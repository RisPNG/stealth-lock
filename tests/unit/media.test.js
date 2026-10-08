import assert from 'node:assert/strict';
import test from 'node:test';

import {Cancellable, loadModule} from './harness.js';
import {LOCKED_STATE, PAUSED_MEDIA_STATE} from '../../shared/runtime-state.js';

async function runtime({players = [{name: 'org.mpris.MediaPlayer2.player', owner: ':1.44', status: 'Playing'}], saved = null} = {}) {
    const calls = [];
    const warnings = [];
    const signals = new Map();
    const state = new Map(saved ? [[PAUSED_MEDIA_STATE, saved]] : []);
    let nextId = 1;
    let epoch = 0;
    class Variant {
        constructor(type, value) { this.type = type; this.value = value; }
        deep_unpack() {
            return this.type === '(ssas)' ? [this.value[0], this.value[1], [...this.value[2]]] : this.value;
        }
    }
    const faults = new Map();
    const bus = {
        call(destination, path, iface, method, parameters, replyType, flags, timeout, cancellable, callback) {
            if (faults.get(method) === 'synchronous')
                throw new Error(method + ' unavailable');
            calls.push({destination, path, iface, method, parameters, replyType, flags, timeout, cancellable, callback, settled: false});
        },
        call_finish(result) {
            if (result.error)
                throw result.error;
            return new Variant('', result.value);
        },
        signal_subscribe(sender, iface, signal, path, arg0, flags, callback) {
            const id = nextId++;
            signals.set(id, {sender, iface, signal, path, arg0, flags, callback});
            return id;
        },
        signal_unsubscribe(id) { assert.equal(signals.delete(id), true); },
    };
    const DBus = {session: bus};
    const flags = {NONE: 0, NO_AUTO_START: 1};
    const {PausedMedia} = await loadModule('shell/media.js', {
        'gi://Gio': {default: {DBus, DBusCallFlags: flags, DBusSignalFlags: {NONE: 0}}},
        'gi://GLib': {default: {Variant, VariantType: class { constructor(type) { this.type = type; } },
            uuid_string_random: () => 'epoch-' + ++epoch}},
        '../shared/runtime-state.js': {LOCKED_STATE, PAUSED_MEDIA_STATE},
    }, {
        global: {
            get_runtime_state: (type, key) => state.has(key) ? new Variant(type, state.get(key)) : null,
            set_runtime_state: (key, value) => value === null ? state.delete(key) : state.set(key, value.deep_unpack()),
        },
        console: {warn: message => warnings.push(message)},
    });
    const cancellable = new Cancellable();
    const ownership = {current: null};
    return {media: new PausedMedia(cancellable, ownership), cancellable, PausedMedia, calls, warnings, signals, state,
        Variant, flags, DBus, bus, players, faults, ownership, busId: 'original-bus',
        signal(owner, status, invalidated = []) {
            for (const subscription of [...signals.values()]) {
                if (subscription.signal === 'PropertiesChanged')
                    subscription.callback(bus, owner, '/org/mpris/MediaPlayer2', '', '',
                        new Variant('', ['org.mpris.MediaPlayer2.Player', status ? {PlaybackStatus: new Variant('s', status)} : {}, invalidated]));
            }
        },
        disappear(owner) {
            for (const subscription of [...signals.values()]) {
                if (subscription.signal === 'NameOwnerChanged')
                    subscription.callback(bus, 'org.freedesktop.DBus', '', '', '', new Variant('', [owner, owner, '']));
            }
        },
    };
}

async function reply(state, call, value, error = null) {
    assert.ok(call && !call.settled, 'expected one unsettled request');
    call.settled = true;
    call.callback(state.bus, {value, error});
    await new Promise(resolve => setImmediate(resolve));
}

async function drain(state, {leavePause = false, stopAt = null} = {}) {
    for (;;) {
        const call = state.calls.find(request => !request.settled && !(leavePause && request.method === 'Pause'));
        if (!call || call.method === stopAt)
            return;
        if (state.faults.has(call.method)) {
            await reply(state, call, undefined, new Error(call.method + ' unavailable'));
            continue;
        }
        let value;
        if (call.method === 'GetId') {
            value = [state.busId];
        } else if (call.method === 'ListNames') {
            value = [state.players.map(player => player.name)];
        } else if (call.method === 'GetNameOwner') {
            const player = state.players.find(player => player.name === call.parameters.value[0]);
            if (!player) {
                await reply(state, call, undefined, new Error('owner disappeared'));
                continue;
            }
            value = [player.owner];
        } else if (call.method === 'Get') {
            const player = state.players.find(player => player.owner === call.destination);
            if (!player) {
                await reply(state, call, undefined, new Error('owner disappeared'));
                continue;
            }
            value = [new state.Variant('s', player.status)];
        } else {
            const player = state.players.find(player => player.owner === call.destination);
            if (player)
                player.status = call.method === 'Pause' ? 'Paused' : 'Playing';
            value = [];
        }
        await reply(state, call, value);
    }
}

async function pause(state, options) {
    const task = state.media.pause(options);
    await drain(state);
    await task;
}

async function close(state, options) {
    state.cancellable.cancel();
    const task = state.media.close(options);
    await drain(state);
    await task;
}

test('pauses only playing MPRIS players and restores the same unique owner without activation', async () => {
    const state = await runtime({players: [
        {name: 'org.example.Unrelated', owner: ':1.22', status: 'Playing'},
        {name: 'org.mpris.MediaPlayer2.player', owner: ':1.44', status: 'Playing'},
        {name: 'org.mpris.MediaPlayer2.paused', owner: ':1.55', status: 'Paused'},
        {name: 'org.mpris.MediaPlayer2.stopped', owner: ':1.66', status: 'Stopped'},
    ]});
    await pause(state);
    assert.equal(state.calls.filter(call => call.method === 'Pause').length, 1);
    assert.deepEqual(state.state.get(PAUSED_MEDIA_STATE), ['original-bus', 'epoch-1', [':1.44']]);
    assert.equal(state.signals.size, 2);
    await close(state);
    const play = state.calls.find(call => call.method === 'Play');
    assert.equal(play.destination, ':1.44');
    assert.equal(play.flags, state.flags.NO_AUTO_START);
    assert.equal(play.cancellable, null);
    assert.equal(state.calls.filter(call => call.method === 'Play').length, 1);
    assert.equal(state.signals.size, 0);
    assert.equal(state.state.has(PAUSED_MEDIA_STATE), false);
    assert.equal(state.warnings.length, 0);
    assert.equal(state.media.close(), state.media._restoration);
});

test('MPRIS aliases sharing a unique owner are paused and restored once', async () => {
    const state = await runtime({players: [
        {name: 'org.mpris.MediaPlayer2.player', owner: ':1.44', status: 'Playing'},
        {name: 'org.mpris.MediaPlayer2.alias', owner: ':1.44', status: 'Playing'},
    ]});
    await pause(state);
    assert.equal(state.calls.filter(call => call.method === 'Get').length, 1);
    assert.equal(state.calls.filter(call => call.method === 'Pause').length, 1);
    await close(state);
    assert.equal(state.calls.filter(call => call.method === 'Play').length, 1);
});

test('failures at every discovery and pause phase remain optional and never restore an unsuccessful player', async t => {
    for (const method of ['GetId', 'ListNames', 'GetNameOwner', 'Get', 'Pause']) {
        await t.test(method, async () => {
            const state = await runtime();
            state.faults.set(method, 'asynchronous');
            await pause(state);
            state.faults.clear();
            await close(state);
            assert.equal(state.calls.filter(call => call.method === 'Play').length, 0);
            assert.equal(state.signals.size, 0);
            assert.equal(state.warnings.length, 1);
        });
    }
});

test('cancellation at every await prevents late resources and keeps only a possibly completed Pause for restoration', async t => {
    for (const method of ['GetId', 'ListNames', 'GetNameOwner', 'Get', 'Pause']) {
        await t.test(method, async () => {
            const state = await runtime();
            const task = state.media.pause();
            await drain(state, {stopAt: method});
            const request = state.calls.find(call => !call.settled);
            assert.equal(request.method, method);
            state.cancellable.cancel();
            const restoration = state.media.close();
            const count = state.calls.length;
            await reply(state, request, method === 'Pause' ? [] : method === 'Get' ? [new state.Variant('s', 'Playing')]
                : method === 'GetId' ? ['original-bus'] : method === 'ListNames' ? [['org.mpris.MediaPlayer2.player']] : [':1.44']);
            await task;
            assert.equal(state.calls.length, count + (method === 'Pause' ? 1 : 0));
            await drain(state);
            await restoration;
            assert.equal(state.signals.size, 0);
            assert.equal(state.warnings.length, 0);
            assert.equal(state.calls.filter(call => call.method === 'Play').length, 0);
        });
    }
});

test('cancellation after a remote Pause keeps compensation until native unlock', async () => {
    const state = await runtime();
    const task = state.media.pause();
    await drain(state, {leavePause: true});
    const request = state.calls.find(call => call.method === 'Pause');
    state.players[0].status = 'Paused';
    state.cancellable.cancel();
    await reply(state, request, undefined, new Error('cancelled after remote Pause'));
    await task;
    assert.equal(state.calls.filter(call => call.method === 'Play').length, 0);
    await close(state);
    assert.equal(state.calls.filter(call => call.method === 'Play').length, 1);
});

test('disable discards restoration even if Pause completed remotely', async () => {
    const state = await runtime();
    const task = state.media.pause();
    await drain(state, {leavePause: true});
    state.players[0].status = 'Paused';
    state.cancellable.cancel();
    state.media.close({resume: false});
    await reply(state, state.calls.find(call => call.method === 'Pause'), []);
    await task;
    assert.equal(state.state.has(PAUSED_MEDIA_STATE), false);
    assert.equal(state.calls.filter(call => call.method === 'Play').length, 0);
    assert.equal(state.signals.size, 0);
});

test('close waits for a delivered remote Pause before reading playback or compensating it', async () => {
    const state = await runtime();
    const task = state.media.pause();
    await drain(state, {leavePause: true});
    const pending = state.calls.find(call => call.method === 'Pause');
    assert.equal(pending.cancellable, null, 'delivered remote work owns its bounded reply');
    state.cancellable.cancel();
    const restoration = state.media.close();
    assert.equal(state.calls.at(-1), pending, 'close does not query an obsolete Playing status');
    state.players[0].status = 'Paused';
    await reply(state, pending, []);
    await task;
    await drain(state);
    await restoration;
    assert.equal(state.players[0].status, 'Playing');
    assert.equal(state.calls.filter(call => call.method === 'Play').length, 1);
    assert.equal(state.ownership.pendingPauses.size, 0);
});

test('a replacement scope waits for its predecessor Pause before rehydrating and restoring', async () => {
    const state = await runtime();
    const task = state.media.pause();
    await drain(state, {leavePause: true});
    const pending = state.calls.find(call => call.method === 'Pause');
    state.cancellable.cancel();
    const oldClose = state.media.close();
    const cancellable = new Cancellable();
    const replacement = new state.PausedMedia(cancellable, state.ownership);
    state.state.set(LOCKED_STATE, true);
    const adopted = replacement.pause({pausePlaying: false});
    await reply(state, state.calls.at(-1), ['original-bus']);
    assert.equal(state.calls.filter(call => call.method === 'Get').length, 1, 'both scopes await the known remote Pause');
    state.players[0].status = 'Paused';
    await reply(state, pending, []);
    await task;
    await drain(state);
    await oldClose;
    await adopted;
    assert.equal(state.calls.filter(call => call.method === 'Play').length, 0);
    assert.equal(replacement._players.size, 1);
    state.state.delete(LOCKED_STATE);
    cancellable.cancel();
    const restored = replacement.close();
    await drain(state);
    await restored;
    assert.equal(state.calls.filter(call => call.method === 'Play').length, 1);
    assert.equal(state.ownership.current, null);
    assert.equal(state.ownership.pendingPauses.size, 0);
});

test('external Playing, Stopped, invalidated status and disappearing unique owners cancel restoration', async t => {
    for (const change of ['Playing', 'Stopped', 'invalidated', 'disappeared']) {
        await t.test(change, async () => {
            const state = await runtime();
            await pause(state);
            if (change === 'disappeared')
                state.disappear(':1.44');
            else
                state.signal(':1.44', change === 'invalidated' ? null : change, change === 'invalidated' ? ['PlaybackStatus'] : []);
            assert.deepEqual(state.state.get(PAUSED_MEDIA_STATE)[2], []);
            await close(state);
            assert.equal(state.calls.filter(call => call.method === 'Play').length, 0);
            assert.equal(state.signals.size, 0);
        });
    }
});

test('the own Paused signal retains restoration and unrelated signals leave it unchanged', async () => {
    const state = await runtime();
    await pause(state);
    state.signal(':1.44', 'Paused');
    state.signal(':1.999', 'Playing');
    state.disappear(':1.999');
    assert.deepEqual(state.state.get(PAUSED_MEDIA_STATE)[2], [':1.44']);
    await close(state);
    assert.equal(state.calls.filter(call => call.method === 'Play').length, 1);
});

test('restoration rechecks current playback and never resumes a stopped or already playing player', async t => {
    for (const status of ['Playing', 'Stopped']) {
        await t.test(status, async () => {
            const state = await runtime();
            await pause(state);
            state.players[0].status = status;
            await close(state);
            assert.equal(state.calls.filter(call => call.method === 'Play').length, 0);
        });
    }
});

test('crash recovery adopts only matching-bus paused owners, with media pausing disabled', async () => {
    const state = await runtime({players: [
        {name: 'org.mpris.MediaPlayer2.paused', owner: ':1.44', status: 'Paused'},
        {name: 'org.mpris.MediaPlayer2.playing', owner: ':1.55', status: 'Playing'},
        {name: 'org.mpris.MediaPlayer2.stopped', owner: ':1.66', status: 'Stopped'},
    ], saved: ['original-bus', 'dead-epoch', [':1.44', ':1.55', ':1.66', ':1.77']]});
    assert.equal(state.state.get(PAUSED_MEDIA_STATE)[1], 'epoch-1');
    await pause(state, {pausePlaying: false});
    assert.deepEqual(state.state.get(PAUSED_MEDIA_STATE)[2], [':1.44']);
    assert.equal(state.calls.filter(call => ['ListNames', 'Pause'].includes(call.method)).length, 0);
    await close(state);
    assert.equal(state.calls.filter(call => call.method === 'Play').length, 1);
    assert.equal(state.calls.find(call => call.method === 'Play').destination, ':1.44');
});

test('bus restart discards old unique IDs rather than restoring an unrelated player', async () => {
    const state = await runtime({players: [{name: 'org.mpris.MediaPlayer2.new', owner: ':1.44', status: 'Paused'}],
        saved: ['previous-bus', 'dead-epoch', [':1.44']]});
    await pause(state, {pausePlaying: false});
    await close(state);
    assert.equal(state.calls.filter(call => call.method !== 'GetId').length, 0);
    assert.equal(state.state.has(PAUSED_MEDIA_STATE), false);
});

test('failed bus verification leaves the claimed crash intent available for a later recovery', async () => {
    const state = await runtime({saved: ['original-bus', 'dead-epoch', [':1.44']]});
    state.faults.set('GetId', 'asynchronous');
    await pause(state, {pausePlaying: false});
    await close(state);
    assert.deepEqual(state.state.get(PAUSED_MEDIA_STATE), ['original-bus', 'epoch-1', [':1.44']]);
    assert.equal(state.calls.filter(call => call.method === 'Play').length, 0);
});

test('relocking during a restoration query adopts intent and prevents the old Play or state cleanup', async () => {
    const state = await runtime();
    await pause(state);
    state.cancellable.cancel();
    const oldClose = state.media.close();
    const oldQuery = state.calls.at(-1);
    const newCancellable = new Cancellable();
    const newMedia = new state.PausedMedia(newCancellable, state.ownership);
    state.state.set(LOCKED_STATE, true);
    assert.deepEqual(state.state.get(PAUSED_MEDIA_STATE), ['original-bus', 'epoch-2', [':1.44']]);
    await reply(state, oldQuery, [new state.Variant('s', 'Paused')]);
    await oldClose;
    assert.equal(state.calls.filter(call => call.method === 'Play').length, 0);
    const newPause = newMedia.pause({pausePlaying: false});
    await drain(state);
    await newPause;
    state.state.delete(LOCKED_STATE);
    newCancellable.cancel();
    const restored = newMedia.close();
    await drain(state);
    await restored;
    assert.equal(state.calls.filter(call => call.method === 'Play').length, 1);
    assert.equal(state.state.has(PAUSED_MEDIA_STATE), false);
    assert.equal(state.signals.size, 0);
});

test('a Play queued before relocking receives a compensating Pause after completion', async () => {
    const state = await runtime();
    await pause(state);
    state.cancellable.cancel();
    const oldClose = state.media.close();
    await reply(state, state.calls.at(-1), [new state.Variant('s', 'Paused')]);
    const oldPlay = state.calls.at(-1);
    assert.equal(oldPlay.method, 'Play');
    const newCancellable = new Cancellable();
    const newMedia = new state.PausedMedia(newCancellable, state.ownership);
    state.state.set(LOCKED_STATE, true);
    const newPause = newMedia.pause({pausePlaying: false});
    await drain(state, {stopAt: 'Play'});
    const oldPlayIndex = state.calls.indexOf(oldPlay);
    for (const call of state.calls.slice(oldPlayIndex + 1)) {
        if (call.method === 'GetId')
            await reply(state, call, ['original-bus']);
    }
    const inheritedQuery = state.calls.find(call => !call.settled && call !== oldPlay);
    await reply(state, inheritedQuery, [new state.Variant('s', 'Paused')]);
    await newPause;
    state.players[0].status = 'Playing';
    state.signal(':1.44', 'Playing');
    assert.deepEqual(state.state.get(PAUSED_MEDIA_STATE)[2], []);
    await reply(state, oldPlay, []);
    assert.equal(state.calls.at(-1).method, 'Pause');
    await drain(state);
    await oldClose;
    assert.equal(state.players[0].status, 'Paused');
    assert.equal(state.state.get(PAUSED_MEDIA_STATE)[1], 'epoch-2');
    assert.deepEqual(state.state.get(PAUSED_MEDIA_STATE)[2], [':1.44']);
    state.state.delete(LOCKED_STATE);
    newCancellable.cancel();
    const restored = newMedia.close();
    await drain(state);
    await restored;
    assert.equal(state.calls.filter(call => call.method === 'Play').length, 2);
    assert.equal(state.signals.size, 0);
});

test('restoration under a retained locked marker waits for a future recovery rather than exposing media', async () => {
    const state = await runtime();
    await pause(state);
    state.state.set(LOCKED_STATE, true);
    await close(state);
    assert.equal(state.calls.filter(call => call.method === 'Play').length, 0);
    assert.deepEqual(state.state.get(PAUSED_MEDIA_STATE)[2], [':1.44']);
});

test('unavailable and restarted players cannot stop successful owners from restoring', async () => {
    const state = await runtime({players: [
        {name: 'org.mpris.MediaPlayer2.first', owner: ':1.44', status: 'Playing'},
        {name: 'org.mpris.MediaPlayer2.second', owner: ':1.55', status: 'Playing'},
    ]});
    await pause(state);
    state.players[0].owner = ':1.99';
    await close(state);
    assert.equal(state.calls.filter(call => call.method === 'Play').length, 1);
    assert.equal(state.calls.find(call => call.method === 'Play').destination, ':1.55');
    assert.equal(state.warnings.length, 1);
});

test('synchronous and asynchronous resume failures release signals and intent without retrying', async t => {
    for (const failure of ['synchronous', 'asynchronous']) {
        await t.test(failure, async () => {
            const state = await runtime();
            await pause(state);
            state.faults.set('Play', failure);
            await close(state);
            assert.equal(state.warnings.length, 1);
            assert.match(state.warnings[0], /media resume failed for :1.44/);
            assert.equal(state.state.has(PAUSED_MEDIA_STATE), false);
            assert.equal(state.signals.size, 0);
        });
    }
});

test('restoration uses the captured bus even if the session getter becomes unavailable', async () => {
    const state = await runtime();
    await pause(state);
    Object.defineProperty(state.DBus, 'session', {get: () => assert.fail('must retain the original connection')});
    await close(state);
    assert.equal(state.calls.filter(call => call.method === 'Play').length, 1);
});

test('unused, disabled-media and already-cancelled components never acquire a bus', async t => {
    for (const action of ['unused', 'disabled', 'cancelled']) {
        await t.test(action, async () => {
            const state = await runtime();
            Object.defineProperty(state.DBus, 'session', {get: () => assert.fail('must not acquire an unused bus')});
            if (action === 'cancelled')
                state.cancellable.cancel();
            if (action !== 'unused')
                await state.media.pause({pausePlaying: action !== 'disabled'});
            await close(state);
            assert.equal(state.calls.length, 0);
            assert.equal(state.warnings.length, 0);
        });
    }
});

test('failed synchronous bus acquisition remains optional and leaves no subscriptions', async () => {
    const state = await runtime();
    Object.defineProperty(state.DBus, 'session', {get: () => { throw new Error('bus unavailable'); }});
    await pause(state);
    await close(state);
    assert.equal(state.calls.length, 0);
    assert.equal(state.signals.size, 0);
    assert.equal(state.warnings.length, 1);
});

test('discovery and persistent owner lists are bounded and reject arbitrary destinations', async () => {
    const players = Array.from({length: 200}, (_unused, index) => ({
        name: 'org.mpris.MediaPlayer2.player' + index, owner: ':1.' + index, status: 'Playing',
    }));
    const state = await runtime({players});
    await pause(state);
    assert.equal(state.calls.filter(call => call.method === 'GetNameOwner').length, 128);
    assert.equal(state.state.get(PAUSED_MEDIA_STATE)[2].length, 32);
    await close(state);
    assert.equal(state.calls.filter(call => call.method === 'Play').length, 32);
    const malformed = await runtime({saved: ['original-bus', 'dead', ['org.example.Other', '../player', ':1.44']]});
    assert.deepEqual(malformed.state.get(PAUSED_MEDIA_STATE)[2], [':1.44']);
    await close(malformed, {resume: false});
});
