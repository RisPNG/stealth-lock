import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import test from 'node:test';

import {readSavedEntries, validateVisualProgramSource} from '../../shared/presets.js';
import {MAX_VISUAL_REPLAY_MICROSECONDS, MAX_VISUAL_SURFACE_PIXELS, validateVisualFrame} from '../../shared/visual-frame.js';
import {deferred, loadModule} from './harness.js';

async function runtime({radiusProperty = true, animations = true, reducedMotion = null, failure = '', clockSize = [240, 80],
    monitors = [{x: 0, y: 0, width: 1024, height: 768}], promptMonitor = '', connectorIndex = {},
    response = {commands: [], blur: null, clock: null}} = {}) {
    const actors = [];
    const surfaces = [];
    const contexts = [];
    const transientContexts = [];
    const workers = [];
    const timers = new Map();
    const glyphs = [];
    const responses = [];
    const requests = [];
    const faults = {failure, pending: null};
    let nextTimer = 1;
    let now = 1000;
    const theme = {red: 32, green: 64, blue: 96, alpha: 255};
    const interfaceSettings = {
        enable_animations: animations,
        reduced_motion: reducedMotion ? 1 : 0,
        owners: new Map(),
        connectObject(signal, callback, owner) {
            if (faults.failure === 'settings-connect')
                throw new Error('settings connection failed');
            const connections = this.owners.get(owner) ?? [];
            connections.push({signal, callback});
            this.owners.set(owner, connections);
        },
        disconnectObject(owner) { this.owners.delete(owner); },
        toggle(value) {
            this.enable_animations = value;
            for (const connections of this.owners.values()) {
                for (const {signal, callback} of connections) {
                    if (signal === 'notify::enable-animations')
                        callback();
                }
            }
        },
        setReducedMotion(value) {
            this.reduced_motion = value ? 1 : 0;
            for (const connections of this.owners.values()) {
                for (const {signal, callback} of connections) {
                    if (signal === 'notify::reduced-motion')
                        callback();
                }
            }
        },
    };
    class Actor {
        constructor(properties = {}) {
            Object.assign(this, properties);
            this.children = [];
            this.handlers = new Map();
            this.effects = new Map();
            this.layout_manager = {set_orientation: orientation => { this.orientation = orientation; }};
            actors.push(this);
        }
        add_child(actor) { this.children.push(actor); actor.parent = this; }
        remove_child(actor) { this.children.splice(this.children.indexOf(actor), 1); actor.parent = null; }
        connect(signal, callback) { this.handlers.set(signal, callback); }
        emit(signal) { this.handlers.get(signal)?.(); }
        get_theme_node() { return {lookup_color: () => [true, {...theme}]}; }
        get_preferred_width() { return [clockSize[0], clockSize[0]]; }
        get_preferred_height() { return [clockSize[1], clockSize[1]]; }
        set_size(width, height) { Object.assign(this, {width, height}); }
        set_position(x, y) { Object.assign(this, {x, y}); }
        set_clip(x, y, width, height) { this.clip = {x, y, width, height}; }
        queue_repaint() { this.repaints = (this.repaints ?? 0) + 1; }
        get_context() {
            const cr = {
                disposed: 0, scale() {}, setSourceSurface() {},
                paint() {
                    if (faults.failure === 'repaint')
                        throw new Error('native repaint failed');
                },
                $dispose() { this.disposed++; },
            };
            transientContexts.push(cr);
            return cr;
        }
        add_effect_with_name(name, effect) { this.effects.set(name, effect); }
        remove_effect_by_name(name) { this.effects.delete(name); }
        destroy() {
            this.destroyed = true;
            this.effects.clear();
            for (const child of [...this.children])
                child.destroy();
            this.parent?.remove_child(this);
        }
    }
    class ImageSurface {
        constructor(format, width, height) {
            if (faults.failure === 'surface')
                throw new Error('surface allocation failed');
            Object.assign(this, {format, width, height, finished: 0});
            surfaces.push(this);
        }
        finish() { this.finished++; }
    }
    class Context {
        constructor(surface) {
            if (faults.failure === 'context')
                throw new Error('context allocation failed');
            this.surface = surface;
            this.disposed = 0;
            this.operations = [];
            contexts.push(this);
        }
        scale(...values) { this.operations.push(['scale', ...values]); }
        setSourceRGBA(...values) { this.operations.push(['color', ...values]); }
        paint() { this.operations.push(['paint']); now += faults.replayMilliseconds ?? 0; }
        rectangle(...values) { this.operations.push(['rectangle', ...values]); }
        fill() { this.operations.push(['fill']); }
        moveTo(...values) { this.operations.push(['moveTo', ...values]); }
        lineTo(...values) { this.operations.push(['lineTo', ...values]); }
        stroke() { this.operations.push(['stroke']); }
        save() { this.operations.push(['save']); }
        restore() { this.operations.push(['restore']); }
        setLineWidth(...values) { this.operations.push(['lineWidth', ...values]); }
        setOperator(operator) { this.operations.push(['operator', operator]); }
        newPath() { this.operations.push(['newPath']); }
        $dispose() { this.disposed++; }
    }
    class BlurEffect {
        static find_property(name) { return name === 'radius' && radiusProperty ? {} : null; }
        constructor(properties) {
            if (faults.failure === 'blur')
                throw new Error('blur allocation failed');
            Object.assign(this, properties);
        }
    }
    class VisualProcess {
        constructor(path) {
            if (faults.failure === 'process')
                throw new Error('process launch failed');
            this.path = path;
            this.busy = false;
            this.closed = false;
            this.destroyed = 0;
            workers.push(this);
        }
        async request(frame) {
            this.busy = true;
            requests.push(frame);
            try {
                if (faults.failure === 'request')
                    throw new Error('visual request failed');
                if (faults.pending)
                    return await faults.pending.promise;
                return structuredClone(responses.shift() ?? response);
            } finally {
                this.busy = false;
            }
        }
        destroy() {
            if (!this.closed) {
                this.closed = true;
                this.destroyed++;
            }
        }
    }
    const GLib = {
        PRIORITY_DEFAULT: 0, SOURCE_CONTINUE: true, SOURCE_REMOVE: false,
        timeout_add(_priority, interval, callback) { const id = nextTimer++; timers.set(id, {interval, callback, kind: 'animation'}); return id; },
        timeout_add_seconds(_priority, interval, callback) { const id = nextTimer++; timers.set(id, {interval, callback, kind: 'clock'}); return id; },
        Source: {remove(id) { assert.ok(timers.delete(id), 'each timer must be removed exactly once'); }},
        get_monotonic_time: () => now * 1000,
        DateTime: {new_now_local: () => {
            if (faults.failure === 'clock')
                throw new Error('clock update failed');
            return {format: format => format};
        }},
    };
    const {VisualEffect} = await loadModule('shell/effects/renderer.js', {
        cairo: {default: {ImageSurface, Context, Format: {ARGB32: 0}, Operator: {DEST_OUT: 1, OVER: 2, SOURCE: 3}}},
        'gi://Clutter': {default: {ActorAlign: {CENTER: 0}, Orientation: {VERTICAL: 1}}},
        'gi://GLib': {default: GLib},
        'gi://Pango': {default: {SCALE: 1024, FontDescription: class { set_family() {} set_absolute_size() {} }}},
        'gi://PangoCairo': {default: {
            create_layout: () => ({set_font_description() {}, set_text: text => glyphs.push(text)}),
            show_layout() {},
        }},
        'gi://Shell': {default: {BlurEffect, BlurMode: {BACKGROUND: 1}}},
        'gi://St': {default: {Widget: Actor, DrawingArea: Actor, BoxLayout: Actor, Label: Actor,
            ReducedMotion: reducedMotion === null ? undefined : {NO_PREFERENCE: 0, REDUCE: 1},
            Settings: {get: () => interfaceSettings}}},
        '../../shared/visual-process.js': {VisualProcess},
        '../../shared/visual-frame.js': {MAX_VISUAL_REPLAY_MICROSECONDS, MAX_VISUAL_SURFACE_PIXELS, validateVisualFrame},
        '../../shared/presets.js': {validateVisualProgramSource},
    }, {global: {display: {get_monitor_index_for_connector: connector => connectorIndex[connector] ?? -1}}, console: {debug() {}}});
    const parent = new Actor();
    const originX = Math.min(...monitors.map(monitor => monitor.x));
    const originY = Math.min(...monitors.map(monitor => monitor.y));
    const geometry = {
        path: '/installed-extension', parent, monitors, originX, originY, promptMonitor, primaryMonitor: monitors[0],
        width: Math.max(...monitors.map(monitor => monitor.x + monitor.width)) - originX,
        height: Math.max(...monitors.map(monitor => monitor.y + monitor.height)) - originY,
    };
    return {
        create(code = 'ctx.draw.paint();') { return new VisualEffect(geometry, code); },
        advance(milliseconds = 50) { now += milliseconds; },
        geometry, parent, actors, contexts, surfaces, transientContexts, workers, requests, responses,
        timers, glyphs, interfaceSettings, faults, theme,
    };
}

test('isolated programs receive only visual metadata and commands retain the same Cairo surface across updates', async () => {
    const state = await runtime({response: {commands: [['setOperator', 'source'], ['setSourceRGBA', 0, 0, 0, 1], ['paint']], blur: null, clock: null}});
    const effect = state.create('throw new Error("must execute only in the helper");');
    await setImmediate();
    assert.equal(state.workers[0].path, '/installed-extension');
    const initial = state.requests[0];
    assert.equal(initial.event, 'init');
    assert.equal(initial.code, 'throw new Error("must execute only in the helper");');
    assert.deepEqual(Object.keys(initial).sort(), ['code', 'colors', 'delta', 'event', 'height', 'monitors', 'now', 'reducedMotion', 'width']);
    assert.equal(initial.delta, 0);
    state.advance(80);
    [...state.timers.values()][0].callback();
    await setImmediate();
    assert.equal(state.requests[1].event, 'update');
    assert.equal(state.requests[1].delta, 80);
    assert.equal(state.surfaces.length, 1);
    assert.equal(state.contexts.length, 1);
    assert.equal(state.contexts[0].operations.filter(operation => operation[0] === 'paint').length, 2);
    effect.destroy();
    await setImmediate();
    assert.equal(state.requests.at(-1).event, 'destroy');
    assert.equal(state.workers[0].destroyed, 1);
});

test('both Shell blur properties receive validated parameters and detach during replacement', async t => {
    for (const radiusProperty of [false, true]) {
        await t.test(radiusProperty ? 'Shell46–51 radius' : 'Shell45 sigma', async () => {
            const state = await runtime({radiusProperty, response: {commands: [], blur: {radius: 12.6, brightness: 0.4}, clock: null}});
            const effect = state.create();
            await setImmediate();
            assert.equal(effect.blur[radiusProperty ? 'radius' : 'sigma'], 13);
            assert.equal(effect.blur.brightness, 0.4);
            assert.equal(effect.area.effects.size, 1);
            state.responses.push({commands: [], blur: null, clock: null});
            await effect.renderFrame('update');
            assert.equal(effect.blur, null);
            assert.equal(effect.area.effects.size, 0);
            effect.destroy();
            await setImmediate();
            assert.equal(state.parent.children.length, 0);
            assert.equal(state.interfaceSettings.owners.size, 0);
        });
    }
});

test('partial construction and asynchronous initialization failures release decoration resources', async t => {
    for (const failure of ['surface', 'context', 'process', 'settings-connect', 'blur', 'clock', 'request']) {
        await t.test(failure, async () => {
            const state = await runtime({failure, response: {commands: [], blur: {radius: 20, brightness: 1}, clock: {visible: true}}});
            if (['surface', 'context', 'process', 'settings-connect'].includes(failure))
                assert.throws(() => state.create(), /failed/);
            else
                state.create();
            await setImmediate();
            assert.equal(state.parent.children.length, 0);
            assert.equal(state.timers.size, 0);
            assert.equal(state.interfaceSettings.owners.size, 0);
            assert.ok(state.contexts.every(context => context.disposed === 1));
            assert.ok(state.surfaces.every(surface => surface.finished === 1));
            assert.ok(state.workers.every(worker => worker.destroyed === 1));
        });
    }
});

test('animation preferences own one source and leave trusted clocks ticking independently', async () => {
    const state = await runtime({response: {commands: [], blur: null, clock: {visible: true, seconds: false, format24h: false, date: false}}});
    const effect = state.create();
    await setImmediate();
    assert.equal(state.timers.size, 2);
    assert.equal(effect.timeLabel.text, '%I:%M %p');
    assert.equal(effect.dateLabel, null);
    assert.equal(effect.clock.orientation, 1);
    assert.equal([...state.timers.values()].find(timer => timer.kind === 'animation').interval, 50);
    state.interfaceSettings.toggle(false);
    await setImmediate();
    assert.deepEqual([...state.timers.values()].map(timer => timer.kind), ['clock']);
    assert.equal(state.requests.at(-1).reducedMotion, true);
    state.interfaceSettings.toggle(true);
    state.interfaceSettings.toggle(true);
    assert.equal(state.timers.size, 2);
    effect.destroy();
    await setImmediate();
    assert.equal(state.timers.size, 0);
    assert.equal(state.contexts[0].disposed, 1);
    assert.equal(state.surfaces[0].finished, 1);
});

test('GNOME51 reduced motion overrides animation and responds to live preference changes', async () => {
    const state = await runtime({reducedMotion: true, response: {commands: [], blur: null, clock: {visible: true}}});
    const effect = state.create();
    await setImmediate();
    assert.deepEqual([...state.timers.values()].map(timer => timer.kind), ['clock']);
    assert.equal(state.requests[0].reducedMotion, true);
    state.interfaceSettings.setReducedMotion(false);
    assert.equal(state.timers.size, 2);
    state.interfaceSettings.setReducedMotion(true);
    await setImmediate();
    assert.deepEqual([...state.timers.values()].map(timer => timer.kind), ['clock']);
    state.interfaceSettings.toggle(false);
    state.interfaceSettings.setReducedMotion(false);
    await setImmediate();
    assert.deepEqual([...state.timers.values()].map(timer => timer.kind), ['clock']);
    state.interfaceSettings.toggle(true);
    assert.equal(state.timers.size, 2);
    effect.destroy();
    await setImmediate();
    state.interfaceSettings.setReducedMotion(false);
    state.interfaceSettings.toggle(true);
    assert.equal(state.timers.size, 0);
    assert.equal(state.interfaceSettings.owners.size, 0);
});

test('theme and monitor inputs refresh through metadata without exposing Shell objects', async () => {
    const state = await runtime({monitors: [{x: -400, y: -100, width: 1024, height: 768}]});
    const effect = state.create();
    await setImmediate();
    state.theme.red = 200;
    effect.area.emit('style-changed');
    await setImmediate();
    assert.equal(state.requests.at(-1).colors.foreground[0], 200 / 255);
    assert.deepEqual(state.requests.at(-1).monitors.map(monitor => ({...monitor})), [{x: 0, y: 0, width: 1024, height: 768}]);
    assert.equal(state.surfaces.length, 1);
    effect.area.emit('repaint');
    assert.equal(state.transientContexts[0].disposed, 1);
    effect.destroy();
    await setImmediate();
    assert.equal(state.surfaces[0].finished, 1);
});

test('theme changes during initialization coalesce into the latest metadata update', async () => {
    const state = await runtime({reducedMotion: false});
    const pending = deferred();
    state.faults.pending = pending;
    const effect = state.create();
    assert.equal(state.requests.length, 1);
    state.theme.red = 100;
    effect.area.emit('style-changed');
    state.theme.red = 220;
    effect.area.emit('style-changed');
    assert.equal(state.requests.length, 1);
    assert.equal(effect._pendingUpdate, true);
    state.faults.pending = null;
    pending.resolve({commands: [], blur: null, clock: null});
    await setImmediate();
    assert.equal(state.requests.length, 2);
    assert.equal(state.requests[1].event, 'update');
    assert.equal(state.requests[1].colors.foreground[0], 220 / 255);
    assert.equal(state.requests[1].reducedMotion, false);
    assert.equal(effect._pendingUpdate, false);
    assert.equal(state.timers.size, 1);
    effect.destroy();
    await setImmediate();
});

test('theme changes during a busy frame refresh a static program exactly once after completion', async () => {
    const state = await runtime({animations: false});
    const effect = state.create();
    await setImmediate();
    const initialRequests = state.requests.length;
    const pending = deferred();
    state.faults.pending = pending;
    const update = effect.renderFrame('update');
    state.theme.green = 110;
    effect.area.emit('style-changed');
    state.theme.green = 240;
    effect.area.emit('style-changed');
    assert.equal(state.requests.length, initialRequests + 1);
    state.faults.pending = null;
    pending.resolve({commands: [], blur: null, clock: null});
    await update;
    await setImmediate();
    assert.equal(state.requests.length, initialRequests + 2);
    assert.equal(state.requests.at(-1).colors.foreground[1], 240 / 255);
    assert.equal(effect._pendingUpdate, false);
    assert.equal(state.timers.size, 0);
    effect.destroy();
    await setImmediate();
});

test('disabling motion during a busy frame sends current metadata after removing the animation source', async t => {
    for (const preference of ['animations', 'reduced-motion']) {
        await t.test(preference, async () => {
            const state = await runtime({reducedMotion: false,
                response: {commands: [], blur: null, clock: {visible: true}}});
            const effect = state.create();
            await setImmediate();
            const initialRequests = state.requests.length;
            const pending = deferred();
            state.faults.pending = pending;
            const update = effect.renderFrame('update');
            if (preference === 'animations') {
                state.interfaceSettings.toggle(false);
                state.interfaceSettings.toggle(false);
            } else {
                state.interfaceSettings.setReducedMotion(true);
                state.interfaceSettings.setReducedMotion(true);
            }
            assert.equal(state.requests.length, initialRequests + 1);
            assert.deepEqual([...state.timers.values()].map(timer => timer.kind), ['clock']);
            state.faults.pending = null;
            pending.resolve({commands: [], blur: null, clock: {visible: true}});
            await update;
            await setImmediate();
            assert.equal(state.requests.length, initialRequests + 2);
            assert.equal(state.requests.at(-1).reducedMotion, true);
            assert.equal(effect._pendingUpdate, false);
            assert.deepEqual([...state.timers.values()].map(timer => timer.kind), ['clock']);
            effect.destroy();
            await setImmediate();
        });
    }
});

test('animation timer ticks skip busy helpers without queuing continuous animation', async () => {
    const state = await runtime();
    const effect = state.create();
    await setImmediate();
    const initialRequests = state.requests.length;
    const pending = deferred();
    state.faults.pending = pending;
    const update = effect.renderFrame('update');
    const timer = [...state.timers.values()].find(source => source.kind === 'animation');
    for (let i = 0; i < 4; i++)
        timer.callback();
    assert.equal(effect._pendingUpdate, false);
    state.faults.pending = null;
    pending.resolve({commands: [], blur: null, clock: null});
    await update;
    await setImmediate();
    assert.equal(state.requests.length, initialRequests + 1);
    effect.destroy();
    await setImmediate();
});

test('native repaint contexts are released when painting fails', async () => {
    const state = await runtime();
    const effect = state.create();
    await setImmediate();
    state.faults.failure = 'repaint';
    effect.area.emit('repaint');
    await setImmediate();
    assert.equal(state.transientContexts[0].disposed, 1);
    assert.equal(effect.layer.destroyed, true);
    assert.equal(state.timers.size, 0);
    assert.equal(state.parent.destroyed, undefined);
    effect.destroy();
});

test('clock and process failures remove only decoration and every owned source', async t => {
    for (const failure of ['request', 'clock']) {
        await t.test(failure, async () => {
            const state = await runtime({response: {commands: [], blur: null, clock: {visible: true}}});
            const effect = state.create();
            await setImmediate();
            const timer = [...state.timers.values()].find(source => source.kind === (failure === 'request' ? 'animation' : 'clock'));
            state.faults.failure = failure;
            timer.callback();
            await setImmediate();
            assert.equal(effect.layer.destroyed, true);
            assert.equal(state.parent.destroyed, undefined);
            assert.equal(state.parent.children.length, 0);
            assert.equal(state.timers.size, 0);
            assert.equal(state.interfaceSettings.owners.size, 0);
            assert.equal(state.contexts[0].disposed, 1);
            assert.equal(state.surfaces[0].finished, 1);
            effect.destroy();
            assert.equal(state.contexts[0].disposed, 1);
        });
    }
});

test('late helper frames cannot touch a destroyed surface and a busy helper is killed immediately', async () => {
    const state = await runtime();
    state.faults.pending = deferred();
    const effect = state.create();
    assert.equal(state.workers[0].busy, true);
    effect.area.emit('style-changed');
    assert.equal(effect._pendingUpdate, true);
    effect.destroy();
    assert.equal(effect._pendingUpdate, false);
    assert.equal(state.workers[0].destroyed, 1);
    const drawn = state.contexts[0].operations.length;
    state.faults.pending.resolve({commands: [['paint']], blur: null, clock: null});
    await setImmediate();
    assert.equal(state.contexts[0].operations.length, drawn);
    assert.equal(state.surfaces[0].finished, 1);
    assert.equal(state.timers.size, 0);
    assert.equal(state.requests.length, 1);
});

test('malformed helper commands are rejected before any trusted Cairo operation', async () => {
    const state = await runtime({response: {commands: [['paint'], ['destroy']], blur: null, clock: null}});
    const effect = state.create();
    await setImmediate();
    assert.equal(state.contexts[0].operations.some(operation => operation[0] === 'paint'), false);
    assert.equal(effect.layer.destroyed, true);
    assert.equal(state.workers[0].closed, true);
});

test('oversized display spans cap the backing image to sixteen million pixels', async () => {
    const state = await runtime({monitors: [{x: 0, y: 0, width: 16000, height: 10000}]});
    const effect = state.create();
    await setImmediate();
    const surface = state.surfaces[0];
    assert.ok(surface.width < 16000 && surface.height < 10000);
    assert.ok(surface.width * surface.height <= MAX_VISUAL_SURFACE_PIXELS + surface.width + surface.height);
    effect.destroy();
    await setImmediate();
});

test('trusted clocks translate negative origins and clamp int32 offsets inside the selected display', async () => {
    const monitors = [{x: -1000, y: -100, width: 600, height: 500}, {x: 200, y: 300, width: 900, height: 500}];
    const state = await runtime({monitors, promptMonitor: '1', response: {commands: [], blur: null,
        clock: {visible: true, monitor: 'settings', align: 'right', topRatio: 1, offsetY: 2147483647}}});
    const effect = state.create();
    await setImmediate();
    assert.deepEqual([effect.clock.x + state.geometry.originX, effect.clock.y + state.geometry.originY], [836, 720]);
    effect.clockConfig.offsetY = -2147483648;
    effect.updateClock();
    assert.equal(effect.clock.y + state.geometry.originY, 300);
    effect.destroy();
    await setImmediate();
});

test('trusted clocks follow stable monitor connectors and use the primary display when disconnected', async () => {
    const monitors = [{x: -1000, y: -100, width: 600, height: 500}, {x: 200, y: 300, width: 900, height: 500}];
    const state = await runtime({monitors, promptMonitor: 'DP-1', connectorIndex: {'DP-1': 1},
        response: {commands: [], blur: null, clock: {visible: true, monitor: 'settings'}}});
    const effect = state.create();
    await setImmediate();
    assert.equal(effect.clock.x + state.geometry.originX, 530);
    effect.clockConfig.monitor = 'HDMI-A-1';
    effect.updateClock();
    assert.equal(effect.clock.x + state.geometry.originX, -820);
    assert.equal(effect.clock.y + state.geometry.originY, -30);
    effect.destroy();
    await setImmediate();
});

test('clocks fit physical monitors even when centered over monitor gaps or larger than the display', async t => {
    for (const options of [
        {monitors: [{x: -1000, y: -100, width: 600, height: 500}, {x: 200, y: 300, width: 900, height: 500}]},
        {clockSize: [600, 400], monitors: [{x: -200, y: -100, width: 160, height: 120}]},
    ]) {
        await t.test(options.clockSize ? 'oversized clock' : 'monitor gaps', async () => {
            const state = await runtime({...options, response: {commands: [], blur: null, clock: {visible: true, monitor: 'all', topRatio: 0.5}}});
            const effect = state.create();
            await setImmediate();
            const x = effect.clock.x + state.geometry.originX;
            const y = effect.clock.y + state.geometry.originY;
            assert.ok(options.monitors.some(monitor => x >= monitor.x && y >= monitor.y &&
                x + effect.clock.width <= monitor.x + monitor.width && y + effect.clock.height <= monitor.y + monitor.height));
            assert.deepEqual({...effect.clock.clip}, {x: 0, y: 0, width: effect.clock.width, height: effect.clock.height});
            effect.destroy();
            await setImmediate();
        });
    }
});

test('code-shaped drawing text remains literal and glyph caches stay bounded', async () => {
    const text = 'globalThis.marker.executed=true;🔒';
    const state = await runtime({response: {commands: [['text', text, 0, 0, 16, 'monospace']], blur: null, clock: null}});
    const effect = state.create();
    await setImmediate();
    assert.equal(state.glyphs[0], text);
    for (let i = 0; i < 520; i++) {
        state.responses.push({commands: [['text', String(i), 0, 0, 16, 'monospace']], blur: null, clock: null});
        await effect.renderFrame('update');
    }
    assert.ok(effect._glyphs.size <= 512);
    effect.destroy();
    await setImmediate();
});

test('native line width survives frames and remains part of the next frame raster budget', async () => {
    const state = await runtime({monitors: [{x: 0, y: 0, width: 1920, height: 1080}],
        response: {commands: [['setLineWidth', 128]], blur: null, clock: null}});
    const effect = state.create();
    await setImmediate();
    assert.equal(effect._lineWidth, 128);
    const commands = Array.from({length: 100}, () => [['moveTo', 0, 0], ['lineTo', 1920, 1080], ['stroke']]).flat();
    state.responses.push({commands, blur: null, clock: null});
    await effect.renderFrame('update');
    assert.equal(effect._destroyed, true);
    assert.equal(effect.layer.destroyed, true);
    assert.equal(state.contexts[0].operations.some(([operation]) => operation === 'stroke'), false);
    await setImmediate();
    assert.equal(state.workers[0].destroyed, 1);
});

test('unexpectedly slow native replay discards decoration after a final command or before the next one', async t => {
    for (const commands of [[['paint']], [['paint'], ['paint']]]) {
        await t.test(`${commands.length} paint commands`, async () => {
            const state = await runtime({response: {commands, blur: null, clock: null}});
            state.faults.replayMilliseconds = 51;
            const effect = state.create();
            await setImmediate();
            assert.equal(effect._destroyed, true);
            assert.equal(effect._ready, false);
            assert.equal(effect.layer.destroyed, true);
            assert.equal(state.contexts[0].operations.filter(([operation]) => operation === 'paint').length, 1);
            assert.equal(state.surfaces[0].finished, 1);
            assert.equal(state.workers[0].destroyed, 1);
        });
    }
});

test('overlay replacement preserves modal input and places programs below the prompt and cursor', async () => {
    const monitor = {x: -400, y: 0, width: 1024, height: 768};
    const creations = [];
    class Renderer {
        constructor(context, code) {
            this.context = context;
            this.code = code;
            this.layer = {name: 'effect'};
            this.destroyed = 0;
            context.parent.children.push(this.layer);
            creations.push(this);
        }
        destroy() {
            this.destroyed++;
            this.context.parent.children.splice(this.context.parent.children.indexOf(this.layer), 1);
        }
    }
    const {LockOverlay} = await loadModule('shell/overlay.js', {
        'gi://Clutter': {default: {}}, 'gi://Cogl': {default: {}}, 'gi://GdkPixbuf': {default: {}},
        'gi://Gio': {default: {}}, 'gi://GLib': {default: {}}, 'gi://Meta': {default: {}},
        'gi://Pango': {default: {}}, 'gi://St': {default: {}},
        'resource:///org/gnome/shell/ui/main.js': {layoutManager: {primaryMonitor: monitor}},
        'resource:///org/gnome/shell/ui/shellEntry.js': {CapsLockWarning: class {}},
        'resource:///org/gnome/shell/ui/status/keyboard.js': {getInputSourceManager: () => ({})},
        './effects/renderer.js': {VisualEffect: Renderer}, '../shared/presets.js': {readSavedEntries},
    }, {console: {debug() {}}});
    const values = {'visual-effect-active': 'Mine', 'visual-effect-presets': JSON.stringify([{name: 'Mine', code: 'ctx.draw.paint();'}]),
        'normal-prompt-monitor': ''};
    const background = {name: 'background'};
    const input = {name: 'password-input'};
    const prompt = {name: 'prompt', input};
    const cursor = {name: 'cursor'};
    const actor = {
        modal: true, children: [background, {name: 'backdrop'}, prompt, cursor],
        set_child_above_sibling(child, sibling) {
            this.children.splice(this.children.indexOf(child), 1);
            this.children.splice(this.children.indexOf(sibling) + 1, 0, child);
        },
    };
    const overlay = {path: '/installed-extension', settings: {get_string: key => values[key]}, actor, background,
        width: 1024, height: 768, monitors: [monitor], originX: -400, originY: 0, effect: null};
    LockOverlay.prototype.refreshEffect.call(overlay);
    assert.equal(creations[0].code, 'ctx.draw.paint();');
    assert.equal(creations[0].context.path, '/installed-extension');
    assert.deepEqual(actor.children.map(child => child.name), ['background', 'effect', 'backdrop', 'prompt', 'cursor']);
    assert.equal(Object.hasOwn(creations[0].context, 'input'), false);
    assert.equal(Object.hasOwn(creations[0].context, 'password'), false);
    assert.equal(actor.modal, true);
    values['visual-effect-active'] = 'deleted';
    LockOverlay.prototype.refreshEffect.call(overlay);
    assert.equal(creations[0].destroyed, 1);
    assert.equal(overlay.effect, null);
    assert.deepEqual(actor.children.map(child => child.name), ['background', 'backdrop', 'prompt', 'cursor']);
    values['visual-effect-active'] = 'Mine';
    values['visual-effect-presets'] = 'not JSON';
    assert.doesNotThrow(() => LockOverlay.prototype.refreshEffect.call(overlay));
    assert.equal(overlay.effect, null);
    assert.equal(actor.modal, true);
    assert.equal(prompt.input, input);
});
