// src/scenes/CharacterCreationScene.js
import GameState from '../systems/GameState.js';
import { SoundManager } from '../systems/SoundManager.js';
import ProgressionManager from '../systems/ProgressionManager.js';
import UIButton, { createButton } from '../ui/Button.js';
import { FONTS } from '../ui/styles.js';
import {
  buildCharacter,
  RACE_BONUSES,
  CLASS_BONUSES
} from '../systems/CharacterBuilder.js';
import { getClassSkillsFor } from '../../data/skills.js';


// Short, per-stat blurbs shown beside the +/- controls — condensed versions
// of the same effects listed in the combat character-info panel's stat
// tooltips (CombatScene.js), kept brief since there's only ~340px of row
// width to work with here.
const STAT_DESCRIPTIONS = {
  STR: 'Weapon damage; feeds Crit Chance',
  DEX: 'Accuracy; feeds Crit Chance',
  CON: 'Max HP, Physical Resist',
  INT: 'Max MP, MP regen; feeds Crit Chance',
  WIS: 'Max MP, Elemental Resist, Resilience',
  CHA: 'Max MP, Initiative, Elemental/Necrotic Resist',
};

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

    // UIScene stays running underneath (TownScene does too — see the Cancel
    // button below), but its frame/side panels render on top and crowd the
    // bonfire scene's own buttons/aesthetic. Sleep it here, wake it on every
    // exit path, same convention CombatScene uses.
    this.scene.sleep('UIScene');
    this.scene.sleep('TownScene');

    SoundManager.init(this);

    // Looping ambient fire sound — stopped on scene shutdown
    if (this.cache.audio.has('sfx_bonfireLoop')) {
      this._bonfireSound = this.sound.add('sfx_bonfireLoop', { loop: true, volume: 0.3 });
      this._bonfireSound.play();
      this.events.once('shutdown', () => this._bonfireSound?.stop());
    }

    // Static backdrop
    if (this.textures.exists('char_creation_backscene')) {
      this.add.image(width / 2, height / 2, 'char_creation_backscene')
        .setDisplaySize(width, height)
        .setDepth(0);
    }

    // Animated smoke overlay on top of the backdrop
    if (this.textures.exists('char_creation_bg')) {
      const animKey = 'char_creation_bg_anim';
      if (!this.anims.exists(animKey)) {
        const frames = Array.from({ length: 24 }, (_, i) =>
          ({ key: 'char_creation_bg', frame: `frame${String(i).padStart(4, '0')}.png` })
        );
        this.anims.create({ key: animKey, frames, frameRate: 6, repeat: -1 });
      }
      this.add.sprite(width / 2, height / 2, 'char_creation_bg', 'frame0000.png')
        .setDisplaySize(width, height)
        .setDepth(0)
        .play(animKey);
    }

    // Invisible click blocker — same depth as buttons (0), added first so buttons
    // take input priority. Catches any stray clicks that would otherwise reach TownScene.
    this.add.rectangle(width / 2, height / 2, width, height, 0x000000, 0)
      .setScrollFactor(0).setDepth(0).setInteractive();

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
        // Reset before rebuilding portraits — showPortraitOptions only fills
        // in a default skin when selectedSkin is falsy (`this.selectedSkin
        // || race_portrait_1`). Without clearing it here first, switching
        // race without manually clicking a new portrait left selectedSkin
        // stuck on whatever race was selected FIRST (Human, the initial
        // default) — race/stats updated correctly, but the character got
        // built with a mismatched portrait.
        this.selectedSkin = null;
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
        this.updateClassSkillText();
      }, 140, 32);
      this.add.existing(btn);
      this.classButtons.push({ cls, btn });
    });
    this.updateClassSkillText();


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

      // brief description — same row, to the right of the plus button
      this.add.text(statXPlus + 36, y, STAT_DESCRIPTIONS[key] || '', {
        fontSize: '13px',
        color: '#999999',
        wordWrap: { width: width - (statXPlus + 36) - 20 },
      }).setOrigin(0, 0.5);
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
      if (GameState.party.length < 6) GameState.addToParty(newChar);

      if (ProgressionManager.hasQuestFlag('orientation_bonfire')) {
        ProgressionManager.clearQuestFlag('orientation_bonfire');
        ProgressionManager.setQuestFlag('orientation_elder');
      }

      // Was missing everywhere else this same clearQuestFlag/setQuestFlag
      // pattern happens (Elder's Tower, vendor row, etc. all save right
      // after) — without it, the flag flip only ever lived in memory, so a
      // reload before any LATER autosave fired left "Create a Character"
      // still active even with a full party already made.
      GameState.save('autosave');

      this.scene.wake('UIScene');
      this.scene.wake('TownScene');
      this.scene.stop();
      this.scene.start('PartyManagementScene');
    }, 'confirm', { fontSize: '20px' });

    createButton(this, width / 2 + 100, bottomY, 'Cancel', () => {
      // TownScene is still active in the background — just stop this scene
      // and it resumes normally. Starting MainMenuScene here would layer it
      // on top of the still-running TownScene, causing overlap/input chaos.
      // UIScene was slept on entry (see create()) and needs waking back up.
      this.scene.wake('UIScene');
      this.scene.wake('TownScene');
      this.scene.stop();
    }, 'danger', { fontSize: '20px' });
  }

  /** Defensive — guarantees UIScene wakes even if this scene is stopped some
   * other way (e.g. "return to main menu") instead of via Confirm/Cancel. */
  shutdown() {
    this.scene.wake('UIScene');
    this.scene.wake('TownScene');
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

    // Evasion and Stun Chance used to live here, but neither actually
    // changes with core-stat allocation: Evasion's base is always 0 (only
    // gear/buffs/weaknesses grant it at runtime — see CharacterBuilder.js),
    // and StunChance isn't a field calculateDerivedStats even returns
    // anymore. Swapped for Crit Chance and Physical Resist, which do move
    // with STR/DEX/INT and CON respectively.
    const d = tempChar.derived;
    this.previewText.setText(
      `HP: ${d.maxHP}   MP: ${d.maxMP}   Acc: ${d.Accuracy}   Crit: ${d.CritChance}%   PhysRes: ${d.PhysicalResist}`
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

    // Bumped up 20px (was baseY + 120) to leave room below for the class
    // unique-skill text; font/color bumped a step for both to read more
    // clearly against the background.
    this.raceDescriptionText = this.add.text(240, baseY + 100, desc, {
      fontSize: '18px',
      color: '#ffddaa',
      align: 'center',
      wordWrap: { width: 300 }
    }).setOrigin(0.5);

    // Default to first if undefined
    this.selectedSkin = this.selectedSkin || `${race.toLowerCase()}_portrait_1`;
    this.highlightSelectedSkin();
  }

  // Shows the one unique skill each class grants (getClassSkillsFor,
  // data/skills.js) beneath the race flavor text — only rendered once a
  // class is selected (selectedClass always has a value here, defaulting to
  // 'Beggar', same convention as the always-preselected race above).
  updateClassSkillText() {
    if (this.classSkillText) {
      this.classSkillText.destroy();
      this.classSkillText = null;
    }
    if (!this.selectedClass) return;

    const [skill] = getClassSkillsFor({ baseClass: this.selectedClass });
    if (!skill) return;

    // Descriptions are already written as "ClassName: effect" — strip the
    // redundant class-name prefix since it's shown right above already.
    const desc = (skill.description || '').replace(
      new RegExp(`^${this.selectedClass}:\\s*`, 'i'), ''
    );

    this.classSkillText = this.add.text(240, 660, `${skill.name}: ${desc}`, {
      fontSize: '18px',
      color: '#ffddaa',
      align: 'center',
      wordWrap: { width: 300 }
    }).setOrigin(0.5);
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
