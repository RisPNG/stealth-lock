import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {LockSession} from './shell/lockSession.js';
import {PausedMedia} from './shell/media.js';
import {LOCKED_STATE, PAUSED_MEDIA_STATE} from './shared/runtime-state.js';
import {initializeEffectPresets} from './shared/presets.js';
import {handoffToSystemLock, restoreWhenShellReady, watchSystemLock} from './shell/integration.js';

export default class StealthLockExtension extends Extension {
    enable() {
        this._cleanup = [];
        this._session = null;
        if (!this._runtime) {
            const restorePrivacy = global.get_runtime_state('b', LOCKED_STATE)?.deep_unpack() ?? false;
            this._runtime = {
                locked: restorePrivacy,
                restorePrivacy,
                intent: global.get_runtime_state('(ssas)', PAUSED_MEDIA_STATE)?.deep_unpack() ?? null,
                current: null,
                pendingPauses: new Map(),
            };
        }
        this._runtime.locked = this._runtime.restorePrivacy || Main.sessionMode.isLocked;
        this._shortcuts = {lock: Meta.KeyBindingAction.NONE, abort: Meta.KeyBindingAction.NONE};
        this._settings = this.getSettings();
        try {
            initializeEffectPresets(this._settings);
            this._shortcuts.lock = Main.wm.addKeybinding('lock-hotkey', this._settings, Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this.lock());
            this._cleanup.push(() => Main.wm.removeKeybinding('lock-hotkey'));
            this._cleanup.push(watchSystemLock(locked => {
                if (this._session)
                    this._session.systemLockChanged(locked);
                else {
                    this._runtime.locked = locked;
                    if (!locked) {
                        this._runtime.restorePrivacy = false;
                        global.set_runtime_state(LOCKED_STATE, null);
                    }
                    if (!locked && this._runtime.intent)
                        new PausedMedia(new Gio.Cancellable(), this._runtime).close();
                }
            }));
            this._settings.connectObject(
                'changed::debug-mode', () => this.configureAbortShortcut(),
                'changed::debug-abort-hotkey', () => this.configureAbortShortcut(),
                'changed::debug-abort-use-lock-hotkey', () => this.configureAbortShortcut(),
                'changed::lock-hotkey', () => this.configureAbortShortcut(),
                this
            );
            this._cleanup.push(() => this._settings.disconnectObject(this));
            this._cleanup.push(() => {
                if (this._shortcuts.abort !== Meta.KeyBindingAction.NONE)
                    Main.wm.removeKeybinding('debug-abort-hotkey');
                this._shortcuts.abort = Meta.KeyBindingAction.NONE;
            });
            this.configureAbortShortcut();
            if (this._runtime.restorePrivacy) {
                this._cleanup.push(restoreWhenShellReady(() => {
                    if (this._runtime.restorePrivacy)
                        this.lock();
                }, this));
            } else if (!this._runtime.locked && this._runtime.intent) {
                new PausedMedia(new Gio.Cancellable(), this._runtime).close();
            }
        } catch (error) {
            this.disable();
            throw error;
        }
    }

    disable() {
        this._session?.disable();
        if (this._runtime.current)
            this._runtime.current.close({resume: false});
        else if (this._runtime.intent)
            new PausedMedia(new Gio.Cancellable(), this._runtime).close({resume: false});
        for (const release of this._cleanup.splice(0).reverse()) {
            try {
                release();
            } catch (error) {
                console.error(`Stealth Lock: extension cleanup failed: ${error.message}`);
            }
        }
        this._settings = null;
    }

    lock() {
        if (this._session || Main.sessionMode.currentMode !== 'user' || Main.sessionMode.isLocked)
            return;
        if (this._settings.get_string('authentication-mode') === 'system') {
            try {
                if (handoffToSystemLock())
                    return;
            } catch (error) {
                console.error(`Stealth Lock: system authentication failed: ${error.message}`);
            }
            Main.notifyError('Stealth Lock could not activate system authentication', 'The system lock screen is unavailable');
            return;
        }
        const session = new LockSession({
            settings: this._settings,
            path: this.path,
            shortcuts: this._shortcuts,
            runtime: this._runtime,
            onClosed: () => {
                if (this._session === session)
                    this._session = null;
            },
        });
        this._session = session;
        session.start();
    }

    configureAbortShortcut() {
        if (this._shortcuts.abort !== Meta.KeyBindingAction.NONE)
            Main.wm.removeKeybinding('debug-abort-hotkey');
        this._shortcuts.abort = Meta.KeyBindingAction.NONE;
        if (!this._settings.get_boolean('debug-mode'))
            return;
        const useLock = this._settings.get_boolean('debug-abort-use-lock-hotkey');
        const shortcut = useLock ? this._settings.get_strv('lock-hotkey') : this._settings.get_strv('debug-abort-hotkey');
        if (useLock || shortcut[0] === this._settings.get_strv('lock-hotkey')[0])
            return;
        this._shortcuts.abort = Main.wm.addKeybinding('debug-abort-hotkey', this._settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NONE, () => this._session?.handoff());
    }
}
