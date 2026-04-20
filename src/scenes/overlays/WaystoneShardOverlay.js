/**
 * WaystoneShardOverlay — opened when the player "Uses" the Waystone Shard item.
 *
 * Placeholder UI showing Prophet Favor and Hunt Progress sections.
 * Both will be populated by real systems in a future update.
 */

import { createOverlayFrame } from '../../ui/OverlayFrame.js';
import ProgressionManager from '../../systems/ProgressionManager.js';
import { setupSceneCursor } from '../../ui/cursor.js';

export default class WaystoneShardOverlay extends Phaser.Scene {
  constructor() {
    super({ key: 'WaystoneShardOverlay' });
  }

  create() {
    setupSceneCursor(this);
    const frame = createOverlayFrame(this, {
      title: 'Waystone Shard',
      onClose: () => this._close(),
    });

    const { bounds, depth } = frame;
    const d = depth;
    const lx = bounds.x + 44;
    const w  = bounds.width - 88;

    // ── Flavor strip ─────────────────────────────────────────────────────────
    this.add.text(bounds.centerX, bounds.y + 64,
      'A fragment of the island\'s sacred waystone network, attuned to your presence.',
      { fontSize: '13px', color: '#8899bb', fontStyle: 'italic', align: 'center',
        wordWrap: { width: w } }
    ).setOrigin(0.5, 0).setDepth(d);

    // ── Divider ───────────────────────────────────────────────────────────────
    const _divider = (y) => {
      const g = this.add.graphics().setDepth(d);
      g.lineStyle(1, 0x334466, 0.45);
      g.beginPath();
      g.moveTo(lx, y);
      g.lineTo(bounds.right - 44, y);
      g.strokePath();
    };

    _divider(bounds.y + 94);

    // ── Prophet Favor section ─────────────────────────────────────────────────
    this.add.text(lx, bounds.y + 102,
      'Prophet Favor',
      { fontSize: '17px', color: '#c8a060', fontStyle: 'bold' }
    ).setDepth(d);

    this.add.text(lx + 12, bounds.y + 128,
      'The island\'s prophets are aware of those who hunt in their domain.\n\n' +
      'Favor reflects your standing with each prophet — earned through the nature of\n' +
      'your hunts, the choices you make, and their own unknowable judgment.\n\n' +
      'The shard will track this standing as you progress.\n\n' +
      '[ Favor tracking — coming soon ]',
      { fontSize: '13px', color: '#667788', lineSpacing: 3, wordWrap: { width: w - 12 } }
    ).setDepth(d);

    _divider(bounds.y + 278);

    // ── Hunt Progress section ─────────────────────────────────────────────────
    this.add.text(lx, bounds.y + 286,
      'Hunt Progress',
      { fontSize: '17px', color: '#c8a060', fontStyle: 'bold' }
    ).setDepth(d);

    this.add.text(lx + 12, bounds.y + 312,
      'Waystone Network — Active\n',
      { fontSize: '13px', color: '#88aacc', fontStyle: 'bold' }
    ).setDepth(d);

    const waystones = [
      { label: 'Elder Grove  ·  Camp Nehemiah', state: 'Attuned', color: '#aaccff' },
      { label: 'Northern Passage',              state: 'Locked',  color: '#445566' },
      { label: 'The Maw',                       state: 'Locked',  color: '#445566' },
      { label: 'Ashfield',                      state: 'Locked',  color: '#445566' },
    ];

    let wy = bounds.y + 334;
    waystones.forEach(ws => {
      this.add.text(lx + 24, wy,
        `· ${ws.label}`,
        { fontSize: '13px', color: '#667788' }
      ).setDepth(d);
      this.add.text(bounds.right - 48, wy,
        `[ ${ws.state} ]`,
        { fontSize: '13px', color: ws.color }
      ).setOrigin(1, 0).setDepth(d);
      wy += 22;
    });

    this.add.text(lx + 12, wy + 16,
      '[ Prophet tracking — coming soon ]',
      { fontSize: '13px', color: '#445566', fontStyle: 'italic' }
    ).setDepth(d);
  }

  _close() {
    this.scene.stop();
  }
}
