// src/scenes/overlays/HuntEventOverlay.js
// Opened directly from HuntHubOverlay when a turn rolls a pending EVENT
// (kind: 'event') — fights go to the smaller HuntEncounterOverlay instead.
//
// Deliberately a full-size screen, not a small popup: once you're here you
// are locked in until the choice/check/puzzle resolves — there is no close
// button, no click-outside-to-dismiss, and ESC is a no-op (createOverlayFrame
// still wires it, but onClose itself does nothing). Same "no backing out"
// rule combat already has, applied to events. This also gives the dice
// token (for 'check' events) a properly-sized, unclipped play area instead
// of fighting for room in a tiny window.
//
// Dispatches on the rolled event definition's own `kind` (data/zones.js):
//   'choice' — pick one of several options
//   'check'  — stat vs DC, resolved via a tween-animated dice token
//   'puzzle' — a riddle/pattern with multiple-choice answers
//
// Launched with: scene.launch('HuntEventOverlay', { encounter })

import { createOverlayFrame } from '../../ui/OverlayFrame.js';
import { setupSceneCursor } from '../../ui/cursor.js';
import { createButton } from '../../ui/Button.js';
import { SoundManager } from '../../systems/SoundManager.js';
import { EventResolver } from '../../systems/EventResolver.js';
import DiceToken from '../../ui/DiceToken.js';
import GameState from '../../systems/GameState.js';

export default class HuntEventOverlay extends Phaser.Scene {
  constructor() {
    super({ key: 'HuntEventOverlay' });
  }

  init(data) {
    this.encounter = data?.encounter || null;
    this._diceToken = null;
  }

  create() {
    setupSceneCursor(this);

    // No bgImage (plain dark/gold default panel, same as every other
    // non-textured overlay) and onClose is a no-op — see the file header.
    // No width/height override either — the default (910x690) is exactly
    // what every other overlay uses, sized to fit between the left/right
    // UI side panels and the top/bottom frame border.
    const frame = createOverlayFrame(this, {
      title: 'An Event Unfolds',
      onClose: () => {},
    });

    // Strip the close affordances entirely rather than leave a dead button —
    // a visible X that does nothing reads as broken, not "locked in".
    frame.closeButton.destroy();
    frame.blockers.forEach(b => b.destroy());

    this._depth = frame.depth;
    this._bounds = frame.bounds;

    // The shared default panel fill is only 82% opaque (see GamePanel.js),
    // which lets the Hunt Hub bleed through faintly behind it — not wanted
    // here. Painted over the panel (same depth, added after, so it renders
    // on top) rather than changing the shared panel style every other
    // overlay also uses. Solid black for now — real per-event art backgrounds
    // are a later pass.
    const b = this._bounds;
    this.add.rectangle(b.x + b.width / 2, b.y + b.height / 2, b.width, b.height, 0x000000, 1).setDepth(frame.panel.depth);

    const eventDef = this.encounter?.eventDef;
    if (!eventDef) { this._forceClose(); return; }

    const { x, y, width } = this._bounds;
    const centerX = x + width / 2;

    this.add.text(centerX, y + 70, this.encounter.label, {
      fontSize: '17px', color: '#cccccc', align: 'center', wordWrap: { width: width - 120 },
    }).setOrigin(0.5).setDepth(this._depth);

    if (eventDef.kind === 'choice') this._renderChoice(eventDef);
    else if (eventDef.kind === 'check') this._renderCheck(eventDef);
    else if (eventDef.kind === 'puzzle') this._renderPuzzle(eventDef);
    else this._forceClose();
  }

  // ── choice ───────────────────────────────────────────────────────────────

  _renderChoice(eventDef) {
    const depth = this._depth;
    const { x, y, width } = this._bounds;
    const centerX = x + width / 2;
    let optY = y + 220;

    (eventDef.options || []).forEach(option => {
      createButton(this, centerX, optY, option.text, () => this._finishEvent(option.outcome), 'primary').setDepth(depth);
      optY += 70;
    });
  }

  // ── check (dice token) ───────────────────────────────────────────────────

  _renderCheck(eventDef) {
    const depth = this._depth;
    const { x, y, width } = this._bounds;
    const centerX = x + width / 2;

    this.add.text(centerX, y + 110, `${eventDef.stat} Check — DC ${eventDef.dc}`, {
      fontSize: '20px', color: '#ffdd88', fontStyle: 'bold', align: 'center',
    }).setOrigin(0.5).setDepth(depth);

    this.add.text(centerX, y + 138, 'Press Space or click Roll when ready.', {
      fontSize: '13px', color: '#999999', align: 'center',
    }).setOrigin(0.5).setDepth(depth);

    const rollBtn = createButton(this, centerX, y + 178, 'Roll', () => this._roll(rollBtn), 'confirm').setDepth(depth + 3);
    this.input.keyboard?.once('keydown-SPACE', () => this._roll(rollBtn));

    this._diceToken = new DiceToken(this, {
      x: centerX, y: y + 395, width: 760, height: 360, depth,
      onSettled: (value) => this._resolveCheck(eventDef, value),
    });
  }

  _roll(rollBtn) {
    if (this._diceToken?.isArmed()) return; // already rolled — Space and the button both route here
    SoundManager.play('select');
    rollBtn.disableInteractive().setAlpha(0.4);
    this._diceToken.roll();
  }

  _resolveCheck(eventDef, roll) {
    const totalStats = this._bestStatsForCheck(eventDef.stat);
    const result = EventResolver.rollCheck(eventDef.stat, eventDef.dc, totalStats, roll);

    const depth = this._depth;
    const { x, y, width, bottom } = this._bounds;
    const centerX = x + width / 2;

    this.add.text(centerX, bottom - 100,
      `Roll: ${result.roll} + ${result.modifier} = ${result.total} vs DC ${eventDef.dc} — ${result.success ? 'Success!' : 'Failure'}`,
      { fontSize: '16px', color: result.success ? '#88ff88' : '#ff8888', align: 'center', wordWrap: { width: width - 80 } }
    ).setOrigin(0.5).setDepth(depth + 3);

    const outcome = result.success ? eventDef.success : eventDef.failure;
    createButton(this, centerX, bottom - 45, 'Continue', () => this._finishEvent(outcome), 'confirm').setDepth(depth + 3);
  }

  /** Uses whichever living party member has the highest value of the relevant stat. */
  _bestStatsForCheck(stat) {
    const living = (GameState.party || []).filter(c => c.status !== 'dead');
    if (living.length === 0) return { [stat]: 10 };
    const best = living.reduce((a, b) => ((b.totalStats?.[stat] || 0) > (a.totalStats?.[stat] || 0) ? b : a));
    return best.totalStats || { [stat]: 10 };
  }

  // ── puzzle ───────────────────────────────────────────────────────────────

  _renderPuzzle(eventDef) {
    const depth = this._depth;
    const { x, y, width } = this._bounds;
    const centerX = x + width / 2;

    this.add.text(centerX, y + 160, eventDef.prompt, {
      fontSize: '16px', color: '#ffdd88', align: 'center', wordWrap: { width: width - 120 },
    }).setOrigin(0.5).setDepth(depth);

    let ansY = y + 260;
    (eventDef.answers || []).forEach((answer, i) => {
      createButton(this, centerX, ansY, answer, () => {
        const outcome = EventResolver.resolvePuzzle(eventDef, i);
        this._finishEvent(outcome);
      }, 'primary').setDepth(depth);
      ansY += 60;
    });
  }

  // ── shared exit ──────────────────────────────────────────────────────────

  _finishEvent(outcome) {
    SoundManager.play('reward');
    const hub = this.scene.get('HuntHubOverlay');
    hub?.onEncounterResolved(outcome);
    this._diceToken?.destroy();
    this._diceToken = null;
    this.scene.stop();
    this.scene.resume('HuntHubOverlay');
  }

  /** Only used defensively if somehow launched without a valid event definition. */
  _forceClose() {
    this.scene.stop();
    this.scene.resume('HuntHubOverlay');
  }
}
