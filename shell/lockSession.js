import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Authentication, MAX_PASSWORD_BYTES} from './authentication.js';
import {PasswordInput} from './input.js';
import {LockOverlay} from './overlay.js';
import {PausedMedia} from './media.js';
import {captureScreenshot} from './screenshot.js';
import {handoffToSystemLock} from './integration.js';
import {LOCKED_STATE} from '../shared/runtime-state.js';

export class LockSession {
    constructor({settings, path, shortcuts, mediaOwnership, onClosed}) {
        this.cancellable = new Gio.Cancellable();
        this._settings = settings;
        this._path = path;
        this._shortcuts = shortcuts;
        this._authentication = null;
        this._media = new PausedMedia(this.cancellable, mediaOwnership);
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
        this._layoutGeneration = 0;
    }

    async start() {
        try {
            this.cancellable.set_error_if_cancelled();
            this._authentication = new Authentication(this._path, this.cancellable, {
                pamService: this._settings.get_string('pam-service'),
                retryBaseSeconds: this._settings.get_int('retry-base-seconds'),
                retryMaxSeconds: this._settings.get_int('retry-max-seconds'),
            });
            this._input = new PasswordInput({
                stealth: this._settings.get_string('lock-type') === 'stealth',
                revealTimeoutSeconds: this._settings.get_int('password-reveal-timeout-seconds'),
                onSubmit: () => this.authenticate(),
                onActivity: () => this.resetPasswordTimeout(),
            });
            const input = this._input;
            this._cleanup.push(() => input.destroy());
            this._overlay = new LockOverlay(this._settings, input.actor, this.cancellable, this._path);
            const overlay = this._overlay;
            this._cleanup.push(() => overlay.destroy());
            overlay.actor.opacity = 0;
            Main.layoutManager.addTopChrome(overlay.actor);
            overlay.positionPrompt();
            const grab = Main.pushModal(overlay.actor, {actionMode: Shell.ActionMode.NONE});
            this._cleanup.push(() => Main.popModal(grab));
            if ((grab.get_seat_state() & Clutter.GrabState.ALL) !== Clutter.GrabState.ALL)
                throw new Error('Could not acquire the keyboard and pointer');
            this._grabbed = true;
            global.set_runtime_state(LOCKED_STATE, new GLib.Variant('b', true));

            overlay.actor.connectObject('captured-event', (_actor, event) => this.handleEvent(event), overlay.actor);
            this._cleanup.push(() => overlay.actor.disconnectObject(overlay.actor));
            Main.layoutManager.connectObject('monitors-changed', () => this.refreshMonitors(), overlay.actor);
            this._cleanup.push(() => Main.layoutManager.disconnectObject(overlay.actor));
            this._settings.connectObject(
                'changed::normal-prompt-css', () => overlay.refreshStyle(),
                'changed::normal-background-css', () => overlay.refreshStyle(),
                'changed::visual-effect-active', () => {
                    if (this._ready)
                        overlay.refreshEffect();
                },
                'changed::visual-effect-presets', () => {
                    if (this._ready)
                        overlay.refreshEffect();
                },
                'changed::normal-prompt-monitor', () => {
                    overlay.positionPrompt();
                    if (this._ready)
                        overlay.refreshEffect();
                },
                ...['normal-prompt-follow-cursor', 'normal-prompt-cursor-anchor', 'normal-prompt-offset-x',
                    'normal-prompt-offset-y', 'normal-prompt-fixed-x', 'normal-prompt-fixed-y'].flatMap(key =>
                    ['changed::' + key, () => overlay.positionPrompt()]),
                overlay.actor
            );
            this._cleanup.push(() => this._settings.disconnectObject(overlay.actor));
            this._cleanup.push(() => {
                if (this._passwordReset) {
                    GLib.Source.remove(this._passwordReset);
                    this._passwordReset = 0;
                }
            });

            await this._media.pause({pausePlaying: this._settings.get_boolean('pause-media')});
            this.cancellable.set_error_if_cancelled();
            if (this._settings.get_boolean('freeze-display')) {
                const generation = this._layoutGeneration;
                const {content} = await captureScreenshot(this.cancellable);
                this.cancellable.set_error_if_cancelled();
                if (generation === this._layoutGeneration) {
                    overlay.background.set_content(content);
                    overlay.background.set_content_gravity(Clutter.ContentGravity.RESIZE_FILL);
                }
            }
            if (this._settings.get_string('cursor-mode') !== 'normal') {
                const tracker = Meta.CursorTracker.get_for_display
                    ? Meta.CursorTracker.get_for_display(global.display)
                    : global.backend.get_cursor_tracker();
                if (tracker.inhibit_cursor_visibility) {
                    const seat = global.stage.context.get_backend().get_default_seat();
                    seat.inhibit_unfocus();
                    this._cleanup.push(() => seat.uninhibit_unfocus());
                    tracker.inhibit_cursor_visibility();
                    this._cleanup.push(() => tracker.uninhibit_cursor_visibility());
                } else {
                    const visible = tracker.get_pointer_visible();
                    tracker.connectObject('visibility-changed', () => {
                        if (!this._nativeLock && !this._closed)
                            tracker.set_pointer_visible(false);
                    }, overlay.actor);
                    this._cleanup.push(() => tracker.disconnectObject(overlay.actor));
                    tracker.set_pointer_visible(false);
                    this._cleanup.push(() => {
                        if (!this._nativeLock)
                            tracker.set_pointer_visible(visible);
                    });
                }
            }
            if (this._layoutGeneration === 0) {
                overlay.refreshEffect();
                this._ready = true;
                overlay.actor.opacity = 255;
            }
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
                    this._overlay.setStatus('Setup incomplete; password or Ctrl+Alt+Shift+L required');
                    this._input.actor.grab_key_focus();
                } else {
                    this.close({clearState: false});
                    Main.notifyError('Stealth Lock could not protect the desktop', error.message);
                }
            }
        }
    }

    async refreshMonitors() {
        if (this._closed || this._nativeLock)
            return;
        const generation = ++this._layoutGeneration;
        const overlay = this._overlay;
        this._ready = false;
        this._input.discardPassword();
        try {
            overlay.relayout();
            if (this._settings.get_boolean('freeze-display')) {
                overlay.actor.opacity = 0;
                const {content} = await captureScreenshot(this.cancellable);
                this.cancellable.set_error_if_cancelled();
                if (generation !== this._layoutGeneration)
                    return;
                overlay.background.set_content(content);
                overlay.background.set_content_gravity(Clutter.ContentGravity.RESIZE_FILL);
            }
            if (generation !== this._layoutGeneration)
                return;
            overlay.actor.opacity = 255;
            this._ready = true;
            this._input.actor.grab_key_focus();
        } catch (error) {
            if (!this.cancellable.is_cancelled() && generation === this._layoutGeneration) {
                overlay.actor.opacity = 255;
                this._ready = true;
                this._overlay.setStatus('Monitor update failed; use GNOME lock');
                this.handoff();
                console.debug(`Stealth Lock: monitor update failed: ${error.message}`);
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
                const abort = useLock ? this._shortcuts.lock : this._shortcuts.abort;
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
        }
        if (!this._ready || this._authentication.busy)
            return Clutter.EVENT_STOP;
        if (type === Clutter.EventType.IM_COMMIT || type === Clutter.EventType.IM_DELETE || type === Clutter.EventType.IM_PREEDIT)
            this.resetPasswordTimeout(type === Clutter.EventType.IM_PREEDIT && !!event.get_im_text());
        return this._input.handleEvent(event);
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
        if (new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES) {
            this._overlay.setStatus(`Password exceeds ${MAX_PASSWORD_BYTES} UTF-8 bytes; use GNOME lock`);
            return;
        }
        const retrySeconds = Math.ceil((this._authentication.retryUntil - GLib.get_monotonic_time() / 1000) / 1000);
        if (retrySeconds > 0) {
            this._overlay.setStatus(`Wait ${retrySeconds} seconds before retrying`);
            return;
        }
        this._overlay.setStatus('Checking password');
        try {
            const verification = this._authentication.verify(password);
            password = null;
            const outcome = await verification;
            this.cancellable.set_error_if_cancelled();
            if (outcome === 'granted')
                this.close();
            else if (outcome === 'denied')
                this._overlay.setStatus('Password not accepted; wait before retrying');
            else
                this._overlay.setStatus('Authentication unavailable; Ctrl+Alt+Shift+L opens GNOME lock');
            if (outcome !== 'granted' && this._settings.get_boolean('password-audible-feedback'))
                global.display.get_sound_player().play_from_theme('dialog-error', 'Stealth Lock authentication failed', null);
        } catch (error) {
            if (!this.cancellable.is_cancelled()) {
                console.error(`Stealth Lock: authentication failed: ${error.message}`);
                this._overlay.setStatus('Authentication unavailable; Ctrl+Alt+Shift+L opens GNOME lock');
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
                this._overlay.setStatus('GNOME could not lock; privacy screen remains active');
            return locked;
        } catch (error) {
            console.error(`Stealth Lock: GNOME lock failed: ${error.message}`);
            if (this._overlay)
                this._overlay.setStatus('GNOME could not lock; privacy screen remains active');
            return false;
        } finally {
            this._handoff = false;
        }
    }

    systemLockChanged(locked) {
        if (this._handoff || this._closed)
            return;
        if (locked)
            this.nativeLockActivated();
        else if (this._nativeLock)
            this.close();
    }

    disable() {
        if (this._closed)
            return;
        if (!this._nativeLock)
            this.handoff();
        this.close({resumeMedia: false, clearState: false});
    }

    nativeLockActivated() {
        if (this._closed || this._nativeLock)
            return;
        this._nativeLock = true;
        this.cancellable.cancel();
        this.releasePrivacyResources();
    }

    close({resumeMedia = true, clearState = true} = {}) {
        if (this._closed)
            return;
        this._closed = true;
        this.cancellable.cancel();
        if (clearState)
            global.set_runtime_state(LOCKED_STATE, null);
        this._media.close({resume: resumeMedia});
        this.releasePrivacyResources();
        this._onClosed();
    }

    releasePrivacyResources() {
        for (const release of this._cleanup.splice(0).reverse()) {
            try {
                release();
            } catch (error) {
                console.error(`Stealth Lock: cleanup failed: ${error.message}`);
            }
        }
        this._overlay = null;
        this._input = null;
    }
}
