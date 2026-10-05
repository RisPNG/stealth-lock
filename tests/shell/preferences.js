import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

Gio.Resource.load('/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource')._register();
const path = GLib.getenv('STEALTH_LOCK_TEST_EXTENSION');
const dir = Gio.File.new_for_path(path);
const [, bytes] = dir.get_child('metadata.json').load_contents(null);
const metadata = JSON.parse(new TextDecoder().decode(bytes));
const {default: Preferences} = await import(dir.get_child('prefs.js').get_uri());
const {extensionManager} = await import('resource:///org/gnome/Shell/Extensions/js/extensionsService.js');
const {serializeExtension} = await import('resource:///org/gnome/Shell/Extensions/js/misc/extensionUtils.js');
const extension = extensionManager.createExtensionObject(serializeExtension({metadata, path}));

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function findWidget(widget, predicate) {
    if (predicate(widget))
        return widget;
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) {
        const found = findWidget(child, predicate);
        if (found)
            return found;
    }
    return null;
}

const app = new Adw.Application({application_id: 'org.example.StealthLockPreferencesTest', flags: Gio.ApplicationFlags.NON_UNIQUE});
let failure = null;
app.connect('activate', () => {
    const window = new Adw.PreferencesWindow({application: app});
    const preferences = new Preferences({...metadata, dir, path});
    extension.stateObj = preferences;
    const settings = preferences.getSettings();
    settings.set_string('normal-prompt-custom-js', 'throw new Error("legacy code must never execute")');
    try {
        preferences.fillPreferencesWindow(window);
        window.present();
        const freeze = findWidget(window, widget => widget instanceof Adw.SwitchRow && widget.title === 'Freeze Display');
        assert(freeze, 'Freeze display control was not built');
        freeze.active = false;
        assert(!settings.get_boolean('freeze-display'), 'Native switch binding failed');
        const reset = findWidget(window, widget => widget instanceof Adw.SpinRow && widget.title === 'Auto Reset (seconds)');
        reset.value = 9;
        assert(settings.get_uint('auto-reset-seconds') === 9, 'Native numeric binding failed');
        const type = findWidget(window, widget => widget instanceof Adw.ComboRow && widget.title === 'Lock Type');
        type.selected = 1;
        const follow = findWidget(window, widget => widget instanceof Adw.SwitchRow && widget.title === 'Follow Cursor');
        const anchor = findWidget(window, widget => widget instanceof Adw.ComboRow && widget.title === 'Cursor Anchor');
        assert(follow.sensitive && !anchor.sensitive, 'Normal fixed prompt controls have wrong sensitivity');
        follow.active = true;
        assert(anchor.sensitive, 'Follow cursor controls did not become sensitive');
        const debug = findWidget(window, widget => widget instanceof Adw.SwitchRow && widget.title === 'Enable Debug Mode');
        const useActivation = findWidget(window, widget => widget instanceof Adw.SwitchRow && widget.title === 'Abort Hotkey = Activation Hotkey');
        debug.active = true;
        const custom = settings.get_strv('debug-abort-hotkey')[0];
        useActivation.active = true;
        settings.set_strv('lock-hotkey', ['<Super><Control>k']);
        assert(settings.get_strv('debug-abort-hotkey')[0] === '<Super><Control>k', 'Matching abort shortcut did not follow activation');
        useActivation.active = false;
        assert(settings.get_strv('debug-abort-hotkey')[0] === custom, 'Custom abort shortcut was not restored');
        assert(settings.get_string('normal-prompt-custom-js').includes('legacy code'), 'Legacy JavaScript was modified');
        preferences._showShortcutEditor(window, settings, 'lock-hotkey');
        for (const dialog of preferences._dialogs)
            dialog.response(Gtk.ResponseType.CANCEL);
        assert(preferences._dialogs.size === 0, 'Shortcut dialog did not close');
        preferences._showShortcutEditor(window, settings, 'lock-hotkey');
        const shortcutDialog = [...preferences._dialogs][0];
        findWidget(shortcutDialog, widget => widget instanceof Gtk.ShortcutLabel).accelerator = '<Control><Alt>j';
        shortcutDialog.response(Gtk.ResponseType.OK);
        assert(settings.get_strv('lock-hotkey')[0] === '<Control><Alt>j', 'Shortcut Save did not persist its preview');
        assert(preferences._dialogs.size === 0, 'Saved shortcut dialog did not close');

        for (const key of ['normal-prompt-css', 'normal-background-css']) {
            preferences._showStyleEditor(window, settings, key, 'CSS Test', 'Test CSS');
            const dialog = [...preferences._dialogs][0];
            const editor = findWidget(dialog, widget => widget instanceof Gtk.TextView);
            const name = findWidget(dialog, widget => widget instanceof Gtk.Entry);
            const buffer = editor.get_buffer();
            name.text = 'example';
            buffer.set_text('padding: 12px;', -1);
            findWidget(dialog, widget => widget instanceof Gtk.Button && widget.label === 'Save As New').emit('clicked');
            let entries = JSON.parse(settings.get_string(key + '-saved-entries'));
            assert(entries[0].name === 'example' && entries[0].code === 'padding: 12px;', 'Saved style creation failed');
            buffer.set_text('padding: 8px;', -1);
            findWidget(dialog, widget => widget instanceof Gtk.Button && widget.label === 'Replace Saved').emit('clicked');
            name.text = 'renamed';
            findWidget(dialog, widget => widget instanceof Gtk.Button && widget.label === 'Rename').emit('clicked');
            entries = JSON.parse(settings.get_string(key + '-saved-entries'));
            assert(entries[0].name === 'renamed' && entries[0].code === 'padding: 8px;', 'Saved style update or rename failed');
            findWidget(dialog, widget => widget instanceof Gtk.Button && widget.label === 'Use Saved').emit('clicked');
            assert(settings.get_string(key) === 'padding: 8px;', 'Saved style load failed');
            findWidget(dialog, widget => widget instanceof Gtk.Button && widget.label === 'Delete').emit('clicked');
            assert(settings.get_string(key + '-saved-entries') === '[]', 'Saved style deletion failed');
            buffer.set_text('padding: 4px;', -1);
            dialog.response(Gtk.ResponseType.OK);
            assert(settings.get_string(key) === 'padding: 4px;', 'Style Apply did not persist the editor');
        }
        window.close();
        assert(preferences._cancellable.is_cancelled() && preferences._dialogs.size === 0, 'Preferences close did not release resources');
        globalThis.print('STEALTH_LOCK_PREFERENCES_OK');
    } catch (error) {
        failure = error;
        window.close();
    } finally {
        app.quit();
    }
});
app.run([]);
if (failure)
    throw failure;
