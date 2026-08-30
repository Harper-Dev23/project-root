import GameState from '../systems/GameState.js';
import StatusBar from '../ui/StatusBar.js';
import { COLORS, DEPTH, MENU_THEME } from '../ui/styles.js';
import { createPanel } from '../ui/GamePanel.js';
import { createButton } from '../ui/Button.js';
import { SoundManager } from '../systems/SoundManager.js';
import { JournalState } from '../systems/JournalState.js';
import { registerHotkeys } from '../systems/HotkeyManager.js';
import ProgressionManager from '../systems/ProgressionManager.js';
import { anyQuestTabHasNew } from './overlays/QuestOverlay.js';
import { setupSceneCursor } from '../ui/cursor.js';

// Every menu overlay scene key. Hoisted to module scope (was a local inside
// create()) so other scenes can ask "is a menu already open?" before layering
// something on top -- TownScene's quest markers need exactly that check.
export const MENU_OVERLAY_KEYS = [
  'CharacterListOverlay', 'InventoryOverlay', 'SkillsOverlay',
  'MapOverlay', 'OptionsOverlay', 'JournalOverlay', 'QuestOverlay',
  'TribeRelationsOverlay', 'PartyManagementScene', 'CampRosterOverlay',
];

function getXPNeededForLevel(level) {
  // Example XP curve; adjust as needed
  return 100 + (level - 1) * 150;
}

export default class UIScene extends Phaser.Scene {
  constructor() {
    super({ key: 'UIScene' });
  }
  init(data) {
    // Defaults to OPEN. It used to default closed, which meant a new player's
    // entire menu -- Character, Party, Inventory, Skills, Map, Quest, Tribes --
    // sat behind an unlabelled 18px "|>" in the corner with nothing pointing at
    // it, including the Quest Log that explains what to do next. Nothing ever
    // passed `true`, so it was closed on every single launch. Collapsing is
    // still one click for players who want the screen space.
    this.rightPanelVisible = data?.rightPanelVisible ?? true;
  }
  create() {
    SoundManager.init(this);
    setupSceneCursor(this);
    this.bottomMode = 'default'; // 'dialogue', 'combat', etc.
    this.currentEnterAction = null; // holds a function when a confirmation dialogue is open
    this.refreshUI();
    this.events.on('wake', this.refreshUI, this);

        // ── Hotkeys ────────────────────────────────────────────────────────
    // All overlay scene keys — used to guard against stacking overlays via hotkeys.
    // Returns true if any overlay is currently running.
    const _anyOverlayOpen = () => this.anyMenuOverlayOpen();

    this._cleanupHotkeys = registerHotkeys(this, {
      menu_character: () => {
        if (_anyOverlayOpen()) return;
        SoundManager.play('select');
        this.scene.launch('CharacterListOverlay');
        this.scene.bringToTop('CharacterListOverlay');
      },
      menu_party: () => {
        if (_anyOverlayOpen()) return;
        SoundManager.play('select');
        this.scene.launch('PartyManagementScene');
        this.scene.bringToTop('PartyManagementScene');
      },
      menu_inventory: () => {
        if (_anyOverlayOpen()) return;
        SoundManager.play('select');
        this.scene.launch('InventoryOverlay');
        this.scene.bringToTop('InventoryOverlay');
      },
      menu_skills: () => {
        if (_anyOverlayOpen()) return;
        SoundManager.play('select');
        this.scene.launch('SkillsOverlay');
        this.scene.bringToTop('SkillsOverlay');
      },
      menu_map:     () => { if (!_anyOverlayOpen()) { SoundManager.play('select'); this.openOverlay('MapOverlay'); } },
      menu_quest:   () => { if (!_anyOverlayOpen()) { SoundManager.play('select'); this.openOverlay('QuestOverlay'); } },
      menu_tribes:  () => {
        if (_anyOverlayOpen()) return;
        if (!ProgressionManager.tribe) return;
        SoundManager.play('select');
        if (!this.scene.isActive('TribeRelationsOverlay')) {
          this.scene.launch('TribeRelationsOverlay');
        }
        this.scene.bringToTop('TribeRelationsOverlay');
      },
      menu_journal: () => { if (!_anyOverlayOpen()) { SoundManager.play('select'); this.openOverlay('JournalOverlay'); } },
      menu_options: () => { if (!_anyOverlayOpen()) { SoundManager.play('select'); this.openOverlay('OptionsOverlay'); } },
    });

    // ESC: registered once here so _anyOverlayOpen is in scope and handler never stacks.
    // Priority 1 → dismiss popup. Priority 2 → let overlay's own ESC close it. Priority 3 → toggle panel.
    this.input.keyboard?.on('keydown-ESC', () => {
      if (this.modalPanelGroup || this.modalBlockerGroup) {
        this.cleanupPopup?.();
        return;
      }
      if (_anyOverlayOpen()) return; // each overlay's OverlayFrame registers its own ESC handler
      SoundManager.play('select');
      this.toggleRightPanel();
      this.toggleButton?.setText(this.rightPanelVisible ? '◀' : '▶');
    });

    this.journalToastOff = JournalState.on('journal:toast', ({ message } = {}) => {
      this.showToast(message || 'New Journal entry');
    });

    this.events.once('shutdown', () => {
      this._cleanupHotkeys?.();
      this.journalToastOff?.();
      this.journalToastOff = null;
    }, this);
    this.events.once('destroy', () => {
      this._cleanupHotkeys?.();
      this.journalToastOff?.();
      this.journalToastOff = null;
    }, this);


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

    // Show base elements. Used to append a literal "(Enter / Close)" /
    // "(Close)" hint to the message text itself — same color as the body,
    // not actually clickable, so it read as a second (broken-looking) close
    // affordance sitting right next to the real, working [ Close ] button.
    // The real Enter/Close buttons below already say what they do.
    this.bottomBar.setVisible(true);
    this.bottomText
      .setText(message)
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

  /**
   * Keeps the left party panel's HP/MP bars synced to live character data
   * every frame, instead of relying solely on a full refreshUI() rebuild
   * (which only fires on specific events and can silently fall out of sync
   * if one of those events doesn't fire when expected). Name/level/XP/favor
   * text still only updates on a full rebuild — those change far less often.
   */
  update() {
    if (!this._partyStatusBars) return;
    this._partyStatusBars.forEach(({ char, hpBar, mpBar }) => {
      if (!char) return;
      hpBar?.updateCurrent(char.currentHP);
      mpBar?.updateCurrent(char.currentMP);
    });
  }

  buildUI(width, height) {
    // Kill any leftover tweens (e.g. the infinite-repeat alert-dot pulse on
    // Quest/Tribes) BEFORE wiping the display list — a tween still targeting
    // an object this removeAll() is about to destroy can otherwise keep
    // ticking against a dead object for a frame, which is the most likely
    // source of a stray/duplicate-looking dot after a rebuild.
    this.tweens.killAll();
    this.children.removeAll(true);
    const leftPanelWidth = 180;
    const rightPanelWidth = 180;

    // LEFT PANEL background
    this.leftPanelBg = createPanel(this, 0, 0, leftPanelWidth, height, 'default')
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

    const bg = createPanel(this, -rightPanelWidth / 2, -height / 2, rightPanelWidth, height, 'default');
    this.rightPanel.add(bg);

    const menuItems = [
      {
        label: '🧍 Character',
        alertDot: GameState.party?.some(c => (c.unspentStatPoints || 0) > 0),
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
      { label: '📜 Quest', action: () => this.openOverlay('QuestOverlay'), alertDot: anyQuestTabHasNew() },
      ...(ProgressionManager.tribe ? [{
        label: '🛡 Tribes',
        alertDot: !ProgressionManager.hasQuestFlag('tribes_button_seen'),
        action: () => {
          ProgressionManager.setQuestFlag('tribes_button_seen');
          if (!this.scene.isActive('TribeRelationsOverlay')) {
            this.scene.launch('TribeRelationsOverlay');
            this.scene.bringToTop('TribeRelationsOverlay');
          }
        },
      }] : []),
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

      if (item.alertDot) {
        // Small pulsing dot in the top-right corner of the button
        const dot = this.add.circle(76, y - 8, 5, 0xffdd44)
          .setDepth(1002).setScrollFactor(0);
        this.tweens.add({
          targets: dot, alpha: 0.3, duration: 700,
          yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
        });
        this.rightPanel.add(dot);
      }
    });

    // Match each freshly-built button's interactivity to the panel's
    // current visibility — see toggleRightPanel()/_setRightPanelChildrenInteractive.
    this._setRightPanelChildrenInteractive(this.rightPanelVisible);

    // === DIALOGUE BAR (fixed 180px margins) ===
    const DIALOG_LEFT_MARGIN = 180;
    const DIALOG_RIGHT_MARGIN = 180;
    const dialogFullWidth = width;
    const dialogueWidth = dialogFullWidth - DIALOG_LEFT_MARGIN - DIALOG_RIGHT_MARGIN; // 920 at 1280 width
    const dialogueCenterX = DIALOG_LEFT_MARGIN + dialogueWidth / 2;
    const dialogueCenterY = height - 75;
    const dialogueHeight = 150;

    this.bottomBar = createPanel(this,
      dialogueCenterX - dialogueWidth / 2,
      dialogueCenterY - dialogueHeight / 2,
      dialogueWidth, dialogueHeight, 'default')
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
        SoundManager.play('select');
        this.toggleRightPanel();
        this.toggleButton.setText(this.rightPanelVisible ? '◀' : '▶');
      });

    // ESC handler registered once in create() — see below



    // === DECORATIVE FRAME (drawn last so it sits above the sidebars) ===
    this.uiFrame = this.add.image(width / 2, height / 2, 'ui_frame')
      .setScrollFactor(0)
      .setDepth(DEPTH.UI_OVERLAY)


    // Party list is pinned directly to two fixed screen points instead of
    // being derived from the right panel's button math — simpler, and the
    // right panel's item count can change without affecting this at all.
    // PARTY_LIST_TOP_Y is the top of the topmost member's name text;
    // PARTY_LIST_BOTTOM_Y is the bottom of a FULL (max-size) party's last
    // member's XP bar. spacingY is fixed (computed once for a full party),
    // NOT redivided across however many members currently exist — members
    // just stack sequentially downward from the top at that fixed gap, so a
    // 2-person party sits snugly near the top instead of being stretched to
    // span the whole 185-600 range with a big gap in between.
    const PARTY_LIST_TOP_Y = 185;
    const PARTY_LIST_BOTTOM_Y = 600;
    const MEMBER_CONTENT_BOTTOM_OFFSET = 44; // xpBar's own y-offset (40) + its height (4)
    const MAX_PARTY_SIZE = 6;

    const startY = PARTY_LIST_TOP_Y;
    const spacingY = (PARTY_LIST_BOTTOM_Y - MEMBER_CONTENT_BOTTOM_OFFSET - PARTY_LIST_TOP_Y) / (MAX_PARTY_SIZE - 1);
    const leftPanelX = 0;

    // 📦 Create a container for party UI elements
    this.leftPartyPanel = this.add.container(leftPanelX, 0).setDepth(DEPTH.UI_OVERLAY);

    // Tracked so update() can sync these bars to live character data every
    // frame, independent of whatever triggered the last full rebuild —
    // see UIScene#update().
    this._partyStatusBars = [];

    GameState.party.forEach((char, i) => {
      const panelY = startY + i * spacingY;
      const centerX = leftPanelWidth / 2;

      const barWidth = 130;
      const barX = (leftPanelWidth - barWidth) / 2;

      // Class color for name
      const classColors = {
        Beggar: '#bbbbbb',
        Acolyte: '#ffe680',
        Performer: '#ffb3ff',
        Grunt: '#ff9999',
        Scholar: '#88c7ff',
        Shepherd: '#c3ffa1'
      };
      const classColor = classColors[char.baseClass] || '#ffffff';

      // Name colored by class
      const nameText = this.add.text(centerX, panelY, `${char.name} (Lv ${char.level})`, {
        fontSize: '14px',
        color: classColor,
        fontStyle: 'bold',
        fontFamily: 'Georgia, Gelasio, serif'
      }).setOrigin(0.5, 0);

      const panelCenterX = leftPanelWidth / 2;

      // HP / MP / XP bars — was 16/26/36, but the name text's own height was
      // clipping into the top of the HP bar at 16; +4 to all three keeps
      // their 10px rhythm but adds clearance under the name.
      const hpBar = new StatusBar(this, panelCenterX, panelY + 20, barWidth, 8, char.currentHP, char.maxHP, 0xff4444, 'HP');
      const mpBar = new StatusBar(this, panelCenterX, panelY + 30, barWidth, 8, char.currentMP, char.maxMP, 0x4444ff, 'MP');
      const xpBar = new StatusBar(
        this, panelCenterX, panelY + 40, barWidth, 4,
        char.experience, getXPNeededForLevel(char.level), 0xffff66, 0x222222
      );

      this._partyStatusBars.push({ char, hpBar, mpBar });

      // Favor — was its own row below the XP bar; now a short "★N" tucked
      // just past the XP bar's right edge on the SAME row, instead of taking
      // a whole extra line.
      const favorText = this.add.text(barX + barWidth + 4, panelY + 40, `★${char.favor}`, {
        fontSize: '9px',
        color: '#88ccff',
        fontFamily: 'Georgia, Gelasio, serif'
      }).setOrigin(0, 0.5);

      // Thin separator line after each member except the last
      const items = [nameText, hpBar, mpBar, xpBar, favorText];
      if (i < GameState.party.length - 1) {
        const sep = this.add.graphics();
        sep.lineStyle(1, 0x5a4a3a, 0.6);
        sep.beginPath();
        sep.moveTo(14, panelY + spacingY - 8);
        sep.lineTo(leftPanelWidth - 14, panelY + spacingY - 8);
        sep.strokePath();
        items.push(sep);
      }

      this.leftPartyPanel.add(items);
    });

    this._buildToastLayer(width);

  }

  createSidebarButton(label, action, x, y) {
    const btn = this.add.text(x, y, label, {
      fontSize: '18px',
      color: '#ffffff'
    }).setOrigin(0.5).setInteractive({ useHandCursor: true }).setScrollFactor(0).setDepth(1001)
      .on('pointerdown', () => { SoundManager.play('select'); action(); })
      .on('pointerover', () => btn.setStyle({ color: MENU_THEME.accentHover }))
      .on('pointerout', () => btn.setStyle({ color: '#ffffff' }));
    return btn;
  }

  /** True if any menu overlay scene is currently running. */
  anyMenuOverlayOpen() {
    return MENU_OVERLAY_KEYS.some(k => this.scene.isActive(k));
  }

  openOverlay(key) {
    if (!this.scene.isActive(key)) {
      this.scene.launch(key);
    }
    this.scene.bringToTop(key);
  }

  _buildToastLayer(width) {
    this.toastTimer?.remove();
    this.toastTimer = null;
    this.toastText?.destroy();
    this.toastBg?.destroy();

    // Faded backing box (silver theme) — toasts used to be bare floating
    // text with no background at all, same "clashes with whatever's behind
    // it" problem as TownScene's other ad-hoc text. Sized dynamically per
    // message in showToast() below, since a plain Rectangle (unlike
    // createPanel's Graphics) supports resizing after creation.
    this.toastBg = this.add.rectangle(width / 2, 64, 10, 10, MENU_THEME.panelFill, 0.92)
      .setStrokeStyle(2, MENU_THEME.panelStroke, 0.9)
      .setDepth(DEPTH.UI_OVERLAY - 1)
      .setScrollFactor(0)
      .setAlpha(0)
      .setVisible(false);

    this.toastText = this.add.text(width / 2, 64, '', {
      fontSize: '20px',
      color: MENU_THEME.titleColor,
      fontStyle: 'bold',
      fontFamily: 'Georgia, Gelasio, serif'
    })
      .setOrigin(0.5)
      .setDepth(DEPTH.UI_OVERLAY)
      .setScrollFactor(0)
      .setAlpha(0)
      .setVisible(false);
  }

  showToast(message) {
    if (!this.toastText) return;
    this.toastTimer?.remove();
    this.toastText.setText(message)
      .setVisible(true)
      .setAlpha(1);

    const PAD_X = 24, PAD_Y = 14;
    this.toastBg
      ?.setSize(this.toastText.width + PAD_X * 2, this.toastText.height + PAD_Y * 2)
      .setPosition(this.toastText.x, this.toastText.y)
      .setVisible(true)
      .setAlpha(1);

    this.toastTimer = this.time.addEvent({
      delay: 2200,
      callback: () => {
        this.tweens.add({
          targets: [this.toastText, this.toastBg].filter(Boolean),
          alpha: 0,
          duration: 400,
          onComplete: () => { this.toastText.setVisible(false); this.toastBg?.setVisible(false); }
        });
      }
    });
  }

  exitToMainMenu() {
    if (this.exitConfirmOpen) return;

    this.cleanupPopup?.();
    this.exitConfirmOpen = true;

    const w = this.sys.game.canvas.width;
    const h = this.sys.game.canvas.height;

    this.modalBlockerGroup = this.add.container(0, 0)
      .setDepth(DEPTH.MODAL_BLOCKER)
      .setScrollFactor(0);

    const blocker = this.add.rectangle(w / 2, h / 2, w, h, 0x000000, 0.4)
      .setOrigin(0.5)
      .setInteractive();
    this.modalBlockerGroup.add(blocker);

    this.modalPanelGroup = this.add.container(0, 0)
      .setDepth(DEPTH.MODAL_PANEL)
      .setScrollFactor(0);

    const panel = createPanel(this, w / 2 - 210, h / 2 - 90, 420, 180, 'menu');

    const title = this.add.text(w / 2, h / 2 - 30, 'Exit to main menu?', {
      fontSize: '20px',
      color: '#ffffff'
    }).setOrigin(0.5);

    const yesBtn = this.add.text(w / 2 - 70, h / 2 + 35, '[ Yes ]', {
      fontSize: '18px',
      color: '#ffffff'
    }).setOrigin(0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => this._confirmExitToMainMenu())
      .on('pointerover', () => yesBtn.setStyle({ color: MENU_THEME.accentHover }))
      .on('pointerout', () => yesBtn.setStyle({ color: '#ffffff' }));

    const noBtn = this.add.text(w / 2 + 70, h / 2 + 35, '[ No ]', {
      fontSize: '18px',
      color: '#ffffff'
    }).setOrigin(0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => {
        this.cleanupPopup();
      })
      .on('pointerover', () => noBtn.setStyle({ color: MENU_THEME.accentHover }))
      .on('pointerout', () => noBtn.setStyle({ color: '#ffffff' }));

    this.modalPanelGroup.add([panel, title, yesBtn, noBtn]);
  }

  _confirmExitToMainMenu() {
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
    const slots = GameState.listSaveSlots();

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

    const panelW = 520, panelH = 480;
    const panel = createPanel(this, w / 2 - panelW / 2, h / 2 - panelH / 2, panelW, panelH, 'menu');
    const title = this.add.text(w / 2, h / 2 - (panelH / 2) + 30, 'Enter Save Name:', {
      fontSize: '20px', color: '#fff'
    }).setOrigin(0.5);

    this.modalPanelGroup.add([panel, title]);

    // DOM input
    this.nameInputDOM = this.add.dom(w / 2, h / 2 - 160).createFromHTML(`
  <input type="text" name="saveName" placeholder="Save name"
         style="font-size:18px;padding:6px 8px;width:320px;">
`);
    this.modalPanelGroup.add(this.nameInputDOM);

    const setInputValue = (val) => {
      const input = this.nameInputDOM?.getChildByName('saveName');
      if (input) input.value = val;
    };

    const performSave = (slotName) => {
      // ensure overwrite uses fresh payload
      localStorage.removeItem(`bmSave_${slotName}`);
      GameState.save(slotName);
      // Don't call destroy() on overwriteConfirmGroup directly — it's a child of
      // modalPanelGroup and loses its scene.sys reference when nested. cleanupPopup()
      // destroys modalPanelGroup (and all children) safely.
      this.overwriteConfirmGroup = null;
      this.cleanupPopup();
      this.refreshUI?.();
      this.showToast?.(`Saved to ${slotName}`);
    };

    const showOverwriteConfirm = (slotName) =>
      this._showModalConfirm(`Overwrite "${slotName}"?`, () => performSave(slotName),
        { dimW: panelW + 40, dimH: panelH + 20 });

    // Buttons
    const saveBtn = this.add.text(w / 2 - 80, h / 2 - 100, '[ Save ]', { fontSize: '18px', color: '#ffffff' })
      .setOrigin(0.5).setInteractive({ useHandCursor: true })
      .on('pointerdown', () => {
        const nm = this.nameInputDOM?.getChildByName('saveName')?.value.trim();
        if (!nm) return;
        setInputValue(nm);
        if (slots.includes(nm)) {
          showOverwriteConfirm(nm);
        } else {
          performSave(nm);
        }
      })
      .on('pointerover', () => saveBtn.setStyle({ color: MENU_THEME.accentHover }))
      .on('pointerout', () => saveBtn.setStyle({ color: '#ffffff' }));

    const cancelBtn = this.add.text(w / 2 + 80, h / 2 - 100, '[ Cancel ]', { fontSize: '18px', color: '#ffffff' })
      .setOrigin(0.5).setInteractive({ useHandCursor: true })
      .on('pointerdown', () => this.cleanupPopup())
      .on('pointerover', () => cancelBtn.setStyle({ color: MENU_THEME.accentHover }))
      .on('pointerout', () => cancelBtn.setStyle({ color: '#ffffff' }));

    this.modalPanelGroup.add([saveBtn, cancelBtn]);

    const listHeader = this.add.text(w / 2, h / 2 - 60, 'Existing Slots (click to fill):', {
      fontSize: '16px',
      color: '#cccccc'
    }).setOrigin(0.5);
    this.modalPanelGroup.add(listHeader);

    const listWidth = panelW - 40;
    const listHeight = 240;
    const slotSpacing = 38;
    const firstRowY = slotSpacing * 1;

    const listX = w / 2 - listWidth / 2;
    const listY = h / 2 - 40;

    const maskGfx = this.make.graphics({ x: listX, y: listY, add: false });
    maskGfx.fillStyle(0xffffff, 1);
    maskGfx.fillRect(0, 0, listWidth, listHeight);
    const mask = new Phaser.Display.Masks.GeometryMask(this, maskGfx);

    const slotsContainer = this.add.container(listX, listY);
    slotsContainer.setMask(mask);
    this.modalPanelGroup.add(slotsContainer);

    const totalHeight = slots.length * slotSpacing;
    const maxScroll = Math.max(0, totalHeight - listHeight);
    const applyScroll = (delta) => {
      if (!maxScroll) return;
      const next = slotsContainer.y - delta;
      slotsContainer.y = Phaser.Math.Clamp(next, listY - maxScroll, listY);
    };

    const listArea = new Phaser.Geom.Rectangle(listX, listY, listWidth, listHeight);
    const handleWheel = (pointer, _over, dx, dy) => {
      if (!Phaser.Geom.Rectangle.Contains(listArea, pointer.worldX, pointer.worldY)) return;
      const step = Phaser.Math.Clamp(dy * 0.25, -30, 30);
      applyScroll(step);
    };
    this.input.on('wheel', handleWheel);

    this.modalPanelGroup.once('destroy', () => {
      this.input.off('wheel', handleWheel);
      maskGfx.destroy();
    });


    if (slots.length === 0) {
      // Was `listTop` — never declared anywhere in this function, so this
      // threw a ReferenceError and killed the rest of createSaveSlotPopup()
      // (including the Cancel button below) whenever there were no save
      // slots yet. slotsContainer's own children use container-local
      // coordinates (it's already positioned at listX/listY), so this
      // centers within listWidth/listHeight instead.
      const emptyText = this.add.text(listWidth / 2, listHeight / 2, 'No existing saves', {
        fontSize: '16px',
        color: '#cccccc'
      }).setOrigin(0.5);
      slotsContainer.add(emptyText);
    } else {
      slots.forEach((sl, i) => {
        const rowY = firstRowY + i * slotSpacing;

        const slotText = this.add.text(10, rowY, sl, {
          fontSize: '16px', color: '#fff'
        })
          .setOrigin(0, 0.5)
          .setInteractive({ useHandCursor: true })
          .on('pointerdown', () => setInputValue(sl))
          .on('pointerover', () => slotText.setStyle({ color: '#ff0' }))
          .on('pointerout', () => slotText.setStyle({ color: '#fff' }));

        const overwriteBtn = this.add.text(listWidth - 90, rowY, '[ Overwrite ]', {
          fontSize: '15px', color: '#ffcc66'
        })
          .setOrigin(0.5)
          .setInteractive({ useHandCursor: true })
          .on('pointerdown', () => {
            setInputValue(sl);
            showOverwriteConfirm(sl);
          })
          .on('pointerover', () => overwriteBtn.setStyle({ color: MENU_THEME.accentHover }))
          .on('pointerout', () => overwriteBtn.setStyle({ color: '#ffcc66' }));

        slotsContainer.add([slotText, overwriteBtn]);
      });
    }
  }




  /**
   * A Yes/No confirm layered over whatever modal popup is already open.
   *
   * Lives in `overwriteConfirmGroup` (kept as the property name because
   * cleanupPopup already nulls it) and is added to modalPanelGroup, so it is
   * torn down with its parent. Its children are cleared with removeAll(true)
   * rather than destroying the container itself -- destroy() on this nested
   * container crashes on a stale sys reference.
   */
  _showModalConfirm(message, onYes, { dimW = 460, dimH = 380 } = {}) {
    if (!this.modalPanelGroup) return;
    const w = this.sys.game.canvas.width;
    const h = this.sys.game.canvas.height;

    if (this.overwriteConfirmGroup) {
      this.overwriteConfirmGroup.removeAll(true);
    } else {
      this.overwriteConfirmGroup = this.add.container(0, 0)
        .setScrollFactor(0)
        .setDepth(DEPTH.MODAL_PANEL + 10);
      this.modalPanelGroup.add(this.overwriteConfirmGroup);
    }

    const dim = this.add.rectangle(w / 2, h / 2, dimW, dimH, 0x000000, 0.55)
      .setOrigin(0.5)
      .setInteractive();
    const confirmPanel = createPanel(this, w / 2 - 220, h / 2 - 90, 440, 180, 'menu');

    const prompt = this.add.text(w / 2, h / 2 - 30, message, {
      fontSize: '18px',
      color: '#ffffff',
      align: 'center',
      wordWrap: { width: 380 }
    }).setOrigin(0.5);

    const yesBtn = this.add.text(w / 2 - 70, h / 2 + 35, '[ Yes ]', {
      fontSize: '18px',
      color: '#ffffff'
    }).setOrigin(0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => {
        SoundManager.play('select');
        onYes?.();
      })
      .on('pointerover', () => yesBtn.setStyle({ color: MENU_THEME.accentHover }))
      .on('pointerout', () => yesBtn.setStyle({ color: '#ffffff' }));

    const noBtn = this.add.text(w / 2 + 70, h / 2 + 35, '[ No ]', {
      fontSize: '18px',
      color: '#ffffff'
    }).setOrigin(0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => {
        SoundManager.play('dullClick');
        this.overwriteConfirmGroup?.removeAll(true);
        this.overwriteConfirmGroup = null;
      })
      .on('pointerover', () => noBtn.setStyle({ color: MENU_THEME.accentHover }))
      .on('pointerout', () => noBtn.setStyle({ color: '#ffffff' }));

    this.overwriteConfirmGroup.add([dim, confirmPanel, prompt, yesBtn, noBtn]);
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
    const panel = createPanel(this, w / 2 - panelW / 2, h / 2 - panelH / 2, panelW, panelH, 'menu');

    const title = this.add.text(w / 2, h / 2 - (panelH / 2) + 30, 'Select Save Slot:', {
      fontSize: '20px', color: '#fff'
    }).setOrigin(0.5, 0.5);

    this.modalPanelGroup.add([panel, title]);

    const slots = GameState.listSaveSlots();
    const listWidth = panelW - 40;
    const listHeight = 220;
    const slotSpacing = 40;
    const firstRowY = slotSpacing * 1; // second-row-ish start

    const listX = w / 2 - listWidth / 2;
    const listY = h / 2 - listHeight / 2;

    const maskGfx = this.make.graphics({ x: listX, y: listY, add: false });
    maskGfx.fillStyle(0xffffff, 1);
    maskGfx.fillRect(0, 0, listWidth, listHeight);
    const mask = new Phaser.Display.Masks.GeometryMask(this, maskGfx);

    const slotsContainer = this.add.container(listX, listY);
    slotsContainer.setMask(mask);
    this.modalPanelGroup.add(slotsContainer);

    const totalHeight = slots.length * slotSpacing;
    const maxScroll = Math.max(0, totalHeight - listHeight);
    const applyScroll = (delta) => {
      if (!maxScroll) return;
      const next = slotsContainer.y - delta;
      slotsContainer.y = Phaser.Math.Clamp(next, listY - maxScroll, listY);
    };

    const listArea = new Phaser.Geom.Rectangle(listX, listY, listWidth, listHeight);
    const handleWheel = (pointer, _over, dx, dy) => {
      if (!Phaser.Geom.Rectangle.Contains(listArea, pointer.worldX, pointer.worldY)) return;
      const step = Phaser.Math.Clamp(dy * 0.25, -50, 50);
      applyScroll(step);
    };
    this.input.on('wheel', handleWheel);

    this.modalPanelGroup.once('destroy', () => {
      this.input.off('wheel', handleWheel);
      maskGfx.destroy();
    });

    if (slots.length === 0) {
      // Same fix as createSaveSlotPopup — `listTop` was never declared,
      // ReferenceError killed the rest of the function (Cancel button
      // included) whenever there were no saves to list.
      const emptyText = this.add.text(listWidth / 2, listHeight / 2, 'No saved games found', {
        fontSize: '18px',
        color: '#cccccc'
      }).setOrigin(0.5);
      slotsContainer.add(emptyText);
    } else {
      slots.forEach((sl, i) => {
        const y = firstRowY + i * slotSpacing;

        const slotText = this.add.text(10, y, sl, {
          fontSize: '18px', color: '#fff'
        })
          .setOrigin(0, 0.5)
          .setInteractive({ useHandCursor: true })
          .on('pointerdown', () => {
            SoundManager.play('select');
            // Loading discards everything since the last save, and this sits
            // one click away in the menu -- same class of destructive action
            // as overwriting a slot, so it gets the same confirm.
            this._showModalConfirm(
              `Load "${sl}"?
Any unsaved progress will be lost.`,
              () => {
                GameState.load(sl);
                this.cleanupPopup();
                this.refreshUI?.();
              },
              { dimW: panelW + 40, dimH: panelH + 20 }
            );
          })
          .on('pointerover', () => slotText.setStyle({ color: '#ff0' }))
          .on('pointerout', () => slotText.setStyle({ color: '#fff' }));

        const deleteBtn = this.add.text(listWidth - 60, y, '[ Delete ]', {
          fontSize: '16px', color: '#ff5555'
        })
          .setOrigin(0.5)
          .setInteractive({ useHandCursor: true })
          .on('pointerdown', () => this.confirmDeleteSlot(sl))
          .on('pointerover', () => deleteBtn.setStyle({ color: '#ff0000' }))
          .on('pointerout', () => deleteBtn.setStyle({ color: '#ff5555' }));

        slotsContainer.add([slotText, deleteBtn]);
      });
    }

    // Cancel button
    const cancelBtn = this.add.text(w / 2, h / 2 + (panelH / 2) - 25, '[ Cancel ]', {
      fontSize: '18px', color: '#ffffff'
    })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => this.cleanupPopup())
      .on('pointerover', () => cancelBtn.setStyle({ color: MENU_THEME.accentHover }))
      .on('pointerout', () => cancelBtn.setStyle({ color: '#ffffff' }));

    this.modalPanelGroup.add(cancelBtn);
  }




  addButton(x, y, label, callback) {
    const btn = createButton(this, x, y, label, callback, 'primary', { fontSize: '20px' });
    if (this.popupGroup) this.popupGroup.add(btn);
    this.popupButtons.push(btn);
  }

  cleanupPopup() {
    if (this.nameInputDOM) { this.nameInputDOM.destroy(); this.nameInputDOM = null; }
    if (this.modalPanelGroup) { this.modalPanelGroup.destroy(true); this.modalPanelGroup = null; }
    if (this.modalBlockerGroup) { this.modalBlockerGroup.destroy(true); this.modalBlockerGroup = null; }
    if (this.popupGroup) { this.popupGroup.destroy(true); this.popupGroup = null; }
    if (this.popupButtons) { this.popupButtons.length = 0; }
    this.overwriteConfirmGroup = null;
    this.exitConfirmOpen = false;
  }

  // opts.bypassToggle — optional: { enabled: bool, onToggle: fn }
  //   When provided, renders a small dev toggle button so you can flip
  //   the unlock bypass on/off without leaving the menu.
  showSelectionMenu(title, options, opts = {}) {
    this.cleanupPopup();

    const w = this.sys.game.canvas.width;
    const h = this.sys.game.canvas.height;
    this.popupGroup = this.add.container(0, 0).setDepth(DEPTH.MENU).setScrollFactor(0);
    this.popupButtons = [];

    // Backdrop. Falls back to the original fully-opaque black rectangle when
    // no bgKey is given (or its texture failed to load), so this stays safe
    // for any future caller that has no art of its own. Either way it is
    // interactive and opaque, which is what stops clicks reaching TownScene
    // and its side panels underneath.
    let overlay;
    if (opts.bgKey && this.textures.exists(opts.bgKey)) {
      overlay = this.add.image(w / 2, h / 2, opts.bgKey)
        .setOrigin(0.5)
        .setDisplaySize(w, h)
        .setInteractive();
    } else {
      overlay = this.add.rectangle(w / 2, h / 2, w, h, 0x000000, 1)
        .setOrigin(0.5)
        .setInteractive();
    }

    // Title
    // Shadowed: this menu can now sit on a full-colour backdrop rather than
    // the flat black it was designed against, and white-on-sky is otherwise
    // close to unreadable. Harmless when no bgKey is supplied.
    const titleText = this.add.text(220, 80, title, {
      fontSize: '26px',
      color: '#ffffff',
      fontStyle: 'bold'
    }).setOrigin(0, 0.5).setShadow(2, 2, '#000000', 6, true, true);

    // --- Dev bypass toggle (optional) ---
    // Shown only when the caller passes opts.bypassToggle.
    // Clicking it flips the bypass and re-opens the menu with fresh state.
    let bypassBtn = null;
    if (opts.bypassToggle) {
      const { enabled, onToggle } = opts.bypassToggle;
      const bypassLabel = enabled ? '[DEV: Locks OFF]' : '[DEV: Locks ON]';
      const bypassColor = enabled ? '#ff9944' : '#888888';
      bypassBtn = this.add.text(w - 220, 80, bypassLabel, {
        fontSize: '14px',
        color: bypassColor,
        backgroundColor: '#1a1a1a',
        padding: { x: 8, y: 4 }
      }).setOrigin(1, 0.5)
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', () => onToggle())
        .on('pointerover', function () { this.setAlpha(0.75); })
        .on('pointerout',  function () { this.setAlpha(1); });
    }

    // Increased vertical spacing for left column
    const spacing = 75;
    const totalHeight = options.length * spacing;
    let startY = (h / 2) - (totalHeight / 2);

    // Right detail panel
    const panelX = w - 500;
    const detailPanel = createPanel(this, panelX - 200, h / 2 - 250, 400, 500, 'default');

    const detailTitle = this.add.text(panelX, h / 2 - 200, '', {
      fontSize: '22px',
      color: '#ffffff',
      fontStyle: 'bold',
      wordWrap: { width: 360 }
    }).setOrigin(0.5, 0);

    const detailDesc = this.add.text(panelX, h / 2 - 160, '', {
      fontSize: '16px',
      color: '#dddddd',
      wordWrap: { width: 360 }
    }).setOrigin(0.5, 0);

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
      const isLocked = !!opt.locked;
      const hasTiers = Array.isArray(opt.tiers) && opt.tiers.length > 0;

      // Which tier (e.g. Gorrek's Reckoning I-V) is currently dialed in via
      // the dropdown below — null means the base scenario itself. Lives on
      // the option object so both the row's own click handler and the
      // dropdown's picks read/write the same state.
      opt._selectedTier = null;

      // Composes the row's own button label from whichever tier is
      // currently selected — e.g. "Gorrek II  ✓" — instead of a separate
      // pip cluster reporting the tier on the side. Locked rows keep the
      // original '???'-style label regardless of tier state.
      const computeLabel = () => {
        if (isLocked) return `[ ${opt.label} ]  🔒`;
        const tier = opt._selectedTier;
        if (tier) {
          const name = `${opt.baseName || opt.label} ${tier.label}`;
          return `[ ${tier.completed ? name + '  ✓' : name} ]`;
        }
        return `[ ${opt.label} ]`;
      };

      const labelColor = isLocked ? '#555555' : '#cccccc';

      const optionText = this.add.text(220, yPos, computeLabel(), {
        fontSize: '20px',
        color: labelColor,
        backgroundColor: '#333333',
        padding: { x: 10, y: 5 }
      }).setOrigin(0, 0.5)
        .setInteractive({ useHandCursor: !isLocked });

      // Brighter and shadowed: these sit directly on the backdrop with no
      // panel behind them, so mid-grey vanished against wood and grass.
      const descText = this.add.text(220, yPos + 20, opt.description || '', {
        fontSize: '14px',
        color: isLocked ? '#666666' : '#e2e2e2',
        wordWrap: { width: 200 }
      }).setOrigin(0, 0).setShadow(1, 1, '#000000', 5, true, true);

      // Pushes whichever is currently selected (base scenario or a tier)
      // into the row label, description, detail panel and Fight button —
      // shared by clicking the row itself AND by picking an option from the
      // tier dropdown, so both paths always agree on what's armed.
      const applySelection = () => {
        const tier = opt._selectedTier;
        const target = tier || opt;
        const tierLocked = !!(tier && !tier.unlocked);

        optionText.setText(computeLabel());
        descText.setText((tier ? (tier.description || tier.longDescription) : opt.description) || '');

        if (tierLocked) {
          detailTitle.setText(`${opt.baseName || opt.label} — ${tier.fullLabel || tier.label}`);
          detailDesc.setText('Complete the previous tier to unlock this one.');
          detailPortrait.setVisible(false);
          fightButton.setStyle({ color: '#555555', backgroundColor: '#222222' });
          fightButton.disableInteractive();
          fightButton.removeAllListeners('pointerdown');
          return;
        }

        detailTitle.setText(tier ? (tier.fullLabel || tier.label) : opt.label);
        detailDesc.setText(target.longDescription || target.description || '');
        if (target.portraitKey) {
          detailPortrait.setTexture(target.portraitKey).setVisible(true);
        } else {
          detailPortrait.setVisible(false);
        }
        fightButton._startScenario = target.onSelect;
        fightButton.setStyle({ color: '#cccccc', backgroundColor: '#333333' });
        fightButton.setInteractive({ useHandCursor: true });
        fightButton.removeAllListeners('pointerdown');
        fightButton.on('pointerdown', () => {
          // Start the scene transition FIRST, and delay tearing down this
          // popup's fully-opaque overlay by a beat — Phaser scene starts
          // (game.scene.start('LoadingScene', ...) under the hood) don't
          // take effect until the next update tick, so destroying the
          // overlay synchronously here left a 1-frame gap where TownScene
          // was briefly visible underneath before LoadingScene painted
          // over it. Keeping the overlay up a little longer costs
          // nothing since we're navigating away regardless.
          fightButton._startScenario();
          this.time.delayedCall(100, () => this.cleanupPopup());
        });
      };

      if (isLocked) {
        // Clicking a locked entry just shows a note in the detail panel.
        optionText.on('pointerdown', () => {
          detailTitle.setText(opt.label);
          detailDesc.setText('Complete the previous scenario to unlock this challenge.');
          detailPortrait.setVisible(false);
          fightButton.setStyle({ color: '#555555', backgroundColor: '#222222' });
          fightButton.disableInteractive();
          fightButton.removeAllListeners('pointerdown');
        });
      } else {
        optionText
          .on('pointerdown', applySelection)
          .on('pointerover', () => optionText.setStyle({ color: MENU_THEME.accentHover }))
          .on('pointerout',  () => optionText.setStyle({ color: '#cccccc' }));
      }

      this.popupButtons.push(optionText, descText);

      // Optional tier dropdown (e.g. Gorrek's Reckoning I-V) — a compact
      // "▾" toggle to the LEFT of the row (right side runs out of room fast
      // if more than one option ever needs this) that expands a short pick
      // list of Base + each tier, birthday-picker style: pick one and it
      // collapses back down, with the choice now baked into the row's own
      // label instead of living in a separate always-visible pip cluster.
      if (hasTiers) {
        const toggleX = 190;
        const toggle = this.add.text(toggleX, yPos, '▾', {
          fontSize: '16px',
          color: '#cccccc',
          backgroundColor: '#222222',
          padding: { x: 6, y: 4 },
        }).setOrigin(0.5).setInteractive({ useHandCursor: true });

        const pickList = [
          { label: 'Base', tier: null, unlocked: true, completed: !!opt.completed },
          ...opt.tiers.map(t => ({ label: t.label, tier: t, unlocked: t.unlocked, completed: t.completed })),
        ];

        // Opens UPWARD from the toggle — this row (Gorrek) sits at the
        // bottom of the list, close enough to Exit that a downward list
        // would crowd or clip past it; opening up instead overlays the
        // row(s) above it, which is fine for a transient dropdown that
        // collapses the instant something is picked.
        const ROW_H = 20;
        const dropdown = this.add.container(0, 0).setVisible(false).setDepth(50);
        pickList.forEach((entry, i) => {
          const rowLocked = !entry.unlocked;
          const oy = yPos - (pickList.length - i) * ROW_H;
          const text = entry.completed ? `${entry.label}  ✓` : entry.label;
          const idleColor = rowLocked ? '#555555' : (entry.completed ? '#88cc88' : '#dddddd');
          const row = this.add.text(toggleX, oy, text, {
            fontSize: '13px',
            color: idleColor,
            backgroundColor: '#1a1a1a',
            padding: { x: 6, y: 3 },
          }).setOrigin(0.5).setInteractive({ useHandCursor: true });

          row.on('pointerdown', () => {
            if (rowLocked) {
              detailTitle.setText(entry.tier ? `${opt.baseName || opt.label} — ${entry.tier.fullLabel || entry.tier.label}` : opt.label);
              detailDesc.setText('Complete the previous tier to unlock this one.');
              detailPortrait.setVisible(false);
              fightButton.setStyle({ color: '#555555', backgroundColor: '#222222' });
              fightButton.disableInteractive();
              fightButton.removeAllListeners('pointerdown');
            } else {
              opt._selectedTier = entry.tier;
              applySelection();
            }
            dropdown.setVisible(false);
          });
          row.on('pointerover', () => { if (!rowLocked) row.setStyle({ color: MENU_THEME.accentHover }); });
          row.on('pointerout',  () => { if (!rowLocked) row.setStyle({ color: idleColor }); });

          dropdown.add(row);
        });

        toggle.on('pointerdown', () => dropdown.setVisible(!dropdown.visible));

        this.popupButtons.push(toggle, dropdown);
      }
    });

    // === Exit Button ===
    const exitButtonY = startY + options.length * spacing + 40;

    const exitButton = this.add.text(220, exitButtonY, '[ Exit ]', {
      fontSize: '18px',
      color: '#cccccc',
      backgroundColor: '#333333',
      padding: { x: 8, y: 4 }
    }).setOrigin(0, 0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => { this.cleanupPopup(); })
      .on('pointerover', () => exitButton.setStyle({ color: MENU_THEME.accentHover }))
      .on('pointerout',  () => exitButton.setStyle({ color: '#cccccc' }));

    this.popupButtons.push(exitButton);

    // Add everything to the group (back → front order).
    this.popupGroup.add(overlay);
    this.popupGroup.add(titleText);
    if (bypassBtn) this.popupGroup.add(bypassBtn);
    this.popupGroup.add(detailPanel);
    this.popupGroup.add([detailTitle, detailDesc, detailPortrait, fightButton]);
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
    const panel = createPanel(this, w / 2 - 200, h / 2 - 75, 400, 150, 'menu');

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
      .on('pointerover', () => yesBtn.setStyle({ color: MENU_THEME.accentHover }))
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
      .on('pointerover', () => noBtn.setStyle({ color: MENU_THEME.accentHover }))
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
      this._setRightPanelChildrenInteractive(this.rightPanelVisible);
    }
  }

  // Phaser containers do NOT cascade setVisible(false) to their children's
  // own interactivity — a hidden container's buttons stay fully clickable
  // (just invisible) unless each child's input is explicitly toggled too.
  // This is the actual cause of "menu buttons still clickable while hidden"
  // — most noticeable after a rebuild (e.g. closing Party Management calls
  // refreshUI(), which creates a brand new rightPanel via buildUI()).
  _setRightPanelChildrenInteractive(enabled) {
    this.rightPanel?.list.forEach(child => {
      if (child.input) child.input.enabled = enabled;
    });
  }

}

