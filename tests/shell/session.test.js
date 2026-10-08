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
    constructor(name, status = 'Playing', delayPause = false) {
        this.status = status;
        this.pauseCount = 0;
        this.playCount = 0;
        this.delayPause = delayPause;
        this.pendingPause = null;
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
        this.status = 'Paused';
        if (this.delayPause)
            this.pendingPause = invocation;
        else
            invocation.return_value(new GLib.Variant('()', []));
    }

    Play() {
        this.playCount++;
        this.status = 'Playing';
    }

    destroy() {
        this.pendingPause?.return_value(new GLib.Variant('()', []));
        this.pendingPause = null;
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

    async 'a replacement MPRIS owner never receives restoration'({extension, settings, expectLog}) {
        expectLog('Stealth Lock: media resume failed for :[0-9.]+:');
        settings.set_boolean('pause-media', true);
        const name = 'org.mpris.MediaPlayer2.stealth_test_replacement';
        const original = new TestPlayer(name);
        let replacement;
        try {
            extension.lock();
            await waitFor(() => extension._session?._ready, 'Original player paused');
            original.destroy();
            replacement = new TestPlayer(name, 'Paused');
            extension._session.close();
            await delay(100);
            equal(replacement.playCount, 0, 'New unique owner untouched');
        } finally {
            extension._session?.close();
            replacement?.destroy();
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
