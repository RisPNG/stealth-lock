import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {exit} from 'system';

import {Authentication} from '../shell/authentication.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function equal(actual, expected) {
    assert(Object.is(actual, expected), `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function waitUntil(condition, milliseconds = 3000) {
    const deadline = GLib.get_monotonic_time() + milliseconds * 1000;
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10, () => {
            const value = condition();
            if (!value && GLib.get_monotonic_time() < deadline)
                return GLib.SOURCE_CONTINUE;
            resolve(value);
            return GLib.SOURCE_REMOVE;
        });
    });
}

function readPid(file) {
    try {
        const [, bytes] = file.load_contents(null);
        return Number(new TextDecoder().decode(bytes));
    } catch {
        return 0;
    }
}

function processGone(pid) {
    try {
        const [, bytes] = Gio.File.new_for_path(`/proc/${pid}/stat`).load_contents(null);
        const stat = new TextDecoder().decode(bytes);
        return stat[stat.lastIndexOf(')') + 2] === 'Z';
    } catch {
        return true;
    }
}

const directory = Gio.File.new_for_path(GLib.dir_make_tmp('stealth-lock-auth-test-XXXXXX'));
const helpers = directory.get_child('helpers');
let total = 0;
let failed = 0;
try {
    helpers.make_directory(null);
    const fixture = Gio.File.new_for_uri(import.meta.url).get_parent().get_child('auth').get_child('fake_authentication.py');
    const [, fixtureBytes] = fixture.load_contents(null);
    assert(new TextDecoder().decode(fixtureBytes).includes('FAKE_AUTHENTICATION_ONLY'), 'Refusing a non-fixture authentication helper');
    fixture.copy(helpers.get_child('authentication.py'), Gio.FileCopyFlags.NONE, null, null);

    const tests = {
        async 'native stdin transport preserves Unicode and isolated interpreter flags'() {
            for (const password of ['correct', 'café 🔒', 'isolated', 'x'.repeat(512), '🔒'.repeat(128)]) {
                const authentication = new Authentication(directory.get_path(), new Gio.Cancellable());
                equal(await authentication.verify(password), 'granted');
                equal(authentication.busy, false);
                equal(authentication.retryUntil, 0);
            }
        },

        async 'helper denial is distinct from errors and signal termination'() {
            for (const [password, expected] of [['wrong', 'denied'], ['crash', 'error'], ['kill', 'error']]) {
                const authentication = new Authentication(directory.get_path(), new Gio.Cancellable());
                equal(await authentication.verify(password), expected);
                equal(authentication.busy, false);
                assert(authentication.retryUntil > GLib.get_monotonic_time() / 1000, 'Failure did not impose backoff');
            }
        },

        async 'missing fixed helper fails closed'() {
            const authentication = new Authentication(directory.get_child('missing').get_path(), new Gio.Cancellable());
            equal(await authentication.verify('correct'), 'error');
            equal(authentication.busy, false);
        },

        async 'malformed and oversized input never starts a process or consumes backoff'() {
            const authentication = new Authentication(directory.get_child('missing').get_path(), new Gio.Cancellable());
            for (const password of ['', 'secret\n', 'secret\r', 'secret\0tail', '\ud800', 'x'.repeat(513), '🔒'.repeat(129)])
                equal(await authentication.verify(password), 'error');
            equal(authentication.busy, false);
            equal(authentication.retryUntil, 0);
        },

        async 'native backoff blocks early admission and success resets it'() {
            const authentication = new Authentication(directory.get_path(), new Gio.Cancellable());
            equal(await authentication.verify('wrong'), 'denied');
            const retry = authentication.retryUntil;
            equal(await authentication.verify('correct'), 'error');
            equal(authentication.retryUntil, retry);
            assert(await waitUntil(() => GLib.get_monotonic_time() / 1000 >= retry), 'Backoff did not expire');
            equal(await authentication.verify('correct'), 'granted');
            equal(authentication.retryUntil, 0);
            equal(await authentication.verify('wrong'), 'denied');
            assert(authentication.retryUntil - GLib.get_monotonic_time() / 1000 <= 1000, 'Success did not reset consecutive failures');
        },

        async 'native cancellation kills the owned helper and concurrent admission cannot replace it'() {
            const pidFile = directory.get_child('cancel.pid');
            const cancellable = new Gio.Cancellable();
            const authentication = new Authentication(directory.get_path(), cancellable);
            const password = `sleep:${pidFile.get_path()}`;
            const pending = authentication.verify(password);
            try {
                assert(await waitUntil(() => readPid(pidFile)), 'Fixture helper did not start');
                const pid = readPid(pidFile);
                const [, commandBytes] = Gio.File.new_for_path(`/proc/${pid}/cmdline`).load_contents(null);
                assert(!new TextDecoder().decode(commandBytes).includes(password), 'Password was included in argv');
                equal(await authentication.verify('correct'), 'error');
                equal(authentication.busy, true);
                cancellable.cancel();
                equal(await pending, 'error');
                equal(authentication.busy, false);
                equal(authentication.retryUntil, 0);
                assert(await waitUntil(() => processGone(pid)), 'Helper survived cancellation');
                equal(await authentication.verify('correct'), 'error');
            } finally {
                cancellable.cancel();
                await pending;
            }
        },

        async 'cancelled session never starts authentication'() {
            const cancellable = new Gio.Cancellable();
            cancellable.cancel();
            const authentication = new Authentication(directory.get_path(), cancellable);
            equal(await authentication.verify('correct'), 'error');
            equal(authentication.busy, false);
            equal(authentication.retryUntil, 0);
        },

        async 'cancellation at native completion cannot grant'() {
            const cancellable = new Gio.Cancellable();
            const communicate = Gio.Subprocess.prototype.communicate_utf8_async;
            Gio.Subprocess.prototype.communicate_utf8_async = function (password, token, callback) {
                communicate.call(this, password, token, (source, result) => {
                    cancellable.cancel();
                    callback(source, result);
                });
            };
            try {
                const authentication = new Authentication(directory.get_path(), cancellable);
                equal(await authentication.verify('correct'), 'error');
                equal(authentication.retryUntil, 0);
            } finally {
                Gio.Subprocess.prototype.communicate_utf8_async = communicate;
            }
        },

        async 'production ten-second deadline kills a sleeping native helper'() {
            const pidFile = directory.get_child('timeout.pid');
            const cancellable = new Gio.Cancellable();
            const authentication = new Authentication(directory.get_path(), cancellable);
            const started = GLib.get_monotonic_time();
            const pending = authentication.verify(`sleep:${pidFile.get_path()}`);
            try {
                assert(await waitUntil(() => readPid(pidFile)), 'Fixture helper did not start');
                const pid = readPid(pidFile);
                equal(await pending, 'error');
                const elapsed = (GLib.get_monotonic_time() - started) / 1000;
                assert(elapsed >= 9900 && elapsed < 15000, `Expected 10-second deadline, took ${elapsed} ms`);
                equal(authentication.busy, false);
                assert(await waitUntil(() => processGone(pid)), 'Helper survived authentication deadline');
            } finally {
                cancellable.cancel();
                await pending;
            }
        },
    };

    for (const [title, run] of Object.entries(tests)) {
        total++;
        try {
            await run();
            console.log(`ok ${total} - ${title}`);
        } catch (error) {
            failed++;
            console.error(`not ok ${total} - ${title}: ${error.message}\n${error.stack}`);
        }
    }
    assert(!helpers.get_child('__pycache__').query_exists(null), 'Isolated helper wrote bytecode');
} finally {
    const files = directory.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    try {
        for (let info = files.next_file(null); info; info = files.next_file(null)) {
            const file = directory.get_child(info.get_name());
            if (info.get_name() === 'helpers') {
                const helperFiles = file.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
                try {
                    for (let helperInfo = helperFiles.next_file(null); helperInfo; helperInfo = helperFiles.next_file(null))
                        file.get_child(helperInfo.get_name()).delete(null);
                } finally {
                    helperFiles.close(null);
                }
            }
            file.delete(null);
        }
    } finally {
        files.close(null);
        directory.delete(null);
    }
}
console.log(`1..${total} (${failed} failed)`);
exit(failed || !total ? 1 : 0);
