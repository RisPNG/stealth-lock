/**
 * Stealth Lock - GNOME Shell Extension
 * 
 * An invisible screen lock that:
 * - Freezes all monitors (captures screenshot overlay)
 * - Pauses all media via MPRIS
 * - Shows custom lock cursor while allowing mouse movement
 * - Accepts blind password entry
 * - Resets password after 5 seconds of inactivity
 * - Unlocks with correct password + Enter
 * 
 * Works on both X11 and Wayland with GNOME Mutter
 */

import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Cogl from 'gi://Cogl';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const MPRIS_PLAYER_INTERFACE = 'org.mpris.MediaPlayer2.Player';
const DEFAULT_AUTO_RESET_SECONDS = 5;
const SCREENSHOT_TIMEOUT_MS = 3000;
const AUTH_TIMEOUT_MS = 10000;
const PASSWORD_BULLET = '\u2022';

// Cursor bitmap embedded as XBM-style bitmaps (LSB-first per byte).
// Source bitmap decides foreground/background within the mask.
// Mask bitmap decides which pixels are visible (mask bit 0 = transparent).
const LOCK_CURSOR_XBM = {
    width: 28,
    height: 40,
    hotX: 14,
    hotY: 21,
    bits: new Uint8Array([
        0xff, 0xff, 0xff, 0xff, 0xff, 0x01, 0xf8, 0xff, 0x7f, 0x00, 0xe0, 0xff,
        0x3f, 0x00, 0xc0, 0xff, 0x1f, 0x00, 0x80, 0xff, 0x0f, 0xfc, 0x03, 0xff,
        0x0f, 0xfe, 0x07, 0xff, 0x0f, 0xff, 0x0f, 0xff, 0x07, 0xff, 0x0f, 0xfe,
        0x87, 0xff, 0x1f, 0xfe, 0x87, 0xff, 0x1f, 0xfe, 0x87, 0xff, 0x1f, 0xfe,
        0x87, 0xff, 0x1f, 0xfe, 0x87, 0xff, 0x1f, 0xfe, 0x87, 0xff, 0x1f, 0xfe,
        0x87, 0xff, 0x1f, 0xfe, 0x87, 0xff, 0x1f, 0xfe, 0x87, 0xff, 0x1f, 0xfe,
        0x87, 0xff, 0x1f, 0xfe, 0x01, 0x00, 0x00, 0xf8, 0x01, 0x00, 0x00, 0xf8,
        0x01, 0x00, 0x00, 0xf8, 0x01, 0x00, 0x00, 0xf8, 0x01, 0xf0, 0x00, 0xf8,
        0x01, 0xf8, 0x01, 0xf8, 0x01, 0xf8, 0x01, 0xf8, 0x01, 0xf8, 0x01, 0xf8,
        0x01, 0xf8, 0x01, 0xf8, 0x01, 0xf0, 0x00, 0xf8, 0x01, 0x60, 0x00, 0xf8,
        0x01, 0x60, 0x00, 0xf8, 0x01, 0x60, 0x00, 0xf8, 0x01, 0x60, 0x00, 0xf8,
        0x01, 0x60, 0x00, 0xf8, 0x01, 0x60, 0x00, 0xf8, 0x01, 0x00, 0x00, 0xf8,
        0x01, 0x00, 0x00, 0xf8, 0x01, 0x00, 0x00, 0xf8, 0x01, 0x00, 0x00, 0xf8,
        0xff, 0xff, 0xff, 0xff,
    ]),
    maskBits: new Uint8Array([
        0x00, 0xfe, 0x07, 0x00, 0x80, 0xff, 0x1f, 0x00, 0xc0, 0xff, 0x3f, 0x00,
        0xe0, 0xff, 0x7f, 0x00, 0xf0, 0xff, 0xff, 0x00, 0xf8, 0xff, 0xff, 0x01,
        0xf8, 0x03, 0xfc, 0x01, 0xf8, 0x01, 0xf8, 0x01, 0xfc, 0x01, 0xf8, 0x03,
        0xfc, 0x00, 0xf0, 0x03, 0xfc, 0x00, 0xf0, 0x03, 0xfc, 0x00, 0xf0, 0x03,
        0xfc, 0x00, 0xf0, 0x03, 0xfc, 0x00, 0xf0, 0x03, 0xfc, 0x00, 0xf0, 0x03,
        0xfc, 0x00, 0xf0, 0x03, 0xfc, 0x00, 0xf0, 0x03, 0xfc, 0x00, 0xf0, 0x03,
        0xff, 0xff, 0xff, 0x0f, 0xff, 0xff, 0xff, 0x0f, 0xff, 0xff, 0xff, 0x0f,
        0xff, 0xff, 0xff, 0x0f, 0xff, 0xff, 0xff, 0x0f, 0xff, 0xff, 0xff, 0x0f,
        0xff, 0xff, 0xff, 0x0f, 0xff, 0xff, 0xff, 0x0f, 0xff, 0xff, 0xff, 0x0f,
        0xff, 0xff, 0xff, 0x0f, 0xff, 0xff, 0xff, 0x0f, 0xff, 0xff, 0xff, 0x0f,
        0xff, 0xff, 0xff, 0x0f, 0xff, 0xff, 0xff, 0x0f, 0xff, 0xff, 0xff, 0x0f,
        0xff, 0xff, 0xff, 0x0f, 0xff, 0xff, 0xff, 0x0f, 0xff, 0xff, 0xff, 0x0f,
        0xff, 0xff, 0xff, 0x0f, 0xff, 0xff, 0xff, 0x0f, 0xff, 0xff, 0xff, 0x0f,
        0xff, 0xff, 0xff, 0x0f,
    ]),
};

function _xbmBit(data, bytesPerRow, x, y) {
    const i = (y * bytesPerRow) + (x >> 3);
    const bit = x & 7; // XBM is LSB-first
    return (data[i] >> bit) & 1;
}

function _renderXbmCursorRgba(xbm, targetWidth, targetHeight, colors) {
    const srcBytesPerRow = Math.ceil(xbm.width / 8);
    const fg = colors?.fg ?? [255, 255, 255, 255];
    const bg = colors?.bg ?? [0, 0, 0, 200];

    const rgba = new Uint8Array(targetWidth * targetHeight * 4);

    for (let y = 0; y < targetHeight; y++) {
        const srcY = Math.min(xbm.height - 1, Math.floor((y * xbm.height) / targetHeight));
        for (let x = 0; x < targetWidth; x++) {
            const srcX = Math.min(xbm.width - 1, Math.floor((x * xbm.width) / targetWidth));

            const masked = _xbmBit(xbm.maskBits, srcBytesPerRow, srcX, srcY);
            if (!masked)
                continue;

            const sourceBit = _xbmBit(xbm.bits, srcBytesPerRow, srcX, srcY);
            const color = sourceBit ? fg : bg;

            const idx = ((y * targetWidth) + x) * 4;
            rgba[idx + 0] = color[0];
            rgba[idx + 1] = color[1];
            rgba[idx + 2] = color[2];
            rgba[idx + 3] = color[3];
        }
    }

    return rgba;
}

/**
 * StealthLockOverlay - The transparent overlay that captures the frozen screen
 */
const StealthLockOverlay = GObject.registerClass(
class StealthLockOverlay extends St.Widget {
    _init(extension) {
        super._init({
            name: 'stealthLockOverlay',
            reactive: true,
            can_focus: true,
            track_hover: false,
        });
        
        this._extension = extension;
        this._screenshots = [];
        this._originX = 0;
        this._originY = 0;
        
        // Connect to allocation to ensure proper sizing
        this.connect('notify::allocation', () => this._updateLayout());
    }
    
    async captureScreens() {
        // Get all monitors and capture screenshots for each
        const monitors = Main.layoutManager.monitors;

        // Track the monitor-space origin so child actor positions work even when monitors have negative coords
        const rect = this._getMonitorsRect(monitors);
        this._originX = rect.x;
        this._originY = rect.y;
        
        for (let i = 0; i < monitors.length; i++) {
            const monitor = monitors[i];
            await this._captureMonitor(i, monitor);
        }
    }
    
    async _captureMonitor(index, monitor) {
        const filename = GLib.build_filenamev([
            GLib.get_tmp_dir(),
            `stealth-lock-${index}-${Date.now()}.png`,
        ]);

        const { success, filenameUsed } = await this._screenshotAreaToFile(
            monitor.x, monitor.y,
            monitor.width, monitor.height,
            filename
        );

        if (!success)
            return false;

        const fileUri = Gio.File.new_for_path(filenameUsed).get_uri();

        // Create background with the screenshot
        const bg = new St.Widget({
            x: monitor.x - this._originX,
            y: monitor.y - this._originY,
            width: monitor.width,
            height: monitor.height,
            style: `background-image: url("${fileUri}"); background-size: cover;`,
        });

        this._screenshots.push({
            widget: bg,
            file: filenameUsed,
            monitor: index,
        });

        this.add_child(bg);
        return true;
    }

    async _screenshotAreaToFile(x, y, width, height, filename) {
        const screenshot = new Shell.Screenshot();

        // GNOME Shell 48+ uses an output stream instead of a filename string for Shell.Screenshot methods.
        // Fall back to the older filename-based signature when needed.
        try {
            const file = Gio.File.new_for_path(filename);
            const stream = file.replace(
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );

            const success = await new Promise(resolve => {
                let timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SCREENSHOT_TIMEOUT_MS, () => {
                    timeoutId = null;
                    console.warn(`Stealth Lock: Screenshot timed out after ${SCREENSHOT_TIMEOUT_MS}ms`);
                    try {
                        stream.close(null);
                    } catch (e) {
                        // Ignore close errors
                    }
                    resolve(false);
                    return GLib.SOURCE_REMOVE;
                });

                const callback = (source, result) => {
                    try {
                        const finishResult = screenshot.screenshot_area_finish(result);
                        resolve(Array.isArray(finishResult) ? finishResult[0] : finishResult);
                    } catch (e) {
                        console.error('Screenshot capture failed:', e);
                        resolve(false);
                    } finally {
                        if (timeoutId) {
                            GLib.source_remove(timeoutId);
                            timeoutId = null;
                        }
                        try {
                            stream.close(null);
                        } catch (e) {
                            // Ignore close errors
                        }
                    }
                };

                // GNOME Shell 48: (x, y, width, height, stream, callback)
                screenshot.screenshot_area(x, y, width, height, stream, callback);
            });

            return { success: !!success, filenameUsed: filename };
        } catch (e) {
            // Fall back to the legacy filename-based API (GNOME Shell 45-47)
        }

        try {
            const finishResult = await new Promise(resolve => {
                let timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SCREENSHOT_TIMEOUT_MS, () => {
                    timeoutId = null;
                    console.warn(`Stealth Lock: Screenshot timed out after ${SCREENSHOT_TIMEOUT_MS}ms`);
                    resolve(false);
                    return GLib.SOURCE_REMOVE;
                });

                const callback = (source, result) => {
                    try {
                        resolve(screenshot.screenshot_area_finish(result));
                    } catch (e) {
                        console.error('Screenshot capture failed:', e);
                        resolve(false);
                    } finally {
                        if (timeoutId) {
                            GLib.source_remove(timeoutId);
                            timeoutId = null;
                        }
                    }
                };

                // GNOME Shell 45-47: (x, y, width, height, filename, callback)
                screenshot.screenshot_area(x, y, width, height, filename, callback);
            });

            if (!finishResult)
                return { success: false, filenameUsed: filename };

            if (!Array.isArray(finishResult))
                return { success: !!finishResult, filenameUsed: filename };

            const [success, , filenameUsed] = finishResult;
            return {
                success: !!success,
                filenameUsed: typeof filenameUsed === 'string' ? filenameUsed : filename,
            };
        } catch (e) {
            console.error('Screenshot capture failed:', e);
            return { success: false, filenameUsed: filename };
        }
    }

    _getMonitorsRect(monitors) {
        if (!monitors?.length) {
            return { x: 0, y: 0, width: 0, height: 0 };
        }

        const first = monitors[0];
        const initial = {
            x: first.x,
            y: first.y,
            maxX: first.x + first.width,
            maxY: first.y + first.height,
        };

        const rect = monitors.reduce((acc, m) => ({
            x: Math.min(acc.x, m.x),
            y: Math.min(acc.y, m.y),
            maxX: Math.max(acc.maxX, m.x + m.width),
            maxY: Math.max(acc.maxY, m.y + m.height),
        }), initial);

        return {
            x: rect.x,
            y: rect.y,
            width: rect.maxX - rect.x,
            height: rect.maxY - rect.y,
        };
    }

    _updateLayout() {
        // Ensure overlay covers entire screen area
        const monitors = Main.layoutManager.monitors;
        const rect = this._getMonitorsRect(monitors);

        this._originX = rect.x;
        this._originY = rect.y;

        this.set_position(rect.x, rect.y);
        this.set_size(rect.width, rect.height);
    }
    
    destroy() {
        // Cleanup screenshots
        for (const ss of this._screenshots) {
            if (ss.widget) {
                ss.widget.destroy();
            }
            try {
                GLib.unlink(ss.file);
            } catch (e) {}
        }
        this._screenshots = [];
        super.destroy();
    }
});

/**
 * StealthLock - Main extension class
 */
export default class StealthLockExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this._overlay = null;
        this._locked = false;
        this._modalGrab = null;
        this._passwordBuffer = '';
        this._passwordResetTimeoutId = null;
        this._capturedEventHandlerId = null;
        this._pausedPlayers = [];
        this._didPauseMedia = false;
        this._cursorTracker = null;
        this._cursorInhibited = false;
        this._settings = null;
        this._keybindingId = null;
        this._originalCursor = null;
        this._cursorSize = 32;
        this._previousPointerVisible = null;
        this._settingsChangedIds = [];
        this._debugLabel = null;
        this._debugAbortSequenceCount = 0;
        this._debugAbortSequenceLastTime = 0;
        this._lastAuthExitCode = null;
        this._lastCursorStagePos = null;
        this._lastCursorLocalPos = null;
        this._lastDebugCursorLabelUpdate = 0;
        this._abortHotkeySyncing = false;

        this._passwordPrompt = null;
        this._passwordPromptText = null;
        this._passwordPromptRevealButton = null;
        this._passwordPromptRevealIcon = null;
        this._passwordPromptRevealed = false;
        this._passwordPromptLastStageX = null;
        this._passwordPromptLastStageY = null;
        this._passwordPromptCustomFn = null;
    }
    
    enable() {
        this._settings = this.getSettings();
        
        // Register the keybinding
        Main.wm.addKeybinding(
            'lock-hotkey',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            this._toggleLock.bind(this)
        );

        this._syncAbortHotkeySettings();
        this._syncDebugKeybindings();

        this._settingsChangedIds.push(
            this._settings.connect('changed::debug-mode', () => this._syncDebugKeybindings())
        );
        this._settingsChangedIds.push(
            this._settings.connect('changed::debug-abort-hotkey', () => {
                this._syncDebugKeybindings();
                this._syncAbortHotkeyCustomFromAbort();
            })
        );
        this._settingsChangedIds.push(
            this._settings.connect('changed::debug-abort-use-lock-hotkey', () => this._syncAbortHotkeySettings())
        );
        this._settingsChangedIds.push(
            this._settings.connect('changed::debug-abort-hotkey-custom', () => this._syncAbortHotkeySettings())
        );
        this._settingsChangedIds.push(
            this._settings.connect('changed::lock-hotkey', () => this._syncAbortHotkeySettings())
        );
        this._settingsChangedIds.push(
            this._settings.connect('changed::debug-show-info', () => this._syncDebugOverlay())
        );
        
        console.log('Stealth Lock extension enabled');
    }
    
    disable() {
        // Remove keybinding
        Main.wm.removeKeybinding('lock-hotkey');
        Main.wm.removeKeybinding('debug-abort-hotkey');
        
        // Ensure we're unlocked before disabling
        if (this._locked) {
            this._unlock(true); // Force unlock
        }

        for (const id of this._settingsChangedIds) {
            try {
                this._settings?.disconnect(id);
            } catch (e) {
                // Ignore disconnect errors
            }
        }
        this._settingsChangedIds = [];
        
        this._settings = null;
        console.log('Stealth Lock extension disabled');
    }

    _isDebugMode() {
        try {
            return !!this._settings?.get_boolean('debug-mode');
        } catch (e) {
            return false;
        }
    }

    _shouldShowDebugInfo() {
        if (!this._isDebugMode())
            return false;

        try {
            return !!this._settings?.get_boolean('debug-show-info');
        } catch (e) {
            return true;
        }
    }

    _shouldFreezeDisplay() {
        try {
            return !!this._settings?.get_boolean('freeze-display');
        } catch (e) {
            return true;
        }
    }

    _getLockType() {
        try {
            const t = this._settings?.get_string('lock-type')?.trim();
            return t || 'stealth';
        } catch (e) {
            return 'stealth';
        }
    }

    _isNormalLockType() {
        return this._getLockType() === 'normal';
    }

    _shouldPauseMedia() {
        try {
            return !!this._settings?.get_boolean('pause-media');
        } catch (e) {
            return true;
        }
    }

    _shouldLockCursor() {
        try {
            return !!this._settings?.get_boolean('lock-cursor');
        } catch (e) {
            return true;
        }
    }

    _getHotkeyAccel(key, fallback) {
        try {
            return this._settings?.get_strv(key)?.[0] || fallback;
        } catch (e) {
            return fallback;
        }
    }

    _syncAbortHotkeyCustomFromAbort() {
        if (!this._settings || this._abortHotkeySyncing)
            return;

        try {
            const useLock = !!this._settings.get_boolean('debug-abort-use-lock-hotkey');
            if (useLock)
                return;

            const abortAccel = this._getHotkeyAccel('debug-abort-hotkey', '<Control><Alt><Shift>u');
            const customAccel = this._getHotkeyAccel('debug-abort-hotkey-custom', '<Control><Alt><Shift>u');
            if (abortAccel && abortAccel !== customAccel)
                this._settings.set_strv('debug-abort-hotkey-custom', [abortAccel]);
        } catch (e) {
            // Ignore sync errors
        }
    }

    _syncAbortHotkeySettings() {
        if (!this._settings || this._abortHotkeySyncing)
            return;

        this._abortHotkeySyncing = true;
        try {
            const useLock = !!this._settings.get_boolean('debug-abort-use-lock-hotkey');
            const lockAccel = this._getHotkeyAccel('lock-hotkey', '<Super><Control>l');
            const currentAbort = this._getHotkeyAccel('debug-abort-hotkey', '<Control><Alt><Shift>u');
            const customAbort = this._getHotkeyAccel('debug-abort-hotkey-custom', '<Control><Alt><Shift>u');

            if (useLock) {
                if (lockAccel && currentAbort !== lockAccel)
                    this._settings.set_strv('debug-abort-hotkey', [lockAccel]);
            } else {
                // If we just toggled off "use lock hotkey", restore the previous custom abort hotkey.
                if (lockAccel && currentAbort === lockAccel && customAbort && customAbort !== lockAccel) {
                    this._settings.set_strv('debug-abort-hotkey', [customAbort]);
                } else if (currentAbort && currentAbort !== customAbort) {
                    // Otherwise keep the custom key tracking the current value (upgrade-safe).
                    this._settings.set_strv('debug-abort-hotkey-custom', [currentAbort]);
                }
            }
        } catch (e) {
            // Ignore sync errors
        } finally {
            this._abortHotkeySyncing = false;
        }
    }

    _syncDebugKeybindings() {
        // Always remove first so toggling debug-mode takes effect immediately.
        Main.wm.removeKeybinding('debug-abort-hotkey');

        if (!this._settings)
            return;

        if (!this._isDebugMode())
            return;

        // Only active while locked because we set actionMode to LOCK_SCREEN.
        Main.wm.addKeybinding(
            'debug-abort-hotkey',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.LOCK_SCREEN,
            () => {
                if (!this._locked || !this._isDebugMode())
                    return;
                console.warn('Stealth Lock: DEBUG abort hotkey used (unlocking without password)');
                this._unlock(true);
            }
        );
    }
    
    _toggleLock() {
        if (this._locked) {
            // Don't allow toggle unlock - must use password
            return;
        }
        this._lock();
    }
    
    async _lock() {
        if (this._locked) return;
        
        this._locked = true;
        this._passwordBuffer = '';
        this._debugAbortSequenceCount = 0;
        this._debugAbortSequenceLastTime = 0;
        this._lastAuthExitCode = null;
        this._didPauseMedia = false;
        
        console.log('Stealth Lock: Locking...');

        try {
            // 1. Pause all media players via MPRIS
            if (this._shouldPauseMedia()) {
                this._didPauseMedia = true;
                await this._pauseAllMedia();
            }

            // 2. Create the overlay and capture screenshots
            this._overlay = new StealthLockOverlay(this);
            if (this._shouldFreezeDisplay())
                await this._overlay.captureScreens();

            // 3. Add overlay to the stage at the top
            if (Main.layoutManager.addTopChrome)
                Main.layoutManager.addTopChrome(this._overlay);
            else
                Main.layoutManager.addChrome(this._overlay);

            // Ensure the overlay has a valid size/position immediately
            this._overlay._updateLayout?.();

            // 4. Grab input globally (real lock)
            this._modalGrab = Main.pushModal(this._overlay, {
                actionMode: Shell.ActionMode.LOCK_SCREEN,
            });

            // Debug overlay (optional)
            if (this._shouldShowDebugInfo()) {
                this._debugLabel = new St.Label({
                    style: 'color: #fff; background-color: rgba(0,0,0,0.70); padding: 8px; border-radius: 6px; font-family: monospace; font-size: 12px;',
                    text: '',
                });
                this._debugLabel.set_position(12, 12);
                this._overlay.add_child(this._debugLabel);
                this._updateDebugLabel();
            }
            
            // 5. Change cursor to lock icon
            if (this._shouldLockCursor())
                this._setLockCursor();

            // Password prompt (optional) - add late so it renders on top
            this._syncPasswordPrompt();
            
            // 6. Grab keyboard input
            this._grabKeyboard();
            
            // 7. Focus the overlay
            this._overlay.grab_key_focus();
            
            console.log('Stealth Lock: Locked');
        } catch (e) {
            console.error('Stealth Lock: Lock failed:', e);
            this._unlock(true);
        }
    }
    
    _unlock(force = false) {
        if (!this._locked && !force) return;
        
        console.log('Stealth Lock: Unlocking...');

        // 1. Release keyboard handlers
        this._releaseKeyboard();

        // 2. Release modal grab
        if (this._modalGrab) {
            try {
                Main.popModal(this._modalGrab);
            } catch (e) {
                // Ignore pop errors
            }
            this._modalGrab = null;
        }

        // 3. Restore cursor
        this._restoreCursor();

        // 3b. Remove password prompt
        this._destroyPasswordPrompt();

        // 4. Remove overlay
        if (this._overlay) {
            try {
                Main.layoutManager.removeChrome(this._overlay);
            } catch (e) {
                // Ignore removal errors
            }
            this._overlay.destroy();
            this._overlay = null;
        }

        this._debugLabel = null;
        
        // 5. Resume media players
        if (this._didPauseMedia)
            this._resumeAllMedia();
        
        // 6. Clear password buffer and timeout
        this._passwordBuffer = '';
        this._clearPasswordResetTimeout();
        
        this._locked = false;
        
        console.log('Stealth Lock: Unlocked');
    }
    
    _grabKeyboard() {
        if (this._capturedEventHandlerId)
            return;

        // Stage-level capture for blocking events and handling mouse motion.
        // Key events are allowed through so the overlay's key-press-event fires
        // reliably under GNOME 45+ modal grabs.
        this._capturedEventHandlerId = global.stage.connect('captured-event', (stage, event) => {
            if (!this._locked)
                return Clutter.EVENT_PROPAGATE;

            const type = event.type();

            // Let key events propagate to the overlay's key-press-event handler
            if (type === Clutter.EventType.KEY_PRESS || type === Clutter.EventType.KEY_RELEASE)
                return Clutter.EVENT_PROPAGATE;

            const coords = event.get_coords?.();
            const ex = coords?.x ?? coords?.[0] ?? 0;
            const ey = coords?.y ?? coords?.[1] ?? 0;

            if (type === Clutter.EventType.MOTION) {
                if (this._cursorActor)
                    this._setCursorActorPositionFromStage(ex, ey);

                if (this._passwordPrompt && this._shouldNormalPromptFollowCursor()) {
                    this._passwordPromptLastStageX = ex;
                    this._passwordPromptLastStageY = ey;
                    this._setPasswordPromptPositionFromStage(ex, ey);
                }

                // Allow hover on the prompt when it's fixed-position.
                if (this._passwordPrompt && !this._shouldNormalPromptFollowCursor() && this._isPointerInPasswordPrompt(ex, ey))
                    return Clutter.EVENT_PROPAGATE;

                return Clutter.EVENT_STOP;
            }

            if (type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.BUTTON_RELEASE) {
                // Only allow clicks on the password prompt UI.
                if (this._passwordPrompt && this._isPointerInPasswordPrompt(ex, ey))
                    return Clutter.EVENT_PROPAGATE;
                return Clutter.EVENT_STOP;
            }

            return Clutter.EVENT_STOP;
        });

        // Key events on the overlay (the modal grab target) — this is the
        // reliable path for keyboard input during pushModal.
        if (this._overlay) {
            this._overlayKeyPressId = this._overlay.connect('key-press-event', (actor, event) => {
                return this._onKeyPress(actor, event);
            });
        }
    }
    
    _releaseKeyboard() {
        if (this._capturedEventHandlerId) {
            global.stage.disconnect(this._capturedEventHandlerId);
            this._capturedEventHandlerId = null;
        }
        if (this._overlayKeyPressId && this._overlay) {
            this._overlay.disconnect(this._overlayKeyPressId);
            this._overlayKeyPressId = null;
        }
    }
    
    _onKeyPress(actor, event) {
        if (!this._locked) return Clutter.EVENT_PROPAGATE;
        
        const keyval = event.get_key_symbol();
        const state = event.get_state();
        // Resolve Unicode character from the key event.
        // event.get_key_unicode() and Clutter.keysym_to_unicode() are
        // unavailable or broken under modal grabs in GNOME 46+, so we
        // fall back to direct keysym mapping.
        let keychar = 0;
        try { keychar = event.get_key_unicode?.() ?? 0; } catch (_) { /* */ }
        if (!keychar) {
            try { keychar = Clutter.keysym_to_unicode?.(keyval) ?? 0; } catch (_) { /* */ }
        }
        // Manual mapping for when the above methods fail or return control chars
        if (!keychar || (keychar > 0 && keychar < 0x20)) {
            if (keyval >= 0x20 && keyval <= 0x7e)
                keychar = keyval;                         // ASCII printable
            else if (keyval >= 0x00a0 && keyval <= 0x00ff)
                keychar = keyval;                         // Latin-1 supplement
            else if (keyval >= 0x01000000)
                keychar = keyval - 0x01000000;            // Direct unicode keysym
            else if (keyval >= Clutter.KEY_KP_0 && keyval <= Clutter.KEY_KP_9)
                keychar = 0x30 + (keyval - Clutter.KEY_KP_0);
            else if (keyval === Clutter.KEY_KP_Decimal || keyval === Clutter.KEY_KP_Separator)
                keychar = 0x2e;
            else if (keyval === Clutter.KEY_KP_Add)       keychar = 0x2b;
            else if (keyval === Clutter.KEY_KP_Subtract)  keychar = 0x2d;
            else if (keyval === Clutter.KEY_KP_Multiply)  keychar = 0x2a;
            else if (keyval === Clutter.KEY_KP_Divide)    keychar = 0x2f;
            else if (keychar > 0 && keychar < 0x20)
                keychar = 0;                              // Discard control chars
        }
        
        // Reset the password timeout on any key press
        this._resetPasswordTimeout();

        // Emergency fallback: switch to GNOME's real lock screen
        // (prevents getting stuck behind the stealth overlay)
        const emergencyModifiers =
            (state & Clutter.ModifierType.CONTROL_MASK) &&
            (state & Clutter.ModifierType.MOD1_MASK) &&
            (state & Clutter.ModifierType.SHIFT_MASK);
        if (emergencyModifiers && (keyval === Clutter.KEY_l || keyval === Clutter.KEY_L)) {
            this._fallbackToSystemLock();
            return Clutter.EVENT_STOP;
        }
        
        // Handle Enter key - attempt unlock
        if (keyval === Clutter.KEY_Return || keyval === Clutter.KEY_KP_Enter) {
            if (this._passwordBuffer.length === 0)
                console.log('Stealth Lock: Unlock attempt (empty buffer)');
            this._attemptUnlock();
            this._updatePasswordPrompt();
            return Clutter.EVENT_STOP;
        }

        // Normal prompt: toggle reveal (Ctrl+R)
        const isCtrl = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
        if (isCtrl && (keyval === Clutter.KEY_r || keyval === Clutter.KEY_R) && this._passwordPromptRevealIcon) {
            this._passwordPromptRevealed = !this._passwordPromptRevealed;
            this._passwordPromptRevealIcon.icon_name = this._passwordPromptRevealed ? 'view-conceal-symbolic' : 'view-reveal-symbolic';
            this._updatePasswordPrompt();
            return Clutter.EVENT_STOP;
        }
        
        // Handle Backspace
        if (keyval === Clutter.KEY_BackSpace) {
            if (this._passwordBuffer.length > 0) {
                this._passwordBuffer = this._passwordBuffer.slice(0, -1);
            }
            this._updateDebugLabel();
            this._updatePasswordPrompt();
            return Clutter.EVENT_STOP;
        }
        
        // Handle Escape - clear password buffer
        if (keyval === Clutter.KEY_Escape) {
            this._passwordBuffer = '';
            this._handleDebugAbortSequence();
            this._updateDebugLabel();
            this._updatePasswordPrompt();
            return Clutter.EVENT_STOP;
        }
        
        // Ignore modifier keys
        if (keyval === Clutter.KEY_Shift_L || keyval === Clutter.KEY_Shift_R ||
            keyval === Clutter.KEY_Control_L || keyval === Clutter.KEY_Control_R ||
            keyval === Clutter.KEY_Alt_L || keyval === Clutter.KEY_Alt_R ||
            keyval === Clutter.KEY_Super_L || keyval === Clutter.KEY_Super_R ||
            keyval === Clutter.KEY_Caps_Lock || keyval === Clutter.KEY_Num_Lock) {
            return Clutter.EVENT_STOP;
        }
        
        // Add printable characters to password buffer
        if (keychar && keychar !== 0) {
            this._passwordBuffer += String.fromCodePoint(keychar);
            if (this._isDebugMode())
                console.log(`Stealth Lock: KEY sym=0x${keyval.toString(16)} uni=U+${keychar.toString(16).padStart(4, '0')} bufLen=${this._passwordBuffer.length}`);
            this._updateDebugLabel();
            this._updatePasswordPrompt();
        } else if (this._isDebugMode()) {
            console.log(`Stealth Lock: KEY sym=0x${keyval.toString(16)} uni=NONE (not added)`);
        }
        
        return Clutter.EVENT_STOP; // Consume all key events when locked
    }

    _handleDebugAbortSequence() {
        if (!this._isDebugMode() || !this._locked)
            return;

        const now = Date.now();
        if (now - this._debugAbortSequenceLastTime > 1200) {
            this._debugAbortSequenceCount = 0;
        }

        this._debugAbortSequenceLastTime = now;
        this._debugAbortSequenceCount += 1;

        if (this._debugAbortSequenceCount >= 5) {
            console.warn('Stealth Lock: DEBUG abort sequence used (Esc x5)');
            this._unlock(true);
        }
    }

    _updateDebugLabel(extraLine = null) {
        if (!this._debugLabel || !this._shouldShowDebugInfo())
            return;

        const abortAccel = (() => {
            try {
                return this._settings?.get_strv('debug-abort-hotkey')?.[0] ?? '';
            } catch (e) {
                return '';
            }
        })();

        const lines = [
            'Stealth Lock DEBUG',
            `bufferLen=${this._passwordBuffer.length}`,
            `authExit=${this._lastAuthExitCode ?? 'n/a'}`,
            `cursor=${this._cursorActor ? 'yes' : 'no'} size=${this._cursorSize || 0}`,
            `cursorStage=${this._lastCursorStagePos ?? 'n/a'} local=${this._lastCursorLocalPos ?? 'n/a'}`,
            `abort=${abortAccel || 'n/a'} (and Esc x5)`,
        ];

        if (extraLine)
            lines.push(extraLine);

        this._debugLabel.text = lines.join('\n');
    }

    _fallbackToSystemLock() {
        console.warn('Stealth Lock: Emergency fallback to GNOME lock screen');

        // Remove our overlay first so ScreenShield can become modal.
        this._unlock(true);

        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            try {
                Main.screenShield?.lock?.(true);
            } catch (e) {
                console.error('Stealth Lock: Failed to lock via ScreenShield:', e);
            }
            return GLib.SOURCE_REMOVE;
        });
    }
    
    _resetPasswordTimeout() {
        this._clearPasswordResetTimeout();

        const seconds = (() => {
            try {
                return this._settings?.get_uint('auto-reset-seconds') ?? DEFAULT_AUTO_RESET_SECONDS;
            } catch (e) {
                return DEFAULT_AUTO_RESET_SECONDS;
            }
        })();

        if (!seconds)
            return;

        this._passwordResetTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            seconds * 1000,
            () => {
                console.log('Stealth Lock: Password reset due to inactivity');
                this._passwordBuffer = '';
                this._updatePasswordPrompt();
                this._passwordResetTimeoutId = null;
                return GLib.SOURCE_REMOVE;
            }
        );
    }
    
    _clearPasswordResetTimeout() {
        if (this._passwordResetTimeoutId) {
            GLib.source_remove(this._passwordResetTimeoutId);
            this._passwordResetTimeoutId = null;
        }
    }
    
    async _attemptUnlock() {
        if (this._passwordBuffer.length === 0) return;
        
        const password = this._passwordBuffer;
        this._passwordBuffer = ''; // Clear immediately for security
        this._updatePasswordPrompt();

        console.log(`Stealth Lock: Unlock attempt (len=${password.length})`);
        this._updateDebugLabel('auth=running');
        
        // Verify password using PAM helper
        const success = await this._verifyPassword(password);
        
        if (success) {
            this._unlock();
        } else {
            console.log('Stealth Lock: Invalid password');
            this._updateDebugLabel('auth=failed');
            // Password already cleared, just reset timeout
            this._resetPasswordTimeout();
        }
    }
    
    async _verifyPassword(password) {
        return new Promise((resolve) => {
            try {
                // Use the PAM helper script directly
                const helperPath = GLib.build_filenamev([
                    this.path, 'polkit-auth-helper.py'
                ]);

                const debugMode = this._isDebugMode();
                const argv = ['python3', '-B', helperPath];
                if (debugMode)
                    argv.push('--debug');

                const procFlags = Gio.SubprocessFlags.STDIN_PIPE |
                    (debugMode
                        ? (Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE)
                        : (Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE));

                const proc = Gio.Subprocess.new(argv, procFlags);

                let finished = false;
                let timeoutId = GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT,
                    AUTH_TIMEOUT_MS,
                    () => {
                        timeoutId = null;
                        if (finished)
                            return GLib.SOURCE_REMOVE;

                        finished = true;
                        console.warn(`Stealth Lock: Auth helper timed out after ${AUTH_TIMEOUT_MS}ms`);
                        try {
                            proc.force_exit();
                        } catch (e) {
                            // Ignore force_exit errors
                        }
                        resolve(false);
                        return GLib.SOURCE_REMOVE;
                    }
                );

                proc.communicate_utf8_async(password + '\n', null, (source, result) => {
                    try {
                        let stdout = '';
                        let stderr = '';
                        const finishResult = proc.communicate_utf8_finish(result);
                        if (Array.isArray(finishResult)) {
                            // [ok, stdout, stderr]
                            [, stdout, stderr] = finishResult;
                        }

                        let exitCode = -1;
                        if (proc.get_if_exited()) {
                            exitCode = proc.get_exit_status();
                        } else if (proc.get_if_signaled()) {
                            exitCode = 128 + proc.get_term_sig();
                        }

                        if (!finished) {
                            finished = true;
                            if (exitCode !== 0)
                                console.warn(`Stealth Lock: Auth helper failed (exit=${exitCode})`);
                            this._lastAuthExitCode = exitCode;
                            if (debugMode && stderr?.trim()) {
                                const snippet = stderr.trim().replaceAll('\n', ' ').slice(0, 200);
                                this._updateDebugLabel(`authErr=${snippet}`);
                            } else {
                                this._updateDebugLabel();
                            }
                            resolve(exitCode === 0);
                        }
                    } catch (e) {
                        console.error('PAM verification error:', e);
                        if (!finished) {
                            finished = true;
                            this._lastAuthExitCode = -1;
                            this._updateDebugLabel('auth=error');
                            resolve(false);
                        }
                    } finally {
                        if (timeoutId) {
                            GLib.source_remove(timeoutId);
                            timeoutId = null;
                        }
                    }
                });
            } catch (e) {
                console.error('Failed to start PAM helper:', e);
                resolve(false);
            }
        });
    }
    
    _setLockCursor() {
        try {
            try {
                this._cursorSize = Math.max(16, Meta.prefs_get_cursor_size?.() ?? 32);
            } catch (e) {
                this._cursorSize = 32;
            }

            const customBitmapUri = (() => {
                let bitmap = '';
                try {
                    bitmap = this._settings?.get_string('cursor-bitmap-path')?.trim() ?? '';
                } catch (e) {
                    bitmap = '';
                }
                if (!bitmap)
                    return '';

                try {
                    const file = bitmap.includes('://')
                        ? Gio.File.new_for_uri(bitmap)
                        : Gio.File.new_for_path(bitmap);
                    if (!file.query_exists(null))
                        return '';
                    return file.get_uri();
                } catch (e) {
                    return '';
                }
            })();

            const cursorHeight = this._cursorSize;
            const usingCustomBitmap = !!customBitmapUri;
            const cursorWidth = usingCustomBitmap
                ? cursorHeight
                : Math.max(1, Math.round((LOCK_CURSOR_XBM.width * cursorHeight) / LOCK_CURSOR_XBM.height));

            if (usingCustomBitmap) {
                this._cursorHotX = Math.round(cursorWidth / 2);
                this._cursorHotY = Math.round(cursorHeight / 2);
            } else {
                const scaleX = cursorWidth / LOCK_CURSOR_XBM.width;
                const scaleY = cursorHeight / LOCK_CURSOR_XBM.height;
                this._cursorHotX = Math.round(LOCK_CURSOR_XBM.hotX * scaleX);
                this._cursorHotY = Math.round(LOCK_CURSOR_XBM.hotY * scaleY);
            }

            // Create cursor widget — added to the overlay so it renders above
            // the frozen screenshots.
            this._cursorActor = new St.Widget({
                width: cursorWidth,
                height: cursorHeight,
                reactive: false,
            });

            if (usingCustomBitmap) {
                this._cursorActor.style = [
                    `background-image: url("${customBitmapUri}");`,
                    'background-repeat: no-repeat;',
                    'background-position: center;',
                    'background-size: contain;',
                ].join(' ');
                console.log('Stealth Lock: Cursor set from custom bitmap');
            } else {
                // Generate cursor image from embedded XBM cursor bitmaps.
                try {
                    const readRgba = (key, fallback) => {
                        try {
                            const unpacked = this._settings?.get_value(key)?.deep_unpack?.();
                            if (!Array.isArray(unpacked) || unpacked.length !== 4)
                                return fallback;
                            return unpacked.map((v, i) => {
                                const n = Number(v);
                                if (!Number.isFinite(n))
                                    return fallback[i];
                                return Math.max(0, Math.min(255, Math.round(n)));
                            });
                        } catch (e) {
                            return fallback;
                        }
                    };

                    const rgba = _renderXbmCursorRgba(
                        LOCK_CURSOR_XBM,
                        cursorWidth,
                        cursorHeight,
                        {
                            fg: readRgba('cursor-fg-rgba', [0, 0, 0, 255]),
                            bg: readRgba('cursor-bg-rgba', [255, 255, 255, 255]),
                        }
                    );
                    const rowstride = cursorWidth * 4;

                    // Prefer St.ImageContent when available (GNOME 46+), since it's
                    // what GNOME Shell uses internally for raw pixel uploads.
                    if (St.ImageContent?.new_with_preferred_size) {
                        const image = St.ImageContent.new_with_preferred_size(cursorWidth, cursorHeight);
                        const coglCtx = global.stage.context.get_backend().get_cogl_context();
                        image.set_data(
                            coglCtx,
                            rgba,
                            Cogl.PixelFormat.RGBA_8888,
                            cursorWidth,
                            cursorHeight,
                            rowstride
                        );
                        this._cursorActor.set_content(image);
                    } else {
                        const image = new Clutter.Image();
                        image.set_data(
                            rgba,
                            Cogl.PixelFormat.RGBA_8888,
                            cursorWidth,
                            cursorHeight,
                            rowstride
                        );
                        this._cursorActor.set_content(image);
                    }
                    this._cursorActor.set_content_gravity(Clutter.ContentGravity.RESIZE_FILL);
                    console.log('Stealth Lock: Cursor generated from embedded XBM');
                } catch (imgErr) {
                    console.warn('Stealth Lock: Cursor generation failed:', imgErr?.stack ?? imgErr?.message ?? imgErr);
                    this._cursorActor.style = 'background-color: rgba(0,120,212,0.8); border-radius: 50%;';
                    this._cursorHotX = Math.round(cursorWidth / 2);
                    this._cursorHotY = Math.round(cursorHeight / 2);
                }
            }

            // Add cursor to overlay (last child = renders on top of screenshots)
            if (this._overlay) {
                this._overlay.add_child(this._cursorActor);
            }
            
            // Get cursor tracker and connect to position changes
            if (global.backend?.get_cursor_tracker)
                this._cursorTracker = global.backend.get_cursor_tracker();
            else
                this._cursorTracker = Meta.CursorTracker.get_for_display(global.display);
            
            // Hide the system cursor (try multiple strategies for robustness)
            this._cursorInhibited = false;
            this._previousPointerVisible = null;

            if (this._cursorTracker?.get_pointer_visible && this._cursorTracker?.set_pointer_visible) {
                try {
                    this._previousPointerVisible = this._cursorTracker.get_pointer_visible();
                } catch (e) {
                    this._previousPointerVisible = null;
                }

                try {
                    this._cursorTracker.set_pointer_visible(false);
                    this._cursorInhibited = true;
                } catch (e) {
                    // Ignore
                }
            }

            try {
                global.display.set_cursor(Meta.Cursor.NONE);
                this._cursorInhibited = true;
            } catch (e) {
                // Ignore
            }
            
            // Update custom cursor position
            this._cursorMotionId = this._cursorTracker.connect('position-invalidated', () => {
                this._updateCursorPosition();
            });
            
            // Also track stage motion events for smoother cursor
            this._stageMotionId = global.stage.connect('motion-event', (actor, event) => {
                if (this._locked && this._cursorActor) {
                    const [x, y] = event.get_coords();
                    this._setCursorActorPositionFromStage(x, y);
                }
                return this._locked ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
            });
            
            // Initial position
            this._updateCursorPosition();
            console.log(`Stealth Lock: Cursor pos=${this._cursorActor.x},${this._cursorActor.y} size=${this._cursorActor.width}x${this._cursorActor.height} visible=${this._cursorActor.visible} opacity=${this._cursorActor.opacity} parent=${this._cursorActor.get_parent()?.name ?? 'none'}`);
            
        } catch (e) {
            console.error('Failed to set custom cursor:', e);
        }
    }

    _syncDebugOverlay() {
        if (!this._locked || !this._overlay)
            return;

        if (this._shouldShowDebugInfo()) {
            if (this._debugLabel)
                return;

            this._debugLabel = new St.Label({
                style: 'color: #fff; background-color: rgba(0,0,0,0.70); padding: 8px; border-radius: 6px; font-family: monospace; font-size: 12px;',
                text: '',
            });
            this._debugLabel.set_position(12, 12);
            this._overlay.add_child(this._debugLabel);
            this._updateDebugLabel();
            return;
        }

        if (this._debugLabel) {
            this._debugLabel.destroy();
            this._debugLabel = null;
        }
    }

    _shouldNormalPromptFollowCursor() {
        if (!this._settings)
            return false;

        if (!this._isNormalLockType())
            return false;

        try {
            return !!this._settings.get_boolean('normal-prompt-follow-cursor');
        } catch (e) {
            return false;
        }
    }

    _getNormalPromptAnchor() {
        try {
            return this._settings?.get_string('normal-prompt-cursor-anchor')?.trim() || 'br';
        } catch (e) {
            return 'br';
        }
    }

    _getNormalPromptOffsets() {
        const defaultX = 12;
        const defaultY = 12;
        try {
            const ox = this._settings?.get_int('normal-prompt-offset-x');
            const oy = this._settings?.get_int('normal-prompt-offset-y');
            return {
                x: Number.isFinite(ox) ? ox : defaultX,
                y: Number.isFinite(oy) ? oy : defaultY,
            };
        } catch (e) {
            return { x: defaultX, y: defaultY };
        }
    }

    _getNormalPromptFixedPosition() {
        try {
            const x = this._settings?.get_int('normal-prompt-fixed-x');
            const y = this._settings?.get_int('normal-prompt-fixed-y');
            return {
                x: Number.isFinite(x) ? x : -1,
                y: Number.isFinite(y) ? y : -1,
            };
        } catch (e) {
            return { x: -1, y: -1 };
        }
    }

    _getSelectedMonitor() {
        try {
            const monitorSetting = this._settings?.get_string('normal-prompt-monitor')?.trim() ?? '';
            if (!monitorSetting)
                return null;

            const monitors = Main.layoutManager.monitors;
            if (!monitors?.length)
                return null;

            const idx = parseInt(monitorSetting, 10);
            if (Number.isFinite(idx) && idx >= 0 && idx < monitors.length)
                return monitors[idx];
        } catch (e) {
            // Ignore
        }
        return null;
    }

    _isSystemDarkTheme() {
        try {
            const ifaceSettings = new Gio.Settings({ schema: 'org.gnome.desktop.interface' });
            const scheme = ifaceSettings.get_string('color-scheme');
            return scheme === 'prefer-dark';
        } catch (e) {
            return false;
        }
    }

    _compileNormalPromptCustomJs() {
        this._passwordPromptCustomFn = null;
        if (!this._settings)
            return;

        let src = '';
        try {
            src = this._settings.get_string('normal-prompt-custom-js') ?? '';
        } catch (e) {
            src = '';
        }

        src = src.trim();
        if (!src)
            return;

        try {
            // eslint-disable-next-line no-new-func
            this._passwordPromptCustomFn = new Function('ctx', src);
        } catch (e) {
            console.error('Stealth Lock: Failed to compile normal-prompt-custom-js:', e);
            this._passwordPromptCustomFn = null;
        }
    }

    _runNormalPromptCustomJs(ctx) {
        if (!this._passwordPromptCustomFn)
            return;

        try {
            this._passwordPromptCustomFn(ctx);
        } catch (e) {
            console.error('Stealth Lock: normal-prompt-custom-js error:', e);
        }
    }

    _syncPasswordPrompt() {
        if (!this._locked || !this._overlay)
            return;

        if (!this._isNormalLockType()) {
            this._destroyPasswordPrompt();
            return;
        }

        if (!this._passwordPrompt)
            this._createPasswordPrompt();

        this._updatePasswordPrompt();
        this._updatePasswordPromptPosition();

        // Ensure cursor tracking is set up for prompt following.
        // position-invalidated on the cursor tracker is more reliable than
        // captured-event MOTION during pushModal with LOCK_SCREEN mode.
        if (this._shouldNormalPromptFollowCursor())
            this._ensurePromptCursorTracking();
    }

    _ensurePromptCursorTracking() {
        // Already tracking via this dedicated handler
        if (this._promptCursorMotionId)
            return;

        // If _setLockCursor() already connected position-invalidated via
        // _cursorMotionId, _updateCursorPosition() will handle prompt updates
        // too (we modified it above).  Still add a dedicated handler so prompt
        // following works even when lock-cursor is disabled.
        if (this._cursorMotionId)
            return;

        if (!this._cursorTracker) {
            try {
                if (global.backend?.get_cursor_tracker)
                    this._cursorTracker = global.backend.get_cursor_tracker();
                else
                    this._cursorTracker = Meta.CursorTracker.get_for_display(global.display);
            } catch (e) {
                return;
            }
        }

        if (!this._cursorTracker)
            return;

        this._promptCursorMotionId = this._cursorTracker.connect('position-invalidated', () => {
            this._updateCursorPosition();
        });
    }

    _createPasswordPrompt() {
        if (!this._overlay || this._passwordPrompt)
            return;

        this._passwordPromptRevealed = false;
        this._compileNormalPromptCustomJs();

        const prompt = new St.BoxLayout({
            name: 'stealthLockPasswordPrompt',
            style_class: 'stealth-lock-password-prompt',
            reactive: true,
            can_focus: false,
            track_hover: true,
        });

        const text = new St.Label({
            name: 'stealthLockPasswordText',
            style_class: 'stealth-lock-password-text',
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
        });
        prompt.add_child(text);

        const revealIcon = new St.Icon({
            icon_name: 'view-reveal-symbolic',
            style_class: 'stealth-lock-password-reveal-icon',
        });

        const revealButton = new St.Button({
            name: 'stealthLockPasswordRevealButton',
            style_class: 'stealth-lock-password-reveal-button',
            reactive: true,
            can_focus: false,
            track_hover: true,
            child: revealIcon,
        });
        revealButton.connect('clicked', () => {
            this._passwordPromptRevealed = !this._passwordPromptRevealed;
            revealIcon.icon_name = this._passwordPromptRevealed ? 'view-conceal-symbolic' : 'view-reveal-symbolic';
            this._updatePasswordPrompt();
        });
        prompt.add_child(revealButton);

        const isDark = this._isSystemDarkTheme();

        // Dark theme defaults for child elements (not affected by user CSS).
        if (isDark) {
            text.style = 'color: #e0e0e0;';
            revealIcon.style = 'color: #aaaaaa;';
        }

        // User CSS override (inline) takes priority over dark defaults.
        try {
            const css = this._settings?.get_string('normal-prompt-css') ?? '';
            if (css.trim())
                prompt.style = css;
            else if (isDark)
                prompt.style = 'background-color: #2d2d2d; border-color: #555555;';
        } catch (e) {
            if (isDark)
                prompt.style = 'background-color: #2d2d2d; border-color: #555555;';
        }

        this._passwordPrompt = prompt;
        this._passwordPromptText = text;
        this._passwordPromptRevealButton = revealButton;
        this._passwordPromptRevealIcon = revealIcon;

        this._overlay.add_child(prompt);

        // Raise cursor actor above the prompt so it renders on top
        if (this._cursorActor && this._overlay.contains(this._cursorActor))
            this._overlay.set_child_above_sibling(this._cursorActor, prompt);

        this._runNormalPromptCustomJs({
            event: 'init',
            prompt,
            text,
            revealButton,
            revealed: this._passwordPromptRevealed,
            settings: this._settings,
        });
    }

    _destroyPasswordPrompt() {
        // Disconnect dedicated prompt cursor tracking
        if (this._promptCursorMotionId && this._cursorTracker) {
            try {
                this._cursorTracker.disconnect(this._promptCursorMotionId);
            } catch (e) {
                // Ignore
            }
        }
        this._promptCursorMotionId = null;

        if (this._passwordPrompt) {
            try {
                this._passwordPrompt.destroy();
            } catch (e) {
                // Ignore
            }
        }

        this._passwordPrompt = null;
        this._passwordPromptText = null;
        this._passwordPromptRevealButton = null;
        this._passwordPromptRevealIcon = null;
        this._passwordPromptRevealed = false;
        this._passwordPromptLastStageX = null;
        this._passwordPromptLastStageY = null;
        this._passwordPromptCustomFn = null;
    }

    _updatePasswordPrompt() {
        if (!this._passwordPrompt || !this._passwordPromptText)
            return;

        const masked = PASSWORD_BULLET.repeat(this._passwordBuffer.length);
        const displayText = this._passwordPromptRevealed ? this._passwordBuffer : masked;
        this._passwordPromptText.text = displayText;

        this._runNormalPromptCustomJs({
            event: 'update',
            prompt: this._passwordPrompt,
            text: this._passwordPromptText,
            revealButton: this._passwordPromptRevealButton,
            buffer: this._passwordBuffer,
            masked,
            revealed: this._passwordPromptRevealed,
            settings: this._settings,
        });

        // Re-clamp/re-anchor if size changed (e.g. more bullets).
        this._updatePasswordPromptPosition();
    }

    _updatePasswordPromptPosition() {
        if (!this._passwordPrompt || !this._overlay)
            return;

        if (this._shouldNormalPromptFollowCursor()) {
            // Use last known pointer position (updated by motion events), otherwise
            // fall back to a one-time pointer query.
            if (Number.isFinite(this._passwordPromptLastStageX) && Number.isFinite(this._passwordPromptLastStageY)) {
                this._setPasswordPromptPositionFromStage(this._passwordPromptLastStageX, this._passwordPromptLastStageY);
                return;
            }

            try {
                const [x, y] = global.get_pointer();
                this._passwordPromptLastStageX = x;
                this._passwordPromptLastStageY = y;
                this._setPasswordPromptPositionFromStage(x, y);
                return;
            } catch (e) {
                // Ignore and fall through to fixed positioning
            }
        }

        const fixed = this._getNormalPromptFixedPosition();
        this._setPasswordPromptPositionFixed(fixed.x, fixed.y);
    }

    _setPasswordPromptPositionFixed(x, y) {
        if (!this._passwordPrompt || !this._overlay)
            return;

        const { width: natW, height: natH } = this._getActorNaturalSize(this._passwordPrompt);
        const promptW = this._passwordPrompt.width || natW || 0;
        const promptH = this._passwordPrompt.height || natH || 0;
        const overlayW = this._overlay.width || 0;
        const overlayH = this._overlay.height || 0;
        const originX = this._overlay._originX ?? 0;
        const originY = this._overlay._originY ?? 0;

        let px = x;
        let py = y;

        if (px < 0 || py < 0) {
            const monitor = this._getSelectedMonitor();
            if (monitor) {
                // Center within the selected monitor's area
                const mx = monitor.x - originX;
                const my = monitor.y - originY;
                if (px < 0)
                    px = mx + Math.round((monitor.width - promptW) / 2);
                if (py < 0)
                    py = my + Math.round((monitor.height - promptH) / 2);
            } else {
                // Center across all monitors
                if (px < 0)
                    px = Math.round((overlayW - promptW) / 2);
                if (py < 0)
                    py = Math.round((overlayH - promptH) / 2);
            }
        }

        px = Math.max(0, Math.min(px, Math.max(0, overlayW - promptW)));
        py = Math.max(0, Math.min(py, Math.max(0, overlayH - promptH)));

        this._passwordPrompt.set_position(px, py);
    }

    _setPasswordPromptPositionFromStage(stageX, stageY) {
        if (!this._passwordPrompt || !this._overlay)
            return;

        const overlayX = this._overlay.x ?? 0;
        const overlayY = this._overlay.y ?? 0;
        const cx = stageX - overlayX;
        const cy = stageY - overlayY;

        const { width: natW, height: natH } = this._getActorNaturalSize(this._passwordPrompt);
        const promptW = this._passwordPrompt.width || natW || 0;
        const promptH = this._passwordPrompt.height || natH || 0;
        const overlayW = this._overlay.width || 0;
        const overlayH = this._overlay.height || 0;

        const offsets = this._getNormalPromptOffsets();
        const anchor = this._getNormalPromptAnchor();

        let px = cx + offsets.x;
        let py = cy + offsets.y;

        if (anchor === 'tr') {
            px = cx + offsets.x;
            py = cy - promptH - offsets.y;
        } else if (anchor === 'tl') {
            px = cx - promptW - offsets.x;
            py = cy - promptH - offsets.y;
        } else if (anchor === 'bl') {
            px = cx - promptW - offsets.x;
            py = cy + offsets.y;
        } // else 'br'

        px = Math.max(0, Math.min(px, Math.max(0, overlayW - promptW)));
        py = Math.max(0, Math.min(py, Math.max(0, overlayH - promptH)));

        this._passwordPrompt.set_position(px, py);
    }

    _getActorNaturalSize(actor) {
        try {
            const [, natW] = actor.get_preferred_width(-1);
            const [, natH] = actor.get_preferred_height(-1);
            return { width: natW, height: natH };
        } catch (e) {
            return { width: actor?.width ?? 0, height: actor?.height ?? 0 };
        }
    }

    _isPointerInPasswordPrompt(stageX, stageY) {
        if (!this._passwordPrompt || !this._overlay)
            return false;

        const overlayX = this._overlay.x ?? 0;
        const overlayY = this._overlay.y ?? 0;
        const promptX = overlayX + (this._passwordPrompt.x ?? 0);
        const promptY = overlayY + (this._passwordPrompt.y ?? 0);

        const { width: natW, height: natH } = this._getActorNaturalSize(this._passwordPrompt);
        const promptW = this._passwordPrompt.width || natW || 0;
        const promptH = this._passwordPrompt.height || natH || 0;

        return stageX >= promptX && stageX <= (promptX + promptW) &&
            stageY >= promptY && stageY <= (promptY + promptH);
    }
    
    _updateCursorPosition() {
        if (!this._cursorTracker) return;

        const needsCursor = !!this._cursorActor;
        const needsPrompt = this._passwordPrompt && this._shouldNormalPromptFollowCursor();
        if (!needsCursor && !needsPrompt) return;

        try {
            const result = this._cursorTracker.get_pointer();
            // GNOME 48+: returns [Graphene.Point, modifiers]
            // Older: returns [x, y, modifiers]
            const first = result[0];
            const px = (first?.x !== undefined) ? first.x : first;
            const py = (first?.y !== undefined) ? first.y : result[1];

            if (needsCursor)
                this._setCursorActorPositionFromStage(px, py);

            if (needsPrompt) {
                this._passwordPromptLastStageX = px;
                this._passwordPromptLastStageY = py;
                this._setPasswordPromptPositionFromStage(px, py);
            }
        } catch (e) {
            // Ignore position errors
        }
    }

    _setCursorActorPositionFromStage(stageX, stageY) {
        if (!this._cursorActor)
            return;

        this._lastCursorStagePos = `${Math.round(stageX)},${Math.round(stageY)}`;

        const defaultHotX = Math.round((this._cursorActor.width || this._cursorSize || 32) / 2);
        const defaultHotY = Math.round((this._cursorActor.height || this._cursorSize || 32) / 2);
        const hotX = Number.isFinite(this._cursorHotX) ? this._cursorHotX : defaultHotX;
        const hotY = Number.isFinite(this._cursorHotY) ? this._cursorHotY : defaultHotY;

        this._cursorActor.set_position(stageX - hotX, stageY - hotY);
        this._cursorActor.visible = true;

        if (this._isDebugMode()) {
            const now = Date.now();
            if (now - this._lastDebugCursorLabelUpdate > 200) {
                this._lastDebugCursorLabelUpdate = now;
                this._updateDebugLabel();
            }
        }
    }
    
    _restoreCursor() {
        // Disconnect cursor tracking
        if (this._promptCursorMotionId && this._cursorTracker) {
            try {
                this._cursorTracker.disconnect(this._promptCursorMotionId);
            } catch (e) {
                // Ignore
            }
            this._promptCursorMotionId = null;
        }

        if (this._cursorMotionId && this._cursorTracker) {
            this._cursorTracker.disconnect(this._cursorMotionId);
            this._cursorMotionId = null;
        }
        
        if (this._stageMotionId) {
            global.stage.disconnect(this._stageMotionId);
            this._stageMotionId = null;
        }
        
        // Show system cursor again
        if (this._cursorTracker && this._cursorInhibited) {
            if (this._cursorTracker.set_pointer_visible) {
                try {
                    this._cursorTracker.set_pointer_visible(this._previousPointerVisible ?? true);
                } catch (e) {
                    // Ignore
                }
            } else if (this._cursorTracker.uninhibit_cursor_visibility) {
                try {
                    this._cursorTracker.uninhibit_cursor_visibility();
                } catch (e) {
                    // Ignore
                }
            }
        }
        this._cursorInhibited = false;
        this._previousPointerVisible = null;

        try {
            global.display.set_cursor(Meta.Cursor.DEFAULT);
        } catch (e) {
            // Ignore
        }
        
        // Remove custom cursor actor
        if (this._cursorActor) {
            this._cursorActor.destroy();
            this._cursorActor = null;
        }
        
        this._cursorTracker = null;
    }
    
    async _pauseAllMedia() {
        this._pausedPlayers = [];
        
        try {
            const bus = Gio.DBus.session;
            
            // List all MPRIS players
            const result = await new Promise((resolve, reject) => {
                bus.call(
                    'org.freedesktop.DBus',
                    '/org/freedesktop/DBus',
                    'org.freedesktop.DBus',
                    'ListNames',
                    null,
                    new GLib.VariantType('(as)'),
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null,
                    (conn, res) => {
                        try {
                            resolve(conn.call_finish(res));
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            });
            
            const names = result.deep_unpack()[0];
            const mprisPlayers = names.filter(n => n.startsWith(MPRIS_PREFIX));
            
            for (const playerName of mprisPlayers) {
                await this._pausePlayer(playerName);
            }
            
            console.log(`Stealth Lock: Paused ${this._pausedPlayers.length} media players`);
        } catch (e) {
            console.error('Failed to pause media:', e);
        }
    }
    
    async _pausePlayer(playerName) {
        try {
            const bus = Gio.DBus.session;
            
            // Check if player is playing
            const propsResult = await new Promise((resolve, reject) => {
                bus.call(
                    playerName,
                    MPRIS_PATH,
                    'org.freedesktop.DBus.Properties',
                    'Get',
                    new GLib.Variant('(ss)', [MPRIS_PLAYER_INTERFACE, 'PlaybackStatus']),
                    new GLib.VariantType('(v)'),
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null,
                    (conn, res) => {
                        try {
                            resolve(conn.call_finish(res));
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            });
            
            const status = propsResult.deep_unpack()[0].deep_unpack();
            
            if (status === 'Playing') {
                // Pause the player
                await new Promise((resolve, reject) => {
                    bus.call(
                        playerName,
                        MPRIS_PATH,
                        MPRIS_PLAYER_INTERFACE,
                        'Pause',
                        null,
                        null,
                        Gio.DBusCallFlags.NONE,
                        -1,
                        null,
                        (conn, res) => {
                            try {
                                conn.call_finish(res);
                                resolve();
                            } catch (e) {
                                reject(e);
                            }
                        }
                    );
                });
                
                // Remember this player was playing
                this._pausedPlayers.push(playerName);
            }
        } catch (e) {
            console.log(`Failed to pause player ${playerName}:`, e.message);
        }
    }
    
    async _resumeAllMedia() {
        for (const playerName of this._pausedPlayers) {
            await this._resumePlayer(playerName);
        }
        
        console.log(`Stealth Lock: Resumed ${this._pausedPlayers.length} media players`);
        this._pausedPlayers = [];
    }
    
    async _resumePlayer(playerName) {
        try {
            const bus = Gio.DBus.session;
            
            await new Promise((resolve, reject) => {
                bus.call(
                    playerName,
                    MPRIS_PATH,
                    MPRIS_PLAYER_INTERFACE,
                    'Play',
                    null,
                    null,
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null,
                    (conn, res) => {
                        try {
                            conn.call_finish(res);
                            resolve();
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            });
        } catch (e) {
            console.log(`Failed to resume player ${playerName}:`, e.message);
        }
    }
}
