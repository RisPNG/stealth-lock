#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project="$(cd "$script_dir/.." && pwd)"
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT

if [[ $# == 3 && "$1" == --verify ]]; then
    mkdir -m 0700 "$staging/verification"
    gpg --batch --dearmor --output "$staging/verification/keyring.gpg" "$2"
    gpgv --homedir "$staging/verification" --keyring "$staging/verification/keyring.gpg" "$3.asc" "$3"
    exit
fi

signing_key=
case "${1:-}" in
    --unsigned)
        [[ $# -le 2 ]] || { echo "Usage: $0 --unsigned [source.tar.gz]" >&2; exit 2; }
        shift
        ;;
    --sign-key)
        [[ $# -ge 2 && $# -le 3 && "$2" =~ ^[[:xdigit:]]{40}([[:xdigit:]]{24})?$ ]] || {
            echo "Usage: $0 --sign-key fingerprint [source.tar.gz]" >&2
            exit 2
        }
        signing_key="$2"
        shift 2
        gpg --batch --list-secret-keys "$signing_key" >/dev/null
        ;;
    *)
        echo "Usage: $0 --unsigned [source.tar.gz] | --sign-key fingerprint [source.tar.gz] | --verify trusted-key.asc source.tar.gz" >&2
        exit 2
        ;;
esac

if ! git -C "$project" diff --quiet HEAD --; then
    echo "Commit the source changes before building a release" >&2
    exit 1
fi
version=$(git -C "$project" show HEAD:metadata.json | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["version-name"])')
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][[:alnum:].-]+)?$ ]] || { echo "Invalid release version" >&2; exit 1; }
output="${1:-$project/dist/stealth-lock-$version.tar.gz}"
mkdir -p "$(dirname "$output")"
output="$(cd "$(dirname "$output")" && pwd)/$(basename "$output")"

git -C "$project" archive --format=tar --prefix="stealth-lock-$version/" HEAD | gzip -n > "$staging/source.tar.gz"
if [[ -n "$signing_key" ]]; then
    gpg --batch --armor --local-user "$signing_key" --detach-sign --output "$staging/source.tar.gz.asc" "$staging/source.tar.gz"
    gpg --batch --armor --export "$signing_key" > "$staging/source.tar.gz.key.asc"
    mkdir -m 0700 "$staging/verification"
    gpg --batch --dearmor --output "$staging/verification/keyring.gpg" "$staging/source.tar.gz.key.asc"
    gpgv --homedir "$staging/verification" --keyring "$staging/verification/keyring.gpg" "$staging/source.tar.gz.asc" "$staging/source.tar.gz"
fi
mv "$staging/source.tar.gz" "$output"
if [[ -n "$signing_key" ]]; then
    mv "$staging/source.tar.gz.asc" "$output.asc"
    mv "$staging/source.tar.gz.key.asc" "$output.key.asc"
else
    rm -f "$output.asc" "$output.key.asc"
fi
echo "$output"
