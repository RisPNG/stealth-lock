import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import IBus from 'gi://IBus';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

export const METRICS = {};

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

async function pressShortcut(keys) {
    const keyboard = Clutter.get_default_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    try {
        for (const key of keys)
            keyboard.notify_keyval(Clutter.get_current_event_time() * 1000, key, Clutter.KeyState.PRESSED);
        await Scripting.sleep(40);
        for (const key of [...keys].reverse())
            keyboard.notify_keyval(Clutter.get_current_event_time() * 1000, key, Clutter.KeyState.RELEASED);
        await Scripting.sleep(80);
    } finally {
        keyboard.run_dispose();
    }
}

export function init() {
    global.settings.set_strv('enabled-extensions', ['stealth-lock@user']);
    global.settings.set_strv('disabled-extensions', []);
    global.settings.set_boolean('disable-user-extensions', false);
    const screensaver = new Gio.Settings({schema_id: 'org.gnome.desktop.screensaver'});
    screensaver.set_boolean('lock-enabled', false);
    const session = new Gio.Settings({schema_id: 'org.gnome.desktop.session'});
    session.set_uint('idle-delay', 0);
}

export async function run() {
    await Main.extensionManager._initializationPromise;
    for (let attempt = 0; attempt < 100 && !Main.extensionManager.lookup('stealth-lock@user')?.stateObj; attempt++)
        await Scripting.sleep(50);
    const record = Main.extensionManager.lookup('stealth-lock@user');
    assert(record?.stateObj, 'The packaged extension did not load');
    assert(!record.error, record.error);
    const extension = record.stateObj;
    const settings = extension.getSettings();
    settings.set_boolean('pause-media', false);
    settings.set_boolean('debug-mode', false);
    settings.set_string('cursor-mode', 'normal');
    settings.set_uint('auto-reset-seconds', 0);
    Main.overview.hide();
    for (let attempt = 0; attempt < 100 && Main.actionMode !== Shell.ActionMode.NORMAL; attempt++)
        await Scripting.sleep(20);
    assert(Main.actionMode === Shell.ActionMode.NORMAL, 'The Shell did not leave startup overview mode');
    const originalActionMode = Main.actionMode;
    const originalFocus = global.stage.get_key_focus();
    const tracker = global.backend.get_cursor_tracker();
    const originalPointerVisible = tracker.get_pointer_visible();
    const originalLock = Main.screenShield.lock;
    const originalLocked = Main.screenShield._isLocked;
    const originalActive = Main.screenShield._isActive;
    Main.screenShield.lock = () => {};
    let session;
    try {
        for (const [type, freeze, cursor] of [
            ['stealth', true, 'normal'],
            ['normal', false, 'normal'],
            ['stealth', false, 'hidden'],
            ['normal', true, 'lock-icon'],
        ]) {
            settings.set_string('lock-type', type);
            settings.set_boolean('freeze-display', freeze);
            settings.set_string('cursor-mode', cursor);
            extension.lock();
            session = extension._session;
            assert(session, 'Activation did not create a session');
            for (let attempt = 0; attempt < 100 && !session._ready; attempt++)
                await Scripting.sleep(20);
            assert(session._ready && !session._closed, 'The privacy screen failed to become ready');
            assert(session._input.actor instanceof St.PasswordEntry, 'Input must use the native password entry');
            assert(Main.actionMode === Shell.ActionMode.NONE, 'The modal must suppress global shortcuts');
            assert(session._overlay.actor.get_parent() === Main.uiGroup, 'Overlay is not Shell chrome');
            assert(session._overlay.prompt.visible === (type === 'normal'), 'Prompt visibility does not match the mode');
            assert(!!session._overlay.background.get_content() === freeze, 'Screenshot capture does not match the setting');
            if (freeze) {
                const content = session._overlay.background.get_content();
                assert(content.get_texture().get_width() > 0, 'Capture did not return a native in-memory texture');
            }
            if (cursor !== 'normal')
                assert(!tracker.get_pointer_visible(), 'The system cursor was not hidden');

            session._input.actor.text = 'päss🔐';
            assert(session._input.takePassword() === 'päss🔐', 'Native input lost Unicode');
            assert(session._input.actor.text === '' && !session._input.actor.password_visible, 'Taking a password must clear and mask it');
            session._input.actor.text = 'ab';
            session._input.actor.grab_key_focus();
            const keyboard = Clutter.get_default_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
            keyboard.notify_keyval(Clutter.get_current_event_time() * 1000, Clutter.KEY_BackSpace, Clutter.KeyState.PRESSED);
            keyboard.notify_keyval(Clutter.get_current_event_time() * 1000, Clutter.KEY_BackSpace, Clutter.KeyState.RELEASED);
            await Scripting.sleep(75);
            assert(session._input.actor.text === 'a', 'Native Backspace did not edit the focused entry');
            keyboard.run_dispose();

            if (type === 'normal') {
                settings.set_boolean('normal-prompt-follow-cursor', true);
                for (const anchor of ['br', 'tr', 'tl', 'bl']) {
                    settings.set_string('normal-prompt-cursor-anchor', anchor);
                    session._overlay.movePointer(512, 384);
                    const prompt = session._overlay.prompt;
                    assert(prompt.x >= 0 && prompt.y >= 0 && prompt.x < 1024 && prompt.y < 768, 'Following prompt left the monitor');
                }
                settings.set_boolean('normal-prompt-follow-cursor', false);
            }
            let checkedPassword = null;
            session._authentication.verify = async password => {
                checkedPassword = password;
                return true;
            };
            session._input.actor.text = 'test-password';
            await pressShortcut([Clutter.KEY_Return]);
            assert(checkedPassword === 'test-password', 'Native activation did not submit the password');
            assert(!extension._session && session._cleanup.length === 0, 'Successful authentication did not release the session');
            assert(Main.actionMode === originalActionMode, 'Action mode was not restored');
            assert(global.stage.get_key_focus() === originalFocus, 'Keyboard focus was not restored');
            assert(tracker.get_pointer_visible() === originalPointerVisible, 'Cursor visibility was not restored');
        }

        settings.set_strv('lock-hotkey', ['<Super><Control>k']);
        settings.set_boolean('debug-mode', false);
        Main.screenShield.lock = () => {};
        extension.lock();
        session = extension._session;
        for (let attempt = 0; attempt < 100 && !session?._ready; attempt++)
            await Scripting.sleep(20);
        assert(session?._ready, 'Shortcut test did not acquire its privacy screen');
        session._input.actor.text = 'clear-this';
        await pressShortcut([Clutter.KEY_Control_L, Clutter.KEY_u]);
        assert(session._input.actor.text === '' && !session._input.actor.password_visible, 'Ctrl+U did not clear and mask native input');
        session._input.actor.text = 'reveal-this';
        await pressShortcut([Clutter.KEY_Control_L, Clutter.KEY_r]);
        assert(session._input.actor.password_visible, 'Ctrl+R did not reveal the normal prompt');
        await pressShortcut([Clutter.KEY_Control_L, Clutter.KEY_r]);
        assert(!session._input.actor.password_visible, 'Ctrl+R did not mask the normal prompt');
        const clipboard = St.Clipboard.get_default();
        clipboard.set_text(St.ClipboardType.CLIPBOARD, 'pasted');
        clipboard.set_text(St.ClipboardType.PRIMARY, 'pasted');
        for (const keys of [[Clutter.KEY_Shift_L, Clutter.KEY_Insert], [Clutter.KEY_Control_L, Clutter.KEY_v]]) {
            await pressShortcut(keys);
            assert(session._input.actor.text === 'reveal-this', 'Clipboard paste reached the password input');
        }
        await pressShortcut([Clutter.KEY_Escape]);
        assert(session._input.actor.text === '' && !session._input.actor.password_visible, 'Escape did not clear native input');
        for (const keys of [[Clutter.KEY_Escape], [Clutter.KEY_Control_L, Clutter.KEY_u]]) {
            session._input.actor.text = 'committed';
            Main.inputMethod._onUpdatePreeditText(null, IBus.Text.new_from_string('composition'), 0, true, IBus.PreeditFocusMode.COMMIT);
            await Scripting.sleep(30);
            assert(session._input.actor.clutter_text.has_preedit(), 'The native composition fixture was not created');
            await pressShortcut(keys);
            assert(!session._input.actor.clutter_text.has_preedit() && session._input.actor.text === '',
                'Password reset left native composition active');
        }
        settings.set_uint('auto-reset-seconds', 1);
        Main.inputMethod._onUpdatePreeditText(null, IBus.Text.new_from_string('composition'), 0, true, IBus.PreeditFocusMode.COMMIT);
        await Scripting.sleep(1100);
        assert(!session._input.actor.clutter_text.has_preedit() && session._input.actor.text === '' && !session._passwordReset,
            'Inactivity reset left native composition or a timer active');
        settings.set_uint('auto-reset-seconds', 0);
        await pressShortcut([Clutter.KEY_Super_L]);
        assert(!Main.overview.visible && session._ready && !session._closed, 'The Super key escaped the privacy screen');
        settings.set_strv('debug-abort-hotkey', ['<Control><Alt><Shift>u']);
        settings.set_boolean('debug-mode', true);
        for (const useActivation of [false, true]) {
            settings.set_boolean('debug-abort-use-lock-hotkey', useActivation);
            await Scripting.sleep(30);
            let handoffAttempts = 0;
            Main.screenShield.lock = () => { handoffAttempts++; };
            await pressShortcut(useActivation
                ? [Clutter.KEY_Control_L, Clutter.KEY_Super_L, Clutter.KEY_k]
                : [Clutter.KEY_Control_L, Clutter.KEY_Alt_L, Clutter.KEY_Shift_L, Clutter.KEY_u]);
            assert(handoffAttempts === 1, 'The registered emergency shortcut did not attempt native handoff');
            assert(!session._closed && session._overlay && Main.actionMode === Shell.ActionMode.NONE,
                'A denied emergency handoff dismissed the privacy screen');
        }
        session.close();
        settings.set_boolean('debug-mode', false);

        settings.set_string('cursor-mode', 'normal');
        extension.lock();
        session = extension._session;
        session.close();
        await Scripting.sleep(40);
        assert(session._closed && !extension._session && session._cleanup.length === 0, 'Cancellation left a live session');

        extension.lock();
        session = extension._session;
        extension.disable();
        assert(session._closed && !extension._session, 'Disable did not close its pending session');
        assert(global.get_runtime_state('b', 'stealth-lock@user.locked')?.deep_unpack(), 'Disable did not retain the recovery marker');
        extension.enable();
        session = extension._session;
        assert(session, 'Re-enable did not recover the privacy screen');
        for (let attempt = 0; attempt < 100 && !session._ready; attempt++)
            await Scripting.sleep(20);
        assert(session._ready && !session._closed, 'Recovered session did not become ready');
        session.close();
        assert(!global.get_runtime_state('b', 'stealth-lock@user.locked'), 'Successful close did not clear the recovery marker');

        settings.set_boolean('freeze-display', false);
        const constructorSettings = extension.getSettings();
        const originalGetString = constructorSettings.get_string;
        const originalGetSettings = extension.getSettings;
        const childrenBeforeFailure = Main.uiGroup.get_n_children();
        constructorSettings.get_string = key => {
            if (key === 'normal-prompt-css')
                throw new Error('expected test constructor failure');
            return originalGetString.call(constructorSettings, key);
        };
        extension.getSettings = () => constructorSettings;
        try {
            extension.lock();
        } finally {
            extension.getSettings = originalGetSettings;
            constructorSettings.get_string = originalGetString;
        }
        assert(!extension._session && Main.uiGroup.get_n_children() === childrenBeforeFailure, 'Constructor failure leaked a session or actor');
        assert(Main.actionMode === originalActionMode && global.stage.get_key_focus() === originalFocus,
            'Constructor failure changed input ownership');
        const originalAddChrome = Main.layoutManager.addTopChrome;
        Main.layoutManager.addTopChrome = () => { throw new Error('expected test acquisition failure'); };
        extension.lock();
        Main.layoutManager.addTopChrome = originalAddChrome;
        assert(!extension._session, 'Acquisition failure did not unwind');
        assert(Main.actionMode === originalActionMode, 'Acquisition failure changed action mode');

        extension.lock();
        session = extension._session;
        await Scripting.sleep(40);
        assert(!session.handoff() && !session._closed && session._overlay, 'A denied native lock must keep the privacy screen');
        Main.screenShield.lock = () => {
            Main.screenShield._isLocked = true;
            Main.screenShield._isActive = true;
            Main.screenShield.emit('locked-changed');
        };
        assert(session.handoff(), 'Confirmed native lock did not accept handoff');
        assert(session._nativeLock && !session._overlay && !session._input, 'Handoff did not release privacy input and presentation');
        Main.screenShield._isLocked = false;
        Main.screenShield._isActive = false;
        Main.screenShield.emit('locked-changed');
        assert(!extension._session, 'Simulated native unlock did not finish the session');
        const preferences = Gio.Subprocess.new(
            ['/usr/bin/gjs', '-m', GLib.build_filenamev([GLib.getenv('STEALTH_LOCK_TEST_DIRECTORY'), 'preferences.js'])],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
        );
        const output = await new Promise((resolve, reject) => {
            preferences.communicate_utf8_async(null, null, (process, result) => {
                try {
                    resolve(process.communicate_utf8_finish(result));
                } catch (error) {
                    reject(error);
                }
            });
        });
        assert(preferences.get_successful(), 'Preferences test failed: ' + output[2]);
        assert(output[1].includes('STEALTH_LOCK_PREFERENCES_OK'), 'Preferences test did not finish');
        if (output[2])
            console.log(output[2]);
        globalThis.print(output[1].trim());
        globalThis.print('STEALTH_LOCK_SHELL_OK');
    } finally {
        session?.close();
        Main.screenShield.lock = originalLock;
        Main.screenShield._isLocked = originalLocked;
        Main.screenShield._isActive = originalActive;
        Main.extensionManager.disableExtension('stealth-lock@user');
    }
}
