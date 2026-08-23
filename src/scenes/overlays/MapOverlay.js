import { createOverlayFrame } from '../../ui/OverlayFrame.js';
import { setupSceneCursor } from '../../ui/cursor.js';
import MapRegionLayer from '../../ui/MapRegionLayer.js';


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

    this.mapArea = new Phaser.Geom.Rectangle(
      bounds.x + 24,
      bounds.y + 72,
      bounds.width - 48,
      bounds.height - 140
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

      this._updateMapBounds();
      this._clampMapPosition();

      // Hoverable region hotspots (see data/mapRegions.js).
      this.regionLayer = new MapRegionLayer(this, {
        container: this.mapContainer,
        image: this.mapImage,
        depth: contentDepth,
        clipRect: this.mapArea,
        onHover: (r) => {
          // Guarded: scene instance properties survive stop/launch, so a
          // stale Text from a previous create() can still be referenced here
          // after its texture is gone (setText would throw on a dead frame).
          if (this._regionInfo?.scene && this._regionInfo.frame) {
            this._regionInfo.setText(r ? `${r.name} — ${r.blurb}` : '');
          }
        },
      });

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
    this._updateMapBounds();
    this._clampMapPosition();
    this.regionLayer?.redraw();
    this._redrawCalibration?.();
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
