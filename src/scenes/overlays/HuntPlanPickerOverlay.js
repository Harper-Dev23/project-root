// src/scenes/overlays/HuntPlanPickerOverlay.js
// "Choose Hunt Plan" sub-screen, opened from HuntHubOverlay's loadout phase.
// Lists the player's owned huntPlan-type item instances plus a "None"
// option. Each instance shows its rolled name in its rarity color and its
// actual rolled modifiers (no two are alike — see ItemFactory.js's
// HUNTPLAN_PREFIX_POOL/HUNTPLAN_SUFFIX_POOL). Picking writes the choice back
// onto HuntHubOverlay and resumes it — same pattern as HuntMapOverlay.

import { createOverlayFrame } from '../../ui/OverlayFrame.js';
import { setupSceneCursor } from '../../ui/cursor.js';
import { SoundManager } from '../../systems/SoundManager.js';
import { getItemComputedData } from '../../systems/ItemFactory.js';
import { describeModifiers } from '../../systems/HuntModifiers.js';
import { RARITY_COLORS } from '../../ui/styles.js';
import GameState from '../../systems/GameState.js';

const ROW_H = 78;

export default class HuntPlanPickerOverlay extends Phaser.Scene {
  constructor() {
    super({ key: 'HuntPlanPickerOverlay' });
  }

  create() {
    setupSceneCursor(this);

    const frame = createOverlayFrame(this, {
      title: 'Choose Hunt Plan',
      onClose: () => this._close(),
      bgImage: 'menu_parchment_background',
    });

    const depth = frame.depth;
    const { x, y, width } = frame.bounds;
    const left = x + 40;

    const huntPlans = (GameState.inventory || [])
      .filter(inst => getItemComputedData(inst)?.type === 'huntPlan');

    let rowY = y + 80;

    this._row(left, rowY, width - 80, depth, 'None', '#ffdd88', 'Go without a Hunt Plan.', () => this._pick(null));
    rowY += ROW_H;

    if (huntPlans.length === 0) {
      this.add.text(left, rowY, "You don't own any Hunt Plans yet — check the Vendor Row.", {
        fontSize: '14px', color: '#999999',
      }).setDepth(depth);
    }

    huntPlans.forEach(inst => {
      const view = getItemComputedData(inst);
      const color = RARITY_COLORS[inst.rarity] || RARITY_COLORS.common;
      const modLines = describeModifiers(inst.instanceMods?.misc);
      const desc = modLines.length ? modLines.join('   ·   ') : 'No modifiers rolled.';
      this._row(left, rowY, width - 80, depth, view.name, color, desc, () => this._pick(inst));
      rowY += ROW_H;
    });
  }

  _row(x, y, w, depth, title, titleColor, desc, onPick) {
    const bg = this.add.rectangle(x + w / 2, y + (ROW_H - 8) / 2, w, ROW_H - 8, 0x1c1c1c, 0.6)
      .setStrokeStyle(1, 0x6a7080)
      .setDepth(depth)
      .setInteractive({ useHandCursor: true });

    this.add.text(x + 16, y + 8, title, { fontSize: '15px', color: titleColor }).setDepth(depth + 1);
    this.add.text(x + 16, y + 30, desc, { fontSize: '12px', color: '#aaaaaa', wordWrap: { width: w - 32 } }).setDepth(depth + 1);

    bg.on('pointerover', () => bg.setFillStyle(0x2a2a2a, 0.8));
    bg.on('pointerout', () => bg.setFillStyle(0x1c1c1c, 0.6));
    bg.on('pointerdown', () => {
      SoundManager.play('select');
      onPick();
    });
  }

  _pick(instanceOrNull) {
    const hub = this.scene.get('HuntHubOverlay');
    hub?.setHuntPlan(instanceOrNull);
    this.scene.stop();
    this.scene.resume('HuntHubOverlay');
  }

  _close() {
    this.scene.stop();
    this.scene.resume('HuntHubOverlay');
  }
}
