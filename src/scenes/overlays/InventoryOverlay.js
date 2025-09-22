import GameState from '../../systems/GameState.js';
import { Items } from '../../../data/items.js';
import { isItemInstance, createItemInstance } from '../../systems/ItemFactory.js';
import InventorySystem from '../../systems/InventorySystem.js';
import Tooltip from '../../ui/Tooltip.js';


export default class InventoryOverlay extends Phaser.Scene {
  constructor() {
    super({ key: 'InventoryOverlay' });
    this.selectedCharIndex = 0;
    this.firstOpen = true;
    this.currentGlobalCategory = 'all';
    this.currentPersonalCategory = 'all';
    this.tooltip = null;
  }

  // Keep party & characters in sync after any change to a character object
  _commitChar(updatedChar) {
    const id = updatedChar.id;
    const iP = GameState.party.findIndex(c => c.id === id);
    if (iP !== -1) GameState.party[iP] = updatedChar;

    const iC = GameState.characters.findIndex(c => c.id === id);
    if (iC !== -1) GameState.characters[iC] = updatedChar;
  }



  // === Quality → color map (same palette you used elsewhere) ===
  QUALITY_COLORS = {
    common: '#cccccc',
    uncommon: '#33cc33',
    rare: '#3399ff',
    epic: '#cc33cc',
    legendary: '#ff9933'
  };

  // Build a display object: name, color, and tooltip lines
  // Build a display object: title, titleColor, and body lines
  _formatItemDisplay(item) {
    const base = Items[item.id] || {};
    const name = item.displayName || base.name || item.id;
    const quality = item.quality || base.quality || 'common';
    const color = this.QUALITY_COLORS?.[quality] || '#cccccc';

    const lines = [];
    if (base.type) lines.push(`Type: ${base.type}${base.slot ? ` (${base.slot})` : ''}`);

    if (base.damage) {
      const flatMin = item.instanceMods?.damageFlat?.min || 0;
      const flatMax = item.instanceMods?.damageFlat?.max || 0;
      const dMin = (base.damage.min || 0) + flatMin;
      const dMax = (base.damage.max || 0) + flatMax;
      lines.push(`Damage: ${dMin}–${dMax}${base.hands === 2 ? ' (2h)' : ''}`);
    }

    const merged = { ...(base.bonuses || {}) };
    if (item.instanceMods?.stats) {
      for (const [k, v] of Object.entries(item.instanceMods.stats)) {
        merged[k] = (merged[k] || 0) + v;
      }
    }
    const statKeys = Object.keys(merged);
    if (statKeys.length) {
      lines.push('Bonuses:');
      statKeys.forEach(k => lines.push(`  • ${k} +${merged[k]}`));
    }

    if (item.instanceMods?.derived) {
      const dKeys = Object.keys(item.instanceMods.derived);
      if (dKeys.length) {
        lines.push('Derived:');
        dKeys.forEach(k => lines.push(`  • ${k} +${item.instanceMods.derived[k]}`));
      }
    }

    if (item.prefixes?.length || item.suffixes?.length) {
      if (item.prefixes?.length) lines.push(`Prefixes: ${item.prefixes.join(', ')}`);
      if (item.suffixes?.length) lines.push(`Suffixes: ${item.suffixes.join(', ')}`);
    }

    if (base.description) lines.push('', base.description);

    // NEW: return title + titleColor separately
    return { title: name, titleColor: color, lines, name, color };
  }


  create() {
    // ensure clean state on every create()
    if (this.tooltip) { this.tooltip.destroy(); this.tooltip = null; }

    // fresh tooltip (this scene instance owns the display list that will be destroyed on restart)
    this.tooltip = new Tooltip(this);
    this.input.on('pointerdown', () => this.tooltip.hide());

    // remove any leftover wheel handler from a previous run
    if (this._onWheel) this.input.off('wheel', this._onWheel, this);


    // BACKDROP
    this.add.rectangle(640, 360, 1280, 720, 0x000000, 0)
      .setInteractive()
      .setDepth(1999);

    const safeWidth = (1280 - (180 * 2)) - 20 + 10;
    const safeHeight = 720 - (15 + 15);

    const bg = this.add.rectangle(640, 720 / 2, safeWidth, safeHeight, 0x111111, 0.95)
      .setStrokeStyle(3, 0xffffff)
      .setDepth(2000);

    if (this.firstOpen) {
      bg.setAlpha(0);
      this.tweens.add({ targets: bg, alpha: 1, duration: 200 });
      this.firstOpen = false;
    }

    this.add.text(640, 50, 'Inventory', {
      fontSize: '28px',
      color: '#ffddaa',
      fontFamily: 'Georgia'
    }).setOrigin(0.5).setDepth(2001);

    // CHARACTER SELECTOR
    GameState.party.forEach((char, i) => {
      this.add.text(200 + i * 120, 100, char.name, {
        fontSize: '18px',
        color: (i === this.selectedCharIndex) ? '#ffff88' : '#cccccc'
      }).setInteractive({ useHandCursor: true })
        .on('pointerdown', () => { this.selectedCharIndex = i; this.scene.restart(); })
        .setDepth(2001);
    });

    const char = GameState.party[this.selectedCharIndex];
    const mainHandItem = char.equipment.weaponMain;
    const mainHandIsTwoHand = mainHandItem && Items[isItemInstance(mainHandItem) ? mainHandItem.id : mainHandItem]?.hands === 2;

    // EQUIPPED GEAR
    let equipY = 140;
    this.add.text(200, equipY, 'Equipped:', { fontSize: '18px', color: '#ffffff' }).setDepth(2001);
    equipY += 20;

    Object.keys(char.equipment).forEach(slot => {
      const equippedItem = char.equipment[slot];
      let itemName = 'None';
      if (isItemInstance(equippedItem)) {
        itemName = Items[equippedItem.id]?.name || equippedItem.id;
      } else if (typeof equippedItem === 'string') {
        itemName = Items[equippedItem]?.name || equippedItem;
      }
      const lineY = equipY;

      const disp = isItemInstance(equippedItem)
        ? this._formatItemDisplay(equippedItem)
        : { name: itemName, color: '#cccccc', lines: [itemName] };

      const nameTxt = this.add.text(200, lineY, `${slot}: ${disp.name}`, {
        fontSize: '14px',
        color: disp.color
      }).setDepth(2001)
        .setInteractive({ useHandCursor: true })
        .on('pointerover', (p) => this.tooltip.show(p.worldX, p.worldY, {
          title: disp.title || disp.name,
          titleColor: disp.titleColor || disp.color,
          lines: disp.lines
        }))
        .on('pointerout', () => this.tooltip.hide())
        .on('pointermove', (p) => this.tooltip.show(p.worldX, p.worldY, {
          title: disp.title || disp.name,
          titleColor: disp.titleColor || disp.color,
          lines: disp.lines
        }))


      if (equippedItem) {
        this.add.text(380, lineY, '[X]', { fontSize: '12px', color: '#ff5555' })
          .setInteractive({ useHandCursor: true })
          .on('pointerdown', () => {
            const updatedChar = InventorySystem.unequipItemFromSlot(char, slot);
            this._commitChar(updatedChar);
            this.scene.restart();

          })

          .setDepth(2001);
      }

      equipY += 16;
    });

    // --- PERSONAL INVENTORY HEADER ---
    equipY += 10;
    this.add.text(200, equipY, 'Personal Inventory:', { fontSize: '16px', color: '#ffffff' }).setDepth(2001);
    equipY += 20;

    // Personal category toggle
    const personalCats = [
      { key: 'weapon', label: 'Wp.' },
      { key: 'armor', label: 'Ar.' },
      { key: 'item', label: 'It.' },
      { key: 'all', label: 'All' }
    ];
    personalCats.forEach((cat, i) => {
      const x = 200 + i * 50;
      this.add.text(x, equipY, cat.label, {
        fontSize: '12px',
        color: (this.currentPersonalCategory === cat.key) ? '#ffff88' : '#cccccc'
      }).setInteractive({ useHandCursor: true })
        .on('pointerdown', () => { this.currentPersonalCategory = cat.key; this.scene.restart(); })
        .setDepth(2001);
    });
    equipY += 20;

    // --- PERSONAL DATA ---
    let personalItems = [...(char.inventory || [])];
    personalItems = this._filterByCategory(personalItems, this.currentPersonalCategory);

    // --- PERSONAL MASK + LIST (OFF-DISPLAY GEO, NO DISPLAY-LIST GRAPHICS) ---
    const P_LINE = 18;
    const pMaskWidth = 300;
    const pMaskHeight = 100;
    const pMaskX = 200;
    const pMaskY = equipY;

    // geometry for mask (not added to display list)
    const pMaskGfx = this.make.graphics({ x: pMaskX, y: pMaskY, add: false });
    pMaskGfx.fillStyle(0xffffff, 1);
    pMaskGfx.fillRect(0, 0, pMaskWidth, pMaskHeight);
    const pMaskShape = new Phaser.Display.Masks.GeometryMask(this, pMaskGfx);

    // list container, positioned exactly at mask origin
    const pList = this.add.container(pMaskX, pMaskY).setDepth(2001).setMask(pMaskShape);

    // (optional) debug window; comment out when done
    // this.add.rectangle(pMaskX, pMaskY, pMaskWidth, pMaskHeight, 0x00ff00, 0.08).setDepth(2000);

    // --- PERSONAL ROWS ---
    personalItems.forEach((item, idx) => {
      const baseItem = Items[item.id] || {};
      const y = idx * P_LINE;

      const dispP = this._formatItemDisplay(item);

      const rowP = this.add.text(0, y, `• ${dispP.name}`, { fontSize: '12px', color: dispP.color })
        .setInteractive({ useHandCursor: true })
        .on('pointerover', (p) => this.tooltip.show(p.worldX, p.worldY, {
          title: dispP.title || dispP.name,
          titleColor: dispP.titleColor || dispP.color,
          lines: dispP.lines
        }))
        .on('pointerout', () => this.tooltip.hide())
        .on('pointermove', (p) => this.tooltip.show(p.worldX, p.worldY, {
          title: dispP.title || dispP.name,
          titleColor: dispP.titleColor || dispP.color,
          lines: dispP.lines
        }));
      pList.add(rowP);

      const tBtn = this.add.text(150, y, '[T]', { fontSize: '12px', color: '#88ccff' })
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', () => {
          // remove from character immutably
          const updatedChar = InventorySystem.removeItemFromCharacter(char, item);

          // add to global via system helper
          InventorySystem.addGlobalItem(item);

          // commit back to party
          this._commitChar(updatedChar);
          this.scene.restart();

        });


      if (baseItem.type === 'weapon') {
        const mBtn = this.add.text(180, y, '[M]', { fontSize: '12px', color: '#88ff88' })
          .setInteractive({ useHandCursor: true })
          .on('pointerdown', () => {
            const updatedChar = InventorySystem.equipItemFromInventory(char, item, 'weaponMain');
            this._commitChar(updatedChar);
            this.scene.restart();
          });

        const offColor = (baseItem.hands === 2 || mainHandIsTwoHand) ? '#555555' : '#88ff88';
        const oBtn = this.add.text(210, y, '[O]', { fontSize: '12px', color: offColor });
        if (!(baseItem.hands === 2 || mainHandIsTwoHand)) {
          oBtn.setInteractive({ useHandCursor: true })
            .on('pointerdown', () => {
              const updatedChar = InventorySystem.equipItemFromInventory(char, item, 'weaponOff');
              this._commitChar(updatedChar);
              this.scene.restart();
            });
        }
        pList.add([tBtn, mBtn, oBtn]);
      } else if (['chest', 'boots', 'gloves', 'head', 'legs', 'ring', 'amulet'].includes(baseItem.slot)) {
        const eqBtn = this.add.text(180, y, '[Eq]', { fontSize: '12px', color: '#88ff88' })
          .setInteractive({ useHandCursor: true })
          .on('pointerdown', () => {
            const updatedChar = InventorySystem.equipItemFromInventory(char, item, baseItem.slot);
            this._commitChar(updatedChar);
            this.scene.restart();
            this.scene.restart();
          });
        pList.add([tBtn, eqBtn]);
      } else {
        const useBtn = this.add.text(180, y, '[Use]', { fontSize: '12px', color: '#888888' });
        pList.add([tBtn, useBtn]);
      }
    });

    // fallback when empty so you can see *something*
    if (personalItems.length === 0) {
      pList.add(this.add.text(0, 0, '(Empty)', { fontSize: '12px', color: '#777777' }));
    }

    const pContentHeight = Math.max(P_LINE * personalItems.length, 0);
    const pVisibleHeight = pMaskHeight;
    // anchor the list to the mask origin (don’t move it to 0)
    pList.setPosition(pMaskX, pMaskY);

    // define personal area rect for scrolling (no Graphics object needed)
    const pArea = { x: pMaskX, y: pMaskY, w: pMaskWidth, h: pVisibleHeight };


    // GLOBAL INVENTORY
    const gToggleY = 160;
    const globalCats = [
      { key: 'weapon', label: 'Weapons' },
      { key: 'armor', label: 'Armor' },
      { key: 'item', label: 'Items' },
      { key: 'all', label: 'All' }
    ];
    globalCats.forEach((cat, i) => {
      const x = 640 + (i - 1.5) * 100;
      this.add.text(x, gToggleY, cat.label, {
        fontSize: '16px',
        color: (this.currentGlobalCategory === cat.key) ? '#ffff88' : '#cccccc'
      }).setInteractive({ useHandCursor: true })
        .on('pointerdown', () => { this.currentGlobalCategory = cat.key; this.scene.restart(); })
        .setDepth(2001)
        .setOrigin(0.5);
    });

    let inventoryItems = [...(GameState.inventory || [])];
    inventoryItems = this._filterByCategory(inventoryItems, this.currentGlobalCategory);

    const safeHeightAdj = safeHeight - 240;
    const originalRightEdge = (180 + 100) + (safeWidth - 100);
    const newWidth = (safeWidth - 100) - 150;
    const newX = originalRightEdge - newWidth;

    const mask = this.add.graphics().fillRect(0, 0, newWidth, safeHeightAdj);
    const maskShape = mask.createGeometryMask();
    mask.setPosition(newX, gToggleY + 20).setDepth(2001);
    mask.setVisible(false);

    const listContainer = this.add.container(newX, gToggleY + 20).setMask(maskShape).setDepth(2001);

    const spacing = 38;
    inventoryItems.forEach((item, i) => {
      const baseItem = Items[item.id] || {};
      const y = i * spacing;

      const dispG = this._formatItemDisplay(item);
      const rowG = this.add.text(20, y, `• ${dispG.name}`, { fontSize: '16px', color: dispG.color })
        .setInteractive({ useHandCursor: true })
        .on('pointerover', (p) => this.tooltip.show(p.worldX, p.worldY, {
          title: dispG.title || dispG.name,
          titleColor: dispG.titleColor || dispG.color,
          lines: dispG.lines
        }))
        .on('pointerout', () => this.tooltip.hide())
        .on('pointermove', (p) => this.tooltip.show(p.worldX, p.worldY, {
          title: dispG.title || dispG.name,
          titleColor: dispG.titleColor || dispG.color,
          lines: dispG.lines
        }))

      listContainer.add(rowG);


      const transferBtn = this.add.text(270, y, '[Transfer]', { fontSize: '14px', color: '#88ccff' })
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', () => {
          // remove instance from global via system helper
          InventorySystem.removeGlobalItem(item);

          // add to character immutably
          const updatedChar = InventorySystem.addItemToCharacter(char, item);

          this._commitChar(updatedChar);
          this.scene.restart();
        });

      if (baseItem.type === 'weapon') {
        const mBtn = this.add.text(420, y, '[Main]', { fontSize: '14px', color: '#88ff88' })
          .setInteractive({ useHandCursor: true })
          .on('pointerdown', () => {
            // 1) remove from global
            InventorySystem.removeGlobalItem(item);

            // 2) add to character inventory (immutable)
            let updatedChar = InventorySystem.addItemToCharacter(char, item);

            // 3) equip from that inventory state
            updatedChar = InventorySystem.equipItemFromInventory(updatedChar, item, 'weaponMain');

            this._commitChar(updatedChar);
            this.scene.restart();

          })


        const offColor = (baseItem.hands === 2 || mainHandIsTwoHand) ? '#555555' : '#88ff88';
        const oBtn = this.add.text(500, y, '[Off]', { fontSize: '14px', color: offColor });
        if (!(baseItem.hands === 2 || mainHandIsTwoHand)) {
          oBtn.setInteractive({ useHandCursor: true })
            .on('pointerdown', () => {
              InventorySystem.removeGlobalItem(item);
              let updatedChar = InventorySystem.addItemToCharacter(char, item);
              updatedChar = InventorySystem.equipItemFromInventory(updatedChar, item, 'weaponOff');

              this._commitChar(updatedChar);
              this.scene.restart();

            })

        }
        listContainer.add([transferBtn, mBtn, oBtn]);
      } else if (['chest', 'boots', 'gloves', 'head', 'legs', 'ring', 'amulet'].includes(baseItem.slot)) {
        const eqBtn = this.add.text(420, y, '[Eq]', { fontSize: '14px', color: '#88ff88' })
          .setInteractive({ useHandCursor: true })
          .on('pointerdown', () => {
            InventorySystem.removeGlobalItem(item);
            let updatedChar = InventorySystem.addItemToCharacter(char, item);
            updatedChar = InventorySystem.equipItemFromInventory(updatedChar, item, baseItem.slot);

            this._commitChar(updatedChar);
            this.scene.restart();

          })

        listContainer.add([transferBtn, eqBtn]);
      } else {
        const useBtn = this.add.text(420, y, '[Use]', { fontSize: '14px', color: '#888888' });
        listContainer.add([transferBtn, useBtn]);
      }
    });
    // === GLOBAL: measure content & reset scroll ===
    const G_LINE = spacing;               // you set spacing = 38 earlier
    const gContentHeight = Math.max(G_LINE * inventoryItems.length, 0);
    const gVisibleHeight = safeHeightAdj;
    // viewport = mask height for global
    listContainer.setPosition(newX, gToggleY + 20);

    // static global scroll hitbox
    const gArea = { x: newX, y: gToggleY + 20, w: newWidth, h: gVisibleHeight };


    // === Wheel handler (one instance) ===
    // remove any old wheel listener before adding new
    if (this._onWheel) this.input.off('wheel', this._onWheel, this);

    this._onWheel = (pointer, gameObjects, deltaX, deltaY) => {
      const mx = pointer.worldX;
      const my = pointer.worldY;

      // --- GLOBAL SCROLL ---
      if (mx >= gArea.x && mx <= gArea.x + gArea.w && my >= gArea.y && my <= gArea.y + gArea.h) {
        if (gContentHeight > gVisibleHeight) {
          const baseYg = gToggleY + 20;
          const maxScroll = gContentHeight - gVisibleHeight;
          const next = listContainer.y - deltaY * 0.25;
          listContainer.y = Phaser.Math.Clamp(next, baseYg - maxScroll, baseYg);
        } else {
          listContainer.y = gToggleY + 20;
        }

      }

      // PERSONAL scroll/clamp
      if (mx >= pArea.x && mx <= pArea.x + pArea.w && my >= pArea.y && my <= pArea.y + pArea.h) {
        if (pContentHeight > pVisibleHeight) {
          const baseY = pMaskY;
          const maxScroll = pContentHeight - pVisibleHeight;
          const next = pList.y - deltaY * 0.25;
          pList.y = Phaser.Math.Clamp(next, baseY - maxScroll, baseY);
        } else {
          pList.y = pMaskY;
        }

      }

    };

    this.input.on('wheel', this._onWheel, this);

    // cleanup when scene shuts down (prevents stacking on restart)
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      if (this._onWheel) this.input.off('wheel', this._onWheel, this);
      this._onWheel = null;
    });


    // EXIT BUTTON
    this.add.text(640, 720 - 40, '[ Close Inventory ]', {
      fontSize: '20px',
      color: '#ff8888'
    }).setOrigin(0.5).setInteractive({ useHandCursor: true })
      .on('pointerdown', () => this.scene.stop()).setDepth(2001);
  }

  _filterByCategory(items, category) {
    if (category === 'weapon') {
      return items.filter(it => Items[it.id]?.type === 'weapon');
    } else if (category === 'armor') {
      return items.filter(it => ['chest', 'boots', 'gloves', 'head', 'legs', 'ring', 'amulet'].includes(Items[it.id]?.slot));
    } else if (category === 'item') {
      return items.filter(it => Items[it.id]?.type !== 'weapon' &&
        !['chest', 'boots', 'gloves', 'head', 'legs', 'ring', 'amulet'].includes(Items[it.id]?.slot));
    }
    return items;
  }
}
