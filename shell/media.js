import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {LOCKED_STATE, PAUSED_MEDIA_STATE} from '../shared/runtime-state.js';

const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const MPRIS_PLAYER = 'org.mpris.MediaPlayer2.Player';
const MAX_PLAYERS = 32;

export class PausedMedia {
    constructor(cancellable, ownership = {current: null}) {
        this._cancellable = cancellable;
        this._ownership = ownership;
        this._pendingPauses = ownership.pendingPauses ??= new Map();
        this._bus = null;
        this._busId = null;
        this._players = new Set();
        this._invalidated = new Set();
        this._signals = [];
        this._epoch = GLib.uuid_string_random();
        this._saved = global.get_runtime_state('(ssas)', PAUSED_MEDIA_STATE)?.deep_unpack() ?? null;
        this._started = false;
        this._closed = false;
        this._restoration = null;
        ownership.current = this;
        if (this._saved) {
            this._saved[2] = this._saved[2].filter(owner => /^:\d+\.\d+$/u.test(owner)).slice(0, MAX_PLAYERS);
            global.set_runtime_state(PAUSED_MEDIA_STATE, new GLib.Variant('(ssas)', [this._saved[0], this._epoch, this._saved[2]]));
        }
    }

    saveRestoreIntent() {
        if (this._closed)
            return;
        const record = global.get_runtime_state('(ssas)', PAUSED_MEDIA_STATE)?.deep_unpack();
        if (record && record[1] !== this._epoch)
            return;
        global.set_runtime_state(PAUSED_MEDIA_STATE, new GLib.Variant('(ssas)', [this._busId, this._epoch, [...this._players]]));
    }

    async pause({pausePlaying = true} = {}) {
        if (this._started || this._closed || (!pausePlaying && !this._saved))
            return;
        this._started = true;
        try {
            this._cancellable.set_error_if_cancelled();
            this._bus = Gio.DBus.session;
            const bus = this._bus;
            this._busId = await new Promise((resolve, reject) => {
                bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'GetId',
                    null, new GLib.VariantType('(s)'), Gio.DBusCallFlags.NONE, 2000, this._cancellable, (connection, result) => {
                        try {
                            resolve(connection.call_finish(result).deep_unpack()[0]);
                        } catch (error) {
                            reject(error);
                        }
                    });
            });
            this._cancellable.set_error_if_cancelled();
            if (this._saved?.[0] === this._busId)
                this._players = new Set(this._saved[2]);
            const inherited = new Set(this._players);
            this.saveRestoreIntent();
            this._signals.push(bus.signal_subscribe(null, 'org.freedesktop.DBus.Properties', 'PropertiesChanged',
                MPRIS_PATH, MPRIS_PLAYER, Gio.DBusSignalFlags.NONE, (_connection, sender, _path, _iface, _signal, parameters) => {
                    if (this._closed || !this._players.has(sender))
                        return;
                    const [, changes, invalidated] = parameters.deep_unpack();
                    const status = changes.PlaybackStatus?.deep_unpack();
                    if (status === 'Playing' || status === 'Stopped' || invalidated.includes('PlaybackStatus')) {
                        this._players.delete(sender);
                        this._invalidated.add(sender);
                        this.saveRestoreIntent();
                    }
                }));
            this._signals.push(bus.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
                '/org/freedesktop/DBus', null, Gio.DBusSignalFlags.NONE, (_connection, _sender, _path, _iface, _signal, parameters) => {
                    const [name, , owner] = parameters.deep_unpack();
                    if (!this._closed && !owner && this._players.delete(name)) {
                        this._invalidated.add(name);
                        this.saveRestoreIntent();
                    }
                }));
            const owners = new Set(inherited);
            if (pausePlaying) {
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
                await Promise.all(names.filter(name => name.startsWith('org.mpris.MediaPlayer2.')).slice(0, 128).map(async name => {
                    try {
                        const owner = await new Promise((resolve, reject) => {
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
                        if (owners.size < MAX_PLAYERS && /^:\d+\.\d+$/u.test(owner))
                            owners.add(owner);
                    } catch (error) {
                        if (!this._cancellable.is_cancelled())
                            console.warn(`Stealth Lock: media discovery failed: ${error.message}`);
                    }
                }));
                this._cancellable.set_error_if_cancelled();
            }
            await Promise.all([...owners].map(async owner => {
                try {
                    const priorPause = this._pendingPauses.get(owner);
                    if (priorPause?.busId === this._busId)
                        await priorPause.promise.catch(() => null);
                    this._cancellable.set_error_if_cancelled();
                    const status = await new Promise((resolve, reject) => {
                        bus.call(owner, MPRIS_PATH, 'org.freedesktop.DBus.Properties', 'Get',
                            new GLib.Variant('(ss)', [MPRIS_PLAYER, 'PlaybackStatus']), new GLib.VariantType('(v)'),
                            Gio.DBusCallFlags.NO_AUTO_START, 2000, this._cancellable, (connection, result) => {
                                try {
                                    resolve(connection.call_finish(result).deep_unpack()[0].deep_unpack());
                                } catch (error) {
                                    reject(error);
                                }
                            });
                    });
                    this._cancellable.set_error_if_cancelled();
                    if (this._invalidated.has(owner))
                        return;
                    if (status === 'Paused' && inherited.has(owner))
                        return;
                    if (status !== 'Playing' || !pausePlaying) {
                        this._players.delete(owner);
                        this.saveRestoreIntent();
                        return;
                    }
                    this._players.add(owner);
                    this.saveRestoreIntent();
                    const pending = new Promise((resolve, reject) => {
                        bus.call(owner, MPRIS_PATH, MPRIS_PLAYER, 'Pause', null, null,
                            Gio.DBusCallFlags.NO_AUTO_START, 2000, null, (connection, result) => {
                                try {
                                    connection.call_finish(result);
                                    resolve();
                                } catch (error) {
                                    reject(error);
                                }
                            });
                    });
                    this._pendingPauses.set(owner, {busId: this._busId, promise: pending});
                    try {
                        await pending;
                    } finally {
                        if (this._pendingPauses.get(owner)?.promise === pending)
                            this._pendingPauses.delete(owner);
                    }
                    this._cancellable.set_error_if_cancelled();
                } catch (error) {
                    if (!this._cancellable.is_cancelled()) {
                        this._players.delete(owner);
                        this.saveRestoreIntent();
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
            return this._restoration;
        this._closed = true;
        if (this._ownership.current === this)
            this._ownership.current = null;
        const bus = this._bus;
        this._bus = null;
        for (const signal of this._signals.splice(0))
            bus.signal_unsubscribe(signal);
        const record = global.get_runtime_state('(ssas)', PAUSED_MEDIA_STATE)?.deep_unpack();
        const owners = record?.[1] === this._epoch ? [...record[2]] : [];
        this._players.clear();
        this._invalidated.clear();
        if (!resume) {
            if (record?.[1] === this._epoch)
                global.set_runtime_state(PAUSED_MEDIA_STATE, null);
            return null;
        }
        if (!bus || !this._busId)
            return null;
        this._restoration = Promise.all(owners.map(async owner => {
            try {
                const pending = this._pendingPauses.get(owner);
                if (pending?.busId === this._busId)
                    await pending.promise.catch(() => null);
                const status = await new Promise((resolve, reject) => {
                    bus.call(owner, MPRIS_PATH, 'org.freedesktop.DBus.Properties', 'Get',
                        new GLib.Variant('(ss)', [MPRIS_PLAYER, 'PlaybackStatus']), new GLib.VariantType('(v)'),
                        Gio.DBusCallFlags.NO_AUTO_START, 2000, null, (connection, result) => {
                            try {
                                resolve(connection.call_finish(result).deep_unpack()[0].deep_unpack());
                            } catch (error) {
                                reject(error);
                            }
                        });
                });
                const current = global.get_runtime_state('(ssas)', PAUSED_MEDIA_STATE)?.deep_unpack();
                if (status !== 'Paused' || current?.[1] !== this._epoch || current[0] !== this._busId ||
                    global.get_runtime_state('b', LOCKED_STATE)?.deep_unpack())
                    return;
                await new Promise((resolve, reject) => {
                    bus.call(owner, MPRIS_PATH, MPRIS_PLAYER, 'Play', null, null,
                        Gio.DBusCallFlags.NO_AUTO_START, 2000, null, (connection, result) => {
                            try {
                                connection.call_finish(result);
                                resolve();
                            } catch (error) {
                                reject(error);
                            }
                        });
                });
                if (global.get_runtime_state('b', LOCKED_STATE)?.deep_unpack()) {
                    const successor = this._ownership.current;
                    await new Promise((resolve, reject) => {
                        bus.call(owner, MPRIS_PATH, MPRIS_PLAYER, 'Pause', null, null,
                            Gio.DBusCallFlags.NO_AUTO_START, 2000, null, (connection, result) => {
                                try {
                                    connection.call_finish(result);
                                    resolve();
                                } catch (error) {
                                    reject(error);
                                }
                        });
                    });
                    const retained = global.get_runtime_state('(ssas)', PAUSED_MEDIA_STATE)?.deep_unpack();
                    if (successor && !successor._closed && successor._busId === this._busId &&
                        retained?.[1] === successor._epoch && successor._players.size < MAX_PLAYERS) {
                        successor._invalidated.delete(owner);
                        successor._players.add(owner);
                        successor.saveRestoreIntent();
                    }
                }
            } catch (error) {
                console.warn(`Stealth Lock: media resume failed for ${owner}: ${error.message}`);
            } finally {
                const current = global.get_runtime_state('(ssas)', PAUSED_MEDIA_STATE)?.deep_unpack();
                if (current?.[1] === this._epoch && !global.get_runtime_state('b', LOCKED_STATE)?.deep_unpack()) {
                    const pending = current[2].filter(player => player !== owner);
                    global.set_runtime_state(PAUSED_MEDIA_STATE, pending.length
                        ? new GLib.Variant('(ssas)', [this._busId, this._epoch, pending]) : null);
                }
            }
        }));
        if (!owners.length && record?.[1] === this._epoch)
            global.set_runtime_state(PAUSED_MEDIA_STATE, null);
        return this._restoration;
    }
}
