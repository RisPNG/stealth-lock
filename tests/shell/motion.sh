#!/usr/bin/env bash
# Move the virtual pointer of the private headless shell: motion.sh <x> <y>   (stage coordinates)
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"

HARNESS_BUS=$(slh_bus_address) || exit 2
export HARNESS_BUS
exec gjs -m "$SLH_HARNESS_DIR/ctl.js" motion "$@"
