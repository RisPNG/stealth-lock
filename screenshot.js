import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

const SCREENSHOT_TIMEOUT_MS = 3000;

export async function captureScreenshot(cancellable) {
    cancellable.set_error_if_cancelled();

    let cancelledId = 0;
    let timeoutId = 0;
    try {
        const screenshot = await new Promise((resolve, reject) => {
            cancelledId = cancellable.connect(() => {
                reject(new GLib.Error(
                    Gio.io_error_quark(),
                    Gio.IOErrorEnum.CANCELLED,
                    'Screenshot capture cancelled'
                ));
            });
            if (cancellable.is_cancelled())
                return;

            timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SCREENSHOT_TIMEOUT_MS, () => {
                timeoutId = 0;
                reject(new GLib.Error(
                    Gio.io_error_quark(),
                    Gio.IOErrorEnum.TIMED_OUT,
                    'Screenshot capture timed out'
                ));
                return GLib.SOURCE_REMOVE;
            });
            const shooter = new Shell.Screenshot();
            shooter.screenshot_stage_to_content((source, result) => {
                try {
                    const [content, scale] = source.screenshot_stage_to_content_finish(result);
                    cancellable.set_error_if_cancelled();
                    resolve({content, scale});
                } catch (error) {
                    reject(error);
                }
            });
        });

        cancellable.set_error_if_cancelled();
        return screenshot;
    } finally {
        if (timeoutId)
            GLib.Source.remove(timeoutId);
        if (cancelledId)
            cancellable.disconnect(cancelledId);
    }
}
