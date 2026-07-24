// Core state & UI
import GameState from '../systems/GameState.js';
import { COLORS, UI_DEPTH, CLASS_COLORS, RARITY_COLORS } from '../ui/styles.js';
import { buildItemTooltipLines } from '../ui/itemTooltip.js';
import { createPanel } from '../ui/GamePanel.js';
import Tooltip from '../ui/Tooltip.js';
import StatusBar from '../ui/StatusBar.js';
import UIButton, { createButton } from '../ui/Button.js';
import { SoundManager } from '../systems/SoundManager.js';
import { createStatusIcon, combineStatusEffects } from '../ui/statusEffectIcons.js';
import { buildSkillTooltipLines } from '../ui/skillTooltip.js';
import { setupSceneCursor, setCursor } from '../ui/cursor.js';

// Data
import { COMBAT_SCENARIOS } from '../../data/combatScenarios.js';
import { ENEMY_TYPES } from '../../data/enemyTypes.js';
import { Items } from '../../data/items.js';
import { SKILLS, getWeaponSkillsFor, getClassSkillsFor, getReactionSkillsFor, applyRhythmStack } from '../../data/skills.js';

// Character / Items / AI systems
import ProgressionManager from '../systems/ProgressionManager.js';
import { HuntManager } from '../systems/HuntManager.js';
import { DevFlags } from '../systems/DevFlags.js';
import { rebuildCharacterStats, resetCombatMods, calculateDerivedStats } from '../systems/CharacterBuilder.js';
import { isItemInstance, createItemInstance, getItemComputedData } from '../systems/ItemFactory.js';
import { AI_PROFILES } from '../systems/AIProfiles.js';
import { getLocalChatScript } from '../systems/LocalChatScripts.js';
import { chooseNPCAction } from '../systems/NPCLogic.js';
import EventBus from '../systems/EventBus.js';
import ReactionSystem, { isReactableAttackSource } from '../systems/ReactionSystem.js';
import { resolveAOESplash } from '../systems/aoeResolver.js';

// Status / Weakness framework
import {
  makeWeaknessState, weaknessDecayAmount, weaknessIntensityMult,
  WeaknessFamilies, StatusEffects, WeaknessV3, WeaknessTierNames,
  WeaknessAliases, familyIntensityMult, familyStartConsume,
  WeaknessBuildupCategory,
} from '../systems/StatusEffects.js';

// Combat logic
import {
  rollToHit, computeHitChance, getLastDamageBreakdown, _resetDamageBreakdown,
  computeEffectiveInitiative, getEffectiveDerived, applyColdEvasionPenalty,
  getEffectivePDR, getEffectiveMDR, getEffectiveEDR, getEffectiveNDR, getHealingReceivedMult, applyExposePreDamage,
  getDamageReductionFraction, _pushBreakdown, _sumStatusEffectMods,
  getProficiencyBreakdown, getProficiencyMultiplier,
  applyGearConversionAndPercent, applyLightningJolt,
} from '../systems/CombatLogic.js';





// Helper: Get safe Items.js data from equipped gear
function getEquippedItemData(equipped) {
  if (!equipped) return null;
  const id = isItemInstance(equipped) ? equipped.id : equipped;
  return Items[id] || null;
}

function calculateEffectiveResourceCost(user, baseCost, resource, opts = {}) {
  let cost = Math.max(0, baseCost | 0);
  const result = { cost, gear: null, penalty: null };
  if (cost <= 0) return result;

  const reductionPct = user?.gearEffects?.skillCostReductionPct || 0;
  if (reductionPct > 0) {
    const clampPct = Math.min(95, Math.max(0, reductionPct));
    const after = Math.max(0, Math.floor(cost * (1 - clampPct / 100)));
    if (after !== cost) {
      result.gear = { before: cost, after };
      cost = after;
    }
  }

  if (resource === 'mp' && opts.includePenalties !== false) {
    const tiers = user?.weakness?.tiers || {};
    const meters = user?.weakness?.meters || {};
    const tier = tiers.disorient | 0;
    if (tier >= 1) {
      const base = WeaknessV3?.families?.disorient?.t1?.costMultiplier ?? 0;
      const cap = WeaknessV3?.families?.disorient?.t1?.costMultiplierCap ?? 0;
      const intensity = typeof familyIntensityMult === 'function'
        ? familyIntensityMult('disorient', meters.disorient | 0)
        : 1;
      let add = base * (intensity > 0 ? intensity : 0);
      if (tier >= 2) add *= 1.5;
      if (cap > 0) add = Math.min(add, cap);
      if (add > 0) {
        const before = cost;
        const after = Math.ceil(cost * (1 + add));
        if (after !== cost) {
          result.penalty = { before, after, mult: 1 + add };
          cost = after;
        }
      }
    }
  }

  result.cost = cost;
  return result;
}
// === Grid helper =========================================
// Kept for any legacy references (visual positioning, etc.)
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

/**
 * Adjacency map for the brick-offset grid.
 * Middle column (4, 5) is offset down half a row, bridging back and front.
 */
const ADJACENCY_MAP = {
  8: [7, 4],
  7: [8, 6, 4, 5],
  6: [7, 5],
  4: [8, 7, 5, 2, 3],
  5: [7, 6, 4, 2, 1],
  3: [4, 2],
  2: [4, 5, 3, 1],
  1: [5, 2]
};

/**
 * Pre-computed shortest-path movement costs between all slots.
 * Replaces Chebyshev distance — accounts for the brick-offset layout
 * where middle-column slots (4, 5) bridge back and front.
 */
const MOVEMENT_COSTS = {
  8: { 8:0, 7:1, 6:2, 4:1, 5:2, 3:2, 2:3, 1:4 },
  7: { 8:1, 7:0, 6:1, 4:1, 5:1, 3:2, 2:2, 1:3 },
  6: { 8:2, 7:1, 6:0, 4:2, 5:1, 3:3, 2:2, 1:2 },
  4: { 8:1, 7:1, 6:2, 4:0, 5:1, 3:1, 2:1, 1:2 },
  5: { 8:2, 7:1, 6:1, 4:1, 5:0, 3:2, 2:1, 1:1 },
  3: { 8:2, 7:2, 6:3, 4:1, 5:2, 3:0, 2:1, 1:2 },
  2: { 8:3, 7:2, 6:2, 4:1, 5:1, 3:1, 2:0, 1:1 },
  1: { 8:4, 7:3, 6:2, 4:2, 5:1, 3:2, 2:1, 1:0 }
};

/** Movement cost between two slots using the brick-offset grid. */
function moveCost(fromId, toId) {
  if (fromId == null || toId == null) return Infinity;
  return MOVEMENT_COSTS[fromId]?.[toId] ?? Infinity;
}

/** All slots adjacent (range 1) to a given slot. */
function getAdjacentSlots(slotId) {
  return ADJACENCY_MAP[slotId] || [];
}

/**
 * Adjacent slots that lie strictly toward the back (direction -1) or toward
 * the front (direction +1) column from slotId, nearest row first. Used by NPC
 * repositioning (_enemyTryShuffleOneColumn/_enemyTryStepTowardFront) so it
 * reads from the SAME adjacency data player movement uses, instead of a
 * separate hardcoded table that can drift out of sync with it.
 */
function getAdjacentSlotsTowardColumn(slotId, direction) {
  const from = SLOT_COORDS[slotId];
  if (!from) return [];
  return getAdjacentSlots(slotId)
    .filter(id => {
      const to = SLOT_COORDS[id];
      return to && Math.sign(to.col - from.col) === direction;
    })
    .sort((a, b) => Math.abs(SLOT_COORDS[a].row - from.row) - Math.abs(SLOT_COORDS[b].row - from.row));
}
// =========================================================

const LOG_COLORS = {
  default: '#eeeeee',
  ally: '#aee1ff',
  enemy: '#ffb3b3',
  neutral: '#dddddd',
  ability: '#ffd166',
  damage: '#ff9966',
  heal: '#8fe0b0',
  crit: '#fff176',
  keyword: '#d4c4ff',
  info: '#bbbbbb'
};

const LOG_LINE_HEIGHT = 18;

// Color scheme for the damage-breakdown tooltip (hover a log line's damage
// number). Reuses the same color language the log LINE itself already uses
// (LOG_COLORS.crit for "(CRIT!)", LOG_COLORS.keyword for "(splash)") so the
// tooltip reads as an extension of the log rather than a separate unstyled
// block. The headline number and crit/reduction/type info get real color;
// pure bookkeeping (source/target/formula/MP) stays muted so it doesn't
// compete for attention against the numbers that actually matter.
const DAMAGE_TOOLTIP_COLORS = {
  muted: '#999999',
  physical: '#dddddd',
  elemental: '#f0a050',
  necrotic: '#9b6bd9',
  reduction: '#e0685f',
  chance: '#7ec8e3',
  // Specific elements — same hex values as itemTooltip.js's TYPE_COLORS, so
  // a fire flat-damage line reads as the same color everywhere in the UI.
  fire: '#D24E35',
  cold: '#3BA3D9',
  lightning: '#E6C447',
  // Generic multiplicative buffs that aren't crit and aren't tied to a
  // specific element (gear damage%, Proficiency, skill%, "Generic increased
  // damage") — a distinct green so "this is a buff scaling the hit" reads
  // differently from "this is raw typed damage".
  buff: '#7fd88f',
};

// Resolves a formula-breakdown token's color from its structural role
// (kind: 'base' | 'crit' | 'convert' | 'flat' | 'mult') plus its label text,
// used to color-code CombatScene's damage-tooltip "Formula:" line token by
// token instead of one flat color for the whole line.
function _formulaPartColor(kind, label) {
  const C = DAMAGE_TOOLTIP_COLORS;
  if (kind === 'base') return C.physical;
  if (kind === 'crit') return LOG_COLORS.crit;

  const l = (label || '').toLowerCase();
  if (kind === 'convert') {
    // Conversion is named "from→to" — color by the DESTINATION type, since
    // that's what the damage becomes.
    if (l.includes('necro')) return C.necrotic;
    if (l.includes('ele')) return C.elemental;
    return C.muted;
  }

  // flat or mult — match a specific element by name in the label first...
  if (l.includes('fire')) return C.fire;
  if (l.includes('cold')) return C.cold;
  if (l.includes('lightning')) return C.lightning;
  if (l.includes('necro')) return C.necrotic;
  if (l.includes('elemental')) return C.elemental;
  // ...an unlabeled flat rider (e.g. a named weapon-damage rider) reads as
  // physical; an unlabeled multiplier (gear/proficiency/skill%/generic buffs)
  // reads as a generic buff.
  return kind === 'flat' ? C.physical : C.buff;
}

// ── Enemy loot helpers ────────────────────────────────────────────────────────
// RARITY_COLORS is imported from styles.js — the single shared source (see
// that file's comment). Don't redefine it here again.

// Training encounters use this — caps at epic since legendary isn't implemented yet.
function rollEnemyDropRarity() {
  const r = Math.random();
  if (r < 0.55) return 'uncommon';
  if (r < 0.88) return 'rare';
  return 'epic';
}

// Hunt-mode drops (Cultist fights) use the same uncommon/rare/epic spread as
// rollEnemyDropRarity(), but lootQualityPercent (from the Hunt Plan/zone/
// weather modifier pipeline — see HuntModifiers.js) shifts weight out of
// uncommon and into rare/epic — never guaranteed, just biased.
function rollHuntDropRarity(lootQualityPercent = 0) {
  let uncommon = 55, rare = 33, epic = 12;
  const shift = Math.min(uncommon - 5, Math.max(0, lootQualityPercent) * 0.6);
  uncommon -= shift;
  rare += shift * 0.6;
  epic += shift * 0.4;

  const r = Math.random() * 100;
  if (r < uncommon) return 'uncommon';
  if (r < uncommon + rare) return 'rare';
  return 'epic';
}

// Returns all item IDs of a given type/slot from the Items catalogue.
function getItemIdsByTypeSlot(type, slot) {
  return Object.entries(Items)
    .filter(([, it]) => it?.type === type && (!slot || it?.slot === slot))
    .map(([id]) => id);
}
// ─────────────────────────────────────────────────────────────────────────────

export default class CombatScene extends Phaser.Scene {
  constructor() {
    super({ key: 'CombatScene' });
    this.unitSlots = [];
    this.koArea = [];
    this.combatEnded = false;

    this.currentTurnIndex = 0;
    this.menuLevel = 'root';
    this.slotEffects = {}; // { [slotId]: [{ id, element, turns, tickPctMaxHP }] }
    this.groundSprites = {}; // { [slotId]: Phaser.GameObjects.Image[] }
    this.lodgeSprites = {};  // { [charName]: Phaser.GameObjects.Image[] }
  }

  init(data) {
    this.partyData = data.party || [];
    this.combatType = data.mode || 'normal';
    this.isTraining = (this.combatType === 'pit');
    this.isHunt = (this.combatType === 'hunt');
    this.huntContext = data.huntContext || null; // { type: 'beast'|'cultist' }
    this.scenarioId = data.scenarioId || 'training_encounter_1';
    this.scenarioData = COMBAT_SCENARIOS[this.scenarioId] || null;
    this.localChatScript = getLocalChatScript(this.scenarioId);
    this.enemiesDefeatedCount = 0;
    this._postCombatDimmed = false;
    // Round counter (1-indexed) + a free-form scratch bag scripts can use
    // for their own state (e.g. "already said X this round") — see
    // _buildLocalChatCtx and LocalChatScripts.js.
    this.combatRound = 1;
    this.localChatState = {};

    // Reset all per-combat state — Phaser reuses the same scene instance on
    // scene.start(), so the constructor only runs once. Everything that must
    // start fresh each combat belongs here, not in the constructor.
    this._rxSelection = null; // seeded from real prepared state on first menu open
    this.combatEnded = false;
    this.currentTurnIndex = 0;
    this.menuLevel = 'root';
    this.slotEffects = {};
    this.groundSprites = {};
    this.lodgeSprites = {};
    this.turnOrder = [];
    this.enemies = [];
    this.unitSlots = [];
    this.koArea = [];
    this.targetingAbility = null;
    this.targetingAbilityBtn = null;
  }

  create() {
    SoundManager.init(this);
    setupSceneCursor(this);
    SoundManager.wireEmptyClick(this, 'dirtClick');
    this.add.image(640, 360, 'combat_pit_bg').setDisplaySize(1280, 720).setDepth(-1);
    this.scene.sleep('TownScene');
    this.scene.sleep('UIScene');

    const { width, height } = this.sys.game.canvas;

    // Setup battlefield and units
    this._createBattleSlots();
    this._placePartyMembers();
    this._placeEnemies(this.scenarioId);

    // Build fixed turn order (decided at combat start) — grouped by TEAM
    // first (no interleaving/"stragglers" between sides), Initiative only
    // decides order WITHIN each team's own block. Which team's block goes
    // first is currently hardcoded to the player party for the combat pit;
    // a real circumstance-based rule (ambush, enemy initiative, etc.) is a
    // separate, later decision — this is a deliberate placeholder for that.
    const byInitiativeDesc = (a, b) => computeEffectiveInitiative(b) - computeEffectiveInitiative(a);
    const partyOrder = [...GameState.party].sort(byInitiativeDesc);
    const enemyOrder = [...(this.enemies || [])].sort(byInitiativeDesc);
    this.turnOrder = [...partyOrder, ...enemyOrder];

    this._resetAllCooldowns();

    // Clean all per-combat transient state off every combatant.
    // Party members are persistent objects (GameState.party) so leftover statuses,
    // ground sprites, and gauge values from a previous fight must be wiped here.
    for (const u of this.turnOrder) {
      // Status effects — both array-style and map-style
      u.statusEffects = [];
      u.statuses = {};
      // Initiative gauge always starts empty each combat
      u.initiativeGaugeMax = u.initiativeGaugeMax ?? 100;
      u.initiativeGauge = 0;
      // Reset any per-turn derived weakness scratch state
      if (u._weaknessDerived) {
        u._weaknessDerived.maxHPDown = 0;
        u._weaknessDerived.evasionDown = 0;
        u._weaknessDerived.initiativeSlow = 0;
      }
    }

    // Destroy any lingering ground/lodge sprites from the previous combat session
    Object.values(this.groundSprites).forEach(arr => arr.forEach(s => s?.destroy?.()));
    this.groundSprites = {};
    Object.values(this.lodgeSprites).forEach(arr => arr.forEach(s => s?.destroy?.()));
    this.lodgeSprites = {};

    // Core UI
    const layout = {
      actionMenu: { x: width - 280, y: height - 242 },
      endTurn: { x: width - 90, y: height - 70 }
    };
    layout.actionLights = {
      x: layout.endTurn.x - 30,
      y: layout.endTurn.y - 60
    };
    layout.turnName = {
      x: layout.endTurn.x,
      y: layout.actionLights.y - 28
    };
    this.layout = layout;

    this._createTurnOrderUI();
    this._createActionMenu(layout.actionMenu.x, layout.actionMenu.y);
    this._createActionLights(layout.actionLights.x, layout.actionLights.y);
    this._createEndTurnButton(layout.endTurn.x, layout.endTurn.y);
    this._highlightCurrentTurn();
    this._createCombatLog();
    this._postLocalChatLines(this.localChatScript?.onCombatStart?.(this._buildLocalChatCtx()));

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
    const panelHeight = 230;

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
    this._charStatusIconContainer = null;

    // Input enable delay (unchanged)
    this.input.enabled = false;
    this.time.delayedCall(200, () => {
      this.input.enabled = true;
    });

    this.events.once('shutdown', this._shutdownCleanup, this);
  }

  _createCombatLog() {
    const config = {
      x: 20,
      y: 460,
      width: 440,
      height: 250,
      padding: 10,
      // Top strip reserved for the Combat/Local tab buttons, bottom strip
      // reserved for the Local tab's chat input — both carved out of the
      // existing panel footprint rather than growing it, so this can't
      // collide with whatever else is laid out around it.
      tabBarHeight: 24,
      inputBarHeight: 30,
    };
    this.combatLogConfig = config;
    const { x, y, width, height, padding, tabBarHeight, inputBarHeight } = config;
    const scrollY = y + tabBarHeight;
    const scrollHeight = height - tabBarHeight - inputBarHeight;

    // Background box
    const bg = createPanel(this, x, y, width, height, 'default')
      .setDepth(UI_DEPTH.overlay);
    this.combatLogBg = bg;



    // Mask for scroll area — shrunk to the middle strip only, so the tab
    // buttons and chat input (top/bottom strips) never get clipped or
    // treated as scrollable log content.
    const shape = this.make.graphics({ add: false });
    shape.fillStyle(0xffffff);
    shape.fillRect(x, scrollY, width, scrollHeight);
    const mask = shape.createGeometryMask();

    this.combatLogContainer = this.add.container(x + padding, scrollY + padding)
      .setDepth(UI_DEPTH.overlay);
    this.combatLogContainer.setMask(mask);

    this.combatLogMask = mask;
    this.combatLogBaseY = scrollY + padding;
    this.combatLogScroll = 0;
    this.combatLogContentHeight = 0;

    this.combatLogBounds = new Phaser.Geom.Rectangle(x, scrollY, width, scrollHeight);
    this.isHoveringCombatLog = false;

    // Two independent message buckets — `combatEntries` is what _log() has
    // always written to; `localEntries` is the new Local tab. `logEntries`
    // stays a live pointer to whichever bucket is currently on screen, so
    // every existing reader of this.logEntries (render, hover tooltips,
    // scroll math) keeps working unmodified regardless of which tab is
    // active — only the tab switch itself repoints it.
    this.combatEntries = [];
    this.localEntries = [];
    this.logEntries = this.combatEntries;
    this.activeCombatLogTab = 'combat';
    this._combatLogTabScroll = { combat: 0, local: 0 };
    this.combatLogMaxEntries = 100;

    this._createCombatLogTabs(x, y, padding, tabBarHeight);
    this._createLocalChatInput(x, y, width, height, padding, inputBarHeight);

    this.input.on('gameout', () => {
      this.isHoveringCombatLog = false;
    });


    this.input.on('wheel', (pointer, gameObjects, deltaX, deltaY) => {
      let handled = false;
      if (this._isPointerOverCombatLog(pointer)) {
        this.isHoveringCombatLog = true;
        this._setCombatLogScroll((this.combatLogScroll || 0) + deltaY * 0.35);
        handled = true;
      }

      if (!handled && this._isPointerOverActionMenu?.(pointer)) {
        this._scrollActionMenu?.(deltaY);
      }
    });
  }

  // Tiny text-based tab bar — Combat / Local — living in the top strip
  // carved out of the log panel. No heavier Button/UIButton chrome; this is
  // meant to read as part of the panel, not a separate control.
  _createCombatLogTabs(x, y, padding, tabBarHeight) {
    const makeTab = (label, tab, offsetX) => {
      const text = this.add.text(x + padding + offsetX, y + padding - 2, label, {
        fontSize: '14px', fontFamily: 'Georgia', color: '#888888',
      }).setDepth(UI_DEPTH.overlay + 1);
      const underline = this.add.graphics().setDepth(UI_DEPTH.overlay + 1);
      text.setInteractive({ useHandCursor: true })
        .on('pointerdown', () => this._switchCombatLogTab(tab));
      return { text, underline };
    };

    this.combatLogTabButtons = {
      combat: makeTab('Combat', 'combat', 0),
      local: makeTab('Local', 'local', 80),
    };
    this._updateCombatLogTabVisuals();
  }

  _updateCombatLogTabVisuals() {
    const buttons = this.combatLogTabButtons;
    if (!buttons) return;
    for (const [tab, { text, underline }] of Object.entries(buttons)) {
      const active = tab === this.activeCombatLogTab;
      text.setStyle({ color: active ? '#ffffff' : '#888888' });
      underline.clear();
      if (active) {
        underline.lineStyle(2, 0xb8922a, 1);
        underline.lineBetween(text.x, text.y + 18, text.x + text.width, text.y + 18);
      }
    }
  }

  // Switches which bucket this.logEntries points at, restores that tab's own
  // scroll position, and toggles the chat input's visibility. Both tabs
  // share every other piece of log machinery (render/scroll/hover/mask).
  _switchCombatLogTab(tab) {
    if (tab === this.activeCombatLogTab || !this.combatLogTabButtons) return;
    this._combatLogTabScroll[this.activeCombatLogTab] = this.combatLogScroll || 0;
    this.activeCombatLogTab = tab;
    this.logEntries = tab === 'local' ? this.localEntries : this.combatEntries;
    this.combatLogScroll = this._combatLogTabScroll[tab] || 0;
    this._updateCombatLogTabVisuals();
    this._renderCombatLog();
    this.localChatInputDom?.setVisible(tab === 'local');
  }

  // DOM <input> for the Local tab — same pattern CharacterCreationScene.js
  // uses for its name field (Phaser's DOM plugin is already enabled for
  // this project). Hidden until the Local tab is active.
  _createLocalChatInput(x, y, width, height, padding, inputBarHeight) {
    const cx = x + width / 2;
    const cy = y + height - inputBarHeight / 2 - 4;
    this.localChatInputDom = this.add.dom(cx, cy).createFromHTML(`
      <input type="text" name="localChatInput" maxlength="200" placeholder="Say something..."
        style="font-size:13px;padding:4px 8px;width:${width - padding * 2}px;
               background-color:#1c1c1c;color:#dddddd;border:1px solid #555;box-sizing:border-box;">
    `).setDepth(UI_DEPTH.overlay + 1).setVisible(false);

    const inputNode = this.localChatInputDom.getChildByName('localChatInput');
    inputNode?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._submitLocalChatInput();
    });
  }

  _submitLocalChatInput() {
    const inputNode = this.localChatInputDom?.getChildByName('localChatInput');
    const text = (inputNode?.value || '').trim();
    if (!text) return;
    inputNode.value = '';
    this._logLocal({ segments: [{ text: `You: ${text}`, color: '#9fd8ff' }] });
    this._maybeRespondLocal(text);
  }

  // Shared context shape for every LocalChatScripts.js hook — see that
  // file's header comment for what each field means.
  _buildLocalChatCtx(extra = {}) {
    return {
      scene: this, scenarioId: this.scenarioId,
      round: this.combatRound, state: this.localChatState,
      ...extra,
    };
  }

  _postLocalChatLines(lines) {
    if (!lines) return;
    (Array.isArray(lines) ? lines : [lines]).forEach(line => {
      this._logLocal({ segments: [{ text: line, color: '#c9a0ff' }] });
    });
  }

  // Delegates to this encounter's LocalChatScripts.js entry (if any) —
  // see that file for the per-scenario onPlayerInput hook shape.
  _maybeRespondLocal(playerText) {
    this._postLocalChatLines(this.localChatScript?.onPlayerInput?.(playerText, this._buildLocalChatCtx()));
  }

  // Local-tab counterpart to _log() — same normalize/cap/render pipeline,
  // separate bucket so it never mixes with combat events.
  _logLocal(entry, opts = {}) {
    const normalized = this._normalizeLogEntry(entry, opts);
    this.localEntries.push(normalized);
    if (this.combatLogMaxEntries && this.localEntries.length > this.combatLogMaxEntries) {
      const excess = this.localEntries.length - this.combatLogMaxEntries;
      if (excess > 0) this.localEntries.splice(0, excess);
    }
    this._scheduleLogRender();
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


  _log(entry, opts = {}) {
    const normalized = this._normalizeLogEntry(entry, opts);
    // Always targets the Combat bucket specifically (not this.logEntries,
    // which may currently be pointed at the Local tab) — a real combat
    // event firing while the player is on the Local tab must still land in
    // Combat, ready to see next time they switch back.
    this.combatEntries.push(normalized);
    if (this.combatLogMaxEntries && this.combatEntries.length > this.combatLogMaxEntries) {
      const excess = this.combatEntries.length - this.combatLogMaxEntries;
      if (excess > 0) this.combatEntries.splice(0, excess);
    }
    this._scheduleLogRender();
  }

  // _renderCombatLog() fully rebuilds every visible log entry's display
  // objects — a single ability resolution commonly calls _log() several
  // times in a row (damage line, crit line, buildup line, tier-cross line,
  // etc.), which used to mean a full rebuild PER line. This coalesces any
  // _log() calls that land in the same synchronous burst into one deferred
  // rebuild instead, via a same-tick delayedCall — updates still land
  // essentially immediately (next frame), but a 5-line burst from one
  // action now costs 1 rebuild instead of 5.
  _scheduleLogRender() {
    if (this._logRenderPending) return;
    this._logRenderPending = true;
    this.time.delayedCall(0, () => {
      this._logRenderPending = false;
      this._renderCombatLog();
      if (!this.isHoveringCombatLog) {
        this._scrollCombatLogToBottom();
      }
    });
  }

  _normalizeLogEntry(entry, opts = {}) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry) && entry.segments) {
      return { ...entry, segments: entry.segments.map(seg => ({ ...seg })) };
    }

    if (typeof entry === 'string') {
      const color = this._colorForPlainLog(entry);
      return { segments: [{ text: entry, color }] };
    }

    if (entry && typeof entry === 'object' && entry.text) {
      return {
        segments: [{ text: entry.text, color: entry.color || LOG_COLORS.default }]
      };
    }

    const fallback = entry != null ? String(entry) : '';
    return { segments: [{ text: fallback, color: LOG_COLORS.default }] };
  }

  _colorForPlainLog(text) {
    if (!text) return LOG_COLORS.default;
    if (/initiative gauge/i.test(text)) return '#7fc8ff';
    if (/buildup|weakens|weakness/i.test(text)) return '#ffcc80';
    if (/regenerates|heals/i.test(text)) return LOG_COLORS.heal;
    if (/damage/i.test(text)) return LOG_COLORS.damage;
    return LOG_COLORS.default;
  }

  _renderCombatLog() {
    if (!this.combatLogContainer) return;

    this.tooltip?.hide();
    this.combatLogContainer.removeAll(true);

    const wrapWidth = this._getCombatLogWrapWidth();
    const spacing = 4;
    let y = 0;

    for (const entry of this.logEntries) {
      if (entry?.separator) {
        // Turn divider — thin horizontal line
        const g = this.add.graphics();
        g.lineStyle(1, 0x444444, 0.7);
        g.beginPath();
        g.moveTo(0, 3);
        g.lineTo(wrapWidth, 3);
        g.strokePath();
        g.setPosition(0, y);
        this.combatLogContainer.add(g);
        y += 8;
        continue;
      }
      const { container, height } = this._createLogEntryDisplay(entry, wrapWidth);
      container.setPosition(0, y);
      this.combatLogContainer.add(container);
      y += height + spacing;
    }

    this.combatLogContentHeight = y;
    this._applyCombatLogScroll();
  }

  _getCombatLogWrapWidth() {
    const cfg = this.combatLogConfig || {};
    const pad = cfg.padding ?? 0;
    const width = cfg.width ?? 0;
    return Math.max(120, width - pad * 2);
  }

  _createLogEntryDisplay(entry, wrapWidth) {
    const container = this.add.container(0, 0);
    const segments = Array.isArray(entry?.segments) ? entry.segments : [];

    let cursorX = 0;
    let cursorY = 0;
    let maxBottom = 0;

    const baseStyle = { fontSize: '14px', color: LOG_COLORS.default };

    const applyFontStyle = (seg) => {
      const styles = [];
      if (seg?.bold) styles.push('bold');
      if (seg?.italic) styles.push('italic');
      return styles.join(' ') || undefined;
    };

    segments.forEach(segment => {
      const tokens = this._tokenizeLogText(segment?.text ?? '');
      tokens.forEach(token => {
        if (token === '\n') {
          cursorX = 0;
          cursorY += LOG_LINE_HEIGHT;
          maxBottom = Math.max(maxBottom, cursorY + LOG_LINE_HEIGHT);
          return;
        }

        const style = {
          ...baseStyle,
          color: segment?.color || entry?.color || LOG_COLORS.default,
          fontStyle: applyFontStyle(segment)
        };

        const textObj = this.make.text({
          x: 0,
          y: 0,
          text: token,
          style,
          add: false
        });
        textObj.setOrigin(0, 0);

        const tokenWidth = textObj.width;
        if (cursorX > 0 && tokenWidth > 0 && cursorX + tokenWidth > wrapWidth) {
          cursorX = 0;
          cursorY += LOG_LINE_HEIGHT;
        }

        textObj.x = cursorX;
        textObj.y = cursorY;
        cursorX += tokenWidth;
        maxBottom = Math.max(maxBottom, cursorY + textObj.height);

        container.add(textObj);
        this._applyLogSegmentInteractivity(textObj, segment);
      });
    });

    if (maxBottom === 0) maxBottom = LOG_LINE_HEIGHT;
    container.setSize(wrapWidth, maxBottom);

    return { container, height: maxBottom };
  }

  _tokenizeLogText(text) {
    if (text == null) return [];
    const result = [];
    const pieces = String(text).split(/(\s+)/);
    pieces.forEach(piece => {
      if (!piece) return;
      if (piece.includes('\n')) {
        const parts = piece.split('\n');
        parts.forEach((part, idx) => {
          if (part) result.push(part);
          if (idx < parts.length - 1) result.push('\n');
        });
      } else {
        result.push(piece);
      }
    });
    return result;
  }

  _applyLogSegmentInteractivity(textObj, segment) {
    if (!textObj || !segment) return;

    const hide = () => this.tooltip?.hide();
    const allowTooltip = (pointer) => {
      if (!pointer) return false;
      if (!this._isPointerOverCombatLog?.(pointer)) return false;
      return true;
    };


    if (segment.type === 'ability' && segment.ability) {
      const actor = segment.actor || segment.abilityUser || null;
      const show = (pointer) => {
        if (!allowTooltip(pointer)) return;
        try {
          const data = this._formatAbilityTooltip(segment.ability, actor);
          this.tooltip?.show(pointer.worldX, pointer.worldY, data);
        } catch (err) {
          console.error('[tooltip error]', err, segment.ability);
        }
      };
      const move = (pointer) => {
        if (!allowTooltip(pointer)) {
          hide();
          return;
        }
        this.tooltip?.reposition(pointer.worldX, pointer.worldY);
      };

      textObj.setInteractive({ cursor: 'pointer' });
      textObj.on('pointerover', show);
      textObj.on('pointermove', move);
      textObj.on('pointerout', hide);
      return;
    }

    if ((segment.type === 'damage' || segment.type === 'heal') && segment.tooltipData) {
      const show = (pointer) => {
        if (!allowTooltip(pointer)) return;
        this.tooltip?.show(pointer.worldX, pointer.worldY, segment.tooltipData);
      };
      const move = (pointer) => {
        if (!allowTooltip(pointer)) {
          hide();
          return;
        }
        this.tooltip?.reposition(pointer.worldX, pointer.worldY);
      };

      textObj.setInteractive({ cursor: 'pointer' });
      textObj.on('pointerover', show);
      textObj.on('pointermove', move);
      textObj.on('pointerout', hide);
      return;
    }
    if (segment.tooltipData) {
      const show = (pointer) => {
        if (!allowTooltip(pointer)) return;
        this.tooltip?.show(pointer.worldX, pointer.worldY, segment.tooltipData);
      };
      const move = (pointer) => {
        if (!allowTooltip(pointer)) {
          hide();
          return;
        }
        this.tooltip?.reposition(pointer.worldX, pointer.worldY);
      };

      textObj.setInteractive({ cursor: 'pointer' });
      textObj.on('pointerover', show);
      textObj.on('pointermove', move);
      textObj.on('pointerout', hide);
    }

  }

  _isPointerOverCombatLog(pointer) {
    if (!pointer || !this.combatLogBounds) return false;
    return this.combatLogBounds.contains(pointer.worldX, pointer.worldY);
  }


  _getLogColorForUnit(unit) {
    if (!unit) return LOG_COLORS.neutral;
    if (unit.isEnemy) return LOG_COLORS.enemy;
    if (unit.isEnemy === false) return LOG_COLORS.ally;
    return LOG_COLORS.neutral;
  }

  _logAbilityUseEntry(user, ability, target) {
    if (!ability) return;
    const actorColor = this._getLogColorForUnit(user);
    const targetColor = this._getLogColorForUnit(target);

    const name = user?.name || 'Unknown';
    const abilityName = ability?.name || ability?.id || 'Ability';
    const segments = [
      { text: name, color: actorColor, bold: true },
      { text: ' uses ', color: LOG_COLORS.default },
      {
        text: abilityName,
        color: LOG_COLORS.ability,
        bold: true,
        type: 'ability',
        ability,
        actor: user
      }
    ];

    if (target && target !== user) {
      segments.push({ text: ' on ', color: LOG_COLORS.default });
      segments.push({ text: target.name || 'target', color: targetColor, bold: true });
    }

    segments.push({ text: '.', color: LOG_COLORS.default });

    this._log({ segments });
  }

  _buildDamageTooltipData({
    user,
    target,
    ability,
    amount,
    raw,
    blocked,
    dr,
    critPct,
    isCrit,
    hitChance,
    formulaParts,
    mpCost,
    mpInfo,
    isMagic,
    isSplash,
    typeBreakdown
  }) {
    const C = DAMAGE_TOOLTIP_COLORS;
    const lines = [];
    const title = `${ability?.name || ability?.id || 'Damage'} Breakdown`;

    const actorName = user?.name || 'Source';
    const targetName = target?.name || 'Target';
    lines.push({ text: `Source: ${actorName}`, color: C.muted });
    lines.push({ text: `Target: ${targetName}`, color: C.muted });

    // Prefer the precise typed physical/elemental/necrotic mix (from
    // _resolveMitigation's typed branch) over the old isMagic boolean, which
    // could only ever say "Magic" or "Physical" and collapsed elemental and
    // necrotic into the same label. Falls back to isMagic for legacy/scalar
    // hits that never had a typed breakdown computed.
    const typeInfo = (() => {
      if (!typeBreakdown) return null;
      const { physDmg = 0, elemDmg = 0, necrDmg = 0 } = typeBreakdown;
      const total = physDmg + elemDmg + necrDmg;
      if (total <= 0) return null;
      const parts = [];
      if (physDmg > 0) parts.push(['Physical', physDmg, C.physical]);
      if (elemDmg > 0) parts.push(['Elemental', elemDmg, C.elemental]);
      if (necrDmg > 0) parts.push(['Necrotic', necrDmg, C.necrotic]);
      if (parts.length === 1) return { text: parts[0][0], color: parts[0][2] };
      // Mixed types — no single dominant color reads honestly, so the line
      // stays neutral; each type's own % still tells the story.
      return {
        text: parts.map(([name, amt]) => `${name} ${Math.round(amt / total * 100)}%`).join(' / '),
        color: C.muted,
      };
    })();
    if (typeInfo) {
      lines.push({ text: `Type: ${typeInfo.text}`, color: typeInfo.color });
    } else if (isMagic != null) {
      lines.push({ text: `Type: ${isMagic ? 'Magic' : 'Physical'}`, color: isMagic ? C.elemental : C.physical });
    }

    // Final Damage is the headline number — same orange the log line's own
    // damage segment uses (LOG_COLORS.damage), so the tooltip's most
    // important line visually matches what's already on screen.
    lines.push({ text: `Final Damage: ${amount}`, color: LOG_COLORS.damage });
    if (raw != null && raw !== amount) {
      const blockedText = blocked > 0 ? ` (blocked ${blocked})` : '';
      lines.push({ text: `Raw Damage: ${raw}${blockedText}`, color: C.muted });
    }

    if (dr && Math.abs(dr) > 0.0001) {
      const pct = Math.round(dr * 100);
      const blockedText = blocked > 0 ? ` (blocked ${blocked})` : '';
      lines.push({ text: `Damage Reduction: ${pct}%${blockedText}`, color: C.reduction });
    }

    if (Array.isArray(formulaParts) && formulaParts.length) {
      // Each formula token is individually colored by its structural role
      // (base/crit/conversion/flat/multiplier — see _formulaPartColor) —
      // rendered as one row of side-by-side colored segments (Tooltip.js's
      // _renderBodyLines segments support) rather than one flat-colored
      // string, so the formula itself shows WHERE each part of the final
      // number came from, not just the number.
      const segs = formulaParts.map(p => (
        typeof p === 'string' ? { text: p, color: C.muted } : p
      ));
      lines.push({ segments: [{ text: 'Formula: ', color: C.muted }, ...segs] });
    }

    if (hitChance != null) {
      lines.push({ text: `Hit Chance: ${Math.round(hitChance)}%`, color: C.chance });
    }

    if (critPct != null) {
      lines.push({ text: `Crit Chance: ${Math.round(critPct)}%`, color: LOG_COLORS.crit });
    }
    if (isCrit) {
      lines.push({ text: 'Critical Hit!', color: LOG_COLORS.crit });
    }

    if (typeof mpCost === 'number' && mpCost > 0) {
      let mpLine = `MP Cost: ${mpCost}`;
      const gear = mpInfo?.gear;
      if (gear && gear.before != null && gear.after != null && gear.after !== gear.before) {
        mpLine += ` (gear ${gear.before} → ${gear.after})`;
      }
      const penalty = mpInfo?.penalty;
      if (penalty && penalty.before != null && penalty.after != null && penalty.after !== penalty.before) {
        const mult = penalty.mult ? ` ×${penalty.mult.toFixed(2)}` : '';
        mpLine += ` (penalty ${penalty.before} → ${penalty.after}${mult})`;
      }
      lines.push({ text: mpLine, color: C.muted });
    }

    if (isSplash) {
      lines.push({ text: 'Splash damage instance', color: LOG_COLORS.keyword });
    }

    return {
      title,
      lines,
      tags: ['damage']
    };
  }

  // Heal-side counterpart to _buildDamageTooltipData — no "Type:" line (heals
  // aren't typed physical/elemental/necrotic) and no Damage Reduction; the
  // target-side equivalent (healingReceivedBonus + Proficiency, applied
  // together outside the skill's own apply()) is shown as one combined
  // "Healing Modifier" percentage instead, same idea as DR but framed as a
  // bonus/penalty rather than a reduction.
  _buildHealTooltipData({
    user,
    target,
    ability,
    amount,
    raw,
    critPct,
    isCrit,
    formulaParts,
    mpCost,
    mpInfo,
    isSplash
  }) {
    const lines = [];
    const title = `${ability?.name || ability?.id || 'Healing'} Breakdown`;

    const actorName = user?.name || 'Source';
    const targetName = target?.name || 'Target';
    lines.push(`Source: ${actorName}`);
    lines.push(`Target: ${targetName}`);

    lines.push(`Final Healing: ${amount}`);
    if (raw != null && raw !== amount) {
      lines.push(`Raw Healing: ${raw}`);
      if (raw > 0) {
        const pct = Math.round(((amount / raw) - 1) * 100);
        const sign = pct >= 0 ? '+' : '';
        lines.push(`Healing Modifier: ${sign}${pct}% (Proficiency + target healing received)`);
      }
    }

    if (Array.isArray(formulaParts) && formulaParts.length) {
      lines.push(`Formula: ${formulaParts.join(' ')}`);
    }

    if (critPct != null) {
      lines.push(`Crit Chance: ${Math.round(critPct)}%`);
    }
    if (isCrit) {
      lines.push('Critical Heal!');
    }

    if (typeof mpCost === 'number' && mpCost > 0) {
      let mpLine = `MP Cost: ${mpCost}`;
      const gear = mpInfo?.gear;
      if (gear && gear.before != null && gear.after != null && gear.after !== gear.before) {
        mpLine += ` (gear ${gear.before} → ${gear.after})`;
      }
      const penalty = mpInfo?.penalty;
      if (penalty && penalty.before != null && penalty.after != null && penalty.after !== penalty.before) {
        const mult = penalty.mult ? ` ×${penalty.mult.toFixed(2)}` : '';
        mpLine += ` (penalty ${penalty.before} → ${penalty.after}${mult})`;
      }
      lines.push(mpLine);
    }

    if (isSplash) {
      lines.push('Splash healing instance');
    }

    return {
      title,
      lines,
      tags: ['heal']
    };
  }

  // Visible scrollable height — panel height minus padding AND the tab bar /
  // chat input strips (both carved out of the same footprint). Shared by
  // every scroll-math call site so they can't drift out of sync with
  // _createCombatLog's own mask/container sizing.
  _getCombatLogViewHeight() {
    const cfg = this.combatLogConfig || {};
    const pad = cfg.padding ?? 0;
    const reserved = (cfg.tabBarHeight ?? 0) + (cfg.inputBarHeight ?? 0);
    return Math.max(0, (cfg.height ?? 0) - pad * 2 - reserved);
  }

  _setCombatLogScroll(value) {
    const viewHeight = this._getCombatLogViewHeight();
    const maxScroll = Math.max(0, (this.combatLogContentHeight || 0) - viewHeight);
    const clamped = Phaser.Math.Clamp(value, 0, maxScroll);
    if (clamped === this.combatLogScroll) return;
    this.combatLogScroll = clamped;
    this._applyCombatLogScroll();
  }

  _applyCombatLogScroll() {
    if (!this.combatLogContainer) return;
    const baseY = this.combatLogBaseY ?? 0;
    this.combatLogContainer.y = baseY - (this.combatLogScroll || 0);
  }

  _scrollCombatLogToBottom() {
    const viewHeight = this._getCombatLogViewHeight();
    const maxScroll = Math.max(0, (this.combatLogContentHeight || 0) - viewHeight);
    this._setCombatLogScroll(maxScroll);
  }

  _createBattleSlots() {
    // Slot IDs are NOT a strict descending sequence over this array — the mid
    // column's top/bottom pair (indices 3-4) breaks the 8..1 countdown that
    // every other entry follows. `container.slotId = 8 - index` used to be
    // applied uniformly regardless, which silently transposed slots 4 and 5:
    // the container actually rendered at mid-TOP got slotId 5, and the one at
    // mid-BOTTOM got slotId 4 — backwards from _getColumnBySlotId, the
    // ADJACENCY_MAP/MOVEMENT_COSTS tables, and PartyManagementScene.js, which
    // all assume slot 4 = mid-top, slot 5 = mid-bottom. That's why a unit at
    // slot 6 (back-bottom) with 1 movement had its correct destination (slot
    // 5, the mid-bottom "bridge" slot) highlighted at the wrong on-screen
    // position (mid-top). Explicit IDs here instead of a positional formula,
    // matching the order the array is actually authored in.
    const SLOT_IDS = [8, 7, 6, 4, 5, 3, 2, 1];

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
      const container = this.add.container(pos.x, pos.y).setSize(64, 64).setDepth(2);

      container.setInteractive();

      const rect = this.add.rectangle(0, 0, 64, 64, 0x000000, 0.2)
        .setOrigin(0.5)
        .setStrokeStyle(2, 0xffffff);

      container.add(rect);

      container.slotId = SLOT_IDS[index];
      container.uniqueKey = `ally_${SLOT_IDS[index]}`;
      container.occupied = false;
      container.rect = rect;
      return container;
    });

    // ---- Enemy slots -----------------------------------------------
    this.enemySlots = enemyPositions.map((pos, index) => {
      const container = this.add.container(pos.x, pos.y).setSize(64, 64).setDepth(2);

      container.setInteractive();

      const rect = this.add.rectangle(0, 0, 64, 64, 0x330000, 0.2)
        .setOrigin(0.5)
        .setStrokeStyle(2, 0xff4444);

      container.add(rect);

      container.slotId = SLOT_IDS[index];
      container.uniqueKey = `enemy_${SLOT_IDS[index]}`;
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
    // Prefer same row; fall back to any in that column. Row comes from the
    // real SLOT_COORDS grid, not a `slotId % 3` guess — that guess grouped
    // slots {3,6}/{1,4,7}/{2,5,8}, which doesn't match the actual row pairs
    // (front/back both have 3 rows: {8,3}=row0, {7,2}=row1... plus 5, {6,1}=
    // row2; mid only has 2 rows). Same class of bug as the slot 4/5 swap.
    const sameRowId = unit._slot?.slotId;
    const sameRowValue = sameRowId != null ? SLOT_COORDS[sameRowId]?.row : null;
    const sameRow = sideSlots.find(s => this._getColumnBySlotId(s.slotId) === targetColumn
      && !s.occupied
      && (sameRowValue != null ? SLOT_COORDS[s.slotId]?.row === sameRowValue : true));
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

    // Zone immobilization: block movement if unit's current tile has an active immobilizing zone
    const currentSid = this._charSlotKey(unit);
    if (currentSid) {
      const activeZones = this.slotEffects?.[currentSid] || [];
      if (activeZones.some(z => z.immobilizes && (z.turns || 0) > 0)) {
        this._log?.(`${unit?.name ?? 'Unit'} is immobilized and cannot move.`);
        return false;
      }
    }

    // Character-bound immobilize (e.g. Glacial Strike, Shield Hook): blocks
    // repositioning wherever the unit stands, independent of any tile zone.
    if (Array.isArray(unit.statusEffects) && unit.statusEffects.some(se =>
        se?.id === 'immobilized' && (se.permanent || (se.turns || 0) > 0))) {
      this._log?.(`${unit?.name ?? 'Unit'} is immobilized and cannot move.`);
      return false;
    }

    // --- clear old slot ties ---
    const old = unit._slot;
    if (old) {
      old.char = null;
      old.occupied = false;
      this._clearPortrait?.(old); // remove old visuals but keep the container
    }

    // Conclave Circle's runic zone "dissipates if you move" (per its own
    // description) — it lives on the mover's own statusEffects (character-
    // bound, not slot-bound), so any movement should end it rather than let
    // it silently relocate/linger. This was still just a TODO before; the
    // status effect is removed here, and the ground sprite refresh clears
    // the now-stale visual (previously it stuck around at the old position
    // until some unrelated skill cast happened to trigger a redraw).
    if (Array.isArray(unit.statusEffects)) {
      const zoneIdx = unit.statusEffects.findIndex(se => se?.id === 'runic_zone' && (se.turns || 0) > 0);
      if (zoneIdx !== -1) {
        unit.statusEffects.splice(zoneIdx, 1);
        this._log?.(`${unit?.name ?? 'The mage'}'s runic circle dissipates as they move.`);
        this._refreshRunicZoneSprite?.(unit);
      }
    }

    // --- assign new slot ---
    newSlot.char = unit;
    newSlot.occupied = true;
    unit._slot = newSlot;

    // Track movement for momentum_strike and similar skills
    const actor = this._currentChar?.();
    if (actor && actor === unit) this.currentActorMovedThisTurn = true;

    // --- rebuild visuals at destination ---
    // Use your existing portrait builder (works for both allies and enemies)
    if (typeof this._placePortrait === 'function') {
      this._placePortrait(unit, newSlot);
    }

    // Reposition lodge arrows to the new slot
    this._refreshLodgeSprites(unit);

    // Runic zone dissolves when the caster moves
    if (Array.isArray(unit.statusEffects)) {
      const zoneIdx = unit.statusEffects.findIndex(se => se?.id === 'runic_zone');
      if (zoneIdx !== -1) {
        unit.statusEffects.splice(zoneIdx, 1);
        this._log?.(`${unit?.name ?? 'Mage'}'s runic zone dissolves as they move.`);
      }
    }

    return true;
  }


  // Use only the unit's side and respect the return value.
  // Tries a real 1-step adjacent slot toward back first, then toward front —
  // sourced from ADJACENCY_MAP/SLOT_COORDS (same data player movement uses)
  // instead of a hardcoded toBack/toFront table. That table had drifted out
  // of sync with the brick-offset adjacency system: several of its entries
  // (e.g. slot 3 -> 6, slot 8 -> 5) were 2-3 movement-cost hops apart, not
  // real neighbors, so NPCs could "shuffle" through slots they couldn't
  // actually reach in one step. (This also used to be defined twice,
  // byte-for-byte identical — the second copy silently shadowed the first;
  // only one copy remains now.)
  // Key a slot object the same way _charSlotKey keys a character's current
  // slot (uniqueKey preferred, side_slotId fallback) — lets hazard checks run
  // against a candidate destination slot without needing a char standing there.
  _slotKeyFor(slotEntry, isEnemy) {
    if (!slotEntry) return null;
    if (slotEntry.uniqueKey) return slotEntry.uniqueKey;
    return slotEntry.slotId != null ? `${isEnemy ? 'enemy' : 'ally'}_${slotEntry.slotId}` : null;
  }

  // A slot counts as hazardous if it carries a ground effect that actually
  // harms whoever stands there (direct tile damage, or a weakness buildup
  // tick) — NOT any slotEffect at all, since e.g. Sanctified Slam's zone only
  // grants MP on hit and shouldn't be avoided like a Quake zone would be.
  _slotIsHazardous(slotEntry, isEnemy) {
    const key = this._slotKeyFor(slotEntry, isEnemy);
    const effects = key != null ? this.slotEffects?.[key] : null;
    if (!Array.isArray(effects) || !effects.length) return false;
    return effects.some(eff =>
      (eff?.tickPctMaxHP > 0) || (eff?.buildupFamilies && Object.keys(eff.buildupFamilies).length > 0)
    );
  }

  _enemyTryShuffleOneColumn(npc) {
    const slotId = npc?._slot?.slotId;
    if (!slotId) return false;

    const side = npc.isEnemy ? this.enemySlots : this.allySlots;
    const tryIds = [
      ...getAdjacentSlotsTowardColumn(slotId, -1), // toward back
      ...getAdjacentSlotsTowardColumn(slotId, 1),  // toward front
    ];
    for (const destId of tryIds) {
      const dest = side.find(s => s.slotId === destId && !s.occupied);
      if (!dest || this._slotIsHazardous(dest, npc.isEnemy)) continue;
      if (this._moveUnitToSlot(npc, dest)) return true;
    }
    return false;
  }

  _enemyTryStepTowardFront(npc) {
    const slotId = npc?._slot?.slotId;
    if (!slotId) return false;

    const side = npc.isEnemy ? this.enemySlots : this.allySlots;
    for (const destId of getAdjacentSlotsTowardColumn(slotId, 1)) {
      const dest = side.find(s => s.slotId === destId && !s.occupied);
      if (!dest || this._slotIsHazardous(dest, npc.isEnemy)) continue;
      if (this._moveUnitToSlot(npc, dest)) return true;
    }
    return false;
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

    // Reset prepared reactions for the new fight — char.reaction persists on
    // the character object across combats (party members are the same
    // objects between fights), but prep is now no-longer wiped at turn start
    // (it persists across rounds within a fight), so without this it would
    // otherwise carry over into a brand new combat no matter how the last
    // one ended (win, loss, or exiting training).
    char.reaction = null;

    // Side flags
    char.isEnemy = false;  // explicit
    char.team = 'ally';
  }


  _assignCharToSlot(char, slot) {
    // Sprite is purely visual — the slot CONTAINER handles all clicks.
    const sprite = this.add.image(0, 0, char.skin).setDisplaySize(64, 64);
    const classColor = CLASS_COLORS?.[char.baseClass] || '#ffffff';
    const nameText = this.add.text(0, 32, char.name, { fontSize: '14px', color: classColor }).setOrigin(0.5, 0);

    const barY = 0;
    const hpBar = new StatusBar(this, -50, barY, 60, 6, char.currentHP, char.maxHP, 0xff4444, 'HP');
    const mpBar = new StatusBar(this, -42, barY, 60, 6, char.currentMP, char.maxMP, 0x4444ff, 'MP');
    hpBar.setAngle(-90);
    mpBar.setAngle(-90);

    slot.removeAllListeners();
    slot.add([sprite, nameText, hpBar, mpBar]);
    slot.occupied = true;
    slot.char = char;
    this._wireSlotInfoClick(slot, char);

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
        name: config.name || template.name || config.type,
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
        healingReceivedBonus: 1.0,

        // Equipment dict (populated below if config.drops present)
        equipment: {},
        // baseline derived stats enemies need for DR calculation
        derived: { PhysicalResist: 0, ElementalResist: 0, NecroticResist: 0, Evasion: 0, Accuracy: 0, Initiative: 0, CritChance: 0, CritMult: 1.5 },
        // Base core stats (STR/DEX/CON/INT/WIS/CHA), optional per template —
        // gear-rolled stat bonuses accumulate on top of this in
        // _equipEnemyItem, same field either way. Most enemy types still
        // have no baseStats at all (empty object), which is intentionally
        // equivalent to their old zero-stat behavior — see the
        // calculateDerivedStats() pass after the drops loop below.
        totalStats: { ...(template.baseStats || {}) },
        // Optional flat per-turn MP regen + overall damage multiplier
        // declared directly on the enemy template (not gear-derived).
        // mpRegenPerTurn: for MP-hungry bosses that shouldn't be able to run
        // completely dry and stop acting — reuses the same gearEffects.
        // mpPerTurn field _applyGearStartOfTurn already reads for everyone;
        // _equipEnemyItem's own mpPerTurn writes stack additively on top.
        // damageMultiplierPct: a blunt overall damage dial (e.g. -20 = 80%
        // damage on everything) without touching stats or gear — reuses
        // gearEffects.hiddenDamagePercent, a CombatLogic.js field that
        // affects real damage output the same way globalDamagePercent does,
        // but is deliberately NOT read by the character sheet's PD/ED/ND
        // display — this is a dev balance lever, not a user-facing buff/debuff.
        gearEffects: {
          ...(Number.isFinite(template.mpRegenPerTurn) && template.mpRegenPerTurn > 0
            ? { mpPerTurn: template.mpRegenPerTurn } : {}),
          ...(Number.isFinite(template.damageMultiplierPct) && template.damageMultiplierPct !== 0
            ? { hiddenDamagePercent: template.damageMultiplierPct } : {}),
        },
      };

      // Equip any configured drops (random item + rarity per entry)
      if (Array.isArray(config.drops)) {
        config.drops.forEach(dropCfg => {
          this._equipEnemyItem(enemy, dropCfg);
        });
      }

      // Resolve base + gear core stats (enemy.totalStats, now fully
      // accumulated) through the SAME calculateDerivedStats() players use —
      // replaces the old ad-hoc CON/WIS-only branches that used to live in
      // _equipEnemyItem. Applied ADDITIVELY on top of the template's flat
      // maxHP/maxMP and the zero-baseline derived stats (direct armor
      // affixes from _derivedMods already landed in enemy.derived per-item
      // above) — for an enemy with no baseStats and no stat-granting gear,
      // every field here is 0 except calculateDerivedStats' own Math.max(1,...)
      // floor on maxHP, so this is a no-op in practice for the common case.
      {
        const statDerived = calculateDerivedStats(enemy.totalStats || {});
        enemy.maxHP += statDerived.maxHP;
        enemy.currentHP = Math.min(enemy.maxHP, enemy.currentHP + statDerived.maxHP);
        enemy.maxMP += statDerived.maxMP;
        enemy.currentMP = Math.min(enemy.maxMP, enemy.currentMP + statDerived.maxMP);
        enemy.derived.Accuracy += statDerived.Accuracy;
        enemy.derived.Evasion += statDerived.Evasion;
        enemy.derived.CritChance += statDerived.CritChance;
        enemy.derived.PhysicalResist += statDerived.PhysicalResist;
        enemy.derived.ElementalResist += statDerived.ElementalResist;
        enemy.derived.NecroticResist += statDerived.NecroticResist;
        enemy.derived.Initiative += statDerived.Initiative;
        enemy.gearEffects = enemy.gearEffects || {};
        enemy.gearEffects.resilience = (enemy.gearEffects.resilience || 0) + (statDerived.Resilience || 0);
        enemy.gearEffects.mpPerTurn = (enemy.gearEffects.mpPerTurn || 0) + (statDerived.MpRegenPerTurn || 0);
      }

      // Flat "natural" derived-stat bonus baked directly into the template —
      // e.g. Mo's 20 base Evasion, Chad's 30% PDR, Gary's 30% NDR, Lenny's
      // 30% EDR — distinct from anything baseStats/gear would grant, so a
      // player can identify "this enemy resists physical, go find a weakness
      // that doesn't" instead of every enemy having a flat, uniform profile.
      // Applied additively on top of the zero-baseline + statDerived above.
      // Resilience isn't one of enemy.derived's fields (it lives in
      // gearEffects.resilience, read by the weakness-buildup reduction at
      // ~line 5893) so it's special-cased to route there instead.
      if (template.derivedBonus) {
        for (const [key, val] of Object.entries(template.derivedBonus)) {
          if (!Number.isFinite(val)) continue;
          if (key === 'Resilience') {
            enemy.gearEffects.resilience = (enemy.gearEffects.resilience || 0) + val;
          } else if (key in enemy.derived) {
            enemy.derived[key] += val;
          }
        }
      }

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

  /**
   * Creates a random item instance for the given drop config and equips it on the enemy.
   * Accumulates gear stat bonuses into enemy.totalStats and applies direct
   * armor affixes (_derivedMods/_miscMods) straight to enemy.derived/gearEffects.
   * Core-stat-DERIVED effects (HP from CON, resists, Accuracy, etc.) are NOT
   * computed here — _placeEnemies runs calculateDerivedStats() once after all
   * of an enemy's drops are equipped, the same function rebuildCharacterStats
   * uses for players, just without the player-specific parts (equipment
   * inventory management, skill unlocks, etc.) that don't apply to enemies.
   *
   * dropCfg: { equip: 'chest'|'head'|..., itemId?: string, droppable?: bool }
   */
  _equipEnemyItem(enemy, dropCfg) {
    const equipSlot = dropCfg.equip || 'chest';
    const droppable = dropCfg.droppable ?? false;
    const isWeaponSlot = equipSlot === 'weaponMain' || equipSlot === 'weaponOff';

    // Pick a specific item ID or choose randomly from the slot pool
    let itemId = dropCfg.itemId;
    if (!itemId) {
      // Weapons need an explicit itemId — no generic random-weapon pool here
      // (armor's random fallback below assumes an armor slot).
      if (isWeaponSlot) return;
      const pool = getItemIdsByTypeSlot('armor', equipSlot);
      if (!pool.length) return;
      itemId = pool[Math.floor(Math.random() * pool.length)];
    }

    let rarity = dropCfg.rarity;
    if (!rarity) {
      if (this.isHunt) {
        const lootQualityPercent = HuntManager.getState()?.combinedModifiers?.lootQualityPercent || 0;
        rarity = rollHuntDropRarity(lootQualityPercent);
      } else {
        rarity = rollEnemyDropRarity();
      }
    }
    // historic-rarity gear (e.g. Bloodthirster) is fixed/scripted, not a
    // random roll — never gets random affixes by default even if a scenario
    // forgot to pass an explicit rarity, matching how the quest-reward copy
    // of this same item is created (rollAffixes: false) in TownScene.js.
    const rollAffixes = dropCfg.rollAffixes ?? (rarity !== 'common' && rarity !== 'historic');
    const inst = createItemInstance(itemId, { rarity, rollAffixes });
    if (!inst) return;

    // Mark whether this instance should drop on victory
    inst._droppable = droppable;

    // Assign to enemy equipment dict
    enemy.equipment[equipSlot] = inst;

    // Apply bonuses directly to derived stats and maxHP so combat DR/resist are live
    const view = getItemComputedData(inst);
    const bonuses = view?.bonuses || {};

    // Generic stat accumulation for ALL bonus keys (STR/CON/DEX/WIS/etc.) —
    // enemies never run through rebuildCharacterStats like players do, so
    // this is the only place their totalStats picks anything up at all.
    enemy.totalStats = enemy.totalStats || {};
    for (const [k, v] of Object.entries(bonuses)) {
      enemy.totalStats[k] = (enemy.totalStats[k] || 0) + v;
    }

    // CON/WIS/DEX/STR derived-stat effects (HP, resists, Accuracy, Evasion,
    // Initiative, weapon damage, Proficiency, ...) all now come from the
    // single calculateDerivedStats() pass in _placeEnemies, run once after
    // every drop for this enemy has been equipped and totalStats is fully
    // accumulated — same formulas players use, no separate ad-hoc branches
    // needed here anymore.

    // Direct derived-stat affixes (e.g. armor's "Hallowed" ElementalResist,
    // or any PhysicalResist/NecroticResist/Accuracy/Evasion/CritChance roll
    // that isn't CON/WIS/DEX-derived) were never applied to enemies at all —
    // only the CON/WIS/DEX branches above fed enemy.derived. Player
    // characters get these via rebuildCharacterStats' gearDerived loop in
    // CharacterBuilder.js; this is the enemy-side equivalent.
    if (view?._derivedMods) {
      for (const [k, v] of Object.entries(view._derivedMods)) {
        if (!v) continue;
        enemy.derived[k] = (enemy.derived[k] || 0) + v;
      }
    }

    // Same generic accumulation for the misc gear-effect fields (resilience,
    // global/elemental/necrotic damage%) — currently has nowhere to matter
    // for THIS encounter's enemies specifically (their skills return
    // hardcoded flat damage, not a calculateDamage() roll that would read
    // gearEffects), but wiring it now means it works automatically the
    // moment any enemy skill is migrated to the real pipeline, instead of
    // silently doing nothing forever like lifeStealPct almost did.
    if (view?._miscMods) {
      const misc = view._miscMods;
      enemy.gearEffects = enemy.gearEffects || {};
      if (misc.resilience) enemy.gearEffects.resilience = (enemy.gearEffects.resilience || 0) + misc.resilience;
      if (misc.globalDamagePercent) enemy.gearEffects.globalDamagePercent = (enemy.gearEffects.globalDamagePercent || 0) + misc.globalDamagePercent;
      if (misc.elementalDamagePercent) enemy.gearEffects.elementalDamagePercent = (enemy.gearEffects.elementalDamagePercent || 0) + misc.elementalDamagePercent;
      if (misc.necroticDamagePercent) enemy.gearEffects.necroticDamagePercent = (enemy.gearEffects.necroticDamagePercent || 0) + misc.necroticDamagePercent;
      if (misc.healingPercent) enemy.gearEffects.healingPercent = (enemy.gearEffects.healingPercent || 0) + misc.healingPercent;
      // mpPerTurn/skillCostReductionPct are read generically off gearEffects
      // (calculateEffectiveResourceCost, per-turn MP regen) with no player-only
      // gate, so enemy casters (e.g. animated_healer/warlock_dummy) benefit too.
      if (misc.mpPerTurn) enemy.gearEffects.mpPerTurn = (enemy.gearEffects.mpPerTurn || 0) + misc.mpPerTurn;
      if (misc.skillCostReductionPct) enemy.gearEffects.skillCostReductionPct = (enemy.gearEffects.skillCostReductionPct || 0) + misc.skillCostReductionPct;
    }

    if (isWeaponSlot) {
      // Mirrors _prepareCharForBattle's player-side weaponType assignment —
      // needed for weapon-gated skills/reactions (e.g. Read and React's
      // melee fallback check) to recognize this enemy as wielding a real
      // weapon instead of silently having weaponType stay null.
      enemy.weaponType = view?.weaponType || enemy.weaponType || null;
    }

    // Gear-driven bonus (e.g. Bloodthirster's lifesteal) instead of a flat
    // hardcoded stat on the enemy template — same field the lifesteal check
    // in _applyAbilityToTarget already reads (user?.gearEffects?.lifeStealPct).
    if (view?.lifeStealPct) {
      enemy.gearEffects = enemy.gearEffects || {};
      enemy.gearEffects.lifeStealPct = (enemy.gearEffects.lifeStealPct || 0) + view.lifeStealPct;
    }
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

    const derived = char.derived || {};
    const eff = (typeof getEffectiveDerived === 'function') ? getEffectiveDerived(char) : (derived || {});

    // Effective evasion with Cold penalty
    let evEff = eff.Evasion | 0;
    try { evEff = applyColdEvasionPenalty(char, evEff); } catch { }
    const baseEv = eff.Evasion | 0;
    let evColor = '#eeeeee';
    if (evEff < baseEv) evColor = '#ff6666';
    else if (evEff > baseEv) evColor = '#66ff66';

    // Accuracy vs its unmodified base — flags temporary combat mods (e.g. Shaken Aim)
    const baseAcc = derived.Accuracy | 0;
    const effAcc = eff.Accuracy | 0;
    let accColor = '#eeeeee';
    if (effAcc < baseAcc) accColor = '#ff6666';
    else if (effAcc > baseAcc) accColor = '#66ff66';

    // Middle column values
    const pdr = getEffectivePDR?.(char) ?? 0;
    const edr = getEffectiveEDR?.(char) ?? 0;
    const ndr = getEffectiveNDR?.(char) ?? 0;
    const healPct = getHealingReceivedMult?.(char) ?? 100;
    const costMult = this._getDisorientCostMult(char);
    const effMaxHP = Math.max(1, Math.floor((char.maxHP | 0) * (1 - (char._weaknessDerived?.maxHPDown || 0))));
    const dispHP = Math.min(char.currentHP | 0, effMaxHP);

    // ===== Right column (original list) =====
    const resilience = char?.resilience ?? char?.gearEffects?.resilience ?? 0;

    // Weakness-family buildup% (gear-derived): per-family weapon suffix +
    // matching armor category affix (physical/elemental/necrotic), combined
    // additively — same formula _applyWeaknessBuildup uses in combat, so the
    // single highest number shown here matches what actually applies.
    const geForBuildup = char?.gearEffects || {};
    const buildupPctByFamily = {};
    for (const fam of Object.keys(WeaknessBuildupCategory)) {
      const weaponPct = geForBuildup.weaponBuildupPercent?.[fam] || 0;
      const armorPct = geForBuildup[`${WeaknessBuildupCategory[fam]}BuildupPercent`] || 0;
      buildupPctByFamily[fam] = weaponPct + armorPct;
    }
    const maxBuildupPct = Math.max(0, ...Object.values(buildupPctByFamily));
    const buildupTooltipLines = Object.entries(buildupPctByFamily)
      .map(([fam, pct]) => `${fam.charAt(0).toUpperCase() + fam.slice(1)}: +${pct}%`);

    const critInfo = (() => {
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

      return { line, color, bold };
    })();

    // Generic "increased damage" per type — gear's globalDamagePercent and any
    // AttackPower-granting combat buff (Rhythm, War Cry, etc.) populate ALL
    // THREE columns uniformly; gear's element/necrotic-specific % only adds to
    // its own column. Matches the same additive-then-multiply model PDR/EDR/NDR
    // already uses on the defensive side, just for outgoing damage instead.
    // Deliberately reads globalDamagePercent only, NOT gearEffects.
    // hiddenDamagePercent (a dev-only balance dial, e.g. the Berserker's
    // un-tuned damage trim) — that one's meant to stay invisible here.
    const ge = char?.gearEffects || {};
    const atkPowerPct = _sumStatusEffectMods?.(char)?.AttackPower || 0;

    // Cold T2's attacker-side "deals less damage" penalty IS a real,
    // player-visible weakness effect (unlike the hidden balance dial above),
    // so it belongs here — mirrors applyWeaknessDamagePipeline's exact
    // formula (CombatLogic.js) so the number shown matches what combat
    // actually applies.
    let coldDealtPenaltyPct = 0;
    if ((char?.weakness?.tiers?.cold || 0) >= 2) {
      const coldMeter = char?.weakness?.meters?.cold || 0;
      const I = familyIntensityMult('cold', coldMeter);
      const basePen = WeaknessV3?.families?.cold?.t2?.dmgDealtPenalty ?? 0;
      const capPen = WeaknessV3?.families?.cold?.t2?.dmgDealtPenaltyCap ?? 0.35;
      coldDealtPenaltyPct = Math.round(Math.min(basePen * I, capPen) * 100);
    }

    const pdPct = Math.round((ge.globalDamagePercent || 0) + atkPowerPct - coldDealtPenaltyPct);
    const edPct = Math.round((ge.globalDamagePercent || 0) + (ge.elementalDamagePercent || 0) + atkPowerPct - coldDealtPenaltyPct);
    const ndPct = Math.round((ge.globalDamagePercent || 0) + (ge.necroticDamagePercent || 0) + atkPowerPct - coldDealtPenaltyPct);

    // Net MP change at the start of this character's turn: gear/INT regen
    // MINUS Concussed's flat drain (Disorient T2) — mirrors the exact
    // formula _startTurnWeakness uses for that drain, so this matches what
    // actually happens. NOT a percentage reduction of the regen rate itself;
    // these are two separate mechanics that both happen to fire at turn start.
    const baseMpPerTurn = char?.gearEffects?.mpPerTurn || 0;
    let concussedDrain = 0;
    if ((char?.weakness?.tiers?.disorient || 0) >= 2) {
      const dm = char?.weakness?.meters?.disorient || 0;
      const dI = familyIntensityMult('disorient', dm);
      const drainBase = WeaknessV3?.families?.disorient?.t2?.startDrainMPBase ?? 0;
      const drainCap = WeaknessV3?.families?.disorient?.t2?.startDrainMPCap ?? 9999;
      concussedDrain = Math.min(Math.floor(drainBase * dI), drainCap);
    }
    const mpPerTurn = baseMpPerTurn - concussedDrain;
    const lifeStealPct = Math.round((char?.gearEffects?.lifeStealPct || 0) * 100);
    // Separate from Proficiency (a highest-core-stat bonus that ALSO affects
    // healing, shown on the Equipment tab) — this combines the HealingPower
    // combat-buff status mod with gear's healingPercent (armor/weapon
    // affixes — see ItemFactory.js), matching applyHealModifiers'
    // (CombatLogic.js) own additive combination of the two.
    const healGivenPct = (_sumStatusEffectMods?.(char)?.HealingPower || 0) + (char?.gearEffects?.healingPercent || 0);

    // Paired rows (right + mid share a row, each independently hoverable —
    // NOT a single "X / Y" string like PDR/EDR/NDR below, since these two
    // need their OWN separate tooltips rather than one shared one). rowsMid
    // entries line up by INDEX with the rowsRight row they sit next to; a
    // rowsRight row with no pair just gets `null` at that index in rowsMid.
    const rowsRight = [
      { label: 'MP:', value: `${char.currentMP}/${char.maxMP}`, desc: 'Current / maximum Mana Points, spent on skills with an MP cost.' },
      { label: 'PDR/EDR/NDR:', value: `${pdr}% / ${edr}% / ${ndr}%`, desc: 'Physical / Elemental / Necrotic Damage Reduction — % of incoming damage of each type prevented.' },
      { label: 'PD/ED/ND:', value: `${pdPct >= 0 ? '+' : ''}${pdPct}% / ${edPct >= 0 ? '+' : ''}${edPct}% / ${ndPct >= 0 ? '+' : ''}${ndPct}%`, desc: 'Physical / Elemental / Necrotic Damage — % bonus (or, if Cold T2, penalty) applied to this character\'s own outgoing damage of each type. Separate from Proficiency, which is a highest-core-stat bonus shown on the Equipment tab.' },
      { label: 'H.Recv:', value: `${healPct}%`, desc: '% of incoming healing actually received.' },
      { label: 'CostX:', value: `×${costMult.toFixed(2)}`, valueColor: (costMult > 1 ? '#ff6666' : '#eeeeee'), valueBold: costMult > 1, desc: 'Multiplier on skill MP/HP costs — raised by Disorient.' },
      { label: 'Crit%:', value: `${eff.CritChance ?? 0}`, desc: 'Chance this character\'s hits land as critical strikes for bonus damage. Reduced by the target\'s Evasion (half value), boosted by this character\'s own excess Accuracy (half value).' },
      { label: 'Resilience:', value: `${resilience}`, desc: 'Flat reduction applied to incoming buildup toward every weakness family. Comes from Wisdom and gear.' },
      { label: 'Accuracy:', value: `${effAcc}`, valueColor: accColor, valueBold: effAcc !== baseAcc, desc: 'Raises this character\'s chance to land a hit. Any excess beyond what\'s needed to reach 100% hit chance instead adds to Crit Chance (half value).' },
      { label: 'Evasion:', value: `${evEff}`, valueColor: evColor, valueBold: true, desc: 'Lowers the attacker\'s chance to hit this character. On a landed hit, it also partially resists being crit (half value).' },
      { label: 'Init Gauge:', value: `${char.initiativeGauge ?? 0}/${char.initiativeGaugeMax ?? 100}`, desc: 'Fills each turn, primarily from Charisma. Spent as a resource by some skills for bonus effects. Initiative sets turn order at the start of battle.' },
      { label: 'Lifesteal:', value: `${lifeStealPct}%`, desc: 'Heals this character for a % of damage dealt — from gear.' },
      {
        label: 'Buildup%:', value: `+${maxBuildupPct}%`,
        desc: 'Highest weakness-buildup bonus across all 9 families (weapon suffix + armor affix, combined). Hover for the full breakdown.',
        descLines: ['Highest gear buildup% bonus across all 9 weakness families:', '', ...buildupTooltipLines],
      },
    ];

    // ===== Middle column — paired counterparts, aligned by index to the
    // rowsRight row they sit next to (see comment above) =====
    const rowsMid = [
      { label: 'HP:', value: `${dispHP}/${effMaxHP}`, desc: 'Current / maximum Hit Points. Reaching 0 knocks the character out.' },
      null,
      null,
      { label: 'H.Given:', value: `${healGivenPct >= 0 ? '+' : ''}${healGivenPct}%`, desc: 'Bonus applied to healing this character casts on others — gear healingPercent + Healing Power combat buffs. Separate from Proficiency (Equipment tab), which also affects healing but isn\'t added in here.' },
      {
        label: 'MP/Trn:', value: `${mpPerTurn >= 0 ? '+' : ''}${mpPerTurn}`,
        valueColor: concussedDrain > 0 ? '#ff6666' : '#eeeeee',
        valueBold: concussedDrain > 0,
        desc: concussedDrain > 0
          ? `Net MP change at the start of this character's turn: +${baseMpPerTurn} regen (gear + Intelligence) − ${concussedDrain} from Concussed (Disorient T2, flat drain that scales with intensity).`
          : 'Flat MP restored at the start of this character\'s turn — from gear and Intelligence (+1 per 5 INT).',
      },
      { label: 'Crit Vuln.:', value: critInfo.line, valueColor: critInfo.color, valueBold: critInfo.bold, desc: 'Bonus crit chance and crit damage attackers get against this character — raised by Expose T2.' },
      null,
      null,
      null,
      null,
      null,
      null,
    ];


    const labelStyle = { fontSize: `${fontPx}px`, color: '#e6d27a', align: 'right' };
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

      if (row.desc || row.descLines) {
        const showTip = (pointer) => {
          this.tooltip?.show(pointer.worldX, pointer.worldY, {
            title: row.label.replace(/:$/, ''),
            lines: row.descLines || [row.desc]
          });
        };
        const moveTip = (pointer) => this.tooltip?.reposition(pointer.worldX, pointer.worldY);
        const hideTip = () => this.tooltip?.hide();
        [valueText, labelText].forEach(t => {
          t.setInteractive({ useHandCursor: true });
          t.on('pointerover', showTip);
          t.on('pointermove', moveTip);
          t.on('pointerout', hideTip);
        });
      }
    });

    // --- MIDDLE column — paired counterpart to the rowsRight row at the
    // same index (see rowsRight/rowsMid comment above); `null` entries mean
    // that rowsRight row has no pair and this column stays blank there ---
    rowsMid.forEach((row, idx) => {
      if (!row) return;
      const y = startY + idx * lineH;

      const valueText = this.add.text(midX, y, row.value, {
        ...valueBase,
        color: row.valueColor || '#eeeeee',
        fontStyle: row.valueBold ? 'bold' : 'normal'
      }).setOrigin(1, 0);
      this.characterInfoPanel.add(valueText);
      this._charInfoBodyGroup.push(valueText);

      const labelX = midX - valueText.width - gap;
      const labelText = this.add.text(labelX, y, row.label, labelStyle).setOrigin(1, 0);
      this.characterInfoPanel.add(labelText);
      this._charInfoBodyGroup.push(labelText);

      if (row.desc || row.descLines) {
        const showTip = (pointer) => {
          this.tooltip?.show(pointer.worldX, pointer.worldY, {
            title: row.label.replace(/:$/, ''),
            lines: row.descLines || [row.desc]
          });
        };
        const moveTip = (pointer) => this.tooltip?.reposition(pointer.worldX, pointer.worldY);
        const hideTip = () => this.tooltip?.hide();
        [valueText, labelText].forEach(t => {
          t.setInteractive({ useHandCursor: true });
          t.on('pointerover', showTip);
          t.on('pointermove', moveTip);
          t.on('pointerout', hideTip);
        });
      }
    });

  }


  // Clear only the header (portrait + name/level)
  _clearCharacterInfoHeader() {
    if (this._charInfoHeaderGroup) this._charInfoHeaderGroup.forEach(c => c.destroy());
    this._charInfoHeaderGroup = [];
    this._charStatusIconContainer = null;
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

    // Status effect badges (shared across tabs)
    const statusY = nameY + nameText.height + 26; // nudged down a bit
    const statusContainer = this.add.container(portraitX, statusY)
      .setDepth(UI_DEPTH.overlay + 2);
    this.characterInfoPanel.add(statusContainer);
    this._charInfoHeaderGroup.push(statusContainer);
    this._charStatusIconContainer = statusContainer;
    this._updateInspectedStatusIcons(char);
  }



  /** Render equipment body (single column, names only) */

  _renderCharacterInfoEquipment(char) {
    this._clearCharacterInfoBody();

    const panelPad = 10;
    const width = this.characterInfoPanelWidth || 400;
    const rightX = width - panelPad;
    const startY = 60 - 20; // moved up 20px
    const statsColumnRight = Math.min(rightX - 40, Math.max(panelPad + 120, rightX - 200));
    const statsLineH = 18;

    const stats = char.totalStats || {};
    const statRows = [
      { label: 'STR:', value: `${stats.STR ?? 0}`, desc: '+1 weapon damage per 5 points. Feeds Crit Chance (with DEX/INT).' },
      { label: 'DEX:', value: `${stats.DEX ?? 0}`, desc: '+1 Accuracy per point. Feeds Crit Chance (with STR/INT).' },
      { label: 'CON:', value: `${stats.CON ?? 0}`, desc: '+2 Max HP and +0.5 Physical Resist per point.' },
      { label: 'INT:', value: `${stats.INT ?? 0}`, desc: '+2 Max MP per point, +1 MP regen per turn per 5 points. Feeds Crit Chance (with STR/DEX).' },
      { label: 'WIS:', value: `${stats.WIS ?? 0}`, desc: '+1 Max MP, +0.5 Elemental Resist, +0.5 Resilience per point.' },
      { label: 'CHA:', value: `${stats.CHA ?? 0}`, desc: '+1 Max MP, +1 Initiative per point (sets turn order and Initiative Gauge regen), +0.5 Elemental Resist, +0.5 Necrotic Resist per point.' },
    ];

    const statLabelStyle = { fontSize: '14px', color: '#cccccc', align: 'right' };
    const statValueStyle = { fontSize: '14px', color: '#eeeeee', align: 'right' };

    statRows.forEach((row, idx) => {
      const y = startY + idx * statsLineH;
      const valueText = this.add.text(statsColumnRight, y, row.value, statValueStyle).setOrigin(1, 0);
      this.characterInfoPanel.add(valueText);
      this._charInfoBodyGroup.push(valueText);

      const labelX = statsColumnRight - valueText.width - 6;
      const labelText = this.add.text(labelX, y, row.label, statLabelStyle).setOrigin(1, 0);
      this.characterInfoPanel.add(labelText);
      this._charInfoBodyGroup.push(labelText);

      const showStatTip = (pointer) => {
        this.tooltip?.show(pointer.worldX, pointer.worldY, {
          title: row.label.replace(/:$/, ''),
          lines: [row.desc]
        });
      };
      const moveStatTip = (pointer) => this.tooltip?.reposition(pointer.worldX, pointer.worldY);
      const hideStatTip = () => this.tooltip?.hide();
      [valueText, labelText].forEach(t => {
        t.setInteractive({ useHandCursor: true });
        t.on('pointerover', showStatTip);
        t.on('pointermove', moveStatTip);
        t.on('pointerout', hideStatTip);
      });
    });

    // Proficiency — %damage bonus off the highest of the 6 core stats above,
    // shown directly beneath them since it's derived straight from this list.
    const profGap = 8;
    const profY = startY + statRows.length * statsLineH + profGap;
    const prof = getProficiencyBreakdown(char);
    const profValueText = this.add.text(statsColumnRight, profY, `+${prof.bonusPct}%`, {
      ...statValueStyle,
      color: prof.bonusPct > 0 ? '#66ff66' : '#eeeeee'
    }).setOrigin(1, 0);
    this.characterInfoPanel.add(profValueText);
    this._charInfoBodyGroup.push(profValueText);

    const profLabelX = statsColumnRight - profValueText.width - 6;
    const profLabelText = this.add.text(profLabelX, profY, 'Proficiency:', statLabelStyle).setOrigin(1, 0);
    this.characterInfoPanel.add(profLabelText);
    this._charInfoBodyGroup.push(profLabelText);

    const showProfTip = (pointer) => {
      this.tooltip?.show(pointer.worldX, pointer.worldY, {
        title: 'Proficiency',
        lines: [
          'A separate %bonus based on your single highest core stat',
          '(whichever of STR/DEX/CON/INT/WIS/CHA is highest).',
          '+1% per point above 10 — applies to outgoing damage and healing.',
          '',
          { text: `Driving stat: ${prof.stat} (${prof.value})`, color: '#66ff66' },
        ]
      });
    };
    const moveProfTip = (pointer) => this.tooltip?.reposition(pointer.worldX, pointer.worldY);
    const hideProfTip = () => this.tooltip?.hide();
    [profValueText, profLabelText].forEach(t => {
      t.setInteractive({ useHandCursor: true });
      t.on('pointerover', showProfTip);
      t.on('pointermove', moveProfTip);
      t.on('pointerout', hideProfTip);
    });

    const slots = ['weaponMain', 'weaponOff', 'head', 'chest', 'legs', 'gloves', 'boots', 'ring', 'amulet'];
    const labelMap = {
      weaponMain: 'M.H',
      weaponOff: 'O.H',
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
      const inst = isItemInstance(equipped) ? equipped : null;
      const rarity = inst?.rarity || inst?.quality || null;
      const rarityColor = (rarity && RARITY_COLORS[rarity]) || '#cccccc';
      const base = inst ? Items[inst.id] : null;

      let label;
      if (!inst) {
        label = `${labelMap[slot]}: —`;
      } else if (char.isEnemy) {
        const rarityLabel = rarity ? rarity.charAt(0).toUpperCase() + rarity.slice(1) : '?';
        // _droppable is set by _equipEnemyItem (defaults false) — some
        // bosses (e.g. Berserker's Bloodthirster + full armor set) are
        // scripted quest/story gear, not random loot, and shouldn't drop on
        // defeat like a normal encounter's would. Show a lock so that's
        // visible instead of just silently not dropping.
        const lockIcon = inst._droppable === false ? ' 🔒' : '';
        label = `${labelMap[slot]}: [${rarityLabel}]${lockIcon}`;
      } else {
        // Allied gear: show base item name only (affixes revealed in tooltip on hover)
        const baseName = base?.name || inst.id;
        label = `${labelMap[slot]}: ${baseName}`;
      }

      const t = this.add.text(rightX, startY + i * 18, label, {
        fontSize: '14px',
        color: inst ? rarityColor : '#555555',
        align: 'right'
      }).setOrigin(1, 0);

      // Wire hover tooltip for equipped items
      if (inst) {
        t.setInteractive({ useHandCursor: false });
        t.on('pointerover', (pointer) => {
          const tipData = this._buildItemTooltipData(inst, char.isEnemy);
          if (tipData) this.tooltip?.show(pointer.worldX, pointer.worldY, tipData);
        });
        t.on('pointerout', () => this.tooltip?.hide());
      }

      this.characterInfoPanel.add(t);
      this._charInfoBodyGroup.push(t);
      i++;
    });
  }

  /**
   * Build tooltip data for an equipped item.
   * Allies: full stat/affix reveal.
   * Enemies: obfuscated — rarity and affix count visible, names hidden.
   */
  _buildItemTooltipData(inst, isEnemy) {
    const base = Items[inst?.id];
    if (!base || !inst) return null;

    const rarity = inst.rarity || inst.quality || 'common';
    const color = RARITY_COLORS[rarity] || '#cccccc';
    const rarityLabel = rarity.charAt(0).toUpperCase() + rarity.slice(1);
    const slotLabel = base.slot ? (base.slot.charAt(0).toUpperCase() + base.slot.slice(1)) : '';
    const typeLabel = base.type === 'armor' ? 'Armor' : base.type === 'weapon' ? 'Weapon' : 'Item';

    if (isEnemy) {
      const affixCount = (inst.prefixes?.length || 0) + (inst.suffixes?.length || 0);
      const lines = [`${rarityLabel} ${slotLabel} ${typeLabel} — unrevealed`, ''];
      for (let a = 0; a < affixCount; a++) lines.push('?? ??');
      if (affixCount) lines.push('');
      // Matches the lock icon's own condition in _renderCharacterInfoEquipment
      // (inst._droppable === false) — was saying "defeat this enemy to loot
      // this item" unconditionally, even on soulbound/historic gear that's
      // locked and will never actually drop.
      lines.push(inst._droppable === false
        ? '🔒 Soulbound — will not drop on defeat.'
        : 'Defeat this enemy to loot this item.');
      return { title: `?? [${rarityLabel}]`, titleColor: color, lines };
    }

    // Allied — full reveal. Used to be a hand-rolled subset (flat stat
    // bonuses + a handful of jewelry procs, but none of the actual
    // damage/modifier info — Min/Max Damage, Local Weapon Damage%, buildup%,
    // resilience, healing%, etc.) — a FOURTH independently-drifted copy of
    // the same tooltip InventoryOverlay/StashOverlay/TownScene already
    // consolidated onto buildItemTooltipLines. Routed through that shared
    // builder instead so combat shows the exact same modifier breakdown as
    // everywhere else.
    return buildItemTooltipLines(inst, { rarityColors: RARITY_COLORS });
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
    const bg = createPanel(this, x, y, width, height, 'default');
    this.characterInfoPanel.add(bg);
    //Who's shown
    this._inspectedChar = char;
    // Refresh slot borders now — this char's border needs to show (they're
    // now the inspected one), and whoever was previously inspected (if
    // anyone, and if not also mid-turn/targeted) needs theirs to hide again.
    this._clearSlotHighlights?.();
    // Persistent header: portrait + name/level under portrait, shows on all tabs
    this._clearCharacterInfoHeader();
    this._renderCharacterInfoHeader(char);
    // Tabs
    this._buildCharacterInfoTabs(char);

    // Body
    this._renderCharacterInfoBody(char);

    // Close button — top-left corner. Previously there was no way to
    // deselect short of clicking a different character, which the border-
    // declutter feature above depends on being possible.
    const closeBtn = this.add.text(8, 8, '✕', {
      fontSize: '16px',
      color: '#cccccc',
      fontStyle: 'bold',
    }).setOrigin(0, 0).setInteractive({ useHandCursor: true });
    closeBtn.on('pointerover', () => closeBtn.setColor('#ffffff'));
    closeBtn.on('pointerout', () => closeBtn.setColor('#cccccc'));
    closeBtn.on('pointerdown', () => {
      this.characterInfoPanel.setVisible(false);
      this._inspectedChar = null;
      this._clearSlotHighlights?.();
    });
    this.characterInfoPanel.add(closeBtn);
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

  // fam: family id. char: the currently-inspected character, used to compute
  // real "Currently: ..." numbers from their actual meter/intensity — just
  // the base weakness-scaled value, no gear/DR/other modifiers layered on
  // (mirrors the same base formula each family's real tick/penalty code uses).
  _weaknessTooltipData(fam, char) {
    const title = this._title(fam);
    const tierNames = WeaknessTierNames[fam] || [];
    const descLines = [];
    const statLines = [];
    const m = char?.weakness?.meters?.[fam] | 0;
    const t = char?.weakness?.tiers?.[fam] | 0;
    const cfg = WeaknessV3?.families?.[fam] || {};
    // label is the tier number (1 or 2); resolves to the actual tier name
    // (e.g. "Dazed") instead of a bare "T1" so it reads the same as the combat
    // log and skill tooltips, which already use these names. Descriptions go
    // first (T1 then T2); the real "Currently: ..." numbers are collected
    // separately and appended together afterward, colored by the same
    // per-tier scheme as the info-panel pip (bright = this tier is actually
    // active on the target right now, gray = just showing the base math).
    // exact: true means this tier's own rule stops applying once the target
    // moves past it (Curse's decay reduction is REPLACED at T2, not stacked
    // on top of T1 — every other family's tiers are additive, T2 keeps T1's
    // effect too, hence the default "at least" check).
    const add = (tier, text, current, opts) => {
      const name = tierNames[tier - 1] || `T${tier}`;
      descLines.push(`${name} (T${tier}): ${text}`);
      if (current) {
        const active = opts?.exact ? (t === tier) : (t >= tier);
        const color = active ? this._getTierColor(tier, fam) : 0x666666;
        statLines.push({ text: `Currently: ${current}`, color });
      }
    };

    switch (fam) {
      case 'fire': {
        const I = familyIntensityMult('fire', m);
        const loss = Math.max(1, Math.floor((cfg.t1?.onActLoss ?? 10) * I));
        const incBase = cfg.t1?.incomingFireBonus ?? 0;
        const incCap = cfg.t1?.incomingFireBonusCap ?? incBase;
        const incPct = Math.round(Math.min(incCap, incBase * I) * 100);
        add(1, 'Takes burn when acting; fire hits harder.',
          `−${loss} Fire buildup per action taken, +${incPct}% incoming Fire buildup.`);
        const tickBase = cfg.t2?.startTickBase ?? 10;
        const tickPerHundred = cfg.t2?.startTickPerHundred ?? 0;
        const tick = Math.max(1, Math.floor(tickBase * I + tickPerHundred * (m / 100)));
        add(2, 'End-of-turn burn tick scales with overflow, plus a flat add-on from current buildup; can consume meter.',
          `${tick} burn damage at end of turn.`);
        break;
      }
      case 'cold': {
        const I = familyIntensityMult('cold', m);
        const regenBase = cfg.t1?.gaugeRegenPenalty ?? 0;
        const regenCap = cfg.t1?.gaugeRegenPenaltyCap ?? regenBase;
        const regenPct = Math.round(Math.min(regenBase * I, regenCap) * 100);
        add(1, 'Initiative gain is slowed.', `−${regenPct}% Initiative Gauge gain.`);
        const drainBase = cfg.t2?.gaugeStartDrainBase ?? 0;
        const drainCap = cfg.t2?.gaugeStartDrainCap ?? 9999;
        const drain = Math.min(Math.floor(drainBase * I), drainCap);
        const dmgBase = cfg.t2?.dmgDealtPenalty ?? 0;
        const dmgCap = cfg.t2?.dmgDealtPenaltyCap ?? dmgBase;
        const dmgPct = Math.round(Math.min(dmgBase * I, dmgCap) * 100);
        const evBase = cfg.t2?.evasionPenalty ?? 0;
        const evCap = cfg.t2?.evasionPenaltyCap ?? evBase;
        const evPct = Math.round(Math.min(evBase * I, evCap) * 100);
        add(2, 'Gauge drains at turn start; damage dealt and evasion drop.',
          `−${drain} Initiative Gauge at turn start, −${dmgPct}% damage dealt, −${evPct}% evasion.`);
        break;
      }
      case 'lightning': {
        // Jolts are an on-hit rider (see applyWeaknessDamagePipeline in
        // CombatLogic.js), not a start-of-turn tick like the other families —
        // they fire whenever this character takes a hit while Zapped/Shocked.
        const dieMax = cfg.t1?.joltDieMax ?? 0;
        add(1, 'Takes random jolts of shock damage on each hit taken.',
          `${dieMax ? `1–${dieMax}` : (cfg.t1?.joltFlat ?? 0)} shock damage per hit taken.`);
        const I = familyIntensityMult('lightning', m);
        const chanceBase = cfg.t2?.multiJoltChance ?? 0;
        const chanceCap = cfg.t2?.multiJoltChanceCap ?? chanceBase;
        const chancePct = Math.round(Math.min(chanceCap, chanceBase * I) * 100);
        const extraMax = cfg.t2?.extraJoltsMax ?? 0;
        add(2, 'Chance for multiple extra jolts based on overflow.',
          `${chancePct}% chance per extra jolt (up to ${extraMax}), each hit taken.`);
        break;
      }
      case 'disorient': {
        const I = familyIntensityMult('disorient', m);
        const cmBase = cfg.t1?.costMultiplier ?? 0;
        const cmCap = cfg.t1?.costMultiplierCap ?? cmBase;
        // Cap is flat regardless of tier — matches calculateEffectiveResourceCost
        // in CombatScene.js exactly (the real consumer): the ×1.5 T2 bump is
        // applied to the raw value BEFORE capping, not to the cap itself. This
        // used to scale the cap by 1.5 at T2 too, which could show a bigger
        // number here than the game would ever actually charge.
        let costAdd = cmBase * I;
        if (t >= 2) costAdd *= 1.5;
        costAdd = Math.min(costAdd, cmCap);
        add(1, 'MP costs rise (scales with overflow).', `MP costs +${Math.round(costAdd * 100)}%.`);
        const drainBase = cfg.t2?.startDrainMPBase ?? 0;
        const drainCap = cfg.t2?.startDrainMPCap ?? 9999;
        const drain = Math.min(Math.floor(drainBase * I), drainCap);
        add(2, 'Loses MP at the start of turn.', `−${drain} MP at turn start.`);
        break;
      }
      case 'lacerate': {
        const I = familyIntensityMult('lacerate', m);
        const onActBase = cfg.t1?.onActBuildupFlat ?? 0;
        const onAct = Math.max(1, Math.round(onActBase * I));
        add(1, 'Acting adds lacerate buildup (bleed threat).', `+${onAct} Lacerate buildup per action taken (self).`);
        const pctBase = cfg.t2?.startPctHP ?? 0.06;
        const pctCap = cfg.t2?.startPctCap ?? 0.20;
        const pct = Math.min(pctBase * I, pctCap);
        const maxHP = Math.max(1, char?.maxHP | 0);
        const dot = Math.max(1, Math.floor(maxHP * pct));
        add(2, 'Hemorrhaging: deals a percentage of Max HP as bleed at end of turn.',
          `${dot} damage (${Math.round(pct * 100)}% Max HP) at end of turn.`);
        break;
      }
      case 'expose': {
        const I = familyIntensityMult('expose', m);
        const drPen = (cfg.t1?.physDRPen ?? 0) * I;
        const buildupAmp = (cfg.t1?.physBuildupAmp ?? 0) * I;
        add(1, 'Physical DR is pierced; takes extra physical buildup.',
          `target's physical DR reduced ${Math.round(drPen * 100)} points, +${Math.round(buildupAmp * 100)}% incoming Disorient/Lacerate buildup.`);
        const ccPct = Math.round((cfg.t2?.critChanceBonus ?? 0) * I * 100);
        // Was missing * I entirely — the real calc (applyExposeCritBonuses in
        // CombatLogic.js) scales crit damage by intensity same as crit chance,
        // but this display showed only the flat base config value, understating
        // the actual bonus at any overflow above the T2 threshold.
        const cdPct = Math.round((cfg.t2?.critDamageBonus ?? 0) * I * 100);
        add(2, 'Bonus crit chance and crit damage against the target.',
          `attackers get +${ccPct}% crit chance, +${cdPct}% crit damage.`);
        break;
      }
      case 'toxic': {
        const I = weaknessIntensityMult(m);
        const bypassBase = cfg.t1?.decayBypassChance ?? 0;
        const bypassCap = cfg.t1?.decayBypassChanceCap ?? bypassBase;
        const bypassPct = Math.round(Math.min(bypassCap, bypassBase * I) * 100);
        add(1, 'Sometimes skips decay, letting poison linger.', `${bypassPct}% chance to skip a decay tick.`);
        const tickBase = cfg.t2?.startTickBase ?? 0;
        const tick = Math.max(1, Math.floor(tickBase * I));
        add(2, 'Flat poison tick at end of turn.', `${tick} poison damage at end of turn.`);
        break;
      }
      case 'disease': {
        const I = weaknessIntensityMult(m);
        const healBase = cfg.t1?.healRecvPenalty ?? 0;
        const healCap = cfg.t1?.healRecvPenaltyCap ?? healBase;
        const healPct = Math.round(Math.min(healCap, healBase * I) * 100);
        add(1, 'Incoming healing reduced.', `incoming healing reduced ${healPct}%.`);
        const maxHPBase = cfg.t2?.maxHPDown ?? 0;
        const maxHPPct = Math.round(Math.min(0.40, maxHPBase * I) * 100);
        add(2, 'Max HP temporarily reduced.', `Max HP reduced ${maxHPPct}%.`);
        break;
      }
      case 'curse': {
        // Curse's two tiers are mutually exclusive, not additive — whichever
        // tier the target currently sits at determines the ENTIRE decay
        // reduction; Afflicted's rate replaces Hexed's rather than stacking
        // on top of it. exact:true below reflects that in the coloring (only
        // the current tier's line lights up, not both at once).
        const I = weaknessIntensityMult(m);
        const dec1Base = cfg.t1?.decayReduction ?? 0;
        const dec1Cap = cfg.t1?.decayReductionCap ?? dec1Base;
        const dec1Pct = Math.round(Math.min(dec1Cap, dec1Base * I) * 100);
        add(1, 'Curse meter decays slower.', `Curse decay slowed ${dec1Pct}% (replaced by Afflicted's rate, not stacked, once T2 is reached).`, { exact: true });
        const dec2Base = cfg.t2?.decayReduction ?? 0;
        const dec2Cap = cfg.t2?.decayReductionCap ?? dec2Base;
        const dec2Pct = Math.round(Math.min(dec2Cap, dec2Base * I) * 100);
        // Real live multiplier, matching the exact formula the rider consumer
        // in CombatScene.js uses — was showing the flat base config value
        // (e.g. always "×1.25") regardless of how far into overflow the
        // target actually was, understating the real current amplification.
        const baseAmp = cfg.t2?.curseAmpMult ?? 1;
        const ampMult = Math.max(1, baseAmp * (I > 0 ? I : 1));
        add(2, 'Decay slows further (replaces Hexed\'s rate). Amplifies active curse riders\' bonus damage — not the tagged skill\'s own hit.',
          `Curse decay slowed ${dec2Pct}%, curse riders amplified ×${ampMult.toFixed(2)}.`, { exact: true });
        break;
      }
      default:
        add(1, 'Weakness effect not yet described.');
        add(2, 'Weakness effect not yet described.');
    }

    const lines = statLines.length ? [...descLines, '', ...statLines] : descLines;
    return { title: `${title} Weakness`, lines };
  }

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

      const showTip = (pointer) => {
        const data = this._weaknessTooltipData(fam, char);
        this.tooltip?.show(pointer.worldX, pointer.worldY, data);
      };
      const moveTip = (pointer) => this.tooltip?.reposition(pointer.worldX, pointer.worldY);
      const hideTip = () => this.tooltip?.hide();
      text.setInteractive({ useHandCursor: true });
      pip.setInteractive({ useHandCursor: true });
      text.on('pointerover', showTip);
      text.on('pointermove', moveTip);
      text.on('pointerout', hideTip);
      pip.on('pointerover', showTip);
      pip.on('pointermove', moveTip);
      pip.on('pointerout', hideTip);

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

    // Panel width trimmed 25% (was 180); right edge stays anchored at x=1260
    // (20px from the 1280-wide canvas edge), so only the container x moves.
    const PANEL_WIDTH = 135;
    const PANEL_X = 1260 - PANEL_WIDTH;

    // UI container (excluding the toggle)
    this.turnOrderUI = this.add.container(PANEL_X, 20).setDepth(UI_DEPTH.overlay);

    // Background + unit list
    this.turnOrderContent = this.add.container(0, 0);
    const bg = createPanel(this, 0, 0, PANEL_WIDTH, 300, 'default');
    this.turnOrderContent.add(bg);
    this._turnOrderBg = bg;

    this.turnOrderEntries = [];
    this._refreshTurnOrderUI();

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

  // Rebuilds the turn-order text list from the CURRENT this.turnOrder array.
  // Previously this list was only ever built once, at combat start
  // (_createTurnOrderUI) — a unit dying calls _onUnitKnockedOut, which
  // splices it out of this.turnOrder, but nothing ever removed its stale
  // entry from the on-screen list or re-numbered/re-indexed the rest, so the
  // displayed order (and the "current turn" highlight, which indexes this
  // list positionally against this.currentTurnIndex) drifted out of sync
  // with the real turn order the moment anyone died. Called once at setup
  // and again every time _onUnitKnockedOut removes a unit.
  _refreshTurnOrderUI() {
    if (!this.turnOrderContent) return;
    const MAX_NAME_CHARS = 10;
    const truncateName = (name) => (
      name && name.length > MAX_NAME_CHARS ? `${name.slice(0, MAX_NAME_CHARS - 1)}…` : (name || '')
    );

    (this.turnOrderEntries || []).forEach(entry => entry?.destroy());
    this.turnOrderEntries = [];

    const allUnits = this.turnOrder || [];
    allUnits.forEach((unit, i) => {
      const icon = this.add.text(10, 10 + i * 24, `${i + 1}. ${truncateName(unit.name)}`, {
        fontSize: '14px',
        color: i === this.currentTurnIndex ? '#00ff00' : '#ffffff'
      });
      this.turnOrderContent.add(icon);
      this.turnOrderEntries.push(icon);
    });
  }


  _createEndTurnButton(x, y) {
    this.endTurnButton = new UIButton(this, x, y, 'End Turn', () => {
      const actor = this._currentChar?.();
      if (actor?.isEnemy) return;  // don't let players skip NPCs
      this._advanceTurn();
    });
    this.endTurnButton.setDepth(UI_DEPTH.overlay + 1);
    this.add.existing(this.endTurnButton);
  }


  _createActionMenu(x, y) {
    const { width, height } = this.sys.game.canvas;
    this.actionMenu = this.add.container(x, y).setDepth(UI_DEPTH.overlay);

    // Ensure a single Tooltip instance for this scene
    if (!this.tooltip || !this.tooltip.container || this.tooltip.container.scene !== this) {
      this.tooltip = new Tooltip(this);
      this.input.on('pointermove', (p) => {
        this.tooltip.reposition(p.worldX, p.worldY);
        if (this.combatLogBounds) {
          this.isHoveringCombatLog = this._isPointerOverCombatLog(p);
        }
      });
      this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => { this.tooltip = null; });

      // Rebuild status icon interactivity now that tooltip exists
      const allSlots = [...(this.allySlots || []), ...(this.enemySlots || [])];
      allSlots.forEach(s => { if (s?.char) this._refreshStatusEffectIcons(s.char); });
    }

    // Scrollable viewport setup for the action menu
    this.actionMenuViewport = { x: -96, y: -34, width: 352, height: 254 };
    const {
      x: viewportX = 0,
      y: viewportY = 0,
      width: viewportWidth,
      height: viewportHeight
    } = this.actionMenuViewport;

    const bg = createPanel(this,
      viewportX - 12, viewportY - 12,
      viewportWidth + 24, viewportHeight + 24,
      'menu')
      .setDepth(UI_DEPTH.overlay - 1);
    this.actionMenuBg = bg;
    this.actionMenu.add(bg);

    this.actionMenuContentX = 20;


    this.actionMenuList = this.add.container(0, 0);
    this.actionMenu.add(this.actionMenuList);

    // Use add.graphics() (in-scene) so the geometry mask transforms correctly in WebGL.
    const maskGfx = this.add.graphics();
    maskGfx.fillStyle(0xffffff);
    maskGfx.fillRect(0, 0, viewportWidth, viewportHeight);
    maskGfx.setPosition(x + viewportX, y + viewportY);
    maskGfx.setVisible(false);
    this.actionMenuMask = maskGfx.createGeometryMask();
    this.actionMenuList.setMask(this.actionMenuMask);

    this.actionMenuScrollY = 0;
    this.actionMenuScrollMax = 0;

    // Skill filter pill state — persists across submenu switches
    this._activeFilterTags = new Set();
    this._createSkillFilterPills(x, y);

    // Safe to build now because _buildActionMenuRoot() will hide if not the player's turn
    this._buildActionMenuRoot();

    const turnNamePos = this.layout?.turnName || { x: width - 250, y: height - 310 };
    this.turnNameText = this.add.text(turnNamePos.x, turnNamePos.y, '', {
      fontSize: '18px',
      fontStyle: 'bold',
      color: '#ffffff'
    }).setOrigin(0.5, 1).setDepth(UI_DEPTH.overlay);
  }

  // ─── Skill Filter Pills ───────────────────────────────────────────────────

  _createSkillFilterPills(menuX, menuY) {
    const PILL_DEFS = [
      { tag: 'lacerate',  label: 'Lacer.',   color: 0xcc4444 },
      { tag: 'expose',    label: 'Expose',   color: 0xcc8844 },
      { tag: 'disorient', label: 'Disor.',   color: 0x9944cc },
      { tag: 'disease',   label: 'Disease',  color: 0x447744 },
      { tag: 'curse',     label: 'Curse',    color: 0x6633aa },
      { tag: 'toxic',     label: 'Toxic',    color: 0x44aa44 },
      { tag: 'fire',      label: 'Fire',     color: 0xdd5500 },
      { tag: 'cold',      label: 'Cold',     color: 0x4477cc },
      { tag: 'lightning', label: 'Lightn.',  color: 0xcccc22 },
      { tag: '_major',    label: 'Major',    color: 0xddaa22 },
      { tag: '_bonus',    label: 'Bonus',    color: 0x22aacc },
    ];

    const PILL_W = 50;
    const PILL_H = 17;
    const GAP    = 3;

    // Position pill column so its left edge is just past the old right edge, then 10px further left
    const vp = this.actionMenuViewport;
    const vpLeft = menuX + vp.x;
    const vpTop  = menuY + vp.y;
    const colLeft  = vpLeft - 6 - 3; // nudged 3px closer to panel

    const container = this.add.container(0, 0).setDepth(UI_DEPTH.overlay);
    this._skillFilterPillsContainer = container;
    this._skillFilterPillData = [];

    PILL_DEFS.forEach((def, i) => {
      const py = vpTop + i * (PILL_H + GAP);
      const cx = colLeft + PILL_W / 2;
      const cy = py + PILL_H / 2;

      const bg = this.add.graphics();
      const hexStr = '#' + def.color.toString(16).padStart(6, '0');

      const drawPill = (active) => {
        bg.clear();
        if (active) {
          bg.fillStyle(def.color, 0.25);
          bg.fillRoundedRect(colLeft, py, PILL_W, PILL_H, 4);
          bg.lineStyle(1.5, def.color, 1);
          bg.strokeRoundedRect(colLeft, py, PILL_W, PILL_H, 4);
        } else {
          bg.fillStyle(0x111111, 0.85);
          bg.fillRoundedRect(colLeft, py, PILL_W, PILL_H, 4);
          bg.lineStyle(1, 0x444444, 0.7);
          bg.strokeRoundedRect(colLeft, py, PILL_W, PILL_H, 4);
        }
      };

      drawPill(false);

      const lbl = this.add.text(cx, cy, def.label, {
        fontSize: '10px', color: '#888888'
      }).setOrigin(0.5);

      const zone = this.add.zone(cx, cy, PILL_W, PILL_H)
        .setInteractive({ useHandCursor: true });

      zone.on('pointerover', () => {
        if (!this._activeFilterTags.has(def.tag)) lbl.setColor('#cccccc');
      });
      zone.on('pointerout', () => {
        if (!this._activeFilterTags.has(def.tag)) lbl.setColor('#888888');
      });
      zone.on('pointerdown', () => {
        SoundManager.play('select');
        const isActive = this._activeFilterTags.has(def.tag);
        if (isActive) {
          this._activeFilterTags.delete(def.tag);
          drawPill(false);
          lbl.setColor('#888888');
        } else {
          this._activeFilterTags.add(def.tag);
          drawPill(true);
          lbl.setColor(hexStr);
        }
        this._refreshFilterHighlights();
      });

      container.add([bg, lbl, zone]);
      this._skillFilterPillData.push({ def, drawPill, lbl, hexStr });
    });

    container.setVisible(false);
  }

  _showSkillFilterPills() {
    if (this._skillFilterPillsContainer) {
      this._skillFilterPillsContainer.setVisible(true);
      // Sync pill visual state with any active tags
      this._skillFilterPillData?.forEach(({ def, drawPill, lbl, hexStr }) => {
        const active = this._activeFilterTags.has(def.tag);
        drawPill(active);
        lbl.setColor(active ? hexStr : '#888888');
      });
    }
  }

  _hideSkillFilterPills() {
    this._skillFilterPillsContainer?.setVisible(false);
  }

  _refreshFilterHighlights() {
    const active = this._activeFilterTags;
    if (!this.actionMenuList) return;

    const tagColors = {};
    this._skillFilterPillData?.forEach(({ def }) => { tagColors[def.tag] = def.color; });

    const WEAKNESS_TAGS = new Set(['lacerate','expose','disorient','disease','curse','toxic','fire','cold','lightning']);

    // Separate active pills into two independent groups
    const activeWeakness = [...active].filter(t => WEAKNESS_TAGS.has(t));
    const activeAction   = [...active].filter(t => t === '_major' || t === '_bonus');

    this.actionMenuList.list.forEach(obj => {
      if (!obj?._filterAbility) {
        obj?.setFilterHighlight?.(null);
        obj?.setFilterHighlightInner?.(null);
        return;
      }

      const ab   = obj._filterAbility;
      const tags = Array.isArray(ab.tags) ? ab.tags : [];
      const cost = ab.actionCost || 'major';

      // Outer border — weakness tag match
      let outerColor = null;
      for (const tag of activeWeakness) {
        if (tags.includes(tag)) { outerColor = tagColors[tag]; break; }
      }

      // Inner border — action type (major/bonus) always occupies inner space
      let innerColor = null;
      for (const tag of activeAction) {
        if (tag === '_major' && cost === 'major') { innerColor = tagColors['_major']; break; }
        if (tag === '_bonus' && cost === 'bonus') { innerColor = tagColors['_bonus']; break; }
      }

      obj.setFilterHighlight?.(outerColor);
      obj.setFilterHighlightInner?.(innerColor);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────

  _buildActionMenuRoot() {
    this._exitTargetingMode?.();
    this._clearActionMenuContent();
    this._hideSkillFilterPills?.();
    const curr = this._currentChar?.();
    const isPlayerTurn = !!curr && !curr.isEnemy;

    if (!isPlayerTurn) {
      // Hide the player action UI entirely on enemy turn OR before first _advanceTurn()
      this.actionMenu.setVisible(false);
      this.endTurnButton?.setVisible(false);
      this._setActionMenuInteractive(false);
      return;
    }

    // Player turn: ensure UI is visible and interactive
    this.actionMenu.setVisible(true);
    this.endTurnButton?.setVisible(true);
    this._setActionMenuInteractive(true);
    this.menuLevel = 'root';

    const baseX = this.actionMenuContentX ?? 0;


    const buttons = [
      { label: 'Weapon Skills', handler: () => this._openSubmenu('weapon') },
      { label: 'Class Skills', handler: () => this._openSubmenu('class') },
      { label: 'Special', handler: () => this._openSubmenu('special') },
      { label: 'Reactions', handler: () => this._openSubmenu('reaction') },
      { label: 'Items', handler: () => this._openSubmenu('items') }
    ];

    buttons.forEach((b, i) => {
      const btn = new UIButton(this, baseX, i * 50, b.label, b.handler);
      this._actionMenuAdd(btn);
    });

    this._finalizeActionMenuLayout();
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

    // MP cost with gear/penalty adjustments (CombatScene-specific, prepended to shared lines)
    let mpPrefix = null;
    if (Number.isFinite(ability.mpCost) && ability.mpCost > 0) {
      const info = calculateEffectiveResourceCost(actor, ability.mpCost, 'mp');
      let mpText = `MP: ${ability.mpCost}`;
      if (info.gear)    mpText += ` → ${info.gear.after}`;
      if (info.penalty) mpText += ` → ${info.penalty.after} (Dazed)`;
      mpPrefix = mpText;
    }

    // Remaining cooldown for this actor
    const cdRemaining = actor?.cooldowns?.[ability.id] || 0;

    // Shared builder — passes actor for live weapon/stat numbers
    const { lines, tags, titleColor } = buildSkillTooltipLines(ability, actor, { cdRemaining });

    // Inject MP-with-modifiers line right after the first line (description)
    // replacing the generic "MP: X" that buildSkillTooltipLines already added
    if (mpPrefix) {
      const mpIdx = lines.findIndex(l => l.startsWith('MP:'));
      if (mpIdx >= 0) lines[mpIdx] = mpPrefix;
    }

    return {
      title: ability.name || ability.id || 'Ability',
      titleColor,
      lines,
      tags,
    };
  }



  // Attach hover listeners to a UIButton that triggers an ability
  _wireAbilityTooltip(btn, ability, actor) {
    if (!btn || !ability) return;



    const hide = () => this.tooltip?.hide();
    const safeShow = (pointer) => {
      if (!this._isPointerOverActionMenu?.(pointer)) {
        hide();
        return;
      }
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
    const move = (p) => {
      if (!this._isPointerOverActionMenu?.(p)) {
        hide();
        return;
      }
      this.tooltip?.reposition(p.worldX, p.worldY);
    };

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

    // Prepared set (real current state)
    const preparedIds = new Set(
      (this.reactions?.listPrepared?.(user) || []).map(s => s.id)
    );

    // Pending selection: seeded from whatever's actually prepared the first
    // time this menu opens, so checkboxes reflect real state instead of
    // always starting empty. Every row is freely toggleable (prepared or
    // not) — "Prepare Selected" below replaces the whole prepared set to
    // match this list, rather than only ever adding to it, so unchecking an
    // already-prepared reaction and confirming actually un-prepares it.
    //
    // Also reseed whenever the CURRENT CHARACTER differs from whoever this
    // selection was last built for — _rxSelection previously only reset via
    // the Back button, so switching characters any other way (ending your
    // turn, clicking a different portrait, etc.) left a stale selection from
    // the PREVIOUS character sitting around. Hitting "Prepare Selected" for
    // the new character then re-armed whatever was in that stale list —
    // including reactions the new character can't even use (e.g. a mace
    // wielder ending up with a sword-only reaction like Read and React
    // re-armed on them every time they touched this menu).
    if (!this._rxSelection || this._rxSelectionOwner !== user) {
      this._rxSelection = [...preparedIds];
      this._rxSelectionOwner = user;
    }

    // Header (aligned at x=0 like the buttons)
    const baseX = this.actionMenuContentX ?? 0;

    const header = this.add.text(
      baseX, 0,
      `Select up to ${cap}. Prepared reactions stay armed until you change them — up to ${left} can trigger before your next turn.`,
      { fontSize: '14px', color: '#ffddaa', wordWrap: { width: 260 } }
    ).setOrigin(0, 0);
    this._actionMenuAdd(header);

    // Layout constants (match your normal button vertical rhythm)
    let y = header.height + 8; // start buttons below header
    const ROW_H = 50;

    // Prepare Selected — free (no reaction action point spent here anymore;
    // that's only spent when a prepared reaction actually triggers, see
    // ReactionSystem._fireReaction). Fully syncs the prepared set to match
    // the pending selection: disarms anything unchecked, arms anything newly
    // checked.
    const prepBtn = new UIButton(this, baseX, y, 'Prepare Selected', () => {
      const chosen = (this._rxSelection || []).slice(0, cap);
      this.reactions?.disarm?.(user);
      for (const id of chosen) {
        const sk = SKILLS?.[id];
        if (sk) this.reactions?.arm?.(user, sk);
      }
      this._log(chosen.length
        ? `${user.name} prepares ${chosen.length} reaction${chosen.length > 1 ? 's' : ''}.`
        : `${user.name} stands down — no reactions prepared.`);
      this._openReactionSubmenu();   // rebuild view (re-seeds from the new real state)
      this._updateActionLights?.();  // refresh lights
    });
    this._actionMenuAdd(prepBtn);
    y += ROW_H;

    // Reaction skills — each as a UIButton row in the SAME container
    const sel = new Set(this._rxSelection);
    abilities.forEach((a) => {
      const full = { ...(SKILLS?.[a.id] || a), id: a.id };
      const isSelected = sel.has(a.id);
      const isPrepared = preparedIds.has(a.id);

      const mark = isSelected ? (isPrepared ? '⦿' : '☑') : '☐';
      const name = this._displayNameForSkill
        ? this._displayNameForSkill(user, full)
        : (full.name || full.id);

      const btn = new UIButton(this, baseX, y, `${mark} ${name}`, () => {
        const idx = this._rxSelection.indexOf(full.id);
        if (idx >= 0) {
          this._rxSelection.splice(idx, 1);
        } else {
          if (this._rxSelection.length >= cap) {
            this._log(`Reaction pool full (${cap}). Unselect one first.`);
            return;
          }
          this._rxSelection.push(full.id);
        }
        this._openReactionSubmenu(); // refresh the marks
      });

      // Tooltip on the whole button (not the label only)
      this._wireAbilityTooltip?.(btn, full, user);

      this._actionMenuAdd(btn);
      y += ROW_H;
    });

    // Back — discards any unconfirmed checkbox edits (next open re-seeds
    // from whatever's actually prepared).
    const backBtn = new UIButton(this, baseX, y + 8, '🔙 Back', () => {
      this._rxSelection = null;
      this._rxSelectionOwner = null;
      this._buildActionMenuRoot?.();
    });
    this._actionMenuAdd(backBtn);

    this._finalizeActionMenuLayout();
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

    const baseX = this.actionMenuContentX ?? 0;


    if (!abilities.length) {
      const noText = this.add.text(baseX, 0, 'No abilities available', {
        fontSize: '16px',
        color: '#888888'
      }).setOrigin(0);
      this._actionMenuAdd(noText);

      // Back button
      this._actionMenuAdd(
        new UIButton(this, baseX, 50, '🔙 Back', () => this._buildActionMenuRoot())
      );
      return;
    }

    abilities.forEach((a, i) => {
      // HYDRATE from SKILLS so tooltip/labels have full data
      const full = (SKILLS[a?.id] || a);

      const cdRaw = actor.cooldowns?.[full.id] || 0;
      const onCD = cdRaw > 0 && !DevFlags.isNoCooldownEnabled();
      const noAction = full.actionCost && !this._canUseActionType(full.actionCost);

      const baseLabel = (this._displayNameForSkill
        ? this._displayNameForSkill(actor, full)
        : (full.name || a.name || 'Unnamed'));
      const label = (cdRaw > 0 && !DevFlags.isNoCooldownEnabled()) ? `${baseLabel} (CD${cdRaw})` : baseLabel;

      const btn = new UIButton(this, baseX, i * 50, label, () => {
        if (onCD || noAction) return;
        // Re-clicking the active targeting ability cancels targeting mode
        if (this.targetingAbility?.id === full.id) {
          this._exitTargetingMode();
          return;
        }
        this._useAbility(full, btn);
      });

      // Store ability reference for filter pill highlighting
      btn._filterAbility = full;

      // Make sure tooltip uses the hydrated object
      this._wireAbilityTooltip?.(btn, full, actor);

      btn.setAlpha((onCD || noAction) ? 0.35 : 1.0);
      this._actionMenuAdd(btn);
    });

    // Back button
    const offsetY = abilities.length * 50 + 10;
    this._actionMenuAdd(
      new UIButton(this, baseX, offsetY, '🔙 Back', () => this._buildActionMenuRoot())
    );

    this._finalizeActionMenuLayout();

    // Show filter pills for skill submenus; apply any active filters
    this._showSkillFilterPills?.();
    this._refreshFilterHighlights?.();
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
    // "free" actions (e.g. Momentum Strike) aren't tracked in actionsLeft at
    // all ({major, bonus, class, reaction} only) — they bypass the action-
    // point economy entirely. _useAbility already knew to skip this check for
    // 'free', but _openSubmenu's button-graying logic called this directly
    // without that exemption, so actionsLeft.free (always undefined) made
    // every free-action skill's button permanently grayed out/unclickable
    // regardless of any other condition (e.g. Momentum Strike's "moved this
    // turn" requirement never even got a chance to matter).
    if (type === 'free') return true;
    // Multi-cost skills (e.g. Heartpiercer's ["major","bonus"]) need every
    // listed type available. Using an array directly as an object key would
    // silently stringify to "major,bonus", which never matches a real key —
    // that bug is why multi-action-cost skills always showed as unusable.
    if (Array.isArray(type)) return type.every(t => char.actionsLeft?.[t] > 0);
    return char.actionsLeft?.[type] > 0;
  }

  _useAbility(ability, sourceBtn = null) {
    const type = ability.actionCost || 'major';
    // "free" actions bypass the action point gate entirely
    if (type !== 'free') {
      if (Array.isArray(type)) {
        if (type.some(t => !this._canUseActionType(t))) return;
      } else if (!this._canUseActionType(type)) return;
    }

    const actor = this._currentChar?.();
    if (!actor) return;

    // Cooldown gate BEFORE entering targeting mode
    const cdRemaining = actor.cooldowns?.[ability.id] || 0;
    if (cdRemaining > 0 && !DevFlags.isNoCooldownEnabled()) {
      this._log(`${ability.name} is on cooldown (${cdRemaining} turn${cdRemaining > 1 ? 's' : ''} left).`);
      return;
    }

    // Enforce attacker positionRequirement if present
    if (ability.positionRequirement?.length && !DevFlags.isNoRangeEnabled()) {
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
      this._enterTargetingMode(ability, sourceBtn);
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



  _enterTargetingMode(ability, sourceBtn = null) {
    // Always clear prior listeners first — prevents stale once() handlers from a previous
    // ability (different side) firing when the player switches abilities mid-targeting
    this._clearSlotListeners();

    this.targetingAbility = ability;

    // Highlight the source button amber-gold so the player sees which ability is armed
    this.targetingAbilityBtn = sourceBtn;
    sourceBtn?.setFill(0x88ff88);  // UIButton interprets this as "selected" → amber-gold style

    const slots = ability.targetRequirement === 'enemy' ? this.enemySlots : this.allySlots;
    // Optional per-column target filter
    let filtered = slots;
    if (ability.targetColumns?.length && !DevFlags.isNoRangeEnabled()) {
      filtered = slots.filter(s => {
        const col = this._getColumnBySlotId(s.slotId);
        return ability.targetColumns.includes(col);
      });
    }
    // Optional explicit slot-ID target filter (e.g. arc-pattern skills that can
    // only be aimed at a flank slot, not the center row) — same shape as
    // targetColumns above, just keyed on raw slotId instead of column.
    if (ability.targetSlots?.length && !DevFlags.isNoRangeEnabled()) {
      filtered = filtered.filter(s => ability.targetSlots.includes(s.slotId));
    }



    filtered.forEach(slot => {
      if (!slot.char || slot.char.status === 'incapacitated') return;



      /* ---- 1️⃣  Make the container clickable for this ability ---- */
      slot.removeAllListeners();          // safety
      slot.once('pointerdown', () => {
        this._applyAbilityToTarget(this._currentChar(), slot.char, ability);
        // _buildActionMenuRoot (called inside _applyAbilityToTarget) handles _exitTargetingMode
      });

      /* ---- 3️⃣  Gold outline for feedback ---- */
      slot.rect.setStrokeStyle(3, 0xffff00);
      slot.rect.setAlpha(1); // in case this slot was idle-hidden (alpha 0) before targeting started
    });
  }


  // NOTE: _exitTargetingMode is defined further below (single canonical version)

  //called in combatdefeat(training)
  _restorePartyFull(party) {
    party.forEach(char => {
      char.status = 'alive';
      char.currentHP = char.maxHP;
      char.currentMP = char.maxMP ?? char.currentMP;
      char.actionsLeft = { major: 1, bonus: 1, class: 1, reaction: 1 };
    });
  }

  _resetAllCooldowns() {
    const party = GameState.party || [];
    const foes = this.enemies || [];
    for (const unit of [...party, ...foes]) {
      if (!unit) continue;
      if (!unit.cooldowns) {
        unit.cooldowns = {};
        continue;
      }
      for (const key of Object.keys(unit.cooldowns)) {
        unit.cooldowns[key] = 0;
      }
    }
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

  // XP granted on FIRST clear of each training scenario. No reward on repeats.
  static SCENARIO_XP = {
    'training_encounter_1': 20,
    'training_encounter_2': 30,
    'training_encounter_3': 50,  // brings Lv1 → Lv2 (20+30+50 = 100)
    'training_encounter_4': 60,  // Styx huntsman
    'training_encounter_5': 60,  // Le'sse duelists
    'training_encounter_6': 80,  // Zafaar berserker — pushes through Lv3 (60+60+80=200 > 150)
  };

  _onCombatVictory() {
    this.combatEnded = true;
    this._resetAllCooldowns();
    const xpSummary = [];

    if (this.isTraining) {
      this._log('🏆 Training complete — all party members are fully restored.');
      GameState.party.forEach(char => {
        char.status = 'alive';
        char.currentHP = char.maxHP;
        char.currentMP = char.maxMP;
      });
    } else {
      this._log('🎉 Victory! All enemies defeated.');
      this._reviveAlliesAfterVictory?.();
    }

    // XP: training scenarios only reward on first clear (no farming).
    // Non-training uses the generic calculation.
    const alreadyCompleted = ProgressionManager.isScenarioCompleted(this.scenarioId);
    let xpReward = 0;
    if (this.isTraining) {
      xpReward = alreadyCompleted ? 0 : (CombatScene.SCENARIO_XP[this.scenarioId] ?? 0);
    } else {
      xpReward = this._calculateXPReward();
    }

    let leveledUpNames = [];
    if (xpReward > 0) {
      const result = GameState.awardPartyXP(xpReward);
      leveledUpNames = result.leveledUpNames;
      xpSummary.push(...result.summaries);
    } else if (alreadyCompleted && this.isTraining) {
      GameState.party.forEach(char => {
        if (char.status !== 'dead') xpSummary.push(`${char.name} — already cleared (no XP)`);
      });
    }

    const uiScene = this.scene.get('UIScene');
    if (uiScene?.refreshUI) uiScene.refreshUI();

    // Collect droppable items from all defeated enemies → global inventory
    const loot = [];
    (this.enemies || []).forEach(enemy => {
      const equip = enemy.equipment || {};
      for (const inst of Object.values(equip)) {
        if (isItemInstance(inst) && inst._droppable) {
          GameState.addToInventory(inst);
          loot.push(inst);
        }
      }
    });

    if (loot.length > 0) {
      this._log(`Collected ${loot.length} item${loot.length > 1 ? 's' : ''} from defeated enemies.`);
    }

    let progressReward = null;
    if (this.isHunt) {
      // Hunt fights aren't training-progression scenarios — award Hunt Points
      // (Beast only; Cultist's reward is the loot just collected above) and
      // let the Hunt Hub pick the resolved encounter back up on return.
      const resolved = HuntManager.resolveCombatEncounter({ won: true, type: this.huntContext?.type });
      if (resolved?.huntPoints > 0) {
        this._log(`+${resolved.huntPoints} Hunt Points.`);
      }
    } else {
      // Record progression and collect ticket reward for the victory screen.
      progressReward = ProgressionManager.onScenarioComplete(this.scenarioId);
    }
    GameState.save('autosave');

    // Pass summary to victory screen
    this._showVictoryScreen('Victory!', xpSummary, progressReward, loot, leveledUpNames);
  }


  _calculateXPReward() {
    // Temporary — can be scenario-based later
    if (this.isHunt) {
      const xpPercent = HuntManager.getState()?.combinedModifiers?.xpPercent || 0;
      return Math.round(20 * (1 + xpPercent / 100));
    }
    return 25;
  }

  _onCombatDefeat() {
    this.combatEnded = true;  // stop all further turn/timer work
    this._resetAllCooldowns();

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

      if (this.isHunt) {
        // A wipe ends the hunt itself — the dead go to the Slain roster,
        // there's no continuing back to the Hunt Hub with a dead party.
        GameState.party.filter(c => c.status === 'dead').forEach(c => GameState.moveToSlain(c));
        HuntManager.end();
        this._showDefeatScreen('Defeat', 'Your party has fallen. The hunt is over.');
      } else {
        this._showDefeatScreen('Defeat', 'Return to town.');
      }
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
  // Policy: on use, store the base cooldown turns. We tick at end of the
  // acting unit's turn and a skill is available only when remaining <= 0.

  _isSkillOnCooldown(char, skillId) {
    return (char.cooldowns?.[skillId] ?? 0) > 0;
  }
  _startSkillCooldown(char, skillId, base) {
    if (!char.cooldowns) char.cooldowns = {};
    const turns = Math.max(0, base || 0);
    char.cooldowns[skillId] = turns;
  }
  _tickCooldownsEndOfTurn(char) {
    if (!char?.cooldowns) return;
    for (const k of Object.keys(char.cooldowns)) {
      if (char.cooldowns[k] > 0) {
        char.cooldowns[k] -= 1;
        if (char.cooldowns[k] < 0) char.cooldowns[k] = 0;
      }
    }
  }

  // === Single skill executor ==============================================
  _executeSkill(user, skillId, target = null) {
    const skill = SKILLS[skillId];
    if (!skill) { this._log(`[WARN] Skill not found: ${skillId}`); return { ok: false }; }

    // Optional gating hook so skills can verify status tiers or custom rules
    if (typeof skill.canExecute === 'function') {
      const verdict = skill.canExecute({ user, target, scene: this }) ?? true;
      const failed = (typeof verdict === 'object') ? (verdict.ok === false) : (verdict === false);
      if (failed) {
        const reason = typeof verdict === 'object' ? verdict.reason : null;
        if (reason) this._log(reason);
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
          this._log(`${skill.name} fizzles — no ${(req.on === 'self') ? 'user' : 'target'} to check.`);
          return { ok: false };
        }

        const tiers = location.weakness?.tiers || {};
        const minTier = req.tierAtLeast ?? req.tier ?? 1;
        if ((tiers[fam] || 0) < minTier) {
          const who = req.on === 'self' ? user?.name || 'user' : target?.name || 'target';
          this._log(`${skill.name} fails — ${who} needs ${fam.toUpperCase()} T${minTier}.`);
          return { ok: false };
        }
      }
    }

    // Pre-checks only (let the pipeline handle actual payment/effects)
    const _mpCost = DevFlags.isFreeManaEnabled() ? 0 : calculateEffectiveResourceCost(user, skill.mpCost || 0, 'mp').cost;
    if (user.currentMP < _mpCost) {
      this._log(`${user.name} lacks the MP to use ${skill.name}.`);
      return { ok: false };
    }
    const hasActionCost = Array.isArray(skill.actionCost)
      ? skill.actionCost.every(t => user.actionsLeft?.[t] > 0)
      : (user.actionsLeft?.[skill.actionCost] > 0);
    if (skill.actionCost && !hasActionCost) {
      this._log(`${user.name} has no ${skill.actionCost} actions left.`);
      return { ok: false };
    }
    if (!DevFlags.isNoCooldownEnabled() && this._isSkillOnCooldown(user, skill.id)) {
      const remain = user.cooldowns?.[skill.id] || 0;
      this._log(`${skill.name} is on cooldown (${remain} turn${remain === 1 ? '' : 's'} remaining).`);
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
    // Track enemy kills for skills like trophy_cry / blood_frenzy that require a kill this turn
    if (unit.isEnemy) {
      this.enemyDiedThisTurn = true;
      const lacTier = unit?.weakness?.tiers?.lacerate || 0;
      this.killedEnemyLacerateTier = Math.max(this.killedEnemyLacerateTier || 0, lacTier);

      this.enemiesDefeatedCount = (this.enemiesDefeatedCount || 0) + 1;
      this._postLocalChatLines(this.localChatScript?.onEnemyDefeated?.(this._buildLocalChatCtx({
        defeatedCount: this.enemiesDefeatedCount,
        totalEnemies: this.scenarioData?.enemies?.length || 0,
        enemy: unit,
      })));

      // Enrage-on-ally-death — generic, template-declared (enemyTypes.js's
      // `enrageOnAllyDeath: { statusId, mods, unlockSkills }`), not
      // hardcoded to any one encounter. When an enemy dies, any other still-
      // living enemy whose OWN template declares this gets a permanent
      // status buff and/or newly unlocked skill ids pushed onto its live
      // `skills` array (AIProfiles.js's canUseSkill/buildAction read SKILLS
      // by id directly, not list membership, so this alone is enough to
      // make the new ability usable — no extra wiring needed per-encounter).
      const survivors = (this.enemies || []).filter(e => e && e !== unit && e.status !== 'incapacitated');
      for (const ally of survivors) {
        const cfg = ENEMY_TYPES[ally.type]?.enrageOnAllyDeath;
        if (!cfg) continue;
        if (cfg.statusId) {
          this._addStatusEffects(ally, [{ id: cfg.statusId, permanent: true, mods: cfg.mods || {} }]);
        }
        if (Array.isArray(cfg.unlockSkills)) {
          ally.skills = ally.skills || [];
          for (const sid of cfg.unlockSkills) {
            if (!ally.skills.includes(sid)) ally.skills.push(sid);
          }
        }
        this._log(`${ally.name} is enraged by ${unit.name}'s fall!`);
      }
    }

    // Destroy lodge arrow sprites for this unit
    const _lodgeKey = unit.name || unit.id || 'unknown';
    (this.lodgeSprites[_lodgeKey] || []).forEach(s => s?.destroy());
    this.lodgeSprites[_lodgeKey] = [];

    // Runic Zone dissipates if its owner is knocked out — same "dissipates"
    // handling movement already gets, just never wired up for death (e.g. a
    // Rune Channel self-jolt, or the zone's own Fire buildup DOT finishing
    // the caster off at end of turn). Removing the status effect alone
    // doesn't clear the ground sprite — _refreshRunicZoneSprite has to be
    // called explicitly to actually destroy it.
    if (Array.isArray(unit.statusEffects)) {
      const zoneIdx = unit.statusEffects.findIndex(se => se?.id === 'runic_zone');
      if (zoneIdx !== -1) unit.statusEffects.splice(zoneIdx, 1);
    }
    this._refreshRunicZoneSprite?.(unit);

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
    this._refreshTurnOrderUI?.();

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



  // Shared typed/scalar mitigation resolver — used by BOTH the primary-hit
  // path below and _applyDirectResult (splash/repeats). Before this, those
  // two had separately-maintained implementations that had drifted apart:
  // the primary path had full physical/elemental/necrotic resolution
  // (physDR/elemDR/necrDR, each with its own min-1 floor), while splash and
  // repeats only ever had a single isMagic-boolean-gated fraction — meaning
  // any hit whose composition became a real mix (e.g. an Elseth amulet
  // converting 30% elemental→necrotic) had that entire mix silently
  // flattened to "all magic or all physical" the moment it splashed or
  // repeated. Unifying them here means both paths automatically get typed
  // resolution whenever a typed breakdown is available, and both fall back
  // identically when one isn't (legacy/~150 unmigrated skills, unaffected).
  //
  // Params:
  //   raw              — pre-mitigation total (already includes any
  //                       normalization the caller did)
  //   physical/elemental/necrotic — optional typed breakdown; if ANY is
  //                       present, typed resolution is used
  //   ignoreDR         — bypass mitigation entirely (e.g. a miss already
  //                       zeroed things, or a skill explicitly says so)
  //   damageReduction  — dual-purpose, matching each path's pre-existing
  //                       semantics: in TYPED mode it's a delta ADDED to the
  //                       freshly-computed physical DR (e.g. Expose T1's
  //                       pierce); in SCALAR mode with no isMagic given, it's
  //                       read as the WHOLE fraction directly (legacy skills
  //                       that pre-compute their own DR via applyDamageModifiers)
  //   isMagic          — SCALAR mode only, used when damageReduction wasn't
  //                       supplied (matches _applyDirectResult's original
  //                       splash/repeat behavior)
  // Returns { dmg, blocked, dr, physDmg, elemDmg, necrDmg } — the typed
  // sub-amounts are only meaningful in typed mode, undefined otherwise.
  _resolveMitigation(target, opts = {}) {
    const { physical, elemental, necrotic, raw, ignoreDR, damageReduction, isMagic } = opts;
    const hasTyped = physical != null || elemental != null || necrotic != null;

    if (hasTyped && !ignoreDR) {
      const rP = physical || 0;
      const rE = elemental || 0;
      const rN = necrotic || 0;
      const typedSum = rP + rE + rN;

      // Re-normalize proportionally if something changed the total after the
      // typed breakdown was computed (e.g. a skill amp applied to `raw` only).
      let p = rP, e = rE, n = rN;
      if (typedSum > 0 && typedSum !== raw) {
        const scale = raw / typedSum;
        p = Math.round(rP * scale);
        e = Math.round(rE * scale);
        n = raw - p - e; // ensure exact sum
      }

      const physDRDelta = damageReduction || 0;
      const physDR = Phaser.Math.Clamp(getDamageReductionFraction(target, { damageType: 'physical', applyExpose: false }) + physDRDelta, -0.95, 0.95);
      const elemDR = Phaser.Math.Clamp(getDamageReductionFraction(target, { damageType: 'elemental', applyExpose: false }), -0.95, 0.95);
      const necrDR = Phaser.Math.Clamp(getDamageReductionFraction(target, { damageType: 'necrotic', applyExpose: false }), -0.95, 0.95);

      // Minimum-1 floor per typed component — a small flat bonus (e.g. a
      // weapon's +1 necrotic affix) shouldn't be fully erased by even 1% resist.
      const physDmg = p > 0 ? Math.max(1, Math.floor(p * (1 - physDR))) : 0;
      const elemDmg = e > 0 ? Math.max(1, Math.floor(e * (1 - elemDR))) : 0;
      const necrDmg = n > 0 ? Math.max(1, Math.floor(n * (1 - necrDR))) : 0;
      const dmg = physDmg + elemDmg + necrDmg;
      const blocked = raw - dmg;
      const dr = raw > 0 ? Math.max(0, 1 - (dmg / raw)) : 0;
      return { dmg, blocked, dr, physDmg, elemDmg, necrDmg };
    }

    const dr = ignoreDR ? 0 : (damageReduction != null
      ? Phaser.Math.Clamp(damageReduction, -0.95, 0.95)
      : Phaser.Math.Clamp(getDamageReductionFraction(target, { isMagic: !!isMagic, applyExpose: false }), -0.95, 0.95));
    const dmg = Math.max(0, Math.floor(raw * (1 - dr)));
    const blocked = raw - dmg;
    return { dmg, blocked, dr };
  }

  _applyAbilityToTarget(user, target, ability, intentOverride = null, options = {}) {
    // Reset the shared breakdown log ONCE here, at the top of every real
    // ability resolution — not just inside calculateDamage()/calculateHealRoll()
    // (which already do their own reset, redundantly). A flat/legacy skill
    // that never calls either of those (most current enemy skills — see
    // project_npc_logic_modernization) never pushes anything to this log at
    // all, so without this its damage tooltip would show whatever was left
    // over from the last REAL typed hit (often a player's), not "no formula
    // available". This makes an empty log the correct, honest default.
    try { _resetDamageBreakdown(); } catch { }

    // ===== Resource gate =====
    // A recast (options.isRepeat — e.g. Rune Channel's spell echo calling
    // this function again at reduced power) is a free automatic proc, not a
    // real player action — it never costs MP, so it's not gated on
    // affording it either (see the matching skip on the actual deduction
    // further down, and on cooldown-start/action-cost-consumption).
    const baseMpCost = (DevFlags.isFreeManaEnabled() || options?.isRepeat) ? 0 : (Number.isFinite(ability?.mpCost) ? ability.mpCost : 0);
    const mpInfo = calculateEffectiveResourceCost(user, baseMpCost, 'mp');
    const mpCost = mpInfo?.cost ?? baseMpCost;

    if (!options?.isRepeat && user.currentMP < mpCost) {
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

    // --- Generic Initiative Gauge requirement gate (e.g. Blazing Fervor,
    // whose entire purpose is spending the gauge — below the minimum spend
    // tier there's nothing for it to do, so it should fizzle rather than
    // silently firing for free).
    if (Number.isFinite(ability?.requiresInitiativeGauge) && ability.requiresInitiativeGauge > 0) {
      const gauge = user?.initiativeGauge || 0;
      if (gauge < ability.requiresInitiativeGauge) {
        this._log(`${ability.name} fizzles: ${user?.name || 'user'} lacks the Initiative Gauge (needs ${ability.requiresInitiativeGauge}).`);
        return; // no costs, no cooldown, no on-act triggers
      }
      // Local-tab hook — an encounter's script can react to its own units'
      // initiative-gauge spenders (e.g. Cade commenting on Coordinated
      // Volley/Molt). No-op unless this scenario's LocalChatScripts.js entry
      // defines onInitiativeAbilityUsed.
      this._postLocalChatLines(this.localChatScript?.onInitiativeAbilityUsed?.(this._buildLocalChatCtx({ user, ability })));
    }

    // --- Generic weakness-tier requirement gate (e.g. Heartpiercer needing
    // the target at least Raw). This field already existed declaratively on
    // several skills and was checked in _executeSkill, but that function
    // isn't what runs for a normal player enemy-target click — this is the
    // path that actually needed the check, so the requirement silently never
    // fired here before now.
    if (ability?.requiresWeakness) {
      const requirements = Array.isArray(ability.requiresWeakness) ? ability.requiresWeakness : [ability.requiresWeakness];
      for (const req of requirements) {
        const fam = req?.family;
        if (!fam) continue;
        const location = req.on === 'self' ? user : target;
        const tiers = location?.weakness?.tiers || {};
        const minTier = req.tierAtLeast ?? req.tier ?? 1;
        if ((tiers[fam] || 0) < minTier) {
          const who = req.on === 'self' ? (user?.name || 'user') : (target?.name || 'target');
          this._log(`${ability.name} fizzles: ${who} needs ${fam.toUpperCase()} T${minTier}.`);
          return; // no costs, no cooldown, no on-act triggers
        }
      }
    }


    // === BEGIN v3: per-action weakness triggers (actor-side) ====================
    const actor = user;
    if (actor?.weakness) {
      const w = actor.weakness;
      const fam = (k) => (k in w.meters) ? k : (WeaknessAliases[k] || k);

      // FIRE T1: acting loses fire buildup (scaled by Fire's intensity) —
      // UNLESS the actor carries the Curse of Cinders rider (Curse T1+),
      // which overrides this into a Fire buildup GAIN instead, scaled by
      // Curse's own intensity. The gain fires regardless of the actor's own
      // Fire tier (unlike the loss, which requires Fire T1+ already).
      {
        const curseTier = w.tiers?.curse | 0;
        const hasCindersRider = curseTier >= 1 &&
          (actor.statusEffects || []).some(se => se?.id === 'curse_cinders' && se?.onAct?.fireBuildupOverride);

        if (hasCindersRider) {
          const mCurse = w.meters?.curse | 0;
          const gainBase = WeaknessV3?.families?.curse?.cinders?.onActFireGainBase ?? 10;
          const I_curse = familyIntensityMult?.('curse', mCurse) ?? 1;
          const gain = Math.max(1, Math.floor(gainBase * I_curse));
          const before = w.meters?.fire | 0;
          w.meters.fire = before + gain;
          this._log(`${actor.name} acts while Cindered: Fire ${before} → ${w.meters.fire} (+${gain}, I=${I_curse.toFixed(2)})`);
          // (Tier recompute handled below)
        } else if ((w.tiers?.fire | 0) >= 1) {
          const mFire = w.meters?.fire | 0;
          const baseLoss = WeaknessV3?.families?.fire?.t1?.onActLoss ?? 50;
          const I = familyIntensityMult?.('fire', mFire) ?? 1;
          const loss = Math.max(1, Math.floor(baseLoss * I));
          const before = mFire;
          w.meters.fire = Math.max(0, before - loss);
          this._log(`${actor.name} acts while Singed: Fire ${before} → ${w.meters.fire} (−${loss}, I=${I.toFixed(2)})`);
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
          this._log(`${actor.name} bleeds more: Lacerate ${before} → ${after} (+${after - before})`);
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

    // Rune Channel: caster takes 80 lightning buildup + 1 flat lightning damage
    // on EVERY skill use while the zone mod is active — including a recast
    // this same zone mod causes (see runeChannel recast block below, which
    // calls this whole function again), since that's a genuine second cast.
    // Deliberately does NOT fire for a plain hit-repeat (repeatChance/
    // _buildRepeatPayload), which never re-enters this function at all —
    // only a true recast does. Buildup is applied FIRST, so a caster already
    // sitting on a lot of accumulated Lightning buildup can have THIS cast's
    // own +80 push them over a jolt-triggering tier, then get jolted by their
    // own rune channel on the very same action — unmitigated by design, same
    // as the original flat 1-damage this replaces.
    {
      const rZone = (user?.statusEffects || []).find(se => se?.id === 'runic_zone' && (se.turns || 0) > 0);
      if (rZone?.mods?.runeChannel) {
        this._applyWeaknessBuildup(user, { lightning: 80 }, { user });
        const { joltTotal } = applyLightningJolt(user);
        const selfDmg = 1 + joltTotal;
        user.currentHP = Math.max(0, (user.currentHP || 0) - selfDmg);
        this._showFloatingNumber?.(selfDmg, user, false);
        const joltNote = joltTotal > 0 ? ` (jolt adds ${joltTotal}!)` : '';
        this._log(`${user?.name ?? 'Mage'} is shocked by the runes for ${selfDmg} lightning damage${joltNote}.`);

        // This self-damage could genuinely knock the caster out (a big
        // self-jolt on top of an already-low HP caster) — it was never
        // checked at all before, so a caster could sit at 0 HP and still be
        // considered "alive" (not incapacitated) for the rest of combat.
        // Same knockout handling every other damage source uses.
        if (user.currentHP <= 0 && user.status !== 'incapacitated') {
          user.status = 'incapacitated';
          this._onUnitKnockedOut(user);
          if (this.combatEnded) return;
          // Caster is down — abort the rest of this cast entirely; there's
          // no one left to deal damage to the target or pay costs/cooldown.
          return;
        }
      }
    }

    // === Pre-hit reactions (redirect / scoped attacker debuff) =============
    // Resolved BEFORE apply()/calculateDamage() ever run — see
    // ReactionSystem.checkPreHit for why this can't reuse the self_hit/
    // ally_hit bus-event path below (that one mutates an ALREADY-COMPUTED
    // result; this needs to be able to change WHO the hit resolves against,
    // which has to happen before the roll, not after). Only for a real
    // primary target — options.isRepeat (recast) and movement skills skip it.
    let preHitScopedDebuffId = null;
    if (!isMovement && !options?.isRepeat && target) {
      const outcome = this.reactions?.checkPreHit?.(target, { attacker: user, ability, scene: this });
      if (outcome?.redirectTo && outcome.redirectTo !== target && outcome.redirectTo.status !== 'incapacitated') {
        this._log(`${outcome.redirectTo.name} intercepts the attack meant for ${target.name}!`);
        target = outcome.redirectTo;
      }
      if (outcome?.scopedDebuffId) preHitScopedDebuffId = outcome.scopedDebuffId;
    }

    // Snapshot weakness tiers BEFORE any new buildup
    const prevTiers = { ...(target?.weakness?.tiers || {}) };

    // Snapshot every target-side "reacts when hit" rider (onNextDamageTaken/
    // onHitBy/nextHitBuildup — see _processTargetHitRiders) BEFORE this
    // ability runs. If THIS very hit is the one that applies a rider (e.g.
    // Pressure Point itself crossing Flayed, or Toxic Bloom applying its own
    // aura), it must NOT also be the hit that triggers/consumes it — only
    // riders that existed before this cast are eligible. By object
    // reference, not id, so a skill that reapplies the same-id rider this
    // same cast is still correctly excluded.
    const preHitRiderRefs = new Set(
      (target?.statusEffects || []).filter(se => se?.onNextDamageTaken || se?.onHitBy || se?.nextHitBuildup)
    );

    // Curse riders no longer need a "before hit" snapshot: their Tier-1 bonus
    // is now applied inside calculateDamage() (called at the very start of a
    // skill's apply(), before that skill can push a NEW rider onto the
    // target), so a rider a skill applies this cast naturally can't also
    // fire its own bonus on that same cast — no gating required.

    // Execute ability to get its payload. `powerScale` (default 1) lets a
    // caller re-invoke this whole function for a genuine RECAST (e.g. Rune
    // Channel's spell echo) at reduced power — a skill opts into supporting
    // this by reading opts.powerScale itself and scaling its own skillPct/
    // buildup numbers; skills that don't read it are simply unaffected
    // (recast at full power) until they're migrated to support it.
    const powerScale = Number.isFinite(options?.powerScale) ? options.powerScale : 1;
    let result = {};
    try {
      result = ability.apply(user, target, this, { powerScale }) || {};
    } catch (e) {
      console.error(`[Ability Error] ${ability.name}`, e);
      this._log(`⚠ ${ability.name} fizzled.`);
      if (preHitScopedDebuffId) this._clearScopedStatus(user, preHitScopedDebuffId);
      return;
    }
    // Scoped pre-hit debuff (e.g. Distracting Feint) only ever applies to
    // THIS one hit — strip it now rather than letting it ride out its own
    // `turns` naturally, which would only tick down at the end of user's
    // whole turn and could leak into a second attack this same turn.
    if (preHitScopedDebuffId) this._clearScopedStatus(user, preHitScopedDebuffId);
    // True no-op: some skills can only check an unmet condition from inside
    // apply() itself, once scene state is available (e.g. Momentum Strike
    // requiring movement this turn — the requiresWeakness/minCurseTier gates
    // above can't cover this since it's not a declarative field). result.fizzle
    // lets apply() signal "nothing happened" after the fact: skip costs,
    // cooldown, action spend, and the generic "X uses Y" line entirely, same
    // as the pre-apply gates above do.
    if (result?.fizzle) {
      if (result.log) this._log(result.log);
      return;
    }

    if (result && Array.isArray(result.statusEffects)) {
      this._addStatusEffects(target, result.statusEffects);
    }

    // Gear conversion + gear damage% — deferred here (see
    // applyGearConversionAndPercent, CombatLogic.js) so it reacts to the
    // skill's OWN finished output, including any manual type conversion the
    // skill just did (e.g. Boulder Toss's Ablaze phys→elem, Miasma Crush's
    // forced necrotic), instead of the weapon's original pre-skill roll.
    // Typed-pipeline skills only — legacy skills already had gear% baked in
    // early, inside calculateDamage(), and are unaffected by this.
    if (ability?.typedDamage && result && !result.isHeal
      && ((result.physical || 0) || (result.elemental || 0) || (result.necrotic || 0))) {
      const converted = applyGearConversionAndPercent(
        { physical: result.physical || 0, elemental: result.elemental || 0, necrotic: result.necrotic || 0 },
        user
      );
      result.physical = converted.physical;
      result.elemental = converted.elemental;
      result.necrotic = converted.necrotic;
      result.amount = converted.amount;
    }

    // Same gear conversion + gear% for every splash entry that carries its
    // own typed breakdown — previously only the primary hit ever got this,
    // so a splash victim never reflected the attacker's Elseth conversion
    // amulets or elemental/necrotic gear% at all (their "type" line only
    // ever showed the skill's own pre-gear composition). Uses the SAME
    // attacker gear as the primary hit — gear conversion depends on the
    // attacker, not the target. `silent:true` — without it, each splash
    // instance's conversion/gear-damage steps push onto the SAME shared
    // breakdown log the PRIMARY hit's tooltip reads from afterward, so a
    // 3-target AOE made the primary's own tooltip show the "phys→ele (gear)"
    // line duplicated 3 times. The primary already logged its own copy of
    // this step a few lines above; splash's own tooltip never reads
    // formulaParts at all (see _buildDamageTooltipData call in
    // _applyDirectResult — formulaParts is hardcoded to []), so there's
    // nothing legitimate for these pushes to feed either way.
    if (ability?.typedDamage && Array.isArray(result?.splash)) {
      for (const sp of result.splash) {
        if (!sp || (sp.physical == null && sp.elemental == null && sp.necrotic == null)) continue;
        const spConverted = applyGearConversionAndPercent(
          { physical: sp.physical || 0, elemental: sp.elemental || 0, necrotic: sp.necrotic || 0 },
          user, { silent: true }
        );
        sp.physical = spConverted.physical;
        sp.elemental = spConverted.elemental;
        sp.necrotic = spConverted.necrotic;
        sp.amount = spConverted.amount;
      }
    }

    // Snapshot the CORE hit composition here — post-gear-conversion, but
    // BEFORE any Tier-3 rider (Jolt) is folded in. This is "the hit itself"
    // as the player would describe it; a rider is a separate thing that
    // TRIGGERS off the hit, not part of its own composition. Repeats/echoes
    // (the generic repeatChance mechanic, runeChannel's echo) use this
    // snapshot instead of the post-Jolt result, and independently re-roll
    // their own Jolt — otherwise a repeat would silently inherit the
    // primary's exact Jolt roll instead of getting its own.
    if (ability?.typedDamage && result && !result.isHeal) {
      result._coreBreakdown = {
        physical: result.physical || 0,
        elemental: result.elemental || 0,
        necrotic: result.necrotic || 0,
      };
    }

    // Lightning Jolt — Tier-3 rider, added dead last: AFTER gear conversion/
    // gear% too (previously it ran inside applyTypedDamageModifiers, before
    // this function even existed, so it couldn't avoid being swept into
    // either). A target-side effect (Zapped/Shocked), unrelated to the
    // skill's own damage composition — never scaled by skill%, buffs, crit,
    // the skill's own conversion, OR gear. Typed-pipeline skills only —
    // legacy skills still get this inside calculateDamage(), unchanged.
    if (ability?.typedDamage && result && !result.isHeal) {
      const { joltTotal } = applyLightningJolt(target);
      if (joltTotal > 0) {
        result.elemental = (result.elemental || 0) + joltTotal;
        result.amount = (result.amount || 0) + joltTotal;
      }
    }

    if (options.logUsage !== false) {
      this._logAbilityUseEntry(user, ability, target);
    }

    // Kindling Rite zone mod: +20%/stack elemental (fire/cold/lightning)
    // damage while zone active (max 3 stacks, +60%). Legacy (non-typed)
    // fallback ONLY now — typed-pipeline skills get this properly and
    // precisely (elemental component only, not the whole scalar amount) via
    // applyTypedDamageModifiers' own step in CombatLogic.js, which also
    // keeps the typed breakdown correctly in sync with `amount` (this flat
    // scalar version doesn't, by nature — this was the exact "known
    // accepted gap" flagged in project_damage_pipeline_reorder memory,
    // closed for typed skills going forward; still needed here for any
    // fire/cold/lightning staff skill not yet migrated to typedDamage).
    if ((result?.amount || 0) > 0 && !isMovement && !ability?.typedDamage) {
      const kindZone = (user?.statusEffects || []).find(se => se?.id === 'runic_zone' && (se.turns || 0) > 0);
      const kindStacks = kindZone?.mods?.kindlingRiteStacks || 0;
      if (kindStacks > 0) {
        const abilityTags = ability?.tags || [];
        const isElemental = ['fire', 'cold', 'lightning'].some(t => abilityTags.includes(t));
        if (isElemental) {
          result.amount = Math.floor(result.amount * (1 + 0.20 * kindStacks));
        }
      }
    }

    // Snipe Pose: consumed on first attack — amplify amount and inject expose buildup
    if ((result?.amount || 0) > 0 && !isMovement) {
      const snipeIdx = (user?.statusEffects || []).findIndex(se => se?.id === 'snipe_pose' && (se.turns || 0) > 0);
      if (snipeIdx !== -1) {
        const sp = user.statusEffects[snipeIdx];
        result.amount = Math.floor(result.amount * (1 + (sp.bonusDmgPct ?? 50) / 100));
        result.buildup = result.buildup || {};
        result.buildup.expose = (result.buildup.expose || 0) + (sp.exposeBuildup ?? 80);
        user.statusEffects.splice(snipeIdx, 1);
        this._log(`${user?.name ?? 'Attacker'} channels their Snipe Pose!`);
      }
    }

    // ===== Establish intent & tags BEFORE reactions / hit checks =====
    const intent = intentOverride || { tags: ability.tags || [], isReaction: false };
    let resultMutable = { ...result };

    // Propagate helpful flags for downstream filters
    const hasAttackTag = (intent.tags || []).includes('attack') || (ability.tags || []).includes('attack');
    // Enemy skills use type:'enemy' and never carry a tags array (unlike
    // player weapon skills), so without this branch NO enemy ability was
    // ever hit-rolled — every attack auto-hit regardless of Accuracy/
    // Evasion/debuffs like Taunting Cry's shaken_aim. Any enemy-authored
    // skill actually aimed at the opposing side counts as an attack source.
    const isEnemyOffensiveSkill = ability.type === 'enemy' && ability.targetRequirement === 'enemy';
    const isWeaponSource = ability.type === 'weapon' || hasAttackTag || isEnemyOffensiveSkill;
    if (resultMutable.isMagic) {
      intent.tags = Array.from(new Set([...(intent.tags || []), 'magic']));
    }
    if (isWeaponSource) {
      intent.tags = Array.from(new Set([...(intent.tags || []), 'attack']));
    }

    // === NEW: Roll to hit (Accuracy vs Evasion) BEFORE reactions land ==========
    // We only roll for weapon/attack-style abilities unless explicitly auto-hit.
    const sameTeam = (!!user?.isEnemy) === (!!target?.isEnemy);
    const metaFriendly = sameTeam
      || ability.targetRequirement === 'ally'
      || ability.targetRequirement === 'self'
      || ability.targetRequirement === 'allyOrSelf'
      || ability.targetRequirement === 'ally_or_self';

    const tagList = Array.isArray(intent.tags) ? intent.tags : [];
    const abilityTags = Array.isArray(ability?.tags) ? ability.tags : [];
    const friendlyTag = tagList.concat(abilityTags).some(tag => (
      tag === 'heal' || tag === 'buff' || tag === 'support'
    ));

    const friendlyOutcome = metaFriendly
      || resultMutable?.isHeal === true
      || friendlyTag;

    // resultMutable.autoHit lets a skill's own apply() force a guaranteed hit
    // for THIS cast only (e.g. Boulder Toss vs a Frostbitten target) without
    // mutating the shared ability.autoHit flag, which would apply to every
    // cast regardless of the condition that earned it.
    const usesHitRoll = !friendlyOutcome && isWeaponSource && ability.hitCheck !== 'none' && ability.autoHit !== true && resultMutable?.autoHit !== true;
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

    const isHealResult = resultMutable?.isHeal === true;

    const rawDamage = Math.max(0, Number(resultMutable.amount || 0));
    const willDealDamage = !isMovement && !isHealResult && (rawDamage > 0 || ability.dealsDamage === true);

    // For typed damage hits (physical/elemental/necrotic), DR is applied per-type at the
    // damage step below — skip this pre-DR block to avoid double-applying base DR.
    // The damageReduction field is still used as a physical DR DELTA (expose T1 writes to it).
    const _hasTypedDamage = resultMutable.physical != null || resultMutable.elemental != null || resultMutable.necrotic != null;
    if (!missed && willDealDamage && !resultMutable.ignoreDR && !_hasTypedDamage) {
      const isMagicHit = !!(resultMutable.isMagic || ability?.isMagic || ability?.tags?.includes?.('magic'));
      const baseDR = getDamageReductionFraction(target, { isMagic: isMagicHit, applyExpose: false });
      if (baseDR) {
        const cur = Number(resultMutable.damageReduction || 0);
        const next = Phaser.Math.Clamp(cur + baseDR, -0.95, 0.95);
        resultMutable.damageReduction = next;
      }
    }


    // ===== Reaction window: BEFORE damage lands on the defender =====
    // Only emit if not missed AND it is hostile & damaging/attack-y.
    if (!missed) {
      const differentTeams = (!!user?.isEnemy) !== (!!target?.isEnemy);
      const rawAmt = (resultMutable.amount | 0);
      const isDamaging = rawAmt > 0 || ability.dealsDamage === true;
      // Deliberately NOT reusing the local isWeaponSource here (that flag
      // also gates hit-rolling/Expose pre-damage above and shouldn't change
      // behavior there) — isReactableAttackSource is the shared, reaction-
      // specific version; see its dev notes in ReactionSystem.js for why
      // type:'enemy' is included and how to tighten it later.
      const allowSelfHit = differentTeams && isDamaging && isReactableAttackSource(ability, intent);

      // Diagnostic: if the target has ANY reaction prepared at all and this
      // hit didn't even qualify to emit self_hit, say why — otherwise a
      // false allowSelfHit here means ReactionSystem never even sees the
      // event, so none of ITS OWN diagnostics get a chance to explain anything.
      if (!allowSelfHit && !missed && target?.reaction?.prepared?.length) {
        if (!differentTeams) {
          // (friendly fire on self typically can't happen, but cheap to check)
        } else if (!isDamaging) {
          this._log?.(`${target.name}'s prepared reaction didn't see a hit to react to (${ability?.name || 'that skill'} dealt no damage).`);
        } else {
          this._log?.(`${target.name}'s prepared reaction ignored ${ability?.name || 'that skill'} (not a recognized attack source — type:'${ability?.type}').`);
        }
      }

      if (allowSelfHit) {
        this.bus?.emit('self_hit', {
          attacker: user,
          target,
          ability,
          intent,
          incomingMutable: resultMutable
        });

        // Ally reactions — emitted for EVERY living teammate of the target,
        // not just same-column ones; each reaction's own canTrigger decides
        // which spatial relationship it actually cares about (e.g. Guardian's
        // Stand wants same-column, Distracting Feint wants "target is in a
        // rank behind me"). Broadened from same-column-only so a reaction
        // needing a different spatial rule doesn't need its own emission path.
        try {
          const sideSlots = target?.isEnemy ? this.enemySlots : this.allySlots;
          const teammatesOfTarget = (sideSlots || [])
            .map(s => s?.char)
            .filter(a => a && a !== target && a.status !== 'incapacitated');

          for (const ally of teammatesOfTarget) {
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

    // Debug log: show what Expose actually did this hit (T1 PDR reduction only —
    // T2 crit vulnerability is a pre-roll bonus inside calculateDamage, logged
    // there via the normal 'critChance'/'crit' breakdown entries instead).
    (() => {
      const ex = resultMutable._expose;
      if (!ex) return;
      const pct = (x) => `${Math.round((x ?? 0) * 100)}%`;

      if (ex.pdrBefore !== undefined && ex.pdrAfter !== undefined) {
        this._log(`Expose: PDR ${pct(ex.pdrBefore)}→${pct(ex.pdrAfter)} (−${pct(ex.pdrSub || 0)})`);
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
        const chanceText = (hitChanceShown != null)
          ? ` (${Math.round(hitChanceShown)}% to hit)`
          : '';
        const missSegments = [
          { text: user.name, color: this._getLogColorForUnit(user), bold: true },
          { text: ' misses ', color: LOG_COLORS.default },
          { text: target.name, color: this._getLogColorForUnit(target), bold: true }
        ];
        if (chanceText) missSegments.push({ text: chanceText, color: LOG_COLORS.info });
        missSegments.push({ text: '.', color: LOG_COLORS.default });
        this._log({ segments: missSegments });

        // Costs/cooldown/action payment happens later as normal.
      } else if (isHeal) {
        // Proficiency (highest-core-stat %bonus) applies to healing output the
        // same as it does to damage — caster-side, so healers aren't left
        // without a use for a high stat the way pure-damage builds have one.
        const healed = Math.floor(amount * (target.healingReceivedBonus || 1.0) * getProficiencyMultiplier(user));
        target.currentHP = Math.min(target.maxHP, target.currentHP + healed);
        if (healed > 0) {
          // Not passing isCrit through here — _showFloatingNumber's isCrit
          // branch unconditionally overrides to yellow regardless of isHeal,
          // which would make a crit heal's floating number look like a
          // damage number instead of a heal. The "(CRIT!)" log tag below is
          // the crit signal for heals; the floating number stays heal-green.
          this._showFloatingNumber?.(healed, target, true);

          // Same tooltip mechanism damage numbers get — reads the SAME
          // shared breakdown log calculateHealRoll now correctly
          // resets/populates (see that function's own comment), so this
          // formula is scoped to THIS heal only, never a stale prior
          // damage-skill's numbers.
          const bd = getLastDamageBreakdown?.() || null;
          let healCritPct = null;
          const healFormulaParts = [];
          if (bd && bd.length) {
            const critEntry = bd.find(e => e && e.label === 'critChance' && typeof e.value === 'number');
            if (critEntry) healCritPct = critEntry.value;
            let baseShown = false;
            for (const e of bd) {
              if (e.label === 'base' && !baseShown) {
                healFormulaParts.push(String(e.value));
                baseShown = true;
              } else if (e.label === 'crit') {
                const m = (e.mult != null) ? e.mult : (e.to && e.from ? (e.to / e.from) : 1.5);
                healFormulaParts.push(`×${(+m).toFixed(2)}`);
              } else if (e.label && e.mult && e.from != null && e.to != null) {
                healFormulaParts.push(`×${(e.mult).toFixed(2)} ${e.label}`);
              }
            }
          }
          const healTooltip = this._buildHealTooltipData({
            user, target, ability,
            amount: healed, raw: amount,
            critPct: healCritPct, isCrit,
            formulaParts: healFormulaParts,
            mpCost, mpInfo,
          });

          const healSegments = [
            { text: user.name, color: this._getLogColorForUnit(user), bold: true },
            { text: ' heals ', color: LOG_COLORS.default },
            { text: target.name, color: this._getLogColorForUnit(target), bold: true },
            { text: ' for ', color: LOG_COLORS.default },
            {
              text: `${healed} HP`,
              color: LOG_COLORS.heal,
              bold: true,
              type: 'heal',
              tooltipData: healTooltip
            },
          ];
          if (isCrit) healSegments.push({ text: ' (CRIT!)', color: LOG_COLORS.crit, bold: true });
          healSegments.push({ text: '.', color: LOG_COLORS.default });
          this._log({ segments: healSegments });
        }
      } else {
        // === DAMAGE with Damage Reduction support ===
        const dealsDamage = !!ability.dealsDamage;
        const raw = Math.max(0, (amount | 0));
        const ignoreDR = !!result?.ignoreDR;

        // See _resolveMitigation for the full rationale — this used to be a
        // separate inline implementation here, now shared with
        // _applyDirectResult (splash/repeats) so the two can't drift apart.
        // damageReduction is coerced to 0 (not left undefined) to preserve
        // this path's exact original behavior: scalar mode here has never
        // fallen back to an isMagic-based computation, unlike
        // _applyDirectResult's own scalar mode, which does.
        const { dmg: dmg0, blocked: blocked0, dr: dr0, physDmg, elemDmg, necrDmg } = this._resolveMitigation(target, {
          physical: result.physical, elemental: result.elemental, necrotic: result.necrotic,
          raw, ignoreDR, damageReduction: result?.damageReduction || 0,
        });
        let dr = dr0, dmg = dmg0, blocked = blocked0;
        const typeBreakdown = (physDmg != null) ? { physDmg, elemDmg, necrDmg } : null;

        // devSuperSaiyan: 10× damage multiplier for player units only
        if (DevFlags.isSuperSaiyanEnabled() && user && !user.isEnemy) dmg *= 10;

        // Status guard effects (guardPct on statusEffects, e.g. fel_chant, bedrock_guard).
        // Must run before damage is applied. Also fires retaliate buildup and consumes guardHits.
        if (!missed && !ignoreDR && dmg > 0) {
          const statusGuardFrac = this._processGuardStatusEffects(target, user);
          if (statusGuardFrac > 0) {
            const reduction = Math.floor(dmg * statusGuardFrac);
            dmg = Math.max(0, dmg - reduction);
            blocked += reduction;
            this._log(`${target?.name ?? 'Target'}'s guard absorbs ${reduction} damage.`);
          }
        }

        // Curse riders (e.g. Curse of Needles) are now a Tier-1 "+X weapon
        // damage" rider handled directly inside calculateDamage() — baked into
        // the base roll before skill%/buffs/gear/crit, universally for every
        // skill (legacy and typed), instead of a flat unmitigated add here
        // after everything (including the target's resistance) had already
        // resolved. See applyCurseWeaponRiders in CombatLogic.js.

        // Target-side "reacts when hit" riders (onNextDamageTaken/onHitBy/
        // nextHitBuildup) — consolidated into _processTargetHitRiders so
        // this works identically for splash/repeat hits too (previously
        // Pressure Point Ignition, Toxic Bloom's heal aura, and Bedrock
        // Guard's retaliation each only ever fired here, never on AOE
        // splash or repeats — see that function's header comment). Only
        // bonusDamage needs folding into `dmg` here — onHitBy's heal-
        // attacker/buildup and nextHitBuildup's attacker-buildup are
        // applied as side effects inside the function itself. Positioned
        // here (not after HP subtraction) so crit-bleed below correctly
        // reflects any onNextDamageTaken bonus as part of the final hit.
        if (raw > 0) {
          const { bonusDamage } = this._processTargetHitRiders(target, user, {
            rawDamage: raw, ignoreDR, preHitRiderRefs,
          });
          dmg += bonusDamage;
        }

        // Attacker-side onHit procs (e.g. Blazing Fervor's fire rider): these
        // live on the ATTACKER's own statusEffects and add bonus damage to
        // THIS hit. For typed-pipeline skills, the fire-damage portion is now
        // a Tier-2 rider handled inside applyTypedDamageModifiers instead
        // (scaled by combat buffs + crit, NOT by the attacking skill's own
        // weapon% — see CombatLogic.js) — only fire it here as a flat,
        // unmitigated fallback for legacy skills, so typed skills don't
        // double-count it. fireBuildup isn't part of that damage-scaling
        // question, so it still applies unconditionally either way.
        if (dmg > 0 && Array.isArray(user?.statusEffects)) {
          const onHitToRemove = [];
          for (let i = 0; i < user.statusEffects.length; i++) {
            const se = user.statusEffects[i];
            const proc = se?.onHit;
            if (!proc) continue;
            if (!se.permanent && (se.turns || 0) <= 0) continue;
            if (proc.fireDamage > 0 && !ability?.typedDamage) {
              dmg += proc.fireDamage;
              try { _pushBreakdown({ label: se.name || 'Fire rider', flat: proc.fireDamage }); } catch { }
              this._log(`${user.name}'s ${se.name || 'fire rider'} burns ${target.name} for +${proc.fireDamage} fire damage.`);
            }
            if (proc.fireBuildup > 0 && target?.weakness) {
              this._applyWeaknessBuildup(target, { fire: proc.fireBuildup }, { user });
            }
            // Generic family-keyed buildup rider (e.g. Bedrock Guard's cold
            // surge on the wielder's next attack) — same shape as
            // nextHitBuildup elsewhere, but attacker-side (applies when THIS
            // unit lands a hit, not when they're hit).
            if (proc.buildup && target?.weakness) {
              this._applyWeaknessBuildup(target, proc.buildup, { user });
            }
            if (se.nextHitOnly) onHitToRemove.push(i);
          }
          for (let i = onHitToRemove.length - 1; i >= 0; i--) user.statusEffects.splice(onHitToRemove[i], 1);
        }

        // Crit-triggered bleed based on the FINAL damage this hit deals — after
        // DR/mitigation AND every additive rider above (Curse of Needles,
        // Pressure Point's ignition, Blazing Fervor's fire rider, etc.), so a
        // bleed correctly reflects everything that actually landed, not just
        // the ability's own base roll. Generic: any ability declaring
        // critBleedPct gets this, not just Heartpiercer — same shape can be
        // reused by future skills.
        if (isCrit && dmg > 0 && Number.isFinite(ability?.critBleedPct) && ability.critBleedPct > 0) {
          const tickDamage = Math.max(1, Math.floor(dmg * (ability.critBleedPct / 100)));
          const bleedTurns = Number.isFinite(ability?.critBleedTurns) ? ability.critBleedTurns : 2;
          const statusId = ability.critBleedStatusId || `${ability.id}_bleed`;
          this._addStatusEffects(target, [{ id: statusId, turns: bleedTurns, tickDamage }]);
          this._log(`${target.name} suffers a bleed from ${ability.name} — ${tickDamage} damage per turn for ${bleedTurns} turns.`);
        }

        // Crit-triggered initiative gain (e.g. Silent Order) — scales with the
        // attacker's own stat instead of a flat number, with an optional
        // stronger multiplier if the target is at least some weakness tier.
        // Generic: any ability declaring critInitiative gets this.
        if (isCrit && ability?.critInitiative) {
          const ci = ability.critInitiative;
          const statVal = user?.totalStats?.[ci.stat] || 0;
          let mult = Number.isFinite(ci.mult) ? ci.mult : 1;
          const rules = Array.isArray(ci.weaknessBonus) ? ci.weaknessBonus : (ci.weaknessBonus ? [ci.weaknessBonus] : []);
          const tw = target?.weakness;
          const matched = rules
            .filter(r => (tw?.tiers?.[r.family] || 0) >= (r.tierAtLeast ?? 1))
            .sort((a, b) => (b.tierAtLeast ?? 1) - (a.tierAtLeast ?? 1))[0];
          if (matched) mult = matched.mult;
          const initGain = Math.max(0, Math.round(statVal * mult));
          if (initGain > 0) {
            user.initiative = (user.initiative || 0) + initGain;
            this._log(`${user?.name ?? 'Attacker'} gains ${initGain} initiative (${ci.stat} ${statVal} × ${mult}).`);
          }
        }

        if (dealsDamage || dmg > 0) {
          target.currentHP = Math.max(0, target.currentHP - dmg);

          // Lifesteal: heal attacker for % of actual damage dealt
          const lifeStealPct = user?.gearEffects?.lifeStealPct || user?.lifeStealPct || 0;
          if (lifeStealPct > 0 && dmg > 0 && user?.currentHP != null && user?.maxHP != null) {
            const healed = Math.max(1, Math.ceil(dmg * lifeStealPct));
            user.currentHP = Math.min(user.maxHP, user.currentHP + healed);
            this._showFloatingNumber?.(healed, user, true);
          }

          // (onMeleeHitBy/onHitBy heal-attacker/buildup and nextHitBuildup
          // attacker-retaliation are now handled generically, earlier, by
          // the single _processTargetHitRiders call above — see that
          // function's header comment. attacker onHit procs, e.g. Blazing
          // Fervor's fire rider, are handled earlier still, added directly
          // into dmg alongside Curse of Needles/Pressure Point Ignition.)

          // Damage number + combat-log line — emitted BEFORE the death/
          // combat-end handling below. This used to run AFTER that block,
          // so a killing blow (which can set this.combatEnded and hit the
          // early `return` a few lines down) skipped logging its own damage
          // entirely — the deciding hit of the fight was the one hit that
          // never showed a number. Same fix shape as the slot-effect log
          // right below, which had to move earlier for the same reason.
          this._showFloatingNumber?.(dmg, target, false, isCrit);

          const bd = getLastDamageBreakdown?.() || null;
          let critPct = null;
          const formulaParts = [];
          if (bd && bd.length) {
            const critEntry = bd.find(e => e && e.label === 'critChance' && typeof e.value === 'number');
            if (critEntry) critPct = critEntry.value;

            let baseShown = false;
            for (const e of bd) {
              if (e.label === 'base' && !baseShown) {
                formulaParts.push({ text: String(e.value), color: _formulaPartColor('base', e.label) });
                baseShown = true;
              } else if (e.label === 'crit') {
                const m = (e.mult != null) ? e.mult : (e.to && e.from ? (e.to / e.from) : 1.5);
                formulaParts.push({ text: `×${(+m).toFixed(2)}`, color: _formulaPartColor('crit', e.label) });
              } else if (e.label && e.convert != null) {
                // Redistribution between typed buckets, not new damage — shown
                // in parens so it doesn't read as an addition to the total
                // (e.g. "(3 phys→ele)", not "+3 phys→ele").
                formulaParts.push({ text: `(${e.convert} ${e.label})`, color: _formulaPartColor('convert', e.label) });
              } else if (e.label && e.flat) {
                formulaParts.push({ text: `+${e.flat} ${e.label}`, color: _formulaPartColor('flat', e.label) });
              } else if (e.label && e.mult && e.from != null && e.to != null) {
                formulaParts.push({ text: `×${(e.mult).toFixed(2)} ${e.label}`, color: _formulaPartColor('mult', e.label) });
              }

            }


          }


          const typeText = isMagic ? ' magic' : '';
          const damageTooltip = this._buildDamageTooltipData({
            user,
            target,
            ability,
            amount: dmg,
            raw,
            blocked,
            dr: ignoreDR ? 0 : dr,
            critPct,
            isCrit,
            hitChance: hitChanceShown,
            formulaParts,
            mpCost,
            mpInfo,
            isMagic,
            isSplash: options?.isSplash,
            typeBreakdown
          });

          const damageSegments = [
            { text: user.name, color: this._getLogColorForUnit(user), bold: true },
            { text: ' hits ', color: LOG_COLORS.default },
            { text: target.name, color: this._getLogColorForUnit(target), bold: true },
            { text: ' for ', color: LOG_COLORS.default },
            {
              text: `${dmg}${typeText} damage`,
              color: LOG_COLORS.damage,
              bold: true,
              type: 'damage',
              tooltipData: damageTooltip
            }
          ];
          if (isCrit) {
            damageSegments.push({ text: ' (CRIT!)', color: LOG_COLORS.crit, bold: true });
          }
          if (options?.isSplash) {
            damageSegments.push({ text: ' (splash)', color: LOG_COLORS.keyword });
          }

          damageSegments.push({ text: '.', color: LOG_COLORS.default });
          this._log({ segments: damageSegments });

          // Local-tab hook — an encounter's script can react to its own
          // units landing a crit (e.g. Cade reacting to a beast's crit).
          // No-op unless this scenario's LocalChatScripts.js entry defines
          // onCrit.
          if (isCrit) {
            this._postLocalChatLines(this.localChatScript?.onCrit?.(this._buildLocalChatCtx({ user, target, ability })));
          }

          if (target.currentHP <= 0 && target.status !== 'incapacitated') {
            target.status = 'incapacitated';

            // Capture slot key BEFORE _onUnitKnockedOut clears target._slot,
            // then apply any tile/slot effect right now so it fires even on a killing blow
            // (avoids the combatEnded early-return skipping it below).
            const _deathSlotKey = this._charSlotKey(target);
            if (result?.slotEffect && _deathSlotKey != null) {
              this.slotEffects = this.slotEffects || {};
              this.slotEffects[_deathSlotKey] = this.slotEffects[_deathSlotKey] || [];
              this.slotEffects[_deathSlotKey].push({ ...result.slotEffect });
              this._refreshGroundSprites(_deathSlotKey);
              this._log(`${target.name}'s tile is affected by ${result.slotEffect.id} for ${result.slotEffect.turns} turns.`);
              // Null out so the normal step (5) below doesn't double-apply
              result = { ...result, slotEffect: undefined };
            }

            this._onUnitKnockedOut(target);
            if (this.combatEnded) return; // battle ended; stop here

            // onKill: effects that fire when this hit kills the target
            if (result?.onKill) {
              const ok = result.onKill;

              // disorientAll: apply N disorient buildup to every remaining living enemy
              if ((ok.disorientAll || 0) > 0) {
                const side = target.isEnemy ? this.enemySlots : this.allySlots;
                const living = (side || []).filter(s => s?.char && s.char.status !== 'incapacitated' && s.char !== target);
                living.forEach(s => {
                  this._applyWeaknessBuildup(s.char, { disorient: ok.disorientAll }, { user });
                });
                if (living.length > 0) this._log(`Sandstorm — ${ok.disorientAll} disorient sweeps the remaining enemies!`);
              }

              // initiativeGained: add to attacker's initiative gauge
              if ((ok.initiativeGained || 0) > 0) {
                user.initiative = (user.initiative || 0) + ok.initiativeGained;
                this._log(`${user?.name ?? 'The slinger'} reads the opening — +${ok.initiativeGained} initiative!`);
              }

              // resetBonusAction: restore the attacker's bonus action point
              if (ok.resetBonusAction && user?.actionsLeft) {
                user.actionsLeft.bonus = 1;
                this._log(`${user?.name ?? 'The slinger'}'s bonus action resets!`);
              }
            }
          }
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
          // Independent Lightning Jolt roll per splash victim — Jolt is purely
          // a function of the TARGET's own weakness state, so each AOE splash
          // target needs its own fresh roll instead of only ever firing for
          // the primary target (the primary hit's Jolt is added earlier in
          // this function and never touches splash payloads at all). Gated
          // on the splash entry actually carrying a typed breakdown (real
          // damage) — buildup-only splash (Hex Stitch's curse spread, etc.)
          // has no physical/elemental/necrotic fields and is left alone.
          if (ability?.typedDamage && (sp.physical != null || sp.elemental != null || sp.necrotic != null)) {
            const { joltTotal } = applyLightningJolt(sp.target);
            if (joltTotal > 0) {
              sp.elemental = (sp.elemental || 0) + joltTotal;
              sp.amount = (sp.amount || 0) + joltTotal;
            }
          }
          const spPrevTiers = Array.isArray(sp.rewardIfTierCross) ? { ...(sp.target?.weakness?.tiers || {}) } : null;
          this._applyDirectResult(user, sp.target, sp, { isSplash: true, ability });
          if (spPrevTiers) this._applySplashTierCrossRewards(user, sp.target, sp.rewardIfTierCross, ability, spPrevTiers);
        }
      }

      // ===== Penetration chain (e.g. Arcane Avalanche) =====
      // A declarative, sequential "overkill cascade" — see
      // _resolvePenetrationChain's header comment for the full shape. Reads
      // a custom _penetrationBreakdown field (NOT result.physical/etc,
      // which this skill's apply() deliberately leaves at 0 so the normal
      // primary-hit HP subtraction above is a no-op — every real hit in
      // this mechanic is dealt by the chain resolver itself).
      if (!missed && ability?.penetrationChain && result?._penetrationBreakdown) {
        this._resolvePenetrationChain(user, target, ability, result._penetrationBreakdown);
      }
    }

    // ===== Post-apply logic (works for both movement and normal skills) =====

    // Recompute / snapshot tiers AFTER buildup
    this._recomputeWeaknessTiers?.(target);
    const currTiers = { ...(target?.weakness?.tiers || {}) };
    const crossed = (fam, tier) => (prevTiers[fam] || 0) < tier && (currTiers[fam] || 0) >= tier;

    // (1) Reward on tier-cross — grouped by family, only the HIGHEST tier
    // actually crossed is applied. A hit that skips two tiers at once (e.g.
    // buildup amplified by devBuildup/gear%) would otherwise match every rule
    // for that family and apply/log each one — mechanically harmless since
    // same-id status effects coalesce, but it logs the same reward twice.
    if (Array.isArray(result?.rewardIfTierCross)) {
      const bestPerFamily = new Map();
      for (const rule of result.rewardIfTierCross) {
        const families = rule.family === 'any' ? ['fire', 'cold', 'lightning'] : [rule.family];
        for (const fam of families) {
          if (!crossed(fam, rule.tier)) continue;
          const best = bestPerFamily.get(fam);
          if (!best || rule.tier > best.tier) bestPerFamily.set(fam, rule);
        }
      }
      // Optional extra gate on JUST the debuff half of a rule — e.g. "crossing
      // Disorient always grants Rhythm, but ALSO drains Initiative only if the
      // target already has Cold T1+" — checked against the target's current
      // tiers, a second independent weakness check, not itself a tier-cross.
      // Scoped to debuff.alsoRequires (not the whole rule) so an unconditional
      // buff on the same rule still fires even when the gate fails.
      const passesAlsoRequires = (gate) => !gate || ((target?.weakness?.tiers?.[gate.family] || 0) >= (gate.tierAtLeast ?? 1));
      for (const [fam, rule] of bestPerFamily) {
        if (rule.healHPpct) {
          const gain = Math.max(1, Math.floor((attacker.maxHP || 1) * rule.healHPpct));
          attacker.currentHP = Math.min(attacker.maxHP || gain, (attacker.currentHP || 0) + gain);
          this._log(`${attacker.name} recovers ${gain} HP (tier ${rule.tier} ${fam}).`);
        }
        if (rule.healMP) {
          attacker.currentMP = Math.max(0, (attacker.currentMP || 0) + rule.healMP);
          this._log(`${attacker.name} recovers ${rule.healMP} MP (tier ${rule.tier} ${fam}).`);
        }
        if (rule.stealInitiative) {
          // Genuine theft, not a flat grant — capped by both the cap itself
          // AND whatever the target actually has available. Draining 0 from
          // an empty gauge is a no-op, not a free grant to the attacker.
          const avail = target?.initiativeGauge || 0;
          const stolen = Math.min(rule.stealInitiative, avail);
          if (stolen > 0) {
            target.initiativeGauge = Math.max(0, avail - stolen);
            const cap = attacker.initiativeGaugeMax ?? 100;
            attacker.initiativeGauge = Math.min(cap, (attacker.initiativeGauge || 0) + stolen);
            this._log(`${attacker.name} steals ${stolen} Initiative from ${target.name} (tier ${rule.tier} ${fam}).`);
          }
        }
        if (rule.buff) {
          this._applyRewardBuff(attacker, rule.buff, ability, { family: fam, tier: rule.tier });
        }
        if (rule.debuff && passesAlsoRequires(rule.debuff.alsoRequires)) {
          this._applyRewardDebuff(target, rule.debuff, ability, { family: fam, tier: rule.tier, attacker });
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
      let lodgeConsumed = false;
      for (const fam of result.consumeWeakness) {
        // Clear traditional weakness meter if present
        if (target.weakness?.meters?.[fam] != null) {
          target.weakness.meters[fam] = 0;
          target.weakness.tiers[fam] = 0;
          this._log(`${target.name}'s ${fam} weakness is consumed!`);
        }
        // Always strip stackable status entries for this family (covers lodged which has no meter)
        if (Array.isArray(target.statusEffects)) {
          const before = target.statusEffects.length;
          target.statusEffects = target.statusEffects.filter(e => e.id !== fam);
          if (target.statusEffects.length < before) {
            this._log(`${target.name}'s ${fam} stacks are cleared!`);
            if (fam === 'lodged') lodgeConsumed = true;
          }
        }
      }
      if (lodgeConsumed) this._refreshLodgeSprites(target);
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
      this._log(`${attacker.name} grants ${result.teamBuff.effect.id} to their rank.`);
    }

    // (5) Slot effects on the target's tile
    if (result?.slotEffect) {
      const sid = this._charSlotKey(target);
      if (sid != null) {
        this.slotEffects = this.slotEffects || {};
        this.slotEffects[sid] = this.slotEffects[sid] || [];
        this.slotEffects[sid].push({ ...result.slotEffect });
        this._refreshGroundSprites(sid);
        this._log(`${target.name}'s tile is affected by ${result.slotEffect.id} for ${result.slotEffect.turns} turns.`);
      }
    }

    // (6) Zone-triggered on-hit rewards (attacker benefits from standing zones under the target)
    if (!missed) {
      const targetSid = this._charSlotKey(target);
      const activeZones = targetSid ? (this.slotEffects?.[targetSid] || []) : [];
      for (const ze of activeZones) {
        if (ze.onHitMpGain > 0 && !user.isEnemy) {
          // Only player-controlled attackers benefit from sanctified zones
          const gain = ze.onHitMpGain;
          user.currentMP = Math.min(user.maxMP || 99, (user.currentMP || 0) + gain);
          this._log(`${user.name} gains ${gain} MP from the sanctified zone.`);
        }
      }
    }

    // (7) Direct MP gain returned by skill (e.g. tremor_echo quake-zone bonus)
    if (!missed && (result?.mpGain || 0) > 0) {
      const gain = result.mpGain;
      user.currentMP = Math.min(user.maxMP || 99, (user.currentMP || 0) + gain);
      this._log(`${user.name} recovers ${gain} MP (${ability?.name ?? 'skill'}).`);
    }

    // (8) Initiative bonus from crit (e.g. silent_order)
    if (!missed && (result?.initiativeGained || 0) > 0) {
      const initGain = result.initiativeGained;
      user.initiative = (user.initiative || 0) + initGain;
      this._log(`${user?.name ?? 'Attacker'} gains ${initGain} initiative!`);
    }

    // (9) Poison tick bursts (e.g. venom_bloom)
    if (!missed && result?.poisonTicks?.count > 0) {
      const { count, damageEach } = result.poisonTicks;
      for (let i = 0; i < count; i++) {
        this.time.delayedCall(400 * (i + 1), () => {
          if (this.combatEnded || !target || target.status === 'incapacitated') return;
          target.currentHP = Math.max(0, (target.currentHP || 0) - damageEach);
          this._showFloatingNumber?.(damageEach, target, false);
          this._log(`Venom Bloom tick ${i + 1}: ${target?.name ?? 'target'} takes ${damageEach} poison damage.`);
          this._refreshUI?.();
        });
      }
    }

    // ---- Costs & cooldowns ----
    const payNow = !(result?.armReaction && result?.consumeOn === 'trigger');
    if (payNow && mpCost > 0) {
      const gearInfo = mpInfo?.gear;
      if (gearInfo && gearInfo.after !== ability.mpCost) {
        this._log(`${user.name}'s gear reduces MP cost: ${ability.mpCost} → ${gearInfo.after}.`);
      }
      const penaltyInfo = mpInfo?.penalty;
      if (penaltyInfo && penaltyInfo.after !== (gearInfo?.after ?? ability.mpCost)) {
        const multText = penaltyInfo.mult ? ` (×${penaltyInfo.mult.toFixed(2)})` : '';
        this._log(`${user.name} is Dazed: MP cost ${penaltyInfo.before} → ${penaltyInfo.after}${multText}`);
      }

      user.currentMP = Math.max(0, user.currentMP - mpCost);
    }



    // Cooldown-start and action-pool consumption are both skipped for a
    // recast (options.isRepeat) — it's a free proc off the ORIGINAL cast,
    // which already started the cooldown and spent the action point once;
    // re-doing either here would double-charge a cast the player only
    // actually took once.
    const delayCD = result?.armReaction && result?.consumeOn === 'trigger';
    if (!options?.isRepeat && !delayCD && Number.isFinite(ability.cooldown) && ability.cooldown > 0) {
      if (!user.cooldowns) user.cooldowns = {};
      user.cooldowns[ability.id] = Math.max(0, ability.cooldown || 0);
    }

    // Spend action pool for any non-reaction skill ("free" costs nothing)
    if (!options?.isRepeat && ability.actionCost && ability.actionCost !== 'free') {
      const isCounter = intent?.isReaction === true;
      if (!isCounter) {
        const pool = user.actionsLeft || (user.actionsLeft = {});
        if (Array.isArray(ability.actionCost)) {
          // Array means the skill costs multiple action types (e.g. ["major","bonus"])
          for (const t of ability.actionCost) {
            pool[t] = Math.max(0, (pool[t] || 0) - 1);
          }
        } else {
          const cur = Number.isFinite(pool[ability.actionCost]) ? pool[ability.actionCost] : 0;
          pool[ability.actionCost] = Math.max(0, cur - 1);
        }
      }
    }

    // ---- Volley reaction: allies with volley_armed echo this ranged skill ----
    // Scalable: any skill with the 'ranged' tag triggers this. The volley copy fires
    // _applyDirectResult directly (bypasses gates/costs/cooldowns) at reduced effectiveness.
    if (!missed && !options?.isVolleyCopy && (ability.tags || []).includes('ranged')) {
      const mySlots = user.isEnemy ? this.enemySlots : this.allySlots;
      for (const slot of (mySlots || [])) {
        const ally = slot?.char;
        if (!ally || ally === user || ally.status === 'incapacitated') continue;
        const vIdx = (ally.statusEffects || []).findIndex(se => se?.id === 'volley_armed' && (se.turns || 0) > 0);
        if (vIdx === -1) continue;
        const vollCfg = ally.statusEffects[vIdx].onAllyProjectile || {};
        const copies  = vollCfg.copyCount      ?? 2;
        const eff     = vollCfg.effectiveness  ?? 0.35;
        ally.statusEffects.splice(vIdx, 1); // consume
        this._log(`${ally.name} volleys with ${user.name}'s ${ability.name}!`);
        for (let i = 0; i < copies; i++) {
          this.time.delayedCall(280 * (i + 1), () => {
            if (this.combatEnded || !target || target.status === 'incapacitated') return;
            this._applyDirectResult(ally, target, {
              amount: Math.floor((result?.amount || 0) * eff),
              buildup: result?.buildup
                ? Object.fromEntries(Object.entries(result.buildup).map(([k, v]) => [k, Math.floor(v * eff)]))
                : undefined,
              element: result?.element,
              isMagic: result?.isMagic,
            }, { ability, isVolleyCopy: true });
          });
        }
      }
    }

    // ---- Repeat mechanic: scalable for any skill returning result.repeatChance ----
    // Repeats fire _applyDirectResult directly (same damage/buildup, no costs/cooldown).
    // Pass isRepeat: true so the copy cannot itself repeat (no infinite chains).
    // Optional result.repeatScale (default 1 = full power) lets a skill declare
    // a reduced-power repeat instead of always repeating at 100% — e.g.
    // Boulder Toss's Shocked proc repeats at 50% damage.
    if (!missed && !options?.isRepeat && (result?.repeatChance || 0) > 0) {
      if (Math.random() < result.repeatChance) {
        this._log(`${user?.name ?? 'Attacker'} channels the momentum — ${ability.name} repeats!`);
        this.time.delayedCall(380, () => {
          if (this.combatEnded || !target || target.status === 'incapacitated') return;
          const repeatScale = Number.isFinite(result?.repeatScale) ? result.repeatScale : 1;
          this._applyDirectResult(user, target, this._buildRepeatPayload(result, target, repeatScale), { ability, isRepeat: true });

          // Re-fan-out splash too (e.g. Hex Stitch's same-column curse splash) —
          // without this the repeat only ever re-hit the primary target, silently
          // skipping every AoE target the original hit reached.
          if (Array.isArray(result?.splash) && result.splash.length) {
            for (const sp of result.splash) {
              if (!sp?.target || sp.target.status === 'incapacitated') continue;
              const spPrevTiers = Array.isArray(sp.rewardIfTierCross) ? { ...(sp.target?.weakness?.tiers || {}) } : null;
              this._applyDirectResult(user, sp.target, sp, { isSplash: true, ability, isRepeat: true });
              if (spPrevTiers) this._applySplashTierCrossRewards(user, sp.target, sp.rewardIfTierCross, ability, spPrevTiers);
            }
          }
        });
      }
    }

    // ---- runeChannel: 25% chance to RECAST the spell at 60% power ----
    // A genuine recast — re-invokes the whole ability via
    // _applyAbilityToTarget (not a flat scaled-damage replay like the
    // generic repeatChance mechanic uses) so it independently re-derives its
    // own damage/buildup through the skill's OWN logic, and can trigger that
    // skill's own repeatChance/rewardIfTierCross/splash exactly like a real
    // cast would — a skill opts into the power reduction itself by reading
    // opts.powerScale (see _applyAbilityToTarget's ability.apply call).
    // isRepeat:true on the recast both skips MP/cooldown/action-cost (see
    // the gates on those above, and the resource gate at the top of this
    // function) AND prevents the recast from triggering ANOTHER rune
    // channel recast — capped at one extra cast per original action, per
    // design. A plain hit-repeat (repeatChance) never re-enters this
    // function at all, so it can't trigger this block a second time either —
    // only a true recast (and the original cast) ever do.
    // noRecast (Conclave Circle/Ward Weave/Rune Channel itself) — zone-toggle
    // utility casts with no repeatable damage/buildup value; recasting them
    // would only waste the caster's own self-punishment for nothing, and for
    // Rune Channel specifically, it's what stops the ability recasting
    // ITSELF the moment its own apply() turns the mod on.
    if (!missed && !options?.isRepeat && !ability?.noRecast && (ability?.tags || []).includes('spell')) {
      const rcZone = (user?.statusEffects || []).find(se => se?.id === 'runic_zone' && (se.turns || 0) > 0 && se.mods?.runeChannel);
      if (rcZone && Math.random() < 0.25) {
        this._log(`${user?.name ?? 'Mage'}'s rune channel recasts the spell at reduced power!`);
        this.time.delayedCall(480, () => {
          if (this.combatEnded || !target || target.status === 'incapacitated') return;
          this._applyAbilityToTarget(user, target, ability, null, { isRepeat: true, powerScale: 0.60 });
        });
      }
    }

    // ---- UI refresh ----
    this._updateHealthBars?.();
    this._updateHPMPBars?.();
    this._updateActionLights?.();
    // _buildActionMenuRoot calls _exitTargetingMode internally — no need to call it again.
    if (!this._currentChar?.()?.isEnemy) this._buildActionMenuRoot?.();
  }


  // Builds a repeat/echo's own payload from the CORE hit breakdown
  // (post-gear-conversion, pre-Tier-3-rider) snapshotted as
  // result._coreBreakdown in _applyAbilityToTarget, scaled by `scale` (1.0
  // for the generic repeatChance mechanic, 0.60 for runeChannel's echo).
  // Independently re-rolls Tier-3 riders (Jolt) for THIS instance instead of
  // reusing whatever the primary hit rolled — a repeat should trigger its
  // own riders with their own fresh roll, not inherit the first hit's exact
  // number. Falls back to the old flat-amount behavior for legacy (non-
  // typed) skills, which never populate _coreBreakdown.
  _buildRepeatPayload(result, target, scale = 1) {
    const core = result?._coreBreakdown;
    if (core) {
      const physical = Math.floor(core.physical * scale);
      let elemental = Math.floor(core.elemental * scale);
      const necrotic = Math.floor(core.necrotic * scale);
      const { joltTotal } = applyLightningJolt(target);
      if (joltTotal > 0) elemental += joltTotal;
      return {
        amount: physical + elemental + necrotic,
        physical, elemental, necrotic,
        buildup: result.buildup ? { ...result.buildup } : undefined,
        element: result.element,
        isMagic: result.isMagic,
      };
    }
    return {
      amount: Math.floor((result?.amount || 0) * scale),
      buildup: result?.buildup ? { ...result.buildup } : undefined,
      element: result?.element,
      isMagic: result?.isMagic,
    };
  }

  _applyDirectResult(user, target, payload, opts = {}) {
    if (!target || !payload) return null;
    // Populated below and returned at the end — purely additive, every
    // existing caller ignores the return value already. Lets a caller (e.g.
    // _resolvePenetrationChain) know exactly how much this specific hit was
    // mitigated down to and how much of it actually landed, so it can
    // compute real overkill for a follow-up cascade step.
    let resultInfo = { mitigatedAmount: 0, dealt: 0, hpBefore: target.currentHP | 0 };

    const isHeal = !!payload.isHeal;
    const isSplashOrAoe = !!(opts?.isSplash || opts?.isVolleyCopy);

    // Reaction window for splash hits — self_hit was previously only ever
    // emitted from the PRIMARY-target path (_applyAbilityToTarget), so a
    // reaction could never trigger off being hit as a secondary target of
    // someone else's AOE (e.g. Bedrock Guard reacting to Disrupting Roar's
    // splash onto an ally who wasn't the chosen primary target). intent.
    // isSplash lets a reaction's canTrigger specifically gate on "I was hit
    // by splash," distinct from a normal direct hit.
    if (!isHeal && (payload.amount | 0) > 0 && opts?.isSplash) {
      const differentTeams = (!!user?.isEnemy) !== (!!target?.isEnemy);
      const ability = opts?.ability || null;
      if (differentTeams && isReactableAttackSource(ability, null)) {
        this.bus?.emit('self_hit', {
          attacker: user,
          target,
          ability,
          intent: { isSplash: true, tags: ability?.tags },
          incomingMutable: payload,
        });
      }
    }

    // Damage / heal — read fresh; a reaction's exec above may have zeroed
    // payload.amount (e.g. Bedrock Guard negating the splash entirely).
    const rawAmt = payload.amount | 0;

    // Apply DR to all non-heal hits (splash, repeats, volley copies all respect armor/resist).
    // Uses the SAME shared resolver the primary-hit path does — if payload
    // carries a physical/elemental/necrotic breakdown (a typed-pipeline
    // skill's repeat/splash populating it), this now properly mitigates
    // each component separately instead of collapsing everything to a
    // single isMagic-gated fraction. Falls back to the original isMagic
    // behavior when no breakdown is given (legacy skills, unaffected).
    let amt = rawAmt;
    let directTypeBreakdown = null;
    if (!isHeal && amt > 0) {
      const { dmg, physDmg, elemDmg, necrDmg } = this._resolveMitigation(target, {
        physical: payload.physical, elemental: payload.elemental, necrotic: payload.necrotic,
        raw: rawAmt, ignoreDR: !!payload.ignoreDR, isMagic: !!payload.isMagic,
      });
      amt = dmg;
      if (physDmg != null) directTypeBreakdown = { physDmg, elemDmg, necrDmg };

      // Guard status effects apply on direct hits only (not splash/aoe — guards are triggered
      // reactions and shouldn't fire multiple times per action or on background aoe)
      if (!isSplashOrAoe) {
        const guardFrac = this._processGuardStatusEffects(target, user);
        if (guardFrac > 0) {
          const reduction = Math.floor(amt * guardFrac);
          amt = Math.max(0, amt - reduction);
          this._log(`${target?.name ?? 'Target'}'s guard absorbs ${reduction} damage.`);
        }
      }

      // Target-side "reacts when hit" riders (onNextDamageTaken/onHitBy/
      // nextHitBuildup) — same consolidated function the primary-hit path
      // uses (see _processTargetHitRiders's header comment). Previously
      // NONE of these three ever fired for a splash or repeat hit at all —
      // this is the actual fix for that. Snapshotting here (rather than
      // just reusing whatever's currently on the target) still correctly
      // excludes a rider THIS SAME payload might apply via its own
      // statusEffects, applied later in this function.
      const preHitRiderRefs = new Set(
        (target?.statusEffects || []).filter(se => se?.onNextDamageTaken || se?.onHitBy || se?.nextHitBuildup)
      );
      const { bonusDamage } = this._processTargetHitRiders(target, user, {
        rawDamage: rawAmt, ignoreDR: !!payload.ignoreDR, preHitRiderRefs,
      });
      amt += bonusDamage;
      resultInfo.mitigatedAmount = amt;
    }

    if (amt !== 0 || isHeal) {
      if (isHeal) {
        const before = target.currentHP | 0;
        const profHealAmt = Math.floor(rawAmt * getProficiencyMultiplier(user));
        const after = Math.min((target.maxHP | 0) || before, before + Math.max(0, profHealAmt));
        const healed = after - before;
        target.currentHP = after;
        if (healed > 0) {
          this._showFloatingNumber?.(healed, target, /*isHeal=*/true, /*isCrit=*/false);
          const healTooltip = this._buildHealTooltipData({
            user, target, ability: opts?.ability || null,
            amount: healed, raw: rawAmt,
            critPct: null, isCrit: false,
            formulaParts: [],
            mpCost: null, mpInfo: null,
            isSplash: opts?.isSplash,
          });
          const healSegments = [
            { text: user.name, color: this._getLogColorForUnit(user), bold: true },
            { text: ' heals ', color: LOG_COLORS.default },
            { text: target.name, color: this._getLogColorForUnit(target), bold: true },
            { text: ' for ', color: LOG_COLORS.default },
            {
              text: `${healed} HP`,
              color: LOG_COLORS.heal,
              bold: true,
              type: 'heal',
              tooltipData: healTooltip
            },
            { text: '.', color: LOG_COLORS.default }
          ];
          this._log({ segments: healSegments });
        }
      } else {
        const before = target.currentHP | 0;
        const after = Math.max(0, before - Math.max(0, amt));
        const dealt = before - after;
        target.currentHP = after;
        resultInfo.hpBefore = before;
        resultInfo.dealt = dealt;
        this._showFloatingNumber?.(dealt, target, /*isHeal=*/false, /*isCrit=*/false);

        const isMagic = !!payload.isMagic;
        const typeText = isMagic ? ' magic' : '';
        const tooltip = this._buildDamageTooltipData({
          user,
          target,
          ability: opts?.ability || null,
          amount: dealt,
          raw: rawAmt,
          blocked: rawAmt - dealt,
          dr: rawAmt > 0 ? Math.max(0, 1 - (dealt / rawAmt)) : 0,
          critPct: null,
          isCrit: false,
          hitChance: null,
          formulaParts: [],
          mpCost: null,
          mpInfo: null,
          isMagic,
          isSplash: opts?.isSplash,
          typeBreakdown: directTypeBreakdown
        });

        const damageSegments = [
          { text: user.name, color: this._getLogColorForUnit(user), bold: true },
          { text: ' hits ', color: LOG_COLORS.default },
          { text: target.name, color: this._getLogColorForUnit(target), bold: true },
          { text: ' for ', color: LOG_COLORS.default },
          {
            text: `${dealt}${typeText} damage`,
            color: LOG_COLORS.damage,
            bold: true,
            type: 'damage',
            tooltipData: tooltip
          }
        ];
        if (opts.isSplash) {
          damageSegments.push({ text: ' (splash)', color: LOG_COLORS.keyword });
        }
        damageSegments.push({ text: '.', color: LOG_COLORS.default });
        this._log({ segments: damageSegments });


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

    return resultInfo;
  }

  /**
   * _resolvePenetrationChain(user, target, ability, coreBreakdown)
   *
   * Generic, declarative "sequential overkill cascade" resolver. A skill
   * declares `ability.penetrationChain = { lines: [...] }` (see Arcane
   * Avalanche for the reference case); this function fires each line IN
   * ARRAY ORDER, fully resolving one (including all of its own recursive
   * overflow) before the next line starts — a slot hit by more than one
   * line needs its HP tracked cumulatively across them, not independently.
   *
   * Each line: { entry: slotId, splitTo: [slotA, slotB], overflow?: { from: slotId|[slotId,slotId], to: slotId } }
   *   1. Deal the full `coreBreakdown` amount to whoever's in `entry` (if anyone).
   *   2. Determine how much of that PROPAGATES onward: the WHOLE amount if
   *      the entry slot was empty or its occupant is at Fire/Cold/Lightning
   *      T2+ (their weakness "conducts" everything through them, not just
   *      overkill) — otherwise real overkill (the mitigated amount dealt
   *      minus their HP immediately before this hit).
   *   3. Split the propagating amount 50/50 across `splitTo`, dealing each
   *      half the exact same way (steps 1-2, one level deep).
   *   4. Whichever of `splitTo`'s slots are named in `overflow.from` have
   *      THEIR OWN propagating amounts summed together and dealt, once, to
   *      `overflow.to`.
   *
   * Every individual hit gets its own independent gear-conversion + gear%
   * and Lightning Jolt roll — same treatment every other splash/repeat
   * instance gets elsewhere in this file — since this bypasses the normal
   * result.splash fan-out loop entirely (it isn't built from a pre-computed
   * array, each step depends on the REAL, live outcome of the step before
   * it). All hits share the same physical/elemental/necrotic RATIO as
   * `coreBreakdown` — one continuous spell, not independently-typed sub-hits.
   */
  _resolvePenetrationChain(user, target, ability, coreBreakdown) {
    const sideSlots = target?.isEnemy ? this.enemySlots : this.allySlots;
    if (!Array.isArray(sideSlots)) return;
    const lines = ability?.penetrationChain?.lines;
    if (!Array.isArray(lines) || !lines.length) return;

    const totalCore = (coreBreakdown?.physical || 0) + (coreBreakdown?.elemental || 0) + (coreBreakdown?.necrotic || 0);
    if (totalCore <= 0) return;
    const ratios = {
      physical: (coreBreakdown.physical || 0) / totalCore,
      elemental: (coreBreakdown.elemental || 0) / totalCore,
      necrotic: (coreBreakdown.necrotic || 0) / totalCore,
    };

    const charInSlot = (slotId) => {
      const slot = sideSlots.find(s => s.slotId === slotId);
      return (slot?.char && slot.char.status !== 'incapacitated') ? slot.char : null;
    };
    const isElementalT2 = (char) => ['fire', 'cold', 'lightning'].some(f => (char?.weakness?.tiers?.[f] || 0) >= 2);
    const breakdownFor = (amount) => {
      const physical = Math.floor(amount * ratios.physical);
      const elemental = Math.floor(amount * ratios.elemental);
      const necrotic = Math.max(0, amount - physical - elemental); // exact sum, no rounding loss
      return { physical, elemental, necrotic };
    };

    // Deals `amount` to whoever's in `slotId` (if anyone) and returns how
    // much of it should propagate onward.
    const dealAndGetPropagation = (slotId, amount) => {
      if (amount <= 0 || slotId == null) return 0;
      const occupant = charInSlot(slotId);
      if (!occupant) return amount; // nobody home — the whole hit passes through untouched

      const conducts = isElementalT2(occupant);
      let bd = breakdownFor(amount);
      // Independent gear-conversion + gear% per hit — silent:true so this
      // doesn't pollute the primary's own breakdown log (see the earlier
      // Sacred Shockwave splash-duplication fix this same session).
      bd = applyGearConversionAndPercent(bd, user, { silent: true });
      // Independent Lightning Jolt roll per hit.
      const { joltTotal } = applyLightningJolt(occupant);
      if (joltTotal > 0) bd.elemental += joltTotal;
      const finalAmount = bd.physical + bd.elemental + bd.necrotic;

      const info = this._applyDirectResult(user, occupant, {
        amount: finalAmount, physical: bd.physical, elemental: bd.elemental, necrotic: bd.necrotic,
        isMagic: !!ability?.isMagic, tags: ability?.tags,
      }, { isSplash: true, ability });

      const mitigated = info?.mitigatedAmount ?? finalAmount;
      const hpBefore = info?.hpBefore ?? 0;
      return conducts ? mitigated : Math.max(0, mitigated - hpBefore);
    };

    for (const line of lines) {
      const entryPropagation = dealAndGetPropagation(line.entry, totalCore);
      if (entryPropagation <= 0 || !Array.isArray(line.splitTo) || line.splitTo.length !== 2) continue;

      const [slotA, slotB] = line.splitTo;
      const halfA = Math.floor(entryPropagation / 2);
      const halfB = entryPropagation - halfA; // exact sum, no rounding loss
      const propA = dealAndGetPropagation(slotA, halfA);
      const propB = dealAndGetPropagation(slotB, halfB);

      if (line.overflow) {
        const fromList = Array.isArray(line.overflow.from) ? line.overflow.from : [line.overflow.from];
        let overflowTotal = 0;
        if (fromList.includes(slotA)) overflowTotal += propA;
        if (fromList.includes(slotB)) overflowTotal += propB;
        if (overflowTotal > 0) dealAndGetPropagation(line.overflow.to, overflowTotal);
      }
    }
  }

  // One-shot payloads that resolve at the END of a character's own next turn
  // (after they've had a chance to act — cleanse, reposition, etc.), rather
  // than at start-of-turn like every other tick in this file. Currently only
  // Glacial Strike's Trapped Fire uses this (`se.onTurnEndOnce`); consumed and
  // removed the first time it fires, regardless of the status's own turns left.
  _applyEndOfTurnProcs(char) {
    if (!Array.isArray(char?.statusEffects)) return;
    for (let i = char.statusEffects.length - 1; i >= 0; i--) {
      const se = char.statusEffects[i];
      const proc = se?.onTurnEndOnce;
      if (!proc) continue;
      if (proc.damage > 0 && char.status !== 'incapacitated') {
        const dr = proc.isMagic ? getDamageReductionFraction(char, { isMagic: true }) : 0;
        const dealt = dr ? Math.max(0, Math.floor(proc.damage * (1 - dr))) : proc.damage;
        const before = char.currentHP | 0;
        const after = Math.max(0, before - dealt);
        char.currentHP = after;
        this._showFloatingNumber?.(dealt, char, false, false);
        this._log(`${char.name} is scorched by trapped fire for ${dealt} damage.`);
        this._updateHealthBars?.(); this._updateHPMPBars?.();
        if (after === 0 && char.status !== 'incapacitated') {
          char.status = 'incapacitated';
          this._onUnitKnockedOut?.(char);
        }
      }
      char.statusEffects.splice(i, 1);
    }
  }

  _startTurnStatusEffects(char) {
    // Apply per-turn effects (DOT, HOT, blocksAction) without touching duration.
    // Duration countdown and expiry is handled exclusively by _tickDownStatusDurations
    // (called at end of the previous actor's turn). Keeping these roles separate
    // prevents double-decrement on stackable and long-duration effects.
    const list = Array.isArray(char.statusEffects) ? char.statusEffects : [];
    if (list.length === 0) return { died: false, skip: false };

    let died = false;
    let skip = false;

    for (const se of list) {
      const name = (StatusEffects?.[se.id]?.name) || se.id;

      // DOT
      const tickDmg = se.tickDamage | 0;
      if (!died && tickDmg > 0) {
        const before = char.currentHP | 0;
        const after = Math.max(0, before - tickDmg);
        char.currentHP = after;
        this._showFloatingNumber?.(tickDmg, char, /*isHeal=*/false, /*isCrit=*/false);
        this._log(`${char.name} suffers ${tickDmg} damage from ${name}.`);
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
          this._log(`${char.name} regenerates ${healed} HP.`);
          this._updateHealthBars?.(); this._updateHPMPBars?.();
        }
      }

      // turn skip (e.g., stunned)
      if (se.blocksAction) skip = true;

      // Lodge tick buildup — applies per-turn buildup fields to the lodged character
      if (se?.id === 'lodged' && se.tickBuildup && !died) {
        this._applyWeaknessBuildup(char, se.tickBuildup, { user: char });
      }

      // runic zone per-turn effects
      if (se.id === 'runic_zone' && (se.turns || 0) > 0) {
        const maxMP = char.maxMP ?? char.derivedStats?.maxMP ?? 0;

        if (se.mods?.wardWeave) {
          // wardWeave: drain 3 initiative gauge instead of restoring MP
          char.initiativeGauge = Math.max(0, (char.initiativeGauge || 0) - 3);
          this._log(`${char.name}'s ward weave sustains — 3 initiative drained.`);
        } else if ((se.mpPerTurn || 0) > 0 && maxMP > 0) {
          const mpGain = se.mpPerTurn;
          char.currentMP = Math.min(maxMP, (char.currentMP || 0) + mpGain);
          this._log(`${char.name}'s runic zone restores ${mpGain} MP.`);
        }

        if (se.mods?.kindlingRite) {
          const kindStacks = se.mods.kindlingRiteStacks || 1;
          const fireAmt = 80 * kindStacks;
          this._applyWeaknessBuildup(char, { fire: fireAmt }, { user: char });
          this._log(`${char.name}'s kindling rite pulses — ${fireAmt} fire buildup (${kindStacks}/3 stacks).`);
        }

        // Rune Channel's lightning buildup moved to a PER-CAST trigger
        // instead of a per-turn passive tick (see the runeChannel block in
        // _applyAbilityToTarget) — per the user's explicit call, the per-turn
        // tick is gone entirely; buildup now only happens when the caster
        // actually casts/recasts a spell.
      }
    }

    return { died, skip };
  }

  /**
   * _processGuardStatusEffects(target, attacker)
   *
   * Called BEFORE damage is applied to `target`. Scans target's statusEffects for
   * entries with a `guardPct` field and:
   *   – Checks any conditions (e.g. guardDiseaseCond: attacker must have disease weakness).
   *   – Fires `retaliateBuildup` on the attacker when guard triggers.
   *   – Decrements `guardHitsLeft`; removes the effect when exhausted.
   *
   * Returns a guard fraction (0–0.95) to reduce the incoming hit by.
   * Only call this on a non-missed, damage-dealing hit.
   */
  _processGuardStatusEffects(target, attacker) {
    const list = Array.isArray(target?.statusEffects) ? target.statusEffects : [];
    let totalGuard = 0;
    const toRemove = [];

    for (let i = 0; i < list.length; i++) {
      const se = list[i];

      // Tiered disease-conditional guard (e.g. Iron Chant: 25% vs a Diseased
      // attacker, 50% vs a Plagued one) — keyed by the ATTACKER's own Disease
      // tier, so the % itself scales with tier instead of being a flat gate.
      let guardPctThisEffect;
      if (se.guardDiseaseTierPct) {
        const attackerDiseaseTier = attacker?.weakness?.tiers?.disease || 0;
        guardPctThisEffect = se.guardDiseaseTierPct[attackerDiseaseTier] || 0;
        if (guardPctThisEffect <= 0) continue;
      } else {
        if (!Number.isFinite(se.guardPct) || se.guardPct <= 0) continue;
        guardPctThisEffect = se.guardPct;
      }

      totalGuard += guardPctThisEffect / 100;

      // Retaliate: apply buildup to the attacker when this guard fires
      if (se.retaliateBuildup && attacker?.weakness) {
        this._applyWeaknessBuildup(attacker, se.retaliateBuildup, { user: target });
        this._log(`${target?.name ?? 'Ally'}'s guard retaliates: ${JSON.stringify(se.retaliateBuildup)} buildup on ${attacker?.name}.`);
      }

      // Consume guardHits counter; schedule removal when exhausted
      if (Number.isFinite(se.guardHits)) {
        if (!Number.isFinite(se.guardHitsLeft)) se.guardHitsLeft = se.guardHits;
        se.guardHitsLeft -= 1;
        if (se.guardHitsLeft <= 0) toRemove.push(i);
      }
    }

    // Remove exhausted guard effects (reverse order keeps indices stable)
    for (let i = toRemove.length - 1; i >= 0; i--) list.splice(toRemove[i], 1);

    // wardWeave: runic zone mod grants a flat 15% damage reduction as guard
    const wardZone = list.find(se => se?.id === 'runic_zone' && (se.turns || 0) > 0 && se.mods?.wardWeave);
    if (wardZone) totalGuard += 0.15;

    return Math.min(0.95, totalGuard);
  }

  /**
   * _processTargetHitRiders(target, attacker, opts)
   *
   * Consolidates every "target has a status effect that reacts when hit"
   * mechanic into ONE function, called from BOTH the primary-hit path
   * (_applyAbilityToTarget) and the splash/repeat path (_applyDirectResult).
   * Previously each of the three shapes below only ever lived in the
   * primary path — Pressure Point Ignition, Toxic Bloom's old melee-only
   * heal aura, and Bedrock Guard's nextHitBuildup retaliation ALL silently
   * did nothing when the target was hit by AOE splash or a repeat, since
   * _applyDirectResult never checked any of them. This is the single place
   * that needs updating if a fourth shape is ever added — no per-skill
   * wiring required elsewhere.
   *
   * Shapes handled:
   *   - onNextDamageTaken: { bonusDamagePercent, buildup } — ONE-SHOT, adds
   *     a %-of-raw-damage bonus (its own ElementalResist check) to THIS
   *     hit, then is consumed. (Pressure Point Ignition)
   *   - onHitBy: { healAttacker, buildup, buildupAdjacent } — PERSISTENT
   *     (not consumed by a hit), fires on every hit while active. (Toxic
   *     Bloom's aura)
   *   - nextHitBuildup (+ optional nextHitOnly) — buildup applied TO THE
   *     ATTACKER; consumed only if nextHitOnly is set. (Bedrock Guard)
   *
   * opts.preHitRiderRefs — a Set of status-effect object references
   * snapshotted BEFORE this ability's own apply() ran — ensures a rider a
   * skill just applied to the target THIS SAME hit can't also fire off that
   * same hit (mirrors the pre-existing hadPressurePointIgnitionBefore
   * pattern, generalized). Pass null to process everything currently on
   * the target (no snapshot available/needed).
   *
   * Returns { bonusDamage } — additional damage the CALLER must fold into
   * the hit before final HP subtraction (onNextDamageTaken only).
   */
  _processTargetHitRiders(target, attacker, opts = {}) {
    const { rawDamage = 0, ignoreDR = false, preHitRiderRefs = null } = opts;
    let bonusDamage = 0;
    const list = Array.isArray(target?.statusEffects) ? target.statusEffects : [];
    const toRemove = [];

    for (let i = 0; i < list.length; i++) {
      const se = list[i];
      if (preHitRiderRefs && !preHitRiderRefs.has(se)) continue;
      // _addStatusEffects never copies a `name` onto the runtime status
      // object (only StatusEffects.js's registry has display names) — look
      // it up fresh here instead of falling back to the raw id in logs.
      const displayName = StatusEffects?.[se.id]?.name || se.id || 'effect';

      if (se.onNextDamageTaken && rawDamage > 0) {
        const ign = se.onNextDamageTaken;
        const bonusRaw = Math.floor(rawDamage * (ign.bonusDamagePercent ?? 30) / 100);
        const elemDR = ignoreDR ? 0 : Phaser.Math.Clamp(
          getDamageReductionFraction(target, { damageType: 'elemental', applyExpose: false }),
          -0.95, 0.95
        );
        const bonus = Math.max(0, Math.floor(bonusRaw * (1 - elemDR)));
        bonusDamage += bonus;
        if ((ign.buildup?.fire ?? 0) > 0) this._applyWeaknessBuildup(target, { fire: ign.buildup.fire }, { user: attacker });
        this._log(`${displayName} ignites — +${bonus} fire damage!`);
        toRemove.push(i);
      }

      if (se.onHitBy && rawDamage > 0) {
        const r = se.onHitBy;
        if (r.healAttacker > 0 && attacker?.currentHP != null && attacker?.maxHP != null) {
          attacker.currentHP = Math.min(attacker.maxHP, attacker.currentHP + r.healAttacker);
          this._showFloatingNumber?.(r.healAttacker, attacker, true);
          this._log(`${attacker?.name ?? 'Attacker'} is healed for ${r.healAttacker} HP by ${target?.name ?? 'target'}'s ${displayName}.`);
        }
        if (r.buildup) this._applyWeaknessBuildup(target, r.buildup, { user: attacker });
        if (r.buildupAdjacent) {
          const adjacent = resolveAOESplash(this, target, { shape: 'adjacent' });
          for (const adj of adjacent) this._applyWeaknessBuildup(adj, r.buildupAdjacent, { user: attacker });
        }
      }

      if (se.nextHitBuildup) {
        if (attacker?.weakness) {
          this._applyWeaknessBuildup(attacker, se.nextHitBuildup, { user: target });
          this._log(`${target?.name ?? 'Target'}'s ${displayName} retaliates with buildup on ${attacker?.name}.`);
        }
        if (se.nextHitOnly) toRemove.push(i);
      }
    }

    for (let i = toRemove.length - 1; i >= 0; i--) list.splice(toRemove[i], 1);
    return { bonusDamage };
  }

  // _processOnHitProcs was removed — its logic (attacker-side onHit.fireDamage
  // / onHit.fireBuildup procs, e.g. Blazing Fervor) now runs earlier, folded
  // into the same additive-rider step Curse of Needles/Pressure Point
  // Ignition use, adding straight into `dmg` instead of firing as its own
  // separate HP subtraction. See that block in _applyAbilityToTarget.

  _applyGearStartOfTurn(char) {
    // NOTE: does NOT factor in Disorient — that's a separate, real mechanic
    // (Concussed/T2 drains a FLAT amount of MP directly, see the Disorient
    // block in _startTurnWeakness) rather than a reduction to this regen
    // rate. An earlier version of this function incorrectly invented a
    // percentage-based regen reduction reusing Cost Mult's scaling; removed.
    const regen = Math.max(0, Math.floor(char?.gearEffects?.mpPerTurn || 0));
    if (!regen) return;

    const before = char.currentMP | 0;
    const max = char.maxMP | 0;
    if (max <= 0 || before >= max) return;

    const after = Math.min(max, before + regen);
    if (after > before) {
      char.currentMP = after;
      this._log(`${char.name} regenerates ${after - before} MP from gear.`);
      this._updateHPMPBars?.();
    }
  }

  _applyMagicDot(char, amount, element, label) {
    let dmg = Math.max(0, amount | 0);
    // If you want magic-side mods (Curse/elemental res) to affect DOT, route through modifiers:
    try {
      if (typeof applyDamageModifiers === 'function') {
        dmg = applyDamageModifiers(dmg, /*attacker*/ null, char, { isMagic: true, element });
      }
    } catch { }
    if (dmg > 0) {
      const dr = getDamageReductionFraction(char, { isMagic: true });
      if (dr) {
        dmg = Math.max(0, Math.floor(dmg * (1 - dr)));
      }
    }
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
      // devBuildup: 5× amplifier for player skills only
      if (DevFlags.isBuildupEnabled() && ctx?.user && !ctx.user.isEnemy) amt *= 5;

      const w = target.weakness;

      if (ctx?.user?.gearEffects) {
        const category = WeaknessBuildupCategory[key];
        const weaponBonus = ctx.user.gearEffects.weaponBuildupPercent?.[key] || 0;
        const armorBonus = category ? (ctx.user.gearEffects[`${category}BuildupPercent`] || 0) : 0;
        const bonus = weaponBonus + armorBonus;
        if (bonus) {
          const before = amt;
          amt = Math.max(0, Math.floor(amt * (1 + bonus / 100)));
          if (amt !== before) {
            const userName = ctx?.user?.name || 'Weapon';
            this._log(`${userName}'s gear empowers ${key} buildup: ${before} → ${amt} (+${bonus}%).`);
          }
        }
      }

      // Hunter's Mark: +BuildupReceived% to all incoming buildup
      {
        const mark = (target?.statusEffects || []).find(se => se?.id === 'hunters_mark' && (se.turns || 0) > 0);
        const bonusPct = mark?.mods?.BuildupReceived || 0;
        if (bonusPct > 0) amt = Math.floor(amt * (1 + bonusPct / 100));
      }

      // Generic per-family incoming-buildup vulnerability, e.g.
      // `{ fireBuildupMul: 1.4 }` on a status effect (Glacial Strike's
      // Trapped Fire, Gust Lash's Wind Exposed). Multiple active sources stack.
      {
        const mulKey = `${key}BuildupMul`;
        let vulnMul = 1;
        for (const se of (target?.statusEffects || [])) {
          const m = se?.[mulKey];
          if ((se?.turns || 0) > 0 && typeof m === 'number') vulnMul *= m;
        }
        if (vulnMul !== 1) amt = Math.max(0, Math.floor(amt * vulnMul));
      }

      // FIRE T1+: incoming fire buildup increased while Singed, scaling with
      // Fire's own intensity curve (capped) instead of a flat bonus.
      if (key === 'fire' && (w.tiers?.fire | 0) >= 1) {
        const base = WeaknessV3?.families?.fire?.t1?.incomingFireBonus ?? 0;
        const cap = WeaknessV3?.families?.fire?.t1?.incomingFireBonusCap ?? base;
        const mFire = w.meters?.fire | 0;
        const Ifire = familyIntensityMult?.('fire', mFire) ?? 1;
        const inc = Math.min(cap, base * (Ifire > 0 ? Ifire : 1));
        const beforeAmt = amt;
        amt = Math.floor(amt * (1 + inc));
        if (beforeAmt !== amt) {
          this._log(`${target.name} takes extra fire buildup (Singed, +${Math.round(inc * 100)}%): ${beforeAmt} → ${amt}`);
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
          this._log(`${target.name} is Raw: physical buildup ${beforeAmt} → ${amt} (I_expose=${Iexp.toFixed(2)})`);
        }
      }

      // NOTE: Curse T2 (Afflicted) used to also amplify incoming CURSE buildup
      // from any curse-tagged ability — same "any curse-tagged skill benefits"
      // pattern removed from the damage pipeline in CombatLogic.js. Removed for
      // now to keep the system consistent and barebones while curse gets
      // rethought; curseAmpMult's only live consumer is the onHit.curseScaled
      // rider hook above.

      // Apply — permanent gear/stat Resilience plus any temporary status-
      // effect Resilience (e.g. Curse Suppression's ward), both flat
      // reductions to this same incoming buildup.
      const baseResilience = target?.gearEffects?.resilience ?? target?.resilience ?? 0;
      const statusResilience = _sumStatusEffectMods(target)?.Resilience || 0;
      const resilience = baseResilience + statusResilience;
      if (resilience > 0) {
        const before = amt;
        amt = Math.max(0, amt - resilience);
        if (amt !== before) {
          this._log(`${target.name}'s resilience reduces ${key} buildup: ${before} → ${amt}.`);
        }
      }

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
        this._log(`${target.name} ${fam} ${before.m}→${afterM}  T${before.t}→T${afterT} (I=${I})`);
      }
    }
  }





  _onWeaknessTierChanged(target, family, newTier, oldTier, ctx) {
    if (newTier > oldTier) {
      const label = (WeaknessTierNames[family]?.[newTier - 1]) || `T${newTier} ${family}`;
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

      // 3) CURSE: reduce decay amount (T1/T2), scaling with intensity (was flat)
      if (fam === 'curse') {
        const t = u.weakness.tiers.curse | 0;
        if (t >= 1) {
          const tierConf = WeaknessV3?.families?.curse?.[t === 2 ? 't2' : 't1'];
          const base = tierConf?.decayReduction || 0;
          const cap = tierConf?.decayReductionCap ?? base;
          const I = weaknessIntensityMult(m);
          const red = Math.min(cap, base * (I > 0 ? I : 1));
          decay = Math.max(1, Math.floor(decay * (1 - red)));
        }
      }

      // 4) TOXIC T1+: chance to bypass ALL Toxic decay for THIS tick, scaling
      // with overflow intensity (capped) — a heavier overflow is MORE likely
      // to dodge decay, not a flat chance regardless of how far past T2 it is.
      if (fam === 'toxic' && ((u.weakness.tiers.toxic | 0) >= 1)) {
        const baseChance = WeaknessV3?.families?.toxic?.t1?.decayBypassChance ?? 0;
        const cap = WeaknessV3?.families?.toxic?.t1?.decayBypassChanceCap ?? 1;
        const I = weaknessIntensityMult(m);
        const chance = Math.min(cap, baseChance * (I > 0 ? I : 1));
        if (Math.random() < chance) {
          this._log(`${u.name} Toxic: decay bypassed (${Math.round(chance * 100)}% chance, I=${I.toFixed(2)}).`);
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



  // Shared by _applySlotEffectsTick (to actually apply it) and the ground
  // sprite's hover tooltip (to preview it) — a zone with a fireBurnProc
  // field (e.g. Plague Slam) only does anything to a char who's currently
  // Ablaze (Fire T2): perHundredDisease% of their CURRENT Disease meter,
  // scaled by their current Fire intensity (the same familyIntensityMult
  // curve used everywhere else). This is entirely separate from Ablaze's
  // own standalone end-of-turn weakness DOT — that mechanic is untouched;
  // this is purely the zone's own bonus proc. Read live rather than
  // snapshotted at cast time. Returns null if the proc doesn't apply right
  // now (no char, not Ablaze, or a zero result).
  _zoneFireBurnPreview(eff, char) {
    const proc = eff?.fireBurnProc;
    if (!proc || !char) return null;
    const fireTier = char?.weakness?.tiers?.fire | 0;
    if (fireTier < 2) return null;
    const diseaseMeter = char?.weakness?.meters?.disease | 0;
    const fireMeter = char?.weakness?.meters?.fire | 0;
    const fireI = familyIntensityMult('fire', fireMeter);
    const raw = (proc.perHundredDisease || 0) * (diseaseMeter / 100) * fireI;
    if (raw <= 0) return null;
    const dr = getDamageReductionFraction(char, { isMagic: true, damageType: 'elemental' });
    const dmg = Math.max(1, Math.floor(raw * (1 - (dr || 0))));
    return { dmg, diseaseMeter, fireMeter };
  }

  // opts.skipTurnDecrement: apply every effect's damage/buildup/vuln exactly
  // as normal, but don't tick eff.turns down or remove expired zones — for
  // skills that trigger a zone's effect as a bonus (e.g. Tremor Echo) without
  // "spending" any of its remaining duration.
  _applySlotEffectsTick(char, opts = {}) {
    const slotKey = this._charSlotKey(char);
    const effects = slotKey ? this.slotEffects?.[slotKey] : null;
    if (!effects || effects.length === 0) return { died: false };

    const stillActive = [];
    let died = false;
    for (const eff of effects) {
      // Damage-over-time from the ground (tickPctMaxHP: 0 = no damage)
      if (!died && eff.tickPctMaxHP > 0) {
        const maxHP = Math.max(1, char.maxHP || 1);
        const dot = Math.max(1, Math.floor(maxHP * eff.tickPctMaxHP));
        const dr = getDamageReductionFraction(char, { isMagic: !!eff.element });
        const tileDmg = dr ? Math.max(0, Math.floor(dot * (1 - dr))) : dot;
        char.currentHP = Math.max(0, char.currentHP - tileDmg);
        this._log(`${char.name} suffers ${tileDmg} damage from ${eff.id}.`);
        this._showFloatingNumber?.(tileDmg, char, false);
        this._updateHealthBars?.(); this._updateHPMPBars?.();
        // This tick was previously only ever called at start-of-turn, where
        // _startTurnStatusEffects/_startTurnWeakness ran afterward and caught
        // a 0-HP result themselves — so a lethal zone tick was never actually
        // marked incapacitated here. Now that this can run standalone at
        // end-of-turn (nothing downstream double-checks HP), it needs its own
        // death handling like every other damage tick in this file.
        if (char.currentHP === 0 && char.status !== 'incapacitated') {
          char.status = 'incapacitated';
          this._onUnitKnockedOut?.(char);
          died = true;
        }
      }

      // Named buildup families (e.g. disorient +50 per turn) — explicit map
      if (!died && eff.buildupFamilies && char.weakness) {
        char.weakness.meters = char.weakness.meters || {};
        let anyBuildup = false;
        for (const [fam, amt] of Object.entries(eff.buildupFamilies)) {
          if (amt > 0) { char.weakness.meters[fam] = (char.weakness.meters[fam] || 0) + amt; anyBuildup = true; }
        }
        if (anyBuildup) {
          this._recomputeWeaknessTiers(char);
          const parts = Object.entries(eff.buildupFamilies).map(([f, v]) => `${f} +${v}`).join(', ');
          this._log(`${char.name} suffers ${parts} from the quake zone.`);
        }
      } else if (!died && eff.element && eff.buildup && char.weakness) {
        // Legacy: single-element buildup via element key
        char.weakness.meters[eff.element] = (char.weakness.meters[eff.element] || 0) + eff.buildup;
        this._recomputeWeaknessTiers(char);
      }

      // Plague Slam's Disease/Fire synergy: if the occupant is Ablaze
      // (Fire T2) at the moment the zone ticks, they combust for Fire
      // damage — purely additive from CURRENT Disease + CURRENT Fire
      // buildup (see _zoneFireBurnPreview), both read live at trigger time.
      // Unlike Frozen Quake's Lightning synergy below (baked in once at
      // cast time, since that condition only ever needs checking once).
      if (!died && eff.fireBurnProc) {
        const preview = this._zoneFireBurnPreview(eff, char);
        if (preview) {
          char.currentHP = Math.max(0, char.currentHP - preview.dmg);
          this._log(`${char.name} combusts in the plague zone for ${preview.dmg} Fire damage (Disease ${preview.diseaseMeter}, Fire ${preview.fireMeter}).`);
          this._showFloatingNumber?.(preview.dmg, char, false);
          this._updateHealthBars?.(); this._updateHPMPBars?.();
          if (char.currentHP === 0 && char.status !== 'incapacitated') {
            char.status = 'incapacitated';
            this._onUnitKnockedOut?.(char);
            died = true;
          }
        }
      }

      // Elemental vulnerability while standing in the zone (e.g. Frozen
      // Quake's Lightning synergy: if the target was already Zapped when the
      // zone was cast, it also makes anyone standing in it take +20%
      // elemental damage). Refreshed every tick via _addStatusEffects'
      // same-id coalescing, so it naturally lapses within a turn of leaving.
      if (!died && eff.elementalVulnPct > 0) {
        this._addStatusEffects(char, [{
          id: 'zone_elemental_vuln', turns: 1,
          mods: { ElementalResist: -eff.elementalVulnPct },
        }]);
      }

      if (opts.skipTurnDecrement) {
        stillActive.push(eff);
        continue;
      }
      eff.turns -= 1;
      if (eff.turns > 0) stillActive.push(eff);
      else this._log(`The ${eff.id.replace(/_/g, ' ')} zone on this tile dissipates.`);
    }
    this.slotEffects[slotKey] = stillActive;
    this._refreshGroundSprites(slotKey);
    return { died };
  }

  // ---------- Slot key helpers ----------
  // Returns a unique string key for a character's slot, disambiguating ally vs enemy.
  // Ally slot 1 → "ally_1", Enemy slot 1 → "enemy_1"
  _charSlotKey(char) {
    const slot = char?._slot;
    if (slot?.uniqueKey) return slot.uniqueKey;
    // Fallback if uniqueKey not set
    const side = char?.isEnemy ? 'enemy' : 'ally';
    const id = slot?.slotId ?? char?.slotId;
    return id != null ? `${side}_${id}` : null;
  }

  // ---------- Ground effect sprites ----------
  // Tint colors per element family
  static GROUND_TINT = {
    fire:      0xff7733,
    cold:      0x77aaff,
    lightning: 0xffee44,
    toxic:     0x88dd44,
    magic:     0xcc88ff,
    curse:     0xcc66aa,
    physical:  0xaa8855,  // warm brown for earth/quake zones
    disease:   0x7fae3f,  // sickly plague green, distinct from toxic's brighter green
  };

  // Sprite key per slotEffect id (fall back to 'fx_crack' for all ground effects)
  static GROUND_SPRITE_KEY = {
    quake:      'fx_crack',
    quake_fire: 'fx_crack',
    quake_cold: 'fx_crack',
    // Add more as you create new sprites
  };

  _refreshGroundSprites(slotKey) {
    if (!this.textures?.exists('fx_crack')) return;

    // Destroy old sprites for this slot
    const old = this.groundSprites[slotKey] || [];
    old.forEach(s => s.destroy());
    this.groundSprites[slotKey] = [];

    const effects = this.slotEffects[slotKey];
    if (!effects || effects.length === 0) return;

    // Find the slot container by its unique key (not raw slotId — avoids ally/enemy collision)
    const slotContainer = this.unitSlots.find(c => c.uniqueKey === slotKey);
    if (!slotContainer) return;
    const { x: sx, y: sy } = slotContainer;

    const total = effects.length;
    effects.forEach((eff, i) => {
      const sprite = this._makeGroundSprite(sx, sy, eff, i, total, slotKey);
      if (sprite) this.groundSprites[slotKey].push(sprite);
    });
  }

  _makeGroundSprite(cx, cy, eff, stackIndex, totalStacks, slotKey) {
    const key = CombatScene.GROUND_SPRITE_KEY[eff.id] || 'fx_crack';
    if (!this.textures?.exists(key)) return null;

    // Spread stacks so they don't fully overlap
    let ox = 0, oy = 0;
    if (totalStacks > 1) {
      const baseAngle = (stackIndex / totalStacks) * Math.PI * 2;
      const jitter = (Math.random() - 0.5) * 0.4;
      const angle = baseAngle + jitter;
      const dist = 6 + Math.random() * 6;
      ox = Math.cos(angle) * dist;
      oy = Math.sin(angle) * dist;
    } else {
      ox = (Math.random() - 0.5) * 8;
      oy = (Math.random() - 0.5) * 6;
    }

    const sprite = this.add.image(cx + ox, cy + oy, key)
      .setScale(0.75)
      .setAlpha(0.85)
      .setDepth(1)    // above bg (-1), below slot containers (2)
      .setRotation(Math.random() * Math.PI * 2);

    const tint = CombatScene.GROUND_TINT[eff.element] ?? null;
    if (tint) sprite.setTint(tint);

    // Hover/click to see remaining turns and every effect stacked on this
    // tile — works even if nobody is currently standing there, since this
    // sprite exists independent of tile occupancy.
    if (slotKey != null) {
      sprite.setInteractive({ useHandCursor: true });
      const showTip = (pointer) => {
        const stack = this.slotEffects?.[slotKey] || [];
        // Current occupant (if any) — used to make conditional zone effects
        // (e.g. Plague Slam's Ablaze proc) show CURRENT/live info here,
        // unlike the skill's own tooltip which always states the full,
        // unconditional mechanic.
        const occupant = (this.turnOrder || []).find(u => u && u.status !== 'incapacitated' && this._charSlotKey?.(u) === slotKey);
        const lines = stack.length ? stack.map(e => {
          const label = (e.id || 'effect').replace(/_/g, ' ');
          const parts = [`${e.turns ?? '?'} turn${e.turns === 1 ? '' : 's'} left`];
          if (e.tickPctMaxHP > 0) parts.push(`${Math.round(e.tickPctMaxHP * 100)}% max HP damage/turn`);
          if (e.buildupFamilies) {
            const fams = Object.entries(e.buildupFamilies).map(([f, v]) => `+${v} ${f}`).join(', ');
            if (fams) parts.push(fams);
          }
          if (e.immobilizes) parts.push('immobilizes');
          if (e.onHitMpGain) parts.push(`+${e.onHitMpGain} MP to attackers hitting enemies here`);
          if (e.elementalVulnPct > 0) parts.push(`+${e.elementalVulnPct}% elemental damage taken`);
          if (e.fireBurnProc) {
            const preview = occupant ? this._zoneFireBurnPreview(e, occupant) : null;
            if (preview) parts.push(`${occupant.name} is Ablaze here — combusts for ${preview.dmg} Fire dmg this turn`);
          }
          return `${label}: ${parts.join(', ')}`;
        }) : ['No active effects'];
        this.tooltip?.show(pointer.worldX, pointer.worldY, { title: 'Ground Effect', lines });
      };
      const moveTip = (pointer) => this.tooltip?.reposition(pointer.worldX, pointer.worldY);
      const hideTip = () => this.tooltip?.hide();
      sprite.on('pointerover', showTip);
      sprite.on('pointermove', moveTip);
      sprite.on('pointerout', hideTip);
    }

    return sprite;
  }

  // ---------- Runic Zone sprite (Conclave Circle + its modifier skills) ----------
  // Deliberately separate from the generic slotEffects ground-zone system
  // above (quake-style zones): the runic zone's real lifetime and mods
  // (kindlingRite/wardWeave/runeChannel) live on the CASTER's own
  // 'runic_zone' status effect, not a tile-keyed slotEffects entry. Sharing
  // that same object into slotEffects (for the generic tick/decay system to
  // manage) would double-decrement its `turns` — once via the status-effect
  // tick, once via the slotEffects tick. So this just visualizes whatever
  // the status effect's CURRENT state is, keyed by owner, redrawn on demand
  // (cast / modified) rather than on a per-round tick.
  //
  // Base ring: blue, getting MORE INTENSE/saturated the more mods are
  // active (0 active = pale blue, all 3 = deep vivid blue) — see
  // RUNIC_ZONE_BASE_TINT_BY_COUNT. One additional overlay glyph per active
  // mod (fx_runic_zone_addition_1/2/3), each its own theme color, layered
  // on top. kindlingRite/addition_1 is confirmed working well as-is
  // (position/scale/depth) — left completely untouched. wardWeave/
  // runeChannel (addition_2/3) are unconfirmed/untested so far (no skill
  // sets those mods to true yet) — given a small radial offset so they
  // don't all spin stacked dead-center on top of each other/the base ring.
  static RUNIC_ZONE_MOD_TINT = {
    kindlingRite: { key: 'fx_runic_zone_addition_1', tint: 0xff7733 }, // fire
    wardWeave: { key: 'fx_runic_zone_addition_2', tint: 0x66ddaa }, // warding green
    runeChannel: { key: 'fx_runic_zone_addition_3', tint: 0xaa77ee }, // arcane purple
  };
  // Corner offsets for Kindling Rite's stacked overlays (up to 3) — spread to
  // opposite corners instead of all piling up dead-center once it can stack.
  static KINDLING_RITE_STACK_OFFSETS = [
    { ox: -12, oy: -12 }, // top-left
    { ox: 12, oy: 12 },   // bottom-right — opposite corner from stack 1
    { ox: 12, oy: -12 },  // top-right
  ];
  // Indexed by count of currently-active mods (0-3) — pale to deep blue.
  static RUNIC_ZONE_BASE_TINT_BY_COUNT = [0xbbddff, 0x77bbff, 0x3388ff, 0x0055dd];
  // Short label/summary per mod for the hover tooltip — mirrors each
  // modifier skill's own description text, kept in sync manually since this
  // lives in CombatScene.js rather than reading data/skills.js directly.
  // Kindling Rite's entry here is a fallback only — showTip below renders a
  // stack-count-aware line for it instead, since its numbers now scale.
  static RUNIC_ZONE_MOD_INFO = {
    kindlingRite: { label: 'Kindling Rite', desc: '+20%/stack elemental damage dealt, 80/stack Fire buildup/turn to caster (max 3 stacks)' },
    wardWeave: { label: 'Ward Weave', desc: '-15% damage taken, drains 3 Initiative/turn (replaces MP regen)' },
    runeChannel: { label: 'Rune Channel', desc: '25% chance to recast spells at 60% power, 80 Lightning buildup + 1 lightning damage on cast/recast' },
  };

  _refreshRunicZoneSprite(owner) {
    if (!owner) return;
    const ownerKey = owner.id || owner.name;
    if (!ownerKey) return;

    this.runicZoneSprites = this.runicZoneSprites || {};
    const prev = this.runicZoneSprites[ownerKey];
    if (prev) prev.forEach(s => s.destroy());
    delete this.runicZoneSprites[ownerKey];

    const zone = (owner.statusEffects || []).find(se => se?.id === 'runic_zone' && (se.turns || 0) > 0);
    if (!zone) return;
    if (!this.textures?.exists('fx_runic_zone')) return;

    const slotKey = this._charSlotKey?.(owner);
    const slotContainer = this.unitSlots.find(c => c.uniqueKey === slotKey);
    if (!slotContainer) return;
    const { x: cx, y: cy } = slotContainer;

    const sprites = [];

    // Base ring — scaled down 25% per feedback (was 0.9), rotation slowed
    // way down (was 8s/turn), tint intensity scales with active mod count.
    // Filtered against the KNOWN mod-key list (not raw Object.entries) so a
    // companion numeric field like kindlingRiteStacks doesn't get counted as
    // its own "mod" — it's metadata about kindlingRite, not a 4th mod.
    const MOD_KEYS = Object.keys(CombatScene.RUNIC_ZONE_MOD_TINT);
    const activeMods = MOD_KEYS.filter(k => zone.mods?.[k]);
    const baseTint = CombatScene.RUNIC_ZONE_BASE_TINT_BY_COUNT[Math.min(3, activeMods.length)];
    const base = this.add.image(cx, cy, 'fx_runic_zone')
      .setScale(0.9 * 0.75)
      .setAlpha(0.85)
      .setDepth(1)
      .setTint(baseTint);
    this.tweens.add({ targets: base, rotation: Math.PI * 2, duration: 20000, repeat: -1 });
    sprites.push(base);

    activeMods.forEach((modKey, i) => {
      const cfg = CombatScene.RUNIC_ZONE_MOD_TINT[modKey];
      if (!cfg || !this.textures?.exists(cfg.key)) return;

      // Kindling Rite now stacks up to 3 — one overlay per stack, spread
      // across corners (see KINDLING_RITE_STACK_OFFSETS) instead of the old
      // single dead-center placement, which would just overlap once this
      // could stack past 1.
      if (modKey === 'kindlingRite') {
        const stacks = Math.min(3, Math.max(1, zone.mods.kindlingRiteStacks || 1));
        for (let s = 0; s < stacks; s++) {
          const { ox, oy } = CombatScene.KINDLING_RITE_STACK_OFFSETS[s] || CombatScene.KINDLING_RITE_STACK_OFFSETS[0];
          const overlay = this.add.image(cx + ox, cy + oy, cfg.key)
            .setScale(0.8)
            .setAlpha(0.9)
            .setDepth(1 + (i + 1) * 0.01 + s * 0.001)
            .setTint(cfg.tint)
            .setRotation(Math.random() * Math.PI * 2);
          this.tweens.add({ targets: overlay, rotation: overlay.rotation + Math.PI, duration: 6000, yoyo: true, repeat: -1 });
          sprites.push(overlay);
        }
        return;
      }

      // wardWeave/runeChannel: single instance, spread around the ring
      // instead of piling up in the same spot. wardWeave gets pushed out
      // further than runeChannel — it was still reading as too tucked
      // behind the portrait at the shared default distance.
      const angle = (i / Math.max(1, activeMods.length)) * Math.PI * 2;
      const dist = modKey === 'wardWeave' ? 18 : 10;
      const ox = Math.cos(angle) * dist;
      const oy = Math.sin(angle) * dist;

      const overlay = this.add.image(cx + ox, cy + oy, cfg.key)
        .setScale(0.8)
        .setAlpha(0.9)
        .setDepth(1 + (i + 1) * 0.01)
        .setTint(cfg.tint)
        .setRotation(Math.random() * Math.PI * 2);
      this.tweens.add({ targets: overlay, rotation: overlay.rotation + Math.PI, duration: 6000, yoyo: true, repeat: -1 });
      sprites.push(overlay);
    });

    // Hover tooltip — same "show CURRENT/live info" convention the quake
    // ground-effect tooltip uses, re-reading the zone fresh on every hover
    // rather than capturing a snapshot, so it can't go stale if a mod skill
    // fires while the tooltip happens to be open. Attached to every sprite
    // (base + overlays) so hovering anywhere on the zone works, not just
    // the small dead-center base ring.
    const showTip = (pointer) => {
      const liveZone = (owner.statusEffects || []).find(se => se?.id === 'runic_zone' && (se.turns || 0) > 0);
      if (!liveZone) { this.tooltip?.hide(); return; }
      const lines = [`${liveZone.turns ?? '?'} turn${liveZone.turns === 1 ? '' : 's'} left`];
      if (liveZone.mpPerTurn) lines.push(`+${liveZone.mpPerTurn} MP/turn to ${owner.name || 'owner'}`);
      const liveActive = MOD_KEYS.filter(k => liveZone.mods?.[k]);
      if (liveActive.length) {
        liveActive.forEach(modKey => {
          if (modKey === 'kindlingRite') {
            const stacks = liveZone.mods.kindlingRiteStacks || 1;
            lines.push(`Kindling Rite (${stacks}/3 stacks): +${stacks * 20}% elemental damage dealt, ${stacks * 80} Fire buildup/turn to caster`);
            return;
          }
          const info = CombatScene.RUNIC_ZONE_MOD_INFO[modKey];
          lines.push(info ? `${info.label}: ${info.desc}` : modKey);
        });
      } else {
        lines.push('No modifiers active yet.');
      }
      this.tooltip?.show(pointer.worldX, pointer.worldY, { title: 'Runic Zone', lines });
    };
    const moveTip = (pointer) => this.tooltip?.reposition(pointer.worldX, pointer.worldY);
    const hideTip = () => this.tooltip?.hide();
    sprites.forEach(s => {
      s.setInteractive({ useHandCursor: true });
      s.on('pointerover', showTip);
      s.on('pointermove', moveTip);
      s.on('pointerout', hideTip);
    });

    this.runicZoneSprites[ownerKey] = sprites;
  }

  // ---------- Lodge arrow sprites (attached to character, one per stack) ----------
  _refreshLodgeSprites(char) {
    if (!char) return;
    if (!this.textures?.exists('fx_lodge_arrow')) return;

    const key = char.name || char.id || 'unknown';

    // Destroy old arrows for this character
    const old = this.lodgeSprites[key] || [];
    old.forEach(s => s.destroy());
    this.lodgeSprites[key] = [];

    // Count lodged stacks
    const stacks = (char.statusEffects || []).filter(e => e.id === 'lodged').length;
    if (stacks === 0) return;

    // Find where this character is rendered (icon lives at 0,0 inside the slot container)
    const slot = char._slot;
    if (!slot) return;
    const cx = slot.x ?? 0;
    const cy = slot.y ?? 0;

    for (let i = 0; i < stacks; i++) {
      // Evenly distribute arrows around the clock + small jitter so they don't overlap
      const baseAngle = (i / stacks) * Math.PI * 2;
      const jitter = (Math.random() - 0.5) * (Math.PI / Math.max(stacks, 2)); // spread ±half a slice
      const angle = baseAngle + jitter;
      const radius = 4 + Math.random() * 8; // 4–12 px: near center so shaft crosses through

      const ax = cx + Math.cos(angle) * radius;
      const ay = cy + Math.sin(angle) * radius;

      const sprite = this.add.image(ax, ay, 'fx_lodge_arrow')
        .setScale(1.1)        // 128×64 → ~141×70 px — shaft clearly passes through the slot
        .setAlpha(0.92)
        .setDepth(1)          // depth 1: above bg (-1), behind slot containers (depth 2)
        .setRotation(angle);  // arrow points outward, shaft passes through center

      this.lodgeSprites[key].push(sprite);
    }
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

    // Fire (Ablaze), Lacerate (Hemorrhage), and Toxic (Envenomed) DOT ticks
    // used to fire here, before the character ever got to act. Moved to
    // _endTurnWeakness (2026-07) so the tick lands AFTER the character's own
    // turn — a real counterplay window (cleanse, reposition, retreat) instead
    // of an unavoidable hit before they've done anything. Cold's gauge
    // penalty (above, via _tickInitiativeGauge) and Disorient's MP drain stay
    // here deliberately: both shape the character's OWN upcoming turn rather
    // than being a delayed consequence of a past one.

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
    if (!char?.weakness) return { died: false };
    // Clear per-turn temp mods
    if (char.combat) char.combat.accPenalty = 0;

    // Fire (Ablaze), Lacerate (Hemorrhage), and Toxic (Envenomed) DOT ticks —
    // moved here from _startTurnWeakness (2026-07) so they land AFTER the
    // character's own turn instead of before it (see _startTurnWeakness for
    // the reasoning). Deliberately fire BEFORE decay below: the tick uses the
    // FULL, undecayed meter (the character was at this weakness's full
    // strength for their entire turn), then decay reduces it afterward.

    // 🔥 FIRE — Ablaze end-of-turn tick (MAGIC), per-family intensity curve + optional meter burn-out
    {
      const tiers = char?.weakness?.tiers || {};
      const meters = char?.weakness?.meters || {};
      if ((tiers.fire | 0) >= 2) {
        const m = meters.fire | 0;

        // Base tick, then multiply by Fire's own curve (does NOT affect Lightning).
        // A second, independent term (X per 100 CURRENT Fire meter) is added
        // on top WITHOUT going through the intensity multiplier — riding the
        // same curve twice would compound into a quadratic; keeping it a
        // flat add-on keeps total growth linear in meter.
        const base = (WeaknessV3?.families?.fire?.t2?.startTickBase ??
          WeaknessV3?.families?.fire?.t2?.startTickFlat ?? 10);
        const mult = familyIntensityMult('fire', m);
        const perHundred = WeaknessV3?.families?.fire?.t2?.startTickPerHundred ?? 0;
        const buildupAddOn = perHundred * (m / 100);
        const burnRaw = Math.max(1, Math.floor((+base || 0) * mult + buildupAddOn));

        // MAGIC-typed ; route through magic modifiers if desired
        let burn = burnRaw;

        try {
          if (typeof applyDamageModifiers === 'function') {
            burn = applyDamageModifiers(burn, /*attacker*/ null, char, { isMagic: true, element: 'fire' });
          }
        } catch { }

        if (burn > 0) {
          const dr = getDamageReductionFraction(char, { isMagic: true });
          if (dr) {
            burn = Math.max(0, Math.floor(burn * (1 - dr)));
          }
        }

        char.currentHP = Math.max(0, (char.currentHP | 0) - burn);
        this._showFloatingNumber?.(burn, char, /*isHeal=*/false, /*isCrit=*/false);
        this._log(`${char.name} Ablaze: (base ${base} × I_fire=${mult.toFixed(2)}) + ${buildupAddOn.toFixed(1)} buildup (m=${m}) ⇒ ${burnRaw} → ${burn} burn (magic).`);
        this._updateHealthBars?.(); this._updateHPMPBars?.();
        if (char.currentHP === 0 && char.status !== 'incapacitated') {
          char.status = 'incapacitated';
          this._onUnitKnockedOut?.(char);
          return { died: true };
        }

        // Optional extra meter consumption at end of turn (per Fire config)
        const consume = familyStartConsume('fire', m);
        if (consume > 0) {
          const before = meters.fire | 0;
          meters.fire = Math.max(0, before - consume);
          this._log(`${char.name} burns out: Fire meter ${before} → ${meters.fire} (−${consume}).`);

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

    // 🩸 LACERATE — Hemorrhaging %HP at end of turn (T2)
    {
      const w = char?.weakness;
      const t = w?.tiers?.lacerate | 0;
      if (t >= 2) {
        const maxHP = Math.max(1, (char.maxHP | 0));
        const meter = w?.meters?.lacerate | 0;

        const basePct = WeaknessV3?.families?.lacerate?.t2?.startPctHP ?? 0.06;
        const capPct = WeaknessV3?.families?.lacerate?.t2?.startPctCap ?? 0.20;

        const I = (typeof weaknessIntensityMult === 'function')
          ? weaknessIntensityMult(meter)
          : (typeof familyIntensityMult === 'function' ? familyIntensityMult('lacerate', meter) : 1);

        const pct = Math.min(basePct * (I > 0 ? I : 1), capPct);
        const dot = Math.max(1, Math.floor(maxHP * pct));

        let bleed = dot;
        const dr = getDamageReductionFraction(char, { isMagic: false });
        if (dr) {
          bleed = Math.max(0, Math.floor(bleed * (1 - dr)));
        }

        char.currentHP = Math.max(0, (char.currentHP | 0) - bleed);
        this._showFloatingNumber?.(bleed, char, /*isHeal=*/false, /*isCrit=*/false);
        this._log(`${char.name} hemorrhages ${bleed} (${Math.round(pct * 100)}% of Max HP).`);
        this._updateHealthBars?.(); this._updateHPMPBars?.();

        if (char.currentHP === 0 && char.status !== 'incapacitated') {
          char.status = 'incapacitated';
          this._onUnitKnockedOut?.(char);
          return { died: true };
        }
      }
    }

    // ☠️ TOXIC — Envenomed end-of-turn tick (T2)
    {
      const w = char?.weakness;
      const t = w?.tiers?.toxic | 0;
      if (t >= 2) {
        const m = w?.meters?.toxic | 0;

        const base = WeaknessV3?.families?.toxic?.t2?.startTickBase ?? 0;

        const I = (typeof weaknessIntensityMult === 'function')
          ? weaknessIntensityMult(m)
          : (typeof familyIntensityMult === 'function' ? familyIntensityMult('toxic', m) : 1);

        const raw = Math.max(1, Math.floor((+base || 0) * (I > 0 ? I : 1)));

        let dmg = raw;
        try {
          if (typeof applyDamageModifiers === 'function') {
            dmg = applyDamageModifiers(raw, /*attacker*/ null, char, { isMagic: true, element: 'necrotic' });
          }
        } catch { }

        if (dmg > 0) {
          const dr = getDamageReductionFraction(char, { damageType: 'necrotic' });
          if (dr) {
            dmg = Math.max(0, Math.floor(dmg * (1 - dr)));
          }
        }

        char.currentHP = Math.max(0, (char.currentHP | 0) - dmg);
        this._showFloatingNumber?.(dmg, char, /*isHeal=*/false, /*isCrit=*/false);
        this._log(`${char.name} Envenomed: base ${base} × I_toxic=${I.toFixed(2)} (m=${m}) ⇒ ${raw} → ${dmg} necrotic.`);
        this._updateHealthBars?.(); this._updateHPMPBars?.();

        if (char.currentHP === 0 && char.status !== 'incapacitated') {
          char.status = 'incapacitated';
          this._onUnitKnockedOut?.(char);
          return { died: true };
        }
      }
    }

    // Apply this unit's decay now — AFTER the DOT ticks above, so decay
    // reflects the meter post-tick (fire's optional burn-out consumption
    // included), not pre-tick.
    this._weaknessDecayUnit(char);
    if (this.characterInfoTab === 'weakness' && this._inspectedChar === char) {
      this._renderCharacterInfoBody(char);
    }
    // Status effect duration is handled exclusively by _tickDownStatusDurations
    // (called right after this, same end-of-turn sequence in _advanceTurn) —
    // this function used to ALSO decrement + filter char.statusEffects itself,
    // completely independently and with no `permanent` check and no log
    // message. Since both ran back-to-back on the same character, every status
    // effect was silently getting decremented twice per turn-end (halving
    // real durations), and this copy — running first — stripped permanent
    // effects (like Pressure Point's ignition) before the correct function
    // ever got a chance to protect them.
    return { died: false };
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
    // Base regen is the character's Initiative stat (derived preferred)
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

    // T1: healing received (scene-side so UI + heals agree). Scales with
    // intensity now (was a flat tier-step 1.0x/1.5x, matching maxHPDown below).
    if (t >= 1) {
      const base = WeaknessV3?.families?.disease?.t1?.healRecvPenalty ?? 0;
      const cap = WeaknessV3?.families?.disease?.t1?.healRecvPenaltyCap ?? base;
      const I = (typeof weaknessIntensityMult === 'function')
        ? weaknessIntensityMult(m)
        : (typeof familyIntensityMult === 'function' ? familyIntensityMult('disease', m) : 1);
      const penalty = Math.min(cap, base * (I > 0 ? I : 1));
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
        if (reason) this._log(`${char.name} Blight updates (${reason}): MaxHP ${prevEffMax}→${newEffMax} (kept ${Math.round(ratio * 100)}%)`);
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
          if (reason) this._log(`${char.name} Blight clears (${reason}): MaxHP cap removed (kept ${Math.round(ratio * 100)}%)`);
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
    this._exitTargetingMode?.();
    this._clearActionMenuContent();
  }
  _createButtonList(items) {
    // items = [{ label:'Text', action: ()=>{} } ... ]
    const baseX = this.actionMenuContentX ?? 0;
    items.forEach((it, i) => {
      const btn = new UIButton(this, baseX, i * 50, it.label, () => {
        const actor = this._currentChar?.();
        if (actor?.isEnemy) {
          this._log(`⛔ It's ${actor.name}'s (enemy) turn. Player actions are disabled.`);
          return;
        }
        if (it.debugTag === 'BA') {
          console.log(`[BasicAttack] Button shown for ${actor?.name}`);
        }
        if (it.action) it.action();
      });
      if (!it.action) btn.setAlpha(0.35);     // grey‑out disabled
      this._actionMenuAdd(btn);
    });
    this._finalizeActionMenuLayout();
  }

  _clearActionMenuContent() {
    if (this.actionMenuList) {
      this.actionMenuList.removeAll(true);
      this.actionMenuList.y = 0;
    } else {
      this.actionMenu?.removeAll(true);
    }
    this.actionMenuScrollY = 0;
    this.actionMenuScrollMax = 0;
  }

  _actionMenuAdd(obj) {
    if (!obj) return;
    if (this.actionMenuList) {
      this.actionMenuList.add(obj);
    } else {
      this.actionMenu?.add(obj);
    }
  }

  _setActionMenuInteractive(enabled) {
    const visit = (child) => {
      if (!child) return;
      if (child.list && Array.isArray(child.list)) {
        child.list.forEach(visit);
      }
      if (enabled) {
        child.setInteractive?.({ useHandCursor: true });
      } else {
        child.disableInteractive?.();
      }
    };

    const roots = this.actionMenuList?.list || this.actionMenu?.list || [];
    roots.forEach(visit);
  }

  _updateActionMenuScrollBounds() {
    if (!this.actionMenuList) {
      this.actionMenuScrollMax = 0;
      return;
    }

    const viewport = this.actionMenuViewport || {};
    const children = this.actionMenuList.list || [];
    let maxBottom = 0;
    const baseY = (this.actionMenu?.y ?? 0) + (viewport.y ?? 0);

    children.forEach(child => {
      if (!child || !child.visible) return;
      const bounds = child.getBounds?.();
      if (!bounds) return;
      const localBottom = bounds.bottom - baseY;
      if (localBottom > maxBottom) maxBottom = localBottom;
    });
    const viewH = viewport.height ?? 0;
    const contentHeight = Math.max(viewH, maxBottom);
    this.actionMenuScrollMax = Math.max(0, contentHeight - viewH);
    this._applyActionMenuScroll();
  }

  _applyActionMenuScroll() {
    if (this.actionMenuList) {
      this.actionMenuList.y = -this.actionMenuScrollY;
    }
    this._refreshActionMenuInteractivity();
  }

  /**
   * Enables interaction only on action menu children currently inside the viewport Y range.
   * This prevents scrolled-off invisible buttons from stealing pointer events (e.g. during targeting).
   * Items that scroll back into view are re-enabled, preserving click-to-cancel-targeting.
   */
  _refreshActionMenuInteractivity() {
    if (!this.actionMenuList || !this.actionMenuViewport) return;
    const { y: viewY, height: viewH } = this.actionMenuViewport;
    const scrollY = this.actionMenuScrollY || 0;
    // Visible Y range in list-local coordinates
    const visTop = viewY + scrollY;
    const visBot = visTop + viewH;

    this.actionMenuList.list.forEach(child => {
      if (!child || !child.input) return; // never made interactive — skip
      const isContainer = child.type === 'Container';
      const h = child.height || 40;
      const itemTop = isContainer ? child.y - h / 2 : child.y;
      const itemBot = isContainer ? child.y + h / 2 : child.y + h;
      const inView = itemBot > visTop && itemTop < visBot;
      if (inView) {
        child.setInteractive({ useHandCursor: true });
      } else {
        child.disableInteractive();
      }
    });
  }

  _setActionMenuScroll(value) {
    const max = this.actionMenuScrollMax ?? 0;
    const clamped = Phaser.Math.Clamp(value, 0, max);
    if (clamped === this.actionMenuScrollY) return;
    this.actionMenuScrollY = clamped;
    this._applyActionMenuScroll();
  }

  _scrollActionMenu(deltaY) {
    if (!this.actionMenu?.visible) return;
    const step = deltaY * 0.35;
    this._setActionMenuScroll((this.actionMenuScrollY || 0) + step);
  }

  _finalizeActionMenuLayout() {
    this._updateActionMenuScrollBounds();
    this._applyActionMenuScroll(); // also calls _refreshActionMenuInteractivity
  }

  _isPointerOverActionMenu(pointer) {
    if (!pointer || !this.actionMenu || !this.actionMenu.visible) return false;
    const viewport = this.actionMenuViewport;
    if (!viewport) return false;
    const localX = pointer.worldX - (this.actionMenu.x ?? 0);
    const localY = pointer.worldY - (this.actionMenu.y ?? 0);
    const viewLeft = viewport.x ?? 0;
    const viewTop = viewport.y ?? 0;
    const viewRight = viewLeft + (viewport.width ?? 0);
    const viewBottom = viewTop + (viewport.height ?? 0);
    return localX >= viewLeft && localX <= viewRight && localY >= viewTop && localY <= viewBottom;
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


  // Wires the info-click handler AND the idle-border hover-reveal together —
  // three call sites re-attach the info click on a slot (_assignCharToSlot,
  // _placePortrait, _exitTargetingMode), each via slot.removeAllListeners()
  // first, which would otherwise silently wipe out any hover listeners set
  // up elsewhere. Centralizing here means all three get the hover affordance
  // for free and can't drift out of sync with each other.
  _wireSlotInfoClick(slot, char) {
    slot.on('pointerdown', () => {
      // Clicking the ALREADY-selected character again deselects — same
      // effect as the ✕ button — instead of just re-rendering the same panel.
      if (this._inspectedChar === char && this.characterInfoPanel?.visible) {
        this.characterInfoPanel.setVisible(false);
        this._inspectedChar = null;
        this._clearSlotHighlights?.();
        return;
      }
      this._showCharacterInfo(char);
    });
    slot.on('pointerover', () => {
      if (!slot.char) return; // empty slots already always show their border
      if (slot === this._currentChar()?._slot) return; // don't clobber the active-turn highlight
      slot.rect.setStrokeStyle(2, slot.char.isEnemy ? 0xff4444 : 0xffffff);
      slot.rect.setAlpha(1);
    });
    slot.on('pointerout', () => this._clearSlotHighlights());
  }

  _clearSlotHighlights() {
    const activeSlot = this._currentChar()?._slot;
    const isTargeting = !!this.targetingAbility;
    // Position-targeting (movement, e.g. Move Step/Dash): reachable empty
    // slots get a green highlight set directly by _enterPositionTargeting.
    // This function has no other awareness of that mode, so without this it
    // would stomp the green back to plain gray the instant it ran for any
    // other reason (e.g. hovering off a nearby occupied ally slot fires the
    // idle-hide hover-out handler, which calls this) — the slot stayed
    // clickable since listeners are untouched, just the feedback vanished.
    const posTargetSet = this._posTargets ? new Set(this._posTargets) : null;

    this.unitSlots.forEach(slot => {
      slot.rect.disableInteractive();

      if (slot === activeSlot) {
        // Scaled up (not just a thicker stroke) so the border clearly extends
        // past the 64x64 portrait sprite's edges instead of being mostly
        // covered by it — a same-size stroke was easy to miss since the
        // portrait (added on top, same dimensions) hid all but a sliver of it.
        slot.rect.setStrokeStyle(3, 0x7fc8ff);       // light blue = "my turn"
        slot.rect.setScale(1.08);
        slot.rect.setAlpha(1);
      } else if (posTargetSet && posTargetSet.has(slot)) {
        slot.rect.setStrokeStyle(3, 0x88ff88);       // green = reachable move target
        slot.rect.setScale(1);
        slot.rect.setAlpha(1);
      } else if (!slot.char) {
        slot.rect.setStrokeStyle(2, 0x888888);       // gray for empty — always shown, no portrait to fall back on
        slot.rect.setScale(1);
        slot.rect.setAlpha(1);
      } else if (isTargeting || this._inspectedChar === slot.char) {
        // Occupied AND needs to show: either targeting mode (need to see who's
        // a valid target) or this is who's currently pinned in the info panel.
        slot.rect.setStrokeStyle(2, slot.char.isEnemy ? 0xff4444 : 0xffffff);
        slot.rect.setScale(1);
        slot.rect.setAlpha(1);
      } else {
        // Idle, occupied, not selected — declutter: hide the border AND the
        // fill (the object's own alpha covers both at once, since the fill's
        // own 0.2 alpha and the stroke's opacity are both multiplied by it) —
        // just the portrait shows. Briefly reappears on hover (see
        // _wireSlotInfoClick).
        slot.rect.setStrokeStyle(0);
        slot.rect.setScale(1);
        slot.rect.setAlpha(0);
      }
    });
  }

  _refreshStatusEffectIcons(unit) {
    const slot = unit?._slot;
    if (!slot) return;

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

    const effects = combineStatusEffects(unit);
    const size = 9;
    const spacing = size * 2 + 6;

    effects.forEach((eff, i) => {
      const { container } = createStatusIcon(this, eff, {
        size,
        depth: UI_DEPTH.overlay + 1,
        tooltip: this.tooltip,
      });
      container.x = i * spacing;
      slot._effectIconContainer.add(container);
    });

    slot._effectIconContainer.setVisible(effects.length > 0);
    this._updateInspectedStatusIcons(unit);
  }

  _updateInspectedStatusIcons(unit) {
    if (!unit || unit !== this._inspectedChar) return;
    if (!this._charStatusIconContainer) return;

    this._charStatusIconContainer.removeAll(true);
    const effects = combineStatusEffects(unit);
    const size = 10;
    const spacing = size * 2 + 6;

    effects.forEach((eff, i) => {
      const { container } = createStatusIcon(this, eff, {
        size,
        depth: UI_DEPTH.overlay + 2,
        tooltip: this.tooltip,
      });
      container.x = i * spacing;
      container.y = 0;
      this._charStatusIconContainer.add(container);
    });

    this._charStatusIconContainer.setVisible(effects.length > 0);
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
        this._log(`${user.name} tries to move but finds no space in the ${destCol}.`);
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

  // Movement cost using pre-computed brick-offset grid distances.
  _moveCost(fromId, toId) {
    return moveCost(fromId, toId);
  }

  // True if the two slots are directly adjacent (range 1) in the brick grid.
  _areAdjacent(slotId1, slotId2) {
    return getAdjacentSlots(slotId1).includes(slotId2);
  }

  // Returns all slot IDs adjacent to the given slot (used by aoeResolver "adjacent" shape).
  _getAdjacentSlots(slotId) {
    return getAdjacentSlots(slotId);
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

  // Reset a slot's border back to your default
  _resetSlotStroke(slot) {
    const isEnemy = this.enemySlots.includes(slot);
    slot.rect.setStrokeStyle(2, isEnemy ? 0xff4444 : 0xffffff);
    slot.rect.setAlpha(1);
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
    if (!fromId) { this._log('No current position.'); return; }

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
      slot.setInteractive();
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
        // Do NOT call disableInteractive() — it destroys the centered geometry set
        // at creation and leaves slots permanently dead for future targeting.
        // removeAllListeners already prevents the movement handler from re-firing.
        this._resetSlotStroke(slot);
      });
      this._posTargets = null;
    }
    // Also clear generic targeting state if any
    this._exitTargetingMode?.();
  }

  // Keep this, but make sure it restores default strokes
  _exitTargetingMode() {
    // Clear targetingAbility FIRST — _clearSlotHighlights() below reads it to
    // decide whether occupied-but-idle slots should stay visible (targeting)
    // or declutter-hide again (not targeting). Calling it while
    // targetingAbility was still set meant every occupied slot got forced
    // visible on exit, and only actually re-hid itself on the NEXT unrelated
    // _clearSlotHighlights() call (e.g. a hover in/out cycle) — exactly the
    // "squares pop up until I hover a character" symptom reported.
    this.targetingAbility = null;
    this._clearSlotHighlights?.();
    this._clearSlotListeners?.();   // removes all slot/icon listeners, keeps interactive active

    // Reset the ability button that was highlighted (amber-gold selection state)
    if (this.targetingAbilityBtn) {
      const btn = this.targetingAbilityBtn;
      this.targetingAbilityBtn = null;
      btn._isSelected = false;
      if (btn.background?.active) {
        btn.background.setFillStyle(0x1c1c1c);
        btn.background.setStrokeStyle(1.5, 0x6a7080);
      }
      if (btn.text?.active) btn.text.setStyle({ color: '#b8bccf' });
    }

    // NOTE: used to hard-reset every slot's border here via _resetSlotStroke
    // (a plain red/white default with no concept of "whose turn is it") —
    // that ran AFTER _clearSlotHighlights() above had already set the
    // current turn's highlight, silently overwriting it back to the default
    // every time the player's action menu rebuilt (_buildActionMenuRoot
    // calls _exitTargetingMode first thing, every player turn). Enemy turns
    // never called this at all, which is why only allies lost the highlight.
    // _clearSlotHighlights() above already resets every slot correctly
    // (including the turn-aware case), so this second pass was redundant
    // and actively wrong — removed instead of fixed.

    // Restore info-click on the slot container (sprites are never interactive).
    // The container keeps its default Rectangle(0,0,64,64) geometry from _createBattleSlots.
    [...this.allySlots, ...this.enemySlots].forEach(slot => {
      const char = slot.char;
      if (!char || !char.icon?.active) return;
      this._wireSlotInfoClick(slot, char);
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
    }).setOrigin(0.5).setDepth(UI_DEPTH.overlay + 10);

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
    // Info panel deliberately stays open across turn transitions now — only
    // the X button or selecting a different character closes it (previously
    // this force-hid it every single turn, even the player's own).

    const currentChar = this._currentChar();

    // ✅ Update the current turn name display
    if (this.turnNameText) {
      const classColor = CLASS_COLORS?.[currentChar.baseClass] || '#ffffff';
      this.turnNameText.setText(`${currentChar.name}`);
      this.turnNameText.setColor(classColor);
    }

    // ✅ Highlight the current turn in the turnOrder UI list (by tinting text)
    if (this.turnOrderEntries) {
      this.turnOrderEntries.forEach((entry, idx) => {
        if (entry?.setColor) {
          const isActive = idx === this.currentTurnIndex;
          entry.setColor(isActive ? '#00ff00' : '#ffffff');
        }
      });
    }

    this._updateActionLights(); // 🔄 Refresh action lights
  }

  _clearPortrait(slot) {
    // keep the rectangle (index 0), remove everything else
    slot.removeBetween(1, slot.length, true);
    this._clearSlotEffectIcons(slot);
  }

  _clearSlotEffectIcons(slot) {
    if (slot?._effectIconContainer) {
      slot._effectIconContainer.destroy(true);
      slot._effectIconContainer = null;
    }
  }


  _clearSlotListeners() {
    this.unitSlots.forEach(slot => {
      /* container – keep interactive (preserves Rectangle geometry), just flush listeners */
      slot.removeAllListeners();

      /* border rectangle – purely visual, keep non-interactive */
      slot.rect.removeAllListeners();
      slot.rect.disableInteractive();
      // Sprites inside containers are never interactive; no icon cleanup needed.
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
      // No valid action this pass (no legal target, everything on cooldown,
      // etc.) — silent. This can fire once per exhausted action-type slot
      // per turn, which reads as pure spam once the AI's actually working.
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

      // Taunted: force target to whoever taunted this NPC
      const tauntEffect = (npc?.statusEffects || []).find(se => se?.id === 'taunted' && (se.turns || 0) > 0);
      if (tauntEffect?.tauntTarget) {
        const tauntSlots = npc.isEnemy ? (this.allySlots || []) : (this.enemySlots || []);
        const tt = tauntEffect.tauntTarget;
        const tauntChar = tauntSlots.map(s => s?.char).find(c => c && (c === tt || c.id === tt || c.name === tt) && c.status !== 'incapacitated');
        if (tauntChar) return tauntChar;
      }

      // default: first alive opposing party member
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

    // 1) Apply END-OF-TURN consequences for the actor who just acted
    const previousChar = this._currentChar?.();
    let previousCharDied = false;
    if (previousChar) {
      // tick centralized cooldowns for the actor who just acted
      this._tickCooldownsEndOfTurn(previousChar);

      // Ground/hazard zone tick (e.g. Frozen Quake) — moved here from start-
      // of-turn (2026-07): the occupant now gets their own full turn to move
      // out of a hazard zone before it can hit them, instead of being ticked
      // before they've had any chance to react.
      const zoneResult = this._applySlotEffectsTick(previousChar);
      if (this.combatEnded) return;
      if (zoneResult?.died) previousCharDied = true;

      if (!previousCharDied) {
        // Weakness DOT ticks (Fire/Lacerate/Toxic) + decay, end of *their* turn
        const weaknessResult = this._endTurnWeakness(previousChar);
        if (this.combatEnded) return;
        if (weaknessResult?.died) previousCharDied = true;
      }

      if (!previousCharDied) {
        // Resolve delayed one-shot payloads (e.g. Glacial Strike's Trapped Fire)
        // before the normal duration tick below removes/logs the status.
        this._applyEndOfTurnProcs(previousChar);

        // === NEW: tick down timed statuses (includes Cinders) ===
        this._tickDownStatusDurations(previousChar);
      }
    }

    // 2) Advance to next actor
    if (!this.turnOrder?.length) return;                  // avoid modulo 0
    if (previousCharDied) {
      // previousChar was just removed from turnOrder by _onUnitKnockedOut,
      // which only decrements currentTurnIndex if the removed slot was
      // BEFORE it — since previousChar WAS AT currentTurnIndex, that
      // condition is false, so the index is left pointing at whichever unit
      // slid into the now-vacant slot (already the correct "next" unit).
      // Incrementing here, like the normal case below, would skip that unit
      // entirely.
      if (this.currentTurnIndex >= this.turnOrder.length) this.currentTurnIndex = 0;
    } else {
      this.currentTurnIndex = (this.currentTurnIndex + 1) % this.turnOrder.length;
    }
    const _isNewRound = this.currentTurnIndex === 0;

    const char = this._currentChar?.();
    if (!char) return;
    if (typeof char.isEnemy !== 'boolean') {
      char.isEnemy = !!this.enemies?.includes(char);
    }

    // Clear per-turn kill flags at the start of each new actor's turn
    this.enemyDiedThisTurn = false;
    this.killedEnemyLacerateTier = 0;
    this.currentActorMovedThisTurn = false;
    this.lodgesDislodgedThisTurn = 0;

    // Tick down ground zones on unoccupied slots ONCE per full round (when the
    // turn array wraps back to index 0). Occupied slots are already handled by
    // _applySlotEffectsTick() above when each character takes their turn.
    // This prevents empty-slot zones from ticking N times per round (once per
    // character turn) instead of once. Movement is safe: we check occupancy at
    // round-end, so a slot vacated mid-round gets one tick; a newly occupied
    // slot is skipped (the occupant's next turn will tick it instead).
    if (_isNewRound) {
      this.combatRound = (this.combatRound || 1) + 1;
      const occupiedKeys = new Set(
        this.turnOrder.map(u => this._charSlotKey(u)).filter(Boolean)
      );
      for (const [key, effects] of Object.entries(this.slotEffects || {})) {
        if (occupiedKeys.has(key) || !effects?.length) continue;
        const stillActive = [];
        for (const eff of effects) {
          eff.turns -= 1;
          if (eff.turns > 0) {
            stillActive.push(eff);
          } else {
            this._log(`The ${eff.id.replace(/_/g, ' ')} zone dissipates.`);
          }
        }
        this.slotEffects[key] = stillActive;
        this._refreshGroundSprites(key);
      }
    }

    const se = this._startTurnStatusEffects(char);    // NEW
    if (this.combatEnded || se.died) return;

    const start = this._startTurnWeakness(char);      // existing
    if (this.combatEnded) return;

    this._applyGearStartOfTurn(char);

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
    // Frost-Numbed (Glacial Strike): bonus action disabled for this whole
    // turn — checked here, once, right after the reset, rather than gating
    // every bonus-action use site individually.
    if ((char?.statusEffects || []).some(se => se?.id === 'frost_numbed' && ((se.turns || 0) > 0 || se.permanent))) {
      char.actionsLeft.bonus = 0;
      this._log(`${char.name} is Frost-Numbed — bonus action disabled this turn.`);
    }
    this.reactions?.onTurnStart(char);
    // Turn separator — always the Combat bucket specifically, never
    // whichever tab happens to be active (same reasoning as _log()).
    this.combatEntries.push({ separator: true });
    this._scheduleLogRender();
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
  _tickDownStatusDurations(char) {
    // Map-style statuses: { id: { turns, ... } }
    if (char?.statuses && typeof char.statuses === 'object') {
      for (const key of Object.keys(char.statuses)) {
        const st = char.statuses[key];
        if (st && typeof st.turns === 'number') {
          st.turns -= 1;
          if (st.turns <= 0) {
            delete char.statuses[key];
            this._log(`${char.name}'s ${key.replaceAll('_', ' ')} fades.`);
          }
        }
      }
    }

    // Legacy array-style statuses: [ { id, turns }, ... ]
    let lodgeCountChanged = false;
    if (Array.isArray(char?.statusEffects)) {
      for (let i = char.statusEffects.length - 1; i >= 0; i--) {
        const st = char.statusEffects[i];
        if (st?.permanent) continue; // Permanent riders (curse_of_needles etc.) never expire
        if (st && typeof st.turns === 'number') {
          st.turns -= 1;
          if (st.turns <= 0) {
            const pretty = (st.name || st.id || 'status');
            this._log(`${char.name}'s ${pretty} fades.`);
            if (st.id === 'lodged') lodgeCountChanged = true;
            char.statusEffects.splice(i, 1);
            // Natural turn-countdown expiry — the ONLY other place runic_zone
            // gets removed is _moveUnitToSlot's movement dissipation, which
            // explicitly refreshes the sprite; this generic path never did,
            // so a zone that simply ran out of turns left an orphaned ground
            // sprite on screen indefinitely instead of disappearing.
            if (st.id === 'runic_zone') this._refreshRunicZoneSprite?.(char);
          }
        }
      }
    }
    if (lodgeCountChanged) this._refreshLodgeSprites(char);

    this._refreshStatusEffectIcons?.(char);
  }


  _applyRewardBuff(target, buff, ability, context = {}) {
    if (!target || !buff) return;

    // Grants a Rhythm stack (shared mechanic — see applyRhythmStack in
    // skills.js) instead of a stat-mod status effect. Bypasses the "no stat
    // mods, nothing to do" bailout below since it's a real effect on its own.
    if (buff.grantsRhythm) {
      applyRhythmStack(target);
    }

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
      this._log(`${target.name} gains ${summary.join(', ')} for ${durationText} from ${abilityName}${tierNote}.`);
    }
  }

  _applyRewardDebuff(target, debuff, ability, context = {}) {
    if (!target || !debuff) return;

    // Immediate bonus buildup to the target (e.g. Marked Cut's bonus Lacerate
    // on crossing an Expose tier) — goes through the real weakness buildup
    // pipeline (respects BuildupReceived, Hunter's Mark, resilience, weapon
    // buildup%, etc.), not expressed as a stat-mod status effect below, since
    // it's an instant meter change rather than a duration-based effect. Uses
    // context.attacker (passed by the rewardIfTierCross consumer) so gear/mark
    // bonuses tied to the attacker still apply, same as any other buildup hit.
    if (debuff.addBuildup) {
      this._applyWeaknessBuildup(target, debuff.addBuildup, { user: context?.attacker, ability });
    }

    // Immediate Initiative Gauge penalty (e.g. Sword Flourish: crossing
    // Disorient while already Chilled saps their momentum) — a direct gauge
    // subtraction, not a status effect, same reasoning as addBuildup above.
    if (Number.isFinite(debuff.initiativeGaugeDrop) && debuff.initiativeGaugeDrop > 0) {
      const before = target.initiativeGauge | 0;
      target.initiativeGauge = Math.max(0, before - debuff.initiativeGaugeDrop);
      if (target.initiativeGauge !== before) {
        this._log(`${target.name} loses ${before - target.initiativeGauge} Initiative Gauge from ${ability?.name || 'the skill'}.`);
      }
    }

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
    // Routes through AttackPower — the SAME generic increased/decreased-
    // damage-dealt mod every combat buff and Sacred Shockwave's own weaken
    // debuff already use. Silence Crescent's old version wrote a bespoke
    // `DamageDealt` mod key instead, which was never read ANYWHERE in the
    // codebase — a real, previously undiscovered "declared but unenforced"
    // bug (same class as Kindling Rite's elemental buff before that was
    // fixed). Fixed by expressing it as negative AttackPower instead.
    if (Number.isFinite(debuff.damageDealtDownPct)) {
      toStat('AttackPower', -Math.abs(debuff.damageDealtDownPct), 'damage dealt');
    }

    // Custom, non-stat marker consumed by a later hit rather than expressed as
    // a numeric mod — e.g. Pressure Point's ignition (next hit taken gets
    // bonus fire damage). Bypasses the "no stat mods, nothing to do" bailout
    // below since it's a real effect even with an empty mods object.
    const hasCustomMarker = !!debuff.onNextDamageTaken;
    if (Object.keys(mods).length === 0 && !hasCustomMarker) return;

    const effectId = debuff.statusId || `reward_${ability?.id || 'skill'}_debuff`;
    const statusPayload = { id: effectId, mods };
    if (debuff.permanent) {
      statusPayload.permanent = true;
    } else {
      statusPayload.turns = turns;
    }
    if (hasCustomMarker) statusPayload.onNextDamageTaken = debuff.onNextDamageTaken;
    this._addStatusEffects(target, [statusPayload]);

    if (summary.length) {
      const durationText = turns > 1 ? `${turns} turns` : '1 turn';
      const abilityName = ability?.name || 'the skill';
      const tierNote = context?.family ? ` (tier ${context.tier} ${context.family})` : '';
      this._log(`${target.name} suffers ${summary.join(', ')} for ${durationText} from ${abilityName}${tierNote}.`);
    } else if (hasCustomMarker) {
      const abilityName = ability?.name || 'the skill';
      const tierNote = context?.family ? ` (tier ${context.tier} ${context.family})` : '';
      this._log(`${target.name} is marked by ${abilityName}${tierNote} — vulnerable on their next hit taken.`);
    }
  }

  // Same "did this ACTUALLY cross a tier" reward mechanism as the primary
  // target's rewardIfTierCross consumer (see the tier-cross block above,
  // near where prevTiers/currTiers are snapshotted), just scoped to one
  // splash/AoE target instead of the primary target — e.g. Sword Flourish
  // granting Rhythm only if the disorient it spreads actually pushes a
  // column-mate into a new tier, not a self-predicted guess made before the
  // real buildup (Hunter's Mark/weapon%/resilience) has been applied.
  // prevTiers must be captured by the caller BEFORE _applyDirectResult runs.
  _applySplashTierCrossRewards(attacker, target, rules, ability, prevTiers) {
    if (!target || !Array.isArray(rules) || !rules.length) return;
    this._recomputeWeaknessTiers?.(target);
    const currTiers = { ...(target?.weakness?.tiers || {}) };
    const crossed = (fam, tier) => (prevTiers[fam] || 0) < tier && (currTiers[fam] || 0) >= tier;

    const bestPerFamily = new Map();
    for (const rule of rules) {
      const families = rule.family === 'any' ? ['fire', 'cold', 'lightning'] : [rule.family];
      for (const fam of families) {
        if (!crossed(fam, rule.tier)) continue;
        const best = bestPerFamily.get(fam);
        if (!best || rule.tier > best.tier) bestPerFamily.set(fam, rule);
      }
    }
    // Gate scoped to debuff.alsoRequires only (see the primary-target
    // consumer above for why) — an unconditional buff on the same rule
    // (e.g. Rhythm on any cross) still fires even if this gate fails.
    const passesAlsoRequires = (gate) => !gate || ((target?.weakness?.tiers?.[gate.family] || 0) >= (gate.tierAtLeast ?? 1));
    for (const [fam, rule] of bestPerFamily) {
      if (rule.buff) this._applyRewardBuff(attacker, rule.buff, ability, { family: fam, tier: rule.tier });
      if (rule.debuff && passesAlsoRequires(rule.debuff.alsoRequires)) {
        this._applyRewardDebuff(target, rule.debuff, ability, { family: fam, tier: rule.tier, attacker });
      }
    }
  }


  // Removes a single status effect by id immediately — for reaction-applied
  // debuffs meant to scope to exactly one hit (see the pre-hit reaction
  // cleanup in _applyAbilityToTarget), where waiting on the effect's own
  // `turns` countdown would let it outlive the hit it was meant for.
  _clearScopedStatus(char, id) {
    if (!char || !id || !Array.isArray(char.statusEffects)) return;
    char.statusEffects = char.statusEffects.filter(se => se?.id !== id);
  }

  _addStatusEffects(target, effects = []) {
    if (!target || !Array.isArray(effects) || effects.length === 0) return;
    target.statusEffects = target.statusEffects || [];

    // Fields with real, non-generic merge/default semantics — everything
    // else (onHitBy, onHit, nextHitBuildup, nextHitOnly, onNextDamageTaken,
    // onTurnEndOnce, any per-family *BuildupMul key, and any FUTURE field a
    // skill invents) is copied through generically below instead of needing
    // to be individually whitelisted. This is the actual fix for the bug
    // class that bit onHitBy/onHit/nextHitBuildup/nextHitOnly one at a time
    // this session — a status effect field used to get silently stripped to
    // nothing unless someone remembered to add it here by name.
    const SPECIAL_KEYS = new Set(['id', 'turns', 'tickDamage', 'tickHeal', 'blocksAction', 'stackable', 'permanent', 'mods', 'data']);
    const buildupMulKeys = new Set(Object.keys(WeaknessFamilies || {}).map(fam => `${fam}BuildupMul`));

    let lodgeChanged = false;
    for (const se of effects) {
      const def = (StatusEffects && StatusEffects[se.id]) || {};
      const permanent = se.permanent ?? def.permanent ?? false;
      const incoming = {
        // Spread registry defaults, then the caller's own values (winning
        // over the registry) — this is what lets ANY field survive without
        // being named here. The explicit fields below then override with
        // their own special default/merge logic.
        ...def,
        ...se,
        id: se.id,
        // A permanent effect gets turns:null, not a real number — otherwise
        // it always falls back to 1 (no turns given, no def.duration), which
        // is why Pressure Point's ignition tooltip showed "Duration: 1 turn"
        // even though _tickDownStatusDurations correctly never expired it.
        // Field name mismatch is intentional/pre-existing: the registry
        // calls this `duration`, the runtime instance calls it `turns` — the
        // generic spread above can't bridge that on its own.
        turns: permanent ? null : (se.turns ?? def.duration ?? 1),
        tickDamage: se.tickDamage ?? def.tickDamage ?? 0,
        tickHeal: se.tickHeal ?? def.tickHeal ?? 0,
        blocksAction: se.blocksAction ?? def.blocksAction ?? false,
        stackable: se.stackable ?? def.stackable ?? false,
        // permanent: lasts until explicitly consumed/removed elsewhere, not on a
        // turn timer (_tickDownStatusDurations skips these).
        permanent,
        mods: { ...(def.mods || {}), ...(se.mods || {}) },
        data: { ...(def.data || {}), ...(se.data || {}) },
      };
      // Defensive type-guard for per-family incoming-buildup vulnerability
      // keys, e.g. fireBuildupMul/lightningBuildupMul (Wind Exposed, Trapped
      // Fire) — only a real family name with a numeric value survives,
      // matching the old hardcoded loop's validation exactly, just without
      // needing to enumerate WeaknessFamilies by hand at each call site.
      for (const key of Object.keys(incoming)) {
        if (buildupMulKeys.has(key) && typeof incoming[key] !== 'number') delete incoming[key];
      }

      if (incoming.stackable) {
        // Each application is its own entry — e.g. lodged arrows stack visually
        target.statusEffects.push(incoming);
        if (incoming.id === 'lodged') lodgeChanged = true;
      } else {
        // Coalesce same-id
        const i = target.statusEffects.findIndex(e => e.id === incoming.id && !e.stackable);
        if (i >= 0) {
          const cur = target.statusEffects[i];
          // Additive/OR/max fields — reapplying the same status STACKS these,
          // it doesn't just overwrite them.
          cur.tickHeal = (cur.tickHeal | 0) + (incoming.tickHeal | 0);
          cur.tickDamage = (cur.tickDamage | 0) + (incoming.tickDamage | 0);
          cur.permanent = !!(cur.permanent || incoming.permanent);
          cur.turns = cur.permanent ? null : Math.max(cur.turns | 0, incoming.turns | 0);
          cur.blocksAction = !!(cur.blocksAction || incoming.blocksAction);
          // mods/onHit: per-key "strongest wins" (bigger |value|), not a
          // blind overwrite — a weaker recast (e.g. Sacred Shockwave's
          // AttackPower debuff scaling with tiers cleared, or Shattering
          // Cut's PhysicalResist debuff scaling with Lacerate consumed) must
          // not silently downgrade an existing stronger application. Falls
          // back to incoming-wins for any non-numeric sub-field — "stronger"
          // isn't well-defined for those.
          const mergeStrongerKeys = (curSub, incSub) => {
            const out = { ...(curSub || {}) };
            for (const k of Object.keys(incSub || {})) {
              const a = out[k], b = incSub[k];
              out[k] = (typeof a === 'number' && typeof b === 'number')
                ? (Math.abs(b) > Math.abs(a) ? b : a)
                : b;
            }
            return out;
          };
          if (incoming.mods && Object.keys(incoming.mods).length) {
            cur.mods = mergeStrongerKeys(cur.mods, incoming.mods);
          }
          if (incoming.onHit && Object.keys(incoming.onHit).length) {
            cur.onHit = mergeStrongerKeys(cur.onHit, incoming.onHit);
          }
          // `data` is deliberately NOT touched here — the original code never
          // merged it on reapply either; preserved as-is rather than silently
          // changing that behavior as part of this cleanup.
          // Everything else — last-cast-wins overwrite, generic instead of
          // one `if (incoming.X !== undefined) cur.X = incoming.X` per field —
          // EXCEPT per-family *BuildupMul keys (Trapped Fire, Torn Defenses,
          // Glacial Scorch, etc.), which get the same "stronger wins" rule.
          for (const key of Object.keys(incoming)) {
            if (SPECIAL_KEYS.has(key) || key === 'onHit') continue;
            if (incoming[key] === undefined) continue;
            if (buildupMulKeys.has(key) && typeof cur[key] === 'number' && typeof incoming[key] === 'number') {
              cur[key] = Math.max(cur[key], incoming[key]);
            } else {
              cur[key] = incoming[key];
            }
          }
        } else {
          target.statusEffects.push(incoming);
        }
      }
    }

    this._refreshStatusEffectIcons?.(target);
    if (lodgeChanged) this._refreshLodgeSprites(target);
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

  // Shared by _showVictoryScreen/_showDefeatScreen: dims and input-blocks
  // everything at battlefield depth (UI_OVERLAY and below — action menu,
  // portraits, etc.), while lifting the combat log's own pieces just above
  // the blocker so it stays visible AND interactive (tabs, scroll) through
  // the rest of the post-combat screen. The victory/defeat panel itself
  // renders even higher (2000+/3001+ below), so it's unaffected either way.
  _dimBattlefieldForPostCombat() {
    if (this._postCombatDimmed) return;
    this._postCombatDimmed = true;
    const { width, height } = this.sys.game.canvas;

    // Make sure inputs reach the topmost interactive object only — this is
    // what lets an interactive-but-listenerless blocker rectangle actually
    // swallow clicks aimed at whatever's beneath it.
    this.input.topOnly = true;

    this.add.rectangle(width / 2, height / 2, width, height, 0x000000, 0.85)
      .setDepth(1500)
      .setInteractive();

    const logDepth = 1600;
    this.combatLogBg?.setDepth(logDepth);
    this.combatLogContainer?.setDepth(logDepth);
    if (this.combatLogTabButtons) {
      Object.values(this.combatLogTabButtons).forEach(({ text, underline }) => {
        text.setDepth(logDepth + 1);
        underline.setDepth(logDepth + 1);
      });
    }
    this.localChatInputDom?.setDepth(logDepth + 1);
  }

  _showVictoryScreen(title = 'Victory!', xpSummary = [], progressReward = null, loot = [], leveledUpNames = []) {
    // A beat of delay before the screen takes over, so the killing blow
    // still reads before everything dims — the log (and its tabs) stay
    // live throughout via _dimBattlefieldForPostCombat, so nothing here
    // needs to render before then.
    this.time.delayedCall(1000, () => this._renderVictoryScreen(title, xpSummary, progressReward, loot, leveledUpNames));
  }

  _renderVictoryScreen(title, xpSummary, progressReward, loot, leveledUpNames) {
    this._dimBattlefieldForPostCombat();
    const { width, height } = this.sys.game.canvas;

    // Victory title
    this.add.text(width / 2, height / 2 - 130, title, {
      fontSize: '48px',
      color: '#ffffff',
      fontStyle: 'bold'
    }).setOrigin(0.5).setDepth(2001);

    let cursorY = height / 2 - 65;

    // XP summary list
    xpSummary.forEach(line => {
      this.add.text(width / 2, cursorY, line, {
        fontSize: '18px', color: '#ffff66'
      }).setOrigin(0.5).setDepth(2001);
      cursorY += 24;
    });

    // Hunt Ticket reward (first completion only)
    if (progressReward?.firstCompletion && progressReward.huntTicketsEarned > 0) {
      cursorY += 6;
      this.add.text(width / 2, cursorY,
        `+${progressReward.huntTicketsEarned} Hunt Tickets  (Total: ${progressReward.huntTicketsTotal})`, {
          fontSize: '18px', color: '#ffe066', fontStyle: 'bold'
        }).setOrigin(0.5).setDepth(2001);
      cursorY += 28;
    }

    // Loot section — only shown if there are droppable items
    if (loot.length > 0) {
      cursorY += 10;
      this.add.text(width / 2, cursorY, '— Loot —', {
        fontSize: '16px', color: '#aaaaaa', fontStyle: 'italic'
      }).setOrigin(0.5).setDepth(2001);
      cursorY += 22;

      loot.forEach(inst => {
        const rarity = inst.rarity || 'common';
        const color = RARITY_COLORS[rarity] || '#cccccc';
        const rarityLabel = rarity.charAt(0).toUpperCase() + rarity.slice(1);
        // Show item type/slot + rarity; full name revealed now that it's in your inventory
        const base = Items[inst.id];
        const slotLabel = base?.slot ? `(${base.slot})` : '';
        const displayName = inst.displayName || base?.name || inst.id;
        this.add.text(width / 2, cursorY, `${displayName} ${slotLabel}  [${rarityLabel}]`, {
          fontSize: '16px', color
        }).setOrigin(0.5).setDepth(2001);
        cursorY += 22;
      });
    }

    // Return button — anchored below all content with some breathing room
    const btnY = Math.max(cursorY + 30, height / 2 + 120);
    createButton(this, width / 2, btnY, 'Return to Camp', () => {
      this._reviveKnockedOutParty();
      this.scene.stop('CombatScene');
      this.scene.wake('TownScene');
      this.scene.wake('UIScene');
      // Belt-and-suspenders: UIScene's own 'wake' listener already calls
      // this, but force it explicitly too so the left party panel's HP/MP/XP
      // bars are guaranteed to reflect this fight's damage immediately.
      this.scene.get('UIScene')?.refreshUI();
      // HuntHubOverlay was stopped (not slept) before combat — see
      // HuntEncounterOverlay._engage() — so it's relaunched fresh here
      // rather than woken. Its render reads live state from HuntManager,
      // so a fresh launch picks the hunt back up correctly.
      if (this.isHunt) {
        this.scene.launch('HuntHubOverlay');
        this.scene.bringToTop('UIScene'); // keep the persistent banners/panel above the Hub
      }
    }, 'primary', { fontSize: '24px' }).setDepth(2001);
  }

  _showDefeatScreen(title = 'Defeat', subtitle = '', opts = {}) {
    // Same beat-of-delay treatment as victory — see _showVictoryScreen.
    this.time.delayedCall(1000, () => this._renderDefeatScreen(title, subtitle, opts));
  }

  _renderDefeatScreen(title, subtitle, opts = {}) {
    const { showRetry = this.isTraining, showExit = true } = opts;
    const { width, height } = this.sys.game.canvas;

    this._dimBattlefieldForPostCombat();

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
      const btn = createButton(this, x, height / 2 + 80, label, () => {
        btn.disableInteractive();
        onClick();
      }, 'primary', { fontSize: '24px' });
      btn.setDepth(3001);
      return btn;
    };

    const buttons = [];
    const spacing = 160;
    if (showRetry) buttons.push(makeBtn('[ Try Again ]', width / 2 - (showExit ? spacing / 2 : 0), () => {
      // Restart same scenario. Party already restored to full in _onCombatDefeat.
      this.scene.restart({ party: this.partyData, mode: 'pit', scenarioId: this.scenarioId });
    }));
    if (showExit) buttons.push(makeBtn('[ Exit ]', width / 2 + (showRetry ? spacing / 2 : 0), () => {
      this._reviveKnockedOutParty();
      this.scene.stop('CombatScene');
      if (this.isHunt) {
        // The hunt already ended in _onCombatDefeat() — close the Hub
        // properly (re-enables Town input) instead of waking it.
        this.scene.get('HuntHubOverlay')?._close();
      }
      this.scene.wake('TownScene');
      this.scene.wake('UIScene');
      this.scene.get('UIScene')?.refreshUI(); // drop the now-Slain party members from the panel immediately
    }));

    // If something else tries to rebuild UI, hide it now
    this.actionMenu?.setVisible(false);
    this.endTurnButton?.setVisible(false);
  }



  _addExitButton() {
    createButton(this, 400, 400, 'Exit Training', () => {
      this._reviveKnockedOutParty();
      this.scene.stop('CombatScene');
      this.scene.wake('TownScene');
      this.scene.wake('UIScene');
    }, 'danger').setDepth(UI_DEPTH.overlay);
  }

  _reviveKnockedOutParty() {
    // Ensure no party member exits combat with 0 HP — they get 1 HP minimum.
    GameState.party.forEach(char => {
      if ((char.currentHP ?? 0) <= 0 || char.status === 'incapacitated') {
        char.currentHP = 1;
        char.status = 'alive';
      }
    });
  }

  _placePortrait(char, slot) {
    this._clearPortrait(slot); // Remove old visuals

    // Was unconditionally resetting to plain white here — that's correct for
    // initial placement (no turn in progress yet), but wiping the border on
    // every re-placement also wiped out the current-turn highlight the
    // instant that character moved to a new slot mid-turn (_moveUnitToSlot
    // calls this), even though it was still their turn. Recompute properly
    // instead, so the light-blue highlight survives a move.
    this._clearSlotHighlights?.();

    // Sprite is purely visual — the slot CONTAINER handles all clicks.
    const sprite = this.add.image(0, 0, char.skin).setDisplaySize(64, 64);

    // The slot container keeps its Rectangle(-32,-32,64,64) geometry from _createBattleSlots.
    // Just swap the listener so clicking shows character info.
    slot.removeAllListeners();
    this._wireSlotInfoClick(slot, char);

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
    this.tooltip = null;
  }


  _currentChar() {
    return this.turnOrder[this.currentTurnIndex];
  }
}
