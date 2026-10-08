# Implementation and release review

The agreed product is a visible-desktop privacy screen for short absences, with input protection, password authentication and restoration when GNOME reloads it after Shell recovery. Installation from source through `install.sh` is the distribution method. The compatibility target is every stable GNOME Shell release from 45 through the latest stable release, currently [GNOME 51](https://release.gnome.org/51/). An extensions.gnome.org release is not planned.

This review separates implemented behavior, required follow-up, optional future work and validation still required. The optional items do not need decisions before using the current feature set. Advertising a compatibility target does not mean every target version or distribution has passed real-session testing.

## Implemented behavior and settled scope

| Area | Current behavior |
| --- | --- |
| Authentication | Fixed `gdm-password`, UID-derived user, one secret prompt, authentication/account/cleanup all required. One attempt at a time, ten-second deadline, failure delays of 1/2/4/8/16/30 seconds, and a 512-byte UTF-8 limit. No alternate PAM service or passwordless, fingerprint, smartcard, multi-factor or password-change flow is implemented. Normal mode shows distinct denied/unavailable and retry messages; Stealth mode hides them except diagnostics. Passwords and buffer lengths are never logged. |
| Input and accessibility | Native PasswordEntry provides keyboard layout/IME handling and Unicode editing, with a 512-character editing ceiling. It supports Escape, Backspace, Return, inactivity clear, Ctrl+U and Normal-mode reveal; reveal follows GNOME policy. Clipboard paste, middle-click paste and desktop shortcuts are blocked. |
| Emergency and disable | Ctrl+Alt+Shift+L, the configured diagnostic abort shortcut and Escape×5 request native locking. A handoff releases the privacy screen only after confirmed native locking. Disable requests native locking and leaves media paused; if GNOME refuses, extension teardown exposes the desktop. Re-enabling with a retained marker restores the privacy screen, but cannot protect the disabled interval. |
| Crash recovery | Per-login Shell runtime state records an active privacy screen. If Shell reloads the enabled extension, it restores protection after startup handlers finish. GNOME may disable extensions after a startup failure within its first minute; a normal Wayland failure may end the login session. The extension cannot force itself to load or cover the interval before loading. Marker writes use GNOME's asynchronous persistence. Recovery takes a new capture; old passwords and frozen frames are never persisted. |
| Media | Playing MPRIS players are paused and resume only through the same unique D-Bus owner. A restarted player with the same public name is not started. Media remains paused during native handoff until unlock, and remains paused on disable. Restore records do not survive Shell crashes. |
| Monitors and placement | Layout changes request native locking. Prompt placement follows the pointer or uses a monitor index/fixed coordinates, clamped to a physical display rather than a monitor gap. Coordinate settings support the full signed 32-bit range. Negative fixed coordinates center the corresponding axis. |
| Effects and themes | A new settings profile receives three ordinary editable/deletable JSON entries, initially inactive: Dim and Blur, Neo Rain and City Grow. The library initializes once per profile; reinstalls preserve edits and deletion, including an empty library. Native clocks follow the locale. Reduced motion retains a static frame. CSS, saved effect selection/configuration, reduced motion, theme variants and emergency shortcut settings update live; other presentation choices generally apply at the next activation. Saved effects use validated JSON configurations. |
| Installation | The source installer stages a slim native GNOME archive, compiles only the local schema and initializes presets before replacing user-local files. Failed replacement restores the installed files; successful replacement removes the temporary backup. Settings writes are not rolled back. The installer does not enable or reload Shell. |
| License and translation | GPL-3.0-only and the established human owner RisPNG are recorded in REUSE. Gettext source strings are listed; translations are not provided. |

## Required follow-up

The saved visual entries currently contain JSON settings for built-in effects. This does not fulfill the agreed editable JavaScript model. Dim and Blur, Neo Rain and City Grow must be ordinary JavaScript entries seeded once, using the same execution path as entries users create themselves. Users must be able to edit or delete them permanently. A separately isolated renderer must keep these programs away from credentials, authentication and lock controls. That correction is still unimplemented.

## Optional future enhancements

- Authentication on systems without GDM, additional authentication mechanisms, and account-policy flows would need an explicit authentication design. The native lock remains the supported route for those flows.
- Configurable retry timing, additional accessible or audible feedback, Caps Lock/layout indicators, touch reveal, reveal timeouts and additional password navigation shortcuts can be considered when a concrete need appears.
- Remembering paused players across crashes, handling external playback changes, stable monitor connector selection and recapturing after hotplug/rotation/scaling would extend current session behavior.
- More live settings, additional effect knobs and measured performance budgets on large desktops are future visual features.
- Translations and signed source releases may be added later.

## Remaining real-session validation

Native automated evidence currently covers GNOME 48.7 Wayland in the isolated fixture. GNOME 45–47 and 49–51, other distributions, and X11 on releases that provide it still need validation. One authorized successful login-password check passed on the current desktop user through the authentication module, Python helper, real `gdm-password` service and PAM account/cleanup checks. A real GNOME native lock/unlock cycle also passed. Physical input blocking and password dismissal in the actual overlay await attended confirmation. Real PAM rejection, account-denial and lockout policies remain untested. Source compatibility checks and declared metadata are not substitutes for this matrix.

## Manual acceptance matrix

- Activate with apps playing video, multiple monitors, negative monitor positions, scaling/rotation, overview open, and another modal active. Confirm either full keyboard/pointer protection or a clear activation failure.
- Try Super, Alt+Tab, Alt+F2, desktop/extension shortcuts, all mouse buttons, touch and scroll against applications. Verify only intended password input and reveal controls react.
- Check each layout/IME, Unicode passwords, Backspace, Escape, empty submission, wrong password, account denial, timeout, repeated Enter, retry timing, reveal concealment and auto-clear. Accept IME candidates with Enter; clear composition-only input with Escape, Ctrl+U and inactivity; check delayed engine responses after clearing. An authorized own-password success may be checked in the user's session. Use disposable test accounts/sessions for real wrong-password, account-denial and lockout-policy tests.
- Disable at every acquisition/await and while authenticating. Confirm no late overlay, no helper left alive, no stale successful result dismissing a new screen, and complete cleanup despite one teardown failure.
- Confirm native locking succeeds before overlay teardown; test denied native lock, normal automatic locking, idle blanking, suspend/resume, user switching and dialogs opened by existing applications while active. Verify media stays paused until the chosen endpoint.
- Test Shell restart/crash while active and after successful dismissal, including crash immediately after activation. Confirm recovery marker restoration, no obsolete password/frame persisted, and no unwanted reactivation after logout/login. Include the distribution's real display-manager failure policy, which the private fixture bypasses.
- Test playing/paused/stopped/disappearing/restarted MPRIS players, cancellation during Pause, externally changed playback and relocking before restoration completes.
- Repeat activation/dismissal and enable/disable cycles. Check actors, modal grabs, signals, sources, helpers, textures and memory return to baseline; inspect Shell logs for errors.
- Verify preferences, CSS and visual library operations, all three effects, clock placement, reduced motion, custom cursor images/colors, all placement/cursor modes, light/dark appearance, source install/reinstall/uninstall and failed file replacement on every target version. Confirm settings, edited entries and an empty deleted library survive reinstalls.

## Automated validation scope

Node and Python suites cover owned resources, authentication policy, cancellation, retries, recovery state, media restoration, native input ordering, saved preset initialization/validation, and isolated distribution scripts. GJS tests exercise actual subprocess I/O, cancellation, exits, and the ten-second timeout using a fake helper. Real source-installer smoke tests use temporary HOME/XDG directories, a private keyfile settings backend and disabled buses; they prove inactive starter entries, preserved user values, and edits/deletion surviving reinstalls without modifying the host installation.

The headless GNOME 48.7 Wayland suite exercises native screenshot textures, PasswordEntry editing/submission, modal input interception, cursor/focus restoration, Shell input-method composition clearing, multiple virtual monitors, live theme variants, MPRIS owners, actual GTK preferences, native blur and Cairo/Pango rain/City renderers, clock placement, reduced motion, effect failure cleanup, and actual compositor SIGKILL/restart recovery. Native virtual activation invokes the registered shortcut. A private fake GDM allows the real screen shield's handoff/unlock lifecycle to run; that coverage is explicitly skipped when the substitute is disabled. Actual account authentication, physical input devices, other GNOME releases, suspend, and full display-manager crash behavior remain manual checks. These checks do not constitute a production security audit.
