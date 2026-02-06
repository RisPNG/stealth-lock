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
        
        // Debug group
        const debugGroup = new Adw.PreferencesGroup({
            title: _('Debug'),
            description: _('Troubleshooting options (use with care)'),
        });
        page.add(debugGroup);

        const debugModeRow = new Adw.SwitchRow({
            title: _('Enable Debug Mode'),
            subtitle: _('Shows debug info and enables abort unlock hotkey'),
            active: settings.get_boolean('debug-mode'),
        });
        debugGroup.add(debugModeRow);

        debugModeRow.connect('notify::active', () => {
            settings.set_boolean('debug-mode', debugModeRow.active);
        });

        settings.connect('changed::debug-mode', () => {
            debugModeRow.active = settings.get_boolean('debug-mode');
        });

        const abortHotkeyRow = new Adw.ActionRow({
            title: _('Abort Hotkey (Debug)'),
            subtitle: _('Unlocks without password when Debug Mode is enabled'),
            sensitive: settings.get_boolean('debug-mode'),
        });

        const currentAbortHotkey = settings.get_strv('debug-abort-hotkey')[0] || '<Control><Alt><Shift>u';
        const abortShortcutLabel = new Gtk.ShortcutLabel({
            accelerator: currentAbortHotkey,
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

        abortEditButton.connect('clicked', () => {
            this._showHotkeyDialog(window, settings, 'debug-abort-hotkey', abortShortcutLabel);
        });

        abortClearButton.connect('clicked', () => {
            const defaultHotkey = '<Control><Alt><Shift>u';
            settings.set_strv('debug-abort-hotkey', [defaultHotkey]);
            abortShortcutLabel.accelerator = defaultHotkey;
        });

        settings.connect('changed::debug-abort-hotkey', () => {
            const hotkey = settings.get_strv('debug-abort-hotkey')[0] || '<Control><Alt><Shift>u';
            abortShortcutLabel.accelerator = hotkey;
        });

        settings.connect('changed::debug-mode', () => {
            abortHotkeyRow.sensitive = settings.get_boolean('debug-mode');
        });

        // Create info group
        const infoGroup = new Adw.PreferencesGroup({
            title: _('How It Works'),
            description: _('Stealth Lock provides an invisible screen lock'),
        });
        page.add(infoGroup);
        
        // Info rows
        const infoItems = [
            { title: _('Freeze Display'), subtitle: _('Captures a screenshot of all monitors as an overlay') },
            { title: _('Pause Media'), subtitle: _('Automatically pauses all playing media (MPRIS)') },
            { title: _('Lock Cursor'), subtitle: _('Mouse cursor changes to a lock icon') },
            { title: _('Invisible Password'), subtitle: _('Type your password blindly and press Enter') },
            { title: _('Auto Reset'), subtitle: _('Password resets after 5 seconds of inactivity') },
        ];
        
        for (const item of infoItems) {
            const row = new Adw.ActionRow({
                title: item.title,
                subtitle: item.subtitle,
            });
            const icon = new Gtk.Image({
                icon_name: 'emblem-ok-symbolic',
                valign: Gtk.Align.CENTER,
            });
            row.add_prefix(icon);
            infoGroup.add(row);
        }
        
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
