// src/scenes/overlays/HuntMapOverlay.js
// "Choose Location" sub-screen, opened from HuntHubOverlay.
//
// Was a two-card list; now the real island map with the playable zones lit
// and clickable and everything else washed out as known-but-unreachable.
// Region hotspots come from data/mapRegions.js (shared with MapOverlay via
// MapRegionLayer); the zone stats panel still comes from data/zones.js, so
// the map is the picker and the panel is the detail.

import { createOverlayFrame } from '../../ui/OverlayFrame.js';
import { setupSceneCursor } from '../../ui/cursor.js';
import { createPanel } from '../../ui/GamePanel.js';
import { SoundManager } from '../../systems/SoundManager.js';
import { listZones, getZone } from '../../../data/zones.js';
import { listHuntableRegions } from '../../../data/mapRegions.js';
import MapRegionLayer from '../../ui/MapRegionLayer.js';

export default class HuntMapOverlay extends Phaser.Scene {
  constructor() {
    super({ key: 'HuntMapOverlay' });
  }

  create() {
    setupSceneCursor(this);

    const frame = createOverlayFrame(this, {
      title: 'Choose Where to Hunt',
      fullscreen: true,
      treatAsLocation: true,
      onClose: () => this._close(),
    });

    const depth = frame.depth;
    const b = frame.bounds;
    this._depth = depth;

    // treatAsLocation keeps the UIScene side panels live (this is a "place",
    // not a modal), which also means the frame's dimmer is fully
    // transparent — so this screen has to paint its own opaque ground or
    // whatever scene is suspended underneath shows straight through.
    this.add.rectangle(b.centerX, b.centerY, b.width, b.height, 0x0b0e14, 1)
      .setDepth(depth - 1);

    const huntable = listHuntableRegions();

    this.add.text(b.x + 32, b.y + 62,
      'Hover a region to read it. Lit regions are open to you — click one to hunt there.', {
        fontSize: '15px', color: '#cccccc',
      }).setDepth(depth + 2);

    // ── Detail panel (right) ────────────────────────────────────────────────
    const panelW = 340;
    const panelX = b.right - panelW - 28;
    const panelY = b.y + 96;
    const panelH = b.height - 150;
    createPanel(this, panelX, panelY, panelW, panelH, 'menu').setDepth(depth + 1);
    this._detailX = panelX + 18;
    this._detailW = panelW - 36;
    this._detailY = panelY + 18;
    this._panelBottom = panelY + panelH;

    this._detailItems = [];
    this._showDetail(null);

    // ── Map window (left) ───────────────────────────────────────────────────
    this.mapArea = new Phaser.Geom.Rectangle(
      b.x + 28, panelY, (panelX - 20) - (b.x + 28), panelH
    );

    const areaBg = this.add.rectangle(
      this.mapArea.centerX, this.mapArea.centerY,
      this.mapArea.width, this.mapArea.height, 0x05080d, 0.55
    ).setStrokeStyle(1, 0x2a3346).setDepth(depth);

    const maskG = this.add.graphics();
    maskG.fillStyle(0xffffff, 1);
    maskG.fillRect(this.mapArea.x, this.mapArea.y, this.mapArea.width, this.mapArea.height);
    maskG.setVisible(false);
    const areaMask = maskG.createGeometryMask();

    this.mapContainer = this.add.container(this.mapArea.centerX, this.mapArea.centerY)
      .setDepth(depth + 1);
    this.mapContainer.setMask(areaMask);

    const key = ['map_behelith_island', 'campMap'].find(k => this.textures.exists(k));
    if (!key) {
      this.add.text(this.mapArea.centerX, this.mapArea.centerY,
        'Map asset not found.', { fontSize: '16px', color: '#ffddaa' })
        .setOrigin(0.5).setDepth(depth + 2);
      return;
    }

    this.mapImage = this.add.image(0, 0, key).setOrigin(0.5);
    this.mapContainer.add(this.mapImage);
    // Fit the whole island — this is a picker, not an explorer, so it opens
    // showing everything rather than needing a pan to find the lit zones.
    const fit = Math.min(
      this.mapArea.width / this.mapImage.width,
      this.mapArea.height / this.mapImage.height
    );
    this.mapImage.setScale(fit);

    this.regionLayer = new MapRegionLayer(this, {
      container: this.mapContainer,
      image: this.mapImage,
      depth: depth + 1,
      clipRect: this.mapArea,
      selectableIds: huntable.map(r => r.id),
      dimUnselectable: true,
      onHover: (r) => this._showDetail(r),
      onSelect: (r) => {
        SoundManager.play('select');
        this._pickZone(r.huntZoneId);
      },
    });

    this._onMove = (p) => this.regionLayer?.handlePointerMove(p);
    this._onDown = (p) => this.regionLayer?.handlePointerDown(p);
    this.input.on('pointermove', this._onMove, this);
    this.input.on('pointerdown', this._onDown, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.input.off('pointermove', this._onMove, this);
      this.input.off('pointerdown', this._onDown, this);
    });
  }

  /** Right-hand readout. `region` null → the default "pick something" state. */
  _showDetail(region) {
    this._detailItems.forEach(o => o.destroy());
    this._detailItems = [];
    const d = this._depth;
    const add = (o) => { this._detailItems.push(o); return o; };
    let y = this._detailY;

    if (!region) {
      add(this.add.text(this._detailX, y, 'The Island of Behel\'ith', {
        fontSize: '17px', color: '#ffdd88', fontFamily: 'Georgia',
        wordWrap: { width: this._detailW },
      }).setDepth(d + 2));
      add(this.add.text(this._detailX, y + 34,
        'Hover any region to read what is known of it.\n\n'
        + 'Only two grounds are open to you so far. The rest of the island is '
        + 'charted but closed — the Hunt has to reach them first.', {
          fontSize: '13px', color: '#8a8a96',
          wordWrap: { width: this._detailW }, lineSpacing: 3,
        }).setDepth(d + 2));
      return;
    }

    add(this.add.text(this._detailX, y, region.name, {
      fontSize: '17px', color: region.huntZoneId ? '#ffdd88' : '#98a0ac',
      fontFamily: 'Georgia', wordWrap: { width: this._detailW },
    }).setDepth(d + 2));
    y += 30;

    const zone = region.huntZoneId ? getZone(region.huntZoneId) : null;

    add(this.add.text(this._detailX, y,
      zone ? `Danger: ${'🟢'.repeat(zone.dangerTier)}  ·  ${zone.terrain}` : region.terrain, {
        fontSize: '12px', color: '#8a8a96',
      }).setDepth(d + 2));
    y += 26;

    add(this.add.text(this._detailX, y, zone ? zone.flavor : region.blurb, {
      fontSize: '13px', color: '#d0cabb',
      wordWrap: { width: this._detailW }, lineSpacing: 2,
    }).setDepth(d + 2));

    if (!zone) {
      add(this.add.text(this._detailX, this._panelBottom - 48,
        region.isCamp ? '⌂  Your camp — you are here.' : '🔒  Not yet reachable.', {
          fontSize: '12px', color: '#6f7a88', fontStyle: 'italic',
        }).setDepth(d + 2));
      return;
    }

    // Weather / Divine Influence stay "Unknown" — real per-hunt factors the
    // player has no way to read yet (carried over from the old card layout).
    const by = this._panelBottom - 92;
    add(this.add.text(this._detailX, by, '🌦 Weather', {
      fontSize: '13px', color: '#88ccff', fontStyle: 'bold',
    }).setDepth(d + 2));
    add(this.add.text(this._detailX + this._detailW, by, 'Unknown', {
      fontSize: '13px', color: '#88ccff',
    }).setOrigin(1, 0).setDepth(d + 2));

    add(this.add.text(this._detailX, by + 24, '✨ Divine Influence', {
      fontSize: '13px', color: '#cc99ff', fontStyle: 'bold',
    }).setDepth(d + 2));
    add(this.add.text(this._detailX + this._detailW, by + 24, 'Unknown', {
      fontSize: '13px', color: '#cc99ff',
    }).setOrigin(1, 0).setDepth(d + 2));

    add(this.add.text(this._detailX, by + 56, '▸  Click the region to hunt here.', {
      fontSize: '12px', color: '#ffdd88', fontStyle: 'italic',
    }).setDepth(d + 2));
  }

  _pickZone(zoneId) {
    if (!zoneId) return;
    const hub = this.scene.get('HuntHubOverlay');
    hub?.setZone(zoneId);
    this.scene.stop();
    this.scene.resume('HuntHubOverlay');
  }

  _close() {
    this.scene.stop();
    this.scene.resume('HuntHubOverlay');
  }
}
