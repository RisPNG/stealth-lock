#!/usr/bin/env bash
# gdbus against the PRIVATE session bus only: gdbus.sh <call|introspect|monitor|emit> [args...]
# The bus address is verified (must be the harness bus and differ from the caller's) before every call.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"

sub=${1:?usage: gdbus.sh call|introspect|monitor|emit ...}
shift
address=$(slh_bus_address)
exec gdbus "$sub" --address "$address" "$@"
