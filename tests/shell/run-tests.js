import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {assert, delay, setAuthControl, waitFor} from './support.js';

export async function run() {
    GLib.log_set_debug_enabled(true);
    const uuid = 'stealth-lock@user';
    const directory = Gio.File.new_for_uri(import.meta.url).get_parent();
    const children = directory.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    const names = [];
    for (let info = children.next_file(null); info; info = children.next_file(null)) {
        if (info.get_name().endsWith('.test.js'))
            names.push(info.get_name());
    }
    children.close(null);
    names.sort();
    assert(names.length > 0, 'No native scenarios found');
    Main.overview.hide();
    await waitFor(() => Main.modalCount === 0, 'Startup overview closes');
    assert(!global.backend.is_rendering_hardware_accelerated(), 'Software rendering required');
    assert(Main.layoutManager.monitors.length === 2, 'Two native virtual monitors required');
    const helper = Main.extensionManager.lookup('harness-helper@test').stateObj;
    const expectedLogs = [];
    let passed = 0;
    let skipped = 0;
    for (const name of names) {
        const {tests} = await import(directory.get_child(name).get_uri());
        for (const [title, scenario] of Object.entries(tests)) {
            let extension = Main.extensionManager.lookup(uuid).stateObj;
            extension?._session?.close();
            if (Main.screenShield?.locked || Main.screenShield?.active) {
                Main.screenShield.deactivate(true);
                await waitFor(() => Main.sessionMode.currentMode === 'user', 'Return to user session');
            }
            Main.extensionManager.enableExtension(uuid);
            await waitFor(() => Main.extensionManager.lookup(uuid).state === 1, 'Extension enabled');
            extension = Main.extensionManager.lookup(uuid).stateObj;
            const settings = extension.getSettings();
            for (const key of settings.settings_schema.list_keys())
                settings.reset(key);
            settings.set_boolean('pause-media', false);
            settings.set_boolean('freeze-display', false);
            settings.set_string('cursor-mode', 'normal');
            settings.set_uint('auto-reset-seconds', 0);
            setAuthControl();
            await delay(40);
            try {
                const result = await scenario({
                    extension, settings, helper, uuid,
                    expectLog(pattern, count = 1) { expectedLogs.push({pattern, count}); },
                });
                if (result?.skipped) {
                    skipped++;
                    console.log(`Stealth Lock native: skipped ${name}: ${title}: ${result.skipped}`);
                } else {
                    passed++;
                    console.log(`Stealth Lock native: ok ${passed} - ${name}: ${title}`);
                }
            } catch (error) {
                console.error(`Stealth Lock native: failed ${name}: ${title}: ${error.message}`);
                throw error;
            } finally {
                extension._session?.close();
            }
        }
    }
    Gio.File.new_for_path(`${GLib.getenv('SLH_ROOT')}/run/expected-logs.json`).replace_contents(
        JSON.stringify(expectedLogs), null, false, Gio.FileCreateFlags.PRIVATE, null);
    const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE});
    launcher.setenv('STEALTH_LOCK_TEST_EXTENSION', Main.extensionManager.lookup(uuid).path, true);
    launcher.setenv('GSETTINGS_BACKEND', 'memory', true);
    launcher.setenv('ADW_DISABLE_PORTAL', '1', true);
    const libraries = ['/usr/lib/gnome-shell', '/usr/lib64/gnome-shell', '/usr/lib/x86_64-linux-gnu/gnome-shell']
        .filter(path => GLib.file_test(path, GLib.FileTest.IS_DIR));
    launcher.setenv('LD_LIBRARY_PATH', libraries.join(':'), true);
    launcher.setenv('GI_TYPELIB_PATH', libraries.map(path => `${path}/girepository-1.0`).join(':'), true);
    const preferences = launcher.spawnv(['gjs', '-m', directory.get_child('preferences.js').get_path()]);
    const [, output, errors] = await new Promise((resolve, reject) => {
        preferences.communicate_utf8_async(null, null, (process, result) => {
            try {
                resolve(process.communicate_utf8_finish(result));
            } catch (error) {
                reject(error);
            }
        });
    });
    assert(preferences.get_successful(), `Actual Extensions preferences host failed: ${errors}`);
    assert(output.includes('STEALTH_LOCK_PREFERENCES_OK'), 'Actual Extensions preferences host completes');
    assert(!/JS ERROR|CRITICAL|WARNING/.test(errors), `Preferences native diagnostics: ${errors}`);
    console.log('Stealth Lock native: actual Extensions preferences host and native accelerator capture passed');
    assert(passed > 0, 'No native checks ran');
    return {passed, skipped, preferences: true, fakeGdm: GLib.getenv('SLH_FAKE_GDM') === '1'};
}
