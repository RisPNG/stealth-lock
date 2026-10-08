# Saved visual programs

A visual entry contains a name and JavaScript function body. The editor supplies the single argument `ctx`; there are no imports, exports or privileged host APIs. The three starter entries use this exact contract. Their source is copied into the library once for a new settings profile, and then belongs to the user. Editing, renaming or deleting them is permanent, including across reinstall. No deleted entry is replenished.

Save and Replace preserve source drafts. Check JavaScript compiles the body without executing it. Apply checks syntax before saving/selecting the entry. Runtime exceptions and exceeded limits remove the visual decoration; password input and the modal privacy screen remain active. Syntax validity does not guarantee that a program will run within its limits.

## Lifecycle and coordinates

The body runs once for `init`, then on `update` at approximately 50 ms intervals while animation is enabled. The same JavaScript realm and `ctx.state` survive updates. `destroy` receives a final best-effort callback when the worker is idle; teardown always removes native resources, even if the body hangs or fails. Do not depend on destroy for external work. Program selection, monitor changes and native theme changes may recreate the worker and state.

| Field | Meaning |
| --- | --- |
| `ctx.event` | `init`, `update` or `destroy` |
| `ctx.state` | Your persistent in-memory object; starts empty on init |
| `ctx.width`, `ctx.height` | Logical size of the combined desktop bounds |
| `ctx.monitors` | `{x, y, width, height}` rectangles relative to those bounds |
| `ctx.colors` | Theme RGBA arrays, normalized to 0–1 |
| `ctx.now` | Monotonic milliseconds; use differences for animation |
| `ctx.delta` | Milliseconds since the previous completed frame, capped at 1000; 0 initially |
| `ctx.reducedMotion` | Whether GNOME requests reduced motion or disables animations |

Drawing coordinates start at the upper-left of the combined desktop bounds. Display gaps can exist within these bounds. Theme colors are `background`, `foreground`, `head`, `glitch`, `cyan`, `mint`, `amber`, `orange`, `magenta` and `blur`. `ctx.colors.palette` contains cyan, mint, amber, orange and magenta. Add colors to the centralized stylesheets when extending the shipped theme.

With reduced motion, init should produce a useful static image. Regular animation updates stop, but a style/motion change can request another update. Native clocks continue independently. Respect `ctx.reducedMotion` in your body.

## Drawing

`ctx.draw` records commands. A trusted Shell renderer validates them and draws below the password prompt. The drawing surface persists across frames, so trails and incremental scenes are possible; use a source paint when you want to replace it. The Cairo path is cleared after each completed frame. Save/restore must balance within the frame.

| Operation | Arguments |
| --- | --- |
| `setSourceRGBA` | `(red, green, blue, alpha)`, each 0–1 |
| `setOperator` | `'source'`, `'over'` or `'dest-out'` |
| `paint` | No arguments; paint the full surface |
| `rectangle` | `(x, y, width, height)`, dimensions nonnegative |
| `fill` | No arguments; fill and clear the path |
| `moveTo`, `lineTo` | `(x, y)` |
| `stroke` | No arguments; stroke and clear the path |
| `setLineWidth` | `(width)`, greater than 0 and at most 128 |
| `save`, `restore` | No arguments; drawing state only |
| `text` | `(text, x, y, fontSize = 16, fontFamily = 'monospace')` |

Text uses plain Unicode through Pango, with no markup. Coordinates and sizes must be finite. Text is limited to 256 characters per command and 4096 characters per frame; drawing font sizes are 1–128 and single family names at most 128 characters. A program may request at most four font families over its lifetime, with at most 512 text operations and 128 newly created layouts in one frame. Comma-separated fallback-family lists are not accepted. Commands outside the workload/coordinate budgets reject the whole frame.

A simple theme-colored overlay:

```js
if (ctx.event === 'destroy')
    return;
ctx.draw.setOperator('source');
ctx.draw.setSourceRGBA(...ctx.colors.blur);
ctx.draw.paint();
```

A moving square using persistent state:

```js
if (ctx.event === 'destroy')
    return;
if (ctx.event === 'init')
    ctx.state.x = 0;
if (!ctx.reducedMotion)
    ctx.state.x = (ctx.state.x + ctx.delta * 0.05) % Math.max(1, ctx.width - 32);
ctx.draw.setOperator('source');
ctx.draw.setSourceRGBA(0, 0, 0, 0);
ctx.draw.paint();
ctx.draw.setOperator('over');
ctx.draw.setSourceRGBA(...ctx.colors.cyan);
ctx.draw.rectangle(ctx.state.x, 32, 32, 32);
ctx.draw.fill();
```

## Blur and clocks

`ctx.blur(radius = 20, brightness = 1)` requests native background blur. Radius is 0–100; brightness is 0–1. `ctx.blur(null)` removes it. The last requested value persists between frames.

`ctx.clock(options)` configures a native locale-aware clock. `ctx.clock(null)` removes it. Options merge with these defaults; unknown fields are rejected:

```js
ctx.clock({
    visible: true,
    format24h: true,
    seconds: true,
    date: true,
    align: 'center',
    topRatio: 0.14,
    offsetY: 0,
    fontSize: 64,
    dateFontSize: 20,
    monitor: 'settings',
});
```

`align` accepts left/center/right; `topRatio` is 0–1. `offsetY` is a signed 32-bit integer. Time font size is 8–160; date font size is 8–64. `monitor` accepts `settings` for the prompt's chosen monitor, `all` for combined bounds, a connector such as `DP-1`, or a numeric index string. Disconnected selections use the primary display. Placement is clamped to a physical monitor rather than a gap. Clocks update every second even with reduced motion.

## Execution boundary

The worker has ordinary JavaScript language features but no GI, Shell, DOM, process, file, network, clipboard, settings, password or lock-control objects. Even dynamically constructed functions remain in this isolated realm. A Bubblewrap namespace exposes only read-only runtime libraries and the two interpreter/API files, with private pipes and no host buses/display/home. Drawing output has a strict whitelist. Programs cannot create arbitrary Shell actors or install event handlers.

Limits include 512 KiB of UTF-8 source without NUL, a 256 KiB frame, 2048 commands and drawing-state depth 32. The trusted renderer budgets at most 16,777,216 effective raster pixels across paints, fills, strokes and size-weighted text in a frame. Nonrectangular subpaths have at most 128 line edges, with 1024 line edges total. Stroke accounting retains line width across frames and save/restore.

The interpreter's address space is capped at 512 MiB. Evaluating a frame has a 25 ms CPU and 500 ms wall deadline; these deadlines govern the worker, while validated raster/font budgets govern native drawing. Native replay also checks elapsed time between commands and after replay, discarding a decoration that exceeds 50 ms. This check cannot interrupt one native operation. Parent watchdogs terminate stalled initialization/checks and frame/destroy calls. The renderer caps its surface at approximately 4,194,304 pixels (16 MiB ARGB, with dimension rounding) and caches at most 512 text layouts. Large desktops may therefore use a downsampled drawing surface. Limits apply equally to starters and user entries.

For example, changing the `options` object in Neo Rain changes its speed or density because that algorithm is your entry's source. Creating a different algorithm follows the same path. An infinite loop ends only that worker; it does not get control of authentication or the Shell main loop.
