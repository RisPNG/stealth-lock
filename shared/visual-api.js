(() => {
    const parse = JSON.parse;
    const stringify = JSON.stringify;
    const assign = Object.assign;
    const freeze = Object.freeze;
    const isFinite = Number.isFinite;
    const append = Array.prototype.push;
    let commands = [];
    let blur = null;
    let clock = null;
    const ctx = {state: {}};

    function drawCommand(name, values) {
        if (commands.length >= 2048)
            throw new RangeError('Visual frame contains too many drawing commands');
        for (const value of values) {
            if (typeof value === 'number' && !isFinite(value))
                throw new RangeError('Drawing coordinates must be finite');
        }
        append.call(commands, [name, ...values]);
    }

    ctx.draw = freeze({
        setSourceRGBA: (r, g, b, a) => drawCommand('setSourceRGBA', [r, g, b, a]),
        paint: () => drawCommand('paint', []),
        rectangle: (x, y, width, height) => drawCommand('rectangle', [x, y, width, height]),
        fill: () => drawCommand('fill', []),
        save: () => drawCommand('save', []),
        restore: () => drawCommand('restore', []),
        moveTo: (x, y) => drawCommand('moveTo', [x, y]),
        lineTo: (x, y) => drawCommand('lineTo', [x, y]),
        stroke: () => drawCommand('stroke', []),
        setLineWidth: width => drawCommand('setLineWidth', [width]),
        setOperator: operator => drawCommand('setOperator', [operator]),
        text: (text, x, y, fontSize = 16, fontFamily = 'monospace') => {
            if (typeof text !== 'string' || [...text].length > 256)
                throw new RangeError('Drawing text must contain at most 256 characters');
            drawCommand('text', [text, x, y, fontSize, fontFamily]);
        },
    });
    ctx.blur = (radius = 20, brightness = 1) => {
        blur = radius === null ? null : {radius, brightness};
    };
    ctx.clock = options => {
        clock = options === null ? null : assign({visible: true}, options);
    };

    return (program, request) => {
        const frame = parse(request);
        commands = [];
        if (frame.event === 'init') {
            ctx.state = {};
            blur = null;
            clock = null;
        }
        for (const key of ['event', 'width', 'height', 'monitors', 'colors', 'now', 'delta', 'reducedMotion'])
            ctx[key] = frame[key];
        program(ctx);
        return stringify({commands, blur, clock});
    };
})();
