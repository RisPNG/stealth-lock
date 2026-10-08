// Test-only helper extension for the private headless GNOME Shell harness (tests/shell).
// Run-shell.sh copies it into the private XDG_DATA_HOME. It exposes org.stealthlock.Harness on the (private)
// session bus of the shell it runs in.
/* eslint-disable no-unused-vars -- the imports below are the scope of the scripts passed to Eval */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import System from 'system';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const BUS_NAME = 'org.stealthlock.Harness';
const OBJECT_PATH = '/org/stealthlock/Harness';

const IFACE_XML = `
<node>
  <interface name="org.stealthlock.Harness">
    <method name="Ping"><arg type="s" direction="out"/></method>
    <method name="Eval">
      <arg type="s" name="script" direction="in"/>
      <arg type="b" name="ok" direction="out"/>
      <arg type="s" name="json" direction="out"/>
    </method>
    <method name="Key">
      <arg type="s" name="name" direction="in"/>
      <arg type="b" name="pressed" direction="in"/>
    </method>
    <method name="KeySym">
      <arg type="u" name="keyval" direction="in"/>
      <arg type="b" name="pressed" direction="in"/>
    </method>
    <method name="KeyCode">
      <arg type="u" name="evdev" direction="in"/>
      <arg type="b" name="pressed" direction="in"/>
    </method>
    <method name="Motion">
      <arg type="d" name="x" direction="in"/>
      <arg type="d" name="y" direction="in"/>
    </method>
    <method name="Button">
      <arg type="u" name="button" direction="in"/>
      <arg type="b" name="pressed" direction="in"/>
    </method>
  </interface>
</node>`;

function replacer(_key, value) {
    if (typeof value === 'bigint')
        return Number(value);
    if (typeof value === 'function')
        return `[function ${value.name}]`;
    if (value instanceof Error)
        return {error: value.message, stack: value.stack};
    if (value instanceof GObject.Object)
        return `[${value.constructor.name}]`;
    return value;
}

export default class HarnessHelper extends Extension {
    enable() {
        const seat = (global.stage.context?.get_backend() ?? Clutter.get_default_backend()).get_default_seat();
        this._keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        this._pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);

        this._exported = Gio.DBusExportedObject.wrapJSObject(IFACE_XML, this);
        this._exported.export(Gio.DBus.session, OBJECT_PATH);
        this._ownerId = Gio.bus_own_name_on_connection(
            Gio.DBus.session, BUS_NAME, Gio.BusNameOwnerFlags.NONE, null, null);
    }

    disable() {
        if (this._ownerId) {
            Gio.bus_unown_name(this._ownerId);
            this._ownerId = 0;
        }
        this._exported?.unexport();
        this._exported = null;
        this._keyboard?.run_dispose?.();
        this._pointer?.run_dispose?.();
        this._keyboard = null;
        this._pointer = null;
    }

    Ping() {
        return `pong ${GLib.get_monotonic_time()}`;
    }

    // Direct eval so the module-scope imports (Main, Meta, Clutter, St, Shell, Gio, GLib) are visible.
    EvalAsync(params, invocation) {
        const [script] = params;
        (async () => {
            try {
                const result = await eval(script); // eslint-disable-line no-eval
                const json = JSON.stringify(result === undefined ? null : result, replacer);
                invocation.return_value(new GLib.Variant('(bs)', [true, json ?? 'null']));
            } catch (e) {
                const json = JSON.stringify({error: String(e?.message ?? e), stack: e?.stack ?? ''});
                invocation.return_value(new GLib.Variant('(bs)', [false, json]));
            }
        })();
    }

    // name: an X11 keysym name as in Clutter.KEY_* (Return, Super_L, BackSpace, ...) or a single character.
    Key(name, pressed) {
        const keyval = [...name].length === 1
            ? Clutter.unicode_to_keysym(name.codePointAt(0))
            : Clutter[`KEY_${name}`];
        if (!keyval)
            throw new Error(`unknown key name: ${name}`);
        this.KeySym(keyval, pressed);
    }

    KeySym(keyval, pressed) {
        this._keyboard.notify_keyval(Clutter.CURRENT_TIME, keyval,
            pressed ? Clutter.KeyState.PRESSED : Clutter.KeyState.RELEASED);
    }

    KeyCode(evdev, pressed) {
        this._keyboard.notify_key(Clutter.CURRENT_TIME, evdev,
            pressed ? Clutter.KeyState.PRESSED : Clutter.KeyState.RELEASED);
    }

    Motion(x, y) {
        this._pointer.notify_absolute_motion(Clutter.CURRENT_TIME, x, y);
    }

    Button(button, pressed) {
        this._pointer.notify_button(Clutter.CURRENT_TIME, button,
            pressed ? Clutter.ButtonState.PRESSED : Clutter.ButtonState.RELEASED);
    }
}
