# Stealth Lock

A password-protected privacy screen for GNOME Shell, inspired by xtrlock. Your desktop remains visible while desktop input is blocked. It is intended for short absences such as stepping away for dinner or a bathroom break.

Press Super+Ctrl+L to activate, type your login password, and press Enter to dismiss it. Escape clears the password. After five seconds without keyboard activity the password clears automatically; preferences can change or disable that timeout. Normal mode shows a native password entry with a reveal button; Stealth mode keeps input invisible. Ctrl+R toggles reveal in Normal mode when GNOME permits password reveal, and Ctrl+U clears input. Clipboard paste is blocked so another person cannot paste and reveal your clipboard contents.

The extension can freeze every monitor using an in-memory snapshot, pause playing MPRIS media, and show a configurable lock cursor, the normal cursor, or no cursor. Preferences retain cursor colors/images, prompt positioning, custom CSS, and saved CSS styles. The built-in cursor preserves the original bitmap and hotspot; custom images load asynchronously and fall back to it when unavailable. Built-in colors and layout live in the central stylesheets; GNOME selects and updates the light/dark variant.

Fresh installations start with three ordinary saved visual entries: Dim and Blur, Neo Rain, and City Grow. They are initially inactive. Select one in Appearance, or use the saved-entry editor to edit its JSON settings, add your own entry, rename, duplicate, or remove entries. Starter entries have the same format and behavior as entries you save yourself. Updates and reinstalls preserve edits and deletions, including an empty library. Reduced motion stops animation while retaining a static frame and any enabled clock. Effects cannot change password handling or authentication.

Ctrl+Alt+Shift+L hands off to GNOME's native lock. Debug abort shortcuts and five consecutive Escapes do the same; they never bypass authentication. A handoff releases the privacy screen only after GNOME confirms it is locked. Paused media stays paused during handoff and resumes after GNOME unlocks. Disabling an active extension first requests the native lock and leaves media paused. If GNOME refuses that request, disabling still removes the extension and exposes the desktop; its recovery marker reapplies protection only when it is enabled again.

GNOME's per-login runtime state records an active privacy screen. If Shell restarts and reloads the extension in the same login session, the privacy screen is reapplied after Shell's startup handlers finish. Successful password authentication or completion of native locking/unlocking clears the record. The record contains no passwords or images and does not persist across logout or reboot. GNOME may disable extensions following a crash during its first minute of startup; restoration requires this extension to load. Recovery cannot protect the interval before the extension runs. Use GNOME's native lock when you need its session-lock guarantees.

## Authentication and supported environments

The declared GNOME Shell versions remain 45–48, on Linux with GDM's `gdm-password` PAM service. `/usr/bin/python3`, `libpam.so.0`, and that service are required. No Python PAM package, sudo, root installation, shadow-file access, or alternate authentication service is used. Both password authentication and PAM account validation must succeed, including PAM cleanup; every error rejects the attempt. Only one password prompt is supported. Fingerprint, smartcard, multi-factor prompts, password expiry/change, and passwordless accounts are outside this password-only flow; use the native lock for those flows.

One authentication attempt may run at a time. A failed attempt imposes a delay of 1, 2, 4, 8, 16, then at most 30 seconds. Attempts time out after ten seconds. Passwords are limited to 512 UTF-8 bytes; the native entry also caps editing at 512 characters. Oversized input is rejected without truncating it or calling PAM. Normal mode displays authentication and retry status; Stealth mode keeps feedback hidden unless diagnostics are enabled. A rejected password and unavailable authentication have distinct messages. Disabling or handing off cancels work and terminates a running helper. Passwords travel through the helper's private stdin, never command-line arguments or logs. Native widget and Python buffers are cleared when their lifetime ends; JavaScript and Python strings cannot promise cryptographic memory erasure.

## Install and remove

From the source checkout:

```sh
mise exec -- bash install.sh
```

Packaging uses `gnome-extensions pack` and verifies the exact runtime-only file inventory and nonexecutable permissions. Installation stages that archive in your user-local extension directory, compiles its local schema, and preserves the previous installation if replacement fails. It never writes system schemas. Log out and back in to load new code, then enable `stealth-lock@user` in Extensions. Installation itself does not enable or reload the running extension.

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
mise exec -- npm run test:auth
PYTHONDONTWRITEBYTECODE=1 mise exec -- python3 -m unittest discover -s tests/auth
mise exec -- npm run check
mise exec -- npm run test:shell
mise exec -- npm run package
```

The full check additionally requires `gjs-check-syntax` and `gjs-check-potfiles` from [GNOME's GJS CI tools](https://gitlab.gnome.org/World/javascript/gjs-ci-tools), REUSE, GLib schema tools, `gnome-extensions`, zip, and unzip. CI installs pinned tooling and runs these gates. The package is written to `dist/`; compiled schemas are generated during installation, never in the source tree or release archive.

Unit tests cover authentication, cancellation, retry timing, setup failures, reverse cleanup, native handoff, recovery state, input protection, cursor loading, saved presets, and packaging. Python tests use fake PAM transactions; GJS authentication tests exercise real subprocesses with a fake helper. Neither authenticates a real account. Shell tests use a separate headless compositor, temporary home/settings, private system and session buses, a separate user/network namespace, software rendering, and systemd resource limits. They include an actual compositor kill/restart and recovery after startup. The authentication helper and GDM service are test substitutes. They do not install the extension into the current desktop. See [the fixture documentation](tests/shell/README.md) for coverage and requirements. Real keyboard layouts, IME engines, mixed-scale monitors, native GDM authentication, suspend and distribution-specific recovery still require the manual matrix in [REVIEW.md](REVIEW.md).

## Settings migration

The UUID, schema ID, and existing safe setting keys are retained. The legacy `lock-cursor` value migrates to `cursor-mode` when there is no explicit cursor-mode value. JavaScript stored in settings is retained for export but never executed; its editors, execution API, and the old snippet files are removed. Export previous snippets with:

```sh
gsettings --schemadir ~/.local/share/gnome-shell/extensions/stealth-lock@user/schemas get org.gnome.shell.extensions.stealth-lock normal-prompt-custom-js
gsettings --schemadir ~/.local/share/gnome-shell/extensions/stealth-lock@user/schemas get org.gnome.shell.extensions.stealth-lock normal-prompt-custom-js-saved-entries
```

The source installer distinguishes a fresh directory from an update and initializes the saved effect library once. Standard ZIP installation has no install hook: initialization happens when the extension or preferences first loads, preserving profiles with existing user settings. An old profile that has only untouched defaults is indistinguishable from a fresh profile and receives inactive starter entries. Existing JavaScript is retained separately and never migrated into executable effects.

Saved effect configurations use `{ "effect": "neo-rain", "knobs": {} }`, with effect values `blur`, `neo-rain`, or `city-grow`. The seeded entries expose the supported knobs and defaults. Colors are optional RGBA byte arrays; `null` uses the central theme. Clock settings support locale-formatted dates, 12/24-hour time, seconds, alignment, size, vertical position, and a monitor index, `settings`, or `all`. Unknown fields, invalid ranges, and invalid JSON are rejected before saving or rendering. Malformed saved libraries are preserved for repair.

Prompt/background CSS, the selected effect and its saved configuration, reduced motion, and GNOME theme changes apply immediately. Most other presentation settings take effect on the next activation; changing the monitor layout requests native locking instead of showing a stale frozen frame. Cursor mode, lock type and pointer anchor use native schema enums while retaining compatible stored strings. Coordinate settings retain their full signed 32-bit range: explicit positions are relative to the virtual desktop origin, clamped to the selected display, and negative fixed coordinates center the corresponding axis. [REVIEW.md](REVIEW.md) records remaining product and release decisions.

## Co-developed with LLMs

This project is co-developed with LLMs. Human maintainers remain responsible for reviewing, understanding, researching, and testing accepted contributions.
