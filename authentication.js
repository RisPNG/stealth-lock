import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const AUTH_TIMEOUT_MS = 10000;
const RETRY_BASE_MS = 1000;
const RETRY_LIMIT_MS = 30000;

export class Authentication {
    constructor(path, cancellable) {
        this._helperPath = GLib.build_filenamev([path, 'authentication.py']);
        this._cancellable = cancellable;
        this.busy = false;
        this._failures = 0;
        this.retryUntil = 0;
    }

    async verify(password) {
        if (this.busy || this._cancellable.is_cancelled() ||
            GLib.get_monotonic_time() / 1000 < this.retryUntil ||
            typeof password !== 'string' || !password || /[\n\r\0]/u.test(password))
            return false;

        this.busy = true;
        let process = null;
        let timeoutId = 0;
        let cancelledId = 0;
        let timedOut = false;
        let success = false;

        try {
            process = Gio.Subprocess.new(
                ['/usr/bin/python3', '-I', '-B', this._helperPath],
                Gio.SubprocessFlags.STDIN_PIPE |
                Gio.SubprocessFlags.STDOUT_SILENCE |
                Gio.SubprocessFlags.STDERR_SILENCE
            );
            cancelledId = this._cancellable.connect(() => process.force_exit());

            if (this._cancellable.is_cancelled()) {
                process.force_exit();
                return false;
            }

            timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, AUTH_TIMEOUT_MS, () => {
                timeoutId = 0;
                timedOut = true;
                process.force_exit();
                return GLib.SOURCE_REMOVE;
            });

            const communicated = await new Promise((resolve, reject) => {
                process.communicate_utf8_async(password, this._cancellable, (source, result) => {
                    try {
                        const [finished] = source.communicate_utf8_finish(result);
                        resolve(finished);
                    } catch (error) {
                        reject(error);
                    }
                });
            });
            if (this._cancellable.is_cancelled())
                return false;

            success = communicated && !timedOut && process.get_successful();
        } catch {
            process?.force_exit();
        } finally {
            if (timeoutId)
                GLib.source_remove(timeoutId);
            if (cancelledId)
                this._cancellable.disconnect(cancelledId);
            this.busy = false;
        }

        if (success) {
            this._failures = 0;
            this.retryUntil = 0;
        } else if (!this._cancellable.is_cancelled()) {
            this._failures = Math.min(this._failures + 1, 6);
            this.retryUntil = GLib.get_monotonic_time() / 1000 +
                Math.min(RETRY_BASE_MS * 2 ** (this._failures - 1), RETRY_LIMIT_MS);
        }

        return success;
    }
}
