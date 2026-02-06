if (ctx.event === 'init') {
  if (ctx.prompt._dimmer)
    return;

  const overlay = ctx.prompt.get_parent();
  if (!overlay)
    return;

  const dimmer = new ctx.prompt.constructor({
    reactive: false,
    can_focus: false,
    track_hover: false,
  });
  dimmer.style = 'background-color: rgba(0, 0, 0, 1.00);';

  overlay.add_child(dimmer);

  const resize = () => {
    dimmer.set_position(0, 0);
    dimmer.set_size(overlay.width || 0, overlay.height || 0);
    overlay.set_child_below_sibling(dimmer, ctx.prompt); // keep prompt on top
  };

  resize();
  const allocId = overlay.connect('notify::allocation', resize);

  ctx.prompt._dimmer = dimmer;
  ctx.prompt._dimmerAllocId = allocId;

  ctx.prompt.connect('destroy', () => {
    try {
      if (ctx.prompt._dimmerAllocId)
        overlay.disconnect(ctx.prompt._dimmerAllocId);
    } catch (e) { }
    try {
      if (ctx.prompt._dimmer)
        ctx.prompt._dimmer.destroy();
    } catch (e) { }
  });
}

if (ctx.event === 'update' && ctx.prompt._dimmer) {
  const overlay = ctx.prompt.get_parent();
  if (overlay)
    overlay.set_child_below_sibling(ctx.prompt._dimmer, ctx.prompt);
}
