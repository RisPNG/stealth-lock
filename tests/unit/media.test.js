import assert from 'node:assert/strict';
import test from 'node:test';

import {Cancellable, loadModule} from './harness.js';

async function runtime() {
    const calls = [];
    const warnings = [];
    let closed = 0;
    class Variant {
        constructor(type, value) {
            this.type = type;
            this.value = value;
        }
        deep_unpack() { return this.value; }
    }
    const bus = {
        call(destination, path, iface, method, parameters, replyType, flags, timeout, cancellable, callback) {
            calls.push({destination, path, iface, method, parameters, replyType, flags, timeout, cancellable, callback});
        },
        call_finish(result) {
            if (result.error)
                throw result.error;
            return new Variant('', result.value);
        },
    };
    const flags = {NONE: 0, NO_AUTO_START: 1};
    const {LockSession} = await loadModule('lockSession.js', {
        'gi://Clutter': {default: {}},
        'gi://Gio': {default: {Cancellable, DBus: {session: bus}, DBusCallFlags: flags}},
        'gi://GLib': {default: {Variant, VariantType: class { constructor(type) { this.type = type; } }}},
        'gi://Meta': {default: {}}, 'gi://Shell': {default: {}}, 'gi://St': {default: {}},
        'resource:///org/gnome/shell/ui/main.js': {},
        './authentication.js': {Authentication: class {}},
        './input.js': {PasswordInput: class {}}, './overlay.js': {LockOverlay: class {}},
        './screenshot.js': {captureScreenshot: () => {}}, './shell.js': {handoffToSystemLock: () => false},
    }, {
        global: {set_runtime_state: () => {}},
        console: {warn: message => warnings.push(message), error: message => warnings.push(message)},
    });
    const session = new LockSession({path: '/extension', getSettings: () => ({})}, () => closed++);
    return {session, calls, warnings, flags, Variant, closed: () => closed};
}

async function reply(call, value, error) {
    assert.ok(call?.callback, 'expected a pending DBus request');
    call.callback({call_finish: result => {
        if (result.error)
            throw result.error;
        return {deep_unpack: () => result.value};
    }}, {value, error});
    await new Promise(resolve => setImmediate(resolve));
}

async function playingPlayer(runtime, names = ['org.mpris.MediaPlayer2.player']) {
    const task = runtime.session.pauseMedia();
    await reply(runtime.calls.at(-1), [names]);
    const ownerCall = runtime.calls.find(call => call.method === 'GetNameOwner');
    await reply(ownerCall, [':1.44']);
    const statusCall = runtime.calls.find(call => call.method === 'Get');
    await reply(statusCall, [new runtime.Variant('s', 'Playing')]);
    return {task, pause: runtime.calls.find(call => call.method === 'Pause')};
}

test('pauses only MPRIS players and restores the same unique owner without activation', async () => {
    const state = await runtime();
    const {task, pause} = await playingPlayer(state, ['org.example.Unrelated', 'org.mpris.MediaPlayer2.player']);
    await reply(pause, []);
    await task;
    assert.deepEqual(state.calls.map(call => call.method), ['ListNames', 'GetNameOwner', 'Get', 'Pause']);
    const owner = state.calls[1];
    assert.equal(owner.parameters.type, '(s)');
    assert.equal(owner.parameters.value[0], 'org.mpris.MediaPlayer2.player');
    const status = state.calls[2];
    assert.equal(status.destination, ':1.44');
    assert.equal(status.parameters.value[0], 'org.mpris.MediaPlayer2.Player');
    assert.equal(status.parameters.value[1], 'PlaybackStatus');
    assert.equal(pause.destination, ':1.44');
    assert.equal(pause.flags, state.flags.NO_AUTO_START);
    state.session.close();
    const play = state.calls.at(-1);
    assert.equal(play.method, 'Play');
    assert.equal(play.destination, ':1.44');
    assert.equal(play.path, '/org/mpris/MediaPlayer2');
    assert.equal(play.iface, 'org.mpris.MediaPlayer2.Player');
    assert.equal(play.flags, state.flags.NO_AUTO_START);
    assert.equal(play.cancellable, null);
    assert.equal(typeof play.callback, 'function');
    await reply(play, []);
    assert.equal(state.warnings.length, 0);
    assert.equal(state.session._cleanup.length, 0);
    state.session.close();
    assert.equal(state.calls.filter(call => call.method === 'Play').length, 1);
    assert.equal(state.closed(), 1);
});

test('paused and stopped players remain unchanged', async t => {
    for (const status of ['Paused', 'Stopped']) {
        await t.test(status, async () => {
            const state = await runtime();
            const task = state.session.pauseMedia();
            await reply(state.calls.at(-1), [['org.mpris.MediaPlayer2.player']]);
            await reply(state.calls.at(-1), [':1.44']);
            await reply(state.calls.at(-1), [new state.Variant('s', status)]);
            await task;
            state.session.close();
            assert.deepEqual(state.calls.map(call => call.method), ['ListNames', 'GetNameOwner', 'Get']);
            assert.equal(state.session._cleanup.length, 0);
        });
    }
});

test('failed discovery, owner, status, and Pause never resume an unsuccessful player', async t => {
    for (const failure of ['ListNames', 'GetNameOwner', 'Get', 'Pause']) {
        await t.test(failure, async () => {
            const state = await runtime();
            const task = state.session.pauseMedia();
            for (const method of ['ListNames', 'GetNameOwner', 'Get', 'Pause']) {
                const call = state.calls.at(-1);
                assert.equal(call.method, method);
                if (method === failure) {
                    await reply(call, undefined, new Error('player disappeared'));
                    break;
                }
                const value = method === 'ListNames' ? [['org.mpris.MediaPlayer2.player']]
                    : method === 'GetNameOwner' ? [':1.44'] : [new state.Variant('s', 'Playing')];
                await reply(call, value);
            }
            await task;
            assert.equal(state.session._cleanup.length, 0);
            state.session.close();
            assert.equal(state.calls.filter(call => call.method === 'Play').length, 0);
            assert.equal(state.warnings.length, 1);
        });
    }
});

test('closing at every DBus await rejects late replies and cannot acquire cleanup', async t => {
    for (const cancellation of ['ListNames', 'GetNameOwner', 'Get', 'Pause']) {
        await t.test(cancellation, async () => {
            const state = await runtime();
            const task = state.session.pauseMedia();
            for (const method of ['ListNames', 'GetNameOwner', 'Get', 'Pause']) {
                const call = state.calls.at(-1);
                assert.equal(call.method, method);
                const value = method === 'ListNames' ? [['org.mpris.MediaPlayer2.player']]
                    : method === 'GetNameOwner' ? [':1.44']
                        : method === 'Get' ? [new state.Variant('s', 'Playing')] : [];
                if (method === cancellation) {
                    state.session.close();
                    const countAfterClose = state.calls.length;
                    await reply(call, value);
                    await task;
                    assert.equal(state.calls.length, countAfterClose);
                    break;
                }
                await reply(call, value);
            }
            assert.equal(state.session._cleanup.length, 0);
            assert.equal(state.closed(), 1);
            assert.equal(state.warnings.length, 0);
            assert.equal(state.calls.filter(call => call.method === 'Play').length, cancellation === 'Pause' ? 1 : 0);
        });
    }
});

test('native lock keeps in-flight Pause compensation until native unlock', async () => {
    const state = await runtime();
    const {task, pause} = await playingPlayer(state);
    state.session.nativeLockActivated();
    assert.equal(state.calls.filter(call => call.method === 'Play').length, 0);
    await reply(pause, undefined, new Error('cancelled after remote Pause'));
    await task;
    assert.equal(state.session._cleanup.length, 1);
    state.session.close();
    assert.equal(state.calls.at(-1).method, 'Play');
    assert.equal(state.calls.at(-1).destination, ':1.44');
    assert.equal(state.session._cleanup.length, 0);
    assert.equal(state.warnings.length, 0);
});

test('disable skips media compensation even when Pause completed remotely', async () => {
    const state = await runtime();
    const {task, pause} = await playingPlayer(state);
    state.session.close({resumeMedia: false, clearState: false});
    await reply(pause, []);
    await task;
    assert.equal(state.calls.filter(call => call.method === 'Play').length, 0);
    assert.equal(state.session._cleanup.length, 0);
});

test('a failing player does not prevent other players being paused and restored', async () => {
    const state = await runtime();
    const task = state.session.pauseMedia();
    await reply(state.calls.at(-1), [['org.mpris.MediaPlayer2.failed', 'org.mpris.MediaPlayer2.playing']]);
    const owners = state.calls.filter(call => call.method === 'GetNameOwner');
    await reply(owners[0], undefined, new Error('owner vanished'));
    await reply(owners[1], [':1.88']);
    await reply(state.calls.at(-1), [new state.Variant('s', 'Playing')]);
    await reply(state.calls.at(-1), []);
    await task;
    state.session.close();
    const plays = state.calls.filter(call => call.method === 'Play');
    assert.equal(plays.length, 1);
    assert.equal(plays[0].destination, ':1.88');
    assert.equal(state.warnings.length, 1);
});

test('MPRIS aliases sharing one unique owner pause and restore the player exactly once', async () => {
    const state = await runtime();
    const task = state.session.pauseMedia();
    await reply(state.calls.at(-1), [['org.mpris.MediaPlayer2.primary', 'org.mpris.MediaPlayer2.alias']]);
    const owners = state.calls.filter(call => call.method === 'GetNameOwner');
    await reply(owners[0], [':1.55']);
    await reply(owners[1], [':1.55']);
    const status = state.calls.filter(call => call.method === 'Get');
    assert.equal(status.length, 1);
    await reply(status[0], [new state.Variant('s', 'Playing')]);
    const pauses = state.calls.filter(call => call.method === 'Pause');
    assert.equal(pauses.length, 1);
    await reply(pauses[0], []);
    await task;
    state.session.close();
    const plays = state.calls.filter(call => call.method === 'Play');
    assert.equal(plays.length, 1);
    assert.equal(plays[0].destination, ':1.55');
    await reply(plays[0], []);
    assert.equal(state.warnings.length, 0);
});

test('failed resume reports the original unique owner without reactivating or retrying the player', async () => {
    const state = await runtime();
    const {task, pause} = await playingPlayer(state);
    await reply(pause, []);
    await task;
    state.session.close();
    await reply(state.calls.at(-1), undefined, new Error('owner vanished'));
    assert.equal(state.warnings.length, 1);
    assert.match(state.warnings[0], /media resume failed for :1.44: owner vanished/);
    assert.equal(state.session._cleanup.length, 0);
    assert.equal(state.closed(), 1);
    assert.equal(state.calls.filter(call => call.method === 'Play').length, 1);
});
