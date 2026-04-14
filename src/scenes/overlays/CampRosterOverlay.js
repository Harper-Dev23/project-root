/**
 * CampRosterOverlay — Camp Nehemiah full character roster.
 * Opened via the ⛺ Camp button inside the player's own tribe lodge.
 *
 * Left half : scrollable character list with Alive / Slain tabs.
 *             Each row shows party-status badge and transfer button.
 * Right half : stats + equipment detail panel (no level-up / talent buttons).
 */

import GameState from '../../systems/GameState.js';
import { getXPNeededForLevel } from '../../../data/xpTable.js';
import { createOverlayFrame } from '../../ui/OverlayFrame.js';
import { Items } from '../../../data/items.js';
import { isItemInstance } from '../../systems/ItemFactory.js';

export default class CampRosterOverlay extends Phaser.Scene {
  constructor() {
    super({ key: 'CampRosterOverlay' });
    this.activeTab          = 'alive';
    this.selectedCharId     = null;
    this.listEntries        = [];
    this.detailContainer    = null;
    this.detailMaskGraphics = null;
    this.detailMask         = null;
    this.detailBackground   = null;
    this.detailScrollArea   = null;
    this.detailContentHeight = 0;
    this.detailViewportHeight = 0;
    this.detailBaseY        = 0;
    this._wheelHandler      = null;
  }

  create() {
    const town = this.scene.get('TownScene');
    if (town?.input) town.input.enabled = false;

    const frame = createOverlayFrame(this, {
      title:   'Camp Nehemiah — Character Roster',
      onClose: () => this._close(),
      bgImage: 'menu_parchment_background',
    });

    this.frame        = frame;
    this.contentDepth = frame.depth;
    this.bgDepth      = frame.depth - 1;

    this._buildTabs();
    this._updateTabStyles();
    this.refreshList();

    const initialChar = this._roster().find(c => c.id === this.selectedCharId) || null;
    this._renderDetail(initialChar);

    // Wheel scroll for detail panel
    if (this._wheelHandler) this.input.off('wheel', this._wheelHandler, this);
    this._wheelHandler = (pointer, _objs, _dx, dy) => {
      if (!this.detailContainer || !this.detailScrollArea) return;
      const { x, y, w, h } = this.detailScrollArea;
      if (pointer.worldX < x || pointer.worldX > x + w || pointer.worldY < y || pointer.worldY > y + h) return;
      const maxScroll = Math.max(0, this.detailContentHeight - this.detailViewportHeight);
      if (maxScroll <= 0) { this.detailContainer.y = this.detailBaseY; return; }
      const next = this.detailContainer.y - dy * 0.3;
      this.detailContainer.y = Phaser.Math.Clamp(next, this.detailBaseY - maxScroll, this.detailBaseY);
    };
    this.input.on('wheel', this._wheelHandler, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      if (this._wheelHandler) { this.input.off('wheel', this._wheelHandler, this); this._wheelHandler = null; }
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  _roster() {
    return this.activeTab === 'alive'
      ? (GameState.characters || [])
      : (GameState.slain || []);
  }

  _inParty(char) {
    return (GameState.party || []).some(c => c.id === char.id);
  }

  // ── Tabs ─────────────────────────────────────────────────────────────────────

  _buildTabs() {
    const bounds  = this.frame.bounds;
    const tabY    = bounds.y + 80;
    const startX  = bounds.x + 40;
    const spacing = 160;

    this.tabObjects = [
      { key: 'alive', label: 'Alive' },
      { key: 'slain', label: 'Slain' },
    ].map((tab, i) => {
      const text = this.add.text(startX + i * spacing, tabY, tab.label, {
        fontSize: '20px', color: '#aaaaaa',
      }).setDepth(this.contentDepth).setInteractive({ useHandCursor: true });
      text.on('pointerdown', () => this._switchTab(tab.key));
      return { ...tab, text };
    });
  }

  _updateTabStyles() {
    (this.tabObjects || []).forEach(({ key, label, text }) => {
      const active = this.activeTab === key;
      text.setText(active ? `[ ${label} ]` : label);
      text.setStyle({ color: active ? '#ffffaa' : '#aaaaaa' });
    });
  }

  _switchTab(key) {
    if (this.activeTab === key) return;
    this.activeTab     = key;
    this.selectedCharId = null;
    this._updateTabStyles();
    this.refreshList();
    this._renderDetail(null);
  }

  // ── Left list ─────────────────────────────────────────────────────────────────

  refreshList() {
    (this.listEntries || []).forEach(e => e.destroy());
    this.listEntries = [];

    const bounds      = this.frame.bounds;
    const listLeft    = bounds.x + 40 + 12;
    const listWidth   = bounds.width / 2 - 60;
    const startY      = bounds.y + 130;
    const rowH        = 48;
    const roster      = this._roster();

    if (!roster.length) {
      const msg = this.activeTab === 'alive'
        ? 'No characters created yet.'
        : 'No fallen heroes recorded.';
      const t = this.add.text(listLeft, startY, msg, { fontSize: '16px', color: '#888888' })
        .setDepth(this.contentDepth);
      this.listEntries.push(t);
      return;
    }

    roster.forEach((char, i) => {
      const y          = startY + i * rowH;
      const isSelected = this.selectedCharId === char.id;
      const inParty    = this._inParty(char);

      const bg = this.add.rectangle(
        listLeft + listWidth / 2, y + rowH / 2 - 4, listWidth, rowH - 4,
        0x000000, isSelected ? 0.45 : 0.28
      )
        .setStrokeStyle(isSelected ? 2 : 1, isSelected ? 0xffffaa : 0x444444, isSelected ? 0.9 : 0.5)
        .setDepth(this.bgDepth)
        .setInteractive({ useHandCursor: true });

      const nameText = this.add.text(listLeft + 10, y + 2,
        `${char.name}  (Lv ${char.level}  ${char.baseClass})`, {
        fontSize: '15px', color: isSelected ? '#ffffaa' : '#eeeeee',
      }).setDepth(this.contentDepth);

      // Party status badge
      const badgeColor = inParty ? '#88ffaa' : '#aaaaaa';
      const badgeLabel = inParty ? '⚔ In Party' : '🏕 Rested';
      const badge = this.add.text(listLeft + 10, y + 22, badgeLabel, {
        fontSize: '12px', color: badgeColor,
      }).setDepth(this.contentDepth);

      // Transfer button (only for alive tab; can't transfer slain)
      let transferBtn = null;
      if (this.activeTab === 'alive') {
        if (inParty) {
          transferBtn = this.add.text(listLeft + listWidth - 10, y + 12, '[ → Camp ]', {
            fontSize: '12px', color: '#ffaa66',
          }).setOrigin(1, 0).setDepth(this.contentDepth)
            .setInteractive({ useHandCursor: true })
            .on('pointerdown', () => {
              GameState.removeFromParty(char);
              this.refreshList();
              const reChar = this._roster().find(c => c.id === this.selectedCharId) || null;
              this._renderDetail(reChar);
              this.scene.get('UIScene')?.refreshUI?.();
            });
        } else if (GameState.party.length < 6) {
          transferBtn = this.add.text(listLeft + listWidth - 10, y + 12, '[ → Party ]', {
            fontSize: '12px', color: '#66aaff',
          }).setOrigin(1, 0).setDepth(this.contentDepth)
            .setInteractive({ useHandCursor: true })
            .on('pointerdown', () => {
              GameState.addToParty(char);
              this.refreshList();
              const reChar = this._roster().find(c => c.id === this.selectedCharId) || null;
              this._renderDetail(reChar);
              this.scene.get('UIScene')?.refreshUI?.();
            });
        } else {
          // Party full — greyed out label
          transferBtn = this.add.text(listLeft + listWidth - 10, y + 12, '[ Party Full ]', {
            fontSize: '12px', color: '#555555',
          }).setOrigin(1, 0).setDepth(this.contentDepth);
        }
      }

      bg.on('pointerover',  () => { if (!isSelected) { bg.setFillStyle(0x000000, 0.4); nameText.setStyle({ color: '#ffffd0' }); } });
      bg.on('pointerout',   () => { if (!isSelected) { bg.setFillStyle(0x000000, 0.28); nameText.setStyle({ color: '#eeeeee' }); } });
      bg.on('pointerdown',  () => this._inspectChar(char));

      const entries = [bg, nameText, badge];
      if (transferBtn) entries.push(transferBtn);
      this.listEntries.push(...entries);
    });
  }

  _inspectChar(char) {
    this.selectedCharId = char.id;
    this.refreshList();
    this._renderDetail(char);
  }

  // ── Right detail panel ────────────────────────────────────────────────────────

  _renderDetail(character) {
    // Destroy previous
    [this.detailContainer, this.detailMask, this.detailMaskGraphics, this.detailBackground]
      .forEach(obj => { if (obj) { obj.destroy(true); } });
    this.detailContainer    = null;
    this.detailMask         = null;
    this.detailMaskGraphics = null;
    this.detailBackground   = null;

    const bounds      = this.frame.bounds;
    const detailLeft  = bounds.x + bounds.width / 2 + 20;
    const detailWidth = bounds.width / 2 - 60;
    const detailTop   = bounds.y + 120;
    const detailH     = bounds.height - 160;

    this.detailBackground = this.add.rectangle(
      detailLeft + detailWidth / 2, detailTop + detailH / 2,
      detailWidth, detailH, 0x000000, 0.25
    ).setStrokeStyle(1, 0xffffff, 0.18).setDepth(this.bgDepth);

    const pad        = 18;
    const scrollLeft = detailLeft + pad;
    const scrollTop  = detailTop  + pad;
    const scrollW    = detailWidth - pad * 2;
    const scrollH    = detailH - pad * 2;

    const maskGfx = this.make.graphics({ x: scrollLeft, y: scrollTop, add: false });
    maskGfx.fillStyle(0xffffff, 1);
    maskGfx.fillRect(0, 0, scrollW, scrollH);
    const mask = new Phaser.Display.Masks.GeometryMask(this, maskGfx);

    this.detailMaskGraphics   = maskGfx;
    this.detailMask           = mask;
    this.detailContainer      = this.add.container(scrollLeft, scrollTop).setDepth(this.contentDepth).setMask(mask);
    this.detailScrollArea     = { x: scrollLeft, y: scrollTop, w: scrollW, h: scrollH };
    this.detailBaseY          = scrollTop;
    this.detailViewportHeight = scrollH;

    if (!character) {
      const ph = this.add.text(0, 0, 'Select a character to view their details.', {
        fontSize: '15px', color: '#888888', wordWrap: { width: scrollW - 10 },
      }).setDepth(this.contentDepth);
      this.detailContainer.add(ph);
      this.detailContentHeight = ph.height;
      return;
    }

    let curY = 0;

    // ── Portrait + name strip at the top ──
    const portraitKey = character.skin || `${(character.race || 'Human').toLowerCase()}_portrait_1`;
    const pKey = this.textures.exists(portraitKey) ? portraitKey
               : this.textures.exists('dummy_portrait') ? 'dummy_portrait' : null;

    const portraitSize = 80;
    const portraitBg = this.add.rectangle(portraitSize / 2, portraitSize / 2, portraitSize, portraitSize, 0x000000, 0.4)
      .setStrokeStyle(1, 0xffffff, 0.25).setDepth(this.contentDepth);
    this.detailContainer.add(portraitBg);

    if (pKey) {
      const img = this.add.image(portraitSize / 2, portraitSize / 2, pKey).setDepth(this.contentDepth).setOrigin(0.5);
      const sc  = Math.min((portraitSize - 8) / img.width, (portraitSize - 8) / img.height);
      img.setScale(sc);
      this.detailContainer.add(img);
    }

    const nameTxt = this.add.text(portraitSize + 12, 4, character.name, {
      fontSize: '18px', color: '#ffddaa', fontStyle: 'bold',
    }).setDepth(this.contentDepth);
    this.detailContainer.add(nameTxt);

    const classLine = `${character.race}  ·  ${character.baseClass}${character.specialization ? ` (${character.specialization})` : ''}`;
    const classTxt = this.add.text(portraitSize + 12, nameTxt.height + 8, classLine, {
      fontSize: '13px', color: '#cccccc',
    }).setDepth(this.contentDepth);
    this.detailContainer.add(classTxt);

    const partyStatus = this._inParty(character) ? '⚔ In Party' : '🏕 Rested at Camp';
    const statusTxt = this.add.text(portraitSize + 12, nameTxt.height + classTxt.height + 14, partyStatus, {
      fontSize: '12px', color: this._inParty(character) ? '#88ffaa' : '#aaaaaa',
    }).setDepth(this.contentDepth);
    this.detailContainer.add(statusTxt);

    curY = portraitSize + 16;

    // ── Stats ──
    const statSource = character.totalStats || character.baseStats || {};
    const sv = k => statSource[k] ?? character.baseStats?.[k] ?? '—';

    curY = this._writeSection(curY, 'Core Stats', [
      `STR: ${sv('STR')}   DEX: ${sv('DEX')}   CON: ${sv('CON')}`,
      `INT: ${sv('INT')}   WIS: ${sv('WIS')}   CHA: ${sv('CHA')}`,
    ], scrollW);

    curY = this._writeSection(curY, 'Vitals', [
      `HP: ${character.currentHP ?? '—'} / ${character.maxHP ?? character.derived?.maxHP ?? '—'}`,
      `MP: ${character.currentMP ?? '—'} / ${character.maxMP ?? character.derived?.maxMP ?? '—'}`,
      `Initiative: ${character.initiative ?? '—'}`,
      `Level: ${character.level}   XP: ${character.experience}/${getXPNeededForLevel(character.level)}`,
    ], scrollW);

    curY = this._writeSection(curY, 'Combat', [
      `Accuracy: ${character.derived?.Accuracy ?? '—'}`,
      `Evasion: ${character.derived?.Evasion ?? '—'}`,
      `Resilience: ${character.resilience ?? character.derived?.Resilience ?? '—'}`,
      `Phys Resist: ${character.derived?.PhysicalResist ?? '—'}`,
      `Elem Resist: ${character.derived?.ElementalResist ?? '—'}`,
    ], scrollW);

    // ── Equipment ──
    if (character.equipment) {
      const eqLines = Object.entries(character.equipment).map(([slot, item]) => {
        if (!item) return `${this._fmtSlot(slot)}: —`;
        const base = isItemInstance(item) ? (Items[item.id] || {}) : (Items[item] || {});
        const name = base.name || (isItemInstance(item) ? item.id : item) || '?';
        return `${this._fmtSlot(slot)}: ${name}`;
      });
      const itemCount = (character.inventory || []).length;
      eqLines.push(`Items in bag: ${itemCount}`);
      curY = this._writeSection(curY, 'Equipment', eqLines, scrollW);
    }

    this.detailContentHeight = curY;
    this.detailContainer.y = this.detailBaseY;
  }

  _writeSection(startY, title, lines, width) {
    const titleTxt = this.add.text(0, startY, title, {
      fontSize: '15px', color: '#ffffaa', fontStyle: 'bold',
    }).setDepth(this.contentDepth);
    this.detailContainer.add(titleTxt);
    let curY = startY + titleTxt.height + 4;

    lines.forEach(line => {
      const t = this.add.text(12, curY, line, {
        fontSize: '14px', color: '#dddddd', wordWrap: { width: width - 24 },
      }).setDepth(this.contentDepth);
      this.detailContainer.add(t);
      curY += t.height + 4;
    });

    return curY + 10;
  }

  _fmtSlot(slot) {
    return slot.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()).trim();
  }

  // ── Close ─────────────────────────────────────────────────────────────────────

  _close() {
    const town = this.scene.get('TownScene');
    if (town?.input) town.input.enabled = true;
    this.scene.get('UIScene')?.refreshUI?.();
    this.scene.stop();
  }
}
