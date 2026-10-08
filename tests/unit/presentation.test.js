import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {setImmediate} from 'node:timers/promises';
import test from 'node:test';

import * as Presets from '../../shared/presets.js';
import {Cancellable, loadModule} from './harness.js';

async function runtime({bitmap = '', size = 40, olderShell = false, lockType = 'normal', monitors = [{x: 0, y: 0, width: 1024, height: 768}]} = {}) {
    const uploads = [];
    const reads = [];
    const decodes = [];
    const events = [];
    const context = {};
    const stage = {context: {get_backend: () => ({get_cogl_context: () => context})}};
    const cancellable = new Cancellable();
    const values = {
        'lock-type': lockType, 'cursor-mode': 'lock-icon', 'cursor-bitmap-path': bitmap,
        'normal-prompt-css': '', 'normal-background-css': '', 'debug-mode': false, 'debug-show-info': true,
        'normal-prompt-follow-cursor': false, 'normal-prompt-monitor': '',
        'normal-prompt-fixed-x': -1, 'normal-prompt-fixed-y': -1,
        'normal-prompt-cursor-anchor': 'br', 'normal-prompt-offset-x': 12, 'normal-prompt-offset-y': 12,
        'visual-effect-active': '', 'visual-effect-presets': '[]',
        'cursor-fg-rgba': [0, 0, 0, 255], 'cursor-bg-rgba': [255, 255, 255, 255],
    };
    class Actor {
        constructor(properties = {}) {
            Object.assign(this, properties);
            this.children = [];
            this.stage = null;
            this.destroyed = false;
            this.visible = true;
            this.clutter_text = {};
            this.layout_manager = {set_orientation: orientation => { this.orientation = orientation; }};
        }
        add_child(child) { child.parent = this; this.children.push(child); }
        remove_child(child) { this.children.splice(this.children.indexOf(child), 1); child.parent = null; }
        get_parent() { return this.parent ?? null; }
        get_stage() { return this.stage; }
        set_content(content) { this.content = content; }
        set_content_gravity(gravity) { this.gravity = gravity; }
        set_size(width, height) { Object.assign(this, {width, height}); }
        set_position(x, y) { Object.assign(this, {x, y}); }
        get_preferred_width() { return [100, 100]; }
        get_preferred_height() { return [40, 40]; }
        get_allocation_box() { events.push('layout'); return {}; }
        destroy() {
            this.destroyed = true;
            events.push('destroy');
            for (const child of this.children)
                child.destroy();
        }
    }
    const settings = {
        get_string: key => values[key], get_boolean: key => values[key], get_int: key => values[key],
        get_value: key => ({deep_unpack: () => values[key]}),
    };
    const stream = {
        close_async: (_priority, cancel, callback) => {
            assert.equal(cancel, null, 'closing must remain possible after session cancellation');
            callback(stream, {});
        },
        close_finish: () => events.push('stream-close'),
    };
    const GdkPixbuf = {Pixbuf: {
        new_from_stream_at_scale_async: (input, width, height, preserveAspect, cancel, callback) => {
            assert.equal(input, stream);
            assert.equal(cancel, cancellable);
            assert.equal(preserveAspect, true);
            decodes.push({width, height, callback});
        },
        new_from_stream_finish: result => {
            if (result.error)
                throw result.error;
            return result.pixbuf;
        },
    }};
    const St = {
        Widget: Actor, BoxLayout: Actor, Label: Actor,
        ImageContent: {new_with_preferred_size: (width, height) => ({
            width, height,
            set_data: (...arguments_) => uploads.push(arguments_),
        })},
    };
    const {LockOverlay} = await loadModule('shell/overlay.js', {
        'gi://Clutter': {default: {Image: olderShell ? class {} : undefined,
            Orientation: {VERTICAL: 1}, ContentGravity: {RESIZE_ASPECT: 1}}},
        'gi://Cogl': {default: {PixelFormat: {RGBA_8888: 'rgba', RGB_888: 'rgb'}}},
        'gi://GdkPixbuf': {default: GdkPixbuf},
        'gi://Gio': {default: {File: {new_for_commandline_arg: value => {
            const file = {
                value,
                read_async: (_priority, cancel, callback) => {
                    assert.equal(cancel, cancellable);
                    reads.push({file, callback});
                },
                read_finish: result => {
                    if (result.error)
                        throw result.error;
                    return stream;
                },
            };
            return file;
        }}}},
        'gi://GLib': {default: {PRIORITY_DEFAULT: 0}},
        'gi://Meta': {default: {prefs_get_cursor_size: () => size}},
        'gi://Pango': {default: {EllipsizeMode: {NONE: 0}}},
        'gi://St': {default: St},
        'resource:///org/gnome/shell/ui/main.js': {layoutManager: {monitors, primaryMonitor: monitors[0]}},
        './effects/backdrop.js': {BackdropEffect: class { constructor() { assert.fail('disabled effects must not create a renderer'); } }},
        '../shared/presets.js': Presets,
    }, {global: {stage, get_pointer: () => [200, 150]}, console: {debug: message => events.push(message)}});
    const input = {actor: new Actor()};
    const overlay = new LockOverlay(settings, input.actor, cancellable);
    overlay.actor.stage = stage;
    return {overlay, input, cancellable, values, reads, decodes, uploads, stream, events, context};
}

test('original bitmap pixels and hotspot survive both native image upload signatures', async t => {
    for (const olderShell of [true, false]) {
        await t.test(olderShell ? 'GNOME45–47 inherited image' : 'GNOME48 St image', async () => {
            const {overlay, uploads, context} = await runtime({olderShell});
            const upload = uploads[0];
            if (!olderShell)
                assert.equal(upload.shift(), context);
            assert.deepEqual(upload.slice(1), ['rgba', 28, 40, 112]);
            assert.equal(createHash('sha256').update(upload[0]).digest('hex'), '035e1031e1d8710e85e7ae65118f2c5610fa150a09f9c5173bf81e05e9e9d9d2');
            assert.deepEqual([overlay.cursorHotX, overlay.cursorHotY], [14, 21]);
        });
    }
});

test('prompt layout uses the native orientation API shared by GNOME45–51', async () => {
    const {overlay} = await runtime();
    assert.equal(overlay.prompt.orientation, 1);
    assert.equal(Object.hasOwn(overlay.prompt, 'vertical'), false);
    assert.equal(overlay.prompt.children[0], overlay.inputActor);
    overlay.destroy();
});

test('custom cursor loading retains the bitmap until valid native decoding succeeds', async () => {
    const {overlay, reads, decodes, uploads, events} = await runtime({bitmap: 'file:///cursor.svg', size: 24});
    assert.deepEqual([overlay.cursor.width, overlay.cursor.height, overlay.cursorHotX, overlay.cursorHotY], [17, 24, 9, 13]);
    assert.equal(reads[0].file.value, 'file:///cursor.svg');
    assert.equal(uploads.length, 1);
    reads[0].callback(reads[0].file, {});
    await setImmediate();
    assert.equal(uploads.length, 1, 'an opened stream is not a decoded image');
    decodes[0].callback(null, {pixbuf: {
        get_width: () => 12, get_height: () => 24, get_has_alpha: () => false,
        get_rowstride: () => 36, get_pixels: () => new Uint8Array(864),
    }});
    await setImmediate();
    assert.equal(uploads.length, 2);
    assert.deepEqual(uploads[1].slice(2), ['rgb', 12, 24, 36]);
    assert.deepEqual([overlay.cursor.width, overlay.cursor.height, overlay.cursorHotX, overlay.cursorHotY], [24, 24, 12, 12]);
    assert.equal(overlay.cursor.gravity, 1);
    assert.ok(events.includes('stream-close'));
});

test('unavailable or corrupt images retain the original cursor and close any opened stream', async t => {
    for (const failure of ['open', 'decode']) {
        await t.test(failure, async () => {
            const {overlay, reads, decodes, uploads, events} = await runtime({bitmap: '/cursor.png'});
            const image = overlay.cursor.content;
            reads[0].callback(reads[0].file, failure === 'open' ? {error: new Error('not readable')} : {});
            await setImmediate();
            if (failure === 'decode') {
                decodes[0].callback(null, {error: new Error('invalid image')});
                await setImmediate();
                assert.ok(events.includes('stream-close'));
            }
            assert.equal(overlay.cursor.content, image);
            assert.equal(uploads.length, 1);
            assert.deepEqual([overlay.cursor.width, overlay.cursor.height], [28, 40]);
        });
    }
});

test('cancellation cannot adopt a late cursor image and still closes the stream', async t => {
    for (const phase of ['open', 'decode']) {
        await t.test(phase, async () => {
            const {overlay, cancellable, reads, decodes, uploads, events} = await runtime({bitmap: 'sftp://host/cursor.png'});
            if (phase === 'decode') {
                reads[0].callback(reads[0].file, {});
                await setImmediate();
            }
            cancellable.cancel();
            overlay.destroy();
            if (phase === 'open')
                reads[0].callback(reads[0].file, {});
            else
                decodes[0].callback(null, {pixbuf: {get_width: () => assert.fail('cancelled image was inspected')}});
            await setImmediate();
            assert.equal(uploads.length, 1);
            assert.ok(events.includes('stream-close'));
            assert.equal(overlay.inputActor.destroyed, false, 'input remains owned by the session');
        });
    }
});

test('prompt stays on a real display through gaps, nonzero origins and live CSS updates', async () => {
    const monitors = [{x: -800, y: 0, width: 800, height: 600}, {x: 200, y: 100, width: 1024, height: 768}];
    const {overlay, values} = await runtime({monitors});
    values['normal-prompt-follow-cursor'] = true;
    values['normal-prompt-cursor-anchor'] = 'tl';
    overlay.movePointer(205, 105);
    assert.deepEqual([overlay.prompt.x + overlay.originX, overlay.prompt.y + overlay.originY], [200, 100]);
    values['normal-prompt-follow-cursor'] = false;
    values['normal-prompt-fixed-x'] = 850;
    values['normal-prompt-fixed-y'] = 10;
    values['normal-prompt-css'] = 'padding: 19px;';
    values['normal-background-css'] = 'opacity: 128;';
    overlay.refreshStyle();
    assert.equal(overlay.prompt.style, 'padding: 19px;');
    assert.equal(overlay.backdrop.style, 'opacity: 128;');
    assert.equal(overlay.prompt.x + overlay.originX, -100, 'a gap position clamps into the primary monitor');
    assert.equal(overlay.prompt.y + overlay.originY, 10);
});

test('authentication feedback remains visible in normal mode and hidden in stealth mode', async t => {
    for (const lockType of ['normal', 'stealth']) {
        await t.test(lockType, async () => {
            const {overlay, input} = await runtime({lockType});
            assert.equal(overlay.status.visible, false);
            assert.equal(overlay.status.clutter_text.line_wrap, true);
            assert.equal(overlay.status.clutter_text.ellipsize, 0);
            overlay.setStatus('Password not accepted; wait before retrying');
            assert.equal(overlay.status.visible, lockType === 'normal');
            assert.equal(overlay.status.text, 'Password not accepted; wait before retrying');
            assert.equal(overlay.info.text, overlay.status.text);
            assert.equal(input.actor.get_parent(), lockType === 'normal' ? overlay.prompt : overlay.actor);
            if (lockType === 'normal')
                assert.ok(Number.isFinite(overlay.prompt.x) && Number.isFinite(overlay.prompt.y));
            overlay.setStatus('');
            assert.equal(overlay.status.visible, false);
        });
    }
});
