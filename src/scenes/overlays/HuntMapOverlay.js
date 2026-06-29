// src/scenes/overlays/HuntMapOverlay.js
// "Choose Location" sub-screen, opened from HuntHubOverlay. Shows the two
// unlocked starting zones as clickable cards. Picking one writes the choice
// back onto HuntHubOverlay and resumes it.
//
// A real hoverable/clickable world map (with these same zone cards appearing
// on hover) is the eventual target here — this card-list is the stand-in
// until that map art/interaction exists.

import { createOverlayFrame } from '../../ui/OverlayFrame.js';
import { setupSceneCursor } from '../../ui/cursor.js';
import { createPanel } from '../../ui/GamePanel.js';
import { SoundManager } from '../../systems/SoundManager.js';
import { listZones } from '../../../data/zones.js';

export default class HuntMapOverlay extends Phaser.Scene {
  constructor() {
    super({ key: 'HuntMapOverlay' });
  }

  create() {
    setupSceneCursor(this);

    const frame = createOverlayFrame(this, {
      title: 'Choose Where to Hunt',
      onClose: () => this._close(),
      bgImage: 'menu_parchment_background',
    });

    const depth = frame.depth;
    const { x, y, width } = frame.bounds;

    this.add.text(x + 40, y + 64, 'Hover a location to preview it, click to choose.', {
      fontSize: '16px',
      color: '#cccccc',
    }).setDepth(depth);

    const zones = listZones();
    const cardW = (width - 100) / zones.length;
    const cardH = 320;
    const cardY = y + 110;

    zones.forEach((zone, i) => {
      const cardX = x + 40 + i * (cardW + 20);
      this._buildZoneCard(zone, cardX, cardY, cardW, cardH, depth);
    });
  }

  _buildZoneCard(zone, cx, cy, w, h, depth) {
    const panel = createPanel(this, cx, cy, w, h, 'menu').setDepth(depth);

    const dangerLabel = '🟢'.repeat(zone.dangerTier);

    this.add.text(cx + w / 2, cy + 24, zone.name, {
      fontSize: '18px',
      color: '#ffdd88',
      fontFamily: 'Georgia',
      align: 'center',
      wordWrap: { width: w - 24 },
    }).setOrigin(0.5, 0).setDepth(depth + 1);

    this.add.text(cx + w / 2, cy + 64, `Danger: ${dangerLabel}  ·  ${zone.terrain}`, {
      fontSize: '13px',
      color: '#999999',
      align: 'center',
    }).setOrigin(0.5, 0).setDepth(depth + 1);

    this.add.text(cx + 16, cy + 96, zone.flavor, {
      fontSize: '14px',
      color: '#d0d0d0',
      wordWrap: { width: w - 32 },
    }).setDepth(depth + 1);

    // Weather and Divine Influence are real per-hunt/per-zone factors, but
    // their effects aren't decipherable to the player yet — shown as known
    // categories with an unknown effect until some future knowledge system
    // lets the player read them.
    this.add.text(cx + 16, cy + h - 56, '🌦 Weather', {
      fontSize: '13px',
      color: '#88ccff',
      fontStyle: 'bold',
    }).setDepth(depth + 1);
    this.add.text(cx + w - 16, cy + h - 56, 'Unknown', {
      fontSize: '13px',
      color: '#88ccff',
    }).setOrigin(1, 0).setDepth(depth + 1);

    this.add.text(cx + 16, cy + h - 32, '✨ Divine Influence', {
      fontSize: '13px',
      color: '#cc99ff',
      fontStyle: 'bold',
    }).setDepth(depth + 1);
    this.add.text(cx + w - 16, cy + h - 32, 'Unknown', {
      fontSize: '13px',
      color: '#cc99ff',
    }).setOrigin(1, 0).setDepth(depth + 1);

    const hitZone = this.add.zone(cx + w / 2, cy + h / 2, w, h)
      .setOrigin(0.5)
      .setDepth(depth + 2)
      .setInteractive({ useHandCursor: true });

    hitZone.on('pointerover', () => panel.setAlpha(0.7));
    hitZone.on('pointerout', () => panel.setAlpha(1));
    hitZone.on('pointerdown', () => {
      SoundManager.play('select');
      this._pickZone(zone.id);
    });
  }

  _pickZone(zoneId) {
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
