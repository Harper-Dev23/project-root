// src/scenes/overlays/PackingOverlay.js
//
// Choose what goes with the party (owner 2026-09-29, playtest batch 4b
// chunk 7, the extraction model): the camp bag on the left, what is going on
// the right. Nothing moves here: the Hunt screen keeps the choice and
// takeDeparture takes those entries out of the camp bag when the party
// leaves. Everything packed is at risk; everything left behind is safe.
// Rations are packed by the Hunt screen's own counter and hunt plans by its
// picker, so neither is listed. Laid out like StashOverlay.
import GameState from '../../systems/GameState.js';
import Tooltip from '../../ui/Tooltip.js';
import { createOverlayFrame } from '../../ui/OverlayFrame.js';
import { createRectMask } from '../../ui/masks.js';
import { SoundManager } from '../../systems/SoundManager.js';
import { DEPTH, RARITY_COLORS } from '../../ui/styles.js';
import { setupSceneCursor } from '../../ui/cursor.js';
import { buildItemTooltipLines } from '../../ui/itemTooltip.js';
import { Items } from '../../../data/items.js';

const FONT = 'Georgia, Gelasio, serif';
const ROW_H = 30;
const ROW_PAD = 5;

/** Camp bag entries that can be packed here. */
export function packable(inv = GameState.inventory) {
  return (inv || []).filter(it => it?.instanceId && it.id !== 'rations' && Items[it.id]?.type !== 'huntPlan');
}

export default class PackingOverlay extends Phaser.Scene {
  constructor() {
    super({ key: 'PackingOverlay' });
  }

  init(data) {
    this._chosen = new Set(data?.packIds || []);
    this._onDone = typeof data?.onDone === 'function' ? data.onDone : null;
    this._scroll = { left: 0, right: 0 };
    this._max = { left: 0, right: 0 };
  }

  create() {
    SoundManager.init(this);
    setupSceneCursor(this);
    const frame = createOverlayFrame(this, { title: 'Pack for the Hunt', onClose: () => this._close() });
    this.root = frame.content;
    const { x: px, y: py, width: pw, height: ph } = frame.bounds;

    this.tooltip = new Tooltip(this);
    if (this.tooltip?.container) this.tooltip.container.setDepth(DEPTH.TOOLTIP);
    this.input.on('pointermove', (p) => this.tooltip?.reposition?.(p.x, p.y));

    const PAD = 16;
    const top = py + 96;
    const h = ph - 96 - 60;
    const colW = pw / 2 - PAD * 1.5;
    this.cols = {
      left: { x: px + PAD, w: colW, top, h },
      right: { x: px + pw / 2 + PAD / 2, w: colW, top, h },
    };
    const head = { fontSize: '14px', color: '#ffddaa', fontFamily: FONT, fontStyle: 'bold' };
    this.root.add(this.add.text(px + PAD, py + 48,
      'What you pack goes into your hunt pack, and is at risk. What stays is safe in camp. Rations are packed on the Hunt screen.',
      { fontSize: '13px', color: '#c8b89a', fontFamily: FONT, wordWrap: { width: pw - PAD * 2 } }));
    this.root.add(this.add.text(this.cols.left.x, top - 22, 'Camp Bag (stays in camp)', head));
    this.root.add(this.add.text(this.cols.right.x, top - 22, 'Going with you (at risk)', head));

    for (const side of ['left', 'right']) {
      const c = this.cols[side];
      const { graphics, mask } = createRectMask(this, c.x, c.top, c.w, c.h);
      this.root.add(graphics);
      c.list = this.add.container(0, 0);
      c.list.setMask(mask);
      this.root.add(c.list);
      c.view = new Phaser.Geom.Rectangle(c.x, c.top, c.w, c.h);
    }
    this.input.on('wheel', (_p, _go, _dx, dy) => {
      const { x, y } = this.input.activePointer;
      for (const side of ['left', 'right']) if (Phaser.Geom.Rectangle.Contains(this.cols[side].view, x, y)) this._setScroll(side, this._scroll[side] + dy * 0.5);
    });

    const done = this.add.text(px + pw - PAD, py + ph - 30, '[ Done ]', { fontSize: '17px', color: '#88ff88', fontFamily: FONT })
      .setOrigin(1, 0.5).setInteractive({ useHandCursor: true })
      .on('pointerover', () => done.setColor('#ffffff'))
      .on('pointerout', () => done.setColor('#88ff88'))
      .on('pointerdown', () => this._close());
    this.root.add(done);
    this.countText = this.add.text(px + PAD, py + ph - 30, '', { fontSize: '14px', color: '#dddddd', fontFamily: FONT }).setOrigin(0, 0.5);
    this.root.add(this.countText);
    this._refresh();
  }

  _refresh() {
    const all = packable();
    const left = all.filter(it => !this._chosen.has(it.instanceId));
    const right = all.filter(it => this._chosen.has(it.instanceId));
    this._build('left', left, '→', '#ffe066');
    this._build('right', right, '←', '#88ccff');
    this.countText.setText(`${right.length} entr${right.length === 1 ? 'y' : 'ies'} packed`);
  }

  _build(side, items, arrow, arrowColor) {
    const c = this.cols[side];
    c.list.removeAll(true);
    if (!items.length) c.list.add(this.add.text(c.x + 8, c.top + 12, '— empty —', { fontSize: '13px', color: '#666666', fontFamily: FONT }));
    items.forEach((it, i) => {
      const y = c.top + i * (ROW_H + ROW_PAD);
      const info = buildItemTooltipLines(it, { rarityColors: RARITY_COLORS });
      const bg = this.add.rectangle(c.x + c.w / 2, y + ROW_H / 2, c.w, ROW_H, 0x1e1e1e, 1).setStrokeStyle(1, 0x444444).setInteractive({ useHandCursor: true });
      const name = this.add.text(c.x + 8, y + ROW_H / 2, info.name, { fontSize: '13px', color: info.color, fontFamily: FONT }).setOrigin(0, 0.5);
      const arr = this.add.text(c.x + c.w - 10, y + ROW_H / 2, arrow, { fontSize: '14px', color: arrowColor, fontFamily: FONT, fontStyle: 'bold' }).setOrigin(1, 0.5);
      const move = () => {
        SoundManager.play('handsClick');
        this.tooltip?.hide();
        if (this._chosen.has(it.instanceId)) this._chosen.delete(it.instanceId); else this._chosen.add(it.instanceId);
        this._refresh();
      };
      bg.on('pointerover', () => { bg.setFillStyle(0x2e3040, 1); const p = this.input.activePointer; this.tooltip?.show(p.x, p.y, { title: info.title, titleColor: info.titleColor, lines: info.lines }); });
      bg.on('pointerout', () => { bg.setFillStyle(0x1e1e1e, 1); this.tooltip?.hide(); });
      bg.on('pointerdown', move);
      c.list.add([bg, name, arr]);
    });
    this._max[side] = Math.max(0, items.length * (ROW_H + ROW_PAD) - c.h);
    this._setScroll(side, this._scroll[side]);
  }

  _setScroll(side, v) {
    this._scroll[side] = Phaser.Math.Clamp(v, 0, this._max[side]);
    this.cols[side].list.y = -this._scroll[side];
  }

  _close() {
    this.tooltip?.hide();
    const ids = [...this._chosen].filter(id => packable().some(it => it.instanceId === id));
    this.scene.stop();
    this._onDone?.(ids);
  }
}
