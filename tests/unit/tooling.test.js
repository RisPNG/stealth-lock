import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const project = fileURLToPath(new URL('../..', import.meta.url));

function createExtensionFixture(t) {
    const directory = mkdtempSync(join(tmpdir(), 'stealth-lock-tooling-'));
    t.after(() => rmSync(directory, {recursive: true, force: true}));
    const source = join(directory, 'source');
    const data = join(directory, 'data');
    const bin = join(directory, 'bin');
    mkdirSync(source);
    mkdirSync(data);
    mkdirSync(bin);

    for (const file of ['package.sh', 'install.sh', 'uninstall.sh', 'LICENSE', 'REUSE.toml', 'LICENSES/GPL-3.0-only.txt', 'schemas/org.gnome.shell.extensions.stealth-lock.gschema.xml']) {
        mkdirSync(dirname(join(source, file)), {recursive: true});
        copyFileSync(join(project, file), join(source, file));
    }
    for (const file of ['extension.js', 'lockSession.js', 'authentication.js', 'screenshot.js', 'overlay.js', 'shell.js', 'input.js', 'prefs.js', 'authentication.py', 'stylesheet.css', 'README.md', 'REVIEW.md'])
        writeFileSync(join(source, file), '');
    writeFileSync(join(source, 'metadata.json'), JSON.stringify({uuid: 'stealth-lock@user', version: 1}));
    writeFileSync(join(bin, 'gnome-extensions'), '#!/usr/bin/env bash\nprintf "%s\\n" "$@" >> "$XDG_DATA_HOME/extension-calls"\n', {mode: 0o755});

    return {
        source,
        data,
        bin,
        installed: join(data, 'gnome-shell/extensions/stealth-lock@user'),
        env: {...process.env, XDG_DATA_HOME: data, PATH: `${bin}:${process.env.PATH}`},
    };
}

test('packaging includes only extension payload and compiles schemas outside source', t => {
    const {source, data, env} = createExtensionFixture(t);
    for (const directory of ['.git', 'node_modules', '__pycache__', 'tests']) {
        mkdirSync(join(source, directory));
        writeFileSync(join(source, directory, 'private.txt'), 'excluded');
    }
    writeFileSync(join(source, 'AGENTS.md'), 'excluded');
    writeFileSync(join(source, '1.0.md'), 'excluded');
    writeFileSync(join(source, 'old.zip'), 'excluded');
    writeFileSync(join(source, 'pam-helper.py'), 'excluded');
    const archive = join(data, 'extension.zip');
    execFileSync('bash', [join(source, 'package.sh'), archive], {env});
    const entries = execFileSync('unzip', ['-Z1', archive], {encoding: 'utf8'}).split('\n').filter(Boolean);

    assert.ok(entries.includes('authentication.py'));
    assert.ok(entries.includes('input.js'));
    assert.ok(entries.includes('schemas/gschemas.compiled'));
    assert.ok(entries.includes('LICENSES/GPL-3.0-only.txt'));
    assert.ok(entries.every(entry => !/(?:private|AGENTS|1\.0\.md|pam-helper|old\.zip)/.test(entry)));
    assert.equal(existsSync(join(source, 'schemas/gschemas.compiled')), false);

    execFileSync('zip', ['-q', archive, 'AGENTS.md'], {cwd: source});
    execFileSync('bash', [join(source, 'package.sh'), archive], {env});
    assert.equal(execFileSync('unzip', ['-Z1', archive], {encoding: 'utf8'}).includes('AGENTS.md'), false);
});

test('installation replaces stale files only inside user-local destination', t => {
    const {source, data, installed, env} = createExtensionFixture(t);
    mkdirSync(installed, {recursive: true});
    writeFileSync(join(installed, 'obsolete.js'), 'old');
    execFileSync('bash', [join(source, 'install.sh')], {env});

    assert.ok(existsSync(join(installed, 'extension.js')));
    assert.ok(existsSync(join(installed, 'schemas/gschemas.compiled')));
    assert.equal(existsSync(join(installed, 'obsolete.js')), false);
    assert.equal(existsSync(join(data, 'extension-calls')), false);
    assert.deepEqual(readdirSync(dirname(installed)), ['stealth-lock@user']);
});

test('failed staging preserves the existing installation and cleans temporary files', t => {
    const {source, installed, env} = createExtensionFixture(t);
    mkdirSync(installed, {recursive: true});
    writeFileSync(join(installed, 'previous.js'), 'old');
    rmSync(join(source, 'authentication.py'));
    const result = spawnSync('bash', [join(source, 'install.sh')], {env});

    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(join(installed, 'previous.js'), 'utf8'), 'old');
    assert.deepEqual(readdirSync(dirname(installed)), ['stealth-lock@user']);
});

test('failed replacement restores the previous installation', t => {
    const {source, bin, installed, env} = createExtensionFixture(t);
    mkdirSync(installed, {recursive: true});
    writeFileSync(join(installed, 'previous.js'), 'old');
    writeFileSync(join(bin, 'mv'), '#!/usr/bin/env bash\nif [[ "$1" == */.stealth-lock-install.*/extension ]]; then exit 1; fi\nexec /usr/bin/mv "$@"\n', {mode: 0o755});
    const result = spawnSync('bash', [join(source, 'install.sh')], {env});

    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(join(installed, 'previous.js'), 'utf8'), 'old');
    assert.deepEqual(readdirSync(dirname(installed)), ['stealth-lock@user']);
});

test('uninstall retains settings by default and resets through local schema when requested', t => {
    const {source, data, bin, installed, env} = createExtensionFixture(t);
    writeFileSync(join(bin, 'gsettings'), '#!/usr/bin/env bash\nprintf "%s\\n" "$@" >> "$XDG_DATA_HOME/settings-calls"\n', {mode: 0o755});
    execFileSync('bash', [join(source, 'install.sh')], {env});
    execFileSync('bash', [join(source, 'uninstall.sh')], {env});
    assert.equal(existsSync(installed), false);
    assert.equal(existsSync(join(data, 'settings-calls')), false);

    execFileSync('bash', [join(source, 'install.sh')], {env});
    execFileSync('bash', [join(source, 'uninstall.sh'), '--purge-settings'], {env});
    assert.equal(existsSync(installed), false);
    assert.deepEqual(readFileSync(join(data, 'settings-calls'), 'utf8').trim().split('\n'), [
        '--schemadir', join(installed, 'schemas'), 'reset-recursively', 'org.gnome.shell.extensions.stealth-lock',
    ]);
    assert.equal(readFileSync(join(data, 'extension-calls'), 'utf8'), 'disable\nstealth-lock@user\ndisable\nstealth-lock@user\n');
});
