import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const checker = fileURLToPath(new URL('../shell/check-log.py', import.meta.url));
const metadataWarning = 'Type gint32 of property AccountsService.User::password-mode does not match return type interface of getter get_password_mode. Falling back to slow path';
const modernMetadataWarning = metadataWarning.replace('gint32', 'GITypeInfo').replace('interface', 'GITypeInfo');
const streamWarnings = ['Input', 'Output'].map(type =>
    `Gio.Unix${type}Stream has been moved to a separate platform-specific library. Please update your code to use GioUnix.${type}Stream instead.`);

function checkNativeLog(t, lines, expected = []) {
    const directory = mkdtempSync(join(tmpdir(), 'stealth-lock-native-log-'));
    t.after(() => rmSync(directory, {recursive: true, force: true}));
    mkdirSync(join(directory, 'run'));
    mkdirSync(join(directory, 'logs'));
    writeFileSync(join(directory, 'run/expected-logs.json'), JSON.stringify(expected));
    writeFileSync(join(directory, 'logs/shell.log'), `${lines.join('\n')}\n`);
    return spawnSync('/usr/bin/python3', ['-I', '-B', checker, directory], {encoding: 'utf8'});
}

test('the native log gate accepts normal messages and exact declared failures', t => {
    const result = checkNativeLog(t, [
        'GNOME Shell-Message: 06:11:05.000: Native scenario completed',
        '(gnome-shell:486): GNOME Shell-WARNING **: 06:11:05.000: Stealth Lock: authentication helper failed (exit 2)',
        '(gnome-shell:486): GNOME Shell-CRITICAL **: 06:11:05.000: Deliberate fixture failure',
    ], [
        {pattern: 'Stealth Lock: authentication helper failed \\(exit 2\\)', count: 1},
        {pattern: 'Deliberate fixture failure', count: 1},
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /2 expected diagnostics/);
    assert.ok(result.stdout.includes('Stealth Lock: authentication helper failed (exit 2)'));
});

test('repeated, changed and unrelated warnings remain visible and informational', t => {
    const exact = `(gnome-shell:486): Gjs-WARNING **: 06:11:05.000: ${metadataWarning}`;
    const modern = exact.replace(metadataWarning, modernMetadataWarning);
    const lines = [
        exact, exact, modern,
        exact.replace('gint32', 'GITypeInfo'),
        exact.replace('interface', 'GITypeInfo'),
        exact.replace('gint32', 'guint32'),
        exact.replace('password-mode', 'account-type'),
        modern.replace('password-mode', 'account-type'),
        exact.replace('Falling back to slow path', 'Cannot read property'),
        `Gjs-WARNING **: 06:11:05.000: ${metadataWarning}`,
        '(gnome-shell:486): Gjs-WARNING **: 06:11:05.000: Unrelated metadata warning',
        '(gnome-shell:486): GNOME Shell-WARNING **: 06:11:05.000: Unexpected stock warning',
        '(gnome-shell:486): Clutter-WARNING **: 06:11:05.000: Actor allocation warning',
        '(gnome-shell:486): Gjs-WARNING **: 06:11:05.000: Explaining ERROR and CRITICAL diagnostics',
        '(gjs:512): Gtk-WARNING **: 06:11:05.000: Example JS ERROR text is shown in the help page',
        '(gnome-shell:486): Gjs-WARNING **: 06:11:05.000: Explanation of AssertionError handling',
        ...streamWarnings.flatMap(warning => {
            const line = `(gnome-shell:486): Gjs-WARNING **: 06:11:05.000: ${warning}`;
            return [line, line, line.replace('GioUnix.', 'Gio.'), line.replace('Stream has', 'Stream was')];
        }),
    ];
    const result = checkNativeLog(t, lines);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const displayed = result.stdout.split('\n')
        .filter(line => /^\d+: /.test(line))
        .map(line => line.replace(/^\d+: /, ''));
    assert.deepEqual(displayed, lines);
});

test('ordinary actor and allocation messages do not become diagnostic failures', t => {
    const lines = [
        'actor allocation completed normally',
        '(gnome-shell:486): Clutter-DEBUG: 06:11:05.000: Actor allocation updated',
        'GNOME Shell-Message: 06:11:05.000: Allocated actor on the second monitor',
        '(gnome-shell:486): St-DEBUG: 06:11:05.000: allocation warning checked during measurement',
        '(gnome-shell:486): GNOME Shell-DEBUG: 06:11:05.000: Actor currently has no allocation',
        '(gnome-shell:486): Gjs-DEBUG: 06:11:05.000: Quoted diagnostic: ERROR, CRITICAL and JS ERROR',
        'GNOME Shell-Message: 06:11:05.000: Example text: assertion failed: (actor != NULL)',
        'GNOME Shell-Message: 06:11:05.000: The assertion never failed during recovery',
        '(gnome-shell:486): Gjs-DEBUG: 06:11:05.000: Quoted diagnostic: AssertionError: width must be positive',
    ];
    const result = checkNativeLog(t, lines);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
});

test('actual errors criticals JavaScript errors and failed assertions remain fatal', t => {
    for (const line of [
        '(gnome-shell:486): GNOME Shell-ERROR **: 06:11:05.000: Failed to protect input',
        '(gnome-shell:486): Gjs-ERROR **: 06:11:05.000: Native operation failed',
        '(gnome-shell:486): St-CRITICAL **: 06:11:05.000: Native actor error',
        '(gjs:512): Gtk-ERROR **: 06:11:05.000: Preferences operation failed',
        '(gjs:512): GLib-GObject-CRITICAL **: 06:11:05.000: Preferences binding failed',
        '(gnome-shell:486): GNOME Shell-CRITICAL **: 06:11:05.000: Set global engine failed: Operation was cancelled',
        'Gjs-Console-CRITICAL **: 06:11:05.000: JS ERROR: TypeError: invalid frame',
        '(gjs:512): Gjs-WARNING **: 06:11:05.000: JS ERROR: Error: invalid preferences state',
        'JS ERROR: Error: malformed input',
        'AssertionError: width must be positive',
        "cogl_framebuffer_set_viewport: assertion 'width > 0' failed",
        '(gnome-shell:486): GLib-GObject-WARNING **: 06:11:05.000: assertion failed: (actor != NULL)',
        'Bail out! GLib:ERROR:fixture.c:10:render: assertion failed: (width > 0)',
    ]) {
        const result = checkNativeLog(t, [line]);
        assert.equal(result.status, 1, line);
        assert.ok(result.stderr.includes(line), result.stderr);
    }
});

test('a failed partial native run scans its full log and preserves its failure while cleaning', t => {
    const directory = mkdtempSync(join(tmpdir(), 'stealth-lock-native-diagnostic-'));
    t.after(() => rmSync(directory, {recursive: true, force: true}));
    const root = join(directory, 'private');
    copyFileSync(fileURLToPath(new URL('../shell/run.sh', import.meta.url)), join(directory, 'run.sh'));
    copyFileSync(checker, join(directory, 'check-log.py'));
    writeFileSync(join(directory, 'run-shell.sh'), `#!/usr/bin/env bash
set -eu
case "$1" in
    start)
        mkdir -p "$SLH_ROOT/run" "$SLH_ROOT/logs"
        printf '[]' > "$SLH_ROOT/run/expected-logs.json"
        printf 'GNOME Shell-CRITICAL **: early native failure\\n' > "$SLH_ROOT/logs/shell.log"
        for index in $(seq 1 100); do printf 'Routine debug message %s\\n' "$index" >> "$SLH_ROOT/logs/shell.log"; done
        : > "$SLH_ROOT/logs/scope.log"
        ;;
    status) echo 'private scope status captured' ;;
    clean) rm -rf -- "$SLH_ROOT" ;;
    *) exit 99 ;;
esac
`, {mode: 0o755});
    writeFileSync(join(directory, 'eval.sh'), '#!/usr/bin/env bash\nexit 23\n', {mode: 0o755});
    const result = spawnSync('mise', ['exec', '--', 'bash', join(directory, 'run.sh')], {
        env: {...process.env, SLH_ROOT: root, SLH_KEEP: '0'}, encoding: 'utf8',
    });
    assert.equal(result.status, 23, result.stderr);
    assert.match(result.stdout, /private scope status captured/);
    assert.equal(result.stderr.match(/early native failure/g)?.length, 1, result.stderr);
    assert.equal(existsSync(root), false);
});

test('declared fixture failures must occur exactly as many times as expected', t => {
    const expected = [{pattern: 'Stealth Lock: authentication helper failed \\(exit 2\\)', count: 1}];
    const missing = checkNativeLog(t, [], expected);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /expected 1, saw 0/);
    for (const severity of ['WARNING', 'CRITICAL']) {
        const line = `(gnome-shell:486): GNOME Shell-${severity} **: 06:11:05.000: Stealth Lock: authentication helper failed (exit 2)`;
        const one = checkNativeLog(t, [line], expected);
        assert.equal(one.status, 0, one.stderr);
        const duplicate = checkNativeLog(t, [line, line], expected);
        assert.equal(duplicate.status, 1);
        assert.match(duplicate.stderr, /expected 1, saw 2/);
    }
});
