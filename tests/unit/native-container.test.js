import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const project = fileURLToPath(new URL('../..', import.meta.url));
const image = `registry.gitlab.gnome.org/gnome/mutter/fedora/39@sha256:${'a'.repeat(64)}`;

function createContainerFixture(t) {
    const directory = mkdtempSync(join(tmpdir(), 'stealth-lock-container-runner-'));
    t.after(() => rmSync(directory, {recursive: true, force: true}));
    const source = join(directory, 'source');
    const bin = join(directory, 'bin');
    const home = join(directory, 'home');
    const staging = join(directory, 'stealth-lock-container.MixedCASE');
    const log = join(directory, 'docker.jsonl');
    for (const path of [source, bin, home, join(source, 'tests'), join(source, 'tests/shell')])
        mkdirSync(path, {mode: 0o700});
    for (const file of ['run-container.sh', 'Containerfile'])
        copyFileSync(join(project, 'tests/shell', file), join(source, 'tests/shell', file));
    writeFileSync(join(source, 'committed.txt'), 'committed source');
    const env = {...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', PATH: `${bin}:${process.env.PATH}`,
        CONTAINER_STAGING: staging, DOCKER_LOG: log};
    execFileSync('git', ['init', '--quiet'], {cwd: source, env});
    execFileSync('git', ['add', '.'], {cwd: source, env});
    execFileSync('git', ['-c', 'user.name=Container Fixture', '-c', 'user.email=fixture@example.invalid',
        'commit', '--quiet', '-m', 'prepare container fixture'], {cwd: source, env});
    writeFileSync(join(source, 'untracked.txt'), 'untracked source');
    writeFileSync(join(bin, 'mktemp'), `#!/usr/bin/env bash
[[ "$*" == '-d /tmp/stealth-lock-container.XXXXXX' ]] || exit 99
mkdir -- "$CONTAINER_STAGING"
printf '%s\\n' "$CONTAINER_STAGING"
`, {mode: 0o755});
    writeFileSync(join(bin, 'docker'), `#!/usr/bin/python3
import json, os, pathlib, re, sys
arguments = sys.argv[1:]
record = {"arguments": arguments}
if arguments[0] == "build":
    record["source"] = sorted(str(path.relative_to(pathlib.Path(arguments[-1]) / "project")) for path in (pathlib.Path(arguments[-1]) / "project").rglob("*") if path.is_file())
with open(os.environ["DOCKER_LOG"], "a") as log:
    log.write(json.dumps(record) + "\\n")
if arguments[0] == "build":
    tag = arguments[arguments.index("--tag") + 1]
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]*:test", tag):
        print("repository name must be lowercase", file=sys.stderr)
        sys.exit(1)
    if os.environ.get("DOCKER_FAIL_BUILD") == "1":
        sys.exit(17)
`, {mode: 0o755});
    return {directory, source, staging, log, env, script: join(source, 'tests/shell/run-container.sh')};
}

test('the native runner accepts mixed-case temporary paths and cleans only its bounded container resources', t => {
    const {directory, staging, log, env, script} = createContainerFixture(t);
    const neighbor = join(directory, 'another-container');
    mkdirSync(neighbor);
    execFileSync('bash', [script, '45', image], {env});
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const identifier = 'stealth-lock-native-45-stealth-lock-container.mixedcase';
    assert.equal(calls[0].arguments[calls[0].arguments.indexOf('--tag') + 1], `${identifier}:test`);
    assert.deepEqual(calls[0].source, ['committed.txt', 'tests/shell/Containerfile', 'tests/shell/run-container.sh']);
    const launch = calls.find(call => call.arguments[0] === 'run').arguments;
    assert.equal(launch[launch.indexOf('--name') + 1], identifier);
    for (const bound of ['--memory=2g', '--cpus=2', '--pids-limit=600'])
        assert.ok(launch.includes(bound));
    assert.ok(calls.some(call => call.arguments[0] === 'exec' && call.arguments.includes('--user') && call.arguments.includes('1000')));
    assert.deepEqual(calls.slice(-2).map(call => call.arguments), [
        ['rm', '--force', identifier], ['image', 'rm', `${identifier}:test`],
    ]);
    assert.equal(existsSync(staging), false);
    assert.equal(existsSync(neighbor), true);
});

test('a failed native image build preserves its exit status and still cleans its own resources', t => {
    const {staging, log, env, script} = createContainerFixture(t);
    const result = spawnSync('bash', [script, '45', image], {env: {...env, DOCKER_FAIL_BUILD: '1'}, encoding: 'utf8'});
    assert.equal(result.status, 17);
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(calls.map(call => call.arguments[0]), ['build', 'rm', 'image']);
    assert.equal(existsSync(staging), false);
});

test('the native runner rejects unpinned images and unsupported versions before creating resources', t => {
    const {staging, log, env, script} = createContainerFixture(t);
    for (const arguments_ of [['44', image], ['45', 'registry.gitlab.gnome.org/gnome/mutter/fedora/39:latest']]) {
        const result = spawnSync('bash', [script, ...arguments_], {env, encoding: 'utf8'});
        assert.equal(result.status, 2);
        assert.match(result.stderr, /pinned-official-mutter-image/);
    }
    assert.equal(existsSync(staging), false);
    assert.equal(existsSync(log), false);
});
