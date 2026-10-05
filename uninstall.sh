#!/usr/bin/env bash

set -euo pipefail

if [[ $# -gt 1 || ( $# -eq 1 && "$1" != --purge-settings ) ]]; then
    echo "Usage: $0 [--purge-settings]" >&2
    exit 2
fi

extension_uuid="stealth-lock@user"
extension_dir="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$extension_uuid"

if [[ ! -d "$extension_dir" ]]; then
    echo "Stealth Lock is not installed for this user."
    exit 0
fi

if command -v gnome-extensions >/dev/null 2>&1; then
    gnome-extensions disable "$extension_uuid" || true
fi

if [[ "${1:-}" == --purge-settings ]]; then
    gsettings --schemadir "$extension_dir/schemas" reset-recursively org.gnome.shell.extensions.stealth-lock
fi

rm -rf "$extension_dir"
echo "Removed Stealth Lock from $extension_dir"
