#!/usr/bin/env bash

set -euo pipefail

[[ $# -le 1 ]] || { echo "Usage: $0 [output-directory]" >&2; exit 2; }

project="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${GITHUB_REPOSITORY:?}" "${GITHUB_REF:?}" "${DEFAULT_BRANCH:?}"
commit=$(git -C "$project" rev-parse "${GITHUB_SHA:-HEAD}^{commit}")
[[ "$(git -C "$project" rev-parse HEAD)" == "$commit" ]] || { echo "Check out the exact build commit" >&2; exit 1; }
version=$(git -C "$project" show "$commit:metadata.json" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["version-name"])')
tag=
if [[ "$GITHUB_REF" == refs/tags/* ]]; then
    tag=${GITHUB_REF#refs/tags/}
    [[ "$tag" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || { echo "Stable tags must use x.y.z" >&2; exit 1; }
    [[ "$tag" == "$version" ]] || { echo "The tag must match metadata.json version-name" >&2; exit 1; }
elif [[ "$GITHUB_REF" != "refs/heads/$DEFAULT_BRANCH" ]]; then
    echo "Only the default branch and x.y.z tags produce curl releases" >&2
    exit 1
fi

output="${1:-$project/dist/curl/$commit}"
mkdir -p "$output"
output=$(cd "$output" && pwd)
source="stealth-lock-$commit.tar.gz"
bash "$project/scripts/release.sh" --unsigned "$output/$source"
git -C "$project" show "$commit:install.sh" > "$output/install.sh"
git -C "$project" show "$commit:uninstall.sh" > "$output/uninstall.sh"
chmod 0755 "$output/install.sh" "$output/uninstall.sh"
/usr/bin/python3 - "$output" "$GITHUB_REPOSITORY" "$commit" "$GITHUB_REF" "$tag" "$version" "$source" <<'PY'
import hashlib
import json
from pathlib import Path
import sys

folder = Path(sys.argv[1])
source = folder / sys.argv[7]
record = {
    'schema': 1,
    'repository': sys.argv[2],
    'commit': sys.argv[3],
    'ref': sys.argv[4],
    'tag': sys.argv[5],
    'version': sys.argv[6],
    'source': {
        'file': source.name,
        'sha256': hashlib.sha256(source.read_bytes()).hexdigest(),
        'bytes': source.stat().st_size,
    },
}
(folder / 'build.json').write_text(json.dumps(record, indent=2) + '\n')
checksums = []
for name in (source.name, 'install.sh', 'uninstall.sh', 'build.json'):
    checksums.append(hashlib.sha256((folder / name).read_bytes()).hexdigest() + '  ' + name + '\n')
(folder / 'SHA256SUMS').write_text(''.join(checksums))
PY
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf 'commit=%s\ndirectory=%s\n' "$commit" "$output" >> "$GITHUB_OUTPUT"
fi
printf 'Built curl release %s from %s\n' "$output" "$commit"
