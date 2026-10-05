import assert from 'node:assert/strict';
import {join} from 'node:path';
import test from 'node:test';

import {loadModule} from './harness.js';

async function createAuthenticationFixture(t, {spawnError = null, finishOnKill = true, cancelOnConnect = false} = {}) {
    let now = 100000;
    let nextId = 1;
    const timers = new Map();
    const processes = [];
    const warnings = [];
    const handlers = new Map();
    const cancellable = {
        cancelled: false,
        is_cancelled() {
            return this.cancelled;
        },
        connect(callback) {
            if (cancelOnConnect)
                this.cancelled = true;
            if (this.cancelled) {
                callback();
                return 0;
            }
            const id = nextId++;
            handlers.set(id, callback);
            return id;
        },
        disconnect(id) {
            assert.equal(handlers.delete(id), true);
        },
        cancel() {
            this.cancelled = true;
            for (const callback of handlers.values())
                callback();
        },
    };

    const Gio = {
        SubprocessFlags: {STDIN_PIPE: 1, STDOUT_SILENCE: 2, STDERR_SILENCE: 4},
        Subprocess: {
            new(argv, flags) {
                if (spawnError)
                    throw spawnError;
                const process = {
                    argv: [...argv],
                    flags,
                    killed: 0,
                    completed: false,
                    communicate_utf8_async(password, token, callback) {
                        this.password = password;
                        this.token = token;
                        this.callback = callback;
                    },
                    communicate_utf8_finish(result) {
                        if (this.token.is_cancelled())
                            throw new Error('Cancelled');
                        if (result.error)
                            throw result.error;
                        return [result.communicated, null, null];
                    },
                    get_if_exited() {
                        assert.equal(this.completed, true);
                        return this.exit !== 137;
                    },
                    get_exit_status() {
                        assert.equal(this.completed, true);
                        return this.exit;
                    },
                    force_exit() {
                        this.killed++;
                        if (finishOnKill && this.callback)
                            this.finish(137);
                    },
                    finish(exit, {communicated = true, error = null} = {}) {
                        if (this.completed)
                            return;
                        this.completed = true;
                        this.exit = exit;
                        queueMicrotask(() => this.callback(this, {communicated, error}));
                    },
                };
                processes.push(process);
                return process;
            },
        },
    };
    const GLib = {
        PRIORITY_DEFAULT: 0,
        SOURCE_REMOVE: false,
        build_filenamev: parts => join(...parts),
        get_monotonic_time: () => now * 1000,
        timeout_add(_priority, milliseconds, callback) {
            const id = nextId++;
            timers.set(id, {at: now + milliseconds, callback});
            return id;
        },
        source_remove(id) {
            assert.equal(timers.delete(id), true);
        },
    };
    t.after(() => {
        assert.equal(timers.size, 0, 'authentication left a timeout behind');
        assert.equal(handlers.size, 0, 'authentication left a cancellation handler behind');
    });

    const {Authentication} = await loadModule('authentication.js', {
        'gi://Gio': {default: Gio},
        'gi://GLib': {default: GLib},
    }, {TextEncoder, console: {warn: message => warnings.push(message)}});

    return {
        authentication: new Authentication('/extension/path', cancellable),
        cancellable,
        processes,
        warnings,
        now: () => now,
        advance(milliseconds) {
            const target = now + milliseconds;
            for (;;) {
                const next = [...timers].filter(([_id, timer]) => timer.at <= target)
                    .sort(([_leftId, left], [_rightId, right]) => left.at - right.at)[0];
                if (!next)
                    break;
                const [id, timer] = next;
                now = timer.at;
                timers.delete(id);
                assert.equal(timer.callback(), false);
            }
            now = target;
        },
    };
}

test('successful helper uses the pinned interpreter and private stdin, then releases resources', async t => {
    const {authentication, cancellable, processes} = await createAuthenticationFixture(t);
    const password = ' 日本語🔒 with spaces ';
    const attempt = authentication.verify(password);
    assert.equal(authentication.busy, true);
    assert.equal(processes.length, 1);
    assert.deepEqual(processes[0].argv, ['/usr/bin/python3', '-I', '-B', '/extension/path/authentication.py']);
    assert.equal(processes[0].flags, 7);
    assert.equal(processes[0].password, password);
    assert.equal(processes[0].token, cancellable);

    processes[0].finish(0);
    assert.equal(await attempt, 'granted');
    assert.equal(authentication.busy, false);
    assert.equal(authentication.retryUntil, 0);
});

test('one in-flight helper owns the attempt despite repeated submissions', async t => {
    const {authentication, processes} = await createAuthenticationFixture(t);
    const first = authentication.verify('first');
    assert.equal(await authentication.verify('second'), 'error');
    assert.equal(await authentication.verify('third'), 'error');
    assert.equal(processes.length, 1);
    assert.equal(authentication.busy, true);
    processes[0].finish(0);
    assert.equal(await first, 'granted');
});

test('nonzero and signal-style exits reject authentication', async t => {
    for (const exit of [1, 2, 7, 137]) {
        await t.test(`exit ${exit}`, async child => {
            const {authentication, processes, now} = await createAuthenticationFixture(child);
            const attempt = authentication.verify('incorrect');
            processes[0].finish(exit);
            assert.equal(await attempt, exit === 1 ? 'denied' : 'error');
            assert.equal(authentication.busy, false);
            assert.equal(authentication.retryUntil, now() + 1000);
            assert.equal((await authentication.verify('too soon')), 'error');
        });
    }
});

test('exact UTF-8 byte limit is passed intact while oversized input never spawns', async t => {
    const {authentication, processes} = await createAuthenticationFixture(t);
    for (const password of ['x'.repeat(512), '🔐'.repeat(128)]) {
        const attempt = authentication.verify(password);
        assert.equal(processes.at(-1).password, password);
        processes.at(-1).finish(0);
        assert.equal(await attempt, 'granted');
    }
    for (const password of ['x'.repeat(513), '🔐'.repeat(129)])
        assert.equal(await authentication.verify(password), 'error');
    assert.equal(processes.length, 2);
    assert.equal(authentication.retryUntil, 0);
});

test('infrastructure diagnostics never contain passwords and denial is quiet', async t => {
    const {authentication, processes, warnings, advance, now} = await createAuthenticationFixture(t);
    for (const exit of [1, 2, 137]) {
        const attempt = authentication.verify('PRIVATE-PASSWORD');
        processes.at(-1).finish(exit);
        assert.equal(await attempt, exit === 1 ? 'denied' : 'error');
        advance(authentication.retryUntil - now());
    }
    assert.equal(warnings.length, 2);
    assert.ok(warnings.every(message => !message.includes('PRIVATE-PASSWORD')));
});

test('communication failures reject even when the process exit says success', async t => {
    for (const completion of [{communicated: false}, {error: new Error('IO failure')}]) {
        await t.test(JSON.stringify(completion), async child => {
            const {authentication, processes} = await createAuthenticationFixture(child);
            const attempt = authentication.verify('test');
            processes[0].finish(0, completion);
            assert.equal(await attempt, 'error');
            assert.equal(authentication.busy, false);
        });
    }
});

test('failed helper startup fails closed and enforces the first retry delay', async t => {
    const {authentication, processes, now} = await createAuthenticationFixture(t, {spawnError: new Error('Interpreter unavailable')});
    assert.equal(await authentication.verify('test'), 'error');
    assert.equal(authentication.busy, false);
    assert.equal(authentication.retryUntil, now() + 1000);
    assert.equal(processes.length, 0);
});

test('failure delays double to thirty seconds and success resets the delay', async t => {
    const fixture = await createAuthenticationFixture(t);
    const {authentication, processes, now, advance} = fixture;
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
        const attempt = authentication.verify('wrong');
        processes.at(-1).finish(1);
        assert.equal(await attempt, 'denied');
        assert.equal(authentication.retryUntil, now() + delay);
        const processCount = processes.length;
        advance(delay - 1);
        assert.equal(await authentication.verify('too soon'), 'error');
        assert.equal(processes.length, processCount);
        advance(1);
    }
    const accepted = authentication.verify('correct');
    processes.at(-1).finish(0);
    assert.equal(await accepted, 'granted');
    assert.equal(authentication.retryUntil, 0);
    const nextFailure = authentication.verify('wrong again');
    processes.at(-1).finish(1);
    assert.equal(await nextFailure, 'denied');
    assert.equal(authentication.retryUntil, now() + 1000);
});

test('ten-second timeout kills the helper and rejects its result', async t => {
    const {authentication, processes, advance} = await createAuthenticationFixture(t);
    const attempt = authentication.verify('test');
    advance(9999);
    assert.equal(authentication.busy, true);
    assert.equal(processes[0].killed, 0);
    advance(1);
    assert.equal(processes[0].killed, 1);
    assert.equal(await attempt, 'error');
    assert.equal(authentication.busy, false);
});

test('late success after timeout is rejected while the old attempt remains in flight', async t => {
    const {authentication, processes, advance} = await createAuthenticationFixture(t, {finishOnKill: false});
    const attempt = authentication.verify('test');
    advance(10000);
    assert.equal(authentication.busy, true);
    assert.equal(await authentication.verify('replacement'), 'error');
    assert.equal(processes.length, 1);
    processes[0].finish(0);
    assert.equal(await attempt, 'error');
    assert.equal(authentication.busy, false);
});

test('session cancellation kills pending authentication and makes every later attempt reject', async t => {
    const {authentication, cancellable, processes} = await createAuthenticationFixture(t);
    const attempt = authentication.verify('test');
    cancellable.cancel();
    assert.ok(processes[0].killed >= 1);
    assert.equal(await attempt, 'error');
    assert.equal(authentication.busy, false);
    assert.equal(authentication.retryUntil, 0);
    assert.equal(await authentication.verify('later'), 'error');
    assert.equal(processes.length, 1);
});

test('a success callback queued before cancellation cannot authenticate afterward', async t => {
    const {authentication, cancellable, processes} = await createAuthenticationFixture(t);
    const attempt = authentication.verify('test');
    processes[0].finish(0);
    cancellable.cancel();
    assert.equal(await attempt, 'error');
    assert.equal(authentication.busy, false);
});

test('already-cancelled and cancellation-during-registration sessions cannot leave a helper alive', async t => {
    const already = await createAuthenticationFixture(t);
    already.cancellable.cancel();
    assert.equal(await already.authentication.verify('test'), 'error');
    assert.equal(already.processes.length, 0);

    const duringConnect = await createAuthenticationFixture(t, {cancelOnConnect: true});
    assert.equal(await duringConnect.authentication.verify('test'), 'error');
    assert.equal(duringConnect.authentication.busy, false);
    assert.equal(duringConnect.processes.length, 1);
    assert.ok(duringConnect.processes[0].killed >= 1);
});

test('malformed or empty passwords never start a helper or consume a retry attempt', async t => {
    const {authentication, processes} = await createAuthenticationFixture(t);
    for (const password of [undefined, null, 10, '', 'secret\n', 'secret\r', 'secret\0tail', '\ud800', 'x'.repeat(513), '🔐'.repeat(129)])
        assert.equal(await authentication.verify(password), 'error');
    assert.equal(processes.length, 0);
    assert.equal(authentication.retryUntil, 0);
    assert.equal(authentication.busy, false);
});
