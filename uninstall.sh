#!/bin/bash
#
# Stealth Lock Extension - Uninstallation Script
#
# Removes the Stealth Lock GNOME Shell extension from the current user.
#
# Optional:
#   --purge-settings  Also resets the extension's GSettings keys
#

set -euo pipefail

EXTENSION_UUID="stealth-lock@user"
USER_EXTENSION_DIR="$HOME/.local/share/gnome-shell/extensions/$EXTENSION_UUID"
SYSTEM_EXTENSION_DIR="/usr/share/gnome-shell/extensions/$EXTENSION_UUID"

SYSTEM_SCHEMAS_DIR="/usr/share/glib-2.0/schemas"
SCHEMA_FILE="org.gnome.shell.extensions.stealth-lock.gschema.xml"
SYSTEM_SCHEMA_PATH="$SYSTEM_SCHEMAS_DIR/$SCHEMA_FILE"

PURGE_SETTINGS=false
if [[ "${1:-}" == "--purge-settings" ]]; then
    PURGE_SETTINGS=true
fi

echo "=============================================="
echo "  Stealth Lock Extension Uninstaller"
echo "=============================================="
echo ""

if command -v gnome-extensions >/dev/null 2>&1; then
    if gnome-extensions list 2>/dev/null | grep -qx "$EXTENSION_UUID"; then
        echo "Disabling extension..."
        gnome-extensions disable "$EXTENSION_UUID" >/dev/null 2>&1 || true
    fi
fi

removed_any=false

if [[ -d "$USER_EXTENSION_DIR" ]]; then
    echo "Removing user extension directory:"
    echo "  $USER_EXTENSION_DIR"
    rm -rf "$USER_EXTENSION_DIR"
    removed_any=true
else
    echo "User extension directory not found:"
    echo "  $USER_EXTENSION_DIR"
fi

if [[ -d "$SYSTEM_EXTENSION_DIR" ]]; then
    if [[ -w "$SYSTEM_EXTENSION_DIR" ]] || [[ -w "$(dirname "$SYSTEM_EXTENSION_DIR")" ]]; then
        echo "Removing system extension directory:"
        echo "  $SYSTEM_EXTENSION_DIR"
        rm -rf "$SYSTEM_EXTENSION_DIR"
        removed_any=true
    else
        echo "System extension directory exists but is not writable:"
        echo "  $SYSTEM_EXTENSION_DIR"
        echo "If you installed it system-wide, rerun with sudo to remove it."
    fi
fi

if [[ -f "$SYSTEM_SCHEMA_PATH" ]]; then
    if [[ -w "$SYSTEM_SCHEMA_PATH" ]] || [[ -w "$SYSTEM_SCHEMAS_DIR" ]]; then
        echo "Removing system-wide schema:"
        echo "  $SYSTEM_SCHEMA_PATH"
        rm -f "$SYSTEM_SCHEMA_PATH"
        echo "Recompiling system schemas..."
        glib-compile-schemas "$SYSTEM_SCHEMAS_DIR" >/dev/null 2>&1 || true
    else
        echo "System-wide schema exists but is not writable:"
        echo "  $SYSTEM_SCHEMA_PATH"
        echo "To remove it:"
        echo "  sudo rm -f \"$SYSTEM_SCHEMA_PATH\""
        echo "  sudo glib-compile-schemas \"$SYSTEM_SCHEMAS_DIR\""
    fi
fi

if $PURGE_SETTINGS; then
    if command -v gsettings >/dev/null 2>&1; then
        echo "Resetting settings..."
        gsettings reset-recursively org.gnome.shell.extensions.stealth-lock >/dev/null 2>&1 || true
    fi
fi

echo ""
if $removed_any; then
    echo "Uninstall complete."
else
    echo "Nothing to remove."
fi
echo ""
echo "Next steps:"
echo "  - Restart GNOME Shell (Wayland: log out/in; X11: Alt+F2, then 'r')"
