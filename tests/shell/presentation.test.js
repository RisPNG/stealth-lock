import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {assert, delay, equal, waitFor} from './support.js';

async function protect(extension) {
    extension.lock();
    await waitFor(() => extension._session?._ready, 'Presentation ready');
    await delay(60);
    return extension._session._overlay;
}

export const tests = {
    async 'fixed and cursor-relative prompts stay wholly inside native monitors'({extension, settings}) {
        settings.set_string('lock-type', 'normal');
        const overlay = await protect(extension);
        equal(overlay.width, 2080, 'Native monitor union width');
        equal(overlay.height, 720, 'Native monitor union height');
        settings.set_string('normal-prompt-monitor', '1');
        overlay.positionPrompt();
        assert(overlay.prompt.x >= 1280, 'Selected second native monitor');
        settings.set_boolean('normal-prompt-follow-cursor', true);
        for (const anchor of ['tl', 'tr', 'bl', 'br']) {
            settings.set_string('normal-prompt-cursor-anchor', anchor);
            for (const monitor of Main.layoutManager.monitors) {
                overlay.movePointer(monitor.x + monitor.width - 1, monitor.y + monitor.height - 1);
                const [, width] = overlay.prompt.get_preferred_width(-1);
                const [, height] = overlay.prompt.get_preferred_height(width);
                assert(overlay.prompt.x + overlay.originX >= monitor.x && overlay.prompt.y + overlay.originY >= monitor.y,
                    `${anchor}: leading edges inside monitor`);
                assert(overlay.prompt.x + overlay.originX + width <= monitor.x + monitor.width &&
                    overlay.prompt.y + overlay.originY + height <= monitor.y + monitor.height, `${anchor}: trailing edges inside monitor`);
            }
        }
        settings.set_boolean('normal-prompt-follow-cursor', false);
        settings.set_string('normal-prompt-monitor', '');
        settings.set_int('normal-prompt-fixed-x', 30000);
        settings.set_int('normal-prompt-fixed-y', 700);
        overlay.positionPrompt();
        assert(overlay.prompt.x < 1280, 'Gap in monitor union falls back to visible primary monitor');
    },

    async 'valid native bitmap paths and URIs replace the exact built-in cursor; missing and corrupt fall back'({extension, settings}) {
        settings.set_string('cursor-mode', 'lock-icon');
        const directory = Gio.File.new_for_path(`${GLib.getenv('SLH_ROOT')}/run`);
        const bitmap = directory.get_child('cursor.png');
        const corrupt = directory.get_child('corrupt.png');
        const pixbuf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, true, 8, 16, 16);
        pixbuf.fill(0x8090a0ff);
        pixbuf.savev(bitmap.get_path(), 'png', [], []);
        corrupt.replace_contents('invalid image bytes', null, false, Gio.FileCreateFlags.PRIVATE, null);
        for (const location of [bitmap.get_path(), bitmap.get_uri()]) {
            settings.set_string('cursor-bitmap-path', location);
            const overlay = await protect(extension);
            await waitFor(() => overlay.cursor.width === overlay.cursor.height, 'Custom bitmap decodes');
            assert(overlay.cursor.get_content(), 'Native image content uploaded');
            equal(overlay.cursorHotX, Math.round(overlay.cursor.width / 2), 'Custom horizontal hotspot');
            equal(overlay.cursorHotY, Math.round(overlay.cursor.height / 2), 'Custom vertical hotspot');
            extension._session.close();
        }
        for (const location of [directory.get_child('missing.png').get_path(), corrupt.get_path()]) {
            settings.set_string('cursor-bitmap-path', location);
            const overlay = await protect(extension);
            await delay(100);
            const height = Meta.prefs_get_cursor_size();
            const width = Math.max(1, Math.round(height * 28 / 40));
            equal(overlay.cursor.width, width, 'Fallback retains native bitmap ratio');
            equal(overlay.cursor.height, height, 'Fallback retains native cursor size');
            equal(overlay.cursorHotX, Math.round(14 * width / 28), 'Fallback horizontal hotspot');
            equal(overlay.cursorHotY, Math.round(21 * height / 40), 'Fallback vertical hotspot');
            extension._session.close();
        }
    },

    async 'native theme variants reload live and custom CSS updates the existing prompt'({extension, settings}) {
        settings.set_string('lock-type', 'normal');
        const desktop = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        const scheme = desktop.get_string('color-scheme');
        const overlay = await protect(extension);
        try {
            desktop.set_string('color-scheme', 'prefer-dark');
            await waitFor(() => overlay.prompt.get_theme_node().get_background_color().red === 45, 'Native dark stylesheet applied');
            desktop.set_string('color-scheme', 'prefer-light');
            await waitFor(() => overlay.prompt.get_theme_node().get_background_color().red === 255, 'Native light stylesheet reload applied');
            settings.set_string('normal-prompt-css', 'padding: 31px;');
            await delay(60);
            equal(overlay.prompt.style, 'padding: 31px;', 'Custom CSS applies to same actor');
            settings.set_string('normal-background-css', 'opacity: 0.4;');
            equal(overlay.backdrop.style, 'opacity: 0.4;', 'Background declaration updates live');
        } finally {
            desktop.set_string('color-scheme', scheme);
        }
    },

    async 'legacy executable style text is retained without executing in Shell'({extension, settings}) {
        const code = 'global.stealthLockLegacyExecuted = true;';
        settings.set_string('normal-prompt-custom-js', code);
        settings.set_string('normal-prompt-custom-js-saved-entries', JSON.stringify([{name: 'retained', code}]));
        await protect(extension);
        equal(global.stealthLockLegacyExecuted, undefined, 'Legacy code never executed');
        equal(settings.get_string('normal-prompt-custom-js'), code, 'Legacy source retained');
    },
};
