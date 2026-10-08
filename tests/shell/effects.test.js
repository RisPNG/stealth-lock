import Cairo from 'cairo';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import PangoCairo from 'gi://PangoCairo';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {assert, delay, equal, waitFor} from './support.js';

async function showProgram(extension, settings, name, code) {
    settings.set_string('visual-effect-presets', JSON.stringify([{name, code}]));
    settings.set_string('visual-effect-active', name);
    extension.lock();
    await waitFor(() => extension._session?._ready, `${name}: privacy presentation ready`);
    const effect = extension._session._overlay.effect;
    assert(effect, `${name}: renderer created`);
    await waitFor(() => effect._ready || effect._destroyed, `${name}: isolated initialization completes`);
    assert(effect._ready && !effect._destroyed, `${name}: isolated program initialized`);
    return effect;
}

export const tests = {
    async 'all ordinary starter programs use isolated workers and release native resources after dismissal'({extension, settings}) {
        const {DEFAULT_EFFECT_PRESETS} = await import(Gio.File.new_for_path(extension.path)
            .resolve_relative_path('shared/presets.js').get_uri());
        const {VisualEffect} = await import(Gio.File.new_for_path(extension.path)
            .resolve_relative_path('shell/effects/renderer.js').get_uri());
        const originals = {renderFrame: VisualEffect.prototype.renderFrame, paint: Cairo.Context.prototype.paint,
            createLayout: PangoCairo.create_layout, showLayout: PangoCairo.show_layout};
        const contexts = new WeakMap();
        const requests = [];
        const decoder = new TextDecoder();
        const cgroup = decoder.decode(GLib.file_get_contents('/proc/self/cgroup')[1]).match(/^0::([^\n]+)$/m)?.[1];
        const cpuStat = cgroup ? `/sys/fs/cgroup${cgroup}/cpu.stat` : null;
        let starter;
        function sampleScheduling() {
            try {
                const thread = decoder.decode(GLib.file_get_contents('/proc/thread-self/schedstat')[1]).trim().split(/\s+/).map(Number);
                const cpu = cpuStat && GLib.file_test(cpuStat, GLib.FileTest.EXISTS)
                    ? Object.fromEntries(decoder.decode(GLib.file_get_contents(cpuStat)[1])
                    .trim().split('\n').map(line => line.split(/\s+/)).map(([key, value]) => [key, Number(value)])) : {};
                return {cpu: thread[0], waiting: thread[1], throttled: cpu.nr_throttled, throttleTime: cpu.throttled_usec};
            } catch {
                return null;
            }
        }
        const animations = global.force_animations;
        global.force_animations = true;
        try {
            VisualEffect.prototype.renderFrame = async function (event, code) {
                if (event !== 'init')
                    return originals.renderFrame.call(this, event, code);
                const context = this._context;
                const metrics = {starter, started: GLib.get_monotonic_time(), paint: null, glyph: null};
                contexts.set(context, metrics);
                const worker = this._process;
                const request = worker.request;
                requests.push({worker, request});
                worker.request = async function (frame) {
                    const response = await request.call(this, frame);
                    if (frame.event === 'init') {
                        metrics.before = sampleScheduling();
                        metrics.nativeStarted = GLib.get_monotonic_time();
                    }
                    return response;
                };
                try {
                    return await originals.renderFrame.call(this, event, code);
                } finally {
                    const finished = GLib.get_monotonic_time();
                    const after = metrics.before ? sampleScheduling() : null;
                    contexts.delete(context);
                    const before = metrics.before;
                    console.info(`Stealth Lock native replay metrics: ${JSON.stringify({
                        starter: metrics.starter, ready: this._ready, destroyed: this._destroyed,
                        initWallMicroseconds: finished - metrics.started,
                        validationReplayClockWallMicroseconds: metrics.nativeStarted ? finished - metrics.nativeStarted : null,
                        validationReplayClockThreadCpuMicroseconds: before && after ? (after.cpu - before.cpu) / 1000 : null,
                        validationReplayClockSchedulerWaitMicroseconds: before && after ? (after.waiting - before.waiting) / 1000 : null,
                        validationReplayClockThrottledPeriods: Number.isFinite(before?.throttled) && Number.isFinite(after?.throttled)
                            ? after.throttled - before.throttled : null,
                        validationReplayClockThrottleMicroseconds: Number.isFinite(before?.throttleTime) && Number.isFinite(after?.throttleTime)
                            ? after.throttleTime - before.throttleTime : null,
                        firstPaintMicroseconds: metrics.paint, firstColdGlyphMicroseconds: metrics.glyph,
                    })}`);
                }
            };
            Cairo.Context.prototype.paint = function (...args) {
                const metrics = contexts.get(this);
                if (!metrics || metrics.paint !== null)
                    return originals.paint.apply(this, args);
                const started = GLib.get_monotonic_time();
                try {
                    return originals.paint.apply(this, args);
                } finally {
                    metrics.paint = GLib.get_monotonic_time() - started;
                }
            };
            PangoCairo.create_layout = function (context, ...args) {
                const metrics = contexts.get(context);
                if (metrics && metrics.glyphStarted === undefined)
                    metrics.glyphStarted = GLib.get_monotonic_time();
                return originals.createLayout.call(this, context, ...args);
            };
            PangoCairo.show_layout = function (context, ...args) {
                const metrics = contexts.get(context);
                try {
                    return originals.showLayout.call(this, context, ...args);
                } finally {
                    if (metrics?.glyphStarted !== undefined && metrics.glyph === null)
                        metrics.glyph = GLib.get_monotonic_time() - metrics.glyphStarted;
                }
            };
            await waitFor(() => St.Settings.get().enable_animations, 'Private software-rendered animations enabled');
            for (const entry of DEFAULT_EFFECT_PRESETS) {
                starter = entry.name;
                settings.set_boolean('freeze-display', true);
                settings.set_string('lock-type', 'normal');
                const code = entry.code + '\nif (ctx.event !== "destroy") ctx.clock({visible: true});';
                const effect = await showProgram(extension, settings, entry.name, code);
                const overlay = extension._session._overlay;
                const worker = effect._process;
                const pid = worker.process.get_identifier();
                let destroyed = false;
                effect.layer.connect('destroy', () => { destroyed = true; });
                assert(effect.layer.get_parent() === overlay.actor && !effect.layer.reactive, `${entry.name}: native layer owned by overlay`);
                const children = overlay.actor.get_children();
                assert(children.indexOf(effect.layer) < children.indexOf(overlay.prompt), `${entry.name}: effect below password prompt`);
                assert(effect.clock && effect._clockTimer > 0 && effect._animationTimer > 0, `${entry.name}: independent native timers`);
                assert(effect.area instanceof St.DrawingArea && effect._context && effect._surface, `${entry.name}: native Cairo drawing`);
                assert(pid && !worker.closed, `${entry.name}: separate live worker`);
                if (entry.name === 'Dim and Blur')
                    assert(effect.blur, 'Starter JavaScript requests native background blur');
                await delay(150);
                extension._session.close();
                equal(effect._animationTimer + effect._clockTimer, 0, `${entry.name}: timers removed`);
                assert(destroyed && !effect._context && !effect._surface && !effect.blur && !effect.clock && !effect._glyphs.size,
                    `${entry.name}: actors and drawing resources released`);
                await waitFor(() => worker.closed && !GLib.file_test(`/proc/${pid}`, GLib.FileTest.IS_DIR), `${entry.name}: worker reaped`);
            }
        } finally {
            extension._session?.close();
            VisualEffect.prototype.renderFrame = originals.renderFrame;
            Cairo.Context.prototype.paint = originals.paint;
            PangoCairo.create_layout = originals.createLayout;
            PangoCairo.show_layout = originals.showLayout;
            for (const {worker, request} of requests)
                worker.request = request;
            global.force_animations = animations;
        }
    },

    async 'live reduced motion stops updates while the isolated program and independent clock remain available'({extension, settings}) {
        const animations = global.force_animations;
        global.force_animations = true;
        try {
            await waitFor(() => St.Settings.get().enable_animations, 'Animations enabled');
            const effect = await showProgram(extension, settings, 'motion', `
                if (ctx.event === 'destroy') return;
                ctx.clock({visible: true, seconds: true});
                ctx.draw.setSourceRGBA(...ctx.colors.foreground);
                ctx.draw.rectangle(20, 20, 40, 40);
                ctx.draw.fill();
            `);
            assert(effect._animationTimer > 0 && effect._clockTimer > 0, 'Both timers initially active');
            global.force_animations = false;
            await waitFor(() => !St.Settings.get().enable_animations && effect._animationTimer === 0, 'Reduced motion cancels animation live');
            assert(effect._clockTimer > 0 && !effect._process.closed, 'Clock and program survive static rendering');
            global.force_animations = true;
            await waitFor(() => effect._animationTimer > 0, 'Animation resumes through native settings');
            extension._session.close();
            equal(effect._animationTimer + effect._clockTimer, 0, 'All timers released');
        } finally {
            extension._session?.close();
            global.force_animations = animations;
        }
    },

    async 'edited user JavaScript replaces its renderer without disturbing password ownership'({extension, settings}) {
        const code = `
            if (ctx.event === 'destroy') return;
            ctx.clock({visible: true, monitor: '1', align: 'right', fontSize: 24});
            ctx.draw.setOperator('source');
            ctx.draw.setSourceRGBA(...ctx.colors.background);
            ctx.draw.paint();
            ctx.draw.setOperator('over');
            ctx.draw.setSourceRGBA(...ctx.colors.foreground);
            ctx.draw.text('ABC🙂', 20, 20, 20, 'monospace');
        `;
        const first = await showProgram(extension, settings, 'edited', code);
        const session = extension._session;
        assert([...first._glyphs.keys()].some(key => key.includes('ABC🙂')), 'Native Pango cache renders program Unicode');
        assert(first.clock.x >= 1280, 'Program clock uses the second native monitor');
        settings.set_string('visual-effect-presets', JSON.stringify([{name: 'edited', code: code
            .replace("ctx.clock({visible: true, monitor: '1', align: 'right', fontSize: 24});", 'ctx.clock(null);')
            .replace('ABC🙂', 'XY')}]));
        await waitFor(() => session._overlay.effect !== first && session._overlay.effect?._ready, 'Edited code initializes replacement worker');
        assert(!first._animationTimer && !first._clockTimer && !first._context && !first._surface, 'Previous native resources released');
        await waitFor(() => first._process.closed, 'Previous worker released');
        const second = session._overlay.effect;
        assert([...second._glyphs.keys()].some(key => key.includes('XY')) && !second.clock, 'Edited drawing and clock code executes');
        settings.set_string('visual-effect-active', '');
        equal(session._overlay.effect, null, 'None removes renderer');
        assert(extension._session === session && session._ready && !session._closed, 'Editing retains protected session');
    },

    async 'ordinary JavaScript runs while Shell APIs and passwords stay outside the worker'({extension, settings}) {
        const animations = global.force_animations;
        global.force_animations = true;
        try {
            await waitFor(() => St.Settings.get().enable_animations, 'Animations enabled for transport inspection');
            const effect = await showProgram(extension, settings, 'isolated', `
                if (ctx.event === 'destroy') return;
                for (const name of ['imports', 'process', 'require', 'fetch', 'XMLHttpRequest', 'WebSocket', 'Gio', 'GLib', 'St', 'Shell', 'global']) {
                    if (typeof globalThis[name] !== 'undefined') throw new Error('Forbidden runtime capability');
                }
                for (const name of ['password', 'input', 'settings', 'actor', 'session', 'unlock', 'close']) {
                    if (name in ctx) throw new Error('Forbidden context capability');
                }
                if (new Function('return 2 + 3')() !== 5) throw new Error('Ordinary JavaScript unavailable');
                ctx.draw.setSourceRGBA(...ctx.colors.foreground);
                ctx.draw.text('isolated', 20, 20);
            `);
            const session = extension._session;
            const secret = 'private-input-fixture';
            session._input.actor.text = secret;
            const request = effect._process.request;
            let inspected = false;
            effect._process.request = function (frame) {
                assert(!JSON.stringify(frame).includes(secret), 'Visual transport excludes password contents');
                inspected = true;
                return request.call(this, frame);
            };
            await waitFor(() => inspected && !effect._process.busy, 'Worker receives a password-free update');
            assert(!effect._destroyed && session._input.actor.text === secret && Main.actionMode === Shell.ActionMode.NONE,
                'Program cannot read or change protected input');
        } finally {
            extension._session?.close();
            global.force_animations = animations;
        }
    },

    async 'Shell access attempts fail in isolation while native password input remains responsive'({extension, settings, helper}) {
        settings.set_string('visual-effect-presets', JSON.stringify([{name: 'invalid', code: 'global.stealthLockEffectExecuted = true;'}]));
        settings.set_string('visual-effect-active', 'invalid');
        extension.lock();
        await waitFor(() => extension._session?._ready, 'Privacy screen available despite invalid program');
        const session = extension._session;
        const effect = session._overlay.effect;
        await waitFor(() => effect._destroyed && effect._process.closed, 'Capability attempt releases renderer');
        equal(global.stealthLockEffectExecuted, undefined, 'Program never executes in Shell');
        helper.Key('a', true);
        helper.Key('a', false);
        await waitFor(() => session._input.actor.text === 'a', 'Password input stays responsive after failure');
        assert(session._ready && !session._closed && !session.cancellable.is_cancelled() && Main.actionMode === Shell.ActionMode.NONE,
            'Visual failure retains modal protection');
    },

    async 'invalid drawing and clock output is refused before native rendering'({extension, settings}) {
        for (const [name, code] of [
            ['stack', 'ctx.draw.restore();'],
            ['clock', 'ctx.clock({fontSize: 100000});'],
            ['color', 'ctx.draw.setSourceRGBA(255, 0, 0, 1); ctx.draw.paint();'],
            ['commands', 'for (let n = 0; n < 3000; n++) ctx.draw.paint();'],
        ]) {
            settings.set_string('visual-effect-presets', JSON.stringify([{name, code}]));
            settings.set_string('visual-effect-active', name);
            extension.lock();
            await waitFor(() => extension._session?._ready, `${name}: privacy screen ready`);
            const session = extension._session;
            const effect = session._overlay.effect;
            await waitFor(() => effect._destroyed && effect._process.closed, `${name}: invalid visual output refused`);
            assert(!effect._context && !effect._surface && !effect.clock && !effect.blur, `${name}: drawing resources released`);
            assert(session._ready && !session._closed && Main.actionMode === Shell.ActionMode.NONE, `${name}: protected session retained`);
            session.close();
        }
    },

    async 'infinite init and update loops terminate without releasing native input protection'({extension, settings}) {
        const animations = global.force_animations;
        global.force_animations = true;
        try {
            await waitFor(() => St.Settings.get().enable_animations, 'Animations enabled for watchdog fixture');
            for (const [name, code] of [
                ['init-loop', 'while (true) {}'],
                ['update-loop', "if (ctx.event === 'update') while (true) {}"],
            ]) {
                settings.set_string('visual-effect-presets', JSON.stringify([{name, code}]));
                settings.set_string('visual-effect-active', name);
                extension.lock();
                await waitFor(() => extension._session?._ready, `${name}: input ownership acquired`);
                const session = extension._session;
                const effect = session._overlay.effect;
                const before = GLib.get_monotonic_time();
                await waitFor(() => effect._destroyed && effect._process.closed, `${name}: bounded worker termination`, 3500);
                assert(GLib.get_monotonic_time() - before < 3500000, `${name}: worker deadline respected`);
                assert(session._ready && !session._closed && Main.actionMode === Shell.ActionMode.NONE, `${name}: no privacy teardown`);
                session.close();
            }
        } finally {
            extension._session?.close();
            global.force_animations = animations;
        }
    },

    async 'user program clocks avoid gaps in the actual two-monitor union'({extension, settings}) {
        const effect = await showProgram(extension, settings, 'gap', `
            if (ctx.event === 'destroy') return;
            ctx.clock({visible: true, monitor: 'all', align: 'right', topRatio: 1});
        `);
        const overlay = extension._session._overlay;
        const clock = effect.clock;
        const x = clock.x + overlay.originX;
        const y = clock.y + overlay.originY;
        assert(Main.layoutManager.monitors.some(monitor => x >= monitor.x && y >= monitor.y &&
            x + clock.width <= monitor.x + monitor.width && y + clock.height <= monitor.y + monitor.height),
        'Entire program clock is contained by a real monitor');
        assert(x < 1280, 'Gap placement falls back to primary monitor');
    },

    async 'user destroy callbacks receive their event and cannot hold privacy resources open'({extension, settings}) {
        const animations = global.force_animations;
        global.force_animations = false;
        try {
            await waitFor(() => !St.Settings.get().enable_animations, 'Static rendering avoids concurrent updates');
            const effect = await showProgram(extension, settings, 'destroy-loop', `
                if (ctx.event === 'destroy') while (true) {}
                ctx.draw.setSourceRGBA(...ctx.colors.foreground);
                ctx.draw.rectangle(20, 20, 40, 40);
                ctx.draw.fill();
            `);
            await waitFor(() => !effect._process.busy, 'Worker idle before cleanup');
            const request = effect._process.request;
            let destroyEvent = false;
            effect._process.request = function (frame) {
                destroyEvent ||= frame.event === 'destroy';
                return request.call(this, frame);
            };
            extension._session.close();
            assert(destroyEvent && !extension._session && effect._destroyed && !effect._context && !effect._surface,
                'Native resources close immediately after delivering destroy');
            await waitFor(() => effect._process.closed, 'Unbounded destroy callback terminated');
        } finally {
            extension._session?.close();
            global.force_animations = animations;
        }
    },
};
