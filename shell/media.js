import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {PAUSED_MEDIA_STATE} from '../shared/runtime-state.js';

const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const MPRIS_PLAYER = 'org.mpris.MediaPlayer2.Player';
const MAX_PLAYERS = 32;

export class PausedMedia {
    constructor(cancellable, runtime) {
        this._cancellable = cancellable;
        this._runtime = runtime;
        this._pendingPauses = runtime.pendingPauses;
        this._bus = null;
        this._busId = null;
        this._players = new Set();
        this._invalidated = new Set();
        this._signals = [];
        this._epoch = GLib.uuid_string_random();
        this._saved = null;
        this._started = false;
        this._closed = false;
        this._restoration = null;
        this._resume = true;
    }

    claimRestoreIntent() {
        const record = this._runtime.intent;
        this._saved = record
            ? [record[0], record[1], [...new Set(record[2].filter(owner => /^:\d+\.\d+$/u.test(owner)))].slice(0, MAX_PLAYERS)]
            : null;
        this._runtime.current = this;
        if (this._saved) {
            this._runtime.intent = [this._saved[0], this._epoch, this._saved[2]];
            global.set_runtime_state(PAUSED_MEDIA_STATE, new GLib.Variant('(ssas)', this._runtime.intent));
        }
    }

    saveRestoreIntent() {
        if (this._closed || this._runtime.current !== this)
            return;
        const record = this._runtime.intent;
        if (record && record[1] !== this._epoch)
            return;
        this._runtime.intent = [this._busId, this._epoch, [...this._players]];
        global.set_runtime_state(PAUSED_MEDIA_STATE, new GLib.Variant('(ssas)', this._runtime.intent));
    }

    retainCompensatedPlayer(owner, busId) {
        const successor = this._runtime.current;
        const intent = this._runtime.intent;
        if (this._runtime.locked && successor && !successor._closed && successor._busId === busId &&
            intent?.[1] === successor._epoch && successor._players.size < MAX_PLAYERS) {
            successor._invalidated.delete(owner);
            successor._players.add(owner);
            successor.saveRestoreIntent();
        }
    }

    async pauseOwnedPlayer(bus, owner, busId) {
        const previous = this._pendingPauses.get(owner);
        const delivery = new Promise((resolve, reject) => {
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
        const pending = Promise.allSettled([
            ...(previous?.busId === busId ? [previous.promise] : []), delivery,
        ]).then(results => {
            if (results.at(-1).status === 'rejected')
                throw results.at(-1).reason;
        });
        this._pendingPauses.set(owner, {busId, promise: pending});
        try {
            await pending;
        } finally {
            if (this._pendingPauses.get(owner)?.promise === pending)
                this._pendingPauses.delete(owner);
        }
    }

    async pause({pausePlaying = true} = {}) {
        if (this._started || this._closed || (!pausePlaying && !this._runtime.intent))
            return;
        this._started = true;
        try {
            this._cancellable.set_error_if_cancelled();
            this.claimRestoreIntent();
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
                    await this.pauseOwnedPlayer(bus, owner, this._busId);
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
        if (!resume) {
            this._resume = false;
            const intent = this._runtime.intent;
            if (intent?.[1] === this._epoch || (!this._started && !this._runtime.current)) {
                this._runtime.intent = null;
                global.set_runtime_state(PAUSED_MEDIA_STATE, null);
            }
            if (this._runtime.current === this)
                this._runtime.current = null;
        }
        if (this._closed)
            return this._restoration;
        this._closed = true;
        const connection = this._bus;
        this._bus = null;
        for (const signal of this._signals.splice(0))
            connection.signal_unsubscribe(signal);
        this._players.clear();
        this._invalidated.clear();
        const record = this._runtime.intent;
        if (!resume)
            return null;
        if (!record || (this._started && record[1] !== this._epoch) ||
            (this._runtime.current !== this && this._runtime.current && !this._runtime.current._closed)) {
            if (this._runtime.current === this)
                this._runtime.current = null;
            return null;
        }
        this._restoration = (async () => {
            try {
                const previous = this._runtime.current;
                if (previous && previous !== this) {
                    await previous._restoration;
                    if (!this._resume || (this._runtime.current && this._runtime.current !== this))
                        return;
                }
                if (!this._started) {
                    if (!this._runtime.intent || this._runtime.locked)
                        return;
                    this.claimRestoreIntent();
                }
                const current = this._runtime.intent;
                if (current?.[1] !== this._epoch)
                    return;
                if (!current[2].length) {
                    this._runtime.intent = null;
                    global.set_runtime_state(PAUSED_MEDIA_STATE, null);
                    return;
                }
                const bus = connection ?? Gio.DBus.session;
                const busId = this._busId ?? await new Promise((resolve, reject) => {
                    bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'GetId',
                        null, new GLib.VariantType('(s)'), Gio.DBusCallFlags.NONE, 2000, null, (source, result) => {
                            try {
                                resolve(source.call_finish(result).deep_unpack()[0]);
                            } catch (error) {
                                reject(error);
                            }
                        });
                });
                const verified = this._runtime.intent;
                if (verified?.[1] !== this._epoch || this._runtime.current !== this)
                    return;
                if (verified[0] !== busId) {
                    this._runtime.intent = null;
                    global.set_runtime_state(PAUSED_MEDIA_STATE, null);
                    return;
                }
                await Promise.all(verified[2].map(async owner => {
                    let compensated = false;
                    try {
                        const pending = this._pendingPauses.get(owner);
                        if (pending?.busId === busId)
                            await pending.promise.catch(() => null);
                        const status = await new Promise((resolve, reject) => {
                            bus.call(owner, MPRIS_PATH, 'org.freedesktop.DBus.Properties', 'Get',
                                new GLib.Variant('(ss)', [MPRIS_PLAYER, 'PlaybackStatus']), new GLib.VariantType('(v)'),
                                Gio.DBusCallFlags.NO_AUTO_START, 2000, null, (source, result) => {
                                    try {
                                        resolve(source.call_finish(result).deep_unpack()[0].deep_unpack());
                                    } catch (error) {
                                        reject(error);
                                    }
                                });
                        });
                        const intent = this._runtime.intent;
                        if (status !== 'Paused' || intent?.[1] !== this._epoch || intent[0] !== busId ||
                            this._runtime.locked)
                            return;
                        await new Promise((resolve, reject) => {
                            bus.call(owner, MPRIS_PATH, MPRIS_PLAYER, 'Play', null, null,
                                Gio.DBusCallFlags.NO_AUTO_START, 2000, null, (source, result) => {
                                    try {
                                        source.call_finish(result);
                                        resolve();
                                    } catch (error) {
                                        reject(error);
                                    }
                                });
                        });
                        if (this._runtime.locked || !this._resume) {
                            compensated = true;
                            this.retainCompensatedPlayer(owner, busId);
                            await this.pauseOwnedPlayer(bus, owner, busId);
                            this.retainCompensatedPlayer(owner, busId);
                        }
                    } catch (error) {
                        console.warn(`Stealth Lock: media resume failed for ${owner}: ${error.message}`);
                    } finally {
                        const intent = this._runtime.intent;
                        if (intent?.[1] === this._epoch && !this._runtime.locked && !compensated) {
                            const pending = intent[2].filter(player => player !== owner);
                            this._runtime.intent = pending.length ? [busId, this._epoch, pending] : null;
                            global.set_runtime_state(PAUSED_MEDIA_STATE, this._runtime.intent
                                ? new GLib.Variant('(ssas)', this._runtime.intent) : null);
                        }
                    }
                }));
            } catch (error) {
                console.warn(`Stealth Lock: media restoration unavailable: ${error.message}`);
            } finally {
                if (this._runtime.current === this)
                    this._runtime.current = null;
            }
        })();
        return this._restoration;
    }
}
