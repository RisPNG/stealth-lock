import assert from 'node:assert/strict';
import test from 'node:test';

import {MAX_VISUAL_FRAME_PIXELS, MAX_VISUAL_SURFACE_PIXELS, validateVisualFrame} from '../../shared/visual-frame.js';

test('drawing data accepts only the documented operations and normalized native decorations', () => {
    const frame = {commands: [
        ['save'], ['setOperator', 'source'], ['setSourceRGBA', 0.1, 0.2, 0.3, 1], ['paint'],
        ['rectangle', -10, -20, 30, 40], ['fill'], ['setLineWidth', 2],
        ['moveTo', 0, 0], ['lineTo', 50, 50], ['stroke'], ['text', '🔒 hello', 0, 0, 16, 'monospace'], ['restore'],
    ], blur: {radius: 20.5, brightness: 0.8}, clock: {seconds: false, offsetY: -2147483648}};
    const result = validateVisualFrame(frame, 100, 100);
    assert.equal(result.commands, frame.commands);
    assert.equal(result.blur, frame.blur);
    assert.deepEqual(result.clock, {visible: true, format24h: true, seconds: false, date: true, align: 'center',
        topRatio: 0.14, offsetY: -2147483648, fontSize: 64, dateFontSize: 20, monitor: 'settings'});
});

test('unknown properties and method names cannot reach actor or arbitrary Cairo APIs', () => {
    for (const frame of [null, [], false, {}, {commands: [], blur: null},
        {commands: [], blur: null, clock: null, settings: {}},
        {commands: [['destroy']], blur: null, clock: null},
        {commands: [['$dispose']], blur: null, clock: null},
        {commands: [['__proto__']], blur: null, clock: null},
        {commands: [['setSourceSurface', 1]], blur: null, clock: null},
        {commands: [['paint', 1]], blur: null, clock: null},
        {commands: Array.from({length: 2049}, () => ['fill']), blur: null, clock: null}])
        assert.throws(() => validateVisualFrame(frame, 100, 100));
});

test('invalid coordinates colors operators and line widths are rejected as complete frames', () => {
    for (const command of [
        ['moveTo', Infinity, 0], ['lineTo', NaN, 0], ['rectangle', 0, 0, -1, 1],
        ['rectangle', 0, 0, 1, -1], ['moveTo', 131073, 0], ['lineTo', '1', 0],
        ['setSourceRGBA', -0.01, 0, 0, 1], ['setSourceRGBA', 0, 0, 0, 1.01],
        ['setLineWidth', 0], ['setLineWidth', 129], ['setOperator', 'xor'],
    ])
        assert.throws(() => validateVisualFrame({commands: [command], blur: null, clock: null}, 100, 100));
});

test('per-frame raster work combines paints fills strokes and font-sized glyphs', () => {
    for (const commands of [
        Array.from({length: 5}, () => ['paint']),
        [['rectangle', 0, 0, 5000, 5000], ['fill']],
        [...Array.from({length: 17}, () => ['rectangle', 0, 0, 1000, 1000]), ['fill']],
        [['text', 'x'.repeat(256), 0, 0, 128, 'monospace'], ['text', 'x', 0, 0, 128, 'monospace']],
        Array.from({length: 17}, () => ['text', 'x'.repeat(256), 0, 0, 16, 'monospace']),
        [['restore']], [['save']],
        [...Array.from({length: 33}, () => ['save']), ...Array.from({length: 33}, () => ['restore'])],
    ])
        assert.throws(() => validateVisualFrame({commands, blur: null, clock: null}, 100, 100));
    assert.doesNotThrow(() => validateVisualFrame({commands: [
        ...Array.from({length: 32}, () => ['save']), ...Array.from({length: 32}, () => ['restore']),
        ...Array.from({length: 4}, () => ['paint']),
    ], blur: null, clock: null}, 100, 100));
});

test('wide diagonal strokes cannot bypass the aggregate raster budget', () => {
    const commands = [['setSourceRGBA', 1, 1, 1, 0.5], ['setLineWidth', 128]];
    for (let i = 0; i < 682; i++)
        commands.push(['moveTo', 0, 0], ['lineTo', 1920, 1080], ['stroke']);
    assert.equal(commands.length, 2048);
    assert.throws(() => validateVisualFrame({commands, blur: null, clock: null}, 1920, 1080), /raster work/u);
    commands[1][1] = 2;
    assert.doesNotThrow(() => validateVisualFrame({commands, blur: null, clock: null}, 1920, 1080));
});

test('fill coverage is charged for polygons and repeated subpaths without rectangle commands', () => {
    const commands = [];
    for (let i = 0; i < 10; i++) {
        commands.push(['moveTo', 0, 0], ['lineTo', 1920, 0], ['lineTo', 1920, 1080],
            ['lineTo', 0, 1080], ['fill']);
    }
    assert.throws(() => validateVisualFrame({commands, blur: null, clock: null}, 1920, 1080), /raster work/u);
    assert.throws(() => validateVisualFrame({commands: [['moveTo', -131072, -131072],
        ['lineTo', 131072, -131072], ['lineTo', 131072, 131072], ['fill']], blur: null, clock: null}, 100, 100), /raster work/u);
});

test('line widths persist across frames and follow native save restore without saving paths', () => {
    const wide = validateVisualFrame({commands: [['setLineWidth', 128]], blur: null, clock: null}, 1920, 1080);
    const commands = Array.from({length: 100}, () => [['moveTo', 0, 0], ['lineTo', 1920, 1080], ['stroke']]).flat();
    assert.doesNotThrow(() => validateVisualFrame({commands, blur: null, clock: null}, 1920, 1080));
    assert.throws(() => validateVisualFrame({commands, blur: null, clock: null}, 1920, 1080, {lineWidth: wide.lineWidth}), /raster work/u);
    const restored = validateVisualFrame({commands: [['save'], ['setLineWidth', 128], ['moveTo', 0, 0],
        ['lineTo', 1920, 1080], ['restore'], ['stroke']], blur: null, clock: null}, 1920, 1080);
    assert.equal(restored.lineWidth, 2);
    const narrow = validateVisualFrame({commands: [['setLineWidth', 1], ['save'], ['setLineWidth', 128],
        ['restore']], blur: null, clock: null}, 1920, 1080, {lineWidth: wide.lineWidth});
    assert.equal(narrow.lineWidth, 1);
});

test('compound rectangle fills remain available while complex intersecting polygons are bounded', () => {
    const rectangles = Array.from({length: 400}, (_, index) => ['rectangle', index % 40 * 20, Math.floor(index / 40) * 20, 12, 20]);
    assert.doesNotThrow(() => validateVisualFrame({commands: [...rectangles, ['fill']], blur: null, clock: null}, 1920, 1080));
    const complex = [['moveTo', 0, 0], ...Array.from({length: 129}, (_, index) => ['lineTo', index % 2, index % 3]), ['fill']];
    assert.throws(() => validateVisualFrame({commands: complex, blur: null, clock: null}, 1920, 1080), /complexity/u);
    const scattered = Array.from({length: 9}, () => [['moveTo', 0, 0],
        ...Array.from({length: 128}, (_, index) => ['lineTo', index % 2, index % 3]), ['stroke']]).flat();
    assert.throws(() => validateVisualFrame({commands: scattered, blur: null, clock: null}, 1920, 1080), /complexity/u);
});

test('raster budgets use fixed effective pixels on large desktops and charge shared paint text work', () => {
    assert.equal(MAX_VISUAL_SURFACE_PIXELS, 4194304);
    assert.equal(MAX_VISUAL_FRAME_PIXELS, 16777216);
    assert.doesNotThrow(() => validateVisualFrame({commands: [['paint'], ['paint'], ['paint'],
        ['text', 'x'.repeat(256), 0, 0, 16, 'monospace']], blur: null, clock: null}, 16000, 10000));
    assert.throws(() => validateVisualFrame({commands: [['paint'], ['paint'], ['paint'], ['paint'],
        ['text', 'x', 0, 0, 16, 'monospace']], blur: null, clock: null}, 2048, 2048), /raster work/u);
});

test('font families stay bounded across the entire effect lifetime', () => {
    let fontFamilies = [];
    for (let index = 0; index < 4; index++) {
        const frame = validateVisualFrame({commands: [['text', 'x', 0, 0, 1, `missing-font-${index}`]],
            blur: null, clock: null}, 1920, 1080, {fontFamilies});
        fontFamilies = frame.fontFamilies;
    }
    assert.throws(() => validateVisualFrame({commands: [['text', 'x', 0, 0, 1, 'missing-font-4']],
        blur: null, clock: null}, 1920, 1080, {fontFamilies}), /font family/u);
});

test('text operations and fresh native layout creation are bounded independently of glyph size', () => {
    assert.throws(() => validateVisualFrame({commands: Array.from({length: 513}, () => ['text', 'x', 0, 0, 1, 'monospace']),
        blur: null, clock: null}, 1920, 1080), /text operation/u);
    assert.throws(() => validateVisualFrame({commands: Array.from({length: 129}, (_, index) =>
        ['text', String.fromCodePoint(0x4e00 + index), 0, 0, 1, 'monospace']), blur: null, clock: null}, 1920, 1080), /new text layout/u);
    assert.doesNotThrow(() => validateVisualFrame({commands: Array.from({length: 512}, () => ['text', 'x', 0, 0, 1, 'monospace']),
        blur: null, clock: null}, 1920, 1080));
});

test('new layout accounting models native FIFO eviction and cascading cache misses', () => {
    const glyphs = Array.from({length: 512}, (_, index) => JSON.stringify([String(index), 1, 'monospace']));
    const commands = [['text', 'new', 0, 0, 1, 'monospace'], ...Array.from({length: 128}, (_, index) =>
        ['text', String(index), 0, 0, 1, 'monospace'])];
    assert.throws(() => validateVisualFrame({commands, blur: null, clock: null}, 1920, 1080, {glyphs}), /new text layout/u);
    assert.doesNotThrow(() => validateVisualFrame({commands: Array.from({length: 256}, (_, index) =>
        ['text', String(index), 0, 0, 1, 'monospace']), blur: null, clock: null}, 1920, 1080, {glyphs}));
});

test('Pango text and fonts contain bounded valid Unicode and finite positioning', () => {
    for (const command of [
        ['text', 'x'.repeat(257), 0, 0, 16, 'monospace'], ['text', '\0', 0, 0, 16, 'monospace'],
        ['text', '\ud800', 0, 0, 16, 'monospace'], ['text', 'hello', 201, 0, 16, 'monospace'],
        ['text', 'hello', 0, -201, 16, 'monospace'], ['text', 'hello', 0, 0, 0, 'monospace'],
        ['text', 'hello', 0, 0, 129, 'monospace'], ['text', 'hello', 0, 0, 16, 'x'.repeat(129)],
        ['text', 'hello', 0, 0, 16, '\0'], ['text', 'hello', 0, 0, 16, 'mono\nspace'],
        ['text', 'hello', 0, 0, 16, 'missing-one,missing-two'],
        ['text', 123, 0, 0, 16, 'monospace'],
    ])
        assert.throws(() => validateVisualFrame({commands: [command], blur: null, clock: null}, 100, 100));
});

test('blur parameters cannot select other Shell effects or exceed the audited native ranges', () => {
    for (const blur of [undefined, false, [], {}, {radius: -1, brightness: 1}, {radius: 101, brightness: 1},
        {radius: 20, brightness: 1.01}, {radius: 20, brightness: -1}, {radius: '20', brightness: 1},
        {radius: 20, brightness: 1, mode: 'all'}, {radius: NaN, brightness: 1}])
        assert.throws(() => validateVisualFrame({commands: [], blur, clock: null}, 100, 100));
});

test('clock fields validate documented formats positioning and signed int32 offsets', () => {
    const valid = {visible: false, format24h: false, seconds: false, date: false, align: 'right',
        topRatio: 1, offsetY: 2147483647, fontSize: 160, dateFontSize: 64, monitor: '1'};
    assert.deepEqual(validateVisualFrame({commands: [], blur: null, clock: valid}, 100, 100).clock, valid);
    for (const monitor of ['all', 'settings', '0', '512', 'DP-1', 'HDMI-A-1', 'eDP-1'])
        assert.equal(validateVisualFrame({commands: [], blur: null, clock: {monitor}}, 100, 100).clock.monitor, monitor);
    for (const clock of [undefined, false, [], {unknown: true}, {visible: 'true'}, {seconds: 1}, {date: null},
        {align: 'bottom'}, {monitor: 1}, {monitor: '-1'}, {monitor: 'DP-1\n'}, {monitor: 'x'.repeat(129)},
        {topRatio: -1}, {topRatio: 1.01},
        {offsetY: -2147483649}, {offsetY: 2147483648}, {offsetY: 0.5}, {fontSize: 7},
        {fontSize: 161}, {dateFontSize: 7}, {dateFontSize: 65}])
        assert.throws(() => validateVisualFrame({commands: [], blur: null, clock}, 100, 100));
});
