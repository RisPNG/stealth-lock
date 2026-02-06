if (ctx.event === 'init') {
  if (!ctx.prompt._dimmer) {
    const overlay = ctx.prompt.get_parent();
    if (overlay) {
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
        overlay.set_child_below_sibling(dimmer, ctx.prompt);
      };
      resize();

      const allocId = overlay.connect('notify::allocation', resize);
      ctx.prompt._dimmer = dimmer;
      ctx.prompt._dimmerAllocId = allocId;

      ctx.prompt.connect('destroy', () => {
        try { overlay.disconnect(ctx.prompt._dimmerAllocId); } catch (e) {}
        try { ctx.prompt._dimmer.destroy(); } catch (e) {}
      });
    }
  }

  // Hide prompt visuals
  ctx.prompt.style = 'background-color: transparent; border: 0; padding: 0; spacing: 0;';
  ctx.prompt.reactive = false;

  if (ctx.text)
    ctx.text.visible = false;

  if (ctx.revealButton) {
    ctx.revealButton.visible = false;
    ctx.revealButton.reactive = false;
  }
}

if (ctx.event === 'update') {
  if (ctx.text)
    ctx.text.text = '';
}
