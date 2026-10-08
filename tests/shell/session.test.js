import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {assert, delay, equal, waitFor} from './support.js';

const PLAYER_INTERFACE = `
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <method name="Pause"/>
    <method name="Play"/>
  </interface>
</node>`;

const APPLICATION_INTERFACE = `
<node>
  <interface name="org.mpris.MediaPlayer2">
    <property name="CanRaise" type="b" access="read"/>
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
  </interface>
</node>`;

class TestPlayer {
    constructor(name, status = 'Playing', delayPause = false, delayPlay = false) {
        this.status = status;
        this.pauseCount = 0;
        this.playCount = 0;
        this.delayPause = delayPause;
        this.pendingPause = null;
        this.delayPlay = delayPlay;
        this.pendingPlay = null;
        this.CanPlay = true;
        this.CanPause = true;
        this.CanGoNext = false;
        this.CanGoPrevious = false;
        this.CanRaise = false;
        this.Identity = 'Stealth Lock test player';
        this.DesktopEntry = '';
        this.Metadata = {
            'xesam:artist': new GLib.Variant('as', ['Stealth Lock tests']),
            'xesam:title': new GLib.Variant('s', 'Test track'),
        };
        this.connection = Gio.DBusConnection.new_for_address_sync(
            GLib.getenv('DBUS_SESSION_BUS_ADDRESS'),
            Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
            null, null);
        this.exported = Gio.DBusExportedObject.wrapJSObject(PLAYER_INTERFACE, this);
        this.exported.export(this.connection, '/org/mpris/MediaPlayer2');
        this.application = Gio.DBusExportedObject.wrapJSObject(APPLICATION_INTERFACE, this);
        this.application.export(this.connection, '/org/mpris/MediaPlayer2');
        this.connection.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'RequestName', new GLib.Variant('(su)', [name, 0]), new GLib.VariantType('(u)'),
            Gio.DBusCallFlags.NONE, 2000, null);
    }

    get PlaybackStatus() {
        return this.status;
    }

    PauseAsync(_params, invocation) {
        this.pauseCount++;
        if (this.delayPause)
            this.pendingPause = invocation;
        else {
            this.changeStatus('Paused');
            invocation.return_value(new GLib.Variant('()', []));
        }
    }

    PlayAsync(_params, invocation) {
        this.playCount++;
        if (this.delayPlay) {
            this.pendingPlay = invocation;
        } else {
            this.changeStatus('Playing');
            invocation.return_value(new GLib.Variant('()', []));
        }
    }

    changeStatus(status) {
        this.status = status;
        this.exported.emit_property_changed('PlaybackStatus', new GLib.Variant('s', status));
    }

    finishPlay() {
        if (!this.pendingPlay)
            return;
        this.changeStatus('Playing');
        this.pendingPlay.return_value(new GLib.Variant('()', []));
        this.pendingPlay = null;
    }

    finishPause() {
        if (!this.pendingPause)
            return;
        this.changeStatus('Paused');
        this.pendingPause.return_value(new GLib.Variant('()', []));
        this.pendingPause = null;
    }

    destroy() {
        this.finishPlay();
        this.finishPause();
        this.exported.unexport();
        this.application.unexport();
        this.connection.close_sync(null);
    }
}

export const tests = {
    async 'partial chrome acquisition unwinds an ordinary error'({extension, expectLog}) {
        expectLog('Stealth Lock: test acquisition failure');
        expectLog('Stealth Lock could not protect the desktop: test acquisition failure');
        const add = Main.layoutManager.addTopChrome;
        const lock = Main.screenShield?.lock;
        const modals = Main.modalCount;
        let actor;
        if (Main.screenShield)
            Main.screenShield.lock = () => {};
        try {
            Main.layoutManager.addTopChrome = function (overlay) {
                actor = overlay;
                add.call(this, overlay);
                throw new Error('test acquisition failure');
            };
            extension.lock();
            await delay(40);
            equal(extension._session, null, 'Failed ownership released');
            assert(!Main.uiGroup.get_children().includes(actor), 'Partially acquired chrome destroyed');
            equal(Main.modalCount, modals, 'No leaked modal');
        } finally {
            Main.layoutManager.addTopChrome = add;
            if (Main.screenShield)
                Main.screenShield.lock = lock;
        }
    },

    async 'close during native capture cancels ownership without waiting for its callback'({extension, settings}) {
        settings.set_boolean('freeze-display', true);
        const capture = Shell.Screenshot.prototype.screenshot_stage_to_content;
        const finish = Shell.Screenshot.prototype.screenshot_stage_to_content_finish;
        let callback;
        const modals = Main.modalCount;
        try {
            Shell.Screenshot.prototype.screenshot_stage_to_content = function (ready) {
                callback = () => ready(this, null);
            };
            Shell.Screenshot.prototype.screenshot_stage_to_content_finish = () => [null, 1];
            extension.lock();
            const session = extension._session;
            await waitFor(() => callback, 'Capture owns its asynchronous callback');
            assert(callback && session._grabbed && !session._ready, 'Grab precedes pending native capture');
            session.close();
            assert(session.cancellable.is_cancelled(), 'Close cancels pending capture');
            callback();
            await delay(50);
            assert(!session._overlay && !session._input && !extension._session, 'Late native callback recreates nothing');
            equal(Main.modalCount, modals, 'Late capture leaks no grab');
        } finally {
            Shell.Screenshot.prototype.screenshot_stage_to_content = capture;
            Shell.Screenshot.prototype.screenshot_stage_to_content_finish = finish;
        }
    },

    async 'one failed cleanup does not prevent the native grab from being released'({extension, expectLog}) {
        expectLog('Stealth Lock: cleanup failed: test cleanup failure');
        const modals = Main.modalCount;
        extension.lock();
        await waitFor(() => extension._session?._ready, 'Ready');
        const session = extension._session;
        session._cleanup.push(() => { throw new Error('test cleanup failure'); });
        session.close();
        session.close();
        equal(Main.modalCount, modals, 'Native grab released exactly once');
        equal(session._cleanup.length, 0, 'Cleanup drained despite failure');
        equal(extension._session, null, 'Session ownership released');
    },

    async 'real MPRIS only pauses and resumes players that were playing'({extension, settings}) {
        settings.set_boolean('pause-media', true);
        const players = ['Playing', 'Paused', 'Stopped'].map((status, index) => new TestPlayer(`org.mpris.MediaPlayer2.stealth_test_${index}`, status));
        try {
            extension.lock();
            await waitFor(() => extension._session?._ready, 'MPRIS pause completes');
            equal(players[0].pauseCount, 1, 'Playing player paused');
            equal(players[1].pauseCount + players[2].pauseCount, 0, 'Paused and stopped untouched');
            extension._session.close();
            await waitFor(() => players[0].playCount === 1, 'Original player resumed');
            equal(players[1].playCount + players[2].playCount, 0, 'Paused and stopped not resumed');
        } finally {
            extension._session?.close();
            await delay(50);
            for (const player of players)
                player.destroy();
        }
    },

    async 'a replacement MPRIS owner never receives restoration'({extension, settings}) {
        settings.set_boolean('pause-media', true);
        const name = 'org.mpris.MediaPlayer2.stealth_test_replacement';
        const original = new TestPlayer(name);
        let replacement;
        try {
            extension.lock();
            await waitFor(() => extension._session?._ready, 'Original player paused');
            original.destroy();
            replacement = new TestPlayer(name, 'Paused');
            await waitFor(() => extension._session._media._players.size === 0, 'Disappearing owner invalidates restoration');
            extension._session.close();
            await delay(100);
            equal(replacement.playCount, 0, 'New unique owner untouched');
        } finally {
            extension._session?.close();
            replacement?.destroy();
        }
    },

    async 'real external playback signals cancel restoration while the own Pause preserves it'({extension, settings}) {
        settings.set_boolean('pause-media', true);
        const player = new TestPlayer('org.mpris.MediaPlayer2.stealth_test_external');
        try {
            for (const status of ['Playing', 'Stopped']) {
                player.changeStatus('Playing');
                extension.lock();
                await waitFor(() => extension._session?._ready, 'External-status player paused');
                equal(extension._session._media._players.size, 1, 'Own Paused signal retains ownership');
                player.changeStatus(status);
                await waitFor(() => extension._session._media._players.size === 0, 'External status releases restoration');
                extension._session.close();
                await delay(60);
                equal(player.playCount, 0, 'External playback decision retained');
            }
        } finally {
            extension._session?.close();
            await delay(50);
            player.destroy();
        }
    },

    async 'closing during a pending remote Pause waits for its effect before restoring playback'({extension, settings}) {
        settings.set_boolean('pause-media', true);
        const player = new TestPlayer('org.mpris.MediaPlayer2.stealth_test_pending_pause', 'Playing', true);
        try {
            extension.lock();
            await waitFor(() => player.pendingPause, 'Remote Pause owns its pending reply');
            const session = extension._session;
            assert(session._grabbed && !session._ready, 'Privacy grab precedes pending media');
            session.close();
            await delay(60);
            equal(player.playCount, 0, 'Restoration waits for the delivered Pause');
            equal(player.status, 'Playing', 'Pending fixture has not paused yet');
            player.finishPause();
            await waitFor(() => player.playCount === 1 && player.status === 'Playing', 'Completed remote Pause is restored');
            assert(!session._overlay && !extension._session, 'Late reply cannot recreate privacy resources');
        } finally {
            player.finishPause();
            extension._session?.close();
            await delay(80);
            player.destroy();
        }
    },

    async 'per-login paused-player records rehydrate a new scope without pausing new players'({extension, settings}) {
        settings.set_boolean('pause-media', true);
        const player = new TestPlayer('org.mpris.MediaPlayer2.stealth_test_rehydrate');
        const {PausedMedia} = await import(Gio.File.new_for_path(extension.path).get_child('shell').get_child('media.js').get_uri());
        const {PAUSED_MEDIA_STATE} = await import(Gio.File.new_for_path(extension.path).get_child('shared').get_child('runtime-state.js').get_uri());
        const cancellable = new Gio.Cancellable();
        let recovered;
        try {
            extension.lock();
            await waitFor(() => extension._session?._ready, 'Initial media intent persisted');
            const record = global.get_runtime_state('(ssas)', PAUSED_MEDIA_STATE).deep_unpack();
            equal(record[2][0], player.connection.get_unique_name(), 'Persisted owner is the unique native bus owner');
            recovered = new PausedMedia(cancellable);
            await recovered.pause({pausePlaying: false});
            equal(player.pauseCount, 1, 'Rehydration does not pause an already paused player again');
            equal(recovered._players.size, 1, 'Matching bus and paused state rehydrate intent');
            extension._session.close();
            await delay(60);
            equal(player.playCount, 0, 'Old epoch cannot restore after ownership is claimed');
            cancellable.cancel();
            await recovered.close();
            equal(player.playCount, 1, 'New scope restores matching owner');
            assert(!global.get_runtime_state('(ssas)', PAUSED_MEDIA_STATE), 'Completed restoration removes persisted intent');
        } finally {
            extension._session?.close();
            cancellable.cancel();
            await recovered?.close();
            await delay(50);
            player.destroy();
        }
    },

    async 'immediate relock prevents an old native restoration query from playing or clearing new intent'({extension, settings}) {
        settings.set_boolean('pause-media', true);
        const player = new TestPlayer('org.mpris.MediaPlayer2.stealth_test_relock');
        const call = Gio.DBusConnection.prototype.call;
        let delayed;
        let intercept = false;
        try {
            Gio.DBusConnection.prototype.call = function (...arguments_) {
                if (intercept && arguments_[0] === player.connection.get_unique_name() &&
                    arguments_[2] === 'org.freedesktop.DBus.Properties' && arguments_[3] === 'Get') {
                    intercept = false;
                    const callback = arguments_[9];
                    arguments_[9] = (connection, result) => { delayed = () => callback(connection, result); };
                }
                call.apply(this, arguments_);
            };
            extension.lock();
            await waitFor(() => extension._session?._ready, 'Initial player paused');
            intercept = true;
            extension._session.close();
            await waitFor(() => delayed, 'Old restoration response held');
            extension.lock();
            await waitFor(() => extension._session?._ready, 'New session reclaims paused intent');
            delayed();
            delayed = null;
            await delay(80);
            equal(player.playCount, 0, 'Old query cannot play through a new lock');
            extension._session.close();
            await waitFor(() => player.playCount === 1, 'New unlock restores the player once');
        } finally {
            delayed?.();
            Gio.DBusConnection.prototype.call = call;
            extension._session?.close();
            await delay(50);
            player.destroy();
        }
    },

    async 'an old Play completed after relocking is paused again and retains new restoration intent'({extension, settings}) {
        settings.set_boolean('pause-media', true);
        const player = new TestPlayer('org.mpris.MediaPlayer2.stealth_test_pending_play', 'Playing', false, true);
        try {
            extension.lock();
            await waitFor(() => extension._session?._ready, 'Initial player paused');
            extension._session.close();
            await waitFor(() => player.pendingPlay, 'Old restoration owns a pending native Play');
            extension.lock();
            await waitFor(() => extension._session?._ready, 'New session reclaims pending intent');
            player.finishPlay();
            await waitFor(() => player.pauseCount === 2 && player.status === 'Paused', 'Late Play is compensated by a native Pause');
            await waitFor(() => extension._session._media._players.size === 1, 'Compensated owner belongs to the new epoch');
            player.delayPlay = false;
            extension._session.close();
            await waitFor(() => player.playCount === 2 && player.status === 'Playing', 'New unlock restores the compensated owner');
        } finally {
            player.delayPlay = false;
            player.finishPlay();
            extension._session?.close();
            await delay(80);
            player.destroy();
        }
    },

    async 'native locking defers real MPRIS restoration until native unlock'({extension, settings}) {
        if (!Main.screenShield)
            return {skipped: 'Stock ScreenShield requires private fake GDM'};
        settings.set_boolean('pause-media', true);
        const player = new TestPlayer('org.mpris.MediaPlayer2.stealth_test_handoff');
        try {
            extension.lock();
            await waitFor(() => extension._session?._ready, 'Player paused');
            const session = extension._session;
            assert(session.handoff(), 'Native shield confirms handoff');
            await delay(80);
            equal(player.playCount, 0, 'Native lock retains media ownership');
            Main.screenShield.deactivate(true);
            await waitFor(() => player.playCount === 1 && !extension._session, 'Native unlock restores original player');
        } finally {
            extension._session?.close();
            await delay(50);
            player.destroy();
        }
        return undefined;
    },

    async 'disable with refused native locking intentionally leaves media paused'({extension, settings}) {
        settings.set_boolean('pause-media', true);
        const player = new TestPlayer('org.mpris.MediaPlayer2.stealth_test_disable');
        const lock = Main.screenShield?.lock;
        if (Main.screenShield)
            Main.screenShield.lock = () => {};
        try {
            extension.lock();
            await waitFor(() => extension._session?._ready, 'Player paused');
            extension.disable();
            await delay(80);
            equal(player.playCount, 0, 'Disable policy does not resume media');
            extension.enable();
            await waitFor(() => extension._session?._ready, 'Marker reclaims protection');
            extension._session.close();
        } finally {
            if (Main.screenShield)
                Main.screenShield.lock = lock;
            extension._session?.close();
            await delay(50);
            player.destroy();
        }
    },
};
