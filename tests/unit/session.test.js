import assert from 'node:assert/strict';
import test from 'node:test';

import {Cancellable, deferred, loadModule} from './harness.js';

async function runtime({capture, verification, handoff = false, grabbed = true, freeze = false, pause = false, overlayError = false} = {}) {
    const events = [];
    const signals = new Map();
    const chrome = new Set();
    const sources = new Map();
    const state = new Map();
    let nextSource = 1;
    const values = {
        'lock-type': 'stealth', 'pause-media': pause, 'freeze-display': freeze,
        'cursor-mode': 'normal', 'auto-reset-seconds': 5, 'debug-mode': false,
        'normal-prompt-css': '', 'normal-background-css': '',
    };
    const settings = {
        get_boolean: key => values[key], get_string: key => values[key], get_uint: key => values[key],
        get_strv: () => [], connectObject: () => {}, disconnectObject: () => events.push('settings-disconnect'),
    };
    const emitter = {
        connectObject: (signal, callback) => signals.set(signal, callback),
        disconnectObject: () => events.push('signals-disconnect'),
    };
    const Clutter = {
        GrabState: {ALL: 3}, ContentGravity: {RESIZE_FILL: 0}, EVENT_PROPAGATE: false, EVENT_STOP: true,
        EventType: {KEY_PRESS: 1, KEY_RELEASE: 2, MOTION: 3, IM_COMMIT: 4, IM_DELETE: 5, BUTTON_PRESS: 6, ENTER: 7, LEAVE: 8},
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
        destroy() {
            this.discardPassword();
            events.push('input-destroy');
        }
    }
    class Overlay {
        constructor() {
            if (overlayError)
                throw new Error('overlay construction failed');
            this.actor = {opacity: 255, ...emitter};
            this.info = {text: ''};
            this.background = {set_content: () => events.push('screenshot-adopt'), set_content_gravity: () => {}};
            this.prompt = {visible: false};
        }
        refreshStyle() {}
        positionPrompt() {}
        movePointer() {}
        destroy() {
            events.push('overlay-destroy');
            if (chrome.delete(this.actor))
                events.push('chrome-remove');
        }
    }
    class Auth {
        constructor() { this.busy = false; }
        async verify(password) {
            this.busy = true;
            events.push(['verify', password]);
            const result = verification ? await verification.promise : false;
            this.busy = false;
            return result;
        }
    }
    const global = {
        stage: {},
        display: {get_keybinding_action: () => 0},
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
    const module = await loadModule('lockSession.js', {
        'gi://Clutter': {default: Clutter}, 'gi://Gio': {default: {Cancellable}},
        'gi://GLib': {default: GLib}, 'gi://Meta': {default: {KeyBindingAction: {NONE: 0}}},
        'gi://Shell': {default: {ActionMode: {NONE: 0}}},
        'resource:///org/gnome/shell/ui/main.js': Main,
        './authentication.js': {Authentication: Auth}, './input.js': {PasswordInput: Input},
        './overlay.js': {LockOverlay: Overlay},
        './screenshot.js': {captureScreenshot: async cancellable => {
            events.push('capture');
            const screenshot = capture ? await capture.promise : {content: {}};
            cancellable.set_error_if_cancelled();
            return screenshot;
        }},
        './shell.js': {handoffToSystemLock: () => {
            events.push('native-lock-request');
            return handoff;
        }},
    }, {global, console: {error: message => events.push(message), warn: message => events.push(message)}});
    const session = new module.LockSession({path: '/extension', getSettings: () => settings}, () => events.push('closed'));
    return {session, events, signals, sources, state, settings, values, Clutter, chrome, key: (key, state = 0) => ({
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
    verification.resolve(true);
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
    verification.resolve(true);
    await attempt;
    assert.equal(state.has('stealth-lock@user.locked'), false);
    assert.ok(events.indexOf('ungrab') < events.indexOf('overlay-destroy'));
    assert.equal(chrome.size, 0);
    assert.equal(events.filter(event => event === 'chrome-remove').length, 1);
    assert.ok(events.indexOf('overlay-destroy') < events.indexOf('input-destroy'));
});

test('cleanup continues after an individual teardown fails', async () => {
    const {session, events} = await runtime();
    await session.start();
    session._cleanup.push({release: () => { throw new Error('broken resource'); }});
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
    const {session, events, state} = await runtime({handoff: true});
    await session.start();
    session._cleanup.push({media: true, release: () => events.push('media-resume')});
    assert.equal(session.handoff(), true);
    assert.ok(events.indexOf('native-lock-request') < events.indexOf('ungrab'));
    assert.ok(!events.includes('media-resume'));
    assert.equal(state.get('stealth-lock@user.locked'), true);
    session.close();
    assert.ok(events.includes('media-resume'));
    assert.equal(state.has('stealth-lock@user.locked'), false);
});

test('denied handoff never releases the overlay or clears recovery state', async () => {
    const {session, events, state} = await runtime();
    await session.start();
    assert.equal(session.handoff(), false);
    assert.ok(!events.includes('ungrab'));
    assert.equal(state.get('stealth-lock@user.locked'), true);
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

test('clipboard paste shortcuts and modifier release cannot escape input protection', async () => {
    const {session, key, Clutter} = await runtime();
    await session.start();
    assert.equal(session.handleEvent(key(Clutter.KEY_Insert, Clutter.ModifierType.SHIFT_MASK)), Clutter.EVENT_STOP);
    assert.equal(session.handleEvent({type: () => Clutter.EventType.KEY_RELEASE, get_key_symbol: () => Clutter.KEY_Super_L}), Clutter.EVENT_STOP);
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
