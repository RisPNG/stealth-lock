import assert from 'node:assert/strict';
import test from 'node:test';

import vm from 'node:vm';

import {DEFAULT_EFFECT_PRESETS, initializeEffectPresets, readSavedEntries, validateVisualProgramSource} from '../../shared/presets.js';

function settingsFixture(values = {}, {refuseLibrary = false, refuseMarker = false} = {}) {
    const saved = new Map(Object.entries(values));
    const writes = [];
    const settings = {
        get_user_value: key => saved.has(key) ? saved.get(key) : null,
        get_boolean: key => saved.get(key) ?? false,
        get_string: key => saved.get(key) ?? (key === 'visual-effect-presets' ? '[]' : ''),
        set_string(key, value) {
            writes.push([key, value]);
            if (refuseLibrary)
                return false;
            saved.set(key, value);
            return true;
        },
        set_boolean(key, value) {
            writes.push([key, value]);
            if (refuseMarker)
                return false;
            saved.set(key, value);
            return true;
        },
    };
    return {settings, saved, writes};
}

test('fresh profile seeds three ordinary inactive presets once, and deletion survives reload', () => {
    const {settings, saved, writes} = settingsFixture();
    assert.equal(initializeEffectPresets(settings), true);
    assert.deepEqual(readSavedEntries(settings, 'visual-effect-presets'), DEFAULT_EFFECT_PRESETS);
    assert.equal(saved.get('visual-effect-initialized'), true);
    assert.equal(settings.get_string('visual-effect-active'), '');
    assert.equal(saved.has('visual-effect-active'), false);
    for (const entry of readSavedEntries(settings, 'visual-effect-presets'))
        assert.equal(validateVisualProgramSource(entry.code), entry.code);
    saved.set('visual-effect-presets', '[]');
    writes.length = 0;
    assert.equal(initializeEffectPresets(settings), true);
    assert.equal(settings.get_string('visual-effect-presets'), '[]');
    assert.deepEqual(writes, []);
});

test('existing empty, edited, and malformed user libraries are preserved even without an initialization marker', () => {
    for (const library of ['[]', '[{"name":"My effect","code":"editable draft"}]', '{invalid json']) {
        const {settings, writes} = settingsFixture({'visual-effect-presets': library});
        assert.equal(initializeEffectPresets(settings), true);
        assert.equal(settings.get_string('visual-effect-presets'), library);
        assert.deepEqual(writes, [['visual-effect-initialized', true]]);
    }
});

test('customized current preferences do not prevent first-time starter initialization', () => {
    const {settings, saved} = settingsFixture({'lock-hotkey': ['custom'], 'normal-prompt-css': 'padding: 9px;'});
    assert.equal(initializeEffectPresets(settings), true);
    assert.deepEqual(readSavedEntries(settings, 'visual-effect-presets'), DEFAULT_EFFECT_PRESETS);
    assert.deepEqual(saved.get('lock-hotkey'), ['custom']);
    assert.equal(saved.get('normal-prompt-css'), 'padding: 9px;');
});

test('explicit current effect selections remain unchanged before first initialization', () => {
    for (const active of ['', 'My Rain']) {
        const {settings, writes} = settingsFixture({'visual-effect-active': active});
        assert.equal(initializeEffectPresets(settings), true);
        assert.equal(settings.get_string('visual-effect-presets'), '[]');
        assert.equal(settings.get_string('visual-effect-active'), active);
        assert.deepEqual(writes, [['visual-effect-initialized', true]]);
    }
});

test('failed seed never writes the marker and a failed marker never replaces successful saved data', () => {
    const refused = settingsFixture({}, {refuseLibrary: true});
    assert.equal(initializeEffectPresets(refused.settings), false);
    assert.equal(refused.saved.has('visual-effect-initialized'), false);
    assert.equal(refused.writes.length, 1);
    const marker = settingsFixture({}, {refuseMarker: true});
    assert.equal(initializeEffectPresets(marker.settings), false);
    const seeded = marker.settings.get_string('visual-effect-presets');
    marker.writes.length = 0;
    assert.equal(initializeEffectPresets(marker.settings), false);
    assert.equal(marker.settings.get_string('visual-effect-presets'), seeded);
    assert.deepEqual(marker.writes, [['visual-effect-initialized', true]]);
});

test('saved-entry validation rejects malformed CSS and effect libraries without modifying settings', () => {
    for (const key of ['normal-prompt-css-saved-entries', 'visual-effect-presets']) {
        for (const raw of ['not JSON', '{}', '[null]', '[[]]', '[{"name":1,"code":"{}"}]',
            '[{"name":"  ","code":"{}"}]', '[{"name":"Valid","code":3}]',
            '[{"name":"Valid","code":"{}","extra":"x"}]',
            '[{"name":"Rain","code":"{}"},{"name":" rain ","code":"{}"}]']) {
            const {settings, writes} = settingsFixture({[key]: raw});
            assert.throws(() => readSavedEntries(settings, key), /Saved entr|saved entry/);
            assert.equal(settings.get_string(key), raw);
            assert.deepEqual(writes, []);
        }
    }
    const editable = settingsFixture({'visual-effect-presets': '[{"name":" Mine ","code":"unfinished JavaScript draft"}]'});
    assert.deepEqual(readSavedEntries(editable.settings, 'visual-effect-presets'), [{name: ' Mine ', code: 'unfinished JavaScript draft'}]);
});

test('saved CSS entries retain exact names and editable code through the shared reader', () => {
    const entries = [{name: ' Spacious ', code: 'padding: 9px;'}, {name: 'Draft', code: ''}];
    const {settings, writes} = settingsFixture({'normal-prompt-css-saved-entries': JSON.stringify(entries)});
    assert.deepEqual(readSavedEntries(settings, 'normal-prompt-css-saved-entries'), entries);
    assert.deepEqual(writes, []);
});

test('program admission checks UTF-8 source bounds without evaluating or rewriting it', () => {
    const source = 'globalThis.presetExecuted = true;\nctx.draw.paint();';
    assert.equal(validateVisualProgramSource(source), source);
    assert.equal(globalThis.presetExecuted, undefined);
    for (const invalid of [null, {}, 1, '', ' \n\t ', 'ctx.draw.paint();\0'])
        assert.throws(() => validateVisualProgramSource(invalid), /JavaScript text|NUL/);
    for (const exact of ['x'.repeat(512 * 1024), '🔒'.repeat(128 * 1024)])
        assert.equal(validateVisualProgramSource(exact), exact);
    for (const oversized of ['x'.repeat(512 * 1024 + 1), '🔒'.repeat(128 * 1024 + 1)])
        assert.throws(() => validateVisualProgramSource(oversized), /512 KiB/);
    assert.equal(validateVisualProgramSource('const unfinished ='), 'const unfinished =');
});

function createProgramFixture(name, {width = 1920, height = 1080, reducedMotion = false, random} = {}) {
    const entry = DEFAULT_EFFECT_PRESETS.find(preset => preset.name === name);
    const commands = [];
    const clockChanges = [];
    const blurChanges = [];
    let seed = 1234567;
    const math = Object.create(Math);
    math.random = random ?? (() => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 4294967296;
    });
    const colors = {
        blur: [0.02, 0.02, 0.02, 0.25], background: [0.02, 0.02, 0.02, 0],
        foreground: [0.1, 0.9, 0.3, 1], head: [0.7, 1, 0.7, 1], glitch: [0.6, 1, 0.6, 1],
        palette: [[0.2, 0.9, 1, 0.7], [1, 0.3, 0.1, 1]],
    };
    const methods = ['setSourceRGBA', 'paint', 'rectangle', 'fill', 'moveTo', 'lineTo', 'stroke',
        'setLineWidth', 'setOperator', 'save', 'restore', 'text'];
    const ctx = {
        event: 'init', state: {}, width, height, reducedMotion, colors,
        now: 0, delta: 50, monitors: [{x: 0, y: 0, width, height}],
        draw: Object.fromEntries(methods.map(method => [method, (...values) => {
            commands.push([method, ...values]);
            assert.ok(commands.length <= 2048, `${name} exceeded the frame command budget`);
        }])),
        clock: options => clockChanges.push(options),
        blur: (...options) => blurChanges.push(options),
    };
    const context = vm.createContext({ctx, Math: math});
    const program = new vm.Script('(function (ctx) {\n' + entry.code + '\n})(ctx)', {filename: name + '.js'});
    return {
        entry, ctx, commands, clockChanges, blurChanges,
        run(event) {
            commands.length = 0;
            ctx.event = event;
            ctx.now += ctx.delta;
            program.runInContext(context, {timeout: 1000});
            assert.ok(Buffer.byteLength(JSON.stringify(commands)) <= 256 * 1024, `${name} exceeded the frame byte budget`);
            return commands;
        },
    };
}

test('each starter is a self-contained editable lifecycle program using the ordinary visual API', () => {
    assert.deepEqual(DEFAULT_EFFECT_PRESETS.map(entry => entry.name), ['Dim and Blur', 'Neo Rain', 'City Grow']);
    for (const {name, code} of DEFAULT_EFFECT_PRESETS) {
        assert.throws(() => JSON.parse(code));
        assert.equal(/\b(?:import|Gio|GLib|Cairo|Pango|Shell|St)\b/u.test(code), false);
        const fixture = createProgramFixture(name);
        assert.ok(fixture.run('init').length > 0, `${name} must render a first frame`);
        fixture.run('update');
        fixture.run('destroy');
        assert.equal(fixture.ctx.state.scene, undefined);
    }
});

test('blur uses theme dimming and disposes its ordinary declaration on destruction', () => {
    const fixture = createProgramFixture('Dim and Blur');
    fixture.run('init');
    assert.deepEqual(fixture.blurChanges, [[20, 1]]);
    assert.deepEqual(fixture.commands, [['setOperator', 'source'], ['setSourceRGBA', ...fixture.ctx.colors.blur], ['paint']]);
    fixture.run('destroy');
    assert.deepEqual(fixture.blurChanges.at(-1), [null]);
});

test('rain draws the editable Unicode alphabet and preserves transparent pixels below glyphs', () => {
    const fixture = createProgramFixture('Neo Rain');
    fixture.run('init');
    const alphabet = fixture.ctx.state.scene.characters;
    assert.equal(alphabet.length, 66);
    assert.equal(alphabet[0].codePointAt(0), 0xff66);
    assert.equal(alphabet[55].codePointAt(0), 0xff9d);
    assert.equal(alphabet.slice(56).join(''), '0123456789');
    assert.ok(fixture.commands.some(command => command[0] === 'text'));
    assert.ok(fixture.commands.filter(command => command[0] === 'text').every(command => alphabet.includes(command[1])));
    fixture.run('update');
    assert.equal(fixture.commands[0][1], 'dest-out');
    assert.ok(fixture.commands.some(command => command[0] === 'setOperator' && command[1] === 'source'));
    assert.equal(fixture.commands.findLast(command => command[0] === 'setOperator')[1], 'over');
});

test('reduced motion renders visible rain and city first frames and keeps subsequent frames static', () => {
    for (const name of ['Neo Rain', 'City Grow']) {
        const fixture = createProgramFixture(name, {reducedMotion: true});
        fixture.run('init');
        assert.ok(fixture.commands.some(command => ['text', 'stroke'].includes(command[0])), `${name} must have visible decoration`);
        const scene = fixture.ctx.state.scene;
        fixture.run('update');
        assert.deepEqual(fixture.commands, []);
        assert.equal(fixture.ctx.state.scene, scene);
        fixture.run('destroy');
        assert.equal(fixture.ctx.state.scene, undefined);
    }
});

test('City Grow retains branching, reverses its recorded drawing, and restarts with its native clock declaration', () => {
    const fixture = createProgramFixture('City Grow', {width: 120, height: 96});
    fixture.run('init');
    assert.equal(fixture.clockChanges[0].visible, true);
    assert.equal(fixture.clockChanges[0].monitor, 'settings');
    const scene = fixture.ctx.state.scene;
    assert.ok(scene.historyLength > 0);
    let reversed = false;
    let restarted = false;
    for (let frame = 0; frame < 3000; frame++) {
        fixture.run('update');
        if (scene.reverseRunning)
            reversed = true;
        if (reversed && !scene.reverseRunning && scene.restartAtMs === null) {
            restarted = true;
            break;
        }
    }
    assert.equal(reversed, true);
    assert.equal(restarted, true);
    assert.ok(scene.cells.some(cell => cell === 1));
    fixture.run('destroy');
    assert.equal(fixture.clockChanges.at(-1), null);
});

test('starter programs remain within frame and retained-state limits on large desktops', () => {
    for (const name of ['Neo Rain', 'City Grow']) {
        const fixture = createProgramFixture(name, {width: 32768, height: 16384, reducedMotion: true});
        fixture.run('init');
        const scene = fixture.ctx.state.scene;
        if (name === 'City Grow') {
            assert.ok(scene.cells.length <= 262144);
            assert.ok(scene.branchList.length <= 24);
        } else {
            assert.ok(scene.columns.length <= 512);
        }
        fixture.ctx.reducedMotion = false;
        for (let frame = 0; frame < 400; frame++) {
            fixture.run('update');
            if (name === 'City Grow') {
                assert.ok(scene.branchList.length <= 24);
                assert.ok(scene.historyLength <= 20000 + 128 * 3);
            }
        }
        fixture.run('destroy');
    }
});

test('users edit or remove starter algorithms without initialization replacing their changes', () => {
    const fixture = settingsFixture();
    initializeEffectPresets(fixture.settings);
    const edited = [{name: 'My pattern', code: DEFAULT_EFFECT_PRESETS[1].code.replace('fontSize: 16', 'fontSize: 24')}];
    fixture.saved.set('visual-effect-presets', JSON.stringify(edited));
    fixture.writes.length = 0;
    assert.equal(initializeEffectPresets(fixture.settings), true);
    assert.deepEqual(readSavedEntries(fixture.settings, 'visual-effect-presets'), edited);
    assert.deepEqual(fixture.writes, []);
});
