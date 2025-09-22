import SceneManager from '../systems/SceneManager.js';
import GameState from '../systems/GameState.js';

export default class MainMenuScene extends Phaser.Scene {
  constructor() {
    super({ key: 'MainMenuScene' });
  }

  create() {
    const { width, height } = this.sys.game.canvas;

    // Background
    this.add.rectangle(width / 2, height / 2, width, height, 0x111122, 1)
      .setScrollFactor(0).setDepth(0);

    this.add.text(width / 2, height / 2 - 120, 'Behel\'ith: Sacred Hunt', {
      fontSize: '40px',
      color: '#ffffff'
    }).setOrigin(0.5).setDepth(1);

    // Keep a reference to SceneManager
    this.sceneManager = new SceneManager(this);

    this.createMenuButton('▶ Start New Game', width / 2, height / 2 - 20, () => {
      this.sceneManager.enterTown();
    });

    this.createMenuButton('📂 Load Game', width / 2, height / 2 + 40, () => {
      this.showLoadGamePopup();
    });

    this.createMenuButton('⚙️ Settings', width / 2, height / 2 + 100, () => {
      console.log('Settings - Coming soon');
    });

    this.createMenuButton('❌ Exit', width / 2, height / 2 + 160, () => {
      console.log('Exit - Not supported in browser');
    });

    this.add.text(width / 2, height - 40, 'v0.1 - Dev Build', {
      fontSize: '16px',
      color: '#aaaaaa'
    }).setOrigin(0.5);
  }

  createMenuButton(label, x, y, callback) {
    const btn = this.add.text(x, y, label, {
      fontSize: '24px',
      color: '#ffffaa'
    }).setOrigin(0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', callback)
      .on('pointerover', () => btn.setStyle({ color: '#ffffff' }))
      .on('pointerout', () => btn.setStyle({ color: '#ffffaa' }));
  }

showLoadGamePopup() {
  const width = this.sys.game.canvas.width;
  const height = this.sys.game.canvas.height;

  const slots = GameState.listSaveSlots();

  // Remove existing popup if any
  if (this.loadPopup) {
    this.loadPopup.destroy(true);
  }

  // === Blocker layer to prevent clicks under popup ===
  const blocker = this.add.rectangle(width / 2, height / 2, width, height, 0x000000, 0.3)
    .setInteractive()
    .setDepth(999); // ensure it's above menu but below popup
  blocker.on('pointerdown', () => {}); // do nothing, just absorb clicks

  // === Popup container ===
  this.loadPopup = this.add.container(width / 2, height / 2).setDepth(1000);

  // Background
  const bg = this.add.rectangle(0, 0, 500, 400, 0x111111, 0.95)
    .setStrokeStyle(2, 0xffffff)
    .setOrigin(0.5);
  this.loadPopup.add(bg);

  this.loadPopup.add(this.add.text(0, -170, 'Select Save Slot', {
    fontSize: '20px',
    color: '#ffffaa'
  }).setOrigin(0.5));

  if (slots.length === 0) {
    this.loadPopup.add(this.add.text(0, 0, 'No saved games found', {
      fontSize: '18px',
      color: '#cccccc'
    }).setOrigin(0.5));
  } else {
    slots.forEach((slot, i) => {
      const rawData = localStorage.getItem(`bmSave_${slot}`);
      let partyPreview = '';
      try {
        const parsed = JSON.parse(rawData);
        if (parsed?.partyIds?.length) {
          const partyChars = (parsed.characters || [])
            .filter(c => parsed.partyIds.includes(c.id))
            .map(c => `${c.name} (Lv ${c.level})`);
          partyPreview = partyChars.join(', ');
        }
      } catch (e) {
        console.warn(`Failed to read save slot ${slot}:`, e);
      }

      const btnY = -120 + i * 60;
      const btn = this.add.text(0, btnY, `[ Slot ${slot} ]`, {
        fontSize: '18px',
        color: '#88ccff'
      }).setOrigin(0.5)
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', () => {
          GameState.load(slot);
          this.loadPopup.destroy(true);
          blocker.destroy();
          this.sceneManager.enterTown();
        });
      this.loadPopup.add(btn);

      if (partyPreview) {
        const previewText = this.add.text(0, btnY + 20, partyPreview, {
          fontSize: '14px',
          color: '#cccccc',
          wordWrap: { width: 460 }
        }).setOrigin(0.5);
        this.loadPopup.add(previewText);
      }
    });
  }

  // Close button
  const closeBtn = this.add.text(0, 170, '[ Close ]', {
    fontSize: '18px',
    color: '#ff6666'
  }).setOrigin(0.5)
    .setInteractive({ useHandCursor: true })
    .on('pointerdown', () => {
      this.loadPopup.destroy(true);
      blocker.destroy();
    });
  this.loadPopup.add(closeBtn);
}

}
