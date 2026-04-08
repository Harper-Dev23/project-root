import { createOverlayFrame } from '../../ui/OverlayFrame.js';


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
    if (town?.input) town.input.enabled = false;

    const frame = createOverlayFrame(this, {
      title: 'Regional Map',
      onClose: () => this._close(),
      bgImage: 'menu_parchment_background'
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
      'Drag to pan the map, scroll to zoom. Click outside the panel to close.', {
      fontSize: '16px',
      color: '#cccccc'
    })
      .setDepth(contentDepth)
      .setAlpha(0.85);

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
      if (!this.isDragging || !this.dragOrigin) return;
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
  }

  _close() {
    const town = this.scene.get('TownScene');
    if (town?.input) town.input.enabled = true;
    this.scene.resume('UIScene');
    this.scene.stop();
  }
}
