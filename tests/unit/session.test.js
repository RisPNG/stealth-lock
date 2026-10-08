import assert from 'node:assert/strict';
import test from 'node:test';

import {Cancellable, deferred, loadModule} from './harness.js';

async function runtime({capture, verification, handoff = false, grabbed = true, freeze = false, pause = false,
    overlayError = false, cursorMode = 'normal', cursorApi = 'visibility', cursorVisible = true,
    cursorInhibitors = 0, nativeCursorInhibitor = false, mediaPause} = {}) {
    const events = [];
    const signals = new Map();
    const chrome = new Set();
    const sources = new Map();
    const state = new Map();
    const shortcuts = {lock: 7, abort: 8};
    const native = {locked: handoff, onLock: null};
    const display = {action: 0, get_keybinding_action() { return this.action; }};
    let nextSource = 1;
    const values = {
        'lock-type': 'stealth', 'pause-media': pause, 'freeze-display': freeze,
        'cursor-mode': cursorMode, 'auto-reset-seconds': 5, 'debug-mode': false,
        'normal-prompt-css': '', 'normal-background-css': '',
        'lock-hotkey': ['<Super>l'], 'debug-abort-hotkey': ['<Alt>l'],
    };
    const settings = {
        get_boolean: key => values[key], get_string: key => values[key], get_uint: key => values[key],
        get_strv: key => values[key], connectObject: () => {}, disconnectObject: () => events.push('settings-disconnect'),
    };
    const emitter = {
        connectObject: (signal, callback) => signals.set(signal, callback),
        disconnectObject: () => events.push('signals-disconnect'),
    };
    const seat = {
        inhibitors: cursorInhibitors === 0 ? 1 : 0,
        inhibit_unfocus() { this.inhibitors++; events.push('pointer-focus-inhibit'); },
        uninhibit_unfocus() {
            assert.ok(this.inhibitors > 0);
            this.inhibitors--;
            events.push('pointer-focus-uninhibit');
        },
    };
    const tracker = cursorApi === 'visibility' ? {
        visible: cursorVisible,
        get_pointer_visible() { return this.visible; },
        set_pointer_visible(visible) { this.visible = visible; events.push(['cursor-visible', visible]); },
        connectObject(_signal, callback) { this.visibilityChanged = callback; },
        disconnectObject() { this.visibilityChanged = null; events.push('cursor-disconnect'); },
    } : {
        inhibitors: cursorInhibitors,
        get_pointer_visible() { return this.inhibitors === 0; },
        inhibit_cursor_visibility() {
            this.inhibitors++;
            if (this.inhibitors === 1)
                seat.inhibitors--;
            events.push('cursor-inhibit');
        },
        uninhibit_cursor_visibility() {
            assert.ok(this.inhibitors > 0, 'every cursor release must correspond to an acquired inhibitor');
            this.inhibitors--;
            if (this.inhibitors === 0)
                seat.inhibitors++;
            events.push('cursor-uninhibit');
        },
    };
    const Clutter = {
        GrabState: {ALL: 3}, ContentGravity: {RESIZE_FILL: 0}, EVENT_PROPAGATE: false, EVENT_STOP: true,
        EventType: {KEY_PRESS: 1, KEY_RELEASE: 2, MOTION: 3, IM_COMMIT: 4, IM_DELETE: 5,
            BUTTON_PRESS: 6, ENTER: 7, LEAVE: 8, IM_PREEDIT: 9, BUTTON_RELEASE: 10},
        ModifierType: {CONTROL_MASK: 1, MOD1_MASK: 2, SHIFT_MASK: 4, SUPER_MASK: 8, META_MASK: 16},
        KEY_Escape: 27, KEY_Return: 13, KEY_KP_Enter: 14, KEY_r: 114, KEY_R: 82,
        KEY_l: 108, KEY_L: 76, KEY_u: 117, KEY_U: 85, KEY_Super_L: 1001, KEY_Super_R: 1002,
        KEY_Insert: 1003, KEY_Meta_L: 1004, KEY_Meta_R: 1005,
    };
    const Main = {
        layoutManager: {...emitter, addTopChrome: actor => {
            chrome.add(actor);
            events.push('chrome-add');
        }},
        pushModal: () => {
            events.push('grab');
            return {get_seat_state: () => grabbed ? 3 : 0};
        },
        popModal: () => events.push('ungrab'),
        notifyError: () => events.push('notify-error'),
    };
    class Input {
        constructor({onActivity}) {
            this.onActivity = onActivity;
            this.actor = {text: '', password_visible: false, grab_key_focus: () => events.push('focus'), contains: () => false};
            this.preedit = false;
            this.actor.clutter_text = {has_preedit: () => this.preedit};
        }
        discardPassword() {
            this.actor.text = '';
            this.actor.password_visible = false;
            this.preedit = false;
            this.onActivity();
        }
        takePassword() {
            const text = this.actor.text;
            this.discardPassword();
            return text;
        }
        handleEvent(event) {
            events.push(['input-event', event]);
            return Clutter.EVENT_PROPAGATE;
        }
        destroy() {
            this.discardPassword();
            events.push('input-destroy');
        }
    }
    class Overlay {
        constructor(_settings, inputActor) {
            if (overlayError)
                throw new Error('overlay construction failed');
            assert.equal(typeof inputActor.grab_key_focus, 'function', 'overlay borrows only the native input actor');
            this.actor = {opacity: 255, ...emitter};
            this.info = {text: ''};
            this.background = {set_content: () => events.push('screenshot-adopt'), set_content_gravity: () => {}};
            this.prompt = {visible: false};
        }
        refreshStyle() {}
        refreshEffect() {}
        setStatus(message) { this.info.text = message; }
        positionPrompt() {}
        movePointer() {}
        destroy() {
            events.push('overlay-destroy');
            if (chrome.delete(this.actor))
                events.push('chrome-remove');
        }
    }
    class Auth {
        constructor() { this.busy = false; this.retryUntil = 0; }
        async verify(password) {
            this.busy = true;
            events.push(['verify', password]);
            const result = verification ? await verification.promise : 'denied';
            this.busy = false;
            return result;
        }
    }
    class Media {
        constructor(cancellable) { this.cancellable = cancellable; }
        async pause() {
            events.push('media-pause');
            if (mediaPause)
                await mediaPause.promise;
            this.cancellable.set_error_if_cancelled();
        }
        close({resume}) {
            assert.equal(this.cancellable.is_cancelled(), true, 'session cancels owned work before releasing media');
            events.push(['media-close', resume]);
            if (pause && resume)
                events.push('media-resume');
        }
    }
    const global = {
        stage: {context: {get_backend: () => ({get_default_seat: () => seat})}},
        backend: {get_cursor_tracker: () => tracker},
        display,
        set_runtime_state: (key, value) => value === null ? state.delete(key) : state.set(key, value.value),
    };
    const GLib = {
        PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false, get_monotonic_time: () => 10000000,
        Variant: class { constructor(_type, value) { this.value = value; } },
        timeout_add: (_priority, _delay, callback) => {
            const id = nextSource++;
            sources.set(id, callback);
            return id;
        },
        Source: {remove: id => sources.delete(id)},
    };
    const module = await loadModule('shell/lockSession.js', {
        'gi://Clutter': {default: Clutter}, 'gi://Gio': {default: {Cancellable}},
        'gi://GLib': {default: GLib}, 'gi://Meta': {default: {KeyBindingAction: {NONE: 0},
            CursorTracker: cursorApi === 'visibility' ? {get_for_display: () => tracker} : {}}},
        'gi://Shell': {default: {ActionMode: {NONE: 0}}},
        'resource:///org/gnome/shell/ui/main.js': Main,
        './authentication.js': {Authentication: Auth, MAX_PASSWORD_BYTES: 512}, './input.js': {PasswordInput: Input},
        './overlay.js': {LockOverlay: Overlay},
        './media.js': {PausedMedia: Media},
        './screenshot.js': {captureScreenshot: async cancellable => {
            events.push('capture');
            const screenshot = capture ? await capture.promise : {content: {}};
            cancellable.set_error_if_cancelled();
            return screenshot;
        }},
        './integration.js': {handoffToSystemLock: () => {
            events.push('native-lock-request');
            native.onLock?.();
            if (handoff && nativeCursorInhibitor) {
                seat.inhibit_unfocus();
                tracker.inhibit_cursor_visibility();
            }
            return native.locked;
        }},
    }, {global, TextEncoder, console: {error: message => events.push(message), warn: message => events.push(message)}});
    const session = new module.LockSession({path: '/extension', settings, shortcuts, onClosed: () => events.push('closed')});
    return {session, events, signals, sources, state, settings, values, Clutter, chrome, shortcuts, display, native, tracker, seat, key: (key, state = 0) => ({
        type: () => Clutter.EventType.KEY_PRESS, get_key_symbol: () => key, get_state: () => state,
        get_key_code: () => 1, get_key_unicode: () => key,
    })};
}

test('protects input before awaiting capture and rejects adoption after disable', async () => {
    const capture = deferred();
    const {session, events, state} = await runtime({freeze: true, capture});
    const startup = session.start();
    assert.ok(events.indexOf('grab') < events.indexOf('capture'));
    assert.equal(state.get('stealth-lock@user.locked'), true);
    session.close({clearState: false});
    capture.resolve({content: {}});
    await startup;
    assert.ok(!events.includes('screenshot-adopt'));
    assert.equal(events.filter(event => event === 'closed').length, 1);
    assert.equal(state.get('stealth-lock@user.locked'), true);
});

test('a stale successful authentication cannot end a closed or replacement session', async () => {
    const verification = deferred();
    const {session, events, state} = await runtime({verification});
    await session.start();
    session._input.actor.text = 'secret';
    const attempt = session.authenticate();
    assert.equal(session._input.actor.text, '');
    session.close({clearState: false});
    verification.resolve('granted');
    await attempt;
    assert.equal(events.filter(event => event === 'closed').length, 1);
    assert.equal(state.get('stealth-lock@user.locked'), true);
});

test('successful unlock clears the recovery marker and releases resources in reverse', async () => {
    const verification = deferred();
    const {session, events, state, chrome} = await runtime({verification});
    await session.start();
    session._input.actor.text = 'correct';
    const attempt = session.authenticate();
    verification.resolve('granted');
    await attempt;
    assert.equal(state.has('stealth-lock@user.locked'), false);
    assert.ok(events.indexOf('ungrab') < events.indexOf('overlay-destroy'));
    assert.equal(chrome.size, 0);
    assert.equal(events.filter(event => event === 'chrome-remove').length, 1);
    assert.ok(events.indexOf('overlay-destroy') < events.indexOf('input-destroy'));
});

test('denied and unavailable authentication retain the modal with distinct feedback', async t => {
    for (const outcome of ['denied', 'error', true]) {
        await t.test(String(outcome), async () => {
            const verification = deferred();
            const {session, events, state} = await runtime({verification});
            await session.start();
            session._input.actor.text = 'secret';
            const attempt = session.authenticate();
            verification.resolve(outcome);
            await attempt;
            assert.equal(state.get('stealth-lock@user.locked'), true);
            assert.equal(events.includes('ungrab'), false);
            assert.match(session._overlay.info.text, outcome === 'denied' ? /Password not accepted/ : /Authentication unavailable/);
            session.close();
        });
    }
});

test('oversized Unicode input is cleared and rejected with byte-limit feedback before authentication', async () => {
    const {session, events} = await runtime();
    await session.start();
    session._input.actor.text = '🔐'.repeat(129);
    session._input.actor.password_visible = true;
    await session.authenticate();
    assert.equal(session._input.actor.text, '');
    assert.equal(session._input.actor.password_visible, false);
    assert.match(session._overlay.info.text, /512 UTF-8 bytes/);
    assert.equal(events.some(event => Array.isArray(event) && event[0] === 'verify'), false);
    assert.equal(events.includes('ungrab'), false);
    session.close();
});

test('password input receives events only while the session is ready and not authenticating', async () => {
    const capture = deferred();
    const {session, events, key, Clutter} = await runtime({freeze: true, capture});
    const startup = session.start();
    const event = key(Clutter.KEY_r, Clutter.ModifierType.CONTROL_MASK);
    assert.equal(session.handleEvent(event), Clutter.EVENT_STOP);
    assert.equal(events.some(event => Array.isArray(event) && event[0] === 'input-event'), false);
    capture.resolve({content: {}});
    await startup;
    assert.equal(session.handleEvent(event), Clutter.EVENT_PROPAGATE);
    assert.equal(events.at(-1)[1], event);
    session._authentication.busy = true;
    assert.equal(session.handleEvent(event), Clutter.EVENT_STOP);
    assert.equal(events.filter(event => Array.isArray(event) && event[0] === 'input-event').length, 1);
    session.close();
});

test('prompt presentation changes cannot alter delegation to password input', async () => {
    const {session, events, key, Clutter} = await runtime();
    await session.start();
    const reveal = key(Clutter.KEY_r, Clutter.ModifierType.CONTROL_MASK);
    for (const visible of [false, true]) {
        session._overlay.prompt.visible = visible;
        assert.equal(session.handleEvent(reveal), Clutter.EVENT_PROPAGATE);
    }
    assert.equal(events.filter(event => Array.isArray(event) && event[0] === 'input-event').length, 2);
    session.close();
});

test('cooldown submission clears the entry and reports retry time without starting authentication', async () => {
    const {session, events} = await runtime();
    await session.start();
    session._authentication.retryUntil = 12000;
    session._input.actor.text = 'secret';
    await session.authenticate();
    assert.equal(session._input.actor.text, '');
    assert.equal(session._overlay.info.text, 'Wait 2 seconds before retrying');
    assert.equal(events.some(event => Array.isArray(event) && event[0] === 'verify'), false);
    session.close();
});

test('cleanup continues after an individual teardown fails', async () => {
    const {session, events} = await runtime();
    await session.start();
    session._cleanup.push(() => { throw new Error('broken resource'); });
    session.close();
    assert.ok(events.includes('ungrab'));
    assert.ok(events.includes('input-destroy'));
    session.close();
    assert.equal(events.filter(event => event === 'closed').length, 1);
});

test('failed screenshot retains acquired protection when GNOME handoff is denied', async () => {
    const capture = deferred();
    const {session, events} = await runtime({freeze: true, capture});
    const startup = session.start();
    capture.reject(new Error('capture failed'));
    await startup;
    assert.equal(session._ready, true);
    assert.equal(session._overlay.actor.opacity, 255);
    assert.ok(!events.includes('ungrab'));
    session.close();
});

test('failure to grab input reports activation failure and never claims protection', async () => {
    const {session, events, state} = await runtime({grabbed: false});
    await session.start();
    assert.ok(events.includes('notify-error'));
    assert.ok(events.includes('ungrab'));
    assert.equal(state.has('stealth-lock@user.locked'), false);
});

test('overlay constructor failure still discards the immediately owned password input', async () => {
    const {session, events} = await runtime({overlayError: true});
    await session.start();
    assert.equal(events.filter(event => event === 'input-destroy').length, 1);
    assert.ok(events.includes('closed'));
    assert.ok(events.includes('notify-error'));
});

test('handoff only releases overlay after confirmed native lock and defers media restore', async () => {
    const {session, events, state} = await runtime({handoff: true, pause: true});
    await session.start();
    assert.equal(session.handoff(), true);
    assert.ok(events.indexOf('native-lock-request') < events.indexOf('ungrab'));
    assert.ok(!events.includes('media-resume'));
    assert.equal(state.get('stealth-lock@user.locked'), true);
    session.close();
    assert.ok(events.includes('media-resume'));
    assert.equal(state.has('stealth-lock@user.locked'), false);
});

test('session owns native notifications and restores media only after actual native unlock', async () => {
    const {session, events, state} = await runtime({pause: true});
    await session.start();
    session.systemLockChanged(false);
    assert.equal(events.includes('ungrab'), false);
    assert.equal(state.get('stealth-lock@user.locked'), true);
    session.systemLockChanged(true);
    session.systemLockChanged(true);
    assert.equal(session.cancellable.is_cancelled(), true);
    assert.equal(events.filter(event => event === 'ungrab').length, 1);
    assert.equal(events.some(event => Array.isArray(event) && event[0] === 'media-close'), false);
    assert.equal(events.includes('closed'), false);
    session.systemLockChanged(false);
    session.systemLockChanged(false);
    assert.equal(events.filter(event => event === 'media-resume').length, 1);
    assert.equal(events.filter(event => event === 'closed').length, 1);
    assert.equal(state.has('stealth-lock@user.locked'), false);
});

test('synchronous shield notifications cannot release the privacy grab before handoff confirmation', async () => {
    const {session, events, native} = await runtime();
    await session.start();
    native.onLock = () => {
        session.systemLockChanged(true);
        session.systemLockChanged(false);
        assert.equal(events.includes('ungrab'), false);
        assert.equal(session.cancellable.is_cancelled(), false);
    };
    assert.equal(session.handoff(), false);
    assert.equal(events.includes('ungrab'), false);
    native.onLock = null;
    native.locked = true;
    assert.equal(session.handoff(), true);
    assert.equal(events.filter(event => event === 'ungrab').length, 1);
    session.systemLockChanged(false);
});

test('disable owns native fallback, preserves recovery and discards media at every startup boundary', async t => {
    for (const handoff of [false, true]) {
        for (const preparing of [false, true]) {
            await t.test(`native ${handoff}, preparing ${preparing}`, async () => {
                const mediaPause = preparing ? deferred() : null;
                const {session, events, state} = await runtime({pause: true, handoff, mediaPause});
                const startup = session.start();
                if (!preparing)
                    await startup;
                session.disable();
                session.disable();
                assert.equal(session.cancellable.is_cancelled(), true);
                assert.ok(events.indexOf('native-lock-request') < events.indexOf('ungrab'));
                assert.equal(events.filter(event => event === 'native-lock-request').length, 1);
                assert.equal(events.filter(event => event === 'closed').length, 1);
                assert.equal(events.filter(event => Array.isArray(event) && event[0] === 'media-close').length, 1);
                assert.equal(events.find(event => Array.isArray(event) && event[0] === 'media-close')[1], false);
                assert.equal(events.includes('media-resume'), false);
                assert.equal(state.get('stealth-lock@user.locked'), true);
                if (preparing) {
                    mediaPause.resolve();
                    await startup;
                    assert.equal(events.includes('focus'), false);
                }
            });
        }
    }
});

test('disable after native activation never requests another lock or resumes media', async () => {
    const {session, events, state} = await runtime({pause: true});
    await session.start();
    session.systemLockChanged(true);
    session.disable();
    assert.equal(events.includes('native-lock-request'), false);
    assert.equal(events.includes('media-resume'), false);
    assert.equal(state.get('stealth-lock@user.locked'), true);
    assert.equal(events.filter(event => event === 'ungrab').length, 1);
});

test('diagnostic abort matching uses live registered shortcut values independently of the extension', async () => {
    const {session, events, values, shortcuts, display, key} = await runtime();
    await session.start();
    values['debug-mode'] = true;
    display.action = shortcuts.abort;
    session.handleEvent(key(97));
    assert.equal(events.filter(event => event === 'native-lock-request').length, 1);
    shortcuts.abort = 9;
    session.handleEvent(key(97));
    assert.equal(events.filter(event => event === 'native-lock-request').length, 1);
    display.action = 9;
    session.handleEvent(key(97));
    assert.equal(events.filter(event => event === 'native-lock-request').length, 2);
    values['debug-abort-use-lock-hotkey'] = true;
    display.action = shortcuts.lock;
    session.handleEvent(key(97));
    assert.equal(events.filter(event => event === 'native-lock-request').length, 3);
    values['debug-abort-use-lock-hotkey'] = false;
    values['debug-abort-hotkey'] = values['lock-hotkey'];
    session.handleEvent(key(97));
    assert.equal(events.filter(event => event === 'native-lock-request').length, 4);
    session.close();
});

test('GNOME45–48 cursor visibility is enforced and restored to its original value once', async t => {
    for (const cursorVisible of [true, false]) {
        await t.test(`original visibility ${cursorVisible}`, async () => {
            const state = await runtime({cursorMode: 'hidden', cursorVisible});
            await state.session.start();
            assert.equal(state.tracker.visible, false);
            state.tracker.visible = true;
            state.tracker.visibilityChanged();
            assert.equal(state.tracker.visible, false);
            state.session.close();
            assert.equal(state.tracker.visible, cursorVisible);
            const released = state.events.filter(event => event === 'cursor-disconnect').length;
            state.session.close();
            assert.equal(state.events.filter(event => event === 'cursor-disconnect').length, released);
        });
    }
});

test('GNOME49–51 cursor ownership releases only its own inhibitor on ordinary close', async t => {
    for (const cursorInhibitors of [0, 1]) {
        await t.test(`existing inhibitors ${cursorInhibitors}`, async () => {
            const state = await runtime({cursorMode: 'lock-icon', cursorApi: 'inhibitor', cursorInhibitors});
            await state.session.start();
            assert.equal(state.tracker.inhibitors, cursorInhibitors + 1);
            assert.equal(state.seat.inhibitors, 1, 'the hidden pointer remains usable inside the modal');
            assert.equal(state.tracker.get_pointer_visible(), false);
            state.session.close();
            state.session.close();
            assert.equal(state.tracker.inhibitors, cursorInhibitors);
            assert.equal(state.seat.inhibitors, cursorInhibitors === 0 ? 1 : 0);
            assert.equal(state.events.filter(event => event === 'cursor-inhibit').length, 1);
            assert.equal(state.events.filter(event => event === 'cursor-uninhibit').length, 1);
            assert.equal(state.events.filter(event => event === 'pointer-focus-inhibit').length, 1);
            assert.equal(state.events.filter(event => event === 'pointer-focus-uninhibit').length, 1);
        });
    }
});

test('native lock handoff retains its cursor inhibitor and releases the extension inhibitor', async () => {
    const state = await runtime({cursorMode: 'hidden', cursorApi: 'inhibitor', handoff: true, nativeCursorInhibitor: true});
    await state.session.start();
    assert.equal(state.tracker.inhibitors, 1);
    assert.equal(state.session.handoff(), true);
    assert.equal(state.tracker.inhibitors, 1, 'the native ScreenShield still owns visibility');
    assert.equal(state.tracker.get_pointer_visible(), false);
    assert.equal(state.seat.inhibitors, 1, 'the native shield owns its hidden pointer focus');
    state.session.close();
    assert.equal(state.tracker.inhibitors, 1, 'later extension teardown cannot release the native shield');
    assert.equal(state.events.filter(event => event === 'cursor-uninhibit').length, 1);
    state.tracker.uninhibit_cursor_visibility();
    state.seat.uninhibit_unfocus();
    assert.equal(state.tracker.get_pointer_visible(), true);
    assert.equal(state.seat.inhibitors, 1, 'native visible pointer focus returns to its original state');
});

test('normal cursor mode never acquires or releases native visibility ownership', async t => {
    for (const cursorApi of ['visibility', 'inhibitor']) {
        await t.test(cursorApi, async () => {
            const state = await runtime({cursorApi});
            await state.session.start();
            state.session.close();
            assert.equal(state.seat.inhibitors, 1);
            assert.equal(state.events.some(event => typeof event === 'string' && event.startsWith('cursor-') ||
                typeof event === 'string' && event.startsWith('pointer-focus-') ||
                Array.isArray(event) && event[0] === 'cursor-visible'), false);
        });
    }
});

test('denied handoff never releases the overlay or clears recovery state', async () => {
    const {session, events, state, tracker, seat} = await runtime({cursorMode: 'hidden', cursorApi: 'inhibitor'});
    await session.start();
    assert.equal(session.handoff(), false);
    assert.ok(!events.includes('ungrab'));
    assert.equal(state.get('stealth-lock@user.locked'), true);
    assert.equal(tracker.inhibitors, 1);
    assert.equal(seat.inhibitors, 1);
    session.close();
});

test('inactivity clears and conceals password; zero setting creates no timer', async () => {
    const {session, sources, values} = await runtime();
    await session.start();
    session._input.actor.text = 'secret';
    session._input.actor.password_visible = true;
    session.resetPasswordTimeout();
    assert.equal(sources.size, 1);
    const callback = [...sources.values()][0];
    callback();
    assert.equal(session._input.actor.text, '');
    assert.equal(session._input.actor.password_visible, false);
    values['auto-reset-seconds'] = 0;
    sources.clear();
    session._input.actor.text = 'secret';
    session.resetPasswordTimeout();
    assert.equal(sources.size, 0);
    session.close();
});

test('Escape clears text without unlocking, repeated Escape in debug requests native lock', async () => {
    const {session, values, key, Clutter, events} = await runtime();
    await session.start();
    session._input.actor.text = 'secret';
    session.handleEvent(key(Clutter.KEY_Escape));
    assert.equal(session._input.actor.text, '');
    assert.ok(!events.includes('ungrab'));
    values['debug-mode'] = true;
    for (let count = 0; count < 5; count++)
        session.handleEvent(key(Clutter.KEY_Escape));
    assert.ok(events.includes('native-lock-request'));
    assert.ok(!events.includes('ungrab'));
    session.close();
});

test('pointer crossings propagate inside the modal during setup and authentication', async () => {
    const capture = deferred();
    const {session, Clutter} = await runtime({freeze: true, capture});
    const startup = session.start();
    for (const type of [Clutter.EventType.ENTER, Clutter.EventType.LEAVE])
        assert.equal(session.handleEvent({type: () => type}), Clutter.EVENT_PROPAGATE);
    capture.resolve({content: {}});
    await startup;
    session._authentication.busy = true;
    for (const type of [Clutter.EventType.ENTER, Clutter.EventType.LEAVE])
        assert.equal(session.handleEvent({type: () => type}), Clutter.EVENT_PROPAGATE);
    session.close();
});

test('inactivity also discards native composition when no characters are committed', async () => {
    const {session, sources, Clutter} = await runtime();
    await session.start();
    session.handleEvent({type: () => Clutter.EventType.IM_PREEDIT, get_im_text: () => 'pending'});
    session._input.preedit = true;
    assert.equal(sources.size, 1);
    [...sources.values()][0]();
    assert.equal(session._input.preedit, false);
    assert.equal(session._passwordReset, 0);
    session.handleEvent({type: () => Clutter.EventType.IM_PREEDIT, get_im_text: () => ''});
    assert.equal(session._passwordReset, 0);
    session.close();
});
