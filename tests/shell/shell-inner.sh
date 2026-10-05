#!/usr/bin/env bash
# Runs under dbus-run-session: DBUS_SESSION_BUS_ADDRESS is the private session bus here.
set -euo pipefail

case ${DBUS_SESSION_BUS_ADDRESS:-} in
    "unix:path=$XDG_RUNTIME_DIR/bus"*) ;;
    *) echo "unexpected session bus address: ${DBUS_SESSION_BUS_ADDRESS:-}" >&2; exit 1 ;;
esac
printf '%s\n' "$DBUS_SESSION_BUS_ADDRESS" > "$SLH_ROOT/run/bus-address.tmp"
mv "$SLH_ROOT/run/bus-address.tmp" "$SLH_ROOT/run/bus-address"

args=(--headless --wayland-display=wayland-test --sm-disable)
for monitor in ${SLH_MONITOR:-1280x720}; do
    args+=("--virtual-monitor=$monitor")
done
if [ "${SLH_X11:-0}" != 1 ]; then args+=(--no-x11); fi
if [ "${SLH_UNSAFE:-0}" = 1 ]; then args+=(--unsafe-mode); fi
exec gnome-shell "${args[@]}" >> "$SLH_ROOT/logs/shell.log" 2>&1
