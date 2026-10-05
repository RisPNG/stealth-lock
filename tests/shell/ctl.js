/* global ARGV, print, printerr */
// Client for the harness helper extension, run with: gjs -m ctl.js <command> ...
// Always connects to the PRIVATE bus address given in HARNESS_BUS (set by eval.sh/keys.sh/motion.sh after
// verification); it never calls Gio.DBus.session / Gio.DBus.system.
//
//   ctl.js eval [-b] [-t SECONDS] <js>     evaluate js in the shell, print the JSON result (exit 1 on error)
//                                          -b: <js> is a function body (use `return`; `await` allowed)
//   ctl.js keys [-d MS] <token>...         inject keys; token: Mod+Mod+key chord, text:<string>, sleep:<ms>,
//                                          code:<evdev>  (press+release a raw evdev keycode)
//   ctl.js motion <x> <y>                  absolute pointer motion
//   ctl.js ping                            round trip to the helper
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

const NAME = 'org.stealthlock.Harness';
const PATH = '/org/stealthlock/Harness';
const IFACE = 'org.stealthlock.Harness';
const ALIASES = {
    Super: 'Super_L',
    Ctrl: 'Control_L',
    Control: 'Control_L',
    Alt: 'Alt_L',
    Shift: 'Shift_L',
    Enter: 'Return',
    Esc: 'Escape',
    Backspace: 'BackSpace',
};

const address = GLib.getenv('HARNESS_BUS');
if (!address || !address.startsWith('unix:path='))
    throw new Error('HARNESS_BUS must be the verified private bus address');

const connection = Gio.DBusConnection.new_for_address_sync(
    address,
    Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
    null, null);

function call(method, params, replyType, timeoutMs = 10000) {
    return connection.call_sync(NAME, PATH, IFACE, method, params,
        replyType ? new GLib.VariantType(replyType) : null, Gio.DBusCallFlags.NONE, timeoutMs, null);
}

function sleep(ms) {
    const loop = new GLib.MainLoop(null, false);
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        loop.quit();
        return GLib.SOURCE_REMOVE;
    });
    loop.run();
}

function key(name, pressed) {
    return call('Key', new GLib.Variant('(sb)', [name, pressed]), '()');
}

function chord(token, delayMs) {
    // a lone "+" token (the plus key itself) splits into empty parts
    const parts = token.length > 1 ? token.split('+') : [token];
    const names = [];
    for (let i = 0; i < parts.length; i++) {
        if (parts[i] === '' && parts[i + 1] === '') {
            names.push('+');
            i++;
        } else if (parts[i] !== '') {
            names.push(parts[i]);
        }
    }
    const resolved = names.map(name => ALIASES[name] ?? name);

    for (const name of resolved) {
        key(name, true);
        sleep(delayMs);
    }
    for (const name of resolved.reverse()) {
        key(name, false);
        sleep(delayMs);
    }
}

const [command, ...args] = ARGV;
try {
    if (command === 'eval') {
        let body = false;
        let timeout = 10;
        while (args[0]?.startsWith('-')) {
            const flag = args.shift();
            if (flag === '-b')
                body = true;
            else if (flag === '-t')
                timeout = Number(args.shift());
            else
                throw new Error(`unknown flag ${flag}`);
        }
        let script = args.join(' ');
        if (body)
            script = `(async () => {\n${script}\n})()`;
        const reply = call('Eval', new GLib.Variant('(s)', [script]), '(bs)', timeout * 1000);
        const [ok, json] = reply.deepUnpack();
        if (ok)
            print(json);
        else
            printerr(json);
        System.exit(ok ? 0 : 1);
    } else if (command === 'keys') {
        let delay = 40;
        while (args[0]?.startsWith('-') && args[0].length === 2) {
            const flag = args.shift();
            if (flag === '-d')
                delay = Number(args.shift());
            else
                throw new Error(`unknown flag ${flag}`);
        }
        for (const token of args) {
            if (token.startsWith('text:')) {
                for (const character of token.slice(5)) {
                    key(character, true);
                    sleep(delay);
                    key(character, false);
                    sleep(delay);
                }
            } else if (token.startsWith('sleep:')) {
                sleep(Number(token.slice(6)));
            } else if (token.startsWith('code:')) {
                const code = Number(token.slice(5));
                call('KeyCode', new GLib.Variant('(ub)', [code, true]), '()');
                sleep(delay);
                call('KeyCode', new GLib.Variant('(ub)', [code, false]), '()');
                sleep(delay);
            } else {
                chord(token, delay);
            }
        }
        sleep(delay);
    } else if (command === 'motion') {
        call('Motion', new GLib.Variant('(dd)', [Number(args[0]), Number(args[1])]), '()');
    } else if (command === 'ping') {
        print(call('Ping', null, '(s)').deepUnpack()[0]);
    } else {
        throw new Error('usage: ctl.js eval|keys|motion|ping ...');
    }
} catch (e) {
    printerr(`harness ctl: ${e.message}`);
    System.exit(2);
}
