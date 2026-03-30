const BACKGROUND_DIM_RED = 0;
const BACKGROUND_DIM_GREEN = 0;
const BACKGROUND_DIM_BLUE = 0;
const BACKGROUND_DIM_ALPHA = 0;
const BACKGROUND_BLUR_RADIUS = 20;
const BACKGROUND_BLUR_BRIGHTNESS = 1;
const BACKGROUND_BLUR_MODE = 'background';
const BACKGROUND_BLUR_EFFECT_NAME = 'background-blur-and-dim';

if (ctx.event === 'init') {
  if (!ctx.background)
    return;

  if (ctx.state.backgroundBaseStyle === undefined)
    ctx.state.backgroundBaseStyle = ctx.background.style ?? '';

  ctx.background.style = `${ctx.state.backgroundBaseStyle} background-color: rgba(${BACKGROUND_DIM_RED}, ${BACKGROUND_DIM_GREEN}, ${BACKGROUND_DIM_BLUE}, ${BACKGROUND_DIM_ALPHA});`.trim();

  ctx.effects.ensureBlur(ctx.background, {
    name: BACKGROUND_BLUR_EFFECT_NAME,
    mode: BACKGROUND_BLUR_MODE,
    radius: BACKGROUND_BLUR_RADIUS,
    brightness: BACKGROUND_BLUR_BRIGHTNESS,
  });
}

if (ctx.event === 'destroy' && ctx.background) {
  if (ctx.state.backgroundBaseStyle !== undefined)
    ctx.background.style = ctx.state.backgroundBaseStyle;

  ctx.effects.remove(ctx.background, BACKGROUND_BLUR_EFFECT_NAME);
}
