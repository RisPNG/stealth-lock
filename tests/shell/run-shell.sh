#!/usr/bin/env bash
# Private headless GNOME Shell for end-to-end tests of the Stealth Lock extension.
#
#   run-shell.sh start    start the shell in a resource-limited transient scope, wait until ready
#   run-shell.sh stop     stop that scope (by unit name; never by process name) and clean up
#   run-shell.sh status   show the scope, its processes, RSS and cgroup memory
#   run-shell.sh pids     "<pid> <comm>" of every process in the scope
#   run-shell.sh clean    stop, then remove everything the harness keeps under SLH_ROOT
#   run-shell.sh crash-restart    SIGKILL only the owned compositor and restart with its private runtime state
#
# Environment knobs (all optional):
#   SLH_ROOT=/tmp/...    where the shell keeps its state: XDG dirs, runtime dir, logs (default /tmp/stealth-lock-shell-<uid>)
#   SLH_EXT_SRC=...      extension under test: unset packs this repository exactly like package.sh does; a directory is
#                        copied; a .zip is unpacked; "none" starts with the helper extension only
#   SLH_ENABLE_EXT=1     enable the extension under test at shell start (default: only the helper is enabled)
#   SLH_UNSAFE=1         also pass --unsafe-mode (makes org.gnome.Shell.Eval available; not needed by the helper)
#   SLH_X11=1            do not pass --no-x11 (starts Xwayland)
#   SLH_FAKE_GDM=1       answer org.gnome.DisplayManager on the private system bus so Main.screenShield (stock lock) exists
#   SLH_NETNS=0          do NOT isolate the network (default 1: private user+network namespace, no connectivity)
#   SLH_MONITOR='WxH [WxH...]'  virtual monitor(s), laid out left to right (default 1280x720)
#   SLH_KEYFILE_EXTRA=f  file whose content is appended to the keyfile GSettings backend
#   SLH_MAX_SECONDS=N    hard wall-clock limit of the whole scope (default 600)
#   SLH_PASSWORD=...     password accepted by the stand-in auth helper (default harness-secret)
#   SLH_SERVICES="a b"   session D-Bus services that may be activated (default: Shell.Extensions, Notifications, CalendarServer)
# The environment of the shell is scrubbed (env -i): nothing from the user's session leaks in.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"

SLH_MAX_SECONDS=${SLH_MAX_SECONDS:-600}

unit_name() { sed -n 's/^UNIT=//p' "$SLH_STATE" 2>/dev/null || true; }

scope_pids() {
    local unit=$1 cg
    cg=$(systemctl --user show -p ControlGroup --value "$unit" 2>/dev/null) || return 0
    if [ -n "$cg" ]; then cat "/sys/fs/cgroup$cg/cgroup.procs" 2>/dev/null || true; fi
}

# /tmp is shared and the name of the root is predictable: it must be a real directory that belongs to the caller.
check_root() {
    [ ! -L "$SLH_ROOT" ] || slh_die "$SLH_ROOT is a symlink"
    [ -d "$SLH_ROOT" ] && [ -O "$SLH_ROOT" ] || slh_die "$SLH_ROOT is not a directory owned by you"
    # a stale FUSE mount (portals) would make rm hang; there should be none, but check first
    if grep -q " $SLH_ROOT/" /proc/self/mountinfo; then slh_die "mount points under $SLH_ROOT; unmount them first"; fi
}

prepare_root() {
    mkdir -p -m 0700 "$SLH_ROOT"
    check_root
    rm -rf "${SLH_ROOT:?}"/{xdg-config,xdg-data,xdg-cache,xdg-state,home,run,runtime,logs}
    mkdir -p "$SLH_ROOT"/{xdg-config,xdg-data,xdg-cache,xdg-state,home,run,runtime,logs}
    chmod 0700 "$SLH_ROOT" "$SLH_RT"
}

# Installs the extension under test into the private XDG_DATA_HOME next to the helper extension. The auth helper of the
# extension is replaced by a stand-in, so that no test can ever reach the real PAM stack.
install_extension() {
    local ext_dir=$SLH_ROOT/xdg-data/gnome-shell/extensions src=${SLH_EXT_SRC-} tmp uuid
    mkdir -p "$ext_dir"
    cp -a "$SLH_HARNESS_DIR/helper-extension/harness-helper@test" "$ext_dir/"
    [ "$src" != none ] || return 0

    tmp=$(mktemp -d "$SLH_ROOT/run/ext.XXXXXX")
    if [ -z "$src" ]; then src=$(bash "$SLH_PROJECT/package.sh" "$SLH_ROOT/run/extension.zip" | tail -n 1); fi
    case $src in
        *.zip) unzip -q "$src" -d "$tmp" ;;
        *) cp -a "$src/." "$tmp/" ;;
    esac
    uuid=$(sed -n 's/.*"uuid"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$tmp/metadata.json")
    [ -n "$uuid" ] || slh_die "no uuid in the metadata.json of $src"
    if [ -d "$tmp/schemas" ]; then glib-compile-schemas --strict "$tmp/schemas"; fi
    cp "$SLH_HARNESS_DIR/stubs/authentication.py" "$tmp/helpers/authentication.py"
    grep -qx 'STEALTH_LOCK_AUTH_FIXTURE = True' "$tmp/helpers/authentication.py" || slh_die "authentication fixture was not installed"
    cmp "$SLH_HARNESS_DIR/stubs/authentication.py" "$tmp/helpers/authentication.py" || slh_die "authentication fixture differs"
    if grep -q 'ctypes\|pam_authenticate' "$tmp/helpers/authentication.py"; then slh_die "authentication fixture can reach PAM"; fi
    mv "$tmp" "$ext_dir/$uuid"
    echo "$uuid" > "$SLH_ROOT/run/ext-uuid"
}

write_settings() {
    local enabled kf=$SLH_ROOT/xdg-config/glib-2.0/settings/keyfile
    enabled="'harness-helper@test'"
    if [ "${SLH_ENABLE_EXT:-0}" = 1 ]; then
        [ -s "$SLH_ROOT/run/ext-uuid" ] || slh_die "SLH_ENABLE_EXT=1 needs an extension under test (SLH_EXT_SRC is none)"
        enabled="$enabled, '$(cat "$SLH_ROOT/run/ext-uuid")'"
    fi
    mkdir -p "$(dirname "$kf")"
    cat > "$kf" <<KEYFILE
[org/gnome/shell]
enabled-extensions=[$enabled]
disable-user-extensions=false
welcome-dialog-last-shown-version='99.0'

[org/gnome/desktop/input-sources]
sources=[('ibus', 'xkb:us::eng')]
mru-sources=[('ibus', 'xkb:us::eng')]
per-window=false
KEYFILE
    if [ -n "${SLH_KEYFILE_EXTRA:-}" ]; then cat "$SLH_KEYFILE_EXTRA" >> "$kf"; fi

    # stop the extension update check (network) and the first-run dialogs
    local gdir=$SLH_ROOT/xdg-data/gnome-shell v
    mkdir -p "$gdir/extension-updates"
    touch "$gdir/lock-warning-shown"
    for v in $(seq 40 99); do touch "$gdir/update-check-$v"; done
    chmod 0555 "$gdir/extension-updates"
}

write_confs() {
    sed "s#@RT@#$SLH_RT#g; s#@ROOT@#$SLH_ROOT#g" "$SLH_HARNESS_DIR/session-bus.conf.in" > "$SLH_ROOT/run/session-bus.conf"
    sed "s#@RT@#$SLH_RT#g; s#@ROOT@#$SLH_ROOT#g" "$SLH_HARNESS_DIR/system-bus.conf.in" > "$SLH_ROOT/run/system-bus.conf"
    # Only these stock services may be D-Bus-activated on the private bus. The default (standard servicedirs)
    # activates ~35 desktop daemons (gvfs, evolution, portals, goa, keyring, FUSE mounts), ~900 MB in total.
    mkdir -p "$SLH_ROOT/run/system-services" "$SLH_ROOT/run/session-services" "$SLH_ROOT/run/no-gbm-backends"
    local svc
    for svc in ${SLH_SERVICES:-org.gnome.Shell.Extensions org.gnome.Shell.Notifications org.gnome.Shell.CalendarServer}; do
        cp "/usr/share/dbus-1/services/$svc.service" "$SLH_ROOT/run/session-services/"
    done
}

cmd_start() {
    local unit
    unit=$(unit_name)
    if [ -n "$unit" ] && systemctl --user is-active --quiet "$unit" 2>/dev/null; then
        slh_die "a harness shell is already running ($unit); stop it first"
    fi
    if systemctl --user list-units --type=scope --no-legend "$SLH_UNIT_PREFIX-*" 2>/dev/null | grep -q .; then
        slh_die "another $SLH_UNIT_PREFIX-* scope is active; run 'run-shell.sh stop' or inspect it"
    fi
    if [ "${1:-}" = resume ]; then
        check_root
        local uuid
        uuid=$(cat "$SLH_ROOT/run/ext-uuid")
        cmp "$SLH_HARNESS_DIR/stubs/authentication.py" "$SLH_ROOT/xdg-data/gnome-shell/extensions/$uuid/helpers/authentication.py" || slh_die "restart authentication fixture differs"
        rm -f "$SLH_RT/bus" "$SLH_RT/system_bus_socket" "$SLH_RT/wayland-test" "$SLH_RT/wayland-test.lock"
    else
        prepare_root
        : > "$SLH_ROOT/logs/shell.log"
        : > "$SLH_ROOT/logs/auth-stub.log"
        install_extension
        write_settings
    fi
    write_confs

    unit=$SLH_UNIT_PREFIX-$(date +%s)-$$.scope
    printf 'UNIT=%s\nSTARTED=%s\n' "$unit" "$(date +%s)" > "$SLH_STATE"

    # Network isolation: a fresh user+network namespace (uid stays the same, no interfaces except a down lo).
    # Needed because GNOME Shell POSTs the list of per-user extensions to extensions.gnome.org at every start
    # (ExtensionDownloader.checkForUpdates, active whenever org.gnome.Extensions.desktop is installed).
    local netns=()
    if [ "${SLH_NETNS:-1}" = 1 ]; then netns=(unshare --user --map-current-user --net --); fi

    # Everything below runs inside the scope; the scrubbed environment is applied by env -i *inside* it.
    systemd-run --user --scope --quiet --collect --unit="$unit" \
        -p MemoryMax=1500M -p MemoryHigh=1200M -p CPUQuota=150% -p TasksMax=400 -p TimeoutStopSec=15 -p RuntimeMaxSec=$((SLH_MAX_SECONDS + ${SLH_RUNTIME_SLACK:-30})) \
        -- timeout -k 5 "$SLH_MAX_SECONDS" \
        "${netns[@]}" \
        env -i \
            PATH=/usr/local/bin:/usr/bin:/bin \
            HOME="$SLH_ROOT/home" USER=slh-nobody LOGNAME=slh-nobody LANG=C.UTF-8 \
            XDG_CONFIG_HOME="$SLH_ROOT/xdg-config" XDG_DATA_HOME="$SLH_ROOT/xdg-data" \
            XDG_CACHE_HOME="$SLH_ROOT/xdg-cache" XDG_STATE_HOME="$SLH_ROOT/xdg-state" \
            XDG_RUNTIME_DIR="$SLH_RT" XDG_DATA_DIRS=/usr/local/share:/usr/share XDG_CONFIG_DIRS=/etc/xdg \
            XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=GNOME WAYLAND_DISPLAY=wayland-test \
            GSETTINGS_BACKEND=keyfile NO_AT_BRIDGE=1 GTK_A11Y=none \
            LIBGL_ALWAYS_SOFTWARE=true LP_NUM_THREADS=1 GBM_ALWAYS_SOFTWARE=true 'VK_LOADER_DRIVERS_SELECT=lvp_*' \
            __EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/50_mesa.json __GLX_VENDOR_LIBRARY_NAME=mesa \
            GBM_BACKENDS_PATH="$SLH_ROOT/run/no-gbm-backends" \
            SLH_ROOT="$SLH_ROOT" SLH_HARNESS_DIR="$SLH_HARNESS_DIR" SLH_PASSWORD="${SLH_PASSWORD:-harness-secret}" \
            SLH_MONITOR="${SLH_MONITOR:-1280x720}" SLH_FAKE_GDM="${SLH_FAKE_GDM:-0}" SLH_X11="${SLH_X11:-0}" SLH_UNSAFE="${SLH_UNSAFE:-0}" \
            bash "$SLH_HARNESS_DIR/scope-main.sh" \
        >> "$SLH_ROOT/logs/scope.log" 2>&1 &
    echo "started unit $unit (launcher pid $!)"

    local i
    for i in $(seq 1 120); do
        if ! systemctl --user is-active --quiet "$unit" 2>/dev/null && [ "$i" -gt 5 ]; then
            echo "scope died during startup; tail of logs:" >&2
            tail -n 20 "$SLH_ROOT/logs/scope.log" "$SLH_ROOT/logs/shell.log" >&2 || true
            cmd_stop
            exit 1
        fi
        if [ -s "$SLH_ROOT/run/bus-address" ] && [ "$("$SLH_HARNESS_DIR/eval.sh" -t 3 '!Main.layoutManager._startingUp' 2>/dev/null)" = true ]; then
            if ! "$SLH_HARNESS_DIR/eval.sh" -t 12 -b '
                const {getIBusManager} = await import("resource:///org/gnome/shell/misc/ibusManager.js");
                const {getInputSourceManager} = await import("resource:///org/gnome/shell/ui/status/keyboard.js");
                const {waitFor} = await import(Gio.File.new_for_path(GLib.getenv("SLH_HARNESS_DIR")).get_child("support.js").get_uri());
                const ibus = getIBusManager();
                const sources = getInputSourceManager();
                await waitFor(() => ibus._ready && ibus._currentEngineName === "xkb:us::eng" &&
                    sources.currentSource?.type === "ibus" && sources.currentSource.id === "xkb:us::eng",
                    "Native IBus US engine selected", 10000);
                return "native IBus US engine ready";
            '; then
                cmd_stop
                exit 1
            fi
            echo "ready after ~$((i / 2))s"
            return 0
        fi
        sleep 0.5
    done
    echo "timed out waiting for the helper; tail of shell.log:" >&2
    tail -n 30 "$SLH_ROOT/logs/shell.log" >&2 || true
    cmd_stop
    exit 1
}

cmd_crash_restart() {
    local unit pid shell_pid=
    unit=$(unit_name)
    [ -n "$unit" ] && systemctl --user is-active --quiet "$unit" || slh_die "no active private scope"
    for pid in $(scope_pids "$unit"); do
        if [ "$(cat "/proc/$pid/comm" 2>/dev/null || true)" = gnome-shell ]; then
            [ -z "$shell_pid" ] || slh_die "more than one compositor in private scope"
            shell_pid=$pid
        fi
    done
    [ -n "$shell_pid" ] || slh_die "private compositor not found in scope"
    echo "crashing private compositor $shell_pid in $unit"
    kill -KILL "$shell_pid"
    cmd_stop
    cmd_start resume
}

cmd_status() {
    local unit pid
    unit=$(unit_name)
    [ -n "$unit" ] || { echo "no harness state"; return 0; }
    if ! systemctl --user is-active --quiet "$unit" 2>/dev/null; then echo "$unit: not active"; return 0; fi
    echo "$unit: active"
    systemctl --user show -p MemoryCurrent -p MemoryPeak -p TasksCurrent "$unit"
    for pid in $(scope_pids "$unit"); do ps -o pid=,rss=,args= -p "$pid" | cut -c1-150; done
}

cmd_stop() {
    local unit
    unit=$(unit_name)
    if [ -n "$unit" ] && systemctl --user is-active --quiet "$unit" 2>/dev/null; then
        systemctl --user stop "$unit" || true
        local i
        for i in $(seq 1 40); do
            systemctl --user is-active --quiet "$unit" 2>/dev/null || break
            sleep 0.5
        done
    fi
    rm -f "$SLH_STATE" "$SLH_ROOT/run/bus-address"
    # make the 0555 update dir deletable later
    if [ -d "$SLH_ROOT/xdg-data/gnome-shell/extension-updates" ]; then chmod 0755 "$SLH_ROOT/xdg-data/gnome-shell/extension-updates"; fi
    echo "stopped ${unit:-nothing}"
}

cmd_clean() {
    cmd_stop
    if [ -e "$SLH_ROOT" ]; then
        check_root
        rm -rf "${SLH_ROOT:?}"
    fi
}

cmd_pids() {
    local unit pid
    unit=$(unit_name)
    [ -n "$unit" ] || return 0
    for pid in $(scope_pids "$unit"); do printf '%s %s\n' "$pid" "$(cat "/proc/$pid/comm" 2>/dev/null)"; done
}

case ${1:-} in
    pids) cmd_pids ;;
    start) cmd_start ;;
    stop) cmd_stop ;;
    status) cmd_status ;;
    clean) cmd_clean ;;
    crash-restart) cmd_crash_restart ;;
    *) sed -n '2,/^[^#]/{/^#/s/^# \{0,1\}//p}' "$0"; exit 2 ;;
esac
