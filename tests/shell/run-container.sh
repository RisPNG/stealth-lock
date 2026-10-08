#!/usr/bin/env bash

set -euo pipefail

if [[ $# != 2 || ! "$1" =~ ^(45|46|47|48|49|50|51)$ || ! "$2" =~ ^registry\.gitlab\.gnome\.org/gnome/mutter/fedora/[0-9]+@sha256:[0-9a-f]{64}$ ]]; then
    echo "Usage: $0 gnome-major pinned-official-mutter-image" >&2
    exit 2
fi
version="$1"
image="$2"
fedora="${image%\@*}"
fedora="${fedora##*/}"
project="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
staging="$(mktemp -d /tmp/stealth-lock-container.XXXXXX)"
identifier="stealth-lock-native-${version}-$(basename "$staging")"
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
    for attempt in $(seq 1 60); do
        if systemctl is-active --quiet user@1000.service && test -S /run/user/1000/bus; then
            exit 0
        fi
        sleep 1
    done
    systemctl status user@1000.service
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
        mise exec -- bash tests/shell/run.sh
    '
