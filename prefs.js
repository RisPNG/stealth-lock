/**
 * Stealth Lock - Preferences UI
 * 
 * Allows users to configure their custom lock hotkey
 */

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class StealthLockPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        
        // Create a preferences page
        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'dialog-password-symbolic',
        });
        window.add(page);
        
        // Create a preferences group for hotkey
        const hotkeyGroup = new Adw.PreferencesGroup({
            title: _('Keyboard Shortcut'),
            description: _('Configure the hotkey to activate stealth lock'),
        });
        page.add(hotkeyGroup);
        
        // Hotkey row
        const hotkeyRow = new Adw.ActionRow({
            title: _('Lock Hotkey'),
            subtitle: _('Press to set a new keyboard shortcut'),
        });
        
        // Get current hotkey
        const currentHotkey = settings.get_strv('lock-hotkey')[0] || '<Super><Control>l';
        
        // Shortcut label
        const shortcutLabel = new Gtk.ShortcutLabel({
            accelerator: currentHotkey,
            valign: Gtk.Align.CENTER,
        });
        hotkeyRow.add_suffix(shortcutLabel);
        
        // Edit button
        const editButton = new Gtk.Button({
            icon_name: 'edit-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        hotkeyRow.add_suffix(editButton);
        
        // Clear button
        const clearButton = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: _('Reset to default'),
        });
        hotkeyRow.add_suffix(clearButton);
        
        hotkeyGroup.add(hotkeyRow);
        
        // Hotkey capture dialog
        editButton.connect('clicked', () => {
            this._showHotkeyDialog(window, settings, 'lock-hotkey', shortcutLabel);
        });
        
        // Reset to default
        clearButton.connect('clicked', () => {
            const defaultHotkey = '<Super><Control>l';
            settings.set_strv('lock-hotkey', [defaultHotkey]);
            shortcutLabel.accelerator = defaultHotkey;
        });
        
        // Listen for settings changes
        settings.connect('changed::lock-hotkey', () => {
            const hotkey = settings.get_strv('lock-hotkey')[0] || '<Super><Control>l';
            shortcutLabel.accelerator = hotkey;
        });

        const DEFAULT_LOCK_HOTKEY = '<Super><Control>l';
        const DEFAULT_ABORT_HOTKEY = '<Control><Alt><Shift>u';
        const CURSOR_MODE_VALUES = ['lock-icon', 'normal', 'hidden'];
        const CURSOR_MODE_LABELS = [_('Lock Icon'), _('Normal Cursor'), _('No Cursor')];

        const getHotkey = (key, fallback) => {
            try {
                return settings.get_strv(key)[0] || fallback;
            } catch (e) {
                return fallback;
            }
        };

        const setHotkey = (key, accel) => {
            settings.set_strv(key, [accel]);
        };

        const normalizeCursorMode = (mode) => {
            if (CURSOR_MODE_VALUES.includes(mode))
                return mode;
            if (mode === 'none' || mode === 'no-cursor')
                return 'hidden';
            return 'lock-icon';
        };

        const getLegacyLockCursor = () => {
            try {
                return settings.get_boolean('lock-cursor');
            } catch (e) {
                return true;
            }
        };

        const getCursorMode = () => {
            try {
                const mode = settings.get_string('cursor-mode')?.trim() ?? '';
                if (CURSOR_MODE_VALUES.includes(mode))
                    return mode;
            } catch (e) {
                // Fall through to legacy key
            }

            return getLegacyLockCursor() ? 'lock-icon' : 'normal';
        };

        const setCursorMode = (mode) => {
            const normalized = normalizeCursorMode(mode);

            try {
                settings.set_string('cursor-mode', normalized);
            } catch (e) {
                // Ignore when running against older schema
            }

            // Keep legacy key in sync for downgrade compatibility.
            try {
                settings.set_boolean('lock-cursor', normalized === 'lock-icon');
            } catch (e) {
                // Ignore when legacy key is unavailable
            }
        };

        const migrateLegacyCursorMode = () => {
            // One-time migration: if cursor-mode has no user value yet but the
            // old lock-cursor key does, map it to the new enum.
            try {
                const hasCursorModeUserValue = settings.get_user_value('cursor-mode') !== null;
                if (hasCursorModeUserValue)
                    return;

                const hasLegacyUserValue = settings.get_user_value('lock-cursor') !== null;
                if (!hasLegacyUserValue)
                    return;

                setCursorMode(getLegacyLockCursor() ? 'lock-icon' : 'normal');
            } catch (e) {
                // Ignore when user-value APIs/keys are unavailable
            }
        };

        migrateLegacyCursorMode();

        const clampByte = (value, fallback) => {
            const n = Number(value);
            if (!Number.isFinite(n))
                return fallback;
            return Math.max(0, Math.min(255, Math.round(n)));
        };

        const getRgbaBytes = (key, fallbackBytes) => {
            try {
                const unpacked = settings.get_value(key).deep_unpack();
                if (!Array.isArray(unpacked) || unpacked.length !== 4)
                    return fallbackBytes;
                return unpacked.map((v, i) => clampByte(v, fallbackBytes[i]));
            } catch (e) {
                return fallbackBytes;
            }
        };

        const bytesToRgba = (bytes) => {
            const rgba = new Gdk.RGBA();
            rgba.red = (bytes[0] ?? 0) / 255;
            rgba.green = (bytes[1] ?? 0) / 255;
            rgba.blue = (bytes[2] ?? 0) / 255;
            rgba.alpha = (bytes[3] ?? 255) / 255;
            return rgba;
        };

        const rgbaToBytes = (rgba) => ([
            clampByte((rgba?.red ?? 0) * 255, 0),
            clampByte((rgba?.green ?? 0) * 255, 0),
            clampByte((rgba?.blue ?? 0) * 255, 0),
            clampByte((rgba?.alpha ?? 1) * 255, 255),
        ]);

        const setRgbaBytes = (key, bytes) => {
            settings.set_value(key, new GLib.Variant('au', bytes));
        };

        // Features group
        const featuresGroup = new Adw.PreferencesGroup({
            title: _('Features'),
            description: _('Toggle optional behavior while locked'),
        });
        page.add(featuresGroup);

        const freezeDisplayRow = new Adw.SwitchRow({
            title: _('Freeze Display'),
            subtitle: _('Capture screenshots and show them as a frozen overlay'),
            active: settings.get_boolean('freeze-display'),
        });
        featuresGroup.add(freezeDisplayRow);

        freezeDisplayRow.connect('notify::active', () => {
            settings.set_boolean('freeze-display', freezeDisplayRow.active);
        });
        settings.connect('changed::freeze-display', () => {
            freezeDisplayRow.active = settings.get_boolean('freeze-display');
        });

        const pauseMediaRow = new Adw.SwitchRow({
            title: _('Pause Media'),
            subtitle: _('Pause MPRIS media players on lock and resume on unlock'),
            active: settings.get_boolean('pause-media'),
        });
        featuresGroup.add(pauseMediaRow);

        pauseMediaRow.connect('notify::active', () => {
            settings.set_boolean('pause-media', pauseMediaRow.active);
        });
        settings.connect('changed::pause-media', () => {
            pauseMediaRow.active = settings.get_boolean('pause-media');
        });

        const cursorModeModel = Gtk.StringList.new(CURSOR_MODE_LABELS);
        const cursorModeRow = new Adw.ComboRow({
            title: _('Cursor'),
            subtitle: _('Choose lock icon, normal cursor, or no cursor while locked'),
            model: cursorModeModel,
        });
        featuresGroup.add(cursorModeRow);

        const syncCursorModeSelected = () => {
            const mode = getCursorMode();
            const idx = Math.max(0, CURSOR_MODE_VALUES.indexOf(mode));
            cursorModeRow.selected = idx;
        };
        syncCursorModeSelected();

        cursorModeRow.connect('notify::selected', () => {
            const mode = CURSOR_MODE_VALUES[cursorModeRow.selected] ?? 'lock-icon';
            setCursorMode(mode);
        });
        settings.connect('changed::cursor-mode', syncCursorModeSelected);
        settings.connect('changed::lock-cursor', syncCursorModeSelected);

        const autoResetRow = new Adw.SpinRow({
            title: _('Auto Reset (seconds)'),
            subtitle: _('Seconds of inactivity before the password clears (0 = never)'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 3600,
                step_increment: 1,
                page_increment: 10,
            }),
            value: settings.get_uint('auto-reset-seconds'),
        });
        featuresGroup.add(autoResetRow);

        autoResetRow.connect('notify::value', () => {
            const value = Math.max(0, Math.round(autoResetRow.value));
            settings.set_uint('auto-reset-seconds', value);
        });
        settings.connect('changed::auto-reset-seconds', () => {
            autoResetRow.value = settings.get_uint('auto-reset-seconds');
        });

        // Password prompt / lock type
        const passwordGroup = new Adw.PreferencesGroup({
            title: _('Password Prompt'),
            description: _('Control how password entry is shown while locked'),
        });
        page.add(passwordGroup);

        const lockTypeModel = Gtk.StringList.new([_('Stealth'), _('Normal')]);
        const lockTypeRow = new Adw.ComboRow({
            title: _('Lock Type'),
            subtitle: _('Stealth hides the prompt; Normal shows an on-screen prompt'),
            model: lockTypeModel,
            selected: settings.get_string('lock-type') === 'normal' ? 1 : 0,
        });
        passwordGroup.add(lockTypeRow);

        const followCursorRow = new Adw.SwitchRow({
            title: _('Follow Cursor'),
            subtitle: _('Position the prompt relative to the cursor'),
            active: settings.get_boolean('normal-prompt-follow-cursor'),
        });
        passwordGroup.add(followCursorRow);

        const anchorModel = Gtk.StringList.new([
            _('Bottom Right'),
            _('Top Right'),
            _('Top Left'),
            _('Bottom Left'),
        ]);
        const anchorValues = ['br', 'tr', 'tl', 'bl'];
        const anchorRow = new Adw.ComboRow({
            title: _('Cursor Anchor'),
            subtitle: _('Where to place the prompt relative to the cursor'),
            model: anchorModel,
        });
        passwordGroup.add(anchorRow);

        const offsetXRow = new Adw.SpinRow({
            title: _('Cursor Offset X'),
            subtitle: _('Horizontal offset from the cursor (px)'),
            adjustment: new Gtk.Adjustment({
                lower: -500,
                upper: 500,
                step_increment: 1,
                page_increment: 10,
            }),
            value: settings.get_int('normal-prompt-offset-x'),
        });
        passwordGroup.add(offsetXRow);

        const offsetYRow = new Adw.SpinRow({
            title: _('Cursor Offset Y'),
            subtitle: _('Vertical offset from the cursor (px)'),
            adjustment: new Gtk.Adjustment({
                lower: -500,
                upper: 500,
                step_increment: 1,
                page_increment: 10,
            }),
            value: settings.get_int('normal-prompt-offset-y'),
        });
        passwordGroup.add(offsetYRow);

        // Monitor selection (populated dynamically from connected monitors)
        const monitorLabels = [_('All Monitors')];
        const monitorValues = [''];
        try {
            const display = Gdk.Display.get_default();
            if (display) {
                const monitorList = display.get_monitors();
                const n = monitorList.get_n_items();
                for (let i = 0; i < n; i++) {
                    const mon = monitorList.get_item(i);
                    const connector = mon.get_connector?.() ?? '';
                    const model = mon.get_model?.() ?? '';
                    const parts = [String(i)];
                    if (connector) parts.push(connector);
                    if (model) parts.push(`(${model})`);
                    monitorLabels.push(parts.join(': '));
                    monitorValues.push(String(i));
                }
            }
        } catch (e) {
            // Ignore - "All Monitors" will be the only option
        }

        const monitorModel = Gtk.StringList.new(monitorLabels);
        const monitorRow = new Adw.ComboRow({
            title: _('Monitor'),
            subtitle: _('Which monitor to center the prompt on'),
            model: monitorModel,
        });
        passwordGroup.add(monitorRow);

        const syncMonitorSelected = () => {
            const current = settings.get_string('normal-prompt-monitor') || '';
            const idx = Math.max(0, monitorValues.indexOf(current));
            monitorRow.selected = idx;
        };
        syncMonitorSelected();

        monitorRow.connect('notify::selected', () => {
            const value = monitorValues[monitorRow.selected] ?? '';
            settings.set_string('normal-prompt-monitor', value);
        });
        settings.connect('changed::normal-prompt-monitor', syncMonitorSelected);

        const fixedXRow = new Adw.SpinRow({
            title: _('Fixed X'),
            subtitle: _('Prompt X position (px). Use -1 to center'),
            adjustment: new Gtk.Adjustment({
                lower: -1,
                upper: 10000,
                step_increment: 1,
                page_increment: 50,
            }),
            value: settings.get_int('normal-prompt-fixed-x'),
        });
        passwordGroup.add(fixedXRow);

        const fixedYRow = new Adw.SpinRow({
            title: _('Fixed Y'),
            subtitle: _('Prompt Y position (px). Use -1 to center'),
            adjustment: new Gtk.Adjustment({
                lower: -1,
                upper: 10000,
                step_increment: 1,
                page_increment: 50,
            }),
            value: settings.get_int('normal-prompt-fixed-y'),
        });
        passwordGroup.add(fixedYRow);

        const customCssRow = new Adw.ActionRow({
            title: _('Custom CSS'),
            subtitle: _('Override prompt styling (inline CSS)'),
        });
        const editCssButton = new Gtk.Button({
            icon_name: 'document-edit-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        customCssRow.add_suffix(editCssButton);
        customCssRow.activatable_widget = editCssButton;
        passwordGroup.add(customCssRow);

        const customJsRow = new Adw.ActionRow({
            title: _('Custom JS'),
            subtitle: _('Run custom JS to modify the prompt (advanced, use with care)'),
        });
        const editJsButton = new Gtk.Button({
            icon_name: 'document-edit-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        customJsRow.add_suffix(editJsButton);
        customJsRow.activatable_widget = editJsButton;
        passwordGroup.add(customJsRow);

        const syncPasswordUi = () => {
            const isNormal = settings.get_string('lock-type') === 'normal';
            const follow = settings.get_boolean('normal-prompt-follow-cursor');

            followCursorRow.sensitive = isNormal;

            anchorRow.sensitive = isNormal && follow;
            offsetXRow.sensitive = isNormal && follow;
            offsetYRow.sensitive = isNormal && follow;

            monitorRow.sensitive = isNormal && !follow;
            fixedXRow.sensitive = isNormal && !follow;
            fixedYRow.sensitive = isNormal && !follow;

            customCssRow.sensitive = isNormal;
            editCssButton.sensitive = isNormal;
            customJsRow.sensitive = isNormal;
            editJsButton.sensitive = isNormal;
        };

        const syncAnchorSelected = () => {
            const current = settings.get_string('normal-prompt-cursor-anchor') || 'br';
            const idx = Math.max(0, anchorValues.indexOf(current));
            anchorRow.selected = idx;
        };
        syncAnchorSelected();

        lockTypeRow.connect('notify::selected', () => {
            settings.set_string('lock-type', lockTypeRow.selected === 1 ? 'normal' : 'stealth');
            syncPasswordUi();
        });
        settings.connect('changed::lock-type', () => {
            lockTypeRow.selected = settings.get_string('lock-type') === 'normal' ? 1 : 0;
            syncPasswordUi();
        });

        followCursorRow.connect('notify::active', () => {
            settings.set_boolean('normal-prompt-follow-cursor', followCursorRow.active);
            syncPasswordUi();
        });
        settings.connect('changed::normal-prompt-follow-cursor', () => {
            followCursorRow.active = settings.get_boolean('normal-prompt-follow-cursor');
            syncPasswordUi();
        });

        anchorRow.connect('notify::selected', () => {
            const value = anchorValues[anchorRow.selected] ?? 'br';
            settings.set_string('normal-prompt-cursor-anchor', value);
        });
        settings.connect('changed::normal-prompt-cursor-anchor', () => {
            syncAnchorSelected();
        });

        offsetXRow.connect('notify::value', () => {
            settings.set_int('normal-prompt-offset-x', Math.round(offsetXRow.value));
        });
        settings.connect('changed::normal-prompt-offset-x', () => {
            offsetXRow.value = settings.get_int('normal-prompt-offset-x');
        });

        offsetYRow.connect('notify::value', () => {
            settings.set_int('normal-prompt-offset-y', Math.round(offsetYRow.value));
        });
        settings.connect('changed::normal-prompt-offset-y', () => {
            offsetYRow.value = settings.get_int('normal-prompt-offset-y');
        });

        fixedXRow.connect('notify::value', () => {
            settings.set_int('normal-prompt-fixed-x', Math.round(fixedXRow.value));
        });
        settings.connect('changed::normal-prompt-fixed-x', () => {
            fixedXRow.value = settings.get_int('normal-prompt-fixed-x');
        });

        fixedYRow.connect('notify::value', () => {
            settings.set_int('normal-prompt-fixed-y', Math.round(fixedYRow.value));
        });
        settings.connect('changed::normal-prompt-fixed-y', () => {
            fixedYRow.value = settings.get_int('normal-prompt-fixed-y');
        });

        editCssButton.connect('clicked', () => {
            this._showTextEditDialog(
                window,
                settings,
                'normal-prompt-css',
                _('Custom CSS'),
                _('Inline CSS applied to the Normal password prompt container.')
            );
        });

        editJsButton.connect('clicked', () => {
            this._showTextEditDialog(
                window,
                settings,
                'normal-prompt-custom-js',
                _('Custom JS'),
                _('Advanced: runs inside GNOME Shell. The code receives a single object `ctx` with fields like `ctx.event`, `ctx.prompt`, `ctx.text`, `ctx.revealButton`, `ctx.buffer`, `ctx.masked`, `ctx.revealed`.')
            );
        });

        syncPasswordUi();

        // Cursor group
        const cursorGroup = new Adw.PreferencesGroup({
            title: _('Cursor'),
            description: _('Customize the lock cursor appearance'),
            sensitive: getCursorMode() === 'lock-icon',
        });
        page.add(cursorGroup);

        const syncCursorGroupSensitivity = () => {
            cursorGroup.sensitive = getCursorMode() === 'lock-icon';
        };
        settings.connect('changed::cursor-mode', syncCursorGroupSensitivity);
        settings.connect('changed::lock-cursor', syncCursorGroupSensitivity);

        const cursorBitmapRow = new Adw.EntryRow({
            title: _('Cursor Bitmap'),
            text: settings.get_string('cursor-bitmap-path'),
        });
        cursorBitmapRow.set_tooltip_text(_('Optional image path (PNG/SVG). Leave blank to use the built-in cursor.'));
        cursorGroup.add(cursorBitmapRow);

        cursorBitmapRow.connect('notify::text', () => {
            settings.set_string('cursor-bitmap-path', cursorBitmapRow.text.trim());
        });
        settings.connect('changed::cursor-bitmap-path', () => {
            cursorBitmapRow.text = settings.get_string('cursor-bitmap-path');
        });

        const browseCursorBitmapButton = new Gtk.Button({
            icon_name: 'folder-open-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: _('Browse...'),
        });
        cursorBitmapRow.add_suffix(browseCursorBitmapButton);

        const clearCursorBitmapButton = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: _('Clear'),
        });
        cursorBitmapRow.add_suffix(clearCursorBitmapButton);

        browseCursorBitmapButton.connect('clicked', () => {
            try {
                console.log('Stealth Lock prefs: Browse cursor image');

                if (this._cursorBitmapDialogCancellable) {
                    try {
                        this._cursorBitmapDialogCancellable.cancel();
                    } catch (e) {
                        // Ignore
                    }
                    this._cursorBitmapDialogCancellable = null;
                }

                const imageFilter = new Gtk.FileFilter();
                imageFilter.set_name(_('Images'));
                imageFilter.add_mime_type('image/png');
                imageFilter.add_mime_type('image/svg+xml');
                imageFilter.add_mime_type('image/*');

                const allFilter = new Gtk.FileFilter();
                allFilter.set_name(_('All Files'));
                allFilter.add_pattern('*');

                // Prefer Gtk.FileDialog (GTK4) for portal-backed picking.
                if (Gtk.FileDialog) {
                    console.log('Stealth Lock prefs: Using Gtk.FileDialog');
                    const dialog = new Gtk.FileDialog({
                        title: _('Select Cursor Image'),
                    });
                    this._cursorBitmapDialog = dialog;

                    const filters = new Gio.ListStore({ item_type: Gtk.FileFilter });
                    filters.append(imageFilter);
                    filters.append(allFilter);
                    dialog.set_filters(filters);
                    dialog.set_default_filter(imageFilter);

                    const cancellable = new Gio.Cancellable();
                    this._cursorBitmapDialogCancellable = cancellable;

                    browseCursorBitmapButton.sensitive = false;
                    dialog.open(window, cancellable, (source, result) => {
                        try {
                            const file = dialog.open_finish(result);
                            if (!file)
                                return;

                            const path = file.get_path();
                            if (path) {
                                settings.set_string('cursor-bitmap-path', path);
                            } else {
                                settings.set_string('cursor-bitmap-path', file.get_uri());
                            }
                        } catch (e) {
                            // Cancelled or failed - ignore, but log failures for troubleshooting.
                            if (!e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                                console.error('Stealth Lock prefs: Cursor image picker failed:', e);
                        } finally {
                            browseCursorBitmapButton.sensitive = true;
                            if (this._cursorBitmapDialog === dialog)
                                this._cursorBitmapDialog = null;
                            if (this._cursorBitmapDialogCancellable === cancellable)
                                this._cursorBitmapDialogCancellable = null;
                        }
                    });

                    return;
                }

                // Fallback (older stacks): Gtk.FileChooserNative.
                console.log('Stealth Lock prefs: Using Gtk.FileChooserNative');
                const chooser = new Gtk.FileChooserNative({
                    title: _('Select Cursor Image'),
                    transient_for: window,
                    modal: true,
                    action: Gtk.FileChooserAction.OPEN,
                    accept_label: _('Open'),
                    cancel_label: _('Cancel'),
                });
                this._cursorBitmapChooser = chooser;

                chooser.add_filter(imageFilter);
                chooser.add_filter(allFilter);
                chooser.set_filter(imageFilter);

                chooser.connect('response', (dlg, response) => {
                    try {
                        if (response !== Gtk.ResponseType.ACCEPT)
                            return;

                        const file = dlg.get_file();
                        if (!file)
                            return;

                        const path = file.get_path();
                        if (path) {
                            settings.set_string('cursor-bitmap-path', path);
                        } else {
                            settings.set_string('cursor-bitmap-path', file.get_uri());
                        }
                    } catch (e) {
                        console.error('Stealth Lock prefs: Cursor image picker failed:', e);
                    } finally {
                        dlg.destroy();
                        if (this._cursorBitmapChooser === dlg)
                            this._cursorBitmapChooser = null;
                    }
                });

                chooser.show();
            } catch (e) {
                console.error('Stealth Lock prefs: Failed to open cursor image picker:', e);
                browseCursorBitmapButton.sensitive = true;
            }
        });

        clearCursorBitmapButton.connect('clicked', () => {
            settings.set_string('cursor-bitmap-path', '');
        });

        const fgRow = new Adw.ActionRow({
            title: _('Cursor Foreground'),
            subtitle: _('Outline/details color (built-in cursor only)'),
        });
        const fgButton = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({ with_alpha: true }),
            rgba: bytesToRgba(getRgbaBytes('cursor-fg-rgba', [0, 0, 0, 255])),
            valign: Gtk.Align.CENTER,
        });
        fgRow.add_suffix(fgButton);
        fgRow.activatable_widget = fgButton;
        cursorGroup.add(fgRow);

        fgButton.connect('notify::rgba', () => {
            setRgbaBytes('cursor-fg-rgba', rgbaToBytes(fgButton.rgba));
        });
        settings.connect('changed::cursor-fg-rgba', () => {
            fgButton.rgba = bytesToRgba(getRgbaBytes('cursor-fg-rgba', [0, 0, 0, 255]));
        });

        const bgRow = new Adw.ActionRow({
            title: _('Cursor Background'),
            subtitle: _('Fill color (built-in cursor only)'),
        });
        const bgButton = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({ with_alpha: true }),
            rgba: bytesToRgba(getRgbaBytes('cursor-bg-rgba', [255, 255, 255, 255])),
            valign: Gtk.Align.CENTER,
        });
        bgRow.add_suffix(bgButton);
        bgRow.activatable_widget = bgButton;
        cursorGroup.add(bgRow);

        bgButton.connect('notify::rgba', () => {
            setRgbaBytes('cursor-bg-rgba', rgbaToBytes(bgButton.rgba));
        });
        settings.connect('changed::cursor-bg-rgba', () => {
            bgButton.rgba = bytesToRgba(getRgbaBytes('cursor-bg-rgba', [255, 255, 255, 255]));
        });

        // Debug group
        const debugGroup = new Adw.PreferencesGroup({
            title: _('Debug'),
            description: _('Troubleshooting options (use with care)'),
        });
        page.add(debugGroup);

        const debugModeRow = new Adw.SwitchRow({
            title: _('Enable Debug Mode'),
            subtitle: _('Enables extra logging and an emergency abort hotkey'),
            active: settings.get_boolean('debug-mode'),
        });
        debugGroup.add(debugModeRow);

        debugModeRow.connect('notify::active', () => {
            settings.set_boolean('debug-mode', debugModeRow.active);
        });
        settings.connect('changed::debug-mode', () => {
            debugModeRow.active = settings.get_boolean('debug-mode');
        });

        const debugShowInfoRow = new Adw.SwitchRow({
            title: _('Show Debug Info'),
            subtitle: _('Show an on-screen debug overlay while locked'),
            active: settings.get_boolean('debug-show-info'),
            sensitive: settings.get_boolean('debug-mode'),
        });
        debugGroup.add(debugShowInfoRow);

        debugShowInfoRow.connect('notify::active', () => {
            settings.set_boolean('debug-show-info', debugShowInfoRow.active);
        });
        settings.connect('changed::debug-show-info', () => {
            debugShowInfoRow.active = settings.get_boolean('debug-show-info');
        });

        const abortUseLockHotkeyRow = new Adw.SwitchRow({
            title: _('Abort Hotkey = Lock Hotkey'),
            subtitle: _('Use the same shortcut for abort while locked'),
            active: settings.get_boolean('debug-abort-use-lock-hotkey'),
            sensitive: settings.get_boolean('debug-mode'),
        });
        debugGroup.add(abortUseLockHotkeyRow);

        const abortHotkeyRow = new Adw.ActionRow({
            title: _('Abort Hotkey (Debug)'),
            subtitle: _('Unlocks without password when Debug Mode is enabled'),
        });

        const abortShortcutLabel = new Gtk.ShortcutLabel({
            accelerator: getHotkey('debug-abort-hotkey', DEFAULT_ABORT_HOTKEY),
            valign: Gtk.Align.CENTER,
        });
        abortHotkeyRow.add_suffix(abortShortcutLabel);

        const abortEditButton = new Gtk.Button({
            icon_name: 'edit-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        abortHotkeyRow.add_suffix(abortEditButton);

        const abortClearButton = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: _('Reset to default'),
        });
        abortHotkeyRow.add_suffix(abortClearButton);

        debugGroup.add(abortHotkeyRow);

        const syncAbortHotkeyUi = () => {
            const debugEnabled = settings.get_boolean('debug-mode');
            const useLock = settings.get_boolean('debug-abort-use-lock-hotkey');
            const lockAccel = getHotkey('lock-hotkey', DEFAULT_LOCK_HOTKEY);
            const abortAccel = getHotkey('debug-abort-hotkey', DEFAULT_ABORT_HOTKEY);

            debugShowInfoRow.sensitive = debugEnabled;
            abortUseLockHotkeyRow.sensitive = debugEnabled;

            abortHotkeyRow.sensitive = debugEnabled && !useLock;
            abortEditButton.sensitive = debugEnabled && !useLock;
            abortClearButton.sensitive = debugEnabled && !useLock;

            abortShortcutLabel.accelerator = useLock ? lockAccel : abortAccel;
        };

        abortUseLockHotkeyRow.connect('notify::active', () => {
            settings.set_boolean('debug-abort-use-lock-hotkey', abortUseLockHotkeyRow.active);

            const lockAccel = getHotkey('lock-hotkey', DEFAULT_LOCK_HOTKEY);
            if (abortUseLockHotkeyRow.active) {
                // Preserve the current custom abort hotkey, then force abort to match lock.
                settings.set_strv('debug-abort-hotkey-custom', [getHotkey('debug-abort-hotkey', DEFAULT_ABORT_HOTKEY)]);
                setHotkey('debug-abort-hotkey', lockAccel);
            } else {
                // Restore previous custom abort hotkey.
                setHotkey('debug-abort-hotkey', getHotkey('debug-abort-hotkey-custom', DEFAULT_ABORT_HOTKEY));
            }

            syncAbortHotkeyUi();
        });

        settings.connect('changed::debug-mode', syncAbortHotkeyUi);
        settings.connect('changed::debug-abort-use-lock-hotkey', () => {
            const useLock = settings.get_boolean('debug-abort-use-lock-hotkey');
            if (!useLock) {
                const lockAccel = getHotkey('lock-hotkey', DEFAULT_LOCK_HOTKEY);
                const abortAccel = getHotkey('debug-abort-hotkey', DEFAULT_ABORT_HOTKEY);
                const customAccel = getHotkey('debug-abort-hotkey-custom', DEFAULT_ABORT_HOTKEY);
                if (abortAccel === lockAccel && customAccel !== lockAccel)
                    setHotkey('debug-abort-hotkey', customAccel);
            }
            syncAbortHotkeyUi();
        });
        settings.connect('changed::debug-abort-hotkey', () => {
            const useLock = settings.get_boolean('debug-abort-use-lock-hotkey');
            if (!useLock)
                settings.set_strv('debug-abort-hotkey-custom', [getHotkey('debug-abort-hotkey', DEFAULT_ABORT_HOTKEY)]);
            syncAbortHotkeyUi();
        });
        settings.connect('changed::lock-hotkey', () => {
            const useLock = settings.get_boolean('debug-abort-use-lock-hotkey');
            if (useLock)
                setHotkey('debug-abort-hotkey', getHotkey('lock-hotkey', DEFAULT_LOCK_HOTKEY));
            syncAbortHotkeyUi();
        });

        settings.connect('changed::debug-show-info', syncAbortHotkeyUi);
        settings.connect('changed::debug-abort-hotkey-custom', syncAbortHotkeyUi);

        syncAbortHotkeyUi();

        abortEditButton.connect('clicked', () => {
            this._showHotkeyDialog(window, settings, 'debug-abort-hotkey', abortShortcutLabel);
        });

        abortClearButton.connect('clicked', () => {
            setHotkey('debug-abort-hotkey', DEFAULT_ABORT_HOTKEY);
            abortShortcutLabel.accelerator = DEFAULT_ABORT_HOTKEY;
        });
        
        // Warning group
        const warningGroup = new Adw.PreferencesGroup({
            title: _('Important Notes'),
        });
        page.add(warningGroup);
        
        const warningRow = new Adw.ActionRow({
            title: _('Security Notice'),
            subtitle: _('This extension uses your system login password. No password is stored by the extension.'),
        });
        const warningIcon = new Gtk.Image({
            icon_name: 'dialog-warning-symbolic',
            valign: Gtk.Align.CENTER,
        });
        warningRow.add_prefix(warningIcon);
        warningGroup.add(warningRow);
    }
    
    _showHotkeyDialog(window, settings, settingsKey, shortcutLabel) {
        const dialog = new Gtk.Dialog({
            title: _('Set Hotkey'),
            modal: true,
            transient_for: window,
            default_width: 400,
            default_height: 200,
        });
        
        dialog.add_button(_('Cancel'), Gtk.ResponseType.CANCEL);
        
        const contentArea = dialog.get_content_area();
        contentArea.set_margin_top(20);
        contentArea.set_margin_bottom(20);
        contentArea.set_margin_start(20);
        contentArea.set_margin_end(20);
        contentArea.set_spacing(20);
        
        const label = new Gtk.Label({
            label: _('Press your desired key combination...'),
            halign: Gtk.Align.CENTER,
        });
        contentArea.append(label);
        
        const hotkeyDisplay = new Gtk.ShortcutLabel({
            accelerator: '',
            halign: Gtk.Align.CENTER,
        });
        contentArea.append(hotkeyDisplay);
        
        // Key event controller
        const keyController = new Gtk.EventControllerKey();
        let capturedAccel = '';
        let saveTimeoutId = null;
        
        keyController.connect('key-pressed', (controller, keyval, keycode, state) => {
            // Escape cancels
            if (keyval === Gdk.KEY_Escape) {
                dialog.response(Gtk.ResponseType.CANCEL);
                return true;
            }

            // Get modifier state
            const mask = state & Gtk.accelerator_get_default_mod_mask();
            
            // Ignore lone modifier keys
            const isModifier = [
                Gdk.KEY_Shift_L, Gdk.KEY_Shift_R,
                Gdk.KEY_Control_L, Gdk.KEY_Control_R,
                Gdk.KEY_Alt_L, Gdk.KEY_Alt_R,
                Gdk.KEY_Super_L, Gdk.KEY_Super_R,
                Gdk.KEY_Meta_L, Gdk.KEY_Meta_R,
            ].includes(keyval);
            
            if (isModifier) {
                return false;
            }
            
            // Build accelerator string
            capturedAccel = Gtk.accelerator_name(keyval, mask);
            hotkeyDisplay.accelerator = capturedAccel;
            
            // Save after a short delay
            if (capturedAccel) {
                if (saveTimeoutId) {
                    GLib.source_remove(saveTimeoutId);
                    saveTimeoutId = null;
                }

                saveTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                    saveTimeoutId = null;
                    if (!capturedAccel)
                        return GLib.SOURCE_REMOVE;

                    settings.set_strv(settingsKey, [capturedAccel]);
                    shortcutLabel.accelerator = capturedAccel;
                    dialog.response(Gtk.ResponseType.OK);
                    return GLib.SOURCE_REMOVE;
                });
            }
            
            return true;
        });
        
        dialog.add_controller(keyController);
        
        dialog.connect('response', () => {
            if (saveTimeoutId) {
                GLib.source_remove(saveTimeoutId);
                saveTimeoutId = null;
            }
            dialog.destroy();
        });
        
        dialog.present();
    }

    _showTextEditDialog(window, settings, settingsKey, title, description) {
        const dialog = new Gtk.Dialog({
            title,
            modal: true,
            transient_for: window,
            default_width: 720,
            default_height: 520,
        });

        dialog.add_button(_('Cancel'), Gtk.ResponseType.CANCEL);
        dialog.add_button(_('Save'), Gtk.ResponseType.OK);

        const contentArea = dialog.get_content_area();
        contentArea.set_margin_top(12);
        contentArea.set_margin_bottom(12);
        contentArea.set_margin_start(12);
        contentArea.set_margin_end(12);
        contentArea.set_spacing(12);

        if (description) {
            const label = new Gtk.Label({
                label: description,
                wrap: true,
                xalign: 0,
            });
            contentArea.append(label);
        }

        const scrolled = new Gtk.ScrolledWindow({
            hexpand: true,
            vexpand: true,
        });
        scrolled.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC);

        const textView = new Gtk.TextView({
            monospace: true,
            wrap_mode: Gtk.WrapMode.NONE,
        });
        scrolled.set_child(textView);
        contentArea.append(scrolled);

        const buffer = textView.get_buffer();
        buffer.set_text(settings.get_string(settingsKey) ?? '', -1);

        dialog.connect('response', (d, response) => {
            try {
                if (response === Gtk.ResponseType.OK) {
                    const start = buffer.get_start_iter();
                    const end = buffer.get_end_iter();
                    const text = buffer.get_text(start, end, false);
                    settings.set_string(settingsKey, text);
                }
            } catch (e) {
                // Ignore
            } finally {
                d.destroy();
            }
        });

        dialog.present();
    }
}
