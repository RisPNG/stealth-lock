#!/bin/bash
#
# Stealth Lock Extension - Installation Script
#
# This script installs the Stealth Lock GNOME Shell extension
# for both X11 and Wayland sessions.
#

set -e

EXTENSION_UUID="stealth-lock@user"
EXTENSION_DIR="$HOME/.local/share/gnome-shell/extensions/$EXTENSION_UUID"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=============================================="
echo "  Stealth Lock Extension Installer"
echo "=============================================="
echo ""

# Check if GNOME Shell is running
if ! pgrep -x "gnome-shell" > /dev/null; then
    echo "Warning: GNOME Shell doesn't appear to be running."
    echo "The extension will be installed but you'll need to restart GNOME Shell to use it."
    echo ""
fi

# Check GNOME Shell version
GNOME_VERSION=$(gnome-shell --version 2>/dev/null | grep -oP '\d+' | head -1 || echo "unknown")
echo "Detected GNOME Shell version: $GNOME_VERSION"

if [[ "$GNOME_VERSION" != "unknown" ]] && [[ "$GNOME_VERSION" -lt 45 ]]; then
    echo "Warning: This extension is designed for GNOME Shell 45+."
    echo "Your version ($GNOME_VERSION) may not be fully compatible."
    echo ""
fi

# Create extension directory
echo "Creating extension directory..."
mkdir -p "$EXTENSION_DIR"

# Copy files
echo "Copying extension files..."
if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete --delete-excluded \
        --exclude '__pycache__/' \
        --exclude '*.zip' \
        "$SCRIPT_DIR/" "$EXTENSION_DIR/"
else
    rm -rf "$EXTENSION_DIR"
    mkdir -p "$EXTENSION_DIR"
    cp -r "$SCRIPT_DIR"/* "$EXTENSION_DIR/"
    rm -rf "$EXTENSION_DIR/__pycache__" >/dev/null 2>&1 || true
    rm -f "$EXTENSION_DIR"/*.zip >/dev/null 2>&1 || true
fi

# Make PAM helper executable
chmod +x "$EXTENSION_DIR/pam-helper.py"
chmod +x "$EXTENSION_DIR/polkit-auth-helper.py" 2>/dev/null || true
chmod +x "$EXTENSION_DIR/uninstall.sh" 2>/dev/null || true

# Compile GSettings schema
echo "Compiling GSettings schema..."
if [ -d "$EXTENSION_DIR/schemas" ]; then
    glib-compile-schemas "$EXTENSION_DIR/schemas/"
fi

# Install system-wide schema (optional, requires root)
SYSTEM_SCHEMAS_DIR="/usr/share/glib-2.0/schemas"
if [ -d "$SYSTEM_SCHEMAS_DIR" ] && [ -w "$SYSTEM_SCHEMAS_DIR" ]; then
    echo "Installing system-wide schema..."
    cp "$EXTENSION_DIR/schemas/"*.gschema.xml "$SYSTEM_SCHEMAS_DIR/"
    glib-compile-schemas "$SYSTEM_SCHEMAS_DIR/"
fi

# Check for python-pam dependency
echo ""
echo "Checking dependencies..."
if python3 -c "import pam" 2>/dev/null; then
    echo "✓ python-pam is installed"
else
    echo "✗ python-pam is not installed (optional, using fallback authentication)"
    echo "  To install: pip3 install python-pam --user"
fi

# Check for libpam (best-effort)
if python3 -c "import ctypes; ctypes.CDLL('libpam.so.0')" 2>/dev/null; then
    echo "✓ libpam is available"
else
    if python3 -c "import ctypes; ctypes.CDLL('libpam.so')" 2>/dev/null; then
        echo "✓ libpam is available"
    else
        echo "✗ libpam not found - authentication may not work"
    fi
fi

echo ""
echo "=============================================="
echo "  Installation Complete!"
echo "=============================================="
echo ""
echo "Next steps:"
echo ""
echo "1. Restart GNOME Shell:"
echo "   - X11: Press Alt+F2, type 'r', and press Enter"
echo "   - Wayland: Log out and log back in"
echo ""
echo "2. Enable the extension:"
echo "   gnome-extensions enable $EXTENSION_UUID"
echo ""
echo "3. Configure your hotkey (default: Super+Ctrl+L):"
echo "   gnome-extensions prefs $EXTENSION_UUID"
echo ""
echo "   Or use dconf/gsettings directly:"
echo "   dconf write /org/gnome/shell/extensions/stealth-lock/lock-hotkey \"['<Super><Control>l']\""
echo ""
echo "Usage:"
echo "  - Press your configured hotkey to lock"
echo "  - Type your password (invisible) and press Enter to unlock"
echo "  - Password resets after 5 seconds of inactivity"
echo ""
echo "Enjoy your stealth lock!"
