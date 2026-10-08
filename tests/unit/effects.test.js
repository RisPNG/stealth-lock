import assert from 'node:assert/strict';
import test from 'node:test';

import {readSavedEntries, validateEffectConfig} from '../../shared/presets.js';
import {loadModule} from './harness.js';

async function runtime({radiusProperty = true, animations = true, reducedMotion = null, failure = '', clockSize = [240, 80],
    monitors = [{x: 0, y: 0, width: 1024, height: 768}], promptMonitor = ''} = {}) {
    const actors = [];
    const surfaces = [];
    const contexts = [];
    const transientContexts = [];
    const blurProperties = [];
    const timers = new Map();
    const scenes = [];
    const glyphs = [];
    const faults = {failure};
    const marker = {executed: false};
    let nextTimer = 1;
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
        get_allocation_box() { return {}; }
        set_size(width, height) { Object.assign(this, {width, height}); }
        set_position(x, y) { Object.assign(this, {x, y}); }
        set_clip(x, y, width, height) { this.clip = {x, y, width, height}; }
        queue_repaint() { this.repaints = (this.repaints ?? 0) + 1; }
        get_context() {
            const cr = {
                disposed: 0,
                setSourceSurface() {},
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
            this.operators = [];
            contexts.push(this);
        }
        setSourceRGBA() {}
        paint() {}
        rectangle() {}
        fill() {}
        moveTo() {}
        setOperator(operator) { this.operators.push(operator); }
        $dispose() { this.disposed++; }
    }
    class BlurEffect {
        static find_property(name) { return name === 'radius' && radiusProperty ? {} : null; }
        constructor(properties) {
            if (faults.failure === 'blur')
                throw new Error('blur allocation failed');
            blurProperties.push(properties);
        }
    }
    class CityGrowth {
        constructor(width, height, knobs) {
            if (faults.failure === 'scene')
                throw new Error('scene construction failed');
            Object.assign(this, {width, height, knobs, advances: 0});
            scenes.push(this);
        }
        advance() {
            if (faults.failure === 'animation')
                throw new Error('scene frame failed');
            this.advances++;
        }
    }
    const GLib = {
        PRIORITY_DEFAULT: 0, SOURCE_CONTINUE: true, SOURCE_REMOVE: false,
        timeout_add(_priority, interval, callback) { const id = nextTimer++; timers.set(id, {interval, callback, kind: 'animation'}); return id; },
        timeout_add_seconds(_priority, interval, callback) { const id = nextTimer++; timers.set(id, {interval, callback, kind: 'clock'}); return id; },
        Source: {remove(id) { assert.ok(timers.delete(id), 'each timer must be removed exactly once'); }},
        DateTime: {new_now_local: () => {
            if (faults.failure === 'clock')
                throw new Error('clock update failed');
            return {format: format => format};
        }},
    };
    const {BackdropEffect} = await loadModule('shell/effects/backdrop.js', {
        cairo: {default: {ImageSurface, Context, Format: {ARGB32: 0}, Operator: {DEST_OUT: 1, OVER: 2, SOURCE: 3}}},
        'gi://Clutter': {default: {ActorAlign: {CENTER: 0}, Orientation: {VERTICAL: 1}}},
        'gi://GLib': {default: GLib},
        'gi://Pango': {default: {SCALE: 1024, FontDescription: class { set_family() {} set_absolute_size() {} }}},
        'gi://PangoCairo': {default: {
            create_layout: () => ({set_font_description() {}, set_text: text => glyphs.push(text), get_pixel_size: () => [10, 20]}),
            show_layout() {},
        }},
        'gi://Shell': {default: {BlurEffect, BlurMode: {BACKGROUND: 1}}},
        'gi://St': {default: {Widget: Actor, DrawingArea: Actor, BoxLayout: Actor, Label: Actor,
            ReducedMotion: reducedMotion === null ? undefined : {NO_PREFERENCE: 0, REDUCE: 1},
            Settings: {get: () => interfaceSettings}}},
        './city.js': {CityGrowth},
    }, {effectMarker: marker, Math: Object.assign(Object.create(Math), {random: () => 0.25}), console: {debug() {}}});
    const parent = new Actor();
    const originX = Math.min(...monitors.map(monitor => monitor.x));
    const originY = Math.min(...monitors.map(monitor => monitor.y));
    const geometry = {
        parent, monitors, originX, originY, promptMonitor, primaryMonitor: monitors[0],
        width: Math.max(...monitors.map(monitor => monitor.x + monitor.width)) - originX,
        height: Math.max(...monitors.map(monitor => monitor.y + monitor.height)) - originY,
    };
    return {
        create(effect = 'city-grow', knobs = {}) { return new BackdropEffect(geometry, validateEffectConfig(JSON.stringify({effect, knobs}))); },
        geometry, parent, actors, contexts, surfaces, transientContexts, blurProperties,
        timers, scenes, glyphs, interfaceSettings, faults, theme, marker,
    };
}

test('both Shell blur properties receive valid native parameters and detach during destruction', async t => {
    for (const radiusProperty of [false, true]) {
        await t.test(radiusProperty ? 'Shell46–51 radius' : 'Shell45 sigma', async () => {
            const state = await runtime({radiusProperty});
            const effect = state.create('blur', {radius: 12.6, brightness: 0.4});
            const properties = state.blurProperties[0];
            assert.deepEqual({...properties}, {mode: 1, brightness: 0.4, [radiusProperty ? 'radius' : 'sigma']: 13});
            assert.equal(effect.area.effects.size, 1);
            assert.equal(state.timers.size, 0);
            effect.destroy();
            assert.equal(effect.area.effects.size, 0);
            assert.equal(state.parent.children.length, 0);
            assert.equal(state.interfaceSettings.owners.size, 0);
        });
    }
});

test('partial effect construction releases acquired actors, native sources and Cairo resources', async t => {
    for (const failure of ['blur', 'context', 'scene', 'clock', 'settings-connect']) {
        await t.test(failure, async () => {
            const state = await runtime({failure});
            assert.throws(() => state.create(failure === 'blur' ? 'blur' : 'city-grow', {clock: {visible: true}}), /failed/);
            assert.equal(state.parent.children.length, 0);
            assert.equal(state.timers.size, 0);
            assert.equal(state.interfaceSettings.owners.size, 0);
            assert.ok(state.contexts.every(context => context.disposed === 1));
            assert.ok(state.surfaces.every(surface => surface.finished === 1));
        });
    }
});

test('animation preference changes own exactly one animation source and preserve the independent clock', async () => {
    const state = await runtime();
    const effect = state.create('city-grow', {intervalMs: 80, clock: {visible: true, seconds: false, format24h: false, date: false}});
    assert.equal(state.timers.size, 2);
    assert.equal(effect.timeLabel.text, '%I:%M %p');
    assert.equal(effect.dateLabel, undefined);
    assert.equal(effect.clock.orientation, 1);
    assert.equal(Object.hasOwn(effect.clock, 'vertical'), false);
    const animation = [...state.timers.values()].find(timer => timer.kind === 'animation');
    assert.equal(animation.interval, 80);
    animation.callback();
    assert.equal(state.scenes[0].advances, 2);
    state.interfaceSettings.toggle(false);
    assert.deepEqual([...state.timers.values()].map(timer => timer.kind), ['clock']);
    state.interfaceSettings.toggle(true);
    state.interfaceSettings.toggle(true);
    assert.equal(state.timers.size, 2);
    effect.destroy();
    assert.equal(state.timers.size, 0);
    assert.equal(state.contexts[0].disposed, 1);
    assert.equal(state.surfaces[0].finished, 1);
});

test('reduced motion creates a static scene without scheduling animation frames', async () => {
    const state = await runtime({animations: false});
    const effect = state.create();
    assert.equal(state.scenes[0].advances, 32);
    assert.equal(state.timers.size, 0);
    assert.equal(effect.area.repaints, 1);
    effect.destroy();
});

test('GNOME51 reduced motion independently overrides enabled animations and reacts live', async () => {
    const state = await runtime({reducedMotion: true});
    const effect = state.create('city-grow', {clock: {visible: true}});
    assert.equal(state.scenes[0].advances, 32);
    assert.deepEqual([...state.timers.values()].map(timer => timer.kind), ['clock']);
    state.interfaceSettings.setReducedMotion(false);
    assert.equal(state.timers.size, 2);
    state.interfaceSettings.setReducedMotion(true);
    assert.deepEqual([...state.timers.values()].map(timer => timer.kind), ['clock']);
    state.interfaceSettings.toggle(false);
    state.interfaceSettings.setReducedMotion(false);
    assert.deepEqual([...state.timers.values()].map(timer => timer.kind), ['clock']);
    state.interfaceSettings.toggle(true);
    assert.equal(state.timers.size, 2);
    effect.destroy();
    state.interfaceSettings.setReducedMotion(false);
    state.interfaceSettings.toggle(true);
    assert.equal(state.timers.size, 0);
    assert.equal(state.interfaceSettings.owners.size, 0);
});

test('theme changes replace the scene and dispose old resources before the next frame', async () => {
    const state = await runtime();
    const effect = state.create();
    const oldTimer = effect._animationTimer;
    state.theme.red = 200;
    effect.area.emit('style-changed');
    assert.equal(state.contexts[0].disposed, 1);
    assert.equal(state.surfaces[0].finished, 1);
    assert.equal(state.timers.has(oldTimer), false);
    assert.equal(state.timers.size, 1);
    assert.equal(state.scenes.length, 2);
    assert.equal(effect.colors.foreground[0], 200 / 255);
    effect.area.emit('repaint');
    assert.equal(state.transientContexts[0].disposed, 1);
    effect.destroy();
    assert.ok(state.contexts.every(context => context.disposed === 1));
    assert.ok(state.surfaces.every(surface => surface.finished === 1));
});

test('failed scene replacement never disposes the old Cairo resources twice', async () => {
    const state = await runtime();
    const effect = state.create();
    state.faults.failure = 'surface';
    try {
        effect.area.emit('style-changed');
    } catch (error) {
        assert.match(error.message, /surface allocation failed/);
    }
    effect.destroy();
    assert.equal(state.contexts[0].disposed, 1);
    assert.equal(state.surfaces[0].finished, 1);
    assert.equal(state.timers.size, 0);
    assert.equal(effect.layer.destroyed, true);
    assert.equal(state.parent.destroyed, undefined);
});

test('native repaint contexts are released even when Cairo painting fails', async () => {
    const state = await runtime();
    const effect = state.create();
    state.faults.failure = 'repaint';
    try {
        effect.area.emit('repaint');
    } catch (error) {
        assert.match(error.message, /native repaint failed/);
    }
    assert.equal(state.transientContexts[0].disposed, 1);
    assert.equal(effect.layer.destroyed, true);
    assert.equal(state.timers.size, 0);
    assert.equal(state.parent.destroyed, undefined);
    effect.destroy();
});

test('asynchronous rendering failures destroy only the effect and remove every owned source', async t => {
    for (const failure of ['animation', 'clock']) {
        await t.test(failure, async () => {
            const state = await runtime();
            const effect = state.create('city-grow', {clock: {visible: true}});
            const timer = [...state.timers.values()].find(source => source.kind === failure);
            state.faults.failure = failure;
            assert.equal(timer.callback(), false);
            assert.equal(effect.layer.destroyed, true);
            assert.equal(state.parent.destroyed, undefined);
            assert.equal(state.parent.children.length, 0);
            assert.equal(state.timers.size, 0);
            assert.equal(state.interfaceSettings.owners.size, 0);
            assert.equal(state.contexts[0].disposed, 1);
            assert.equal(state.surfaces[0].finished, 1);
            effect.destroy();
            assert.equal(state.contexts[0].disposed, 1, 'later overlay cleanup must be idempotent');
        });
    }
});

test('clock selection translates negative stage origins and clamps extreme offsets inside the chosen monitor', async () => {
    const monitors = [{x: -1000, y: -100, width: 600, height: 500}, {x: 200, y: 300, width: 900, height: 500}];
    const state = await runtime({monitors, promptMonitor: '1'});
    const effect = state.create('blur', {clock: {visible: true, monitor: 'settings', align: 'right', topRatio: 1, offsetY: 2147483647}});
    assert.deepEqual([effect.clock.x + state.geometry.originX, effect.clock.y + state.geometry.originY], [836, 720]);
    effect.config.knobs.clock.offsetY = -2147483648;
    effect.updateClock();
    assert.equal(effect.clock.y + state.geometry.originY, 300);
    effect.destroy();
});

test('a clock centered over virtual monitor gaps remains wholly visible on a real monitor', async () => {
    const monitors = [{x: -1000, y: -100, width: 600, height: 500}, {x: 200, y: 300, width: 900, height: 500}];
    const state = await runtime({monitors});
    const effect = state.create('blur', {clock: {visible: true, monitor: 'all', topRatio: 0.5}});
    const x = effect.clock.x + state.geometry.originX;
    const y = effect.clock.y + state.geometry.originY;
    assert.ok(monitors.some(monitor => x >= monitor.x && y >= monitor.y &&
        x + effect.clock.width <= monitor.x + monitor.width && y + effect.clock.height <= monitor.y + monitor.height),
    `clock rectangle ${x},${y},${effect.clock.width},${effect.clock.height} must fit a physical monitor`);
    effect.destroy();
});

test('oversized clock content is resized and clipped to a small physical monitor', async () => {
    const state = await runtime({clockSize: [600, 400], monitors: [{x: -200, y: -100, width: 160, height: 120}]});
    const effect = state.create('blur', {clock: {visible: true, align: 'left', topRatio: 1}});
    assert.deepEqual([effect.clock.width, effect.clock.height, effect.clock.x, effect.clock.y], [160, 120, 0, 0]);
    assert.deepEqual({...effect.clock.clip}, {x: 0, y: 0, width: 160, height: 120});
    effect.destroy();
});

test('code-shaped user text is rendered as characters and never evaluated', async () => {
    const state = await runtime();
    const text = 'globalThis.effectMarker.executed=true;🔒';
    const effect = state.create('neo-rain', {characters: text, fontFamily: 'globalThis.effectMarker.executed=true'});
    assert.deepEqual(state.glyphs, [...text]);
    assert.equal(state.marker.executed, false);
    assert.equal(state.timers.size, 1);
    effect.destroy();
});

test('rain erases prior pixels before repainting a transparent background', async () => {
    const state = await runtime();
    const effect = state.create('neo-rain', {background: [10, 20, 30, 0]});
    assert.deepEqual([...effect.colors.background], [10 / 255, 20 / 255, 30 / 255, 0]);
    const operators = state.contexts[0].operators;
    assert.equal(operators[0], 1, 'DEST_OUT removes old alpha independently of background alpha');
    assert.ok(operators.includes(3), 'SOURCE restores actual transparent pixels beneath droplet cells');
    assert.equal(operators.at(-1), 2, 'new glyphs use normal OVER composition');
    effect.destroy();
});

test('overlay effect replacement preserves modal input and places decoration below the prompt and cursor', async () => {
    const monitor = {x: -400, y: 0, width: 1024, height: 768};
    const creations = [];
    const marker = {executed: false};
    class Renderer {
        constructor(context, config) {
            this.context = context;
            this.config = config;
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
        './effects/backdrop.js': {BackdropEffect: Renderer}, '../shared/presets.js': {readSavedEntries, validateEffectConfig},
    }, {effectMarker: marker, console: {debug() {}}});
    const values = {
        'visual-effect-active': 'Mine',
        'visual-effect-presets': JSON.stringify([{name: 'Mine', code: '{"effect":"blur","knobs":{"radius":5}}'}]),
        'normal-prompt-monitor': '',
    };
    const background = {name: 'background'};
    const input = {name: 'password-input'};
    const prompt = {name: 'prompt', input};
    const cursor = {name: 'cursor'};
    const actor = {
        modal: true,
        children: [background, {name: 'backdrop'}, prompt, cursor],
        set_child_above_sibling(child, sibling) {
            this.children.splice(this.children.indexOf(child), 1);
            this.children.splice(this.children.indexOf(sibling) + 1, 0, child);
        },
    };
    const overlay = {
        settings: {get_string: key => values[key]}, actor, background,
        width: 1024, height: 768, monitors: [monitor], originX: -400, originY: 0, effect: null,
    };
    LockOverlay.prototype.refreshEffect.call(overlay);
    assert.equal(creations.length, 1);
    assert.deepEqual(actor.children.map(child => child.name), ['background', 'effect', 'backdrop', 'prompt', 'cursor']);
    assert.equal(Object.hasOwn(creations[0].context, 'input'), false);
    assert.equal(Object.hasOwn(creations[0].context, 'password'), false);
    assert.equal(actor.modal, true);
    values['visual-effect-active'] = 'deleted';
    LockOverlay.prototype.refreshEffect.call(overlay);
    assert.equal(creations[0].destroyed, 1);
    assert.equal(overlay.effect, null);
    assert.deepEqual(actor.children.map(child => child.name), ['background', 'backdrop', 'prompt', 'cursor']);
    for (const library of ['not JSON', JSON.stringify([{name: 'Mine', code: 'globalThis.effectMarker.executed=true'}])]) {
        values['visual-effect-active'] = 'Mine';
        values['visual-effect-presets'] = library;
        assert.doesNotThrow(() => LockOverlay.prototype.refreshEffect.call(overlay));
        assert.equal(overlay.effect, null);
        assert.equal(creations.length, 1);
        assert.equal(actor.modal, true);
        assert.equal(prompt.input, input);
    }
    assert.equal(marker.executed, false);
});
