# Stealth Lock

Stealth Lock provides an alternative way for you to lock your screen. It is basically a screen lock rather than a lock screen, but that really depends on how you set it up.

The idea came from [xtrlock](https://manpages.debian.org/unstable/xtrlock/xtrlock.1.en.html), and I wanted that experience in GNOME, on both X11 and Wayland. It has since grown into its own project, with more ways to make the screen look and behave how you want.

## Why?

You might want to leave a movie playing without someone skipping it, changing the volume, or minimising the window.

You might simply prefer to see your desktop while you step away.

Stealth Lock lets you do these with a choice of your own customizable screen lock effects.
## Installation and Update

Stealth Lock should work on GNOME 45 onwards. Run either command from your desktop account to install or update, then log out and back in to load the new code.

Latest stable release:

```sh
curl -fsSL https://github.com/RisPNG/stealth-lock/releases/download/latest-release/install.sh | bash -s -- --release
```

Current development build:

```sh
curl -fsSL https://raw.githubusercontent.com/RisPNG/stealth-lock/main/install.sh | bash
```

The installer downloads and checks the published source archive, installs for your user and removes its temporary files. Rerun the same command to update; your settings and saved effects are preserved. The [runtime requirements](dev/README.md#requirements) still apply.

If you already have the source, install or update it with:

```sh
bash install.sh
```

## Usage

By default, once the extension is enabled, you can simply activate Stealth Lock with **Super+Ctrl+L**. Type your login password and press **Enter** to unlock. You can change the shortcut in the extension settings.

**Stealth mode** keeps the password input invisible. **Normal mode** gives you a visible password box, with Caps Lock, keyboard layout and authentication feedback. By default, your typed password automatically clears after five seconds without keyboard activity.

| Key | Action |
| --- | --- |
| Escape or Ctrl+U | Clear what you have typed |
| Ctrl+R | Show or hide your password in Normal mode, if GNOME allows it |
| Ctrl+A, arrows, Home and End | Select and move through your typed password |
| Ctrl+Alt+Shift+L | Switch to GNOME's native lock screen |

Pasting is blocked so someone cannot paste and reveal your clipboard contents.

## Settings

Open the extension settings to configure Stealth Lock:

- **Freeze Display** keeps a still image of your desktop on screen. Turn it off to let the display keep updating.
- **Pause Media** pauses supported players and tries to resume them when you unlock.
- **Cursor** lets you use the lock icon, your normal cursor, or no cursor. Choose its colours or supply your own image.
- **Password prompt** can follow your pointer or stay at a chosen position on a selected monitor.
- **Appearance** gives you saved visual effects, clocks and custom CSS.

Freeze Display and Pause Media are **on by default**. To keep a movie playing and visible, turn both off.

Your first settings profile comes with three optional effects: **Dim and Blur**, **Neo Rain**, and **City Grow** to give you a sense of what Stealth Lock is capable of. They start inactive. Edit, duplicate, or remove them just like entries you add yourself. They are added only once, so reinstalling preserves your collection, even if you have deleted every entry.

Changes to effects, CSS, and the prompt position show immediately. Other session choices take effect the next time you activate Stealth Lock.

## Uninstallation

To remove the extension and keep your settings:

```sh
curl -fsSL https://raw.githubusercontent.com/RisPNG/stealth-lock/main/uninstall.sh | bash
```

To remove it and reset your settings instead:

```sh
curl -fsSL https://raw.githubusercontent.com/RisPNG/stealth-lock/main/uninstall.sh | bash -s -- --purge-settings
```

Choose one removal command. Resetting settings needs the installed files, so use that option before removing them.

With a local source copy, use `bash uninstall.sh` or `bash uninstall.sh --purge-settings` instead.

## Development

See the [development guide](dev/README.md) for the project structure, custom visual program API, tests and release process. The interface is English for this release.
