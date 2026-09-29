// src/scenes/overlays/PartsBuyerOverlay.js
//
// The Bone Pile keeper buys beast parts from the camp bag for Hunt Tickets
// (owner 2026-09-29, playtest batch 4b chunk 6). Prices and bundles are
// src/systems/PartsBuyer.js; this lists the parts, what each stack fetches,
// and sells one stack or all of them. Laid out like StashOverlay.
import { wakeTown } from '../../ui/townInput.js';
import GameState from '../../systems/GameState.js';
import ProgressionManager from '../../systems/ProgressionManager.js';
import Tooltip from '../../ui/Tooltip.js';
import { createOverlayFrame } from '../../ui/OverlayFrame.js';
import { createRectMask } from '../../ui/masks.js';
import { SoundManager } from '../../systems/SoundManager.js';
import { DEPTH, RARITY_COLORS } from '../../ui/styles.js';
import { setupSceneCursor } from '../../ui/cursor.js';
import { buildItemTooltipLines } from '../../ui/itemTooltip.js';
import { isSellablePart, partOffer, sellPart, sellAllParts, partMultiplier } from '../../systems/PartsBuyer.js';

const FONT = 'Georgia, Gelasio, serif';
const ROW_H = 30;
const ROW_PAD = 5;

export default class PartsBuyerOverlay extends Phaser.Scene {
  constructor() {
    super({ key: 'PartsBuyerOverlay' });
    this.tooltip = null;
    this._scroll = 0;
    this._scrollMax = 0;
  }

  create() {
    SoundManager.init(this);
    setupSceneCursor(this);
    const town = this.scene.get('TownScene');
    if (town?.input) town.input.enabled = false;

    const frame = createOverlayFrame(this, { title: 'The Bone Pile: Parts', onClose: () => this._close() });
    this.root = frame.content;
    const { x: px, y: py, width: pw, height: ph } = frame.bounds;

    this.tooltip = new Tooltip(this);
    if (this.tooltip?.container) this.tooltip.container.setDepth(DEPTH.TOOLTIP);
    this.input.on('pointermove', (p) => this.tooltip?.reposition?.(p.x, p.y));

    const PAD = 20;
    this.L = { x: px + PAD, w: pw - PAD * 2, top: py + 116, h: ph - 116 - 70 };

    this.root.add(this.add.text(this.L.x, py + 66,
      '"Bones, hides, teeth. I have a use for all of it." 10 Common or 4 Uncommon parts a ticket, a Rare 1, an Epic 3.\n' +
      'An apex beast\'s parts fetch double, a boss\'s triple. Only whole tickets: what is left over stays in your bag.',
      { fontSize: '13px', color: '#c8b89a', fontFamily: FONT, wordWrap: { width: this.L.w } }));

    const { graphics: maskShape, mask } = createRectMask(this, this.L.x, this.L.top, this.L.w, this.L.h);
    this.root.add(maskShape);
    this.list = this.add.container(0, 0);
    this.list.setMask(mask);
    this.root.add(this.list);

    const viewport = new Phaser.Geom.Rectangle(this.L.x, this.L.top, this.L.w, this.L.h);
    this.input.on('wheel', (_p, _go, _dx, dy) => {
      const { x, y } = this.input.activePointer;
      if (Phaser.Geom.Rectangle.Contains(viewport, x, y)) this._setScroll(this._scroll + dy * 0.5);
    });

    this.footer = this.add.container(0, 0);
    this.root.add(this.footer);
    this.footerY = py + ph - 48;
    this._refresh();
  }

  _parts() {
    return (GameState.inventory || []).filter(isSellablePart);
  }

  _refresh() {
    const prev = this._scroll || 0;
    this.list.removeAll(true);
    this.footer.removeAll(true);
    const parts = this._parts();
    const { x, w, top } = this.L;

    if (!parts.length) {
      this.list.add(this.add.text(x + 8, top + 12, '— no beast parts in your bag —', { fontSize: '13px', color: '#666666', fontFamily: FONT }));
    }
    parts.forEach((inst, i) => {
      const y = top + i * (ROW_H + ROW_PAD);
      const info = buildItemTooltipLines(inst, { rarityColors: RARITY_COLORS });
      const offer = partOffer(inst);
      const mult = partMultiplier(inst);
      const bg = this.add.rectangle(x + w / 2, y + ROW_H / 2, w, ROW_H, 0x1e1e1e, 1).setStrokeStyle(1, 0x444444).setInteractive();
      const name = this.add.text(x + 8, y + ROW_H / 2, info.name + (mult > 1 ? (mult === 3 ? '  (boss)' : '  (apex)') : ''), {
        fontSize: '13px', color: info.color, fontFamily: FONT,
      }).setOrigin(0, 0.5);
      const canSell = offer && offer.tickets > 0;
      const label = canSell
        ? `[ Sell ${offer.sellable} for ${offer.tickets} ticket${offer.tickets === 1 ? '' : 's'} ]`
        : `(${offer?.bundle || '?'} needed for a ticket)`;
      const sell = this.add.text(x + w - 8, y + ROW_H / 2, label, {
        fontSize: '13px', color: canSell ? '#ffe066' : '#777777', fontFamily: FONT,
      }).setOrigin(1, 0.5);
      if (canSell) {
        sell.setInteractive({ useHandCursor: true })
          .on('pointerover', () => sell.setColor('#ffffff'))
          .on('pointerout', () => sell.setColor('#ffe066'))
          .on('pointerdown', () => {
            sellPart(GameState.inventory, inst, ProgressionManager);
            this._afterSale();
          });
      }
      bg.on('pointerover', () => { bg.setFillStyle(0x2e3040, 1); const p = this.input.activePointer; this.tooltip?.show(p.x, p.y, { title: info.title, titleColor: info.titleColor, lines: info.lines }); });
      bg.on('pointerout', () => { bg.setFillStyle(0x1e1e1e, 1); this.tooltip?.hide(); });
      this.list.add([bg, name, sell]);
    });

    const total = parts.reduce((n, inst) => n + (partOffer(inst)?.tickets || 0), 0);
    const tickets = this.add.text(x, this.footerY, `Hunt Tickets: ${ProgressionManager.huntTickets}`, { fontSize: '15px', color: '#dddddd', fontFamily: FONT }).setOrigin(0, 0.5);
    const all = this.add.text(x + w, this.footerY, total > 0 ? `[ Sell all for ${total} ticket${total === 1 ? '' : 's'} ]` : '[ Nothing worth a ticket ]', {
      fontSize: '16px', color: total > 0 ? '#88ff88' : '#777777', fontFamily: FONT,
    }).setOrigin(1, 0.5);
    if (total > 0) {
      all.setInteractive({ useHandCursor: true })
        .on('pointerover', () => all.setColor('#ffffff'))
        .on('pointerout', () => all.setColor('#88ff88'))
        .on('pointerdown', () => { sellAllParts(GameState.inventory, ProgressionManager); this._afterSale(); });
    }
    this.footer.add([tickets, all]);

    this._scrollMax = Math.max(0, parts.length * (ROW_H + ROW_PAD) - this.L.h);
    this._setScroll(prev);
  }

  _afterSale() {
    SoundManager.play('reward');
    this.tooltip?.hide();
    GameState.save('autosave');
    this.scene.get('UIScene')?.refreshUI?.();
    this.scene.get('TownScene')?._updateVendorCurrencyDisplay?.();
    this._refresh();
  }

  _setScroll(v) {
    this._scroll = Phaser.Math.Clamp(v, 0, this._scrollMax);
    this.list.y = -this._scroll;
  }

  _close() {
    this.tooltip?.hide();
    wakeTown(this);
    this.scene.resume('UIScene');
    this.scene.stop();
  }
}
