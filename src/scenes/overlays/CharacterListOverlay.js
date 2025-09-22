import GameState from '../../systems/GameState.js';
import { getXPNeededForLevel } from '../../../data/xpTable.js';

export default class CharacterListOverlay extends Phaser.Scene {
  constructor() {
    super({ key: 'CharacterListOverlay' });
  }

  create() {
    const width = this.sys.game.canvas.width;
    const height = this.sys.game.canvas.height;

    // 🔲 Dimmed background — LOW depth
    this.add.rectangle(width / 2, height / 2, width, height, 0x000000, 0.8)
      .setInteractive()
      .setDepth(0);

    // 🧑 Title
    this.add.text(width / 2, 40, 'Camp Nehemiah - Character Roster', {
      fontSize: '28px',
      color: '#ffffff'
    }).setOrigin(0.5).setDepth(1);

    // ❌ Close Button
    this.add.text(width - 60, 40, '[X]', {
      fontSize: '24px',
      color: '#ff6666'
    }).setOrigin(0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => {
        this.scene.stop();
        this.scene.resume('UIScene');
      })
      .setDepth(2);

    // Tabs
    this.activeTab = 'alive';
    this.renderTabs();
    this.refreshCharacterList();
  }

  renderTabs() {
    const tabX = 100;
    const tabY = 100;
    const tabSpacing = 120;

    this.aliveTab = this.add.text(tabX, tabY, '[ Alive ]', {
      fontSize: '20px',
      color: this.activeTab === 'alive' ? '#ffffaa' : '#aaaaaa'
    }).setInteractive({ useHandCursor: true }).on('pointerdown', () => {
      this.activeTab = 'alive';
      this.refreshCharacterList();
    }).setDepth(1);

    this.slainTab = this.add.text(tabX + tabSpacing, tabY, '[ Slain ]', {
      fontSize: '20px',
      color: this.activeTab === 'slain' ? '#ffffaa' : '#aaaaaa'
    }).setInteractive({ useHandCursor: true }).on('pointerdown', () => {
      this.activeTab = 'slain';
      this.refreshCharacterList();
    }).setDepth(1);
  }

  refreshCharacterList() {
    // Clear existing items
    if (this.characterTexts) {
      this.characterTexts.forEach(txt => txt.destroy());
    }
    this.characterTexts = [];

    const startY = 150;
    const spacing = 30;

    GameState.party.forEach((char, i) => {
      const y = startY + i * spacing;

      const charText = this.add.text(200, y,
        `${char.name} (Lv ${char.level}) - XP: ${char.experience}/${getXPNeededForLevel(char.level)}`,
        {
          fontSize: '18px',
          color: '#ffffff'
        }
      ).setInteractive({ useHandCursor: true })
        .on('pointerdown', () => this.inspectCharacter(char));

      this.characterTexts.push(charText);
    });
  }

  inspectCharacter(character) {
    if (this.detailTexts) {
      this.detailTexts.forEach(txt => txt.destroy());
    }
    this.detailTexts = [];

    const startY = 150;
    const spacing = 26;

    const lines = [
      `Name: ${character.name}`,
      `Level: ${character.level}`,
      `XP: ${character.experience}/${getXPNeededForLevel(character.level)}`,
      `Race: ${character.race}`,
      `Class: ${character.baseClass}`,
      `HP: ${character.currentHP}/${character.maxHP}`,
      `MP: ${character.currentMP}/${character.maxMP}`,
      `Accuracy: ${character.derived.Accuracy}`,
      `Evasion: ${character.derived.Evasion}`,
      `Stun Chance: ${character.derived.StunChance}`,
      `Physical Res: ${character.derived.PhysicalResist}`,
      `Elemental Res: ${character.derived.ElementalResist}`,
      `Fear Res: ${character.statusResist.fear}`,
      `Charm Res: ${character.statusResist.charm}`,
      `Poison Res: ${character.statusResist.poison}`,
      `Healing Given: ${Math.round(character.healing.given * 100)}%`,
      `Healing Received: ${Math.round(character.healing.received * 100)}%`,
      `Initiative: ${character.initiative}`,
      `Favor: ${character.favor}/10`
    ];

    lines.forEach((line, i) => {
      const text = this.add.text(700, startY + i * spacing, line, {
        fontSize: '18px',
        color: '#ffffcc'
      }).setDepth(2);
      this.detailTexts.push(text);
    });
  }
}
