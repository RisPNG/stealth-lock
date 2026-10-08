#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 0 ]]; then
    echo "Usage: $0" >&2
    exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
extension_uuid="$(/usr/bin/python3 -c 'import json, sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["uuid"])' "$script_dir/metadata.json")"
extension_parent="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions"
extension_dir="$extension_parent/$extension_uuid"
mkdir -p "$extension_parent"
staging="$(mktemp -d "$extension_parent/.stealth-lock-install.XXXXXX")"
trap 'if [[ -d "$staging/previous" && ! -e "$extension_dir" ]]; then mv "$staging/previous" "$extension_dir"; fi; rm -rf "$staging"' EXIT

bash "$script_dir/package.sh" "$staging/extension.zip" >/dev/null
unzip -q "$staging/extension.zip" -d "$staging/extension"
glib-compile-schemas --strict "$staging/extension/schemas"
gjs -m "$staging/extension/shared/visual-process.js" "$staging/extension"
gjs -m "$staging/extension/shared/presets.js" "$staging/extension/schemas"
if [[ -e "$extension_dir" ]]; then
    mv "$extension_dir" "$staging/previous"
fi
mv "$staging/extension" "$extension_dir"

echo "Installed Stealth Lock at $extension_dir"
echo "Log out and back in to load the new code, then enable $extension_uuid in Extensions."
