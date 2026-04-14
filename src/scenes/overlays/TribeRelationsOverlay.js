import { createOverlayFrame } from '../../ui/OverlayFrame.js';
import {
  TRIBE_IDS, TRIBE_DISPLAY,
  OWN_TRIBE_LEVELS, OTHER_TRIBE_LEVELS,
  getTribeRepLevel, getNextThreshold,
} from '../../systems/TribeRelations.js';
import ProgressionManager from '../../systems/ProgressionManager.js';

// ── Visual constants ──────────────────────────────────────────────────────────

const C = {
  ownTribeHeader:   '#ffdd44',
  otherTribeHeader: '#ccbbaa',
  levelName:        '#ffffff',
  score:            '#aaaaaa',
  effect:           '#999999',
  progressBg:       0x222222,
  progressFill:     0x88aaff,
  progressFillOwn:  0xffdd44,
  divider:          0x5a4a3a,
  nextLevelHint:    '#777777',
};

const CARD_W  = 390;
const CARD_H  = 148;
const CARD_PAD = 18;
const GAP      = 12;

// ── Scene ─────────────────────────────────────────────────────────────────────

export default class TribeRelationsOverlay extends Phaser.Scene {
  constructor() {
    super({ key: 'TribeRelationsOverlay' });
  }

  create() {
    const town = this.scene.get('TownScene');
    if (town?.input) town.input.enabled = false;

    const frame = createOverlayFrame(this, {
      title:   'Tribe Relations',
      onClose: () => this._close(),
      bgImage: 'menu_parchment_background',
    });

    const { bounds, depth } = frame;
    this._depth  = depth;
    this._bounds = bounds;

    this._renderCards();
  }

  // ── Card rendering ────────────────────────────────────────────────────────

  _renderCards() {
    const pm     = ProgressionManager;
    const { x, y, width } = this._bounds;
    const depth  = this._depth;

    // Two columns: own tribe on left, three others stacked on right.
    // Own tribe card is taller to reflect more info / more levels.
    const ownId  = pm.tribe;

    // Sort so own tribe is first, then the remaining 3 in fixed order.
    const others = TRIBE_IDS.filter(id => id !== ownId);

    // ── Section label ──
    this.add.text(x + 22, y + 70, 'Your Tribe', {
      fontSize: '13px', color: C.ownTribeHeader, fontStyle: 'italic',
    }).setDepth(depth);

    this.add.text(x + width / 2 + 10, y + 70, 'Other Tribes', {
      fontSize: '13px', color: C.otherTribeHeader, fontStyle: 'italic',
    }).setDepth(depth);

    // ── Own tribe card (left column, full height) ──
    const ownCardH = CARD_H * 3 + GAP * 2; // same total height as 3 right cards
    const ownCardY = y + 92;
    const ownCardX = x + 22;

    if (ownId) {
      this._drawTribeCard(ownCardX, ownCardY, CARD_W, ownCardH, ownId, pm, depth, true);
    } else {
      // No tribe chosen yet
      this.add.text(ownCardX + CARD_W / 2, ownCardY + ownCardH / 2,
        'No tribe chosen yet.', {
          fontSize: '14px', color: '#666666', align: 'center',
        }).setOrigin(0.5).setDepth(depth);
    }

    // ── Other tribe cards (right column, stacked) ──
    const rightX = x + width / 2 + 10;
    others.forEach((id, i) => {
      const cardY = ownCardY + i * (CARD_H + GAP);
      this._drawTribeCard(rightX, cardY, CARD_W, CARD_H, id, pm, depth, false);
    });
  }

  /**
   * Draws a single tribe rep card.
   *
   * @param {number} cx        - left edge of card
   * @param {number} cy        - top edge of card
   * @param {number} cw        - card width
   * @param {number} ch        - card height
   * @param {string} tribeId
   * @param {object} pm        - ProgressionManager
   * @param {number} depth
   * @param {boolean} isOwn
   */
  _drawTribeCard(cx, cy, cw, ch, tribeId, pm, depth, isOwn) {
    const rep = getTribeRepLevel(tribeId, pm);
    const displayName = TRIBE_DISPLAY[tribeId] ?? tribeId;

    // Card background
    const bg = this.add.graphics().setDepth(depth - 1);
    bg.fillStyle(isOwn ? 0x1a1500 : 0x111111, 0.85);
    bg.fillRoundedRect(cx, cy, cw, ch, 6);
    bg.lineStyle(2, isOwn ? 0xbbaa44 : 0x5a4a3a, 1);
    bg.strokeRoundedRect(cx, cy, cw, ch, 6);

    let relY = cy + CARD_PAD;

    // Tribe name
    this.add.text(cx + CARD_PAD, relY, displayName, {
      fontSize: '18px', color: isOwn ? C.ownTribeHeader : C.otherTribeHeader, fontStyle: 'bold',
    }).setDepth(depth);

    // Level name (right-aligned in header row)
    this.add.text(cx + cw - CARD_PAD, relY, rep.name, {
      fontSize: '16px', color: rep.color, fontStyle: 'bold',
    }).setOrigin(1, 0).setDepth(depth);

    relY += 28;

    // Score display
    this.add.text(cx + CARD_PAD, relY, `Score: ${rep.score}`, {
      fontSize: '12px', color: C.score,
    }).setDepth(depth);

    // Progress bar — only if not at max
    const barX  = cx + CARD_PAD;
    const barY  = relY + 18;
    const barW  = cw - CARD_PAD * 2;
    const barH  = 8;

    if (!rep.isMax) {
      const levelDef = isOwn ? OWN_TRIBE_LEVELS : OTHER_TRIBE_LEVELS;
      // bottom of current level = threshold for current index
      const import_getThresholdForIndex = (idx) => {
        const T = [-50, -20, -5, 26, 66, 106];
        return T[idx - 1] ?? -Infinity;
      };
      const floorScore = import_getThresholdForIndex(rep.index);
      const ceilScore  = rep.nextThreshold;           // bottom of next level
      const range = ceilScore - floorScore;
      const fill  = range > 0 ? Phaser.Math.Clamp((rep.score - floorScore) / range, 0, 1) : 0;

      const barGfx = this.add.graphics().setDepth(depth);
      barGfx.fillStyle(C.progressBg, 1);
      barGfx.fillRoundedRect(barX, barY, barW, barH, 3);
      barGfx.fillStyle(isOwn ? C.progressFillOwn : C.progressFill, 1);
      barGfx.fillRoundedRect(barX, barY, barW * fill, barH, 3);

      // "X more to next level"
      const needed = ceilScore - rep.score;
      this.add.text(cx + cw - CARD_PAD, barY, `+${needed} to ${levelDef[rep.index + 1]?.name ?? '?'}`, {
        fontSize: '11px', color: C.nextLevelHint,
      }).setOrigin(1, 0).setDepth(depth);

      relY = barY + barH + 10;
    } else {
      relY = barY + 4;
    }

    // Effect description
    const effectTxt = this.add.text(cx + CARD_PAD, relY, rep.effect, {
      fontSize: '12px', color: C.effect,
      wordWrap: { width: cw - CARD_PAD * 2 },
    }).setDepth(depth);

    // Max level badge
    if (rep.isMax) {
      this.add.text(cx + cw - CARD_PAD, cy + CARD_PAD + 28, '★ MAX', {
        fontSize: '11px', color: rep.color, fontStyle: 'bold',
      }).setOrigin(1, 0).setDepth(depth);
    }
  }

  // ── Close ─────────────────────────────────────────────────────────────────

  _close() {
    const town = this.scene.get('TownScene');
    if (town?.input) town.input.enabled = true;
    this.scene.resume('UIScene');
    this.scene.get('UIScene')?.refreshUI?.();
    this.scene.stop();
  }
}
