import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export class VisualProcess {
    constructor(path, parent = null) {
        parent?.set_error_if_cancelled();
        this.parent = parent;
        this.parentSignal = 0;
        this.parentDisconnect = 0;
        this.cancellable = new Gio.Cancellable();
        this.busy = false;
        this.closed = false;
        this.deadline = 0;
        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
        });
        launcher.set_environ([]);
        const argv = [
            '/usr/bin/python3', '-I', GLib.build_filenamev([path, 'helpers', 'visual-renderer.py']),
            '--scope', path, String(new Gio.Credentials().get_unix_pid()),
        ];
        try {
            this.process = launcher.spawnv(argv);
        } finally {
            launcher.close();
        }
        this.process.wait_async(null, (process, result) => {
            try {
                process.wait_finish(result);
            } catch (error) {
                console.debug(`Stealth Lock: visual process cleanup failed: ${error.message}`);
            }
        });
        if (parent) {
            this.parentSignal = parent.connect(() => {
                if (!this.parentDisconnect) {
                    this.parentDisconnect = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                        this.parentDisconnect = 0;
                        if (this.parentSignal) {
                            parent.disconnect(this.parentSignal);
                            this.parentSignal = 0;
                        }
                        this.parent = null;
                        return GLib.SOURCE_REMOVE;
                    });
                }
                this.destroy();
            });
        }
    }

    async request(frame) {
        if (this.closed || this.busy)
            throw new Error('Visual process is unavailable');
        this.busy = true;
        this.deadline = GLib.timeout_add(GLib.PRIORITY_DEFAULT, frame.event === 'init' || frame.event === 'check' ? 2000 : 1000, () => {
            this.deadline = 0;
            this.destroy();
            return GLib.SOURCE_REMOVE;
        });
        try {
            const data = new TextEncoder().encode(JSON.stringify(frame) + '\n');
            await new Promise((resolve, reject) => {
                this.process.get_stdin_pipe().write_all_async(data, GLib.PRIORITY_DEFAULT, this.cancellable, (stream, result) => {
                    try {
                        stream.write_all_finish(result);
                        resolve();
                    } catch (error) {
                        reject(error);
                    }
                });
            });
            const chunks = [];
            let length = 0;
            while (true) {
                const bytes = await new Promise((resolve, reject) => {
                    this.process.get_stdout_pipe().read_bytes_async(4096, GLib.PRIORITY_DEFAULT, this.cancellable, (stream, result) => {
                        try {
                            resolve(stream.read_bytes_finish(result).get_data());
                        } catch (error) {
                            reject(error);
                        }
                    });
                });
                if (!bytes.length)
                    throw new Error('Visual program exited before completing its frame');
                length += bytes.length;
                if (length > 262145)
                    throw new Error('Visual program exceeded the frame size limit');
                chunks.push(bytes);
                const newline = bytes.indexOf(10);
                if (newline < 0)
                    continue;
                if (newline !== bytes.length - 1)
                    throw new Error('Visual program returned unexpected data');
                const response = new Uint8Array(length);
                let offset = 0;
                for (const chunk of chunks) {
                    response.set(chunk, offset);
                    offset += chunk.length;
                }
                const frameResult = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(response));
                if (frameResult.error)
                    throw new Error('Visual program could not be processed');
                return frameResult;
            }
        } catch (error) {
            this.destroy();
            throw error;
        } finally {
            if (this.deadline) {
                GLib.Source.remove(this.deadline);
                this.deadline = 0;
            }
            this.busy = false;
        }
    }

    destroy() {
        if (this.closed)
            return;
        this.closed = true;
        if (this.parentSignal && !this.parentDisconnect) {
            this.parent.disconnect(this.parentSignal);
            this.parentSignal = 0;
            this.parent = null;
        }
        if (this.deadline) {
            GLib.Source.remove(this.deadline);
            this.deadline = 0;
        }
        this.cancellable.cancel();
        this.process.force_exit();
    }
}

if (Array.isArray(globalThis.ARGV)) {
    const System = await import('system');
    if (Gio.File.new_for_path(System.programInvocationName).get_uri() === import.meta.url) {
        if (System.programArgs.length !== 1)
            throw new Error('Usage: gjs -m shared/visual-process.js <extension-directory>');
        const process = new VisualProcess(System.programArgs[0]);
        try {
            const response = await process.request({event: 'check', code: 'return;'});
            if (!response.valid)
                throw new Error('The isolated visual renderer is unavailable');
        } finally {
            process.destroy();
        }
    }
}
