import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {LockSession, LOCKED_STATE} from './lockSession.js';
import {watchSystemLock} from './shell.js';

export default class StealthLockExtension extends Extension {
    enable() {
        this._cleanup = [];
        this._session = null;
        this._settings = this.getSettings();
        try {
            if (this._settings.get_user_value('cursor-mode') === null && this._settings.get_user_value('lock-cursor') !== null)
                this._settings.set_string('cursor-mode', this._settings.get_boolean('lock-cursor') ? 'lock-icon' : 'normal');
            this._lockAction = Main.wm.addKeybinding('lock-hotkey', this._settings, Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this.lock());
            this._cleanup.push(() => Main.wm.removeKeybinding('lock-hotkey'));
            this._cleanup.push(watchSystemLock(locked => {
                if (this._session?._handoff)
                    return;
                if (locked && this._session)
                    this._session.nativeLockActivated();
                else if (!locked && this._session?._nativeLock)
                    this._session.close();
                else if (!locked && !this._session)
                    global.set_runtime_state(LOCKED_STATE, null);
            }));
            this._settings.connectObject(
                'changed::debug-mode', () => this.configureAbortShortcut(),
                'changed::debug-abort-hotkey', () => this.configureAbortShortcut(),
                'changed::debug-abort-use-lock-hotkey', () => this.configureAbortShortcut(),
                'changed::lock-hotkey', () => this.configureAbortShortcut(),
                this
            );
            this._cleanup.push(() => this._settings.disconnectObject(this));
            this._cleanup.push(() => Main.wm.removeKeybinding('debug-abort-hotkey'));
            this.configureAbortShortcut();
            if (global.get_runtime_state('b', LOCKED_STATE)?.deep_unpack())
                this.lock();
        } catch (error) {
            this.disable();
            throw error;
        }
    }

    disable() {
        if (this._session) {
            if (!this._session._nativeLock)
                this._session.handoff();
            this._session.cancellable.cancel();
            this._session.close({resumeMedia: false, clearState: false});
        }
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
        const session = new LockSession(this, () => {
            if (this._session === session)
                this._session = null;
        });
        this._session = session;
        session.start();
    }

    configureAbortShortcut() {
        Main.wm.removeKeybinding('debug-abort-hotkey');
        this._abortAction = Meta.KeyBindingAction.NONE;
        if (!this._settings.get_boolean('debug-mode'))
            return;
        const useLock = this._settings.get_boolean('debug-abort-use-lock-hotkey');
        const shortcut = useLock ? this._settings.get_strv('lock-hotkey') : this._settings.get_strv('debug-abort-hotkey');
        if (useLock || shortcut[0] === this._settings.get_strv('lock-hotkey')[0])
            return;
        this._abortAction = Main.wm.addKeybinding('debug-abort-hotkey', this._settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NONE, () => this._session?.handoff());
    }
}
