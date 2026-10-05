import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export function assert(condition, message = 'assertion failed') {
    if (!condition)
        throw new Error(message);
}

export function equal(actual, expected, message = 'values differ') {
    if (!Object.is(actual, expected))
        throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

export function delay(milliseconds) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

export async function waitFor(predicate, message, timeoutMs = 5000) {
    const deadline = GLib.get_monotonic_time() + timeoutMs * 1000;
    while (!predicate()) {
        if (GLib.get_monotonic_time() >= deadline)
            throw new Error(`timed out: ${message}`);
        await delay(20);
    }
}

export function setAuthControl(control = {}) {
    const file = Gio.File.new_for_path(`${GLib.getenv('SLH_ROOT')}/run/auth-control.json`);
    file.replace_contents(JSON.stringify(control), null, false, Gio.FileCreateFlags.PRIVATE, null);
}
