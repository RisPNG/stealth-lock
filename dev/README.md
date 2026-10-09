# Development guide

The [main README](../README.md) covers installation and everyday use. This guide explains the system's contracts, the saved visual program API, development checks, private native tests and source releases.

The project targets GNOME Shell 45–51. English is the release language, and distribution uses the source installer. The project is licensed under GPL-3.0-only; see [LICENSE](../LICENSE).

## Requirements

Run development commands through mise. The repository's [mise.toml](../mise.toml) pins Node 24.21.0, uv 0.12.5, Meson 1.3.2 and Ninja 1.11.1.3. It also records system requirements and distribution package names. Install those system packages through your distribution; mise does not replace GNOME's libraries or the interpreter at `/usr/bin/python3`.

| Purpose | System requirements |
| --- | --- |
| Install and run | Bash 4.3 or later, `gnome-extensions`, GJS 1.78 or later, GTK 4.12 or later, libadwaita 1.4 or later, GLib 2.76 or later with schema tools and introspection bindings, unzip and `/usr/bin/python3` |
| Visual worker | Bubblewrap 0.8.0 or later at `/usr/bin/bwrap`, JavaScriptCoreGTK 6 at `libjavascriptcoregtk-6.0.so.1`, systemd 254 or later at `/usr/bin/systemd-run` with a running user manager and cgroup v2 memory/swap controllers, and unprivileged user namespaces |
| Password authentication | Linux PAM and an administrator-approved service in `/etc/pam.d`; the default is `gdm-password` |
| Source checks and packaging | The runtime requirements, GNOME Shell tools, zip, gettext, OpenSSL, GnuPG and GNOME's pinned GJS CI tools |
| Native session tests | GNOME Shell, D-Bus, a user systemd manager, IBus with the US engine, and unprivileged user/network namespaces |
| Container matrix | Docker, with permission to run the isolated systemd containers described below |

The installer validates the visual sandbox before changing settings or replacing installed files. Node and npm are development tools; they are not extension runtime dependencies. Ordinary installation and removal use `bash install.sh` and `bash uninstall.sh` without the development toolchain.

## Work on the extension

Install the tools and JavaScript dependencies, then run the checks:

```sh
mise install
mise run setup:gjs
mise exec -- npm ci
mise exec -- npm run check
```

`setup:gjs` verifies the official GJS CI tools archive against the revision and checksum recorded in `mise.toml`, builds it into ignored `dev/.tools/gjs-ci-tools`, and makes its commands available through mise's PATH. It does not install the tools globally.

`npm run check` runs lint, unit tests, isolated authentication and visual worker tests, native GJS transport checks, shell-script syntax, the official GJS syntax and translation-file checks, schema validation, stylesheet checks and runtime archive validation. It uses temporary files and removes generated reports on exit.

ESLint reports `consistent-return` and `no-unused-vars` as advisory warnings. They remain visible in local checks and CI; lint errors still fail the source gate.

Run the private native suite separately, then build the runtime archive:

```sh
mise exec -- npm run test:shell
mise exec -- npm run package
```

The archive is written to `dist/`. `package.sh` defines the runtime payload once, packs it with `gnome-extensions` and rejects an unexpected inventory or executable payload files. It is separate from the complete source archive used for distribution.

To try a change on an actual desktop, unlock and disable the installed extension before running `mise exec -- bash install.sh`. Log out and back in before enabling it so Shell loads the new modules. Installing files does not enable or reload the extension.

The installer stages the runtime payload, compiles its schema, validates the worker and initialises first-profile entries before replacing installed files. A failed replacement restores the previous installation. Settings writes are not rolled back. Installation uses `$XDG_DATA_HOME/gnome-shell/extensions/stealth-lock@user`, or `~/.local/share/gnome-shell/extensions/stealth-lock@user` when `XDG_DATA_HOME` is unset.

## Project structure and ownership

| Location | Responsibility |
| --- | --- |
| `extension.js`, `prefs.js`, `metadata.json` | GNOME entrypoints and extension metadata |
| `stylesheet.css`, `stylesheet-dark.css`, `stylesheet-light.css` | GNOME theme entrypoints |
| `shell/` | Session protection, authentication transport, password input, media, screenshots and presentation |
| `shell/effects/` | Trusted drawing, blur and clock rendering |
| `shared/` | Saved entries, starter source, runtime-state identifiers, visual API, frame validation and worker transport |
| `helpers/` | PAM authentication and the isolated JavaScript interpreter |
| `styles/` | Shared theme definitions |
| `schemas/` | GSettings schema |
| `scripts/` | Source checks and release signing |
| `dev/` | This technical guide and ignored local tool installations |
| `tests/` | Unit, authentication, visual worker and private native scenarios; see the [test catalogue](../tests/README.md) |

`extension.js` owns enablement, registered shortcuts and the live runtime record across enable/disable. It supplies settings, the installation path, current shortcut actions and runtime ownership to `LockSession`.

`shell/lockSession.js` owns the privacy grab, native lock transitions, cancellation and reverse cleanup. `shell/media.js` coordinates paused-player ownership against the same runtime record until authenticated dismissal or native unlock. Disabling the extension discards media restoration.

`shell/input.js` owns native password editing and reveal permissions. `shell/overlay.js` borrows its input actor for presentation. `shell/effects/renderer.js` renders validated drawing commands, blur and clocks without access to credentials. `shell/screenshot.js` owns native capture, and `shell/integration.js` handles startup and screen-shield integration.

`shell/authentication.js` owns helper transport and retry timing; `helpers/authentication.py` owns the PAM transaction. `shared/presets.js` owns saved-entry validation and one-time initialisation, while `shared/starter-programs.js` contains the source copied into a new profile. `shared/visual-process.js` owns isolated worker transport, and `shared/visual-frame.js` validates drawing output. `prefs.js` owns the native settings UI and saved-entry editor. Theme colours belong in the central stylesheets.

## Authentication and protection

The default PAM service is `gdm-password`. On other systems, an administrator must select and validate one service filename in preferences. There is no automatic service fallback. The service and its containing path must be root-owned and not writable by group or others.

The helper derives the account from the current UID. Success requires a secret prompt, successful authentication, account approval and successful cleanup. It never saves or logs passwords. One attempt runs at a time, with a ten-second deadline and a 512-byte UTF-8 password limit. Retry delays default to 1, 2, 4, 8, 16 and 30 seconds; the initial and maximum delays are adjustable.

System Lock Screen delegates fingerprint, smartcard, multi-factor authentication, password changes and other account-policy conversations to GNOME's native lock. Availability depends on the system's configuration.

GNOME's native password entry owns Unicode editing and input-method composition. Clipboard paste, copy, cut and middle-click paste are blocked. Normal mode supports permitted keyboard, mouse and touch password reveal, with adjustable concealment and inactivity timeouts. Stealth mode keeps the entry hidden.

Before claiming protection, the privacy actor must own the active stage grab. Runtimes exposing device-grab state must also report both keyboard and pointer capture. Newer Wayland-only Mutter guarantees complete native grabs, but the active actor must still be verified. A failed acquisition follows the native lock fallback and reports failure if protection cannot be established.

Ctrl+Alt+Shift+L and optional diagnostic shortcuts request native locking. The extension releases its privacy resources only after GNOME confirms that the native lock is active. Disable also requests native locking; if GNOME refuses, extension teardown can expose the desktop.

The extension owns live protection and restoration intent in memory. GNOME's asynchronous runtime files contain per-login recovery snapshots, never passwords or screenshots. A restart can restore privacy only if the snapshot persisted and the extension loads again. It cannot cover the interval before loading or prevent GNOME disabling extensions after an early crash. A Wayland crash can end the login session.

Only playing MPRIS players are paused. Restoration requires the original unique D-Bus owner, bus identity and session epoch. External playback changes or a disappearing owner remove eligibility. Pending Pause/Play replies, relocking and replacement sessions share the runtime owner. Native handoff keeps media paused until native unlock; disable leaves it paused.

Monitor changes retain input protection, clear typed secrets and recapture the frozen desktop. A stable connector identifies the selected monitor when available, and positions are clamped to a physical display with signed 32-bit coordinates. Obsolete captures cannot replace a newer layout; capture failure requests native locking.

CSS, saved programs, theme variants, motion settings, prompt placement and emergency shortcuts update live. Authentication policy and other session choices apply on the next activation.

## Saved visual programs

A visual entry contains a name and JavaScript function body. The editor supplies one argument, `ctx`; there are no imports, exports or privileged host APIs. Dim and Blur, Neo Rain and City Grow use this same contract. Their source is copied into a new settings profile once, initially inactive, and then belongs to the user. Edits, deletions and an empty library survive reinstall.

Save and Replace preserve source drafts. Check JavaScript compiles the body without executing it. Apply checks syntax before saving and selecting the entry. A runtime exception or exceeded limit removes the decoration while password input and the privacy grab remain active. Valid syntax does not guarantee that a program fits its runtime limits.

### Lifecycle and coordinates

The body runs for `init`, then for `update` at approximately 50 ms intervals while animation is enabled. The JavaScript realm and `ctx.state` survive updates. `destroy` receives a final best-effort callback when the worker is idle; teardown always removes native resources even if the body hangs or fails. Do not rely on it for external work. Program selection, monitor changes and native theme changes may recreate the worker and state.

| Field | Meaning |
| --- | --- |
| `ctx.event` | `init`, `update` or `destroy` |
| `ctx.state` | Persistent in-memory object, initially empty |
| `ctx.width`, `ctx.height` | Logical size of the combined desktop bounds |
| `ctx.monitors` | `{x, y, width, height}` rectangles relative to those bounds |
| `ctx.colors` | Theme RGBA arrays, normalised to 0–1 |
| `ctx.now` | Monotonic milliseconds; use differences for animation |
| `ctx.delta` | Milliseconds since the previous completed frame, capped at 1000; initially 0 |
| `ctx.reducedMotion` | Whether GNOME requests reduced motion or disables animations |

Coordinates start at the upper-left of the combined desktop bounds. Gaps can exist between monitors. Theme colours are `background`, `foreground`, `head`, `glitch`, `cyan`, `mint`, `amber`, `orange`, `magenta` and `blur`. `ctx.colors.palette` contains cyan, mint, amber, orange and magenta. Add new shipped colours to the central stylesheets.

With reduced motion, `init` should produce a useful static image. Regular animation stops, although a style or motion change can request another update. Native clocks continue independently. Respect `ctx.reducedMotion` in the program body.

### Drawing

`ctx.draw` records commands. The trusted Shell renderer validates and draws them below the password prompt. The surface persists between frames, allowing trails and incremental scenes. Use a source paint to replace it. The Cairo path clears after each completed frame, and save/restore must balance within that frame.

| Operation | Arguments |
| --- | --- |
| `setSourceRGBA` | `(red, green, blue, alpha)`, each 0–1 |
| `setOperator` | `'source'`, `'over'` or `'dest-out'` |
| `paint` | No arguments; paint the full surface |
| `rectangle` | `(x, y, width, height)`, with nonnegative dimensions |
| `fill` | No arguments; fill and clear the path |
| `moveTo`, `lineTo` | `(x, y)` |
| `stroke` | No arguments; stroke and clear the path |
| `setLineWidth` | `(width)`, greater than 0 and at most 128 |
| `save`, `restore` | No arguments; drawing state only |
| `text` | `(text, x, y, fontSize = 16, fontFamily = 'monospace')` |

Text uses plain Unicode through Pango, without markup. Coordinates and sizes must be finite. Text is limited to 256 characters per command and 4096 per frame. Drawing font sizes are 1–128, and a single family name is at most 128 characters. Over its lifetime, a program can request four font families. Each frame permits 512 text operations and 128 newly created layouts. Comma-separated fallback-family lists are rejected. Exceeding a coordinate or workload budget rejects the whole frame.

A simple overlay using the theme's blur colour:

```js
if (ctx.event === 'destroy')
    return;
ctx.draw.setOperator('source');
ctx.draw.setSourceRGBA(...ctx.colors.blur);
ctx.draw.paint();
```

A moving square uses persistent state and respects reduced motion:

```js
if (ctx.event === 'destroy')
    return;
if (ctx.event === 'init')
    ctx.state.x = 0;
if (!ctx.reducedMotion)
    ctx.state.x = (ctx.state.x + ctx.delta * 0.05) % Math.max(1, ctx.width - 32);
ctx.draw.setOperator('source');
ctx.draw.setSourceRGBA(0, 0, 0, 0);
ctx.draw.paint();
ctx.draw.setOperator('over');
ctx.draw.setSourceRGBA(...ctx.colors.cyan);
ctx.draw.rectangle(ctx.state.x, 32, 32, 32);
ctx.draw.fill();
```

### Blur and clocks

`ctx.blur(radius = 20, brightness = 1)` requests native background blur. Radius is 0–100, and brightness is 0–1. `ctx.blur(null)` removes blur. The last requested value persists between frames.

`ctx.clock(options)` configures a native locale-aware clock, and `ctx.clock(null)` removes it. Options merge with these defaults; unknown fields are rejected:

```js
ctx.clock({
    visible: true,
    format24h: true,
    seconds: true,
    date: true,
    align: 'center',
    topRatio: 0.14,
    offsetY: 0,
    fontSize: 64,
    dateFontSize: 20,
    monitor: 'settings',
});
```

`align` accepts the exact values `left`, `center` and `right`. `topRatio` is 0–1, and `offsetY` is a signed 32-bit integer. Time font size is 8–160, and date font size is 8–64.

`monitor` accepts `settings` for the prompt's selected monitor, `all` for combined bounds, a connector such as `DP-1`, or a numeric index string. A disconnected selection uses the primary display. Placement is clamped to a physical monitor rather than a gap. Clocks update every second, including with reduced motion.

### Isolation and resource limits

The worker provides ordinary JavaScript but no GI, Shell, DOM, process, file, network, clipboard, settings, password or lock-control objects. Dynamically constructed functions remain in the same isolated realm. Each worker enters its own systemd user scope with a kernel-enforced memory ceiling and no swap. It verifies the actual cgroup limits before loading JavaScriptCore or accepting source. Bubblewrap exposes only read-only runtime libraries, the two interpreter/API files and the worker's own memory-limit files, with private pipes and no host buses, display or home directory. Drawing output follows a strict whitelist. Programs cannot create arbitrary Shell actors or install event handlers.

| Limit | Budget |
| --- | --- |
| Source | 512 KiB of UTF-8, without NUL |
| Frame output | 256 KiB and 2048 drawing commands |
| Drawing-state depth | 32 |
| Effective raster work | 16,777,216 pixels per frame across paints, fills, strokes and size-weighted text |
| Nonrectangular paths | 128 line edges per subpath, 1024 total |
| Worker memory | 512 MiB of cgroup memory, with no swap |
| Interpreter address space | 136 GiB of virtual reservation, to accommodate JavaScriptCore's aligned heaps; the memory ceiling still applies |
| Frame evaluation | 25 ms CPU and 500 ms wall time |
| Native replay | 50 ms, checked between commands and after replay |
| Drawing surface | Approximately 4,194,304 pixels, or 16 MiB ARGB, with dimension rounding |
| Cached text layouts | 512 |

Stroke accounting retains line width between frames and through save/restore. Large desktops can use a downsampled drawing surface. Parent watchdogs terminate stalled initialisation, checks, frames and destroy calls. The native replay deadline cannot interrupt a single native operation. Worker deadlines and native raster/font budgets apply separately and equally to starter and user programs.

For example, editing Neo Rain's `options` changes the algorithm in that saved entry. A different algorithm follows the same authoring and execution path. An infinite loop terminates only its worker; it cannot take control of authentication or the Shell main loop.

## Native session tests

Run the suite from the project root:

```sh
mise exec -- npm run test:shell
```

The runner creates private system and session buses, HOME and XDG directories, and two headless Wayland monitors. It uses a scrubbed environment and software rendering with one Mesa raster worker to reduce CPU contention. One owned transient slice limits the compositor and its visual workers together to 1500 MiB, 150% CPU and 400 tasks. Its 10 ms CPU quota period reduces refill stalls during the 50 ms drawing deadline. The compositor scope also has an elapsed-time limit. It does not change the current desktop or its settings.

Before launch, the installed `helpers/authentication.py` is replaced and compared with a sentinel-bearing fixture. The same comparison runs before crash recovery starts a fresh compositor. The fixture uses private stdin and controlled exit statuses without PAM. The runner selects the real IBus US engine and waits for both native engine and input-source readiness.

Scenarios exercise registered activation, actual virtual keyboard and pointer devices, password editing and composition, normal and stealth feedback, subprocess results, modal ownership and cancellation. They also cover cursor decoding and fallback, monitor geometry, live native themes and real private-bus MPRIS players.

The stock ScreenShield runs against private GDM and logind fixtures. Their reauthentication peer and inhibitor descriptor model native lifecycles without authenticating the desktop user or suspending the host.

The effects scenarios execute ordinary saved starters through real Bubblewrap-isolated JavaScriptCore workers. Commands reach native blur and Cairo/Pango drawing, including Unicode glyphs and central theme colours. Coverage includes independent clocks, containment across monitor gaps, live edits, reduced motion, cleanup and worker reaping. Tests inspect update transport while a disposable password is present, reject invalid native output, and terminate infinite init/update/destroy callbacks while protection stays active.

Animations are enabled only in the private compositor. Each starter's first frame records wall time, native paint and cold-glyph spans, and available CPU, scheduler and throttling counters. Counter reads and metric logging occur outside the production replay deadline. Drawing calls, assertions and resource limits remain unchanged.

A real `ExtensionPrefsDialog` client exercises GTK bindings, schema bounds, enum and colour controls, saved CSS previews, entry creation/editing/deletion and shortcut capture. It checks Save, Escape and Backspace reset, invalid-JavaScript rejection, ordinary editable starter entries and an empty library that does not reseed.

For recovery, the runner waits for the native snapshot, kills only the compositor PID in its owned scope with SIGKILL, preserves its private state and settings, then checks recovery and dismissal in a fresh compositor. Immediate assertions use the live runtime record; disk assertions separately wait for asynchronous persistence. This tests extension recovery with an enabled profile, independently of a distribution's display-manager failure policy.

### Diagnostics and cleanup

| Option | Effect |
| --- | --- |
| `SLH_FAKE_GDM=0` | Test unavailable native locking; ScreenShield-dependent scenarios report explicit skips |
| `SLH_KEEP=1` | Retain private logs after stopping the owned slice |
| `SLH_NETNS=0` | Explicitly disable network isolation where user namespaces are unavailable |

Otherwise, the runner stops its exact slice and all descendant scopes, then removes temporary files on success or failure. Compositor exit also requests slice cleanup so sibling workers cannot outlive the test session. The lower-level `tests/shell/run-shell.sh` provides `start`, `stop`, `status`, `pids`, `clean` and `crash-restart` controls for an owned fixture; its header documents the additional environment options.

The log gate displays warnings as information. Repeated warnings, changed wording and ordinary actor or allocation messages do not fail the suite. Actual error or critical diagnostics, JavaScript error banners and failed assertions still fail unless they are deliberately declared fixture outcomes.

Expected fixture messages must match exact declarations recorded before their scenario runs, regardless of severity. Missing or excess occurrences fail, including when the message is only a warning. Preferences output is forwarded into the desktop log and checked by the same scanner. Failed runs scan the full log before showing recent output and cleaning the scope, while preserving the original failure status.

### Authentication fixtures and the version matrix

The separate Python authentication suite includes real `pam_unix` and `pam_faillock` transactions. Bubblewrap maps the current UID/GID to namespace root and exposes private disposable passwd/shadow files, an administrator-owned `gdm-password` policy and failure tally. It checks correct/wrong passwords, account/password expiry, locked hashes, lockout/reset, missing services/modules and unsafe policy permissions without reaching the host account or policy. It does not validate every distribution's PAM configuration.

CI runs source checks and actual GNOME 45–51 runtimes. Source checks use an owned user slice with a 2 GiB memory ceiling, two CPUs and 600 tasks. Each native job uses a digest-pinned official GNOME Mutter Fedora image, installs that Fedora release's runtime, asserts its Shell major and runs as a dedicated nonroot user in an owned systemd container. The container has a 2 GiB memory ceiling and two CPUs; the native fixture retains the stricter aggregate limits above. Older releases use signed RPMs from the official Fedora archive.

Pushes and pull requests containing only Markdown changes, including README edits, skip the automated workflow. A manual run remains available through `workflow_dispatch`.

Each container first runs the existing JavaScriptCore worker and GJS transport suites. Worker failures expose subprocess status and sandbox stderr without disclosing program source or weakening isolation. Pinned Node exports the actual starter entries inside the disposable container.

`tests/shell/run-container.sh <major> <pinned-image>` reproduces a job on a host with Docker and mise. Choose the image from [the CI matrix](../.github/workflows/ci.yml). It tests committed `HEAD` and cleans its container, derived image and temporary files. A configured matrix is not passing evidence: a supported runtime needs a successful actual job.

Unit tests use unchanged ES modules with explicit native dependency mocks through Node's VM module flag. Installer tests run the real initialiser with temporary HOME/XDG directories and a private settings backend. The [test catalogue](../tests/README.md) describes individual files and their behaviour.

## Release acceptance

Before publishing, run the full source gate, inspect passing native jobs for the target GNOME versions, and complete attended acceptance on real sessions. Confirm that the installed build is loaded after a fresh login. Headless fixtures do not replace physical input or a distribution's actual authentication and crash policies.

| Area | Actual-system acceptance |
| --- | --- |
| Activation | Video, multiple monitors, negative positions, scaling/rotation, overview and existing modals must give complete protection or a clear activation failure |
| Devices | Super, Alt+Tab, Alt+F2, other shortcuts, mouse buttons, touch and scrolling must react only through intended password/reveal controls |
| Input engines | Check actual layouts and IBus engines, Unicode, composition-only clearing, delayed engine responses, selection, reveal concealment and inactivity clearing |
| Native transitions | Check automatic lock, idle blanking, suspend/resume, user switching and application dialogs; native protection must precede privacy teardown |
| Recovery | Check actual Shell/display-manager crash policy, immediate activation crashes and authenticated dismissal, without stale secrets/frames or unwanted activation after a new login |
| Resources | Repeat activation/dismissal and enable/disable; actors, grabs, signals, sources, workers, textures and memory must return to baseline |
| Distribution | Check preferences, programs, clocks, themes, cursors/images, monitors and install/reinstall/uninstall on each target runtime; edits and an empty library must remain intact |

Use disposable accounts for rejection, expiry and lockout tests. Record the tested commit, runtime, outcomes and any skips so evidence remains attributable. Commit reviewed source before building and verifying the release archive. Translations beyond English and distribution through extensions.gnome.org are outside this release.

## Source releases

The distribution archive contains committed source. Recipients extract it and run `bash install.sh`; `package.sh` produces the separate slim GNOME runtime archive.

### Build an archive

Run the checks and commit the reviewed changes first. The release script rejects tracked changes because its input is committed `HEAD`:

```sh
mise exec -- npm run check
mise exec -- npm run test:shell
mise exec -- bash scripts/release.sh --unsigned
```

The default output is `dist/stealth-lock-<version-name>.tar.gz`. `git archive` supplies the source, and `gzip -n` removes variable gzip metadata, so the same commit produces the same archive bytes. Inspect the actual native matrix results before claiming a release is verified.

### Create a signing key

An OpenPGP signature proves that the holder of a key signed those exact archive bytes. It detects changes to the download. Recipients also need an independently trusted public fingerprint; a key bundled with the download alone does not establish the maintainer's identity. Signing does not alter runtime authentication or make an untested build secure.

The maintainer's current public fingerprint is `5B33C2F5445A05EB4600CB3A4C5D246614732607`, for Ris Peng `<hello@rispeng.com>`, expiring on 8 October 2027. Check it through a trusted copy of the repository before using the exported release key.

If a new key is needed, install GnuPG and run these commands in your own terminal:

```sh
mise exec -- gpg --quick-generate-key 'Ris Peng <hello@rispeng.com>' ed25519 sign 1y
mise exec -- gpg --fingerprint 'hello@rispeng.com'
```

Choose the passphrase through the local pinentry prompt. Keep the private key, passphrase and revocation certificate private and backed up. Share only the public key and fingerprint, and renew an expiring key before later releases. Use an existing suitable key rather than creating another unnecessarily. The commands follow [GnuPG's key-management documentation](https://www.gnupg.org/documentation/manuals/gnupg/OpenPGP-Key-Management.html); no project command creates the identity key automatically.

### Sign and verify

Replace `YOUR_FULL_FINGERPRINT` with the full 40- or 64-hex-digit public fingerprint:

```sh
mise exec -- bash scripts/release.sh --sign-key YOUR_FULL_FINGERPRINT
```

The script writes the archive, an ASCII-armoured detached signature (`.asc`) and an exported public key (`.key.asc`). It verifies them with `gpgv` in a temporary private keyring before moving the release files into place. The private key stays in the existing GnuPG installation.

Publish the archive and signature together. Make the public key available and publish its fingerprint through a channel recipients already trust. A recipient checks the key against that trusted fingerprint, then runs:

```sh
mise exec -- gpg --show-keys --with-fingerprint trusted-maintainer-key.asc
mise exec -- bash scripts/release.sh --verify trusted-maintainer-key.asc stealth-lock-1.0.1.tar.gz
```

The signature must be beside the archive as `stealth-lock-1.0.1.tar.gz.asc`. Verification uses a temporary keyring without changing the recipient's personal keyring. A changed archive or different signing key fails verification.

For example, changing one byte on a mirror invalidates the signature. A valid signature from a previously untrusted key still requires checking who owns that key.
