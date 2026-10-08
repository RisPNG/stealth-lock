import assert from 'node:assert/strict';
import test from 'node:test';

import {Cancellable, loadModule} from './harness.js';

async function createScreenshotFixture(t, {startupError = null} = {}) {
    const cancellable = new Cancellable();
    const timers = new Map();
    const captures = [];
    let nextId = 1;
    const Gio = {
        io_error_quark: () => 1,
        IOErrorEnum: {CANCELLED: 2, TIMED_OUT: 3},
    };
    const GLib = {
        PRIORITY_DEFAULT: 0,
        SOURCE_REMOVE: false,
        Error: class extends Error {
            constructor(domain, code, message) {
                super(message);
                this.domain = domain;
                this.code = code;
            }
        },
        timeout_add(_priority, delay, callback) {
            const id = nextId++;
            timers.set(id, {delay, callback});
            return id;
        },
        Source: {
            remove(id) {
                assert.equal(timers.delete(id), true);
            },
        },
    };
    const Shell = {
        Screenshot: class {
            constructor() {
                if (startupError)
                    throw startupError;
                this.finished = 0;
                captures.push(this);
            }

            screenshot_stage_to_content(callback) {
                this.callback = callback;
            }

            screenshot_stage_to_content_finish(result) {
                this.finished++;
                if (result.error)
                    throw result.error;
                return [result.content, result.scale];
            }

            finish(result) {
                this.callback(this, result);
            }
        },
    };
    t.after(() => {
        assert.equal(timers.size, 0, 'capture left a timeout behind');
        assert.equal(cancellable.handlers.size, 0, 'capture left a cancellation handler behind');
    });
    const {captureScreenshot} = await loadModule('shell/screenshot.js', {
        'gi://Gio': {default: Gio},
        'gi://GLib': {default: GLib},
        'gi://Shell': {default: Shell},
    });
    return {captureScreenshot, cancellable, captures, timers, Gio};
}

test('capture returns native in-memory content and removes its temporary resources', async t => {
    const {captureScreenshot, cancellable, captures, timers} = await createScreenshotFixture(t);
    const pending = captureScreenshot(cancellable);
    assert.equal(captures.length, 1);
    assert.equal(timers.size, 1);
    const content = {};
    captures[0].finish({content, scale: 2});
    const result = await pending;
    assert.equal(result.content, content);
    assert.equal(result.scale, 2);
    assert.equal(captures[0].finished, 1);
});

test('a cancelled session rejects capture and consumes its late native callback', async t => {
    const {captureScreenshot, cancellable, captures, Gio} = await createScreenshotFixture(t);
    const pending = captureScreenshot(cancellable);
    cancellable.cancel();
    await assert.rejects(pending, error => error.code === Gio.IOErrorEnum.CANCELLED);
    captures[0].finish({content: {}, scale: 1});
    assert.equal(captures[0].finished, 1);
});

test('capture times out after three seconds and cannot be fulfilled by a late screenshot', async t => {
    const {captureScreenshot, cancellable, captures, timers, Gio} = await createScreenshotFixture(t);
    const pending = captureScreenshot(cancellable);
    const [id, timeout] = [...timers][0];
    assert.equal(timeout.delay, 3000);
    timers.delete(id);
    assert.equal(timeout.callback(), false);
    await assert.rejects(pending, error => error.code === Gio.IOErrorEnum.TIMED_OUT);
    captures[0].finish({content: {}, scale: 1});
    assert.equal(captures[0].finished, 1);
});

test('already-cancelled sessions never start screenshot capture', async t => {
    const {captureScreenshot, cancellable, captures} = await createScreenshotFixture(t);
    cancellable.cancel();
    await assert.rejects(captureScreenshot(cancellable), /cancelled/);
    assert.equal(captures.length, 0);
});

test('native setup and finish failures release capture resources', async t => {
    const startup = new Error('No screenshot service');
    const failedStartup = await createScreenshotFixture(t, {startupError: startup});
    await assert.rejects(failedStartup.captureScreenshot(failedStartup.cancellable), error => error === startup);

    const fixture = await createScreenshotFixture(t);
    const completion = new Error('Capture failed');
    const pending = fixture.captureScreenshot(fixture.cancellable);
    fixture.captures[0].finish({error: completion});
    await assert.rejects(pending, error => error === completion);
});
