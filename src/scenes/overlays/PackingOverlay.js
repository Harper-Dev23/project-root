// src/scenes/overlays/PackingOverlay.js
//
// The Pack step as its own screen, for the co-op lobby (chunk 15f-2; the
// solo Hunt screen draws the same rows inline, src/ui/PackRows.js). Rations
// and every hunt item in your camp bag, by group, with − count +. Each row
// says whose its item will be on the hunt (owner, 2026-10-20, split by
// kind): "for the party" goes into the one shared pack, which events draw
// on, and comes home split by who brought it; "yours" stays in your own
// pack for your own fights. Nothing moves here: the lobby keeps the plan and
// the camp bag gives it up when the hunt starts.
//
// data: { pack: PackPlan, coop: true, onDone(pack) }

import GameState from '../../systems/GameState.js';
import { createOverlayFrame } from '../../ui/OverlayFrame.js';
import { SoundManager } from '../../systems/SoundManager.js';
import { setupSceneCursor } from '../../ui/cursor.js';
import { createButton } from '../../ui/Button.js';
import { countInList } from '../../systems/ItemStacks.js';
import { rationPackCap } from '../../systems/HuntRules.js';
import { clampPlan, emptyPlan, reminders } from '../../systems/PackPlan.js';
import { drawPackRows } from '../../ui/PackRows.js';

const FONT = 'Georgia, Gelasio, serif';
const RATION_STEP = 10;

export default class PackingOverlay extends Phaser.Scene {
  constructor() {
    super({ key: 'PackingOverlay' });
  }

  init(data) {
    this._onDone = typeof data?.onDone === 'function' ? data.onDone : null;
    this._coop = data?.coop !== false;
    this.pack = clampPlan(GameState.inventory || [], data?.pack || emptyPlan(), rationPackCap(GameState.party || []));
  }

  create() {
    SoundManager.init(this);
    setupSceneCursor(this);
    const frame = createOverlayFrame(this, { title: 'Pack for the Hunt', onClose: () => this._close() });
    this.bounds = frame.bounds;
    // Drawn on its own layer above the frame (as the Hunt screen does): a
    // container inside the frame's cannot be rebuilt from its own click.
    this._depth = (frame.depth ?? 1000) + 1;
    this._render();
  }

  _render() {
    this.content?.destroy(true);
    this.content = this.add.container(0, 0).setDepth(this._depth);
    const { x, y, width, height } = this.bounds;
    const left = x + 30, bag = GameState.inventory || [];
    const cap = rationPackCap(GameState.party || []);
    this.pack = clampPlan(bag, this.pack, cap);
    const text = (tx, ty, s, style) => { const t = this.add.text(tx, ty, s, { fontFamily: FONT, ...style }); this.content.add(t); return t; };

    text(left, y + 50, this._coop
      ? 'For the party: one shared pack everyone\'s choices and events draw on; what is left comes home to whoever brought it. Yours: your own pack, for your own fights.'
      : 'Everything packed goes into the hunt pack, and is at risk. What stays is safe in camp.',
      { fontSize: '13px', color: '#c8b89a', wordWrap: { width: width - 60 } });

    // Rations: always for the party.
    text(left, y + 98, `Rations for the party: ${this.pack.rations}  (${countInList(bag, 'rations')} in camp, ${cap} at most)`, { fontSize: '15px', color: '#e8e0cc' });
    const stepper = { minWidth: 46, padX: 14 };
    this.content.add(createButton(this, x + width - 190, y + 106, '−', () => this._rations(-RATION_STEP), 'primary', stepper));
    this.content.add(createButton(this, x + width - 100, y + 106, '+', () => this._rations(RATION_STEP), 'primary', stepper));

    const { empty } = drawPackRows(this, { add: (o) => this.content.add(o), left, top: y + 140, width: width - 60, bottom: y + height - 110,
      bag, plan: this.pack, coop: this._coop, onChange: (p) => { this.pack = p; this._render(); } });
    if (empty) text(left, y + 250, 'Nothing else in camp to pack. The Draughtwell sells draughts, Escape Ropes and Smoke Pots.', { fontSize: '13px', color: '#999999' });

    const remind = reminders(bag, this.pack);
    if (remind.length) text(left, y + height - 96, remind.join('  '), { fontSize: '12px', color: '#e8b070', wordWrap: { width: width - 220 } });
    const last = GameState.flags?.lastHunt?.pack;
    if (last) this.content.add(createButton(this, left + 90, y + height - 34, 'Pack as last time', () => { this.pack = clampPlan(bag, last, cap); SoundManager.play('select'); this._render(); }, 'primary'));
    this.content.add(createButton(this, left + (last ? 270 : 70), y + height - 34, 'Unpack all', () => { this.pack = emptyPlan(); SoundManager.play('select'); this._render(); }, 'danger'));
    this.content.add(createButton(this, x + width - 90, y + height - 34, 'Done', () => this._close(), 'confirm'));
  }

  _rations(delta) {
    const most = Math.min(rationPackCap(GameState.party || []), countInList(GameState.inventory || [], 'rations'));
    this.pack = { ...this.pack, rations: Math.max(0, Math.min(most, (this.pack.rations || 0) + delta)) };
    SoundManager.play('select');
    this._render();
  }

  _close() {
    const pack = clampPlan(GameState.inventory || [], this.pack, rationPackCap(GameState.party || []));
    this.scene.stop();
    this._onDone?.(pack);
  }
}
