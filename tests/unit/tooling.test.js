import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const project = fileURLToPath(new URL('../..', import.meta.url));

function createExtensionFixture(t, {realPresets = false} = {}) {
    const directory = mkdtempSync(join(tmpdir(), 'stealth-lock-tooling-'));
    t.after(() => rmSync(directory, {recursive: true, force: true}));
    const source = join(directory, 'source');
    const data = join(directory, 'data');
    const bin = join(directory, 'bin');
    const home = join(directory, 'home');
    const config = join(directory, 'config');
    const cache = join(directory, 'cache');
    const state = join(directory, 'state');
    const runtime = join(directory, 'run');
    for (const path of [source, data, bin, home, config, cache, state, runtime])
        mkdirSync(path, {mode: 0o700});

    for (const file of ['package.sh', 'install.sh', 'uninstall.sh', 'LICENSE', 'schemas/org.gnome.shell.extensions.stealth-lock.gschema.xml']) {
        mkdirSync(dirname(join(source, file)), {recursive: true});
        copyFileSync(join(project, file), join(source, file));
    }
    for (const file of ['extension.js', 'shell/lockSession.js', 'shell/authentication.js', 'shell/screenshot.js', 'shell/overlay.js', 'shell/integration.js', 'shell/media.js', 'shell/input.js', 'prefs.js', 'shared/presets.js', 'shared/starter-programs.js', 'shared/visual-api.js', 'shared/visual-frame.js', 'shared/visual-process.js', 'shared/runtime-state.js', 'shell/effects/renderer.js', 'helpers/authentication.py', 'helpers/visual-renderer.py', 'stylesheet.css', 'styles/stylesheet-base.css', 'stylesheet-dark.css', 'stylesheet-light.css', 'README.md']) {
        mkdirSync(dirname(join(source, file)), {recursive: true});
        writeFileSync(join(source, file), '');
    }
    if (realPresets) {
        for (const file of ['shared/presets.js', 'shared/starter-programs.js', 'shared/visual-api.js', 'shared/visual-process.js', 'helpers/visual-renderer.py'])
            copyFileSync(join(project, file), join(source, file));
    }
    writeFileSync(join(source, 'metadata.json'), JSON.stringify({uuid: 'stealth-lock@user', version: 1, name: 'Stealth Lock test', description: 'Isolated packaging fixture', 'shell-version': ['48'], 'settings-schema': 'org.gnome.shell.extensions.stealth-lock'}));
    writeFileSync(join(bin, 'gnome-extensions'), '#!/usr/bin/env bash\nif [[ "$1" == pack ]]; then exec /usr/bin/gnome-extensions "$@"; fi\nprintf "%s\\n" "$@" >> "$XDG_DATA_HOME/extension-calls"\n', {mode: 0o755});
    writeFileSync(join(bin, 'gjs'), '#!/usr/bin/env bash\nprintf "%s\\n" "$@" >> "$XDG_DATA_HOME/initializer-calls"\nexec /usr/bin/gjs "$@"\n', {mode: 0o755});

    return {
        source,
        data,
        bin,
        installed: join(data, 'gnome-shell/extensions/stealth-lock@user'),
        env: {
            PATH: `${bin}:${process.env.PATH}`, HOME: home,
            XDG_DATA_HOME: data, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: cache,
            XDG_STATE_HOME: state, XDG_RUNTIME_DIR: runtime,
            XDG_DATA_DIRS: '/usr/local/share:/usr/share', XDG_CONFIG_DIRS: '/etc/xdg',
            LANG: 'C.UTF-8', GSETTINGS_BACKEND: 'keyfile',
            DBUS_SESSION_BUS_ADDRESS: 'disabled:', DBUS_SYSTEM_BUS_ADDRESS: 'disabled:',
        },
    };
}

function installedSettings({installed, env}, values = {}) {
    return JSON.parse(execFileSync('/usr/bin/gjs', ['-m', join(project, 'tests/unit/fixtures/installed-settings.js'),
        join(installed, 'schemas'), JSON.stringify(values)], {env, encoding: 'utf8'}));
}

test('native packaging includes exactly the nonexecutable runtime payload without generated schemas', t => {
    const {source, data, env} = createExtensionFixture(t);
    for (const directory of ['.git', 'node_modules', '__pycache__', 'tests']) {
        mkdirSync(join(source, directory));
        writeFileSync(join(source, directory, 'private.txt'), 'excluded');
    }
    writeFileSync(join(source, 'AGENTS.md'), 'excluded');
    writeFileSync(join(source, 'planning.md'), 'excluded');
    writeFileSync(join(source, 'extra.zip'), 'excluded');
    writeFileSync(join(source, 'unlisted.py'), 'excluded');
    for (const directory of ['shell', 'shell/effects', 'shared', 'helpers', 'styles'])
        writeFileSync(join(source, directory, 'private.txt'), 'excluded');
    const archive = join(data, 'extension.zip');
    execFileSync('bash', [join(source, 'package.sh'), archive], {env});
    const entries = execFileSync('unzip', ['-Z1', archive], {encoding: 'utf8'}).split('\n').filter(Boolean);

    assert.equal(entries.filter(entry => !entry.endsWith('/')).length, 25);
    assert.ok(entries.includes('helpers/authentication.py'));
    assert.ok(entries.includes('shell/input.js'));
    assert.ok(entries.includes('shell/media.js'));
    assert.ok(entries.includes('shell/integration.js'));
    assert.ok(entries.includes('shell/effects/renderer.js'));
    assert.ok(entries.includes('shared/presets.js'));
    assert.ok(entries.includes('shared/starter-programs.js'));
    assert.ok(entries.includes('shared/visual-api.js'));
    assert.ok(entries.includes('shared/visual-frame.js'));
    assert.ok(entries.includes('shared/visual-process.js'));
    assert.ok(entries.includes('shared/runtime-state.js'));
    assert.ok(entries.includes('helpers/visual-renderer.py'));
    assert.ok(entries.includes('styles/stylesheet-base.css'));
    assert.ok(entries.includes('schemas/org.gnome.shell.extensions.stealth-lock.gschema.xml'));
    assert.ok(entries.includes('stylesheet-light.css'));
    assert.ok(entries.includes('LICENSE'));
    assert.ok(entries.every(entry => !/(?:private|AGENTS|planning\.md|unlisted|extra\.zip)/.test(entry)));
    assert.equal(existsSync(join(source, 'schemas/gschemas.compiled')), false);
    assert.ok(entries.every(entry => !/(?:gschemas\.compiled|package\.sh|install\.sh|uninstall\.sh|README)/.test(entry)));
    execFileSync('/usr/bin/python3', ['-c', 'import stat,sys,zipfile; a=zipfile.ZipFile(sys.argv[1]); assert all(not ((e.external_attr >> 16) & (stat.S_IXUSR|stat.S_IXGRP|stat.S_IXOTH)) for e in a.infolist() if not e.is_dir())', archive]);

    execFileSync('zip', ['-q', archive, 'AGENTS.md'], {cwd: source});
    execFileSync('bash', [join(source, 'package.sh'), archive], {env});
    assert.equal(execFileSync('unzip', ['-Z1', archive], {encoding: 'utf8'}).includes('AGENTS.md'), false);
});

test('native packaging retains raw schemas when the installed GNOME tool auto-compiles default schema directories', t => {
    const {source, data, bin, env} = createExtensionFixture(t);
    writeFileSync(join(bin, 'gnome-extensions'), `#!/usr/bin/python3
import json, os, pathlib, subprocess, sys, zipfile
arguments = sys.argv[1:]
subprocess.run(["/usr/bin/gnome-extensions", *arguments], check=True)
source = pathlib.Path(arguments[-1])
schemas = source / "schemas"
if schemas.is_dir():
    subprocess.run(["glib-compile-schemas", "--strict", str(schemas)], check=True)
    output = pathlib.Path(next(argument.split("=", 1)[1] for argument in arguments if argument.startswith("--out-dir=")))
    uuid = json.loads((source / "metadata.json").read_text())["uuid"]
    with zipfile.ZipFile(output / (uuid + ".shell-extension.zip"), "a") as archive:
        archive.write(schemas / "gschemas.compiled", "schemas/gschemas.compiled")
pathlib.Path(os.environ["XDG_DATA_HOME"], "pack-details.json").write_text(json.dumps({
    "automaticSchemasCompiled": schemas.is_dir(),
    "extraSources": [argument.split("=", 1)[1] for argument in arguments if argument.startswith("--extra-source=")],
}))
`, {mode: 0o755});
    const archive = join(data, 'extension.zip');
    execFileSync('bash', [join(source, 'package.sh'), archive], {env});
    const entries = execFileSync('unzip', ['-Z1', archive], {encoding: 'utf8'}).trim().split('\n');
    assert.ok(entries.includes('schemas/org.gnome.shell.extensions.stealth-lock.gschema.xml'));
    assert.equal(entries.includes('schemas/gschemas.compiled'), false);
    assert.equal(entries.filter(entry => !entry.endsWith('/')).length, 25);
    assert.equal(existsSync(join(source, 'schemas/gschemas.compiled')), false);
    const details = JSON.parse(readFileSync(join(data, 'pack-details.json'), 'utf8'));
    assert.equal(details.automaticSchemasCompiled, false);
    assert.ok(details.extraSources.some(path => path.startsWith('/') && path.endsWith('/schemas')));
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
    rmSync(join(source, 'helpers/authentication.py'));
    const result = spawnSync('bash', [join(source, 'install.sh')], {env});

    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(join(installed, 'previous.js'), 'utf8'), 'old');
    assert.deepEqual(readdirSync(dirname(installed)), ['stealth-lock@user']);
});

test('installation checks the isolated renderer before initializing the staged schema on installation and replacement', t => {
    const {source, data, installed, env} = createExtensionFixture(t);
    execFileSync('bash', [join(source, 'install.sh')], {env});
    let arguments_ = readFileSync(join(data, 'initializer-calls'), 'utf8').trim().split('\n');
    assert.equal(arguments_[0], '-m');
    assert.ok(arguments_[1].endsWith('/extension/shared/visual-process.js'));
    assert.ok(arguments_[2].endsWith('/extension'));
    assert.equal(arguments_[3], '-m');
    assert.ok(arguments_[4].endsWith('/extension/shared/presets.js'));
    assert.ok(arguments_[5].endsWith('/extension/schemas'));
    assert.equal(arguments_.length, 6);
    writeFileSync(join(data, 'initializer-calls'), '');
    execFileSync('bash', [join(source, 'install.sh')], {env});
    arguments_ = readFileSync(join(data, 'initializer-calls'), 'utf8').trim().split('\n');
    assert.equal(arguments_.length, 6);
    assert.ok(arguments_[2].endsWith('/extension'));
    assert.ok(arguments_[5].endsWith('/extension/schemas'));
    assert.ok(existsSync(join(installed, 'shared/presets.js')));
});

test('the real installer seeds once and preserves edited and deleted presets through updates and reinstalls', t => {
    const fixture = createExtensionFixture(t, {realPresets: true});
    const {source, installed, env} = fixture;
    execFileSync('bash', [join(source, 'install.sh')], {env});
    const initial = installedSettings(fixture);
    const entries = JSON.parse(initial['visual-effect-presets']);
    assert.deepEqual(entries.map(entry => entry.name), ['Dim and Blur', 'Neo Rain', 'City Grow']);
    assert.ok(entries.every(entry => entry.code.includes('ctx.event') && entry.code.includes('ctx.draw')));
    assert.equal(initial['visual-effect-active'], '');
    assert.equal(initial['visual-effect-initialized'], true);

    entries[0] = {name: 'My Blur', code: "if (ctx.event === 'destroy') return; ctx.blur(7, 1);"};
    entries.splice(1, 1);
    const retained = {
        'visual-effect-presets': JSON.stringify(entries), 'visual-effect-active': 'My Blur',
        'freeze-display': false, 'auto-reset-seconds': 17, 'normal-prompt-css': 'padding: 4px;',
    };
    installedSettings(fixture, retained);
    for (const reinstall of [false, true]) {
        if (reinstall)
            execFileSync('bash', [join(source, 'uninstall.sh')], {env});
        execFileSync('bash', [join(source, 'install.sh')], {env});
        const current = installedSettings(fixture);
        for (const [key, value] of Object.entries(retained))
            assert.equal(current[key], value, key);
        assert.equal(current['visual-effect-initialized'], true);
    }

    installedSettings(fixture, {'visual-effect-presets': '[]', 'visual-effect-active': ''});
    for (const reinstall of [false, true]) {
        if (reinstall)
            execFileSync('bash', [join(source, 'uninstall.sh')], {env});
        execFileSync('bash', [join(source, 'install.sh')], {env});
        const current = installedSettings(fixture);
        assert.equal(current['visual-effect-presets'], '[]');
        assert.equal(current['visual-effect-active'], '');
        assert.equal(current['visual-effect-initialized'], true);
    }
    assert.deepEqual(readdirSync(dirname(installed)), ['stealth-lock@user']);
});

test('the real installer initializes starters alongside current preferences customized before first installation', t => {
    const fixture = createExtensionFixture(t, {realPresets: true});
    const {source, installed, env} = fixture;
    execFileSync('glib-compile-schemas', ['--strict', join(source, 'schemas')], {env});
    const retained = {'normal-prompt-css': 'padding: 9px;', 'freeze-display': false, 'auto-reset-seconds': 17};
    const previous = installedSettings({...fixture, installed: source}, retained);
    assert.equal(previous['visual-effect-initialized'], false);
    execFileSync('bash', [join(source, 'install.sh')], {env});
    const current = installedSettings(fixture);
    assert.equal(current['visual-effect-initialized'], true);
    assert.equal(JSON.parse(current['visual-effect-presets']).length, 3);
    assert.equal(current['visual-effect-active'], '');
    for (const [key, value] of Object.entries(retained))
        assert.equal(current[key], value, key);
    assert.deepEqual(readdirSync(dirname(installed)), ['stealth-lock@user']);
});

test('the real installer preserves current libraries and selections configured before first initialization', async t => {
    const custom = JSON.stringify([{name: 'My Rain', code: "if (ctx.event === 'destroy') return; ctx.draw.text('user program', 20, 20);"}]);
    for (const [name, retained] of [
        ['custom library and selection', {'visual-effect-presets': custom, 'visual-effect-active': 'My Rain'}],
        ['deleted library', {'visual-effect-presets': '[]', 'visual-effect-active': ''}],
        ['explicit None selection', {'visual-effect-active': ''}],
    ]) {
        await t.test(name, t => {
            const fixture = createExtensionFixture(t, {realPresets: true});
            const {source, env} = fixture;
            execFileSync('glib-compile-schemas', ['--strict', join(source, 'schemas')], {env});
            installedSettings({...fixture, installed: source}, retained);
            execFileSync('bash', [join(source, 'install.sh')], {env});
            const current = installedSettings(fixture);
            for (const [key, value] of Object.entries(retained))
                assert.equal(current[key], value, key);
            assert.equal(current['visual-effect-presets'], retained['visual-effect-presets'] ?? '[]');
            assert.equal(current['visual-effect-initialized'], true);
        });
    }
});

test('failed replacement restores the previous installation', t => {
    const fixture = createExtensionFixture(t, {realPresets: true});
    const {source, bin, installed, env} = fixture;
    execFileSync('bash', [join(source, 'install.sh')], {env});
    const retained = {'visual-effect-presets': '[]', 'visual-effect-active': '', 'normal-prompt-css': 'padding: 5px;'};
    installedSettings(fixture, retained);
    writeFileSync(join(installed, 'previous.js'), 'previous installation');
    writeFileSync(join(bin, 'mv'), '#!/usr/bin/env bash\nif [[ "$1" == */.stealth-lock-install.*/extension ]]; then exit 1; fi\nexec /usr/bin/mv "$@"\n', {mode: 0o755});
    const result = spawnSync('bash', [join(source, 'install.sh')], {env});

    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(join(installed, 'previous.js'), 'utf8'), 'previous installation');
    const current = installedSettings(fixture);
    for (const [key, value] of Object.entries(retained))
        assert.equal(current[key], value, key);
    assert.equal(current['visual-effect-initialized'], true);
    assert.deepEqual(readdirSync(dirname(installed)), ['stealth-lock@user']);
});

test('failed renderer preflight preserves the previous installation before settings initialization', t => {
    const fixture = createExtensionFixture(t, {realPresets: true});
    const {source, bin, installed, env} = fixture;
    execFileSync('bash', [join(source, 'install.sh')], {env});
    const retained = {'visual-effect-presets': '[]', 'visual-effect-active': ''};
    installedSettings(fixture, retained);
    writeFileSync(join(installed, 'previous.js'), 'previous installation');
    writeFileSync(join(bin, 'gjs'), '#!/usr/bin/env bash\nexit 2\n', {mode: 0o755});
    const result = spawnSync('bash', [join(source, 'install.sh')], {env});
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(join(installed, 'previous.js'), 'utf8'), 'previous installation');
    const current = installedSettings(fixture);
    for (const [key, value] of Object.entries(retained))
        assert.equal(current[key], value, key);
    assert.equal(current['visual-effect-initialized'], true);
    assert.deepEqual(readdirSync(dirname(installed)), ['stealth-lock@user']);
});

test('failed preset initialization preserves the previous installation after successful renderer preflight', t => {
    const fixture = createExtensionFixture(t, {realPresets: true});
    const {source, bin, installed, env} = fixture;
    execFileSync('bash', [join(source, 'install.sh')], {env});
    const retained = {'visual-effect-presets': '[]', 'visual-effect-active': ''};
    installedSettings(fixture, retained);
    writeFileSync(join(installed, 'previous.js'), 'previous installation');
    writeFileSync(join(bin, 'gjs'), '#!/usr/bin/env bash\nif [[ "$2" == */shared/presets.js ]]; then exit 2; fi\nexec /usr/bin/gjs "$@"\n', {mode: 0o755});
    const result = spawnSync('bash', [join(source, 'install.sh')], {env});
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(join(installed, 'previous.js'), 'utf8'), 'previous installation');
    const current = installedSettings(fixture);
    for (const [key, value] of Object.entries(retained))
        assert.equal(current[key], value, key);
    assert.deepEqual(readdirSync(dirname(installed)), ['stealth-lock@user']);
});

test('actual isolated renderer failure prevents first-profile preset writes and installation', t => {
    const fixture = createExtensionFixture(t, {realPresets: true});
    const {source, installed, env} = fixture;
    execFileSync('glib-compile-schemas', ['--strict', join(source, 'schemas')], {env});
    const before = installedSettings({...fixture, installed: source}, {'freeze-display': false});
    assert.equal(before['visual-effect-initialized'], false);
    writeFileSync(join(source, 'helpers/visual-renderer.py'), "raise RuntimeError('isolated dependency fixture unavailable')\n");
    const result = spawnSync('bash', [join(source, 'install.sh')], {env});
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(installed), false);
    const after = installedSettings({...fixture, installed: source});
    assert.equal(after['visual-effect-initialized'], false);
    assert.equal(after['visual-effect-presets'], before['visual-effect-presets']);
    assert.equal(after['freeze-display'], false);
    assert.deepEqual(readdirSync(dirname(installed)), []);
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
