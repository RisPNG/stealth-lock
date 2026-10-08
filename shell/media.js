import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const MPRIS_PLAYER = 'org.mpris.MediaPlayer2.Player';

export class PausedMedia {
    constructor(cancellable) {
        this._cancellable = cancellable;
        this._bus = null;
        this._players = new Set();
        this._started = false;
        this._closed = false;
    }

    async pause() {
        if (this._started || this._closed)
            return;
        this._started = true;
        try {
            this._cancellable.set_error_if_cancelled();
            this._bus = Gio.DBus.session;
            const bus = this._bus;
            const names = await new Promise((resolve, reject) => {
                bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames',
                    null, new GLib.VariantType('(as)'), Gio.DBusCallFlags.NONE, 2000, this._cancellable, (connection, result) => {
                        try {
                            resolve(connection.call_finish(result).deep_unpack()[0]);
                        } catch (error) {
                            reject(error);
                        }
                    });
            });
            this._cancellable.set_error_if_cancelled();
            const owners = new Set();
            await Promise.all(names.filter(name => name.startsWith('org.mpris.MediaPlayer2.')).map(async name => {
                let owner = null;
                try {
                    owner = await new Promise((resolve, reject) => {
                        bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'GetNameOwner',
                            new GLib.Variant('(s)', [name]), new GLib.VariantType('(s)'), Gio.DBusCallFlags.NONE, 2000,
                            this._cancellable, (connection, result) => {
                                try {
                                    resolve(connection.call_finish(result).deep_unpack()[0]);
                                } catch (error) {
                                    reject(error);
                                }
                            });
                    });
                    this._cancellable.set_error_if_cancelled();
                    if (owners.has(owner))
                        return;
                    owners.add(owner);
                    const status = await new Promise((resolve, reject) => {
                        bus.call(owner, MPRIS_PATH, 'org.freedesktop.DBus.Properties', 'Get',
                            new GLib.Variant('(ss)', [MPRIS_PLAYER, 'PlaybackStatus']), new GLib.VariantType('(v)'),
                            Gio.DBusCallFlags.NONE, 2000, this._cancellable, (connection, result) => {
                                try {
                                    resolve(connection.call_finish(result).deep_unpack()[0].deep_unpack());
                                } catch (error) {
                                    reject(error);
                                }
                            });
                    });
                    this._cancellable.set_error_if_cancelled();
                    if (status !== 'Playing')
                        return;
                    this._players.add(owner);
                    await new Promise((resolve, reject) => {
                        bus.call(owner, MPRIS_PATH, MPRIS_PLAYER, 'Pause', null, null,
                            Gio.DBusCallFlags.NO_AUTO_START, 2000, this._cancellable, (connection, result) => {
                                try {
                                    connection.call_finish(result);
                                    resolve();
                                } catch (error) {
                                    reject(error);
                                }
                            });
                    });
                    this._cancellable.set_error_if_cancelled();
                } catch (error) {
                    if (!this._cancellable.is_cancelled()) {
                        this._players.delete(owner);
                        console.warn(`Stealth Lock: media pause failed: ${error.message}`);
                    }
                }
            }));
            this._cancellable.set_error_if_cancelled();
        } catch (error) {
            if (!this._cancellable.is_cancelled())
                console.warn(`Stealth Lock: media unavailable: ${error.message}`);
        }
    }

    close({resume = true} = {}) {
        if (this._closed)
            return;
        this._closed = true;
        const owners = [...this._players];
        this._players.clear();
        const bus = this._bus;
        this._bus = null;
        if (!resume)
            return;
        for (const owner of owners) {
            try {
                bus.call(owner, MPRIS_PATH, MPRIS_PLAYER, 'Play', null, null,
                    Gio.DBusCallFlags.NO_AUTO_START, 2000, null, (connection, result) => {
                        try {
                            connection.call_finish(result);
                        } catch (error) {
                            console.warn(`Stealth Lock: media resume failed for ${owner}: ${error.message}`);
                        }
                    });
            } catch (error) {
                console.warn(`Stealth Lock: media resume failed for ${owner}: ${error.message}`);
            }
        }
    }
}
