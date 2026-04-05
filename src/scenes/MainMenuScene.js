import SceneManager from '../systems/SceneManager.js';
import GameState from '../systems/GameState.js';
import ProgressionManager from '../systems/ProgressionManager.js';

export default class MainMenuScene extends Phaser.Scene {
  constructor() {
    super({ key: 'MainMenuScene' });
  }

  preload() {
    this.load.image('main_menu_bg', 'assets/MainMenu_Background.png');
  }

  create() {
    const { width, height } = this.sys.game.canvas;

    // Background
    this.add.image(width / 2, height / 2, 'main_menu_bg')
      .setDisplaySize(width, height)
      .setScrollFactor(0)
      .setDepth(0);

    this.add.text(width / 2, height / 2 - 110, 'Behel\'ith: Sacred Hunt', {
      fontSize: '40px',
      color: '#f3dede'
    }).setOrigin(0.5).setDepth(2);

    // Keep a reference to SceneManager
    this.sceneManager = new SceneManager(this);

    this.createMenuButton('▶ Start New Game', width / 2, height / 2 - 20, () => {
      // Reset all in-memory state for a clean new game.
      GameState.reset();
      ProgressionManager.reset();
      // Seed the orientation flow — first flag points the player to the bonfire.
      ProgressionManager.setQuestFlag('orientation_bonfire');
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

    this.add.text(width - 10, height - 10, 'v0.1 - Dev Build', {
      fontSize: '16px',
      color: '#333333'
    }).setOrigin(1, 1);
  }

  createMenuButton(label, x, y, callback) {
    const btn = this.add.text(x, y, label, {
      fontSize: '24px',
      color: '#ffffff'
    }).setOrigin(0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', callback)
      .on('pointerover', () => btn.setStyle({ color: '#dddddd' }))
      .on('pointerout', () => btn.setStyle({ color: '#ffffff' }));
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

    const listWidth = 460;
    const listHeight = 240;
    const listTop = -140;
    const slotSpacing = 60;
    const slotsContainer = this.add.container(0, 0);

    const maskGfx = this.add.graphics();
    maskGfx.fillStyle(0xffffff, 1);
    maskGfx.fillRect(width / 2 - listWidth / 2, height / 2 + listTop, listWidth, listHeight);
    maskGfx.setVisible(false);
    slotsContainer.setMask(maskGfx.createGeometryMask());

    this.loadPopup.add([maskGfx, slotsContainer]);

    let scrollOffset = 0;
    const totalHeight = slots.length * slotSpacing;
    const maxScroll = Math.max(0, totalHeight - listHeight);
    const applyScroll = (delta) => {
      if (!maxScroll) return;
      scrollOffset = Phaser.Math.Clamp(scrollOffset + delta, -maxScroll, 0);
      slotsContainer.y = scrollOffset;
    };

    const listArea = new Phaser.Geom.Rectangle(
      width / 2 - listWidth / 2,
      height / 2 + listTop,
      listWidth,
      listHeight
    );
    const handleWheel = (pointer, _over, dx, dy) => {
      if (!Phaser.Geom.Rectangle.Contains(listArea, pointer.worldX, pointer.worldY)) return;
      const step = Math.min(Math.abs(dy) * 0.35, 60) * Math.sign(-dy || 1);
      applyScroll(step);
    };
    this.input.on('wheel', handleWheel);
    this.loadPopup.once('destroy', () => {
      this.input.off('wheel', handleWheel);
      maskGfx.destroy();
    });

    if (slots.length === 0) {
      slotsContainer.add(this.add.text(0, listTop + listHeight / 2, 'No saved games found', {
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

        const btnY = listTop + 20 + i * slotSpacing;
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
        slotsContainer.add(btn);

        if (partyPreview) {
          const previewText = this.add.text(0, btnY + 20, partyPreview, {
            fontSize: '14px',
            color: '#cccccc',
            wordWrap: { width: listWidth - 20 }
          }).setOrigin(0.5);
          slotsContainer.add(previewText);
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
