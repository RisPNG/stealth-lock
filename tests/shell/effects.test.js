import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {assert, delay, equal, waitFor} from './support.js';

export const tests = {
    async 'all three native effects own their actors and release native resources after dismissal'({extension, settings}) {
        const animations = global.force_animations;
        global.force_animations = true;
        try {
            await waitFor(() => St.Settings.get().enable_animations, 'Private software-rendered animations enabled for testing');
            for (const name of ['blur', 'neo-rain', 'city-grow']) {
                const code = JSON.stringify({effect: name, knobs: {clock: {visible: true}}});
                settings.set_string('visual-effect-presets', JSON.stringify([{name, code}]));
                settings.set_string('visual-effect-active', name);
                settings.set_boolean('freeze-display', true);
                settings.set_string('lock-type', 'normal');
                extension.lock();
                await waitFor(() => extension._session?._ready, `${name}: native presentation ready`);
                const overlay = extension._session._overlay;
                const effect = overlay.effect;
                let destroyed = false;
                effect.layer.connect('destroy', () => { destroyed = true; });
                assert(effect && effect.layer.get_parent() === overlay.actor && !effect.layer.reactive, `${name}: native effect owned by overlay`);
                const children = overlay.actor.get_children();
                assert(children.indexOf(effect.layer) < children.indexOf(overlay.prompt), `${name}: effect below password prompt`);
                assert(effect.clock && effect._clockTimer > 0, `${name}: independent native clock`);
                if (name === 'blur') {
                    assert(effect.blur, 'Native Shell blur created');
                } else {
                    assert(effect.area instanceof St.DrawingArea && effect._animationTimer > 0, `${name}: native Cairo drawing and owned animation`);
                    await delay(150);
                }
                extension._session.close();
                equal(effect._animationTimer, 0, `${name}: animation source removed`);
                equal(effect._clockTimer, 0, `${name}: clock source removed`);
                assert(destroyed, `${name}: native layer destroyed`);
                assert(!effect._context && !effect._surface && !effect.scene && !effect.blur, `${name}: native resources released`);
            }
        } finally {
            extension._session?.close();
            global.force_animations = animations;
        }
    },

    async 'live reduced motion stops animation while the independent clock remains active'({extension, settings}) {
        const animations = global.force_animations;
        global.force_animations = true;
        try {
            await waitFor(() => St.Settings.get().enable_animations, 'Animations enabled');
            const code = JSON.stringify({effect: 'neo-rain', knobs: {clock: {visible: true, seconds: true}}});
            settings.set_string('visual-effect-presets', JSON.stringify([{name: 'motion', code}]));
            settings.set_string('visual-effect-active', 'motion');
            extension.lock();
            await waitFor(() => extension._session?._ready, 'Animation ready');
            const effect = extension._session._overlay.effect;
            assert(effect._animationTimer > 0 && effect._clockTimer > 0, 'Both native timers initially active');
            global.force_animations = false;
            await waitFor(() => !St.Settings.get().enable_animations && effect._animationTimer === 0, 'Reduced motion cancels animation live');
            assert(effect._clockTimer > 0, 'Clock continues independently');
            global.force_animations = true;
            await waitFor(() => effect._animationTimer > 0, 'Animation resumes through native settings notification');
            extension._session.close();
            equal(effect._animationTimer + effect._clockTimer, 0, 'All effect timers gone after dismissal');
        } finally {
            extension._session?.close();
            global.force_animations = animations;
        }
    },

    async 'edited effect knobs replace their native owner without disturbing the protected session'({extension, settings}) {
        const config = {effect: 'neo-rain', knobs: {
            foreground: [20, 200, 40, 255], background: [10, 10, 10, 255], characters: 'ABC🙂', fontSize: 20,
            clock: {visible: true, monitor: '1', align: 'right', fontSize: 24},
        }};
        settings.set_string('visual-effect-presets', JSON.stringify([{name: 'edited', code: JSON.stringify(config)}]));
        settings.set_string('visual-effect-active', 'edited');
        extension.lock();
        await waitFor(() => extension._session?._ready, 'Edited configuration ready');
        const session = extension._session;
        const first = session._overlay.effect;
        assert(first.scene.glyphs.has('🙂'), 'Native Pango glyph cache includes configured Unicode');
        equal(JSON.stringify(first.colors.foreground), JSON.stringify([20, 200, 40, 255].map(value => value / 255)), 'Typed foreground override reaches native renderer');
        assert(first.clock.x >= 1280, 'Clock uses selected native second monitor');
        config.knobs.clock.visible = false;
        config.knobs.characters = 'XY';
        settings.set_string('visual-effect-presets', JSON.stringify([{name: 'edited', code: JSON.stringify(config)}]));
        await waitFor(() => session._overlay.effect !== first, 'Library edit replaces effect owner');
        assert(!first._animationTimer && !first._clockTimer && !first._context && !first._surface, 'Previous drawing and clock resources released');
        const second = session._overlay.effect;
        assert(second.scene.glyphs.has('X') && !second.scene.glyphs.has('🙂') && !second.clock, 'Edited glyph and clock knobs reach replacement');
        settings.set_string('visual-effect-active', '');
        equal(session._overlay.effect, null, 'None removes renderer');
        assert(extension._session === session && session._ready && !session._closed, 'Effect edits never release privacy ownership');
    },

    async 'unknown executable effect configurations keep privacy protection without executing code'({extension, settings}) {
        settings.set_string('visual-effect-presets', JSON.stringify([{name: 'invalid', code: 'global.stealthLockEffectExecuted = true;'}]));
        settings.set_string('visual-effect-active', 'invalid');
        extension.lock();
        await waitFor(() => extension._session?._ready, 'Invalid effect retains native privacy screen');
        assert(!extension._session._overlay.effect, 'Invalid configuration creates no renderer');
        equal(global.stealthLockEffectExecuted, undefined, 'Executable text never runs');
        assert(!extension._session._closed && !extension._session.cancellable.is_cancelled(), 'Presentation failure never releases input ownership');
        assert(GLib.get_monotonic_time() > 0, 'Native Shell remains responsive');
    },

    async 'clock bounds avoid the gap in the actual two-monitor union'({extension, settings}) {
        const code = JSON.stringify({effect: 'city-grow', knobs: {clock: {visible: true, monitor: 'all', align: 'right', topRatio: 1}}});
        settings.set_string('visual-effect-presets', JSON.stringify([{name: 'gap', code}]));
        settings.set_string('visual-effect-active', 'gap');
        extension.lock();
        await waitFor(() => extension._session?._ready, 'Clock gap presentation ready');
        const overlay = extension._session._overlay;
        const clock = overlay.effect.clock;
        const x = clock.x + overlay.originX;
        const y = clock.y + overlay.originY;
        assert(Main.layoutManager.monitors.some(monitor => x >= monitor.x && y >= monitor.y &&
            x + clock.width <= monitor.x + monitor.width && y + clock.height <= monitor.y + monitor.height),
        'Entire native clock is contained by a real monitor');
        assert(x < 1280, 'Gap placement falls back to primary monitor');
    },

    async 'a failed native animation source releases its renderer and keeps password ownership'({extension, settings}) {
        const animations = global.force_animations;
        global.force_animations = true;
        try {
            await waitFor(() => St.Settings.get().enable_animations, 'Animations enabled for failure fixture');
            const code = JSON.stringify({effect: 'neo-rain', knobs: {clock: {visible: true}}});
            settings.set_string('visual-effect-presets', JSON.stringify([{name: 'failure', code}]));
            settings.set_string('visual-effect-active', 'failure');
            extension.lock();
            await waitFor(() => extension._session?._ready, 'Failure fixture presentation ready');
            const session = extension._session;
            const effect = session._overlay.effect;
            await delay(100);
            effect.scene.advance = () => { throw new Error('native animation fixture failure'); };
            await waitFor(() => !effect._animationTimer && !effect._clockTimer, 'Native timer failure releases renderer');
            assert(!effect._context && !effect._surface && !effect.scene, 'Failed renderer releases drawing resources');
            assert(extension._session === session && session._ready && !session._closed, 'Native draw failure keeps input protected');
            settings.set_string('visual-effect-active', '');
            settings.set_string('visual-effect-active', 'failure');
            await waitFor(() => session._overlay.effect !== effect, 'Editing after failure creates a fresh renderer');
            assert(session._overlay.effect.scene, 'Renderer recovers without recreating session ownership');
        } finally {
            extension._session?.close();
            global.force_animations = animations;
        }
    },
};
