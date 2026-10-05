#!/usr/bin/env bash
# Inject keyboard input into the private headless shell through the helper's Clutter virtual keyboard.
#   keys.sh [-d MS] 'Super+Control+l' 'text:wrong' Return sleep:200 code:28
# Chord = modifiers pressed in order, key tapped, modifiers released in reverse. Names are X11 keysym names
# (Return, Escape, BackSpace, Tab, F5, ...) or single characters; Super/Ctrl/Control/Alt/Shift are aliases.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"

HARNESS_BUS=$(slh_bus_address) || exit 2
export HARNESS_BUS
exec gjs -m "$SLH_HARNESS_DIR/ctl.js" keys "$@"
