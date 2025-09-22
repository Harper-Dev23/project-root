// src/systems/CharacterBuilder.js
import { isItemInstance } from './ItemFactory.js';
import { SKILLS } from '../../data/skills.js';
import { Items } from '../../data/items.js';
import GameState from './GameState.js';
import { getItemComputedData } from './ItemFactory.js';
// --- Constants ------------------------------------------------
export const RACE_BONUSES = {
  Human: { STR: 1, DEX: 1, CON: 1, INT: 1, WIS: 1, CHA: 1 },
  Dwarf: { STR: 2, CON: 2, DEX: -1 },
  Elf: { DEX: 2, INT: 1, CON: -1 },
  Ferrow: { DEX: 2, WIS: 1, STR: -1 },
  Wylett: { DEX: 1, WIS: 2, CHA: -1 },
  Skith: { DEX: 2, INT: 1, CHA: -1 }
};

//export const RACE_MOVES = {
//  Human: { range: 1, cooldown: 2, name: 'Tactical Reposition' },
//  Dwarf: { range: 1, cooldown: 2, name: 'Stone Step' },
//  Elf: { range: 1, cooldown: 2, name: 'Feystride' },
//  Ferrow: { range: 2, cooldown: 3, name: 'Gust Shift' },
//  Wylett: { range: 2, cooldown: 3, name: 'Briar Dash' },
//  Skith: { range: 2, cooldown: 3, name: 'Scale Slide' }
//};

export const CLASS_BONUSES = {
  Beggar: { DEX: 1, CON: 1 },
  Acolyte: { WIS: 2, CHA: 1 },
  Performer: { CHA: 2, DEX: 1 },
  Grunt: { STR: 2, CON: 1 },
  Scholar: { INT: 2, WIS: 1 },
  Shepherd: { WIS: 1, DEX: 1 }
};

// --- Helpers --------------------------------------------------
function mergeStats(base, bonus) {
  const out = { ...base };
  for (const key in bonus) {
    out[key] = (out[key] || 0) + bonus[key];
  }
  return out;
}

function getStartingSkills(baseClass) {
  const ids = ['basic_attack'];
  if (baseClass === 'Scholar') ids.push('fireball');
  return ids;
}

export function getUnlockedWeaponSkills(stats) {
  const skills = [];
  if (stats.DEX >= 10) skills.push('Feinting Jab');
  if (stats.DEX >= 15) skills.push('Barbed Arrow');
  if (stats.STR >= 10) skills.push('Bonecrusher');
  if (stats.INT >= 10) skills.push('Scorching Ray');
  return skills;
}

export function getRacialTraits(race) {
  const traits = {
    Human: ['Adaptive Reflexes', 'Tactical Reposition'],
    Dwarf: ['Stonebound Resolve', 'Stone Step'],
    Elf: ['Graceful Deflection', 'Feystride'],
    Ferrow: ['Skyborn Reflex', 'Gust Shift'],
    Wylett: ['Wild Instincts', 'Briar Dash'],
    Skith: ['Molten Reflex', 'Scale Slide']
  };
  return traits[race] || [];
}

export function calculateDerivedStats(stats) {
  // === Persistent, pre-combat derived snapshot ===
  const maxHP = Math.max(1, (stats.CON || 0) * 5);

  // MaxMP = 2*INT + CHA + WIS (generous on purpose; rebalance later)
  const maxMP = Math.max(0, 2 * (stats.INT || 0) + (stats.CHA || 0) + (stats.WIS || 0));

  // DEX no longer grants Evasion; Initiative now tied to CHA
  const Accuracy = Math.round((stats.DEX || 0) * 2);
  const Evasion = 0;                // base is 0; runtime only via buffs/gear/weaknesses
  const Initiative = Math.round((stats.CHA || 0) * 1);

  // Crit chance uses STR+DEX+INT equally; higher baseline
  const tri = (stats.STR || 0) + (stats.DEX || 0) + (stats.INT || 0);
  const CritChance = Math.max(0, Math.min(100, Math.round(5 + 0.30 * tri)));
  const CritMult = 1.5;

  // Resists (CHA contributes to Elemental as requested)
  const ElementalResist = Math.round(((stats.WIS || 0) * 0.5) + ((stats.CHA || 0) * 0.5));
  const PhysicalResist = Math.round((stats.CON || 0) * 0.5);
  const CritAvoid = Math.round((stats.WIS || 0) * 0.5);

  return {
    maxHP, maxMP,
    Accuracy, Evasion,
    CritChance, CritMult, CritAvoid,
    ElementalResist, PhysicalResist,
    Initiative,
    ActionPoints: 1,
    BonusActions: 1,
    ReactionPoints: 1,
    ClassAction: 1
  };
}


function generateUniqueId() {
  return 'char_' + Math.random().toString(36).slice(2, 10);
}

// --- Main Build Function --------------------------------------
export function buildCharacter({ name, race, baseClass, stats, skin }) {
  const raceBonus = RACE_BONUSES[race] || {};
  const classBonus = CLASS_BONUSES[baseClass] || {};
  const totalStats = mergeStats(mergeStats({ ...stats }, raceBonus), classBonus);
  const derived = calculateDerivedStats(totalStats);
  const maxHP = derived.maxHP || 1;
  const maxMP = derived.maxMP || 0;
  // === Movement mapping -> skill ids (used by skills: [] below)
  const RACE_MOVE_SKILL_ID = {
    Human: 'move_step',
    Dwarf: 'move_step',
    Elf: 'move_step',
    Ferrow: 'move_dash',
    Wylett: 'move_dash',
    Skith: 'move_dash'
  };
  const startingSkillIds = getStartingSkills(baseClass);
  const movementId = RACE_MOVE_SKILL_ID[race];


  return {
    id: generateUniqueId(),
    name,
    race,
    baseClass,
    specialization: null,
    level: 1,
    experience: 0,
    favor: 0,
    tribe: null,
    skin: skin || `${race.toLowerCase()}_portrait_1`,

    skills: [
      // racial movement as a NORMAL skill from SKILLS
      ...(movementId && SKILLS[movementId] ? [{
        ...SKILLS[movementId],
        id: movementId
      }] : []),

      // base class starters
      ...startingSkillIds.map(id => {
        const skill = SKILLS[id];
        return {
          ...skill,
          id,
          requiresTarget: skill?.requiresTarget ?? false,
          targetRequirement: skill?.targetRequirement ?? null
        };
      })
    ],

    cooldowns: {},
    baseStats: { ...stats },
    totalStats,
    derived,
    maxHP,
    maxMP,
    currentHP: maxHP,
    currentMP: maxMP,
    initiative: derived.Initiative,

    statusResist: { fear: 0, charm: 0, poison: 0, stun: 0 },
    healing: { received: 1.0, given: 1.0 },

    modifiers: {
      race: raceBonus,
      class: classBonus,
      gear: {}
    },

    weaponSkills: getUnlockedWeaponSkills(totalStats),
    racialTraits: getRacialTraits(race),
    classTalents: [],
    specializationTalents: [],

    weaponType: null,
    weapon: null,
    equipment: {
      weaponMain: null,
      weaponOff: null,
      head: null,
      chest: null,
      legs: null,
      gloves: null,
      boots: null,
      ring: null,
      amulet: null
    },
    inventory: [],

    location: { x: 0, y: 0 },
    status: "alive"
  };
}

function toInstance(entry, character) {
  if (!entry) return null;
  if (isItemInstance(entry)) return entry;

  // Try to resolve to an existing instance from inventories first (stable affixes/IDs)
  const id = typeof entry === 'string' ? entry : entry.id;
  const fromChar = (character?.inventory || []).find(it => isItemInstance(it) && it.id === id);
  if (fromChar) return fromChar;
  const fromGlobal = (GameState?.inventory || []).find(it => isItemInstance(it) && it.id === id);
  if (fromGlobal) return fromGlobal;

  // Last resort: mint a minimal instance (no random re-rolls beyond your factory rules)
  return createItemInstance(id);
}

export function equipItem(character, item, slot) {
  // Normalize the incoming item to a proper instance
  const inst = toInstance(item, character);
  if (!inst) {
    console.warn('equipItem: unable to resolve item to an instance', item);
    return character;
  }

  const baseItem = Items[inst.id];
  if (!baseItem) {
    console.warn(`Item ${inst.id} not found`);
    return character;
  }

  const isWeapon = baseItem.type === 'weapon';
  const isArmor = ['chest', 'boots', 'gloves', 'head', 'legs', 'ring', 'amulet'].includes(baseItem.slot);
  if (!isWeapon && !isArmor) {
    console.warn(`${inst.id} is not equipable`);
    return character;
  }

  // Clone to avoid mutating the original
  const updated = {
    ...character,
    equipment: { ...(character.equipment || {}) },
    inventory: [...(character.inventory || [])]
  };

  // Helper: normalize any equipped entry before pushing back to inventory
  const pushBackToInventory = (eqEntry) => {
    if (!eqEntry) return;
    const eqInst = toInstance(eqEntry, character);
    if (eqInst) updated.inventory.push(eqInst);
  };

  // === WEAPON LOGIC ===
  if (isWeapon) {
    if (slot === 'weaponOff') {
      if (baseItem.hands === 2) {
        console.warn('Cannot equip a two-handed weapon in the off-hand');
        return character;
      }
      const mainEntry = updated.equipment.weaponMain;
      const mainBase = mainEntry ? Items[toInstance(mainEntry, character).id] : null;
      if (mainBase?.hands === 2) {
        console.warn('Cannot equip off-hand while main hand holds a two-handed weapon');
        return character;
      }
    }

    // If something is already in the target slot, move it back to inventory
    if (updated.equipment[slot]) {
      pushBackToInventory(updated.equipment[slot]);
    }

    // If equipping a 2H in main, clear off-hand to inventory
    if (slot === 'weaponMain' && baseItem.hands === 2 && updated.equipment.weaponOff) {
      pushBackToInventory(updated.equipment.weaponOff);
      updated.equipment.weaponOff = null;
    }

    updated.equipment[slot] = inst;
  }

  // === ARMOR LOGIC ===
  if (isArmor) {
    const armorSlot = baseItem.slot;
    if (updated.equipment[armorSlot]) {
      pushBackToInventory(updated.equipment[armorSlot]);
    }
    updated.equipment[armorSlot] = inst;
  }

  // Remove the equipped instance from both inventories (by instanceId)
  updated.inventory = updated.inventory.filter(it => it.instanceId !== inst.instanceId);
  GameState.inventory = (GameState.inventory || []).filter(it => it.instanceId !== inst.instanceId);

  // Recalculate stats after equipping
  return rebuildCharacterStats(updated);
}

export function resetCombatMods(character) {
  character.combatMods = {
    Accuracy: 0, Evasion: 0, Initiative: 0,
    CritChance: 0, CritMult: 0,
    ElementalResist: 0, PhysicalResist: 0, CritAvoid: 0
  };
}

export function applyLevelUp(char) {
  // Example growth formula — tweak as needed
  char.maxHP += 5;
  char.maxMP += 2;
  char.currentHP = char.maxHP;
  char.currentMP = char.maxMP;
}

export function rebuildCharacterStats(character) {
  const raceBonus = RACE_BONUSES[character.race] || {};
  const classBonus = CLASS_BONUSES[character.baseClass] || {};
  const baseStatPoints = character.baseStats || {}; // stored allocations

  // Combine raw stats
  let total = mergeStats(baseStatPoints, raceBonus);
  total = mergeStats(total, classBonus);

  // Equipment bonuses (base + instance affixes; rarity-aware)
  const equipped = character.equipment || {};
  for (const slot in equipped) {
    const inst = equipped[slot];
    if (!inst) continue;

    // Works whether 'inst' is a string id or a full instance object
    const view = getItemComputedData(inst);

    // view.bonuses is the merged result of base item + instance mods
    if (view?.bonuses) {
      total = mergeStats(total, view.bonuses);
    }
  }

  character.totalStats = total;

  const prevMaxHP = character.maxHP || 1;
  const prevMaxMP = character.maxMP || 0;
  const prevHP = character.currentHP ?? prevMaxHP;
  const prevMP = character.currentMP ?? prevMaxMP;
  const hpRatio = Math.max(0, Math.min(1, prevHP / Math.max(1, prevMaxHP)));
  const mpRatio = (prevMaxMP > 0) ? Math.max(0, Math.min(1, prevMP / prevMaxMP)) : 0;

  const d = calculateDerivedStats(total);
  character.derived = d;               // single source of baseline truth
  character.maxHP = d.maxHP;
  character.maxMP = d.maxMP;
  character.currentHP = Math.max(0, Math.min(d.maxHP, Math.round(d.maxHP * hpRatio)));
  character.currentMP = Math.max(0, Math.min(d.maxMP, Math.round(d.maxMP * mpRatio)));
  character.initiative = d.Initiative;

  // Runtime-only modifiers (do NOT persist; reset each combat)
  if (!character.combatMods) character.combatMods = {
    Accuracy: 0, Evasion: 0, Initiative: 0,
    CritChance: 0, CritMult: 0,
    ElementalResist: 0, PhysicalResist: 0, CritAvoid: 0
  };

  return character;

}
