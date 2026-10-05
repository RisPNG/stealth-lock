#!/usr/bin/env bash
# Evaluate JavaScript inside the private headless shell and print the JSON result.
#   eval.sh [-b] [-t SECONDS] '<expression>'     e.g. eval.sh 'Main.modalCount'
#   eval.sh -b 'const a = ...; return a;'        -b: function body, may use await
# Direct eval in the helper's module scope: Main, Meta, Shell, St, Clutter, Gio, GLib are in scope; the shell
# internals are reachable through Main.*, global.*. Exit status: 0 ok, 1 JS error, 2 transport error.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"

HARNESS_BUS=$(slh_bus_address) || exit 2
export HARNESS_BUS
exec gjs -m "$SLH_HARNESS_DIR/ctl.js" eval "$@"
