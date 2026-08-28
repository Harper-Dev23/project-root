// src/ui/DialogBox.js
// A single, reusable "faded box with a banner" text container — the fix for
// TownScene's inconsistent, hand-rolled floating text (bare this.add.text
// calls with no background, clashing with whatever art sits behind them,
// especially where several stack up like Elders' Tower). Functional style
// (returns a Container to .add() into a caller's own layout), matching the
// createPanel/createOverlayFrame convention already used elsewhere in ui/.

import { createPanel } from './GamePanel.js';
import { MENU_THEME } from './styles.js';

/**
 * Builds a themed text box: a silverMenu-styled faded panel, an optional
 * banner header strip with a title, and word-wrapped body text — auto-sized
 * to fit the body content instead of a hardcoded height per call site.
 *
 * @param {Phaser.Scene} scene
 * @param {object} opts
 * @param {number} opts.x       Horizontal CENTER of the box.
 * @param {number} opts.y       TOP edge of the box.
 * @param {number} [opts.width=700]
 * @param {string|null} [opts.title=null]   Banner header text; omit for a plain body-only box.
 * @param {string} [opts.body='']
 * @param {string} [opts.fontSize='15px']
 * @param {string} [opts.color=MENU_THEME.titleColor]
 * @param {string} [opts.fontStyle='normal']
 * @param {string} [opts.titleColor=MENU_THEME.titleColor]  Override for the banner header text specifically.
 * @param {number} [opts.depth=12]
 * @returns {{ container: Phaser.GameObjects.Container, height: number }}
 */
export function createTextBanner(scene, {
  x = 640,
  y,
  width = 700,
  title = null,
  body = '',
  fontSize = '15px',
  color = MENU_THEME.titleColor,
  fontStyle = 'normal',
  titleColor = MENU_THEME.titleColor,
  titleFontSize = '17px',
  depth = 12,
} = {}) {
  const PAD = 18;
  const BANNER_H = title ? 44 : 0;

  // Measure the body text first so the panel can be sized to fit it exactly
  // — every call site here has wildly different content length (a one-line
  // reminder vs. several paragraphs of lore), so a fixed height per caller
  // would either clip long text or leave huge empty boxes for short text.
  const bodyText = scene.add.text(0, 0, body, {
    fontSize, color, fontStyle, align: 'center',
    fontFamily: 'Georgia, Gelasio, serif',
    wordWrap: { width: width - PAD * 2 },
    lineSpacing: 4,
  }).setOrigin(0.5, 0);

  const boxHeight = BANNER_H + PAD * 2 + bodyText.height;

  const panel = createPanel(scene, x - width / 2, y, width, boxHeight, 'silverMenu')
    .setDepth(depth);

  const items = [panel];

  if (title) {
    const bannerBg = scene.add.rectangle(x, y + BANNER_H / 2, width - 4, BANNER_H, MENU_THEME.panelCorner, 0.16)
      .setDepth(depth + 1);
    const bannerRule = scene.add.rectangle(x, y + BANNER_H, width - 20, 2, MENU_THEME.panelStroke, 0.8)
      .setDepth(depth + 1);
    const titleText = scene.add.text(x, y + BANNER_H / 2, title, {
      fontSize: titleFontSize,
      color: titleColor,
      fontStyle: 'bold',
      fontFamily: 'Georgia, Gelasio, serif',
    }).setOrigin(0.5).setDepth(depth + 1);
    items.push(bannerBg, bannerRule, titleText);
  }

  bodyText.setPosition(x, y + BANNER_H + PAD).setDepth(depth + 1);
  items.push(bodyText);

  const container = scene.add.container(0, 0, items);
  return { container, height: boxHeight };
}
