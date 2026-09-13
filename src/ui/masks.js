// src/ui/masks.js
//
// Clipping masks for scrolling lists, built so they work in BOTH of Phaser's
// renderers.
//
// The game runs with `type: Phaser.AUTO`, which uses WebGL when the browser
// offers it and falls back to the Canvas renderer when it does not. LibreWolf
// withholds WebGL by default, and a player there reported that the Skills list,
// the vendor list and both Stash columns were completely blank — yet hovering
// still showed tooltips and clicking still worked. The rows were all there; they
// were simply never drawn.
//
// The cause is how Canvas applies a geometry mask. GeometryMask.preRenderCanvas
// draws the mask shape and then calls ctx.clip(), which clips to the current
// PATH. Graphics honours this: in clip mode its fillRect becomes ctx.rect(), a
// path. A Rectangle SHAPE does not — RectangleCanvasRenderer always paints with
// ctx.fillRect(), which draws pixels and adds nothing to the path. The clip then
// runs on an empty path and hides everything the mask covers. WebGL masks use
// the stencil buffer instead, so a Rectangle mask looks fine to every WebGL player
// and the bug stays invisible to anyone testing in an ordinary browser.
//
// Reproduced in headless Edge with WebGL disabled: the Rectangle-masked lists
// rendered empty, while the Graphics-masked lists (combat menu, inventory, the
// Load list) rendered normally in the same run.
//
// RULE: never build a GeometryMask from a Rectangle (or any Shape). Use this.
// tools/headless/masks.mjs scans the source and fails if one reappears.

/**
 * A rectangular clip region in WORLD coordinates.
 *
 * Returns the Graphics (kept so the caller can destroy it, or add it to a
 * container that owns its lifetime) and the mask to pass to setMask. A geometry
 * mask renders in world space in both renderers, so adding the Graphics to a
 * container does not move the clip region.
 *
 * @param {Phaser.Scene} scene
 * @param {number} x      left edge
 * @param {number} y      top edge
 * @param {number} width
 * @param {number} height
 * @returns {{ graphics: Phaser.GameObjects.Graphics, mask: Phaser.Display.Masks.GeometryMask }}
 */
export function createRectMask(scene, x, y, width, height) {
  const graphics = scene.add.graphics();
  graphics.fillStyle(0xffffff, 1);
  graphics.fillRect(x, y, Math.max(0, width), Math.max(0, height));
  // Invisible, or WebGL would draw it as a white box. The Canvas clip path is
  // still built from it: the mask renders its geometry directly, not through the
  // display list, and visibility does not stop that.
  graphics.setVisible(false);
  return { graphics, mask: graphics.createGeometryMask() };
}
