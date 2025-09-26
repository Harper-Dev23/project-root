// Core state & UI
import GameState from '../systems/GameState.js';
import { COLORS, UI_DEPTH, CLASS_COLORS } from '../ui/styles.js';
import Tooltip from '../ui/Tooltip.js';
import StatusBar from '../ui/StatusBar.js';
import UIButton from '../ui/Button.js';

// Data
import { COMBAT_SCENARIOS } from '../../data/combatScenarios.js';
import { ENEMY_TYPES } from '../../data/enemyTypes.js';
import { Items } from '../../data/items.js';
import { SKILLS, getWeaponSkillsFor, getClassSkillsFor, getReactionSkillsFor } from '../../data/skills.js';
import { getXPNeededForLevel } from '../../data/xpTable.js';

// Character / Items / AI systems
import { applyLevelUp, rebuildCharacterStats, resetCombatMods } from '../systems/CharacterBuilder.js';
import { isItemInstance } from '../systems/ItemFactory.js';
import { AI_PROFILES } from '../systems/AIProfiles.js';
import { chooseNPCAction } from '../systems/NPCLogic.js';
import EventBus from '../systems/EventBus.js';
import ReactionSystem from '../systems/ReactionSystem.js';

// Status / Weakness framework
import {
  makeWeaknessState, weaknessDecayAmount, weaknessIntensityMult,
  WeaknessFamilies, StatusEffects, WeaknessV3,
  WeaknessAliases, familyIntensityMult, familyStartConsume,
  hasCurseCinders, hasCurseTier1Plus, curseOverflowFactor,
  tickDownCurseCinders,
} from '../systems/StatusEffects.js';

// Combat logic
import {
  rollToHit, computeHitChance, getLastDamageBreakdown,
  computeEffectiveInitiative, getEffectiveDerived, applyColdEvasionPenalty,
  getEffectivePDR, getEffectiveMDR, getHealingReceivedMult, applyExposePreDamage,
} from '../systems/CombatLogic.js';





// Helper: Get safe Items.js data from equipped gear
function getEquippedItemData(equipped) {
  if (!equipped) return null;
  const id = isItemInstance(equipped) ? equipped.id : equipped;
  return Items[id] || null;
}
// === Grid helper =========================================
const SLOT_COORDS = {
  8: { col: 0, row: 0 },
  7: { col: 0, row: 1 },
  6: { col: 0, row: 2 },
  4: { col: 1, row: 0 },
  5: { col: 1, row: 1 },
  3: { col: 2, row: 0 },
  2: { col: 2, row: 1 },
  1: { col: 2, row: 2 }
};

/** Chebyshev distance (max row/col diff) between two ally slots */
function moveCost(fromId, toId) {
  const a = SLOT_COORDS[fromId];
  const b = SLOT_COORDS[toId];
  if (!a || !b) return Infinity;       // enemy‑side slots → unreachable
  return Math.max(Math.abs(a.col - b.col), Math.abs(a.row - b.row));
}
// =========================================================


export default class CombatScene extends Phaser.Scene {
  constructor() {
    super({ key: 'CombatScene' });
    this.unitSlots = [];
    this.koArea = [];
    this.combatEnded = false;

    this.currentTurnIndex = 0;
    this.menuLevel = 'root';
    this.slotEffects = {}; // { [slotId]: [{ id, element, turns, tickPctMaxHP }] }
  }

  init(data) {
    this.partyData = data.party || [];
    this.combatType = data.mode || 'normal';
    this.isTraining = (this.combatType === 'pit');
    this.scenarioId = data.scenarioId || 'training_encounter_1';
    // === Reactions UI state ===
    this._rxSelection = [];
    // Store scenario data if available
    this.scenarioData = COMBAT_SCENARIOS[this.scenarioId] || null;
  }

  create() {
    this.add.rectangle(640, 360, 1280, 720, 0x000000).setDepth(-1);
    this.scene.sleep('TownScene');
    this.scene.sleep('UIScene');

    const { width, height } = this.sys.game.canvas;

    // Setup battlefield and units
    this._createBattleSlots();
    this._placePartyMembers();
    this._placeEnemies(this.scenarioId);

    // Build fixed turn order (decided at combat start)
    this.turnOrder = [...GameState.party, ...(this.enemies || [])];
    this.turnOrder.sort((a, b) => computeEffectiveInitiative(b) - computeEffectiveInitiative(a));


    // Seed Initiative Gauge (resource)
    for (const u of this.turnOrder) {
      if (u.initiativeGaugeMax == null) u.initiativeGaugeMax = 100; // default cap
      if (u.initiativeGauge == null) u.initiativeGauge = 0;         // starts empty
    }

    // Core UI
    this._createTurnOrderUI();
    this._createActionMenu(width - 320, height - 240);
    this._createActionLights(width - 320, height - 280);
    this._createEndTurnButton(width - 160, height - 60);
    this._highlightCurrentTurn();
    this._createCombatLog();

    // Systems
    this.bus = new EventBus();
    this.reactions = new ReactionSystem(this, this.bus);
    this.reactions.install();

    // === IMPORTANT CHANGE ===
    // Do NOT hand-roll the first turn. Use the same pipeline as every other turn.
    // This ensures the first actor gets start-of-turn effects and the initiative gauge tick.
    this.currentTurnIndex = -1;      // so _advanceTurn() moves to index 0
    this._advanceTurn();             // handles UI gating + AI on enemy turns

    // Training messaging
    if (this.isTraining && this.scenarioData) {
      this._log(`🏋️ Training: ${this.scenarioData.name}`);
      this._log(this.scenarioData.description);
      console.log(`Training: ${this.scenarioData.name}`);
    } else if (this.isTraining) {
      this._log('🏋️ Training begins…');
      console.log('Training begins…');
    }

    this.turnOrderVisible = true;
    if (this.isTraining) this._addExitButton();

    // Character info panel (unchanged)
    const panelX = 475;
    const panelY = 470;
    const panelWidth = 400;
    const panelHeight = 210;

    this.characterInfoPanelX = panelX;
    this.characterInfoPanelY = panelY;
    this.characterInfoPanelWidth = panelWidth;
    this.characterInfoPanelHeight = panelHeight;

    this.characterInfoPanel = this.add.container(panelX, panelY)
      .setDepth(UI_DEPTH.overlay + 1)
      .setVisible(false);

    this.characterInfoText = null;
    this.characterInfoMask = null;
    this.characterScrollZone = null;
    this.isHoveringCharacterInfo = false;
    this.characterInfoTab = 'info'; // 'info' | 'equipment'

    // Input enable delay (unchanged)
    this.input.enabled = false;
    this.time.delayedCall(200, () => {
      this.input.enabled = true;
    });

    console.log('[DEBUG] Current character skill list:', GameState.party[0].skills);
    this.events.once('shutdown', this._shutdownCleanup, this);
  }

  _createCombatLog() {
    const x = 20;
    const y = 500;
    const width = 440;
    const height = 140;

    // Background box
    const bg = this.add.rectangle(x, y, width, height, 0x000000, 0.6)
      .setOrigin(0)
      .setStrokeStyle(2, 0xffffff)
      .setDepth(UI_DEPTH.overlay);

    // Scrollable text
    this.combatLogText = this.add.text(x + 10, y + 10, '', {
      fontSize: '14px',
      color: '#eeeeee',
      wordWrap: { width: width - 20 }
    }).setOrigin(0, 0).setDepth(UI_DEPTH.overlay);

    // Mask for scroll area
    const shape = this.make.graphics();
    shape.fillStyle(0xffffff);
    shape.fillRect(x, y, width, height);
    const mask = shape.createGeometryMask();
    this.combatLogText.setMask(mask);

    // Scroll zone to detect hover
    this.logScrollZone = this.add.zone(x, y, width, height)
      .setOrigin(0)
      .setInteractive()
      .setDepth(UI_DEPTH.overlay);

    this.isHoveringCombatLog = false;

    this.logScrollZone.on('pointerover', () => {
      this.isHoveringCombatLog = true;
    });

    this.logScrollZone.on('pointerout', () => {
      this.isHoveringCombatLog = false;
    });

    this.logEntries = [];

    this.input.on('wheel', (pointer, gameObjects, deltaX, deltaY) => {
      if (!this.isHoveringCombatLog) return;
      this.combatLogText.y -= deltaY * 0.25;
      this.combatLogText.y = Phaser.Math.Clamp(
        this.combatLogText.y,
        y + height - this.combatLogText.height - 10,
        y + 10
      );
    });
  }
  _displayNameForSkill(user, skill) {
    const r = user?.race;
    if (skill.id === 'move_step') {
      return ({ Human: 'Tactical Reposition', Dwarf: 'Stone Step', Elf: 'Feystride' }[r]) || skill.name;
    }
    if (skill.id === 'move_dash') {
      return ({ Ferrow: 'Gust Shift', Wylett: 'Briar Dash', Skith: 'Scale Slide' }[r]) || skill.name;
    }
    return skill.name;
  }


  _log(text) {
    this.logEntries.push(text);
    this.combatLogText.setText(this.logEntries.join('\n'));

    // If not hovering, auto-scroll to newest entry
    if (!this.isHoveringCombatLog) {
      const textHeight = this.combatLogText.height;
      const viewHeight = 140; // your combat log height
      const baseY = 500 + 10; // original Y + 10 padding

      const offset = Math.max(textHeight - viewHeight + 10, 0);
      this.combatLogText.y = baseY - offset;
    }
  }


  _createBattleSlots() {
    const allyPositions = [
      { x: 200, y: 100 }, // Slot 8 (Back top)
      { x: 200, y: 180 }, // Slot 7
      { x: 200, y: 260 }, // Slot 6

      { x: 380, y: 160 }, // Slot 4 (Mid top)
      { x: 380, y: 240 }, // Slot 5 (Mid bottom)

      { x: 560, y: 120 }, // Slot 3
      { x: 560, y: 200 }, // Slot 2
      { x: 560, y: 280 }, // Slot 1
    ];

    const enemyPositions = [
      { x: 1080, y: 100 }, // Slot 8
      { x: 1080, y: 180 }, // Slot 7
      { x: 1080, y: 260 }, // Slot 6

      { x: 900, y: 160 }, // Slot 4
      { x: 900, y: 240 }, // Slot 5

      { x: 720, y: 120 }, // Slot 3
      { x: 720, y: 200 }, // Slot 2
      { x: 720, y: 280 }, // Slot 1
    ];

    // ---- Ally slots ------------------------------------------------
    this.allySlots = allyPositions.map((pos, index) => {
      const container = this.add.container(pos.x, pos.y).setSize(64, 64);

      // Centre‑anchored 64×64 hit‑area
      container.setInteractive(
        new Phaser.Geom.Rectangle(0, 0, 64, 64),
        Phaser.Geom.Rectangle.Contains,
        true           // hand cursor
      );

      // Border (also centre‑anchored, so (0,0) is the slot centre)
      const rect = this.add.rectangle(0, 0, 64, 64, 0x000000, 0.2)
        .setOrigin(0.5)
        .setStrokeStyle(2, 0xffffff);

      container.add(rect);

      container.slotId = 8 - index;
      container.occupied = false;
      container.rect = rect;
      return container;
    });

    // ---- Enemy slots -----------------------------------------------
    this.enemySlots = enemyPositions.map((pos, index) => {
      const container = this.add.container(pos.x, pos.y).setSize(64, 64);

      container.setInteractive(
        new Phaser.Geom.Rectangle(0, 0, 64, 64),
        Phaser.Geom.Rectangle.Contains,
        true
      );

      const rect = this.add.rectangle(0, 0, 64, 64, 0x330000, 0.2)
        .setOrigin(0.5)
        .setStrokeStyle(2, 0xff4444);

      container.add(rect);

      container.slotId = 8 - index;
      container.occupied = false;
      container.rect = rect;
      return container;
    });



    // For unified logic (like targeting), combine both into one list
    this.unitSlots = [...this.allySlots, ...this.enemySlots];
    this.allSlots = [...this.unitSlots]; // or combine other slot arrays if applicable

  }
  _findOpenSlotOnSide(unit, targetColumn) {
    const sideSlots = unit.isEnemy ? this.enemySlots : this.allySlots;
    // Prefer same row; fall back to any in that column
    const sameRowId = unit._slot?.slotId;
    const sameRow = sideSlots.find(s => this._getColumnBySlotId(s.slotId) === targetColumn
      && !s.occupied
      && (sameRowId ? (s.slotId % 3) === (sameRowId % 3) : true));
    if (sameRow) return sameRow;
    return sideSlots.find(s => this._getColumnBySlotId(s.slotId) === targetColumn && !s.occupied) || null;
  }

  _moveUnitToSlot(unit, newSlot) {
    if (!unit?._slot || !newSlot || newSlot.occupied) return false;

    // Hard side-guard: never cross sides
    const isEnemyDest = this.enemySlots?.includes(newSlot);
    const isAllyDest = this.allySlots?.includes(newSlot);
    if (unit.isEnemy && !isEnemyDest) return false;
    if (!unit.isEnemy && !isAllyDest) return false;

    // --- clear old slot ties ---
    const old = unit._slot;
    if (old) {
      old.char = null;
      old.occupied = false;
      this._clearPortrait?.(old); // remove old visuals but keep the container
    }

    // --- assign new slot ---
    newSlot.char = unit;
    newSlot.occupied = true;
    unit._slot = newSlot;

    // --- rebuild visuals at destination ---
    // Use your existing portrait builder (works for both allies and enemies)
    if (typeof this._placePortrait === 'function') {
      this._placePortrait(unit, newSlot);
    }

    return true;
  }


  // Use only the unit's side and respect the return value.
  _enemyTryShuffleOneColumn(npc) {
    const slotId = npc?._slot?.slotId;
    if (!slotId) return false;

    const toBack = { 1: 4, 2: 5, 3: 6, 4: 7, 5: 8 };
    const toFront = { 6: 3, 5: 2, 4: 1, 7: 4, 8: 5 };

    const tryIds = [];
    if (toBack[slotId]) tryIds.push(toBack[slotId]);
    if (toFront[slotId]) tryIds.push(toFront[slotId]);

    const side = npc.isEnemy ? this.enemySlots : this.allySlots;
    for (const destId of tryIds) {
      const dest = side.find(s => s.slotId === destId && !s.occupied);
      if (dest && this._moveUnitToSlot(npc, dest)) return true;
    }
    return false;
  }

  _enemyTryShuffleOneColumn(npc) {
    const slotId = npc?._slot?.slotId;
    if (!slotId) return false;

    const toBack = { 1: 4, 2: 5, 3: 6, 4: 7, 5: 8 };
    const toFront = { 6: 3, 5: 2, 4: 1, 7: 4, 8: 5 };

    const tryIds = [];
    if (toBack[slotId]) tryIds.push(toBack[slotId]);
    if (toFront[slotId]) tryIds.push(toFront[slotId]);

    const side = npc.isEnemy ? this.enemySlots : this.allySlots;
    for (const destId of tryIds) {
      const dest = side.find(s => s.slotId === destId && !s.occupied);
      if (dest && this._moveUnitToSlot(npc, dest)) return true;
    }
    return false;
  }

  _enemyTryStepTowardFront(npc) {
    const slotId = npc?._slot?.slotId;
    if (!slotId) return false;

    const forward = { 6: 3, 5: 2, 4: 1, 7: 4, 8: 5 };
    const destId = forward[slotId];
    if (!destId) return false;

    const side = npc.isEnemy ? this.enemySlots : this.allySlots;
    const dest = side.find(s => s.slotId === destId && !s.occupied);
    return dest ? this._moveUnitToSlot(npc, dest) : false;
  }


  _placePartyMembers() {
    // Build lookup: instanceId -> char
    const party = GameState.party || [];
    const idToChar = new Map(party.map(c => [c.instanceId || c.id, c]));

    // 1) First, place anyone with an explicit saved slot
    const slotMap = GameState.partySlots || {};
    const used = new Set();

    this.allySlots.forEach(slot => {
      const wantedId = slotMap[slot.slotId];
      if (!wantedId) return;

      const char = idToChar.get(wantedId);
      if (!char || used.has(char)) return;

      this._prepareCharForBattle(char);
      this._assignCharToSlot(char, slot);
      this._refreshStatusEffectIcons?.(char);
      used.add(char);
    });

    // 2) Fill remaining ally slots left→right with remaining party members
    for (const char of party) {
      if (used.has(char)) continue;
      const open = this.allySlots.find(s => !s.occupied);
      if (!open) break;
      this._prepareCharForBattle(char);
      this._assignCharToSlot(char, open);
      this._refreshStatusEffectIcons?.(char);
      used.add(char);
    }
  }

  // small helpers (drop right under it)
  _prepareCharForBattle(char) {
    rebuildCharacterStats(char);
    const weaponData = getEquippedItemData(char.equipment?.weaponMain);
    char.weaponType = weaponData?.weaponType || null;

    // Weakness state + per-turn derived bucket
    char.weakness = makeWeaknessState();
    char._weaknessDerived = char._weaknessDerived || { maxHPDown: 0, evasionDown: 0, initiativeSlow: 0 };
    char.healingReceivedBonus = (char.healingReceivedBonus == null) ? 1.0 : char.healingReceivedBonus;

    // Side flags
    char.isEnemy = false;  // explicit
    char.team = 'ally';
  }


  _assignCharToSlot(char, slot) {
    const sprite = this.add.image(0, 0, char.skin).setDisplaySize(64, 64).setInteractive();
    const classColor = CLASS_COLORS?.[char.baseClass] || '#ffffff';
    const nameText = this.add.text(0, 32, char.name, { fontSize: '14px', color: classColor }).setOrigin(0.5, 0);

    const barY = 0;
    const hpBar = new StatusBar(this, -50, barY, 60, 6, char.currentHP, char.maxHP, 0xff4444, 'HP');
    const mpBar = new StatusBar(this, -42, barY, 60, 6, char.currentMP, char.maxMP, 0x4444ff, 'MP');
    hpBar.setAngle(-90);
    mpBar.setAngle(-90);

    sprite.on('pointerdown', () => this._showCharacterInfo(char));

    slot.add([sprite, nameText, hpBar, mpBar]);
    slot.occupied = true;
    slot.char = char;

    char._slot = slot;
    char.icon = sprite;
    char.hpBar = hpBar;
    char.mpBar = mpBar;
  }



  _placeEnemies(scenarioId = 'training_encounter_1') {
    this.enemies = [];

    const scenario = COMBAT_SCENARIOS[scenarioId];
    if (!scenario) {
      console.error(`Scenario not found: ${scenarioId}`);
      return;
    }

    scenario.enemies.forEach(config => {
      const template = ENEMY_TYPES[config.type];
      if (!template) {
        console.error(`Enemy type not found: ${config.type}`);
        return;
      }

      // Normalize base stats
      const maxHP = Number.isFinite(template.maxHP) ? template.maxHP : 1;
      const maxMP = Number.isFinite(template.maxMP) ? template.maxMP : 0;

      const enemy = {
        ...template,                       // base stats / ai / sprites, etc.
        type: config.type,
        name: template.name || config.type,
        currentHP: Number.isFinite(config.hp) ? config.hp : maxHP,
        maxHP,
        currentMP: maxMP,
        maxMP,
        slotId: config.slotId,
        status: 'alive',
        isEnemy: true,                     // ✅ critical flag
        team: 'enemy',
        actionsLeft: { major: 1, bonus: 1, class: 1, reaction: 1 },

        // Ensure skills is an array (some templates may omit)
        skills: Array.isArray(template.skills) ? [...template.skills] : [],

        // Initialize weakness + per-turn derived bag
        weakness: makeWeaknessState(),
        _weaknessDerived: { maxHPDown: 0, evasionDown: 0, initiativeSlow: 0 },
        healingReceivedBonus: 1.0
      };

      // Find target slot
      const slot = this.enemySlots?.find(s => s.slotId === config.slotId);
      if (!slot) {
        console.error(`Enemy slot not found: ${config.slotId}`);
        return;
      }

      slot.occupied = true;
      slot.char = enemy;
      enemy._slot = slot;

      this._placePortrait(enemy, slot);
      this._refreshStatusEffectIcons?.(enemy);
      this.enemies.push(enemy);
    });
  }


  // ===== Character Info Panel: Tabs & Body (RIGHT-ALIGNED) ===================
  _buildCharacterInfoTabs(char) {
    // Clean old tabs
    if (this._charInfoTabButtons) this._charInfoTabButtons.forEach(b => b.destroy());
    this._charInfoTabButtons = [];

    const panelPad = 10;
    const width = this.characterInfoPanelWidth || 400;
    const rightX = width - panelPad;
    const tabsY = 28 - 20; // moved up 20px

    const makeTab = (label, tabKey, rightOffsetPx) => {
      const w = 100, h = 22, gap = 6;
      const xLeft = (rightX - rightOffsetPx) - w;  // align to right edge
      const isActive = (this.characterInfoTab === tabKey);

      const bg = this.add.rectangle(xLeft, tabsY, w, h, isActive ? 0x333333 : 0x222222, 1)
        .setOrigin(0, 0)
        .setStrokeStyle(1, isActive ? 0xffffff : 0x888888)
        .setInteractive({ useHandCursor: true });

      const txt = this.add.text(xLeft + 10, tabsY + 2, label, {
        fontSize: '14px',
        color: isActive ? '#ffffff' : '#cccccc'
      }).setOrigin(0, 0).setInteractive({ useHandCursor: true });

      const handler = () => {
        if (this.characterInfoTab === tabKey) return;
        this.characterInfoTab = tabKey;
        this._renderCharacterInfoBody(char);
        this._buildCharacterInfoTabs(char);
      };
      bg.on('pointerdown', handler);
      txt.on('pointerdown', handler);

      this.characterInfoPanel.add(bg);
      this.characterInfoPanel.add(txt);
      this._charInfoTabButtons.push(bg, txt);

      return w + gap; // consume width to the left
    };

    // Build from the right edge inward: Equipment (right), Info (left of it)
    let offset = 0;
    offset += makeTab('Equipment', 'equipment', offset);
    offset += makeTab('Weakness', 'weakness', offset);
    offset += makeTab('Info', 'info', offset);
  }

  /** Clear only the changing body area, keep bg/header/tabs intact */

  _clearCharacterInfoBody() {
    if (this._charInfoBodyGroup) this._charInfoBodyGroup.forEach(c => c.destroy());
    this._charInfoBodyGroup = [];
  }
  // Right-aligned stats body
  _renderCharacterInfoStats(char) {
    this._clearCharacterInfoBody();

    const panelPad = 10;
    const width = this.characterInfoPanelWidth || 400;

    const rightX = width - panelPad - 2;         // right column (unchanged)
    const midX = Math.floor(width * 0.50) + 80; // MIDDLE COLUMN SHIFTED +80px
    const leftX = panelPad;                     // bottom-left (name/level)

    const startY = 40;   // same effective as your previous (60 - 20)
    const fontPx = 14;
    const lineH = 14;   // tight spacing
    const gap = 6;

    const stats = char.totalStats || {};
    const derived = char.derived || {};
    const eff = (typeof getEffectiveDerived === 'function') ? getEffectiveDerived(char) : (derived || {});

    // Effective evasion with Cold penalty
    let evEff = eff.Evasion | 0;
    try { evEff = applyColdEvasionPenalty(char, evEff); } catch { }
    const baseEv = eff.Evasion | 0;
    let evColor = '#eeeeee';
    if (evEff < baseEv) evColor = '#ff6666';
    else if (evEff > baseEv) evColor = '#66ff66';

    // Middle column values
    const pdr = getEffectivePDR?.(char) ?? 0;
    const mdr = getEffectiveMDR?.(char) ?? 0;
    const healPct = getHealingReceivedMult?.(char) ?? 100;
    const costMult = this._getDisorientCostMult(char);
    const effMaxHP = Math.max(1, Math.floor((char.maxHP | 0) * (1 - (char._weaknessDerived?.maxHPDown || 0))));
    const dispHP = Math.min(char.currentHP | 0, effMaxHP);

    // ===== Right column (original list) =====
    const rowsRight = [
      { label: 'HP:', value: `${dispHP}/${effMaxHP}` },
      { label: 'MP:', value: `${char.currentMP}/${char.maxMP}` },
      { label: 'STR:', value: `${stats.STR ?? 0}` },
      { label: 'DEX:', value: `${stats.DEX ?? 0}` },
      { label: 'CON:', value: `${stats.CON ?? 0}` },
      { label: 'INT:', value: `${stats.INT ?? 0}` },
      { label: 'WIS:', value: `${stats.WIS ?? 0}` },
      { label: 'CHA:', value: `${stats.CHA ?? 0}` },
      { label: 'Accuracy:', value: `${derived.Accuracy ?? 0}` },
      { label: 'Evasion:', value: `${evEff}`, valueColor: evColor, valueBold: true },
      { label: 'Crit Chance:', value: `${derived.CritChance ?? 0}` },
      { label: 'Init Gauge:', value: `${char.initiativeGauge ?? 0}/${char.initiativeGaugeMax ?? 100}` },
    ];

    // ===== Middle column (aligned to HP row Y) =====
    const rowsMid = [
      { label: 'PDR:', value: `${pdr}%` },
      { label: 'MDR:', value: `${mdr}%` },
      { label: 'Healing Recv:', value: `${healPct}%` },
      { label: 'Cost Mult:', value: `×${costMult.toFixed(2)}`, valueColor: (costMult > 1 ? '#ffcc66' : '#eeeeee'), valueBold: costMult > 1 },
    ];

    // === Crit Vuln (beneath Cost Mult) — ultra compact ===
    (() => {
      const w = char?.weakness;
      let line = '-';
      let color = '#cccccc';
      let bold = false;

      if (w && (w.tiers?.expose | 0) >= 2) {
        const m = w.meters?.expose | 0;
        const I = familyIntensityMult?.('expose', m) ?? 1;

        const ccPct = Math.round(((WeaknessV3?.families?.expose?.t2?.critChanceBonus ?? 0) * I) * 100);
        const cdPct = Math.round(((WeaknessV3?.families?.expose?.t2?.critDamageBonus ?? 0) * 100));

        // e.g., "35%, 25% cm"
        line = `${ccPct}%, ${cdPct}% CDB`;
        color = '#ffbb66';
        bold = true;
      }

      // Label is "Crit:" so the final line reads "Crit: 35%, 25% cm"
      rowsMid.push({ label: 'Crit Vuln.:', value: line, valueColor: color, valueBold: bold });
    })();




    const labelStyle = { fontSize: `${fontPx}px`, color: '#cccccc', align: 'right' };
    const valueBase = { fontSize: `${fontPx}px`, align: 'right', stroke: '#111111', strokeThickness: 1 };

    // --- RIGHT column ---
    rowsRight.forEach((row, idx) => {
      const y = startY + idx * lineH;

      const valueText = this.add.text(rightX, y, row.value, {
        ...valueBase,
        color: row.valueColor || '#eeeeee',
        fontStyle: row.valueBold ? 'bold' : 'normal'
      }).setOrigin(1, 0);
      this.characterInfoPanel.add(valueText);
      this._charInfoBodyGroup.push(valueText);

      const labelX = rightX - valueText.width - gap;
      const labelText = this.add.text(labelX, y, row.label, labelStyle).setOrigin(1, 0);
      this.characterInfoPanel.add(labelText);
      this._charInfoBodyGroup.push(labelText);
    });

    // --- MIDDLE column (3 rows), aligned to HP row Y ---
    rowsMid.forEach((row, idx) => {
      const y = startY + idx * lineH; // align with HP, MP, STR, ...
      const valueText = this.add.text(midX, y, row.value, {
        ...valueBase,
        color: '#eeeeee'
      }).setOrigin(1, 0);
      this.characterInfoPanel.add(valueText);
      this._charInfoBodyGroup.push(valueText);

      const labelX = midX - valueText.width - gap;
      const labelText = this.add.text(labelX, y, row.label, labelStyle).setOrigin(1, 0);
      this.characterInfoPanel.add(labelText);
      this._charInfoBodyGroup.push(labelText);
    });

  }


  // Clear only the header (portrait + name/level)
  _clearCharacterInfoHeader() {
    if (this._charInfoHeaderGroup) this._charInfoHeaderGroup.forEach(c => c.destroy());
    this._charInfoHeaderGroup = [];
  }

  // Build the persistent header: portrait on the left, name+level under it
  _renderCharacterInfoHeader(char) {
    if (!this.characterInfoPanel) return;
    if (!this._charInfoHeaderGroup) this._charInfoHeaderGroup = [];

    const x = 0, y = 0;
    const portraitX = x + 10;
    const portraitY = y + 40;

    // Portrait
    if (this._charPortrait) { this._charPortrait.destroy(); this._charPortrait = null; }
    const portraitKey = char.skin || `${(char.race || 'Human').toLowerCase()}_portrait_1`;
    if (this.textures.exists(portraitKey)) {
      const portrait = this.add.image(portraitX, portraitY, portraitKey).setOrigin(0, 0);
      this._fitSpriteScale(portrait, 90, 90); // same box as before
      this.characterInfoPanel.add(portrait);
      this._charPortrait = portrait;
      this._charInfoHeaderGroup.push(portrait);
    }

    // Name + Level directly under portrait
    const lvl = (char.level ?? char.totalStats?.Level ?? 1);
    const nameY = portraitY + 90 + 6; // 6px gap under portrait box
    const nameText = this.add.text(portraitX, nameY, `${char.name} (Lv ${lvl})`, {
      fontSize: '16px',
      color: '#ffffff',
      fontStyle: 'bold',
      stroke: '#111111',
      strokeThickness: 2
    }).setOrigin(0, 0);
    this.characterInfoPanel.add(nameText);
    this._charInfoHeaderGroup.push(nameText);
  }



  /** Render equipment body (single column, names only) */

  _renderCharacterInfoEquipment(char) {
    this._clearCharacterInfoBody();

    const panelPad = 10;
    const width = this.characterInfoPanelWidth || 400;
    const rightX = width - panelPad;
    const startY = 60 - 20; // moved up 20px

    const slots = ['weaponMain', 'weaponOff', 'head', 'chest', 'legs', 'gloves', 'boots', 'ring', 'amulet'];
    const labelMap = {
      weaponMain: 'Main Hand',
      weaponOff: 'Off Hand',
      head: 'Head',
      chest: 'Chest',
      legs: 'Legs',
      gloves: 'Gloves',
      boots: 'Boots',
      ring: 'Ring',
      amulet: 'Amulet'
    };

    let i = 0;
    slots.forEach(slot => {
      const equipped = char.equipment?.[slot];
      const data = getEquippedItemData(equipped);
      const name = data?.name || (isItemInstance(equipped) ? equipped.id : (equipped || 'None'));

      const t = this.add.text(rightX, startY + i * 18, `${labelMap[slot]}: ${name}`, {
        fontSize: '14px',
        color: '#cccccc',
        align: 'right'
      }).setOrigin(1, 0); // right align

      this.characterInfoPanel.add(t);
      this._charInfoBodyGroup.push(t);
      i++;
    });
  }

  /** Entry point for (re)building the body based on active tab */
  _renderCharacterInfoBody(char) {
    if (this.characterInfoTab === 'equipment') this._renderCharacterInfoEquipment(char);
    else if (this.characterInfoTab === 'weakness') this._renderCharacterInfoWeakness(char);  // ⬅️ NEW
    else this._renderCharacterInfoStats(char);
  }

  // Fit an image into a max box (keeps aspect) (PORTRAIT)
  _fitSpriteScale(sprite, maxW, maxH) {
    const tex = sprite.texture?.getSourceImage?.();
    if (!tex || !tex.width || !tex.height) return;
    const s = Math.min(maxW / tex.width, maxH / tex.height);
    sprite.setScale(s);
  }


  _showCharacterInfo(char) {
    if (!this.characterInfoPanel) return;

    this.characterInfoPanel.removeAll(true);
    this.characterInfoPanel.setVisible(true);

    const x = 0, y = 0;
    const width = this.characterInfoPanelWidth || 400;
    const height = this.characterInfoPanelHeight || 210;
    const rightX = width - 10;

    // Background
    const bg = this.add.rectangle(x, y, width, height, 0x111111, 0.85)
      .setOrigin(0)
      .setStrokeStyle(2, 0xffffff);
    this.characterInfoPanel.add(bg);
    // Persistent header: portrait + name/level under portrait, shows on all tabs
    this._clearCharacterInfoHeader();
    this._renderCharacterInfoHeader(char);


    //Who's shown
    this._inspectedChar = char;
    // Tabs
    this._buildCharacterInfoTabs(char);

    // Body
    this._renderCharacterInfoBody(char);
  }


  _getTierColor(tier, family) {
    if (tier <= 0) return 0x666666;

    // Elemental
    if (family === 'fire') return tier === 2 ? 0xff6b00 : 0xffc266;
    if (family === 'cold') return tier === 2 ? 0x66ccff : 0xb3e5ff;
    if (family === 'lightning') return tier === 2 ? 0xffff66 : 0xfff3b0;

    // Physical (keep distinct but readable)
    if (family === 'disorient') return tier === 2 ? 0xffcc00 : 0xffe680; // Dazed/Concussed
    if (family === 'lacerate') return tier === 2 ? 0xcc0022 : 0xff6680; // Bleeding/Hemorrhage
    if (family === 'expose') return tier === 2 ? 0xff8800 : 0xffbb66; // Exposed/Flayed

    // Necrotic
    if (family === 'toxic') return tier === 2 ? 0x00b300 : 0x66ff66; // Poisoned/Envenomed
    if (family === 'disease') return tier === 2 ? 0x99aa00 : 0xccdd55; // sickly olive
    if (family === 'curse') return tier === 2 ? 0x9933ff : 0xcc99ff; // violet

    return 0xcccccc;
  }


  _title(f) { return f.charAt(0).toUpperCase() + f.slice(1); }

  _renderCharacterInfoWeakness(char) {
    this._clearCharacterInfoBody();

    const panelPad = 10;
    const width = this.characterInfoPanelWidth || 400;
    const rightX = width - panelPad;  // right edge anchor
    const startY = 40;                // top of the lists
    const rowH = 20;
    const colGap = 165;               // distance from right column to middle column
    const vGap = 42;                   // vertical gap between Elemental and Necrotic stacks

    // Keep these exactly where they were visually:
    const elemental = ['fire', 'cold', 'lightning']; // right column (top)
    const physical = ['disorient', 'lacerate', 'expose'];     // middle column

    // Move Necrotic under Elemental in the right column (bottom-right)
    const necrotic = ['toxic', 'disease', 'curse'];

    const meters = char?.weakness?.meters || {};
    const tiers = char?.weakness?.tiers || {};

    const drawRow = (fam, xRight, yTop) => {
      const m = meters[fam] ?? 0;
      const t = tiers[fam] ?? 0;

      const text = this.add.text(xRight, yTop, `${this._title(fam)}: ${m} (T${t})`, {
        fontSize: '14px',
        color: '#eeeeee',
        align: 'right'
      }).setOrigin(1, 0);

      const pip = this.add.circle(xRight - text.width - 10, yTop + 8, 5, this._getTierColor(t, fam))
        .setVisible(t > 0);

      this.characterInfoPanel.add(text);
      this.characterInfoPanel.add(pip);
      this._charInfoBodyGroup.push(text, pip);
    };

    // Middle column: Physical (unchanged position)
    physical.forEach((fam, i) => drawRow(fam, rightX - colGap, startY + i * rowH));

    // Right column top: Elemental (unchanged position)
    elemental.forEach((fam, i) => drawRow(fam, rightX, startY + i * rowH));

    // Right column bottom: necrotic (moved under Elemental)
    const necroticStartY = startY + (elemental.length * rowH) + vGap;
    necrotic.forEach((fam, i) => drawRow(fam, rightX, necroticStartY + i * rowH));
  }





  //////////////////////////////////////////////////////////////////////////////////

  _createTurnOrderUI() {
    this.turnOrderVisible = true;

    // UI container (excluding the toggle)
    this.turnOrderUI = this.add.container(1080, 20).setDepth(UI_DEPTH.overlay);

    // Background + unit list
    this.turnOrderContent = this.add.container(0, 0);
    const bg = this.add.rectangle(0, 0, 180, 300, 0x222222, 0.9).setOrigin(0, 0);
    this.turnOrderContent.add(bg);

    const allUnits = this.turnOrder;
    allUnits.forEach((unit, i) => {
      const icon = this.add.text(10, 10 + i * 24, `${i + 1}. ${unit.name}`, {
        fontSize: '14px',
        color: '#ffffff'
      });
      this.turnOrderContent.add(icon);
    });

    // Add content to UI container
    this.turnOrderUI.add(this.turnOrderContent);

    // 🔁 Toggle Button (stays visible)
    const toggleBtn = this.add.text(1240, 25, '▼', {
      fontSize: '14px',
      color: '#ffffff',
      backgroundColor: '#000000',
      padding: { x: 4, y: 2 }
    }).setInteractive().setDepth(UI_DEPTH.overlay);

    toggleBtn.on('pointerdown', () => {
      this.turnOrderVisible = !this.turnOrderVisible;
      this.turnOrderContent.setVisible(this.turnOrderVisible);
      toggleBtn.setText(this.turnOrderVisible ? '▼' : '▲');
    });
  }


  _createEndTurnButton(x, y) {
    this.endTurnButton = new UIButton(this, x, y, 'End Turn', () => {
      const actor = this._currentChar?.();
      if (actor?.isEnemy) return;  // don’t let players skip NPCs
      this._advanceTurn();
    });
    this.add.existing(this.endTurnButton);
  }


  _createActionMenu(x, y) {
    const { width, height } = this.sys.game.canvas;
    this.actionMenu = this.add.container(x, y).setDepth(UI_DEPTH.overlay);

    // Ensure a single Tooltip instance for this scene
    if (!this.tooltip) {
      this.tooltip = new Tooltip(this);
      this.input.on('pointermove', (p) => this.tooltip.reposition(p.worldX, p.worldY));
    }

    // Safe to build now because _buildActionMenuRoot() will hide if not the player’s turn
    this._buildActionMenuRoot();

    this.turnNameText = this.add.text(width - 250, height - 310, '', {
      fontSize: '18px',
      fontStyle: 'bold',
      color: '#ffffff'
    }).setOrigin(0.5, 1).setDepth(UI_DEPTH.overlay);
  }

  _buildActionMenuRoot() {
    this.actionMenu.removeAll(true);
    const curr = this._currentChar?.();
    const isPlayerTurn = !!curr && !curr.isEnemy;

    if (!isPlayerTurn) {
      // Hide the player action UI entirely on enemy turn OR before first _advanceTurn()
      this.actionMenu.setVisible(false);
      this.endTurnButton?.setVisible(false);
      this.actionMenu.iterate?.(c => c.disableInteractive?.());
      return;
    }

    // Player turn: ensure UI is visible and interactive
    this.actionMenu.setVisible(true);
    this.endTurnButton?.setVisible(true);
    this.actionMenu.iterate?.(c => c.setInteractive?.()); // in case anything persisted disabled
    this.menuLevel = 'root';

    const buttons = [
      { label: 'Weapon Skills', handler: () => this._openSubmenu('weapon') },
      { label: 'Class Skills', handler: () => this._openSubmenu('class') },
      { label: 'Special', handler: () => this._openSubmenu('special') },
      { label: 'Reactions', handler: () => this._openSubmenu('reaction') },
      { label: 'Items', handler: () => this._openSubmenu('items') }
    ];

    buttons.forEach((b, i) => {
      const btn = new UIButton(this, 0, i * 50, b.label, b.handler);
      this.actionMenu.add(btn);
    });
  }

  _updateHealthBars() {
    const getEffMax = (u) => {
      const down = u?._weaknessDerived?.maxHPDown || 0;
      const base = u?.maxHP | 0;
      return Math.max(1, Math.floor(base * (1 - down)));
    };

    (GameState.party || []).forEach(char => {
      if (char?.hpBar) char.hpBar.update(char.currentHP, getEffMax(char));
    });

    (this.enemies || []).forEach(enemy => {
      if (enemy?.hpBar) enemy.hpBar.update(enemy.currentHP, getEffMax(enemy));
    });
  }


  // Build tooltip content for an ability (static fields only; no apply() call)
  _formatAbilityTooltip(ability, actor) {
    if (!ability) return { title: 'Unknown', lines: [], tags: [] };

    const lines = [];

    // Costs
    const costBits = [];
    if (ability.actionCost) costBits.push(`Action: ${String(ability.actionCost)}`);
    if (Number.isFinite(ability.mpCost) && ability.mpCost > 0) {
      let mpText = `MP: ${ability.mpCost}`;
      const w = actor?.weakness;
      if (w && ((w.tiers?.disorient | 0) >= 1)) {
        const m = w.meters?.disorient | 0;
        const I = familyIntensityMult('disorient', m);
        const base = WeaknessV3?.families?.disorient?.t1?.costMultiplier ?? 0;
        const cap = WeaknessV3?.families?.disorient?.t1?.costMultiplierCap ?? 0.75;
        const bump = Math.min(base * I, cap);
        const mult = 1 + bump;
        const eff = Math.max(0, Math.floor(ability.mpCost * mult));
        if (eff !== ability.mpCost) mpText = `MP: ${ability.mpCost} → ${eff}`;
      }
      costBits.push(mpText);
    }
    if (Number.isFinite(ability.hpCost) && ability.hpCost > 0) costBits.push(`HP: ${ability.hpCost}`);
    if (Number.isFinite(ability.cooldown) && ability.cooldown > 0) costBits.push(`CD: ${ability.cooldown}`);
    if (costBits.length) lines.push(costBits.join('  •  '));

    // Targeting / range
    const posArr = Array.isArray(ability.positionRequirement) ? ability.positionRequirement : (ability.positionRequirement ? [ability.positionRequirement] : []);
    const pos = posArr.length ? posArr.join('/') : '—';
    const tgt = ability.requiresTarget ? (ability.targetRequirement || 'enemy') : 'self/none';
    const colsArr = Array.isArray(ability.targetColumns) ? ability.targetColumns : [];
    const cols = colsArr.length ? `  •  Columns: ${colsArr.join(', ')}` : '';
    const rng = (ability.range != null) ? ability.range : '—';
    lines.push(`Range: ${rng}  •  Use from: ${pos}  •  Target: ${tgt}${cols}`);

    // Requirements
    const reqBits = [];
    if (ability.requiredStat) {
      const v = (ability.requiredValue != null) ? ability.requiredValue : '?';
      reqBits.push(`Req: ${ability.requiredStat} ≥ ${v}`);
    }
    const reqWpnArr = Array.isArray(ability.requiredWeapon) ? ability.requiredWeapon : (ability.requiredWeapon ? [ability.requiredWeapon] : []);
    if (reqWpnArr.length) reqBits.push(`Weapon: ${reqWpnArr.join(', ')}`);
    if (reqBits.length) lines.push(reqBits.join('  •  '));

    // AoE hint (static)
    const tags = Array.isArray(ability.tags) ? Array.from(new Set(ability.tags)) : [];
    if (tags.includes('aoe')) {
      const shape = ability.aoe?.shape || 'column';
      const scale = (ability.aoe?.scale != null) ? Math.round(ability.aoe.scale * 100) : 50;
      lines.push(`AoE: ${shape} splash (${scale}%)`);
    }

    // Hints
    if (ability.buildupHint && typeof ability.buildupHint === 'object') {
      const bu = Object.entries(ability.buildupHint).map(([k, v]) => `${k}+${v}`).join(', ');
      lines.push(`Buildup: ${bu}`);
    }
    if (ability.statusHint) lines.push(`Status: ${ability.statusHint}`);

    // Description
    if (ability.description) lines.push(String(ability.description));

    // Cooldown preview
    const cdRaw = actor?.cooldowns?.[ability.id] || 0;
    if (cdRaw > 0) {
      const cdShown = Math.max(0, cdRaw - 1);
      lines.push(`On cooldown: ${cdShown} turn${cdShown === 1 ? '' : 's'} remaining`);
    }

    const titleColor = (tags.includes('fire') && '#ffb37a')
      || (tags.includes('cold') && '#88cff2')
      || (tags.includes('lightning') && '#f0d35c')
      || (tags.includes('heal') && '#8fe0b0')
      || '#ffddaa';

    return {
      title: ability.name || ability.id || 'Ability',
      titleColor,
      lines,
      tags
    };
  }



  // Attach hover listeners to a UIButton that triggers an ability
  _wireAbilityTooltip(btn, ability, actor) {
    if (!btn || !ability) return;

    const safeShow = (pointer) => {
      try {
        const data = this._formatAbilityTooltip(ability, actor);
        this.tooltip?.show(pointer.worldX, pointer.worldY, data);
      } catch (err) {
        console.error('[tooltip error]', err, ability);
        this.tooltip?.show(pointer.worldX, pointer.worldY, {
          title: ability?.name || ability?.id || 'Ability',
          lines: [String(ability?.description || '')],
          tags: Array.isArray(ability?.tags) ? ability.tags : []
        });
      }
    };
    const move = (p) => this.tooltip?.reposition(p.worldX, p.worldY);
    const hide = () => this.tooltip?.hide();

    // Ensure container is interactive
    if (!btn.input?.enabled) btn.setInteractive?.({ useHandCursor: true });
    btn.on?.('pointerover', safeShow);
    btn.on?.('pointermove', move);
    btn.on?.('pointerout', hide);

  }



  _openReactionSubmenu() {
    this._clearActionMenu?.();

    const user = this._currentChar?.();
    if (!user) return;

    // Selection memory
    this._rxSelection = this._rxSelection || [];

    // Source data
    const abilities = (typeof getReactionSkillsFor === 'function')
      ? (getReactionSkillsFor(user) || [])
      : [];

    // Capacity / remaining triggers — prefer ReactionSystem helpers if present
    const cap = this.reactions?.capacity?.(user)
      ?? this._rxCapacityFor?.(user)
      ?? 2;
    const left = this.reactions?.remainingTriggers?.(user)
      ?? this._rxTriggersRemainingFor?.(user)
      ?? 1;

    const hasPoint = (user.actionsLeft?.reaction ?? 0) > 0;

    // Prepared set (to show ⦿)
    const preparedIds = new Set(
      (this.reactions?.listPrepared?.(user) || []).map(s => s.id)
    );

    // Header (aligned at x=0 like the buttons)
    const header = this.add.text(
      0, 0,
      `Select up to ${cap}. Will trigger ≤ ${left} before your next turn.`,
      { fontSize: '14px', color: '#ffddaa' }
    ).setOrigin(0, 0);
    this.actionMenu.add(header);

    // Layout constants (match your normal button vertical rhythm)
    let y = header.height + 8; // start buttons below header
    const ROW_H = 50;

    // Prepare Selected (standard UIButton)
    const prepBtn = new UIButton(
      this, 0, y,
      hasPoint ? 'Prepare Selected' : 'Prepare Selected (no reaction action)',
      () => {
        if (!hasPoint) {
          this._log?.(`${user.name} has no reaction actions left.`);
          return;
        }
        const chosen = (this._rxSelection || []).slice(0, cap);
        if (!chosen.length) {
          this._log?.('Nothing selected to prepare.');
          return;
        }
        for (const id of chosen) {
          const sk = SKILLS?.[id];
          if (sk) this.reactions?.arm?.(user, sk);
        }
        user.actionsLeft.reaction = Math.max(
          0, (user.actionsLeft.reaction || 0) - 1
        );
        this._rxSelection = [];
        this._log?.(`${user.name} prepares ${chosen.length} reaction${chosen.length > 1 ? 's' : ''}.`);
        this._openReactionSubmenu();   // rebuild view
        this._updateActionLights?.();  // refresh lights
      }
    );
    if (!hasPoint) prepBtn.setAlpha?.(0.5);
    this.actionMenu.add(prepBtn);
    y += ROW_H;

    // Reaction skills — each as a UIButton row in the SAME container
    const sel = new Set(this._rxSelection);
    abilities.forEach((a) => {
      const full = { ...(SKILLS?.[a.id] || a), id: a.id };
      const isPrepared = preparedIds.has(a.id);
      const isSelected = sel.has(a.id);

      const mark = isPrepared ? '⦿' : (isSelected ? '☑' : '☐');
      const name = this._displayNameForSkill
        ? this._displayNameForSkill(user, full)
        : (full.name || full.id);

      const btn = new UIButton(this, 0, y, `${mark} ${name}`, () => {
        if (isPrepared) return; // prepared entries are display-only
        const idx = this._rxSelection.indexOf(full.id);
        if (idx >= 0) {
          this._rxSelection.splice(idx, 1);
        } else {
          if (this._rxSelection.length >= cap) {
            this._log?.(`Reaction pool full (${cap}). Unselect one first.`);
            return;
          }
          this._rxSelection.push(full.id);
        }
        this._openReactionSubmenu(); // refresh the marks
      });

      // Slight visual hint for prepared rows (still using the same UIButton style)
      if (isPrepared) btn.setAlpha?.(0.9);

      // Tooltip on the whole button (not the label only)
      this._wireAbilityTooltip?.(btn, full, user);

      this.actionMenu.add(btn);
      y += ROW_H;
    });

    // Back (standard UIButton)
    const backBtn = new UIButton(this, 0, y + 8, '🔙 Back', () => {
      this._rxSelection = [];
      this._buildActionMenuRoot?.();
    });
    this.actionMenu.add(backBtn);
  }



  _openSubmenu(type) {

    // Special handling for Reactions: open the multi-select panel
    if (type === 'reaction') {
      this._openReactionSubmenu();
      return;
    }

    this._clearActionMenu();

    const actor = this._currentChar?.();
    if (!actor) return;

    // Get abilities once
    let abilities = this._getCurrentCharAbilities(type) || [];

    // SAFETY: never show reaction-mechanic skills in the Weapon submenu
    if (type === 'weapon') {
      abilities = abilities.filter(s => (s?.mechanic || '') !== 'reaction');
    }

    if (!abilities.length) {
      const noText = this.add.text(0, 0, 'No abilities available', {
        fontSize: '16px',
        color: '#888888'
      }).setOrigin(0);
      this.actionMenu.add(noText);

      // Back button
      this.actionMenu.add(
        new UIButton(this, 0, 50, '🔙 Back', () => this._buildActionMenuRoot())
      );
      return;
    }

    abilities.forEach((a, i) => {
      // HYDRATE from SKILLS so tooltip/labels have full data
      const full = (SKILLS[a?.id] || a);

      const cdRaw = actor.cooldowns?.[full.id] || 0;     // stored value includes grace
      const onCD = cdRaw > 0;
      const cdShown = Math.max(0, cdRaw - 1);              // show "real" remaining turns
      const noAction = full.actionCost && !this._canUseActionType(full.actionCost);

      const baseLabel = (this._displayNameForSkill
        ? this._displayNameForSkill(actor, full)
        : (full.name || a.name || 'Unnamed'));
      const label = onCD ? `${baseLabel} (CD${cdShown})` : baseLabel;

      const btn = new UIButton(this, 0, i * 50, label, () => {
        if (onCD || noAction) return;                      // hard gate: do nothing
        this._useAbility(full);                            // use the hydrated skill
      });

      // Make sure tooltip uses the hydrated object
      this._wireAbilityTooltip?.(btn, full, actor);

      btn.setAlpha((onCD || noAction) ? 0.35 : 1.0);
      this.actionMenu.add(btn);
    });

    // Back button
    const offsetY = abilities.length * 50 + 10;
    this.actionMenu.add(
      new UIButton(this, 0, offsetY, '🔙 Back', () => this._buildActionMenuRoot())
    );
  }


  _createActionLights(x, y) {
    this.actionLights = {
      major: this.add.circle(x, y, 6, 0x00ff00).setDepth(UI_DEPTH.overlay),
      bonus: this.add.circle(x + 20, y, 6, 0x00ff00).setDepth(UI_DEPTH.overlay),
      class: this.add.circle(x + 40, y, 6, 0x00ff00).setDepth(UI_DEPTH.overlay),
      reaction: this.add.circle(x + 60, y, 6, 0x00ff00).setDepth(UI_DEPTH.overlay)
    };
  }

  // Replace your _getCurrentCharAbilities() with this version
  _getCurrentCharAbilities(type) {
    const char = this._currentChar?.();
    if (!char) return [];

    switch (type) {
      case 'weapon':
        // exclude reaction skills from the Weapon submenu
        return getWeaponSkillsFor(char).filter(a => (a?.mechanic || '') !== 'reaction');

      case 'class':
        return getClassSkillsFor(char);

      case 'reaction':
        // keep: reaction skills live in their own submenu
        return getReactionSkillsFor(char);

      case 'special':
        return (char.skills || [])
          .filter(s => s.type === 'special')
          .map(s => ({ ...SKILLS[s.id] || s, id: s.id }));

      default:
        return [];
    }
  }




  _rxCapacityFor(char) {
    return this.reactions?.capacity?.(char) ?? (char?.reactionCapacity ?? 2);
  }
  _rxTriggersRemainingFor(char) {
    return this.reactions?.remainingTriggers?.(char) ?? (char?.reaction?.triggersRemaining ?? 1);
  }

  _canUseActionType(type) {
    const char = this._currentChar();
    return char.actionsLeft?.[type] > 0;
  }

  _useAbility(ability) {
    const type = ability.actionCost || 'major';
    if (!this._canUseActionType(type)) return;

    const actor = this._currentChar?.();
    if (!actor) return;

    // Cooldown gate BEFORE entering targeting mode
    const cdRemaining = actor.cooldowns?.[ability.id] || 0;
    if (cdRemaining > 0) {
      const visible = Math.max(0, cdRemaining - 1); // your “grace” tick model
      this._log(`${ability.name} is on cooldown${visible ? ` (${visible} turn${visible > 1 ? 's' : ''} left)` : ''}.`);
      return;
    }

    // Enforce attacker positionRequirement if present
    if (ability.positionRequirement?.length) {
      const col = this._getUnitColumn(actor);
      if (!ability.positionRequirement.includes(col)) {
        this._log(`${actor.name} cannot use ${ability.name} from ${col}.`);
        return;
      }
    }

    // --- Targeted skills ---
    if (ability.requiresTarget) {
      // Position-targeting for movement/reposition skills
      if (ability.targetRequirement === 'position') {
        this._enterPositionTargeting(actor, ability);
        return;
      }
      // Normal targeting (enemy/ally/self/etc.)
      this._enterTargetingMode(ability);
      return;
    }

    // --- Non-target skills: assume self (expand later if needed) ---
    this._applyAbilityToTarget(actor, actor, ability);

    // NOTE: Do NOT decrement actions here; _applyAbilityToTarget handles action spending
    // for all non-reaction, non-class skills. Keep the UI refresh only.
    if (!actor.isEnemy) {
      this._updateActionLights?.();
      this._buildActionMenuRoot?.();
    }
  }



  _enterTargetingMode(ability) {
    console.log('[BasicAttack] Entering targeting mode');

    this.targetingAbility = ability;
    const slots = ability.targetRequirement === 'enemy' ? this.enemySlots : this.allySlots;
    console.log('[DEBUG] Targeting ability:', ability.name);
    console.log('[DEBUG] Target slots:', slots.map(s => s.char?.name || 'empty'));
    // Optional per-column target filter
    let filtered = slots;
    if (ability.targetColumns?.length) {
      filtered = slots.filter(s => {
        const col = this._getColumnBySlotId(s.slotId);
        return ability.targetColumns.includes(col);
      });
    }



    filtered.forEach(slot => {
      if (!slot.char || slot.char.status === 'incapacitated') return;



      /* ---- 1️⃣  Flush any old listeners on the sprite ---- */
      if (slot.char.icon) {
        slot.char.icon.removeAllListeners();
        slot.char.icon.disableInteractive();
      }

      /* ---- 2️⃣  Make the entire container clickable ---- */
      slot.removeAllListeners();          // safety
      slot.once('pointerdown', () => {
        console.log(`[${ability.name}] Clicked`, slot.char.name);
        this._applyAbilityToTarget(this._currentChar(), slot.char, ability);
        this._exitTargetingMode();
      });

      /* ---- 3️⃣  Gold outline for feedback ---- */
      slot.rect.setStrokeStyle(3, 0xffff00);
    });
  }


  _exitTargetingMode() {
    this._clearSlotHighlights();   // redraw green/red borders
    this._clearSlotListeners();    // remove targeting-mode listeners, keep hitboxes
    this.targetingAbility = null;  // clear ability selection
    // if you track this: this.targetingTargets = null;

    // Restore click handlers for all visible portraits/slots
    [...this.allySlots, ...this.enemySlots].forEach(slot => {
      const char = slot.char;
      if (!char || !char.icon || !char.icon.active) return;

      // Portrait
      char.icon.removeListener('pointerdown');  // remove only this event
      char.icon.setInteractive({ useHandCursor: true });
      char.icon.on('pointerdown', () => this._showCharacterInfo(char));

      // Slot (behind portrait)
      slot.removeListener('pointerdown');
      slot.setInteractive({ useHandCursor: true });
      slot.on('pointerdown', () => this._showCharacterInfo(char));
    });
  }

  //called in combatdefeat(training)
  _restorePartyFull(party) {
    party.forEach(char => {
      char.status = 'alive';
      char.currentHP = char.maxHP;
      char.currentMP = char.maxMP ?? char.currentMP;
      char.actionsLeft = { major: 1, bonus: 1, class: 1, reaction: 1 };
    });
  }



  _updateHPMPBars() {
    this.allSlots.forEach(slot => {
      if (slot.char) {
        slot.char.hpBar?.updateCurrent(slot.char.currentHP);
        slot.char.mpBar?.updateCurrent(slot.char.currentMP);
      }
    });
  }
  _checkVictoryCondition() {
    const anyEnemiesAlive = this.enemies.some(e => e?.status !== 'incapacitated');
    const anyAlliesAlive = GameState.party.some(p => p?.status !== 'incapacitated');

    if (!anyEnemiesAlive) {
      this._onCombatVictory();
    } else if (!anyAlliesAlive) {
      this._onCombatDefeat();
    }
  }

  _onCombatVictory() {
    this.combatEnded = true;
    let xpReward = 0;
    const xpSummary = [];

    if (this.isTraining) {
      this._log('🏆 Training complete — all party members are fully restored.');
      GameState.party.forEach(char => {
        char.status = 'alive';
        char.currentHP = char.maxHP;
        char.currentMP = char.maxMP;
      });
      xpReward = 10;
    } else {
      this._log('🎉 Victory! All enemies defeated.');
      this._reviveAlliesAfterVictory?.();
      xpReward = this._calculateXPReward();
    }

    GameState.party.forEach(char => {
      if (char.status !== 'dead') {
        char.experience += xpReward;
        let summary = `${char.name} gains ${xpReward} XP`;

        while (char.experience >= getXPNeededForLevel(char.level)) {
          char.experience -= getXPNeededForLevel(char.level);
          char.level++;
          applyLevelUp(char);
          summary += ` — Level Up! (Lv ${char.level})`;
        }

        xpSummary.push(summary);
      }
    });

    const uiScene = this.scene.get('UIScene');
    if (uiScene?.refreshUI) uiScene.refreshUI();

    // Pass summary to victory screen
    this._showVictoryScreen('Victory!', xpSummary);
  }


  _calculateXPReward() {
    // Temporary — can be scenario-based later
    return 25;
  }

  _onCombatDefeat() {
    this.combatEnded = true;  // stop all further turn/timer work

    if (this.isTraining) {
      this._log('⚠ Training lost — restoring party to full HP/MP.');
      this._restorePartyFull(GameState.party);
      this._showDefeatScreen('Defeat (Training)', 'You can retry immediately.', { showRetry: true, showExit: true });
    }
    else {
      this._log('💀 All allies knocked out. You were defeated.');
      GameState.party.forEach(char => {
        if (char.status === 'incapacitated') char.status = 'dead';
      });
      this._showDefeatScreen('Defeat', 'Return to town.');
    }
  }

  _reviveAlliesAfterVictory() {
    GameState.party.forEach(char => {
      if (char.status === 'incapacitated') {
        char.status = 'alive';
        char.currentHP = 1;
      }
    });
  }

  // === Cooldowns (centralized) =============================================
  // Policy: on use, set remaining = baseCooldown + 1 (grace). We tick at end
  // of *this* unit's turn. A skill is available only if remaining <= 0.

  _isSkillOnCooldown(char, skillId) {
    return (char.cooldowns?.[skillId] ?? 0) > 0;
  }
  _startSkillCooldown(char, skillId, base) {
    if (!char.cooldowns) char.cooldowns = {};
    const grace = Math.max(0, base || 0) + 1;
    char.cooldowns[skillId] = grace;
  }
  _tickCooldownsEndOfTurn(char) {
    if (!char?.cooldowns) return;
    for (const k of Object.keys(char.cooldowns)) {
      if (char.cooldowns[k] > 0) char.cooldowns[k] -= 1;
    }
  }

  // === Single skill executor ==============================================
  _executeSkill(user, skillId, target = null) {
    const skill = SKILLS[skillId];
    if (!skill) { this._log?.(`[WARN] Skill not found: ${skillId}`); return { ok: false }; }

    // Optional gating hook so skills can verify status tiers or custom rules
    if (typeof skill.canExecute === 'function') {
      const verdict = skill.canExecute({ user, target, scene: this }) ?? true;
      const failed = (typeof verdict === 'object') ? (verdict.ok === false) : (verdict === false);
      if (failed) {
        const reason = typeof verdict === 'object' ? verdict.reason : null;
        if (reason) this._log?.(reason);
        return { ok: false };
      }
    }

    if (skill.requiresWeakness) {
      const requirements = Array.isArray(skill.requiresWeakness)
        ? skill.requiresWeakness
        : [skill.requiresWeakness];

      for (const req of requirements) {
        const fam = req?.family;
        if (!fam) continue;

        const location = req.on === 'self' ? user : target;
        if (!location) {
          this._log?.(`${skill.name} fizzles — no ${(req.on === 'self') ? 'user' : 'target'} to check.`);
          return { ok: false };
        }

        const tiers = location.weakness?.tiers || {};
        const minTier = req.tierAtLeast ?? req.tier ?? 1;
        if ((tiers[fam] || 0) < minTier) {
          const who = req.on === 'self' ? user?.name || 'user' : target?.name || 'target';
          this._log?.(`${skill.name} fails — ${who} needs ${fam.toUpperCase()} T${minTier}.`);
          return { ok: false };
        }
      }
    }

    // Pre-checks only (let the pipeline handle actual payment/effects)
    if (user.currentMP < (skill.mpCost || 0)) {
      this._log(`${user.name} lacks the MP to use ${skill.name}.`);
      return { ok: false };
    }
    if (skill.actionCost && !(user.actionsLeft?.[skill.actionCost] > 0)) {
      this._log(`${user.name} has no ${skill.actionCost} actions left.`);
      return { ok: false };
    }
    if (this._isSkillOnCooldown(user, skill.id)) {
      this._log(`${skill.name} is on cooldown.`);
      return { ok: false };
    }
    if (skill.requiresTarget && !target) {
      this._log(`No target for ${skill.name}.`);
      return { ok: false };
    }

    // Use the *same* pipeline players use so damage actually lands,
    // reactions trigger, buildup happens, etc.
    this._applyAbilityToTarget(user, target, skill);

    // _applyAbilityToTarget is responsible for paying costs, starting cooldowns,
    // spending action buckets, logging, deaths, etc.
    return { ok: true };
  }


  _onUnitKnockedOut(unit) {
    this._log(`${unit.name} has been knocked out!`);
    unit.status = 'incapacitated';

    if (unit._slot) {
      unit._slot.char = null;
      this._clearPortrait(unit._slot);
      unit._slot.occupied = false;
      unit._slot = null;
    }

    // 🔧 Adjust turn index safely
    const removedIndex = this.turnOrder.indexOf(unit);
    this.turnOrder = this.turnOrder.filter(u => u !== unit);
    if (removedIndex !== -1 && removedIndex < this.currentTurnIndex) {
      this.currentTurnIndex = Math.max(0, this.currentTurnIndex - 1);
    }
    if (this.currentTurnIndex >= this.turnOrder.length) {
      this.currentTurnIndex = 0;
    }

    if (!this.koArea) this.koArea = [];
    this.koArea.push(unit);
    this._placeInKOArea(unit);

    this._checkVictoryCondition();
  }



  _placeInKOArea(unit) {
    const isEnemy = unit.isEnemy;
    const index = this.koArea.filter(u => u.isEnemy === isEnemy).length - 1;
    const spacing = 72;
    const x = isEnemy ? 800 + index * spacing : 200 + index * spacing;
    const y = 40;

    const sprite = this.add.image(x, y, unit.skin)
      .setDisplaySize(48, 48)
      .setAlpha(0.4)
      .setInteractive();

    sprite.on('pointerdown', () => {
      this._showCharacterInfo(unit);
    });

    const name = this.add.text(x, y + 28, unit.name, {
      fontSize: '12px',
      color: '#888888'
    }).setOrigin(0.5, 0);

    unit.icon = sprite;

    if (!this.koSprites) this.koSprites = [];
    this.koSprites.push(sprite, name);
  }



  _applyAbilityToTarget(user, target, ability, intentOverride = null) {
    // ===== Resource gate =====
    const baseMpCost = ability.mpCost || 0;
    let mpCost = baseMpCost;

    // 🤯 Disorient T1: increased skill costs
    if (user?.weakness && (user.weakness.tiers.disorient | 0) >= 1) {
      const t = user.weakness.tiers.disorient | 0;
      const baseMult = WeaknessV3.families.disorient.t1.costMult * (t === 2 ? 1.5 : 1);
      mpCost = Math.ceil(baseMpCost * (1 + baseMult));
    }

    if (user.currentMP < mpCost) {
      this._log(`${user.name} lacks the MP to use ${ability.name}.`);
      return;
    }

    // --- Optional gating: abilities may require a minimum CURSE tier on the target
    // ability.minCurseTier = 0 (default = no gate), 1 = Hexed+, 2 = Afflicted
    {
      const minTier = Number(ability?.minCurseTier) || 0;
      if (minTier > 0) {
        const ct = target?.weakness?.tiers?.curse | 0;
        if (ct < minTier) {
          this._log(`${ability.name} fizzles: ${target?.name || 'target'} is not at required CURSE tier (needs T${minTier}).`);
          return; // no costs, no cooldown, no on-act triggers
        }
      }
    }


    // === BEGIN v3: per-action weakness triggers (actor-side) ====================
    const actor = user;
    if (actor?.weakness) {
      const w = actor.weakness;
      const fam = (k) => (k in w.meters) ? k : (WeaknessAliases[k] || k);

      // FIRE T1: acting loses fire buildup (scaled by Fire's intensity)
      {
        if ((w.tiers?.fire | 0) >= 1) {
          const mFire = w.meters?.fire | 0;
          const baseLoss = WeaknessV3?.families?.fire?.t1?.onActLoss ?? 50;
          const I = familyIntensityMult?.('fire', mFire) ?? 1;
          const loss = Math.max(1, Math.floor(baseLoss * I));
          const before = mFire;
          w.meters.fire = Math.max(0, before - loss);
          this._log?.(`${actor.name} acts while Singed: Fire ${before} → ${w.meters.fire} (−${loss}, I=${I.toFixed(2)})`);
          // (Tier recompute handled below)
        }
      }

      // LACERATE T1+: Bleeding — any action adds bleed buildup to self (intensity & Expose-aware)
      {
        const lacId = fam('lacerate');
        if ((w.tiers?.[lacId] | 0) >= 1) {
          const mLac = w.meters?.[lacId] | 0;
          let add = WeaknessV3?.families?.lacerate?.t1?.onActBuildupFlat ?? 0; // per action

          // Scale by current Lacerate intensity
          const I_lac = familyIntensityMult?.('lacerate', mLac) ?? 1;
          add = Math.max(1, Math.round(add * (I_lac > 0 ? I_lac : 1)));

          // If actor is Exposed (T1+), they take extra physical buildup → Lacerate rises faster.
          try {
            const expId = fam('expose');
            if ((w.tiers?.[expId] | 0) >= 1) {
              const mExp = w.meters?.[expId] | 0;
              const I_exp = familyIntensityMult?.('expose', mExp) ?? 1;
              const bonus = WeaknessV3?.families?.expose?.t1?.physBuildupAmp ?? 0; // e.g. +0.15 at I=1
              add = Math.max(1, Math.round(add * (1 + bonus * (I_exp > 0 ? I_exp : 1))));
            }
          } catch { }

          const before = mLac;
          const after = before + add;
          w.meters[lacId] = after;
          this._log?.(`${actor.name} bleeds more: Lacerate ${before} → ${after} (+${after - before})`);
          // (Tier recompute handled below)
        }
      }

      // Recompute tiers for families we touched
      for (const k of ['fire', 'lacerate']) {
        const id = fam(k);
        const conf = WeaknessFamilies[id] || WeaknessFamilies[k];
        const m2 = w.meters[id] || 0;
        const newTier = (m2 >= conf.t2) ? 2 : (m2 >= conf.t1 ? 1 : 0);
        if (newTier !== (w.tiers[id] || 0)) {
          const oldTier = w.tiers[id] || 0;
          w.tiers[id] = newTier;
          this._onWeaknessTierChanged?.(actor, id, newTier, oldTier, { perAction: true });
        }
      }
    }
    // === END v3: per-action weakness triggers ==================================



    const attacker = user;
    const isMovement = !!(ability?.isMovement || ability?.targetRequirement === 'position');

    // Snapshot weakness tiers BEFORE any new buildup
    const prevTiers = { ...(target?.weakness?.tiers || {}) };

    // Execute ability to get its payload
    let result = {};
    try {
      result = ability.apply(user, target, this) || {};
    } catch (e) {
      console.error(`[Ability Error] ${ability.name}`, e);
      this._log(`⚠ ${ability.name} fizzled.`);
      return;
    }
    if (result && Array.isArray(result.statusEffects)) {
      this._addStatusEffects(target, result.statusEffects);
    }

    // ===== Establish intent & tags BEFORE reactions / hit checks =====
    const intent = intentOverride || { tags: ability.tags || [], isReaction: false };
    let resultMutable = { ...result };

    // Propagate helpful flags for downstream filters
    const hasAttackTag = (intent.tags || []).includes('attack') || (ability.tags || []).includes('attack');
    const isWeaponSource = ability.type === 'weapon' || hasAttackTag;
    if (resultMutable.isMagic) {
      intent.tags = Array.from(new Set([...(intent.tags || []), 'magic']));
    }
    if (isWeaponSource) {
      intent.tags = Array.from(new Set([...(intent.tags || []), 'attack']));
    }

    // === NEW: Roll to hit (Accuracy vs Evasion) BEFORE reactions land ==========
    // We only roll for weapon/attack-style abilities unless explicitly auto-hit.
    const usesHitRoll = isWeaponSource && ability.hitCheck !== 'none' && ability.autoHit !== true;
    let missed = false;
    let hitChanceShown = null;

    if (!isMovement && usesHitRoll) {
      const { hit, chance } = rollToHit(attacker, target, ability);
      hitChanceShown = chance;
      if (!hit) {
        missed = true;
        // force the result inert so nothing triggers from damage later
        resultMutable.amount = 0;
        resultMutable.ignoreDR = true;
        resultMutable.isHeal = false;
        resultMutable.buildup = null;
        resultMutable.splash = null;
      }
    }

    // ===== Reaction window: BEFORE damage lands on the defender =====
    // Only emit if not missed AND it is hostile & damaging/attack-y.
    if (!missed) {
      const differentTeams = (!!user?.isEnemy) !== (!!target?.isEnemy);
      const rawAmt = (resultMutable.amount | 0);
      const isDamaging = rawAmt > 0 || ability.dealsDamage === true;
      const allowSelfHit = differentTeams && isDamaging && isWeaponSource;

      if (allowSelfHit) {
        this.bus?.emit('self_hit', {
          attacker: user,
          target,
          ability,
          intent,
          incomingMutable: resultMutable
        });

        // Ally reactions (same column)
        try {
          const sameColumnAllies = (typeof this._getAlliesInSameColumn === 'function')
            ? this._getAlliesInSameColumn(target).filter(a =>
              a !== target && a.alive !== false && a.status !== 'incapacitated'
            )
            : (this._getAllies?.(target) || []).filter(a =>
              a !== target &&
              (a.position || a.column) === (target.position || target.column) &&
              a.alive !== false &&
              a.status !== 'incapacitated'
            );

          for (const ally of sameColumnAllies) {
            this.bus?.emit('ally_hit', {
              attacker: user,
              target,
              ally,
              ability,
              intent,
              incomingMutable: resultMutable
            });
          }
        } catch (e) {
          console.error('[ally_hit emit error]', e);
        }
      }
    }
    // ===== EXPOSE (defender) pre-damage shaping (ADDlTIVE) =====
    if (!missed) {
      try {
        applyExposePreDamage?.({ user, target, resultMutable, intent, isWeaponSource, missed });
      } catch (e) {
        console.error('[applyExposePreDamage]', e);
      }
    }

    // Debug log: show what Expose actually did this hit
    (() => {
      const ex = resultMutable._expose;
      if (!ex) return;
      const pct = (x) => `${Math.round((x ?? 0) * 100)}%`;

      if (ex.pdrBefore !== undefined && ex.pdrAfter !== undefined) {
        this._log?.(`Expose: PDR ${pct(ex.pdrBefore)}→${pct(ex.pdrAfter)} (−${pct(ex.pdrSub || 0)})`);
      }
      if (ex.critForced) {
        this._log?.(`Expose: forced crit (+${pct(ex.critChanceBonus || 0)} chance, +${pct(ex.critDmgBonus || 0)} crit dmg)`);
      } else if (ex.critAmpOnly) {
        this._log?.(`Expose: crit dmg +${pct(ex.critDmgBonus || 0)}`);
      }
    })();

    // Freeze the possibly-mutated result
    result = resultMutable;

    // If this ability is a PREP (e.g., Riposte), arm it now
    if (result?.armReaction) {
      this.reactions?.arm(user, ability);
    }

    // ===== Damage / Heal / Buildup pipeline (skip for pure movement) =====
    if (!isMovement) {
      const {
        amount = 0,
        isCrit = false,
        isHeal = false,
        isMagic = false
      } = result;

      // === NEW: Miss handling ===
      if (missed) {
        this._showFloatingText?.('DODGE', target);
        const hint = (hitChanceShown != null) ? ` (${hitChanceShown}% to hit)` : '';
        this._log(`${user.name} misses ${target.name}${hint}.`);

        // Costs/cooldown/action payment happens later as normal.
      } else if (isHeal) {
        const healed = Math.floor(amount * (target.healingReceivedBonus || 1.0));
        target.currentHP = Math.min(target.maxHP, target.currentHP + healed);
        if (healed > 0) {
          this._showFloatingNumber?.(healed, target, true);
          this._log(`${user.name} heals ${target.name} for ${healed}`);
        }
      } else {
        // === DAMAGE with Damage Reduction support ===
        const dealsDamage = !!ability.dealsDamage;
        const raw = Math.max(0, (amount | 0));
        const ignoreDR = !!result?.ignoreDR;
        const dr = ignoreDR ? 0 : Math.max(0, Math.min(0.9, result?.damageReduction || 0));

        const dmg = Math.max(0, Math.floor(raw * (1 - dr)));
        const blocked = raw - dmg;

        if (dealsDamage || dmg > 0) {
          target.currentHP = Math.max(0, target.currentHP - dmg);

          if (target.currentHP <= 0 && target.status !== 'incapacitated') {
            target.status = 'incapacitated';
            this._onUnitKnockedOut(target);
            if (this.combatEnded) return; // battle ended; stop here
          }

          this._showFloatingNumber?.(dmg, target, false, isCrit);

          const critText = isCrit ? ' (CRIT!)' : '';
          const typeText = isMagic ? ' magic' : '';
          const drText = (!ignoreDR && dr > 0)
            ? ` (DR ${Math.round(dr * 100)}%${blocked > 0 ? `, blocked ${blocked}` : ''})`
            : '';

          (() => {
            const bd = getLastDamageBreakdown?.() || null;

            // Try to read crit chance from breakdown, if present
            let critPct = null;
            if (bd && bd.length) {
              const entry = bd.find(e => e && e.label === 'critChance' && typeof e.value === 'number');
              if (entry) critPct = entry.value;
            }

            if (bd && bd.length) {
              const parts = [];
              let baseShown = false;

              for (const e of bd) {
                if (e.label === 'base' && !baseShown) {
                  parts.push(String(e.value));
                  baseShown = true;
                } else if (e.label === 'crit') {
                  // show crit mult as ×N.NN if present
                  const m = (e.mult != null) ? e.mult : (e.to && e.from ? (e.to / e.from) : 1.5);
                  parts.push(`×${(+m).toFixed(2)}`);
                } else if (e.label && e.flat) {
                  parts.push(`+${e.flat} ${e.label}`);
                } else if (e.label && e.mult && e.from != null && e.to != null) {
                  parts.push(`×${(e.mult).toFixed(2)} ${e.label}`);
                }
              }

              const formula = parts.join(' ');
              // If this hit crit, append the crit %; rely on existing critText to know if it crit
              const critSuffix = (critText && /CRIT/i.test(critText) && critPct != null)
                ? ` (crit ${Math.round(critPct)}%)`
                : '';

              this._log(
                `${user.name} hits ${target.name} for ${dmg}${typeText} damage${critText}${critSuffix}${drText}` +
                ` ⟵ ${formula}${hitChanceShown != null ? ` (${Math.round(hitChanceShown)}% to hit)` : ''}`
              );
            } else {
              const critSuffix = (critText && /CRIT/i.test(critText) && critPct != null)
                ? ` (crit ${Math.round(critPct)}%)`
                : '';
              this._log(
                `${user.name} hits ${target.name} for ${dmg}${typeText} damage${critText}${critSuffix}${drText}` +
                `${hitChanceShown != null ? ` (${Math.round(hitChanceShown)}% to hit)` : ''}`
              );
            }
          })();


        }
      }

      // Elemental buildup AFTER damage/heal (NOT on miss)
      if (!missed && result?.buildup) {
        this._applyWeaknessBuildup(target, result.buildup, { user, ability });
        if (this.characterInfoTab === 'weakness' && this._inspectedChar === target) {
          this._renderCharacterInfoBody(target);
        }
      }

      // ===== Splash fan-out (pre-computed payloads) =====
      if (!missed && Array.isArray(result?.splash) && result.splash.length) {
        for (const sp of result.splash) {
          if (!sp?.target) continue;
          this._applyDirectResult(user, sp.target, sp, { isSplash: true });
        }
      }
    }

    // ===== Post-apply logic (works for both movement and normal skills) =====

    // Recompute / snapshot tiers AFTER buildup
    this._recomputeWeaknessTiers?.(target);
    const currTiers = { ...(target?.weakness?.tiers || {}) };
    const crossed = (fam, tier) => (prevTiers[fam] || 0) < tier && (currTiers[fam] || 0) >= tier;

    // (1) Reward on tier-cross
    if (Array.isArray(result?.rewardIfTierCross)) {
      for (const rule of result.rewardIfTierCross) {
        const families = rule.family === 'any' ? ['fire', 'cold', 'lightning'] : [rule.family];
        for (const fam of families) {
          if (crossed(fam, rule.tier)) {
            if (rule.healHPpct) {
              const gain = Math.max(1, Math.floor((attacker.maxHP || 1) * rule.healHPpct));
              attacker.currentHP = Math.min(attacker.maxHP || gain, (attacker.currentHP || 0) + gain);
              this._log(`${attacker.name} recovers ${gain} HP (tier ${rule.tier} ${fam}).`);
            }
            if (rule.healMP) {
              attacker.currentMP = Math.max(0, (attacker.currentMP || 0) + rule.healMP);
              this._log(`${attacker.name} recovers ${rule.healMP} MP (tier ${rule.tier} ${fam}).`);
            }
            if (rule.buff) {
              this._applyRewardBuff(attacker, rule.buff, ability, { family: fam, tier: rule.tier });
            }
            if (rule.debuff) {
              this._applyRewardDebuff(target, rule.debuff, ability, { family: fam, tier: rule.tier });
            }
          }
        }
      }
    }

    // (2) Reward if target is already weak
    if (result?.rewardIfWeak) {
      const fam = result.rewardIfWeak.family;
      const minTier = result.rewardIfWeak.tierAtLeast || 1;
      if ((currTiers[fam] || 0) >= minTier) {
        if (result.rewardIfWeak.healHPpct) {
          const gain = Math.max(1, Math.floor((attacker.maxHP || 1) * result.rewardIfWeak.healHPpct));
          attacker.currentHP = Math.min(attacker.maxHP || gain, (attacker.currentHP || 0) + gain);
          this._log(`${attacker.name} siphons ${gain} HP (weak ${fam}).`);
        }
        if (result.rewardIfWeak.healMP) {
          attacker.currentMP = Math.max(0, (attacker.currentMP || 0) + result.rewardIfWeak.healMP);
          this._log(`${attacker.name} restores ${result.rewardIfWeak.healMP} MP (weak ${fam}).`);
        }
      }
    }

    // (3) Consume weaknesses
    if (Array.isArray(result?.consumeWeakness)) {
      for (const fam of result.consumeWeakness) {
        if (!target.weakness?.meters?.[fam]) continue;
        target.weakness.meters[fam] = 0;
        target.weakness.tiers[fam] = 0;
        this._log(`${target.name}'s ${fam} is consumed!`);
      }
      if (this.characterInfoTab === 'weakness' && this._inspectedChar === target) {
        this._renderCharacterInfoBody(target);
      }
    }

    // (4) Column/team buffs (ally-side)
    if (result?.teamBuff?.scope === 'column' && result.teamBuff.effect) {
      const allies = this._getAlliesInSameColumn(attacker);
      for (const a of allies) {
        a.statusEffects = a.statusEffects || [];
        a.statusEffects.push({ ...result.teamBuff.effect });
      }
      this._log(`${attacker.name} grants ${result.teamBuff.effect.id} to their column.`);
    }

    // (5) Slot effects on the target’s tile
    if (result?.slotEffect) {
      const sid = target?._slot?.slotId ?? target?.slotId;
      if (sid != null) {
        this.slotEffects = this.slotEffects || {};
        this.slotEffects[sid] = this.slotEffects[sid] || [];
        this.slotEffects[sid].push({ ...result.slotEffect });
        this._log(`${target.name}'s tile is affected by ${result.slotEffect.id} for ${result.slotEffect.turns} turns.`);
      }
    }

    // ---- Costs & cooldowns ----
    const payNow = !(result?.armReaction && result?.consumeOn === 'trigger');
    if (payNow && Number.isFinite(ability.mpCost) && ability.mpCost > 0) {
      let mpCost = ability.mpCost;

      // Disorient T1 (Dazed): increase skill MP costs (overflow-scaled, capped)
      const w = user?.weakness;
      if (w && ((w.tiers?.disorient | 0) >= 1)) {
        const m = w.meters?.disorient | 0;
        const I = familyIntensityMult('disorient', m);
        const base = WeaknessV3?.families?.disorient?.t1?.costMultiplier ?? 0;
        const cap = WeaknessV3?.families?.disorient?.t1?.costMultiplierCap ?? 0.75;
        const bump = Math.min(base * I, cap);    // 0..cap
        const mult = 1 + bump;

        const before = mpCost;
        mpCost = Math.max(0, Math.floor(mpCost * mult));
        this._log(`${user.name} is Dazed: MP cost ${before} → ${mpCost} (×${mult.toFixed(2)})`);
      }

      user.currentMP = Math.max(0, user.currentMP - mpCost);
    }

    const delayCD = result?.armReaction && result?.consumeOn === 'trigger';
    if (!delayCD && Number.isFinite(ability.cooldown) && ability.cooldown > 0) {
      if (!user.cooldowns) user.cooldowns = {};
      user.cooldowns[ability.id] = (ability.cooldown || 0) + 1; // your grace model
    }

    // Spend action pool for any non-reaction skill
    if (ability.actionCost) {
      const isCounter = intent?.isReaction === true;
      if (!isCounter) {
        const pool = user.actionsLeft || (user.actionsLeft = {});
        const cur = Number.isFinite(pool[ability.actionCost]) ? pool[ability.actionCost] : 0;
        pool[ability.actionCost] = Math.max(0, cur - 1);
      }
    }

    // ---- UI refresh ----
    this._updateHealthBars?.();
    this._updateHPMPBars?.();
    this._updateActionLights?.();
    if (!this._currentChar?.()?.isEnemy) this._buildActionMenuRoot?.();
    if (this.targetingAbility) this._exitTargetingMode();
  }


  _applyDirectResult(user, target, payload, opts = {}) {
    if (!target || !payload) return;

    // Damage / heal
    const amt = payload.amount | 0;
    const isHeal = !!payload.isHeal;

    if (amt !== 0) {
      if (isHeal) {
        const before = target.currentHP | 0;
        const after = Math.min((target.maxHP | 0) || before, before + Math.max(0, amt));
        const healed = after - before;
        target.currentHP = after;
        if (healed > 0) {
          this._showFloatingNumber?.(healed, target, /*isHeal=*/true, /*isCrit=*/false);
          this._log?.(`${user.name} heals ${target.name} for ${healed}.`);
        }
      } else {
        // Direct apply: you can route DR here later if you want ally cover to affect splash
        const before = target.currentHP | 0;
        const after = Math.max(0, before - Math.max(0, amt));
        const dealt = before - after;
        target.currentHP = after;
        this._showFloatingNumber?.(dealt, target, /*isHeal=*/false, /*isCrit=*/false);
        this._log?.(`${user.name} hits ${target.name} for ${dealt}${opts.isSplash ? ' (splash)' : ''}.`);
        if (after === 0 && target.status !== 'incapacitated') {
          target.status = 'incapacitated';
          this._onUnitKnockedOut?.(target);
        }
      }
      this._updateHealthBars?.(); this._updateHPMPBars?.();
    }

    // Status effects on splash payload
    if (payload.statusEffects?.length) {
      this._addStatusEffects(target, payload.statusEffects);
    }

    // Elemental buildup for splash victims (same hook as primary)
    if (payload.buildup) {
      this._applyWeaknessBuildup?.(target, payload.buildup, { user, ability: null });
      if (this.characterInfoTab === 'weakness' && this._inspectedChar === target) {
        this._renderCharacterInfoBody?.(target);
      }
    }
  }

  _startTurnStatusEffects(char) {
    const list = Array.isArray(char.statusEffects) ? char.statusEffects : [];
    if (list.length === 0) return { died: false, skip: false };

    let died = false;
    let skip = false;
    const keep = [];

    for (const se of list) {
      const name = (StatusEffects?.[se.id]?.name) || se.id;

      // DOT
      const tickDmg = se.tickDamage | 0;
      if (!died && tickDmg > 0) {
        const before = char.currentHP | 0;
        const after = Math.max(0, before - tickDmg);
        char.currentHP = after;
        this._showFloatingNumber?.(tickDmg, char, /*isHeal=*/false, /*isCrit=*/false);
        this._log?.(`${char.name} suffers ${tickDmg} damage from ${name}.`);
        this._updateHealthBars?.(); this._updateHPMPBars?.();
        if (after === 0 && char.status !== 'incapacitated') {
          char.status = 'incapacitated';
          this._onUnitKnockedOut?.(char);
          died = true;
        }
      }

      // HOT / regen
      const tickHeal = se.tickHeal | 0;
      if (!died && tickHeal > 0) {
        const before = char.currentHP | 0;
        const after = Math.min((char.maxHP | 0) || before, before + tickHeal);
        const healed = after - before;
        char.currentHP = after;
        if (healed > 0) {
          this._showFloatingNumber?.(healed, char, /*isHeal=*/true, /*isCrit=*/false);
          this._log?.(`${char.name} regenerates ${healed} HP.`);
          this._updateHealthBars?.(); this._updateHPMPBars?.();
        }
      }

      // turn skip (e.g., stunned)
      if (se.blocksAction) skip = true;

      // decrement duration
      const remaining = (se.turns ?? 1) - 1;
      if (!died && remaining > 0) keep.push({ ...se, turns: remaining });
    }

    char.statusEffects = keep;
    return { died, skip };
  }

  _applyMagicDot(char, amount, element, label) {
    let dmg = Math.max(0, amount | 0);
    // If you want magic-side mods (Curse/elemental res) to affect DOT, route through modifiers:
    try {
      if (typeof applyDamageModifiers === 'function') {
        dmg = applyDamageModifiers(dmg, /*attacker*/ null, char, { isMagic: true, element });
      }
    } catch { }
    const before = char.currentHP | 0;
    const after = Math.max(0, before - dmg);
    char.currentHP = after;
    this._showFloatingNumber?.(dmg, char, /*isHeal=*/false);
    this._log(`${char.name} takes ${dmg} ${label} (${element}).`);
    this._updateHealthBars?.(); this._updateHPMPBars?.();
    if (after === 0 && char.status !== 'incapacitated') {
      char.status = 'incapacitated';
      this._onUnitKnockedOut?.(char);
      return { died: true };
    }
    return { died: false };
  }



  _applyWeaknessBuildup(target, buildupMap, ctx) {
    if (!target?.weakness) return;
    const famKey = (k) => (k in target.weakness.meters) ? k : (WeaknessAliases[k] || k);

    // BEFORE snapshot for logging
    const pre = {};
    for (const raw of Object.keys(buildupMap)) {
      const fam = famKey(raw);
      if (!fam) continue;
      pre[fam] = { m: target.weakness.meters?.[fam] || 0, t: target.weakness.tiers?.[fam] || 0 };
    }

    for (const rawKey of Object.keys(buildupMap)) {
      const key = famKey(rawKey);
      const fam = WeaknessFamilies[key];
      if (!fam) continue;

      let amt = Math.max(0, Math.floor(buildupMap[rawKey] || 0));
      if (amt <= 0) continue;

      const w = target.weakness;

      // FIRE T1+: incoming fire buildup increased while Singed
      if (key === 'fire' && (w.tiers?.fire | 0) >= 1) {
        const inc = WeaknessV3?.families?.fire?.t1?.incomingFireBonus ?? 0;
        const beforeAmt = amt;
        amt = Math.floor(amt * (1 + inc));
        if (beforeAmt !== amt) {
          this._log?.(`${target.name} takes extra fire buildup (Singed): ${beforeAmt} → ${amt}`);
        }
      }

      // EXPOSE T1+: extra PHYSICAL-family buildup (NOT including expose itself)
      if ((w.tiers?.expose | 0) >= 1 && (key === 'disorient' || key === 'lacerate')) {
        const mExp = w.meters?.expose | 0;
        const Iexp = familyIntensityMult?.('expose', mExp) ?? 1;
        const bonus = WeaknessV3?.families?.expose?.t1?.physBuildupAmp ?? 0; // e.g. +0.15
        const beforeAmt = amt;
        amt = Math.max(1, Math.floor(amt * (1 + bonus * (Iexp > 0 ? Iexp : 1))));
        if (amt !== beforeAmt) {
          this._log?.(`${target.name} is Raw: physical buildup ${beforeAmt} → ${amt} (I_expose=${Iexp.toFixed(2)})`);
        }
      }

      // CURSE T2: if this buildup came from a CURSE-tagged ability, amplify it
      if ((w.tiers?.curse | 0) >= 2 && ctx?.ability?.tags?.includes?.('curse')) {
        const mCur = w.meters?.curse | 0;
        const Icur = (typeof familyIntensityMult === 'function') ? familyIntensityMult('curse', mCur) : 1;
        const amp = WeaknessV3?.families?.curse?.t2?.curseAmpMult ?? 1;
        if (amp > 1) {
          const beforeAmt = amt;
          // scale the extra (amp-1) by intensity Icur so Afflicted scales with meter
          amt = Math.max(1, Math.floor(amt * (1 + (amp - 1) * (Icur > 0 ? Icur : 1))));
          if (amt !== beforeAmt) {
            this._log?.(`${target.name} is Afflicted: CURSE-tagged buildup ${beforeAmt} → ${amt} (I_curse=${Icur.toFixed(2)})`);
          }
        }
      }

      // Apply
      const beforeMeter = w.meters[key] | 0;
      w.meters[key] = beforeMeter + amt;

      // Recompute tier + grace on change
      const m = w.meters[key] | 0;
      const newTier = (m >= fam.t2) ? 2 : (m >= fam.t1 ? 1 : 0);
      const oldTier = w.tiers[key] | 0;
      if (newTier !== oldTier) {
        w.tiers[key] = newTier;
        (w.grace || (w.grace = {}))[key] = fam.grace || 0;
        this._onWeaknessTierChanged?.(target, key, newTier, oldTier, ctx);
      }

      // Disease: recompute derived immediately (post-meter & post-tier)
      if (key === 'disease' && (w.meters[key] !== beforeMeter || newTier !== oldTier)) {
        this._applyDiseaseDerivedNow?.(target, ctx?.perAction ? 'action' : 'buildup');
      }
    }

    // AFTER: log changes
    for (const fam of Object.keys(pre)) {
      const before = pre[fam];
      const afterM = target.weakness.meters?.[fam] || 0;
      const afterT = target.weakness.tiers?.[fam] || 0;
      if (afterM !== before.m || afterT !== before.t) {
        const I = (familyIntensityMult?.(fam, afterM) ?? 1).toFixed(2);
        this._log?.(`${target.name} ${fam} ${before.m}→${afterM}  T${before.t}→T${afterT} (I=${I})`);
      }
    }
  }





  _onWeaknessTierChanged(target, family, newTier, oldTier, ctx) {
    const names = {
      lightning: ['Zapped', 'Shocked'],
      cold: ['Chilled', 'Frostbitten'],
      fire: ['Singed', 'Ablaze'],
      disorient: ['Dazed', 'Concussed'],
      lacerate: ['Bleeding', 'Hemorrhaging'],
      expose: ['Raw', 'Flayed'],
      disease: ['Sickened', 'Plagued'],
      curse: ['Hexed', 'Afflicted'],
      toxic: ['Poisoned', 'Envenomed'],
    };

    if (newTier > oldTier) {
      const label = (names[family]?.[newTier - 1]) || `T${newTier} ${family}`;
      this._log(`${target.name} is now ${label}.`);
    } else {
      this._log(`${target.name} weakens: ${family} dropped to T${newTier}.`);
    }
  }
  _weaknessDecayAll() {
    const all = [...GameState.party, ...(this.enemies || [])];
    for (const u of all) this._weaknessDecayUnit(u);
  }

  _weaknessDecayUnit(u) {
    if (!u?.weakness) return;

    for (const fam of Object.keys(WeaknessFamilies)) {
      const conf = WeaknessFamilies[fam];

      // 1) Grace: while grace > 0, no decay.
      if ((u.weakness.grace?.[fam] | 0) > 0) {
        u.weakness.grace[fam] = (u.weakness.grace[fam] | 0) - 1;
        continue;
      }

      // 2) Compute overflow-aware decay amount (but don't apply yet)
      const m = u.weakness.meters?.[fam] | 0;
      let decay = weaknessDecayAmount(conf.decay, m);

      // 3) CURSE: reduce decay amount (T1/T2)
      if (fam === 'curse') {
        const t = u.weakness.tiers.curse | 0;
        if (t >= 1) {
          const red = WeaknessV3?.families?.curse?.[t === 2 ? 't2' : 't1']?.decayReduction || 0;
          decay = Math.max(1, Math.floor(decay * (1 - red)));
        }
      }

      // 4) TOXIC T1+: chance to bypass ALL Toxic decay for THIS tick.
      if (fam === 'toxic' && ((u.weakness.tiers.toxic | 0) >= 1)) {
        const chance = WeaknessV3?.families?.toxic?.t1?.decayBypassChance ?? 0;
        if (Math.random() < chance) {
          this._log?.(`${u.name} Toxic: decay bypassed (${Math.round(chance * 100)}% chance).`);
          continue; // NO DECAY THIS TICK
        }
      }

      // 5) Apply decay
      const before = m;
      const after = Math.max(0, before - (decay | 0));
      u.weakness.meters[fam] = after;

      // 6) Re-tier if needed
      const oldTier = u.weakness.tiers[fam] | 0;
      const newTier = (after >= conf.t2) ? 2 : (after >= conf.t1 ? 1 : 0);
      if (newTier !== oldTier) {
        u.weakness.tiers[fam] = newTier;
        this._onWeaknessTierChanged?.(u, fam, newTier, oldTier, { decay: true });
      }

      // 7) Disease: recompute derived immediately (post-decay & post-tier)
      if (fam === 'disease' && after !== before) {
        this._applyDiseaseDerivedNow?.(u, 'decay');
      }
    }
  }



  _applySlotEffectsTick(char) {
    const slotId = char?._slot?.slotId ?? char?.slotId;
    const effects = (slotId != null) ? this.slotEffects?.[slotId] : null;
    if (!effects || effects.length === 0) return;

    const stillActive = [];
    for (const eff of effects) {
      // Damage-over-time from the ground, optional elemental buildup
      const maxHP = Math.max(1, char.maxHP || 1);
      const dot = Math.max(1, Math.floor(maxHP * (eff.tickPctMaxHP || 0.02)));
      char.currentHP = Math.max(0, char.currentHP - dot);
      this._log(`${char.name} suffers ${dot} damage from ${eff.id}.`);

      // Optional elemental weakness buildup
      if (eff.element && char.weakness) {
        char.weakness.meters[eff.element] = (char.weakness.meters[eff.element] || 0) + (eff.buildup || 0);
        this._recomputeWeaknessTiers(char);
      }

      eff.turns -= 1;
      if (eff.turns > 0) stillActive.push(eff);
    }
    this.slotEffects[slotId] = stillActive;
  }



  _startTurnWeakness(char) {
    // --- SAFETY: ensure per-turn derived weakness bag exists ---
    char._weaknessDerived = char._weaknessDerived || {};
    this._applyDiseaseDerivedNow(char, 'turn-start');

    // Reset per-turn derived fields EVERY turn (so we re-derive cleanly)
    char._weaknessDerived.maxHPDown = 0;
    char._weaknessDerived.evasionDown = 0;
    char._weaknessDerived.initiativeSlow = 0;

    // healingReceivedBonus is used by Disease T1; default to neutral if missing
    if (char.healingReceivedBonus == null) char.healingReceivedBonus = 1.0;

    // If you also use a "grace" or per-family temp map, make sure it exists:
    // char.weakness ??= makeWeaknessState();  // (optional global guard)

    // Tick the initiative gauge at start-of-turn 
    this._tickInitiativeGauge(char);

    // If unit has no weakness state, nothing to do
    if (!char?.weakness) return { died: false, skip: false };

    // 🔥 FIRE — Ablaze start-of-turn tick (MAGIC), per-family intensity curve + optional meter burn-out
    {
      const tiers = char?.weakness?.tiers || {};
      const meters = char?.weakness?.meters || {};
      if ((tiers.fire | 0) >= 2) {
        const m = meters.fire | 0;

        // Base tick, then multiply by Fire's own curve (does NOT affect Lightning)
        const base = (WeaknessV3?.families?.fire?.t2?.startTickBase ??
          WeaknessV3?.families?.fire?.t2?.startTickFlat ?? 10);
        const mult = familyIntensityMult('fire', m);
        const burnRaw = Math.max(1, Math.floor((+base || 0) * mult));

        // MAGIC-typed ; route through magic modifiers if desired
        let burn = burnRaw;

        // --- Cinders rider: allow AFLAME tick to crit iff Cinders active AND Curse T1+ right now ---
        try {
          // Prefer your helpers if present (supports either map-style statuses or your array style as fallback)
          const cindersActive =
            (typeof hasCurseCinders === 'function' ? hasCurseCinders(char)
              : (char.statuses?.curse_cinders || (char.statusEffects || []).some(e => e.id === 'curse_cinders')));

          const curseT1Plus =
            (typeof hasCurseTier1Plus === 'function' ? hasCurseTier1Plus(char)
              : ((char?.weakness?.meters?.curse | 0) >= 100));

          if (cindersActive && curseT1Plus) {
            // Base crit chance & mult (safe defaults if you haven't added these to WeaknessV3)
            const baseCritChance = WeaknessV3?.families?.curse?.cinders?.baseCritChance ?? 0.05;  // 5% base
            const critMult = WeaknessV3?.families?.curse?.cinders?.critMult ?? 1.50;  // x1.5

            // Extra crit chance scales with Curse overflow above 200; cap it
            const of =
              (typeof curseOverflowFactor === 'function' ? curseOverflowFactor(char)
                : Math.max(0, ((char?.weakness?.meters?.curse | 0) - 200) / 100));

            const extraCritChance = Math.min(
              WeaknessV3?.families?.curse?.cinders?.extraCritCap ?? 0.35, // cap
              (WeaknessV3?.families?.curse?.cinders?.extraCritSlope ?? 0.20) * of
            );

            const finalCritChance = Math.max(0, Math.min(0.95, baseCritChance + extraCritChance));

            if (Math.random() < finalCritChance) {
              burn = Math.floor(burn * critMult);
              this._log?.(`${char.name} suffers AFLAME (Cinders CRIT) for ${burn} (chance ${Math.round(finalCritChance * 100)}%).`);
              try { addDamageBreakdown?.({ label: 'Cinders crit', mult: critMult }); } catch { }
            } else {
              this._log?.(`${char.name} suffers AFLAME (Cinders) for ${burn}.`);
            }
          } else {
            // Not active or not hexed/afflicted → normal log keeps your previous context
            this._log?.(`${char.name} suffers AFLAME for ${burn}.`);
          }
        } catch {
          // Hard-fail safe: normal log if something odd happens
          this._log?.(`${char.name} suffers AFLAME for ${burn}.`);
        }


        try {
          if (typeof applyDamageModifiers === 'function') {
            burn = applyDamageModifiers(burn, /*attacker*/ null, char, { isMagic: true, element: 'fire' });
          }
        } catch { }


        char.currentHP = Math.max(0, (char.currentHP | 0) - burn);
        this._showFloatingNumber?.(burn, char, /*isHeal=*/false, /*isCrit=*/false);
        this._log(`${char.name} Ablaze: base ${base} × I_fire=${mult.toFixed(2)} (m=${m}) ⇒ ${burnRaw} → ${burn} burn (magic).`);
        this._updateHealthBars?.(); this._updateHPMPBars?.();
        if (char.currentHP === 0 && char.status !== 'incapacitated') {
          char.status = 'incapacitated';
          this._onUnitKnockedOut?.(char);
          return { died: true, skip: true };
        }

        // Optional extra meter consumption at start of turn (per Fire config)
        const consume = familyStartConsume('fire', m);
        if (consume > 0) {
          const before = meters.fire | 0;
          meters.fire = Math.max(0, before - consume);
          this._log(`${char.name} burns out: Fire meter ${before} → ${meters.fire} (−${consume}).`);

          // Recompute tier if you don't have a global recompute here
          const fam = WeaknessFamilies.fire;
          const newTier = (meters.fire >= fam.t2) ? 2 : (meters.fire >= fam.t1 ? 1 : 0);
          const oldTier = tiers.fire | 0;
          if (newTier !== oldTier) {
            tiers.fire = newTier;
            (char.weakness.grace || (char.weakness.grace = {})).fire = fam.grace || 0;
            this._onWeaknessTierChanged?.(char, 'fire', newTier, oldTier, { startTick: true });
          }
        }
      }
    }


    // 🩸 LACERATE — Hemorrhaging %HP at start of turn (T2)
    {
      const w = char?.weakness;
      const t = w?.tiers?.lacerate | 0;
      if (t >= 2) {
        const maxHP = Math.max(1, (char.maxHP | 0));
        const meter = w?.meters?.lacerate | 0;

        // Safe config reads with defaults
        const basePct = WeaknessV3?.families?.lacerate?.t2?.startPctHP ?? 0.06; // 6% base
        const capPct = WeaknessV3?.families?.lacerate?.t2?.startPctCap ?? 0.20; // 20% cap

        // Intensity factor (prefer your helper; fall back to 1)
        const I = (typeof weaknessIntensityMult === 'function')
          ? weaknessIntensityMult(meter)
          : (typeof familyIntensityMult === 'function' ? familyIntensityMult('lacerate', meter) : 1);

        const pct = Math.min(basePct * (I > 0 ? I : 1), capPct);
        const dot = Math.max(1, Math.floor(maxHP * pct));

        char.currentHP = Math.max(0, (char.currentHP | 0) - dot);
        this._showFloatingNumber?.(dot, char, /*isHeal=*/false, /*isCrit=*/false);
        this._log?.(`${char.name} hemorrhages ${dot} (${Math.round(pct * 100)}% of Max HP).`);
        this._updateHealthBars?.(); this._updateHPMPBars?.();

        if (char.currentHP === 0 && char.status !== 'incapacitated') {
          char.status = 'incapacitated';
          this._onUnitKnockedOut?.(char);
          return { died: true, skip: true };
        }
      }
    }


    // ☠️ TOXIC — Envenomed start-of-turn tick (T2)
    {
      const w = char?.weakness;
      const t = w?.tiers?.toxic | 0;
      if (t >= 2) {
        const m = w?.meters?.toxic | 0;

        // NOTE: config uses startTickBase (not startTickFlat)
        const base = WeaknessV3?.families?.toxic?.t2?.startTickBase ?? 0;

        // Intensity (use your helper, fall back safely)
        const I = (typeof weaknessIntensityMult === 'function')
          ? weaknessIntensityMult(m)
          : (typeof familyIntensityMult === 'function' ? familyIntensityMult('toxic', m) : 1);

        const raw = Math.max(1, Math.floor((+base || 0) * (I > 0 ? I : 1)));

        // Treat as 'necrotic' magic so MDR/element hooks can apply
        let dmg = raw;
        try {
          if (typeof applyDamageModifiers === 'function') {
            dmg = applyDamageModifiers(raw, /*attacker*/ null, char, { isMagic: true, element: 'necrotic' });
          }
        } catch { }

        char.currentHP = Math.max(0, (char.currentHP | 0) - dmg);
        this._showFloatingNumber?.(dmg, char, /*isHeal=*/false, /*isCrit=*/false);
        this._log?.(`${char.name} Envenomed: base ${base} × I_toxic=${I.toFixed(2)} (m=${m}) ⇒ ${raw} → ${dmg} necrotic.`);
        this._updateHealthBars?.(); this._updateHPMPBars?.();

        if (char.currentHP === 0 && char.status !== 'incapacitated') {
          char.status = 'incapacitated';
          this._onUnitKnockedOut?.(char);
          return { died: true, skip: true };
        }
      }
    }


    // 🤯 DISORIENT — Concussed (T2) drains MP at start of turn
    {
      const tiers = char?.weakness?.tiers || {};
      const meters = char?.weakness?.meters || {};
      if ((tiers.disorient | 0) >= 2) {
        const m = meters.disorient | 0;
        const I = familyIntensityMult('disorient', m);
        const base = WeaknessV3?.families?.disorient?.t2?.startDrainMPBase ?? 0;
        const cap = WeaknessV3?.families?.disorient?.t2?.startDrainMPCap ?? 9999;
        const drain = Math.min(Math.floor((+base || 0) * I), cap);

        if (drain > 0) {
          const before = char.currentMP | 0;
          char.currentMP = Math.max(0, before - drain);
          this._updateHPMPBars?.();
          this._log(`${char.name} is Concussed: −${drain} MP (I=${I.toFixed(2)})`);
        }
      }
    }

    // 🔮 CURSE — decay reduction only (riders live in skills)
    // Apply via decay step below by scaling the decay amount for 'curse' family.

    return { died: false, skip: false };
  }


  _endTurnWeakness(char) {
    if (!char?.weakness) return;
    // Clear per-turn temp mods
    if (char.combat) char.combat.accPenalty = 0;
    // Apply this unit's decay now
    this._weaknessDecayUnit(char);
    if (this.characterInfoTab === 'weakness' && this._inspectedChar === char) {
      this._renderCharacterInfoBody(char);
    }
    // Status effect duration tick + icon refresh
    if (Array.isArray(char.statusEffects) && char.statusEffects.length) {
      char.statusEffects = char.statusEffects
        .map(e => ({ ...e, turns: Math.max(0, (e.turns | 0) - 1) }))
        .filter(e => (e.turns | 0) > 0);
      this._refreshStatusEffectIcons(char);
    }
  }



  // Recompute tiers for all families from current meters.
  // Does NOT reset grace. Only emits a tier-change event if the tier actually changed.
  _recomputeWeaknessTiers(u) {
    if (!u?.weakness) return;
    for (const fam of Object.keys(WeaknessFamilies)) {
      const cfg = WeaknessFamilies[fam];
      const m = u.weakness.meters?.[fam] || 0;
      const newTier = (m >= cfg.t2) ? 2 : (m >= cfg.t1 ? 1 : 0);
      const oldTier = u.weakness.tiers?.[fam] || 0;
      if (newTier !== oldTier) {
        u.weakness.tiers[fam] = newTier;
        // Note: no grace reset here — only \_applyWeaknessBuildup gives grace on rise.
        this._onWeaknessTierChanged(u, fam, newTier, oldTier, { recompute: true });
      }
    }
  }


  _tickInitiativeGauge(char) {
    // Base regen is the character’s Initiative stat (derived preferred)
    const baseRegen = Math.max(0, (char?.derived?.Initiative ?? char?.initiative ?? 0) | 0);

    // Cold modifiers
    const t = char?.weakness?.tiers?.cold | 0;
    const m = char?.weakness?.meters?.cold | 0;
    const I = (t > 0) ? familyIntensityMult('cold', m) : 1.0;

    let regen = baseRegen;
    if (t >= 1) {
      const rBase = WeaknessV3?.families?.cold?.t1?.gaugeRegenPenalty ?? 0;
      const rCap = WeaknessV3?.families?.cold?.t1?.gaugeRegenPenaltyCap ?? 0.75;
      const rPen = Math.min(rBase * I, rCap); // 0..cap
      regen = Math.max(0, Math.floor(baseRegen * (1 - rPen)));
    }

    // Optional T2 drain at start of turn
    let drain = 0;
    if (t >= 2) {
      const dBase = WeaknessV3?.families?.cold?.t2?.gaugeStartDrainBase ?? 0;
      const dCap = WeaknessV3?.families?.cold?.t2?.gaugeStartDrainCap ?? 9999;
      drain = Math.min(Math.floor(dBase * I), dCap);
    }

    const before = char.initiativeGauge | 0;
    const max = (char.initiativeGaugeMax | 0) || 100;
    const after = Math.max(0, Math.min(max, before + regen - drain));

    char.initiativeGauge = after;

    // Logging for visibility while tuning
    this._log(`${char.name} Initiative Gauge: +${regen}${drain ? ` -${drain}` : ''} = ${after}/${max}${t ? ` (Cold I=${I.toFixed(2)})` : ''}`);
    return { before, after, regen, drain, I };
  }

  // SMALL HELPERS


  _applyDiseaseDerivedNow(char, reason = '') {
    if (!char) return;

    // Ensure bag
    char._weaknessDerived = char._weaknessDerived || {};

    const w = char.weakness;
    const t = w?.tiers?.disease | 0;
    const m = w?.meters?.disease | 0;

    // T1: healing received (scene-side so UI + heals agree)
    if (t >= 1) {
      const base = WeaknessV3?.families?.disease?.t1?.healRecvPenalty ?? 0;
      const tierMult = (t === 2) ? 1.5 : 1.0;
      const penalty = Math.max(0, base * tierMult);
      char.healingReceivedBonus = Math.max(0, 1 - penalty);
    } else {
      char.healingReceivedBonus = 1.0;
    }

    // T2: effective MaxHP shrink (ratio-preserving)
    const prevEffMax = char._weaknessDerived.effMaxHP || (char.maxHP | 0);

    if (t >= 2) {
      const baseDown = WeaknessV3?.families?.disease?.t2?.maxHPDown ?? 0;
      const I = (typeof weaknessIntensityMult === 'function')
        ? weaknessIntensityMult(m)
        : (typeof familyIntensityMult === 'function' ? familyIntensityMult('disease', m) : 1);
      const downPct = Math.min(baseDown * (I > 0 ? I : 1), 0.40);

      const newEffMax = Math.max(1, Math.floor((char.maxHP | 0) * (1 - downPct)));
      char._weaknessDerived.maxHPDown = downPct;
      char._weaknessDerived.effMaxHP = newEffMax;

      if (newEffMax !== prevEffMax) {
        const ratio = Math.max(0, Math.min(1, (char.currentHP | 0) / prevEffMax));
        char.currentHP = Math.min(newEffMax, Math.floor(newEffMax * ratio));
        this._updateHealthBars?.();
        this._updateHPMPBars?.();
        if (reason) this._log?.(`${char.name} Blight updates (${reason}): MaxHP ${prevEffMax}→${newEffMax} (kept ${Math.round(ratio * 100)}%)`);
      }
    } else {
      // Clear T2 derived
      if (char._weaknessDerived.maxHPDown || char._weaknessDerived.effMaxHP) {
        char._weaknessDerived.maxHPDown = 0;
        char._weaknessDerived.effMaxHP = undefined;
        // When cap lifts, preserve ratio up to base max
        const baseMax = char.maxHP | 0;
        const ratio = Math.max(0, Math.min(1, (char.currentHP | 0) / prevEffMax));
        const newHP = Math.min(baseMax, Math.floor(baseMax * ratio));
        if (newHP !== char.currentHP) {
          char.currentHP = newHP;
          this._updateHealthBars?.();
          this._updateHPMPBars?.();
          if (reason) this._log?.(`${char.name} Blight clears (${reason}): MaxHP cap removed (kept ${Math.round(ratio * 100)}%)`);
        }
      }
    }

    // If the inspected panel is open on this char, refresh it
    if (this.characterInfoTab && this._inspectedChar === char) {
      this._renderCharacterInfoBody(char);
    }
  }


  _getDisorientCostMult(char) {
    const w = char?.weakness;
    if (!w || ((w.tiers?.disorient | 0) < 1)) return 1.0;
    const m = w.meters?.disorient | 0;
    const I = familyIntensityMult('disorient', m);
    const base = WeaknessV3?.families?.disorient?.t1?.costMultiplier ?? 0;
    const cap = WeaknessV3?.families?.disorient?.t1?.costMultiplierCap ?? 0;
    const bump = Math.min(base * I, cap); // 0..cap
    return 1 + bump;
  }



  // === UI helpers =====================================================
  _clearActionMenu() {
    // Hide any active tooltip and destroy any reaction list container
    this.tooltip?.hide();
    if (this._rxList) { this._rxList.destroy(); this._rxList = null; }
    this.actionMenu?.removeAll(true);
  }
  _createButtonList(items) {
    // items = [{ label:'Text', action: ()=>{} } ... ]
    items.forEach((it, i) => {
      const btn = new UIButton(this, 0, i * 50, it.label, () => {
        const actor = this._currentChar?.();
        if (actor?.isEnemy) {
          this._log?.(`⛔ It’s ${actor.name}’s (enemy) turn. Player actions are disabled.`);
          return;
        }
        if (it.debugTag === 'BA') {
          console.log(`[BasicAttack] Button shown for ${actor?.name}`);
        }
        if (it.action) it.action();
      });
      if (!it.action) btn.setAlpha(0.35);     // grey‑out disabled
      this.actionMenu.add(btn);
    });
  }

  _updateActionLights() {
    const char = this._currentChar?.();
    if (!char || !char.actionsLeft) {
      // Safe fallback: gray out lights
      for (const type in this.actionLights) {
        this.actionLights[type].setFillStyle(0x333333);
      }
      return;
    }
    for (const type in this.actionLights) {
      this.actionLights[type].setFillStyle(char.actionsLeft[type] > 0 ? 0x00ff00 : 0x333333);
    }
  }


  _clearSlotHighlights() {
    const activeSlot = this._currentChar()?._slot;

    this.unitSlots.forEach(slot => {
      slot.rect.disableInteractive();

      if (slot === activeSlot) {
        slot.rect.setStrokeStyle(3, 0x00ff00);       // thicker green = “my turn”
      } else if (slot.char?.isEnemy) {
        slot.rect.setStrokeStyle(2, 0xff4444);       // red for enemies
      } else if (slot.char) {
        slot.rect.setStrokeStyle(2, 0xffffff);       // white for allies
      } else {
        slot.rect.setStrokeStyle(2, 0x888888);       // gray for empty
      }
    });
  }

  _getEffectIconGlyph(effectId) {
    try {
      const eff = (StatusEffects && StatusEffects[effectId]) ? StatusEffects[effectId] : null;
      if (eff && eff.icon) return eff.icon;
    } catch { }
    if (effectId === 'curse_cinders') return '☠🔥';
    return '⬢';
  }


  _addStatusEffects(target, list) {
    if (!target) return;
    target.statusEffects = target.statusEffects || [];
    for (const incoming of list) {
      if (!incoming || !incoming.id) continue;
      const turns = Math.max(1, incoming.turns | 0);
      const ex = target.statusEffects.find(e => e.id === incoming.id);
      if (ex) ex.turns = Math.max(ex.turns | 0, turns);
      else target.statusEffects.push({ id: incoming.id, turns });
    }
    this._refreshStatusEffectIcons(target);
  }

  _refreshStatusEffectIcons(unit) {
    const slot = unit?._slot;
    const anchorX = unit?.portrait?.x ?? slot?.x ?? 0;
    const anchorY = unit?.portrait?.y ?? slot?.y ?? 0;

    if (!slot?._effectIconContainer) {
      slot._effectIconContainer = this.add.container(anchorX + 30, anchorY - 40)
        .setDepth(UI_DEPTH.overlay)
        .setName(`fxicons_${unit.name}`);
    } else {
      slot._effectIconContainer.setPosition(anchorX + 30, anchorY - 40);
      slot._effectIconContainer.removeAll(true);
    }

    const list = unit.statusEffects || [];
    list.forEach((eff, i) => {
      const glyph = this._getEffectIconGlyph(eff.id);
      const t = this.add.text(i * 14, 0, glyph, { fontSize: '14px', color: '#ffffff' })
        .setOrigin(0, 0.5);
      slot._effectIconContainer.add(t);
    });
  }




  // Map slotId -> column group for both sides
  _getColumnBySlotId(slotId) {
    if ([1, 2, 3].includes(slotId)) return 'front';
    if ([4, 5].includes(slotId)) return 'mid';
    if ([6, 7, 8].includes(slotId)) return 'back';
    return null;
  }
  _getUnitColumn(unit) {
    return this._getColumnBySlotId(unit?._slot?.slotId);
  }

  _getAlliesInSameColumn(unit) {
    const col = this._getUnitColumn(unit);
    if (!col) return [];
    const sideSlots = unit.isEnemy ? this.enemySlots : this.allySlots;
    return sideSlots
      .filter(s => this._getColumnBySlotId(s.slotId) === col && s.char && s.char.status !== 'incapacitated')
      .map(s => s.char);
  }
  // === Movement used by movement skills ===================================
  // delta: -1 = toward FRONT (advance), +1 = toward BACK (retreat). Magnitude = steps.
  moveBySlots(user, delta) {
    if (!user?._slot) return false;

    // Our three columns in order: front < mid < back
    const order = ['front', 'mid', 'back'];
    const curCol = this._getUnitColumn(user);
    let idx = order.indexOf(curCol);
    if (idx < 0) return false;

    const steps = Math.abs(delta);
    const dir = Math.sign(delta);

    for (let i = 0; i < steps; i++) {
      const nextIdx = idx + dir;
      if (nextIdx < 0 || nextIdx >= order.length) break;
      const destCol = order[nextIdx];

      // find an open slot for this unit on its side in that column
      const dest = this._findOpenSlotOnSide(user, destCol);
      if (!dest) {
        this._log?.(`${user.name} tries to move but finds no space in the ${destCol}.`);
        break;
      }
      if (this._moveUnitToSlot(user, dest)) {
        idx = nextIdx; // advanced one column
      } else {
        break;
      }
    }
    return true;
  }

  // === Position helpers ====================================================

  // Map slotId -> (column,row) for Chebyshev distance.
  // Columns: front=0, mid=1, back=2
  // Rows: top=0, mid=1, bottom=2
  _slotToCoord(id) {
    // front row: 3 (top), 2 (mid), 1 (bottom)
    const front = { 3: 0, 2: 1, 1: 2 };
    // mid row: 4 (mid), 5 (bottom)  [choose 4=1 so 1→4 is cost 1]
    const mid = { 4: 1, 5: 2 };
    // back row: 8 (top), 7 (mid), 6 (bottom)
    const back = { 8: 0, 7: 1, 6: 2 };

    if (front[id] !== undefined) return { c: 0, r: front[id] };
    if (mid[id] !== undefined) return { c: 1, r: mid[id] };
    if (back[id] !== undefined) return { c: 2, r: back[id] };
    return null;
  }

  // Movement budget cost:
  // - if columns differ, cost = column difference (ignore rows)
  // - if same column, cost = row difference
  _moveCost(fromId, toId) {
    const a = this._slotToCoord(fromId);
    const b = this._slotToCoord(toId);
    if (!a || !b) return Infinity;

    const colDiff = Math.abs(a.c - b.c);
    const rowDiff = Math.abs(a.r - b.r);

    if (colDiff > 0) return colDiff;   // columns trump rows
    return rowDiff;                     // same column: pay rows
  }

  // All open slots on THIS unit's side (no enemy territory)
  _getOpenSlotsForUnitSide(user) {
    const sideSlots = user.isEnemy ? this.enemySlots : this.allySlots;
    return sideSlots.filter(s => !s.occupied);
  }

  // Move to an explicit slot container
  moveToPosition(user, slotContainer) {
    if (!slotContainer || slotContainer.occupied) return false;
    return this._moveUnitToSlot(user, slotContainer);
  }

  // Reset a slot’s border back to your default
  _resetSlotStroke(slot) {
    const isEnemy = this.enemySlots.includes(slot);
    slot.rect.setStrokeStyle(2, isEnemy ? 0xff4444 : 0xffffff);
  }


  // === Position-targeting flow ============================================
  _enterPositionTargeting(user, ability) {
    // Clear any previous targeting visuals/listeners
    this._exitTargetingMode?.();

    // Movement budget: prefer ability.moveRange, else infer from id
    const range = Number.isFinite(ability.moveRange)
      ? ability.moveRange
      : (ability.id === 'move_dash' ? 2 : 1);

    const fromId = user._slot?.slotId;
    if (!fromId) { this._log?.('No current position.'); return; }

    // Only this side (allies for players, enemies for NPCs)
    const open = this._getOpenSlotsForUnitSide(user);

    const reachable = open.filter(s => {
      const cost = this._moveCost(fromId, s.slotId);
      return Number.isFinite(cost) && cost > 0 && cost <= range;
    });

    if (!reachable.length) {
      this._log?.('No valid positions in range.');
      return;
    }

    // Track what we touched so we can restore cleanly
    this._posTargets = reachable;

    // Highlight + click to select
    reachable.forEach(slot => {
      slot.setInteractive({ useHandCursor: true });
      slot.rect.setStrokeStyle(3, 0x88ff88);

      slot.once('pointerdown', () => {
        this._exitPositionTargeting();
        // Execute movement with the actual slot container as "target"
        this._executeSkill(user, ability.id, slot);
      });
    });

    // ESC to cancel
    this.input.keyboard?.once('keydown-ESC', () => this._exitPositionTargeting());
  }

  _exitPositionTargeting() {
    if (this._posTargets) {
      this._posTargets.forEach(slot => {
        slot.removeAllListeners('pointerdown');
        slot.disableInteractive();
        this._resetSlotStroke(slot);
      });
      this._posTargets = null;
    }
    // Also clear generic targeting state if any
    this._exitTargetingMode?.();
  }

  // Keep this, but make sure it restores default strokes
  _exitTargetingMode() {
    // your existing clears
    this._clearSlotHighlights?.();
    this._clearSlotListeners?.();
    this.targetingAbility = null;

    // Hard reset borders so nothing stays dim
    [...this.allySlots, ...this.enemySlots].forEach(slot => this._resetSlotStroke(slot));

    // Restore info-clicks (your existing code is fine here)
    [...this.allySlots, ...this.enemySlots].forEach(slot => {
      const char = slot.char;
      if (!char || !char.icon || !char.icon.active) return;

      char.icon.removeListener('pointerdown');
      char.icon.setInteractive({ useHandCursor: true });
      char.icon.on('pointerdown', () => this._showCharacterInfo(char));

      slot.removeListener('pointerdown');
      slot.setInteractive({ useHandCursor: true });
      slot.on('pointerdown', () => this._showCharacterInfo(char));
    });
  }

  // If you call this elsewhere, just delegate to exit (keeps behavior consistent)
  _clearTargetingUI() {
    this._exitTargetingMode();
  }


  _showFloatingNumber(amount, target, isHeal = false, isCrit = false) {
    if (!target || !target._slot || !target._slot.getWorldTransformMatrix) return;

    const slot = target._slot;
    const world = slot.getWorldTransformMatrix();
    const x = world.tx;
    const y = world.ty;

    let color = '#ffffff'; // Default: damage
    if (isHeal) color = '#00ff66';
    if (isCrit) color = '#ffff00'; // Crit: yellow

    const sign = isHeal ? '+' : '-';

    const floatText = this.add.text(x, y + 32, `${sign}${amount}`, {
      fontSize: '20px',
      fontStyle: 'bold',
      color,
      stroke: '#000000',
      strokeThickness: 3
    }).setOrigin(0.5);

    this.tweens.add({
      targets: floatText,
      y: y - 32,
      alpha: 0,
      duration: 2000,
      ease: 'Sine.easeOut',
      onComplete: () => floatText.destroy()
    });
  }


  _highlightCurrentTurn() {
    this._clearSlotHighlights(); // ✅ Update green slot border
    this.characterInfoPanel?.setVisible(false);

    const currentChar = this._currentChar();

    // ✅ Update the current turn name display
    if (this.turnNameText) {
      const classColor = CLASS_COLORS?.[currentChar.baseClass] || '#ffffff';
      this.turnNameText.setText(`${currentChar.name}`);
      this.turnNameText.setColor(classColor);
    }

    // ✅ Highlight the current turn in the turnOrder UI list (by tinting text)
    if (this.turnOrderContent) {
      const children = this.turnOrderContent.list;
      children.forEach((child, i) => {
        if (child.setColor) {
          const isActive = i === this.currentTurnIndex;
          child.setColor(isActive ? '#00ff00' : '#ffffff');
        }
      });
    }

    this._updateActionLights(); // 🔄 Refresh action lights
  }

  _clearPortrait(slot) {
    // keep the rectangle (index 0), remove everything else
    slot.removeBetween(1, slot.length, true);
  }


  _clearSlotListeners() {
    this.unitSlots.forEach(slot => {
      /* container – keep interactive, just remove listeners */
      slot.removeAllListeners();

      /* border rectangle – not interactive, so keep it disabled */
      slot.rect.removeAllListeners();
      slot.rect.disableInteractive();

      /* sprite / circle – disable completely each time */
      if (slot.char?.icon) {
        slot.char.icon.removeAllListeners();
        slot.char.icon.disableInteractive();
      }
    });
  }

  /** Execute an NPC action chosen by NPCLogic */
  _performNPCAction(npc, action, onComplete = null) {
    const finish = (didAct = false) => {
      this._updateActionLights?.();
      if (typeof onComplete === 'function') {
        onComplete(didAct);
      } else if (!this.combatEnded) {
        this._advanceTurn();
      }
    };

    if (!action) {
      this._log(`${npc.name} hesitates.`);
      finish(false);
      return;
    }

    const runAndEnd = (skillId, target) => {
      const ability = SKILLS[skillId];
      if (!ability) {
        this._log(`[WARN] NPC tried unknown skill: ${skillId}`);
        finish(false);
        return true;
      }

      const res = this._executeSkill(npc, skillId, target);
      if (res?.ok) {
        // DO NOT zero any buckets here – _executeSkill already spent the right one.
        this.time.delayedCall(250, () => { if (!this.combatEnded) finish(true); });
        return true;
      }
      return false;
    };

    const ensureTargetIfNeeded = (skillId, givenTarget) => {
      const ability = SKILLS[skillId];
      if (!ability) return null;
      if (!ability.requiresTarget) return null; // movement / self skills usually false
      // default: first alive party member
      return givenTarget || GameState.party.find(p => !p.isEnemy && p.status !== 'incapacitated') || null;
    };

    switch (action.type) {
      case 'major':
      case 'bonus':
      case 'class': {
        const skillId = action.skill || 'basic_attack';
        const ability = SKILLS[skillId];
        if (!ability) break;

        // Movement-type skills should not require a character target
        let target = ability.isMovement ? null : ensureTargetIfNeeded(skillId, action.target);
        if (ability.requiresTarget && !target) {
          this._log(`${npc.name} finds no target.`);
          finish(false);
          return;
        }
        if (runAndEnd(skillId, target)) return;
        break;
      }

      // Back-compat: some logic returns { type:'attack', skill:'...' }
      case 'attack': {
        const skillId = action.skill || 'basic_attack';
        const ability = SKILLS[skillId];
        if (!ability) break;

        let target = ability.isMovement ? null : ensureTargetIfNeeded(skillId, action.target);
        if (ability.requiresTarget && !target) {
          this._log(`${npc.name} finds no target.`);
          finish(false);
          return;
        }
        if (runAndEnd(skillId, target)) return;
        break;
      }

      case 'guard': {
        // treat like a self-buff; consume its own cost
        const ability = SKILLS['guard'];
        if (ability) {
          const ok = this._executeSkill(npc, 'guard', npc);
          if (ok?.ok) {
            if (npc?.actionsLeft && npc.actionsLeft[ability.actionCost || 'class'] != null) {
              npc.actionsLeft[ability.actionCost || 'class'] = 0;
            }
            this.time.delayedCall(250, () => { if (!this.combatEnded) finish(true); });
            return;
          }
        }
        break;
      }

      default:
        console.warn(`[NPC] Unsupported action type: ${action.type}`);
    }

    // Nothing executed — don't stall the loop
    this._log(`${npc.name} waits.`);
    finish(false);
  }


  /** Ask the external logic for an action */
  _takeEnemyTurn_viaLogic(npc) {
    const enemies = GameState.party.filter(p => !p.isEnemy && p.status !== 'incapacitated');

    const hasActionsRemaining = () => {
      const pool = npc.actionsLeft || {};
      return ['major', 'bonus', 'class'].some(type => (pool[type] || 0) > 0);
    };

    const decideNext = () => {
      if (this.combatEnded) return null;

      let action = null;
      if (npc.aiProfile && AI_PROFILES?.[npc.aiProfile]?.decide) {
        action = AI_PROFILES[npc.aiProfile].decide(npc, this, enemies);
      }
      if (!action) {
        action = chooseNPCAction(npc, enemies, this);
      }
      return action;
    };

    const tryAct = (depth = 0) => {
      if (this.combatEnded) return;
      if (!hasActionsRemaining()) {
        this._advanceTurn();
        return;
      }
      if (depth > 12) { // safety valve
        console.warn(`[NPC] Abort loop for ${npc.name} after ${depth} attempts.`);
        this._advanceTurn();
        return;
      }

      const action = decideNext();
      if (!action) {
        this._advanceTurn();
        return;
      }

      this._performNPCAction(npc, action, (didAct) => {
        if (this.combatEnded) return;
        if (!didAct) {
          this.time.delayedCall(150, () => tryAct(depth + 1));
          return;
        }
        if (hasActionsRemaining()) {
          this.time.delayedCall(200, () => tryAct(depth + 1));
        } else {
          this._advanceTurn();
        }
      });
    };

    tryAct();
  }

  _advanceTurn() {
    if (this.combatEnded) return;

    // 1) Apply END-OF-TURN decay for the actor who just acted
    const previousChar = this._currentChar?.();
    if (previousChar) {
      // tick centralized cooldowns for the actor who just acted
      this._tickCooldownsEndOfTurn(previousChar);
      // NEW: decay weaknesses at end of *their* turn
      this._endTurnWeakness(previousChar);

      // === NEW: tick down timed statuses (includes Cinders) ===
      this._tickDownStatusDurations(previousChar);
    }

    // 2) Advance to next actor
    if (!this.turnOrder?.length) return;                  // avoid modulo 0
    this.currentTurnIndex = (this.currentTurnIndex + 1) % this.turnOrder.length;

    const char = this._currentChar?.();
    if (!char) return;
    if (typeof char.isEnemy !== 'boolean') {
      char.isEnemy = !!this.enemies?.includes(char);
    }

    // 3) Apply START-OF-TURN ongoings (DOT/skip-turn/penalties)
    const se = this._startTurnStatusEffects(char);    // NEW
    if (this.combatEnded || se.died) return;

    const start = this._startTurnWeakness(char);      // existing
    if (this.combatEnded) return;

    // If any source says skip, skip
    if (se.skip || start.skip) {
      this.time.delayedCall(300, () => { if (!this.combatEnded) this._advanceTurn(); });
      return;
    }

    // 4) If Frozen (skip) or died to DOT, immediately advance again
    if (start.skip) {
      // Small pause so the log can be read
      this.time.delayedCall(300, () => { if (!this.combatEnded) this._advanceTurn(); });
      return;
    }

    // 5) Reset action economy for this actor
    char.actionsLeft = { major: 1, bonus: 1, class: 1, reaction: 1 };
    this.reactions?.onTurnStart(char);
    // 6) Update highlights/UI shell
    this._highlightCurrentTurn();

    // 7) Branch by actor type
    if (char.isEnemy) {
      this.actionMenu?.setVisible(false);
      this.endTurnButton?.setVisible(false);
      this.actionMenu?.iterate?.(child => child.disableInteractive?.());

      // Let AI act after a brief delay
      this.time.delayedCall(400, () => {
        if (this.combatEnded) return;
        this._takeEnemyTurn_viaLogic(char);
      });
      return; // do NOT build player menus for enemies
    }

    // Player turn: show action UI
    this._buildActionMenuRoot();
  }

  // Decrement per-turn status durations at end of the unit's own turn.
  // Generic loop first; then call specific helpers (like tickDownCurseCinders) for any special cases.
  _tickDownStatusDurations(char) {
    // Map-style statuses: { id: { turns, ... } }
    if (char?.statuses && typeof char.statuses === 'object') {
      for (const key of Object.keys(char.statuses)) {
        const st = char.statuses[key];
        if (st && typeof st.turns === 'number') {
          st.turns -= 1;
          if (st.turns <= 0) {
            delete char.statuses[key];
            this._log?.(`${char.name}'s ${key.replaceAll('_', ' ')} fades.`);
          }
        }
      }
    }

    // Legacy array-style statuses: [ { id, turns }, ... ]
    if (Array.isArray(char?.statusEffects)) {
      for (let i = char.statusEffects.length - 1; i >= 0; i--) {
        const st = char.statusEffects[i];
        if (st && typeof st.turns === 'number') {
          st.turns -= 1;
          if (st.turns <= 0) {
            const pretty = (st.name || st.id || 'status');
            this._log?.(`${char.name}'s ${pretty} fades.`);
            char.statusEffects.splice(i, 1);
          }
        }
      }
    }

    // Specific status helpers (safe no-ops if not imported)
    try { tickDownCurseCinders?.(char); } catch { }
  }


  _applyRewardBuff(target, buff, ability, context = {}) {
    if (!target || !buff) return;

    const turns = Math.max(1, buff.turns | 0);
    const mods = {};
    const summary = [];

    const toStat = (key, value, label) => {
      if (!Number.isFinite(value)) return;
      mods[key] = (mods[key] || 0) + value;
      const sign = value >= 0 ? '+' : '';
      summary.push(`${sign}${value}% ${label}`);
    };

    if (Number.isFinite(buff.critChanceBonusPct)) {
      toStat('CritChance', buff.critChanceBonusPct, 'crit chance');
    }
    if (Number.isFinite(buff.accPct)) {
      toStat('Accuracy', buff.accPct, 'accuracy');
    }
    if (Number.isFinite(buff.guardPct)) {
      toStat('PhysicalResist', buff.guardPct, 'guard');
    }
    if (Number.isFinite(buff.evasionPct)) {
      toStat('Evasion', buff.evasionPct, 'evasion');
    }

    if (Object.keys(mods).length === 0) return;

    const effectId = buff.statusId || `reward_${ability?.id || 'skill'}_buff`;
    this._addStatusEffects(target, [{ id: effectId, turns, mods }]);

    if (summary.length) {
      const durationText = turns > 1 ? `${turns} turns` : '1 turn';
      const abilityName = ability?.name || 'the skill';
      const tierNote = context?.family ? ` (tier ${context.tier} ${context.family})` : '';
      this._log?.(`${target.name} gains ${summary.join(', ')} for ${durationText} from ${abilityName}${tierNote}.`);
    }
  }

  _applyRewardDebuff(target, debuff, ability, context = {}) {
    if (!target || !debuff) return;

    const turns = Math.max(1, debuff.turns | 0);
    const mods = {};
    const summary = [];

    const toStat = (key, value, label) => {
      if (!Number.isFinite(value)) return;
      mods[key] = (mods[key] || 0) + value;
      const sign = value >= 0 ? '+' : '';
      summary.push(`${sign}${value}% ${label}`);
    };

    if (Number.isFinite(debuff.physicalVulnPct)) {
      toStat('PhysicalResist', -Math.abs(debuff.physicalVulnPct), 'physical guard');
    }
    if (Number.isFinite(debuff.accDownPct)) {
      toStat('Accuracy', -Math.abs(debuff.accDownPct), 'accuracy');
    }
    if (Number.isFinite(debuff.speedDownPct)) {
      toStat('Initiative', -Math.abs(debuff.speedDownPct), 'initiative');
    }

    if (Object.keys(mods).length === 0) return;

    const effectId = debuff.statusId || `reward_${ability?.id || 'skill'}_debuff`;
    this._addStatusEffects(target, [{ id: effectId, turns, mods }]);

    if (summary.length) {
      const durationText = turns > 1 ? `${turns} turns` : '1 turn';
      const abilityName = ability?.name || 'the skill';
      const tierNote = context?.family ? ` (tier ${context.tier} ${context.family})` : '';
      this._log?.(`${target.name} suffers ${summary.join(', ')} for ${durationText} from ${abilityName}${tierNote}.`);
    }
  }


  _addStatusEffects(target, effects = []) {
    if (!target || !Array.isArray(effects) || effects.length === 0) return;
    target.statusEffects = target.statusEffects || [];

    for (const se of effects) {
      const def = (StatusEffects && StatusEffects[se.id]) || {};
      const incoming = {
        id: se.id,
        turns: se.turns ?? def.duration ?? 1,
        tickDamage: se.tickDamage ?? def.tickDamage ?? 0,
        tickHeal: se.tickHeal ?? def.tickHeal ?? 0,
        blocksAction: se.blocksAction ?? def.blocksAction ?? false,
        mods: { ...(def.mods || {}), ...(se.mods || {}) },
        data: { ...(def.data || {}), ...(se.data || {}) },
      };

      // Coalesce same-id
      const i = target.statusEffects.findIndex(e => e.id === incoming.id);
      if (i >= 0) {
        const cur = target.statusEffects[i];
        cur.tickHeal = (cur.tickHeal | 0) + (incoming.tickHeal | 0);
        cur.tickDamage = (cur.tickDamage | 0) + (incoming.tickDamage | 0);
        cur.turns = Math.max(cur.turns | 0, incoming.turns | 0);
        // keep blocksAction if either says true
        cur.blocksAction = !!(cur.blocksAction || incoming.blocksAction);
        if (incoming.mods && Object.keys(incoming.mods).length) {
          cur.mods = { ...(incoming.mods) };
        }
      } else {
        target.statusEffects.push(incoming);
      }
    }

    this._refreshStatusEffectIcons?.(target);
  }



  _addStatusBars(unit) {
    const { x, y } = unit.icon.getCenter();
    const localX = 0;  // match container-relative positioning
    const localY = 0;

    const hpBar = new StatusBar(this, localX - 50, localY, 60, 6, unit.currentHP, unit.maxHP, 0xff4444, 'HP');
    const mpBar = new StatusBar(this, localX - 42, localY, 60, 6, unit.currentMP, unit.maxMP, 0x4444ff, 'MP');

    hpBar.setAngle(-90);
    mpBar.setAngle(-90);

    unit._slot.add([hpBar, mpBar]);

    // Maintain handles for updates
    unit.hpBar = hpBar;
    unit.mpBar = mpBar;
  }

  _showVictoryScreen(title = 'Victory!', xpSummary = []) {
    const { width, height } = this.sys.game.canvas;

    // Dark overlay
    this.add.rectangle(width / 2, height / 2, width, height, 0x000000, 0.7)
      .setDepth(2000);

    // Victory text
    this.add.text(width / 2, height / 2 - 120, title, {
      fontSize: '48px',
      color: '#ffffff',
      fontStyle: 'bold'
    }).setOrigin(0.5).setDepth(2001);

    // XP summary list
    xpSummary.forEach((line, i) => {
      this.add.text(width / 2, height / 2 - 50 + (i * 25), line, {
        fontSize: '18px',
        color: '#ffff66'
      }).setOrigin(0.5).setDepth(2001);
    });

    // Return button
    const btn = this.add.text(width / 2, height / 2 + 150, '[ Return to Camp ]', {
      fontSize: '24px',
      color: '#cccccc',
      backgroundColor: '#333333',
      padding: { x: 10, y: 5 }
    }).setOrigin(0.5).setDepth(2001).setInteractive();

    btn.on('pointerdown', () => {
      this.scene.stop('CombatScene');
      this.scene.wake('TownScene');
      this.scene.wake('UIScene');
    });
  }

  _showDefeatScreen(title = 'Defeat', subtitle = '', opts = {}) {
    const { showRetry = this.isTraining, showExit = true } = opts;
    const { width, height } = this.sys.game.canvas;

    // Make sure inputs reach the overlay even if other scenes are still interactive
    this.input.topOnly = true;

    // Dark overlay
    const overlay = this.add.rectangle(width / 2, height / 2, width, height, 0x000000, 0.7)
      .setDepth(3000);

    // Title
    this.add.text(width / 2, height / 2 - 100, title, {
      fontSize: '48px',
      color: '#ff6666',
      fontStyle: 'bold'
    }).setOrigin(0.5).setDepth(3001);

    // Subtitle
    if (subtitle) {
      this.add.text(width / 2, height / 2 - 40, subtitle, {
        fontSize: '20px',
        color: '#ffffff'
      }).setOrigin(0.5).setDepth(3001);
    }

    // Button builder
    const makeBtn = (label, x, onClick) => {
      const t = this.add.text(x, height / 2 + 80, label, {
        fontSize: '24px',
        color: '#e0e0e0',
        backgroundColor: '#333333',
        padding: { x: 14, y: 8 }
      }).setOrigin(0.5).setDepth(3001).setInteractive({ useHandCursor: true });

      t.on('pointerover', () => t.setStyle({ backgroundColor: '#555555', color: '#ffffff' }));
      t.on('pointerout', () => t.setStyle({ backgroundColor: '#333333', color: '#e0e0e0' }));
      t.on('pointerdown', () => {
        // prevent double clicks
        t.disableInteractive();
        onClick();
      });
      return t;
    };

    const buttons = [];
    const spacing = 160;
    if (showRetry) buttons.push(makeBtn('[ Try Again ]', width / 2 - (showExit ? spacing / 2 : 0), () => {
      // Restart same scenario. Party already restored to full in _onCombatDefeat.
      this.scene.restart({ party: this.partyData, mode: 'pit', scenarioId: this.scenarioId });
    }));
    if (showExit) buttons.push(makeBtn('[ Exit ]', width / 2 + (showRetry ? spacing / 2 : 0), () => {
      this.scene.stop('CombatScene');
      this.scene.wake('TownScene');
      this.scene.wake('UIScene');
    }));

    // If something else tries to rebuild UI, hide it now
    this.actionMenu?.setVisible(false);
    this.endTurnButton?.setVisible(false);
  }



  _addExitButton() {
    const exitBtn = new UIButton(this, 400, 400, 'Exit Training', () => {
      this.scene.stop('CombatScene');
      this.scene.wake('TownScene');
      this.scene.wake('UIScene');
    });

    // 🔺 Make sure button has correct depth
    exitBtn.setDepth(UI_DEPTH.overlay);

    this.add.existing(exitBtn);
  }

  _placePortrait(char, slot) {
    this._clearPortrait(slot); // Remove old visuals

    slot.rect.setStrokeStyle(2, 0xffffff); // Reset outline

    // 🔁 Remove old listeners and create fresh interactive portrait sprite
    const sprite = this.add.image(0, 0, char.skin)
      .setDisplaySize(64, 64)
      .setInteractive(); // ✅ click-enabled

    sprite.removeAllListeners();  // ✅ ensure no duplicate listeners
    sprite.on('pointerdown', () => {
      this._showCharacterInfo(char);
    });

    // 🧽 Clear and reset slot interactivity
    slot.removeAllListeners();      // ✅ clean existing listeners
    slot.setSize(80, 80);
    slot.setInteractive();
    slot.on('pointerdown', () => {
      this._showCharacterInfo(char);
    });

    // Name label
    const classColor = CLASS_COLORS?.[char.baseClass] || '#ffffff';
    const nameTxt = this.add.text(0, 32, char.name, {
      fontSize: '14px',
      color: classColor
    }).setOrigin(0.5, 0);

    // Vertical HP/MP bars
    const hpBar = new StatusBar(this, -50, 0, 60, 6, char.currentHP, char.maxHP, 0xff4444, 'HP');
    const mpBar = new StatusBar(this, -42, 0, 60, 6, char.currentMP, char.maxMP, 0x4444ff, 'MP');
    hpBar.setAngle(-90);
    mpBar.setAngle(-90);

    // Add to container
    slot.add([sprite, nameTxt, hpBar, mpBar]);

    // Store references for later updates
    char.icon = sprite;
    char.hpBar = hpBar;
    char.mpBar = mpBar;

    // NEW: ensure status icons render now that slot/icon exist
    this._refreshStatusEffectIcons?.(char);
  }

  _shutdownCleanup() {
    this.koArea = [];
    if (this.koSprites) {
      this.koSprites.forEach(obj => obj.destroy?.());
      this.koSprites = [];
    }
  }


  _currentChar() {
    return this.turnOrder[this.currentTurnIndex];
  }
}