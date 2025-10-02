import GameState from '../../systems/GameState.js';
import { getXPNeededForLevel } from '../../../data/xpTable.js';
import { createOverlayFrame } from '../../ui/OverlayFrame.js';

export default class CharacterListOverlay extends Phaser.Scene {
  constructor() {
    super({ key: 'CharacterListOverlay' });
    this.detailContainer = null;
    this.detailMask = null;
    this.detailMaskGraphics = null;
    this.detailScrollArea = null;
    this.detailContentHeight = 0;
    this.detailViewportHeight = 0;
    this.detailBaseY = 0;
    this._detailWheelHandler = null;
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
    this.detailBackground = null;
    this.detailContainer = null;
    this.detailMask = null;
    this.detailMaskGraphics = null;
    this.detailScrollArea = null;
    this.detailContentHeight = 0;
    this.detailViewportHeight = 0;
    this.detailBaseY = 0;

    this.activeTab = 'alive';
    this.selectedCharacterId = GameState.party?.[0]?.id ?? null;

    this.hintText = this.add.text(frame.bounds.x + 40, frame.bounds.y + 60,
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

    if (this._detailWheelHandler) {
      this.input.off('wheel', this._detailWheelHandler, this);
    }
    this._detailWheelHandler = (pointer, _objects, _dx, dy) => {
      if (!this.detailContainer || !this.detailScrollArea) return;
      const { x, y, w, h } = this.detailScrollArea;
      const { worldX, worldY } = pointer;
      if (worldX < x || worldX > x + w || worldY < y || worldY > y + h) return;

      const maxScroll = Math.max(0, this.detailContentHeight - this.detailViewportHeight);
      if (maxScroll <= 0) {
        this.detailContainer.y = this.detailBaseY;
        return;
      }

      const next = this.detailContainer.y - dy * 0.3;
      this.detailContainer.y = Phaser.Math.Clamp(next, this.detailBaseY - maxScroll, this.detailBaseY);
    };
    this.input.on('wheel', this._detailWheelHandler, this);

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      if (this._detailWheelHandler) {
        this.input.off('wheel', this._detailWheelHandler, this);
        this._detailWheelHandler = null;
      }
    });
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
    if (this.detailContainer) {
      this.detailContainer.destroy(true);
      this.detailContainer = null;
    }
    if (this.detailMask) {
      this.detailMask.destroy();
      this.detailMask = null;
    }
    if (this.detailMaskGraphics) {
      this.detailMaskGraphics.destroy();
      this.detailMaskGraphics = null;
    }

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

    const maskGraphics = this.make.graphics({ x: detailLeft, y: detailTop, add: false });
    maskGraphics.fillStyle(0xffffff, 1);
    maskGraphics.fillRect(0, 0, detailWidth, detailHeight);
    const mask = new Phaser.Display.Masks.GeometryMask(this, maskGraphics);

    this.detailMaskGraphics = maskGraphics;
    this.detailMask = mask;

    this.detailContainer = this.add.container(detailLeft, detailTop).setDepth(this.contentDepth);
    this.detailContainer.setMask(mask);

    this.detailScrollArea = { x: detailLeft, y: detailTop, w: detailWidth, h: detailHeight };
    this.detailBaseY = detailTop;
    this.detailViewportHeight = detailHeight;

    let cursorY = 0;


    if (!character) {
      const placeholderText = this.activeTab === 'slain'
        ? 'Fallen heroes will appear here once recorded.'
        : 'Select a character to review their vitals.';
      const placeholder = this.add.text(0, 0, placeholderText, {
        fontSize: '16px',
        color: '#cccccc',
        wordWrap: { width: detailWidth - 20 }
      }).setDepth(this.contentDepth);
      this.detailContainer.add(placeholder);
      cursorY = placeholder.height;
      this.detailContentHeight = cursorY;
      this._resetDetailScroll();
      this.hintText?.setVisible(true);
      return;
    }

    this.hintText?.setVisible(false);

    const header = this.add.text(0, 0, character.name, {
      fontSize: '22px',
      color: '#ffddaa',
      fontFamily: 'Georgia'
    }).setDepth(this.contentDepth);
    this.detailContainer.add(header);

    cursorY = header.height + 12;

    const overview = [
      `Race: ${character.race}`,
      `Class: ${character.baseClass}${character.specialization ? ` – ${character.specialization}` : ''}`,
      `Level: ${character.level}`,
      `XP: ${character.experience}/${getXPNeededForLevel(character.level)}`,
      `Favor: ${character.favor}/10`
    ];
    cursorY = this._writeSection(0, cursorY, 'Overview', overview, detailWidth);

    const vitals = [
      `HP: ${character.currentHP}/${character.maxHP}`,
      `MP: ${character.currentMP}/${character.maxMP}`,
      `Initiative: ${character.initiative}`
    ];
    cursorY = this._writeSection(0, cursorY, 'Vitals', vitals, detailWidth);

    const resilience = character.resilience ?? character.derived?.Resilience ?? '—';
    const combat = [
      `Accuracy: ${character.derived?.Accuracy ?? '—'}`,
      `Evasion: ${character.derived?.Evasion ?? '—'}`,
      `Resilience: ${resilience}`
    ];
    cursorY = this._writeSection(0, cursorY, 'Combat', combat, detailWidth);

    const resistances = [
      `Physical Res: ${character.derived?.PhysicalResist ?? '—'}`,
      `Elemental Res: ${character.derived?.ElementalResist ?? '—'}`
    ];
    cursorY = this._writeSection(0, cursorY, 'Resistances', resistances, detailWidth);

    const healing = [
      `Healing Given: ${Math.round((character.healing?.given ?? 0) * 100)}%`,
      `Healing Received: ${Math.round((character.healing?.received ?? 0) * 100)}%`
    ];
    cursorY = this._writeSection(0, cursorY, 'Support', healing, detailWidth);

    this.detailContentHeight = cursorY;
    this._resetDetailScroll();
  }

  _writeSection(x, startY, title, lines, width) {
    const titleText = this.add.text(x, startY, title, {
      fontSize: '18px',
      color: '#ffffaa',
      fontStyle: 'bold'
    }).setDepth(this.contentDepth);
    this.detailContainer?.add(titleText);

    let cursorY = startY + titleText.height + 6;
    lines.forEach(line => {
      const body = this.add.text(x + 12, cursorY, line, {
        fontSize: '16px',
        color: '#eeeeee',
        wordWrap: { width: width - 24 }
      }).setDepth(this.contentDepth);
      this.detailContainer?.add(body);
      cursorY += body.height + 6;
    });

    return cursorY + 10;
  }

  _resetDetailScroll() {
    if (!this.detailContainer) return;
    this.detailContainer.y = this.detailBaseY;
  }

  _close() {
    this.scene.resume('UIScene');
    this.scene.stop();
  }
}
