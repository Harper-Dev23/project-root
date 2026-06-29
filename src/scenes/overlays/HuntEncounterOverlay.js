// src/scenes/overlays/HuntEncounterOverlay.js
// Opened from HuntHubOverlay when a turn rolls a pending encounter. The
// encounter's real nature is hidden until resolved.
//
// Two flows, branched on `encounter.kind`:
//   'event'     — non-fight, stub Investigate/Resolve flow (flavor text only).
//   'encounter' — a real fight. Shows pre-fight flavor + "Engage", which
//                 sleeps HuntHubOverlay and launches CombatScene in 'hunt'
//                 mode. CombatScene reports the outcome back to HuntManager
//                 directly and wakes HuntHubOverlay on return — see
//                 CombatScene.js's hunt-mode branches and HuntHubOverlay's
//                 'wake' listener.
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
    const isFight = this.encounter?.kind === 'encounter';

    const frame = createOverlayFrame(this, {
      title: isFight ? 'Something Approaches' : 'Investigate',
      onClose: () => (isFight ? this._closeWithoutResolving() : this._resolveEvent()),
      bgImage: 'menu_stony_background',
      width: 600,
      height: 360,
    });

    const depth = frame.depth;
    const { x, y, width } = frame.bounds;
    const centerX = x + width / 2;

    if (isFight) {
      this.add.text(centerX, y + 80, this.encounter?.label || 'Something stirs nearby.', {
        fontSize: '16px', color: '#ffaa88', align: 'center', wordWrap: { width: width - 80 },
      }).setOrigin(0.5).setDepth(depth);

      this.add.text(centerX, y + 150,
        'There is no avoiding this — once you engage, you cannot flee mid-fight.',
        { fontSize: '13px', color: '#888888', align: 'center', wordWrap: { width: width - 80 } }
      ).setOrigin(0.5).setDepth(depth);

      createButton(this, centerX, y + 240, 'Engage', () => this._engage(), 'danger').setDepth(depth);
    } else {
      this.add.text(centerX, y + 80,
        'You move carefully toward whatever stirred ahead…',
        { fontSize: '16px', color: '#cccccc', align: 'center', wordWrap: { width: width - 80 } }
      ).setOrigin(0.5).setDepth(depth);

      this.add.text(centerX, y + 150,
        '(No mechanical effect yet — this is where the actual event\nwill eventually play out.)',
        { fontSize: '13px', color: '#888888', align: 'center', wordWrap: { width: width - 80 } }
      ).setOrigin(0.5).setDepth(depth);

      createButton(this, centerX, y + 240, 'Resolve', () => this._resolveEvent(), 'confirm').setDepth(depth);
    }
  }

  _resolveEvent() {
    SoundManager.play('reward');
    const hub = this.scene.get('HuntHubOverlay');
    hub?.onEncounterResolved();
    this.scene.stop();
    this.scene.resume('HuntHubOverlay');
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
