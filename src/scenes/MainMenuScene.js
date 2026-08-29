import SceneManager from '../systems/SceneManager.js';
import GameState from '../systems/GameState.js';
import ProgressionManager from '../systems/ProgressionManager.js';
import JournalState from '../systems/JournalState.js';
import { createButton } from '../ui/Button.js';
import { createPanel } from '../ui/GamePanel.js';
import { SoundManager, AUDIO_MANIFEST, MUSIC_MANIFEST } from '../systems/SoundManager.js';
import { setupSceneCursor } from '../ui/cursor.js';

export default class MainMenuScene extends Phaser.Scene {
  constructor() {
    super({ key: 'MainMenuScene' });
  }

  preload() {
    this.load.image('main_menu_bg', 'assets/MainMenu_Background.png');
    AUDIO_MANIFEST.forEach(s => {
      this.load.audio(`sfx_${s.id}`, `assets/audio/${s.file}`);
    });
    const startScreenTrack = MUSIC_MANIFEST.find(m => m.id === 'behelithStartScreen');
    this.load.audio(`music_${startScreenTrack.id}`, [
      `assets/audio/music/${startScreenTrack.file}.ogg`,
      `assets/audio/music/${startScreenTrack.file}.mp3`,
    ]);
  }

  create() {
    SoundManager.init(this);
    SoundManager.playMusic('behelithStartScreen');
    setupSceneCursor(this);
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
      SoundManager.stopMusic();
      // Reset all in-memory state for a clean new game.
      GameState.reset();
      ProgressionManager.reset();
      // Journal read-state lives in localStorage (key 'game.journalState'),
      // NOT in the save slot — so without this it survived across new games
      // and every entry stayed marked read forever once seen. JournalState
      // has always had reset(); nothing called it until now.
      JournalState.reset();
      // Seed the orientation flow — first flag points the player to the bonfire.
      ProgressionManager.setQuestFlag('orientation_bonfire');
      this.sceneManager.enterTown();
    });

    this.createMenuButton('📂 Load Game', width / 2, height / 2 + 40, () => {
      this.showLoadGamePopup();
    });

    this.createMenuButton('⚙️ Settings', width / 2, height / 2 + 100, () => {
      // Reuse the same OptionsOverlay every other Settings entry point uses —
      // launched (not started) so it opens on top of the main menu instead
      // of replacing it.
      if (!this.scene.isActive('OptionsOverlay')) {
        this.scene.launch('OptionsOverlay');
      }
      this.scene.bringToTop('OptionsOverlay');
    });

    this.createMenuButton('❌ Exit', width / 2, height / 2 + 160, () => {
      console.log('Exit - Not supported in browser');
    });

    this.add.text(width - 10, height - 10, 'v0.1 - Dev Build', {
      fontSize: '16px',
      color: '#333333'
    }).setOrigin(1, 1);

    // Stream in the loading-screen art AFTER this menu is already on screen.
    //
    // It can't go in preload(): this scene's preload is what the player waits
    // on before seeing anything at all, and this file is bigger than
    // everything else that preload pulls combined. It also can't be loaded by
    // LoadingScene itself, which builds its UI inside preload() and so needs
    // the texture to already be in the cache.
    //
    // Loading it here means it downloads while the player reads the menu, and
    // LoadingScene falls back to a plain black screen if they click through
    // faster than it arrives.
    if (!this.textures.exists('ruins_load_screen')) {
      this.load.image('ruins_load_screen', 'assets/UIinterface/ruins_LoadScreen.webp');
      this.load.start();
    }
  }

  createMenuButton(label, x, y, callback) {
    createButton(this, x, y, label, callback, 'primary', { fontSize: '24px' })
      .setDepth(2);
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

    // Background — wider and taller so slots don't overlap the title
    const bg = createPanel(this, -280, -260, 560, 520, 'menu');
    this.loadPopup.add(bg);

    this.loadPopup.add(this.add.text(0, -230, 'Select Save Slot', {
      fontSize: '20px',
      color: '#ffffaa'
    }).setOrigin(0.5));

    const listWidth = 520;
    const listHeight = 330;
    const listTop = -200;
    const slotSpacing = 75;
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
    const handleWheel = (pointer, _over, _dx, dy) => {
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
        const btn = createButton(this, 0, btnY, `Slot ${slot}`, () => {
          SoundManager.stopMusic();
          GameState.load(slot);
          this.loadPopup.destroy(true);
          blocker.destroy();
          this.sceneManager.enterTown();
        }, 'primary', { fontSize: '18px' });
        slotsContainer.add(btn);

        if (partyPreview) {
          const previewText = this.add.text(0, btnY + 38, partyPreview, {
            fontSize: '14px',
            color: '#cccccc',
            wordWrap: { width: listWidth - 20 }
          }).setOrigin(0.5);
          slotsContainer.add(previewText);
        }
      });
    }

    // Close button — push below the enlarged list
    const closeBtn = createButton(this, 0, 220, 'Close', () => {
      this.loadPopup.destroy(true);
      blocker.destroy();
    }, 'danger', { fontSize: '18px' });
    this.loadPopup.add(closeBtn);
  }

}
