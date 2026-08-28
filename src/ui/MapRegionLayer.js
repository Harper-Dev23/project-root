// src/ui/MapRegionLayer.js
// Reusable hover/click region layer for the Behel'ith island map, shared by
// MapOverlay (browse + hover names) and HuntMapOverlay (pick a hunt zone).
//
// Geometry notes — the two coordinate spaces this juggles:
//   • Region polygons in data/mapRegions.js are NORMALIZED 0..1 against the
//     map image, so they survive any zoom/fit factor.
//   • The highlight Graphics lives INSIDE the same container as the map
//     image and is kept at the image's own scale, so it pans (container)
//     and zooms (scale) in lockstep with the art for free, and can be drawn
//     once in native image pixels rather than re-projected every frame.
//   • Labels are deliberately NOT in that container — they're screen-space
//     so the font stays a constant readable size no matter the zoom.

import { MAP_REGIONS, TERRAIN_TINT, pointInPoly, polyLabelPoint } from '../../data/mapRegions.js';

export default class MapRegionLayer {
  /**
   * @param {Phaser.Scene} scene
   * @param {object} opts
   *   container    — the panning container holding the map image
   *   image        — the map Phaser.GameObjects.Image
   *   depth        — base depth; layer draws at depth+1, labels at depth+6
   *   clipRect     — Phaser.Geom.Rectangle the map is visible within
   *   selectableIds— Set/array of region ids that are clickable (null = all)
   *   onSelect     — fn(region) when a selectable region is clicked
   *   onHover      — fn(region|null) whenever the hovered region changes
   *   dimUnselectable — draw non-selectable regions muted (hunt-picker mode)
   *   showIdleOutlines— draw every region's outline even when not hovered.
   *                     False on the browse map (the art should read as art
   *                     until you point at something); true in the picker,
   *                     where you need to see all the options at once.
   */
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.container = opts.container;
    this.image = opts.image;
    this.depth = opts.depth ?? 0;
    this.clipRect = opts.clipRect || null;
    this.onSelect = opts.onSelect || null;
    this.onHover = opts.onHover || null;
    this.dimUnselectable = !!opts.dimUnselectable;
    this.showIdleOutlines = opts.showIdleOutlines !== false;
    this.enabled = true;

    // Optional externally-driven highlight (e.g. hovering a legend row)
    // that behaves exactly like a pointer hover on the map.
    this.forced = null;

    this.selectable = opts.selectableIds
      ? new Set(opts.selectableIds)
      : null; // null = everything is selectable

    this.regions = MAP_REGIONS;
    this.hovered = null;

    // Highlight graphics — inside the container, matched to the image scale.
    this.gfx = scene.add.graphics().setDepth(this.depth + 1);
    this.container.add(this.gfx);
    if (this.clipRect && this.image?.mask) this.gfx.setMask(this.image.mask);

    // Screen-space label (constant size regardless of zoom).
    this.labelBg = scene.add.rectangle(0, 0, 10, 10, 0x000000, 0.82)
      .setOrigin(0.5).setDepth(this.depth + 6).setVisible(false)
      .setStrokeStyle(1, 0x6a7a90);
    this.label = scene.add.text(0, 0, '', {
      fontSize: '15px', color: '#ffeebb', fontFamily: 'Georgia, Gelasio, serif',
    }).setOrigin(0.5).setDepth(this.depth + 7).setVisible(false);
    this.sublabel = scene.add.text(0, 0, '', {
      fontSize: '11px', color: '#9aa4b4',
    }).setOrigin(0.5).setDepth(this.depth + 7).setVisible(false);

    this.redraw();
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) this._setHovered(null);
  }

  /** Screen point → normalized 0..1 image space (null if outside the art). */
  screenToNorm(px, py) {
    const img = this.image;
    if (!img) return null;
    const s = img.scaleX || 1;
    const localX = (px - this.container.x) / s;
    const localY = (py - this.container.y) / s;
    const nx = localX / img.width + 0.5;
    const ny = localY / img.height + 0.5;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return null;
    return { nx, ny };
  }

  /** Normalized 0..1 → screen point. */
  normToScreen(nx, ny) {
    const img = this.image;
    const s = img.scaleX || 1;
    return {
      x: this.container.x + (nx - 0.5) * img.width * s,
      y: this.container.y + (ny - 0.5) * img.height * s,
    };
  }

  regionAt(px, py) {
    if (this.clipRect && !Phaser.Geom.Rectangle.Contains(this.clipRect, px, py)) return null;
    const n = this.screenToNorm(px, py);
    if (!n) return null;
    // Iterate in reverse so later (smaller, more specific) regions win where
    // two outlines overlap at their shared border.
    for (let i = this.regions.length - 1; i >= 0; i--) {
      const r = this.regions[i];
      if (pointInPoly(r.poly, n.nx, n.ny)) return r;
    }
    return null;
  }

  isSelectable(region) {
    if (!region) return false;
    return this.selectable ? this.selectable.has(region.id) : true;
  }

  handlePointerMove(pointer) {
    if (!this.enabled) return;
    // A legend-driven highlight outranks the pointer, so moving the mouse
    // toward the legend doesn't clear the row you're pointing at.
    if (this.forced) return;
    const r = this.regionAt(pointer.x, pointer.y);
    this._setHovered(r);
    if (r) this._positionLabel(r);
  }

  /** Highlight a region from outside the map (legend row hover). */
  highlightRegion(regionOrId) {
    const r = typeof regionOrId === 'string'
      ? this.regions.find(x => x.id === regionOrId)
      : regionOrId;
    this.forced = r || null;
    this._setHovered(r || null);
    if (r) this._positionLabel(r);
  }

  clearHighlight() {
    this.forced = null;
    this._setHovered(null);
  }

  handlePointerDown(pointer) {
    if (!this.enabled) return false;
    const r = this.regionAt(pointer.x, pointer.y);
    if (r && this.isSelectable(r) && this.onSelect) {
      this.onSelect(r);
      return true;
    }
    return false;
  }

  _setHovered(r) {
    if (this.hovered === r) return;
    this.hovered = r;
    this.redraw();
    if (this.onHover) this.onHover(r);

    const show = !!r;
    this.labelBg.setVisible(show);
    this.label.setVisible(show);
    this.sublabel.setVisible(show);
    if (!show) return;

    this.label.setText(r.name);
    const selectable = this.isSelectable(r);
    this.label.setColor(selectable ? '#ffeebb' : '#98a0ac');

    // Terrain is always shown — it's the one fact that's true on every
    // screen. The call-to-action is appended only in PICKER mode (a layer
    // with an onSelect handler, i.e. HuntMapOverlay); the plain Regional
    // Map is browse-only, so "click to hunt here" would be a lie there.
    const isPicker = !!this.onSelect;
    let sub = r.terrain;
    if (!selectable) {
      // The camp's terrain IS 'camp', so appending it reads as "camp · home
      // camp" — just say what it is.
      sub = r.isCamp ? 'home camp · you are here' : `${r.terrain} · not yet reachable`;
    } else if (isPicker && r.huntZoneId) {
      sub = `${r.terrain} · ▸ click to hunt here`;
    }
    this.sublabel.setText(sub);
  }

  _positionLabel(r) {
    // polyLabelPoint, not the raw centroid — concave regions (the crescent
    // Mountains of Proverbs) have a centroid that lands outside themselves.
    const [cx, cy] = polyLabelPoint(r.poly);
    const p = this.normToScreen(cx, cy);
    const w = Math.max(this.label.width, this.sublabel.width) + 22;
    const h = 40;

    // Keep the label inside the visible map window rather than letting it
    // drift off the panel edge when a region sits near the border.
    let lx = p.x, ly = p.y;
    if (this.clipRect) {
      lx = Phaser.Math.Clamp(lx, this.clipRect.x + w / 2 + 4, this.clipRect.right - w / 2 - 4);
      ly = Phaser.Math.Clamp(ly, this.clipRect.y + h / 2 + 4, this.clipRect.bottom - h / 2 - 4);
    }

    this.labelBg.setPosition(lx, ly).setSize(w, h);
    this.label.setPosition(lx, ly - 8);
    this.sublabel.setPosition(lx, ly + 11);
  }

  /** Rebuilds every outline. Cheap enough to call on hover/zoom/pan. */
  redraw() {
    const img = this.image;
    if (!img || !this.gfx) return;
    const g = this.gfx;
    const s = img.scaleX || 1;
    g.setScale(s);
    g.clear();

    const W = img.width, H = img.height;
    const toLocal = ([nx, ny]) => [(nx - 0.5) * W, (ny - 0.5) * H];

    for (const r of this.regions) {
      const pts = r.poly.map(toLocal);
      const isHover = this.hovered === r;
      const selectable = this.isSelectable(r);
      const tint = TERRAIN_TINT[r.terrain] ?? 0xffffff;

      let fillAlpha = 0;
      let lineAlpha = this.showIdleOutlines ? (selectable ? 0.30 : 0.12) : 0;
      let lineW = 1;
      let lineColor = tint;

      if (this.dimUnselectable && !selectable) {
        // Hunt-picker mode: everything you can't go to gets a flat grey
        // wash, so the two open zones read as the only live options.
        fillAlpha = 0.34;
        lineColor = 0x2a3038;
        lineAlpha = 0.5;
      } else if (selectable && this.dimUnselectable) {
        // Standing invitation on the pickable zones even before hover.
        fillAlpha = isHover ? 0.42 : 0.20;
        lineAlpha = 1;
        lineW = isHover ? 3 : 2;
        lineColor = isHover ? 0xffeebb : tint;
      }

      if (isHover && !this.dimUnselectable) {
        fillAlpha = 0.34;
        lineAlpha = 1;
        lineW = 2.5;
      }

      // Nothing to paint for an idle region on the browse map — skip it
      // entirely so a 60-point river outline costs nothing when hidden.
      if (fillAlpha <= 0 && lineAlpha <= 0) continue;

      if (fillAlpha > 0) {
        g.fillStyle(this.dimUnselectable && !selectable ? 0x10141a : tint, fillAlpha);
        g.beginPath();
        g.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
        g.closePath();
        g.fillPath();
      }

      g.lineStyle(lineW / s, lineColor, lineAlpha);
      g.beginPath();
      g.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
      g.closePath();
      g.strokePath();
    }
  }

  destroy() {
    this.gfx?.destroy();
    this.labelBg?.destroy();
    this.label?.destroy();
    this.sublabel?.destroy();
  }
}
