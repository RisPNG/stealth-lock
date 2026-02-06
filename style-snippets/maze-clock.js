// Maze Clock – animated maze background with configurable password field + clock monitor target.
// Paste into: Extensions > Stealth Lock > Normal Prompt Custom JS
// Leave "Normal Prompt CSS" empty.
//
// Requires: lock-type = "normal"
//
// KNOBS:
const SHOW_PASSWORD_FIELD = true;
// CLOCK_MONITOR_MODE:
// - 'all'      => top-middle across all monitors
// - 'settings' => use Stealth Lock's "Prompt Monitor" setting (falls back to 'all')
// - 'manual'   => use CLOCK_MANUAL_MONITOR_INDEX below
const CLOCK_MONITOR_MODE = 'settings';
const CLOCK_MANUAL_MONITOR_INDEX = 0;

if (ctx.event === 'init') {
  if (ctx.prompt._maze) return;

  const { St, GLib, cairo: Cairo } = ctx.gi;
  if (!Cairo) return;

  const overlay = ctx.prompt.get_parent();
  if (!overlay) return;

  const w = overlay.width || global.stage.width || 1920;
  const h = overlay.height || global.stage.height || 1080;

  // ── Prompt style knob ──────────────────────────────
  if (SHOW_PASSWORD_FIELD) {
    ctx.prompt.style =
      'background-color: rgba(0,0,0,0.60); '
    + 'border: 1px solid rgba(255,255,255,0.15); '
    + 'border-radius: 8px; padding: 10px 16px;';
    ctx.prompt.reactive = true;

    if (ctx.text) {
      ctx.text.visible = true;
      ctx.text.style = 'color: rgba(255,255,255,0.9); font-size: 20px; '
                     + 'min-width: 220px; min-height: 24px;';
    }

    if (ctx.revealButton) {
      ctx.revealButton.visible = true;
      ctx.revealButton.reactive = true;
      const ico = ctx.revealButton.get_child();
      if (ico)
        ico.style = 'color: rgba(255,255,255,0.5); icon-size: 20px;';
    }
  } else {
    ctx.prompt.style = 'background-color: transparent; border: 0; padding: 0; spacing: 0;';
    ctx.prompt.reactive = false;

    if (ctx.text)
      ctx.text.visible = false;

    if (ctx.revealButton) {
      ctx.revealButton.visible = false;
      ctx.revealButton.reactive = false;
    }
  }

  // ── Maze grid ──────────────────────────────────────
  const CELL = 6;
  const cols = Math.floor(w / CELL);
  const rows = Math.floor(h / CELL);
  const vis = new Uint8Array(cols * rows);
  let walkers = [];

  // ── Off-screen Cairo surface (incremental drawing) ─
  const surf = new Cairo.ImageSurface(Cairo.Format.ARGB32, w, h);
  const sCr = new Cairo.Context(surf);
  sCr.setSourceRGBA(0, 0, 0, 1);
  sCr.paint();
  sCr.setLineWidth(1.5);

  // ── Colour: position-based hue gradient ────────────
  function hsl(deg, s, l) {
    const n = deg / 360;
    const a = s * Math.min(l, 1 - l);
    const f = t => {
      const k = (t + n * 12) % 12;
      return l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    };
    return [f(0), f(8), f(4)];
  }

  function cellRGB(cx, cy) {
    const d = Math.hypot(cx / cols, cy / rows) / Math.SQRT2;
    return hsl(20 + d * 175, 0.85, 0.48);
  }

  // ── Walkers ────────────────────────────────────────
  const DX = [0, 1, 0, -1];
  const DY = [-1, 0, 1, 0];

  function spawn() {
    for (let i = 0; i < 100; i++) {
      const cx = (Math.random() * cols) | 0;
      const cy = (Math.random() * rows) | 0;
      const idx = cy * cols + cx;
      if (!vis[idx]) {
        vis[idx] = 1;
        walkers.push({ x: cx, y: cy, d: -1 });
        return true;
      }
    }
    return false;
  }

  function step(wk) {
    const open = [];
    for (let i = 0; i < 4; i++) {
      const nx = wk.x + DX[i];
      const ny = wk.y + DY[i];
      if (nx >= 0 && nx < cols && ny >= 0 && ny < rows && !vis[ny * cols + nx])
        open.push(i);
    }
    if (!open.length) return false;

    const dir = (wk.d >= 0 && open.includes(wk.d) && Math.random() < 0.55)
      ? wk.d : open[(Math.random() * open.length) | 0];

    const nx = wk.x + DX[dir];
    const ny = wk.y + DY[dir];
    vis[ny * cols + nx] = 1;

    const [r, g, b] = cellRGB(nx, ny);
    sCr.setSourceRGBA(r, g, b, 1);
    sCr.moveTo(wk.x * CELL + CELL / 2, wk.y * CELL + CELL / 2);
    sCr.lineTo(nx * CELL + CELL / 2, ny * CELL + CELL / 2);
    sCr.stroke();

    wk.x = nx;
    wk.y = ny;
    wk.d = dir;
    return true;
  }

  // ── St.DrawingArea (blits the off-screen surface) ──
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

  // ── Clock (St labels) ──────────────────────────────
  const DAYS = [
    'Sunday', 'Monday', 'Tuesday', 'Wednesday',
    'Thursday', 'Friday', 'Saturday',
  ];
  const MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const CLOCK_TOP_RATIO = 0.14;

  const tLbl = new St.Label({ text: '' });
  tLbl.style = 'color: white; font-size: 64px; font-weight: 300;';

  const dLbl = new St.Label({ text: '' });
  dLbl.style = 'color: rgba(255,255,255,0.70); font-size: 20px; '
             + 'font-weight: 400; margin-top: 6px;';

  const clock = new St.BoxLayout({ vertical: true });
  clock.add_child(tLbl);
  clock.add_child(dLbl);
  overlay.insert_child_below(clock, ctx.prompt);

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
    if (CLOCK_MONITOR_MODE === 'manual') {
      return getMonitorRect(CLOCK_MANUAL_MONITOR_INDEX) || getCombinedRect();
    }

    if (CLOCK_MONITOR_MODE === 'settings') {
      const idx = getSettingsMonitorIndex();
      if (Number.isInteger(idx))
        return getMonitorRect(idx) || getCombinedRect();
      return getCombinedRect();
    }

    return getCombinedRect();
  }

  function tickClock() {
    const d = new Date();
    tLbl.text = [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map(v => String(v).padStart(2, '0')).join(':');
    dLbl.text = DAYS[d.getDay()] + ', ' + d.getDate() + ' '
              + MONTHS[d.getMonth()] + ' ' + d.getFullYear();

    const target = getClockTargetRect();
    const overlayW = overlay.width || w;
    const overlayH = overlay.height || h;
    const [, clockW] = clock.get_preferred_width(-1);
    const [, clockH] = clock.get_preferred_height(-1);

    let x = target.x + Math.round((target.width - (clockW || 300)) / 2);
    let y = target.y + Math.round(target.height * CLOCK_TOP_RATIO);

    x = Math.max(0, Math.min(x, Math.max(0, overlayW - (clockW || 300))));
    y = Math.max(0, Math.min(y, Math.max(0, overlayH - (clockH || 80))));
    clock.set_position(x, y);
  }
  tickClock();

  // ── Animation loop ─────────────────────────────────
  const tid = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 45, () => {
    while (walkers.length < 80) {
      if (!spawn()) break;
    }

    for (let i = walkers.length - 1, n = 0; i >= 0; i--) {
      if (n >= 55) break;
      if (step(walkers[i])) n++;
      else walkers.splice(i, 1);
    }

    mazeArea.queue_repaint();
    tickClock();
    return true;
  });

  // ── Cleanup on destroy ─────────────────────────────
  ctx.prompt._maze = { mazeArea, clock, tid };
  ctx.prompt.connect('destroy', () => {
    const m = ctx.prompt._maze;
    if (!m) return;
    try { GLib.source_remove(m.tid); } catch (e) {}
    try { surf.finish(); } catch (e) {}
    try { m.clock.destroy(); } catch (e) {}
    try { m.mazeArea.destroy(); } catch (e) {}
    ctx.prompt._maze = null;
  });
}

if (ctx.event === 'update') {
  if (!SHOW_PASSWORD_FIELD) {
    if (ctx.text)
      ctx.text.text = '';
  } else if (ctx.text) {
    ctx.text.style = 'color: rgba(255,255,255,0.9); font-size: 20px; '
                   + 'min-width: 220px; min-height: 24px;';
  }
}
