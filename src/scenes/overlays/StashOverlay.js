// src/scenes/overlays/StashOverlay.js
import GameState from '../../systems/GameState.js';
import ProgressionManager from '../../systems/ProgressionManager.js';
import { Items } from '../../../data/items.js';
import { isItemInstance, getItemComputedData } from '../../systems/ItemFactory.js';
import Tooltip from '../../ui/Tooltip.js';
import { createOverlayFrame } from '../../ui/OverlayFrame.js';
import { SoundManager } from '../../systems/SoundManager.js';
import { DEPTH, RARITY_COLORS } from '../../ui/styles.js';
import { setupSceneCursor } from '../../ui/cursor.js';

const TRIBE_DISPLAY_NAMES = {
  styx:   'Styx',
  zafaar: 'Zafaar',
  elseth: 'Elseth',
  lesse:  "Le'sse",
};

export default class StashOverlay extends Phaser.Scene {
  constructor() {
    super({ key: 'StashOverlay' });
    this.tooltip = null;
    this._scrollLeft  = 0;
    this._scrollRight = 0;
    this._scrollMaxL  = 0;
    this._scrollMaxR  = 0;
  }

  create() {
    SoundManager.init(this);
    setupSceneCursor(this);

    const town = this.scene.get('TownScene');
    if (town?.input) town.input.enabled = false;

    const tribeId = ProgressionManager.getTribe() || 'styx';
    const tribeName = TRIBE_DISPLAY_NAMES[tribeId] || tribeId;

    const frame = createOverlayFrame(this, {
      title: `${tribeName} Tribe Stash`,
      onClose: () => this._close(),
    });

    this.root = frame.content;
    const { x: px, y: py, width: pw, height: ph } = frame.bounds;

    this.tooltip = new Tooltip(this);
    if (this.tooltip?.container) this.tooltip.container.setDepth(DEPTH.TOOLTIP);

    this.input.on('pointermove', (p) => {
      if (this.tooltip?.reposition) this.tooltip.reposition(p.x, p.y);
    });

    // Layout constants
    const PAD       = 16;
    const DIVIDER_X = px + pw / 2;
    const TOP_Y     = py + 56;
    const BOT_Y     = py + ph - 50;
    const PANEL_H   = BOT_Y - TOP_Y;
    const COL_W     = pw / 2 - PAD * 1.5;

    // Left column: Global Inventory
    const lx = px + PAD;
    // Right column: Tribe Stash
    const rx = DIVIDER_X + PAD;

    // ── Column headers ──
    const headerStyle = { fontSize: '14px', color: '#ffddaa', fontFamily: 'Georgia', fontStyle: 'bold' };
    this.root.add(this.add.text(lx, TOP_Y - 22, 'Global Inventory', headerStyle));
    this.root.add(this.add.text(rx, TOP_Y - 22, `${tribeName} Stash`, headerStyle));

    // ── Transfer All button (inventory → stash) ──
    const transferAllBtn = this.add.text(DIVIDER_X, TOP_Y + PANEL_H / 2, '→ Stash All →', {
      fontSize: '13px', color: '#ffe066', fontFamily: 'Georgia'
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });

    transferAllBtn.on('pointerover', () => transferAllBtn.setColor('#ffffff'));
    transferAllBtn.on('pointerout',  () => transferAllBtn.setColor('#ffe066'));
    transferAllBtn.on('pointerdown', () => {
      this._transferAll(tribeId);
      this._refresh(tribeId, lx, rx, TOP_Y, PANEL_H, COL_W);
    });
    this.root.add(transferAllBtn);

    // ── Divider line ──
    const divGfx = this.add.graphics();
    divGfx.lineStyle(1, 0x555555, 1);
    divGfx.lineBetween(DIVIDER_X, TOP_Y, DIVIDER_X, BOT_Y);
    this.root.add(divGfx);

    // ── Scrollable list containers ──
    // Left mask
    const leftMaskShape = this.add.rectangle(lx + COL_W / 2, TOP_Y + PANEL_H / 2, COL_W, PANEL_H, 0x000000, 0);
    const leftMask = leftMaskShape.createGeometryMask();
    this.root.add(leftMaskShape);

    this.leftList = this.add.container(0, 0);
    this.leftList.setMask(leftMask);
    this.root.add(this.leftList);

    // Right mask
    const rightMaskShape = this.add.rectangle(rx + COL_W / 2, TOP_Y + PANEL_H / 2, COL_W, PANEL_H, 0x000000, 0);
    const rightMask = rightMaskShape.createGeometryMask();
    this.root.add(rightMaskShape);

    this.rightList = this.add.container(0, 0);
    this.rightList.setMask(rightMask);
    this.root.add(this.rightList);

    // Store layout params for refresh
    this._layout = { tribeId, lx, rx, TOP_Y, PANEL_H, COL_W };

    // ── Scroll input ──
    const leftViewport  = new Phaser.Geom.Rectangle(lx, TOP_Y, COL_W, PANEL_H);
    const rightViewport = new Phaser.Geom.Rectangle(rx, TOP_Y, COL_W, PANEL_H);

    this.input.on('wheel', (_p, _go, _dx, dy) => {
      const { x, y } = this.input.activePointer;
      if (Phaser.Geom.Rectangle.Contains(leftViewport, x, y)) {
        this._setScrollLeft(this._scrollLeft + dy * 0.5);
      } else if (Phaser.Geom.Rectangle.Contains(rightViewport, x, y)) {
        this._setScrollRight(this._scrollRight + dy * 0.5);
      }
    });

    this._refresh(tribeId, lx, rx, TOP_Y, PANEL_H, COL_W);
  }

  // ── Build item display info ──
  _fmt(item) {
    const instance = isItemInstance(item) ? item : null;
    const computed  = instance ? getItemComputedData(instance) : null;
    const base      = computed || Items[item?.id] || {};
    const name      = instance?.displayName || base.name || item?.id || 'Unknown';
    const rarity    = instance?.rarity || instance?.quality || base.rarity || base.quality || 'common';
    const color     = RARITY_COLORS[rarity] || '#cccccc';

    const lines = [];
    if (base.type) lines.push(`Type: ${base.type}${base.slot ? ` (${base.slot})` : ''}`);
    if (computed?.damage) lines.push(`Damage: ${computed.damage.min}–${computed.damage.max}`);
    const statBonuses = computed?.bonuses || {};
    for (const [k, v] of Object.entries(statBonuses)) lines.push(`  ${k} +${v}`);
    const misc = instance?.instanceMods?.misc || {};
    if (misc.mpPerTurn) lines.push(`MP/turn +${misc.mpPerTurn}`);
    if (misc.globalDamagePercent) lines.push(`Damage +${misc.globalDamagePercent}%`);
    if (base.description) lines.push('', base.description);

    return { title: name, titleColor: color, lines, name, color };
  }

  // ── Render both lists ──
  _refresh(tribeId, lx, rx, TOP_Y, PANEL_H, COL_W) {
    this._scrollLeft  = 0;
    this._scrollRight = 0;
    this.leftList.removeAll(true);
    this.rightList.removeAll(true);
    this.leftList.y  = 0;
    this.rightList.y = 0;

    const globalItems = GameState.inventory;
    const stashItems  = GameState.getStash(tribeId);

    const leftHeight = this._buildList(
      this.leftList, globalItems, lx, TOP_Y, COL_W, PANEL_H,
      (item) => {
        GameState.removeFromInventory(item.instanceId);
        GameState.addToStash(tribeId, item);
        GameState.save('autosave');
        SoundManager.play('handsClick');
        this._refresh(tribeId, lx, rx, TOP_Y, PANEL_H, COL_W);
      },
      '→', '#ffe066'
    );

    const rightHeight = this._buildList(
      this.rightList, stashItems, rx, TOP_Y, COL_W, PANEL_H,
      (item) => {
        GameState.removeFromStash(tribeId, item.instanceId);
        GameState.addToInventory(item);
        GameState.save('autosave');
        SoundManager.play('handsClick');
        this._refresh(tribeId, lx, rx, TOP_Y, PANEL_H, COL_W);
      },
      '←', '#88ccff'
    );

    this._scrollMaxL = Math.max(0, leftHeight  - PANEL_H);
    this._scrollMaxR = Math.max(0, rightHeight - PANEL_H);
  }

  // Returns total content height so caller can set scroll max
  _buildList(container, items, colX, TOP_Y, colW, panelH, onTransfer, arrowChar, arrowColor) {
    const ROW_H   = 32;
    const ROW_PAD = 6;

    if (!items || items.length === 0) {
      container.add(
        this.add.text(colX + 8, TOP_Y + 16, '— empty —', { fontSize: '13px', color: '#666666', fontFamily: 'Georgia' })
      );
      return 0;
    }

    items.forEach((item, i) => {
      const rowY = TOP_Y + i * (ROW_H + ROW_PAD);
      const info = this._fmt(item);

      const bg = this.add.rectangle(colX + colW / 2, rowY + ROW_H / 2, colW, ROW_H, 0x1e1e1e, 1)
        .setStrokeStyle(1, 0x444444)
        .setInteractive({ useHandCursor: true });

      const nameTxt = this.add.text(colX + 8, rowY + ROW_H / 2, info.name, {
        fontSize: '13px',
        color: info.color,
        fontFamily: 'Georgia',
      }).setOrigin(0, 0.5);

      const arrow = this.add.text(colX + colW - 10, rowY + ROW_H / 2, arrowChar, {
        fontSize: '14px',
        color: arrowColor,
        fontFamily: 'Georgia',
        fontStyle: 'bold',
      }).setOrigin(1, 0.5).setInteractive({ useHandCursor: true });

      const highlight = () => {
        bg.setFillStyle(0x2e3040, 1);
        const { x, y } = this.input.activePointer;
        this.tooltip?.show(x, y, { title: info.title, titleColor: info.titleColor, lines: info.lines });
      };
      const unhighlight = () => {
        bg.setFillStyle(0x1e1e1e, 1);
        this.tooltip?.hide();
      };

      bg.on('pointerover', highlight);
      bg.on('pointerout',  unhighlight);
      nameTxt.setInteractive({ useHandCursor: true });
      nameTxt.on('pointerover', highlight);
      nameTxt.on('pointerout',  unhighlight);

      arrow.on('pointerover', () => arrow.setColor('#ffffff'));
      arrow.on('pointerout',  () => arrow.setColor(arrowColor));
      arrow.on('pointerdown', () => onTransfer(item));
      bg.on('pointerdown',    () => onTransfer(item));

      container.add([bg, nameTxt, arrow]);
    });

    return items.length * (ROW_H + ROW_PAD);
  }

  _transferAll(tribeId) {
    const items = [...GameState.inventory];
    for (const item of items) {
      GameState.removeFromInventory(item.instanceId);
      GameState.addToStash(tribeId, item);
    }
    GameState.save('autosave');
    SoundManager.play('handsClick');
  }

  _setScrollLeft(y) {
    this._scrollLeft = Phaser.Math.Clamp(y, 0, this._scrollMaxL);
    this.leftList.y = -this._scrollLeft;
  }

  _setScrollRight(y) {
    this._scrollRight = Phaser.Math.Clamp(y, 0, this._scrollMaxR);
    this.rightList.y = -this._scrollRight;
  }

  _close() {
    this.tooltip?.hide();
    const town = this.scene.get('TownScene');
    if (town?.input) town.input.enabled = true;
    this.scene.resume('UIScene');
    this.scene.stop();
  }
}
