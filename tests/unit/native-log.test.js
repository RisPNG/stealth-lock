import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const checker = fileURLToPath(new URL('../shell/check-log.py', import.meta.url));
const metadataWarning = 'Type gint32 of property AccountsService.User::password-mode does not match return type interface of getter get_password_mode. Falling back to slow path';

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
        `(gnome-shell:912): Gjs-WARNING **: 06:11:06.000: ${metadataWarning}`,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /0 expected diagnostics, 2 upstream metadata warnings/);
});

test('repeated, altered and unrelated native warnings remain failures', t => {
    const exact = `(gnome-shell:486): Gjs-WARNING **: 06:11:05.000: ${metadataWarning}`;
    for (const lines of [
        [exact, exact.replace('05.000', '06.000')],
        [exact.replace('gint32', 'guint32')],
        [exact.replace('password-mode', 'account-type')],
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
