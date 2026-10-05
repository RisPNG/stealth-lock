import assert from 'node:assert/strict';
import test from 'node:test';

import {loadModule} from './harness.js';

async function extensionRuntime({wasLocked = false, nativeLocked = false, debugMode = false, deferRestore = false} = {}) {
    const state = new Map(wasLocked ? [['stealth-lock@user.locked', true]] : []);
    const events = [];
    let nativeChange;
    let pendingRestore;
    const settings = {
        get_user_value: () => null,
        get_boolean: key => key === 'debug-mode' && debugMode,
        get_strv: key => [key === 'lock-hotkey' ? '<Super><Control>l' : '<Control><Alt><Shift>u'],
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
        wm: {
            addKeybinding: name => {
                events.push(['add', name]);
                return 1;
            },
            removeKeybinding: name => events.push(['remove', name]),
        },
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
        './presets.js': {initializeEffectPresets: () => {}},
        './shell.js': {restoreWhenShellReady: callback => {
            if (deferRestore)
                pendingRestore = callback;
            else
                callback();
            return () => { pendingRestore = null; };
        }, watchSystemLock: callback => {
            nativeChange = callback;
            return () => events.push('lock-watch-disconnect');
        }},
    }, {global});
    const extension = new module.default();
    return {extension, events, state, nativeChange: locked => nativeChange(locked), restore: () => pendingRestore?.()};
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

test('diagnostic shortcut cleanup removes only bindings acquired by this extension', async () => {
    const inactive = await extensionRuntime();
    inactive.extension.enable();
    inactive.extension.configureAbortShortcut();
    inactive.extension.disable();
    assert.equal(inactive.events.filter(event => Array.isArray(event) && event[0] === 'remove' && event[1] === 'debug-abort-hotkey').length, 0);

    const active = await extensionRuntime({debugMode: true});
    active.extension.enable();
    active.extension.configureAbortShortcut();
    active.extension.disable();
    const acquired = active.events.filter(event => Array.isArray(event) && event[0] === 'add' && event[1] === 'debug-abort-hotkey').length;
    const released = active.events.filter(event => Array.isArray(event) && event[0] === 'remove' && event[1] === 'debug-abort-hotkey').length;
    assert.equal(acquired, 2);
    assert.equal(released, acquired);
    assert.equal(active.extension._abortAction, 0);
});

test('deferred recovery rechecks the marker and is canceled when the extension is disabled', async t => {
    for (const cancel of ['native unlock', 'disable']) {
        await t.test(cancel, async () => {
            const {extension, events, state, nativeChange, restore} = await extensionRuntime({wasLocked: true, deferRestore: true});
            extension.enable();
            assert.ok(!events.includes('start'));
            if (cancel === 'native unlock') {
                nativeChange(false);
                assert.equal(state.has('stealth-lock@user.locked'), false);
            } else {
                extension.disable();
                assert.equal(state.get('stealth-lock@user.locked'), true);
            }
            restore();
            assert.ok(!events.includes('start'));
            if (cancel === 'native unlock')
                extension.disable();
        });
    }
});

test('recovery waits for all startup handlers and releases pending work at either boundary', async t => {
    for (const endpoint of ['complete', 'before startup', 'before idle', 'already ready']) {
        await t.test(endpoint, async () => {
            const handlers = new Map();
            const sources = new Map();
            const owner = {};
            let actionMode;
            let calls = 0;
            const layoutManager = {
                _startingUp: endpoint !== 'already ready',
                connectObject: (signal, callback, actualOwner) => {
                    assert.equal(actualOwner, owner);
                    handlers.set(signal, callback);
                },
                disconnectObject: actualOwner => {
                    assert.equal(actualOwner, owner);
                    handlers.clear();
                },
            };
            const GLib = {
                PRIORITY_DEFAULT_IDLE: 200, SOURCE_REMOVE: false,
                idle_add: (priority, callback) => {
                    assert.equal(priority, 200);
                    sources.set(1, callback);
                    return 1;
                },
                Source: {remove: id => assert.equal(sources.delete(id), true)},
            };
            const {restoreWhenShellReady} = await loadModule('shell.js', {
                'gi://GLib': {default: GLib},
                'resource:///org/gnome/shell/ui/main.js': {layoutManager},
            });
            const release = restoreWhenShellReady(() => { calls++; actionMode = 0; }, owner);
            if (endpoint === 'already ready') {
                assert.equal(calls, 1);
                assert.equal(sources.size, 0);
                release();
                return;
            }
            assert.equal(calls, 0);
            if (endpoint === 'before startup') {
                release();
                assert.equal(handlers.size, 0);
                assert.equal(sources.size, 0);
                return;
            }
            handlers.get('startup-complete')();
            actionMode = 1;
            assert.equal(calls, 0, 'Main startup action-mode updates run before recovery');
            assert.equal(handlers.size, 0);
            if (endpoint === 'before idle') {
                release();
                assert.equal(sources.size, 0);
                return;
            }
            const idle = sources.get(1);
            sources.delete(1);
            assert.equal(idle(), false);
            assert.equal(calls, 1);
            assert.equal(actionMode, 0);
            release();
        });
    }
});

test('an unavailable native shield refuses handoff without preventing privacy screen ownership', async () => {
    const {handoffToSystemLock, watchSystemLock} = await loadModule('shell.js', {
        'gi://GLib': {default: {}},
        'resource:///org/gnome/shell/ui/main.js': {screenShield: null},
    });
    assert.equal(handoffToSystemLock(), false);
    let changes = 0;
    const release = watchSystemLock(() => changes++);
    release();
    assert.equal(changes, 0);
});

test('native handoff requires both locked and active confirmation', async () => {
    for (const [locked, active] of [[false, false], [false, true], [true, false], [true, true]]) {
        const shield = {locked, active, lock: animate => assert.equal(animate, false)};
        const {handoffToSystemLock} = await loadModule('shell.js', {
            'gi://GLib': {default: {}},
            'resource:///org/gnome/shell/ui/main.js': {screenShield: shield},
        });
        assert.equal(handoffToSystemLock(), locked && active);
    }
});

test('native shield watch ignores intermediate unlocking and releases both connections', async () => {
    const handlers = new Map();
    const removed = [];
    const states = [];
    const shield = {
        locked: false,
        active: true,
        connect: (name, callback) => {
            handlers.set(name, callback);
            return name;
        },
        disconnect: id => removed.push(id),
    };
    const {watchSystemLock} = await loadModule('shell.js', {
        'gi://GLib': {default: {}},
        'resource:///org/gnome/shell/ui/main.js': {screenShield: shield},
    });
    const release = watchSystemLock(locked => states.push(locked));
    handlers.get('locked-changed')();
    assert.deepEqual(states, []);
    shield.locked = true;
    handlers.get('locked-changed')();
    shield.locked = false;
    handlers.get('locked-changed')();
    shield.active = false;
    handlers.get('active-changed')();
    assert.deepEqual(states, [true, false]);
    release();
    assert.deepEqual(removed, ['active-changed', 'locked-changed']);
});
