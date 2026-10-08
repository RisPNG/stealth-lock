import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {CityGrowth} from './city.js';

const BLUR_RADIUS_PROPERTY = Shell.BlurEffect.find_property('radius') ? 'radius' : 'sigma';

class DigitalRain {
    constructor(width, height, knobs, cr) {
        this.knobs = knobs;
        this.width = width;
        this.height = height;
        this.characters = [...knobs.characters];
        this.glyphs = new Map();
        const font = new Pango.FontDescription();
        font.set_family(knobs.fontFamily);
        font.set_absolute_size(knobs.fontSize * Pango.SCALE);
        this.cellWidth = Math.ceil(knobs.fontSize * 0.6);
        this.cellHeight = Math.ceil(knobs.fontSize * 1.2);
        for (const character of this.characters) {
            const layout = PangoCairo.create_layout(cr);
            layout.set_font_description(font);
            layout.set_text(character, -1);
            const [width, height] = layout.get_pixel_size();
            this.cellWidth = Math.max(this.cellWidth, width);
            this.cellHeight = Math.max(this.cellHeight, height);
            this.glyphs.set(character, layout);
        }
        this.rows = Math.max(1, Math.floor(height / this.cellHeight));
        this.columns = Array.from({length: Math.max(1, Math.floor(width / this.cellWidth))}, () => ({
            droplets: [], cooldown: Math.floor(Math.random() * 31),
        }));
        for (const column of this.columns) {
            if (Math.random() < knobs.density * 0.3)
                this.spawnDroplet(column);
        }
    }

    spawnDroplet(column) {
        const k = this.knobs;
        const upperLength = Math.random() < 0.5 ? Math.min(k.lengthMax, Math.max(k.lengthMin, 15)) : k.lengthMax;
        const length = k.lengthMin + Math.floor(Math.random() * (upperLength - k.lengthMin + 1));
        column.droplets.push({
            y: -Math.random() * length,
            speed: k.speedMin + Math.random() * (k.speedMax - k.speedMin),
            length,
            dieRow: Math.random() < 0.33 ? Math.floor(Math.random() * this.rows) : this.rows + length,
            characters: Array.from({length}, () => this.characters[Math.floor(Math.random() * this.characters.length)]),
        });
        column.cooldown = 3 + Math.floor(Math.random() * 48);
    }

    advance(cr, colors) {
        const {background, foreground, head, glitch} = colors;
        cr.setOperator(Cairo.Operator.DEST_OUT);
        cr.setSourceRGBA(...background.slice(0, 3), this.knobs.fadeAlpha);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);
        cr.setSourceRGBA(...background.slice(0, 3), background[3] * this.knobs.fadeAlpha);
        cr.paint();
        cr.setOperator(Cairo.Operator.SOURCE);
        cr.setSourceRGBA(...background);
        for (let ci = 0; ci < this.columns.length; ci++) {
            for (const drop of this.columns[ci].droplets) {
                const headRow = Math.floor(drop.y);
                for (let row = Math.max(0, headRow - drop.length); row <= Math.min(this.rows - 1, headRow); row++)
                    cr.rectangle(ci * this.cellWidth, row * this.cellHeight, this.cellWidth, this.cellHeight);
            }
        }
        cr.fill();
        cr.setOperator(Cairo.Operator.OVER);
        for (let ci = 0; ci < this.columns.length; ci++) {
            const column = this.columns[ci];
            for (const drop of column.droplets) {
                const headRow = Math.floor(drop.y);
                for (let row = Math.max(0, headRow - drop.length); row <= Math.min(this.rows - 1, headRow); row++) {
                    const distance = headRow - row;
                    const index = distance % drop.length;
                    if (distance > 0 && Math.random() < 0.03)
                        drop.characters[index] = this.characters[Math.floor(Math.random() * this.characters.length)];
                    const intensity = distance <= 2 ? 0.95 : 0.3 + 0.6 * (1 - distance / drop.length);
                    cr.setSourceRGBA(...(distance === 0 ? head : foreground.map((component, i) => i < 3 ? component * intensity : component)));
                    cr.moveTo(ci * this.cellWidth, row * this.cellHeight);
                    PangoCairo.show_layout(cr, this.glyphs.get(drop.characters[index]));
                }
                drop.y += drop.speed;
            }
            column.droplets = column.droplets.filter(drop =>
                Math.floor(drop.y) - drop.length < this.rows && Math.floor(drop.y) < drop.dieRow + drop.length);
            if (column.cooldown > 0)
                column.cooldown--;
            else if (column.droplets.length < this.knobs.maxDrops && Math.random() < 0.06 * this.knobs.density)
                this.spawnDroplet(column);
        }
        const flashes = Math.ceil(this.columns.length * this.rows * 0.001 * this.knobs.density);
        for (let i = 0; i < flashes; i++) {
            const x = Math.floor(Math.random() * this.columns.length) * this.cellWidth;
            const y = Math.floor(Math.random() * this.rows) * this.cellHeight;
            cr.setOperator(Cairo.Operator.SOURCE);
            cr.setSourceRGBA(...background);
            cr.rectangle(x, y, this.cellWidth, this.cellHeight);
            cr.fill();
            cr.setOperator(Cairo.Operator.OVER);
            cr.setSourceRGBA(...glitch);
            cr.moveTo(x, y);
            PangoCairo.show_layout(cr, this.glyphs.get(this.characters[Math.floor(Math.random() * this.characters.length)]));
        }
    }
}

export class BackdropEffect {
    constructor({parent, width, height, monitors, primaryMonitor, originX, originY, promptMonitor}, config) {
        this.config = config;
        this.width = width;
        this.height = height;
        this.monitors = monitors;
        this.primaryMonitor = primaryMonitor;
        this.originX = originX;
        this.originY = originY;
        this.promptMonitor = promptMonitor;
        this._animationTimer = 0;
        this._clockTimer = 0;
        this._surface = null;
        this._context = null;
        this.scene = null;
        this.blur = null;
        this.clock = null;
        this._interfaceSettings = St.Settings.get();
        this.layer = new St.Widget({width, height, reactive: false});
        parent.add_child(this.layer);
        try {
            const knobs = config.knobs;
            if (config.effect === 'blur') {
                this.area = new St.Widget({width, height, style_class: 'stealth-lock-effect-blur', reactive: false});
                this.layer.add_child(this.area);
                this.blur = new Shell.BlurEffect({
                    mode: Shell.BlurMode.BACKGROUND,
                    brightness: knobs.brightness,
                    [BLUR_RADIUS_PROPERTY]: Math.round(knobs.radius),
                });
                this.area.add_effect_with_name('stealth-lock-blur', this.blur);
                if (knobs.background)
                    this.area.style = `background-color: rgba(${knobs.background.slice(0, 3).join(',')}, ${knobs.background[3] / 255});`;
            } else {
                this.area = new St.DrawingArea({width, height, style_class: `stealth-lock-effect-${config.effect}`, reactive: false});
                this.layer.add_child(this.area);
                this.area.connect('repaint', () => {
                    let cr;
                    let failure;
                    try {
                        cr = this.area.get_context();
                        cr.setSourceSurface(this._surface, 0, 0);
                        cr.paint();
                    } catch (error) {
                        failure = error;
                    } finally {
                        cr?.$dispose();
                    }
                    if (failure) {
                        console.debug(`Stealth Lock: visual effect repaint failed: ${failure.message}`);
                        this.destroy();
                    }
                });
                this.area.connect('style-changed', () => {
                    try {
                        this.prepareScene();
                    } catch (error) {
                        console.debug(`Stealth Lock: visual effect theme update failed: ${error.message}`);
                        this.destroy();
                    }
                });
                this.prepareScene();
            }
            if (knobs.clock.visible) {
                this.clock = new St.BoxLayout({style_class: 'stealth-lock-effect-clock', reactive: false});
                this.clock.layout_manager.set_orientation(Clutter.Orientation.VERTICAL);
                this.timeLabel = new St.Label({style_class: 'stealth-lock-effect-time', x_expand: true, x_align: Clutter.ActorAlign.CENTER});
                this.timeLabel.style = `font-size: ${knobs.clock.fontSize}px;`;
                this.clock.add_child(this.timeLabel);
                if (knobs.clock.date) {
                    this.dateLabel = new St.Label({style_class: 'stealth-lock-effect-date', x_expand: true, x_align: Clutter.ActorAlign.CENTER});
                    this.dateLabel.style = `font-size: ${knobs.clock.dateFontSize}px;`;
                    this.clock.add_child(this.dateLabel);
                }
                if (knobs.foreground) {
                    const color = `color: rgba(${knobs.foreground.slice(0, 3).join(',')}, ${knobs.foreground[3] / 255});`;
                    this.timeLabel.style += color;
                    if (this.dateLabel)
                        this.dateLabel.style += color;
                }
                this.layer.add_child(this.clock);
                this.updateClock();
                this._clockTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                    try {
                        this.updateClock();
                    } catch (error) {
                        console.debug(`Stealth Lock: visual effect clock failed: ${error.message}`);
                        this.destroy();
                        return GLib.SOURCE_REMOVE;
                    }
                    return GLib.SOURCE_CONTINUE;
                });
            }
            this._interfaceSettings.connectObject('notify::enable-animations', () => this.configureAnimation(), this.layer);
            if (St.ReducedMotion)
                this._interfaceSettings.connectObject('notify::reduced-motion', () => this.configureAnimation(), this.layer);
            this.configureAnimation();
        } catch (error) {
            this.destroy();
            throw error;
        }
    }

    prepareScene() {
        if (this._destroyed)
            return;
        if (this._animationTimer) {
            GLib.Source.remove(this._animationTimer);
            this._animationTimer = 0;
        }
        this._context?.$dispose();
        this._context = null;
        this._surface?.finish();
        this._surface = null;
        this._surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, this.width, this.height);
        this._context = new Cairo.Context(this._surface);
        const node = this.area.get_theme_node();
        this.colors = {};
        for (const name of ['background', 'foreground', 'head', 'glitch', 'cyan', 'mint', 'amber', 'orange', 'magenta']) {
            const [, color] = node.lookup_color(`-stealth-lock-${name}`, false);
            this.colors[name] = [color.red, color.green, color.blue, color.alpha].map(component => component / 255);
        }
        const knobs = this.config.knobs;
        if (knobs.background)
            this.colors.background = knobs.background.map(component => component / 255);
        if (knobs.foreground)
            this.colors.foreground = knobs.foreground.map(component => component / 255);
        this.colors.palette = knobs.palette?.map(color => color.map(component => component / 255)) ??
            (knobs.foreground ? [this.colors.foreground] : ['cyan', 'mint', 'amber', 'orange', 'magenta'].map(name => this.colors[name]));
        this._context.setSourceRGBA(...this.colors.background);
        this._context.paint();
        this.scene = this.config.effect === 'neo-rain'
            ? new DigitalRain(this.width, this.height, knobs, this._context)
            : new CityGrowth(this.width, this.height, knobs);
        const frames = this._interfaceSettings.enable_animations &&
            (!St.ReducedMotion || this._interfaceSettings.reduced_motion !== St.ReducedMotion.REDUCE) ? 1 : 32;
        for (let i = 0; i < frames; i++)
            this.scene.advance(this._context, this.colors);
        this.area.queue_repaint();
        this.configureAnimation();
    }

    configureAnimation() {
        if (this._destroyed)
            return;
        if (this._animationTimer) {
            GLib.Source.remove(this._animationTimer);
            this._animationTimer = 0;
        }
        if (this.scene && this._interfaceSettings.enable_animations &&
            (!St.ReducedMotion || this._interfaceSettings.reduced_motion !== St.ReducedMotion.REDUCE)) {
            this._animationTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this.config.knobs.intervalMs, () => {
                try {
                    this.scene.advance(this._context, this.colors);
                    this.area.queue_repaint();
                } catch (error) {
                    console.debug(`Stealth Lock: visual effect animation failed: ${error.message}`);
                    this.destroy();
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            });
        }
    }

    updateClock() {
        const clock = this.config.knobs.clock;
        const now = GLib.DateTime.new_now_local();
        this.timeLabel.text = now.format(clock.format24h
            ? clock.seconds ? '%H:%M:%S' : '%H:%M'
            : clock.seconds ? '%I:%M:%S %p' : '%I:%M %p');
        if (this.dateLabel)
            this.dateLabel.text = now.format('%A, %e %B %Y');
        const index = clock.monitor === 'settings' ? this.promptMonitor : clock.monitor;
        let bounds = {x: 0, y: 0, width: this.width, height: this.height};
        if (/^\d+$/.test(index) && this.monitors[Number(index)]) {
            const monitor = this.monitors[Number(index)];
            bounds = {...monitor, x: monitor.x - this.originX, y: monitor.y - this.originY};
        }
        const [, naturalWidth] = this.clock.get_preferred_width(-1);
        let width = Math.min(naturalWidth, bounds.width);
        let [, height] = this.clock.get_preferred_height(width);
        height = Math.min(height, bounds.height);
        let x = bounds.x + (bounds.width - width) / 2;
        if (clock.align === 'left')
            x = bounds.x + 24;
        else if (clock.align === 'right')
            x = bounds.x + bounds.width - width - 24;
        let y = bounds.y + bounds.height * clock.topRatio + clock.offsetY;
        x = Math.max(bounds.x, Math.min(x, bounds.x + Math.max(0, bounds.width - width)));
        y = Math.max(bounds.y, Math.min(y, bounds.y + Math.max(0, bounds.height - height)));
        if (!this.monitors.some(monitor => x + this.originX >= monitor.x && y + this.originY >= monitor.y &&
            x + this.originX + width <= monitor.x + monitor.width && y + this.originY + height <= monitor.y + monitor.height)) {
            const monitor = this.primaryMonitor;
            bounds = {...monitor, x: monitor.x - this.originX, y: monitor.y - this.originY};
            width = Math.min(naturalWidth, bounds.width);
            [, height] = this.clock.get_preferred_height(width);
            height = Math.min(height, bounds.height);
            x = Math.max(bounds.x, Math.min(x, bounds.x + bounds.width - width));
            y = Math.max(bounds.y, Math.min(y, bounds.y + bounds.height - height));
        }
        this.clock.set_size(width, height);
        this.clock.set_clip(0, 0, width, height);
        this.clock.set_position(Math.round(x), Math.round(y));
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._interfaceSettings.disconnectObject(this.layer);
        for (const id of [this._animationTimer, this._clockTimer]) {
            if (id)
                GLib.Source.remove(id);
        }
        this._animationTimer = 0;
        this._clockTimer = 0;
        if (this.blur)
            this.area.remove_effect_by_name('stealth-lock-blur');
        this.blur = null;
        this.layer.destroy();
        this._context?.$dispose();
        this._surface?.finish();
        this._context = null;
        this._surface = null;
        this.scene = null;
        this.clock = null;
    }
}
