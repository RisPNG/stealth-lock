import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const project = fileURLToPath(new URL('../..', import.meta.url));

function createCurlReleaseFixture(t, {version = '1.0.1', ref = 'refs/heads/main'} = {}) {
    const directory = mkdtempSync(join(tmpdir(), 'stealth-lock-curl-release-'));
    const source = join(directory, 'source');
    const bundle = join(directory, 'bundle');
    const bin = join(directory, 'bin');
    const releases = join(directory, 'releases');
    for (const path of [source, bin, releases, join(source, 'scripts')])
        mkdirSync(path);
    t.after(() => rmSync(directory, {recursive: true, force: true}));
    for (const name of ['release.sh', 'build-release.sh', 'publish-release.sh'])
        copyFileSync(join(project, 'scripts', name), join(source, 'scripts', name));
    writeFileSync(join(source, 'metadata.json'), JSON.stringify({'version-name': version}));
    writeFileSync(join(source, 'install.sh'), '#!/usr/bin/env bash\necho install fixture\n');
    writeFileSync(join(source, 'uninstall.sh'), '#!/usr/bin/env bash\necho uninstall fixture\n');
    writeFileSync(join(source, '.gitignore'), 'private\n');
    const env = {...process.env, GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_DATE: '2026-10-09T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-09T00:00:00Z',
        GITHUB_REPOSITORY: 'RisPNG/stealth-lock', GITHUB_REF: ref, DEFAULT_BRANCH: 'main',
        GITHUB_OUTPUT: join(directory, 'outputs')};
    execFileSync('git', ['init', '--quiet'], {cwd: source, env});
    execFileSync('git', ['add', '.'], {cwd: source, env});
    execFileSync('git', ['-c', 'user.name=Release Fixture', '-c', 'user.email=fixture@example.invalid',
        'commit', '--quiet', '-m', 'prepare release fixture'], {cwd: source, env});
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: source, env, encoding: 'utf8'}).trim();
    Object.assign(env, {GITHUB_SHA: commit, BUILD_COMMIT: commit});
    return {directory, source, bundle, bin, releases, commit, env, build: join(source, 'scripts/build-release.sh'),
        publish: join(source, 'scripts/publish-release.sh')};
}

function createPublicationFixture(t, options) {
    const fixture = createCurlReleaseFixture(t, options);
    const {directory, releases, bundle, bin, commit, env, build} = fixture;
    execFileSync('bash', [build, bundle], {env, stdio: 'pipe'});
    const state = join(directory, 'state.json');
    writeFileSync(state, JSON.stringify({releases: {}, gitRefs: {}, calls: [], commit, remoteChecks: 0, advanceOnCheck: null}));
    Object.assign(env, {PATH: `${bin}:${env.PATH}`, RELEASE_STATE: state, RELEASE_DIRECTORY: releases});
    writeFileSync(join(bin, 'git'), `#!${process.execPath}
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.env.RELEASE_STATE));
if (process.argv[2] !== 'ls-remote') process.exit(2);
state.remoteChecks++;
fs.writeFileSync(process.env.RELEASE_STATE, JSON.stringify(state));
const commit = state.advanceOnCheck && state.remoteChecks >= state.advanceOnCheck ? 'f'.repeat(40) : state.commit;
process.stdout.write(commit + '\\t' + process.env.GITHUB_REF + '\\n');
`, {mode: 0o755});
    writeFileSync(join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.RELEASE_STATE));
state.calls.push(args);
fs.writeFileSync(process.env.RELEASE_STATE, JSON.stringify(state));
if (args[0] === 'api') {
    const tag = args[3].split('/').at(-1);
    if (!state.gitRefs[tag]) process.exit(1);
    state.gitRefs[tag] = args[args.indexOf('-f') + 1].slice(4);
    fs.writeFileSync(process.env.RELEASE_STATE, JSON.stringify(state));
    process.exit(0);
}
if (args[0] !== 'release') process.exit(2);
const tag = args[2];
const folder = path.join(process.env.RELEASE_DIRECTORY, tag);
const release = state.releases[tag];
if (args[1] === 'view') {
    if (!release) process.exit(1);
    const names = fs.readdirSync(folder);
    if (args.includes('--jq')) {
        process.stdout.write(names.filter(name => /^stealth-lock-.*\\.tar\\.gz$/.test(name)).join('\\n') + '\\n');
    } else {
        process.stdout.write(JSON.stringify({...release, assets: names.map(name => ({name}))}));
    }
} else if (args[1] === 'create') {
    if (release) process.exit(1);
    fs.mkdirSync(folder);
    state.releases[tag] = {isDraft: args.includes('--draft'), isPrerelease: args.includes('--prerelease')};
} else if (args[1] === 'upload') {
    if (!release) process.exit(1);
    for (const source of args.slice(3).filter(arg => arg.startsWith('/'))) {
        const target = path.join(folder, path.basename(source));
        if (fs.existsSync(target) && !args.includes('--clobber')) process.exit(1);
        fs.copyFileSync(source, target);
    }
} else if (args[1] === 'download') {
    if (!release) process.exit(1);
    const target = args[args.indexOf('--dir') + 1];
    for (let index = 3; index < args.length; index++) {
        if (args[index] === '--pattern') {
            const name = args[++index];
            if (!fs.existsSync(path.join(folder, name))) process.exit(1);
            fs.copyFileSync(path.join(folder, name), path.join(target, name));
        }
    }
} else if (args[1] === 'edit') {
    if (!release) process.exit(1);
    if (args.includes('--draft=false')) {
        release.isDraft = false;
        state.gitRefs[tag] ??= args.includes('--target') ? args[args.indexOf('--target') + 1] : state.commit;
    }
    if (args.includes('--prerelease=false')) release.isPrerelease = false;
    if (args.includes('--prerelease')) release.isPrerelease = true;
} else if (args[1] === 'delete-asset') {
    fs.unlinkSync(path.join(folder, args[3]));
} else process.exit(2);
fs.writeFileSync(process.env.RELEASE_STATE, JSON.stringify(state));
`, {mode: 0o755});
    return {...fixture, state};
}

test('curl bundles contain reproducible committed source and a complete checksum manifest', t => {
    const {directory, source, bundle, commit, env, build} = createCurlReleaseFixture(t);
    writeFileSync(join(source, 'private'), 'private source notes');
    execFileSync('bash', [build, bundle], {env, stdio: 'pipe'});
    const record = JSON.parse(readFileSync(join(bundle, 'build.json'), 'utf8'));
    const archive = `stealth-lock-${commit}.tar.gz`;
    assert.deepEqual(record, {schema: 1, repository: 'RisPNG/stealth-lock', commit, ref: 'refs/heads/main', tag: '', version: '1.0.1',
        source: {file: archive, sha256: createHash('sha256').update(readFileSync(join(bundle, archive))).digest('hex'),
            bytes: readFileSync(join(bundle, archive)).length}});
    assert.deepEqual(readdirSync(bundle).sort(), ['SHA256SUMS', 'build.json', 'install.sh', archive, 'uninstall.sh'].sort());
    execFileSync('sha256sum', ['--check', 'SHA256SUMS'], {cwd: bundle});
    const entries = execFileSync('tar', ['-tzf', join(bundle, archive)], {encoding: 'utf8'});
    assert.match(entries, /stealth-lock-1\.0\.1\/install\.sh/);
    assert.doesNotMatch(entries, /private|\.git\//);
    const second = join(directory, 'second');
    execFileSync('bash', [build, second], {env, stdio: 'pipe'});
    for (const name of readdirSync(bundle))
        assert.deepEqual(readFileSync(join(second, name)), readFileSync(join(bundle, name)), name);
});

test('stable bundles require strict version tags, matching metadata and the exact clean commit', t => {
    const {source, bundle, env, build} = createCurlReleaseFixture(t, {ref: 'refs/tags/1.0.1'});
    execFileSync('bash', [build, bundle], {env, stdio: 'pipe'});
    assert.equal(JSON.parse(readFileSync(join(bundle, 'build.json'))).tag, '1.0.1');
    for (const ref of ['refs/tags/v1.0.1', 'refs/tags/01.0.1', 'refs/tags/1.0.1-rc.1', 'refs/tags/1.0.2', 'refs/heads/feature']) {
        const rejected = spawnSync('bash', [build, bundle], {env: {...env, GITHUB_REF: ref}, encoding: 'utf8'});
        assert.equal(rejected.status, 1, ref);
    }
    const wrongCommit = spawnSync('bash', [build, bundle], {env: {...env, GITHUB_SHA: 'f'.repeat(40)}, encoding: 'utf8'});
    assert.notEqual(wrongCommit.status, 0);
    writeFileSync(join(source, 'install.sh'), 'uncommitted installer\n');
    const dirty = spawnSync('bash', [build, bundle], {env, encoding: 'utf8'});
    assert.equal(dirty.status, 1);
    assert.match(dirty.stderr, /Commit the source changes/);
});

test('publication rejects altered bundle assets before any remote operations', t => {
    const {bundle, state, env, publish} = createPublicationFixture(t);
    writeFileSync(join(bundle, 'install.sh'), 'altered installer');
    const rejected = spawnSync('bash', [publish, bundle], {env, encoding: 'utf8'});
    assert.notEqual(rejected.status, 0);
    assert.deepEqual(JSON.parse(readFileSync(state)).calls, []);
    assert.equal(JSON.parse(readFileSync(state)).remoteChecks, 0);
});

test('development publication updates the manifest last and skips obsolete commits', t => {
    const {bundle, releases, state, commit, env, publish} = createPublicationFixture(t);
    const initial = JSON.parse(readFileSync(state));
    initial.advanceOnCheck = 1;
    writeFileSync(state, JSON.stringify(initial));
    execFileSync('bash', [publish, bundle], {env, stdio: 'pipe'});
    assert.deepEqual(JSON.parse(readFileSync(state)).calls, []);
    initial.advanceOnCheck = null;
    initial.remoteChecks = 0;
    writeFileSync(state, JSON.stringify(initial));
    execFileSync('bash', [publish, bundle], {env, stdio: 'pipe'});
    const published = JSON.parse(readFileSync(state));
    assert.equal(published.releases['latest-build'].isPrerelease, true);
    assert.equal(published.releases['latest-build'].isDraft, false);
    assert.equal(published.gitRefs['latest-build'], commit);
    assert.ok(published.calls.findIndex(call => call[1] === 'edit') < published.calls.findIndex(call => call[0] === 'api'));
    const uploads = published.calls.filter(call => call[1] === 'upload');
    assert.equal(uploads[0][3], join(bundle, `stealth-lock-${commit}.tar.gz`));
    assert.equal(uploads.at(-1)[3], join(bundle, 'build.json'));
    assert.deepEqual(readFileSync(join(releases, 'latest-build/build.json')), readFileSync(join(bundle, 'build.json')));
});

test('a default-branch advance during publication keeps the existing alias manifest', t => {
    const {bundle, releases, state, env, publish} = createPublicationFixture(t);
    const initial = JSON.parse(readFileSync(state));
    initial.advanceOnCheck = 2;
    initial.releases['latest-build'] = {isDraft: false, isPrerelease: true};
    mkdirSync(join(releases, 'latest-build'));
    writeFileSync(join(releases, 'latest-build/build.json'), 'previous manifest');
    writeFileSync(state, JSON.stringify(initial));
    execFileSync('bash', [publish, bundle], {env, stdio: 'pipe'});
    assert.equal(readFileSync(join(releases, 'latest-build/build.json'), 'utf8'), 'previous manifest');
    const uploads = JSON.parse(readFileSync(state)).calls.filter(call => call[1] === 'upload');
    assert.equal(uploads.length, 1);
});

test('stable publication preserves original assets across retries and repairs its alias', t => {
    const {bundle, releases, state, env, publish} = createPublicationFixture(t, {ref: 'refs/tags/1.0.1'});
    execFileSync('bash', [publish, bundle], {env, stdio: 'pipe'});
    const original = readFileSync(join(releases, '1.0.1/build.json'));
    const initial = JSON.parse(readFileSync(state));
    initial.calls = [];
    writeFileSync(state, JSON.stringify(initial));
    rmSync(join(releases, 'latest-release/install.sh'));
    execFileSync('bash', [publish, bundle], {env, stdio: 'pipe'});
    const published = JSON.parse(readFileSync(state));
    assert.ok(published.calls.filter(call => call[1] === 'upload').every(call => call[2] === 'latest-release'));
    assert.deepEqual(readFileSync(join(releases, '1.0.1/build.json')), original);
    assert.ok(existsSync(join(releases, 'latest-release/install.sh')));
    assert.equal(published.releases['latest-release'].isPrerelease, false);
});

test('an older stable version receives its own release without rolling back the stable alias', t => {
    const {bundle, releases, state, env, publish} = createPublicationFixture(t, {version: '1.9.0', ref: 'refs/tags/1.9.0'});
    const initial = JSON.parse(readFileSync(state));
    initial.releases['latest-release'] = {isDraft: false, isPrerelease: false};
    mkdirSync(join(releases, 'latest-release'));
    const previous = {...JSON.parse(readFileSync(join(bundle, 'build.json'))),
        version: '1.10.0', tag: '1.10.0', ref: 'refs/tags/1.10.0', commit: 'a'.repeat(40)};
    writeFileSync(join(releases, 'latest-release/build.json'), JSON.stringify(previous));
    writeFileSync(state, JSON.stringify(initial));
    execFileSync('bash', [publish, bundle], {env, stdio: 'pipe'});
    assert.ok(existsSync(join(releases, '1.9.0/build.json')));
    assert.deepEqual(JSON.parse(readFileSync(join(releases, 'latest-release/build.json'))), previous);
    assert.ok(JSON.parse(readFileSync(state)).calls.filter(call => call[1] === 'upload').every(call => call[2] === '1.9.0'));
});

test('stable publication refuses to replace a conflicting asset from an interrupted release', t => {
    const {bundle, releases, state, env, publish} = createPublicationFixture(t, {ref: 'refs/tags/1.0.1'});
    const initial = JSON.parse(readFileSync(state));
    initial.releases['1.0.1'] = {isDraft: false, isPrerelease: false};
    mkdirSync(join(releases, '1.0.1'));
    writeFileSync(join(releases, '1.0.1/install.sh'), 'another installer');
    writeFileSync(state, JSON.stringify(initial));
    const rejected = spawnSync('bash', [publish, bundle], {env, encoding: 'utf8'});
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /differs; refusing to replace/);
    assert.equal(readFileSync(join(releases, '1.0.1/install.sh'), 'utf8'), 'another installer');
    assert.equal(existsSync(join(releases, '1.0.1/build.json')), false);
    assert.equal(existsSync(join(releases, 'latest-release')), false);
});

test('a stable tag moved during asset upload leaves its draft unpublished and its alias untouched', t => {
    const {bundle, state, env, publish} = createPublicationFixture(t, {ref: 'refs/tags/1.0.1'});
    const initial = JSON.parse(readFileSync(state));
    initial.advanceOnCheck = 3;
    writeFileSync(state, JSON.stringify(initial));
    const rejected = spawnSync('bash', [publish, bundle], {env, encoding: 'utf8'});
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /release tag moved during publication/);
    const published = JSON.parse(readFileSync(state));
    assert.equal(published.releases['1.0.1'].isDraft, true);
    assert.equal(published.releases['latest-release'], undefined);
    assert.ok(published.calls.every(call => call[1] !== 'edit' && call[0] !== 'api'));
});
