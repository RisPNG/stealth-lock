import assert from 'node:assert/strict';
import test from 'node:test';

import {validateEffectConfig} from '../../presets.js';
import {loadModule} from './harness.js';

async function fixture(overrides = {}, {width = 120, height = 96, random} = {}) {
    let seed = 1234567;
    const math = Object.create(Math);
    math.random = random ?? (() => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 4294967296;
    });
    const {CityGrowth} = await loadModule('city.js', {'cairo': {default: {Operator: {SOURCE: 1}}}}, {Math: math});
    const knobs = validateEffectConfig(JSON.stringify({effect: 'city-grow', knobs: overrides})).knobs;
    const scene = new CityGrowth(width, height, knobs);
    const operations = [];
    const colors = {background: [0.05, 0.05, 0.05, 1], palette: [[0.2, 0.9, 1, 0.7], [1, 0.3, 0.1, 1]]};
    const context = {
        color: [], line: [], rectangleData: [], lineWidth: 0, operator: 2, savedStates: [],
        save() { this.savedStates.push({color: [...this.color], lineWidth: this.lineWidth, operator: this.operator}); },
        restore() { Object.assign(this, this.savedStates.pop()); },
        setOperator(operator) { this.operator = operator; },
        setSourceRGBA(...rgba) { this.color = rgba; },
        setLineWidth(width) { this.lineWidth = width; },
        rectangle(...values) { this.rectangleData = values; },
        fill() { operations.push({type: 'RECT', values: [...this.rectangleData], color: [...this.color], operator: this.operator}); },
        moveTo(x, y) { this.line = [x, y]; },
        lineTo(x, y) { this.line.push(x, y); },
        stroke() { operations.push({type: 'LINE', values: [...this.line], color: [...this.color], lineWidth: this.lineWidth, operator: this.operator}); },
        paint() { operations.push({type: 'PAINT', color: [...this.color], operator: this.operator}); },
    };
    return {scene, context, colors, operations, math};
}

test('initialization claims distinct seed cells and caps seeds to available grid cells', async () => {
    const {scene, context, colors, operations} = await fixture({startBranches: 32}, {width: 12, height: 12, random: () => 0});
    assert.equal(scene.cells.length, 4);
    assert.equal(scene.branchList.length, 0);
    scene.advance(context, colors, 1000);
    assert.equal(scene.branchList.length, 4);
    assert.equal(new Set(scene.branchList.map(branch => branch.pos.y * scene.cols + branch.pos.x)).size, 4);
    assert.equal(scene.cells.reduce((sum, occupied) => sum + occupied, 0), 4);
    assert.deepEqual(operations, [{type: 'PAINT', color: colors.background, operator: 1}]);
    assert.equal(context.operator, 2);
});

test('free neighbors stay inside the grid and exclude occupied cells', async () => {
    const {scene} = await fixture({scale: 1}, {width: 6, height: 6});
    assert.deepEqual(Array.from(scene.freeNeighbors({x: 1, y: 1}), p => [p.x, p.y]), [[2, 1], [0, 1], [1, 2], [1, 0]]);
    scene.cells[1 * scene.cols + 2] = 1;
    assert.equal(scene.freeNeighbors({x: 1, y: 1}).length, 3);
    assert.deepEqual(Array.from(scene.freeNeighbors({x: 0, y: 0}), p => [p.x, p.y]), [[1, 0], [0, 1]]);
});

test('growth never revisits a claimed destination and keeps history bounded by grid size', async () => {
    const {scene, context, colors, operations} = await fixture();
    scene.advance(context, colors, 1000);
    const claimed = new Set(scene.branchList.map(branch => branch.pos.y * scene.cols + branch.pos.x));
    let checked = operations.length;
    for (let frames = 0; frames < 5000 && !scene.reverseRunning; frames++) {
        scene.advance(context, colors, 1000);
        for (const operation of operations.slice(checked).filter(operation => operation.type === 'LINE')) {
            const x = Math.round((operation.values[2] - scene.knobs.lineWidth / 2) / scene.gridStep);
            const y = Math.round((operation.values[3] - scene.knobs.lineWidth / 2) / scene.gridStep);
            const destination = y * scene.cols + x;
            assert.equal(claimed.has(destination), false, `City path collided at ${x},${y}`);
            assert.ok(x >= 0 && x < scene.cols && y >= 0 && y < scene.rows);
            claimed.add(destination);
        }
        checked = operations.length;
    }
    assert.equal(scene.reverseRunning, true, 'Growth did not terminate on a finite grid');
    assert.equal(scene.branchList.length, 0);
    assert.equal(scene.cells.reduce((sum, occupied) => sum + occupied, 0), claimed.size);
    assert.ok(claimed.size <= scene.cells.length);
    assert.ok(scene.allBranches.length <= scene.cells.length);
    assert.ok(scene.allBranches.reduce((sum, branch) => sum + branch.history.length, 0) <= scene.cells.length * 3);
});

test('a trapped tip backtracks to its own earlier frontier and stops when all frontiers are blocked', async () => {
    const {scene, context, colors} = await fixture({startBranches: 1});
    scene.advance(context, colors, 1000);
    const branch = scene.branchList[0];
    branch.ownFields = [{x: 1, y: 1}, {x: 2, y: 1}, {x: 3, y: 1}];
    branch.pos = branch.ownFields.at(-1);
    scene.cells.fill(1);
    scene.cells[2 * scene.cols + 1] = 0;
    const destination = branch.findNextMove();
    assert.deepEqual([destination.x, destination.y], [1, 2]);
    assert.deepEqual([branch.pos.x, branch.pos.y], [1, 1]);
    scene.cells.fill(1);
    assert.equal(branch.findNextMove(), null);
    assert.equal(branch.state, 'STOPPED');
});

test('land growth favors its expansion direction and returns to city when blocked or nearing expiry', async () => {
    const {scene, context, colors} = await fixture({startBranches: 1}, {random: () => 0.99});
    scene.advance(context, colors, 1000);
    const branch = scene.branchList[0];
    branch.pos = {x: 3, y: 3};
    branch.ownFields = [{...branch.pos}];
    scene.cells.fill(0);
    branch.mode = 'LAND';
    branch.expandDirection = {x: 1, y: 0};
    let destination = branch.findNextMove();
    assert.deepEqual([destination.x, destination.y], [4, 3]);
    scene.cells[3 * scene.cols + 4] = 1;
    branch.findNextMove();
    assert.equal(branch.mode, 'CITY');
    branch.mode = 'LAND';
    branch.lifeTime = 15;
    branch.age = 1;
    branch.findNextMove();
    assert.equal(branch.mode, 'CITY');
});

test('branching inherits the parent palette and jitter with shorter lifetime and lower brightness', async () => {
    const {scene, context, colors, operations} = await fixture({startBranches: 1, fillBlocks: false});
    scene.advance(context, colors, 1000);
    const parent = scene.branchList[0];
    parent.pos = {x: 3, y: 3};
    parent.ownFields = [{x: 2, y: 3}, {x: 3, y: 3}];
    parent.paletteIndex = 1;
    parent.jitter = 0.04;
    scene.cells.fill(0);
    scene.cells[3 * scene.cols + 3] = 1;
    const child = parent.branchOff(context, colors);
    assert.ok(child);
    assert.equal(child.paletteIndex, parent.paletteIndex);
    assert.equal(child.jitter, parent.jitter);
    assert.equal(child.brightness, 0.55);
    assert.equal(child.lifeTime, 15);
    assert.equal(scene.cells[child.pos.y * scene.cols + child.pos.x], 1);
    assert.equal(operations.filter(operation => operation.type === 'LINE').length, 1);
    parent.lifeTime = parent.age;
    parent.drawMove(context, colors);
    assert.equal(parent.state, 'STOPPED');
});

test('fast branches perform at most three growth steps per frame and bound carried work', async () => {
    const {scene, context, colors} = await fixture({startBranches: 1, branchSpeedMultiplier: 0.1, fillBlocks: false}, {random: () => 0.99});
    scene.advance(context, colors, 1000);
    const branch = scene.branchList[0];
    assert.ok(branch.speedFactor > 3);
    scene.advance(context, colors, 1000);
    assert.equal(branch.age, 3);
    assert.equal(branch.stepCarry, 4);
});

test('block and street drawing honor alpha, line width and bounded palette brightness', async () => {
    const {scene, context, colors, operations} = await fixture({startBranches: 1, fillAlpha: 0.5, lineWidth: 0.25});
    scene.advance(context, colors, 1000);
    const branch = scene.branchList[0];
    branch.pos = {x: 3, y: 3};
    branch.ownFields = [{...branch.pos}];
    branch.paletteIndex = 0;
    branch.jitter = 0.1;
    branch.drawSegment(context, colors, {x: 4, y: 3});
    const blocks = operations.filter(operation => operation.type === 'RECT');
    const streets = operations.filter(operation => operation.type === 'LINE');
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].color[3], 0.35);
    assert.equal(streets.length, 1);
    assert.equal(streets[0].color[3], 0.7);
    assert.equal(streets[0].lineWidth, 0.25);
    assert.ok(operations.every(operation => operation.color.every(component => component >= 0 && component <= 1)));
});

test('reversal removes history with a bounded frame budget and respects the restart delay', async () => {
    const {scene, context, colors, operations} = await fixture({reversePoints: 7}, {width: 60, height: 60});
    scene.advance(context, colors, 1000);
    for (let frames = 0; frames < 5000 && !scene.reverseRunning; frames++)
        scene.advance(context, colors, 1000);
    assert.equal(scene.reverseRunning, true);
    const branches = scene.allBranches.length;
    const before = scene.allBranches.reduce((sum, branch) => sum + branch.history.length, 0);
    assert.ok(before > 0);
    const drawStart = operations.length;
    scene.advance(context, colors, 1000);
    const after = scene.allBranches.reduce((sum, branch) => sum + branch.history.length, 0);
    assert.ok(after < before);
    assert.ok(before - after <= scene.knobs.reversePoints + branches);
    assert.ok(operations.slice(drawStart).every(operation => JSON.stringify(operation.color) === JSON.stringify(colors.background)));
    for (let frames = 0; frames < 5000 && scene.restartAtMs === null; frames++)
        scene.advance(context, colors, 1000);
    assert.equal(scene.restartAtMs, 2000);
    assert.equal(scene.allBranches.length, 0);
    const calls = operations.length;
    scene.advance(context, colors, 1999);
    assert.equal(operations.length, calls);
    scene.advance(context, colors, 2000);
    assert.equal(operations.at(-1).type, 'PAINT');
    assert.equal(scene.reverseRunning, false);
    assert.equal(scene.restartAtMs, null);
    assert.equal(scene.cells.reduce((sum, occupied) => sum + occupied, 0), 3);
});

test('disabled reversal retains no paint history and restarts directly after growth', async () => {
    const {scene, context, colors} = await fixture({reverse: false, restartDelayMs: 0}, {width: 60, height: 60});
    scene.advance(context, colors, 0);
    for (let frames = 0; frames < 5000 && scene.restartAtMs === null; frames++) {
        scene.advance(context, colors, 0);
        assert.ok(scene.branchList.every(branch => branch.history.length === 0));
        assert.equal(scene.allBranches.length, 0);
    }
    assert.equal(scene.reverseRunning, false);
    assert.equal(scene.restartAtMs, 0);
    scene.advance(context, colors, 0);
    assert.equal(scene.restartAtMs, null);
    assert.equal(scene.branchList.length, 3);
});

test('transparent background replaces pixels on reset and reversal, then restores normal compositing', async () => {
    const {scene, context, colors, operations} = await fixture({startBranches: 1}, {width: 30, height: 30});
    colors.background = [0.1, 0.2, 0.3, 0];
    scene.advance(context, colors, 1000);
    assert.equal(operations[0].type, 'PAINT');
    assert.equal(operations[0].operator, 1);
    assert.equal(operations[0].color[3], 0);
    assert.equal(context.operator, 2);
    assert.equal(context.savedStates.length, 0);
    for (let frames = 0; frames < 5000 && !scene.reverseRunning; frames++)
        scene.advance(context, colors, 1000);
    assert.equal(scene.reverseRunning, true);
    const reverseStart = operations.length;
    scene.advance(context, colors, 1000);
    const erased = operations.slice(reverseStart);
    assert.ok(erased.length > 0);
    assert.ok(erased.every(operation => operation.operator === 1 && operation.color[3] === 0));
    assert.equal(context.operator, 2);
    assert.equal(context.savedStates.length, 0);
});
