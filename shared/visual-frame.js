export const MAX_VISUAL_SURFACE_PIXELS = 4194304;
export const MAX_VISUAL_FRAME_PIXELS = 16777216;
export const MAX_VISUAL_REPLAY_MICROSECONDS = 50000;

export function validateVisualFrame(frame, width, height, {lineWidth: previousLineWidth = 2, fontFamilies = [], glyphs: previousGlyphs = []} = {}) {
    if (frame === null || typeof frame !== 'object' || Array.isArray(frame) ||
        Object.keys(frame).some(key => !['commands', 'blur', 'clock'].includes(key)) ||
        !Array.isArray(frame.commands) || frame.commands.length > 2048)
        throw new Error('Visual frame has an invalid structure');
    const arities = {setSourceRGBA: 4, paint: 0, rectangle: 4, fill: 0, save: 0, restore: 0,
        moveTo: 2, lineTo: 2, stroke: 0, setLineWidth: 1, setOperator: 1, text: 5};
    const scale = Math.min(1, Math.sqrt(MAX_VISUAL_SURFACE_PIXELS / (width * height)));
    const surfacePixels = Math.ceil(width * scale) * Math.ceil(height * scale);
    const widths = [];
    const families = new Set(fontFamilies);
    const cachedGlyphs = new Set(previousGlyphs);
    let lineWidth = previousLineWidth;
    let paints = 0;
    let glyphs = 0;
    let texts = 0;
    let newLayouts = 0;
    let pixels = 0;
    let edges = 0;
    let path = [];
    for (const command of frame.commands) {
        if (!Array.isArray(command) || !Object.hasOwn(arities, command[0]) || command.length !== arities[command[0]] + 1)
            throw new Error('Visual frame contains an unknown drawing command');
        const [name, ...values] = command;
        if (name === 'setOperator') {
            if (!['source', 'over', 'dest-out'].includes(values[0]))
                throw new Error('Visual frame contains an invalid drawing operator');
        } else if (name === 'text') {
            const [text, x, y, size, family] = values;
            if (typeof text !== 'string' || [...text].length > 256 || /[\0\uD800-\uDFFF]/u.test(text) ||
                typeof family !== 'string' || family.length > 128 || /[,\0\r\n\uD800-\uDFFF]/u.test(family) ||
                ![x, y, size].every(Number.isFinite) || size < 1 || size > 128 ||
                Math.abs(x) > width * 2 || Math.abs(y) > height * 2)
                throw new Error('Visual frame contains invalid text');
            glyphs += [...text].length;
            if (glyphs > 4096)
                throw new Error('Visual frame exceeds the text budget');
            if (++texts > 512)
                throw new Error('Visual frame exceeds the text operation budget');
            families.add(family);
            if (families.size > 4)
                throw new Error('Visual program exceeds the font family budget');
            const key = JSON.stringify([text, size, family]);
            if (!cachedGlyphs.has(key)) {
                if (++newLayouts > 128)
                    throw new Error('Visual frame exceeds the new text layout budget');
                if (cachedGlyphs.size >= 512)
                    cachedGlyphs.delete(cachedGlyphs.values().next().value);
                cachedGlyphs.add(key);
            }
            pixels += [...text].length * Math.max(1, size * scale) ** 2 * 4;
            path.push({x, y, minX: x, maxX: x, minY: y, maxY: y, edges: 0, length: 0});
        } else if (!values.every(value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 131072)) {
            throw new Error('Visual frame contains invalid coordinates');
        }
        if (name === 'setSourceRGBA' && values.some(value => value < 0 || value > 1))
            throw new Error('Visual colors must use normalized RGBA values');
        if (name === 'setLineWidth') {
            if (values[0] <= 0 || values[0] > 128)
                throw new Error('Visual line width is outside the allowed range');
            lineWidth = values[0];
        }
        if (name === 'rectangle') {
            if (values[2] < 0 || values[3] < 0)
                throw new Error('Visual rectangle dimensions must be nonnegative');
            const [x, y, rectangleWidth, rectangleHeight] = values;
            path.push({rectangle: true, edges: 4, length: 2 * (rectangleWidth + rectangleHeight),
                area: rectangleWidth * rectangleHeight});
            path.push({x, y, minX: x, maxX: x, minY: y, maxY: y, edges: 0, length: 0});
        }
        if (name === 'moveTo') {
            const [x, y] = values;
            path.push({x, y, minX: x, maxX: x, minY: y, maxY: y, edges: 0, length: 0});
        }
        if (name === 'lineTo') {
            const [x, y] = values;
            const current = path.at(-1);
            if (!current) {
                path.push({x, y, minX: x, maxX: x, minY: y, maxY: y, edges: 0, length: 0});
            } else {
                current.length += Math.hypot(x - current.x, y - current.y);
                current.x = x;
                current.y = y;
                current.minX = Math.min(current.minX, x);
                current.maxX = Math.max(current.maxX, x);
                current.minY = Math.min(current.minY, y);
                current.maxY = Math.max(current.maxY, y);
                if (++current.edges > 128 || ++edges > 1024)
                    throw new Error('Visual frame exceeds the path complexity budget');
            }
        }
        if (name === 'fill' || name === 'stroke') {
            for (const subpath of path) {
                if (!subpath.edges)
                    continue;
                if (name === 'stroke') {
                    pixels += (subpath.length * lineWidth + subpath.edges * lineWidth ** 2 * 4) * scale ** 2;
                } else {
                    const area = subpath.rectangle ? subpath.area :
                        (subpath.maxX - subpath.minX) * (subpath.maxY - subpath.minY) * Math.max(1, subpath.edges / 4);
                    pixels += area * scale ** 2;
                }
            }
            path = [];
        }
        if (name === 'paint') {
            if (++paints > 4)
                throw new Error('Visual frame contains too many full-surface paints');
            pixels += surfacePixels;
        }
        if (name === 'save') {
            if (widths.length >= 32)
                throw new Error('Visual frame contains an invalid drawing state stack');
            widths.push(lineWidth);
        } else if (name === 'restore') {
            if (!widths.length)
                throw new Error('Visual frame contains an invalid drawing state stack');
            lineWidth = widths.pop();
        }
        if (pixels > MAX_VISUAL_FRAME_PIXELS)
            throw new Error('Visual frame exceeds the raster work budget');
    }
    if (widths.length !== 0)
        throw new Error('Visual frame has unbalanced drawing state');
    if (frame.blur !== null && (typeof frame.blur !== 'object' || Array.isArray(frame.blur) ||
        Object.keys(frame.blur).some(key => !['radius', 'brightness'].includes(key)) ||
        !Number.isFinite(frame.blur.radius) || frame.blur.radius < 0 || frame.blur.radius > 100 ||
        !Number.isFinite(frame.blur.brightness) || frame.blur.brightness < 0 || frame.blur.brightness > 1))
        throw new Error('Visual blur settings are invalid');
    let clock = null;
    if (frame.clock !== null) {
        const defaults = {visible: true, format24h: true, seconds: true, date: true, align: 'center',
            topRatio: 0.14, offsetY: 0, fontSize: 64, dateFontSize: 20, monitor: 'settings'};
        if (typeof frame.clock !== 'object' || Array.isArray(frame.clock) ||
            Object.keys(frame.clock).some(key => !Object.hasOwn(defaults, key)))
            throw new Error('Visual clock settings are invalid');
        clock = {...defaults, ...frame.clock};
        if (!['visible', 'format24h', 'seconds', 'date'].every(key => typeof clock[key] === 'boolean') ||
            !['left', 'center', 'right'].includes(clock.align) || typeof clock.monitor !== 'string' ||
            (!['settings', 'all'].includes(clock.monitor) && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(clock.monitor)) ||
            !Number.isFinite(clock.topRatio) || clock.topRatio < 0 || clock.topRatio > 1 ||
            !Number.isInteger(clock.offsetY) || clock.offsetY < -2147483648 || clock.offsetY > 2147483647 ||
            !Number.isFinite(clock.fontSize) || clock.fontSize < 8 || clock.fontSize > 160 ||
            !Number.isFinite(clock.dateFontSize) || clock.dateFontSize < 8 || clock.dateFontSize > 64)
            throw new Error('Visual clock settings are outside the allowed ranges');
    }
    return {...frame, clock, lineWidth, fontFamilies: [...families]};
}
