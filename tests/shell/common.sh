# Shared settings for the headless shell harness. Sourced by the other scripts.

slh_die() {
    echo "harness: $*" >&2
    exit 1
}

SLH_HARNESS_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SLH_PROJECT=$(cd "$SLH_HARNESS_DIR/../.." && pwd)

# Everything the shell writes lives under SLH_ROOT. Its runtime directory is the shell's XDG_RUNTIME_DIR and holds the
# unix sockets, whose paths are limited to 107 bytes, so the root has to stay short.
SLH_ROOT=${SLH_ROOT:-/tmp/stealth-lock-shell-$(id -u)}
case $SLH_ROOT in
    *..*) slh_die "SLH_ROOT must not contain '..': $SLH_ROOT" ;;
    /tmp/?*) ;;
    *) slh_die "SLH_ROOT must be a directory under /tmp: $SLH_ROOT" ;;
esac
[ ${#SLH_ROOT} -le 60 ] || slh_die "SLH_ROOT is too long for unix socket paths: $SLH_ROOT"
SLH_RT=$SLH_ROOT/runtime

# Instances with different roots never collide: the unit name is derived from the root path.
SLH_ID=$(printf '%s' "$SLH_ROOT" | md5sum | cut -c1-6)
SLH_UNIT_PREFIX=slh-shell-$SLH_ID
SLH_SLICE=slh$SLH_ID.slice
SLH_STATE=$SLH_ROOT/run/state

slh_start_resources() {
    if systemctl --user is-active --quiet "$SLH_SLICE"; then
        slh_die "$SLH_SLICE is already active; stop the owned test resources first"
    fi
    if ! busctl --user call org.freedesktop.systemd1 /org/freedesktop/systemd1 \
        org.freedesktop.systemd1.Manager StartTransientUnit 'ssa(sv)a(sa(sv))' \
        "$SLH_SLICE" fail 7 \
        Description s 'Stealth Lock private test resources' \
        CollectMode s inactive-or-failed \
        MemoryMax t 1572864000 MemoryHigh t 1258291200 \
        CPUQuotaPerSecUSec t 1500000 CPUQuotaPeriodUSec t 10000 \
        TasksMax t 400 0 >/dev/null; then
        slh_stop_resources
        slh_die "test resource slice could not be created"
    fi
    local cgroup i
    for i in $(seq 1 40); do
        systemctl --user is-active --quiet "$SLH_SLICE" && break
        sleep 0.05
    done
    if ! systemctl --user is-active --quiet "$SLH_SLICE"; then
        slh_stop_resources
        slh_die "test resource slice did not start"
    fi
    cgroup=$(systemctl --user show -p ControlGroup --value "$SLH_SLICE")
    if [ "$(cat "/sys/fs/cgroup$cgroup/memory.max")" != 1572864000 ] ||
        [ "$(cat "/sys/fs/cgroup$cgroup/memory.high")" != 1258291200 ] ||
        [ "$(cat "/sys/fs/cgroup$cgroup/cpu.max")" != '15000 10000' ] ||
        [ "$(cat "/sys/fs/cgroup$cgroup/pids.max")" != 400 ]; then
        slh_stop_resources
        slh_die "test aggregate resource policy differs"
    fi
}

slh_stop_resources() {
    local cgroup i
    cgroup=$(systemctl --user show -p ControlGroup --value "$SLH_SLICE" 2>/dev/null) || return 0
    [ -n "$cgroup" ] || return 0
    systemctl --user stop "$SLH_SLICE"
    for i in $(seq 1 40); do
        if ! systemctl --user is-active --quiet "$SLH_SLICE" && [ ! -d "/sys/fs/cgroup$cgroup" ]; then
            return 0
        fi
        sleep 0.5
    done
    slh_die "owned test resources did not stop ($SLH_SLICE)"
}

slh_resource_pids() {
    local cgroup
    cgroup=$(systemctl --user show -p ControlGroup --value "$SLH_SLICE" 2>/dev/null) || return 0
    [ -n "$cgroup" ] && [ -d "/sys/fs/cgroup$cgroup" ] || return 0
    find "/sys/fs/cgroup$cgroup" -name cgroup.procs -exec cat {} +
}

# The private session bus address, verified to be the harness bus and not the user's.
slh_bus_address() {
    local addr
    addr=$(cat "$SLH_ROOT/run/bus-address" 2>/dev/null) || slh_die "no private bus address (shell not started?)"
    case $addr in
        "unix:path=$SLH_RT/bus"*) ;;
        *) slh_die "refusing bus address that is not the private one: $addr" ;;
    esac
    [ "$addr" != "${DBUS_SESSION_BUS_ADDRESS:-}" ] || slh_die "bus address equals the caller's session bus"
    printf '%s\n' "$addr"
}
