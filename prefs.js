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

        const lockCursorRow = new Adw.SwitchRow({
            title: _('Lock Cursor'),
            subtitle: _('Replace the cursor with a lock cursor while locked'),
            active: settings.get_boolean('lock-cursor'),
        });
        featuresGroup.add(lockCursorRow);

        lockCursorRow.connect('notify::active', () => {
            settings.set_boolean('lock-cursor', lockCursorRow.active);
        });
        settings.connect('changed::lock-cursor', () => {
            lockCursorRow.active = settings.get_boolean('lock-cursor');
        });

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

        // Cursor group
        const cursorGroup = new Adw.PreferencesGroup({
            title: _('Cursor'),
            description: _('Customize the lock cursor appearance'),
            sensitive: settings.get_boolean('lock-cursor'),
        });
        page.add(cursorGroup);

        settings.connect('changed::lock-cursor', () => {
            cursorGroup.sensitive = settings.get_boolean('lock-cursor');
        });

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
}
