#!/usr/bin/env bash

set -euo pipefail

if [[ $# != 2 || ! "$1" =~ ^(45|46|47|48|49|50|51)$ || ! "$2" =~ ^registry\.fedoraproject\.org/fedora:[0-9]+@sha256:[0-9a-f]{64}$ ]]; then
    echo "Usage: $0 gnome-major pinned-official-fedora-image" >&2
    exit 2
fi
version="$1"
image="$2"
fedora="${image%\@*}"
fedora="${fedora##*:}"
project="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
staging="$(mktemp -d /tmp/stealth-lock-container.XXXXXX)"
identifier="stealth-lock-native-${version}-$(basename "$staging")"
identifier="${identifier,,}"
container_image="${identifier}:test"
cleanup() {
    docker rm --force "$identifier" >/dev/null 2>&1 || true
    docker image rm "$container_image" >/dev/null 2>&1 || true
    rm -rf "$staging"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cp "$project/tests/shell/Containerfile" "$staging/Containerfile"
mkdir "$staging/project"
git -C "$project" archive HEAD | tar -xf - -C "$staging/project"
docker build --file "$staging/Containerfile" --build-arg "BASE_IMAGE=$image" --build-arg "FEDORA_VERSION=$fedora" --tag "$container_image" "$staging"
docker run --detach --name "$identifier" --privileged --cgroupns=private \
    --memory=2g --cpus=2 --pids-limit=600 --tmpfs /run --tmpfs /run/lock "$container_image" >/dev/null
docker cp "$staging/project/." "$identifier:/project"
docker cp "$(command -v mise)" "$identifier:/usr/local/bin/mise"
docker exec "$identifier" chown -R 1000:1000 /project
docker exec "$identifier" bash -eu -c '
    getent passwd slh-ci
    id slh-ci
    test "$(id -u slh-ci)" = 1000
    if getent shadow slh-ci >/dev/null; then
        echo "Fixture shadow entry is readable"
    else
        echo "Fixture shadow entry is unavailable" >&2
    fi
    stat --format="%n mode=%a owner=%u:%g" /etc/shadow /etc/gshadow /usr/sbin/unix_chkpwd
    if /usr/sbin/unix_chkpwd slh-ci chkexpiry </dev/null; then
        echo "Fixture account expiry helper passed"
    else
        echo "Fixture account expiry helper failed: $?" >&2
    fi
    sed -n -E "/^(Name|Uid|Gid|Cap(Inh|Prm|Eff|Bnd|Amb)|NoNewPrivs):/p" /proc/1/status
    systemctl show user@1000.service --property=User --property=PAMName --property=Environment \
        --property=CapabilityBoundingSet --property=NoNewPrivileges --property=RestrictSUIDSGID
    systemctl cat user@1000.service | head -n 80
    for attempt in $(seq 1 60); do
        if systemctl is-active --quiet user@1000.service && test -S /run/user/1000/bus; then
            systemctl is-active user-runtime-dir@1000.service
            stat --format="%n mode=%a owner=%u:%g" /run/user/1000
            test "$(stat --format=%a:%u:%g /run/user/1000)" = 700:1000:1000
            exit 0
        fi
        sleep 1
    done
    systemctl status user@1000.service || true
    systemctl status user-runtime-dir@1000.service || true
    if test -d /run/user/1000; then
        stat --format="%n mode=%a owner=%u:%g" /run/user/1000
    fi
    journalctl --unit=user@1000.service --lines=60 --no-pager
    exit 1
'
docker exec --user 1000 --workdir /project \
    --env "EXPECTED_SHELL_VERSION=$version" --env HOME=/home/slh-ci \
    --env XDG_RUNTIME_DIR=/run/user/1000 --env DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
    "$identifier" bash -eu -c '
        actual=$(gnome-shell --version)
        [[ "$actual" == "GNOME Shell $EXPECTED_SHELL_VERSION."* ]] || {
            echo "Expected GNOME $EXPECTED_SHELL_VERSION; installed $actual" >&2
            exit 1
        }
        echo "$actual"
        mise trust /project/mise.toml
        mise install
        export SLH_ROOT=$(mktemp -d /tmp/stealth-lock-preflight.XXXXXX)
        . tests/shell/common.sh
        trap "slh_stop_resources; rm -rf -- \"\$SLH_ROOT\"" EXIT
        slh_start_resources
        systemd-run --user --scope --quiet --collect --slice="$SLH_SLICE" \
            --unit="$SLH_UNIT_PREFIX-preflight.scope" \
            -p TasksMax=infinity -p TimeoutStopSec=15 -p RuntimeMaxSec=180 \
            -- timeout -k 5 150 unshare --user --map-current-user --net -- bash -eu -c "
                echo Fixture user, network namespace and inherited slice preflight passed
                mise exec -- python3 -I -B -m unittest discover -s tests/visual -p test_visual_renderer.py
                mise exec -- gjs -m tests/visual/process.js
            "
        slh_stop_resources
        rm -rf -- "$SLH_ROOT"
        trap - EXIT
        unset SLH_ROOT
        mise exec -- bash tests/shell/run.sh
    '
