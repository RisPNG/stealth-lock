import GLib from 'gi://GLib';
import IBus from 'gi://IBus';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {assert, delay, equal, setAuthControl, waitFor} from './support.js';

async function chord(helper, modifiers, key) {
    for (const modifier of modifiers)
        helper.Key(modifier, true);
    helper.Key(key, true);
    await delay(30);
    helper.Key(key, false);
    for (const modifier of [...modifiers].reverse())
        helper.Key(modifier, false);
    await delay(50);
}

async function protect(extension) {
    extension.lock();
    await waitFor(() => extension._session?._ready, 'Privacy screen ready');
    return extension._session;
}

export const tests = {
    async 'registered activation acquires input; editing and blocked shortcuts use native devices'({extension, helper}) {
        const mode = Main.actionMode;
        const modals = Main.modalCount;
        await chord(helper, ['Super_L', 'Control_L'], 'l');
        await waitFor(() => extension._session?._ready, 'Registered hotkey activates');
        const session = extension._session;
        equal(Main.modalCount, modals + 1, 'Exactly one modal grab');
        equal(Main.actionMode, Shell.ActionMode.NONE, 'Global shortcuts disabled');
        assert(session._input.actor instanceof St.PasswordEntry, 'Native password entry required');
        equal(global.stage.key_focus, session._input.actor.clutter_text, 'Password input owns focus');
        session._input.actor.text = 'abc';
        await chord(helper, [], 'BackSpace');
        equal(session._input.actor.text, 'ab', 'Native Backspace editing');
        await chord(helper, ['Control_L'], 'u');
        equal(session._input.actor.text, '', 'Clear shortcut');
        const clipboard = St.Clipboard.get_default();
        clipboard.set_text(St.ClipboardType.CLIPBOARD, 'not-a-password');
        clipboard.set_text(St.ClipboardType.PRIMARY, 'not-a-password');
        for (const [modifiers, key] of [[['Control_L'], 'v'], [['Shift_L'], 'Insert'], [[], 'Super_L']])
            await chord(helper, modifiers, key);
        equal(session._input.actor.text, '', 'Paste shortcuts blocked');
        assert(!Main.overview.visible && !session._closed, 'Super cannot escape');
        session.close();
        equal(Main.modalCount, modals, 'Modal grab restored');
        equal(Main.actionMode, mode, 'Action mode restored');
    },

    async 'wrong password keeps protection; real subprocess fixture success dismisses it'({extension, settings, helper}) {
        settings.set_string('lock-type', 'normal');
        const session = await protect(extension);
        session._input.actor.text = 'wrong';
        await chord(helper, [], 'Return');
        await waitFor(() => !session._authentication.busy && session._authentication.retryUntil > 0, 'Denied attempt finishes');
        equal(extension._session, session, 'Denied attempt keeps screen');
        equal(session._input.actor.text, '', 'Submitted secret discarded');
        assert(session._overlay.status.visible && session._overlay.status.text.includes('Password not accepted'), 'Normal prompt displays authentication feedback');
        session._authentication.retryUntil = 0;
        session._input.actor.text = 'harness-secret';
        await chord(helper, [], 'Return');
        await waitFor(() => extension._session === null, 'Fixture password accepted');
        equal(Main.modalCount, 0, 'No modal grab after authentication');
    },

    async 'one in-flight attempt and helper errors never release protection'({extension, expectLog}) {
        expectLog('Stealth Lock: authentication helper failed \\(exit 2\\)');
        const session = await protect(extension);
        setAuthControl({delaySeconds: 0.15, exitCode: 2});
        session._input.actor.text = 'harness-secret';
        session._input.actor.clutter_text.emit('activate');
        await waitFor(() => session._authentication.busy, 'Helper owns attempt');
        session._input.actor.text = 'second';
        session._input.actor.clutter_text.emit('activate');
        equal(session._input.actor.text, 'second', 'Concurrent submission ignored');
        await waitFor(() => !session._authentication.busy, 'Helper error finishes');
        assert(session._authentication.retryUntil > GLib.get_monotonic_time() / 1000, 'Failure enforces retry delay');
        equal(extension._session, session, 'Helper error stays protected');
        assert(!session._overlay.status.visible, 'Stealth keeps authentication feedback hidden');
    },

    async 'reveal and composition clear/inactivity use actual native PasswordEntry'({extension, settings, helper}) {
        settings.set_string('lock-type', 'normal');
        const session = await protect(extension);
        session._input.actor.text = 'é🙂';
        await chord(helper, ['Control_L'], 'r');
        assert(session._input.actor.password_visible, 'Normal prompt reveals');
        await chord(helper, ['Control_L'], 'r');
        assert(!session._input.actor.password_visible, 'Normal prompt conceals');
        for (const [modifiers, key] of [[[], 'Escape'], [['Control_L'], 'u']]) {
            session._input.actor.text = 'committed';
            Main.inputMethod._onUpdatePreeditText(null, IBus.Text.new_from_string('composition'), 0, true, IBus.PreeditFocusMode.COMMIT);
            await delay(30);
            assert(session._input.actor.clutter_text.has_preedit(), 'Composition fixture active');
            await chord(helper, modifiers, key);
            assert(!session._input.actor.clutter_text.has_preedit() && session._input.actor.text === '', 'Clear removes composition and committed secret');
        }
        settings.set_uint('auto-reset-seconds', 1);
        Main.inputMethod._onUpdatePreeditText(null, IBus.Text.new_from_string('composition'), 0, true, IBus.PreeditFocusMode.COMMIT);
        await waitFor(() => !session._input.actor.clutter_text.has_preedit(), 'Inactivity clears composition', 2500);
        equal(session._passwordReset, 0, 'Inactivity timer released');
    },

    async 'in-memory freeze and all cursor modes restore native pointer/focus'({extension, settings}) {
        const tracker = global.backend.get_cursor_tracker();
        const visibility = tracker.get_pointer_visible();
        const focus = global.stage.key_focus;
        for (const mode of ['normal', 'hidden', 'lock-icon']) {
            settings.set_boolean('freeze-display', true);
            settings.set_string('cursor-mode', mode);
            const session = await protect(extension);
            const content = session._overlay.background.get_content();
            assert(content && content.get_texture().get_width() > 0, 'Native in-memory texture required');
            equal(tracker.get_pointer_visible(), mode === 'normal' ? visibility : false, 'Requested cursor visibility');
            session.close();
            equal(tracker.get_pointer_visible(), visibility, 'Cursor visibility restored');
            equal(global.stage.key_focus, focus, 'Focus restored');
        }
    },

    async 'disable/re-enable restores the privacy marker with denied native locking'({extension}) {
        const shield = Main.screenShield;
        const original = shield?.lock;
        if (shield)
            shield.lock = () => {};
        try {
            const first = await protect(extension);
            extension.disable();
            assert(first._closed && !extension._session, 'Disable releases old session');
            assert(extension._runtime.locked, 'Recovery marker retained immediately');
            await waitFor(() => global.get_runtime_state('b', 'stealth-lock@user.locked')?.deep_unpack(),
                'Retained recovery marker persisted');
            extension.enable();
            await waitFor(() => extension._session?._ready, 'Re-enable restores protection');
            assert(extension._session !== first, 'Recovered screen has fresh ownership');
            extension._session.close();
            assert(!extension._runtime.locked, 'Successful dismissal clears live marker immediately');
            await waitFor(() => global.get_runtime_state('b', 'stealth-lock@user.locked') === null,
                'Successful dismissal removes persisted marker');
        } finally {
            if (shield)
                shield.lock = original;
        }
    },

    async 'emergency chord uses the stock GNOME shield and defers cleanup until native unlock'({extension, helper}) {
        if (GLib.getenv('SLH_FAKE_GDM') !== '1')
            return {skipped: 'Private fake GDM required for stock ScreenShield'};
        assert(Main.screenShield, 'Stock ScreenShield created');
        const session = await protect(extension);
        await chord(helper, ['Control_L', 'Alt_L', 'Shift_L'], 'l');
        await waitFor(() => Main.screenShield.locked && Main.sessionMode.currentMode === 'unlock-dialog', 'Stock shield locks');
        assert(session._nativeLock && !session._overlay && !session._input, 'Privacy UI yields after native confirmation');
        Main.screenShield.deactivate(true);
        await waitFor(() => Main.sessionMode.currentMode === 'user' && extension._session === null, 'Native unlock completes session');
        assert(!extension._runtime.locked, 'Native unlock clears live privacy marker');
        await waitFor(() => global.get_runtime_state('b', 'stealth-lock@user.locked') === null,
            'Native unlock removes persisted privacy marker');
        return undefined;
    },

    async 'unavailable and refused native locking retain the privacy screen'({extension, helper}) {
        const shield = Main.screenShield;
        const original = shield?.lock;
        if (shield)
            shield.lock = () => {};
        try {
            const session = await protect(extension);
            await chord(helper, ['Control_L', 'Alt_L', 'Shift_L'], 'l');
            equal(extension._session, session, 'Denied handoff retains ownership');
            assert(!session._closed && session._overlay && Main.actionMode === Shell.ActionMode.NONE, 'Denied handoff retains keyboard/pointer protection');
        } finally {
            if (shield)
                shield.lock = original;
        }
    },
};
