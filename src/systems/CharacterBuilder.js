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


  const instanceId = generateUniqueId();
  return {
    id: instanceId,
    instanceId,  // PartyManagementScene and save/load both rely on this field
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

  const gearDerived = {};
  const gearEffects = {
    mpPerTurn: 0,
    skillCostReductionPct: 0,
    globalDamagePercent: 0,
    elementalDamagePercent: 0,
    necroticDamagePercent: 0,
    resilience: 0,
    weaponBuildupPercent: {},
    // Jewelry passives
    physToElemPercent: 0,
    physToNecroPercent: 0,
    elemToNecroPercent: 0,
    initBonusOnBattleStart: 0,
    shieldPctOnBattleStart: 0,
    physBuildupOnPhysDmg: {},
    elemBuildupOnElemDmg: {},
    procDoubleDamage: 0,
    procHalfDamageTaken: 0,
    procHealOnHeal: 0,
    procElemFlat: 0,
    procNecroFlat: 0,
    procPhysFlat: 0,
  };

  // Track skill grants from equipped jewelry
  const grantedSkillIds = new Set();

  // Equipment bonuses (base + instance affixes; rarity-aware)
  const equipped = character.equipment || {};
  for (const slot in equipped) {
    const inst = equipped[slot];
    if (!inst) continue;


    const view = getItemComputedData(inst);


    if (view?.bonuses) {
      total = mergeStats(total, view.bonuses);
    }

    if (view?._derivedMods) {
      for (const [k, v] of Object.entries(view._derivedMods)) {
        gearDerived[k] = (gearDerived[k] || 0) + v;
      }
    }

    if (view?._miscMods) {
      const misc = view._miscMods;
      if (misc.mpPerTurn) gearEffects.mpPerTurn += misc.mpPerTurn;
      if (misc.skillCostReductionPct) gearEffects.skillCostReductionPct += misc.skillCostReductionPct;
      if (misc.globalDamagePercent) gearEffects.globalDamagePercent += misc.globalDamagePercent;
      if (misc.elementalDamagePercent) gearEffects.elementalDamagePercent += misc.elementalDamagePercent;
      if (misc.necroticDamagePercent) gearEffects.necroticDamagePercent += misc.necroticDamagePercent;
      if (misc.resilience) gearEffects.resilience += misc.resilience;
      if (misc.buildupPercent) {
        for (const [fam, amt] of Object.entries(misc.buildupPercent)) {
          gearEffects.weaponBuildupPercent[fam] = (gearEffects.weaponBuildupPercent[fam] || 0) + amt;
        }
      }
      // Jewelry misc mods
      if (misc.physToElemPercent) gearEffects.physToElemPercent += misc.physToElemPercent;
      if (misc.physToNecroPercent) gearEffects.physToNecroPercent += misc.physToNecroPercent;
      if (misc.elemToNecroPercent) gearEffects.elemToNecroPercent += misc.elemToNecroPercent;
      if (misc.initBonusOnBattleStart) gearEffects.initBonusOnBattleStart += misc.initBonusOnBattleStart;
      if (misc.shieldPctOnBattleStart) gearEffects.shieldPctOnBattleStart += misc.shieldPctOnBattleStart;
      if (misc.procDoubleDamage) gearEffects.procDoubleDamage += misc.procDoubleDamage;
      if (misc.procHalfDamageTaken) gearEffects.procHalfDamageTaken += misc.procHalfDamageTaken;
      if (misc.procHealOnHeal) gearEffects.procHealOnHeal += misc.procHealOnHeal;
      if (misc.procElemFlat) gearEffects.procElemFlat += misc.procElemFlat;
      if (misc.procNecroFlat) gearEffects.procNecroFlat += misc.procNecroFlat;
      if (misc.procPhysFlat) gearEffects.procPhysFlat += misc.procPhysFlat;
      if (misc.physBuildupOnPhysDmg) {
        for (const [fam, amt] of Object.entries(misc.physBuildupOnPhysDmg)) {
          gearEffects.physBuildupOnPhysDmg[fam] = (gearEffects.physBuildupOnPhysDmg[fam] || 0) + amt;
        }
      }
      if (misc.elemBuildupOnElemDmg) {
        for (const [fam, amt] of Object.entries(misc.elemBuildupOnElemDmg)) {
          gearEffects.elemBuildupOnElemDmg[fam] = (gearEffects.elemBuildupOnElemDmg[fam] || 0) + amt;
        }
      }
    }

    // Collect granted skills from equipped jewelry
    if (view?.grantsSkills) {
      view.grantsSkills.forEach(skillId => grantedSkillIds.add(skillId));
    }
  }

  character.totalStats = total;

  const prevMaxHP = character.maxHP || 1;
  const prevMaxMP = character.maxMP || 0;
  const prevHP = character.currentHP ?? prevMaxHP;
  const prevMP = character.currentMP ?? prevMaxMP;
  const hpRatio = Math.max(0, Math.min(1, prevHP / Math.max(1, prevMaxHP)));
  const mpRatio = (prevMaxMP > 0) ? Math.max(0, Math.min(1, prevMP / prevMaxMP)) : 0;

  const baseDerived = calculateDerivedStats(total);
  const d = { ...baseDerived };
  for (const [k, v] of Object.entries(gearDerived)) {
    d[k] = (d[k] || 0) + v;
  }

  character.derived = d;               // single source of baseline truth
  character.maxHP = d.maxHP;
  character.maxMP = d.maxMP;
  character.currentHP = Math.max(0, Math.min(d.maxHP, Math.round(d.maxHP * hpRatio)));
  character.currentMP = Math.max(0, Math.min(d.maxMP, Math.round(d.maxMP * mpRatio)));
  character.initiative = d.Initiative;

  character.modifiers = character.modifiers || {};
  character.modifiers.gear = {
    stats: {},
    derived: { ...gearDerived },
    misc: {
      mpPerTurn: gearEffects.mpPerTurn,
      skillCostReductionPct: gearEffects.skillCostReductionPct,
      globalDamagePercent: gearEffects.globalDamagePercent,
      elementalDamagePercent: gearEffects.elementalDamagePercent,
      necroticDamagePercent: gearEffects.necroticDamagePercent,
      resilience: gearEffects.resilience,
      weaponBuildupPercent: { ...gearEffects.weaponBuildupPercent }
    }
  };

  character.gearEffects = {
    mpPerTurn: gearEffects.mpPerTurn,
    skillCostReductionPct: gearEffects.skillCostReductionPct,
    globalDamagePercent: gearEffects.globalDamagePercent,
    elementalDamagePercent: gearEffects.elementalDamagePercent,
    necroticDamagePercent: gearEffects.necroticDamagePercent,
    resilience: gearEffects.resilience,
    weaponBuildupPercent: { ...gearEffects.weaponBuildupPercent },
    // Jewelry passives — read by CombatScene for battle-start effects and proc rolls
    physToElemPercent: gearEffects.physToElemPercent,
    physToNecroPercent: gearEffects.physToNecroPercent,
    elemToNecroPercent: gearEffects.elemToNecroPercent,
    initBonusOnBattleStart: gearEffects.initBonusOnBattleStart,
    shieldPctOnBattleStart: gearEffects.shieldPctOnBattleStart,
    physBuildupOnPhysDmg: { ...gearEffects.physBuildupOnPhysDmg },
    elemBuildupOnElemDmg: { ...gearEffects.elemBuildupOnElemDmg },
    procDoubleDamage: gearEffects.procDoubleDamage,
    procHalfDamageTaken: gearEffects.procHalfDamageTaken,
    procHealOnHeal: gearEffects.procHealOnHeal,
    procElemFlat: gearEffects.procElemFlat,
    procNecroFlat: gearEffects.procNecroFlat,
    procPhysFlat: gearEffects.procPhysFlat,
  };
  character.resilience = gearEffects.resilience || 0;

  // Sync equipment-granted skills into char.skills.
  // Strip any previously granted item skills, then re-add from current gear.
  const baseSkills = (character.skills || []).filter(s => !s._fromItem);
  const itemSkillEntries = Array.from(grantedSkillIds).map(id => ({
    id,
    type: 'special',
    _fromItem: true,
  }));
  character.skills = [...baseSkills, ...itemSkillEntries];

  // Runtime-only modifiers (do NOT persist; reset each combat)
  if (!character.combatMods) character.combatMods = {
    Accuracy: 0, Evasion: 0, Initiative: 0,
    CritChance: 0, CritMult: 0,
    ElementalResist: 0, PhysicalResist: 0, CritAvoid: 0
  };

  return character;

}
