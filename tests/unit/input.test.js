import assert from 'node:assert/strict';
import test from 'node:test';

import {loadModule} from './harness.js';

async function runtime({stealth = false, attached = true, revealTimeoutSeconds = 10} = {}) {
    const events = [];
    const callbacks = new Map();
    const entryCallbacks = new Map();
    const timers = new Map();
    let nextTimer = 1;
    const lockdown = {disable_show_password: false};
    const peekChild = {};
    const peek = {contains: source => source === peekChild};
    const Clutter = {
        EVENT_PROPAGATE: false, EVENT_STOP: true,
        EventType: {KEY_PRESS: 1, KEY_RELEASE: 2, IM_COMMIT: 3, IM_DELETE: 4, IM_PREEDIT: 5,
            BUTTON_PRESS: 6, BUTTON_RELEASE: 7, SCROLL: 8, TOUCH_BEGIN: 9, TOUCH_UPDATE: 10, TOUCH_END: 11, TOUCH_CANCEL: 12},
        ModifierType: {CONTROL_MASK: 1, MOD1_MASK: 2, SHIFT_MASK: 4, SUPER_MASK: 8, META_MASK: 16},
        KEY_a: 97, KEY_A: 65, KEY_Home: 1006, KEY_End: 1007, KEY_Left: 1008, KEY_Right: 1009, KEY_Delete: 1010, KEY_r: 114, KEY_R: 82, KEY_u: 117, KEY_U: 85, KEY_Insert: 1000,
        KEY_Super_L: 1001, KEY_Super_R: 1002, KEY_Meta_L: 1003, KEY_Meta_R: 1004,
    };
    let actor;
    const stage = {
        focus: null,
        get_key_focus() { return this.focus; },
        get_event_actor(event) { return event.get_source(); },
        set_key_focus(focus) {
            events.push(['focus', focus]);
            if (actor && this.focus && (this.focus === actor || actor.contains(this.focus))) {
                events.push('native-focus-out');
                if (actor.preedit) {
                    actor.text += actor.preedit;
                    actor.preedit = '';
                    events.push('native-composition-reset');
                }
            }
            this.focus = focus;
        },
    };
    class Entry {
        constructor(properties) {
            actor = this;
            this.properties = properties;
            this._text = '';
            this._visible = false;
            this.preedit = '';
            this.destroyed = false;
            this.clutter_text = {
                set_max_length: length => { this.maximumCharacters = length; },
                connectObject: (...arguments_) => {
                    assert.equal(arguments_.at(-1), this);
                    for (let i = 0; i < arguments_.length - 1; i += 2)
                        callbacks.set(arguments_[i], arguments_[i + 1]);
                },
                disconnectObject: owner => {
                    assert.equal(owner, this);
                    events.push('disconnect');
                    callbacks.clear();
                },
            };
        }
        get text() { return this._text; }
        set text(value) {
            this._text = value;
            events.push(['text', value]);
            callbacks.get('text-changed')?.();
        }
        get password_visible() { return this._visible; }
        set password_visible(value) {
            const changed = this._visible !== value;
            this._visible = value;
            events.push(['visible', value]);
            if (changed)
                entryCallbacks.get('notify::password-visible')?.();
        }
        connectObject(...arguments_) {
            assert.equal(arguments_.at(-1), this);
            for (let index = 0; index < arguments_.length - 1; index += 2)
                entryCallbacks.set(arguments_[index], arguments_[index + 1]);
        }
        disconnectObject(owner) {
            assert.equal(owner, this);
            entryCallbacks.clear();
            events.push('entry-disconnect');
        }
        set_size(width, height) { this.size = [width, height]; }
        get_stage() { return attached ? stage : null; }
        get_secondary_icon() { return this.properties.show_peek_icon ? peek : null; }
        contains(other) { return other === this.clutter_text; }
        grab_key_focus() {
            events.push(['refocus', this.text, this.password_visible]);
            stage.set_key_focus(this.clutter_text);
        }
        destroy() {
            events.push('actor-destroy');
            if (stage.focus === this || this.contains(stage.focus))
                stage.set_key_focus(null);
            this.destroyed = true;
        }
    }
    const {PasswordInput} = await loadModule('shell/input.js', {
        'gi://Clutter': {default: Clutter},
        'gi://GLib': {default: {
            PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false,
            timeout_add(_priority, milliseconds, callback) {
                const id = nextTimer++;
                timers.set(id, {milliseconds, callback});
                return id;
            },
            Source: {remove(id) { assert.equal(timers.delete(id), true); }},
        }},
        'gi://St': {default: {PasswordEntry: Entry, Settings: {get: () => lockdown}}},
    });
    const input = new PasswordInput({
        stealth, revealTimeoutSeconds,
        onSubmit: () => events.push('submit'),
        onActivity: () => events.push('activity'),
    });
    return {input, actor, stage, events, callbacks, entryCallbacks, timers, lockdown, peek, peekChild, Clutter,
        expire() {
            const [id, timer] = timers.entries().next().value;
            timers.delete(id);
            assert.equal(timer.callback(), false);
        },
        key: (key, modifiers = 0, unicode = key) => ({
            type: () => Clutter.EventType.KEY_PRESS, get_key_symbol: () => key,
            get_state: () => modifiers, get_key_unicode: () => unicode,
        }),
    };
}

test('constructs a native password entry with separate stealth and normal presentation', async () => {
    const normal = await runtime();
    assert.equal(normal.actor.maximumCharacters, 512);
    assert.equal(normal.actor.properties.show_peek_icon, true);
    assert.equal(normal.actor.properties.x_expand, true);
    assert.equal(normal.actor.properties.can_focus, true);
    assert.equal(normal.actor.properties.reactive, true);
    assert.equal(normal.actor.properties.style_class, 'stealth-lock-password-entry');
    const stealth = await runtime({stealth: true});
    assert.equal(stealth.actor.properties.show_peek_icon, false);
    assert.equal(stealth.actor.properties.x_expand, false);
    assert.equal(stealth.actor.properties.style_class, 'stealth-lock-hidden-input');
    assert.deepEqual(stealth.actor.size, [1, 1]);
    assert.equal(stealth.actor.opacity, 0);
});

test('native activation and text changes call the supplied session callbacks', async () => {
    const {actor, callbacks, events} = await runtime();
    actor.text = 'päss🔐';
    callbacks.get('activate')();
    assert.deepEqual(events, [['text', 'päss🔐'], 'activity', 'submit']);
});

test('discard clears a synchronous focus-out composition commit before restoring owned focus', async t => {
    for (const focusTarget of ['entry', 'text']) {
        await t.test(focusTarget, async () => {
            const {input, actor, stage, events} = await runtime();
            actor.text = 'committed';
            actor.preedit = 'pending';
            actor.password_visible = true;
            stage.focus = focusTarget === 'entry' ? actor : actor.clutter_text;
            events.length = 0;
            input.discardPassword();
            assert.equal(actor.text, '');
            assert.equal(actor.preedit, '');
            assert.equal(actor.password_visible, false);
            assert.equal(stage.focus, actor.clutter_text);
            const resetIndex = events.indexOf('native-composition-reset');
            const clearIndex = events.findIndex(event => Array.isArray(event) && event[0] === 'text' && event[1] === '');
            const refocusIndex = events.findIndex(event => Array.isArray(event) && event[0] === 'refocus');
            assert.ok(resetIndex >= 0 && resetIndex < clearIndex);
            assert.ok(clearIndex < refocusIndex);
            assert.deepEqual(events[refocusIndex], ['refocus', '', false]);
            assert.ok(events.lastIndexOf('activity') < refocusIndex);
        });
    }
});

test('taking a password returns only committed text and discards pending composition', async () => {
    const {input, actor, stage} = await runtime();
    actor.text = 'päss🔐';
    actor.preedit = 'uncommitted';
    stage.focus = actor.clutter_text;
    assert.equal(input.takePassword(), 'päss🔐');
    assert.equal(actor.text, '');
    assert.equal(actor.preedit, '');
    assert.equal(actor.password_visible, false);
});

test('taking composition-only input returns an empty password and clears composition', async () => {
    const {input, actor, stage} = await runtime();
    actor.preedit = 'uncommitted';
    stage.focus = actor.clutter_text;
    assert.equal(input.takePassword(), '');
    assert.equal(actor.text, '');
    assert.equal(actor.preedit, '');
});

test('discard never steals focus from an unrelated actor', async () => {
    const {input, actor, stage, events} = await runtime();
    const unrelated = {};
    stage.focus = unrelated;
    actor.text = 'secret';
    actor.password_visible = true;
    events.length = 0;
    input.discardPassword();
    assert.equal(stage.focus, unrelated);
    assert.equal(actor.text, '');
    assert.equal(actor.password_visible, false);
    assert.equal(events.some(event => Array.isArray(event) && ['focus', 'refocus'].includes(event[0])), false);
    assert.ok(events.includes('activity'));
});

test('offstage cleanup clears credentials without changing stage focus', async () => {
    const {input, actor, stage, events} = await runtime({attached: false});
    const unrelated = {};
    stage.focus = unrelated;
    actor.text = 'secret';
    actor.password_visible = true;
    events.length = 0;
    input.discardPassword();
    assert.equal(stage.focus, unrelated);
    assert.equal(actor.text, '');
    assert.equal(actor.password_visible, false);
    assert.equal(events.some(event => Array.isArray(event) && ['focus', 'refocus'].includes(event[0])), false);
});

test('destroy disconnects entry signals before discarding credentials and destroying the actor', async () => {
    const {input, actor, stage, events, callbacks} = await runtime();
    actor.text = 'secret';
    actor.preedit = 'pending';
    actor.password_visible = true;
    stage.focus = actor.clutter_text;
    events.length = 0;
    input.destroy();
    assert.equal(events[0], 'disconnect');
    assert.equal(callbacks.size, 0);
    assert.equal(actor.text, '');
    assert.equal(actor.preedit, '');
    assert.equal(actor.password_visible, false);
    assert.equal(actor.destroyed, true);
    assert.equal(stage.focus, null);
    assert.equal(events.filter(event => event === 'activity').length, 1);
    assert.ok(events.indexOf('activity') < events.indexOf('actor-destroy'));
    assert.equal(events.filter(event => event === 'actor-destroy').length, 1);
});

test('reveal shortcut follows input mode and live native reveal policy', async t => {
    for (const stealth of [false, true]) {
        await t.test(stealth ? 'stealth' : 'normal', async () => {
            const {input, actor, lockdown, key, Clutter} = await runtime({stealth});
            const reveal = key(Clutter.KEY_r, Clutter.ModifierType.CONTROL_MASK);
            assert.equal(input.handleEvent(reveal), Clutter.EVENT_STOP);
            assert.equal(actor.password_visible, !stealth);
            actor.password_visible = false;
            lockdown.disable_show_password = true;
            assert.equal(input.handleEvent(reveal), Clutter.EVENT_STOP);
            assert.equal(actor.password_visible, false);
            lockdown.disable_show_password = false;
            input.handleEvent(key(Clutter.KEY_R, Clutter.ModifierType.CONTROL_MASK));
            assert.equal(actor.password_visible, !stealth);
        });
    }
});

test('Ctrl+U clears committed and composing input without exposing it', async () => {
    const {input, actor, stage, key, Clutter} = await runtime();
    actor.text = 'secret';
    actor.preedit = 'pending';
    actor.password_visible = true;
    stage.focus = actor.clutter_text;
    assert.equal(input.handleEvent(key(Clutter.KEY_u, Clutter.ModifierType.CONTROL_MASK)), Clutter.EVENT_STOP);
    assert.equal(actor.text, '');
    assert.equal(actor.preedit, '');
    assert.equal(actor.password_visible, false);
    assert.equal(stage.focus, actor.clutter_text);
});

test('native text editing and IME propagate while paste and desktop shortcuts are blocked', async () => {
    const {input, actor, stage, key, Clutter} = await runtime();
    const modifiers = Clutter.ModifierType;
    for (const event of [key(118, modifiers.CONTROL_MASK), key(Clutter.KEY_Insert, modifiers.SHIFT_MASK),
        key(Clutter.KEY_Super_L), key(120, modifiers.SUPER_MASK), key(120, modifiers.META_MASK),
        key(1005, modifiers.MOD1_MASK, 0)])
        assert.equal(input.handleEvent(event), Clutter.EVENT_STOP);
    assert.equal(stage.focus, null);
    for (const event of [key(97), key(8), key(13), key(233, modifiers.MOD1_MASK)])
        assert.equal(input.handleEvent(event), Clutter.EVENT_PROPAGATE);
    assert.equal(stage.focus, actor.clutter_text);
    for (const type of [Clutter.EventType.IM_COMMIT, Clutter.EventType.IM_DELETE, Clutter.EventType.IM_PREEDIT])
        assert.equal(input.handleEvent({type: () => type}), Clutter.EVENT_PROPAGATE);
    for (const key of [Clutter.KEY_Super_L, Clutter.KEY_Super_R, Clutter.KEY_Meta_L, Clutter.KEY_Meta_R])
        assert.equal(input.handleEvent({type: () => Clutter.EventType.KEY_RELEASE, get_key_symbol: () => key}), Clutter.EVENT_STOP);
    assert.equal(input.handleEvent({type: () => Clutter.EventType.KEY_RELEASE, get_key_symbol: () => 97}), Clutter.EVENT_PROPAGATE);
});

test('pointer permission is limited to the native reveal icon and its children', async t => {
    for (const stealth of [false, true]) {
        await t.test(stealth ? 'stealth' : 'normal', async () => {
            const {input, lockdown, peek, peekChild, Clutter} = await runtime({stealth});
            for (const type of [Clutter.EventType.BUTTON_PRESS, Clutter.EventType.BUTTON_RELEASE]) {
                for (const source of [peek, peekChild, {}, null]) {
                    const event = {type: () => type, get_button: () => 1, get_source: () => source};
                    assert.equal(input.handleEvent(event), !stealth && [peek, peekChild].includes(source)
                        ? Clutter.EVENT_PROPAGATE : Clutter.EVENT_STOP);
                    lockdown.disable_show_password = true;
                    assert.equal(input.handleEvent(event), Clutter.EVENT_STOP);
                    lockdown.disable_show_password = false;
                }
                assert.equal(input.handleEvent({type: () => type, get_button: () => 2, get_source: () => peek}), Clutter.EVENT_STOP);
            }
            assert.equal(input.handleEvent({type: () => Clutter.EventType.SCROLL}), Clutter.EVENT_STOP);
        });
    }
});

test('native selection and cursor navigation propagate while clipboard and desktop combinations stop', async () => {
    const {input, key, Clutter} = await runtime();
    const {CONTROL_MASK: control, SHIFT_MASK: shift, MOD1_MASK: alt, SUPER_MASK: superKey} = Clutter.ModifierType;
    for (const symbol of [Clutter.KEY_a, Clutter.KEY_A, Clutter.KEY_Home, Clutter.KEY_End, Clutter.KEY_Left, Clutter.KEY_Right]) {
        assert.equal(input.handleEvent(key(symbol, control)), Clutter.EVENT_PROPAGATE);
        assert.equal(input.handleEvent(key(symbol, control | shift)), Clutter.EVENT_PROPAGATE);
        assert.equal(input.handleEvent(key(symbol, control | alt)), Clutter.EVENT_STOP);
        assert.equal(input.handleEvent(key(symbol, control | superKey)), Clutter.EVENT_STOP);
    }
    for (const symbol of [99, 120, 118, Clutter.KEY_Insert, Clutter.KEY_Delete])
        assert.equal(input.handleEvent(key(symbol, control)), Clutter.EVENT_STOP);
    assert.equal(input.handleEvent(key(Clutter.KEY_Delete, shift)), Clutter.EVENT_STOP);
    for (const symbol of [Clutter.KEY_Home, Clutter.KEY_End, Clutter.KEY_Left, Clutter.KEY_Right])
        assert.equal(input.handleEvent(key(symbol)), Clutter.EVENT_PROPAGATE);
});

test('normal touch reveal follows an owned native icon sequence and leaves all other touch blocked', async t => {
    for (const stealth of [false, true]) {
        await t.test(stealth ? 'stealth' : 'normal', async () => {
            const {input, peek, peekChild, lockdown, Clutter} = await runtime({stealth});
            const event = (type, sequence, source) => ({type: () => type, get_event_sequence: () => sequence, get_source: () => source});
            const sequence = {get_slot: () => 1};
            const unrelated = {get_slot: () => 2};
            assert.equal(input.handleEvent(event(Clutter.EventType.TOUCH_BEGIN, unrelated, {})), Clutter.EVENT_STOP);
            assert.equal(input.handleEvent(event(Clutter.EventType.TOUCH_UPDATE, unrelated, peek)), Clutter.EVENT_STOP);
            assert.equal(input.handleEvent(event(Clutter.EventType.TOUCH_BEGIN, sequence, peekChild)),
                stealth ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE);
            assert.equal(input.handleEvent(event(Clutter.EventType.TOUCH_UPDATE, sequence, peek)),
                stealth ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE);
            assert.equal(input.handleEvent(event(Clutter.EventType.TOUCH_UPDATE, {get_slot: () => 1}, peek)),
                stealth ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE);
            assert.equal(input.handleEvent(event(Clutter.EventType.TOUCH_UPDATE, sequence, {})), Clutter.EVENT_STOP);
            lockdown.disable_show_password = true;
            assert.equal(input.handleEvent(event(Clutter.EventType.TOUCH_END, sequence, peek)), Clutter.EVENT_STOP);
            assert.equal(input._revealTouches.size, 0);
            lockdown.disable_show_password = false;
            assert.equal(input.handleEvent(event(Clutter.EventType.TOUCH_UPDATE, sequence, peek)), Clutter.EVENT_STOP);
            input.handleEvent(event(Clutter.EventType.TOUCH_BEGIN, sequence, peek));
            input.handleEvent(event(Clutter.EventType.TOUCH_CANCEL, sequence, peek));
            assert.equal(input._revealTouches.size, 0);
            input.handleEvent(event(Clutter.EventType.TOUCH_BEGIN, sequence, peek));
            input.discardPassword();
            assert.equal(input._revealTouches.size, 0);
        });
    }
});

test('native icon and shortcut visibility changes share one reveal deadline and discard removes it', async () => {
    const {input, actor, timers, expire, key, Clutter} = await runtime({revealTimeoutSeconds: 3});
    actor.password_visible = true;
    assert.equal(timers.size, 1);
    assert.equal([...timers.values()][0].milliseconds, 3000);
    expire();
    assert.equal(actor.password_visible, false);
    assert.equal(timers.size, 0);
    input.handleEvent(key(Clutter.KEY_r, Clutter.ModifierType.CONTROL_MASK));
    assert.equal(timers.size, 1);
    input.handleEvent(key(Clutter.KEY_r, Clutter.ModifierType.CONTROL_MASK));
    assert.equal(timers.size, 0);
    actor.password_visible = true;
    input.discardPassword();
    assert.equal(timers.size, 0);
    actor.password_visible = true;
    input.destroy();
    assert.equal(timers.size, 0);
});

test('zero reveal timeout retains native explicit concealment and stealth never owns a reveal source', async () => {
    for (const options of [{revealTimeoutSeconds: 0}, {stealth: true}]) {
        const {input, actor, timers} = await runtime(options);
        actor.password_visible = true;
        assert.equal(timers.size, 0);
        input.discardPassword();
        assert.equal(actor.password_visible, false);
        input.destroy();
    }
});
