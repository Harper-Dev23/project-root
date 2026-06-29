// src/scenes/overlays/HuntEncounterOverlay.js
// The brief "something's out there" preview shown when a turn rolls a pending
// FIGHT (kind: 'encounter'). Deliberately small and low-key — flavor line +
// "Engage" — since you haven't committed to anything yet, closing it just
// leaves the encounter pending (HuntHubOverlay will show Investigate again).
//
// Once you click Engage there's no backing out — it stops HuntHubOverlay and
// launches CombatScene in 'hunt' mode, which can't be fled mid-fight.
//
// Pending EVENTS (non-fight) skip this screen entirely and go straight to
// HuntEventOverlay — see HuntHubOverlay._investigate().
//
// Launched with: scene.launch('HuntEncounterOverlay', { encounter })

import { createOverlayFrame } from '../../ui/OverlayFrame.js';
import { setupSceneCursor } from '../../ui/cursor.js';
import { createButton } from '../../ui/Button.js';
import { SoundManager } from '../../systems/SoundManager.js';
import GameState from '../../systems/GameState.js';

export default class HuntEncounterOverlay extends Phaser.Scene {
  constructor() {
    super({ key: 'HuntEncounterOverlay' });
  }

  init(data) {
    this.encounter = data?.encounter || null;
  }

  create() {
    setupSceneCursor(this);

    // No bgImage — the plain dark/gold default panel (same as Options,
    // Inventory, etc.) reads cleanly with this screen's light text colors,
    // no textured background needed for a screen this brief.
    const frame = createOverlayFrame(this, {
      title: 'Something Approaches',
      onClose: () => this._closeWithoutResolving(),
      width: 600,
      height: 360,
    });

    const depth = frame.depth;
    const { x, y, width } = frame.bounds;
    const centerX = x + width / 2;

    this.add.text(centerX, y + 90, this.encounter?.label || 'Something stirs nearby.', {
      fontSize: '16px', color: '#ffaa88', align: 'center', wordWrap: { width: width - 80 },
    }).setOrigin(0.5).setDepth(depth);

    this.add.text(centerX, y + 160,
      'There is no avoiding this — once you engage, you cannot flee mid-fight.',
      { fontSize: '13px', color: '#999999', align: 'center', wordWrap: { width: width - 80 } }
    ).setOrigin(0.5).setDepth(depth);

    createButton(this, centerX, y + 250, 'Engage', () => this._engage(), 'danger').setDepth(depth);
  }

  _engage() {
    SoundManager.play('select');
    // HuntHubOverlay is paused (not running) at this point — Phaser's sleep()
    // silently no-ops on a non-running scene, leaving it paused-but-visible
    // on top of combat. Stop it outright instead; CombatScene re-launches it
    // fresh on return (safe — its render reads live state from HuntManager,
    // not from instance fields that a fresh launch would reset).
    this.scene.stop('HuntHubOverlay');
    this.scene.stop();
    window.sceneManager.loadScene('CombatScene', 'A fight breaks out!', {
      mode: 'hunt',
      party: GameState.party,
      scenarioId: this.encounter.scenarioId,
      huntContext: { type: this.encounter.type },
    });
  }

  /** Closing without engaging leaves the encounter pending — the Hub will show Investigate again. */
  _closeWithoutResolving() {
    this.scene.stop();
    this.scene.resume('HuntHubOverlay');
  }
}
