import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class StealthLockPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        this._dialogs = new Set();
        this._cancellable = new Gio.Cancellable();
        window.set_default_size(760, 780);

        const page = new Adw.PreferencesPage({title: _('General'), icon_name: 'dialog-password-symbolic'});
        window.add(page);
        const shortcuts = new Adw.PreferencesGroup({title: _('Keyboard Shortcut')});
        const features = new Adw.PreferencesGroup({title: _('Features')});
        const password = new Adw.PreferencesGroup({title: _('Password Prompt')});
        const cursor = new Adw.PreferencesGroup({title: _('Cursor'), sensitive: settings.get_string('cursor-mode') === 'lock-icon'});
        const styles = new Adw.PreferencesGroup({title: _('Appearance')});
        const debug = new Adw.PreferencesGroup({title: _('Debug'), description: _('Troubleshooting and handoff to the GNOME lock screen')});
        const notes = new Adw.PreferencesGroup({title: _('Important Notes')});
        for (const group of [shortcuts, features, password, cursor, styles, debug, notes])
            page.add(group);

        const shortcutLabels = new Map();
        let abortRow;
        for (const [key, group, title, subtitle] of [
            ['lock-hotkey', shortcuts, _('Activation Hotkey'), _('Activate the privacy screen')],
            ['debug-abort-hotkey', debug, _('Abort Hotkey (Debug)'), _('Hand off to the GNOME lock screen; a password is still required')],
        ]) {
            const row = new Adw.ActionRow({title, subtitle});
            const label = new Gtk.ShortcutLabel({accelerator: settings.get_strv(key)[0] ?? '', valign: Gtk.Align.CENTER});
            const edit = new Gtk.Button({icon_name: 'edit-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'], tooltip_text: _('Set shortcut')});
            const reset = new Gtk.Button({icon_name: 'edit-clear-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'], tooltip_text: _('Reset to default')});
            row.add_suffix(label);
            row.add_suffix(edit);
            row.add_suffix(reset);
            row.activatable_widget = edit;
            group.add(row);
            shortcutLabels.set(key, label);
            edit.connect('clicked', () => this._showShortcutEditor(window, settings, key));
            reset.connect('clicked', () => settings.reset(key));
            if (key === 'debug-abort-hotkey')
                abortRow = row;
        }

        for (const [key, title, subtitle] of [
            ['freeze-display', _('Freeze Display'), _('Keep an in-memory snapshot of all monitors while active')],
            ['pause-media', _('Pause Media'), _('Pause playing MPRIS media and resume those players after unlock')],
        ]) {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            features.add(row);
        }
        const autoReset = new Adw.SpinRow({
            title: _('Auto Reset (seconds)'),
            subtitle: _('Clear the password after inactivity; 0 disables the timer'),
            adjustment: new Gtk.Adjustment({lower: 0, upper: 3600, step_increment: 1, page_increment: 10}),
        });
        settings.bind('auto-reset-seconds', autoReset, 'value', Gio.SettingsBindFlags.DEFAULT);
        features.add(autoReset);

        const comboRows = new Map();
        for (const [key, group, title, subtitle, values, labels] of [
            ['cursor-mode', features, _('Cursor'), _('Choose how the pointer appears while active'), ['lock-icon', 'normal', 'hidden'], [_('Lock Icon'), _('Normal Cursor'), _('No Cursor')]],
            ['lock-type', password, _('Lock Type'), _('Stealth hides the prompt; Normal shows a password entry'), ['stealth', 'normal'], [_('Stealth'), _('Normal')]],
            ['normal-prompt-cursor-anchor', password, _('Cursor Anchor'), _('Place the prompt at this corner of the pointer'), ['br', 'tr', 'tl', 'bl'], [_('Bottom Right'), _('Top Right'), _('Top Left'), _('Bottom Left')]],
        ]) {
            const row = new Adw.ComboRow({title, subtitle, model: Gtk.StringList.new(labels), selected: Math.max(0, values.indexOf(settings.get_string(key)))});
            row.connect('notify::selected', () => {
                settings.set_string(key, values[row.selected]);
                if (key === 'cursor-mode')
                    settings.set_boolean('lock-cursor', row.selected === 0);
            });
            comboRows.set(key, {row, values});
            group.add(row);
        }
        const follow = new Adw.SwitchRow({title: _('Follow Cursor'), subtitle: _('Position the normal prompt relative to the pointer')});
        settings.bind('normal-prompt-follow-cursor', follow, 'active', Gio.SettingsBindFlags.DEFAULT);
        password.add(follow);

        const positionRows = new Map();
        for (const [key, title, subtitle, lower, upper, step] of [
            ['normal-prompt-offset-x', _('Cursor Offset X'), _('Horizontal distance from the pointer in pixels'), -500, 500, 10],
            ['normal-prompt-offset-y', _('Cursor Offset Y'), _('Vertical distance from the pointer in pixels'), -500, 500, 10],
            ['normal-prompt-fixed-x', _('Fixed X'), _('Horizontal position in pixels; -1 centers the prompt'), -1, 10000, 50],
            ['normal-prompt-fixed-y', _('Fixed Y'), _('Vertical position in pixels; -1 centers the prompt'), -1, 10000, 50],
        ]) {
            const row = new Adw.SpinRow({title, subtitle, adjustment: new Gtk.Adjustment({lower, upper, step_increment: 1, page_increment: step})});
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
            positionRows.set(key, row);
            password.add(row);
        }
        const monitorValues = [''];
        const monitorLabels = [_('All Monitors')];
        const monitors = Gdk.Display.get_default().get_monitors();
        for (let index = 0; index < monitors.get_n_items(); index++) {
            const monitor = monitors.get_item(index);
            const label = [String(index), monitor.get_connector(), monitor.get_model()].filter(Boolean).join(': ');
            monitorValues.push(String(index));
            monitorLabels.push(label);
        }
        const selectedMonitor = settings.get_string('normal-prompt-monitor');
        if (!monitorValues.includes(selectedMonitor)) {
            monitorValues.push(selectedMonitor);
            monitorLabels.push(_('Monitor %s (disconnected)').format(selectedMonitor));
        }
        const monitorRow = new Adw.ComboRow({title: _('Monitor'), subtitle: _('Center the fixed prompt on this monitor'), model: Gtk.StringList.new(monitorLabels), selected: monitorValues.indexOf(selectedMonitor)});
        monitorRow.connect('notify::selected', () => settings.set_string('normal-prompt-monitor', monitorValues[monitorRow.selected]));
        password.add(monitorRow);
        comboRows.set('normal-prompt-monitor', {row: monitorRow, values: monitorValues});

        const bitmap = new Adw.EntryRow({title: _('Cursor Bitmap'), tooltip_text: _('Optional image path or URI; leave blank to use the built-in cursor')});
        settings.bind('cursor-bitmap-path', bitmap, 'text', Gio.SettingsBindFlags.DEFAULT);
        const browse = new Gtk.Button({icon_name: 'folder-open-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'], tooltip_text: _('Select image')});
        const clearBitmap = new Gtk.Button({icon_name: 'edit-clear-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'], tooltip_text: _('Use built-in cursor')});
        bitmap.add_suffix(browse);
        bitmap.add_suffix(clearBitmap);
        cursor.add(bitmap);
        clearBitmap.connect('clicked', () => settings.reset('cursor-bitmap-path'));
        browse.connect('clicked', () => {
            const images = new Gtk.FileFilter({name: _('Images')});
            images.add_mime_type('image/*');
            const files = new Gtk.FileFilter({name: _('All Files')});
            files.add_pattern('*');
            const filters = new Gio.ListStore({item_type: Gtk.FileFilter});
            filters.append(images);
            filters.append(files);
            const dialog = new Gtk.FileDialog({title: _('Select Cursor Image'), filters, default_filter: images});
            browse.sensitive = false;
            dialog.open(window, this._cancellable, (source, result) => {
                try {
                    const file = source.open_finish(result);
                    if (!this._cancellable.is_cancelled())
                        settings.set_string('cursor-bitmap-path', file.get_path() ?? file.get_uri());
                } catch (error) {
                    if (!error.matches(Gtk.DialogError, Gtk.DialogError.DISMISSED) &&
                        !error.matches(Gtk.DialogError, Gtk.DialogError.CANCELLED) &&
                        !error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                        console.error('Stealth Lock: cursor image picker failed', error);
                        if (!this._cancellable.is_cancelled())
                            window.add_toast(new Adw.Toast({title: _('Could not open cursor image')}));
                    }
                } finally {
                    if (!this._cancellable.is_cancelled())
                        browse.sensitive = true;
                }
            });
        });

        const colorButtons = new Map();
        for (const [key, title, subtitle] of [
            ['cursor-fg-rgba', _('Cursor Foreground'), _('Outline and details of the built-in cursor')],
            ['cursor-bg-rgba', _('Cursor Background'), _('Fill of the built-in cursor')],
        ]) {
            const bytes = settings.get_value(key).deep_unpack();
            const rgba = new Gdk.RGBA({red: bytes[0] / 255, green: bytes[1] / 255, blue: bytes[2] / 255, alpha: bytes[3] / 255});
            const row = new Adw.ActionRow({title, subtitle});
            const button = new Gtk.ColorDialogButton({dialog: new Gtk.ColorDialog({with_alpha: true}), rgba, valign: Gtk.Align.CENTER});
            button.connect('notify::rgba', () => {
                const value = button.rgba;
                const components = [value.red, value.green, value.blue, value.alpha].map(component => Math.round(component * 255));
                settings.set_value(key, new GLib.Variant('au', components));
            });
            row.add_suffix(button);
            row.activatable_widget = button;
            cursor.add(row);
            colorButtons.set(key, button);
        }
        for (const [key, title, description] of [
            ['normal-prompt-css', _('Prompt CSS'), _('Inline CSS for the normal password prompt container')],
            ['normal-background-css', _('Background CSS'), _('Inline CSS for the full-screen background')],
        ]) {
            const row = new Adw.ActionRow({title, subtitle: description});
            const edit = new Gtk.Button({icon_name: 'document-edit-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'], tooltip_text: _('Edit CSS and saved styles')});
            row.add_suffix(edit);
            row.activatable_widget = edit;
            styles.add(row);
            edit.connect('clicked', () => this._showStyleEditor(window, settings, key, title, description));
        }
        styles.add(new Adw.ActionRow({
            title: _('Legacy JavaScript'),
            subtitle: _('Previous scripts and saved entries remain in GSettings for export. They are ignored and are never executed.'),
        }));

        const debugMode = new Adw.SwitchRow({title: _('Enable Debug Mode'), subtitle: _('Enable diagnostic logging and the abort shortcut')});
        const debugInfo = new Adw.SwitchRow({title: _('Show Debug Info'), subtitle: _('Show diagnostic status while the privacy screen is active')});
        const useActivation = new Adw.SwitchRow({title: _('Abort Hotkey = Activation Hotkey'), subtitle: _('Use the activation shortcut to hand off to the GNOME lock screen')});
        for (const [key, row] of [
            ['debug-mode', debugMode],
            ['debug-show-info', debugInfo],
            ['debug-abort-use-lock-hotkey', useActivation],
        ]) {
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            debug.add(row);
        }
        notes.add(new Adw.ActionRow({
            title: _('Privacy Screen'),
            subtitle: _('This extension blocks normal desktop input while active. Disabling it or restarting GNOME Shell can remove the overlay. Use the GNOME lock screen for session security.'),
        }));
        notes.add(new Adw.ActionRow({
            title: _('System Password'),
            subtitle: _('Unlock uses your login password. Passwords are not saved in settings or written to disk. Ctrl+Alt+Shift+L hands off to the GNOME lock screen.'),
        }));

        const isNormal = settings.get_string('lock-type') === 'normal';
        const follows = settings.get_boolean('normal-prompt-follow-cursor');
        follow.sensitive = isNormal;
        comboRows.get('normal-prompt-cursor-anchor').row.sensitive = isNormal && follows;
        monitorRow.sensitive = isNormal && !follows;
        for (const [key, row] of positionRows)
            row.sensitive = isNormal && (key.includes('offset') ? follows : !follows);
        debugInfo.sensitive = debugMode.active;
        useActivation.sensitive = debugMode.active;
        abortRow.sensitive = debugMode.active && !useActivation.active;
        shortcutLabels.get('debug-abort-hotkey').accelerator = settings.get_strv(useActivation.active ? 'lock-hotkey' : 'debug-abort-hotkey')[0] ?? '';

        let previousUseActivation = useActivation.active;
        const settingsId = settings.connect('changed', (_settings, key) => {
            if (key === 'debug-abort-use-lock-hotkey' && previousUseActivation !== useActivation.active) {
                previousUseActivation = useActivation.active;
                if (useActivation.active) {
                    settings.set_strv('debug-abort-hotkey-custom', settings.get_strv('debug-abort-hotkey'));
                    settings.set_strv('debug-abort-hotkey', settings.get_strv('lock-hotkey'));
                } else {
                    settings.set_strv('debug-abort-hotkey', settings.get_strv('debug-abort-hotkey-custom'));
                }
            } else if (key === 'lock-hotkey' && useActivation.active) {
                settings.set_strv('debug-abort-hotkey', settings.get_strv('lock-hotkey'));
            } else if (key === 'debug-abort-hotkey' && !useActivation.active) {
                settings.set_strv('debug-abort-hotkey-custom', settings.get_strv('debug-abort-hotkey'));
            }
            const combo = comboRows.get(key);
            if (combo)
                combo.row.selected = Math.max(0, combo.values.indexOf(settings.get_string(key)));
            const color = colorButtons.get(key);
            if (color) {
                const bytes = settings.get_value(key).deep_unpack();
                color.rgba = new Gdk.RGBA({red: bytes[0] / 255, green: bytes[1] / 255, blue: bytes[2] / 255, alpha: bytes[3] / 255});
            }
            shortcutLabels.get('lock-hotkey').accelerator = settings.get_strv('lock-hotkey')[0] ?? '';
            shortcutLabels.get('debug-abort-hotkey').accelerator = settings.get_strv(useActivation.active ? 'lock-hotkey' : 'debug-abort-hotkey')[0] ?? '';
            cursor.sensitive = settings.get_string('cursor-mode') === 'lock-icon';
            const normal = settings.get_string('lock-type') === 'normal';
            const following = settings.get_boolean('normal-prompt-follow-cursor');
            follow.sensitive = normal;
            comboRows.get('normal-prompt-cursor-anchor').row.sensitive = normal && following;
            monitorRow.sensitive = normal && !following;
            for (const [positionKey, row] of positionRows)
                row.sensitive = normal && (positionKey.includes('offset') ? following : !following);
            debugInfo.sensitive = settings.get_boolean('debug-mode');
            useActivation.sensitive = settings.get_boolean('debug-mode');
            abortRow.sensitive = settings.get_boolean('debug-mode') && !useActivation.active;
        });
        window.connect('close-request', () => {
            this._cancellable.cancel();
            settings.disconnect(settingsId);
            for (const dialog of this._dialogs)
                dialog.destroy();
            this._dialogs.clear();
            return false;
        });
    }

    _showShortcutEditor(window, settings, key) {
        const dialog = new Gtk.Dialog({title: _('Set Shortcut'), transient_for: window, modal: true, destroy_with_parent: true, default_width: 440});
        this._dialogs.add(dialog);
        dialog.add_button(_('Cancel'), Gtk.ResponseType.CANCEL);
        const save = dialog.add_button(_('Save'), Gtk.ResponseType.OK);
        save.sensitive = false;
        const content = dialog.get_content_area();
        content.set_margin_top(24);
        content.set_margin_bottom(24);
        content.set_margin_start(24);
        content.set_margin_end(24);
        content.set_spacing(16);
        content.append(new Gtk.Label({label: _('Press the desired key combination. Escape cancels.'), wrap: true}));
        const preview = new Gtk.ShortcutLabel({accelerator: ''});
        content.append(preview);
        const controller = new Gtk.EventControllerKey({propagation_phase: Gtk.PropagationPhase.CAPTURE});
        controller.connect('key-pressed', (keyController, keyval, _keycode, state) => {
            if (keyval === Gdk.KEY_Escape) {
                dialog.response(Gtk.ResponseType.CANCEL);
                return true;
            }
            if (keyController.get_current_event().is_modifier())
                return true;
            preview.accelerator = Gtk.accelerator_name(keyval, state & Gtk.accelerator_get_default_mod_mask());
            save.sensitive = preview.accelerator !== '';
            return true;
        });
        dialog.add_controller(controller);
        dialog.connect('response', (_dialog, response) => {
            if (response === Gtk.ResponseType.OK)
                settings.set_strv(key, [preview.accelerator]);
            this._dialogs.delete(dialog);
            dialog.destroy();
        });
        dialog.present();
    }

    _showStyleEditor(window, settings, key, title, description) {
        const entriesKey = key + '-saved-entries';
        let entries;
        let savedEntriesValid = true;
        try {
            entries = JSON.parse(settings.get_string(entriesKey));
            if (!Array.isArray(entries))
                throw new Error('Saved styles must be an array');
            entries = entries.filter(entry => typeof entry?.name === 'string' && entry.name.trim() && typeof entry.code === 'string')
                .map(entry => ({name: entry.name.trim(), code: entry.code}));
        } catch (error) {
            console.error('Stealth Lock: could not read saved styles', error);
            entries = [];
            savedEntriesValid = false;
        }
        const dialog = new Gtk.Dialog({title, transient_for: window, modal: true, destroy_with_parent: true, default_width: 780, default_height: 620});
        this._dialogs.add(dialog);
        dialog.add_button(_('Cancel'), Gtk.ResponseType.CANCEL);
        dialog.add_button(_('Apply'), Gtk.ResponseType.OK);
        const content = dialog.get_content_area();
        content.set_margin_top(16);
        content.set_margin_bottom(16);
        content.set_margin_start(16);
        content.set_margin_end(16);
        content.set_spacing(12);
        content.append(new Gtk.Label({label: description + '. ' + _('Use CSS declarations only. Leave blank to use the default style.'), wrap: true, xalign: 0}));
        if (!savedEntriesValid)
            content.append(new Gtk.Label({label: _('Saved styles could not be read. Their existing GSettings value has been retained.'), wrap: true, xalign: 0}));

        const names = Gtk.StringList.new(entries.map(entry => entry.name));
        const toolbar = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 8});
        const selector = new Gtk.DropDown({model: names, hexpand: true});
        const load = new Gtk.Button({label: _('Use Saved'), sensitive: entries.length > 0});
        toolbar.append(selector);
        toolbar.append(load);
        content.append(toolbar);
        const name = new Gtk.Entry({placeholder_text: _('Saved style name'), text: entries[0]?.name ?? ''});
        content.append(name);
        const actions = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 8});
        const add = new Gtk.Button({label: _('Save As New'), sensitive: savedEntriesValid && name.text.trim() !== ''});
        const replace = new Gtk.Button({label: _('Replace Saved'), sensitive: entries.length > 0});
        const rename = new Gtk.Button({label: _('Rename'), sensitive: entries.length > 0});
        const remove = new Gtk.Button({label: _('Delete'), sensitive: entries.length > 0, css_classes: ['destructive-action']});
        for (const button of [add, replace, rename, remove])
            actions.append(button);
        content.append(actions);
        const scroll = new Gtk.ScrolledWindow({hexpand: true, vexpand: true});
        const editor = new Gtk.TextView({monospace: true, wrap_mode: Gtk.WrapMode.NONE});
        const buffer = editor.get_buffer();
        buffer.set_text(settings.get_string(key), -1);
        scroll.set_child(editor);
        content.append(scroll);

        selector.connect('notify::selected', () => {
            const entry = entries[selector.selected];
            name.text = entry?.name ?? '';
            load.sensitive = !!entry;
            replace.sensitive = !!entry;
            rename.sensitive = !!entry && name.text.trim() !== '';
            remove.sensitive = !!entry;
        });
        name.connect('changed', () => {
            add.sensitive = savedEntriesValid && name.text.trim() !== '';
            rename.sensitive = !!entries[selector.selected] && name.text.trim() !== '';
        });
        load.connect('clicked', () => {
            const entry = entries[selector.selected];
            buffer.set_text(entry.code, -1);
            settings.set_string(key, entry.code);
        });
        add.connect('clicked', () => {
            const base = name.text.trim();
            const taken = new Set(entries.map(entry => entry.name.toLowerCase()));
            let uniqueName = base;
            let suffix = 2;
            while (taken.has(uniqueName.toLowerCase()))
                uniqueName = base + ' (' + suffix++ + ')';
            const code = buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), false);
            entries.push({name: uniqueName, code});
            settings.set_string(entriesKey, JSON.stringify(entries));
            names.splice(0, names.get_n_items(), entries.map(entry => entry.name));
            selector.selected = entries.length - 1;
            name.text = uniqueName;
        });
        replace.connect('clicked', () => {
            entries[selector.selected].code = buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), false);
            settings.set_string(entriesKey, JSON.stringify(entries));
        });
        rename.connect('clicked', () => {
            const index = selector.selected;
            const base = name.text.trim();
            const taken = new Set(entries.filter((_entry, entryIndex) => entryIndex !== index).map(entry => entry.name.toLowerCase()));
            let uniqueName = base;
            let suffix = 2;
            while (taken.has(uniqueName.toLowerCase()))
                uniqueName = base + ' (' + suffix++ + ')';
            entries[index].name = uniqueName;
            settings.set_string(entriesKey, JSON.stringify(entries));
            names.splice(0, names.get_n_items(), entries.map(entry => entry.name));
            selector.selected = index;
            name.text = uniqueName;
        });
        remove.connect('clicked', () => {
            entries.splice(selector.selected, 1);
            settings.set_string(entriesKey, JSON.stringify(entries));
            names.splice(0, names.get_n_items(), entries.map(entry => entry.name));
            selector.selected = entries.length ? 0 : Gtk.INVALID_LIST_POSITION;
            name.text = entries[0]?.name ?? '';
        });
        dialog.connect('response', (_dialog, response) => {
            if (response === Gtk.ResponseType.OK)
                settings.set_string(key, buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), false));
            this._dialogs.delete(dialog);
            dialog.destroy();
        });
        dialog.present();
    }
}
