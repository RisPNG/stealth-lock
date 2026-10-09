#!/usr/bin/env bash

set -euo pipefail

channel=
case "${1:-}" in
    --dev) channel=latest-build ;;
    --release) channel=latest-release ;;
    '') ;;
    *) echo "Usage: bash install.sh [--dev | --release]" >&2; exit 2 ;;
esac
if [[ $# -gt 1 ]]; then
    echo "Usage: bash install.sh [--dev | --release]" >&2
    exit 2
fi

script_dir=
if [[ -n "${BASH_SOURCE[0]:-}" ]]; then
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
if [[ -z "$channel" && ( -z "$script_dir" || ! -f "$script_dir/metadata.json" ) ]]; then
    channel=latest-build
fi

extension_parent="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions"
mkdir -p "$extension_parent"
staging="$(mktemp -d "$extension_parent/.stealth-lock-install.XXXXXX")"
extension_dir=
trap 'if [[ -d "$staging/previous" && ! -e "$extension_dir" ]]; then mv "$staging/previous" "$extension_dir"; fi; rm -rf "$staging"' EXIT

if [[ -n "$channel" ]]; then
    repository=RisPNG/stealth-lock
    mkdir "$staging/source"
    curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --max-time 60 \
        "https://github.com/$repository/releases/download/$channel/build.json" -o "$staging/source/build.json"
    /usr/bin/python3 - "$staging/source/build.json" "$channel" "$repository" > "$staging/source/download" <<'PY'
import json
import re
import sys

with open(sys.argv[1], encoding="utf-8") as source_file:
    build = json.load(source_file)
source = build["source"]
if (build["schema"] != 1 or build["repository"] != sys.argv[3]
        or not re.fullmatch(r"[0-9a-f]{40}", build["commit"])
        or source["file"] != "stealth-lock-" + build["commit"] + ".tar.gz"
        or not re.fullmatch(r"[0-9a-f]{64}", source["sha256"])):
    raise SystemExit("Invalid source release manifest")
if sys.argv[2] == "latest-release":
    if (not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", build["tag"])
            or build["ref"] != "refs/tags/" + build["tag"]
            or build["version"] != build["tag"]):
        raise SystemExit("Invalid stable release manifest")
    channel = build["tag"]
else:
    if build["tag"] or not build["ref"].startswith("refs/heads/"):
        raise SystemExit("Invalid development release manifest")
    channel = "latest-build"
print(channel, source["file"], source["sha256"])
PY
    read -r source_channel source_archive source_sha256 < "$staging/source/download"
    curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --max-time 60 \
        "https://github.com/$repository/releases/download/$source_channel/$source_archive" -o "$staging/source/$source_archive"
    echo "$source_sha256  $staging/source/$source_archive" | sha256sum --check --status
    tar -xzf "$staging/source/$source_archive" --strip-components=1 -C "$staging/source"
    script_dir="$staging/source"
fi

extension_uuid="$(/usr/bin/python3 -c 'import json, sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["uuid"])' "$script_dir/metadata.json")"
extension_dir="$extension_parent/$extension_uuid"

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
