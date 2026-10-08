import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {initializeEffectPresets, readSavedEntries, validateEffectConfig} from './shared/presets.js';

export default class StealthLockPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        initializeEffectPresets(settings);
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
        const [, [autoResetLower, autoResetUpper]] = settings.settings_schema.get_key('auto-reset-seconds').get_range().recursiveUnpack();
        const autoReset = new Adw.SpinRow({
            title: _('Auto Reset (seconds)'),
            subtitle: _('Clear the password after inactivity; 0 disables the timer'),
            adjustment: new Gtk.Adjustment({lower: autoResetLower, upper: autoResetUpper, step_increment: 1, page_increment: 10}),
        });
        settings.bind('auto-reset-seconds', autoReset, 'value', Gio.SettingsBindFlags.DEFAULT);
        features.add(autoReset);

        const comboRows = new Map();
        for (const [key, group, title, subtitle, labels] of [
            ['cursor-mode', features, _('Cursor'), _('Choose how the pointer appears while active'), [_('Lock Icon'), _('Normal Cursor'), _('No Cursor')]],
            ['lock-type', password, _('Lock Type'), _('Stealth hides the prompt; Normal shows a password entry'), [_('Stealth'), _('Normal')]],
            ['normal-prompt-cursor-anchor', password, _('Cursor Anchor'), _('Place the prompt at this corner of the pointer'), [_('Bottom Right'), _('Top Right'), _('Top Left'), _('Bottom Left')]],
        ]) {
            const row = new Adw.ComboRow({title, subtitle, model: Gtk.StringList.new(labels), selected: settings.get_enum(key)});
            row.connect('notify::selected', () => settings.set_enum(key, row.selected));
            comboRows.set(key, {row});
            group.add(row);
        }
        const follow = new Adw.SwitchRow({title: _('Follow Cursor'), subtitle: _('Position the normal prompt relative to the pointer')});
        settings.bind('normal-prompt-follow-cursor', follow, 'active', Gio.SettingsBindFlags.DEFAULT);
        password.add(follow);

        const positionRows = new Map();
        for (const [key, title, subtitle, step] of [
            ['normal-prompt-offset-x', _('Cursor Offset X'), _('Horizontal distance from the pointer in pixels'), 10],
            ['normal-prompt-offset-y', _('Cursor Offset Y'), _('Vertical distance from the pointer in pixels'), 10],
            ['normal-prompt-fixed-x', _('Fixed X'), _('Horizontal position in pixels; negative values center the prompt'), 50],
            ['normal-prompt-fixed-y', _('Fixed Y'), _('Vertical position in pixels; negative values center the prompt'), 50],
        ]) {
            const [, [lower, upper]] = settings.settings_schema.get_key(key).get_range().recursiveUnpack();
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
            edit.connect('clicked', () => this._showSavedEntryEditor(window, settings, key, title, description));
        }
        let effectEntries = [];
        try {
            effectEntries = readSavedEntries(settings, 'visual-effect-presets');
        } catch (error) {
            console.error('Stealth Lock: could not read visual effect presets', error);
        }
        const effectNames = Gtk.StringList.new([_('None'), ...effectEntries.map(entry => entry.name)]);
        const effectRow = new Adw.ComboRow({
            title: _('Visual Effect'),
            subtitle: _('Choose a saved effect configuration; None turns effects off'),
            model: effectNames,
            selected: Math.max(0, effectEntries.findIndex(entry => entry.name === settings.get_string('visual-effect-active')) + 1),
        });
        const editEffects = new Gtk.Button({icon_name: 'document-edit-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'], tooltip_text: _('Edit effect presets')});
        effectRow.add_suffix(editEffects);
        styles.add(effectRow);
        editEffects.connect('clicked', () => this._showSavedEntryEditor(window, settings, 'visual-effect-active', _('Visual Effect Presets'), _('Edit saved configurations for blur, neo-rain, and city-grow')));
        const effectSelectionId = effectRow.connect('notify::selected', () => {
            const entry = effectEntries[effectRow.selected - 1];
            if (entry) {
                try {
                    validateEffectConfig(entry.code);
                } catch (error) {
                    window.add_toast(new Adw.Toast({title: _('Invalid effect configuration: %s').format(error.message)}));
                    effectRow.block_signal_handler(effectSelectionId);
                    effectRow.selected = Math.max(0, effectEntries.findIndex(preset => preset.name === settings.get_string('visual-effect-active')) + 1);
                    effectRow.unblock_signal_handler(effectSelectionId);
                    return;
                }
            }
            settings.set_string('visual-effect-active', entry?.name ?? '');
        });

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
        settings.bind('debug-mode', debugInfo, 'sensitive', Gio.SettingsBindFlags.GET | Gio.SettingsBindFlags.NO_SENSITIVITY);
        settings.bind('debug-mode', useActivation, 'sensitive', Gio.SettingsBindFlags.GET | Gio.SettingsBindFlags.NO_SENSITIVITY);
        notes.add(new Adw.ActionRow({
            title: _('Privacy Screen'),
            subtitle: _('This extension blocks normal desktop input while active. Disabling it or restarting GNOME Shell can remove the overlay. Use the GNOME lock screen for session security.'),
        }));
        notes.add(new Adw.ActionRow({
            title: _('System Password'),
            subtitle: _('Unlock uses your login password. Passwords are not saved in settings or written to disk. Ctrl+Alt+Shift+L hands off to the GNOME lock screen.'),
        }));

        const conditionalControls = {
            follow,
            anchor: comboRows.get('normal-prompt-cursor-anchor').row,
            monitor: monitorRow,
            positions: positionRows,
            abort: abortRow,
        };
        this._updateControlAvailability(settings, conditionalControls);
        shortcutLabels.get('debug-abort-hotkey').accelerator = settings.get_strv(useActivation.active ? 'lock-hotkey' : 'debug-abort-hotkey')[0] ?? '';

        const settingsId = settings.connect('changed', (_settings, key) => {
            if (key === 'visual-effect-presets' || key === 'visual-effect-active') {
                try {
                    effectEntries = readSavedEntries(settings, 'visual-effect-presets');
                } catch (error) {
                    console.error('Stealth Lock: could not read visual effect presets', error);
                    effectEntries = [];
                }
                effectRow.block_signal_handler(effectSelectionId);
                effectNames.splice(0, effectNames.get_n_items(), [_('None'), ...effectEntries.map(entry => entry.name)]);
                effectRow.selected = Math.max(0, effectEntries.findIndex(entry => entry.name === settings.get_string('visual-effect-active')) + 1);
                effectRow.unblock_signal_handler(effectSelectionId);
            }
            const combo = comboRows.get(key);
            if (combo)
                combo.row.selected = combo.values
                    ? Math.max(0, combo.values.indexOf(settings.get_string(key)))
                    : settings.get_enum(key);
            const color = colorButtons.get(key);
            if (color) {
                const bytes = settings.get_value(key).deep_unpack();
                color.rgba = new Gdk.RGBA({red: bytes[0] / 255, green: bytes[1] / 255, blue: bytes[2] / 255, alpha: bytes[3] / 255});
            }
            shortcutLabels.get('lock-hotkey').accelerator = settings.get_strv('lock-hotkey')[0] ?? '';
            shortcutLabels.get('debug-abort-hotkey').accelerator = settings.get_strv(useActivation.active ? 'lock-hotkey' : 'debug-abort-hotkey')[0] ?? '';
            cursor.sensitive = settings.get_string('cursor-mode') === 'lock-icon';
            this._updateControlAvailability(settings, conditionalControls);
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

    _updateControlAvailability(settings, controls) {
        const normal = settings.get_string('lock-type') === 'normal';
        const following = settings.get_boolean('normal-prompt-follow-cursor');
        controls.follow.sensitive = normal;
        controls.anchor.sensitive = normal && following;
        controls.monitor.sensitive = normal && !following;
        for (const [key, row] of controls.positions)
            row.sensitive = normal && (key.includes('offset') ? following : !following);
        controls.abort.sensitive = settings.get_boolean('debug-mode') && !settings.get_boolean('debug-abort-use-lock-hotkey');
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
        content.append(new Gtk.Label({label: _('Press the desired key combination. Escape cancels; Backspace restores the default.'), wrap: true}));
        const preview = new Gtk.ShortcutLabel({accelerator: ''});
        content.append(preview);
        let resetShortcut = false;
        const controller = new Gtk.EventControllerKey({propagation_phase: Gtk.PropagationPhase.CAPTURE});
        controller.connect('key-pressed', (keyController, keyval, keycode, state) => {
            const event = keyController.get_current_event();
            if (event.is_modifier())
                return true;
            const mask = state & Gtk.accelerator_get_default_mod_mask() & ~Gdk.ModifierType.LOCK_MASK;
            if (mask === 0 && keyval === Gdk.KEY_Escape) {
                dialog.response(Gtk.ResponseType.CANCEL);
                return true;
            }
            if (mask === 0 && keyval === Gdk.KEY_BackSpace) {
                preview.accelerator = settings.get_default_value(key).deep_unpack()[0] ?? '';
                resetShortcut = true;
                save.sensitive = true;
                return true;
            }
            const [translated, unshifted] = event.get_display().translate_key(
                keycode, state & ~(Gdk.ModifierType.SHIFT_MASK | Gdk.ModifierType.LOCK_MASK), event.get_layout());
            if (translated)
                keyval = Gdk.keyval_to_lower(unshifted);
            const typesCharacter = (mask & ~Gdk.ModifierType.SHIFT_MASK) === 0 && Gdk.keyval_to_unicode(keyval) !== 0;
            if (!Gtk.accelerator_valid(keyval, mask) || typesCharacter)
                return true;
            resetShortcut = false;
            preview.accelerator = Gtk.accelerator_name(keyval, mask);
            save.sensitive = true;
            return true;
        });
        dialog.add_controller(controller);
        dialog.connect('response', (_dialog, response) => {
            if (response === Gtk.ResponseType.OK) {
                if (resetShortcut)
                    settings.reset(key);
                else
                    settings.set_strv(key, [preview.accelerator]);
            }
            this._dialogs.delete(dialog);
            dialog.destroy();
        });
        dialog.connect('realize', () => dialog.get_surface().inhibit_system_shortcuts(null));
        dialog.present();
    }

    _showSavedEntryEditor(window, settings, key, title, description) {
        const isEffect = key === 'visual-effect-active';
        const entriesKey = isEffect ? 'visual-effect-presets' : key + '-saved-entries';
        let entries;
        let savedEntriesValid = true;
        try {
            entries = readSavedEntries(settings, entriesKey);
        } catch (error) {
            console.error('Stealth Lock: could not read saved entries', error);
            entries = [];
            savedEntriesValid = false;
        }
        const dialog = new Gtk.Dialog({title, transient_for: window, modal: true, destroy_with_parent: true, default_width: 780, default_height: 620});
        this._dialogs.add(dialog);
        dialog.add_button(_('Cancel'), Gtk.ResponseType.CANCEL);
        const apply = dialog.add_button(_('Apply'), Gtk.ResponseType.OK);
        const content = dialog.get_content_area();
        content.set_margin_top(16);
        content.set_margin_bottom(16);
        content.set_margin_start(16);
        content.set_margin_end(16);
        content.set_spacing(12);
        content.append(new Gtk.Label({
            label: description + '. ' + (isEffect
                ? _('Use JSON with an effect name and typed knobs. Unspecified knobs use defaults. JavaScript is never executed. Apply saves the configuration and selects that preset.')
                : _('Use CSS declarations only. Leave blank to use the default style.')),
            wrap: true,
            xalign: 0,
        }));
        if (!savedEntriesValid)
            content.append(new Gtk.Label({label: _('Saved entries could not be read. Their existing GSettings value has been retained.'), wrap: true, xalign: 0}));

        const names = Gtk.StringList.new(entries.map(entry => entry.name));
        const toolbar = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 8});
        const activeIndex = isEffect ? entries.findIndex(entry => entry.name === settings.get_string(key)) : 0;
        const initialIndex = entries.length ? Math.max(0, activeIndex) : Gtk.INVALID_LIST_POSITION;
        const selector = new Gtk.DropDown({model: names, selected: initialIndex, hexpand: true});
        const load = new Gtk.Button({label: isEffect ? _('Load Saved') : _('Use Saved'), sensitive: entries.length > 0});
        toolbar.append(selector);
        toolbar.append(load);
        content.append(toolbar);
        const initialEntry = entries[initialIndex];
        const firstLine = (isEffect ? initialEntry?.code.replace(/\s+/g, ' ').trim() : initialEntry?.code.split(/\r?\n/).map(line => line.trim()).find(Boolean)) ?? _('Empty entry');
        const preview = new Gtk.Label({
            label: firstLine.length <= 72 ? firstLine : `${firstLine.slice(0, 69)}...`,
            wrap: true,
            xalign: 0,
            css_classes: ['dim-label'],
            visible: entries.length > 0,
        });
        content.append(preview);
        const name = new Gtk.Entry({placeholder_text: _('Saved entry name'), text: initialEntry?.name ?? (isEffect ? _('New effect') : '')});
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
        scroll.set_child(editor);
        content.append(scroll);
        const validation = new Gtk.Label({wrap: true, xalign: 0, css_classes: ['error'], visible: false});
        content.append(validation);
        let configurationValid = true;

        buffer.connect('changed', () => {
            if (isEffect) {
                try {
                    validateEffectConfig(buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), false));
                    configurationValid = true;
                    validation.visible = false;
                } catch (error) {
                    configurationValid = false;
                    validation.label = error.message;
                    validation.visible = true;
                }
            }
            add.sensitive = savedEntriesValid && configurationValid && name.text.trim() !== '';
            replace.sensitive = configurationValid && !!entries[selector.selected];
            apply.sensitive = !isEffect || savedEntriesValid && configurationValid && (!!entries[selector.selected] || name.text.trim() !== '');
        });

        selector.connect('notify::selected-item', () => {
            const entry = entries[selector.selected];
            const line = (isEffect ? entry?.code.replace(/\s+/g, ' ').trim() : entry?.code.split(/\r?\n/).map(line => line.trim()).find(Boolean)) ?? _('Empty entry');
            preview.label = line.length <= 72 ? line : `${line.slice(0, 69)}...`;
            preview.visible = !!entry;
            name.text = entry?.name ?? '';
            load.sensitive = !!entry;
            replace.sensitive = configurationValid && !!entry;
            rename.sensitive = !!entry && name.text.trim() !== '';
            remove.sensitive = !!entry;
        });
        name.connect('changed', () => {
            add.sensitive = savedEntriesValid && configurationValid && name.text.trim() !== '';
            rename.sensitive = !!entries[selector.selected] && name.text.trim() !== '';
            apply.sensitive = !isEffect || savedEntriesValid && configurationValid && (!!entries[selector.selected] || name.text.trim() !== '');
        });
        load.connect('clicked', () => {
            const entry = entries[selector.selected];
            buffer.set_text(entry.code, -1);
            if (!isEffect)
                settings.set_string(key, entry.code);
        });
        add.connect('clicked', () => {
            const base = name.text.trim();
            const taken = new Set(entries.map(entry => entry.name.trim().toLowerCase()));
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
            const line = (isEffect ? entries[selector.selected].code.replace(/\s+/g, ' ').trim() : entries[selector.selected].code.split(/\r?\n/).map(part => part.trim()).find(Boolean)) ?? _('Empty entry');
            preview.label = line.length <= 72 ? line : `${line.slice(0, 69)}...`;
        });
        rename.connect('clicked', () => {
            const index = selector.selected;
            const base = name.text.trim();
            const taken = new Set(entries.filter((_entry, entryIndex) => entryIndex !== index).map(entry => entry.name.trim().toLowerCase()));
            let uniqueName = base;
            let suffix = 2;
            while (taken.has(uniqueName.toLowerCase()))
                uniqueName = base + ' (' + suffix++ + ')';
            const oldName = entries[index].name;
            entries[index].name = uniqueName;
            settings.set_string(entriesKey, JSON.stringify(entries));
            if (isEffect && settings.get_string(key) === oldName)
                settings.set_string(key, uniqueName);
            names.splice(0, names.get_n_items(), entries.map(entry => entry.name));
            selector.selected = index;
            name.text = uniqueName;
        });
        remove.connect('clicked', () => {
            if (isEffect && settings.get_string(key) === entries[selector.selected].name)
                settings.set_string(key, '');
            entries.splice(selector.selected, 1);
            settings.set_string(entriesKey, JSON.stringify(entries));
            names.splice(0, names.get_n_items(), entries.map(entry => entry.name));
            selector.selected = entries.length ? 0 : Gtk.INVALID_LIST_POSITION;
            name.text = entries[0]?.name ?? '';
        });
        dialog.connect('response', (_dialog, response) => {
            if (response === Gtk.ResponseType.OK) {
                const code = buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), false);
                if (isEffect) {
                    if (!apply.sensitive)
                        return;
                    let entry = entries[selector.selected];
                    if (entry) {
                        entry.code = code;
                    } else {
                        entry = {name: name.text.trim(), code};
                        entries.push(entry);
                    }
                    settings.set_string(entriesKey, JSON.stringify(entries));
                    settings.set_string(key, entry.name);
                } else {
                    settings.set_string(key, code);
                }
            }
            this._dialogs.delete(dialog);
            dialog.destroy();
        });
        buffer.set_text(isEffect ? initialEntry?.code ?? JSON.stringify({effect: 'neo-rain', knobs: {}}, null, 2) : settings.get_string(key), -1);
        dialog.present();
    }
}
