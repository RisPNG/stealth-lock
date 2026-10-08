import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import {delay, waitFor} from './support.js';

Adw.init();
GObject.gtypeNameBasedOnJSPath = true;
Gio.Resource.load('/usr/share/gnome-shell/gnome-shell-dbus-interfaces.gresource')._register();
Gio.Resource.load('/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource')._register();
const path = GLib.getenv('STEALTH_LOCK_TEST_EXTENSION');
const dir = Gio.File.new_for_path(path);
const [, bytes] = dir.get_child('metadata.json').load_contents(null);
const metadata = JSON.parse(new TextDecoder().decode(bytes));
const {ExtensionPrefsDialog} = await import('resource:///org/gnome/Shell/Extensions/js/extensionPrefsDialog.js');
const {extensionManager} = await import('resource:///org/gnome/Shell/Extensions/js/extensionsService.js');
const {serializeExtension} = await import('resource:///org/gnome/Shell/Extensions/js/misc/extensionUtils.js');
const extension = extensionManager.createExtensionObject(serializeExtension({metadata, path, type: 2, state: 6, enabled: false, error: '', hasPrefs: true, hasUpdate: false, canChange: true, sessionModes: []}));

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

async function injectShortcut(keys) {
    for (const key of keys)
        Gio.DBus.session.call_sync('org.stealthlock.Harness', '/org/stealthlock/Harness', 'org.stealthlock.Harness',
            'Key', new GLib.Variant('(sb)', [key, true]), null, Gio.DBusCallFlags.NONE, 2000, null);
    await delay(50);
    for (const key of [...keys].reverse())
        Gio.DBus.session.call_sync('org.stealthlock.Harness', '/org/stealthlock/Harness', 'org.stealthlock.Harness',
            'Key', new GLib.Variant('(sb)', [key, false]), null, Gio.DBusCallFlags.NONE, 2000, null);
    await delay(80);
}

const window = new ExtensionPrefsDialog(extension);
const loaded = new Promise(resolve => window.connect('loaded', resolve));
try {
    await Promise.race([loaded, delay(10000).then(() => { throw new Error('Preferences load timed out'); })]);
    assert(window.visible_page instanceof Adw.PreferencesPage, 'Actual Extensions host displays preferences');
    const preferences = extension.stateObj;
    const settings = preferences.getSettings();
    const starters = JSON.parse(settings.get_string('visual-effect-presets'));
    assert(starters.length === 3 && new Set(starters.map(entry => JSON.parse(entry.code).effect)).size === 3, 'Fresh profile seeds three ordinary effect entries');
    assert(settings.get_boolean('visual-effect-initialized') && settings.get_string('visual-effect-active') === '', 'Starter effects initialize once and remain inactive');
    window.present();
    await waitFor(() => window.is_active, 'Actual Extensions preferences window gains native focus');
    for (const [title, key] of [
        ['Freeze Display', 'freeze-display'], ['Pause Media', 'pause-media'],
        ['Follow Cursor', 'normal-prompt-follow-cursor'], ['Enable Debug Mode', 'debug-mode'],
    ]) {
        const row = findWidget(window, widget => widget instanceof Adw.SwitchRow && widget.title === title);
        const original = settings.get_boolean(key);
        row.active = !original;
        assert(settings.get_boolean(key) === !original, `${title}: widget writes settings`);
        settings.set_boolean(key, original);
        assert(row.active === original, `${title}: settings update widget`);
    }
    for (const [title, key] of [
        ['Auto Reset (seconds)', 'auto-reset-seconds'], ['Cursor Offset X', 'normal-prompt-offset-x'],
        ['Cursor Offset Y', 'normal-prompt-offset-y'], ['Fixed X', 'normal-prompt-fixed-x'], ['Fixed Y', 'normal-prompt-fixed-y'],
    ]) {
        const row = findWidget(window, widget => widget instanceof Adw.SpinRow && widget.title === title);
        const [, range] = settings.settings_schema.get_key(key).get_range().deep_unpack();
        const [lower, upper] = range.deep_unpack();
        assert(row.adjustment.lower === lower && row.adjustment.upper === upper, `${title}: native schema range`);
        row.value = upper;
        assert(settings.get_value(key).deep_unpack() === upper, `${title}: widget writes upper bound`);
        row.value = lower;
        assert(settings.get_value(key).deep_unpack() === lower, `${title}: widget writes lower bound`);
        settings.reset(key);
        assert(row.value === settings.get_value(key).deep_unpack(), `${title}: reset updates widget`);
    }
    for (const [title, key] of [['Cursor', 'cursor-mode'], ['Lock Type', 'lock-type'], ['Cursor Anchor', 'normal-prompt-cursor-anchor']]) {
        const row = findWidget(window, widget => widget instanceof Adw.ComboRow && widget.title === title);
        for (let index = 0; index < row.model.get_n_items(); index++) {
            row.selected = index;
            assert(settings.get_enum(key) === index, `${title}: native enum choice`);
        }
        settings.reset(key);
        assert(row.selected === settings.get_enum(key), `${title}: enum reset updates row`);
    }
    const color = findWidget(window, widget => widget instanceof Adw.ActionRow && widget.title === 'Cursor Foreground').activatable_widget;
    color.rgba = new Gdk.RGBA({red: 0.2, green: 0.4, blue: 0.6, alpha: 0.8});
    assert(JSON.stringify(settings.get_value('cursor-fg-rgba').deep_unpack()) === '[51,102,153,204]', 'Native color button writes schema bytes');
    settings.set_value('cursor-fg-rgba', new GLib.Variant('au', [255, 255, 255, 255]));
    assert(color.rgba.red === 1, 'Stored cursor color updates native control');
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
    const abort = findWidget(window, widget => widget instanceof Adw.ActionRow && widget.title === 'Abort Hotkey (Debug)');
    const abortLabel = findWidget(abort, widget => widget instanceof Gtk.ShortcutLabel);
    debug.active = true;
    const custom = settings.get_strv('debug-abort-hotkey')[0];
    useActivation.active = true;
    assert(settings.get_strv('debug-abort-hotkey')[0] === custom, 'Sharing activation preserves the stored custom abort shortcut');
    assert(abortLabel.accelerator === settings.get_strv('lock-hotkey')[0], 'Shared abort label shows the activation shortcut');
    settings.set_strv('lock-hotkey', ['<Super><Control>k']);
    assert(settings.get_strv('debug-abort-hotkey')[0] === custom, 'Changing activation leaves the stored custom abort shortcut unchanged');
    assert(abortLabel.accelerator === '<Super><Control>k', 'Shared abort label follows activation changes');
    useActivation.active = false;
    assert(settings.get_strv('debug-abort-hotkey')[0] === custom, 'Disabling sharing preserves the stored custom abort shortcut');
    assert(abortLabel.accelerator === custom, 'Disabling sharing displays the custom abort shortcut');
    preferences._showShortcutEditor(window, settings, 'lock-hotkey');
    for (const dialog of preferences._dialogs)
        dialog.response(Gtk.ResponseType.CANCEL);
    assert(preferences._dialogs.size === 0, 'Shortcut dialog did not close');
    preferences._showShortcutEditor(window, settings, 'lock-hotkey');
    const shortcutDialog = [...preferences._dialogs][0];
    await delay(100);
    await injectShortcut(['j']);
    assert(!shortcutDialog.get_widget_for_response(Gtk.ResponseType.OK).sensitive, 'Printable shortcut rejected');
    await injectShortcut(['Control_L', 'Alt_L', 'j']);
    assert(shortcutDialog.get_widget_for_response(Gtk.ResponseType.OK).sensitive, 'Captured modified shortcut enables Save');
    shortcutDialog.response(Gtk.ResponseType.OK);
    assert(settings.get_strv('lock-hotkey')[0] === '<Control><Alt>j', 'Shortcut Save did not persist its preview');
    assert(preferences._dialogs.size === 0, 'Saved shortcut dialog did not close');
    preferences._showShortcutEditor(window, settings, 'lock-hotkey');
    const resetDialog = [...preferences._dialogs][0];
    await delay(100);
    await injectShortcut(['BackSpace']);
    resetDialog.response(Gtk.ResponseType.OK);
    assert(settings.get_user_value('lock-hotkey') === null, 'Native Backspace and Save reset to schema default');
    preferences._showShortcutEditor(window, settings, 'lock-hotkey');
    await delay(100);
    await injectShortcut(['Escape']);
    assert(preferences._dialogs.size === 0, 'Native Escape cancels shortcut dialog');

    for (const key of ['normal-prompt-css', 'normal-background-css']) {
        preferences._showSavedEntryEditor(window, settings, key, 'CSS Test', 'Test CSS');
        const dialog = [...preferences._dialogs][0];
        const editor = findWidget(dialog, widget => widget instanceof Gtk.TextView);
        const name = findWidget(dialog, widget => widget instanceof Gtk.Entry);
        const buffer = editor.get_buffer();
        name.text = 'example';
        buffer.set_text('padding: 12px;', -1);
        findWidget(dialog, widget => widget instanceof Gtk.Button && widget.label === 'Save As New').emit('clicked');
        const preview = findWidget(dialog, widget => widget instanceof Gtk.Label && widget.has_css_class('dim-label'));
        assert(preview.visible && preview.label === 'padding: 12px;', 'Saved style first-line preview failed');
        let entries = JSON.parse(settings.get_string(key + '-saved-entries'));
        assert(entries[0].name === 'example' && entries[0].code === 'padding: 12px;', 'Saved style creation failed');
        buffer.set_text('padding: 8px;', -1);
        findWidget(dialog, widget => widget instanceof Gtk.Button && widget.label === 'Replace Saved').emit('clicked');
        assert(preview.label === 'padding: 8px;', 'Replacement updates saved preview');
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
    const effectRow = findWidget(window, widget => widget instanceof Adw.ComboRow && widget.title === 'Visual Effect');
    assert(effectRow.model.get_n_items() === 4 && effectRow.selected === 0, 'Native effect selector offers None and all ordinary entries');
    preferences._showSavedEntryEditor(window, settings, 'visual-effect-active', 'Visual Effect Presets', 'Native effect test');
    let effectDialog = [...preferences._dialogs][0];
    let selector = findWidget(effectDialog, widget => widget instanceof Gtk.DropDown);
    let effectBuffer = findWidget(effectDialog, widget => widget instanceof Gtk.TextView).buffer;
    for (let index = 0; index < starters.length; index++) {
        selector.selected = index;
        findWidget(effectDialog, widget => widget instanceof Gtk.Button && widget.label === 'Load Saved').emit('clicked');
        const config = JSON.parse(effectBuffer.text);
        config.knobs.intervalMs = 55 + index * 5;
        effectBuffer.set_text(JSON.stringify(config), -1);
        findWidget(effectDialog, widget => widget instanceof Gtk.Button && widget.label === 'Replace Saved').emit('clicked');
        assert(JSON.parse(JSON.parse(settings.get_string('visual-effect-presets'))[index].code).knobs.intervalMs === config.knobs.intervalMs,
            'Each starter is editable as an ordinary saved entry');
        assert(settings.get_string('visual-effect-active') === '', 'Loading or replacing a draft never activates it');
    }
    const retained = settings.get_string('visual-effect-presets');
    effectBuffer.set_text('{"effect":"blur","knobs":{"unknown":1}}', -1);
    assert(!effectDialog.get_widget_for_response(Gtk.ResponseType.OK).sensitive, 'Unknown knob disables Apply');
    effectDialog.response(Gtk.ResponseType.OK);
    assert(preferences._dialogs.has(effectDialog) && settings.get_string('visual-effect-presets') === retained, 'Invalid configuration stays open and preserves saved entries');
    effectBuffer.set_text('{"effect":"blur","knobs":{}}', -1);
    const effectName = findWidget(effectDialog, widget => widget instanceof Gtk.Entry);
    effectName.text = 'Native custom effect';
    findWidget(effectDialog, widget => widget instanceof Gtk.Button && widget.label === 'Save As New').emit('clicked');
    effectDialog.response(Gtk.ResponseType.OK);
    assert(settings.get_string('visual-effect-active') === 'Native custom effect', 'Apply selects a saved custom configuration');
    assert(effectRow.selected === 4, 'Native effect selector follows active saved name');
    preferences._showSavedEntryEditor(window, settings, 'visual-effect-active', 'Visual Effect Presets', 'Native effect test');
    effectDialog = [...preferences._dialogs][0];
    findWidget(effectDialog, widget => widget instanceof Gtk.Entry).text = 'Native renamed effect';
    findWidget(effectDialog, widget => widget instanceof Gtk.Button && widget.label === 'Rename').emit('clicked');
    assert(settings.get_string('visual-effect-active') === 'Native renamed effect', 'Renaming the active ordinary entry preserves activation');
    findWidget(effectDialog, widget => widget instanceof Gtk.Button && widget.label === 'Delete').emit('clicked');
    assert(settings.get_string('visual-effect-active') === '', 'Deleting active entry selects None');
    selector = findWidget(effectDialog, widget => widget instanceof Gtk.DropDown);
    while (selector.model.get_n_items() > 0)
        findWidget(effectDialog, widget => widget instanceof Gtk.Button && widget.label === 'Delete').emit('clicked');
    effectDialog.response(Gtk.ResponseType.CANCEL);
    assert(settings.get_string('visual-effect-presets') === '[]' && effectRow.model.get_n_items() === 1, 'All starter entries can be deleted from the ordinary library');
    const {initializeEffectPresets} = await import(dir.resolve_relative_path('shared/presets.js').get_uri());
    initializeEffectPresets(settings);
    assert(settings.get_string('visual-effect-presets') === '[]', 'Deleted library remains empty when initialized again');
    window.close();
    assert(preferences._cancellable.is_cancelled() && preferences._dialogs.size === 0, 'Preferences close releases resources');
    globalThis.print('STEALTH_LOCK_PREFERENCES_OK');
} finally {
    window.close();
}
