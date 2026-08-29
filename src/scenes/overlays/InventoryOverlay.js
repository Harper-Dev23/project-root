import GameState from '../../systems/GameState.js';
import ProgressionManager from '../../systems/ProgressionManager.js';
import { Items } from '../../../data/items.js';
import { isItemInstance, getItemComputedData } from '../../systems/ItemFactory.js';
import InventorySystem from '../../systems/InventorySystem.js';
import { rebuildCharacterStats } from '../../systems/CharacterBuilder.js';
import Tooltip from '../../ui/Tooltip.js';
import { createOverlayFrame } from '../../ui/OverlayFrame.js';
import { SoundManager } from '../../systems/SoundManager.js';
import { CLASS_COLORS, RARITY_COLORS } from '../../ui/styles.js';
import { buildItemTooltipLines } from '../../ui/itemTooltip.js';
import { setupSceneCursor } from '../../ui/cursor.js';


export default class InventoryOverlay extends Phaser.Scene {
  constructor() {
    super({ key: 'InventoryOverlay' });
    this.selectedCharIndex = 0;
    this.currentGlobalCategory = 'all';
    this.currentPersonalCategory = 'all';
    this.currentWeaponType = 'Any';
    this.currentArmorSlot = 'Any';
    this.currentRarity = 'All';
    // Free-text filter. Lives on the instance (like the other filters) rather
    // than in init(), because scene.restart() re-runs init but NOT the
    // constructor — that's how every filter here survives a rebuild.
    this.searchQuery = '';
    this.tooltip = null;
  }

  /**
   * Everything one item can be matched against. Deliberately wider than the
   * visible name so "bone", "severed", "dagger", "head" or "epic" all work
   * without the player knowing which field they're really searching.
   */
  _searchHaystack(inst) {
    const base = Items[inst.id] || {};
    return [
      inst.displayName, base.name, base.type, base.weaponType, base.slot,
      inst.rarity || inst.quality, inst.renownOrigin,
      inst.renownState === 'gaining' ? 'renown' : '',
    ].filter(Boolean).join(' ').toLowerCase();
  }

  // Keep party & characters in sync after any change to a character object
  _commitChar(updatedChar) {
    const id = updatedChar.id;
    const iP = GameState.party.findIndex(c => c.id === id);
    if (iP !== -1) GameState.party[iP] = updatedChar;

    const iC = GameState.characters.findIndex(c => c.id === id);
    if (iC !== -1) GameState.characters[iC] = updatedChar;
  }



  // Build a display object: title, titleColor, and body lines.
  // Delegates to the shared builder (src/ui/itemTooltip.js) so this overlay,
  // StashOverlay, and TownScene all render the exact same tooltip content
  // instead of three independently-maintained (and previously drifted) copies.
  _formatItemDisplay(item) {
    return buildItemTooltipLines(item, { rarityColors: RARITY_COLORS });
  }

  // Shift-to-compare: shows the selected character's currently equipped
  // item in the matching slot as a second tooltip beside the primary one.
  // Weapons always compare against weaponMain (no reliable single "slot"
  // field to pick main vs off from an inventory row) — everything else
  // compares against its own baseItem.slot, same field the [Eq] button uses.
  _updateCompareTooltip(baseItem, item) {
    if (!this._shiftHeld || !this.tooltip?.container?.visible) {
      this.compareTooltip?.hide();
      return;
    }
    const char = GameState.party[this.selectedCharIndex];
    const slot = baseItem?.type === 'weapon' ? 'weaponMain' : baseItem?.slot;
    const equipped = char && slot ? char.equipment[slot] : null;
    if (!isItemInstance(equipped) || equipped === item) {
      this.compareTooltip?.hide();
      return;
    }

    const disp = this._formatItemDisplay(equipped);
    // Seed position doesn't matter — show() only uses it to size/layout the
    // background; the real position is set below, anchored off the primary
    // tooltip's ACTUAL rendered spot (already margin/clamped by its own show()).
    this.compareTooltip.show(0, 0, {
      title: `Equipped: ${disp.title || disp.name}`,
      titleColor: disp.titleColor || disp.color,
      lines: disp.lines
    });

    const primaryX = this.tooltip.container.x;
    const primaryY = this.tooltip.container.y;
    const primaryW = this.tooltip._bgW || 0;
    const compareW = this.compareTooltip._bgW || 0;
    const gap = 8;
    let cx = primaryX + primaryW + gap;
    if (cx + compareW > 1280 - 8) cx = primaryX - compareW - gap;
    this.compareTooltip.container.setPosition(Math.max(8, cx), primaryY);
  }


  create() {
    SoundManager.init(this);
    setupSceneCursor(this);

    // Disable TownScene input so its hover/click zones don't fire through this overlay
    const town = this.scene.get('TownScene');
    if (town?.input) town.input.enabled = false;
    // ensure clean state on every create()
    if (this.tooltip) { this.tooltip.destroy(); this.tooltip = null; }
    if (this.compareTooltip) { this.compareTooltip.destroy(); this.compareTooltip = null; }

    // fresh tooltip (this scene instance owns the display list that will be destroyed on restart)
    this.tooltip = new Tooltip(this);
    this.input.on('pointerdown', () => this.tooltip.hide());

    // Hold-Shift-to-compare: a second Tooltip instance, shown beside the
    // primary one, rendering the selected character's currently EQUIPPED
    // item in the matching slot. _hoveredCompareItem tracks whatever's
    // under the cursor right now so a Shift press mid-hover (no mouse
    // movement) still shows it immediately, not just on the next pointermove.
    this.compareTooltip = new Tooltip(this);
    this._shiftHeld = false;
    this._hoveredCompareItem = null;
    this.input.keyboard.on('keydown-SHIFT', () => {
      this._shiftHeld = true;
      if (this._hoveredCompareItem) {
        this._updateCompareTooltip(this._hoveredCompareItem.baseItem, this._hoveredCompareItem.item);
      }
    });
    this.input.keyboard.on('keyup-SHIFT', () => {
      this._shiftHeld = false;
      this.compareTooltip?.hide();
    });

    // remove any leftover wheel handler from a previous run
    if (this._onWheel) this.input.off('wheel', this._onWheel, this);

    const frame = createOverlayFrame(this, {
      title: 'Inventory',
      fullscreen: true,
      onClose: () => this._handleClose(),
    });

    const safeWidth = frame.bounds.width;
    const safeHeight = frame.bounds.height;
    const contentDepth = frame.depth;

    // Currency strip — top-right corner of the overlay.
    // Reminds the player of spendable tickets without leaving the inventory screen.
    this.add.text(
      frame.bounds.x + frame.bounds.width - 16,
      frame.bounds.y + 14,
      `🎟 Hunt Tickets: ${ProgressionManager.huntTickets}   🏷 Tribe Tickets: ${ProgressionManager.tribeTickets}`,
      { fontSize: '13px', color: '#ffddaa' }
    ).setOrigin(1, 0).setDepth(contentDepth + 1);

    // Personal (equipped-gear) column stays a fixed ~223px wide starting at
    // pMaskX (192, see below) — it's a bounded item list, not something that
    // should stretch across the whole screen. The global list starts right
    // after it and stretches to fill whatever's left of the now-full-screen
    // panel, down to a 40px right margin.
    //
    // Was `globalListWidth = (safeWidth - 100) - 150` / `globalListLeft =
    // (180 + 100) + (safeWidth - 100) - globalListWidth` — that formula
    // algebraically cancels safeWidth out to a hardcoded constant (430)
    // regardless of the actual panel width, which produced a huge dead gap
    // on the left once the overlay went full-screen.
    const globalListLeft = 192 + 223 + 15;
    const globalListWidth = Math.max(200, (frame.bounds.x + safeWidth) - globalListLeft - 40);


    // Clamp selectedCharIndex in case party shrank
    if (this.selectedCharIndex >= GameState.party.length) this.selectedCharIndex = 0;

    // Pre-declare variables used both inside the party guard and in later sections
    let char = null, mainHandIsTwoHand = false;
    let pArea = null, pList = null, pMaskY = 0, pMaskHeight = 0, pContentHeight = 0, pVisibleHeight = 0;

    // CHARACTER SELECTOR — tinted by class color
    if (GameState.party.length === 0) {
      // No active party — show placeholder, skip all character-dependent UI
      this.add.text(
        frame.bounds.x + (frame.bounds.width * 0.25),
        frame.bounds.y + frame.bounds.height * 0.5 - 20,
        'No active party members.\nAdd hunters via the Camp roster in your tribe lodge.',
        { fontSize: '15px', color: '#666666', align: 'center', wordWrap: { width: 260 } }
      ).setOrigin(0.5).setDepth(contentDepth);
    } else {

    const _dimHex = (hex) => {
      // Halve each channel for unselected dimming
      const c = hex.replace('#', '');
      const r = Math.floor(parseInt(c.substring(0,2),16) * 0.5).toString(16).padStart(2,'0');
      const g = Math.floor(parseInt(c.substring(2,4),16) * 0.5).toString(16).padStart(2,'0');
      const b = Math.floor(parseInt(c.substring(4,6),16) * 0.5).toString(16).padStart(2,'0');
      return `#${r}${g}${b}`;
    };
    GameState.party.forEach((char, i) => {
      const isSelected = (i === this.selectedCharIndex);
      const classColor = CLASS_COLORS[char.baseClass] || '#cccccc';
      const textColor = isSelected ? classColor : _dimHex(classColor);
      const tabX = 200 + i * 120;
      // Underline bar for selected tab
      if (isSelected) {
        const hexNum = parseInt(classColor.replace('#',''), 16);
        this.add.rectangle(tabX + 36, 116, 64, 3, hexNum)
          .setOrigin(0.5, 0).setDepth(contentDepth);
      }
      this.add.text(tabX, 100, char.name, {
        fontSize: '18px',
        color: textColor,
        fontStyle: isSelected ? 'bold' : 'normal',
      }).setInteractive({ useHandCursor: true })
        .on('pointerdown', () => { SoundManager.play('select'); this.selectedCharIndex = i; this.scene.restart(); })
        .setDepth(contentDepth);
    });

    char = GameState.party[this.selectedCharIndex];
    const mainHandItem = char.equipment.weaponMain;
    mainHandIsTwoHand = mainHandItem && Items[isItemInstance(mainHandItem) ? mainHandItem.id : mainHandItem]?.hands === 2;

    // EQUIPPED GEAR
    let equipY = 140;

    // Selected character's portrait, beside (left of) the Equipped section —
    // same portraitKey/fallback convention as CharacterListOverlay.
    const PORTRAIT_BOX = 72;
    const portraitX = 120, portraitY = equipY;
    const portraitKey = char.skin || `${(char.race || 'Human').toLowerCase()}_portrait_1`;
    const availablePortraitKey = this.textures.exists(portraitKey)
      ? portraitKey
      : (this.textures.exists('dummy_portrait') ? 'dummy_portrait' : null);
    this.add.rectangle(portraitX + PORTRAIT_BOX / 2, portraitY + PORTRAIT_BOX / 2, PORTRAIT_BOX, PORTRAIT_BOX, 0x000000, 0.35)
      .setStrokeStyle(1, 0x6a7080).setDepth(contentDepth);
    if (availablePortraitKey) {
      const portrait = this.add.image(portraitX + PORTRAIT_BOX / 2, portraitY + PORTRAIT_BOX / 2, availablePortraitKey)
        .setDepth(contentDepth);
      const scale = Math.min((PORTRAIT_BOX - 6) / portrait.width, (PORTRAIT_BOX - 6) / portrait.height);
      portrait.setScale(scale);
    }

    this.add.text(200, equipY, 'Equipped:', { fontSize: '18px', color: '#ffffff' }).setDepth(contentDepth);
    equipY += 20;

    const EQUIPPED_TEXT_WIDTH = 160;
    // Canonical display order rather than Object.keys(): the equipment object
    // is built in several places (creation, save load, enemy setup) and any of
    // them reordering its keys would silently reshuffle this panel. Any slot
    // not in the list still renders, appended at the end, so a future slot
    // can't vanish just because nobody updated this array.
    const SLOT_ORDER = ['weaponMain', 'weaponOff', 'head', 'chest', 'legs', 'gloves', 'boots', 'ring', 'amulet'];
    const slotKeys = [
      ...SLOT_ORDER.filter(k => k in char.equipment),
      ...Object.keys(char.equipment).filter(k => !SLOT_ORDER.includes(k)),
    ];
    slotKeys.forEach(slot => {
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
            SoundManager.play('dullClick');
            const updatedChar = InventorySystem.unequipItemFromSlot(char, slot);
            this._commitChar(updatedChar);
            this.scene.restart();
          })

          .setDepth(contentDepth);
      }

      equipY += Math.max(nameTxt.height, 16) + 4;
    });

    // Outline box around the Equipped section
    const equipBoxGfx = this.add.graphics().setDepth(contentDepth - 1);
    equipBoxGfx.lineStyle(2, 0xa08060, 0.9);
    equipBoxGfx.strokeRect(190, 134, 218, equipY - 128);

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

    const pMaskX = 192;
    pMaskY = equipY;
    const pMaskWidth = globalListLeft - pMaskX - 15;
    pMaskHeight = Math.max(150, (safeHeight - 60) - pMaskY);

    // geometry for mask (not added to display list)
    const pMaskGfx = this.make.graphics({ x: pMaskX, y: pMaskY, add: false });
    pMaskGfx.fillStyle(0xffffff, 1);
    pMaskGfx.fillRect(0, 0, pMaskWidth, pMaskHeight);
    const pMaskShape = new Phaser.Display.Masks.GeometryMask(this, pMaskGfx);

    // list container, positioned exactly at mask origin
    pList = this.add.container(pMaskX, pMaskY).setDepth(contentDepth).setMask(pMaskShape);

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
          this._hoveredCompareItem = { baseItem, item };
          this._updateCompareTooltip(baseItem, item);
        })
        .on('pointerout', () => {
          this.tooltip.hide();
          this._hoveredCompareItem = null;
          this.compareTooltip?.hide();
        })
        .on('pointermove', (p) => {
          if (!this._isPointerWithinArea(p, pArea)) {
            this.tooltip.hide();
            this._hoveredCompareItem = null;
            this.compareTooltip?.hide();
            return;
          }
          this.tooltip.show(p.worldX, p.worldY, {
            title: dispP.title || dispP.name,
            titleColor: dispP.titleColor || dispP.color,
            lines: dispP.lines
          });
          this._hoveredCompareItem = { baseItem, item };
          this._updateCompareTooltip(baseItem, item);
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
          SoundManager.play('dullClick');
          const updatedChar = InventorySystem.removeItemFromCharacter(char, item);
          InventorySystem.addGlobalItem(item);
          this._commitChar(updatedChar);
          this.scene.restart();
        });

      if (baseItem.type === 'weapon') {
        const mBtn = this.add.text(BUTTON_START_X + BUTTON_SPACING, y, '[M]', { fontSize: '12px', color: '#88ff88' })
          .setInteractive({ useHandCursor: true })
          .on('pointerdown', (p) => {
            if (!this._isPointerWithinArea(p, pArea)) return;
            SoundManager.play('dullClick');
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
              SoundManager.play('dullClick');
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
            SoundManager.play('dullClick');
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

    pContentHeight = Math.max(personalCursorY, 0);
    pVisibleHeight = pMaskHeight;
    // anchor the list to the mask origin (don't move it to 0)
    pList.setPosition(pMaskX, pMaskY);

    // define personal area rect for scrolling (no Graphics object needed)
    pArea = { x: pMaskX, y: pMaskY, w: pMaskWidth, h: pVisibleHeight };

    } // end party.length > 0 guard

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
        .on('pointerdown', () => {
          this.currentGlobalCategory = cat.key;
          this.currentWeaponType = 'Any';
          this.currentArmorSlot = 'Any';
          this.scene.restart();
        })
        .setDepth(contentDepth)
        .setOrigin(0.5);
    });

    // Subtype + rarity cyclers (right side of global header row)
    const WEAPON_TYPES = ['Any', 'axe_2h', 'bow', 'dagger', 'gun', 'mace_2h', 'shield', 'sling', 'spear_1h', 'staff', 'sword_1h', 'sword_2h', 'wand', 'whip'];
    const ARMOR_SLOTS = ['Any', 'boots', 'chest', 'gloves', 'head', 'legs', 'ring', 'amulet'];
    const RARITIES = ['All', 'common', 'uncommon', 'rare', 'epic'];
    const cyclerCX = frame.bounds.x + frame.bounds.width - 110;

    const makeCycler = (cx, cy, prefixLabel, value, list, setter) => {
      const idx = list.indexOf(value);
      const prevVal = list[(idx - 1 + list.length) % list.length];
      const nextVal = list[(idx + 1) % list.length];
      this.add.text(cx - 68, cy, prefixLabel, { fontSize: '11px', color: '#999999' })
        .setOrigin(0, 0).setDepth(contentDepth);
      this.add.text(cx - 32, cy, '◀', { fontSize: '13px', color: '#aaaaaa' })
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', () => { SoundManager.play('select'); setter(prevVal); this.scene.restart(); })
        .setDepth(contentDepth);
      this.add.text(cx, cy, this._formatLabel(value), { fontSize: '12px', color: '#ffff88' })
        .setOrigin(0.5, 0).setDepth(contentDepth);
      this.add.text(cx + 32, cy, '▶', { fontSize: '13px', color: '#aaaaaa' })
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', () => { SoundManager.play('select'); setter(nextVal); this.scene.restart(); })
        .setDepth(contentDepth);
    };

    if (this.currentGlobalCategory === 'weapon') {
      makeCycler(cyclerCX, gToggleY, 'Type:', this.currentWeaponType, WEAPON_TYPES, v => { this.currentWeaponType = v; });
    } else if (this.currentGlobalCategory === 'armor') {
      makeCycler(cyclerCX, gToggleY, 'Slot:', this.currentArmorSlot, ARMOR_SLOTS, v => { this.currentArmorSlot = v; });
    } else {
      this.add.text(cyclerCX, gToggleY, 'Subtype: —', { fontSize: '11px', color: '#444444' })
        .setOrigin(0.5, 0).setDepth(contentDepth);
    }
    makeCycler(cyclerCX, gToggleY + 22, 'Rarity:', this.currentRarity, RARITIES, v => { this.currentRarity = v; });

    // ---- Search bar --------------------------------------------------------
    // Sits on the left of the second header row, opposite the Rarity cycler.
    // Always listening while the overlay is open — there is no focus state to
    // manage, and the only other key this scene binds is SHIFT (compare
    // tooltip). ESC is left alone: OverlayFrame uses it to close, and
    // hijacking it to clear the box would be a surprise.
    this._buildSearchBar(globalListLeft, gToggleY + 18, 330, contentDepth);

    const listStartY = gToggleY + 44;

    let inventoryItems = [...(GameState.inventory || [])];
    inventoryItems = this._applyGlobalFilters(inventoryItems);

    const safeHeightAdj = safeHeight - 264;
    const newWidth = globalListWidth;
    const newX = globalListLeft;

    const mask = this.add.graphics().fillRect(0, 0, newWidth, safeHeightAdj);
    const maskShape = mask.createGeometryMask();
    mask.setPosition(newX, listStartY).setDepth(contentDepth);
    mask.setVisible(false);

    const listContainer = this.add.container(newX, listStartY).setMask(maskShape).setDepth(contentDepth);

    // Outline box around the entire global inventory section (tabs + list)
    const gBoxGfx = this.add.graphics().setDepth(contentDepth - 1);
    gBoxGfx.lineStyle(2, 0xa08060, 0.9);
    gBoxGfx.strokeRect(newX - 4, gToggleY - 10, newWidth + 8, (listStartY - gToggleY) + safeHeightAdj + 14);

    const gArea = { x: newX, y: listStartY, w: newWidth, h: safeHeightAdj };

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
          this._hoveredCompareItem = { baseItem, item };
          this._updateCompareTooltip(baseItem, item);
        })
        .on('pointerout', () => {
          this.tooltip.hide();
          this._hoveredCompareItem = null;
          this.compareTooltip?.hide();
        })
        .on('pointermove', (p) => {
          if (!this._isPointerWithinArea(p, gArea)) {
            this.tooltip.hide();
            this._hoveredCompareItem = null;
            this.compareTooltip?.hide();
            return;
          }
          this.tooltip.show(p.worldX, p.worldY, {
            title: dispG.title || dispG.name,
            titleColor: dispG.titleColor || dispG.color,
            lines: dispG.lines
          });
          this._hoveredCompareItem = { baseItem, item };
          this._updateCompareTooltip(baseItem, item);
        })
      const rowBgHeight = rowG.height + 10;
      const rowBg = this.add.rectangle(0, y - 5, newWidth, rowBgHeight, 0x000000, 0.35)
        .setOrigin(0, 0)
        .setStrokeStyle(1, 0xffffff, 0.18);

      listContainer.add(rowBg);
      listContainer.add(rowG);

      // [✦ Inspect] used to live inside the `baseItem.locked` branch below,
      // which was fine when the only renown item was the Bloodthirster (locked
      // AND historic). Renown now comes from drop condition, so ordinary
      // unlocked gear can carry it - a Bone weapon got no button at all. Placed
      // at x=570, clear of the widest row's [Off] at 500(w43).
      if (item.historic || item.renownState === 'gaining') {
        const inspectBtn = this.add.text(570, y, '[✦ Inspect]', { fontSize: '13px', color: '#d4a017' })
          .setInteractive({ useHandCursor: true })
          .on('pointerover', () => inspectBtn.setStyle({ color: '#ffe066' }))
          .on('pointerout', () => inspectBtn.setStyle({ color: '#d4a017' }))
          .on('pointerdown', (p) => {
            if (!this._isPointerWithinArea(p, gArea)) return;
            SoundManager.play('select');
            this._openInspectModal(item);
          });
        listContainer.add(inspectBtn);
      }


      if (baseItem.locked) {
        // Locked items cannot be moved or transferred — show lock badge and optional Use button.
        const lockLabel = this.add.text(270, y, '[Locked]', { fontSize: '13px', color: '#555577' });
        if (baseItem.onUse === 'waystone_shard_menu') {
          const useBtn = this.add.text(360, y, '[Use]', { fontSize: '14px', color: '#aaccff' })
            .setInteractive({ useHandCursor: true })
            .on('pointerover', () => useBtn.setStyle({ color: '#ccddff' }))
            .on('pointerout',  () => useBtn.setStyle({ color: '#aaccff' }))
            .on('pointerdown', (p) => {
              if (!this._isPointerWithinArea(p, gArea)) return;
              SoundManager.play('select');
              if (!this.scene.isActive('WaystoneShardOverlay')) {
                this.scene.launch('WaystoneShardOverlay');
              }
              this.scene.bringToTop('WaystoneShardOverlay');
            });
          listContainer.add([lockLabel, useBtn]);
        } else {
          listContainer.add(lockLabel);
        }
      } else if (char) {
        const transferBtn = this.add.text(270, y, '[Transfer]', { fontSize: '14px', color: '#88ccff' })
          .setInteractive({ useHandCursor: true })
          .on('pointerdown', (p) => {
            if (!this._isPointerWithinArea(p, gArea)) return;
            SoundManager.play('dullClick');
            InventorySystem.removeGlobalItem(item);
            const updatedChar = InventorySystem.addItemToCharacter(char, item);
            this._commitChar(updatedChar);
            this.scene.restart();
          });

        if (baseItem.type === 'weapon') {
          const mBtn = this.add.text(420, y, '[Main]', { fontSize: '14px', color: '#88ff88' })
            .setInteractive({ useHandCursor: true })
            .on('pointerdown', (p) => {
              if (!this._isPointerWithinArea(p, gArea)) return;
              SoundManager.play('dullClick');
              InventorySystem.removeGlobalItem(item);
              let updatedChar = InventorySystem.addItemToCharacter(char, item);
              updatedChar = InventorySystem.equipItemFromInventory(updatedChar, item, 'weaponMain');
              this._commitChar(updatedChar);
              this.scene.restart();
            });

          const offColor = (baseItem.hands === 2 || mainHandIsTwoHand) ? '#555555' : '#88ff88';
          const oBtn = this.add.text(500, y, '[Off]', { fontSize: '14px', color: offColor });
          if (!(baseItem.hands === 2 || mainHandIsTwoHand)) {
            oBtn.setInteractive({ useHandCursor: true })
              .on('pointerdown', (p) => {
                if (!this._isPointerWithinArea(p, gArea)) return;
                SoundManager.play('dullClick');
                InventorySystem.removeGlobalItem(item);
                let updatedChar = InventorySystem.addItemToCharacter(char, item);
                updatedChar = InventorySystem.equipItemFromInventory(updatedChar, item, 'weaponOff');
                this._commitChar(updatedChar);
                this.scene.restart();
              });
          }
          listContainer.add([transferBtn, mBtn, oBtn]);
        } else if (['chest', 'boots', 'gloves', 'head', 'legs', 'ring', 'amulet'].includes(baseItem.slot)) {
          const eqBtn = this.add.text(420, y, '[Eq]', { fontSize: '14px', color: '#88ff88' })
            .setInteractive({ useHandCursor: true })
            .on('pointerdown', (p) => {
              if (!this._isPointerWithinArea(p, gArea)) return;
              SoundManager.play('dullClick');
              InventorySystem.removeGlobalItem(item);
              let updatedChar = InventorySystem.addItemToCharacter(char, item);
              updatedChar = InventorySystem.equipItemFromInventory(updatedChar, item, baseItem.slot);
              this._commitChar(updatedChar);
              this.scene.restart();
            });

          listContainer.add([transferBtn, eqBtn]);
        } else if (baseItem.onUse === 'respec_stats') {
          // TESTING ITEM (Tonic of Reflection). This whole branch and the item
          // definition are the only support it needs - remove both and nothing
          // else changes.
          const useBtn = this.add.text(420, y, '[Use]', { fontSize: '14px', color: '#ffcc88' })
            .setInteractive({ useHandCursor: true })
            .on('pointerover', () => useBtn.setStyle({ color: '#ffe4b3' }))
            .on('pointerout', () => useBtn.setStyle({ color: '#ffcc88' }))
            .on('pointerdown', (p) => {
              if (!this._isPointerWithinArea(p, gArea)) return;
              SoundManager.play('select');
              this._respecCharacter(char, item);
            });
          listContainer.add([transferBtn, useBtn]);
        } else {
          const useBtn = this.add.text(420, y, '[Use]', { fontSize: '14px', color: '#888888' });
          listContainer.add([transferBtn, useBtn]);
        }
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
    listContainer.setPosition(newX, listStartY);

    // static global scroll hitbox (reuse gArea defined above)


    // === Wheel handler (one instance) ===
    // remove any old wheel listener before adding new
    if (this._onWheel) this.input.off('wheel', this._onWheel, this);

    // Helper: disable interaction on list children that are outside their mask window.
    // Geometry masks clip rendering but NOT pointer events — this prevents scrolled-off
    // invisible items from stealing clicks meant for UI above/below the list.
    const _syncInteractivity = (container, maskTopY, maskBotY) => {
      container.list.forEach(child => {
        if (!child || !child.input) return; // never made interactive — skip
        const isContainer = child.type === 'Container';
        const h = child.height || 16;
        const worldTop = container.y + child.y - (isContainer ? h / 2 : 0);
        const worldBot = worldTop + h;
        const inView = worldBot > maskTopY && worldTop < maskBotY;
        if (inView) {
          child.setInteractive({ useHandCursor: true });
        } else {
          child.disableInteractive();
        }
      });
    };

    this._onWheel = (pointer, gameObjects, deltaX, deltaY) => {
      const mx = pointer.worldX;
      const my = pointer.worldY;

      // --- GLOBAL SCROLL ---
      if (mx >= gArea.x && mx <= gArea.x + gArea.w && my >= gArea.y && my <= gArea.y + gArea.h) {
        if (gContentHeight > gVisibleHeight) {
          const baseYg = listStartY;
          const maxScroll = gContentHeight - gVisibleHeight;
          const next = listContainer.y - deltaY * 0.25;
          listContainer.y = Phaser.Math.Clamp(next, baseYg - maxScroll, baseYg);
        } else {
          listContainer.y = listStartY;
        }
        _syncInteractivity(listContainer, listStartY, listStartY + gVisibleHeight);
      }

      // PERSONAL scroll/clamp (only when a party member is selected)
      if (pArea && pList && mx >= pArea.x && mx <= pArea.x + pArea.w && my >= pArea.y && my <= pArea.y + pArea.h) {
        if (pContentHeight > pVisibleHeight) {
          const baseY = pMaskY;
          const maxScroll = pContentHeight - pVisibleHeight;
          const next = pList.y - deltaY * 0.25;
          pList.y = Phaser.Math.Clamp(next, baseY - maxScroll, baseY);
        } else {
          pList.y = pMaskY;
        }
        _syncInteractivity(pList, pMaskY, pMaskY + pMaskHeight);
      }

    };

    this.input.on('wheel', this._onWheel, this);

    // cleanup when scene shuts down (prevents stacking on restart)
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      if (this._onWheel) this.input.off('wheel', this._onWheel, this);
      this._onWheel = null;
    });
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

      // Armour and jewellery: the slot label is already printed to the left of
      // this value, so falling through to _formatLabel(base.slot) rendered
      // "Head: Head". Base names here are short (16 chars at worst), so show
      // the real one; the affixed name still lives in the tooltip.
      if (base.name) {
        return base.name;
      }

      if (base.slot) {
        return this._formatLabel(base.slot);
      }

      if (base.type) {
        return this._formatLabel(base.type);
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
    const town = this.scene.get('TownScene');
    if (town?.input) town.input.enabled = true;
    this.scene.resume('UIScene');
    this.scene.stop();
  }

  /**
   * Draws the search field and wires the keyboard.
   *
   * The list is rebuilt via scene.restart() — the same thing every other
   * filter does — but debounced, because restarting per keystroke rebuilds the
   * entire overlay and flickers. The query Text is updated immediately so
   * typing still feels instant; only the filtering waits for the pause.
   */
  _buildSearchBar(x, y, width, depth) {
    const H = 20;
    // Deliberately NOT interactive: there is no focus state to grant, and an
    // interactive rect with no handler would just swallow clicks landing on it.
    const bg = this.add.rectangle(x, y, width, H, 0x000000, 0.35)
      .setOrigin(0, 0).setDepth(depth)
      .setStrokeStyle(1, this.searchQuery ? 0xffff88 : 0x666666, 0.9);

    this.add.text(x + 6, y + 3, 'Search:', { fontSize: '11px', color: '#999999' })
      .setOrigin(0, 0).setDepth(depth + 1);

    const queryText = this.add.text(x + 58, y + 3, this.searchQuery || 'type to filter…', {
      fontSize: '12px',
      color: this.searchQuery ? '#ffff88' : '#5a5a5a',
      fontStyle: this.searchQuery ? 'normal' : 'italic',
    }).setOrigin(0, 0).setDepth(depth + 1);

    if (this.searchQuery) {
      const clear = this.add.text(x + width - 16, y + 3, '✕', { fontSize: '12px', color: '#cc7777' })
        .setOrigin(0, 0).setDepth(depth + 1)
        .setInteractive({ useHandCursor: true })
        .on('pointerover', () => clear.setColor('#ff9999'))
        .on('pointerout', () => clear.setColor('#cc7777'))
        .on('pointerdown', () => {
          SoundManager.play('select');
          this.searchQuery = '';
          this.scene.restart();
        });
    }

    // Live result count — the fastest way to tell a typo from an empty result.
    const total = (GameState.inventory || []).length;
    const shown = this._applyGlobalFilters([...(GameState.inventory || [])]).length;
    if (this.searchQuery) {
      this.add.text(x + width + 10, y + 3, `${shown} / ${total}`, {
        fontSize: '11px', color: shown ? '#88cc88' : '#cc7777'
      }).setOrigin(0, 0).setDepth(depth + 1);
    }

    const onKey = (ev) => {
      const k = ev.key;
      if (k === 'Backspace') {
        if (!this.searchQuery) return;
        this.searchQuery = this.searchQuery.slice(0, -1);
      } else if (k && k.length === 1 && /[\w \-'’]/.test(k)) {
        if (this.searchQuery.length >= 32) return;
        this.searchQuery += k;
      } else {
        return;   // ignore ESC, arrows, Shift, F-keys, etc.
      }
      ev.preventDefault?.();
      // instant visual feedback, deferred filtering
      queryText.setText(this.searchQuery || 'type to filter…')
        .setColor(this.searchQuery ? '#ffff88' : '#5a5a5a')
        .setStyle({ fontStyle: this.searchQuery ? 'normal' : 'italic' });
      bg.setStrokeStyle(1, this.searchQuery ? 0xffff88 : 0x666666, 0.9);
      if (this._searchTimer) this._searchTimer.remove(false);
      this._searchTimer = this.time.delayedCall(220, () => {
        this._searchTimer = null;
        this.scene.restart();
      });
    };

    this.input.keyboard?.on('keydown', onKey);
    this.events.once('shutdown', () => {
      this.input.keyboard?.off('keydown', onKey);
      if (this._searchTimer) { this._searchTimer.remove(false); this._searchTimer = null; }
    });
  }

  /**
   * TESTING ITEM: Tonic of Reflection.
   *
   * Restores baseStats to the snapshot taken at character creation and hands
   * back every stat point earned since (5 per level, see applyLevelUp), then
   * rebuilds derived stats. Consumes one copy.
   *
   * Refuses on characters created before `creationStats` existed rather than
   * guessing a baseline - a wrong guess would silently corrupt their stats.
   */
  _respecCharacter(char, item) {
    if (!char) return;
    if (!char.creationStats) {
      console.warn('[Respec] no creationStats on', char.name, '- character predates the tonic; refusing.');
      return;
    }
    const level = Math.max(1, char.level || 1);
    char.baseStats = { ...char.creationStats };
    char.unspentStatPoints = 5 * (level - 1);
    rebuildCharacterStats(char);
    char.currentHP = Math.min(char.currentHP, char.maxHP);
    char.currentMP = Math.min(char.currentMP, char.maxMP);
    InventorySystem.removeGlobalItem(item);
    this._commitChar(char);
    GameState.save('autosave');
    this.scene.restart();
  }
  _applyGlobalFilters(items) {
    let result = this._filterByCategory(items, this.currentGlobalCategory);

    if (this.currentGlobalCategory === 'weapon' && this.currentWeaponType !== 'Any') {
      result = result.filter(it => Items[it.id]?.weaponType === this.currentWeaponType);
    } else if (this.currentGlobalCategory === 'armor' && this.currentArmorSlot !== 'Any') {
      result = result.filter(it => Items[it.id]?.slot === this.currentArmorSlot);
    }

    if (this.currentRarity !== 'All') {
      result = result.filter(it => (it.rarity || it.quality || 'common') === this.currentRarity);
    }

    // Free-text search, applied last so it narrows whatever the tabs/cyclers
    // already selected. Space-separated terms are ANDed, so "bone axe" finds
    // only bone axes rather than everything matching either word.
    const q = (this.searchQuery || '').trim().toLowerCase();
    if (q) {
      const terms = q.split(/\s+/);
      result = result.filter(it => {
        const hay = this._searchHaystack(it);
        return terms.every(t => hay.includes(t));
      });
    }

    return result;
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

  _openInspectModal(item) {
    if (this._inspectModal) {
      this._inspectModal.destroy(true);
      this._inspectModal = null;
    }

    const W = this.scale.width;
    const H = this.scale.height;
    const pw = 460;
    const ph = 390;
    const px = (W - pw) / 2;
    const py = (H - ph) / 2;
    const depth = 2150; // above overlay frame (MENU=2000, MODAL_PANEL=2100) but below tooltip (2200)

    const container = this.add.container(0, 0).setDepth(depth);
    this._inspectModal = container;

    // Dim background
    const dim = this.add.rectangle(0, 0, W, H, 0x000000, 0.65).setOrigin(0, 0);
    container.add(dim);

    // Panel background
    const panel = this.add.graphics();
    panel.fillStyle(0x0d0d0d, 0.97);
    panel.fillRoundedRect(px, py, pw, ph, 8);
    panel.lineStyle(2, 0xd4a017, 1);
    panel.strokeRoundedRect(px, py, pw, ph, 8);
    container.add(panel);

    const base = Items[item.id] || {};
    const isHistoric = item.historic || base.historic;
    const isGaining = item.renownState === 'gaining';
    const explained = ProgressionManager.hasQuestFlag('bloodthirster_elder_explained');

    const titleColor = isHistoric ? '#d4a017' : '#ccaa44';
    const title = this.add.text(px + pw / 2, py + 18, `✦ ${base.name || item.id}`, {
      fontSize: '16px', color: titleColor, fontStyle: 'bold'
    }).setOrigin(0.5, 0);
    container.add(title);

    // Divider
    const divGfx = this.add.graphics();
    divGfx.lineStyle(1, 0x5a4a3a, 0.8);
    divGfx.lineBetween(px + 16, py + 44, px + pw - 16, py + 44);
    container.add(divGfx);

    let bodyLines = [];

    if (isHistoric && !explained) {
      // Pre-explanation: blurred flavor text
      bodyLines = [
        'You hold the blade steady, but something resists',
        'your understanding of it.',
        '',
        'There is a weight in the metal that goes beyond',
        'its size — a memory it will not yet share.',
        '',
        'Perhaps someone who studies such things',
        'could shed light on what this weapon holds.',
        '',
        '— Visit the Elders\' Tower —',
      ];

      // Set the elder visit flag and trigger quest flag rebuild
      if (!ProgressionManager.hasQuestFlag('bloodthirster_elder_visit')) {
        ProgressionManager.setQuestFlag('bloodthirster_elder_visit');
        const town = this.scene.get('TownScene');
        town?._buildQuestFlags?.();
        this.scene.get('UIScene')?.refreshUI?.();
      }

    } else if (isHistoric && explained) {
      // Post-explanation: full history
      const kills = item.history?.kills ?? 0;
      const dmg = item.history?.damageDealt ?? 0;
      const battles = item.history?.battlesCarried ?? 0;
      const droppedFrom = item.history?.droppedFrom ?? 'Unknown';
      const droppedScenario = item.history?.droppedScenario ?? 'Unknown';

      const droppedLabel = droppedFrom === 'berserker_boss'
        ? 'Zafaar Berserker (Boss)'
        : droppedFrom;
      const scenarioLabel = droppedScenario === 'training_encounter_6'
        ? 'Combat Pit — Encounter VI'
        : droppedScenario;

      const lacerate  = item.questProgress?.lacerateBuildupDealt ?? 0;
      const innocent  = item.questProgress?.innocentBloodDrunk   ?? 0;
      const hunts     = item.questProgress?.huntsCompleted        ?? 0;

      bodyLines = [
        `Origin:       ${droppedLabel}`,
        `Encounter:    ${scenarioLabel}`,
        '',
        `Kills:        ${kills}`,
        `Damage Dealt: ${dmg.toLocaleString()}`,
        `Battles:      ${battles}`,
        '',
        item.soulbound ? '✦ Soulbound — will not be lost on party wipe' : null,
        item.lifeStealPct ? `✦ ${Math.round((item.lifeStealPct || base.lifeStealPct || 0) * 100)}% Lifesteal` : null,
        '',
        '— Weapon Quest —',
        `Lacerate Buildup:   ${lacerate.toLocaleString()} / 5,000`,
        `Innocent Blood:     ${innocent} / 100`,
        `Complete a Hunt:    ${hunts} / 1`,
      ].filter(l => l !== null);

      if (!ProgressionManager.hasQuestFlag('bloodthirster_inspect_2')) {
        ProgressionManager.setQuestFlag('bloodthirster_inspect_2');
        const town = this.scene.get('TownScene');
        town?._buildQuestFlags?.();
        this.scene.get('UIScene')?.refreshUI?.();
      }

    } else if (isGaining) {
      // Renown-gaining item
      const renown = item.renown || 0;
      const renownMax = item.renownMax || 1000;
      const pct = Math.round((renown / renownMax) * 100);
      const kills = item.history?.kills ?? 0;
      const dmg = item.history?.damageDealt ?? 0;

      bodyLines = [
        '◆ Potentially Historic',
        '',
        `Renown: ${renown} / ${renownMax}  (${pct}%)`,
        '',
        `Kills recorded:  ${kills}`,
        `Damage recorded: ${dmg.toLocaleString()}`,
        '',
        'Use this item in combat to build Renown.',
        'Something may awaken within it in time.',
      ];
    }

    const bodyY = py + 56;
    bodyLines.forEach((line, i) => {
      const lineColor = line.startsWith('✦') ? '#d4a017'
        : line.startsWith('◆') ? '#ccaa44'
        : line.startsWith('—') ? '#aaaaaa'
        : '#dddddd';
      const txt = this.add.text(px + 20, bodyY + i * 20, line, {
        fontSize: '13px', color: lineColor
      });
      container.add(txt);
    });

    // Close button
    const closeY = py + ph - 36;
    const closeBtn = this.add.text(px + pw / 2, closeY, '[ Close ]', {
      fontSize: '14px', color: '#aaaaaa'
    }).setOrigin(0.5, 0).setInteractive({ useHandCursor: true });

    closeBtn.on('pointerover', () => closeBtn.setColor('#ffffff'));
    closeBtn.on('pointerout', () => closeBtn.setColor('#aaaaaa'));
    closeBtn.on('pointerdown', () => {
      SoundManager.play('select');
      container.destroy(true);
      this._inspectModal = null;
    });

    // Renown-capable items get a way into the renown web. Display-only for
    // now — see RenownTreeOverlay. Historic items without an origin (the
    // Bloodthirster) don't get one, since they have no entry point in the web.
    if (item?.renownOrigin) {
      const treeBtn = this.add.text(px + pw / 2, closeY - 30, '[ View Renown Web ]', {
        fontSize: '14px', color: '#d4a017'
      }).setOrigin(0.5, 0).setInteractive({ useHandCursor: true });
      treeBtn.on('pointerover', () => treeBtn.setColor('#ffe066'));
      treeBtn.on('pointerout', () => treeBtn.setColor('#d4a017'));
      treeBtn.on('pointerdown', () => {
        SoundManager.play('select');
        container.destroy(true);
        this._inspectModal = null;
        if (this.scene.isActive('RenownTreeOverlay')) this.scene.stop('RenownTreeOverlay');
        this.scene.launch('RenownTreeOverlay', { item });
        // Without this the web starts BEHIND the inventory, so you'd have to
        // close the inventory to see it. Same pattern TownScene uses for the
        // Waystone overlay. The inventory stays open underneath, so closing
        // the web drops you straight back to the item list.
        this.scene.bringToTop('RenownTreeOverlay');
      });
      container.add(treeBtn);
    }

    container.add(closeBtn);

    // Also close on dim click
    dim.setInteractive();
    dim.on('pointerdown', () => {
      SoundManager.play('select');
      container.destroy(true);
      this._inspectModal = null;
    });
  }
}
