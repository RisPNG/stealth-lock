import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Authentication} from './authentication.js';
import {PasswordInput} from './input.js';
import {LockOverlay} from './overlay.js';
import {captureScreenshot} from './screenshot.js';
import {handoffToSystemLock} from './shell.js';

const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const MPRIS_PLAYER = 'org.mpris.MediaPlayer2.Player';
export const LOCKED_STATE = 'stealth-lock@user.locked';

export class LockSession {
    constructor(extension, onClosed) {
        this.cancellable = new Gio.Cancellable();
        this._extension = extension;
        this._settings = extension.getSettings();
        this._authentication = new Authentication(extension.path, this.cancellable);
        this._onClosed = onClosed;
        this._cleanup = [];
        this._closed = false;
        this._ready = false;
        this._nativeLock = false;
        this._handoff = false;
        this._passwordReset = 0;
        this._escapeCount = 0;
        this._lastEscape = 0;
        this._grabbed = false;
        this._input = null;
        this._overlay = null;
    }

    async start() {
        try {
            this.cancellable.set_error_if_cancelled();
            this._input = new PasswordInput({
                stealth: this._settings.get_string('lock-type') === 'stealth',
                onSubmit: () => this.authenticate(),
                onActivity: () => this.resetPasswordTimeout(),
            });
            const input = this._input;
            this._cleanup.push({release: () => input.destroy()});
            this._overlay = new LockOverlay(this._settings, input);
            const overlay = this._overlay;
            this._cleanup.push({release: () => overlay.destroy()});
            overlay.actor.opacity = 0;
            Main.layoutManager.addTopChrome(overlay.actor);
            overlay.positionPrompt();
            const grab = Main.pushModal(overlay.actor, {actionMode: Shell.ActionMode.NONE});
            this._cleanup.push({release: () => Main.popModal(grab)});
            if ((grab.get_seat_state() & Clutter.GrabState.ALL) !== Clutter.GrabState.ALL)
                throw new Error('Could not acquire the keyboard and pointer');
            this._grabbed = true;
            global.set_runtime_state(LOCKED_STATE, new GLib.Variant('b', true));

            overlay.actor.connectObject('captured-event', (_actor, event) => this.handleEvent(event), overlay.actor);
            this._cleanup.push({release: () => overlay.actor.disconnectObject(overlay.actor)});
            Main.layoutManager.connectObject('monitors-changed', () => this.handoff(), overlay.actor);
            this._cleanup.push({release: () => Main.layoutManager.disconnectObject(overlay.actor)});
            this._settings.connectObject(
                'changed::normal-prompt-css', () => overlay.refreshStyle(),
                'changed::normal-background-css', () => overlay.refreshStyle(),
                overlay.actor
            );
            this._cleanup.push({release: () => this._settings.disconnectObject(overlay.actor)});
            this._cleanup.push({release: () => {
                if (this._passwordReset) {
                    GLib.Source.remove(this._passwordReset);
                    this._passwordReset = 0;
                }
            }});

            if (this._settings.get_boolean('pause-media')) {
                await this.pauseMedia();
                this.cancellable.set_error_if_cancelled();
            }
            if (this._settings.get_boolean('freeze-display')) {
                const {content} = await captureScreenshot(this.cancellable);
                this.cancellable.set_error_if_cancelled();
                overlay.background.set_content(content);
                overlay.background.set_content_gravity(Clutter.ContentGravity.RESIZE_FILL);
            }
            if (this._settings.get_string('cursor-mode') !== 'normal') {
                const tracker = Meta.CursorTracker.get_for_display
                    ? Meta.CursorTracker.get_for_display(global.display)
                    : global.backend.get_cursor_tracker();
                const visible = tracker.get_pointer_visible();
                tracker.connectObject('visibility-changed', () => {
                    if (!this._nativeLock && !this._closed)
                        tracker.set_pointer_visible(false);
                }, overlay.actor);
                this._cleanup.push({release: () => tracker.disconnectObject(overlay.actor)});
                tracker.set_pointer_visible(false);
                this._cleanup.push({release: () => {
                    if (!this._nativeLock)
                        tracker.set_pointer_visible(visible);
                }});
            }
            this._ready = true;
            overlay.actor.opacity = 255;
            overlay.info.text = 'Stealth Lock privacy screen\nPassword required\nCtrl+Alt+Shift+L: GNOME lock';
            input.actor.grab_key_focus();
        } catch (error) {
            if (this.cancellable.is_cancelled())
                return;
            console.error(`Stealth Lock: ${error.message}`);
            if (!this.handoff()) {
                if (this._grabbed) {
                    this._ready = true;
                    this._overlay.actor.opacity = 255;
                    this._overlay.info.text = 'Setup incomplete; password or Ctrl+Alt+Shift+L required';
                    this._input.actor.grab_key_focus();
                } else {
                    this.close({clearState: false});
                    Main.notifyError('Stealth Lock could not protect the desktop', error.message);
                }
            }
        }
    }

    handleEvent(event) {
        if (this._nativeLock || this._closed)
            return Clutter.EVENT_PROPAGATE;
        const type = event.type();
        if (type === Clutter.EventType.ENTER || type === Clutter.EventType.LEAVE)
            return Clutter.EVENT_PROPAGATE;
        if (type === Clutter.EventType.MOTION) {
            this._overlay.movePointer(...event.get_coords());
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.KEY_PRESS) {
            const key = event.get_key_symbol();
            const state = event.get_state();
            const control = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
            const alt = (state & Clutter.ModifierType.MOD1_MASK) !== 0;
            const shift = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;
            if (control && alt && shift && (key === Clutter.KEY_l || key === Clutter.KEY_L)) {
                this.handoff();
                return Clutter.EVENT_STOP;
            }
            if (this._settings.get_boolean('debug-mode')) {
                const useLock = this._settings.get_boolean('debug-abort-use-lock-hotkey') ||
                    this._settings.get_strv('debug-abort-hotkey')[0] === this._settings.get_strv('lock-hotkey')[0];
                const action = global.display.get_keybinding_action(event.get_key_code(), state);
                const abort = useLock ? this._extension._lockAction : this._extension._abortAction;
                if (abort !== Meta.KeyBindingAction.NONE && action === abort) {
                    this.handoff();
                    return Clutter.EVENT_STOP;
                }
            }
            if (key === Clutter.KEY_Escape) {
                this._input.discardPassword();
                const now = GLib.get_monotonic_time();
                this._escapeCount = now - this._lastEscape <= 1200000 ? this._escapeCount + 1 : 1;
                this._lastEscape = now;
                if (this._settings.get_boolean('debug-mode') && this._escapeCount >= 5)
                    this.handoff();
                return Clutter.EVENT_STOP;
            }
            if (!this._ready || this._authentication.busy)
                return Clutter.EVENT_STOP;
            this.resetPasswordTimeout(true);
            if (control && !alt && (key === Clutter.KEY_r || key === Clutter.KEY_R) && this._overlay.prompt.visible) {
                this._input.actor.password_visible = !this._input.actor.password_visible;
                return Clutter.EVENT_STOP;
            }
            if (control && !alt && (key === Clutter.KEY_u || key === Clutter.KEY_U)) {
                this._input.discardPassword();
                return Clutter.EVENT_STOP;
            }
            if (shift && key === Clutter.KEY_Insert)
                return Clutter.EVENT_STOP;
            if (key === Clutter.KEY_Super_L || key === Clutter.KEY_Super_R ||
                (state & (Clutter.ModifierType.SUPER_MASK | Clutter.ModifierType.META_MASK)) || control)
                return Clutter.EVENT_STOP;
            if (alt && event.get_key_unicode() === 0)
                return Clutter.EVENT_STOP;
            this._input.actor.grab_key_focus();
            return Clutter.EVENT_PROPAGATE;
        }
        if (!this._ready || this._authentication.busy)
            return Clutter.EVENT_STOP;
        if (type === Clutter.EventType.KEY_RELEASE) {
            const key = event.get_key_symbol();
            if (key === Clutter.KEY_Super_L || key === Clutter.KEY_Super_R || key === Clutter.KEY_Meta_L || key === Clutter.KEY_Meta_R)
                return Clutter.EVENT_STOP;
            return Clutter.EVENT_PROPAGATE;
        }
        if (type === Clutter.EventType.IM_COMMIT || type === Clutter.EventType.IM_DELETE || type === Clutter.EventType.IM_PREEDIT) {
            this.resetPasswordTimeout(type === Clutter.EventType.IM_PREEDIT && !!event.get_im_text());
            return Clutter.EVENT_PROPAGATE;
        }
        const source = event.get_source();
        if ((type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.BUTTON_RELEASE) &&
            event.get_button() === 1 && this._overlay.prompt.visible) {
            const peek = this._input.actor.get_secondary_icon();
            if (peek && source && (source === peek || peek.contains(source)))
                return Clutter.EVENT_PROPAGATE;
        }
        return Clutter.EVENT_STOP;
    }

    resetPasswordTimeout(inputEvent = false) {
        if (this._passwordReset) {
            GLib.Source.remove(this._passwordReset);
            this._passwordReset = 0;
        }
        if (this._closed || this._nativeLock || (!inputEvent && !this._input.actor.text))
            return;
        const seconds = this._settings.get_uint('auto-reset-seconds');
        if (seconds) {
            this._passwordReset = GLib.timeout_add(GLib.PRIORITY_DEFAULT, seconds * 1000, () => {
                this._passwordReset = 0;
                this._input.discardPassword();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    async authenticate() {
        if (!this._ready || this._closed || this._nativeLock || this._authentication.busy)
            return;
        let password = this._input.takePassword();
        if (!password)
            return;
        this._overlay.info.text = 'Checking password';
        try {
            const verification = this._authentication.verify(password);
            password = null;
            const success = await verification;
            this.cancellable.set_error_if_cancelled();
            if (success)
                this.close();
            else
                this._overlay.info.text = 'Authentication failed; wait before retrying';
        } catch (error) {
            if (!this.cancellable.is_cancelled()) {
                console.error(`Stealth Lock: authentication failed: ${error.message}`);
                this._overlay.info.text = 'Authentication unavailable; Ctrl+Alt+Shift+L opens GNOME lock';
            }
        }
    }

    handoff() {
        if (this._nativeLock || this._closed || this._handoff)
            return false;
        this._handoff = true;
        try {
            const locked = handoffToSystemLock();
            if (locked)
                this.nativeLockActivated();
            else if (this._overlay)
                this._overlay.info.text = 'GNOME could not lock; privacy screen remains active';
            return locked;
        } catch (error) {
            console.error(`Stealth Lock: GNOME lock failed: ${error.message}`);
            if (this._overlay)
                this._overlay.info.text = 'GNOME could not lock; privacy screen remains active';
            return false;
        } finally {
            this._handoff = false;
        }
    }

    nativeLockActivated() {
        if (this._closed || this._nativeLock)
            return;
        this._nativeLock = true;
        this.cancellable.cancel();
        for (let index = this._cleanup.length - 1; index >= 0; index--) {
            const resource = this._cleanup[index];
            if (resource.media)
                continue;
            this._cleanup.splice(index, 1);
            try {
                resource.release();
            } catch (error) {
                console.error(`Stealth Lock: cleanup failed: ${error.message}`);
            }
        }
        this._overlay = null;
        this._input = null;
    }

    close({resumeMedia = true, clearState = true} = {}) {
        if (this._closed)
            return;
        this._closed = true;
        this.cancellable.cancel();
        if (clearState)
            global.set_runtime_state(LOCKED_STATE, null);
        for (const resource of this._cleanup.splice(0).reverse()) {
            if (resource.media && !resumeMedia)
                continue;
            try {
                resource.release();
            } catch (error) {
                console.error(`Stealth Lock: cleanup failed: ${error.message}`);
            }
        }
        this._overlay = null;
        this._input = null;
        this._onClosed();
    }

    async pauseMedia() {
        const bus = Gio.DBus.session;
        try {
            const names = await new Promise((resolve, reject) => {
                bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames',
                    null, new GLib.VariantType('(as)'), Gio.DBusCallFlags.NONE, 2000, this.cancellable, (connection, result) => {
                        try {
                            resolve(connection.call_finish(result).deep_unpack()[0]);
                        } catch (error) {
                            reject(error);
                        }
                    });
            });
            this.cancellable.set_error_if_cancelled();
            await Promise.all(names.filter(name => name.startsWith('org.mpris.MediaPlayer2.')).map(async name => {
                let restoration = null;
                try {
                    const owner = await new Promise((resolve, reject) => {
                        bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'GetNameOwner',
                            new GLib.Variant('(s)', [name]), new GLib.VariantType('(s)'), Gio.DBusCallFlags.NONE, 2000,
                            this.cancellable, (connection, result) => {
                                try {
                                    resolve(connection.call_finish(result).deep_unpack()[0]);
                                } catch (error) {
                                    reject(error);
                                }
                            });
                    });
                    this.cancellable.set_error_if_cancelled();
                    const status = await new Promise((resolve, reject) => {
                        bus.call(owner, MPRIS_PATH, 'org.freedesktop.DBus.Properties', 'Get',
                            new GLib.Variant('(ss)', [MPRIS_PLAYER, 'PlaybackStatus']), new GLib.VariantType('(v)'),
                            Gio.DBusCallFlags.NONE, 2000, this.cancellable, (connection, result) => {
                                try {
                                    resolve(connection.call_finish(result).deep_unpack()[0].deep_unpack());
                                } catch (error) {
                                    reject(error);
                                }
                            });
                    });
                    this.cancellable.set_error_if_cancelled();
                    if (status !== 'Playing')
                        return;
                    restoration = {media: true, release: () => {
                        bus.call(owner, MPRIS_PATH, MPRIS_PLAYER, 'Play', null, null,
                            Gio.DBusCallFlags.NO_AUTO_START, 2000, null, null);
                    }};
                    this._cleanup.push(restoration);
                    await new Promise((resolve, reject) => {
                        bus.call(owner, MPRIS_PATH, MPRIS_PLAYER, 'Pause', null, null,
                            Gio.DBusCallFlags.NO_AUTO_START, 2000, this.cancellable, (connection, result) => {
                                try {
                                    connection.call_finish(result);
                                    resolve();
                                } catch (error) {
                                    reject(error);
                                }
                            });
                    });
                    this.cancellable.set_error_if_cancelled();
                } catch (error) {
                    if (!this.cancellable.is_cancelled()) {
                        if (restoration)
                            this._cleanup.splice(this._cleanup.indexOf(restoration), 1);
                        console.warn(`Stealth Lock: media pause failed: ${error.message}`);
                    }
                }
            }));
            this.cancellable.set_error_if_cancelled();
        } catch (error) {
            if (!this.cancellable.is_cancelled())
                console.warn(`Stealth Lock: media unavailable: ${error.message}`);
        }
    }
}
