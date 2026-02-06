// Maze Clock – animated maze background with clock, NO password field.
// Password input still works (typed blindly), only visuals are hidden.
// Paste into: Extensions > Stealth Lock > Normal Prompt Custom JS
// Leave "Normal Prompt CSS" empty.
//
// Requires: lock-type = "normal"

if (ctx.event === 'init') {
  if (ctx.prompt._maze) return;

  const { St, GLib, cairo: Cairo } = ctx.gi;

  const overlay = ctx.prompt.get_parent();
  if (!overlay) return;

  const w = overlay.width  || global.stage.width  || 1920;
  const h = overlay.height || global.stage.height || 1080;

  // ── Hide password prompt visuals ───────────────────
  ctx.prompt.style = 'background-color: transparent; border: 0; padding: 0; spacing: 0;';
  ctx.prompt.reactive = false;

  if (ctx.text)
    ctx.text.visible = false;

  if (ctx.revealButton) {
    ctx.revealButton.visible = false;
    ctx.revealButton.reactive = false;
  }

  // ── Maze grid ──────────────────────────────────────
  const CELL = 6;
  const cols = Math.floor(w / CELL);
  const rows = Math.floor(h / CELL);
  const vis  = new Uint8Array(cols * rows);
  let walkers = [];

  // ── Off-screen Cairo surface (incremental drawing) ─
  const surf = new Cairo.ImageSurface(Cairo.Format.ARGB32, w, h);
  const sCr  = new Cairo.Context(surf);
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
      const nx = wk.x + DX[i], ny = wk.y + DY[i];
      if (nx >= 0 && nx < cols && ny >= 0 && ny < rows && !vis[ny * cols + nx])
        open.push(i);
    }
    if (!open.length) return false;

    const dir = (wk.d >= 0 && open.includes(wk.d) && Math.random() < 0.55)
      ? wk.d : open[(Math.random() * open.length) | 0];

    const nx = wk.x + DX[dir], ny = wk.y + DY[dir];
    vis[ny * cols + nx] = 1;

    const [r, g, b] = cellRGB(nx, ny);
    sCr.setSourceRGBA(r, g, b, 1);
    sCr.moveTo(wk.x * CELL + CELL / 2, wk.y * CELL + CELL / 2);
    sCr.lineTo(nx   * CELL + CELL / 2, ny   * CELL + CELL / 2);
    sCr.stroke();

    wk.x = nx; wk.y = ny; wk.d = dir;
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

  // ── Clock (St labels) ─────────────────────────────
  const DAYS   = ['Sunday','Monday','Tuesday','Wednesday',
                  'Thursday','Friday','Saturday'];
  const MONTHS = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];

  const tLbl = new St.Label({ text: '' });
  tLbl.style = 'color: white; font-size: 64px; font-weight: 300;';

  const dLbl = new St.Label({ text: '' });
  dLbl.style = 'color: rgba(255,255,255,0.70); font-size: 20px; '
             + 'font-weight: 400; margin-top: 6px;';

  const clock = new St.BoxLayout({ vertical: true });
  clock.add_child(tLbl);
  clock.add_child(dLbl);
  overlay.insert_child_below(clock, ctx.prompt);

  function tickClock() {
    const d = new Date();
    tLbl.text = [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map(v => String(v).padStart(2, '0')).join(':');
    dLbl.text = DAYS[d.getDay()] + ', ' + d.getDate() + ' '
              + MONTHS[d.getMonth()] + ' ' + d.getFullYear();
    const ow = overlay.width || w;
    const oh = overlay.height || h;
    const [, cw] = clock.get_preferred_width(-1);
    clock.set_position(
      Math.round((ow - (cw || 300)) / 2),
      Math.round(oh * 0.14)
    );
  }
  tickClock();

  // ── Animation loop ─────────────────────────────────
  const tid = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 45, () => {
    while (walkers.length < 80) { if (!spawn()) break; }
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
  if (ctx.text)
    ctx.text.text = '';
}
