import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {VisualProcess} from '../../shared/visual-process.js';
import {MAX_VISUAL_REPLAY_MICROSECONDS, MAX_VISUAL_SURFACE_PIXELS, validateVisualFrame} from '../../shared/visual-frame.js';
import {validateVisualProgramSource} from '../../shared/presets.js';

const BLUR_RADIUS_PROPERTY = Shell.BlurEffect.find_property('radius') ? 'radius' : 'sigma';

export class VisualEffect {
    constructor({parent, path, width, height, monitors, primaryMonitor, originX, originY, promptMonitor}, code) {
        validateVisualProgramSource(code);
        Object.assign(this, {width, height, monitors, primaryMonitor, originX, originY, promptMonitor});
        this._animationTimer = 0;
        this._clockTimer = 0;
        this._destroyed = false;
        this._ready = false;
        this._pendingUpdate = false;
        this._surface = null;
        this._context = null;
        this._glyphs = new Map();
        this._lineWidth = 2;
        this._fontFamilies = [];
        this.blur = null;
        this.clock = null;
        this.clockConfig = null;
        this._interfaceSettings = St.Settings.get();
        this.layer = new St.Widget({width, height, reactive: false});
        parent.add_child(this.layer);
        try {
            this.area = new St.DrawingArea({width, height, style_class: 'stealth-lock-effect', reactive: false});
            this.layer.add_child(this.area);
            this._scale = Math.min(1, Math.sqrt(MAX_VISUAL_SURFACE_PIXELS / (width * height)));
            this._surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, Math.ceil(width * this._scale), Math.ceil(height * this._scale));
            this._context = new Cairo.Context(this._surface);
            this._context.scale(this._scale, this._scale);
            this.area.connect('repaint', () => {
                let cr;
                try {
                    cr = this.area.get_context();
                    cr.scale(1 / this._scale, 1 / this._scale);
                    cr.setSourceSurface(this._surface, 0, 0);
                    cr.paint();
                } catch (error) {
                    console.debug(`Stealth Lock: visual repaint failed: ${error.message}`);
                    this.destroy();
                } finally {
                    cr?.$dispose();
                }
            });
            this.area.connect('style-changed', () => {
                this._pendingUpdate = true;
                if (this._ready)
                    this.renderFrame('update');
            });
            this._interfaceSettings.connectObject('notify::enable-animations', () => this.configureAnimation(), this.layer);
            if (St.ReducedMotion)
                this._interfaceSettings.connectObject('notify::reduced-motion', () => this.configureAnimation(), this.layer);
            this._process = new VisualProcess(path);
            this.renderFrame('init', code);
        } catch (error) {
            this.destroy();
            throw error;
        }
    }

    async renderFrame(event, code) {
        if (this._destroyed)
            return;
        if (this._process.busy || (event === 'update' && !this._ready)) {
            if (event === 'update')
                this._pendingUpdate = true;
            return;
        }
        if (event === 'update')
            this._pendingUpdate = false;
        try {
            const node = this.area.get_theme_node();
            const colors = {};
            for (const name of ['background', 'foreground', 'head', 'glitch', 'cyan', 'mint', 'amber', 'orange', 'magenta', 'blur']) {
                const [, color] = node.lookup_color(`-stealth-lock-${name}`, false);
                colors[name] = [color.red, color.green, color.blue, color.alpha].map(component => component / 255);
            }
            colors.palette = ['cyan', 'mint', 'amber', 'orange', 'magenta'].map(name => colors[name]);
            const now = GLib.get_monotonic_time() / 1000;
            const reducedMotion = !this._interfaceSettings.enable_animations ||
                Boolean(St.ReducedMotion && this._interfaceSettings.reduced_motion === St.ReducedMotion.REDUCE);
            const response = await this._process.request({event, code, width: this.width, height: this.height,
                monitors: this.monitors.map(monitor => ({x: monitor.x - this.originX, y: monitor.y - this.originY,
                    width: monitor.width, height: monitor.height})), colors, now,
                delta: this._lastFrame === undefined ? 0 : Math.min(1000, now - this._lastFrame), reducedMotion});
            if (this._destroyed)
                return;
            const frame = validateVisualFrame(response, this.width, this.height,
                {lineWidth: this._lineWidth, fontFamilies: this._fontFamilies, glyphs: this._glyphs.keys()});
            this._lineWidth = frame.lineWidth;
            this._fontFamilies = frame.fontFamilies;
            this._lastFrame = now;
            const cr = this._context;
            const operators = {'source': Cairo.Operator.SOURCE, 'over': Cairo.Operator.OVER, 'dest-out': Cairo.Operator.DEST_OUT};
            const started = GLib.get_monotonic_time();
            for (const [operation, ...values] of frame.commands) {
                if (GLib.get_monotonic_time() - started > MAX_VISUAL_REPLAY_MICROSECONDS)
                    throw new Error('Visual frame exceeded the native replay deadline');
                if (operation === 'setOperator') {
                    cr.setOperator(operators[values[0]]);
                } else if (operation === 'text') {
                    const [text, x, y, size, family] = values;
                    const key = JSON.stringify([text, size, family]);
                    let layout = this._glyphs.get(key);
                    if (!layout) {
                        if (this._glyphs.size >= 512)
                            this._glyphs.delete(this._glyphs.keys().next().value);
                        const font = new Pango.FontDescription();
                        font.set_family(family);
                        font.set_absolute_size(size * Pango.SCALE);
                        layout = PangoCairo.create_layout(cr);
                        layout.set_font_description(font);
                        layout.set_text(text, -1);
                        this._glyphs.set(key, layout);
                    }
                    cr.moveTo(x, y);
                    PangoCairo.show_layout(cr, layout);
                } else {
                    cr[operation](...values);
                }
            }
            if (GLib.get_monotonic_time() - started > MAX_VISUAL_REPLAY_MICROSECONDS)
                throw new Error('Visual frame exceeded the native replay deadline');
            cr.newPath();
            if (frame.blur) {
                if (!this.blur) {
                    this.blur = new Shell.BlurEffect({mode: Shell.BlurMode.BACKGROUND});
                    this.area.add_effect_with_name('stealth-lock-blur', this.blur);
                }
                this.blur[BLUR_RADIUS_PROPERTY] = Math.round(frame.blur.radius);
                this.blur.brightness = frame.blur.brightness;
            } else if (this.blur) {
                this.area.remove_effect_by_name('stealth-lock-blur');
                this.blur = null;
            }
            if (JSON.stringify(frame.clock) !== JSON.stringify(this.clockConfig)) {
                if (this._clockTimer)
                    GLib.Source.remove(this._clockTimer);
                this._clockTimer = 0;
                this.clock?.destroy();
                this.clock = null;
                this.clockConfig = frame.clock;
                if (frame.clock?.visible) {
                    this.clock = new St.BoxLayout({style_class: 'stealth-lock-effect-clock', reactive: false});
                    this.clock.layout_manager.set_orientation(Clutter.Orientation.VERTICAL);
                    this.timeLabel = new St.Label({style_class: 'stealth-lock-effect-time', x_expand: true, x_align: Clutter.ActorAlign.CENTER});
                    this.timeLabel.style = `font-size: ${frame.clock.fontSize}px;`;
                    this.clock.add_child(this.timeLabel);
                    this.dateLabel = null;
                    if (frame.clock.date) {
                        this.dateLabel = new St.Label({style_class: 'stealth-lock-effect-date', x_expand: true, x_align: Clutter.ActorAlign.CENTER});
                        this.dateLabel.style = `font-size: ${frame.clock.dateFontSize}px;`;
                        this.clock.add_child(this.dateLabel);
                    }
                    this.layer.add_child(this.clock);
                    this.updateClock();
                    this._clockTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                        try {
                            this.updateClock();
                            return GLib.SOURCE_CONTINUE;
                        } catch (error) {
                            console.debug(`Stealth Lock: visual clock failed: ${error.message}`);
                            this.destroy();
                            return GLib.SOURCE_REMOVE;
                        }
                    });
                }
            }
            this.area.queue_repaint();
            if (!this._ready) {
                this._ready = true;
                this.configureAnimation();
            }
        } catch (error) {
            if (!this._destroyed)
                console.debug(`Stealth Lock: visual program is unavailable: ${error.message}`);
            this.destroy();
        } finally {
            if (!this._destroyed && this._ready && this._pendingUpdate)
                this.renderFrame('update');
        }
    }

    configureAnimation() {
        if (this._destroyed)
            return;
        if (!this._ready || this._process.busy)
            this._pendingUpdate = true;
        if (this._animationTimer)
            GLib.Source.remove(this._animationTimer);
        this._animationTimer = 0;
        const animated = this._interfaceSettings.enable_animations &&
            (!St.ReducedMotion || this._interfaceSettings.reduced_motion !== St.ReducedMotion.REDUCE);
        if (this._ready && animated) {
            this._animationTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                if (!this._process.busy)
                    this.renderFrame('update');
                return GLib.SOURCE_CONTINUE;
            });
        } else if (this._ready) {
            this.renderFrame('update');
        }
    }

    updateClock() {
        const clock = this.clockConfig;
        const now = GLib.DateTime.new_now_local();
        this.timeLabel.text = now.format(clock.format24h
            ? clock.seconds ? '%H:%M:%S' : '%H:%M'
            : clock.seconds ? '%I:%M:%S %p' : '%I:%M %p');
        if (this.dateLabel)
            this.dateLabel.text = now.format('%A, %e %B %Y');
        const selection = clock.monitor === 'settings' ? this.promptMonitor : clock.monitor;
        let bounds = {x: 0, y: 0, width: this.width, height: this.height};
        if (selection && selection !== 'all') {
            const index = /^\d+$/.test(selection) ? Number(selection) : global.display.get_monitor_index_for_connector(selection);
            const monitor = this.monitors[index] ?? this.primaryMonitor;
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
        this._pendingUpdate = false;
        this._interfaceSettings.disconnectObject(this.layer);
        for (const id of [this._animationTimer, this._clockTimer]) {
            if (id)
                GLib.Source.remove(id);
        }
        this._animationTimer = 0;
        this._clockTimer = 0;
        if (this._process && !this._process.closed) {
            if (this._ready && !this._process.busy)
                this._process.request({event: 'destroy'}).catch(() => {}).finally(() => this._process.destroy());
            else
                this._process.destroy();
        }
        this.layer.destroy();
        this._context?.$dispose();
        this._surface?.finish();
        this._context = null;
        this._surface = null;
        this._glyphs.clear();
        this.blur = null;
        this.clock = null;
    }
}
