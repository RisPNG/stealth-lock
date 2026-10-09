#!/usr/bin/env bash

set -euo pipefail

[[ $# == 1 ]] || { echo "Usage: $0 output-directory" >&2; exit 2; }

directory=$(realpath -- "$1")
: "${GITHUB_REPOSITORY:?}" "${GITHUB_REF:?}" "${BUILD_COMMIT:?}" "${DEFAULT_BRANCH:?}"
if [[ "$GITHUB_REF" == refs/tags/* ]]; then
    tag=${GITHUB_REF#refs/tags/}
    [[ "$tag" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || { echo "Stable tags must use x.y.z" >&2; exit 1; }
    alias=latest-release
    title='Latest stable release'
    release_options=(--prerelease=false --latest=false)
elif [[ "$GITHUB_REF" == "refs/heads/$DEFAULT_BRANCH" ]]; then
    tag=
    alias=latest-build
    title='Latest development build'
    release_options=(--prerelease --latest=false)
else
    echo "Only the default branch and x.y.z tags publish curl releases" >&2
    exit 1
fi

verify_release_bundle() {
    /usr/bin/python3 - "$1" <<'PY'
import hashlib
import json
import os
from pathlib import Path
import re
import sys

folder = Path(sys.argv[1])
record = json.loads((folder / 'build.json').read_text())
assert record['schema'] == 1
assert record['repository'] == os.environ['GITHUB_REPOSITORY']
assert record['commit'] == os.environ['BUILD_COMMIT']
assert re.fullmatch(r'[0-9a-f]{40}', record['commit'])
assert record['ref'] == os.environ['GITHUB_REF']
tag = record['ref'][10:] if record['ref'].startswith('refs/tags/') else ''
assert record['tag'] == tag
assert re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', tag) if tag else record['ref'] == 'refs/heads/' + os.environ['DEFAULT_BRANCH']
assert re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?', record['version'])
assert not tag or record['version'] == tag
source = record['source']
assert source['file'] == 'stealth-lock-' + record['commit'] + '.tar.gz'
assert re.fullmatch(r'[0-9a-f]{64}', source['sha256'])
assert type(source['bytes']) is int and source['bytes'] > 0
assert (folder / source['file']).stat().st_size == source['bytes']
expected = {}
for name in (source['file'], 'install.sh', 'uninstall.sh', 'build.json'):
    expected[name] = hashlib.sha256((folder / name).read_bytes()).hexdigest()
assert expected[source['file']] == source['sha256']
checksums = {}
for line in (folder / 'SHA256SUMS').read_text().splitlines():
    match = re.fullmatch(r'([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9.-]*)', line)
    assert match and match[2] not in checksums
    checksums[match[2]] = match[1]
assert checksums == expected
print(source['file'])
PY
}

source=$(verify_release_bundle "$directory")
remote_commit=$(git ls-remote "https://github.com/$GITHUB_REPOSITORY.git" "$GITHUB_REF" "${GITHUB_REF}^{}" | tail -n 1 | cut -f 1)
if [[ "$remote_commit" != "$BUILD_COMMIT" ]]; then
    if [[ -z "$tag" ]]; then
        echo "A newer default-branch commit exists; leaving the development release unchanged"
        exit 0
    fi
    echo "The release tag no longer points to the built commit" >&2
    exit 1
fi

staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT
source_dir=$directory
if [[ -n "$tag" ]]; then
    if gh release view "$tag" --repo "$GITHUB_REPOSITORY" --json isDraft,isPrerelease,assets > "$staging/source-release.json"; then
        published=$(/usr/bin/python3 - "$staging/source-release.json" <<'PY'
import json
from pathlib import Path
import sys
record = json.loads(Path(sys.argv[1]).read_text())
print(str(any(asset['name'] == 'build.json' for asset in record['assets'])).lower())
PY
)
        if [[ "$published" == true ]]; then
            source_dir=$staging/published
            mkdir "$source_dir"
            gh release download "$tag" --repo "$GITHUB_REPOSITORY" --dir "$source_dir" \
                --pattern "$source" --pattern install.sh --pattern uninstall.sh --pattern SHA256SUMS --pattern build.json
            source=$(verify_release_bundle "$source_dir")
            echo "The tagged commit already has published assets; preserving them"
        fi
    else
        gh release create "$tag" --repo "$GITHUB_REPOSITORY" --verify-tag --target "$BUILD_COMMIT" \
            --draft --title "$tag" --notes "Source built and checked from commit $BUILD_COMMIT. See build.json and SHA256SUMS for its source identity and checksums."
        printf '{"assets":[]}\n' > "$staging/source-release.json"
    fi
    if [[ "$source_dir" == "$directory" ]]; then
        /usr/bin/python3 - "$staging/source-release.json" > "$staging/existing-assets" <<'PY'
import json
from pathlib import Path
import sys
for asset in json.loads(Path(sys.argv[1]).read_text())['assets']:
    print(asset['name'])
PY
        for asset in "$source" install.sh uninstall.sh SHA256SUMS build.json; do
            if [[ "$asset" == build.json ]]; then
                remote_commit=$(git ls-remote "https://github.com/$GITHUB_REPOSITORY.git" "$GITHUB_REF" "${GITHUB_REF}^{}" | tail -n 1 | cut -f 1)
                [[ "$remote_commit" == "$BUILD_COMMIT" ]] || { echo "The release tag moved during publication; keeping its manifest unpublished" >&2; exit 1; }
            fi
            if rg --fixed-strings --line-regexp --quiet "$asset" "$staging/existing-assets"; then
                mkdir -p "$staging/existing"
                gh release download "$tag" --repo "$GITHUB_REPOSITORY" --pattern "$asset" --dir "$staging/existing"
                cmp --silent "$source_dir/$asset" "$staging/existing/$asset" || { echo "Published $tag asset $asset differs; refusing to replace it" >&2; exit 1; }
            else
                gh release upload "$tag" "$source_dir/$asset" --repo "$GITHUB_REPOSITORY"
            fi
        done
    fi
    remote_commit=$(git ls-remote "https://github.com/$GITHUB_REPOSITORY.git" "$GITHUB_REF" "${GITHUB_REF}^{}" | tail -n 1 | cut -f 1)
    [[ "$remote_commit" == "$BUILD_COMMIT" ]] || { echo "The release tag moved during publication; leaving its release unpublished" >&2; exit 1; }
    gh release edit "$tag" --repo "$GITHUB_REPOSITORY" --draft=false --prerelease=false --latest=false
fi

if gh release view "$alias" --repo "$GITHUB_REPOSITORY" --json isDraft,isPrerelease,assets > "$staging/alias-release.json"; then
    published=$(/usr/bin/python3 - "$staging/alias-release.json" <<'PY'
import json
from pathlib import Path
import sys
record = json.loads(Path(sys.argv[1]).read_text())
print(str(any(asset['name'] == 'build.json' for asset in record['assets'])).lower())
PY
)
    if [[ "$published" == true && -n "$tag" ]]; then
        mkdir "$staging/alias"
        gh release download "$alias" --repo "$GITHUB_REPOSITORY" --pattern build.json --dir "$staging/alias"
        decision=$(/usr/bin/python3 - "$staging/alias/build.json" "$source_dir/build.json" <<'PY'
import json
from pathlib import Path
import re
import sys

previous = json.loads(Path(sys.argv[1]).read_text())
current = json.loads(Path(sys.argv[2]).read_text())
assert previous['schema'] == 1 and previous['repository'] == current['repository']
assert re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', previous['tag'])
assert previous['ref'] == 'refs/tags/' + previous['tag'] and previous['version'] == previous['tag']
assert re.fullmatch(r'[0-9a-f]{40}', previous['commit'])
old_version = tuple(map(int, previous['tag'].split('.')))
new_version = tuple(map(int, current['tag'].split('.')))
if old_version == new_version:
    assert previous == current
print('older' if old_version > new_version else 'publish')
PY
)
        if [[ "$decision" == older ]]; then
            echo "The stable alias already contains a newer version; leaving it unchanged"
            exit 0
        fi
    fi
else
    gh release create "$alias" --repo "$GITHUB_REPOSITORY" --target "$BUILD_COMMIT" --draft \
        "${release_options[@]}" --title "$title" --notes 'Source release alias. See build.json for the original commit, reference, version and source checksum.'
fi

gh release upload "$alias" "$source_dir/$source" --repo "$GITHUB_REPOSITORY" --clobber
remote_commit=$(git ls-remote "https://github.com/$GITHUB_REPOSITORY.git" "$GITHUB_REF" "${GITHUB_REF}^{}" | tail -n 1 | cut -f 1)
if [[ "$remote_commit" != "$BUILD_COMMIT" ]]; then
    if [[ -z "$tag" ]]; then
        echo "The default branch advanced during publication; keeping the previous manifest"
        exit 0
    fi
    echo "The release tag moved during publication; keeping the previous alias manifest" >&2
    exit 1
fi
gh release upload "$alias" "$source_dir/install.sh" "$source_dir/uninstall.sh" "$source_dir/SHA256SUMS" --repo "$GITHUB_REPOSITORY" --clobber
gh release edit "$alias" --repo "$GITHUB_REPOSITORY" "${release_options[@]}" --draft=false --target "$BUILD_COMMIT" --title "$title"
gh api --method PATCH "repos/$GITHUB_REPOSITORY/git/refs/tags/$alias" -f sha="$BUILD_COMMIT" -F force=true
gh release upload "$alias" "$source_dir/build.json" --repo "$GITHUB_REPOSITORY" --clobber
gh release view "$alias" --repo "$GITHUB_REPOSITORY" --json assets \
    --jq '.assets[] | select(.name | startswith("stealth-lock-") and endswith(".tar.gz")) | .name' > "$staging/sources"
while IFS= read -r previous; do
    if [[ "$previous" != "$source" ]]; then
        gh release delete-asset "$alias" "$previous" --repo "$GITHUB_REPOSITORY" --yes
    fi
done < "$staging/sources"
