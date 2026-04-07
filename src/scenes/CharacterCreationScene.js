// src/scenes/CharacterCreationScene.js
import GameState from '../systems/GameState.js';
import ProgressionManager from '../systems/ProgressionManager.js';
import UIButton, { createButton } from '../ui/Button.js';
import { FONTS } from '../ui/styles.js';
import {
  buildCharacter,
  RACE_BONUSES,
  CLASS_BONUSES
} from '../systems/CharacterBuilder.js';


export default class CharacterCreationScene extends Phaser.Scene {
  constructor() {
    super({ key: 'CharacterCreationScene' });
  }

  init() {

    // starting allocatable pool (adjust later if needed)
    this.availablePoints = 10;

    // base stats before race/class bonuses
    this.baseStats = { STR: 5, DEX: 5, CON: 5, INT: 5, WIS: 5, CHA: 5 };

    // defaults
    this.selectedRace = 'Human';
    this.selectedClass = 'Beggar';
    this.statTexts = {};

    this.raceButtons = [];
    this.classButtons = [];


    this.portraitIcons = [];
    this.selectedSkin = null;

  }

  create() {
    const { width, height } = this.sys.game.canvas;

    // dark overlay
    this.add.rectangle(width / 2, height / 2, width, height, 0x111111, 0.95)
      .setScrollFactor(0)
      .setDepth(0)
      .setInteractive();

    // title
    this.add.text(width / 2, 40, 'Create Your Hunter', FONTS.heading)
      .setOrigin(0.5);

    /* -------------------------------------------------------
     * NAME INPUT (DOM)
     * ----------------------------------------------------- */
    this.nameInput = this.add.dom(width / 2, 100).createFromHTML(`
      <input type="text" name="charName" maxlength="24" placeholder="Character Name"
        style="font-size:18px;padding:6px;width:240px;
               background-color:#2a2a2a;color:#ffffff;border:1px solid #555;">
    `);

    /* -------------------------------------------------------
     * RACE SELECTION (left column)
     * ----------------------------------------------------- */
    const raceX = 160;
    this.add.text(raceX, 140, 'Race:', { ...FONTS.body, color: '#ffffff' }).setOrigin(0.5);

    const raceOptions = Object.keys(RACE_BONUSES);
    raceOptions.forEach((race, i) => {
      const y = 180 + i * 42;
      const btn = new UIButton(this, raceX, y, race, () => {
        this.selectedRace = race;
        this.updateStatDisplay();
        this.showPortraitOptions(race);
        this.updateButtonHighlights();
      }, 110, 32);
      this.add.existing(btn);
      this.raceButtons.push({ race, btn });
    });


    this.selectedSkin = null;
    this.showPortraitOptions(this.selectedRace);




    /* -------------------------------------------------------
     * CLASS SELECTION (center-left column)
     * ----------------------------------------------------- */
    const classX = 320;
    this.add.text(classX, 140, 'Class:', { ...FONTS.body, color: '#ffffff' }).setOrigin(0.5);

    const classOptions = ['Beggar', 'Acolyte', 'Performer', 'Grunt', 'Scholar', 'Shepherd'];
    classOptions.forEach((cls, i) => {
      const y = 180 + i * 42;
      const btn = new UIButton(this, classX, y, cls, () => {
        this.selectedClass = cls;
        this.updateStatDisplay();
        this.updateButtonHighlights();
      }, 140, 32);
      this.add.existing(btn);
      this.classButtons.push({ cls, btn });
    });


    /* -------------------------------------------------------
     * STAT ALLOCATION (right column)
     * ----------------------------------------------------- */
    const statKeys = Object.keys(this.baseStats); // STR,DEX,CON,INT,WIS,CHA
    const statStartY = 200;
    const statXLabel = width / 2 + 100;  // label column
    const statXMinus = statXLabel + 40;
    const statXValue = statXMinus + 50;
    const statXPlus = statXValue + 50;

    statKeys.forEach((key, i) => {
      const y = statStartY + i * 48;

      // label
      this.add.text(statXLabel, y, key, { ...FONTS.body, color: '#ffffff' })
        .setOrigin(1, 0.5);

      // minus
      const minusBtn = new UIButton(this, statXMinus, y, '–', () => {
        const min = 5; // absolute minimum before bonuses
        if (this.baseStats[key] > min) {
          this.baseStats[key]--;
          this.availablePoints++;
          this.updateStatDisplay();
        }
      }, 32, 32);
      this.add.existing(minusBtn);

      // value text
      const statText = this.add.text(statXValue, y, '', { ...FONTS.body, color: '#ffffff' })
        .setOrigin(0.5);
      this.statTexts[key] = statText;

      // plus
      const plusBtn = new UIButton(this, statXPlus, y, '+', () => {
        if (this.availablePoints > 0) {
          this.baseStats[key]++;
          this.availablePoints--;
          this.updateStatDisplay();
        }
      }, 32, 32);
      this.add.existing(plusBtn);
    });

    /* -------------------------------------------------------
     * STAT PREVIEW + REMAINING POINTS
     * ----------------------------------------------------- */
    const previewY = height - 180;
    this.previewText = this.add.text(width / 2, previewY, '', { ...FONTS.body, color: '#aaaaaa' })
      .setOrigin(0.5);

    this.pointsText = this.add.text(width / 2, previewY + 30, '', { ...FONTS.body, color: '#ffffff' })
      .setOrigin(0.5);

    // initial fill
    this.updateStatDisplay();
    this.updateDerivedPreview();

    /* -------------------------------------------------------
     * CONFIRM / CANCEL
     * ----------------------------------------------------- */
    const bottomY = height - 80;

    createButton(this, width / 2 - 100, bottomY, 'Confirm', () => {
      const name = (this.nameInput.getChildByName('charName')?.value || '').trim();
      if (!name) return;

      const newChar = buildCharacter({
        name,
        race: this.selectedRace,
        baseClass: this.selectedClass,
        stats: { ...this.baseStats },
        skin: this.selectedSkin
      });

      GameState.addCharacter(newChar);

      if (ProgressionManager.hasQuestFlag('orientation_bonfire')) {
        ProgressionManager.clearQuestFlag('orientation_bonfire');
        ProgressionManager.setQuestFlag('orientation_elder');
      }

      this.scene.stop();
      this.scene.start('PartyManagementScene');
    }, 'confirm', { fontSize: '20px' });

    createButton(this, width / 2 + 100, bottomY, 'Cancel', () => {
      // TownScene + UIScene are still active in the background — just stop this
      // scene and they resume normally. Starting MainMenuScene here would layer
      // it on top of the still-running TownScene, causing overlap/input chaos.
      this.scene.stop();
    }, 'danger', { fontSize: '20px' });
  }

  /* ---------------------------------------------------------
   * UPDATE UI: base + bonuses
   * ------------------------------------------------------- */
  updateStatDisplay() {
    const raceB = RACE_BONUSES[this.selectedRace] || {};
    const classB = CLASS_BONUSES[this.selectedClass] || {};

    Object.keys(this.statTexts).forEach(key => {
      const base = this.baseStats[key] || 0;
      const r = raceB[key] || 0;
      const c = classB[key] || 0;
      const total = base + r + c;
      this.statTexts[key].setText(`${total}`);
    });

    this.pointsText.setText(`Points Remaining: ${this.availablePoints}`);
    this.updateDerivedPreview();
  }

  /* ---------------------------------------------------------
   * Show derived stats (HP/MP/etc.) based on current selections
   * ------------------------------------------------------- */
  updateDerivedPreview() {
    // simulate a temp character through the builder
    const tempChar = buildCharacter({
      name: 'Preview',
      race: this.selectedRace,
      baseClass: this.selectedClass,
      stats: { ...this.baseStats }
    });

    const d = tempChar.derived;
    this.previewText.setText(
      `HP: ${d.maxHP}   MP: ${d.maxMP}   Acc: ${d.Accuracy}   Eva: ${d.Evasion}   Stun: ${d.StunChance}`
    );
  }

  showPortraitOptions(race) {
    // Clear previous
    this.portraitIcons.forEach(icon => icon.destroy());
    this.portraitIcons = [];

    const baseX = 120;
    const baseY = 500;
    const spacingX = 180;

    for (let i = 1; i <= 2; i++) {
      const skinKey = `${race.toLowerCase()}_portrait_${i}`;
      const x = baseX + (i - 1) * spacingX;

      const icon = this.add.image(x, baseY, skinKey)
        .setInteractive({ useHandCursor: true })
        .setScale(1.0)
        .setData('skinKey', skinKey)
        .on('pointerdown', () => {
          this.selectPortrait(icon);
        });

      this.portraitIcons.push(icon);
    }
    if (this.raceDescriptionText) {
      this.raceDescriptionText.destroy();
    }

    const descriptions = {
      human: "Adaptable and enduring.",
      dwarf: "Sturdy and resilient.",
      elf: "Graceful and intelligent.",
      ferrow: "Avian hunters, swift and sharp-eyed.",
      wylett: "Woodland beasts with primal instincts.",
      skith: "Serpentine minds, deceptive and swift."
    };

    const desc = descriptions[race.toLowerCase()] || "A mysterious people.";

    this.raceDescriptionText = this.add.text(240, baseY + 120, desc, {
      fontSize: '16px',
      color: '#cccccc',
      align: 'center',
      wordWrap: { width: 300 }
    }).setOrigin(0.5);

    // Default to first if undefined
    this.selectedSkin = this.selectedSkin || `${race.toLowerCase()}_portrait_1`;
    this.highlightSelectedSkin();
  }

  selectPortrait(icon) {
    this.selectedSkin = icon.getData('skinKey');
    this.highlightSelectedSkin();
  }

  highlightSelectedSkin() {
    this.portraitIcons.forEach(icon => {
      const isSelected = icon.getData('skinKey') === this.selectedSkin;
      icon.setScale(isSelected ? 1.2 : 1.0);
    });
  }


  updateButtonHighlights() {
    this.raceButtons.forEach(({ race, btn }) => {
      btn.setFill(race === this.selectedRace ? 0x88ff88 : 0x333333);
    });

    this.classButtons.forEach(({ cls, btn }) => {
      btn.setFill(cls === this.selectedClass ? 0x88ff88 : 0x333333);
    });
  }


}
