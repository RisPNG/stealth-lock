export const DEFAULT_EFFECT_PRESETS = [
    {
        name: 'Dim and Blur',
        code: String.raw`
if (ctx.event === 'destroy') {
    ctx.blur(null);
    return;
}

ctx.blur(20, 1);
ctx.draw.setOperator('source');
ctx.draw.setSourceRGBA(...ctx.colors.blur);
ctx.draw.paint();
`.trim(),
    },
    {
        name: 'Neo Rain',
        code: String.raw`
const options = {
    fontSize: 16,
    fontFamily: 'monospace',
    characters: 'ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789',
    density: 0.7,
    maxDrops: 3,
    speedMin: 0.3,
    speedMax: 1.2,
    lengthMin: 4,
    lengthMax: 40,
    fadeAlpha: 0.06,
};

class DigitalRain {
    constructor(width, height) {
        this.characters = [...options.characters];
        this.cellWidth = Math.ceil(options.fontSize * 0.75);
        this.cellHeight = Math.ceil(options.fontSize * 1.25);
        this.rows = Math.max(1, Math.floor(height / this.cellHeight));
        this.columns = Array.from({length: Math.min(512, Math.max(1, Math.floor(width / this.cellWidth)))}, () => ({
            droplets: [], cooldown: Math.floor(Math.random() * 31),
        }));
        this.cellWidth = width / this.columns.length;
        this.cursor = 0;
        for (const column of this.columns) {
            if (Math.random() < options.density * 0.3)
                this.spawnDroplet(column, true);
        }
        if (!this.columns.some(column => column.droplets.length))
            this.spawnDroplet(this.columns[Math.floor(this.columns.length / 2)], true);
    }

    spawnDroplet(column, visible = false) {
        const upperLength = Math.random() < 0.5 ? Math.min(options.lengthMax, Math.max(options.lengthMin, 15)) : options.lengthMax;
        const length = options.lengthMin + Math.floor(Math.random() * (upperLength - options.lengthMin + 1));
        column.droplets.push({
            y: visible ? Math.random() * this.rows : -Math.random() * length,
            speed: options.speedMin + Math.random() * (options.speedMax - options.speedMin),
            length,
            dieRow: Math.random() < 0.33 ? Math.floor(Math.random() * this.rows) : this.rows + length,
            characters: Array.from({length}, () => this.characters[Math.floor(Math.random() * this.characters.length)]),
        });
        column.cooldown = 3 + Math.floor(Math.random() * 48);
    }

    advance(draw, colors, delta, staticFrame = false) {
        const {background, foreground, head, glitch} = colors;
        const elapsed = staticFrame ? 0 : Math.min(3, Math.max(0, delta / 50));
        draw.setOperator('dest-out');
        draw.setSourceRGBA(...background.slice(0, 3), options.fadeAlpha);
        draw.paint();
        draw.setOperator('over');
        draw.setSourceRGBA(...background.slice(0, 3), background[3] * options.fadeAlpha);
        draw.paint();
        const glyphs = [];
        for (let i = 0; i < this.columns.length; i++) {
            const ci = (this.cursor + i) % this.columns.length;
            const column = this.columns[ci];
            for (const drop of column.droplets) {
                const headRow = Math.floor(drop.y);
                for (let row = Math.max(0, headRow - drop.length); row <= Math.min(this.rows - 1, headRow); row++) {
                    if (glyphs.length === 400)
                        break;
                    const distance = headRow - row;
                    const index = distance % drop.length;
                    if (!staticFrame && distance > 0 && Math.random() < 0.03)
                        drop.characters[index] = this.characters[Math.floor(Math.random() * this.characters.length)];
                    const intensity = distance <= 2 ? 0.95 : 0.3 + 0.6 * (1 - distance / drop.length);
                    glyphs.push({x: ci * this.cellWidth, y: row * this.cellHeight,
                        character: drop.characters[index],
                        color: distance === 0 ? head : foreground.map((component, channel) => channel < 3 ? component * intensity : component)});
                }
                drop.y += drop.speed * elapsed;
            }
            if (!staticFrame) {
                column.droplets = column.droplets.filter(drop =>
                    Math.floor(drop.y) - drop.length < this.rows && Math.floor(drop.y) < drop.dieRow + drop.length);
                column.cooldown = Math.max(0, column.cooldown - elapsed);
                if (!column.cooldown && column.droplets.length < options.maxDrops && Math.random() < 0.06 * options.density * elapsed)
                    this.spawnDroplet(column);
            }
        }
        this.cursor = (this.cursor + 17) % this.columns.length;
        draw.setOperator('source');
        draw.setSourceRGBA(...background);
        for (const glyph of glyphs)
            draw.rectangle(glyph.x, glyph.y, this.cellWidth, this.cellHeight);
        draw.fill();
        draw.setOperator('over');
        for (const glyph of glyphs) {
            draw.setSourceRGBA(...glyph.color);
            draw.text(glyph.character, glyph.x, glyph.y, options.fontSize, options.fontFamily);
        }
        const flashes = Math.min(16, Math.ceil(this.columns.length * this.rows * 0.001 * options.density));
        for (let i = 0; i < flashes; i++) {
            const x = Math.floor(Math.random() * this.columns.length) * this.cellWidth;
            const y = Math.floor(Math.random() * this.rows) * this.cellHeight;
            draw.setOperator('source');
            draw.setSourceRGBA(...background);
            draw.rectangle(x, y, this.cellWidth, this.cellHeight);
            draw.fill();
            draw.setOperator('over');
            draw.setSourceRGBA(...glitch);
            draw.text(this.characters[Math.floor(Math.random() * this.characters.length)], x, y, options.fontSize, options.fontFamily);
        }
    }
}

if (ctx.event === 'destroy') {
    delete ctx.state.scene;
    return;
}
if (ctx.event === 'init') {
    ctx.state.scene = new DigitalRain(ctx.width, ctx.height);
    ctx.draw.setOperator('source');
    ctx.draw.setSourceRGBA(...ctx.colors.background);
    ctx.draw.paint();
    ctx.state.scene.advance(ctx.draw, ctx.colors, 0, true);
} else if (!ctx.reducedMotion) {
    ctx.state.scene.advance(ctx.draw, ctx.colors, ctx.delta);
}
`.trim(),
    },
    {
        name: 'City Grow',
        code: String.raw`
const options = {
    scale: 3,
    startBranches: 3,
    lineWidth: 2,
    fillBlocks: true,
    fillAlpha: 0.25,
    reverse: true,
    reversePoints: 50,
    restartDelayMs: 1000,
    branchSpeedMultiplier: 1.2,
};

class CityBranch {
    constructor(city, position, paletteLength) {
        this.city = city;
        this.pos = position;
        this.state = 'RUNNING';
        this.mode = 'CITY';
        this.expandDirection = {x: 0, y: 0};
        this.ownFields = [{...position}];
        this.age = 0;
        this.lifeTime = 8000;
        this.paletteIndex = Math.floor(Math.random() * paletteLength);
        this.brightness = 1;
        this.jitter = (Math.random() * 2 - 1) * 0.1;
        const minimum = Math.min(options.branchSpeedMultiplier, 1 / options.branchSpeedMultiplier);
        const maximum = Math.max(options.branchSpeedMultiplier, 1 / options.branchSpeedMultiplier);
        this.speedFactor = minimum + Math.random() * (maximum - minimum);
        this.stepCarry = 0;
        this.history = [];
    }

    drawSegment(draw, colors, destination, origin = this.pos) {
        if (!this.city.segments)
            return false;
        this.city.segments--;
        const base = colors.palette[this.paletteIndex % colors.palette.length];
        const factor = Math.max(0.1, this.brightness * (1 + this.jitter));
        const [r, g, b] = base.slice(0, 3).map(component => Math.max(0, Math.min(1, component * factor)));
        if (options.fillBlocks && this.mode === 'CITY') {
            const last = this.ownFields.at(-1);
            for (const perpendicular of [
                {x: destination.y - last.y, y: destination.x - last.x},
                {x: last.y - destination.y, y: last.x - destination.x},
            ]) {
                const x = this.city.gridStep * Math.min(destination.x, last.x + perpendicular.x) + options.lineWidth;
                const y = this.city.gridStep * Math.min(destination.y, last.y + perpendicular.y) + options.lineWidth;
                const side = Math.max(0, this.city.gridStep - options.lineWidth);
                draw.setSourceRGBA(r, g, b, base[3] * options.fillAlpha);
                draw.rectangle(x, y, side, side);
                draw.fill();
                if (options.reverse) {
                    this.history.push({type: 'RECT', x, y, w: side, h: side});
                    this.city.historyLength++;
                }
            }
        }
        const offset = options.lineWidth / 2;
        const x1 = this.city.gridStep * origin.x + offset;
        const y1 = this.city.gridStep * origin.y + offset;
        const x2 = this.city.gridStep * destination.x + offset;
        const y2 = this.city.gridStep * destination.y + offset;
        draw.setLineWidth(options.lineWidth);
        draw.setSourceRGBA(r, g, b, base[3]);
        draw.moveTo(x1, y1);
        draw.lineTo(x2, y2);
        draw.stroke();
        if (options.reverse) {
            this.history.push({type: 'LINE', x1, y1, x2, y2});
            this.city.historyLength++;
        }
        this.pos = destination;
        this.ownFields.push(destination);
        if (this.ownFields.length > 300)
            this.ownFields.shift();
        return true;
    }

    findNextMove() {
        let free = this.city.freeNeighbors(this.pos);
        if (!free.length) {
            for (let i = this.ownFields.length - 1; i >= 0; i--) {
                free = this.city.freeNeighbors(this.ownFields[i]);
                if (free.length) {
                    this.pos = {...this.ownFields[i]};
                    break;
                }
            }
            if (!free.length) {
                this.state = 'STOPPED';
                return null;
            }
        }
        if (this.lifeTime - this.age < 15) {
            this.mode = 'CITY';
        } else if (this.mode === 'LAND') {
            const expandField = {x: this.pos.x + this.expandDirection.x, y: this.pos.y + this.expandDirection.y};
            if (free.some(field => field.x === expandField.x && field.y === expandField.y)) {
                for (let i = 0; i < 10; i++)
                    free.push(expandField);
            } else {
                this.mode = 'CITY';
                this.age = Math.round(Math.random() * this.age);
            }
        }
        return free[Math.floor(Math.random() * free.length)];
    }

    drawMove(draw, colors) {
        if (this.age >= this.lifeTime) {
            this.state = 'STOPPED';
            return;
        }
        if (this.mode === 'CITY' && Math.random() <= 0.12) {
            this.mode = 'LAND';
            const free = this.city.freeNeighbors(this.pos);
            if (free.length) {
                const target = free[Math.floor(Math.random() * free.length)];
                this.expandDirection = {x: target.x - this.pos.x, y: target.y - this.pos.y};
            }
        } else if (this.mode === 'LAND' && Math.random() <= 0.00003) {
            this.mode = 'CITY';
            this.age = Math.round(Math.random() * this.age);
        }
        const destination = this.findNextMove();
        if (destination && this.drawSegment(draw, colors, destination)) {
            this.age++;
            this.city.cells[destination.y * this.city.cols + destination.x] = 1;
        }
    }

    branchOff(draw, colors) {
        if (this.ownFields.length <= 1 || !this.city.segments)
            return null;
        const origin = this.ownFields.at(-1);
        const free = this.city.freeNeighbors(origin);
        if (!free.length)
            return null;
        const destination = free[Math.floor(Math.random() * free.length)];
        if (!this.drawSegment(draw, colors, destination, origin))
            return null;
        const branch = new CityBranch(this.city, {...this.pos}, colors.palette.length);
        branch.paletteIndex = this.paletteIndex;
        branch.brightness = 0.55;
        branch.lifeTime = 15;
        branch.jitter = this.jitter;
        this.city.cells[destination.y * this.city.cols + destination.x] = 1;
        return branch;
    }
}

class CityGrowth {
    constructor(width, height) {
        this.gridStep = Math.max(2, Math.round(options.scale) * 2, Math.ceil(Math.sqrt(width * height / 262144)));
        this.cols = Math.max(2, Math.floor(width / this.gridStep));
        this.rows = Math.max(2, Math.floor(height / this.gridStep));
        this.cells = new Uint8Array(this.cols * this.rows);
        this.branchList = [];
        this.allBranches = [];
        this.reverseRunning = false;
        this.restartAtMs = null;
        this.historyLength = 0;
        this.segments = 128;
        this.initialized = false;
    }

    freeNeighbors({x, y}) {
        const free = [];
        if (x + 1 < this.cols && !this.cells[y * this.cols + x + 1])
            free.push({x: x + 1, y});
        if (x - 1 >= 0 && !this.cells[y * this.cols + x - 1])
            free.push({x: x - 1, y});
        if (y + 1 < this.rows && !this.cells[(y + 1) * this.cols + x])
            free.push({x, y: y + 1});
        if (y - 1 >= 0 && !this.cells[(y - 1) * this.cols + x])
            free.push({x, y: y - 1});
        return free;
    }

    initializeCity(draw, colors) {
        draw.save();
        draw.setOperator('source');
        draw.setSourceRGBA(...colors.background);
        draw.paint();
        draw.restore();
        this.cells.fill(0);
        this.branchList = [];
        this.allBranches = [];
        this.reverseRunning = false;
        this.restartAtMs = null;
        this.historyLength = 0;
        for (let i = 0; i < Math.min(options.startBranches, 24, this.cells.length); i++) {
            let index = Math.floor(Math.random() * this.cells.length);
            if (this.cells[index])
                index = this.cells.indexOf(0);
            this.cells[index] = 1;
            this.branchList.push(new CityBranch(this, {x: index % this.cols, y: Math.floor(index / this.cols)}, colors.palette.length));
        }
        if (options.reverse)
            this.allBranches = this.branchList.slice();
        this.initialized = true;
    }

    advance(draw, colors, now, delta = 50) {
        if (!this.initialized || (this.restartAtMs !== null && now >= this.restartAtMs))
            this.initializeCity(draw, colors);
        if (this.restartAtMs !== null)
            return;
        if (this.reverseRunning) {
            const active = [];
            let remaining = Math.min(128, options.reversePoints);
            draw.save();
            draw.setOperator('source');
            draw.setSourceRGBA(...colors.background);
            for (const branch of this.allBranches) {
                const steps = Math.min(branch.history.length, remaining,
                    Math.ceil(options.reversePoints / Math.max(1, this.allBranches.length)));
                for (let i = 0; i < steps; i++) {
                    const action = branch.history.pop();
                    this.historyLength--;
                    remaining--;
                    if (action.type === 'RECT') {
                        draw.rectangle(action.x, action.y, action.w, action.h);
                        draw.fill();
                    } else {
                        draw.setLineWidth(options.lineWidth);
                        draw.moveTo(action.x1, action.y1);
                        draw.lineTo(action.x2, action.y2);
                        draw.stroke();
                    }
                }
                if (branch.history.length)
                    active.push(branch);
            }
            draw.restore();
            this.allBranches = active;
            if (!active.length)
                this.restartAtMs = now + options.restartDelayMs;
            return;
        }
        const elapsed = Math.min(3, Math.max(0, delta / 50));
        for (const branch of this.branchList.slice()) {
            if (this.branchList.length === 24)
                break;
            const falloff = 51 / (50 + Math.max(1, this.branchList.length));
            const probability = (branch.mode === 'CITY' ? 0.15 : 0.06) * falloff * branch.speedFactor * elapsed;
            if (Math.random() > probability)
                continue;
            const child = branch.branchOff(draw, colors);
            if (child) {
                if (Math.random() <= 0.01) {
                    child.brightness = 1;
                    child.paletteIndex++;
                    child.lifeTime = 8000;
                }
                this.branchList.push(child);
                if (options.reverse)
                    this.allBranches.push(child);
            }
        }
        this.branchList = this.branchList.filter(branch => {
            branch.stepCarry += Math.max(0.05, branch.speedFactor) * elapsed;
            let substeps = 0;
            while (branch.state === 'RUNNING' && branch.stepCarry >= 1 && substeps < 3 && this.segments) {
                branch.stepCarry--;
                branch.drawMove(draw, colors);
                substeps++;
            }
            branch.stepCarry = Math.min(branch.stepCarry, 4);
            return branch.state === 'RUNNING';
        });
        if (!this.branchList.length || this.historyLength >= 20000) {
            if (options.reverse)
                this.reverseRunning = true;
            else
                this.restartAtMs = now + options.restartDelayMs;
        }
    }
}

if (ctx.event === 'destroy') {
    delete ctx.state.scene;
    ctx.clock(null);
    return;
}
if (ctx.event === 'init') {
    ctx.clock({visible: true, format24h: true, seconds: true, date: true,
        align: 'center', topRatio: 0.14, offsetY: 0, fontSize: 64, dateFontSize: 20, monitor: 'settings'});
    ctx.state.scene = new CityGrowth(ctx.width, ctx.height);
    for (let i = 0; i < (ctx.reducedMotion ? 32 : 2); i++)
        ctx.state.scene.advance(ctx.draw, ctx.colors, ctx.now);
} else if (!ctx.reducedMotion) {
    ctx.state.scene.segments = 128;
    ctx.state.scene.advance(ctx.draw, ctx.colors, ctx.now, ctx.delta);
}
`.trim(),
    },
];
