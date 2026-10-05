#!/usr/bin/env bash
# Runs INSIDE the transient systemd scope, with a scrubbed environment (see run-shell.sh).
# Starts a private (empty) system bus, then a private session bus (dbus-run-session) whose child is the shell.
set -euo pipefail

sysbus_pid=
gdm_pid=
cleanup() {
    if [ -n "$gdm_pid" ]; then kill "$gdm_pid" 2>/dev/null || true; fi
    if [ -n "$sysbus_pid" ]; then kill "$sysbus_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT

rm -f "$SLH_ROOT/run/system-bus-address"
dbus-daemon --config-file="$SLH_ROOT/run/system-bus.conf" --nofork --nosyslog \
    --print-address=3 3>"$SLH_ROOT/run/system-bus-address" &
sysbus_pid=$!
for _ in $(seq 1 50); do
    [ -s "$SLH_ROOT/run/system-bus-address" ] && break
    sleep 0.1
done
[ -s "$SLH_ROOT/run/system-bus-address" ] || { echo "private system bus did not start" >&2; exit 1; }
export DBUS_SYSTEM_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/system_bus_socket

if [ "${SLH_FAKE_GDM:-0}" = 1 ]; then
    gjs -m "$SLH_HARNESS_DIR/fake-gdm.js" >> "$SLH_ROOT/logs/fake-gdm.log" 2>&1 &
    gdm_pid=$!
    sleep 0.5
fi

dbus-run-session --config-file="$SLH_ROOT/run/session-bus.conf" -- bash "$SLH_HARNESS_DIR/shell-inner.sh"
