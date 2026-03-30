// Neo Digital Rain — Matrix-style falling characters for Stealth Lock
// Inspired by github.com/st3w/neo
// Paste into: Extensions > Stealth Lock > Custom JS
//
// ── KNOBS ──────────────────────────────────────────────────────────────

// Rain appearance
const NEO_FONT_SIZE = 16;
const NEO_FONTS = ['Monaspace Krypton NF', 'Noto Sans', 'Noto Sans Mono CJK JP', 'monaspace'];
const NEO_BACKGROUND_RGBA = [0, 0, 0, 1];

// Droplet behavior
const NEO_DENSITY = 0.7;            // fraction of columns with active rain
const NEO_MAX_DROPS = 3;            // max simultaneous droplets per column
const NEO_SPEED_MIN = 0.3;          // min rows per frame
const NEO_SPEED_MAX = 1.2;          // max rows per frame (async per-droplet)
const NEO_LENGTH_MIN = 4;           // min visible chars in a droplet
const NEO_LENGTH_MAX = 40;          // max visible chars in a droplet
const NEO_SHORT_PCT = 0.5;          // fraction of droplets that are short
const NEO_SHORT_MAX = 15;           // max length for short droplets
const NEO_DIE_EARLY_PCT = 0.33;     // fraction that stop before reaching bottom
const NEO_SPAWN_COOLDOWN_MIN = 3;   // min frames between spawns in same column
const NEO_SPAWN_COOLDOWN_MAX = 50;  // max frames between spawns in same column
const NEO_SPAWN_CHANCE = 0.06;      // per-frame spawn chance per eligible column

// Visual effects
const NEO_FADE_ALPHA = 0.06;        // trail fade per frame (lower = longer trails)
const NEO_GLITCH_CHANCE = 0.001;    // per-cell-per-frame glitch flash probability
const NEO_CHAR_CYCLE_CHANCE = 0.03; // per-body-char-per-frame character change

// Animation
const NEO_INTERVAL_MS = 50;

// Character sets (swap NEO_CHARS to change)
const NEO_CHARS_KATAKANA = (() => { let s = ''; for (let c = 0xFF66; c <= 0xFF9D; c++) s += String.fromCharCode(c); return s + '0123456789'; })();
const NEO_CHARS_ASCII = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%&*+=?/<>';
const NEO_CHARS_BINARY = '01';
const NEO_CHARS_HEX = '0123456789ABCDEF';
const NEO_CHARS = NEO_CHARS_KATAKANA;

// Prompt knobs
const SHOW_PASSWORD_FIELD = true;
const TEXT_CLEAR_WHEN_HIDDEN = true;
const SHOW_REVEAL_BUTTON = true;
const PROMPT_STYLE_VISIBLE =
  'background-color: rgba(0,0,0,0.60); '
  + 'border: 1px solid rgba(0,255,70,0.25); '
  + 'border-radius: 8px; padding: 10px 16px;';
const PROMPT_STYLE_HIDDEN = 'background-color: transparent; border: 0; padding: 0; spacing: 0;';
const PROMPT_TEXT_STYLE =
  'color: rgba(0,255,70,0.9); font-size: 20px; min-width: 220px; min-height: 24px; font-weight: 500; font-family: monospace;';
const REVEAL_ICON_STYLE = 'color: rgba(0,255,70,0.5); icon-size: 20px;';

// Clock knobs
const SHOW_CLOCK = false;
const CLOCK_USE_24H = true;
const CLOCK_SHOW_SECONDS = true;
const CLOCK_SHOW_DATE = true;
const CLOCK_TOP_RATIO = 0.14;
const CLOCK_VERTICAL_OFFSET_PX = 0;
const CLOCK_HORIZONTAL_ALIGN = 'center';
const CLOCK_SIDE_MARGIN_PX = 24;
const CLOCK_TIME_STYLE = 'color: rgba(0,255,70,0.95); font-size: 64px; font-weight: 700; font-family: monospace;';
const CLOCK_DATE_STYLE = 'color: rgba(0,255,70,0.60); font-size: 20px; font-weight: 500; margin-top: 6px; font-family: monospace;';
const CLOCK_MONITOR_MODE = 'settings';
const CLOCK_MANUAL_MONITOR_INDEX = 0;

// ── INIT ───────────────────────────────────────────────────────────────

if (ctx.event === 'init') {
  if (ctx.state.neo) return;

  const { St, GLib, cairo: Cairo, Clutter, Pango } = ctx.gi;
  if (!Cairo) return;

  const overlay = ctx.overlay;
  if (!overlay) return;
  const backgroundLayer = ctx.backgroundLayer || overlay;
  const prompt = ctx.prompt;

  const w = overlay.width || global.stage.width || 1920;
  const h = overlay.height || global.stage.height || 1080;

  // Prompt styling
  if (prompt && SHOW_PASSWORD_FIELD) {
    prompt.style = PROMPT_STYLE_VISIBLE;
    prompt.reactive = true;
    if (ctx.text) {
      ctx.text.visible = true;
      ctx.text.style = PROMPT_TEXT_STYLE;
    }
    if (ctx.revealButton) {
      ctx.revealButton.visible = SHOW_REVEAL_BUTTON;
      ctx.revealButton.reactive = SHOW_REVEAL_BUTTON;
      if (SHOW_REVEAL_BUTTON) {
        const icon = ctx.revealButton.get_child();
        if (icon) icon.style = REVEAL_ICON_STYLE;
      }
    }
  } else if (prompt) {
    prompt.style = PROMPT_STYLE_HIDDEN;
    prompt.reactive = false;
    if (ctx.text) ctx.text.visible = false;
    if (ctx.revealButton) {
      ctx.revealButton.visible = false;
      ctx.revealButton.reactive = false;
    }
  }

  // ── Rain setup ──

  const surf = new Cairo.ImageSurface(Cairo.Format.ARGB32, w, h);
  const sCr = new Cairo.Context(surf);

  sCr.setSourceRGBA(NEO_BACKGROUND_RGBA[0], NEO_BACKGROUND_RGBA[1], NEO_BACKGROUND_RGBA[2], NEO_BACKGROUND_RGBA[3]);
  sCr.paint();

  // Measure cell size across all fonts (use the largest)
  let cellW = Math.ceil(NEO_FONT_SIZE * 0.6);
  let cellH = Math.ceil(NEO_FONT_SIZE * 1.2);
  let fontAscent = NEO_FONT_SIZE * 0.8;
  for (const fam of NEO_FONTS) {
    try {
      sCr.selectFontFace(fam, 0, 0);
      sCr.setFontSize(NEO_FONT_SIZE);
      const te = sCr.textExtents('W');
      const fe = sCr.fontExtents();
      cellW = Math.max(cellW, Math.ceil(te.xAdvance || NEO_FONT_SIZE * 0.6));
      cellH = Math.max(cellH, Math.ceil(fe.height || NEO_FONT_SIZE * 1.2));
      fontAscent = Math.max(fontAscent, fe.ascent || NEO_FONT_SIZE * 0.8);
    } catch (e) {}
  }
  cellW = Math.max(cellW, 6);
  cellH = Math.max(cellH, 8);

  const numCols = Math.max(1, Math.floor(w / cellW));
  const numRows = Math.max(1, Math.floor(h / cellH));

  const CLEN = NEO_CHARS.length;
  function randChar() { return NEO_CHARS[Math.floor(Math.random() * CLEN)]; }
  function randInt(lo, hi) { return lo + Math.floor(Math.random() * (hi - lo + 1)); }

  // Build char → font map. For each char, pick the first font that has the glyph.
  // Detection: render two known-unassigned codepoints to get each font's .notdef
  // signature, then compare each real char's extents against it.
  const charFont = {};
  const lastFontIdx = NEO_FONTS.length - 1;
  const notdefSig = [];
  for (let fi = 0; fi < NEO_FONTS.length; fi++) {
    try {
      sCr.selectFontFace(NEO_FONTS[fi], 0, 0);
      sCr.setFontSize(NEO_FONT_SIZE);
      const e1 = sCr.textExtents(String.fromCodePoint(0x0378)); // unassigned
      const e2 = sCr.textExtents(String.fromCodePoint(0x0380)); // unassigned
      if (Math.abs(e1.width - e2.width) < 0.1 && Math.abs(e1.xAdvance - e2.xAdvance) < 0.1)
        notdefSig.push({ w: e1.width, xa: e1.xAdvance });
      else
        notdefSig.push(null);
    } catch (e) { notdefSig.push(null); }
  }
  for (let i = 0; i < CLEN; i++) {
    const ch = NEO_CHARS[i];
    charFont[ch] = lastFontIdx;
    for (let fi = 0; fi < NEO_FONTS.length; fi++) {
      const sig = notdefSig[fi];
      if (!sig) { charFont[ch] = fi; break; } // can't detect → assume font has it
      try {
        sCr.selectFontFace(NEO_FONTS[fi], 0, 0);
        sCr.setFontSize(NEO_FONT_SIZE);
        const ce = sCr.textExtents(ch);
        if (Math.abs(ce.width - sig.w) > 0.5 || Math.abs(ce.xAdvance - sig.xa) > 0.5) {
          charFont[ch] = fi;
          break;
        }
      } catch (e) {}
    }
  }

  class Droplet {
    constructor(col) {
      this.col = col;
      const isShort = Math.random() < NEO_SHORT_PCT;
      this.length = isShort
        ? randInt(NEO_LENGTH_MIN, NEO_SHORT_MAX)
        : randInt(NEO_LENGTH_MIN, NEO_LENGTH_MAX);
      this.y = -(Math.random() * this.length);
      this.speed = NEO_SPEED_MIN + Math.random() * (NEO_SPEED_MAX - NEO_SPEED_MIN);
      this.alive = true;
      this.dieRow = Math.random() < NEO_DIE_EARLY_PCT
        ? Math.floor(Math.random() * numRows)
        : numRows + this.length;
      this.chars = [];
      for (let i = 0; i < this.length; i++)
        this.chars.push(randChar());
    }

    advance() {
      this.y += this.speed;
      const head = Math.floor(this.y);
      if (head - this.length >= numRows || head >= this.dieRow + this.length)
        this.alive = false;
    }
  }

  // Column state with staggered initial spawn
  const columns = [];
  for (let i = 0; i < numCols; i++) {
    const col = { droplets: [], cooldown: randInt(0, 30) };
    if (Math.random() < NEO_DENSITY * 0.3) {
      col.droplets.push(new Droplet(i));
      col.cooldown = randInt(NEO_SPAWN_COOLDOWN_MIN, NEO_SPAWN_COOLDOWN_MAX);
    }
    columns.push(col);
  }

  function tickRain() {
    // Fade trail for inactive cells
    sCr.setSourceRGBA(0, 0, 0, NEO_FADE_ALPHA);
    sCr.rectangle(0, 0, w, h);
    sCr.fill();

    // Batch-clear all active cells to black
    sCr.setSourceRGBA(0, 0, 0, 1);
    for (let ci = 0; ci < numCols; ci++) {
      for (const drop of columns[ci].droplets) {
        const head = Math.floor(drop.y);
        const tail = head - drop.length;
        const sr = Math.max(0, tail);
        const er = Math.min(numRows - 1, head);
        for (let row = sr; row <= er; row++)
          sCr.rectangle(ci * cellW, row * cellH, cellW, cellH);
      }
    }
    sCr.fill();

    // Draw characters (switch font only when needed)
    let curFi = -1;

    for (let ci = 0; ci < numCols; ci++) {
      const col = columns[ci];

      for (const drop of col.droplets) {
        const head = Math.floor(drop.y);
        const tail = head - drop.length;
        const sr = Math.max(0, tail);
        const er = Math.min(numRows - 1, head);

        for (let row = sr; row <= er; row++) {
          const dist = head - row;
          const t = dist / Math.max(1, drop.length);

          // Cycle body chars for digital noise
          if (dist > 0 && Math.random() < NEO_CHAR_CYCLE_CHANCE)
            drop.chars[dist % drop.chars.length] = randChar();

          // Head-to-tail green gradient
          let r, g, b;
          if (dist === 0) {
            r = 0.7; g = 1.0; b = 0.7;        // white-green head
          } else if (dist <= 2) {
            r = 0.0; g = 0.95; b = 0.05;       // bright green near head
          } else {
            r = 0; g = 0.3 + 0.6 * (1 - t); b = 0;
          }

          const ch = drop.chars[dist % drop.chars.length];
          const fi = charFont[ch] ?? lastFontIdx;
          if (fi !== curFi) {
            sCr.selectFontFace(NEO_FONTS[fi], 0, 0);
            sCr.setFontSize(NEO_FONT_SIZE);
            curFi = fi;
          }

          sCr.setSourceRGBA(r, g, b, 1);
          sCr.moveTo(ci * cellW, row * cellH + fontAscent);
          sCr.showText(ch);
        }

        drop.advance();
      }

      // Remove dead droplets
      col.droplets = col.droplets.filter(d => d.alive);

      // Spawn new droplets
      if (col.cooldown > 0) {
        col.cooldown--;
      } else if (col.droplets.length < NEO_MAX_DROPS && Math.random() < NEO_SPAWN_CHANCE) {
        col.droplets.push(new Droplet(ci));
        col.cooldown = randInt(NEO_SPAWN_COOLDOWN_MIN, NEO_SPAWN_COOLDOWN_MAX);
      }
    }

    // Glitch flashes
    const glitchN = Math.ceil(numCols * numRows * NEO_GLITCH_CHANCE);
    for (let i = 0; i < glitchN; i++) {
      const gc = Math.floor(Math.random() * numCols);
      const gr = Math.floor(Math.random() * numRows);
      const px = gc * cellW;
      const py = gr * cellH;
      sCr.setSourceRGBA(0, 0, 0, 1);
      sCr.rectangle(px, py, cellW, cellH);
      sCr.fill();
      const glitchCh = randChar();
      const glitchFi = charFont[glitchCh] ?? lastFontIdx;
      if (glitchFi !== curFi) {
        sCr.selectFontFace(NEO_FONTS[glitchFi], 0, 0);
        sCr.setFontSize(NEO_FONT_SIZE);
        curFi = glitchFi;
      }
      sCr.setSourceRGBA(0.6, 1.0, 0.6, 1.0);
      sCr.moveTo(px, py + fontAscent);
      sCr.showText(glitchCh);
    }
  }

  // St.DrawingArea — blits the off-screen surface
  const neoArea = new St.DrawingArea();
  neoArea.set_size(w, h);
  neoArea.set_position(0, 0);
  backgroundLayer.add_child(neoArea);

  neoArea.connect('repaint', () => {
    const rc = neoArea.get_context();
    rc.setSourceSurface(surf, 0, 0);
    rc.paint();
    rc.$dispose();
  });
  neoArea.queue_repaint();

  // ── Clock ──

  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

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

    overlay.add_child(clock);
    if (prompt)
      overlay.set_child_below_sibling(clock, prompt);
    else if (ctx.background)
      overlay.set_child_above_sibling(clock, ctx.background);
    else if (neoArea)
      overlay.set_child_above_sibling(clock, neoArea);
  }

  function getCombinedRect() {
    return { x: 0, y: 0, width: overlay.width || w, height: overlay.height || h };
  }

  function getMonitorRect(index) {
    if (!Number.isInteger(index) || index < 0) return null;
    if (!global.display?.get_n_monitors || !global.display?.get_monitor_geometry) return null;
    const nMon = global.display.get_n_monitors();
    if (index >= nMon) return null;
    const g = global.display.get_monitor_geometry(index);
    if (!g) return null;
    const ox = overlay._originX ?? 0;
    const oy = overlay._originY ?? 0;
    return { x: g.x - ox, y: g.y - oy, width: g.width, height: g.height };
  }

  function getSettingsMonitorIndex() {
    try {
      const raw = (ctx.settings?.get_string('normal-prompt-monitor') ?? '').trim();
      if (!raw || !/^-?\d+$/.test(raw)) return null;
      const idx = Number(raw);
      return Number.isInteger(idx) ? idx : null;
    } catch (e) { return null; }
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
    if (CLOCK_SHOW_SECONDS) parts.push(date.getSeconds());
    return parts
      .map((v, i) => (i === 0 && !CLOCK_USE_24H ? String(v) : String(v).padStart(2, '0')))
      .join(':') + suffix;
  }

  function tickClock() {
    if (!clock || !tLbl) return;
    const d = new Date();
    tLbl.text = formatClockTime(d);
    if (dLbl)
      dLbl.text = DAYS[d.getDay()] + ', ' + d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear();

    const target = getClockTargetRect();
    const ow = overlay.width || w;
    const oh = overlay.height || h;
    const [, prefTW] = tLbl.get_preferred_width(-1);
    const [, prefTH] = tLbl.get_preferred_height(-1);
    let prefDW = 0, prefDH = 0;
    if (dLbl) {
      [, prefDW] = dLbl.get_preferred_width(-1);
      [, prefDH] = dLbl.get_preferred_height(-1);
    }
    const cW = Math.max(prefTW || 0, prefDW || 0, 300);
    clock.set_width(cW);
    const [, prefCH] = clock.get_preferred_height(cW);
    const cH = Math.max(prefCH || 0, prefTH || 0, prefDH || 0, 80);
    clock.set_size(cW, cH);

    let x;
    if (CLOCK_HORIZONTAL_ALIGN === 'left') x = target.x + CLOCK_SIDE_MARGIN_PX;
    else if (CLOCK_HORIZONTAL_ALIGN === 'right') x = target.x + target.width - cW - CLOCK_SIDE_MARGIN_PX;
    else x = target.x + Math.round((target.width - cW) / 2);

    let y = target.y + Math.round(target.height * CLOCK_TOP_RATIO) + CLOCK_VERTICAL_OFFSET_PX;
    x = Math.max(0, Math.min(x, Math.max(0, ow - cW)));
    y = Math.max(0, Math.min(y, Math.max(0, oh - cH)));
    clock.set_position(x, y);
  }
  tickClock();

  // ── Animation loop ──

  const tid = GLib.timeout_add(GLib.PRIORITY_DEFAULT, NEO_INTERVAL_MS, () => {
    tickRain();
    neoArea.queue_repaint();
    tickClock();
    return true;
  });

  ctx.state.neo = { neoArea, clock, tid, surf };
}

// ── UPDATE ─────────────────────────────────────────────────────────────

if (ctx.event === 'update') {
  if (ctx.prompt && !SHOW_PASSWORD_FIELD) {
    ctx.prompt.style = PROMPT_STYLE_HIDDEN;
    ctx.prompt.reactive = false;
    if (TEXT_CLEAR_WHEN_HIDDEN && ctx.text) ctx.text.text = '';
    if (ctx.text) ctx.text.visible = false;
    if (ctx.revealButton) {
      ctx.revealButton.visible = false;
      ctx.revealButton.reactive = false;
    }
  } else if (ctx.prompt && SHOW_PASSWORD_FIELD) {
    ctx.prompt.style = PROMPT_STYLE_VISIBLE;
    ctx.prompt.reactive = true;
    if (ctx.text) {
      ctx.text.visible = true;
      ctx.text.style = PROMPT_TEXT_STYLE;
    }
    if (ctx.revealButton) {
      ctx.revealButton.visible = SHOW_REVEAL_BUTTON;
      ctx.revealButton.reactive = SHOW_REVEAL_BUTTON;
      if (SHOW_REVEAL_BUTTON) {
        const icon = ctx.revealButton.get_child();
        if (icon) icon.style = REVEAL_ICON_STYLE;
      }
    }
  }
}

// ── DESTROY ────────────────────────────────────────────────────────────

if (ctx.event === 'destroy') {
  const s = ctx.state.neo;
  if (!s) return;
  try { ctx.gi.GLib.source_remove(s.tid); } catch (e) {}
  try { s.surf.finish(); } catch (e) {}
  if (s.clock) try { s.clock.destroy(); } catch (e) {}
  try { s.neoArea.destroy(); } catch (e) {}
  ctx.state.neo = null;
}
