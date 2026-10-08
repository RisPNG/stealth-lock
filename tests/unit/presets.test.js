import assert from 'node:assert/strict';
import test from 'node:test';

import {DEFAULT_EFFECT_PRESETS, initializeEffectPresets, readSavedEntries, validateEffectConfig} from '../../shared/presets.js';

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
    for (const entry of readSavedEntries(settings, 'visual-effect-presets')) {
        const config = validateEffectConfig(entry.code);
        assert.equal(config.knobs.clock.visible, config.effect === 'city-grow');
    }
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
    const editable = settingsFixture({'visual-effect-presets': '[{"name":" Mine ","code":"invalid configuration draft"}]'});
    assert.deepEqual(readSavedEntries(editable.settings, 'visual-effect-presets'), [{name: ' Mine ', code: 'invalid configuration draft'}]);
});

test('saved CSS entries retain exact names and editable code through the shared reader', () => {
    const entries = [{name: ' Spacious ', code: 'padding: 9px;'}, {name: 'Draft', code: ''}];
    const {settings, writes} = settingsFixture({'normal-prompt-css-saved-entries': JSON.stringify(entries)});
    assert.deepEqual(readSavedEntries(settings, 'normal-prompt-css-saved-entries'), entries);
    assert.deepEqual(writes, []);
});

test('normalization fills effect and clock defaults without selecting or executing scripts', () => {
    const blur = validateEffectConfig('{"effect":"blur"}');
    assert.deepEqual(blur, {
        effect: 'blur',
        knobs: {
            intervalMs: 50, background: null, foreground: null,
            clock: {visible: false, format24h: true, seconds: true, date: true, align: 'center', topRatio: 0.14,
                offsetY: 0, fontSize: 64, dateFontSize: 20, monitor: 'settings'},
            radius: 20, brightness: 1,
        },
    });
    assert.throws(() => validateEffectConfig('globalThis.presetExecuted = true'), /not valid JSON/);
    assert.equal(globalThis.presetExecuted, undefined);
});

test('top-level shape, effect names, knobs and unknown keys are checked strictly', () => {
    for (const config of [null, [], true, {}, {effect: ['blur']}, {effect: 'clock'}, {effect: '__proto__'},
        {effect: 'blur', script: 'x'}, {effect: 'blur', knobs: null}, {effect: 'blur', knobs: []},
        {effect: 'blur', knobs: {fontSize: 10}}, {effect: 'neo-rain', knobs: {radius: 2}}])
        assert.throws(() => validateEffectConfig(JSON.stringify(config)));
    assert.throws(() => validateEffectConfig({effect: 'blur'}), /JSON text/);
    assert.throws(() => validateEffectConfig('{"effect":"blur","knobs":{"__proto__":{}}}'), /Unknown/);
});

test('numeric configuration rejects invalid bounds and fractions where integers are required', () => {
    const invalid = {
        blur: [{intervalMs: 32}, {intervalMs: 1001}, {intervalMs: 33.5}, {radius: -1}, {radius: 101}, {brightness: 1.01}, {brightness: '0.5'}],
        'neo-rain': [{fontSize: 7}, {fontSize: 16.5}, {density: -0.1}, {maxDrops: 9}, {speedMin: 0.04},
            {speedMax: 3.01}, {lengthMin: 0}, {lengthMax: 101}, {lengthMin: 1.5}, {fadeAlpha: 0},
            {speedMin: 2, speedMax: 1}, {lengthMin: 50, lengthMax: 40}],
        'city-grow': [{scale: 17}, {startBranches: 0}, {lineWidth: 0.24}, {fillAlpha: 1.1},
            {reversePoints: 513}, {restartDelayMs: -1}, {branchSpeedMultiplier: 0.09}, {scale: 1.5}],
    };
    for (const [effect, cases] of Object.entries(invalid)) {
        for (const knobs of cases)
            assert.throws(() => validateEffectConfig(JSON.stringify({effect, knobs})));
    }
    assert.equal(validateEffectConfig('{"effect":"blur","knobs":{"radius":0.5,"brightness":0,"intervalMs":33}}').knobs.radius, 0.5);
    assert.equal(validateEffectConfig('{"effect":"city-grow","knobs":{"lineWidth":0.25,"restartDelayMs":30000}}').knobs.restartDelayMs, 30000);
    assert.throws(() => validateEffectConfig('{"effect":"blur","knobs":{"radius":1e400}}'), /radius/);
});

test('color palettes use typed byte RGBA arrays and permit theme defaults', () => {
    const knobs = {background: [0, 128, 255, 0], foreground: [255, 0, 64, 255], palette: [[0, 0, 0, 255]]};
    assert.deepEqual(validateEffectConfig(JSON.stringify({effect: 'city-grow', knobs})).knobs.palette, knobs.palette);
    for (const value of ['red', [0, 0, 0], [0, 0, 0, 256], [0, 0, 0, -1], [0, 0, 0, 1.5], [true, 0, 0, 255]])
        assert.throws(() => validateEffectConfig(JSON.stringify({effect: 'blur', knobs: {foreground: value}})));
    for (const palette of [[], [[0, 0, 0, 255], [1, 2, 3]], Array(17).fill([0, 0, 0, 255]), 'red'])
        assert.throws(() => validateEffectConfig(JSON.stringify({effect: 'city-grow', knobs: {palette}})));
    assert.equal(validateEffectConfig('{"effect":"city-grow","knobs":{"palette":null}}').knobs.palette, null);
});

test('rain text uses Unicode codepoint limits and flags remain booleans', () => {
    const defaultCharacters = validateEffectConfig('{"effect":"neo-rain"}').knobs.characters;
    assert.equal(defaultCharacters.length, 66);
    assert.equal(defaultCharacters.codePointAt(0), 0xff66);
    assert.equal(defaultCharacters.codePointAt(55), 0xff9d);
    assert.equal(defaultCharacters.slice(56), '0123456789');
    assert.ok([...defaultCharacters.slice(0, 56)].every((character, index) => character.codePointAt(0) === 0xff66 + index));
    const rain = validateEffectConfig(JSON.stringify({effect: 'neo-rain', knobs: {characters: '🔒'.repeat(256), fontFamily: 'monospace'}}));
    assert.equal([...rain.knobs.characters].length, 256);
    for (const characters of ['', 'x\n', 'x\r', 'x\0', '\ud800', '\udfff', '🔒'.repeat(257), 5])
        assert.throws(() => validateEffectConfig(JSON.stringify({effect: 'neo-rain', knobs: {characters}})));
    for (const fontFamily of ['', ' ', 'x\n', 'x\r', 'x\0', '\ud800', '\udfff', 'x'.repeat(129), 5])
        assert.throws(() => validateEffectConfig(JSON.stringify({effect: 'neo-rain', knobs: {fontFamily}})));
    assert.equal(validateEffectConfig('{"effect":"neo-rain","knobs":{"fontFamily":"🔒 Font"}}').knobs.fontFamily, '🔒 Font');
    for (const knobs of [{fillBlocks: 1}, {reverse: 'true'}])
        assert.throws(() => validateEffectConfig(JSON.stringify({effect: 'city-grow', knobs})));
});

test('clock normalization validates every positioning, format and monitor field', () => {
    const clock = {visible: true, format24h: false, seconds: false, date: false, align: 'right', topRatio: 1,
        offsetY: -2147483648, fontSize: 160, dateFontSize: 64, monitor: '12'};
    assert.deepEqual(validateEffectConfig(JSON.stringify({effect: 'blur', knobs: {clock}})).knobs.clock, clock);
    for (const invalid of [null, [], {visible: 1}, {format24h: 'false'}, {seconds: null}, {date: 0}, {align: 'middle'},
        {topRatio: -0.01}, {topRatio: 1.01}, {offsetY: 2147483648}, {offsetY: 0.5}, {fontSize: 7},
        {dateFontSize: 65}, {monitor: 0}, {monitor: '-1'}, {monitor: 'primary'}, {extra: true}])
        assert.throws(() => validateEffectConfig(JSON.stringify({effect: 'blur', knobs: {clock: invalid}})));
    for (const monitor of ['settings', 'all', '0'])
        assert.equal(validateEffectConfig(JSON.stringify({effect: 'blur', knobs: {clock: {monitor}}})).knobs.clock.monitor, monitor);
    assert.equal(validateEffectConfig('{"effect":"neo-rain","knobs":{"clock":{"visible":true}}}').knobs.clock.fontSize, 64);
});
