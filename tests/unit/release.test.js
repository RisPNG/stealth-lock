import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const project = fileURLToPath(new URL('../..', import.meta.url));

function createReleaseFixture(t, {signed = false} = {}) {
    const directory = mkdtempSync(join(tmpdir(), 'stealth-lock-release-'));
    const source = join(directory, 'source');
    const home = join(directory, 'home');
    const gnupg = join(directory, 'gnupg');
    for (const path of [source, home, gnupg, join(source, 'scripts')])
        mkdirSync(path, {mode: 0o700});
    const env = {...process.env, HOME: home, GNUPGHOME: gnupg,
        GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_DATE: '2026-10-08T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-08T00:00:00Z'};
    t.after(() => {
        spawnSync('gpgconf', ['--homedir', gnupg, '--kill', 'gpg-agent'], {env});
        rmSync(directory, {recursive: true, force: true});
    });
    copyFileSync(join(project, 'scripts/release.sh'), join(source, 'scripts/release.sh'));
    writeFileSync(join(source, 'metadata.json'), JSON.stringify({'version-name': '1.0.1'}));
    writeFileSync(join(source, 'install.sh'), 'fixture source installer\n');
    writeFileSync(join(source, '.gitignore'), 'AGENTS.md\n1.0.md\nnode_modules/\ndist/\n');
    execFileSync('git', ['init', '--quiet'], {cwd: source, env});
    execFileSync('git', ['add', '.'], {cwd: source, env});
    execFileSync('git', ['-c', 'user.name=Release Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'prepare release fixture'], {cwd: source, env});
    let key;
    if (signed) {
        execFileSync('gpg', ['--batch', '--pinentry-mode', 'loopback', '--passphrase', '', '--quick-gen-key',
            'Release Fixture <fixture@example.invalid>', 'ed25519', 'sign', '0'], {env, stdio: 'pipe'});
        key = execFileSync('gpg', ['--batch', '--with-colons', '--list-secret-keys'], {env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']})
            .split('\n').find(line => line.startsWith('fpr:')).split(':')[9];
    }
    return {directory, source, env, key, script: join(source, 'scripts/release.sh')};
}

test('source releases reproduce committed bytes and exclude untracked private files', t => {
    const {directory, source, env, script} = createReleaseFixture(t);
    writeFileSync(join(source, 'AGENTS.md'), 'private');
    writeFileSync(join(source, '1.0.md'), 'private');
    mkdirSync(join(source, 'node_modules'));
    writeFileSync(join(source, 'node_modules/private'), 'private');
    const first = join(directory, 'first.tar.gz');
    const second = join(directory, 'second.tar.gz');
    execFileSync('bash', [script, '--unsigned', first], {env});
    execFileSync('bash', [script, '--unsigned', second], {env});
    assert.deepEqual(readFileSync(first), readFileSync(second));
    const entries = execFileSync('tar', ['-tzf', first], {encoding: 'utf8'}).trim().split('\n');
    assert.ok(entries.includes('stealth-lock-1.0.1/install.sh'));
    assert.ok(entries.includes('stealth-lock-1.0.1/scripts/release.sh'));
    assert.ok(entries.every(entry => !/AGENTS|1\.0\.md|node_modules|\.git\//.test(entry)));
});

test('release creation refuses uncommitted tracked changes and implicit signing keys', t => {
    const {directory, source, env, script} = createReleaseFixture(t);
    const output = join(directory, 'source.tar.gz');
    writeFileSync(join(source, 'install.sh'), 'unreviewed source');
    const dirty = spawnSync('bash', [script, '--unsigned', output], {env, encoding: 'utf8'});
    assert.equal(dirty.status, 1);
    assert.match(dirty.stderr, /Commit the source changes/);
    assert.equal(existsSync(output), false);
    for (const arguments_ of [[], ['--sign-key'], ['--sign-key', 'short-key-id'], ['--sign-key', '0'.repeat(40)]]) {
        const result = spawnSync('bash', [script, ...arguments_], {env, encoding: 'utf8'});
        assert.notEqual(result.status, 0);
    }
});

test('an explicit disposable signing key verifies independently and tampering is rejected', t => {
    const {directory, env, key, script} = createReleaseFixture(t, {signed: true});
    const output = join(directory, 'source.tar.gz');
    execFileSync('bash', [script, '--sign-key', key, output], {env, stdio: 'pipe'});
    assert.ok(existsSync(`${output}.asc`));
    assert.ok(existsSync(`${output}.key.asc`));
    const verifier = join(directory, 'verifier');
    mkdirSync(verifier, {mode: 0o700});
    const verifierEnv = {...env, GNUPGHOME: verifier};
    execFileSync('bash', [script, '--verify', `${output}.key.asc`, output], {env: verifierEnv, stdio: 'pipe'});
    const archive = readFileSync(output);
    archive[archive.length - 1] ^= 1;
    writeFileSync(output, archive);
    const tampered = spawnSync('bash', [script, '--verify', `${output}.key.asc`, output], {env: verifierEnv, encoding: 'utf8'});
    assert.notEqual(tampered.status, 0);
    assert.match(tampered.stderr, /BAD signature/);
});

test('an unsigned replacement removes prior release signatures and retains other neighboring files', t => {
    const {directory, source, env, key, script} = createReleaseFixture(t, {signed: true});
    const output = join(directory, 'source.tar.gz');
    execFileSync('bash', [script, '--sign-key', key, output], {env, stdio: 'pipe'});
    const previousArchive = readFileSync(output);
    writeFileSync(`${output}.notes`, 'release notes');
    writeFileSync(join(source, 'install.sh'), 'revised source installer\n');
    execFileSync('git', ['add', 'install.sh'], {cwd: source, env});
    execFileSync('git', ['-c', 'user.name=Release Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'revise release fixture'], {cwd: source, env});
    execFileSync('bash', [script, '--unsigned', output], {env});
    assert.notDeepEqual(readFileSync(output), previousArchive);
    assert.equal(execFileSync('tar', ['-xzOf', output, 'stealth-lock-1.0.1/install.sh'], {encoding: 'utf8'}), 'revised source installer\n');
    assert.equal(existsSync(`${output}.asc`), false);
    assert.equal(existsSync(`${output}.key.asc`), false);
    assert.equal(readFileSync(`${output}.notes`, 'utf8'), 'release notes');
});

test('verification rejects a valid signature when only a different trusted key is supplied', t => {
    const {directory, env, key, script} = createReleaseFixture(t, {signed: true});
    const output = join(directory, 'source.tar.gz');
    execFileSync('bash', [script, '--sign-key', key, output], {env, stdio: 'pipe'});
    execFileSync('gpg', ['--batch', '--pinentry-mode', 'loopback', '--passphrase', '', '--quick-gen-key',
        'Other Fixture <other@example.invalid>', 'ed25519', 'sign', '0'], {env, stdio: 'pipe'});
    const wrongKey = join(directory, 'other-key.asc');
    writeFileSync(wrongKey, execFileSync('gpg', ['--batch', '--armor', '--export', 'other@example.invalid'], {env}));
    const verifier = join(directory, 'verifier');
    mkdirSync(verifier, {mode: 0o700});
    const rejected = spawnSync('bash', [script, '--verify', wrongKey, output], {env: {...env, GNUPGHOME: verifier}, encoding: 'utf8'});
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /No public key/);
    execFileSync('bash', [script, '--verify', `${output}.key.asc`, output], {env: {...env, GNUPGHOME: verifier}, stdio: 'pipe'});
});
