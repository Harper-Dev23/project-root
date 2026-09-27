// src/scenes/overlays/HuntPlanPickerOverlay.js
// "Choose Hunt Plan" sub-screen, opened from HuntHubOverlay's loadout phase.
// The free Basic Hunt Plan is always the first row (it replaced "None" in
// Hunt Plans v2); after it come the player's owned huntPlan instances. Each
// row shows the plan's rolled name in its rarity colour, its item level, tier
// and implicit, its bonus objectives and its rolled modifiers (describePlan).
// Picking writes the choice back onto HuntHubOverlay and resumes it -- same
// pattern as HuntMapOverlay.

import { createOverlayFrame } from '../../ui/OverlayFrame.js';
import { setupSceneCursor } from '../../ui/cursor.js';
import { SoundManager } from '../../systems/SoundManager.js';
import { getItemComputedData } from '../../systems/ItemFactory.js';
import { describePlan, makeBasicPlan } from '../../systems/HuntPlans.js';
import { RARITY_COLORS } from '../../ui/styles.js';
import GameState from '../../systems/GameState.js';
import { Items } from '../../../data/items.js';
import { PRIMARY_OBJECTIVES } from '../../../data/huntMapGen.js';

/**
 * Whether a plan can be taken to `zoneId` (chunk 14b-3): a boss plan belongs to
 * one region only, and waits until its objective exists (14b-4). Returns
 * { show, why } where `why` (a reason it cannot be picked) may be null.
 */
export function planFitsZone(inst, zoneId) {
  const base = Items[inst?.id] || {};
  if (!base.boss) return { show: true, why: null };
  if (base.zone && base.zone !== zoneId) return { show: false, why: null };
  if (!PRIMARY_OBJECTIVES[base.objective]) return { show: true, why: 'Its lair cannot be reached yet (a coming update).' };
  if (base.boss) return { show: true, why: null, note: 'A boss hunt: it is used up once the boss is fought, not when you set out.' };
  return { show: true, why: null };
}

const ROW_H = 92;

export default class HuntPlanPickerOverlay extends Phaser.Scene {
  constructor() {
    super({ key: 'HuntPlanPickerOverlay' });
  }

  create() {
    setupSceneCursor(this);

    const frame = createOverlayFrame(this, {
      title: 'Choose Hunt Plan',
      treatAsLocation: true,
      onClose: () => this._close(),
      bgImage: 'menu_parchment_background',
    });

    const depth = frame.depth;
    const { x, y, width } = frame.bounds;
    const left = x + 40;

    const zoneId = this.scene.get('HuntHubOverlay')?.zoneId || null;
    const huntPlans = (GameState.inventory || [])
      .filter(inst => getItemComputedData(inst)?.type === 'huntPlan' && planFitsZone(inst, zoneId).show);

    let rowY = y + 80;

    const basic = makeBasicPlan();
    this._row(left, rowY, width - 80, depth, getItemComputedData(basic).name, '#ffdd88',
      describePlan(basic).join('   ·   '), () => this._pick(basic));
    rowY += ROW_H;

    if (huntPlans.length === 0) {
      this.add.text(left, rowY, 'Better plans are sold at the Greenhollow Satchel, for Hunt Tickets.', {
        fontSize: '14px', color: '#999999',
      }).setDepth(depth);
    }

    huntPlans.forEach(inst => {
      const view = getItemComputedData(inst);
      const color = RARITY_COLORS[inst.rarity] || RARITY_COLORS.common;
      const { why, note } = planFitsZone(inst, zoneId);
      const desc = [...(why ? [why] : []), ...(note ? [note] : []), ...describePlan(inst)].join('   ·   ');
      this._row(left, rowY, width - 80, depth, view.name, color, desc, why ? null : () => this._pick(inst));
      rowY += ROW_H;
    });
  }

  _row(x, y, w, depth, title, titleColor, desc, onPick) {
    const bg = this.add.rectangle(x + w / 2, y + (ROW_H - 8) / 2, w, ROW_H - 8, 0x1c1c1c, 0.6)
      .setStrokeStyle(1, 0x6a7080)
      .setDepth(depth);
    // A row that cannot be picked (a boss plan whose lair is not in yet) is
    // shown, dimmed, and takes no click.
    if (!onPick) {
      bg.setAlpha(0.5);
      this.add.text(x + 16, y + 8, title, { fontSize: '15px', color: titleColor }).setDepth(depth + 1).setAlpha(0.6);
      this.add.text(x + 16, y + 30, desc, { fontSize: '12px', color: '#aaaaaa', wordWrap: { width: w - 32 } }).setDepth(depth + 1).setAlpha(0.8);
      return;
    }
    bg.setInteractive({ useHandCursor: true });

    this.add.text(x + 16, y + 8, title, { fontSize: '15px', color: titleColor }).setDepth(depth + 1);
    this.add.text(x + 16, y + 30, desc, { fontSize: '12px', color: '#aaaaaa', wordWrap: { width: w - 32 } }).setDepth(depth + 1);

    bg.on('pointerover', () => bg.setFillStyle(0x2a2a2a, 0.8));
    bg.on('pointerout', () => bg.setFillStyle(0x1c1c1c, 0.6));
    bg.on('pointerdown', () => {
      SoundManager.play('select');
      onPick();
    });
  }

  _pick(instance) {
    const hub = this.scene.get('HuntHubOverlay');
    hub?.setHuntPlan(instance);
    this.scene.stop();
    this.scene.resume('HuntHubOverlay');
  }

  _close() {
    this.scene.stop();
    this.scene.resume('HuntHubOverlay');
  }
}
