// src/scenes/overlays/TribeHQOverlay.js
// Tribe Headquarters — info/tracking screen only for now. Shows the player's
// personal Hunt Points, their tribe's grand total, the tribe's 6 NPC hunting
// parties (ticking up via TribeHuntSimulator), and a read-only comparison of
// all four tribes' totals.
//
// Gear donation, Favor-gated claiming of NPC loot, and the Favor-vendor menu
// described alongside this are a separate, larger follow-up — not built here.

import { createOverlayFrame } from '../../ui/OverlayFrame.js';
import { setupSceneCursor } from '../../ui/cursor.js';
import { createPanel } from '../../ui/GamePanel.js';
import { TRIBE_IDS, TRIBE_DISPLAY } from '../../systems/TribeRelations.js';
import { getPartiesForTribe } from '../../../data/tribeHuntingParties.js';
import ProgressionManager from '../../systems/ProgressionManager.js';

export default class TribeHQOverlay extends Phaser.Scene {
  constructor() {
    super({ key: 'TribeHQOverlay' });
  }

  create() {
    const town = this.scene.get('TownScene');
    setupSceneCursor(this);
    if (town?.input) town.input.enabled = false;

    const tribeId = ProgressionManager.getTribe();
    const tribeName = TRIBE_DISPLAY[tribeId] || 'Unaffiliated';

    const frame = createOverlayFrame(this, {
      title: `${tribeName} Headquarters`,
      onClose: () => this._close(),
      bgImage: 'menu_stony_background',
    });

    const depth = frame.depth;
    const { x, y, width, bottom } = frame.bounds;
    const left = x + 40;

    if (!tribeId) {
      this.add.text(left, y + 100, "You haven't pledged to a tribe yet.", {
        fontSize: '16px', color: '#cccccc',
      }).setDepth(depth);
      return;
    }

    // ── Totals ───────────────────────────────────────────────────────────
    this.add.text(left, y + 64, `Your Hunt Points: ${ProgressionManager.huntPoints}`, {
      fontSize: '16px', color: '#88ddff',
    }).setDepth(depth);

    this.add.text(left, y + 92, `${tribeName} Tribe Total: ${ProgressionManager.getTribeHuntPoints(tribeId)}`, {
      fontSize: '18px', color: '#ffdd88', fontStyle: 'bold',
    }).setDepth(depth);

    // ── Hunting parties ──────────────────────────────────────────────────
    const listY = y + 140;
    this.add.text(left, listY, 'Hunting Parties', {
      fontSize: '16px', color: '#ffffaa', fontStyle: 'bold',
    }).setDepth(depth);

    const parties = getPartiesForTribe(tribeId);
    const rowH = 38;
    let rowY = listY + 32;

    parties.forEach(party => {
      createPanel(this, left, rowY, width - 80, rowH - 4, 'slot').setDepth(depth);

      const displayName = party.isPlayerSlot ? 'Your Hunting Party' : party.name;
      const tierStars = '★'.repeat(party.tier);
      const nameColor = party.isPlayerSlot ? '#88ff88' : (party.isLeaderParty ? '#ffdd88' : '#d0d0d0');

      this.add.text(left + 16, rowY + (rowH - 4) / 2, displayName, {
        fontSize: '14px', color: nameColor,
      }).setOrigin(0, 0.5).setDepth(depth + 1);

      this.add.text(left + 320, rowY + (rowH - 4) / 2, tierStars, {
        fontSize: '13px', color: '#ccaa44',
      }).setOrigin(0, 0.5).setDepth(depth + 1);

      this.add.text(left + width - 100, rowY + (rowH - 4) / 2, `${ProgressionManager.getPartyPoints(tribeId, party.id)} pts`, {
        fontSize: '13px', color: '#88ddff',
      }).setOrigin(1, 0.5).setDepth(depth + 1);

      rowY += rowH;
    });

    // ── All-tribes comparison footer ────────────────────────────────────
    const footerY = bottom - 60;
    this.add.text(left, footerY, 'All Tribes (Hunt Points)', {
      fontSize: '13px', color: '#999999',
    }).setDepth(depth);

    const comparisonStr = TRIBE_IDS
      .map(id => `${TRIBE_DISPLAY[id]}: ${ProgressionManager.getTribeHuntPoints(id)}`)
      .join('   ·   ');

    this.add.text(left, footerY + 22, comparisonStr, {
      fontSize: '14px', color: '#cccccc',
    }).setDepth(depth);
  }

  _close() {
    const town = this.scene.get('TownScene');
    if (town?.input) town.input.enabled = true;
    this.scene.resume('UIScene');
    this.scene.stop();
  }
}
