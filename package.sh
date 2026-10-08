#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
read -r extension_uuid version < <(/usr/bin/python3 - "$script_dir/metadata.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as metadata_file:
    metadata = json.load(metadata_file)
print(metadata["uuid"], metadata["version"])
PY
)

if [[ $# -gt 1 ]]; then
    echo "Usage: $0 [output.zip]" >&2
    exit 2
fi

output="${1:-$script_dir/dist/${extension_uuid}-v${version}.zip}"
mkdir -p "$(dirname "$output")"
output="$(cd "$(dirname "$output")" && pwd)/$(basename "$output")"
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT

payload=(
    extension.js
    shell/lockSession.js
    shell/authentication.js
    helpers/authentication.py
    shell/screenshot.js
    shell/overlay.js
    shell/integration.js
    shell/media.js
    shell/input.js
    prefs.js
    shared/presets.js
    shell/effects/backdrop.js
    shell/effects/city.js
    metadata.json
    stylesheet.css
    schemas/org.gnome.shell.extensions.stealth-lock.gschema.xml
    styles/stylesheet-base.css
    stylesheet-dark.css
    stylesheet-light.css
    LICENSE
    REUSE.toml
    LICENSES/GPL-3.0-only.txt
)

extras=()
declare -A extra_paths=()
for file in "${payload[@]}"; do
    mkdir -p "$staging/payload/$(dirname "$file")"
    cp "$script_dir/$file" "$staging/payload/$file"
    chmod 0644 "$staging/payload/$file"
    case "$file" in
        extension.js|prefs.js|metadata.json|stylesheet.css|schemas/*) ;;
        *)
            extra_path="${file%%/*}"
            if [[ ! -v "extra_paths[$extra_path]" ]]; then
                extras+=("--extra-source=$extra_path")
                extra_paths[$extra_path]=1
            fi
            ;;
    esac
done

glib-compile-schemas --strict --dry-run "$staging/payload/schemas"
gnome-extensions pack --force --out-dir="$staging" "${extras[@]}" "$staging/payload"
/usr/bin/python3 - "$staging/$extension_uuid.shell-extension.zip" "${payload[@]}" <<'PY'
import stat
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1]) as archive:
    entries = [entry for entry in archive.infolist() if not entry.is_dir()]
    if sorted(entry.filename for entry in entries) != sorted(sys.argv[2:]):
        raise SystemExit("Unexpected extension archive inventory")
    if any((entry.external_attr >> 16) & (stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH) for entry in entries):
        raise SystemExit("Extension payload contains executable files")
PY
mv "$staging/$extension_uuid.shell-extension.zip" "$output"
echo "$output"
