// src/scenes/overlays/HuntEncounterOverlay.js
// The "Investigate" screen — opened from HuntHubOverlay when a turn rolls a
// pending encounter. The encounter's real nature is hidden until resolved.
//
// This is a stub: no combat hookup yet (per ENCOUNTER_SYSTEM.md, the basic
// enemy roster is a separate design pass). Once real combat/events exist,
// this is the natural hook point — e.g. routing to CombatScene for a
// "beasts" category roll instead of just a Resolve button.
//
// Launched with: scene.launch('HuntEncounterOverlay', { encounter })

import { createOverlayFrame } from '../../ui/OverlayFrame.js';
import { setupSceneCursor } from '../../ui/cursor.js';
import { createButton } from '../../ui/Button.js';
import { SoundManager } from '../../systems/SoundManager.js';

export default class HuntEncounterOverlay extends Phaser.Scene {
  constructor() {
    super({ key: 'HuntEncounterOverlay' });
  }

  init(data) {
    this.encounter = data?.encounter || null;
  }

  create() {
    setupSceneCursor(this);

    const frame = createOverlayFrame(this, {
      title: 'Investigate',
      onClose: () => this._resolve(),
      bgImage: 'menu_stony_background',
      width: 600,
      height: 360,
    });

    const depth = frame.depth;
    const { x, y, width } = frame.bounds;
    const centerX = x + width / 2;

    this.add.text(centerX, y + 80,
      'You move carefully toward whatever stirred ahead…',
      { fontSize: '16px', color: '#cccccc', align: 'center', wordWrap: { width: width - 80 } }
    ).setOrigin(0.5).setDepth(depth);

    this.add.text(centerX, y + 150,
      '(No combat hookup yet — this is where the actual encounter\nwill eventually play out.)',
      { fontSize: '13px', color: '#888888', align: 'center', wordWrap: { width: width - 80 } }
    ).setOrigin(0.5).setDepth(depth);

    createButton(this, centerX, y + 240, 'Resolve', () => this._resolve(), 'confirm').setDepth(depth);
  }

  _resolve() {
    SoundManager.play('reward');
    const hub = this.scene.get('HuntHubOverlay');
    hub?.onEncounterResolved();
    this.scene.stop();
    this.scene.resume('HuntHubOverlay');
  }
}
