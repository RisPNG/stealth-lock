import assert from 'node:assert/strict';
import test from 'node:test';

import {loadModule} from './harness.js';

async function extensionRuntime({wasLocked = false, nativeLocked = false} = {}) {
    const state = new Map(wasLocked ? [['stealth-lock@user.locked', true]] : []);
    const events = [];
    let nativeChange;
    const settings = {
        get_user_value: () => null,
        get_boolean: () => false,
        connectObject: () => {},
        disconnectObject: () => events.push('settings-disconnect'),
    };
    class Extension {
        getSettings() { return settings; }
    }
    class LockSession {
        constructor(_extension, onClosed) {
            this.onClosed = onClosed;
            this.cancellable = {cancel: () => events.push('cancel')};
            this._nativeLock = false;
        }
        start() { events.push('start'); }
        handoff() {
            events.push('handoff');
            this._nativeLock = true;
        }
        nativeLockActivated() { this._nativeLock = true; }
        close(options = {}) {
            events.push(['close', options]);
            if (options.clearState !== false)
                state.delete('stealth-lock@user.locked');
            this.onClosed();
        }
    }
    const Main = {
        wm: {addKeybinding: () => 1, removeKeybinding: name => events.push(['remove', name])},
        sessionMode: {currentMode: nativeLocked ? 'unlock-dialog' : 'user', isLocked: nativeLocked},
    };
    const global = {
        get_runtime_state: (_type, key) => state.has(key) ? {deep_unpack: () => state.get(key)} : null,
        set_runtime_state: (key, value) => value === null ? state.delete(key) : state.set(key, value),
    };
    const module = await loadModule('extension.js', {
        'gi://Meta': {default: {KeyBindingFlags: {NONE: 0}, KeyBindingAction: {NONE: 0}}},
        'gi://Shell': {default: {ActionMode: {NORMAL: 1, OVERVIEW: 2, NONE: 0}}},
        'resource:///org/gnome/shell/ui/main.js': Main,
        'resource:///org/gnome/shell/extensions/extension.js': {Extension},
        './lockSession.js': {LockSession, LOCKED_STATE: 'stealth-lock@user.locked'},
        './shell.js': {watchSystemLock: callback => {
            nativeChange = callback;
            return () => events.push('lock-watch-disconnect');
        }},
    }, {global});
    const extension = new module.default();
    return {extension, events, state, nativeChange: locked => nativeChange(locked)};
}

test('reload within the login session reapplies an active privacy screen', async () => {
    const {extension, events, state} = await extensionRuntime({wasLocked: true});
    extension.enable();
    assert.equal(events.filter(event => event === 'start').length, 1);
    assert.equal(state.get('stealth-lock@user.locked'), true);
    extension.lock();
    assert.equal(events.filter(event => event === 'start').length, 1);
    extension.disable();
    assert.ok(events.indexOf('handoff') < events.indexOf('cancel'));
    assert.equal(state.get('stealth-lock@user.locked'), true);
});

test('a clean login or authenticated dismissal does not create a recovery screen', async () => {
    const {extension, events} = await extensionRuntime();
    extension.enable();
    assert.ok(!events.includes('start'));
    extension.disable();
});

test('recovery does not interfere with an existing native lock and clears after native unlock', async () => {
    const {extension, events, state, nativeChange} = await extensionRuntime({wasLocked: true, nativeLocked: true});
    extension.enable();
    assert.ok(!events.includes('start'));
    nativeChange(false);
    assert.equal(state.has('stealth-lock@user.locked'), false);
    extension.disable();
});

test('an unrelated inactive shield event cannot clear an active privacy recovery marker', async () => {
    const {extension, state, nativeChange} = await extensionRuntime({wasLocked: true});
    extension.enable();
    nativeChange(false);
    assert.equal(state.get('stealth-lock@user.locked'), true);
    extension.disable();
});
