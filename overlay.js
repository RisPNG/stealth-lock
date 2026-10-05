import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class LockOverlay {
    constructor(settings, input) {
        this.settings = settings;
        this.input = input;
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
            this.prompt = new St.BoxLayout({style_class: 'stealth-lock-prompt'});
            this.actor.add_child(this.prompt);
            this.prompt.add_child(input.actor);
            this.prompt.visible = settings.get_string('lock-type') === 'normal';
            if (!this.prompt.visible) {
                this.prompt.remove_child(input.actor);
                this.actor.add_child(input.actor);
            }
            this.info = new St.Label({style_class: 'stealth-lock-info', x: 12, y: 12});
            this.actor.add_child(this.info);
            this.info.visible = settings.get_boolean('debug-mode') && settings.get_boolean('debug-show-info');
            const interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
            this.actor.add_style_class_name(interfaceSettings.get_string('color-scheme') === 'prefer-dark' ? 'dark' : 'light');
            this.refreshStyle();

            this.cursor = null;
            this.cursorHotX = 0;
            this.cursorHotY = 0;
            if (settings.get_string('cursor-mode') === 'lock-icon') {
                const size = Meta.prefs_get_cursor_size();
                const bitmap = settings.get_string('cursor-bitmap-path');
                if (bitmap) {
                    const file = Gio.File.new_for_commandline_arg(bitmap);
                    this.cursor = new St.Icon({gicon: new Gio.FileIcon({file}), icon_size: size});
                    this.cursorHotX = size / 2;
                    this.cursorHotY = size / 2;
                } else {
                    const width = Math.round(size * 28 / 40);
                    const foreground = settings.get_value('cursor-fg-rgba').deep_unpack();
                    const background = settings.get_value('cursor-bg-rgba').deep_unpack();
                    this.cursor = new St.DrawingArea({width, height: size});
                    this.cursor.connect('repaint', area => {
                        const context = area.get_context();
                        context.scale(width / 28, size / 40);
                        context.setLineWidth(2);
                        context.setSourceRGBA(...background.map(channel => channel / 255));
                        context.rectangle(1, 18, 26, 21);
                        context.fillPreserve();
                        context.setSourceRGBA(...foreground.map(channel => channel / 255));
                        context.stroke();
                        context.setLineWidth(4);
                        context.arc(14, 12, 9, Math.PI, 0);
                        context.lineTo(23, 18);
                        context.moveTo(5, 12);
                        context.lineTo(5, 18);
                        context.stroke();
                        context.arc(14, 26, 2, 0, 2 * Math.PI);
                        context.fill();
                        context.rectangle(13, 26, 2, 6);
                        context.fill();
                        context.$dispose();
                    });
                    this.cursorHotX = width / 2;
                    this.cursorHotY = size * 21 / 40;
                }
                this.actor.add_child(this.cursor);
            }
            this.movePointer(this.pointerX, this.pointerY);
        } catch (error) {
            input.actor.get_parent()?.remove_child(input.actor);
            this.actor.destroy();
            throw error;
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
        this.input.actor.get_parent()?.remove_child(this.input.actor);
        this.background.set_content(null);
        // Clutter retains queued actors until layout completes, even after destruction.
        this.actor.get_allocation_box();
        this.actor.destroy();
    }
}
