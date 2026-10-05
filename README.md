# Stealth Lock

A password-protected privacy screen for GNOME Shell, inspired by xtrlock. Your desktop remains visible while desktop input is blocked. It is intended for short absences such as stepping away for dinner or a bathroom break.

Press Super+Ctrl+L to activate, type your login password, and press Enter to dismiss it. Escape clears the password. After five seconds without keyboard activity the password clears automatically; preferences can change or disable that timeout. Normal mode shows a native password entry with a reveal button; Stealth mode keeps input invisible. Ctrl+R toggles reveal in Normal mode and Ctrl+U clears input. Clipboard paste is blocked so another person cannot paste and reveal your clipboard contents.

The extension can freeze every monitor using an in-memory snapshot, pause playing MPRIS media, and show a configurable lock cursor, the normal cursor, or no cursor. Preferences retain cursor colors/images, prompt positioning, custom CSS, and saved CSS styles. Built-in colors live in `stylesheet.css`.

Ctrl+Alt+Shift+L hands off to GNOME's native lock. Debug abort shortcuts and five consecutive Escapes do the same; they never bypass authentication. A handoff releases the privacy screen only after GNOME confirms it is locked. Paused media stays paused during handoff and resumes after GNOME unlocks. Disabling an active extension first requests the native lock and leaves media paused. If GNOME refuses that request, disabling still removes the extension and exposes the desktop; its recovery marker reapplies protection only when it is enabled again.

GNOME's per-login runtime state records an active privacy screen. If Shell restarts and reloads the extension in the same login session, the privacy screen is reapplied. Successful password authentication or completion of native locking/unlocking clears the record. The record contains no passwords or images and does not persist across logout or reboot. Extension loading still occurs after Shell starts: recovery cannot protect the interval before the extension runs. Use GNOME's native lock when you need its session-lock guarantees.

## Authentication and supported environments

The declared GNOME Shell versions remain 45–48, on Linux with GDM's `gdm-password` PAM service. `/usr/bin/python3`, `libpam.so.0`, and that service are required. No Python PAM package, sudo, root installation, shadow-file access, or alternate authentication service is used. Both password authentication and PAM account validation must succeed, including PAM cleanup; every error rejects the attempt. Only one password prompt is supported. Fingerprint, smartcard, multi-factor prompts, password expiry/change, and passwordless accounts are outside this password-only flow; use the native lock for those flows.

One authentication attempt may run at a time. A failed attempt imposes a delay of 1, 2, 4, 8, 16, then at most 30 seconds. Attempts time out after ten seconds. Disabling or handing off cancels work and terminates a running helper. Passwords travel through the helper's private stdin, never command-line arguments or logs. Native widget and Python buffers are cleared when their lifetime ends; JavaScript and Python strings cannot promise cryptographic memory erasure.

## Install and remove

From the source checkout:

```sh
mise exec -- bash install.sh
```

Installation copies only the extension payload to your user-local extension directory and compiles its local schema. It never writes system schemas. Log out and back in to load new code, then enable `stealth-lock@user` in Extensions. Installation itself does not enable or reload the running extension.

```sh
mise exec -- bash uninstall.sh
mise exec -- bash uninstall.sh --purge-settings
```

Settings are retained unless `--purge-settings` is supplied. Old system-wide copies or schemas from earlier installers require separate manual cleanup; the new scripts manage only the user-local installation.

## Build and verify

```sh
mise exec -- npm ci
mise exec -- npm run lint
mise exec -- npm test
PYTHONDONTWRITEBYTECODE=1 mise exec -- python3 -m unittest discover -s tests/auth
mise exec -- npm run check
mise exec -- npm run test:shell
mise exec -- npm run package
```

The full check additionally requires `gjs-check-syntax` and `gjs-check-potfiles` from [GNOME's GJS CI tools](https://gitlab.gnome.org/World/javascript/gjs-ci-tools), REUSE, GLib schema tools, zip, and unzip. CI installs pinned tooling and runs these gates. The package is written to `dist/`; the compiled schema is generated in staging, never in the source tree.

Unit tests cover authentication, cancellation, retry timing, setup failures, reverse cleanup, native handoff, recovery state, input protection, and packaging. Python tests use fake PAM transactions and never authenticate a real account. Shell tests use a separate headless compositor, temporary home/settings, and a separate D-Bus session; authentication and native lock transitions are stubbed where they would affect the host. They do not install the extension into the current desktop. Real keyboard layouts, IME, mixed-scale multi-monitor setups, native GDM authentication, suspend and crash recovery still require the manual matrix in [REVIEW.md](REVIEW.md).

## Settings migration

The UUID, schema ID, and existing safe setting keys are retained. The legacy `lock-cursor` value migrates to `cursor-mode` when there is no explicit cursor-mode value. JavaScript stored in settings is retained for export but never executed; its editors, execution API, and the old snippet files are removed. Export previous snippets with:

```sh
gsettings --schemadir ~/.local/share/gnome-shell/extensions/stealth-lock@user/schemas get org.gnome.shell.extensions.stealth-lock normal-prompt-custom-js
gsettings --schemadir ~/.local/share/gnome-shell/extensions/stealth-lock@user/schemas get org.gnome.shell.extensions.stealth-lock normal-prompt-custom-js-saved-entries
```

Prompt/background CSS updates apply immediately. Most presentation settings take effect on the next activation; changing the monitor layout requests native locking instead of showing a stale frozen frame. [REVIEW.md](REVIEW.md) records remaining product and release decisions.

## Co-developed with LLMs

This project is co-developed with LLMs. Human maintainers remain responsible for reviewing, understanding, researching, and testing accepted contributions.
