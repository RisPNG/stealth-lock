import assert from 'node:assert/strict';
import test from 'node:test';

import {loadModule} from './harness.js';

const filename = 'tests/unit/fixtures/module.js';

test('native ESM loads unchanged multiline imports, aliases and re-exports with mocked dependencies', async () => {
    const transform = value => value * 2;
    const module = await loadModule(filename, {'./dependency.js': {default: transform, value: 7}});
    assert.equal(module.calculated, 14);
    assert.equal(module.forwarded, 7);
    assert.equal(module.value, 7);
    assert.equal(module.namespace.value, 7);
    assert.equal(module.default, module.namespace);
    assert.equal(module.namespace.default, transform);
    assert.equal(module.source, new URL('./fixtures/module.js', import.meta.url).href);
});

test('each module execution has an isolated context while honoring supplied globals', async () => {
    const dependencies = {'./dependency.js': {default: value => value, value: 1}};
    const first = await loadModule(filename, dependencies, {fixtureRuns: 10});
    const second = await loadModule(filename, dependencies);
    assert.equal(first.executions, 11);
    assert.equal(second.executions, 1);
    assert.equal(globalThis.fixtureRuns, undefined);
});

test('the module linker rejects undeclared dependencies instead of loading their real files', async () => {
    await assert.rejects(loadModule(filename, {}), /Unexpected dependency: \.\/dependency\.js/);
    await assert.rejects(loadModule(filename, Object.create({'./dependency.js': {default: () => 1, value: 1}})),
        /Unexpected dependency: \.\/dependency\.js/);
    await assert.rejects(loadModule(filename, {'./dependency.js': {default: () => 1}}),
        /does not provide an export named 'value'/);
});
