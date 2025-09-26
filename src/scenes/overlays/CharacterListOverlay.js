import GameState from '../../systems/GameState.js';
import { getXPNeededForLevel } from '../../../data/xpTable.js';
import { createOverlayFrame } from '../../ui/OverlayFrame.js';

export default class CharacterListOverlay extends Phaser.Scene {
  constructor() {
    super({ key: 'CharacterListOverlay' });
  }

  create() {

    const frame = createOverlayFrame(this, {
      title: 'Camp Nehemiah - Character Roster',
      onClose: () => this._close()
    });

    this.frame = frame;
    this.contentDepth = frame.depth;
    this.backgroundDepth = frame.depth - 1;

    this.tabButtons = [];
    this.listEntries = [];
    this.detailTexts = [];
    this.detailBackground = null;

    this.activeTab = 'alive';
    this.selectedCharacterId = GameState.party?.[0]?.id ?? null;

    this.hintText = this.add.text(frame.bounds.x + 40, frame.bounds.y + 78,
      'Select a character to view their vitals.', {
      fontSize: '16px',
      color: '#cccccc',
      fontStyle: 'italic'
    })
      .setDepth(this.contentDepth)
      .setAlpha(0.85);

    this._buildTabs();
    this._updateTabStyles();
    this.refreshCharacterList();

    const initialCharacter = GameState.party?.find(c => c.id === this.selectedCharacterId) || null;
    this.renderCharacterDetails(initialCharacter);
  }

  _buildTabs() {
    const bounds = this.frame.bounds;
    const tabY = bounds.y + 80;
    const startX = bounds.x + 40;
    const spacing = 160;

    const tabs = [
      { key: 'alive', label: 'Alive' },
      { key: 'slain', label: 'Slain' }
    ];

    this.tabButtons = tabs.map((tab, index) => {
      const text = this.add.text(startX + index * spacing, tabY, tab.label, {
        fontSize: '20px',
        color: '#aaaaaa'
      })
        .setDepth(this.contentDepth)
        .setInteractive({ useHandCursor: true });
      text.on('pointerdown', () => this._switchTab(tab.key));
      return { ...tab, text };
    });
  }

  _updateTabStyles() {
    if (!this.tabButtons) return;
    this.tabButtons.forEach(({ key, label, text }) => {
      const active = this.activeTab === key;
      text.setText(active ? `[ ${label} ]` : label);
      text.setStyle({ color: active ? '#ffffaa' : '#aaaaaa' });
    });
  }

  _switchTab(key) {
    if (this.activeTab === key) return;
    this.activeTab = key;

    if (key !== 'alive') {
      this.selectedCharacterId = null;
    } else if (!GameState.party?.some(c => c.id === this.selectedCharacterId)) {
      this.selectedCharacterId = GameState.party?.[0]?.id ?? null;
    }

    this._updateTabStyles();
    this.refreshCharacterList();

    const selected = key === 'alive'
      ? GameState.party?.find(c => c.id === this.selectedCharacterId) || null
      : null;
    this.renderCharacterDetails(selected);
  }

  refreshCharacterList() {
    if (this.listEntries) {
      this.listEntries.forEach(entry => entry.destroy());
    }
    this.listEntries = [];

    const bounds = this.frame.bounds;
    const listLeft = bounds.x + 40;
    const listWidth = bounds.width / 2 - 60;
    const startY = bounds.y + 130;
    const spacing = 44;

    const roster = this.activeTab === 'alive'
      ? (GameState.party || [])
      : (GameState.slain || []);

    if (!roster.length) {
      const message = this.activeTab === 'alive'
        ? 'No adventurers are currently assembled.'
        : 'No fallen heroes recorded yet.';
      const placeholder = this.add.text(listLeft, startY, message, {
        fontSize: '16px',
        color: '#bbbbbb'
      }).setDepth(this.contentDepth);
      this.listEntries.push(placeholder);
      return;
    }

    roster.forEach((char, index) => {
      const y = startY + index * spacing;
      const isSelected = this.selectedCharacterId === char.id;

      const bg = this.add.rectangle(
        listLeft + listWidth / 2,
        y + 16,
        listWidth,
        34,
        0x000000,
        isSelected ? 0.45 : 0.3
      )
        .setStrokeStyle(isSelected ? 2 : 1, isSelected ? 0xffffaa : 0x555555, isSelected ? 0.9 : 0.6)
        .setDepth(this.backgroundDepth)
        .setInteractive({ useHandCursor: true });

      const nameText = this.add.text(listLeft + 16, y, `${char.name} (Lv ${char.level})`, {
        fontSize: '18px',
        color: isSelected ? '#ffffaa' : '#ffffff'
      }).setDepth(this.contentDepth);

      const xpText = this.add.text(listLeft + 16, y + 18,
        `XP: ${char.experience}/${getXPNeededForLevel(char.level)}`, {
        fontSize: '14px',
        color: '#cccccc'
      }).setDepth(this.contentDepth);

      const updateHover = (hover) => {
        if (isSelected) return;
        bg.setFillStyle(0x000000, hover ? 0.45 : 0.3);
        nameText.setStyle({ color: hover ? '#ffffee' : '#ffffff' });
      };

      bg.on('pointerover', () => updateHover(true));
      bg.on('pointerout', () => updateHover(false));
      bg.on('pointerdown', () => this.inspectCharacter(char));

      this.listEntries.push(bg, nameText, xpText);
    });
  }

  inspectCharacter(character) {
    if (!character) return;
    this.selectedCharacterId = character.id;
    this.renderCharacterDetails(character);
    this.refreshCharacterList();
  }

  renderCharacterDetails(character) {
    if (this.detailTexts) {
      this.detailTexts.forEach(entry => entry.destroy());
    }
    this.detailTexts = [];

    if (this.detailBackground) {
      this.detailBackground.destroy();
      this.detailBackground = null;
    }

    const bounds = this.frame.bounds;
    const detailLeft = bounds.x + bounds.width / 2 + 20;
    const detailWidth = bounds.width / 2 - 60;
    const detailTop = bounds.y + 120;
    const detailHeight = bounds.height - 160;

    this.detailBackground = this.add.rectangle(
      detailLeft + detailWidth / 2,
      detailTop + detailHeight / 2,
      detailWidth,
      detailHeight,
      0x000000,
      0.25
    )
      .setStrokeStyle(1, 0xffffff, 0.2)
      .setDepth(this.backgroundDepth);

    if (!character) {
      const placeholder = this.add.text(detailLeft, detailTop,
        this.activeTab === 'slain'
          ? 'Fallen heroes will appear here once recorded.'
          : 'Select a character to review their vitals.', {
        fontSize: '16px',
        color: '#cccccc',
        wordWrap: { width: detailWidth - 20 }
      }).setDepth(this.contentDepth);
      this.detailTexts.push(placeholder);
      this.hintText?.setVisible(true);
      return;
    }

    this.hintText?.setVisible(false);

    const header = this.add.text(detailLeft, detailTop, character.name, {
      fontSize: '22px',
      color: '#ffddaa',
      fontFamily: 'Georgia'
    }).setDepth(this.contentDepth);
    this.detailTexts.push(header);

    let cursorY = detailTop + 32;

    const overview = [
      `Race: ${character.race}`,
      `Class: ${character.baseClass}${character.specialization ? ` – ${character.specialization}` : ''}`,
      `Level: ${character.level}`,
      `XP: ${character.experience}/${getXPNeededForLevel(character.level)}`,
      `Favor: ${character.favor}/10`
    ];
    cursorY = this._writeSection(detailLeft, cursorY, 'Overview', overview, detailWidth);

    const vitals = [
      `HP: ${character.currentHP}/${character.maxHP}`,
      `MP: ${character.currentMP}/${character.maxMP}`,
      `Initiative: ${character.initiative}`
    ];
    cursorY = this._writeSection(detailLeft, cursorY, 'Vitals', vitals, detailWidth);

    const combat = [
      `Accuracy: ${character.derived?.Accuracy ?? '—'}`,
      `Evasion: ${character.derived?.Evasion ?? '—'}`,
      `Stun Chance: ${character.derived?.StunChance ?? '—'}`,
      `Physical Res: ${character.derived?.PhysicalResist ?? '—'}`,
      `Elemental Res: ${character.derived?.ElementalResist ?? '—'}`
    ];
    cursorY = this._writeSection(detailLeft, cursorY, 'Combat', combat, detailWidth);

    const resistances = [
      `Fear Res: ${character.statusResist?.fear ?? '—'}`,
      `Charm Res: ${character.statusResist?.charm ?? '—'}`,
      `Poison Res: ${character.statusResist?.poison ?? '—'}`
    ];
    cursorY = this._writeSection(detailLeft, cursorY, 'Resistances', resistances, detailWidth);

    const healing = [
      `Healing Given: ${Math.round((character.healing?.given ?? 0) * 100)}%`,
      `Healing Received: ${Math.round((character.healing?.received ?? 0) * 100)}%`
    ];
    this._writeSection(detailLeft, cursorY, 'Support', healing, detailWidth);
  }

  _writeSection(x, startY, title, lines, width) {
    const titleText = this.add.text(x, startY, title, {
      fontSize: '18px',
      color: '#ffffaa',
      fontStyle: 'bold'
    }).setDepth(this.contentDepth);
    this.detailTexts.push(titleText);

    let cursorY = startY + 24;
    lines.forEach(line => {
      const body = this.add.text(x + 12, cursorY, line, {
        fontSize: '16px',
        color: '#eeeeee',
        wordWrap: { width: width - 24 }
      }).setDepth(this.contentDepth);
      this.detailTexts.push(body);
      cursorY += 22;
    });

    return cursorY + 10;
  }

  _close() {
    this.scene.resume('UIScene');
    this.scene.stop();
  }
}
