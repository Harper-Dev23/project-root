import GameState from '../../systems/GameState.js';
import { Items } from '../../../data/items.js';
import { isItemInstance, getItemComputedData } from '../../systems/ItemFactory.js';
import InventorySystem from '../../systems/InventorySystem.js';
import Tooltip from '../../ui/Tooltip.js';
import { createOverlayFrame } from '../../ui/OverlayFrame.js';


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
    const instance = isItemInstance(item) ? item : null;
    const computed = instance ? getItemComputedData(instance) : null;
    const base = computed || Items[item.id] || Items[item] || {};
    const name = instance?.displayName || computed?.name || base.name || instance?.id || item?.id || 'Unknown';
    const quality = instance?.quality || computed?.quality || base.quality || 'common';
    const color = this.QUALITY_COLORS?.[quality] || '#cccccc';

    const lines = [];
    if (base.type) lines.push(`Type: ${base.type}${base.slot ? ` (${base.slot})` : ''}`);

    if (computed?.damage) {
      const range = `${computed.damage.min}–${computed.damage.max}`;
      lines.push(`Damage: ${range}${base.hands === 2 ? ' (2h)' : ''}`);
    }

    const statBonuses = computed?.bonuses || {};
    const statKeys = Object.keys(statBonuses);
    if (statKeys.length) {
      lines.push('Bonuses:');
      statKeys.forEach(k => lines.push(`  • ${k} +${statBonuses[k]}`));
    }

    const derivedMods = instance?.instanceMods?.derived || {};
    const derivedKeys = Object.keys(derivedMods);
    if (derivedKeys.length) {
      lines.push('Derived:');
      derivedKeys.forEach(k => lines.push(`  • ${k} +${derivedMods[k]}`));
    }

    const dmgFlat = instance?.instanceMods?.damageFlat || {};
    const dmgPercent = instance?.instanceMods?.damagePercent?.weapon || 0;
    if ((dmgFlat.min || 0) || (dmgFlat.max || 0) || dmgPercent) {
      lines.push('Weapon Modifiers:');
      if (dmgFlat.min) lines.push(`  • Min Damage +${dmgFlat.min}`);
      if (dmgFlat.max) lines.push(`  • Max Damage +${dmgFlat.max}`);
      if (dmgPercent) lines.push(`  • Local Weapon Damage +${dmgPercent}%`);
    }

    const elemFlat = instance?.instanceMods?.elementalFlat || {};
    const elemEntries = Object.entries(elemFlat).filter(([, v]) => (v.min || 0) || (v.max || 0));
    if (elemEntries.length) {
      lines.push('Added Damage:');
      elemEntries.forEach(([el, v]) => lines.push(`  • ${el.toUpperCase()} +${v.min}–${v.max}`));
    }

    const misc = instance?.instanceMods?.misc || {};
    if (misc.mpPerTurn) lines.push(`MP per Turn: +${misc.mpPerTurn}`);
    if (misc.skillCostReductionPct) lines.push(`Skill Cost Reduction: -${misc.skillCostReductionPct}%`);
    if (misc.globalDamagePercent) lines.push(`Damage (all sources): +${misc.globalDamagePercent}%`);
    if (misc.elementalDamagePercent) lines.push(`Elemental Damage: +${misc.elementalDamagePercent}%`);
    if (misc.necroticDamagePercent) lines.push(`Necrotic Damage: +${misc.necroticDamagePercent}%`);
    if (misc.resilience) lines.push(`Resilience: +${misc.resilience}`);

    const buildup = misc.buildupPercent || {};
    const buildupKeys = Object.keys(buildup);
    if (buildupKeys.length) {
      lines.push('Buildup Bonus:');
      buildupKeys.forEach(k => lines.push(`  • ${k.toUpperCase()} +${buildup[k]}%`));
    }

    if (instance?.prefixes?.length || instance?.suffixes?.length) {
      if (instance.prefixes?.length) lines.push(`Prefixes: ${instance.prefixes.join(', ')}`);
      if (instance.suffixes?.length) lines.push(`Suffixes: ${instance.suffixes.join(', ')}`);
    }

    if (base.description) lines.push('', base.description);

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

    const frame = createOverlayFrame(this, {
      title: 'Inventory',
      onClose: () => this._handleClose()
    });

    const safeWidth = frame.bounds.width;
    const safeHeight = frame.bounds.height;
    const contentDepth = frame.depth;


    const globalListWidth = (safeWidth - 100) - 150;
    const globalListLeft = (180 + 100) + (safeWidth - 100) - globalListWidth;

    if (this.firstOpen) {
      frame.panel.setAlpha(0);
      this.tweens.add({ targets: frame.panel, alpha: 0.95, duration: 200 });
      this.firstOpen = false;
    }

    frame.dimmer.setAlpha(0.65);

    // CHARACTER SELECTOR
    GameState.party.forEach((char, i) => {
      this.add.text(200 + i * 120, 100, char.name, {
        fontSize: '18px',
        color: (i === this.selectedCharIndex) ? '#ffff88' : '#cccccc'
      }).setInteractive({ useHandCursor: true })
        .on('pointerdown', () => { this.selectedCharIndex = i; this.scene.restart(); })
        .setDepth(contentDepth);
    });

    const char = GameState.party[this.selectedCharIndex];
    const mainHandItem = char.equipment.weaponMain;
    const mainHandIsTwoHand = mainHandItem && Items[isItemInstance(mainHandItem) ? mainHandItem.id : mainHandItem]?.hands === 2;

    // EQUIPPED GEAR
    let equipY = 140;
    this.add.text(200, equipY, 'Equipped:', { fontSize: '18px', color: '#ffffff' }).setDepth(contentDepth);
    equipY += 20;

    const EQUIPPED_TEXT_WIDTH = 160;
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

      const slotLabel = this._formatLabel(slot);
      const simpleName = this._getEquippedSimpleName(slot, equippedItem, disp.name);

      const slotColor = equippedItem ? disp.color : '#777777';


      const nameTxt = this.add.text(200, lineY, `${slotLabel}: ${simpleName}`, {
        fontSize: '14px',
        color: slotColor,
        wordWrap: { width: EQUIPPED_TEXT_WIDTH, useAdvancedWrap: true }
      }).setDepth(contentDepth)
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

          .setDepth(contentDepth);
      }

      equipY += Math.max(nameTxt.height, 16) + 4;
    });

    // --- PERSONAL INVENTORY HEADER ---
    equipY += 10;
    this.add.text(200, equipY, 'Personal Inventory:', { fontSize: '16px', color: '#ffffff' }).setDepth(contentDepth);
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
        .setDepth(contentDepth);
    });
    equipY += 20;

    // --- PERSONAL DATA ---
    let personalItems = [...(char.inventory || [])];
    personalItems = this._filterByCategory(personalItems, this.currentPersonalCategory);

    // --- PERSONAL MASK + LIST (OFF-DISPLAY GEO, NO DISPLAY-LIST GRAPHICS) ---

    const pMaskX = 200;
    const pMaskY = equipY;
    const pMaskWidth = globalListLeft - pMaskX;
    const pMaskHeight = Math.max(150, (safeHeight - 60) - pMaskY);

    // geometry for mask (not added to display list)
    const pMaskGfx = this.make.graphics({ x: pMaskX, y: pMaskY, add: false });
    pMaskGfx.fillStyle(0xffffff, 1);
    pMaskGfx.fillRect(0, 0, pMaskWidth, pMaskHeight);
    const pMaskShape = new Phaser.Display.Masks.GeometryMask(this, pMaskGfx);

    // list container, positioned exactly at mask origin
    const pList = this.add.container(pMaskX, pMaskY).setDepth(contentDepth).setMask(pMaskShape);

    // --- PERSONAL ROWS ---
    const PERSONAL_TEXT_WIDTH = 140;
    const BUTTON_START_X = Math.max(0, pMaskWidth - 80);
    const BUTTON_SPACING = 28;
    let personalCursorY = 0;
    personalItems.forEach((item) => {
      const baseItem = Items[item.id] || {};
      const y = personalCursorY;

      const dispP = this._formatItemDisplay(item);

      const rowP = this.add.text(0, y, `• ${dispP.name}`, {
        fontSize: '12px',
        color: dispP.color,
        wordWrap: { width: PERSONAL_TEXT_WIDTH, useAdvancedWrap: true }
      })
        .setInteractive({ useHandCursor: true })
        .on('pointerover', (p) => {
          if (!this._isPointerWithinArea(p, pArea)) return;
          this.tooltip.show(p.worldX, p.worldY, {
            title: dispP.title || dispP.name,
            titleColor: dispP.titleColor || dispP.color,
            lines: dispP.lines
          });
        })
        .on('pointerout', () => this.tooltip.hide())
        .on('pointermove', (p) => {
          if (!this._isPointerWithinArea(p, pArea)) {
            this.tooltip.hide();
            return;
          }
          this.tooltip.show(p.worldX, p.worldY, {
            title: dispP.title || dispP.name,
            titleColor: dispP.titleColor || dispP.color,
            lines: dispP.lines
          });
        });

      const rowBgHeight = rowP.height + 6;
      const rowBg = this.add.rectangle(0, y - 3, pMaskWidth, rowBgHeight, 0x000000, 0.35)
        .setOrigin(0, 0)
        .setStrokeStyle(1, 0xffffff, 0.18);

      pList.add(rowBg);
      pList.add(rowP);

      const tBtn = this.add.text(BUTTON_START_X, y, '[T]', { fontSize: '12px', color: '#88ccff' })
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', (p) => {
          if (!this._isPointerWithinArea(p, pArea)) return;
          // remove from character immutably
          const updatedChar = InventorySystem.removeItemFromCharacter(char, item);

          // add to global via system helper
          InventorySystem.addGlobalItem(item);

          // commit back to party
          this._commitChar(updatedChar);
          this.scene.restart();

        });


      if (baseItem.type === 'weapon') {
        const mBtn = this.add.text(BUTTON_START_X + BUTTON_SPACING, y, '[M]', { fontSize: '12px', color: '#88ff88' })
          .setInteractive({ useHandCursor: true })
          .on('pointerdown', (p) => {
            if (!this._isPointerWithinArea(p, pArea)) return;
            const updatedChar = InventorySystem.equipItemFromInventory(char, item, 'weaponMain');
            this._commitChar(updatedChar);
            this.scene.restart();
          });

        const offColor = (baseItem.hands === 2 || mainHandIsTwoHand) ? '#555555' : '#88ff88';
        const oBtn = this.add.text(BUTTON_START_X + BUTTON_SPACING * 2, y, '[O]', { fontSize: '12px', color: offColor });
        if (!(baseItem.hands === 2 || mainHandIsTwoHand)) {
          oBtn.setInteractive({ useHandCursor: true })
            .on('pointerdown', (p) => {
              if (!this._isPointerWithinArea(p, pArea)) return;
              const updatedChar = InventorySystem.equipItemFromInventory(char, item, 'weaponOff');
              this._commitChar(updatedChar);
              this.scene.restart();
            });
        }
        pList.add([tBtn, mBtn, oBtn]);
      } else if (['chest', 'boots', 'gloves', 'head', 'legs', 'ring', 'amulet'].includes(baseItem.slot)) {
        const eqBtn = this.add.text(BUTTON_START_X + BUTTON_SPACING, y, '[Eq]', { fontSize: '12px', color: '#88ff88' })
          .setInteractive({ useHandCursor: true })
          .on('pointerdown', (p) => {
            if (!this._isPointerWithinArea(p, pArea)) return;
            const updatedChar = InventorySystem.equipItemFromInventory(char, item, baseItem.slot);
            this._commitChar(updatedChar);
            this.scene.restart();
          });
        pList.add([tBtn, eqBtn]);
      } else {
        const useBtn = this.add.text(BUTTON_START_X + BUTTON_SPACING, y, '[Use]', { fontSize: '12px', color: '#888888' });
        pList.add([tBtn, useBtn]);
      }

      personalCursorY += rowP.height + 6;
    });

    // fallback when empty so you can see *something*
    if (personalItems.length === 0) {
      const empty = this.add.text(0, 0, '(Empty)', { fontSize: '12px', color: '#777777' });
      pList.add(empty);
      personalCursorY = empty.height;
    }

    const pContentHeight = Math.max(personalCursorY, 0);
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
        .setDepth(contentDepth)
        .setOrigin(0.5);
    });

    let inventoryItems = [...(GameState.inventory || [])];
    inventoryItems = this._filterByCategory(inventoryItems, this.currentGlobalCategory);

    const safeHeightAdj = safeHeight - 240;
    const newWidth = globalListWidth;
    const newX = globalListLeft;
    
    const mask = this.add.graphics().fillRect(0, 0, newWidth, safeHeightAdj);
    const maskShape = mask.createGeometryMask();
    mask.setPosition(newX, gToggleY + 20).setDepth(contentDepth);
    mask.setVisible(false);

    const listContainer = this.add.container(newX, gToggleY + 20).setMask(maskShape).setDepth(contentDepth);

    const gArea = { x: newX, y: gToggleY + 20, w: newWidth, h: safeHeightAdj };

    const spacing = 10;
    const GLOBAL_TEXT_WIDTH = 230;
    let globalCursorY = 0;
    inventoryItems.forEach((item) => {
      const baseItem = Items[item.id] || {};
      const y = globalCursorY;

      const dispG = this._formatItemDisplay(item);
      const rowG = this.add.text(20, y, `• ${dispG.name}`, {
        fontSize: '16px',
        color: dispG.color,
        wordWrap: { width: GLOBAL_TEXT_WIDTH, useAdvancedWrap: true }
      })
        .setInteractive({ useHandCursor: true })
        .on('pointerover', (p) => {
          if (!this._isPointerWithinArea(p, gArea)) return;
          this.tooltip.show(p.worldX, p.worldY, {
            title: dispG.title || dispG.name,
            titleColor: dispG.titleColor || dispG.color,
            lines: dispG.lines
          });
        })
        .on('pointerout', () => this.tooltip.hide())
        .on('pointermove', (p) => {
          if (!this._isPointerWithinArea(p, gArea)) {
            this.tooltip.hide();
            return;
          }
          this.tooltip.show(p.worldX, p.worldY, {
            title: dispG.title || dispG.name,
            titleColor: dispG.titleColor || dispG.color,
            lines: dispG.lines
          });
        })
      const rowBgHeight = rowG.height + 10;
      const rowBg = this.add.rectangle(0, y - 5, newWidth, rowBgHeight, 0x000000, 0.35)
        .setOrigin(0, 0)
        .setStrokeStyle(1, 0xffffff, 0.18);

      listContainer.add(rowBg);
      listContainer.add(rowG);


      const transferBtn = this.add.text(270, y, '[Transfer]', { fontSize: '14px', color: '#88ccff' })
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', (p) => {
          if (!this._isPointerWithinArea(p, gArea)) return;
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
          .on('pointerdown', (p) => {
            if (!this._isPointerWithinArea(p, gArea)) return;
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
            .on('pointerdown', (p) => {
              if (!this._isPointerWithinArea(p, gArea)) return;
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
          .on('pointerdown', (p) => {
            if (!this._isPointerWithinArea(p, gArea)) return;
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

      globalCursorY += rowG.height + spacing;
    });
    if (inventoryItems.length === 0) {
      const empty = this.add.text(20, 0, '(Empty)', { fontSize: '16px', color: '#777777' });
      listContainer.add(empty);
      globalCursorY = empty.height;
    }
    // === GLOBAL: measure content & reset scroll ===
    const gContentHeight = Math.max(globalCursorY, 0);
    const gVisibleHeight = gArea.h;
    // viewport = mask height for global
    listContainer.setPosition(newX, gToggleY + 20);

    // static global scroll hitbox (reuse gArea defined above)


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
      .on('pointerdown', () => this._handleClose()).setDepth(contentDepth);
  }

  _isPointerWithinArea(pointer, area) {
    if (!area) return true;
    const { worldX, worldY } = pointer;
    return worldX >= area.x && worldX <= area.x + area.w && worldY >= area.y && worldY <= area.y + area.h;
  }

  _getEquippedSimpleName(slot, item, fallbackName) {
    if (!item) return 'None';

    const base = this._getBaseItemData(item);
    if (base) {
      if (base.type === 'weapon') {
        if (base.weaponType) {
          return this._formatLabel(base.weaponType);
        }
        if (base.name) return base.name;
      }

      if (base.slot) {
        return this._formatLabel(base.slot);
      }

      if (base.type) {
        return this._formatLabel(base.type);
      }

      if (base.name) {
        return base.name;
      }
    }

    if (isItemInstance(item)) {
      if (item.baseId && Items[item.baseId]?.name) {
        return Items[item.baseId].name;
      }
      if (item.id && Items[item.id]?.name) {
        return Items[item.id].name;
      }
      if (item.name) {
        return item.name;
      }
    }

    if (typeof item === 'string') {
      return this._formatLabel(item);
    }

    if (fallbackName) return fallbackName;

    return this._formatLabel(slot) || 'Unknown';
  }

  _getBaseItemData(item) {
    if (!item) return null;
    if (isItemInstance(item)) {
      return Items[item.id] || null;
    }
    if (typeof item === 'string') {
      return Items[item] || null;
    }
    if (item?.id) {
      return Items[item.id] || null;
    }
    return null;
  }

  _formatLabel(str = '') {
    if (!str) return '';
    return str
      .replace(/_/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/\b\w/g, s => s.toUpperCase())
      .replace(/(\d)([a-z])/gi, (_, num, letter) => `${num}${letter.toUpperCase()}`);
  }

  _handleClose() {
    this.tooltip?.hide();
    this.scene.resume('UIScene');
    this.scene.stop();
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
