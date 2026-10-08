# Implementation and release review

Stealth Lock provides a visible-desktop privacy screen for short absences. The agreed distribution method is `install.sh`, the interface is English for this release, and the target is every stable GNOME Shell release from 45 through the latest stable release, currently [GNOME 51](https://release.gnome.org/51/). These product decisions are settled.

## Implemented behavior

| Area | Behavior |
| --- | --- |
| Password authentication | The default PAM service is `gdm-password`. Administrators can select one service filename in `/etc/pam.d` for other systems; there is no automatic service fallback. The service and its containing path must be root-owned and not writable by group or others. The helper derives the account from the current UID and requires a secret prompt, successful authentication, account approval and successful cleanup. Passwords are never saved or logged. |
| Additional authentication | The System Lock Screen preference uses GNOME's native lock and its configured fingerprint, smartcard, MFA and account-policy flows. Password-change conversations also belong to the native lock. Which methods work depends on the system's configuration. |
| Attempts and feedback | One attempt runs at a time, with a ten-second deadline and a 512-byte UTF-8 password limit. Exponential retry delays default to 1/2/4/8/16/30 seconds; initial and maximum delays are adjustable. Normal mode shows denied/unavailable/retry status, Caps Lock and the input layout. Audible failure feedback is optional. Stealth mode keeps the prompt hidden. |
| Native input | GNOME PasswordEntry owns Unicode editing and IME handling. Escape/Ctrl+U clear input; Ctrl+A and native cursor/selection navigation work. Normal mode supports policy-controlled keyboard, mouse and touch reveal, with an adjustable concealment timeout. Inactivity clearing is adjustable. Clipboard paste, copy, cut and middle-click paste are blocked. |
| Protection and handoff | Modal acquisition must include both keyboard and pointer. Ctrl+Alt+Shift+L and optional diagnostic shortcuts request native locking. The privacy screen releases only after confirmed native locking. Disable requests native locking; if GNOME refuses it, extension teardown can expose the desktop. |
| Recovery | Per-login Shell runtime state records an active screen. Reloading the enabled extension reapplies protection after Shell startup. Passwords and screenshots are never persisted. The extension cannot cover the interval before loading or prevent GNOME from disabling extensions after an early startup crash. A Wayland crash can end the login session. GNOME's asynchronous persistence makes recovery best effort; an abrupt crash can leave the previous or missing snapshot. |
| Media | Only playing MPRIS players are paused. Restoration uses the original unique D-Bus owner, bus identity and session epoch. An extension-owned runtime record coordinates live lock state and playback intent across enable/disable; native runtime files store asynchronous recovery snapshots. Intent survives a Shell restart within the same bus/login. External playback changes and disappearing owners remove restoration eligibility. Pending Pause/Play replies, relocking and replacement sessions are coordinated. Native handoff keeps media paused until native unlock; disable leaves it paused. |
| Monitors | The prompt stores a stable connector when available. Monitor changes retain the modal/input owner, clear typed secrets and recapture the frozen desktop. Obsolete captures cannot overwrite a newer layout. Capture failure requests native locking. Positions are clamped to a physical display and support signed 32-bit coordinates. |
| JavaScript programs | Dim and Blur, Neo Rain and City Grow are ordinary editable JavaScript entries seeded once and initially inactive. User-created entries use the same runtime and CRUD. Edits, deletion and an empty library survive reinstall. No privileged built-in algorithm executes the saved code. See [the program API](docs/VISUAL_PROGRAMS.md). |
| Isolation and visual limits | A separate Bubblewrap worker runs JavaScriptCore without host home, buses, display, network, GI, Shell actors, credentials or lock controls. Bounded commands reach the trusted renderer. Each worker has a 512 MiB address-space ceiling and 25 ms CPU/500 ms wall frame deadlines. Native raster work is separately budgeted across paints, paths, strokes and text, with a roughly 4-million-pixel surface. A failed program removes its decoration while retaining input protection. |
| Appearance | Central styles own colors. Native blur, Cairo/Pango drawing and locale-aware clocks render below the prompt. Reduced motion keeps a static drawing while clocks continue. CSS, saved programs, theme variants, motion settings, prompt placement and emergency shortcuts update live; authentication policy and other session choices apply on the next activation. |
| Installation and release | The installer stages an explicitly listed runtime payload, validates the sandbox and initializes entries before replacing user-local files. Failed replacement restores installed files. Settings writes are not rolled back. The installer does not enable or reload Shell. Source archives are reproducible, with optional detached OpenPGP signatures and independent verification. |
| Automation and license | CI runs quality checks and an actual GNOME 45–51 runtime matrix using pinned official base images. GPL-3.0-only and RisPNG ownership are recorded through REUSE. Gettext extraction is maintained; English is the only release language. |

## Validation evidence

The integrated GNOME 48.7 Wayland fixture passed 34 native scenarios with no skips. It exercises screenshots, modal input interception, native password editing/composition, cursor restoration, virtual monitors, live themes, isolated JavaScript starters and custom programs, clocks, reduced motion, worker termination, actual GTK preferences, private-bus MPRIS races, native screen-shield handoff and compositor SIGKILL/restart recovery. A private fake GDM drives the stock screen shield; password outcomes use a sentinel-verified fixture helper.

Unit and subprocess suites cover policy, cancellation, stale results, retries, resource ownership, bounded drawing, editor lifecycle, one-time initialization and installer/release behavior. Deferred-persistence cases verify live lock/media ownership independently of asynchronous disk snapshots; native checks separately wait for recovery snapshots to settle. Isolated real Linux PAM tests cover correct/wrong passwords, locked accounts, account/password expiry, failure lockout/reset and unsafe/missing services using disposable namespace accounts. They never submit a wrong password to the desktop user's account.

A prior attended check on this machine passed one genuine login-password authentication through `gdm-password`, and a genuine native lock/unlock cycle. The verified current implementation is installed with all 27 source payload files matching and settings preserved. It remains disabled until a fresh host login loads the new modules; the attended physical overlay test was deferred by the user. The private fixture selects the real IBus US engine; physical devices, other IME engines, suspend and display-manager crash behavior require actual-session acceptance.

The GNOME 45–51 CI matrix runs actual runtimes. Only 48.7 has been executed locally. Version support is accepted from passing native jobs; a source/API review or metadata declaration is insufficient evidence.

## Release acceptance

These checks apply before publishing a source release:

- Load the verified build on the current desktop and complete attended activation, physical input blocking and password dismissal. Updating Shell modules requires logout/login; the session will not be restarted automatically.
- Run and inspect the GNOME 45–51 matrix after the reviewed commits reach the remote. Local Docker access is unavailable, so those jobs cannot run on this host through the container runner.
- Build and verify the maintainer-signed source archive after committing the checked source. The selected public fingerprint is recorded in [the release guide](docs/RELEASING.md); the private key and passphrase remain local.
- Approve the prepared nonmerge commit subjects before pushing, as required by the repository instructions.

There are no outstanding product choices for the implemented scope. Translations beyond English and distribution through extensions.gnome.org remain outside this release by decision.

## Manual acceptance on actual systems

| Scenario | Acceptance |
| --- | --- |
| Activation | Test video, multiple monitors, negative monitor positions, scaling/rotation, overview and an existing modal. Confirm full input protection or a clear activation failure. |
| Devices | Try Super, Alt+Tab, Alt+F2, other shortcuts, mouse buttons, touch and scroll. Only intended password/reveal controls should react. |
| Input engines | Check actual layouts/IBus engines, Unicode, composition-only clearing, delayed engine responses, selection, reveal concealment and inactivity clear. Use disposable accounts for rejection/account/lockout testing. |
| Native transitions | Test automatic lock, idle blanking, suspend/resume, user switching and dialogs from existing apps. Confirm native lock before privacy teardown and media restoration only at the correct endpoint. |
| Recovery | Test the distribution's actual Shell/display-manager crash policy, including immediate activation crashes and authenticated dismissal. Confirm no stale secret/frame or unwanted activation after a new login. |
| Resources | Repeat activation/dismissal and enable/disable; verify actors, grabs, signals, sources, workers, textures and memory return to baseline. |
| Distribution | Repeat preferences, all programs, clocks, themes, cursor modes/images, monitor changes and install/reinstall/uninstall on each target runtime. Edits and an empty library must remain intact. |

For example, changing the options inside your saved Neo Rain program changes that entry alone. Removing all three starter entries leaves the library empty after reinstall. Choosing System Lock Screen delegates sign-in to GNOME's configured authentication methods.
