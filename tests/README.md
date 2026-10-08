# Tests

The tests are completely AI-generated and barely audited by humans unless a specific need calls for closer review. Automated execution and AI review do not count as human auditing. Passing results show that these checks completed in the tested setup; they do not replace human review or testing on your own desktop.

This page describes the behaviour each test file checks. Commands, requirements and details of the private test desktop are in the [developer documentation](../dev/README.md).

## Individual behaviour checks

The files in `unit/` use controlled examples and test substitutes. Some also run installation and release scripts in temporary folders.

| Test file | What it checks |
| --- | --- |
| [unit/authentication.test.js](unit/authentication.test.js) | Password submission, retry delays, timeouts and cancellation. Repeated submissions and late replies cannot approve an obsolete attempt, and diagnostics do not expose passwords. |
| [unit/effects.test.js](unit/effects.test.js) | Effects, blur and clocks respond to settings, themes, displays and reduced motion. Invalid or expensive drawing and failed programs remove the effect while keeping the privacy screen active. |
| [unit/harness.test.js](unit/harness.test.js) | The test setup loads the intended code with the supplied test substitutes and keeps separate tests from affecting one another. |
| [unit/input.test.js](unit/input.test.js) | Typing, editing and partly composed text are handled correctly. Reveal and clear controls work, forbidden shortcuts are blocked, and discarded passwords are cleared without taking focus from another control. |
| [unit/media.test.js](unit/media.test.js) | Only playing media is paused, and the same player is resumed at the appropriate time. Player changes, recovery, immediate relocking and delayed replies cannot restore the wrong player or override a newer lock. |
| [unit/native-container.test.js](unit/native-container.test.js) | The test desktop runner accepts only the intended environments, applies its limits, preserves failures and cleans only the temporary resources it created. |
| [unit/native-log.test.js](unit/native-log.test.js) | Unexpected warnings and errors fail the checks. Exact expected messages have strict limits, and an early error remains visible when a partial run fails and cleans up. |
| [unit/preferences.test.js](unit/preferences.test.js) | Settings persist and controls respond to changes. Saved styles and programs can be edited, renamed and removed; invalid programs cannot be applied, and cancelling an editor preserves existing choices. |
| [unit/presentation.test.js](unit/presentation.test.js) | Prompts, feedback and cursor images appear correctly and stay on a visible display. Missing or corrupt cursor images retain the default, and cancelled image loading cannot replace it later. |
| [unit/presets.test.js](unit/presets.test.js) | Starter entries are added once and remain ordinary editable entries. Edits and deletion survive reopening, and the starter programs draw their expected scenes with and without motion. |
| [unit/recovery.test.js](unit/recovery.test.js) | An active privacy screen returns after reloading, respects GNOME's own lock and clears after unlocking. Recovery and media restoration respond correctly to startup, disabling and delayed saved state. |
| [unit/release.test.js](unit/release.test.js) | Release archives contain the committed source. Signed archives require the correct trusted key, altered archives are rejected, and replacing a release removes obsolete signatures while preserving neighbouring files. |
| [unit/screenshot.test.js](unit/screenshot.test.js) | Capturing the frozen desktop succeeds, cancels or times out cleanly. A late capture cannot revive a cancelled request or leave temporary resources behind. |
| [unit/session.test.js](unit/session.test.js) | Input is protected before the screen finishes preparing, and only the correct active screen can claim that protection. Password denial, system-lock handoff, inactivity, display changes and cleanup preserve the intended lock, cursor and media behaviour. |
| [unit/tooling.test.js](unit/tooling.test.js) | Packaging includes the intended extension files. Installation preserves the previous copy on failure, updates retain edited or deleted starters, and uninstalling keeps settings unless resetting them was requested. |
| [unit/visual-frame.test.js](unit/visual-frame.test.js) | Drawing instructions, text, colours, fonts, blur and clocks stay within the permitted choices and limits. Unsupported or excessively expensive output is refused before it is drawn. |

## Password, drawing and stylesheet checks

These files check the supporting programs as well as the expected behaviour. The password tests use controlled or disposable credentials, rather than your login password.

| Test file | What it checks |
| --- | --- |
| [auth/test_authentication.py](auth/test_authentication.py) | Password checking must complete successfully for the right account and an acceptable account status. Extra password requests, malformed input, missing services and unsafe configuration are refused. |
| [auth/test_real_pam.py](auth/test_real_pam.py) | Disposable accounts exercise real Linux password checks, wrong passwords, locked or expired accounts and repeated-failure lockouts. Missing or unsafe configuration is refused without changing the host account or its rules. |
| [authentication-gjs.js](authentication-gjs.js) | Real communication with a controlled password helper preserves Unicode input, distinguishes denial from errors, and handles retries, cancellation and timeouts without exposing passwords in command arguments. |
| [check-stylesheets.js](check-stylesheets.js) | GNOME can load all built-in stylesheets, and every stylesheet they include exists. |
| [visual/test_visual_renderer.py](visual/test_visual_renderer.py) | Saved JavaScript programs can draw and retain their state, including the actual starters with and without motion. Invalid programs, excessive output, endless loops and memory abuse are stopped; the isolated drawing process has no access to the desktop session or network. |
| [visual/process.js](visual/process.js) | Real program checks and drawing requests finish or fail cleanly. Cancellation, invalid replies and hung programs stop the owned process and leave no pending work behind. |

## Checks on a private GNOME desktop

These files run against a real GNOME test desktop. Password outcomes and system-login services are controlled fixtures, so they do not authenticate your account or lock your current desktop.

| Test file | What it checks |
| --- | --- |
| [shell/effects.test.js](shell/effects.test.js) | The ordinary starters draw through isolated programs, respond to live edits and reduced motion, and place clocks on visible displays. Invalid output, forbidden desktop access and endless loops leave password protection active. |
| [shell/integration.test.js](shell/integration.test.js) | Activation shortcuts, password editing, reveal, clearing, frozen displays and cursor choices work together. Wrong passwords and helper errors retain protection; successful fixture authentication unlocks, and emergency system locking and reload recovery follow the intended behaviour. |
| [shell/presentation.test.js](shell/presentation.test.js) | Prompt placement stays inside the two test displays, custom cursor images load or retain the default on failure, and theme and style changes appear while the screen is active. |
| [shell/session.test.js](shell/session.test.js) | Startup failures, pending captures and cleanup release the right resources. Real test media players pause and resume correctly through player changes, delayed replies, recovery, relocking and GNOME's own lock. |
| [shell/preferences.js](shell/preferences.js) | The real preferences window saves and resets settings, captures shortcuts, previews styles and edits saved programs. Starter entries can be changed or deleted, invalid programs cannot be applied, and deleting the library does not recreate it. |

## Support files and runners

These files supply test data, control the test setup or run the checks. They are not additional test suites.

| File or group | Purpose |
| --- | --- |
| [unit/harness.js](unit/harness.js) | Loads extension code with controlled test substitutes and supplies cancellation and delayed-response examples. |
| [unit/fixtures/dependency.js](unit/fixtures/dependency.js), [module.js](unit/fixtures/module.js) and [installed-settings.js](unit/fixtures/installed-settings.js) | Provide sample code and private settings for the test setup and installer checks. |
| [auth/fake_authentication.py](auth/fake_authentication.py) and [shell/stubs/authentication.py](shell/stubs/authentication.py) | Return controlled password outcomes, delays and failures without checking a real account. |
| [shell/fake-gdm.js](shell/fake-gdm.js) | Supplies private stand-ins for login and session services used by GNOME's own lock. |
| [shell/helper-extension/](shell/helper-extension/) | Its `extension.js` and `metadata.json` provide test-only keyboard, pointer and desktop controls. They are never part of the installed extension. |
| [shell/support.js](shell/support.js) | Supplies shared comparisons, waiting and controlled password-helper outcomes. |
| [shell/run.sh](shell/run.sh) | Runs the private desktop checks, reviews their logs, then adds abrupt crash and restart recovery checks before cleanup. |
| [shell/run-tests.js](shell/run-tests.js) | Runs each desktop scenario and the real preferences window, recording expected diagnostic messages as it goes. |
| [shell/run-shell.sh](shell/run-shell.sh), [scope-main.sh](shell/scope-main.sh) and [shell-inner.sh](shell/shell-inner.sh) | Prepare, start, observe, restart and remove the private GNOME desktop. |
| [shell/common.sh](shell/common.sh) | Shares the private test paths and checks which test session the controls can reach. |
| [shell/ctl.js](shell/ctl.js), [eval.sh](shell/eval.sh), [gdbus.sh](shell/gdbus.sh), [keys.sh](shell/keys.sh), [motion.sh](shell/motion.sh) and [shot.sh](shell/shot.sh) | Control or observe the private test desktop, including keyboard input, pointer movement and screenshots. |
| [shell/session-bus.conf.in](shell/session-bus.conf.in) and [system-bus.conf.in](shell/system-bus.conf.in) | Keep communication between test services within the private setup. |
| [shell/check-log.py](shell/check-log.py) | Rejects unexpected desktop diagnostics and checks the exact limits on allowed messages. |
| [shell/run-container.sh](shell/run-container.sh) and [Containerfile](shell/Containerfile) | Create a disposable environment for each GNOME version, run the supporting checks and desktop suite, then remove it. |

For example, password denial is checked separately from typing into the real password prompt, while the desktop suite checks how they work together. The [developer documentation](../dev/README.md#native-session-tests) explains how those checks are run and what still needs testing on an actual user session.
