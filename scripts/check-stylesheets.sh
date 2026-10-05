#!/usr/bin/env bash

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
directories=()
for directory in /usr/lib/gnome-shell /usr/lib64/gnome-shell /usr/lib/*/gnome-shell /usr/lib/mutter-* /usr/lib64/mutter-* /usr/lib/*/mutter-*; do
    if [[ -d "$directory" ]]; then
        directories+=("$directory" "$directory/girepository-1.0")
    fi
done
if [[ ${#directories[@]} -eq 0 ]]; then
    echo "SKIPPED native stylesheet parser: GNOME Shell St library is unavailable"
    exit 0
fi
library_path="$(IFS=:; echo "${directories[*]}")"
env GI_TYPELIB_PATH="$library_path" LD_LIBRARY_PATH="$library_path" GSETTINGS_BACKEND=memory \
    mise exec -- gjs -m tests/check-stylesheets.js
