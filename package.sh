#!/bin/bash
#
# Stealth Lock Extension - Packaging Script
#
# Creates a distributable zip file of the extension
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_UUID="stealth-lock@user"
VERSION=$(grep -oP '"version":\s*\K\d+' "$SCRIPT_DIR/metadata.json")
OUTPUT_FILE="${EXTENSION_UUID}-v${VERSION}.zip"

echo "Packaging Stealth Lock Extension v${VERSION}..."

cd "$SCRIPT_DIR"

# Ensure schemas are compiled
if [ -d "schemas" ]; then
    echo "Compiling schemas..."
    glib-compile-schemas schemas/
fi

# Create zip file
echo "Creating $OUTPUT_FILE..."
ZIP_INPUTS=(
    extension.js
    prefs.js
    metadata.json
    stylesheet.css
    pam-helper.py
    polkit-auth-helper.py
    install.sh
    uninstall.sh
    README.md
)

if [ -d "schemas" ]; then
    ZIP_INPUTS+=(schemas/)
fi

zip -r "$OUTPUT_FILE" "${ZIP_INPUTS[@]}" -x "*.zip"

echo ""
echo "Package created: $SCRIPT_DIR/$OUTPUT_FILE"
echo ""
echo "To install from zip:"
echo "  gnome-extensions install $OUTPUT_FILE"
echo ""
echo "Or extract manually to:"
echo "  ~/.local/share/gnome-shell/extensions/$EXTENSION_UUID/"
