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
    lockSession.js
    authentication.js
    authentication.py
    screenshot.js
    overlay.js
    shell.js
    input.js
    prefs.js
    metadata.json
    stylesheet.css
    schemas/org.gnome.shell.extensions.stealth-lock.gschema.xml
    package.sh
    install.sh
    uninstall.sh
    README.md
    REVIEW.md
    LICENSE
    REUSE.toml
    LICENSES/GPL-3.0-only.txt
)

for file in "${payload[@]}"; do
    mkdir -p "$staging/payload/$(dirname "$file")"
    cp "$script_dir/$file" "$staging/payload/$file"
done

glib-compile-schemas --strict "$staging/payload/schemas"
(cd "$staging/payload" && zip -q -r "$staging/extension.zip" .)
mv "$staging/extension.zip" "$output"
echo "$output"
