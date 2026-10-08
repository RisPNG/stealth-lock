import assert from 'node:assert/strict';
import test from 'node:test';

import {Cancellable, loadModule} from './harness.js';

async function runtime() {
    const calls = [];
    const warnings = [];
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
    const DBus = {session: bus};
    const {PausedMedia} = await loadModule('shell/media.js', {
        'gi://Gio': {default: {DBus, DBusCallFlags: flags}},
        'gi://GLib': {default: {Variant, VariantType: class { constructor(type) { this.type = type; } }}},
    }, {
        console: {warn: message => warnings.push(message), error: message => warnings.push(message)},
    });
    const cancellable = new Cancellable();
    const media = new PausedMedia(cancellable);
    return {media, cancellable, calls, warnings, flags, Variant, bus, DBus};
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
    const task = runtime.media.pause();
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
    for (const call of state.calls) {
        assert.equal(call.timeout, 2000);
        assert.equal(call.cancellable, state.cancellable);
    }
    state.cancellable.cancel();
    state.media.close();
    const play = state.calls.at(-1);
    assert.equal(play.method, 'Play');
    assert.equal(play.destination, ':1.44');
    assert.equal(play.path, '/org/mpris/MediaPlayer2');
    assert.equal(play.iface, 'org.mpris.MediaPlayer2.Player');
    assert.equal(play.flags, state.flags.NO_AUTO_START);
    assert.equal(play.cancellable, null);
    assert.equal(play.timeout, 2000);
    assert.equal(typeof play.callback, 'function');
    await reply(play, []);
    assert.equal(state.warnings.length, 0);
    state.media.close();
    assert.equal(state.calls.filter(call => call.method === 'Play').length, 1);
});

test('paused and stopped players remain unchanged', async t => {
    for (const status of ['Paused', 'Stopped']) {
        await t.test(status, async () => {
            const state = await runtime();
            const task = state.media.pause();
            await reply(state.calls.at(-1), [['org.mpris.MediaPlayer2.player']]);
            await reply(state.calls.at(-1), [':1.44']);
            await reply(state.calls.at(-1), [new state.Variant('s', status)]);
            await task;
            state.cancellable.cancel();
            state.media.close();
            assert.deepEqual(state.calls.map(call => call.method), ['ListNames', 'GetNameOwner', 'Get']);
        });
    }
});

test('failed discovery, owner, status, and Pause never resume an unsuccessful player', async t => {
    for (const failure of ['ListNames', 'GetNameOwner', 'Get', 'Pause']) {
        await t.test(failure, async () => {
            const state = await runtime();
            const task = state.media.pause();
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
            state.cancellable.cancel();
            state.media.close();
            assert.equal(state.calls.filter(call => call.method === 'Play').length, 0);
            assert.equal(state.warnings.length, 1);
        });
    }
});

test('closing at every DBus await rejects late replies and cannot acquire new restoration', async t => {
    for (const cancellation of ['ListNames', 'GetNameOwner', 'Get', 'Pause']) {
        await t.test(cancellation, async () => {
            const state = await runtime();
            const task = state.media.pause();
            for (const method of ['ListNames', 'GetNameOwner', 'Get', 'Pause']) {
                const call = state.calls.at(-1);
                assert.equal(call.method, method);
                const value = method === 'ListNames' ? [['org.mpris.MediaPlayer2.player']]
                    : method === 'GetNameOwner' ? [':1.44']
                        : method === 'Get' ? [new state.Variant('s', 'Playing')] : [];
                if (method === cancellation) {
                    state.cancellable.cancel();
                    state.media.close();
                    const countAfterClose = state.calls.length;
                    await reply(call, value);
                    await task;
                    assert.equal(state.calls.length, countAfterClose);
                    break;
                }
                await reply(call, value);
            }
            state.media.close();
            assert.equal(state.warnings.length, 0);
            assert.equal(state.calls.filter(call => call.method === 'Play').length, cancellation === 'Pause' ? 1 : 0);
        });
    }
});

test('native lock keeps in-flight Pause compensation until native unlock', async () => {
    const state = await runtime();
    const {task, pause} = await playingPlayer(state);
    state.cancellable.cancel();
    assert.equal(state.calls.filter(call => call.method === 'Play').length, 0);
    await reply(pause, undefined, new Error('cancelled after remote Pause'));
    await task;
    state.media.close();
    assert.equal(state.calls.at(-1).method, 'Play');
    assert.equal(state.calls.at(-1).destination, ':1.44');
    state.media.close();
    assert.equal(state.calls.filter(call => call.method === 'Play').length, 1);
    assert.equal(state.warnings.length, 0);
});

test('disable skips media compensation even when Pause completed remotely', async () => {
    const state = await runtime();
    const {task, pause} = await playingPlayer(state);
    state.cancellable.cancel();
    state.media.close({resume: false});
    await reply(pause, []);
    await task;
    assert.equal(state.calls.filter(call => call.method === 'Play').length, 0);
    state.media.close();
    assert.equal(state.calls.filter(call => call.method === 'Play').length, 0);
});

test('a failing player does not prevent other players being paused and restored', async () => {
    const state = await runtime();
    const task = state.media.pause();
    await reply(state.calls.at(-1), [['org.mpris.MediaPlayer2.failed', 'org.mpris.MediaPlayer2.playing']]);
    const owners = state.calls.filter(call => call.method === 'GetNameOwner');
    await reply(owners[0], undefined, new Error('owner vanished'));
    await reply(owners[1], [':1.88']);
    await reply(state.calls.at(-1), [new state.Variant('s', 'Playing')]);
    await reply(state.calls.at(-1), []);
    await task;
    state.cancellable.cancel();
    state.media.close();
    const plays = state.calls.filter(call => call.method === 'Play');
    assert.equal(plays.length, 1);
    assert.equal(plays[0].destination, ':1.88');
    assert.equal(state.warnings.length, 1);
});

test('MPRIS aliases sharing one unique owner pause and restore the player exactly once', async () => {
    const state = await runtime();
    const task = state.media.pause();
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
    state.cancellable.cancel();
    state.media.close();
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
    state.cancellable.cancel();
    state.media.close();
    await reply(state.calls.at(-1), undefined, new Error('owner vanished'));
    assert.equal(state.warnings.length, 1);
    assert.match(state.warnings[0], /media resume failed for :1.44: owner vanished/);
    state.media.close();
    assert.equal(state.calls.filter(call => call.method === 'Play').length, 1);
});

test('pause discovers once across simultaneous and repeated calls', async () => {
    const state = await runtime();
    const task = state.media.pause();
    await state.media.pause();
    assert.equal(state.calls.length, 1);
    await reply(state.calls[0], [[]]);
    await task;
    await state.media.pause();
    assert.deepEqual(state.calls.map(call => call.method), ['ListNames']);
    state.cancellable.cancel();
    state.media.close();
    await state.media.pause();
    assert.equal(state.calls.length, 1);
});

test('a cancelled or already closed component cannot begin discovery', async t => {
    await t.test('cancelled session', async () => {
        const state = await runtime();
        state.cancellable.cancel();
        await state.media.pause();
        state.media.close();
        assert.equal(state.calls.length, 0);
        assert.equal(state.warnings.length, 0);
    });
    await t.test('closed component leaves token ownership with session', async () => {
        const state = await runtime();
        state.media.close();
        assert.equal(state.cancellable.is_cancelled(), false);
        await state.media.pause();
        state.media.close();
        assert.equal(state.calls.length, 0);
        assert.equal(state.warnings.length, 0);
    });
});

test('cancellation while players progress independently cannot add late restoration', async () => {
    const state = await runtime();
    const task = state.media.pause();
    await reply(state.calls[0], [['org.mpris.MediaPlayer2.playing', 'org.mpris.MediaPlayer2.late']]);
    const owners = state.calls.filter(call => call.method === 'GetNameOwner');
    await reply(owners[0], [':1.44']);
    await reply(state.calls.at(-1), [new state.Variant('s', 'Playing')]);
    const pause = state.calls.at(-1);
    state.cancellable.cancel();
    state.media.close();
    const countAfterClose = state.calls.length;
    await reply(owners[1], [':1.88']);
    await reply(pause, []);
    await task;
    assert.equal(state.calls.length, countAfterClose);
    assert.equal(state.calls.filter(call => call.method === 'Get').length, 1);
    assert.equal(state.calls.filter(call => call.method === 'Play').length, 1);
    assert.equal(state.calls.at(-1).destination, ':1.44');
    assert.equal(state.warnings.length, 0);
});

test('synchronous and asynchronous resume failures do not prevent other owners being restored', async () => {
    const state = await runtime();
    const task = state.media.pause();
    await reply(state.calls[0], [[
        'org.mpris.MediaPlayer2.first', 'org.mpris.MediaPlayer2.second', 'org.mpris.MediaPlayer2.third',
    ]]);
    const owners = state.calls.filter(call => call.method === 'GetNameOwner');
    const destinations = [':1.44', ':1.88', ':1.99'];
    for (let index = 0; index < owners.length; index++) {
        await reply(owners[index], [destinations[index]]);
        await reply(state.calls.at(-1), [new state.Variant('s', 'Playing')]);
        await reply(state.calls.at(-1), []);
    }
    await task;
    const attempts = [];
    const call = state.bus.call;
    state.bus.call = (...parameters) => {
        if (parameters[3] === 'Play') {
            attempts.push(parameters[0]);
            if (parameters[0] === ':1.44')
                throw new Error('connection closed');
        }
        call(...parameters);
    };
    state.cancellable.cancel();
    state.media.close();
    assert.deepEqual(attempts, destinations);
    const plays = state.calls.filter(call => call.method === 'Play');
    assert.equal(plays.length, 2);
    await reply(plays[0], undefined, new Error('owner vanished'));
    await reply(plays[1], []);
    assert.equal(state.warnings.length, 2);
    assert.match(state.warnings[0], /media resume failed for :1.44: connection closed/);
    assert.match(state.warnings[1], /media resume failed for :1.88: owner vanished/);
    state.media.close();
    assert.equal(attempts.length, 3);
});

test('closing unused media never reads the synchronous session-bus getter', async () => {
    const state = await runtime();
    Object.defineProperty(state.DBus, 'session', {get: () => assert.fail('unused media must not acquire a bus')});
    state.media.close();
    state.media.close();
    await state.media.pause();
    assert.equal(state.calls.length, 0);
    assert.equal(state.warnings.length, 0);
    assert.equal(state.cancellable.is_cancelled(), false);
});

test('discovery getter failure remains optional and cannot prevent media close', async () => {
    const state = await runtime();
    let reads = 0;
    Object.defineProperty(state.DBus, 'session', {get: () => {
        reads++;
        throw new Error('session bus unavailable');
    }});
    await state.media.pause();
    assert.equal(state.calls.length, 0);
    assert.equal(state.warnings.length, 1);
    assert.match(state.warnings[0], /media unavailable: session bus unavailable/);
    state.cancellable.cancel();
    state.media.close();
    state.media.close();
    assert.equal(reads, 1);
});

test('pre-cancelled discovery never attempts synchronous bus acquisition', async () => {
    const state = await runtime();
    Object.defineProperty(state.DBus, 'session', {get: () => assert.fail('cancelled media must not acquire a bus')});
    state.cancellable.cancel();
    await state.media.pause();
    state.media.close();
    assert.equal(state.calls.length, 0);
    assert.equal(state.warnings.length, 0);
});

test('restoration uses the original connection even if the global session-bus getter changes', async t => {
    for (const replacement of ['different connection', 'unavailable connection']) {
        await t.test(replacement, async () => {
            const state = await runtime();
            const {task, pause} = await playingPlayer(state);
            await reply(pause, []);
            await task;
            let reads = 0;
            Object.defineProperty(state.DBus, 'session', {get: () => {
                reads++;
                if (replacement === 'unavailable connection')
                    throw new Error('bus unavailable');
                return {call: () => assert.fail('unique owner belongs to the original connection')};
            }});
            state.cancellable.cancel();
            state.media.close();
            assert.equal(reads, 0);
            const play = state.calls.at(-1);
            assert.equal(play.method, 'Play');
            assert.equal(play.destination, ':1.44');
            await reply(play, []);
            state.media.close();
            assert.equal(state.calls.filter(call => call.method === 'Play').length, 1);
            assert.equal(state.warnings.length, 0);
        });
    }
});
