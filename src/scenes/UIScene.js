import GameState from '../systems/GameState.js';
import StatusBar from '../ui/StatusBar.js';
import { COLORS } from '../ui/styles.js';
import { DEPTH } from '../ui/styles.js';

function getXPNeededForLevel(level) {
  // Example XP curve; adjust as needed
  return 100 + (level - 1) * 150;
}

export default class UIScene extends Phaser.Scene {
  constructor() {
    super({ key: 'UIScene' });
  }
  init(data) {
    this.rightPanelVisible = data?.rightPanelVisible ?? false;
  }
  create() {
    this.bottomMode = 'default'; // 'dialogue', 'combat', etc.
    this.currentEnterAction = null; // holds a function when a confirmation dialogue is open
    this.refreshUI();
    this.events.on('wake', this.refreshUI, this);

    // Listen once for entering Samuel's tent
    this.events.on('enterSamuel', () => {
      this.resetBottomBar();
      const town = this.scene.get('TownScene');
      if (town && town.enterSamuelTent) {
        town.enterSamuelTent();
      } else {
        console.warn('TownScene.enterSamuelTent() not found.');
      }
    });
  }

  // ---------------- Dialogue / Confirmation UI ----------------

  /**
   * Simple dialogue (no Enter action, just Close).
   * Use this for flavor text / narration.
   */
  showDialogue(message) {
    this.showConfirmationDialogue(message, null);
  }

  /**
   * Confirmation / interactive dialogue.
   * @param {string} message - Text to display.
   * @param {Function|null} onEnter - Callback to run if player clicks [ Enter ].
   */
  showConfirmationDialogue(message, onEnter) {
    this.bottomMode = 'dialogue';
    this.currentEnterAction = (typeof onEnter === 'function') ? onEnter : null;

    // Ensure elements exist (defensive; they are built in buildUI)
    if (!this.bottomBar || !this.bottomText) {
      console.warn('Dialogue UI elements missing (buildUI may not have run yet).');
      return;
    }

    // Show base elements
    this.bottomBar.setVisible(true);
    this.bottomText
      .setText(
        message +
        (this.currentEnterAction ? '\n\n(Enter / Close)' : '\n\n(Close)')
      )
      .setVisible(true);

    // Buttons: Enter only if there is a callback
    if (this.dialogueEnterButton) {
      this.dialogueEnterButton.setVisible(!!this.currentEnterAction);
    }
    if (this.dialogueCloseButton) {
      this.dialogueCloseButton.setVisible(true);
    }
  }

  /**
   * Hides all dialogue UI and clears any pending Enter callback.
   */
  resetBottomBar() {
    this.bottomMode = 'default';
    this.currentEnterAction = null;

    if (this.bottomBar) this.bottomBar.setVisible(false);
    if (this.bottomText) this.bottomText.setVisible(false);
    if (this.dialogueEnterButton) this.dialogueEnterButton.setVisible(false);
    if (this.dialogueCloseButton) this.dialogueCloseButton.setVisible(false);
  }

  refreshUI() {
    const { width, height } = this.sys.game.canvas;
    console.log("Refreshing UI");

    if (this.leftPartyPanel) {
      this.leftPartyPanel.destroy(true);
    }

    // Clear and rebuild all UI
    this.buildUI(width, height);

    // Apply correct visibility to the right panel
    if (this.rightPanel) {
      this.rightPanel.setVisible(this.rightPanelVisible);
    }

    if (this.toggleButton) {
      this.toggleButton.setText(this.rightPanelVisible ? '◀' : '▶');
    }

  }

  buildUI(width, height) {
    this.children.removeAll(true);
    const leftPanelWidth = 180;
    const rightPanelWidth = 180;

    // LEFT PANEL background 
    this.leftPanelBg = this.add.rectangle(
      leftPanelWidth / 2,
      height / 2,
      leftPanelWidth,
      height,
      0x222222,
      0.85
    )
      .setOrigin(0.5)
      .setDepth(DEPTH.UI_BASE)
      .setScrollFactor(0);

    this.add.image(width - 90, height / 2, 'sidebar_left')  // 90 centers it in a 180px-wide space
      .setOrigin(0.5)
      .setDepth(DEPTH.UI_BASE)
      .setScrollFactor(0);

    this.add.rectangle(width - 90, height / 2, 180, height, 0x000000, 0.4)
      .setOrigin(0.5)
      .setDepth(DEPTH.UI_BASE)
      .setScrollFactor(0);


    // ▶️ RIGHT PANEL

    this.rightPanel = this.add.container(width - rightPanelWidth / 2, height / 2);
    this.rightPanel.setDepth(DEPTH.UI_BASE).setScrollFactor(0);
    this.rightPanel.setVisible(this.rightPanelVisible); // ⬅️ NEW: respect collapsed state

    const bg = this.add.rectangle(0, 0, rightPanelWidth, height, 0x222222, 0.95)
      .setOrigin(0.5);
    this.rightPanel.add(bg);

    const menuItems = [
      {
        label: '🧍 Character',
        action: () => {
          if (!this.scene.isActive('CharacterListOverlay')) {
            this.scene.launch('CharacterListOverlay');
            this.scene.bringToTop('CharacterListOverlay');
          }
        }
      },
      {
        label: '🧑‍🤝‍🧑 Party',
        action: () => {
          if (!this.scene.isActive('PartyManagementScene')) {
            this.scene.launch('PartyManagementScene');
            this.scene.bringToTop('PartyManagementScene');
          }
        }
      },
      {
        label: '🧳 Inventory',
        action: () => {
          if (!this.scene.isActive('InventoryOverlay')) {
            this.scene.launch('InventoryOverlay');
            this.scene.bringToTop('InventoryOverlay');
          }
        }
      },
      {
        label: '🗡️ Skills',
        action: () => {
          if (!this.scene.isActive('SkillsOverlay')) {
            this.scene.launch('SkillsOverlay');
            this.scene.bringToTop('SkillsOverlay');
          }
        }
      },
      { label: '🗺️ Map', action: () => this.openOverlay('MapOverlay') },
      { label: '📜 Quest', action: () => this.openOverlay('QuestOverlay') },
      { label: '📖 Journal', action: () => this.openOverlay('JournalOverlay') },
      { label: '⚙️ Options', action: () => this.openOverlay('OptionsOverlay') },
      { label: '💾 Save', action: () => this.createSaveSlotPopup() },
      { label: '🔁 Load', action: () => this.createLoadSlotPopup() },
      { label: '🚪 Exit', action: () => this.exitToMainMenu() }
    ];

    const totalItems = menuItems.length;
    const spacing = 30;
    const totalHeight = spacing * totalItems;
    const menuStartY = -totalHeight / 2 + 20;

    menuItems.forEach((item, index) => {
      const y = menuStartY + index * spacing;
      const btn = this.createSidebarButton(item.label, item.action, 0, y);
      this.rightPanel.add(btn);
    });

    // === DIALOGUE BAR (fixed 180px margins) ===
    const DIALOG_LEFT_MARGIN = 180;
    const DIALOG_RIGHT_MARGIN = 180;
    const dialogFullWidth = width;
    const dialogueWidth = dialogFullWidth - DIALOG_LEFT_MARGIN - DIALOG_RIGHT_MARGIN; // 920 at 1280 width
    const dialogueCenterX = DIALOG_LEFT_MARGIN + dialogueWidth / 2;
    const dialogueCenterY = height - 75;
    const dialogueHeight = 150;

    this.bottomBar = this.add.rectangle(
      dialogueCenterX,
      dialogueCenterY,
      dialogueWidth,
      dialogueHeight,
      0x111111,
      0.85
    )
      .setStrokeStyle(2, 0xffffff)
      .setDepth(DEPTH.UI_BASE)
      .setVisible(false);

    this.bottomText = this.add.text(
      DIALOG_LEFT_MARGIN + 20,
      dialogueCenterY - dialogueHeight / 2 + 30,
      '',
      {
        fontSize: '18px',
        color: '#ffffff',
        wordWrap: { width: dialogueWidth - 40 }
      }
    )
      .setDepth(DEPTH.UI_OVERLAY)
      .setVisible(false);

    // Buttons (fixed offsets near right edge)
    this.dialogueEnterButton = this.add.text(
      DIALOG_LEFT_MARGIN + dialogueWidth - 240,
      dialogueCenterY + 25,
      '[ Enter ]',
      { fontSize: '18px', color: '#88ff88' }
    )
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => {
        if (this.currentEnterAction) {
          // Save then clear to avoid accidental re-use
          const fn = this.currentEnterAction;
          this.currentEnterAction = null;
          this.resetBottomBar();
          fn();
        }
      })
      .setDepth(DEPTH.UI_OVERLAY)
      .setVisible(false);

    this.dialogueCloseButton = this.add.text(
      DIALOG_LEFT_MARGIN + dialogueWidth - 140,
      dialogueCenterY + 25,
      '[ Close ]',
      { fontSize: '18px', color: '#ff8888' }
    )
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => {
        this.currentEnterAction = null;
        this.resetBottomBar();
      })
      .setDepth(DEPTH.UI_OVERLAY)
      .setVisible(false);

    // ▶️ TOGGLE BUTTON
    this.toggleButton = this.add.text(width - 10, 10, this.rightPanelVisible ? '◀' : '▶', {
      fontSize: '18px',
      color: '#ffffff',
      backgroundColor: '#000000',
      padding: { x: 4, y: 2 }
    }).setOrigin(1, 0)
      .setInteractive({ useHandCursor: true })
      .setScrollFactor(0)
      .setDepth(DEPTH.UI_OVERLAY + 1)
      .on('pointerdown', () => {
        this.toggleRightPanel();
        this.toggleButton.setText(this.rightPanelVisible ? '◀' : '▶');
      });



    // === DECORATIVE FRAME (drawn last so it sits above the sidebars) ===
    this.uiFrame = this.add.image(width / 2, height / 2, 'ui_frame')
      .setScrollFactor(0)
      .setDepth(DEPTH.UI_OVERLAY)


    const startY = 80;
    const spacingY = 90;
    const leftPanelX = 0;

    // 📦 Create a container for party UI elements
    this.leftPartyPanel = this.add.container(leftPanelX, 0).setDepth(DEPTH.UI_OVERLAY);

    GameState.party.forEach((char, i) => {
      const panelY = startY + i * spacingY;
      const centerX = leftPanelWidth / 2;

      const barWidth = 130;
      const barX = (leftPanelWidth - barWidth) / 2;

      // Name and Level (centered)
      const nameText = this.add.text(centerX, panelY, `${char.name} (Lv ${char.level})`, {
        fontSize: '18px',
        color: '#ffffff',
        fontStyle: 'bold'
      }).setOrigin(0.5, 0);  // Center horizontally

      // Determine center X of the left panel
      const panelCenterX = leftPanelWidth / 2;

      // HP / MP Bars (centered by X position)
      const hpBar = new StatusBar(this, panelCenterX, panelY + 22, barWidth, 8, char.currentHP, char.maxHP, 0xff4444, 'HP');
      const mpBar = new StatusBar(this, panelCenterX, panelY + 34, barWidth, 8, char.currentMP, char.maxMP, 0x4444ff, 'MP');

      // XP Bar (centered by X position)
      const xpColor = 0xffff66; // Always yellow for XP
      const xpBar = new StatusBar(
        this,
        panelCenterX,
        panelY + 46,
        barWidth,
        4,
        char.experience,
        getXPNeededForLevel(char.level),
        xpColor,
        0x222222
      );


      // Class label
      const classColors = {
        Beggar: '#bbbbbb',
        Acolyte: '#ffe680',
        Performer: '#ffb3ff',
        Grunt: '#ff9999',
        Scholar: '#88c7ff',
        Shepherd: '#c3ffa1'
      };
      const classLabel = char.specialization
        ? `${char.baseClass} – ${char.specialization}`
        : `${char.baseClass}`;
      const classColor = classColors[char.baseClass] || '#aaaaaa';

      const classText = this.add.text(centerX, panelY + 50, classLabel, {
        fontSize: '18px',
        color: classColor,
        fontStyle: 'bold',
        fontFamily: 'Georgia'
      }).setOrigin(0.5, 0);  // Centered

      // Favor
      const favorText = this.add.text(centerX, panelY + 70, `Favor: ${char.favor}`, {
        fontSize: '12px',
        color: '#88ccff',
        fontStyle: 'bold',
        fontFamily: 'Georgia'
      }).setOrigin(0.5, 0);  // Centered

      this.leftPartyPanel.add([nameText, hpBar, mpBar, xpBar, classText, favorText]);
    });


  }

  createSidebarButton(label, action, x, y) {
    const btn = this.add.text(x, y, label, {
      fontSize: '18px',
      color: '#ffffff'
    }).setOrigin(0.5).setInteractive({ useHandCursor: true }).setScrollFactor(0).setDepth(1001)
      .on('pointerdown', action)
      .on('pointerover', () => btn.setStyle({ color: '#ffffaa' }))
      .on('pointerout', () => btn.setStyle({ color: '#ffffff' }));
    return btn;
  }

  openOverlay(key) {
    if (!this.scene.isActive(key)) {
      this.scene.launch(key);
    }
    this.scene.bringToTop(key);
  }

  exitToMainMenu() {
    this.cleanupPopup?.();
    const overlays = [
      'CharacterListOverlay',
      'InventoryOverlay',
      'SkillsOverlay',
      'MapOverlay',
      'OptionsOverlay',
      'JournalOverlay',
      'QuestOverlay',
      'PartyManagementScene'
    ];
    overlays.forEach(key => {
      if (this.scene.isActive(key)) {
        this.scene.stop(key);
      }
    });

    if (this.scene.isActive('TownScene')) {
      this.scene.stop('TownScene');
    }

    this.scene.start('MainMenuScene');
  }


  createSaveSlotPopup() {
    this.cleanupPopup?.();

    const w = this.sys.game.canvas.width;
    const h = this.sys.game.canvas.height;

    // 1) FULL-SCREEN BLOCKER (transparent, eats clicks; below UI)
    this.modalBlockerGroup = this.add.container(0, 0)
      .setDepth(DEPTH.MODAL_BLOCKER)
      .setScrollFactor(0);

    const blocker = this.add.rectangle(w / 2, h / 2, w, h, 0x000000, 0.0) // alpha 0
      .setOrigin(0.5)
      .setInteractive(); // blocks input to TownScene
    this.modalBlockerGroup.add(blocker);

    // 2) PANEL GROUP (above everything UI)
    this.modalPanelGroup = this.add.container(0, 0)
      .setDepth(DEPTH.MODAL_PANEL)
      .setScrollFactor(0);

    // 🔄 NO halo/dim rectangle here. Just the panel itself:
    const panelW = 420, panelH = 200;
    const panel = this.add.rectangle(w / 2, h / 2, panelW, panelH, 0x111111, 0.95)
      .setOrigin(0.5)
      .setStrokeStyle(2, 0xffffff);
    const title = this.add.text(w / 2, h / 2 - 70, 'Enter Save Name:', {
      fontSize: '20px', color: '#fff'
    }).setOrigin(0.5);

    this.modalPanelGroup.add([panel, title]);

    // DOM input
    this.nameInputDOM = this.add.dom(w / 2, h / 2 - 25).createFromHTML(`
  <input type="text" name="saveName" placeholder="Save name"
         style="font-size:18px;padding:5px;width:260px;">
`);
    this.modalPanelGroup.add(this.nameInputDOM);

    // Buttons
    const saveBtn = this.add.text(w / 2 - 70, h / 2 + 50, '[ Save ]', { fontSize: '18px', color: '#ffffff' })
      .setOrigin(0.5).setInteractive({ useHandCursor: true })
      .on('pointerdown', () => {
        const nm = this.nameInputDOM.getChildByName('saveName').value.trim();
        if (nm) GameState.save(nm);
        this.cleanupPopup();
      })
      .on('pointerover', () => saveBtn.setStyle({ color: '#ffffaa' }))
      .on('pointerout', () => saveBtn.setStyle({ color: '#ffffff' }));

    const cancelBtn = this.add.text(w / 2 + 70, h / 2 + 50, '[ Cancel ]', { fontSize: '18px', color: '#ffffff' })
      .setOrigin(0.5).setInteractive({ useHandCursor: true })
      .on('pointerdown', () => this.cleanupPopup())
      .on('pointerover', () => cancelBtn.setStyle({ color: '#ffffaa' }))
      .on('pointerout', () => cancelBtn.setStyle({ color: '#ffffff' }));

    this.modalPanelGroup.add([saveBtn, cancelBtn]);

  }



  createLoadSlotPopup() {
    this.cleanupPopup?.();

    const w = this.sys.game.canvas.width;
    const h = this.sys.game.canvas.height;

    // 1) Transparent full-screen blocker: blocks TownScene, NOT your UI
    this.modalBlockerGroup = this.add.container(0, 0)
      .setDepth(DEPTH.MODAL_BLOCKER)   // e.g. 900 (below UI, above world)
      .setScrollFactor(0);

    const blocker = this.add.rectangle(w / 2, h / 2, w, h, 0x000000, 0.0) // alpha 0 (no halo)
      .setOrigin(0.5)
      .setInteractive(); // eats clicks so TownScene can't
    this.modalBlockerGroup.add(blocker);

    // 2) Panel group: ABOVE everything visual
    this.modalPanelGroup = this.add.container(0, 0)
      .setDepth(DEPTH.MODAL_PANEL)     // e.g. 2100 (above menus/UI)
      .setScrollFactor(0);

    // Panel (no semi-transparent "dim" behind; just the panel)
    const panelW = 420, panelH = 360;
    const panel = this.add.rectangle(w / 2, h / 2, panelW, panelH, 0x111111, 0.95)
      .setOrigin(0.5)
      .setStrokeStyle(2, 0xffffff);

    const title = this.add.text(w / 2, h / 2 - (panelH / 2) + 30, 'Select Save Slot:', {
      fontSize: '20px', color: '#fff'
    }).setOrigin(0.5, 0.5);

    this.modalPanelGroup.add([panel, title]);

    // Slots
    const slots = GameState.listSaveSlots();
    const startY = h / 2 - 110;
    slots.forEach((sl, i) => {
      const y = startY + i * 40;

      const slotText = this.add.text(w / 2 - 120, y, sl, {
        fontSize: '18px', color: '#fff'
      })
        .setOrigin(0, 0.5)
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', () => {
          GameState.load(sl);
          this.cleanupPopup();
          this.refreshUI?.();
        })
        .on('pointerover', () => slotText.setStyle({ color: '#ff0' }))
        .on('pointerout', () => slotText.setStyle({ color: '#fff' }));

      const deleteBtn = this.add.text(w / 2 + 130, y, '[🗑️]', {
        fontSize: '16px', color: '#ff5555'
      })
        .setOrigin(0.5)
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', () => this.confirmDeleteSlot(sl))
        .on('pointerover', () => deleteBtn.setStyle({ color: '#ff0000' }))
        .on('pointerout', () => deleteBtn.setStyle({ color: '#ff5555' }));

      this.modalPanelGroup.add([slotText, deleteBtn]);
    });

    // Cancel button
    const cancelBtn = this.add.text(w / 2, h / 2 + (panelH / 2) - 25, '[ Cancel ]', {
      fontSize: '18px', color: '#ffffff'
    })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => this.cleanupPopup())
      .on('pointerover', () => cancelBtn.setStyle({ color: '#ffffaa' }))
      .on('pointerout', () => cancelBtn.setStyle({ color: '#ffffff' }));

    this.modalPanelGroup.add(cancelBtn);
  }


  // Replace your addButton with this (same signature)
  addButton(x, y, label, callback) {
    const btn = this.add.text(x, y, `[ ${label} ]`, {
      fontSize: '20px',
      color: '#ffffff',
      backgroundColor: '#444',
      padding: { x: 10, y: 5 }
    })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', callback)
      .on('pointerover', () => btn.setStyle({ color: '#ffffaa' }))
      .on('pointerout', () => btn.setStyle({ color: '#ffffff' }));

    // ✅ ensure popup layering is consistent
    if (this.popupGroup) this.popupGroup.add(btn);

    this.popupButtons.push(btn);
  }

  cleanupPopup() {
    if (this.nameInputDOM) { this.nameInputDOM.destroy(); this.nameInputDOM = null; }
    if (this.modalPanelGroup) { this.modalPanelGroup.destroy(true); this.modalPanelGroup = null; }
    if (this.modalBlockerGroup) { this.modalBlockerGroup.destroy(true); this.modalBlockerGroup = null; }
  }

  showSelectionMenu(title, options) {
    this.cleanupPopup();

    const w = this.sys.game.canvas.width;
    const h = this.sys.game.canvas.height;
    this.popupGroup = this.add.container(0, 0).setDepth(DEPTH.MENU).setScrollFactor(0);
    this.popupButtons = [];

    // Dark background overlay
    const overlay = this.add.rectangle(w / 2, h / 2, w, h, 0x000000, 0.7)
      .setOrigin(0.5)


    // Title
    const titleText = this.add.text(220, 80, title, {
      fontSize: '26px',
      color: '#ffffff',
      fontStyle: 'bold'
    }).setOrigin(0, 0.5)


    // Increased vertical spacing for left column
    const spacing = 75;
    const totalHeight = options.length * spacing;
    let startY = (h / 2) - (totalHeight / 2);

    // Right detail panel (moved further left)
    const panelX = w - 500;
    const detailPanel = this.add.rectangle(panelX, h / 2, 400, 500, 0x222222, 0.95)
      .setStrokeStyle(2, 0xffffff)


    const detailTitle = this.add.text(panelX, h / 2 - 200, '', {
      fontSize: '22px',
      color: '#ffffff',
      fontStyle: 'bold',
      wordWrap: { width: 360 }
    }).setOrigin(0.5, 0)


    const detailDesc = this.add.text(panelX, h / 2 - 160, '', {
      fontSize: '16px',
      color: '#dddddd',
      wordWrap: { width: 360 }
    }).setOrigin(0.5, 0)


    const detailPortrait = this.add.image(panelX, h / 2 + 50, '')

      .setVisible(false);

    // Fight button (starts disabled)
    const fightButton = this.add.text(panelX, h / 2 + 230, '[ Fight ]', {
      fontSize: '20px',
      color: '#555555',
      backgroundColor: '#222222',
      padding: { x: 10, y: 5 }
    }).setOrigin(0.5)

      .setInteractive({ useHandCursor: false })
      .setVisible(true);

    // Left-side options
    options.forEach((opt, index) => {
      const yPos = startY + index * spacing;

      const optionText = this.add.text(220, yPos, `[ ${opt.label} ]`, {
        fontSize: '20px',
        color: '#cccccc',
        backgroundColor: '#333333',
        padding: { x: 10, y: 5 }
      }).setOrigin(0, 0.5)

        .setInteractive({ useHandCursor: true })
        .on('pointerdown', () => {
          // Update detail panel
          detailTitle.setText(opt.label);
          detailDesc.setText(opt.longDescription || opt.description || '');
          if (opt.portraitKey) {
            detailPortrait.setTexture(opt.portraitKey).setVisible(true);
          } else {
            detailPortrait.setVisible(false);
          }

          // Enable fight button
          fightButton._startScenario = opt.onSelect;
          fightButton.setStyle({ color: '#cccccc', backgroundColor: '#333333' });
          fightButton.setInteractive({ useHandCursor: true });
          fightButton.removeAllListeners('pointerdown');
          fightButton.on('pointerdown', () => {
            this.cleanupPopup();
            fightButton._startScenario();
          });
        })
        .on('pointerover', () => optionText.setStyle({ color: '#ffffaa' }))
        .on('pointerout', () => optionText.setStyle({ color: '#cccccc' }));

      const descText = this.add.text(220, yPos + 20, opt.description || '', {
        fontSize: '14px',
        color: '#aaaaaa',
        wordWrap: { width: 200 }
      }).setOrigin(0, 0)


      this.popupButtons.push(optionText, descText);
    });

    // === Exit Button ===
    // Position it 40px below the last option row
    const exitButtonY = startY + options.length * spacing + 40;

    const exitButton = this.add.text(220, exitButtonY, '[ Exit ]', {
      fontSize: '18px',
      color: '#cccccc',
      backgroundColor: '#333333',
      padding: { x: 8, y: 4 }
    }).setOrigin(0, 0.5)

      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => {
        this.cleanupPopup();
      })
      .on('pointerover', () => exitButton.setStyle({ color: '#ffffaa' }))
      .on('pointerout', () => exitButton.setStyle({ color: '#cccccc' }));

    this.popupButtons.push(exitButton);

    // Add everything to the group
    // Add in this order:
    this.popupGroup.add(overlay);            // first = back
    this.popupGroup.add(titleText);
    this.popupGroup.add(detailPanel);
    this.popupGroup.add([detailTitle, detailDesc, detailPortrait, fightButton]);
    // add options + exit last
    this.popupGroup.add([...this.popupButtons]);
  }



  confirmDeleteSlot(slotName) {
    const w = this.sys.game.canvas.width;
    const h = this.sys.game.canvas.height;

    // Close any existing modal
    this.cleanupPopup?.();

    // 1) Invisible full-screen blocker: ABOVE world, BELOW persistent UI
    this.modalBlockerGroup = this.add.container(0, 0)
      .setDepth(DEPTH.MODAL_BLOCKER)
      .setScrollFactor(0);

    const blocker = this.add.rectangle(w / 2, h / 2, w, h, 0x000000, 0)
      .setOrigin(0.5)
      .setInteractive(); // eats clicks so TownScene can’t

    this.modalBlockerGroup.add(blocker);

    // 2) Panel group: ABOVE everything (panel, text, buttons)
    this.modalPanelGroup = this.add.container(0, 0)
      .setDepth(DEPTH.MODAL_PANEL)
      .setScrollFactor(0);

    // Local dim ONLY around the dialog (doesn't cover right UI)
    const dim = this.add.rectangle(w / 2, h / 2, 460, 220, 0x000000, 0.5).setOrigin(0.5);
    const panel = this.add.rectangle(w / 2, h / 2, 400, 150, 0x111111, 0.95)
      .setOrigin(0.5)
      .setStrokeStyle(2, 0xffffff);

    const title = this.add.text(w / 2, h / 2 - 38, `Delete "${slotName}"?`, {
      fontSize: '20px',
      color: '#ffffff'
    }).setOrigin(0.5);

    // Buttons (use closures; don't use pointer arg for setStyle)
    const yesBtn = this.add.text(w / 2 - 60, h / 2 + 35, '[ Yes ]', {
      fontSize: '18px',
      color: '#ffffff'
    }).setOrigin(0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => {
        GameState.deleteSlot(slotName);
        this.cleanupPopup();
        this.createLoadSlotPopup(); // reopen list after delete
      })
      .on('pointerover', () => yesBtn.setStyle({ color: '#ffffaa' }))
      .on('pointerout', () => yesBtn.setStyle({ color: '#ffffff' }));

    const noBtn = this.add.text(w / 2 + 60, h / 2 + 35, '[ No ]', {
      fontSize: '18px',
      color: '#ffffff'
    }).setOrigin(0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => {
        this.cleanupPopup();
        this.createLoadSlotPopup(); // go back to list
      })
      .on('pointerover', () => noBtn.setStyle({ color: '#ffffaa' }))
      .on('pointerout', () => noBtn.setStyle({ color: '#ffffff' }));

    this.modalPanelGroup.add([dim, panel, title, yesBtn, noBtn]);
  }

  resize(gameSize) {
    this.buildUI(gameSize.width, gameSize.height);
  }
  updateBottomText(message) {
    if (this.bottomText) {
      this.bottomText.setText(message).setVisible(true);
      if (this.bottomBar) this.bottomBar.setVisible(true);
    }
  }
  toggleRightPanel() {
    this.rightPanelVisible = !this.rightPanelVisible;

    if (this.rightPanel) {
      this.rightPanel.setVisible(this.rightPanelVisible);
    }
  }

}

