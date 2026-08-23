import { createOverlayFrame } from '../../ui/OverlayFrame.js';
import { setupSceneCursor } from '../../ui/cursor.js';
import MapRegionLayer from '../../ui/MapRegionLayer.js';
import { MAP_REGIONS, TERRAIN_TINT, polyLabelPoint } from '../../../data/mapRegions.js';


export default class MapOverlay extends Phaser.Scene {
  constructor() {
    super({ key: 'MapOverlay' });
    this.mapContainer = null;
    this.mapImage = null;
    this.mapArea = null;
    this.mapClamp = null;
    this.currentScale = 1;
    this.isDragging = false;
    this.dragOrigin = null;
  }

  create() {
    const town = this.scene.get('TownScene');
    setupSceneCursor(this);
    if (town?.input) town.input.enabled = false;

    // Scene instances are reused across stop/launch, so every object
    // reference from a previous create() is stale here — clear them before
    // rebuilding or a hover callback can touch a destroyed Text.
    this.regionLayer?.destroy();
    this.regionLayer = null;
    this._regionInfo = null;
    this._legendRows = null;
    this._mapFrameGfx = null;
    this._mapSeaGfx = null;
    this._calGfx = null;
    this._calibrating = false;
    this._calPoints = [];

    const frame = createOverlayFrame(this, {
      title: 'Regional Map',
      fullscreen: true,
      onClose: () => this._close(),
    });

    const contentDepth = frame.depth;
    const backgroundDepth = contentDepth - 1;
    const bounds = frame.bounds;

    // Reserve a left-hand column for the region legend. The map viewport
    // only loses that width — pan and zoom are untouched, and the island
    // still fits comfortably at the default fit-scale.
    const LEGEND_W = 208;
    const LEGEND_GAP = 14;

    // Top edge at +84, not +72 — the instruction line sits at +60 and runs
    // ~20px tall, so the old value clipped it behind the legend panel.
    const CONTENT_TOP = bounds.y + 84;
    const CONTENT_H = bounds.height - 152;

    this.legendRect = new Phaser.Geom.Rectangle(
      bounds.x + 24, CONTENT_TOP, LEGEND_W, CONTENT_H
    );

    this.mapArea = new Phaser.Geom.Rectangle(
      bounds.x + 24 + LEGEND_W + LEGEND_GAP,
      CONTENT_TOP,
      bounds.width - 48 - LEGEND_W - LEGEND_GAP,
      CONTENT_H
    );

    const infoText = this.add.text(bounds.x + 32, bounds.y + 60,
      'Drag to pan, scroll to zoom, hover a region to name it.', {
      fontSize: '16px',
      color: '#cccccc'
    })
      .setDepth(contentDepth)
      .setAlpha(0.85);

    // Detail readout for the hovered region — sits under the map window so
    // the map itself stays uncluttered (the floating label carries only the
    // name; the blurb lands here).
    this._regionInfo = this.add.text(
      bounds.x + 32, bounds.y + bounds.height - 52, '', {
        fontSize: '13px', color: '#9aa4b4',
        wordWrap: { width: bounds.width - 200 },
      }).setDepth(contentDepth);

    const areaBg = this.add.rectangle(
      this.mapArea.x + this.mapArea.width / 2,
      this.mapArea.y + this.mapArea.height / 2,
      this.mapArea.width,
      this.mapArea.height,
      0x000000,
      0.3
    )
      .setStrokeStyle(1, 0xffffff, 0.2)
      .setDepth(backgroundDepth);

    const maskGraphics = this.add.graphics();
    maskGraphics.fillStyle(0xffffff, 1);
    maskGraphics.fillRect(this.mapArea.x, this.mapArea.y, this.mapArea.width, this.mapArea.height);
    maskGraphics.setVisible(false);
    const areaMask = maskGraphics.createGeometryMask();

    this.mapContainer = this.add.container(
      this.mapArea.x + this.mapArea.width / 2,
      this.mapArea.y + this.mapArea.height / 2
    ).setDepth(contentDepth);
    this.mapContainer.setMask(areaMask);

    const availableKey = ['map_behelith_island', 'campMap'].find(key => this.textures.exists(key)) || null;

    if (availableKey) {
      this.mapImage = this.add.image(0, 0, availableKey);
      this.mapImage.setOrigin(0.5);
      this.mapContainer.add(this.mapImage);

      const fitScale = Math.min(
        (this.mapArea.width - 48) / this.mapImage.width,
        (this.mapArea.height - 48) / this.mapImage.height,
        1
      );
      this.currentScale = fitScale;
      this.mapImage.setScale(this.currentScale);

      this._buildMapFrame(contentDepth);

      this._updateMapBounds();
      this._clampMapPosition();

      // Hoverable region hotspots (see data/mapRegions.js).
      // showIdleOutlines:false — the browse map shows the art clean and
      // only outlines what you're actually pointing at; the legend below
      // is how you find things without painting 25 outlines over it.
      this.regionLayer = new MapRegionLayer(this, {
        container: this.mapContainer,
        image: this.mapImage,
        depth: contentDepth,
        clipRect: this.mapArea,
        showIdleOutlines: false,
        onHover: (r) => {
          this._syncLegendHighlight?.(r);
          // Guarded: scene instance properties survive stop/launch, so a
          // stale Text from a previous create() can still be referenced here
          // after its texture is gone (setText would throw on a dead frame).
          if (this._regionInfo?.scene && this._regionInfo.frame) {
            this._regionInfo.setText(r ? `${r.name} — ${r.blurb}` : '');
          }
        },
      });

      this._buildLegend(contentDepth);
      this._buildCalibrateButton(bounds, contentDepth);
    } else {
      this.add.text(
        this.mapArea.x + 20,
        this.mapArea.y + 20,
        'Map asset not found. Place "Behelith_Island_Map.webp" in assets/maps to display it.',
        {
          fontSize: '18px',
          color: '#ffddaa',
          wordWrap: { width: this.mapArea.width - 40 }
        }
      ).setDepth(contentDepth);
    }

    this._onPointerDown = (pointer) => {
      if (!this.mapImage) return;
      // Calibration mode swallows clicks to collect polygon points.
      if (this._calibrating && Phaser.Geom.Rectangle.Contains(this.mapArea, pointer.x, pointer.y)) {
        this._calibrateClick(pointer);
        return;
      }
      if (Phaser.Geom.Rectangle.Contains(this.mapArea, pointer.x, pointer.y)) {
        this.isDragging = true;
        this.dragOrigin = {
          pointerX: pointer.x,
          pointerY: pointer.y,
          containerX: this.mapContainer.x,
          containerY: this.mapContainer.y
        };
      }
    };

    this._onPointerUp = () => {
      this.isDragging = false;
      this.dragOrigin = null;
    };

    this._onPointerMove = (pointer) => {
      if (!this.isDragging || !this.dragOrigin) {
        this.regionLayer?.handlePointerMove(pointer);
        return;
      }
      const dx = pointer.x - this.dragOrigin.pointerX;
      const dy = pointer.y - this.dragOrigin.pointerY;
      this.mapContainer.x = this.dragOrigin.containerX + dx;
      this.mapContainer.y = this.dragOrigin.containerY + dy;
      this._clampMapPosition();
    };

    this._onWheel = (_pointer, _go, _dx, deltaY) => {
      if (!this.mapImage) return;
      const pointer = this.input.activePointer;
      if (!Phaser.Geom.Rectangle.Contains(this.mapArea, pointer.x, pointer.y)) return;
      const step = deltaY > 0 ? -0.1 : 0.1;
      this._setMapScale(this.currentScale + step);
    };

    this.input.on('pointerdown', this._onPointerDown, this);
    this.input.on('pointerup', this._onPointerUp, this);
    this.input.on('pointerupoutside', this._onPointerUp, this);
    this.input.on('pointermove', this._onPointerMove, this);
    this.input.on('wheel', this._onWheel, this);

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.input.off('pointerdown', this._onPointerDown, this);
      this.input.off('pointerup', this._onPointerUp, this);
      this.input.off('pointerupoutside', this._onPointerUp, this);
      this.input.off('pointermove', this._onPointerMove, this);
      this.input.off('wheel', this._onWheel, this);
    });
  }

  _setMapScale(scale) {
    if (!this.mapImage) return;
    this.currentScale = Phaser.Math.Clamp(scale, 0.4, 2.5);
    this.mapImage.setScale(this.currentScale);
    this._syncMapFrameScale();
    this._updateMapBounds();
    this._clampMapPosition();
    this.regionLayer?.redraw();
    this._redrawCalibration?.();
  }

  // ── Decorative map frame ──────────────────────────────────────────────────
  // Zoomed out, the map art used to simply stop — a hard rectangular edge
  // against the empty panel, which read as a texture floating in a void
  // rather than a chart. Two pieces fix that, both living INSIDE
  // mapContainer so they pan and zoom with the art:
  //
  //   1. An "open sea" bleed painted well beyond the image bounds, in the
  //      map's own edge tone (sampled from the art: a deep teal ~#2e4249),
  //      fading outward. Panning past the coastline now runs into more
  //      ocean instead of a cut-off.
  //   2. A drawn border right on the image edge — a broad band, a double
  //      hairline, and corner ornaments — so the chart has a physical rim.
  //
  // Drawn once in NATIVE image pixels and rescaled with the image (same
  // approach MapRegionLayer uses), so it never needs re-rendering on zoom.

  _buildMapFrame(depth) {
    if (!this.mapImage) return;
    const W = this.mapImage.width;
    const H = this.mapImage.height;
    const halfW = W / 2;
    const halfH = H / 2;

    const SEA = 0x2e4249;

    // --- 1. Open-sea bleed, behind the art ---------------------------------
    // A single flat fill, deliberately. A stepped alpha falloff was tried
    // first and the bands read as concentric rectangles rather than a
    // gradient — worse than no falloff at all. One uniform sea tone lets
    // the framed chart sit on open water instead.
    // Padding is large enough to cover the viewport at minimum zoom (0.4)
    // from any pan position, so no edge is ever reachable.
    const SEA_PAD = 4000;
    const sea = this.add.graphics();
    sea.fillStyle(SEA, 1);
    sea.fillRect(-halfW - SEA_PAD, -halfH - SEA_PAD, W + SEA_PAD * 2, H + SEA_PAD * 2);
    this.mapContainer.addAt(sea, 0);   // behind the image
    this._mapSeaGfx = sea;

    // --- 2. The frame itself, over the art ---------------------------------
    const frame = this.add.graphics();

    // Broad outer band sitting just outside the art edge.
    frame.lineStyle(26, 0x1b2731, 0.95);
    frame.strokeRect(-halfW - 13, -halfH - 13, W + 26, H + 26);
    // Warm inlay, then a fine dark keyline hard against the art.
    frame.lineStyle(5, 0x6b5a3e, 0.9);
    frame.strokeRect(-halfW - 3, -halfH - 3, W + 6, H + 6);
    frame.lineStyle(2, 0x141c24, 1);
    frame.strokeRect(-halfW, -halfH, W, H);

    // Corner ornaments — short right-angle brackets in the warm inlay tone.
    const arm = 46;
    frame.lineStyle(6, 0xbba46a, 0.95);
    const corners = [
      [-halfW - 8, -halfH - 8,  1,  1],
      [ halfW + 8, -halfH - 8, -1,  1],
      [-halfW - 8,  halfH + 8,  1, -1],
      [ halfW + 8,  halfH + 8, -1, -1],
    ];
    for (const [cx, cy, sx, sy] of corners) {
      frame.beginPath();
      frame.moveTo(cx, cy + sy * arm);
      frame.lineTo(cx, cy);
      frame.lineTo(cx + sx * arm, cy);
      frame.strokePath();
    }

    this.mapContainer.add(frame);
    this._mapFrameGfx = frame;

    this._syncMapFrameScale();
  }

  /** Keeps the frame and sea bleed locked to the image's current scale. */
  _syncMapFrameScale() {
    const s = this.mapImage?.scaleX ?? 1;
    this._mapSeaGfx?.setScale(s);
    this._mapFrameGfx?.setScale(s);
  }

  // ── Region legend ─────────────────────────────────────────────────────────
  // Because the browse map no longer draws idle outlines, this list is how
  // you find a region without hunting for it with the cursor. Hovering a row
  // highlights it on the map; clicking centres the map on it (handy once
  // you've zoomed in and lost your bearings).

  _buildLegend(depth) {
    const R = this.legendRect;
    if (!R) return;

    this.add.rectangle(R.centerX, R.centerY, R.width, R.height, 0x090c14, 0.72)
      .setStrokeStyle(1, 0x2a3346).setDepth(depth);

    this.add.text(R.x + 12, R.y + 10, 'REGIONS', {
      fontSize: '11px', color: '#6a7a90', fontStyle: 'bold',
    }).setDepth(depth + 1);

    this.add.text(R.x + R.width - 12, R.y + 10, `${MAP_REGIONS.length}`, {
      fontSize: '11px', color: '#4f5a68',
    }).setOrigin(1, 0).setDepth(depth + 1);

    const top = R.y + 30;
    const rowH = Math.min(20, (R.height - 44) / MAP_REGIONS.length);
    this._legendRows = [];

    MAP_REGIONS.forEach((region, i) => {
      const y = top + i * rowH;
      const tint = TERRAIN_TINT[region.terrain] ?? 0xffffff;
      const isHunt = !!region.huntZoneId;

      // Full-width hit strip so the whole row is hoverable, not just glyphs.
      const strip = this.add.rectangle(R.centerX, y + rowH / 2, R.width - 8, rowH, 0xffffff, 0)
        .setDepth(depth + 1)
        .setInteractive({ useHandCursor: true });

      const swatch = this.add.rectangle(R.x + 14, y + rowH / 2, 7, 7, tint, 0.95)
        .setDepth(depth + 2);

      const label = this.add.text(R.x + 26, y + rowH / 2,
        (isHunt ? '★ ' : '') + region.name, {
          fontSize: '11px',
          color: isHunt ? '#ffdd88' : '#9aa4b4',
        }).setOrigin(0, 0.5).setDepth(depth + 2);

      const row = { region, strip, swatch, label, isHunt };
      strip.on('pointerover', () => {
        this.regionLayer?.highlightRegion(region);
        this._paintLegendRow(row, true);
      });
      strip.on('pointerout', () => {
        this.regionLayer?.clearHighlight();
        this._paintLegendRow(row, false);
      });
      strip.on('pointerdown', () => this._centreOnRegion(region));

      this._legendRows.push(row);
    });
  }

  _paintLegendRow(row, on) {
    row.strip.setFillStyle(0xffffff, on ? 0.08 : 0);
    row.label.setColor(on ? '#ffeebb' : (row.isHunt ? '#ffdd88' : '#9aa4b4'));
  }

  /** Keeps legend rows in sync when the highlight came from the map itself. */
  _syncLegendHighlight(region) {
    if (!this._legendRows) return;
    this._legendRows.forEach(row => this._paintLegendRow(row, row.region === region));
  }

  /** Pans the map so a region sits in the middle of the viewport. */
  _centreOnRegion(region) {
    if (!this.mapImage || !this.regionLayer) return;
    const [nx, ny] = polyLabelPoint(region.poly);
    const s = this.mapImage.scaleX || 1;
    // Where that point sits relative to the container origin, then offset
    // the container so it lands on the viewport centre.
    this.mapContainer.x = this.mapArea.centerX - (nx - 0.5) * this.mapImage.width * s;
    this.mapContainer.y = this.mapArea.centerY - (ny - 0.5) * this.mapImage.height * s;
    this._clampMapPosition();
    this.regionLayer.highlightRegion(region);
  }

  // ── Calibration mode ──────────────────────────────────────────────────────
  // Dev tool for correcting region polygons without guessing in a text
  // editor: click around a region's outline on the real art, and it prints a
  // ready-to-paste `poly: [...]` array (normalized 0..1) to the console.
  // Purely additive — nothing here touches normal browsing.

  _buildCalibrateButton(bounds, depth) {
    this._calibrating = false;
    this._calPoints = [];
    this._calGfx = this.add.graphics().setDepth(depth + 8);

    const btn = this.add.text(bounds.right - 32, bounds.y + 62, '⟐ Calibrate', {
      fontSize: '13px', color: '#6f7a88', backgroundColor: '#141820',
      padding: { x: 8, y: 4 },
    }).setOrigin(1, 0).setDepth(depth + 8)
      .setInteractive({ useHandCursor: true });

    this._calHint = this.add.text(bounds.right - 32, bounds.y + 88, '', {
      fontSize: '11px', color: '#7f8a98', align: 'right',
    }).setOrigin(1, 0).setDepth(depth + 8);

    btn.on('pointerdown', () => {
      this._calibrating = !this._calibrating;
      this._calPoints = [];
      this._calGfx.clear();
      btn.setColor(this._calibrating ? '#ffdd88' : '#6f7a88');
      this._calHint.setText(this._calibrating
        ? 'Click the outline point by point.\nRight-click / Esc-less: press C to copy, X to clear.'
        : '');
      this.regionLayer?.setEnabled(!this._calibrating);
    });

    this._calKeys = this.input.keyboard.on('keydown', (e) => {
      if (!this._calibrating) return;
      const k = (e.key || '').toLowerCase();
      if (k === 'x') { this._calPoints = []; this._redrawCalibration(); }
      if (k === 'z') { this._calPoints.pop(); this._redrawCalibration(); }
      if (k === 'c') {
        const poly = this._calPoints.map(([x, y]) => `[${x.toFixed(3)},${y.toFixed(3)}]`).join(',');
        const out = `poly: [${poly}],`;
        console.log('[map calibration]\n' + out);
        try { navigator.clipboard?.writeText(out); } catch { /* console is enough */ }
        this._calHint.setText(`Copied ${this._calPoints.length} points to console/clipboard.`);
      }
    });
  }

  _calibrateClick(pointer) {
    const n = this.regionLayer?.screenToNorm(pointer.x, pointer.y);
    if (!n) return;
    this._calPoints.push([n.nx, n.ny]);
    this._redrawCalibration();
    this._calHint.setText(`${this._calPoints.length} points · C=copy  Z=undo  X=clear`);
  }

  _redrawCalibration() {
    if (!this._calGfx || !this.regionLayer) return;
    const g = this._calGfx;
    g.clear();
    if (!this._calPoints?.length) return;
    const pts = this._calPoints.map(([nx, ny]) => this.regionLayer.normToScreen(nx, ny));
    g.lineStyle(2, 0xffdd88, 1);
    g.beginPath();
    g.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
    if (pts.length > 2) g.closePath();
    g.strokePath();
    g.fillStyle(0xffdd88, 1);
    pts.forEach(p => g.fillCircle(p.x, p.y, 3));
  }

  _updateMapBounds() {
    if (!this.mapImage || !this.mapArea) return;
    const areaCenterX = this.mapArea.x + this.mapArea.width / 2;
    const areaCenterY = this.mapArea.y + this.mapArea.height / 2;
    const mapWidth = this.mapImage.displayWidth;
    const mapHeight = this.mapImage.displayHeight;
    const clampX = Math.max(0, mapWidth - this.mapArea.width) / 2;
    const clampY = Math.max(0, mapHeight - this.mapArea.height) / 2;

    this.mapClamp = {
      minX: areaCenterX - clampX,
      maxX: areaCenterX + clampX,
      minY: areaCenterY - clampY,
      maxY: areaCenterY + clampY
    };
  }

  _clampMapPosition() {
    if (!this.mapContainer || !this.mapClamp) return;
    this.mapContainer.x = Phaser.Math.Clamp(this.mapContainer.x, this.mapClamp.minX, this.mapClamp.maxX);
    this.mapContainer.y = Phaser.Math.Clamp(this.mapContainer.y, this.mapClamp.minY, this.mapClamp.maxY);
    this._redrawCalibration?.();
  }

  _close() {
    const town = this.scene.get('TownScene');
    if (town?.input) town.input.enabled = true;
    this.scene.resume('UIScene');
    this.scene.stop();
  }
}
