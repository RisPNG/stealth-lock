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
    ], [{pattern: 'Stealth Lock: authentication helper failed \\(exit 2\\)', count: 1}]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 expected diagnostics, 0 upstream metadata warnings/);
});

test('the exact AccountsService metadata fallback is bounded once per native compositor process', t => {
    const result = checkNativeLog(t, [
        `(gnome-shell:486): Gjs-WARNING **: 06:11:05.000: ${metadataWarning}`,
        `(gnome-shell:912): Gjs-WARNING **: 06:11:06.000: ${modernMetadataWarning}`,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /0 expected diagnostics, 2 upstream metadata warnings/);
});

test('native subprocess stream metadata warnings are bounded per type and compositor process', t => {
    const result = checkNativeLog(t, [
        `(gnome-shell:486): Gjs-WARNING **: 06:11:05.000: ${metadataWarning}`,
        ...[486, 912].flatMap(pid => streamWarnings.map(warning =>
            `(gnome-shell:${pid}): Gjs-WARNING **: 06:11:06.000: ${warning}`)),
        '0 request() ["shared/visual-process.js":76:29]',
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /0 expected diagnostics, 5 upstream metadata warnings/);
});

test('repeated, altered and unrelated native warnings remain failures', t => {
    const exact = `(gnome-shell:486): Gjs-WARNING **: 06:11:05.000: ${metadataWarning}`;
    const modern = exact.replace(metadataWarning, modernMetadataWarning);
    for (const lines of [
        [exact, exact.replace('05.000', '06.000')],
        [exact, modern],
        [modern, modern.replace('05.000', '06.000')],
        [exact.replace('gint32', 'GITypeInfo')],
        [exact.replace('interface', 'GITypeInfo')],
        [exact.replace('gint32', 'guint32')],
        [exact.replace('password-mode', 'account-type')],
        [modern.replace('password-mode', 'account-type')],
        [exact.replace('Falling back to slow path', 'Cannot read property')],
        [`Gjs-WARNING **: 06:11:05.000: ${metadataWarning}`],
        ['(gnome-shell:486): Gjs-WARNING **: 06:11:05.000: Unrelated metadata warning'],
        ['(gnome-shell:486): GNOME Shell-CRITICAL **: 06:11:05.000: Set global engine failed: Operation was cancelled'],
        ['(gnome-shell:486): GNOME Shell-WARNING **: 06:11:05.000: Unexpected stock warning'],
        ['(gnome-shell:486): St-CRITICAL **: 06:11:05.000: Native actor error'],
    ]) {
        const result = checkNativeLog(t, lines);
        assert.equal(result.status, 1, JSON.stringify(lines));
        assert.match(result.stderr, /WARNING|CRITICAL/);
    }
    for (const warning of streamWarnings) {
        const line = `(gnome-shell:486): Gjs-WARNING **: 06:11:05.000: ${warning}`;
        for (const lines of [
            [line, line.replace('05.000', '06.000')],
            [line.replace('Gjs-WARNING', 'GNOME Shell-WARNING')],
            [line.replace('GioUnix.', 'Gio.')],
            [line.replace(/GioUnix\.(Input|Output)/, 'GioUnix.Other')],
            [line.replace('Stream has', 'Stream was')],
            [line.replace('gnome-shell:486', 'gnome-shell-calendar-server:486')],
            [line.replace('(gnome-shell:486): ', '')],
        ]) {
            const result = checkNativeLog(t, lines);
            assert.equal(result.status, 1, JSON.stringify(lines));
            assert.match(result.stderr, /WARNING/);
        }
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
    const line = '(gnome-shell:486): GNOME Shell-WARNING **: 06:11:05.000: Stealth Lock: authentication helper failed (exit 2)';
    const missing = checkNativeLog(t, [], expected);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /expected 1, saw 0/);
    const duplicate = checkNativeLog(t, [line, line], expected);
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /authentication helper failed/);
});
