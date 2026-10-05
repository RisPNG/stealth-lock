import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {BackdropEffect} from './effects.js';
import {readEffectPresets, validateEffectConfig} from './presets.js';

const LOCK_CURSOR_XBM = {
    width: 28,
    height: 40,
    hotX: 14,
    hotY: 21,
    bits: new Uint8Array([
        0xff, 0xff, 0xff, 0xff, 0xff, 0x01, 0xf8, 0xff, 0x7f, 0x00, 0xe0, 0xff,
        0x3f, 0x00, 0xc0, 0xff, 0x1f, 0x00, 0x80, 0xff, 0x0f, 0xfc, 0x03, 0xff,
        0x0f, 0xfe, 0x07, 0xff, 0x0f, 0xff, 0x0f, 0xff, 0x07, 0xff, 0x0f, 0xfe,
        0x87, 0xff, 0x1f, 0xfe, 0x87, 0xff, 0x1f, 0xfe, 0x87, 0xff, 0x1f, 0xfe,
        0x87, 0xff, 0x1f, 0xfe, 0x87, 0xff, 0x1f, 0xfe, 0x87, 0xff, 0x1f, 0xfe,
        0x87, 0xff, 0x1f, 0xfe, 0x87, 0xff, 0x1f, 0xfe, 0x87, 0xff, 0x1f, 0xfe,
        0x87, 0xff, 0x1f, 0xfe, 0x01, 0x00, 0x00, 0xf8, 0x01, 0x00, 0x00, 0xf8,
        0x01, 0x00, 0x00, 0xf8, 0x01, 0x00, 0x00, 0xf8, 0x01, 0xf0, 0x00, 0xf8,
        0x01, 0xf8, 0x01, 0xf8, 0x01, 0xf8, 0x01, 0xf8, 0x01, 0xf8, 0x01, 0xf8,
        0x01, 0xf8, 0x01, 0xf8, 0x01, 0xf0, 0x00, 0xf8, 0x01, 0x60, 0x00, 0xf8,
        0x01, 0x60, 0x00, 0xf8, 0x01, 0x60, 0x00, 0xf8, 0x01, 0x60, 0x00, 0xf8,
        0x01, 0x60, 0x00, 0xf8, 0x01, 0x60, 0x00, 0xf8, 0x01, 0x00, 0x00, 0xf8,
        0x01, 0x00, 0x00, 0xf8, 0x01, 0x00, 0x00, 0xf8, 0x01, 0x00, 0x00, 0xf8,
        0xff, 0xff, 0xff, 0xff,
    ]),
    maskBits: new Uint8Array([
        0x00, 0xfe, 0x07, 0x00, 0x80, 0xff, 0x1f, 0x00, 0xc0, 0xff, 0x3f, 0x00,
        0xe0, 0xff, 0x7f, 0x00, 0xf0, 0xff, 0xff, 0x00, 0xf8, 0xff, 0xff, 0x01,
        0xf8, 0x03, 0xfc, 0x01, 0xf8, 0x01, 0xf8, 0x01, 0xfc, 0x01, 0xf8, 0x03,
        0xfc, 0x00, 0xf0, 0x03, 0xfc, 0x00, 0xf0, 0x03, 0xfc, 0x00, 0xf0, 0x03,
        0xfc, 0x00, 0xf0, 0x03, 0xfc, 0x00, 0xf0, 0x03, 0xfc, 0x00, 0xf0, 0x03,
        0xfc, 0x00, 0xf0, 0x03, 0xfc, 0x00, 0xf0, 0x03, 0xfc, 0x00, 0xf0, 0x03,
        0xff, 0xff, 0xff, 0x0f, 0xff, 0xff, 0xff, 0x0f, 0xff, 0xff, 0xff, 0x0f,
        0xff, 0xff, 0xff, 0x0f, 0xff, 0xff, 0xff, 0x0f, 0xff, 0xff, 0xff, 0x0f,
        0xff, 0xff, 0xff, 0x0f, 0xff, 0xff, 0xff, 0x0f, 0xff, 0xff, 0xff, 0x0f,
        0xff, 0xff, 0xff, 0x0f, 0xff, 0xff, 0xff, 0x0f, 0xff, 0xff, 0xff, 0x0f,
        0xff, 0xff, 0xff, 0x0f, 0xff, 0xff, 0xff, 0x0f, 0xff, 0xff, 0xff, 0x0f,
        0xff, 0xff, 0xff, 0x0f, 0xff, 0xff, 0xff, 0x0f, 0xff, 0xff, 0xff, 0x0f,
        0xff, 0xff, 0xff, 0x0f, 0xff, 0xff, 0xff, 0x0f, 0xff, 0xff, 0xff, 0x0f,
        0xff, 0xff, 0xff, 0x0f,
    ]),
};

export class LockOverlay {
    constructor(settings, input, cancellable) {
        this.settings = settings;
        this.input = input;
        this.effect = null;
        [this.pointerX, this.pointerY] = global.get_pointer();
        this.monitors = Main.layoutManager.monitors.map(monitor => ({...monitor}));
        this.originX = Math.min(...this.monitors.map(monitor => monitor.x));
        this.originY = Math.min(...this.monitors.map(monitor => monitor.y));
        this.width = Math.max(...this.monitors.map(monitor => monitor.x + monitor.width)) - this.originX;
        this.height = Math.max(...this.monitors.map(monitor => monitor.y + monitor.height)) - this.originY;
        this.actor = new St.Widget({
            name: 'stealthLockOverlay',
            reactive: true,
            can_focus: true,
            x: this.originX,
            y: this.originY,
            width: this.width,
            height: this.height,
        });
        try {
            this.background = new St.Widget({width: this.width, height: this.height});
            this.backdrop = new St.Widget({width: this.width, height: this.height});
            this.actor.add_child(this.background);
            this.actor.add_child(this.backdrop);
            this.prompt = new St.BoxLayout({style_class: 'stealth-lock-prompt', vertical: true});
            this.actor.add_child(this.prompt);
            this.prompt.add_child(input.actor);
            this.prompt.visible = settings.get_string('lock-type') === 'normal';
            if (!this.prompt.visible) {
                this.prompt.remove_child(input.actor);
                this.actor.add_child(input.actor);
            }
            this.status = new St.Label({style_class: 'stealth-lock-status'});
            this.status.clutter_text.line_wrap = true;
            this.status.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            this.status.visible = false;
            this.prompt.add_child(this.status);
            this.info = new St.Label({style_class: 'stealth-lock-info', x: 12, y: 12});
            this.actor.add_child(this.info);
            this.info.visible = settings.get_boolean('debug-mode') && settings.get_boolean('debug-show-info');
            this.refreshStyle();

            this.cursor = null;
            this.cursorHotX = 0;
            this.cursorHotY = 0;
            if (settings.get_string('cursor-mode') === 'lock-icon') {
                const height = Meta.prefs_get_cursor_size();
                const width = Math.max(1, Math.round(LOCK_CURSOR_XBM.width * height / LOCK_CURSOR_XBM.height));
                this.cursor = new St.Widget({width, height, reactive: false});
                this.cursorHotX = Math.round(LOCK_CURSOR_XBM.hotX * width / LOCK_CURSOR_XBM.width);
                this.cursorHotY = Math.round(LOCK_CURSOR_XBM.hotY * height / LOCK_CURSOR_XBM.height);
                const foreground = settings.get_value('cursor-fg-rgba').deep_unpack();
                const background = settings.get_value('cursor-bg-rgba').deep_unpack();
                const rgba = new Uint8Array(width * height * 4);
                const bytesPerRow = Math.ceil(LOCK_CURSOR_XBM.width / 8);
                for (let y = 0; y < height; y++) {
                    const sourceY = Math.floor(y * LOCK_CURSOR_XBM.height / height);
                    for (let x = 0; x < width; x++) {
                        const sourceX = Math.floor(x * LOCK_CURSOR_XBM.width / width);
                        const byte = sourceY * bytesPerRow + (sourceX >> 3);
                        const bit = sourceX & 7;
                        if ((LOCK_CURSOR_XBM.maskBits[byte] >> bit) & 1)
                            rgba.set((LOCK_CURSOR_XBM.bits[byte] >> bit) & 1 ? foreground : background, (y * width + x) * 4);
                    }
                }
                const image = St.ImageContent.new_with_preferred_size(width, height);
                const upload = [rgba, Cogl.PixelFormat.RGBA_8888, width, height, width * 4];
                // Shell 48 moved image uploads from Clutter.Image to St and requires its Cogl context.
                if (!Clutter.Image)
                    upload.unshift(global.stage.context.get_backend().get_cogl_context());
                image.set_data(...upload);
                this.cursor.set_content(image);
                this.actor.add_child(this.cursor);
                const bitmap = settings.get_string('cursor-bitmap-path').trim();
                if (bitmap)
                    this.loadCursorImage(Gio.File.new_for_commandline_arg(bitmap), cancellable);
            }
            this.movePointer(this.pointerX, this.pointerY);
        } catch (error) {
            input.actor.get_parent()?.remove_child(input.actor);
            this.actor.destroy();
            throw error;
        }
    }

    async loadCursorImage(file, cancellable) {
        let stream;
        try {
            stream = await new Promise((resolve, reject) => {
                file.read_async(GLib.PRIORITY_DEFAULT, cancellable, (source, result) => {
                    try {
                        resolve(source.read_finish(result));
                    } catch (error) {
                        reject(error);
                    }
                });
            });
            cancellable.set_error_if_cancelled();
            const size = this.cursor.height;
            const pixbuf = await new Promise((resolve, reject) => {
                GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(stream, size, size, true, cancellable, (_source, result) => {
                    try {
                        resolve(GdkPixbuf.Pixbuf.new_from_stream_finish(result));
                    } catch (error) {
                        reject(error);
                    }
                });
            });
            cancellable.set_error_if_cancelled();
            const width = pixbuf.get_width();
            const height = pixbuf.get_height();
            const image = St.ImageContent.new_with_preferred_size(width, height);
            const upload = [pixbuf.get_pixels(), pixbuf.get_has_alpha() ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
                width, height, pixbuf.get_rowstride()];
            if (!Clutter.Image)
                upload.unshift(global.stage.context.get_backend().get_cogl_context());
            image.set_data(...upload);
            this.cursor.set_content(image);
            this.cursor.set_content_gravity(Clutter.ContentGravity.RESIZE_ASPECT);
            this.cursor.set_size(size, size);
            this.cursorHotX = Math.round(size / 2);
            this.cursorHotY = Math.round(size / 2);
            this.movePointer(this.pointerX, this.pointerY);
        } catch (error) {
            if (!cancellable.is_cancelled())
                console.debug(`Stealth Lock: cursor image is unavailable: ${error.message}`);
        } finally {
            if (stream) {
                await new Promise(resolve => {
                    stream.close_async(GLib.PRIORITY_DEFAULT, null, (source, result) => {
                        try {
                            source.close_finish(result);
                        } catch (error) {
                            console.debug(`Stealth Lock: cursor image stream close failed: ${error.message}`);
                        }
                        resolve();
                    });
                });
            }
        }
    }

    setStatus(message) {
        this.status.text = message;
        this.status.visible = this.prompt.visible && message !== '';
        this.info.text = message;
        this.positionPrompt();
    }

    refreshEffect() {
        this.effect?.destroy();
        this.effect = null;
        const active = this.settings.get_string('visual-effect-active');
        if (!active)
            return;
        try {
            const entry = readEffectPresets(this.settings).find(preset => preset.name === active);
            if (!entry)
                return;
            this.effect = new BackdropEffect({
                parent: this.actor,
                width: this.width,
                height: this.height,
                monitors: this.monitors,
                primaryMonitor: Main.layoutManager.primaryMonitor,
                originX: this.originX,
                originY: this.originY,
                promptMonitor: this.settings.get_string('normal-prompt-monitor'),
            }, validateEffectConfig(entry.code));
            this.actor.set_child_above_sibling(this.effect.layer, this.background);
        } catch (error) {
            console.debug(`Stealth Lock: visual effect is unavailable: ${error.message}`);
        }
    }

    refreshStyle() {
        this.prompt.style = this.settings.get_string('normal-prompt-css');
        this.backdrop.style = this.settings.get_string('normal-background-css');
        this.positionPrompt();
    }

    movePointer(stageX, stageY) {
        this.pointerX = stageX;
        this.pointerY = stageY;
        if (this.cursor)
            this.cursor.set_position(stageX - this.originX - this.cursorHotX, stageY - this.originY - this.cursorHotY);
        if (this.settings.get_boolean('normal-prompt-follow-cursor'))
            this.positionPrompt();
    }

    positionPrompt() {
        if (!this.actor.get_stage() || !this.prompt.visible)
            return;
        const [, width] = this.prompt.get_preferred_width(-1);
        const [, height] = this.prompt.get_preferred_height(width);
        const follow = this.settings.get_boolean('normal-prompt-follow-cursor');
        let bounds = {x: this.originX, y: this.originY, width: this.width, height: this.height};
        let x;
        let y;
        if (follow) {
            bounds = this.monitors.find(monitor => this.pointerX >= monitor.x && this.pointerX < monitor.x + monitor.width &&
                this.pointerY >= monitor.y && this.pointerY < monitor.y + monitor.height) ?? Main.layoutManager.primaryMonitor;
            const anchor = this.settings.get_string('normal-prompt-cursor-anchor');
            const offsetX = this.settings.get_int('normal-prompt-offset-x');
            const offsetY = this.settings.get_int('normal-prompt-offset-y');
            x = this.pointerX + (anchor.endsWith('l') ? -width - offsetX : offsetX);
            y = this.pointerY + (anchor.startsWith('t') ? -height - offsetY : offsetY);
        } else {
            const monitor = this.settings.get_string('normal-prompt-monitor');
            if (monitor !== '' && this.monitors[Number(monitor)])
                bounds = this.monitors[Number(monitor)];
            const fixedX = this.settings.get_int('normal-prompt-fixed-x');
            const fixedY = this.settings.get_int('normal-prompt-fixed-y');
            x = fixedX < 0 ? bounds.x + (bounds.width - width) / 2 : this.originX + fixedX;
            y = fixedY < 0 ? bounds.y + (bounds.height - height) / 2 : this.originY + fixedY;
        }
        x = Math.max(bounds.x, Math.min(x, bounds.x + Math.max(0, bounds.width - width)));
        y = Math.max(bounds.y, Math.min(y, bounds.y + Math.max(0, bounds.height - height)));
        if (!this.monitors.some(monitor => x >= monitor.x && y >= monitor.y &&
            x + width <= monitor.x + monitor.width && y + height <= monitor.y + monitor.height)) {
            const monitor = Main.layoutManager.primaryMonitor;
            x = Math.max(monitor.x, Math.min(x, monitor.x + Math.max(0, monitor.width - width)));
            y = Math.max(monitor.y, Math.min(y, monitor.y + Math.max(0, monitor.height - height)));
        }
        this.prompt.set_position(Math.round(x - this.originX), Math.round(y - this.originY));
    }

    destroy() {
        this.effect?.destroy();
        this.effect = null;
        this.input.actor.get_parent()?.remove_child(this.input.actor);
        this.background.set_content(null);
        // Clutter retains queued actors until layout completes, even after destruction.
        this.actor.get_allocation_box();
        this.actor.destroy();
    }
}
