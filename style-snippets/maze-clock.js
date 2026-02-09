// Maze Clock - CityGrow-style animated city background with configurable prompt + clock monitor target.
// Paste into: Extensions > Stealth Lock > Normal Prompt Custom JS
// Leave "Normal Prompt CSS" empty.
//
// Requires: lock-type = "normal"
//
// KNOBS ---------------------------------------------------------------------

// Prompt knobs
const SHOW_PASSWORD_FIELD = true;
const TEXT_CLEAR_WHEN_HIDDEN = true;
const SHOW_REVEAL_BUTTON_WITH_PASSWORD_FIELD = true;
const PROMPT_STYLE_VISIBLE =
  'background-color: rgba(0,0,0,0.60); '
  + 'border: 1px solid rgba(255,255,255,0.15); '
  + 'border-radius: 8px; padding: 10px 16px;';
const PROMPT_STYLE_HIDDEN = 'background-color: transparent; border: 0; padding: 0; spacing: 0;';
const PROMPT_TEXT_STYLE =
  'color: rgba(255,255,255,0.9); font-size: 20px; min-width: 220px; min-height: 24px; font-weight: 500; font-family: "Monaspace Krypton NF";';
const REVEAL_ICON_STYLE = 'color: rgba(255,255,255,0.5); icon-size: 20px;';

// CityGrow-style simulation knobs
const CITY_SCALE = 3;
const CITY_START_BRANCHES = 3;
const CITY_LINE_WIDTH = 2;
const CITY_FILL_BLOCKS = true;
const CITY_FILL_ALPHA = 0.25;
const CITY_SHOW_REVERSE = true;
const CITY_REVERSE_POINTS_BASE = 50;
const CITY_RESTART_DELAY_MS = 1000;
const CITY_BACKGROUND_RGBA = [0, 0, 0, 1];

// Branch behavior knobs
const CITY_LIFETIME_MAIN = 8000;
const CITY_LIFETIME_BRANCH = 15;
const CITY_PROP_CITY_TO_LAND = 12.0; // %
const CITY_PROP_LAND_TO_CITY = 0.003; // %
const CITY_PROP_BRANCH_OFF_CITY = 15; // %
const CITY_PROP_BRANCH_OFF_LAND = 6; // %
const CITY_PROP_BRANCH_TO_MAIN = 1; // %
const CITY_BRANCH_FALLOFF = 50;
const CITY_MAX_STEPS_BACK = 300;
const CITY_LAND_EXPAND_WEIGHT = 10;
const CITY_BRANCH_SPEED_MULTIPLIER = 1.2; // 1.2 => per-branch speed range is ~0.83x .. 1.2x
const CITY_BRANCH_MAX_SUBSTEPS_PER_TICK = 3; // safety cap for very high multipliers

// Palette-based color knobs (no hue-gradient maze coloring)
const CITY_PALETTE = [
  [0.20, 0.95, 1.00], // cyan
  [0.30, 1.00, 0.72], // mint
  [0.95, 0.78, 0.30], // amber
  [1.00, 0.46, 0.24], // orange
  [0.90, 0.40, 0.75], // magenta
];
const CITY_MAIN_BRIGHTNESS = 1.0;
const CITY_BRANCH_BRIGHTNESS = 0.55;
const CITY_COLOR_JITTER = 0.10;
const CITY_COLOR_SHIFT_ON_NEW_MAIN = 1;

// Animation knob
const ANIMATION_INTERVAL_MS = 50;

// Clock knobs
const SHOW_CLOCK = true;
const CLOCK_USE_24H = true;
const CLOCK_SHOW_SECONDS = true;
const CLOCK_SHOW_DATE = true;
const CLOCK_TOP_RATIO = 0.14;
const CLOCK_VERTICAL_OFFSET_PX = 0;
const CLOCK_HORIZONTAL_ALIGN = 'center'; // 'left' | 'center' | 'right'
const CLOCK_SIDE_MARGIN_PX = 24;
const CLOCK_TIME_STYLE = 'color: white; font-size: 64px; font-weight: 700; font-family: "Google Sans";';
const CLOCK_DATE_STYLE = 'color: rgba(255,255,255,0.70); font-size: 20px; font-weight: 500; margin-top: 6px; font-family: "Google Sans";';
// CLOCK_MONITOR_MODE:
// - 'all'      => top-middle across all monitors
// - 'settings' => use Stealth Lock's "Prompt Monitor" setting (falls back to 'all')
// - 'manual'   => use CLOCK_MANUAL_MONITOR_INDEX below
const CLOCK_MONITOR_MODE = 'settings';
const CLOCK_MANUAL_MONITOR_INDEX = 0;

if (ctx.event === 'init') {
  if (ctx.prompt._maze) return;

  const { St, GLib, cairo: Cairo, Clutter, Pango } = ctx.gi;
  if (!Cairo) return;

  const overlay = ctx.prompt.get_parent();
  if (!overlay) return;

  const w = overlay.width || global.stage.width || 1920;
  const h = overlay.height || global.stage.height || 1080;

  // Prompt style/state
  if (SHOW_PASSWORD_FIELD) {
    ctx.prompt.style = PROMPT_STYLE_VISIBLE;
    ctx.prompt.reactive = true;

    if (ctx.text) {
      ctx.text.visible = true;
      ctx.text.style = PROMPT_TEXT_STYLE;
    }

    if (ctx.revealButton) {
      const revealVisible = SHOW_REVEAL_BUTTON_WITH_PASSWORD_FIELD;
      ctx.revealButton.visible = revealVisible;
      ctx.revealButton.reactive = revealVisible;
      if (revealVisible) {
        const icon = ctx.revealButton.get_child();
        if (icon)
          icon.style = REVEAL_ICON_STYLE;
      }
    }
  } else {
    ctx.prompt.style = PROMPT_STYLE_HIDDEN;
    ctx.prompt.reactive = false;

    if (ctx.text)
      ctx.text.visible = false;

    if (ctx.revealButton) {
      ctx.revealButton.visible = false;
      ctx.revealButton.reactive = false;
    }
  }

  // Drawing state
  const gridStep = Math.max(2, Math.round(CITY_SCALE) * 2);
  const cols = Math.max(2, Math.floor(w / gridStep));
  const rows = Math.max(2, Math.floor(h / gridStep));
  let cells = new Uint8Array(cols * rows);
  let branchList = [];
  let allBranches = [];
  let reverseRunning = false;
  let restartAtMs = 0;

  // Off-screen Cairo surface (incremental drawing)
  const surf = new Cairo.ImageSurface(Cairo.Format.ARGB32, w, h);
  const sCr = new Cairo.Context(surf);

  function paintBackground() {
    sCr.setSourceRGBA(
      CITY_BACKGROUND_RGBA[0],
      CITY_BACKGROUND_RGBA[1],
      CITY_BACKGROUND_RGBA[2],
      CITY_BACKGROUND_RGBA[3],
    );
    sCr.paint();
  }
  paintBackground();

  function clamp01(v) {
    return Math.max(0, Math.min(1, v));
  }

  function randomInt(maxExclusive) {
    if (maxExclusive <= 0) return 0;
    return Math.floor(Math.random() * maxExclusive);
  }

  function randomChoice(list) {
    return list[randomInt(list.length)];
  }

  function getBranchSpeedFactor() {
    const mult = Math.max(1, Number(CITY_BRANCH_SPEED_MULTIPLIER) || 1);
    const min = 1 / mult;
    const max = mult;
    return min + Math.random() * (max - min);
  }

  class Pos {
    constructor(x, y) {
      this.x = x;
      this.y = y;
    }

    toIdx(offX = 0, offY = 0) {
      return (this.y + offY) * cols + (this.x + offX);
    }

    static fromIdx(idx) {
      const y = Math.floor(idx / cols);
      const x = idx - y * cols;
      return new Pos(x, y);
    }
  }

  function randomPos() {
    return Pos.fromIdx(randomInt(cols * rows));
  }

  function paletteRGB(index, brightness, jitter) {
    const len = Math.max(1, CITY_PALETTE.length);
    const ii = ((index % len) + len) % len;
    const base = CITY_PALETTE[ii];
    const factor = Math.max(0.1, brightness * (1 + jitter));
    return [
      clamp01(base[0] * factor),
      clamp01(base[1] * factor),
      clamp01(base[2] * factor),
    ];
  }

  class Branch {
    constructor(pos) {
      this.pos = pos;
      this.state = 'RUNNING';
      this.mode = 'CITY';
      this.expandDirection = new Pos(0, 0);
      this.ownFields = [new Pos(pos.x, pos.y)];
      this.age = 0;
      this.lifeTime = CITY_LIFETIME_MAIN;
      this.paletteIndex = randomInt(Math.max(1, CITY_PALETTE.length));
      this.brightness = CITY_MAIN_BRIGHTNESS;
      this.jitter = (Math.random() * 2 - 1) * CITY_COLOR_JITTER;
      this.speedFactor = getBranchSpeedFactor();
      this.stepCarry = 0;
      this.history = [];
    }

    getColorRGB() {
      return paletteRGB(this.paletteIndex, this.brightness, this.jitter);
    }

    drawFillCell(leftTop) {
      const margin = CITY_LINE_WIDTH / 2;
      const offset = CITY_LINE_WIDTH / 2;
      const x = gridStep * leftTop.x + margin + offset;
      const y = gridStep * leftTop.y + margin + offset;
      const side = Math.max(0, gridStep - 2 * margin);

      const [r, g, b] = this.getColorRGB();
      sCr.setSourceRGBA(r, g, b, CITY_FILL_ALPHA);
      sCr.rectangle(x, y, side, side);
      sCr.fill();

      this.history.push({
        type: 'RECT',
        x,
        y,
        w: side,
        h: side,
      });
    }

    createLine(toPos, fromPos = null) {
      const startPos = fromPos || this.pos;

      if (CITY_FILL_BLOCKS && this.mode === 'CITY' && this.ownFields.length >= 1) {
        const lastPos = this.ownFields[this.ownFields.length - 1];

        let perpendicular = new Pos(toPos.y - lastPos.y, toPos.x - lastPos.x);
        let imaginaryPoint = new Pos(lastPos.x + perpendicular.x, lastPos.y + perpendicular.y);
        let leftTop = new Pos(Math.min(toPos.x, imaginaryPoint.x), Math.min(toPos.y, imaginaryPoint.y));
        this.drawFillCell(leftTop);

        perpendicular = new Pos(lastPos.y - toPos.y, lastPos.x - toPos.x);
        imaginaryPoint = new Pos(lastPos.x + perpendicular.x, lastPos.y + perpendicular.y);
        leftTop = new Pos(Math.min(toPos.x, imaginaryPoint.x), Math.min(toPos.y, imaginaryPoint.y));
        this.drawFillCell(leftTop);
      }

      const offset = CITY_LINE_WIDTH / 2;
      const [r, g, b] = this.getColorRGB();
      const x1 = gridStep * startPos.x + offset;
      const y1 = gridStep * startPos.y + offset;
      const x2 = gridStep * toPos.x + offset;
      const y2 = gridStep * toPos.y + offset;

      sCr.setLineWidth(CITY_LINE_WIDTH);
      sCr.setSourceRGBA(r, g, b, 1);
      sCr.moveTo(x1, y1);
      sCr.lineTo(x2, y2);
      sCr.stroke();

      this.history.push({
        type: 'LINE',
        x1,
        y1,
        x2,
        y2,
      });

      this.pos = toPos;
      this.ownFields.push(toPos);
    }

    static reverseEntry(entry) {
      sCr.setSourceRGBA(
        CITY_BACKGROUND_RGBA[0],
        CITY_BACKGROUND_RGBA[1],
        CITY_BACKGROUND_RGBA[2],
        CITY_BACKGROUND_RGBA[3],
      );

      if (entry.type === 'RECT') {
        sCr.rectangle(entry.x, entry.y, entry.w, entry.h);
        sCr.fill();
        return;
      }

      sCr.setLineWidth(CITY_LINE_WIDTH);
      sCr.moveTo(entry.x1, entry.y1);
      sCr.lineTo(entry.x2, entry.y2);
      sCr.stroke();
    }

    moveToNewPos() {
      const stopAt = Math.max(0, this.ownFields.length - CITY_MAX_STEPS_BACK);
      for (let i = this.ownFields.length - 1; i >= stopAt; i--) {
        const testPos = this.ownFields[i];
        if (this.getFreeFields(testPos).length > 0) {
          this.pos = new Pos(testPos.x, testPos.y);
          return true;
        }
      }
      return false;
    }

    getFreeFields(pos = null) {
      const p = pos || this.pos;
      const free = [];

      if (p.x + 1 < cols && cells[p.toIdx(1, 0)] === 0)
        free.push(new Pos(p.x + 1, p.y));
      if (p.x - 1 >= 0 && cells[p.toIdx(-1, 0)] === 0)
        free.push(new Pos(p.x - 1, p.y));
      if (p.y + 1 < rows && cells[p.toIdx(0, 1)] === 0)
        free.push(new Pos(p.x, p.y + 1));
      if (p.y - 1 >= 0 && cells[p.toIdx(0, -1)] === 0)
        free.push(new Pos(p.x, p.y - 1));

      return free;
    }

    findNextMove() {
      if (this.state !== 'RUNNING')
        return null;

      const free = this.getFreeFields();
      if (!free.length) {
        if (this.moveToNewPos())
          return this.findNextMove();
        this.state = 'STOPPED';
        return null;
      }

      if (this.lifeTime - this.age < CITY_LIFETIME_BRANCH) {
        this.mode = 'CITY';
      } else if (this.mode === 'LAND') {
        const expandField = new Pos(
          this.pos.x + this.expandDirection.x,
          this.pos.y + this.expandDirection.y,
        );
        const canExpand = free.some(field => field.x === expandField.x && field.y === expandField.y);
        if (canExpand) {
          for (let i = 0; i < CITY_LAND_EXPAND_WEIGHT; i++)
            free.push(expandField);
        } else {
          this.mode = 'CITY';
          this.age = Math.round(Math.random() * this.age);
        }
      }

      return randomChoice(free);
    }

    setExpandDirection() {
      const free = this.getFreeFields();
      if (!free.length)
        return;
      const target = randomChoice(free);
      this.expandDirection = new Pos(target.x - this.pos.x, target.y - this.pos.y);
    }

    drawMove() {
      if (this.age >= this.lifeTime) {
        this.state = 'STOPPED';
        return;
      }

      if (this.mode === 'CITY' && Math.random() <= CITY_PROP_CITY_TO_LAND / 100.0) {
        this.mode = 'LAND';
        this.setExpandDirection();
      } else if (this.mode === 'LAND' && Math.random() <= CITY_PROP_LAND_TO_CITY / 100.0) {
        this.mode = 'CITY';
        this.age = Math.round(Math.random() * this.age);
      }

      const newPos = this.findNextMove();
      if (!newPos)
        return;

      this.createLine(newPos);
      this.age++;
      cells[newPos.toIdx()] = 1;
    }

    setMain() {
      this.brightness = CITY_MAIN_BRIGHTNESS;
      this.paletteIndex += CITY_COLOR_SHIFT_ON_NEW_MAIN;
      this.lifeTime = CITY_LIFETIME_MAIN;
    }

    branchOff() {
      if (this.ownFields.length <= 1)
        return null;

      const searchPos = this.ownFields[this.ownFields.length - 1];
      const free = this.getFreeFields(searchPos);
      if (!free.length)
        return null;

      const newPos = randomChoice(free);
      this.createLine(newPos, searchPos);

      const newBranch = new Branch(new Pos(this.pos.x, this.pos.y));
      newBranch.paletteIndex = this.paletteIndex;
      newBranch.brightness = CITY_BRANCH_BRIGHTNESS;
      newBranch.lifeTime = CITY_LIFETIME_BRANCH;
      newBranch.jitter = this.jitter;
      cells[newPos.toIdx()] = 1;
      return newBranch;
    }
  }

  function initializeCity() {
    paintBackground();
    cells = new Uint8Array(cols * rows);
    branchList = [];
    allBranches = [];
    reverseRunning = false;
    restartAtMs = 0;

    for (let i = 0; i < CITY_START_BRANCHES; i++)
      branchList.push(new Branch(randomPos()));
    allBranches = branchList.slice();
  }

  function scheduleRestart() {
    if (restartAtMs > 0) return;
    restartAtMs = Date.now() + Math.max(0, CITY_RESTART_DELAY_MS);
  }

  function tickCity() {
    if (restartAtMs > 0 && Date.now() >= restartAtMs) {
      initializeCity();
      return;
    }

    if (reverseRunning) {
      if (!CITY_SHOW_REVERSE) {
        scheduleRestart();
        return;
      }

      const active = [];
      const reversePoints = Math.ceil(CITY_REVERSE_POINTS_BASE / Math.max(1, allBranches.length));
      for (const branch of allBranches) {
        if (!branch.history.length)
          continue;

        const steps = Math.min(branch.history.length, reversePoints);
        for (let i = 0; i < steps; i++) {
          const action = branch.history.pop();
          Branch.reverseEntry(action);
        }

        if (branch.history.length)
          active.push(branch);
      }

      allBranches = active;
      if (!allBranches.length)
        scheduleRestart();
      return;
    }

    for (const oldBranch of branchList.slice()) {
      const scaledBranchOff = CITY_PROP_BRANCH_OFF_CITY
        * (1.0 + CITY_BRANCH_FALLOFF)
        / (CITY_BRANCH_FALLOFF + Math.max(1, branchList.length));
      const scaledBranchOffLand = CITY_PROP_BRANCH_OFF_LAND
        * (1.0 + CITY_BRANCH_FALLOFF)
        / (CITY_BRANCH_FALLOFF + Math.max(1, branchList.length));
      const speedScale = Math.max(0.05, oldBranch.speedFactor || 1);

      const canBranch = (
        (oldBranch.mode === 'CITY' && Math.random() <= (scaledBranchOff * speedScale) / 100.0)
        || (oldBranch.mode === 'LAND' && Math.random() <= (scaledBranchOffLand * speedScale) / 100.0)
      );

      if (!canBranch)
        continue;

      const newBranch = oldBranch.branchOff();
      if (!newBranch)
        continue;

      if (Math.random() <= CITY_PROP_BRANCH_TO_MAIN / 100.0)
        newBranch.setMain();
      branchList.push(newBranch);
      allBranches.push(newBranch);
    }

    branchList = branchList.filter(branch => {
      const speed = Math.max(0.05, branch.speedFactor || 1);
      branch.stepCarry = (branch.stepCarry || 0) + speed;

      let n = 0;
      while (
        branch.state === 'RUNNING'
        && branch.stepCarry >= 1
        && n < Math.max(1, CITY_BRANCH_MAX_SUBSTEPS_PER_TICK)
      ) {
        branch.stepCarry -= 1;
        branch.drawMove();
        n++;
      }

      const carryCap = Math.max(2, CITY_BRANCH_MAX_SUBSTEPS_PER_TICK + 1);
      if (branch.stepCarry > carryCap)
        branch.stepCarry = carryCap;
      return branch.state === 'RUNNING';
    });

    if (!branchList.length) {
      if (CITY_SHOW_REVERSE)
        reverseRunning = true;
      else
        scheduleRestart();
    }
  }

  initializeCity();

  // St.DrawingArea (blits the off-screen surface)
  const mazeArea = new St.DrawingArea();
  mazeArea.set_size(w, h);
  mazeArea.set_position(0, 0);
  overlay.insert_child_below(mazeArea, ctx.prompt);

  mazeArea.connect('repaint', () => {
    const cr = mazeArea.get_context();
    cr.setSourceSurface(surf, 0, 0);
    cr.paint();
    cr.$dispose();
  });
  mazeArea.queue_repaint();

  // Clock (St labels)
  const DAYS = [
    'Sunday', 'Monday', 'Tuesday', 'Wednesday',
    'Thursday', 'Friday', 'Saturday',
  ];
  const MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];

  let clock = null;
  let tLbl = null;
  let dLbl = null;

  function centerLabel(label) {
    if (!label) return;
    try { label.set_x_align(Clutter.ActorAlign.CENTER); } catch (e) {}
    try { label.set_x_expand(true); } catch (e) {}

    try {
      const text = label.clutter_text
        || (typeof label.get_clutter_text === 'function' ? label.get_clutter_text() : null);
      if (text && typeof text.set_line_alignment === 'function' && Pango && Pango.Alignment)
        text.set_line_alignment(Pango.Alignment.CENTER);
    } catch (e) {}
  }

  if (SHOW_CLOCK) {
    tLbl = new St.Label({ text: '' });
    tLbl.style = CLOCK_TIME_STYLE + ' text-align: center;';
    centerLabel(tLbl);

    clock = new St.BoxLayout({ vertical: true });
    try { clock.set_x_align(Clutter.ActorAlign.CENTER); } catch (e) {}
    clock.add_child(tLbl);

    if (CLOCK_SHOW_DATE) {
      dLbl = new St.Label({ text: '' });
      dLbl.style = CLOCK_DATE_STYLE + ' text-align: center;';
      centerLabel(dLbl);
      clock.add_child(dLbl);
    }

    overlay.insert_child_below(clock, ctx.prompt);
  }

  function getCombinedRect() {
    return {
      x: 0,
      y: 0,
      width: overlay.width || w,
      height: overlay.height || h,
    };
  }

  function getMonitorRect(index) {
    if (!Number.isInteger(index) || index < 0) return null;
    if (!global.display?.get_n_monitors || !global.display?.get_monitor_geometry)
      return null;

    const nMonitors = global.display.get_n_monitors();
    if (index >= nMonitors) return null;

    const g = global.display.get_monitor_geometry(index);
    if (!g) return null;

    const originX = overlay._originX ?? 0;
    const originY = overlay._originY ?? 0;
    return {
      x: g.x - originX,
      y: g.y - originY,
      width: g.width,
      height: g.height,
    };
  }

  function getSettingsMonitorIndex() {
    try {
      const raw = (ctx.settings?.get_string('normal-prompt-monitor') ?? '').trim();
      if (!raw) return null;
      if (!/^-?\d+$/.test(raw)) return null;
      const idx = Number(raw);
      return Number.isInteger(idx) ? idx : null;
    } catch (e) {
      return null;
    }
  }

  function getClockTargetRect() {
    if (CLOCK_MONITOR_MODE === 'manual')
      return getMonitorRect(CLOCK_MANUAL_MONITOR_INDEX) || getCombinedRect();

    if (CLOCK_MONITOR_MODE === 'settings') {
      const idx = getSettingsMonitorIndex();
      if (Number.isInteger(idx))
        return getMonitorRect(idx) || getCombinedRect();
      return getCombinedRect();
    }

    return getCombinedRect();
  }

  function formatClockTime(date) {
    let hours = date.getHours();
    let suffix = '';

    if (!CLOCK_USE_24H) {
      suffix = hours >= 12 ? ' PM' : ' AM';
      hours = hours % 12 || 12;
    }

    const parts = [hours, date.getMinutes()];
    if (CLOCK_SHOW_SECONDS)
      parts.push(date.getSeconds());

    return parts
      .map((value, i) => (i === 0 && !CLOCK_USE_24H ? String(value) : String(value).padStart(2, '0')))
      .join(':') + suffix;
  }

  function tickClock() {
    if (!clock || !tLbl) return;

    const d = new Date();
    tLbl.text = formatClockTime(d);
    if (dLbl) {
      dLbl.text = DAYS[d.getDay()] + ', ' + d.getDate() + ' '
                + MONTHS[d.getMonth()] + ' ' + d.getFullYear();
    }

    const target = getClockTargetRect();
    const overlayW = overlay.width || w;
    const overlayH = overlay.height || h;
    const [, prefTimeW] = tLbl.get_preferred_width(-1);
    const [, prefTimeH] = tLbl.get_preferred_height(-1);
    let prefDateW = 0;
    let prefDateH = 0;
    if (dLbl) {
      [, prefDateW] = dLbl.get_preferred_width(-1);
      [, prefDateH] = dLbl.get_preferred_height(-1);
    }

    const clockW = Math.max(prefTimeW || 0, prefDateW || 0, 300);
    clock.set_width(clockW);
    const [, prefClockH] = clock.get_preferred_height(clockW);
    const clockH = Math.max(prefClockH || 0, prefTimeH || 0, prefDateH || 0, 80);
    clock.set_size(clockW, clockH);

    let x;
    if (CLOCK_HORIZONTAL_ALIGN === 'left') {
      x = target.x + CLOCK_SIDE_MARGIN_PX;
    } else if (CLOCK_HORIZONTAL_ALIGN === 'right') {
      x = target.x + target.width - clockW - CLOCK_SIDE_MARGIN_PX;
    } else {
      x = target.x + Math.round((target.width - clockW) / 2);
    }

    let y = target.y + Math.round(target.height * CLOCK_TOP_RATIO) + CLOCK_VERTICAL_OFFSET_PX;

    x = Math.max(0, Math.min(x, Math.max(0, overlayW - clockW)));
    y = Math.max(0, Math.min(y, Math.max(0, overlayH - clockH)));
    clock.set_position(x, y);
  }
  tickClock();

  // Animation loop
  const tid = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ANIMATION_INTERVAL_MS, () => {
    tickCity();
    mazeArea.queue_repaint();
    tickClock();
    return true;
  });

  // Cleanup on destroy
  ctx.prompt._maze = { mazeArea, clock, tid };
  ctx.prompt.connect('destroy', () => {
    const m = ctx.prompt._maze;
    if (!m) return;
    try { GLib.source_remove(m.tid); } catch (e) {}
    try { surf.finish(); } catch (e) {}
    if (m.clock) {
      try { m.clock.destroy(); } catch (e) {}
    }
    try { m.mazeArea.destroy(); } catch (e) {}
    ctx.prompt._maze = null;
  });
}

if (ctx.event === 'update') {
  if (!SHOW_PASSWORD_FIELD) {
    if (TEXT_CLEAR_WHEN_HIDDEN && ctx.text)
      ctx.text.text = '';
  } else if (ctx.text) {
    ctx.text.style = PROMPT_TEXT_STYLE;
  }
}
