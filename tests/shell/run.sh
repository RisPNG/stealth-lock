#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd "$script_dir/../.." && pwd)"
test_directory="$(mktemp -d -t stealth-lock-shell.XXXXXX)"
runner_pid=
cleanup() {
    if [[ -n "$runner_pid" ]]; then
        kill -TERM -- "-$runner_pid" 2>/dev/null || true
    fi
    mise exec -- python3 - "$test_directory" <<'PY'
import os
from pathlib import Path
import signal
import sys
import time

runtime = f'XDG_RUNTIME_DIR={sys.argv[1]}/runtime'.encode()
for process_environment in Path('/proc').glob('[0-9]*/environ'):
    try:
        if runtime in process_environment.read_bytes().split(b'\0'):
            os.kill(int(process_environment.parent.name), signal.SIGTERM)
    except OSError:
        pass
time.sleep(0.2)
PY
    for mount in "$test_directory/runtime/doc" "$test_directory/runtime/gvfs"; do
        if mountpoint -q "$mount"; then
            fusermount3 -u "$mount"
        fi
    done
    rm -r "$test_directory"
}
trap cleanup EXIT
mkdir -p "$test_directory/home" "$test_directory/config" "$test_directory/data" "$test_directory/cache" "$test_directory/runtime"
chmod 700 "$test_directory" "$test_directory/runtime"
extension_dir="$test_directory/data/gnome-shell/extensions/stealth-lock@user"
mkdir -p "$extension_dir"
mise exec -- bash "$project_dir/package.sh" "$test_directory/extension.zip" > /dev/null
unzip -q "$test_directory/extension.zip" -d "$extension_dir"

setsid env HOME="$test_directory/home" XDG_CONFIG_HOME="$test_directory/config" \
    XDG_DATA_HOME="$test_directory/data" XDG_CACHE_HOME="$test_directory/cache" \
    XDG_RUNTIME_DIR="$test_directory/runtime" GSETTINGS_BACKEND=memory \
    DISPLAY= WAYLAND_DISPLAY= GDK_BACKEND=wayland NO_AT_BRIDGE=1 GIO_USE_VFS=local GIO_USE_VOLUME_MONITOR=unix \
    GI_TYPELIB_PATH="/usr/lib/gnome-shell/girepository-1.0:${GI_TYPELIB_PATH:-}" \
    LD_LIBRARY_PATH="/usr/lib/gnome-shell:${LD_LIBRARY_PATH:-}" \
    STEALTH_LOCK_TEST_EXTENSION="$extension_dir" STEALTH_LOCK_TEST_DIRECTORY="$script_dir" \
    timeout --kill-after=5s 30s dbus-run-session -- \
    gnome-shell --headless --wayland --no-x11 --sm-disable \
    --virtual-monitor 1024x768 --automation-script "$script_dir/smoke.js" \
    > "$test_directory/shell.log" 2>&1 &
runner_pid=$!
if ! wait "$runner_pid"; then
    cat "$test_directory/shell.log"
    exit 1
fi
if ! rg -q '^STEALTH_LOCK_SHELL_OK$' "$test_directory/shell.log"; then
    cat "$test_directory/shell.log"
    exit 1
fi
if rg -q 'JS ERROR|cleanup failed|Extension stealth-lock@user.*Error|St-CRITICAL|GLib(-GIO)?-CRITICAL|Clutter-CRITICAL|Gtk-CRITICAL|Pango-CRITICAL|Spurious clutter_actor_allocate|Can.t update stage views actor' "$test_directory/shell.log"; then
    cat "$test_directory/shell.log"
    exit 1
fi
rg '^STEALTH_LOCK_' "$test_directory/shell.log"
