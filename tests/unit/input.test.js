import assert from 'node:assert/strict';
import test from 'node:test';

import {loadModule} from './harness.js';

async function runtime({stealth = false, attached = true} = {}) {
    const events = [];
    const callbacks = new Map();
    let actor;
    const stage = {
        focus: null,
        get_key_focus() { return this.focus; },
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
            this._visible = value;
            events.push(['visible', value]);
        }
        set_size(width, height) { this.size = [width, height]; }
        get_stage() { return attached ? stage : null; }
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
    const {PasswordInput} = await loadModule('input.js', {'gi://St': {default: {PasswordEntry: Entry}}});
    const input = new PasswordInput({
        stealth,
        onSubmit: () => events.push('submit'),
        onActivity: () => events.push('activity'),
    });
    return {input, actor, stage, events, callbacks};
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
