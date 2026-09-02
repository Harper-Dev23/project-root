// src/ui/Tooltip.js
import { FONTS, COLORS, UI_DEPTH, SPACING } from './styles.js';
import { AOE_GRID_SLOTS } from './skillTooltip.js';

export default class Tooltip {
  constructor(scene) {
    this.scene = scene;
    this.padding = SPACING.padding || 6;
    this.gapTitleBody = 4;
    this.gapTitlePills = 6;
    this.gapPillsBody = 6;
    this.pillH = 16;
    this.pillPadX = 6;
    this.pillPadY = 3;
    this.pillGap = 6;

    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.destroy());
    scene.events.once(Phaser.Scenes.Events.DESTROY, () => this.destroy());

    const topDepth = (UI_DEPTH?.tooltip ?? 5000) + 500; // sit above any overlay panels
    this.topDepth = topDepth;

    // Title
    const title = scene.add.text(this.padding, this.padding, '', {
      ...FONTS.body,
      color: '#dddddd',
      wordWrap: { width: 320 }
    }).setOrigin(0, 0).setDepth(topDepth);

    // Pills row container (rendered as children rect+text)
    const pills = scene.add.container(this.padding, this.padding)
      .setDepth(topDepth);

    // Body — a stack of individual Text objects (one per line) rather than a
    // single multi-line Text, so each line can carry its own color (e.g. a
    // weakness tooltip's "Currently: ..." stats dim vs highlighted per line).
    // Plain strings still work exactly as before, just each becomes its own object.
    const bodyContainer = scene.add.container(this.padding, this.padding)
      .setDepth(topDepth);

    // Background drawn via Graphics so clear()+redraw every show() guarantees correct size
    const bg = scene.add.graphics().setDepth(topDepth);
    this._bgW = 0;
    this._bgH = 0;

    this.container = scene.add.container(0, 0, [bg, title, pills, bodyContainer])
      .setDepth(topDepth)
      .setVisible(false);

    // Disable interactivity for the tooltip container and all child elements (prevents blocking clicks)
    this.container.disableInteractive?.();
    this.bg = bg;
    this.title = title;
    this.pills = pills;
    this.bodyContainer = bodyContainer;

    // Disable interactivity for title, pills, and body text (to ensure it doesn't block clicks)
    this.title.disableInteractive?.();
    this.pills.disableInteractive?.();
    this.bodyContainer.disableInteractive?.();

    // Set up input events to hide the tooltip when clicking outside or on 'gameout'
    scene.input?.on?.('gameout', () => this.hide());
    scene.input?.on?.('pointerdown', () => this.hide());
  }

  // Helper to convert colors to CSS format
  _toCss(c) {
    if (typeof c === 'string' && c) return c;
    if (typeof c === 'number' && Number.isFinite(c)) {
      const hex = (c >>> 0).toString(16).padStart(6, '0').slice(-6);
      return `#${hex}`;
    }
    return '#dddddd';
  }

  // Clear existing pills (tags) when rendering new ones
  _clearPills() {
    this.pills.removeAll(true);
  }

  // Clear existing body lines when rendering new ones
  _clearBodyLines() {
    this.bodyContainer.removeAll(true);
  }

  // Render body lines as stacked Text objects. Each entry may be:
  //  - a plain string (default muted color)
  //  - { text, color } for a single-color line
  //  - { segments: [{ text, color }, ...] } for a SINGLE row made of multiple
  //    differently-colored runs placed side by side (e.g. a damage formula's
  //    "12 ×1.50 +3 fire ×1.10 gear" where each token means something
  //    different) — same side-by-side placement idea CombatScene's own log
  //    segments use, just simpler: wraps at segment boundaries only (each
  //    segment is already a short atomic token, not a paragraph needing
  //    per-word wrap).
  // Returns the total content width/height for background sizing.
  _renderBodyLines(lines = []) {
    this._clearBodyLines();
    this._aoeAnchorY = null;
    let y = 0;
    let maxW = 0;
    const wrapWidth = 320;
    const segGap = 4;

    for (const entry of lines) {
      const segments = Array.isArray(entry?.segments) ? entry.segments : null;

      if (segments) {
        let x = 0;
        let rowH = 0;
        for (const seg of segments) {
          const segColor = seg?.color != null ? seg.color : (FONTS.muted?.color || '#dddddd');
          const txt = this.scene.add.text(0, 0, seg?.text ?? '', {
            ...FONTS.muted,
            color: this._toCss(segColor)
          }).setOrigin(0, 0).setDepth(this.topDepth);

          if (x > 0 && x + txt.width > wrapWidth) {
            x = 0;
            y += rowH;
            rowH = 0;
          }
          txt.setPosition(x, y);
          this.bodyContainer.add(txt);
          x += txt.width + segGap;
          rowH = Math.max(rowH, txt.height);
          maxW = Math.max(maxW, x - segGap);
        }
        y += rowH;
        continue;
      }

      const isObj = entry && typeof entry === 'object';
      if (isObj && entry.anchorAoe) this._aoeAnchorY = y;
      const text = isObj ? (entry.text ?? '') : String(entry ?? '');
      const color = isObj && entry.color != null ? entry.color : (FONTS.muted?.color || '#dddddd');
      const txt = this.scene.add.text(0, y, text, {
        ...FONTS.muted,
        color: this._toCss(color),
        wordWrap: { width: wrapWidth }
      }).setOrigin(0, 0).setDepth(this.topDepth);
      this.bodyContainer.add(txt);
      y += txt.height;
      maxW = Math.max(maxW, txt.width);
    }
    return { width: maxW, height: y };
  }

  // Color mapping for tags (pill colors)
  _pillColorFor(tag) {
    switch (tag) {
      case 'fire': return { fill: 0xD24E35, stroke: 0xA43A27 };
      case 'cold': return { fill: 0x3BA3D9, stroke: 0x2A7BA3 };
      case 'lightning': return { fill: 0xE6C447, stroke: 0x9E8A2E };
      case 'magic': return { fill: 0x8E6BD9, stroke: 0x6D50AA };
      case 'attack': return { fill: 0x7A7A7A, stroke: 0x4C4C4C };
      case 'aoe': return { fill: 0x4A8F5C, stroke: 0x346642 };
      case 'heal': return { fill: 0x3FA86C, stroke: 0x2B6F48 };
      case 'reaction': return { fill: 0xB56EDC, stroke: 0x7E4CA0 };
      default: return { fill: 0x5A5A5A, stroke: 0x3A3A3A };
    }
  }

  // Render the pills (tags) in the tooltip
_renderPills(tags = []) {
  this._clearPills();
  if (!tags.length) return 0;

  let x = 0;
  let maxH = 0;
  for (const tag of tags) {
    const { fill, stroke } = this._pillColorFor(tag);

    // Create text for the tag
    const txt = this.scene.add.text(0, 0, tag, {
      ...FONTS.muted,
      color: '#ffffff'
    }).setDepth(this.topDepth).setOrigin(0, 0.5);

    const w = txt.width + this.pillPadX * 2;  // Width of the pill (based on text width + padding)
    const h = Math.max(this.pillH, txt.height + this.pillPadY * 2);  // Height of the pill (with padding)

    // Create a graphics object for the pill background
    const graphics = this.scene.add.graphics().setDepth(this.topDepth);
    graphics.fillStyle(fill, 1);  // Set the fill color
    graphics.fillRoundedRect(0, 0, w, h, 8);  // Create rounded rectangle (pill background)
    graphics.lineStyle(1, stroke, 1);  // Set stroke color and thickness
    graphics.strokeRoundedRect(0, 0, w, h, 8);  // Draw border with rounded corners

    // Position the graphics and text (pill background and tag text)
    graphics.setPosition(x, 0);  // Position the pill background
    txt.setPosition(x + this.pillPadX, h / 2);  // Position the text inside the pill

    // Add both the graphics and text to the pills container
    this.pills.add(graphics);
    this.pills.add(txt);

    x += w + this.pillGap;  // Move to the next pill position
    maxH = Math.max(maxH, h);  // Update the max height for layout
  }

  return maxH;  // Return the max height to adjust the tooltip layout
}







  // Reposition the tooltip to follow the cursor (with bounds checking)
  /**
   * Restrict the area the tooltip is allowed to occupy. Defaults to the whole
   * canvas. TownScene narrows it to the visible map, because the right sidebar
   * (x 1100-1280) belongs to UIScene and renders ABOVE TownScene -- a tooltip
   * clamped only to the canvas edge slid underneath it and became unreadable.
   */
  setBounds(left, right, top, bottom) {
    this.boundsLeft = left;
    this.boundsRight = right;
    if (Number.isFinite(top)) this.boundsTop = top;
    if (Number.isFinite(bottom)) this.boundsBottom = bottom;
    return this;
  }

  /**
   * Shared placement for show() and reposition(). Prefers sitting to the right
   * of the cursor; when that would overflow the allowed area it FLIPS to the
   * cursor's left rather than just sliding left, so the pointer never ends up
   * sitting on top of its own tooltip.
   */
  _place(x, y) {
    const w = this._bgW || 0;
    const h = this._bgH || 0;
    const margin = 12;
    const left = this.boundsLeft ?? 0;
    const right = this.boundsRight ?? 1280;

    let px = x + margin;
    if (px + w > right - 8) {
      px = x - margin - w;                       // flip to the left of the cursor
      if (px < left + 8) {
        // Too wide to sit on either side: clamp inside the area and accept
        // overlapping the cursor rather than spilling outside it.
        px = Math.max(left + 8, right - w - 8);
      }
    }
    // Vertical placement had NO bottom clamp: it flipped above the cursor when
    // there was room and otherwise dropped below, so a tall tooltip (a weapon
    // with the Alt affix breakdown open is the usual offender) simply ran off
    // the bottom of the screen. Now it prefers above, then below, and finally
    // clamps inside the allowed band — matching how the horizontal axis has
    // always behaved.
    const top = this.boundsTop ?? 0;
    const bottom = this.boundsBottom ?? (this.scene?.scale?.height ?? 720);
    let py = (y - h - margin >= top + 8) ? y - h - margin : y + margin;
    if (py + h > bottom - 8) py = bottom - h - 8;
    if (py < top + 8) py = top + 8;
    this.container.setPosition(px, py);
  }

  reposition(x, y) {
    if (!this.container?.visible) return;
    this._place(x, y);
  }

  /**
   * Show the tooltip at (x, y) with the provided data.
   * data can be:
   *  - { title, titleColor, lines: string[], tags?: string[] }
   *  - string[] (first line => title, rest => body)
   */
  show(x, y, data) {
    let titleText = '';
    let titleColor = '#dddddd';
    let bodyLines = [];
    let tags = [];
    let aoeGrid = null;

    if (Array.isArray(data)) {
      titleText = data[0] || '';
      bodyLines = data.slice(1);
    } else if (data && typeof data === 'object') {
      titleText = data.title || '';
      titleColor = data.titleColor || '#dddddd';
      bodyLines = Array.isArray(data.lines) ? data.lines : [];
      tags = Array.isArray(data.tags) ? data.tags : [];
      aoeGrid = data.aoeGrid || null;
    }

    // Set title
    this.title.setText(titleText).setColor(this._toCss(titleColor));

    // Pills row (tags)
    this.pills.setPosition(this.padding, this.padding);
    const titleBounds = this.title.getBounds();
    const pillTop = this.padding + (titleBounds.height ? titleBounds.height + this.gapTitlePills : 0);
    this.pills.y = pillTop;
    const pillH = this._renderPills(tags);

    // Body under title (+pills if present)
    const bodyTop = pillH
      ? (pillTop + pillH + this.gapPillsBody)
      : (this.padding + (titleBounds.height ? titleBounds.height + this.gapTitleBody : 0));

    this.bodyContainer.setPosition(this.padding, bodyTop);
    const { width: bw, height: bh } = this._renderBodyLines(bodyLines);

    // Use .width/.height directly — reliably set synchronously after setText(),
    // unlike getBounds() which can return NaN before the first render cycle.
    const tw = this.title.width || 0;
    const th = this.title.height || 0;
    const pw = this.pills.getBounds().width || 0;
    const contentWidth = Math.max(tw, bw, pw);
    const contentHeight =
      (th ? th + this.gapTitleBody : 0) +
      (pillH ? pillH + this.gapPillsBody : 0) +
      bh;

    const bgW = contentWidth + this.padding * 2;
    const bgH = Math.max(this.padding * 2 + contentHeight, 24);
    this.bg.clear();
    this.bg.fillStyle(COLORS.panel, 1);
    this.bg.fillRect(0, 0, bgW, bgH);
    this.bg.lineStyle(1, COLORS.border, 1);
    this.bg.strokeRect(0, 0, bgW, bgH);
    // ---- AoE mini-diagram, drawn into the dead space to the RIGHT of the
    // short Cost/MP/Cooldown rows. Costs no extra tooltip height: the width is
    // already set by the description's 320px wrap, so that gutter is empty.
    this._clearAoeGrid();
    if (aoeGrid) {
      const CELL = 10, GAP = 3, COLS = 3, ROWS = 5;
      // Extra air either side of the MID column. The formation is brick-offset
      // (mid rank sits between the front/back rows, not aligned with them), and
      // a uniform gap made that read as one solid block instead of three ranks.
      const MID_GAP = 7;
      const colX = (c) => c * (CELL + GAP) + (c >= 1 ? MID_GAP : 0) + (c >= 2 ? MID_GAP : 0);
      const gW = colX(COLS - 1) + CELL;
      const gH = ROWS * CELL + (ROWS - 1) * GAP;
      const gx = bgW - this.padding - gW - 8;
      // Anchored to the Cost line (see anchorAoe in skillTooltip.js) so it sits
      // BELOW the Applies/AoE/reward block, whose height varies per skill and
      // was colliding with the diagram on skills with several reward lines.
      const anchor = this._aoeAnchorY;
      const bodyTopAbs = this.bodyContainer ? this.bodyContainer.y : this.padding;
      const gy = anchor != null
        ? Math.min(bodyTopAbs + anchor, bgH - this.padding - gH)
        : Math.max(this.padding, bgH - this.padding - gH);
      const g = this.scene.add.graphics().setDepth(this.topDepth);
      const hit = new Set(aoeGrid.hit || []);
      for (const slot of AOE_GRID_SLOTS) {
        const x = gx + colX(slot.col);
        const y = gy + slot.row * (CELL + GAP);
        const isAim = aoeGrid.aim === slot.id;
        const isHit = hit.has(slot.id);
        if (isAim)       { g.fillStyle(0xffffff, 0.95); g.fillRect(x, y, CELL, CELL); }
        else if (isHit)  { g.fillStyle(0xffaa33, 0.90); g.fillRect(x, y, CELL, CELL); }
        else             { g.fillStyle(0x000000, 0.45); g.fillRect(x, y, CELL, CELL);
                           g.lineStyle(1, 0x666666, 0.7); g.strokeRect(x + 0.5, y + 0.5, CELL - 1, CELL - 1); }
      }
      // Thin bar down the FRONT edge (right-hand column) so the player can
      // tell which end of the formation is the front line at a glance.
      // Front-line marker on the LEFT, matching the flipped orientation.
      g.fillStyle(0x88aacc, 0.55);
      g.fillRect(gx - 4, gy, 2, gH);
      // Faint frame so the squares read as one diagram rather than loose marks.
      g.lineStyle(1, 0x777777, 0.45);
      g.strokeRect(gx - 8.5, gy - 4.5, gW + 13, gH + 9);
      this.container.add(g);
      this._aoeGridGfx = g;
    }

    this._bgW = bgW;
    this._bgH = bgH;

    // Place above cursor; fall back to below if too close to top edge, and
    // flip to the cursor's left if there isn't room on the right (see _place).
    this._place(x, y);
    this.container.setVisible(true);
  }

  // Hide the tooltip
  _clearAoeGrid() { if (this._aoeGridGfx) { this._aoeGridGfx.destroy(); this._aoeGridGfx = null; } }

  hide() { this.container.setVisible(false); }

  // Destroy the tooltip container
  destroy() { this.container.destroy(); }
}
