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
        const multiplier = city.knobs.branchSpeedMultiplier;
        const minimum = Math.min(multiplier, 1 / multiplier);
        const maximum = Math.max(multiplier, 1 / multiplier);
        this.speedFactor = minimum + Math.random() * (maximum - minimum);
        this.stepCarry = 0;
        this.history = [];
    }

    drawSegment(cr, colors, destination, origin = this.pos) {
        const k = this.city.knobs;
        const base = colors.palette[this.paletteIndex % colors.palette.length];
        const factor = Math.max(0.1, this.brightness * (1 + this.jitter));
        const [r, g, b] = base.slice(0, 3).map(component => Math.max(0, Math.min(1, component * factor)));
        if (k.fillBlocks && this.mode === 'CITY') {
            const last = this.ownFields.at(-1);
            for (const perpendicular of [
                {x: destination.y - last.y, y: destination.x - last.x},
                {x: last.y - destination.y, y: last.x - destination.x},
            ]) {
                const x = this.city.gridStep * Math.min(destination.x, last.x + perpendicular.x) + k.lineWidth;
                const y = this.city.gridStep * Math.min(destination.y, last.y + perpendicular.y) + k.lineWidth;
                const side = Math.max(0, this.city.gridStep - k.lineWidth);
                cr.setSourceRGBA(r, g, b, base[3] * k.fillAlpha);
                cr.rectangle(x, y, side, side);
                cr.fill();
                if (k.reverse)
                    this.history.push({type: 'RECT', x, y, w: side, h: side});
            }
        }
        const offset = k.lineWidth / 2;
        const x1 = this.city.gridStep * origin.x + offset;
        const y1 = this.city.gridStep * origin.y + offset;
        const x2 = this.city.gridStep * destination.x + offset;
        const y2 = this.city.gridStep * destination.y + offset;
        cr.setLineWidth(k.lineWidth);
        cr.setSourceRGBA(r, g, b, base[3]);
        cr.moveTo(x1, y1);
        cr.lineTo(x2, y2);
        cr.stroke();
        if (k.reverse)
            this.history.push({type: 'LINE', x1, y1, x2, y2});
        this.pos = destination;
        this.ownFields.push(destination);
    }

    findNextMove() {
        if (this.state !== 'RUNNING')
            return null;
        let free = this.city.freeNeighbors(this.pos);
        if (!free.length) {
            const stopAt = Math.max(0, this.ownFields.length - 300);
            for (let i = this.ownFields.length - 1; i >= stopAt; i--) {
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

    drawMove(cr, colors) {
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
        if (!destination)
            return;
        this.drawSegment(cr, colors, destination);
        this.age++;
        this.city.cells[destination.y * this.city.cols + destination.x] = 1;
    }

    branchOff(cr, colors) {
        if (this.ownFields.length <= 1)
            return null;
        const origin = this.ownFields.at(-1);
        const free = this.city.freeNeighbors(origin);
        if (!free.length)
            return null;
        const destination = free[Math.floor(Math.random() * free.length)];
        this.drawSegment(cr, colors, destination, origin);
        const branch = new CityBranch(this.city, {...this.pos}, colors.palette.length);
        branch.paletteIndex = this.paletteIndex;
        branch.brightness = 0.55;
        branch.lifeTime = 15;
        branch.jitter = this.jitter;
        this.city.cells[destination.y * this.city.cols + destination.x] = 1;
        return branch;
    }
}

export class CityGrowth {
    constructor(width, height, knobs) {
        this.knobs = knobs;
        this.gridStep = Math.max(2, Math.round(knobs.scale) * 2);
        this.cols = Math.max(2, Math.floor(width / this.gridStep));
        this.rows = Math.max(2, Math.floor(height / this.gridStep));
        this.cells = new Uint8Array(this.cols * this.rows);
        this.branchList = [];
        this.allBranches = [];
        this.reverseRunning = false;
        this.restartAtMs = null;
        this._initialized = false;
    }

    freeNeighbors(position) {
        const free = [];
        const {x, y} = position;
        if (x + 1 < this.cols && this.cells[y * this.cols + x + 1] === 0)
            free.push({x: x + 1, y});
        if (x - 1 >= 0 && this.cells[y * this.cols + x - 1] === 0)
            free.push({x: x - 1, y});
        if (y + 1 < this.rows && this.cells[(y + 1) * this.cols + x] === 0)
            free.push({x, y: y + 1});
        if (y - 1 >= 0 && this.cells[(y - 1) * this.cols + x] === 0)
            free.push({x, y: y - 1});
        return free;
    }

    initializeCity(cr, colors) {
        cr.save();
        cr.setOperator(Cairo.Operator.SOURCE);
        cr.setSourceRGBA(...colors.background);
        cr.paint();
        cr.restore();
        this.cells.fill(0);
        this.branchList = [];
        this.allBranches = [];
        this.reverseRunning = false;
        this.restartAtMs = null;
        for (let i = 0; i < Math.min(this.knobs.startBranches, this.cells.length); i++) {
            let index = Math.floor(Math.random() * this.cells.length);
            if (this.cells[index])
                index = this.cells.indexOf(0);
            this.cells[index] = 1;
            const position = {x: index % this.cols, y: Math.floor(index / this.cols)};
            this.branchList.push(new CityBranch(this, position, colors.palette.length));
        }
        if (this.knobs.reverse)
            this.allBranches = this.branchList.slice();
        this._initialized = true;
    }

    advance(cr, colors, nowMs = Date.now()) {
        if (!this._initialized || (this.restartAtMs !== null && nowMs >= this.restartAtMs)) {
            this.initializeCity(cr, colors);
            return;
        }
        if (this.restartAtMs !== null)
            return;
        if (this.reverseRunning) {
            const active = [];
            const reversePoints = Math.ceil(this.knobs.reversePoints / Math.max(1, this.allBranches.length));
            cr.save();
            cr.setOperator(Cairo.Operator.SOURCE);
            cr.setSourceRGBA(...colors.background);
            for (const branch of this.allBranches) {
                const steps = Math.min(branch.history.length, reversePoints);
                for (let i = 0; i < steps; i++) {
                    const action = branch.history.pop();
                    if (action.type === 'RECT') {
                        cr.rectangle(action.x, action.y, action.w, action.h);
                        cr.fill();
                    } else {
                        cr.setLineWidth(this.knobs.lineWidth);
                        cr.moveTo(action.x1, action.y1);
                        cr.lineTo(action.x2, action.y2);
                        cr.stroke();
                    }
                }
                if (branch.history.length)
                    active.push(branch);
            }
            cr.restore();
            this.allBranches = active;
            if (!active.length)
                this.restartAtMs = nowMs + this.knobs.restartDelayMs;
            return;
        }
        for (const branch of this.branchList.slice()) {
            const falloff = 51 / (50 + Math.max(1, this.branchList.length));
            const probability = (branch.mode === 'CITY' ? 0.15 : 0.06) * falloff * branch.speedFactor;
            if (Math.random() > probability)
                continue;
            const child = branch.branchOff(cr, colors);
            if (!child)
                continue;
            if (Math.random() <= 0.01) {
                child.brightness = 1;
                child.paletteIndex++;
                child.lifeTime = 8000;
            }
            this.branchList.push(child);
            if (this.knobs.reverse)
                this.allBranches.push(child);
        }
        this.branchList = this.branchList.filter(branch => {
            branch.stepCarry += Math.max(0.05, branch.speedFactor);
            let substeps = 0;
            while (branch.state === 'RUNNING' && branch.stepCarry >= 1 && substeps < 3) {
                branch.stepCarry--;
                branch.drawMove(cr, colors);
                substeps++;
            }
            branch.stepCarry = Math.min(branch.stepCarry, 4);
            return branch.state === 'RUNNING';
        });
        if (!this.branchList.length) {
            if (this.knobs.reverse)
                this.reverseRunning = true;
            else
                this.restartAtMs = nowMs + this.knobs.restartDelayMs;
        }
    }
}
import Cairo from 'cairo';
