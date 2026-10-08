# Stealth Lock

Stealth Lock is a password-protected privacy screen for GNOME Shell. It keeps your desktop visible while blocking keyboard and mouse input.

The idea came from [xtrlock](https://manpages.debian.org/unstable/xtrlock/xtrlock.1.en.html), which was built for X11. I started this extension to bring that idea to GNOME Shell on both X11 and Wayland. It has since grown into its own project, with more features and appearance settings.

## But why?

That depends on your use case.

You might want to keep a movie or music playing without accidental input skipping playback, changing the volume, or minimising a window.

You might also want a different appearance for the privacy screen. You can change the password prompt, cursor and visual effects, or use custom CSS to style it yourself.

## Install

The project targets GNOME Shell 45–51 on Linux. Password authentication currently requires GNOME's login manager, GDM.

Run this from the source checkout as your desktop user, without sudo:

```sh
mise exec -- bash install.sh
```

Then log out and back in, and enable `stealth-lock@user` in Extensions. The installer does not enable it for you. It installs only for your user and keeps your existing settings.

<details>
<summary>Tools needed for source installation</summary>

The commands use mise. Installation also needs Bash, `gnome-extensions`, GJS, GLib schema tools, unzip and `/usr/bin/python3`. Node and npm are only needed for development checks.

The extension is installed in `$XDG_DATA_HOME/gnome-shell/extensions/stealth-lock@user`, or `~/.local/share/gnome-shell/extensions/stealth-lock@user` when `XDG_DATA_HOME` is unset.

</details>

## Using Stealth Lock

Press Super+Ctrl+L to activate it. To unlock, type your login password and press Enter. You can change the activation shortcut in preferences.

By default, Stealth mode keeps your password input invisible. If you prefer a visible password box, choose Normal mode. Normal mode also shows whether authentication failed and when you can try again. After a failed attempt, you need to wait before trying again.

| Key | Action |
| --- | --- |
| Escape or Ctrl+U | Clear what you have typed |
| Ctrl+R | Show or hide the password in Normal mode, if GNOME allows it |
| Ctrl+Alt+Shift+L | Switch to GNOME's native lock screen |

Your typed password clears after five seconds without keyboard activity. You can change or disable that timeout in preferences. Pasting is blocked so someone cannot paste and reveal your clipboard contents.

## Customise it

Preferences let you choose how Stealth Lock looks and behaves:

- **Freeze Display** keeps a still image of your desktop on screen. Turn it off to let the display keep updating.
- **Pause Media** pauses playback in supported media players and tries to resume it when you unlock. Turn it off if you want playback to continue.
- **Cursor** lets you use the lock icon, keep your normal cursor or hide it. You can also change its colours or use a custom image.
- **Password prompt** can follow the pointer or stay at a chosen position on a selected monitor.
- **Appearance** includes saved visual effects, clocks and custom CSS.

Freeze Display and Pause Media are enabled by default. To keep a movie playing and visible, turn both off.

A new settings profile starts with three optional effects: Dim and Blur, Neo Rain and City Grow. They are initially inactive. Select one in Appearance, or edit, duplicate and remove entries to make your own collection. The library initializes once per profile; your edits and deletions persist across reinstalls. If you prefer less movement, reduced motion keeps a still version of the effect.

CSS and visual effect changes appear immediately. Most other choices take effect the next time you activate Stealth Lock.

## A note about locking

Stealth Lock depends on the extension running. Use GNOME's own lock screen when you need protection that does not depend on this extension. Stealth Lock uses your login password; fingerprint, smartcard and multi-factor sign-in are not supported.

Ctrl+Alt+Shift+L keeps the privacy screen in place until GNOME confirms that its native lock is active. Media paused by Stealth Lock stays paused until GNOME unlocks.

Disabling Stealth Lock while it is active also requests native locking and leaves paused media paused. If that request fails, disabling still removes the privacy screen and exposes the desktop. After a Shell restart, Stealth Lock can restore the privacy screen if the extension loads again, but it cannot protect the interval before it loads.

## Update or remove

Before updating, unlock Stealth Lock and disable it in Extensions. Run the installation command again, then log out and back in and enable it. Your settings are kept.

To remove the extension and keep its settings:

```sh
mise exec -- bash uninstall.sh
```

To remove it and reset its settings instead:

```sh
mise exec -- bash uninstall.sh --purge-settings
```

Choose one removal command. Resetting settings needs the installed files, so it must be done before they are removed. These scripts manage only your user installation.

## Development

To install the development dependencies, run the checks and build an archive:

```sh
mise exec -- npm ci
mise exec -- npm run check
mise exec -- npm run package
```

The archive is written to `dist/`. The checks need GJS, Python, GNOME Shell tools, GLib schema tools, zip, unzip, REUSE and [GNOME's GJS CI tools](https://gitlab.gnome.org/World/javascript/gjs-ci-tools).

The separate [headless Shell tests](tests/shell/README.md) run with `mise exec -- npm run test:shell`. [REVIEW.md](REVIEW.md) covers implementation details, tested environments, authentication limits and the remaining manual checks.

The layout separates GNOME entrypoints, Shell code, shared settings and the authentication helper:

```text
extension.js, prefs.js, metadata.json    GNOME entrypoints
stylesheet*.css                         GNOME theme entrypoints
shell/                                  Session, authentication transport, input and presentation
  effects/                              Backdrop rendering and City Grow
shared/                                 Saved-entry and effect configuration
helpers/                                Python PAM authentication
styles/                                 Shared theme definitions
schemas/                                GSettings schema
scripts/                                Development checks
tests/                                  Unit, authentication and isolated Shell tests
```

- `extension.js` owns enablement and registered shortcuts. It supplies settings, the installation path and current shortcut actions to `LockSession`.
- `shell/lockSession.js` owns protection, native lock transitions, cancellation and reverse cleanup. `shell/media.js` retains paused players separately until authenticated dismissal or native unlock; disable discards restoration.
- `shell/input.js` owns native password editing and reveal permissions. `shell/overlay.js` borrows its actor for presentation; `shell/effects/backdrop.js` and `shell/effects/city.js` own visual rendering without access to credentials.
- `shell/authentication.js` owns helper transport and retry timing; `helpers/authentication.py` owns the PAM transaction. `shell/screenshot.js` owns native capture and `shell/integration.js` isolates startup and screen-shield integration.
- `shared/presets.js` owns saved-entry validation, effect configuration and one-time initialization. It is used by Shell, preferences and the installer. `prefs.js` owns the native settings UI and shared saved-entry editor. Central stylesheets own the theme.

Unit tests execute unchanged ES modules with explicit native dependency mocks, using Node's VM module flag through `npm test`. Installer integration tests execute the real initializer with temporary HOME/XDG directories and a private settings backend. `package.sh` defines the runtime payload once and verifies the resulting archive against it.
