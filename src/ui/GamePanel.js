// src/ui/GamePanel.js
// Factory function for styled, decorated panels.
// Usage:
//   import { createPanel } from '../ui/GamePanel.js';
//   const bg = createPanel(this, x, y, width, height, 'default').setDepth(12);

import { PANEL_STYLES } from './styles.js';

/**
 * Draws a themed panel with corner ornaments onto the scene.
 *
 * @param {Phaser.Scene} scene
 * @param {number} x           Left edge of the panel
 * @param {number} y           Top edge of the panel
 * @param {number} width
 * @param {number} height
 * @param {string|object} style  Key from PANEL_STYLES, or a custom config object
 * @returns {Phaser.GameObjects.Graphics}
 */
export function createPanel(scene, x, y, width, height, style = 'default') {
  const cfg = (typeof style === 'string')
    ? (PANEL_STYLES[style] ?? PANEL_STYLES.default)
    : { ...PANEL_STYLES.default, ...style };

  const {
    fill, fillAlpha,
    stroke, strokeWidth, radius,
    cornerSize, cornerColor, cornerAlpha,
  } = cfg;

  const gfx = scene.add.graphics();

  // --- Background fill ---
  gfx.fillStyle(fill, fillAlpha);
  gfx.fillRoundedRect(x, y, width, height, radius);

  // --- Border stroke ---
  if (strokeWidth > 0) {
    gfx.lineStyle(strokeWidth, stroke, 1);
    gfx.strokeRoundedRect(x, y, width, height, radius);
  }

  // --- Corner ornaments ---
  // Each corner: an L-bracket (two lines) + a small diamond dot at the outer tip.
  if (cornerSize > 0) {
    const s  = cornerSize;       // arm length
    const d  = 3;                // diamond half-size
    const lw = strokeWidth + 1;  // slightly thicker than the border

    gfx.lineStyle(lw, cornerColor, cornerAlpha);
    gfx.fillStyle(cornerColor, cornerAlpha);

    // Helper: draw one L-bracket + diamond for a given corner
    // ox, oy = corner point; hx, hy = horizontal arm direction; vx, vy = vertical arm direction
    const drawCorner = (cx, cy, hDir, vDir) => {
      // Horizontal arm
      gfx.beginPath();
      gfx.moveTo(cx + hDir * s, cy);
      gfx.lineTo(cx, cy);
      gfx.lineTo(cx, cy + vDir * s);
      gfx.strokePath();

      // Diamond at the outer tip (where the two arms meet)
      gfx.beginPath();
      gfx.moveTo(cx,           cy - d * vDir);  // top
      gfx.lineTo(cx + d * hDir, cy);             // right
      gfx.lineTo(cx,           cy + d * vDir);  // bottom
      gfx.lineTo(cx - d * hDir, cy);             // left
      gfx.closePath();
      gfx.fillPath();
    };

    const inset = radius * 0.5; // pull corners inward slightly so they sit on the rounded edge

    drawCorner(x + inset,           y + inset,            1,  1);  // top-left
    drawCorner(x + width - inset,   y + inset,           -1,  1);  // top-right
    drawCorner(x + inset,           y + height - inset,   1, -1);  // bottom-left
    drawCorner(x + width - inset,   y + height - inset,  -1, -1);  // bottom-right
  }

  return gfx;
}
