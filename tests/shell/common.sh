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
SLH_STATE=$SLH_ROOT/run/state

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
