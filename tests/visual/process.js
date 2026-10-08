import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import {VisualProcess} from '../../shared/visual-process.js';

const root = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_parent().get_path();
const pending = new Set();
let passed = 0;
let failed = false;

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

async function rejects(worker, request) {
    let failure = null;
    try {
        await worker.request(request);
    } catch (error) {
        failure = error;
    }
    assert(failure, 'Untrusted visual request unexpectedly succeeded');
    assert(worker.closed && worker.deadline === 0 && !worker.busy,
        'Failed visual request did not release its deadline and pending operation');
}

try {
    const check = new VisualProcess(root);
    pending.add(check);
    const validation = await check.request({event: 'check', code: 'while (true) {}'});
    assert(validation.valid === true, 'Syntax check executed the program body');
    assert(check.deadline === 0 && !check.busy, 'Successful syntax check leaked its deadline');
    check.destroy();
    pending.delete(check);
    passed++;

    const renderer = new VisualProcess(root);
    pending.add(renderer);
    const initial = await renderer.request({event: 'init', code: "ctx.state.frames = 0; ctx.draw.text('init',0,0);"});
    assert(initial.commands[0][1] === 'init', 'Native renderer did not return drawing data');
    const closed = await renderer.request({event: 'destroy'});
    assert(closed.commands[0][1] === 'init', 'Native renderer did not execute destroy lifecycle');
    renderer.destroy();
    pending.delete(renderer);
    passed++;

    const invalid = new VisualProcess(root);
    pending.add(invalid);
    await rejects(invalid, {event: 'check', code: 'if ('});
    pending.delete(invalid);
    passed++;

    const loop = new VisualProcess(root);
    pending.add(loop);
    await rejects(loop, {event: 'init', code: 'while (true) {}'});
    pending.delete(loop);
    passed++;

    const cancelled = new VisualProcess(root);
    pending.add(cancelled);
    let cancellation = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30, () => {
        cancellation = 0;
        cancelled.destroy();
        return GLib.SOURCE_REMOVE;
    });
    try {
        await rejects(cancelled, {event: 'init', code: 'while (true) {}'});
    } finally {
        if (cancellation)
            GLib.Source.remove(cancellation);
    }
    pending.delete(cancelled);
    passed++;

    const parent = new Gio.Cancellable();
    const owned = new VisualProcess(root, parent);
    pending.add(owned);
    assert(owned.parentSignal !== 0, 'Parent cancellation was not connected');
    let parentCancellation = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30, () => {
        parentCancellation = 0;
        parent.cancel();
        return GLib.SOURCE_REMOVE;
    });
    try {
        await rejects(owned, {event: 'init', code: 'while (true) {}'});
        await new Promise(resolve => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        }));
        assert(owned.parentSignal === 0 && owned.parentDisconnect === 0 && owned.parent === null,
            'Cancelled parent retained a cancellation connection or deferred cleanup');
    } finally {
        if (parentCancellation)
            GLib.Source.remove(parentCancellation);
    }
    pending.delete(owned);
    passed++;

    const reusableParent = new Gio.Cancellable();
    const canceledOwner = new VisualProcess(root, reusableParent);
    pending.add(canceledOwner);
    const destroy = canceledOwner.destroy.bind(canceledOwner);
    let cancellationCallbacks = 0;
    canceledOwner.destroy = () => {
        cancellationCallbacks++;
        destroy();
    };
    reusableParent.cancel();
    assert(canceledOwner.closed, 'Parent cancellation did not synchronously stop the helper');
    await new Promise(resolve => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
    assert(canceledOwner.parentSignal === 0 && canceledOwner.parentDisconnect === 0,
        'Cancellation did not disconnect after returning from the native callback');
    const completedCallbacks = cancellationCallbacks;
    reusableParent.reset();
    reusableParent.cancel();
    assert(cancellationCallbacks === completedCallbacks,
        'Resetting and cancelling a former parent called a destroyed helper again');
    pending.delete(canceledOwner);
    passed++;

    const alreadyCancelled = new Gio.Cancellable();
    alreadyCancelled.cancel();
    let prevented = false;
    try {
        new VisualProcess(root, alreadyCancelled);
    } catch {
        prevented = true;
    }
    assert(prevented, 'Already cancelled parent launched a new helper');
    passed++;

    const releasedParent = new Gio.Cancellable();
    const detached = new VisualProcess(root, releasedParent);
    pending.add(detached);
    detached.destroy();
    assert(detached.parentSignal === 0, 'Normal teardown retained a parent cancellation connection');
    releasedParent.cancel();
    assert(detached.closed && detached.deadline === 0, 'Parent cancellation changed a closed process');
    pending.delete(detached);
    passed++;

    const staging = GLib.dir_make_tmp('stealth-lock-visual-process-XXXXXX');
    try {
        GLib.mkdir_with_parents(GLib.build_filenamev([staging, 'helpers']), 0o700);
        GLib.mkdir_with_parents(GLib.build_filenamev([staging, 'shared']), 0o700);
        const helper = GLib.build_filenamev([staging, 'helpers', 'visual-renderer.py']);
        GLib.file_set_contents(GLib.build_filenamev([staging, 'shared', 'visual-api.js']), '');
        for (const [source, event] of [
            ["import sys,time\nsys.stdin.buffer.readline()\ntime.sleep(10)\n", 'check'],
            ["import sys\nsys.stdin.buffer.readline()\nsys.stdout.buffer.write(b'\\xff\\n')\nsys.stdout.buffer.flush()\n", 'init'],
            ["import sys\nsys.stdin.buffer.readline()\nsys.stdout.buffer.write(b'x'*262146)\nsys.stdout.buffer.flush()\n", 'init'],
            ["import sys\nsys.stdin.buffer.readline()\nsys.stdout.buffer.write(b'{}\\n{}\\n')\nsys.stdout.buffer.flush()\n", 'init'],
        ]) {
            GLib.file_set_contents(helper, source);
            const worker = new VisualProcess(staging);
            pending.add(worker);
            await rejects(worker, {event, code: ''});
            pending.delete(worker);
            passed++;
        }
    } finally {
        for (const file of [
            ['helpers', 'visual-renderer.py'], ['shared', 'visual-api.js'], ['helpers'], ['shared'], [],
        ])
            Gio.File.new_for_path(GLib.build_filenamev([staging, ...file])).delete(null);
    }
    console.log(`${passed} native visual process tests passed`);
} catch (error) {
    console.error(error.stack);
    failed = true;
} finally {
    for (const worker of pending)
        worker.destroy();
}
System.exit(failed ? 1 : 0);
