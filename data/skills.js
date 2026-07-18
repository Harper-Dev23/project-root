// @ts-nocheck
// data/skills.js
import { calculateDamage, calculateDualWieldDamage } from '../src/systems/CombatLogic.js';
import { calculateFireballDamage } from '../src/systems/CombatLogic.js';
import { Items } from './items.js';
import {
  applyDamageModifiers, applyTypedDamageModifiers, scaleTypedDamage, _pushBreakdown,
  findRewardIfWeakRule, applyDamagePctBonus, getDamageReductionFraction,
  calculateHealRoll, applyHealModifiers,
} from '../src/systems/CombatLogic.js';
import { weaknessIntensityMult, weaknessTierFromMeter, weaknessDecayAmount, WeaknessV3 } from '../src/systems/StatusEffects.js';
import { DevFlags } from '../src/systems/DevFlags.js';
import { resolveAOESplash } from '../src/systems/aoeResolver.js';


const cloneBuffStruct = (buff) => (buff ? { ...buff } : undefined);
const cloneRewardStruct = (reward) => (reward ? {
  ...reward,
  buff: cloneBuffStruct(reward.buff),
  debuff: cloneBuffStruct(reward.debuff)
} : undefined);
const cloneRewardList = (list) => (Array.isArray(list) ? list.map(rule => ({
  ...rule,
  buff: cloneBuffStruct(rule.buff),
  debuff: cloneBuffStruct(rule.debuff)
})) : undefined);
// rewardIfWeak accepts either a single rule or an array of per-tier rules
// (e.g. a weaker T1 case and a stronger T2 case for the same family).
const cloneRewardOrList = (reward) => (
  Array.isArray(reward) ? cloneRewardList(reward) : cloneRewardStruct(reward)
);
const cloneArray = (arr) => (Array.isArray(arr) ? [...arr] : undefined);

/**
 * Adds one rhythm_stack statusEffect to char (max 3), and refreshes ALL existing
 * rhythm stacks to 2 turns so they don't expire mid-combo.
 * Each stack carries mods: { AttackPower: 5 } which flows through _sumStatusEffectMods automatically.
 * stackable: true lets combineStatusEffects (statusEffectIcons.js) collapse the
 * separate array entries into a single icon with a "×N" badge instead of N
 * duplicate icons.
 */
export function applyRhythmStack(char) {
  if (!char) return;
  char.statusEffects = char.statusEffects || [];
  const existing = char.statusEffects.filter(se => se?.id === 'rhythm_stack');
  existing.forEach(se => { se.turns = 2; }); // always refresh duration on all stacks
  if (existing.length < 3) {
    char.statusEffects.push({ id: 'rhythm_stack', turns: 2, stackable: true, mods: { AttackPower: 5 } });
  }
}

/**
 * dislodgeLodges(target, scene, count?)
 * Removes up to `count` lodged arrows from target.statusEffects and returns damage/effects.
 * Each lodge has an optional scalingBonus (e.g. 0.10 = +10% per additional lodge on target).
 * Only the lodge with that field benefits from it — other lodges deal flat baseDamage.
 * Hunter's Mark on target amplifies all lodge damage by +25%.
 */
function dislodgeLodges(target, scene, count = Infinity) {
  if (!target) return { totalDamage: 0, lacerateBuildup: 0, dislodged: 0 };
  const allLodges = (target.statusEffects || []).filter(se => se?.id === 'lodged');
  const toRemove = isFinite(count) ? allLodges.slice(0, count) : allLodges;
  if (toRemove.length === 0) return { totalDamage: 0, lacerateBuildup: 0, dislodged: 0 };

  const totalLodges = allLodges.length;
  const huntersMark = (target.statusEffects || []).find(se => se?.id === 'hunters_mark' && (se.turns || 0) > 0);
  const markBonus = huntersMark ? 1.25 : 1.0;

  let totalDamage = 0;
  let lacerateBuildup = 0;
  for (const lodge of toRemove) {
    const additionalLodges = totalLodges - 1;
    const scale = lodge.scalingBonus ? (1 + lodge.scalingBonus * additionalLodges) : 1;
    totalDamage += Math.floor((lodge.baseDamage || 0) * scale * markBonus);
    if (lodge.lacerateOnDislodge) lacerateBuildup += lodge.lacerateOnDislodge;
  }

  const removeSet = new Set(toRemove);
  target.statusEffects = (target.statusEffects || []).filter(se => !removeSet.has(se));
  if (scene) {
    scene.lodgesDislodgedThisTurn = (scene.lodgesDislodgedThisTurn || 0) + toRemove.length;
    scene._refreshLodgeSprites?.(target);
  }
  return { totalDamage, lacerateBuildup, dislodged: toRemove.length };
}

/** Returns the active runic_zone statusEffect on a character, or undefined. */
function getRunicZone(char) {
  return (char?.statusEffects || []).find(se => se?.id === 'runic_zone' && (se.turns || 0) > 0);
}

const SWORD_CHAIN_STATUS_KEY = 'sword_rhythm_window';
const SWORD_RECENT_HIT_KEY = 'sword_recent_hit';
const WHIP_CHAIN_STATUS_KEY = 'whip_chain_state';
const ensureStatusBucket = (unit) => {
  if (!unit) return null;
  if (!unit.statuses || typeof unit.statuses !== 'object') unit.statuses = {};
  return unit.statuses;
};
const markSword1hUse = (unit, abilityId) => {
  const bucket = ensureStatusBucket(unit);
  if (!bucket) return;
  bucket[SWORD_CHAIN_STATUS_KEY] = {
    ...(bucket[SWORD_CHAIN_STATUS_KEY] || {}),
    weapon: 'sword_1h',
    lastAbility: abilityId || null,
    turns: 2,
  };
};
const hasSword1hChainReady = (unit) => {
  const marker = unit?.statuses?.[SWORD_CHAIN_STATUS_KEY];
  return !!(marker && (marker.turns | 0) > 0);
};
const markSword1hHit = (target, attacker, abilityId) => {
  if (!target) return;
  const bucket = ensureStatusBucket(target);
  if (!bucket) return;
  bucket[SWORD_RECENT_HIT_KEY] = {
    ...(bucket[SWORD_RECENT_HIT_KEY] || {}),
    weapon: 'sword_1h',
    lastAbility: abilityId || null,
    lastAttackerId: attacker?.id || attacker?.name || null,
    turns: 2,
  };
};
const targetRecentlyHitBySword1h = (target, attacker) => {
  const marker = target?.statuses?.[SWORD_RECENT_HIT_KEY];
  if (!marker) return false;
  if ((marker.turns | 0) <= 0) return false;
  if (attacker && marker.lastAttackerId && marker.lastAttackerId !== (attacker.id || attacker.name)) {
    return false;
  }
  return true;
};

const markWhipUse = (unit) => {
  const bucket = ensureStatusBucket(unit);
  if (!bucket) return 0;
  const prev = bucket[WHIP_CHAIN_STATUS_KEY];
  const count = prev && (prev.turns | 0) > 0 ? (prev.count || 0) + 1 : 1;
  bucket[WHIP_CHAIN_STATUS_KEY] = { turns: 2, count };
  return count;
};

const getWhipChainCount = (unit) => {
  const marker = unit?.statuses?.[WHIP_CHAIN_STATUS_KEY];
  if (!marker || (marker.turns | 0) <= 0) return 0;
  return marker.count || 0;
};

function normalizeSkillEntry(id, skill = {}) {
  const normalized = {
    ...skill,
    id: skill.id ?? id,
    tags: cloneArray(skill.tags),
    requiredWeapon: cloneArray(skill.requiredWeapon),
    positionRequirement: cloneArray(skill.positionRequirement),
    consumeWeakness: cloneArray(skill.consumeWeakness),
    applyWeakness: cloneArray(skill.applyWeakness),
    buildupHint: skill.buildupHint ? { ...skill.buildupHint } : undefined,
    aoe: skill.aoe ? { ...skill.aoe } : undefined,
    move: skill.move ? { ...skill.move } : undefined,
    rewardIfWeak: cloneRewardOrList(skill.rewardIfWeak),
    rewardIfTargetHas: cloneRewardStruct(skill.rewardIfTargetHas),
    rewardIfSelfHas: cloneRewardStruct(skill.rewardIfSelfHas),
    rewards: cloneRewardList(skill.rewards),
    transformWeakness: skill.transformWeakness ? { ...skill.transformWeakness } : undefined,
    triggers: cloneArray(skill.triggers)
  };

  return normalized;
}

function buildSkillRegistry(skillDefs = {}) {
  const registry = {};
  for (const [id, skill] of Object.entries(skillDefs)) {
    registry[id] = normalizeSkillEntry(id, skill);
  }
  return registry;
}

// Initialized upfront so downstream code can safely reference SKILLS before it is populated.
export const SKILLS = {};

export const SkillTypes = ['weapon', 'class', 'reaction', 'special'];
export const ActionTypes = ['major', 'bonus', 'class', 'reaction'];



export function getWeaponSkillsFor(char) {
  const unlocked = [];

  for (const [id, skill] of Object.entries(SKILLS)) {
    if (skill.type !== 'weapon') continue;
    if (skill.enemyOnly) continue;
    if (skill.disabled) continue;

    // ? Unify stat key case
    const statKey = skill.requiredStat?.toUpperCase();
    const statVal = statKey ? (char.totalStats?.[statKey] || 0) : null;

    if (skill.requiredStat && statVal < skill.requiredValue && !DevFlags.isBreakthroughEnabled()) continue;

    // ? Normalize weapon type check
    const mainType = char.equipment?.weaponMain ? Items[char.equipment.weaponMain]?.weaponType : null;
    const offType = char.equipment?.weaponOff ? Items[char.equipment.weaponOff]?.weaponType : null;

    // Preserve existing char.weaponType behavior
    const equippedType = char.weaponType || mainType;

    // ? Pass if required weapon matches mainType, offType, or equippedType
    if (skill.requiredWeapon?.length > 0) {
      if (!(
        (equippedType && skill.requiredWeapon.includes(equippedType)) ||
        (mainType && skill.requiredWeapon.includes(mainType)) ||
        (offType && skill.requiredWeapon.includes(offType))
      )) {
        continue;
      }
    }

    unlocked.push({ id, ...skill });
  }

  return unlocked;
}

export function getClassSkillsFor(char) {
  const out = [];
  const base = (char.baseClass || char.class || '').toLowerCase();

  // map base class -> allowed class skills
  const allowed = {
    beggar: ['hide'],
    acolyte: ['blessing'],
    shepherd: ['watch_over'],
    grunt: ['blockade'],
    performer: ['musical_memory'],
    scholar: ['meditate']
  }[base] || [];

  for (const id of allowed) {
    const skill = SKILLS[id];
    if (!skill) continue;
    if (skill.enemyOnly) continue;
    if (skill.disabled) continue;
    out.push({ id, ...skill });
  }
  return out;
}

export function getReactionSkillsFor(char) {
  const out = [];
  if (!char) return out;

  const mainType = char.equipment?.weaponMain ? Items[char.equipment.weaponMain]?.weaponType : null;
  const offType = char.equipment?.weaponOff ? Items[char.equipment.weaponOff]?.weaponType : null;
  const equipped = char.weaponType || mainType;

  for (const [id, s] of Object.entries(SKILLS)) {
    if (!s || s.mechanic !== 'reaction') continue;
    if (s.enemyOnly) continue;
    if (s.disabled) continue;

    // stat gate
    if (s.requiredStat && !DevFlags.isBreakthroughEnabled()) {
      const statKey = s.requiredStat.toUpperCase();
      const statVal = char.totalStats?.[statKey] || 0;
      if (statVal < (s.requiredValue || 0)) continue;
    }

    // weapon gate
    if (Array.isArray(s.requiredWeapon) && s.requiredWeapon.length) {
      const ok =
        (equipped && s.requiredWeapon.includes(equipped)) ||
        (mainType && s.requiredWeapon.includes(mainType)) ||
        (offType && s.requiredWeapon.includes(offType));
      if (!ok) continue;
    }

    // position gate (use your same column strings)
    if (Array.isArray(s.positionRequirement) && s.positionRequirement.length) {
      const col = char.position || char._slot?.slotId; // you typically store column on char; slot is fallback
      if (!s.positionRequirement.includes(char.position || 'front')) {
        // If you rely on scene column helper at trigger-time, allow prep anyway.
        // Keep conservative: require listed positions for visibility.
        continue;
      }
    }

    out.push({ id, ...s });
  }

  return out;
}

const RAW_SKILLS = {
  // --- Core Skills ---
  'basic_attack': {
    id: 'basic_attack',
    name: 'Basic Attack',
    type: 'weapon',
    actionCost: 'major',
    mpCost: 0,
    hpCost: 0,
    range: 1,
    positionRequirement: ['front', 'mid', 'back'],
    requiresTarget: true,
    targetRequirement: 'enemy',
    targetColumns: ['front', 'mid', 'back'],
    cooldown: 0,
    apply: (attacker, target) => {
      const mainWeapon = attacker.equipment?.weaponMain ? Items[attacker.equipment.weaponMain] : null;
      const offWeapon = attacker.equipment?.weaponOff ? Items[attacker.equipment.weaponOff] : null;
      const mainIsTwoHand = mainWeapon?.hands === 2;


      if (offWeapon && offWeapon.weaponType !== 'shield' && !mainIsTwoHand) {
        const result = calculateDualWieldDamage(attacker, target);
        const amount = applyDamageModifiers(result.amount, attacker, target);
        return { ...result, amount };
      } else {
        const r = calculateDamage(attacker, target);
        const amount = applyDamageModifiers(r.amount, attacker, target);
        return { ...r, amount };
      }
    },
    description: 'A quick physical strike.',
  },

  // --- Class Skills ---------------------------------------------------------
  'meditate': {
    id: 'meditate', // avoid collision with 'meditate' if you already used it anywhere
    name: 'Meditate',
    type: 'class',
    actionCost: 'class',
    mpCost: 0,
    hpCost: 0,
    requiresTarget: false,
    cooldown: 2,
    description: 'Regain a chunk of MP and clear minor mind effects.',
    apply: (user) => {
      // Simple, safe baseline: restore 20% MP (min 1 if you have MP at all)
      const maxMP = user.maxMP || user.derivedStats?.maxMP || 0;
      if (maxMP > 0) {
        const gain = Math.max(1, Math.floor(maxMP * 0.2));
        user.currentMP = Math.min(maxMP, (user.currentMP || 0) + gain);
      }
      // If you track status flags, clear some here (example only):
      if (user.statuses) {
        delete user.statuses['dazed'];
        delete user.statuses['silenced'];
      }
      return { log: `${user.name} meditates and regains focus.` };
    }
  },

  'hide': {
    id: 'hide',
    name: 'Hide',
    type: 'class',
    actionCost: 'class',
    mpCost: 0,
    hpCost: 0,
    requiresTarget: false,
    cooldown: 3,
    description: 'Beggar: become harder to hit for a short time.',
    apply: (user) => {
      // Keep it minimal: mark a simple flag you can key off in your hit calc.
      user.hidden = { turns: 2 }; // your combat loop should decrement this each round
      return { log: `${user.name} melts into the shadows.` };
    }
  },

  'blessing': {
    id: 'blessing',
    name: 'Blessing',
    type: 'class',
    actionCost: 'class',
    mpCost: 0,
    hpCost: 0,
    requiresTarget: true,
    targetRequirement: 'ally',
    cooldown: 3,
    description: 'Acolyte: buff a single ally with modest accuracy/damage.',
    apply: (user, target) => {
      if (!target) return { log: `${user.name} tries to bless, but finds no target.` };
      target.blessing = { turns: 3, acc: 0.1, dmg: 0.1 };
      return { log: `${user.name} blesses ${target.name}.` };
    }
  },

  'watch_over': {
    id: 'watch_over',
    name: 'Watch Over',
    type: 'class',
    actionCost: 'class',
    mpCost: 0,
    hpCost: 0,
    requiresTarget: true,
    targetRequirement: 'ally',
    cooldown: 3,
    description: 'Shepherd: guard an ally, redirecting some damage for a turn.',
    apply: (user, ally) => {
      if (!ally) return { log: `${user.name} looks for someone to guard.` };
      ally.guardedBy = { id: user.id, turns: 1, reduction: 0.3 }; // you redirect/mitigate in your damage resolver
      return { log: `${user.name} watches over ${ally.name}.` };
    }
  },

  'blockade': {
    id: 'blockade',
    name: 'Blockade',
    type: 'class',
    actionCost: 'class',
    mpCost: 0,
    hpCost: 0,
    requiresTarget: false,
    cooldown: 3,
    description: 'Grunt: hunker down; raise physical resistance for a turn.',
    apply: (user) => {
      user.blockade = { turns: 1, physRes: 0.25 };
      return { log: `${user.name} forms a blockade.` };
    }
  },

  'musical_memory': {
    id: 'musical_memory',
    name: 'Musical Memory',
    type: 'class',
    actionCost: 'class',
    mpCost: 0,
    hpCost: 0,
    requiresTarget: false,
    cooldown: 3,
    description: 'Performer: rally the party; small crit buff for 2 turns.',
    apply: (user) => {
      (user.team || []).forEach(ally => {
        if (!ally) return;
        ally.musicalMemory = { turns: 2, crit: 0.05 };
      });
      return { log: `${user.name} plays a stirring motif.` };
    }
  },




  // --- Weapon Skills ---
  // Legacy weapon entries migrated to the v3.21 sections below.

  'guard': {
    id: 'guard',
    name: 'Guard',
    type: 'class',
    actionCost: 'class',
    mpCost: 0,
    hpCost: 0,
    range: 0,
    positionRequirement: ['front', 'mid', 'back'],
    requiresTarget: false,
    targetRequirement: 'self',
    cooldown: 2,
    apply: (attacker) => {
      // Returns a self-buff payload; you can wire an actual buff system later.
      return { selfBuff: { damageReduction: 0.25, duration: 1 } };
    },
    description: 'Raise guard to reduce incoming damage until next turn.'
  },

  // --- Movement (unified) ---
  'move_step': {
    id: 'move_step',
    name: 'Step',
    type: 'special',
    actionCost: 'bonus',
    cooldown: 2,              // H/D/E racial movement
    requiresTarget: true,         // <-- select a destination
    targetRequirement: 'position',       // <-- custom: we'll handle in CombatScene
    isMovement: true,             // <-- flag to skip damage pipeline
    moveRange: 1,  // Chebyshev distance budget
    apply(user, destSlot, scene) {
      // Safety: ignore bad/occupied slots
      if (!destSlot || destSlot.occupied) return {};
      scene.moveToPosition(user, destSlot);
      scene._log?.(`${user.name} repositions.`);
      return {};
    }
  },

  'move_dash': {
    id: 'move_dash',
    name: 'Dash',
    type: 'special',
    actionCost: 'bonus',
    cooldown: 3,              // Ferrow/Wylett/Skith
    requiresTarget: true,
    targetRequirement: 'position',
    isMovement: true,
    moveRange: 2,
    apply(user, destSlot, scene) {
      if (!destSlot || destSlot.occupied) return {};
      scene.moveToPosition(user, destSlot);
      scene._log?.(`${user.name} rushes to a new position.`);
      return {};
    }
  },

  // ── STYX Ring-Granted Skills ──────────────────────────────────────────────
  // Cleanse physical buildup families from an ally
  'triage': {
    id: 'triage',
    name: 'Triage',
    type: 'special',
    actionCost: 'bonus',
    mpCost: 0,
    cooldown: 2,
    requiresTarget: true,
    targetRequirement: 'ally',
    tags: ['heal', 'support'],
    apply(user, target, scene) {
      if (!target?.weakness?.meters) return {};
      const families = ['lacerate', 'expose', 'disorient'];
      families.forEach(fam => { target.weakness.meters[fam] = 0; });
      scene?._log?.(`${user.name} triages ${target.name} — physical trauma cleansed.`);
      return {};
    },
    description: 'Bonus action. Cleanse all physical buildup (Lacerate, Expose, Disorient) from an ally. CD 2.'
  },

  // Cleanse necrotic buildup families from an ally
  'remedy': {
    id: 'remedy',
    name: 'Remedy',
    type: 'special',
    actionCost: 'bonus',
    mpCost: 0,
    cooldown: 2,
    requiresTarget: true,
    targetRequirement: 'ally',
    tags: ['heal', 'support'],
    apply(user, target, scene) {
      if (!target?.weakness?.meters) return {};
      const families = ['disease', 'curse', 'toxic'];
      families.forEach(fam => { target.weakness.meters[fam] = 0; });
      scene?._log?.(`${user.name} remedies ${target.name} — necrotic corruption purged.`);
      return {};
    },
    description: 'Bonus action. Cleanse all necrotic buildup (Disease, Curse, Toxic) from an ally. CD 2.'
  },

  // Cleanse elemental buildup families from an ally
  'weather': {
    id: 'weather',
    name: 'Weather',
    type: 'special',
    actionCost: 'bonus',
    mpCost: 0,
    cooldown: 2,
    requiresTarget: true,
    targetRequirement: 'ally',
    tags: ['heal', 'support'],
    apply(user, target, scene) {
      if (!target?.weakness?.meters) return {};
      const families = ['fire', 'cold', 'lightning'];
      families.forEach(fam => { target.weakness.meters[fam] = 0; });
      scene?._log?.(`${user.name} steadies ${target.name} — elemental buildup dispelled.`);
      return {};
    },
    description: 'Bonus action. Cleanse all elemental buildup (Fire, Cold, Lightning) from an ally. CD 2.'
  },

  // ── STYX Amulet-Granted Skill ────────────────────────────────────────────
  // Reduce all cooldowns of an ally by 3
  'hasten': {
    id: 'hasten',
    name: 'Hasten',
    type: 'special',
    actionCost: 'bonus',
    mpCost: 0,
    cooldown: 3,
    requiresTarget: true,
    targetRequirement: 'ally',
    tags: ['support'],
    apply(user, target, scene) {
      if (!target?.cooldowns) return {};
      for (const key of Object.keys(target.cooldowns)) {
        target.cooldowns[key] = Math.max(0, (target.cooldowns[key] || 0) - 3);
      }
      scene?._log?.(`${user.name} hastens ${target.name} — cooldowns reduced by 3.`);
      return {};
    },
    description: 'Bonus action. Reduce all cooldowns of an ally by 3 turns. CD 3.'
  },

  // ── LE\'SSE Ring-Granted Skills ───────────────────────────────────────────
  // Convert all damage to elemental for this turn
  'elemental_overload': {
    id: 'elemental_overload',
    name: 'Elemental Overload',
    type: 'special',
    actionCost: 'bonus',
    mpCost: 0,
    cooldown: 3,
    requiresTarget: false,
    tags: [],
    apply(user, _target, scene) {
      user.combatMods = user.combatMods || {};
      user.combatMods._damageConvertToElem = true;
      scene?._log?.(`${user.name} channels Elemental Overload — all damage becomes elemental this turn.`);
      return {};
    },
    description: 'Bonus action. All damage dealt becomes elemental this turn. CD 3.'
  },

  // Convert all damage to physical for this turn
  'raw_force': {
    id: 'raw_force',
    name: 'Raw Force',
    type: 'special',
    actionCost: 'bonus',
    mpCost: 0,
    cooldown: 3,
    requiresTarget: false,
    tags: [],
    apply(user, _target, scene) {
      user.combatMods = user.combatMods || {};
      user.combatMods._damageConvertToPhys = true;
      scene?._log?.(`${user.name} grounds their power — all damage becomes physical this turn.`);
      return {};
    },
    description: 'Bonus action. All damage dealt becomes physical this turn. CD 3.'
  },

  // Convert all damage to necrotic for this turn
  'sever_spirit': {
    id: 'sever_spirit',
    name: 'Sever Spirit',
    type: 'special',
    actionCost: 'bonus',
    mpCost: 0,
    cooldown: 3,
    requiresTarget: false,
    tags: [],
    apply(user, _target, scene) {
      user.combatMods = user.combatMods || {};
      user.combatMods._damageConvertToNecro = true;
      scene?._log?.(`${user.name} severs the spirit — all damage becomes necrotic this turn.`);
      return {};
    },
    description: 'Bonus action. All damage dealt becomes necrotic this turn. CD 3.'
  }
};



const NPC_ONLY_SKILLS = {
  // Shared training utilities

  'dummy_shuffle': {
    id: 'dummy_shuffle',
    name: 'Shuffle',
    type: 'special',
    actionCost: 'bonus',
    enemyOnly: true,
    requiresTarget: false,
    targetRequirement: 'position',
    isMovement: true,
    cooldown: 0,
    apply: (attacker, _target, scene) => {
      const moved = scene?._enemyTryShuffleOneColumn?.(attacker);
      if (moved) scene?._log?.(`${attacker.name} shuffles position.`);
      return { amount: 0, moved };
    }
  },

  'dummy_sway': {
    id: 'dummy_sway',
    name: 'Sway',
    type: 'special',
    actionCost: 'major',
    enemyOnly: true,
    requiresTarget: false,
    apply: (attacker, _target, scene) => {
      scene._log?.(`${attacker.name} sways. A slight breeze blows...`);
      return { amount: 0 };
    },
    description: 'Idles theatrically, consuming time.'
  },

  'step_forward': {
    id: 'step_forward',
    name: 'Step Forward',
    type: 'special',
    actionCost: 'bonus',
    enemyOnly: true,
    requiresTarget: false,
    targetRequirement: 'position',
    isMovement: true,
    cooldown: 2,
    apply: (attacker, _target, scene) => {
      const moved = scene?._enemyTryStepTowardFront?.(attacker);
      if (moved) scene?._log?.(`${attacker.name} steps forward.`);
      return { moved, amount: 0 };
    }
  },

  // Encounter 1 - Warm-up Duel
  'warmup_swing': {
    id: 'warmup_swing',
    name: 'Practice Swing',
    type: 'enemy',
    actionCost: 'major',
    mpCost: 4,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    apply: () => ({ amount: 12 })
  },
  'warmup_patch': {
    id: 'warmup_patch',
    name: 'Patch Scratches',
    type: 'enemy',
    actionCost: 'class',
    mpCost: 5,
    cooldown: 1,
    enemyOnly: true,
    requiresTarget: false,
    apply: (user) => {
      if (!user) return { amount: 0 };
      const heal = Math.max(3, Math.floor((user.maxHP || 40) * 0.15));
      user.currentHP = Math.min(user.maxHP || heal, (user.currentHP || 0) + heal);
      return { amount: 0 };
    }
  },

  // Encounter 2 - Defensive Trial
  'defender_guard_raise': {
    id: 'defender_guard_raise',
    name: 'Raise Shield',
    type: 'enemy',
    actionCost: 'bonus',
    mpCost: 4,
    cooldown: 2,
    enemyOnly: true,
    requiresTarget: false,
    apply: (user) => ({
      amount: 0,
      statusEffects: [{ id: 'defender_guard', turns: 2, mods: { PhysicalResist: 20 } }]
    })
  },
  'defender_taunt': {
    id: 'defender_taunt',
    name: 'Challenge Cry',
    type: 'enemy',
    actionCost: 'major',
    mpCost: 5,
    cooldown: 1,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    apply: (user, target, scene) => {
      scene?._log?.(`${user.name} challenges ${target?.name}.`);
      return {
        amount: 6,
        statusEffects: [{ id: 'taunted', turns: 1, data: { forcedTarget: user?.id || null } }],
        buildup: { expose: 60 }
      };
    }
  },
  'offender_expose_strike': {
    id: 'offender_expose_strike',
    name: 'Stinging Strike',
    type: 'enemy',
    actionCost: 'major',
    mpCost: 6,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    apply: () => ({ amount: 14, buildup: { expose: 70 } })
  },
  'defender_small_heal': {
    id: 'defender_small_heal',
    name: 'Training Mend',
    type: 'enemy',
    actionCost: 'class',
    mpCost: 8,
    cooldown: 2,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'ally',
    apply: (_user, target) => {
      if (!target) return { amount: 0 };
      const heal = Math.max(6, Math.floor((target.maxHP || 40) * 0.2));
      target.currentHP = Math.min(target.maxHP || heal, (target.currentHP || 0) + heal);
      return { amount: 0 };
    }
  },

  // Encounter 3 - Animated Party Test
  'fighter_heavy_slash': {
    id: 'fighter_heavy_slash',
    name: 'Heavy Slash',
    type: 'enemy',
    actionCost: 'major',
    mpCost: 5,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    apply: () => ({ amount: 6, buildup: { expose: 90 } })
  },
  'fighter_guarded_blow': {
    id: 'fighter_guarded_blow',
    name: 'Guarded Blow',
    type: 'enemy',
    actionCost: 'bonus',
    mpCost: 4,
    cooldown: 2,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    apply: (user, target) => ({
      amount: 3,
      buildup: { cold: 60 },
      statusEffects: [{ id: 'fighter_guard', turns: 2, mods: { PhysicalResist: 15 } }]
    })
  },
  'fighter_taunt': {
    id: 'fighter_taunt',
    name: 'Taunting Cry',
    type: 'enemy',
    actionCost: 'class',
    mpCost: 4,
    cooldown: 1,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    requiresWeakness: { family: 'expose', tier: 1 },
    apply: (user, target, scene) => {
      scene?._log?.(`${user.name} taunts ${target?.name}!`);
      return { amount: 0, statusEffects: [{ id: 'taunted', turns: 1, data: { forcedTarget: user?.id || null } }] };
    }
  },
  'fighter_executioner': {
    id: 'fighter_executioner',
    name: "Executioner's Strike",
    type: 'enemy',
    actionCost: 'major',
    mpCost: 8,
    cooldown: 2,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    requiresWeakness: { family: 'expose', tier: 2 },
    apply: () => ({ amount: 11, consumeWeakness: ['expose'] })
  },

  'healer_heal': {
    id: 'healer_heal',
    name: 'Restore',
    type: 'enemy',
    actionCost: 'major',
    mpCost: 10,
    cooldown: 1,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'ally',
    apply: (_user, target) => {
      if (!target) return { amount: 0 };
      const heal = Math.max(14, Math.floor((target.maxHP || 50) * 0.35));
      target.currentHP = Math.min(target.maxHP || heal, (target.currentHP || 0) + heal);
      return { amount: 0 };
    }
  },
  'healer_cleanse': {
    id: 'healer_cleanse',
    name: 'Cleanse Weakness',
    type: 'enemy',
    actionCost: 'class',
    mpCost: 8,
    cooldown: 2,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'ally',
    apply: (_user, target, scene) => {
      if (!target?.weakness) return { amount: 0 };
      const w = target.weakness;
      let removed = false;
      for (const fam of ['curse', 'disease', 'toxic']) {
        if ((w.meters?.[fam] || 0) > 0) {
          w.meters[fam] = 0;
          w.tiers[fam] = 0;
          removed = true;
        }
      }
      if (removed) {
        scene?._log?.(`${target.name} is cleansed of maladies.`);
        target.currentMP = Math.min(target.maxMP || 0, (target.currentMP || 0) + 4);
      }
      return { amount: 0 };
    }
  },
  'healer_blessing': {
    id: 'healer_blessing',
    name: 'Blessing',
    type: 'enemy',
    actionCost: 'bonus',
    mpCost: 6,
    cooldown: 3,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'ally',
    apply: (_user, target) => ({
      amount: 0,
      statusEffects: [{ id: 'healer_blessing', turns: 3, mods: { Accuracy: 10 }, data: { mpRegen: 2 } }]
    })
  },
  'healer_flame_flick': {
    id: 'healer_flame_flick',
    name: 'Flame Flick',
    type: 'enemy',
    actionCost: 'bonus',
    mpCost: 3,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    apply: () => ({ amount: 3, buildup: { fire: 70 } })
  },

  'warlock_hex': {
    id: 'warlock_hex',
    name: 'Hex',
    type: 'enemy',
    actionCost: 'major',
    mpCost: 5,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    apply: () => ({ amount: 3, buildup: { curse: 80 } })
  },
  'warlock_drain_life': {
    id: 'warlock_drain_life',
    name: 'Drain Life',
    type: 'enemy',
    actionCost: 'major',
    mpCost: 10,
    cooldown: 2,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    requiresWeakness: { family: 'curse', tier: 1 },
    apply: (user, target) => {
      const tier = target?.weakness?.tiers?.curse || 0;
      const dmg = 5;
      const heal = tier >= 2 ? 18 : 10;
      if (user) {
        user.currentHP = Math.min(user.maxHP || heal, (user.currentHP || 0) + heal);
      }
      return { amount: dmg };
    }
  },
  'warlock_dark_bolts': {
    id: 'warlock_dark_bolts',
    name: 'Dark Bolts',
    type: 'enemy',
    actionCost: 'bonus',
    mpCost: 4,
    cooldown: 1,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    apply: () => ({ amount: 4, buildup: { disease: 70 } })
  },
  'warlock_curse_amplify': {
    id: 'warlock_curse_amplify',
    name: 'Curse Amplify',
    type: 'enemy',
    actionCost: 'class',
    mpCost: 8,
    cooldown: 2,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    requiresWeakness: { family: 'curse', tier: 1 },
    apply: (_user, target, scene) => {
      if (!target?.weakness) return { amount: 0 };
      const w = target.weakness;
      const meter = w.meters?.curse || 0;
      w.meters.curse = meter * 2;
      scene?._log?.(`${target.name}'s curse deepens!`);
      return { amount: 0 };
    }
  },

  'ranger_quick_shot': {
    id: 'ranger_quick_shot',
    name: 'Quick Shot',
    type: 'enemy',
    actionCost: 'bonus',
    mpCost: 3,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    apply: () => ({ amount: 5, buildup: { expose: 60 } })
  },
  'ranger_frost_arrow': {
    id: 'ranger_frost_arrow',
    name: 'Frost Arrow',
    type: 'enemy',
    actionCost: 'major',
    mpCost: 5,
    cooldown: 1,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    apply: () => ({ amount: 5, buildup: { cold: 90 } })
  },
  'ranger_volley': {
    id: 'ranger_volley',
    name: 'Volley',
    type: 'enemy',
    actionCost: 'class',
    mpCost: 8,
    cooldown: 2,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    apply: (_user, _target, scene) => {
      const foes = scene?.turnOrder?.filter(u => !u.isEnemy && u.status !== 'incapacitated') || [];
      return {
        amount: 4,
        splash: foes.slice(1).map(t => ({ target: t, amount: 3 }))
      };
    }
  },
  'ranger_aimed_shot': {
    id: 'ranger_aimed_shot',
    name: 'Aimed Shot',
    type: 'enemy',
    actionCost: 'major',
    mpCost: 8,
    cooldown: 2,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    requiresWeakness: { family: 'expose', tier: 1 },
    apply: () => ({ amount: 9, consumeWeakness: ['expose'] })
  },

  'rogue_poisoned_knife': {
    id: 'rogue_poisoned_knife',
    name: 'Poisoned Knife',
    type: 'enemy',
    actionCost: 'bonus',
    mpCost: 3,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    apply: (_user, target) => {
      const exposeTier = target?.weakness?.tiers?.expose || 0;
      const base = { amount: 3, buildup: { toxic: 70 } };
      if (exposeTier >= 1) {
        base.buildup.toxic += 40;
      }
      return base;
    }
  },
  'rogue_hamstring': {
    id: 'rogue_hamstring',
    name: 'Hamstring',
    type: 'enemy',
    actionCost: 'major',
    mpCost: 5,
    cooldown: 1,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    apply: () => ({ amount: 5, buildup: { lacerate: 80 }, statusEffects: [{ id: 'slowed', turns: 2, mods: { Initiative: -10 } }] })
  },
  'rogue_evasion': {
    id: 'rogue_evasion',
    name: 'Evasion',
    type: 'enemy',
    actionCost: 'bonus',
    mpCost: 4,
    cooldown: 2,
    enemyOnly: true,
    requiresTarget: false,
    apply: (user, _target, scene) => {
      if (!user) return { amount: 0 };
      const anyAfflicted = scene?.turnOrder?.some(u => !u.isEnemy && u.status !== 'incapacitated' && (((u.weakness?.tiers?.curse || 0) >= 1) || ((u.weakness?.tiers?.toxic || 0) >= 1)));
      if (anyAfflicted) {
        user.currentMP = Math.min(user.maxMP || 0, (user.currentMP || 0) + 3);
      }
      return { amount: 0, statusEffects: [{ id: 'rogue_evasion', turns: 1, mods: { Evasion: 20 } }] };
    }
  },
  'rogue_sneak_attack': {
    id: 'rogue_sneak_attack',
    name: 'Sneak Attack',
    type: 'enemy',
    actionCost: 'major',
    mpCost: 7,
    cooldown: 1,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    requiresWeakness: { family: 'expose', tier: 1 },
    apply: () => ({ amount: 9 })
  },
  'rogue_finishing_strike': {
    id: 'rogue_finishing_strike',
    name: 'Finishing Strike',
    type: 'enemy',
    actionCost: 'class',
    mpCost: 10,
    cooldown: 2,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    canExecute: ({ target }) => {
      if (!target?.weakness?.tiers) return { ok: false };
      const tiers = target.weakness.tiers;
      const families = ['expose', 'toxic', 'curse', 'disease', 'cold', 'fire', 'lacerate'];
      const count = families.reduce((n, fam) => n + ((tiers[fam] || 0) >= 1 ? 1 : 0), 0);
      return count >= 2 ? true : { ok: false, reason: `${target.name} lacks layered weaknesses.` };
    },
    apply: () => ({ amount: 13, consumeWeakness: ['expose', 'toxic'] })
  },

  'wizard_arcane_bolt': {
    id: 'wizard_arcane_bolt',
    name: 'Arcane Bolt',
    type: 'enemy',
    actionCost: 'bonus',
    mpCost: 3,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    apply: () => ({ amount: 5, buildup: { lightning: 60 } })
  },
  'wizard_static_field': {
    id: 'wizard_static_field',
    name: 'Static Field',
    type: 'enemy',
    actionCost: 'major',
    mpCost: 5,
    cooldown: 1,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    apply: () => ({ amount: 5, buildup: { lightning: 90 } })
  },
  'wizard_mana_shield': {
    id: 'wizard_mana_shield',
    name: 'Mana Shield',
    type: 'enemy',
    actionCost: 'bonus',
    mpCost: 4,
    cooldown: 3,
    enemyOnly: true,
    requiresTarget: false,
    apply: (user) => ({
      amount: 0,
      statusEffects: [{ id: 'wizard_mana_shield', turns: 2, mods: { ElementalResist: 20 } }]
    })
  },
  'wizard_overload': {
    id: 'wizard_overload',
    name: 'Overload',
    type: 'enemy',
    actionCost: 'class',
    mpCost: 8,
    cooldown: 2,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    requiresWeakness: { family: 'lightning', tier: 1 },
    apply: () => ({ amount: 12, consumeWeakness: ['lightning'] })
  },

  // Encounter 4 - Huntsman & Beasts
  'huntsman_mark': {
    id: 'huntsman_mark',
    name: "Huntmaster's Mark",
    type: 'enemy',
    actionCost: 'bonus',
    mpCost: 4,
    cooldown: 1,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    apply: (user, target) => ({
      amount: 3,
      buildup: { expose: 80 },
      statusEffects: [{ id: 'huntsman_marked', turns: 3, data: { markedBy: user?.id || null } }]
    })
  },
  'huntsman_command': {
    id: 'huntsman_command',
    name: 'Whistled Command',
    type: 'enemy',
    actionCost: 'class',
    mpCost: 6,
    cooldown: 2,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'ally',
    apply: (_user, beast) => ({
      amount: 0,
      statusEffects: [{ id: 'commanded', turns: 1, mods: { Initiative: 15, Accuracy: 10 } }]
    })
  },
  'huntsman_trap_shot': {
    id: 'huntsman_trap_shot',
    name: 'Trap Shot',
    type: 'enemy',
    actionCost: 'major',
    mpCost: 6,
    cooldown: 1,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    apply: () => ({ amount: 7, buildup: { lacerate: 90 }, statusEffects: [{ id: 'snared', turns: 2 }] })
  },
  'huntsman_empower_pack': {
    id: 'huntsman_empower_pack',
    name: 'Empower Pack',
    type: 'enemy',
    actionCost: 'bonus',
    mpCost: 8,
    cooldown: 3,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    canExecute: ({ target }) => {
      if (!target?.weakness?.tiers) return { ok: false };
      const tiers = target.weakness.tiers;
      const present = ['expose', 'lacerate', 'disease', 'toxic'].reduce((n, fam) => n + ((tiers[fam] || 0) >= 1 ? 1 : 0), 0);
      return present >= 2 ? true : { ok: false, reason: 'The mark lacks layered weaknesses.' };
    },
    apply: (_user, _target, scene) => {
      const beasts = scene?.enemies?.filter(u => u?.tags?.includes('beast')) || [];
      for (const beast of beasts) {
        beast.statusEffects = beast.statusEffects || [];
        beast.statusEffects.push({ id: 'empowered_pack', turns: 2, mods: { Initiative: 20, Accuracy: 10 } });
      }
      return { amount: 0 };
    }
  },

  'oskar_rending_bite': {
    id: 'oskar_rending_bite',
    name: 'Rending Bite',
    type: 'enemy',
    actionCost: 'major',
    mpCost: 5,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    apply: () => ({ amount: 7, buildup: { lacerate: 90 } })
  },
  'oskar_infectious_claw': {
    id: 'oskar_infectious_claw',
    name: 'Infectious Claw',
    type: 'enemy',
    actionCost: 'bonus',
    mpCost: 4,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    apply: (_user, target) => {
      const hasLac = (target?.weakness?.tiers?.lacerate || 0) >= 1;
      return { amount: 5, buildup: { disease: hasLac ? 140 : 80 } };
    }
  },
  'oskar_maw_rip': {
    id: 'oskar_maw_rip',
    name: 'Maw Rip',
    type: 'enemy',
    actionCost: 'major',
    mpCost: 8,
    cooldown: 2,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    requiresWeakness: { family: 'lacerate', tier: 1 },
    apply: () => ({ amount: 11, consumeWeakness: ['lacerate'] })
  },
  'oskar_rotting_maw': {
    id: 'oskar_rotting_maw',
    name: 'Rotting Maw',
    type: 'enemy',
    actionCost: 'class',
    mpCost: 10,
    cooldown: 3,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    requiresWeakness: { family: 'disease', tier: 2 },
    apply: (_user, target) => {
      if (target?.weakness) {
        const val = target.weakness.meters?.disease || 0;
        target.weakness.meters.disease = 0;
        target.weakness.tiers.disease = 0;
        target.weakness.meters.toxic = (target.weakness.meters.toxic || 0) + val;
      }
      return { amount: 9 };
    }
  },

  'kiro_toxic_spit': {
    id: 'kiro_toxic_spit',
    name: 'Toxic Spit',
    type: 'enemy',
    actionCost: 'bonus',
    mpCost: 4,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    apply: () => ({ amount: 4, buildup: { toxic: 90 } })
  },
  'kiro_venomous_swipe': {
    id: 'kiro_venomous_swipe',
    name: 'Venomous Swipe',
    type: 'enemy',
    actionCost: 'major',
    mpCost: 5,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    apply: () => ({ amount: 6, buildup: { disease: 90 } })
  },
  'kiro_poison_cloud': {
    id: 'kiro_poison_cloud',
    name: 'Poison Cloud',
    type: 'enemy',
    actionCost: 'class',
    mpCost: 8,
    cooldown: 2,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    requiresWeakness: { family: 'toxic', tier: 1 },
    apply: (_user, _target, scene) => {
      const foes = scene?.turnOrder?.filter(u => !u.isEnemy && u.status !== 'incapacitated') || [];
      return {
        amount: 3,
        consumeWeakness: ['toxic'],
        splash: foes.map(t => ({ target: t, amount: 2, buildup: { toxic: 60 } }))
      };
    }
  },
  'kiro_corrosive_bite': {
    id: 'kiro_corrosive_bite',
    name: 'Corrosive Bite',
    type: 'enemy',
    actionCost: 'major',
    mpCost: 8,
    cooldown: 2,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    requiresWeakness: { family: 'toxic', tier: 2 },
    apply: (_user, target) => {
      const payload = { amount: 10, consumeWeakness: ['toxic'] };
      if ((target?.weakness?.tiers?.disease || 0) >= 1) {
        payload.buildup = { curse: 80 };
      }
      return payload;
    }
  },

  // Encounter 5 - Elemental Duelists
  'fire_flame_slash': {
    id: 'fire_flame_slash',
    name: 'Flame Slash',
    type: 'enemy',
    actionCost: 'major',
    mpCost: 5,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    apply: () => ({ amount: 7, buildup: { fire: 100 } })
  },
  'fire_heated_guard': {
    id: 'fire_heated_guard',
    name: 'Heated Guard',
    type: 'enemy',
    actionCost: 'bonus',
    mpCost: 4,
    cooldown: 2,
    enemyOnly: true,
    requiresTarget: false,
    apply: (user) => ({
      amount: 0,
      statusEffects: [{ id: 'heated_guard', turns: 2, mods: { PhysicalResist: 15 }, data: { retaliateFire: true } }]
    })
  },
  'fire_burst': {
    id: 'fire_burst',
    name: 'Fire Burst',
    type: 'enemy',
    actionCost: 'class',
    mpCost: 10,
    cooldown: 2,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    requiresWeakness: { family: 'fire', tier: 2 },
    apply: () => ({ amount: 11, consumeWeakness: ['fire'] })
  },
  'fire_flare_wave': {
    id: 'fire_flare_wave',
    name: 'Flare Wave',
    type: 'enemy',
    actionCost: 'major',
    mpCost: 12,
    cooldown: 3,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    apply: (_user, _target, scene) => {
      const foes = scene?.turnOrder?.filter(u => !u.isEnemy && u.status !== 'incapacitated') || [];
      return {
        amount: 6,
        splash: foes.map(t => ({ target: t, amount: 5, buildup: { fire: 60 } }))
      };
    }
  },

  'ice_frost_strike': {
    id: 'ice_frost_strike',
    name: 'Frost Strike',
    type: 'enemy',
    actionCost: 'major',
    mpCost: 5,
    cooldown: 1,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    apply: () => ({ amount: 7, buildup: { cold: 100 } })
  },
  'ice_icy_guard': {
    id: 'ice_icy_guard',
    name: 'Icy Guard',
    type: 'enemy',
    actionCost: 'bonus',
    mpCost: 4,
    cooldown: 2,
    enemyOnly: true,
    requiresTarget: false,
    apply: () => ({ amount: 0, statusEffects: [{ id: 'icy_guard', turns: 2, mods: { PhysicalResist: 15 }, data: { retaliateCold: true } }] })
  },
  'ice_freeze_point': {
    id: 'ice_freeze_point',
    name: 'Freeze Point',
    type: 'enemy',
    actionCost: 'class',
    mpCost: 10,
    cooldown: 2,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    requiresWeakness: { family: 'cold', tier: 2 },
    apply: () => ({ amount: 11, consumeWeakness: ['cold'], statusEffects: [{ id: 'frozen', turns: 1, blocksAction: true }] })
  },
  'ice_shard_storm': {
    id: 'ice_shard_storm',
    name: 'Shard Storm',
    type: 'enemy',
    actionCost: 'major',
    mpCost: 12,
    cooldown: 3,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    apply: (_user, _target, scene) => {
      const foes = scene?.turnOrder?.filter(u => !u.isEnemy && u.status !== 'incapacitated') || [];
      return {
        amount: 5,
        splash: foes.map(t => ({ target: t, amount: 4, buildup: { cold: 50 } }))
      };
    }
  },

  // Encounter 6 - Berserker Boss
  'berserker_reckless_strike': {
    id: 'berserker_reckless_strike',
    name: 'Reckless Strike',
    type: 'enemy',
    actionCost: 'major',
    mpCost: 0,
    cooldown: 0,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['melee', 'attack'],
    // Free fallback so he's never fully locked out of acting once MP runs
    // dry — every other move in his kit costs MP, and with no 0-cost option
    // he'd just do nothing on any turn he couldn't afford anything.
    apply: (attacker, target) => {
      const ability = SKILLS?.berserker_reckless_strike;
      const roll = calculateDamage(attacker, target, ability);
      const amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability, tags: ability?.tags, skipGearMultiplier: true,
      }));
      return { ...roll, amount };
    },
    description: "A free, no-frills swing — always available, even at 0 MP."
  },

  'berserker_crushing_blow': {
    id: 'berserker_crushing_blow',
    name: 'Crushing Blow',
    type: 'enemy',
    actionCost: 'major',
    mpCost: 6,
    cooldown: 1,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['melee', 'attack', 'expose', 'lacerate'],
    apply: (attacker, target) => {
      const ability = SKILLS?.berserker_crushing_blow;
      const roll = calculateDamage(attacker, target, ability);
      const amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability, tags: ability?.tags, skipGearMultiplier: true,
      }));
      return { ...roll, amount, buildup: { expose: 90, lacerate: 80 } };
    }
  },
  'berserker_disrupting_roar': {
    id: 'berserker_disrupting_roar',
    name: 'Disrupting Roar',
    type: 'enemy',
    actionCost: 'class',
    mpCost: 8,
    cooldown: 2,
    enemyOnly: true,
    // Was requiresTarget:false with 100% of its damage living in `splash`
    // (no real primary target hit at all) — that meant it could never emit
    // the self_hit event reactions listen for, so nothing (Bedrock Guard
    // included) could ever trigger against it. Now hits a real primary
    // target (picked by the AI, see berserker_boss profile) and splashes
    // the same amount to the rest of the party, same as before.
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['aoe', 'disorient'],
    aoe: { shape: 'party', scale: 1 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.berserker_disrupting_roar;
      const roll = calculateDamage(attacker, target, ability);
      const amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability, tags: ability?.tags, skipGearMultiplier: true,
      }));
      const others = (scene?.turnOrder?.filter(u => !u.isEnemy && u.status !== 'incapacitated' && u !== target)) || [];
      return {
        ...roll,
        amount,
        buildup: { disorient: 80 },
        splash: others.map(t => ({ target: t, amount, buildup: { disorient: 80 } })),
      };
    },
    description: "Roars, disorienting the whole party. Deals damage and builds Disorient on every foe."
  },
  'berserker_bleeding_sweep': {
    id: 'berserker_bleeding_sweep',
    name: 'Bleeding Sweep',
    type: 'enemy',
    actionCost: 'major',
    mpCost: 8,
    cooldown: 2,
    enemyOnly: true,
    // Same fix as Disrupting Roar — was 100% splash with no real primary
    // target, so it could never emit self_hit for any reaction to see.
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['melee', 'aoe', 'lacerate'],
    aoe: { shape: 'party', scale: 1 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.berserker_bleeding_sweep;
      const roll = calculateDamage(attacker, target, ability);
      const amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability, tags: ability?.tags, skipGearMultiplier: true,
      }));
      const others = (scene?.turnOrder?.filter(u => !u.isEnemy && u.status !== 'incapacitated' && u !== target)) || [];
      return {
        ...roll,
        amount,
        buildup: { lacerate: 90 },
        splash: others.map(t => ({ target: t, amount, buildup: { lacerate: 90 } })),
      };
    },
    description: "A wide, bleeding sweep across the whole party."
  },
  'berserker_guarded_fury': {
    id: 'berserker_guarded_fury',
    name: 'Guarded Fury',
    type: 'enemy',
    actionCost: 'bonus',
    mpCost: 5,
    cooldown: 2,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['melee', 'attack', 'cold'],
    apply: (attacker, target) => {
      const ability = SKILLS?.berserker_guarded_fury;
      const roll = calculateDamage(attacker, target, ability);
      const amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability, tags: ability?.tags, skipGearMultiplier: true,
      }));
      return {
        ...roll,
        amount,
        buildup: { cold: 70 },
        statusEffects: [{ id: 'berserker_guard', turns: 2, mods: { PhysicalResist: 15 } }]
      };
    }
  },
  'berserker_battle_frenzy': {
    id: 'berserker_battle_frenzy',
    name: 'Battle Frenzy',
    type: 'enemy',
    actionCost: 'bonus',
    mpCost: 6,
    cooldown: 3,
    enemyOnly: true,
    requiresTarget: false,
    apply: (user) => ({
      amount: 0,
      statusEffects: [{ id: 'battle_frenzy', turns: 2, mods: { Initiative: 30, Accuracy: 10 } }]
    })
  },
  'berserker_death_spiral': {
    id: 'berserker_death_spiral',
    name: 'Death Spiral',
    type: 'enemy',
    actionCost: 'class',
    mpCost: 12,
    cooldown: 3,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['melee', 'attack', 'finisher'],
    requiresWeakness: [
      { family: 'expose', tier: 1 },
      { family: 'lacerate', tier: 1 }
    ],
    apply: (attacker, target) => {
      const ability = SKILLS?.berserker_death_spiral;
      const roll = calculateDamage(attacker, target, ability);
      const amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability, tags: ability?.tags, skipGearMultiplier: true,
      }));
      return { ...roll, amount, consumeWeakness: ['expose', 'lacerate'] };
    }
  },
  'berserker_unstoppable_rush': {
    id: 'berserker_unstoppable_rush',
    name: 'Unstoppable Rush',
    type: 'enemy',
    actionCost: 'major',
    mpCost: 10,
    cooldown: 2,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['melee', 'attack'],
    apply: (attacker, target) => {
      const ability = SKILLS?.berserker_unstoppable_rush;
      if (attacker) {
        attacker.initiativeGauge = Math.max(0, (attacker.initiativeGauge || 0) - 50);
      }
      const disorientStacks = target?.weakness?.tiers?.disorient || 0;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability, tags: ability?.tags, skipGearMultiplier: true,
      }));
      if (disorientStacks >= 1) amount += 3 * disorientStacks;
      return { ...roll, amount };
    }
  },
  'berserker_blood_fury': {
    id: 'berserker_blood_fury',
    name: 'Blood Fury',
    type: 'enemy',
    actionCost: 'reaction',
    mpCost: 4,
    cooldown: 2,
    mechanic: 'reaction',
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['melee', 'attack', 'expose', 'disorient'],
    // Was missing a reaction.trigger/exec entirely — mechanic:'reaction' with
    // no trigger meant this could never actually fire, even if armed (and
    // nothing armed it either, since berserker_boss's AI never referenced
    // it). Now: real trigger, and the AI arms it at the start of the fight
    // (see berserker_boss profile) so it's live for the whole encounter.
    reaction: {
      trigger: 'self_hit',
      cooldownOn: 'trigger',
      exec: ({ owner, attacker, scene }) => {
        if (!attacker || !scene) return;
        const counterSkill = SKILLS?.berserker_blood_fury;
        scene.time?.delayedCall?.(50, () => {
          scene._applyAbilityToTarget(owner, attacker, counterSkill, { isReaction: true, tags: counterSkill?.tags || [] });
        });
      },
    },
    apply: (attacker, target) => {
      const ability = SKILLS?.berserker_blood_fury;
      const roll = calculateDamage(attacker, target, ability);
      const amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability, tags: ability?.tags, skipGearMultiplier: true,
      }));
      return { ...roll, amount, buildup: { expose: 60, disorient: 60 } };
    },
    description: "Reaction: lashes back at whoever strikes him, dealing damage and building Expose and Disorient."
  }
};
Object.assign(RAW_SKILLS, NPC_ONLY_SKILLS);

// ===============================
// v3.2 - Dagger skills (13) - injected directly; no wrapper const
// Notes: no `range`; tooltip helpers via `buildupHint`/`aoe`; event scaffolding inert.
// ===============================
Object.assign(RAW_SKILLS, {



  // ===============================
  // v3.21 - Sword (2h) (13)
  // ===============================

  // -------- Generation (6) --------
  'wide_sweep': {
    id: "wide_sweep",
    name: "Wide Sweep",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sword_2h"],
    requiredStat: "STR",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lacerate", "aoe"],
    emitTagsOnUse: ["slash"],
    cooldown: 2,
    aoe: { shape: "column", scale: 1 },
    buildupHint: { lacerate: 100 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.wide_sweep;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      amount = Math.max(1, Math.floor(amount * 0.95));
      const buildupVal = ability?.buildupHint?.lacerate ?? 100;
      const splash = [];
      if (scene && target && typeof scene._getUnitColumn === "function" && typeof scene._getColumnBySlotId === "function") {
        const column = scene._getUnitColumn(target);
        if (column) {
          const sideSlots = target?.isEnemy ? scene.enemySlots : scene.allySlots;
          const others = sideSlots
            ?.filter(slot => slot?.char && slot.char !== target && slot.char.status !== "incapacitated" && scene._getColumnBySlotId(slot.slotId) === column)
            .map(slot => slot.char) || [];
          others.slice(0, 2).forEach(char => {
            const splashAmount = Math.max(1, Math.floor(amount * 0.8));
            splash.push({
              target: char,
              amount: splashAmount,
              buildup: { lacerate: buildupVal },
              tags: ability?.tags,
            });
          });
        }
      }
      return {
        ...roll,
        amount,
        buildup: { lacerate: buildupVal },
        splash: splash.length ? splash : undefined,
      };
    },
    description: "A broad arc that strikes up to three foes ahead, opening each with bleeding cuts."
  },

  'winters_mark': {
    id: "winters_mark",
    name: "Winter's Mark",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sword_2h"],
    requiredStat: "WIS",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "cold"],
    emitTagsOnUse: ["thrust"],
    cooldown: 2,
    buildupHint: { cold: 100 },
    rewardIfTierCross: [{ family: "cold", tier: 1, debuff: { speedDownPct: 10, turns: 1 } }],
    apply: (attacker, target) => {
      const ability = SKILLS?.winters_mark;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: "cold",
        skipGearMultiplier: true,
      }));
      const coldTier = target?.weakness?.tiers?.cold || 0;
      if (coldTier >= 1) {
        amount = Math.floor(amount * (1 + 0.08 * coldTier));
      }
      return {
        ...roll,
        amount,
        element: "cold",
        buildup: { cold: ability?.buildupHint?.cold ?? 100 },
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
      };
    },
    description: "A precise mark that seeds Frost-crossing a tier chills the target's footing."
  },

  'defensive_stand': {
    id: "defensive_stand",
    name: "Defensive Stand",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sword_2h"],
    requiredStat: "CON",
    requiredValue: 14,
    actionCost: "bonus",
    mpCost: 3,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["stance", "support", "cold"],
    cooldown: 3,
    buildupHint: { cold: 100 },
    rewardIfTier: { family: "cold", tierAtLeast: 1, buff: { guardPct: 12, turns: 1 } },
    statusEffects: [{ id: "defensive_stand", turns: 1, guardPct: 15, nextHitBuildup: { cold: 100 }, nextHitOnly: true }],
    apply: (attacker) => {
      const ability = SKILLS?.defensive_stand;
      const statusEffects = Array.isArray(ability?.statusEffects)
        ? ability.statusEffects.map(effect => ({
          ...effect,
          nextHitBuildup: { cold: ability?.buildupHint?.cold ?? 100 }
        }))
        : undefined;
      return {
        amount: 0,
        statusEffects,
        rewardIfTier: cloneRewardStruct(ability?.rewardIfTier),
      };
    },
    description: "Brace behind the greatsword, gaining guard; the next attacker is chilled."
  },

  'threatening_posture': {
    id: "threatening_posture",
    name: "Threatening Posture",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sword_2h"],
    requiredStat: "CHA",
    requiredValue: 13,
    actionCost: "bonus",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["support", "taunt", "expose"],
    cooldown: 2,
    buildupHint: { expose: 100 },
    statusEffects: [{ id: "taunted", turns: 1 }],
    apply: (attacker, target) => {
      const ability = SKILLS?.threatening_posture;
      const turns = ability?.statusEffects?.[0]?.turns ?? 1;
      const statusEffects = [{
        id: "taunted",
        turns,
        data: { forcedTarget: attacker?.id || attacker?.name || null },
      }];
      return {
        amount: 0,
        statusEffects,
        buildup: { expose: ability?.buildupHint?.expose ?? 100 },
      };
    },
    description: "A menacing stance that taunts the foe and exposes a soft spot."
  },

  'sundering_blade': {
    id: "sundering_blade",
    name: "Sundering Blade",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sword_2h"],
    requiredStat: "STR",
    requiredValue: 17,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lacerate", "expose"],
    emitTagsOnUse: ["slash"],
    cooldown: 3,
    buildupHint: { lacerate: 100, expose: 80 },
    rewardIfTierCross: [{ family: "lacerate", tier: 1, debuff: { bleedTakenPct: 15, turns: 2 } }],
    apply: (attacker, target) => {
      const ability = SKILLS?.sundering_blade;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      const exposeTier = target?.weakness?.tiers?.expose || 0;
      if (exposeTier >= 1) {
        amount = Math.floor(amount * (1 + 0.1 * exposeTier));
      }
      return {
        ...roll,
        amount,
        buildup: {
          lacerate: ability?.buildupHint?.lacerate ?? 100,
          expose: ability?.buildupHint?.expose ?? 80,
        },
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
      };
    },
    description: "A brutal cut that both rends and reveals; deeper bleeds amplify the pain."
  },

  'footwork_drill': {
    id: "footwork_drill",
    name: "Footwork Drill",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sword_2h"],
    requiredStat: "DEX",
    requiredValue: 15,
    actionCost: "bonus",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "cold", "proliferate"],
    emitTagsOnUse: ["slash"],
    cooldown: 2,
    proliferateWeakness: { families: ["cold"], to: "adjacent", ratio: 1.0, maxTargets: 1 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.footwork_drill;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: "cold",
        skipGearMultiplier: true,
      }));
      amount = Math.max(1, Math.floor(amount * 0.9));

      const hasWeakness = !!(target?.weakness && Object.values(target.weakness.tiers || {}).some(val => (val || 0) > 0));
      let log;
      if (hasWeakness && attacker) {
        const before = attacker.initiativeGauge || 0;
        attacker.initiativeGauge = Math.max(0, before - 15);
        const gain = Math.max(0, before - attacker.initiativeGauge);
        log = gain ? `${attacker.name || "The duelist"} seizes tempo, gaining initiative.` : undefined;
      }

      const spreadMeta = [];
      if (scene && target && typeof scene._getUnitColumn === "function" && typeof scene._getColumnBySlotId === "function") {
        const column = scene._getUnitColumn(target);
        if (column) {
          const sideSlots = target?.isEnemy ? scene.enemySlots : scene.allySlots;
          const neighbors = sideSlots
            ?.filter(slot => slot?.char && slot.char !== target && slot.char.status !== "incapacitated" && scene._getColumnBySlotId(slot.slotId) === column)
            .map(slot => slot.char) || [];
          const coldMeter = target?.weakness?.meters?.cold || 0;
          const maxTargets = ability?.proliferateWeakness?.maxTargets ?? 1;
          neighbors.slice(0, maxTargets).forEach(char => {
            if (coldMeter <= 0) return;
            char.weakness = char.weakness || { meters: {}, tiers: {} };
            char.weakness.meters = char.weakness.meters || {};
            char.weakness.tiers = char.weakness.tiers || {};
            char.weakness.meters.cold = (char.weakness.meters.cold || 0) + coldMeter;
            char.weakness.tiers.cold = weaknessTierFromMeter(char.weakness.meters.cold);
            spreadMeta.push({ targetId: char.id || char.name, family: "cold", amount: coldMeter });
          });
        }
      }

      return {
        ...roll,
        amount,
        element: "cold",
        log,
        proliferatedWeakness: spreadMeta.length ? spreadMeta : undefined,
      };
    },
    description: "Agile steps cut in and out-steal tempo against weakened foes and mirror their Frost to a neighbor."
  },

  // -------- Payoff (7) --------
  'arc_finish': {
    id: "arc_finish",
    name: "Arc Finish",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sword_2h"],
    requiredStat: "STR",
    requiredValue: 17,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "aoe", "finisher", "consume"],
    emitTagsOnUse: ["slash"],
    cooldown: 3,
    aoe: { shape: "column", scale: 1 },
    requiresWeakness: { family: "lacerate", tierAtLeast: 1 },
    consumeWeakness: ["lacerate"],
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.arc_finish;
      const roll = calculateDamage(attacker, target, ability);
      const baseAmount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const computeDamage = (victim, base, scale = 1) => {
        if (!victim) return { amount: Math.max(1, Math.floor(base * scale)), burst: 0, cleared: false };
        let amount = Math.max(1, Math.floor(base * scale));
        const meter = victim?.weakness?.meters?.lacerate || 0;
        const tier = victim?.weakness?.tiers?.lacerate || 0;
        if (tier >= 1) {
          amount = Math.floor(amount * (1 + 0.12 * tier));
        }
        let burst = 0;
        if (meter > 0) {
          const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
          burst = Math.max(0, Math.floor((meter / 14) + (tier * 6) + Math.max(0, intensity - 1) * 8));
          amount += burst;
        }
        let cleared = false;
        if (victim?.weakness?.meters) {
          victim.weakness.meters.lacerate = 0;
          if (victim.weakness.tiers) {
            victim.weakness.tiers.lacerate = weaknessTierFromMeter(0);
          }
          cleared = meter > 0;
        }
        return { amount: Math.max(1, amount), burst, cleared };
      };

      const main = computeDamage(target, baseAmount, 1);
      const splash = [];
      if (scene && target && typeof scene._getUnitColumn === "function" && typeof scene._getColumnBySlotId === "function") {
        const column = scene._getUnitColumn(target);
        if (column) {
          const sideSlots = target?.isEnemy ? scene.enemySlots : scene.allySlots;
          const others = sideSlots
            ?.filter(slot => slot?.char && slot.char !== target && slot.char.status !== "incapacitated" && scene._getColumnBySlotId(slot.slotId) === column)
            .map(slot => slot.char) || [];
          others.slice(0, 2).forEach(char => {
            const res = computeDamage(char, baseAmount, 0.85);
            splash.push({
              target: char,
              amount: res.amount,
              consumeWeakness: ability?.consumeWeakness ? [...ability.consumeWeakness] : undefined,
              tags: ability?.tags,
            });
          });
        }
      }

      return {
        ...roll,
        amount: main.amount,
        consumeWeakness: ability?.consumeWeakness ? [...ability.consumeWeakness] : undefined,
        splash: splash.length ? splash : undefined,
      };
    },
    description: "A crushing follow-through against bleeding foes; converts stored blood into a finishing sweep."
  },

  'glacial_crack': {
    id: "glacial_crack",
    name: "Glacial Crack",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sword_2h"],
    requiredStat: "WIS",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "cold", "consume", "control"],
    emitTagsOnUse: ["smash"],
    cooldown: 3,
    requiresWeakness: { family: "cold", tierAtLeast: 2 },
    consumeWeakness: ["cold"],
    statusEffects: [{ id: "rooted", turns: 1 }],
    transformWeakness: { from: "cold", to: "immobilized", ratio: 1 },
    apply: (attacker, target) => {
      const ability = SKILLS?.glacial_crack;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: "cold",
        skipGearMultiplier: true,
      }));
      const meter = target?.weakness?.meters?.cold || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      amount = Math.floor(amount * (1 + Math.max(0.15, (intensity - 1) * 0.15)));

      const statusEffects = Array.isArray(ability?.statusEffects)
        ? ability.statusEffects.map(effect => ({ ...effect }))
        : undefined;

      return {
        ...roll,
        amount,
        isMagic: true,
        element: "cold",
        statusEffects,
        consumeWeakness: ability?.consumeWeakness ? [...ability.consumeWeakness] : undefined,
        transformWeakness: ability?.transformWeakness ? { ...ability.transformWeakness } : undefined,
      };
    },
    description: "Bring the blade down to shatter Frost, rooting the frozen target and converting Cold into binding ice."
  },

  'avalanche_crash': {
    id: "avalanche_crash",
    name: "Avalanche Crash",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sword_2h"],
    requiredStat: "STR",
    requiredValue: 17,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "cold", "aoe", "consume"],
    emitTagsOnUse: ["smash"],
    cooldown: 3,
    aoe: { shape: "cone", scale: 1 },
    conditionHint: { requiresColdInArea: true },
    consumeWeakness: ["cold"],
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.avalanche_crash;
      const roll = calculateDamage(attacker, target, ability);
      const baseAmount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: "cold",
        skipGearMultiplier: true,
      }));

      const hitOne = (victim, scale = 1) => {
        if (!victim) return { amount: 0 };
        let amt = Math.max(1, Math.floor(baseAmount * scale));
        const coldTier = victim?.weakness?.tiers?.cold || 0;
        if (coldTier > 0) {
          amt = Math.floor(amt * (1 + 0.12 * coldTier));
        }
        const meter = victim?.weakness?.meters?.cold || 0;
        const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
        if (intensity > 1) {
          amt = Math.floor(amt * (1 + Math.max(0, intensity - 1) * 0.12));
        }
        if (victim?.weakness?.meters) {
          victim.weakness.meters.cold = 0;
          if (victim.weakness.tiers) {
            victim.weakness.tiers.cold = weaknessTierFromMeter(0);
          }
        }
        return { amount: Math.max(1, amt) };
      };

      const main = hitOne(target, 1);
      const splash = [];
      if (scene && target && typeof scene._getUnitColumn === "function" && typeof scene._getColumnBySlotId === "function") {
        const column = scene._getUnitColumn(target);
        if (column) {
          const sideSlots = target?.isEnemy ? scene.enemySlots : scene.allySlots;
          const others = sideSlots
            ?.filter(slot => slot?.char && slot.char !== target && slot.char.status !== "incapacitated" && scene._getColumnBySlotId(slot.slotId) === column)
            .map(slot => slot.char) || [];
          others.slice(0, 2).forEach(char => {
            const res = hitOne(char, 0.8);
            splash.push({
              target: char,
              amount: res.amount,
              element: "cold",
              consumeWeakness: ability?.consumeWeakness ? [...ability.consumeWeakness] : undefined,
              tags: ability?.tags,
            });
          });
        }
      }

      return {
        ...roll,
        amount: main.amount,
        isMagic: true,
        element: "cold",
        consumeWeakness: ability?.consumeWeakness ? [...ability.consumeWeakness] : undefined,
        splash: splash.length ? splash : undefined,
      };
    },
    description: "Drive the blade into the ground, sending a frost wave through the line and collapsing Cold stacks."
  },

  'riposte_cyclone': {
    id: "riposte_cyclone",
    name: "Riposte Cyclone",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sword_2h"],
    requiredStat: "DEX",
    requiredValue: 16,
    actionCost: "bonus",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "aoe"],
    emitTagsOnUse: ["spin"],
    cooldown: 3,
    aoe: { shape: "cone", scale: 1 },
    conditionHint: { dodgedOrParriedThisRound: true },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.riposte_cyclone;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      amount = Math.max(1, Math.floor(amount * 0.9));

      const exposeTier = target?.weakness?.tiers?.expose || 0;
      if (exposeTier >= 1) {
        amount = Math.floor(amount * (1 + 0.12 * exposeTier));
      }

      const splash = [];
      if (scene && target && typeof scene._getUnitColumn === "function" && typeof scene._getColumnBySlotId === "function") {
        const column = scene._getUnitColumn(target);
        if (column) {
          const sideSlots = target?.isEnemy ? scene.enemySlots : scene.allySlots;
          const others = sideSlots
            ?.filter(slot => slot?.char && slot.char !== target && slot.char.status !== "incapacitated" && scene._getColumnBySlotId(slot.slotId) === column)
            .map(slot => slot.char) || [];
          others.slice(0, 2).forEach(char => {
            let splashAmount = Math.max(1, Math.floor(amount * 0.75));
            const tier = char?.weakness?.tiers?.expose || 0;
            if (tier >= 1) {
              splashAmount = Math.floor(splashAmount * (1 + 0.1 * tier));
            }
            splash.push({
              target: char,
              amount: splashAmount,
              tags: ability?.tags,
            });
          });
        }
      }

      return {
        ...roll,
        amount,
        splash: splash.length ? splash : undefined,
      };
    },
    description: "A spinning counter released after an evade; harsher on exposed foes nearby."
  },

  'aura_of_frost': {
    id: "aura_of_frost",
    name: "Aura of Frost",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sword_2h"],
    requiredStat: "WIS",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "attack", "cold", "aoe", "consume"],
    emitTagsOnUse: ["frost"],
    cooldown: 4,
    aoe: { shape: "cone", scale: 1 },
    conditionHint: { requiresFrostZone: true },
    consumeWeakness: ["cold"],
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.aura_of_frost;
      const roll = calculateDamage(attacker, target, ability);
      const baseAmount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: "cold",
        isMagic: true,
        skipGearMultiplier: true,
      }));

      const hitOne = (victim, scale = 1) => {
        if (!victim) return { amount: 0 };
        let amt = Math.max(1, Math.floor(baseAmount * scale));
        const coldTier = victim?.weakness?.tiers?.cold || 0;
        if (coldTier > 0) {
          amt = Math.floor(amt * (1 + 0.1 * coldTier));
        }
        if (victim?.weakness?.meters?.cold) {
          victim.weakness.meters.cold = 0;
          if (victim.weakness.tiers) {
            victim.weakness.tiers.cold = weaknessTierFromMeter(victim.weakness.meters.cold);
          }
        }
        return { amount: Math.max(1, amt) };
      };

      const main = hitOne(target, 1);
      const splash = [];
      if (scene && target && typeof scene._getUnitColumn === "function" && typeof scene._getColumnBySlotId === "function") {
        const column = scene._getUnitColumn(target);
        if (column) {
          const sideSlots = target?.isEnemy ? scene.enemySlots : scene.allySlots;
          const others = sideSlots
            ?.filter(slot => slot?.char && slot.char !== target && slot.char.status !== "incapacitated" && scene._getColumnBySlotId(slot.slotId) === column)
            .map(slot => slot.char) || [];
          others.slice(0, 2).forEach(char => {
            const res = hitOne(char, 0.85);
            splash.push({
              target: char,
              amount: res.amount,
              isMagic: true,
              element: "cold",
              consumeWeakness: ability?.consumeWeakness ? [...ability.consumeWeakness] : undefined,
              tags: ability?.tags,
            });
          });
        }
      }

      return {
        ...roll,
        amount: main.amount,
        isMagic: true,
        element: "cold",
        consumeWeakness: ability?.consumeWeakness ? [...ability.consumeWeakness] : undefined,
        splash: splash.length ? splash : undefined,
      };
    },
    description: "Unleash a frost aura around the swing; chilled foes suffer more before their Cold dissipates."
  },

  'executioners_edge': {
    id: "executioners_edge",
    name: "Executioner's Edge",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sword_2h"],
    requiredStat: "STR",
    requiredValue: 18,
    actionCost: "major",
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "execute", "consume"],
    emitTagsOnUse: ["slash"],
    cooldown: 3,
    requiresWeakness: { family: "lacerate", tierAtLeast: 2 },
    consumeWeakness: ["lacerate"],
    statusEffects: [{ id: "weakened", turns: 2, mods: { PhysicalResist: -12, damageDownPct: 10 } }],
    rewardIfTierCross: [{ family: "lacerate", tier: 2, debuff: { bleedResDownPct: 20, turns: 2 } }],
    apply: (attacker, target) => {
      const ability = SKILLS?.executioners_edge;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      amount = Math.floor(amount * 1.25);

      const meter = target?.weakness?.meters?.lacerate || 0;
      const tier = target?.weakness?.tiers?.lacerate || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      if (tier > 0) {
        amount = Math.floor(amount * (1 + 0.18 * tier));
      }
      if (intensity > 1) {
        amount = Math.floor(amount * (1 + Math.max(0, intensity - 1) * 0.2));
      }

      const statusEffects = Array.isArray(ability?.statusEffects)
        ? ability.statusEffects.map(effect => ({ ...effect }))
        : undefined;

      return {
        ...roll,
        amount,
        statusEffects,
        consumeWeakness: ability?.consumeWeakness ? [...ability.consumeWeakness] : undefined,
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
      };
    },
    description: "A decisive finisher for deeply bleeding foes; leaves them weakened and strips bleed resistance."
  },

  'harmony_strike': {
    id: "harmony_strike",
    name: "Harmony Strike",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sword_2h"],
    requiredStat: "CHA",
    requiredValue: 17,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "aoe", "support"],
    emitTagsOnUse: ["slash"],
    cooldown: 3,
    aoe: { shape: "column", scale: 1 },
    conditionHint: { requiresMultipleWeakenedEnemies: true },
    healPerStatus: 3,
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.harmony_strike;
      const roll = calculateDamage(attacker, target, ability);
      const baseAmount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const families = ["expose", "lacerate"];
      const trimOneStack = (victim) => {
        let consumed = 0;
        if (!victim?.weakness) return consumed;
        victim.weakness.meters = victim.weakness.meters || {};
        victim.weakness.tiers = victim.weakness.tiers || {};
        families.forEach(f => {
          const meter = victim.weakness.meters?.[f] || 0;
          if (meter > 0) {
            const newMeter = Math.max(0, meter - 100);
            victim.weakness.meters[f] = newMeter;
            victim.weakness.tiers[f] = weaknessTierFromMeter(newMeter);
            consumed += 1;
          }
        });
        return consumed;
      };

      const applyOn = (victim, scale = 1) => {
        if (!victim) return { amount: 0, consumed: 0 };
        let amt = Math.max(1, Math.floor(baseAmount * scale));
        const consumed = trimOneStack(victim);
        if (consumed > 0) {
          amt = Math.floor(amt * (1 + 0.1 * consumed));
        }
        return { amount: Math.max(1, amt), consumed };
      };

      const main = applyOn(target, 1);
      const splash = [];
      let totalConsumed = main.consumed;
      if (scene && target && typeof scene._getUnitColumn === "function" && typeof scene._getColumnBySlotId === "function") {
        const column = scene._getUnitColumn(target);
        if (column) {
          const sideSlots = target?.isEnemy ? scene.enemySlots : scene.allySlots;
          const others = sideSlots
            ?.filter(slot => slot?.char && slot.char !== target && slot.char.status !== "incapacitated" && scene._getColumnBySlotId(slot.slotId) === column)
            .map(slot => slot.char) || [];
          others.slice(0, 2).forEach(char => {
            const res = applyOn(char, 0.9);
            totalConsumed += res.consumed;
            splash.push({
              target: char,
              amount: res.amount,
              tags: ability?.tags,
            });
          });
        }
      }

      const healPerStatus = ability?.healPerStatus ?? 3;
      let healedAllies;
      // KNOWN BUG, not yet fixed (found while fixing the identical issue in
      // Sacred Shockwave): attacker.team is a STRING ('ally'/'enemy'), not an
      // array of teammates — .forEach on it throws, gets caught by
      // CombatScene's ability-apply try/catch, and the whole cast silently
      // "fizzles" (discarding damage already computed above) whenever this
      // block is reached with totalConsumed > 0. Fix: enumerate via
      // scene.allySlots/enemySlots instead, same as every other skill in
      // this file. Left alone for now — revisit when this weapon type gets
      // its own pass.
      if (attacker?.team && totalConsumed > 0) {
        healedAllies = [];
        attacker.team.forEach(ally => {
          if (!ally) return;
          const maxHP = ally.maxHP ?? ally.derivedStats?.maxHP ?? 0;
          if (maxHP <= 0) return;
          const heal = totalConsumed * healPerStatus;
          const before = ally.currentHP ?? 0;
          const after = Math.min(maxHP, before + heal);
          ally.currentHP = after;
          healedAllies.push({ id: ally.id || ally.name, healed: after - before });
        });
      }

      return {
        ...roll,
        amount: main.amount,
        splash: splash.length ? splash : undefined,
        healedAllies: healedAllies && healedAllies.length ? healedAllies : undefined,
      };
    },
    description: "A sweeping cut that harmonizes the battlefield-prunes Expose/Bleed by a stack and shares a small heal per status to nearby allies."
  },

  // ===============================
  // v3.22 - Sling (1h)
  // ============================================================
  // Active (17): pebble_drum, sandbite, angle_bank, scouts_breath,
  //   tracer_shot, stone_hail, frost_pebble, ricochet_mark, lodging_stone,
  //   searing_pitch, thunder_skip,
  //   shatter_lodge, ricochet_barrage, disease_spread,
  //   charged_throw, seeding_salvo, sandstorm_burst, scouting_report
  // Deferred (commented): see bottom of section
  // ============================================================

  // -------- Generation (11) --------

  'pebble_drum': {
    id: "pebble_drum",
    name: "Pebble Drum",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["sling"],
    requiredStat: "DEX",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "disorient"],
    emitTagsOnUse: ["projectile"],
    buildupHint: { disorient: 60 },
    apply: (attacker, target) => {
      const ability = SKILLS?.pebble_drum;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability, tags: ability?.tags, skipGearMultiplier: true,
      }));
      amount = Math.floor(amount * 0.95);

      const disorientTier = target?.weakness?.tiers?.disorient || 0;
      const mpGain = disorientTier >= 1 ? 3 : undefined;

      return {
        ...roll,
        amount,
        buildup: { disorient: ability?.buildupHint?.disorient ?? 60 },
        mpGain,
      };
    },
    description: "Rapid rattling shots. Restores 3 MP if target is already Disoriented.",
  },

  'sandbite': {
    id: "sandbite",
    name: "Sandbite",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["sling"],
    requiredStat: "DEX",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "disease"],
    emitTagsOnUse: ["projectile"],
    buildupHint: { disease: 90 },
    apply: (attacker, target) => {
      const ability = SKILLS?.sandbite;
      const roll = calculateDamage(attacker, target, ability);
      const amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability, tags: ability?.tags, skipGearMultiplier: true,
      }));

      const diseaseMeter = target?.weakness?.meters?.disease || 0;
      const diseaseTier = target?.weakness?.tiers?.disease || 0;
      const baseBuildup = ability?.buildupHint?.disease ?? 90;
      const newTier = weaknessTierFromMeter(diseaseMeter + baseBuildup);
      const tierCross = diseaseTier === 0 && newTier >= 1;

      return {
        ...roll,
        amount,
        buildup: { disease: baseBuildup, ...(tierCross ? { expose: 40, lacerate: 40 } : {}) },
        log: tierCross ? `${attacker?.name ?? 'The slinger'} opens the wound — +40 Expose and Lacerate!` : undefined,
      };
    },
    description: "Grit-tipped shot that seeds disease. Crossing Disease T1 also applies 40 Expose and 40 Lacerate.",
  },

  'angle_bank': {
    id: "angle_bank",
    name: "Angle Bank",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["sling"],
    requiredStat: "DEX",
    requiredValue: 13,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack"],
    emitTagsOnUse: ["projectile"],
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.angle_bank;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability, tags: ability?.tags, skipGearMultiplier: true,
      }));
      amount = Math.floor(amount * 1.10);

      // +50% if target is standing on an active quake zone
      const slotKey = scene?._charSlotKey?.(target);
      const hasQuake = slotKey && (scene?.slotEffects?.[slotKey] || []).some(
        e => e.isQuakeZone && (e.turns || 0) > 0
      );
      if (hasQuake) {
        amount = Math.floor(amount * 1.50);
      }

      return {
        ...roll,
        amount,
        log: hasQuake ? `${attacker?.name ?? 'The slinger'} banks off the quake — +50% damage!` : undefined,
      };
    },
    description: "A banking shot off terrain. 110% damage; +50% if target stands on a quake zone.",
  },

  'scouts_breath': {
    id: "scouts_breath",
    name: "Scout's Breath",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["sling"],
    requiredStat: "DEX",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 0,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["support", "initiative"],
    apply: (attacker) => {
      let disorientCleared = 0;
      if (attacker?.weakness?.meters) {
        disorientCleared = Math.min(200, attacker.weakness.meters.disorient || 0);
        if (disorientCleared > 0) {
          attacker.weakness.meters.disorient = Math.max(0, (attacker.weakness.meters.disorient || 0) - 200);
          attacker.weakness.tiers = attacker.weakness.tiers || {};
          attacker.weakness.tiers.disorient = weaknessTierFromMeter(attacker.weakness.meters.disorient);
        }
      }
      return {
        amount: 0,
        initiativeGained: 5,
        log: `${attacker?.name ?? 'The slinger'} steadies — +5 initiative${disorientCleared > 0 ? `, cleared ${disorientCleared} disorient` : ''}.`,
      };
    },
    description: "Steady your aim. Gain +5 initiative and purge up to 200 self-disorient.",
  },

  'tracer_shot': {
    id: "tracer_shot",
    name: "Tracer Shot",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["sling"],
    requiredStat: "DEX",
    requiredValue: 13,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "lodge"],
    emitTagsOnUse: ["projectile", "lodge"],
    apply: (attacker, target) => {
      const ability = SKILLS?.tracer_shot;
      const roll = calculateDamage(attacker, target, ability);
      const amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability, tags: ability?.tags, skipGearMultiplier: true,
      }));

      target.statusEffects = target.statusEffects || [];
      target.statusEffects.push({
        id: 'lodged',
        turns: 999,
        stackable: true,
        tickBuildup: { expose: 30, fire: 30 },
        onRip: { physDamagePct: 25, physDamagePctPerLodge: 10 },
      });

      const lodgeCount = (target.statusEffects).filter(se => se?.id === 'lodged').length;
      return {
        ...roll,
        amount,
        log: `${attacker?.name ?? 'The slinger'} marks ${target?.name ?? 'the target'} with a tracer lodge (${lodgeCount} total).`,
      };
    },
    description: "Marked shot that lodges in the wound. Pulses 30 Expose + 30 Fire buildup/turn. On rip: 25% weapon damage (+10%/lodge).",
  },

  'stone_hail': {
    id: "stone_hail",
    name: "Stone Hail",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["sling"],
    requiredStat: "DEX",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "expose", "aoe"],
    emitTagsOnUse: ["projectile"],
    buildupHint: { expose: 40 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.stone_hail;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability, tags: ability?.tags, skipGearMultiplier: true,
      }));
      amount = Math.floor(amount * 0.90);

      const coldTier = target?.weakness?.tiers?.cold || 0;
      const exposeBuildup = coldTier >= 1 ? 100 : (ability?.buildupHint?.expose ?? 40);

      const splash = resolveAOESplash(scene, target, { shape: 'column' }).map(char => ({
        target: char,
        amount: Math.floor(amount * 0.70),
        buildup: { expose: 40 },
        tags: ability?.tags,
      }));

      return {
        ...roll,
        amount,
        buildup: { expose: exposeBuildup },
        splash: splash.length ? splash : undefined,
      };
    },
    description: "Scatter stones down the rank. 90% damage + 40 Expose (100 if target is Chilled). Column splash at 70%.",
  },

  'frost_pebble': {
    id: "frost_pebble",
    name: "Frost Pebble",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["sling"],
    requiredStat: "WIS",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 0,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "cold"],
    emitTagsOnUse: ["projectile"],
    buildupHint: { cold: 60 },
    rewardIfTierCross: [{ family: "cold", tier: 1, debuff: { speedDownPct: 10, turns: 1 } }],
    apply: (attacker, target) => {
      const ability = SKILLS?.frost_pebble;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability, tags: ability?.tags, element: 'cold', isMagic: true, skipGearMultiplier: true,
      }));

      const coldTier = target?.weakness?.tiers?.cold || 0;
      const coldMeter = target?.weakness?.meters?.cold || 0;
      const intensity = Math.max(1, weaknessIntensityMult(coldMeter) || 1);
      let buildup = ability?.buildupHint?.cold ?? 60;
      if (coldTier >= 1) {
        amount = Math.floor(amount * (1 + 0.10 * coldTier));
        buildup += Math.max(4, Math.floor(5 * intensity));
      }

      return {
        ...roll,
        amount,
        isMagic: true,
        element: 'cold',
        buildup: { cold: buildup },
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
      };
    },
    description: "Bonus-action chilled lob. Crossing Cold T1 briefly slows the target.",
  },

  'ricochet_mark': {
    id: "ricochet_mark",
    name: "Ricochet Mark",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["sling"],
    requiredStat: "DEX",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "expose", "proliferate"],
    emitTagsOnUse: ["projectile"],
    buildupHint: { expose: 45 },
    proliferateWeakness: { families: ["expose"], to: "adjacent", ratio: 0.5, maxTargets: 1 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.ricochet_mark;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability, tags: ability?.tags, skipGearMultiplier: true,
      }));

      const baseBuildup = ability?.buildupHint?.expose ?? 45;
      const spreadMeta = [];

      if (scene && target && typeof scene._getUnitColumn === 'function' && typeof scene._getColumnBySlotId === 'function') {
        const column = scene._getUnitColumn(target);
        if (column) {
          const sideSlots = target?.isEnemy ? scene.enemySlots : scene.allySlots;
          const neighbors = sideSlots
            ?.filter(slot => slot?.char && slot.char !== target && slot.char.status !== 'incapacitated' && scene._getColumnBySlotId(slot.slotId) === column)
            .map(slot => slot.char) || [];
          const maxTargets = ability?.proliferateWeakness?.maxTargets ?? 1;
          const ratio = ability?.proliferateWeakness?.ratio ?? 0.5;
          const sourceMeter = target?.weakness?.meters?.expose || 0;

          neighbors.slice(0, maxTargets).forEach(char => {
            const transfer = Math.max(0, Math.floor(sourceMeter * ratio));
            if (transfer > 0) {
              char.weakness = char.weakness || { meters: {}, tiers: {} };
              char.weakness.meters = char.weakness.meters || {};
              char.weakness.tiers = char.weakness.tiers || {};
              char.weakness.meters.expose = (char.weakness.meters.expose || 0) + transfer;
              char.weakness.tiers.expose = weaknessTierFromMeter(char.weakness.meters.expose);
              spreadMeta.push({ targetId: char.id || char.name, family: 'expose', amount: transfer });
            }
          });
        }
      }

      return {
        ...roll,
        amount,
        buildup: { expose: baseBuildup },
        proliferatedWeakness: spreadMeta.length ? spreadMeta : undefined,
      };
    },
    description: "Bank the shot — 50% of target's Expose transfers to a column neighbor.",
  },

  'lodging_stone': {
    id: "lodging_stone",
    name: "Lodging Stone",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["sling"],
    requiredStat: "DEX",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "lodge"],
    emitTagsOnUse: ["projectile", "lodge"],
    apply: (attacker, target) => {
      const ability = SKILLS?.lodging_stone;
      const roll = calculateDamage(attacker, target, ability);
      const amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability, tags: ability?.tags, skipGearMultiplier: true,
      }));

      target.statusEffects = target.statusEffects || [];
      target.statusEffects.push({ id: 'lodged', turns: 999, stackable: true });

      const lodgeCount = target.statusEffects.filter(se => se?.id === 'lodged').length;
      return {
        ...roll,
        amount,
        log: `${attacker?.name ?? 'The slinger'} lodges a stone in ${target?.name ?? 'the target'} (${lodgeCount} lodge${lodgeCount !== 1 ? 's' : ''}).`,
      };
    },
    description: "Bonus-action: embed a lodge in the wound. Stacks. Amplifies all shatter effects.",
  },

  'searing_pitch': {
    id: "searing_pitch",
    name: "Searing Pitch",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["sling"],
    requiredStat: "INT",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 0,
    cooldown: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "fire"],
    emitTagsOnUse: ["projectile"],
    buildupHint: { fire: 60 },
    apply: (attacker, target) => {
      const ability = SKILLS?.searing_pitch;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability, tags: ability?.tags, element: 'fire', isMagic: true, skipGearMultiplier: true,
      }));
      const coldTier = target?.weakness?.tiers?.cold || 0;
      let fireBuildup = ability?.buildupHint?.fire ?? 60;
      if (coldTier >= 1) {
        amount = Math.floor(amount * 1.20);
        fireBuildup += 20;
      }
      return {
        ...roll,
        amount,
        isMagic: true,
        element: 'fire',
        buildup: { fire: fireBuildup },
      };
    },
    description: "Sticky burning shot. +20% damage and +20 fire buildup on Chilled targets.",
  },

  'thunder_skip': {
    id: "thunder_skip",
    name: "Thunder Skip",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["sling"],
    requiredStat: "DEX",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 0,
    cooldown: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "lightning", "bounce"],
    emitTagsOnUse: ["projectile"],
    buildupHint: { lightning: 60 },
    apply: (attacker, target) => {
      const ability = SKILLS?.thunder_skip;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability, tags: ability?.tags, element: 'lightning', isMagic: true, skipGearMultiplier: true,
      }));
      const fireTier = target?.weakness?.tiers?.fire || 0;
      if (fireTier >= 2) amount = Math.floor(amount * 1.20);
      return {
        ...roll,
        amount,
        isMagic: true,
        element: 'lightning',
        buildup: { lightning: ability?.buildupHint?.lightning ?? 60 },
        bounce: true,
      };
    },
    description: "Charged arcing shot that bounces to a second target. +20% on Ablaze foes.",
  },

  // -------- Payoff (7) --------

  'shatter_lodge': {
    id: "shatter_lodge",
    name: "Shatter Lodge",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["sling"],
    requiredStat: "DEX",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "consume"],
    canExecute: ({ target }) => {
      const stacks = (target?.statusEffects || []).filter(e => e?.id === 'lodged').length;
      if (stacks === 0) return { ok: false, reason: "Target has no lodged stones." };
      return true;
    },
    apply: (attacker, target) => {
      const ability = SKILLS?.shatter_lodge;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability, tags: ability?.tags, skipGearMultiplier: true,
      }));

      const lodgedList = (target?.statusEffects || []).filter(e => e?.id === 'lodged');
      const stacks = lodgedList.length;
      const burstFlat = stacks * 8;
      amount += burstFlat;

      // Process onRip effects — physDamagePct fires once (scales with total stacks)
      let onRipBonus = 0;
      let poisonTickCount = 0;
      let poisonTickDamage = 12;
      let hasPhysRip = false;

      for (const lodge of lodgedList) {
        if (!lodge.onRip) continue;
        if (lodge.onRip.physDamagePct && !hasPhysRip) {
          hasPhysRip = true;
          const pct = lodge.onRip.physDamagePct + (lodge.onRip.physDamagePctPerLodge || 0) * (stacks - 1);
          onRipBonus += Math.floor(roll.amount * pct / 100);
        }
        if (lodge.onRip.poisonTicks) {
          poisonTickCount += lodge.onRip.poisonTicks;
          if (lodge.onRip.tickDamage) poisonTickDamage = lodge.onRip.tickDamage;
        }
      }

      amount += onRipBonus;

      return {
        ...roll,
        amount,
        consumeWeakness: ['lodged'],
        poisonTicks: poisonTickCount > 0 ? { count: poisonTickCount, damageEach: poisonTickDamage } : undefined,
        log: `${attacker?.name ?? 'The slinger'} shatters ${stacks} lodge${stacks > 1 ? 's' : ''} for +${burstFlat + onRipBonus} bonus damage!`,
      };
    },
    description: "+8 damage per lodge. Fires all lodge rip effects. Consumes all lodges.",
  },

  'ricochet_barrage': {
    id: "ricochet_barrage",
    name: "Ricochet Barrage",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["sling"],
    requiredStat: "DEX",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "expose", "consume"],
    emitTagsOnUse: ["projectile"],
    // TODO: full sequential multi-target selection flow in CombatScene
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.ricochet_barrage;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability, tags: ability?.tags, skipGearMultiplier: true,
      }));

      // Consume up to 400 expose from primary — bonus carried to adjacent targets
      const exposeMeter = target?.weakness?.meters?.expose || 0;
      const consumed = Math.min(400, exposeMeter);
      if (consumed > 0) {
        target.weakness.meters.expose = exposeMeter - consumed;
        target.weakness.tiers.expose = weaknessTierFromMeter(target.weakness.meters.expose);
      }
      const bonusPct = Math.floor(consumed / 100) * 12; // +12% per 100 consumed

      const cascadeAmount = Math.floor(amount * (1 + bonusPct / 100));
      const splash = resolveAOESplash(scene, target, { shape: 'adjacent' }).slice(0, 2).map(char => ({
        target: char,
        amount: cascadeAmount,
        tags: ability?.tags,
      }));

      return {
        ...roll,
        amount,
        splash: splash.length ? splash : undefined,
        log: consumed > 0
          ? `${attacker?.name ?? 'The slinger'} barrage — ${consumed} expose consumed, +${bonusPct}% cascade damage!`
          : undefined,
      };
    },
    description: "Three-shot burst. Consumes primary's Expose (+12%/100) and carries the bonus to adjacent targets. [TODO: sequential targeting]",
  },

  'disease_spread': {
    id: "disease_spread",
    name: "Disease Spread",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["sling"],
    requiredStat: "DEX",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "disease", "necrotic", "consume"],
    emitTagsOnUse: ["projectile"],
    requiresWeakness: { family: "disease", tierAtLeast: 1 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.disease_spread;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability, tags: ability?.tags, skipGearMultiplier: true,
      }));
      amount = Math.floor(amount * 0.50);

      const diseaseMeter = target?.weakness?.meters?.disease || 0;
      const consumed = Math.min(400, diseaseMeter);
      if (consumed > 0) {
        target.weakness.meters.disease = diseaseMeter - consumed;
        target.weakness.tiers.disease = weaknessTierFromMeter(target.weakness.meters.disease);
      }

      const adjacentTargets = resolveAOESplash(scene, target, { shape: 'adjacent' });
      const spreadEach = adjacentTargets.length > 0 ? consumed : 0;
      const splashBase = Math.max(1, Math.floor(roll.amount * 0.50));

      const splash = adjacentTargets.map(char => ({
        target: char,
        amount: splashBase,
        buildup: spreadEach > 0 ? { disease: spreadEach } : undefined,
        isMagic: true,
        element: 'necrotic',
        tags: ability?.tags,
      }));

      return {
        ...roll,
        amount,
        isMagic: true,
        element: 'necrotic',
        splash: splash.length ? splash : undefined,
        log: consumed > 0
          ? `${attacker?.name ?? 'The slinger'} spreads ${consumed} disease to ${adjacentTargets.length} adjacent foe${adjacentTargets.length !== 1 ? 's' : ''}!`
          : undefined,
      };
    },
    description: "Req disease T1+. Consumes up to 400 disease and proliferates it to all adjacent enemies. 50% necrotic to each.",
  },

  'charged_throw': {
    id: "charged_throw",
    name: "Charged Throw",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["sling"],
    requiredStat: "DEX",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "lightning", "fire", "consume"],
    emitTagsOnUse: ["projectile"],
    requiresWeakness: { family: "lightning", tierAtLeast: 1 },
    apply: (attacker, target) => {
      const ability = SKILLS?.charged_throw;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability, tags: ability?.tags, skipGearMultiplier: true,
      }));

      const lightningMeter = target?.weakness?.meters?.lightning || 0;
      const consumed = Math.min(200, lightningMeter);
      if (consumed > 0) {
        target.weakness.meters.lightning = lightningMeter - consumed;
        target.weakness.tiers.lightning = weaknessTierFromMeter(target.weakness.meters.lightning);
      }
      const bonusPct = Math.floor(consumed / 100) * 60; // 0, 60, or 120
      amount = Math.floor(amount * (1 + bonusPct / 100));
      amount += 80; // flat fire damage

      return {
        ...roll,
        amount,
        log: consumed > 0
          ? `${attacker?.name ?? 'The slinger'} charged throw — ${consumed} lightning consumed for +${bonusPct}% damage!`
          : undefined,
      };
    },
    description: "Req lightning T1+. Consumes up to 200 lightning: +60%/100 consumed (max +120%). Deals +80 flat fire damage.",
  },

  'seeding_salvo': {
    id: "seeding_salvo",
    name: "Seeding Salvo",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["sling"],
    requiredStat: "DEX",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "disease", "toxic", "lodge", "consume"],
    emitTagsOnUse: ["projectile", "lodge"],
    requiresWeakness: { family: "disease", tierAtLeast: 1 },
    apply: (attacker, target) => {
      const ability = SKILLS?.seeding_salvo;
      const roll = calculateDamage(attacker, target, ability);
      const amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability, tags: ability?.tags, skipGearMultiplier: true,
      }));

      // Transform up to 200 disease → toxic
      const diseaseMeter = target?.weakness?.meters?.disease || 0;
      const transformed = Math.min(200, diseaseMeter);
      if (transformed > 0) {
        target.weakness.meters.disease = diseaseMeter - transformed;
        target.weakness.tiers.disease = weaknessTierFromMeter(target.weakness.meters.disease);
        target.weakness.meters = target.weakness.meters || {};
        target.weakness.tiers = target.weakness.tiers || {};
        target.weakness.meters.toxic = (target.weakness.meters.toxic || 0) + transformed;
        target.weakness.tiers.toxic = weaknessTierFromMeter(target.weakness.meters.toxic);
      }

      // Apply lodge with toxic/disease tick buildup and poison-on-rip
      target.statusEffects = target.statusEffects || [];
      target.statusEffects.push({
        id: 'lodged',
        turns: 999,
        stackable: true,
        tickBuildup: { toxic: 20, disease: 20 },
        onRip: { poisonTicks: 2, tickDamage: 12 },
      });

      const lodgeCount = target.statusEffects.filter(se => se?.id === 'lodged').length;
      return {
        ...roll,
        amount,
        log: `${attacker?.name ?? 'The slinger'} seeds a toxic lodge${transformed > 0 ? ` — ${transformed} disease transformed to toxic` : ''} (${lodgeCount} lodge${lodgeCount !== 1 ? 's' : ''}).`,
      };
    },
    description: "Req disease T1+. Converts up to 200 disease → toxic and lodges a festering stone (20 toxic + 20 disease/turn, 2 poison ticks on rip).",
  },

  'sandstorm_burst': {
    id: "sandstorm_burst",
    name: "Sandstorm Burst",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["sling"],
    requiredStat: "DEX",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "disorient", "aoe"],
    emitTagsOnUse: ["projectile"],
    buildupHint: { necrotic: 60 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.sandstorm_burst;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability, tags: ability?.tags, skipGearMultiplier: true,
      }));

      const primaryDiseased = (target?.weakness?.tiers?.disease || 0) >= 1;

      const splash = resolveAOESplash(scene, target, { shape: 'diamond' }).map(char => ({
        target: char,
        amount: Math.floor(amount * 0.70),
        buildup: (char?.weakness?.tiers?.disease || 0) >= 1 ? { necrotic: 60 } : undefined,
        tags: ability?.tags,
      }));

      return {
        ...roll,
        amount,
        buildup: primaryDiseased ? { necrotic: 60 } : undefined,
        splash: splash.length ? splash : undefined,
        onKill: { disorientAll: 60 },
      };
    },
    description: "Diamond AOE. 60 necrotic buildup on diseased targets. On kill: 60 disorient to all remaining enemies.",
  },

  'scouting_report': {
    id: "scouting_report",
    name: "Scouting Report",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["sling"],
    requiredStat: "DEX",
    requiredValue: 18,
    actionCost: "major",
    mpCost: 8,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "finisher"],
    emitTagsOnUse: ["projectile"],
    canExecute: ({ target }) => {
      if ((target?.weakness?.tiers?.disorient || 0) < 2) return { ok: false, reason: "Requires Disorient T2+." };
      if ((target?.weakness?.tiers?.expose || 0) < 2) return { ok: false, reason: "Requires Expose T2+." };
      return true;
    },
    apply: (attacker, target) => {
      const ability = SKILLS?.scouting_report;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability, tags: ability?.tags, skipGearMultiplier: true,
      }));
      amount = Math.floor(amount * 2.50);

      return {
        ...roll,
        amount,
        onKill: { initiativeGained: 8, resetBonusAction: true },
      };
    },
    description: "Ultimate. Req disorient T2+ and expose T2+. 250% damage. On kill: +8 initiative + reset bonus action.",
  },

  /*
  // ======== DEFERRED SLING SKILLS ========
  // These are not active in the current demo. Candidates for class adaptation.

  'pouch_probe': {
    id: "pouch_probe",
    name: "Pouch Probe",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sling"],
    requiredStat: "DEX",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "expose"],
    emitTagsOnUse: ["projectile"],
    buildupHint: { expose: 55 },
    apply: (attacker, target) => {
      const ability = SKILLS?.pouch_probe;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability, tags: ability?.tags, skipGearMultiplier: true,
      }));
      const exposeTier = target?.weakness?.tiers?.expose || 0;
      const exposeMeter = target?.weakness?.meters?.expose || 0;
      const intensity = Math.max(1, weaknessIntensityMult(exposeMeter) || 1);
      let buildup = ability?.buildupHint?.expose ?? 55;
      if (exposeTier >= 1) {
        amount = Math.floor(amount * (1 + 0.06 * exposeTier));
        buildup += Math.max(4, Math.floor(5 * intensity));
      }
      return { ...roll, amount, buildup: { expose: buildup } };
    },
    description: "A testing shot that opens guard and builds Expose.",
  },

  'concussive_pellet': {
    id: "concussive_pellet",
    name: "Concussive Pellet",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sling"],
    requiredStat: "STR",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "disorient"],
    emitTagsOnUse: ["projectile"],
    buildupHint: { disorient: 65 },
    apply: (attacker, target) => {
      const ability = SKILLS?.concussive_pellet;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability, tags: ability?.tags, skipGearMultiplier: true,
      }));
      const exposeTier = target?.weakness?.tiers?.expose || 0;
      let buildup = ability?.buildupHint?.disorient ?? 65;
      if (exposeTier >= 1) { amount = Math.floor(amount * (1 + 0.08 * exposeTier)); buildup += 25; }
      return { ...roll, amount, buildup: { disorient: buildup } };
    },
    description: "A weighted strike that rattles the target; worse if they're already Exposed.",
  },

  'seeding_shot': {
    id: "seeding_shot",
    name: "Seeding Shot",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sling"],
    requiredStat: "DEX",
    requiredValue: 13,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "toxic"],
    emitTagsOnUse: ["projectile"],
    buildupHint: { toxic: 60 },
    apply: (attacker, target) => {
      const ability = SKILLS?.seeding_shot;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability, tags: ability?.tags, skipGearMultiplier: true,
      }));
      const exposeTier = target?.weakness?.tiers?.expose || 0;
      let buildup = ability?.buildupHint?.toxic ?? 60;
      if (exposeTier >= 1) { amount = Math.floor(amount * (1 + 0.10 * exposeTier)); buildup += 20; }
      return { ...roll, amount, buildup: { toxic: buildup } };
    },
    description: "A resin-tipped stone that seeds Poison; Exposed foes take more buildup.",
  },

  'steady_breath': {
    id: "steady_breath",
    name: "Steady Breath",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sling"],
    requiredStat: "WIS",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 0,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["support", "mp", "stance"],
    statusEffects: [{ id: "steady_breath", turns: 1, mpRestoreFlat: 2, nextProjectileAccPct: 10 }],
    apply: (attacker) => {
      const ability = SKILLS?.steady_breath;
      const statusEffects = Array.isArray(ability?.statusEffects)
        ? ability.statusEffects.map(effect => ({ ...effect })) : [];
      return { amount: 0, statusEffects };
    },
    description: "Focus and breathe — restore a little MP and line up your next shot.",
  },

  'skull_crack': {
    id: "skull_crack",
    name: "Skull Crack",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sling"],
    requiredStat: "STR",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "disorient", "finisher"],
    requiresWeakness: { family: "disorient", tierAtLeast: 1 },
    apply: (attacker, target) => {
      const ability = SKILLS?.skull_crack;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability, tags: ability?.tags, skipGearMultiplier: true,
      }));
      const meter = target?.weakness?.meters?.disorient || 0;
      const tier = target?.weakness?.tiers?.disorient || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      if (tier >= 1) amount = Math.floor(amount * (1 + 0.18 * tier));
      if (intensity > 1) amount = Math.floor(amount * (1 + Math.max(0, intensity - 1) * 0.2));
      if (tier >= 2) amount = Math.floor(amount * 1.18);
      return { ...roll, amount };
    },
    description: "A brutal temple-seeking shot that thrives on a rattled foe.",
  },

  'ice_breaker': {
    id: "ice_breaker",
    name: "Ice Breaker",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sling"],
    requiredStat: "INT",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "cold", "amplify"],
    requiresWeakness: { family: "cold", tierAtLeast: 1 },
    apply: (attacker, target) => {
      const ability = SKILLS?.ice_breaker;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability, tags: ability?.tags, element: 'cold', isMagic: true, skipGearMultiplier: true,
      }));
      const meter = target?.weakness?.meters?.cold || 0;
      const tier = target?.weakness?.tiers?.cold || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      if (tier >= 1) amount = Math.floor(amount * (1 + 0.15 * tier));
      if (intensity > 1) amount = Math.floor(amount * (1 + Math.max(0, intensity - 1) * 0.2));
      return { ...roll, amount, isMagic: true, element: 'cold' };
    },
    description: "A cracking shot that exploits frost — at higher Cold tiers, fractures armor.",
  },

  'toxin_bloom': {
    id: "toxin_bloom",
    name: "Toxin Bloom",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sling"],
    requiredStat: "DEX",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "toxic", "consume"],
    requiresWeakness: { family: "toxic", tierAtLeast: 1 },
    apply: (attacker, target) => {
      const ability = SKILLS?.toxin_bloom;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability, tags: ability?.tags, skipGearMultiplier: true,
      }));
      const meter = target?.weakness?.meters?.toxic || 0;
      const tier = target?.weakness?.tiers?.toxic || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      const burst = Math.max(0, Math.floor((meter / 13) + (tier * 5) + Math.max(0, intensity - 1) * 6));
      amount += burst;
      return { ...roll, amount, consumeWeakness: ['toxic'] };
    },
    description: "Detonate built-up Poison. Consumes toxic meter for bonus damage.",
  },

  'thread_the_gap': {
    id: "thread_the_gap",
    name: "Thread the Gap",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sling"],
    requiredStat: "DEX",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "finisher"],
    requiresWeakness: { family: "expose", tierAtLeast: 1 },
    apply: (attacker, target) => {
      const ability = SKILLS?.thread_the_gap;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability, tags: ability?.tags, skipGearMultiplier: true,
      }));
      const exposeTier = target?.weakness?.tiers?.expose || 0;
      const meter = target?.weakness?.meters?.expose || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      if (exposeTier > 1) amount = Math.floor(amount * (1 + 0.25 * (exposeTier - 1)));
      if (intensity > 1) amount = Math.floor(amount * (1 + Math.max(0, intensity - 1) * 0.2));
      if (exposeTier >= 2) amount = Math.floor(amount * 1.40);
      return { ...roll, amount };
    },
    description: "A pinpoint strike through a small opening; deadlier at deeper Expose.",
  },

  'ricochet_spread': {
    id: "ricochet_spread",
    name: "Ricochet Spread",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sling"],
    requiredStat: "DEX",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "proliferate", "aoe"],
    emitTagsOnUse: ["projectile"],
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.ricochet_spread;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability, tags: ability?.tags, skipGearMultiplier: true,
      }));
      const splash = resolveAOESplash(scene, target, { shape: 'column' }).map(char => ({
        target: char,
        amount: Math.max(1, Math.floor(amount * 0.80)),
        tags: ability?.tags,
      }));
      return { ...roll, amount, splash: splash.length ? splash : undefined };
    },
    description: "A trick shot that skips down the line.",
  },

  'rebounding_shot': {
    id: "rebounding_shot",
    name: "Rebounding Shot",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sling"],
    requiredStat: "DEX",
    requiredValue: 20,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "bounce"],
    cooldown: 4,
    apply: (attacker, target) => {
      const ability = SKILLS?.rebounding_shot;
      const roll = calculateDamage(attacker, target, ability);
      const amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability, tags: ability?.tags, skipGearMultiplier: true,
      }));
      return { ...roll, amount, bounce: true };
    },
    description: "Hits one enemy then bounces to another.",
  },

  // ======== END DEFERRED SLING SKILLS ========
  */

  // ---- OLD v3.21 sling content removed (superseded by v3.22 above) ----
  /*  id: "pouch_probe_REMOVED",
    name: "Pouch Probe",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sling"],
    requiredStat: "DEX",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "expose"],
    emitTagsOnUse: ["projectile"],
    buildupHint: { expose: 55 },
    apply: (attacker, target) => {
      const ability = SKILLS?.pouch_probe;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const exposeTier = target?.weakness?.tiers?.expose || 0;
      const exposeMeter = target?.weakness?.meters?.expose || 0;
      const intensity = Math.max(1, weaknessIntensityMult(exposeMeter) || 1);
      let buildup = ability?.buildupHint?.expose ?? 55;
      if (exposeTier >= 1) {
        amount = Math.floor(amount * (1 + 0.06 * exposeTier));
        buildup += Math.max(4, Math.floor(5 * intensity));
      }

      return {
        ...roll,
        amount,
        buildup: { expose: buildup },
      };
    },
    description: "A testing shot that opens guard and builds Expose."
  },

  'concussive_pellet': {
    id: "concussive_pellet",
    name: "Concussive Pellet",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sling"],
    requiredStat: "STR",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "disorient"],
    emitTagsOnUse: ["projectile"],
    buildupHint: { disorient: 65 },
    rewardIfWeak: { family: "expose", tierAtLeast: 1, buff: { addBuildup: { disorient: 25 } } },
    apply: (attacker, target) => {
      const ability = SKILLS?.concussive_pellet;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const exposeTier = target?.weakness?.tiers?.expose || 0;
      let buildup = ability?.buildupHint?.disorient ?? 65;
      if (exposeTier >= 1) {
        amount = Math.floor(amount * (1 + 0.08 * exposeTier));
        buildup += ability?.rewardIfWeak?.buff?.addBuildup?.disorient ?? 25;
      }

      return {
        ...roll,
        amount,
        buildup: { disorient: buildup },
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
      };
    },
    description: "A weighted strike that rattles the target; worse if they're already Exposed."
  },

  'seeding_shot': {
    id: "seeding_shot",
    name: "Seeding Shot",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sling"],
    requiredStat: "DEX",
    requiredValue: 13,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "toxic"],
    emitTagsOnUse: ["projectile"],
    buildupHint: { toxic: 60 },
    rewardIfWeak: { family: "expose", tierAtLeast: 1, buff: { addBuildup: { toxic: 20 } } },
    apply: (attacker, target) => {
      const ability = SKILLS?.seeding_shot;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const exposeTier = target?.weakness?.tiers?.expose || 0;
      let buildup = ability?.buildupHint?.toxic ?? 60;
      if (exposeTier >= 1) {
        amount = Math.floor(amount * (1 + 0.1 * exposeTier));
        buildup += ability?.rewardIfWeak?.buff?.addBuildup?.toxic ?? 20;
      }

      return {
        ...roll,
        amount,
        buildup: { toxic: buildup },
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
      };
    },
    description: "A resin-tipped stone that seeds Poison; Exposed foes take more buildup."
  },

  'frost_pebble': {
    id: "frost_pebble",
    name: "Frost Pebble",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sling"],
    requiredStat: "INT",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "cold"],
    emitTagsOnUse: ["projectile"],
    buildupHint: { cold: 60 },
    rewardIfTierCross: [{ family: "cold", tier: 1, debuff: { speedDownPct: 10, turns: 1 } }],
    apply: (attacker, target) => {
      const ability = SKILLS?.frost_pebble;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: 'cold',
        skipGearMultiplier: true,
      }));

      let buildup = ability?.buildupHint?.cold ?? 60;
      const coldTier = target?.weakness?.tiers?.cold || 0;
      const coldMeter = target?.weakness?.meters?.cold || 0;
      const intensity = Math.max(1, weaknessIntensityMult(coldMeter) || 1);
      if (coldTier >= 1) {
        amount = Math.floor(amount * (1 + 0.12 * coldTier));
        buildup += Math.max(4, Math.floor(6 * intensity));
      }

      return {
        ...roll,
        amount,
        isMagic: true,
        element: 'cold',
        buildup: { cold: buildup },
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
      };
    },
    description: "A chilled shot; crossing Cold T1 briefly slows the target."
  },

  'ricochet_mark': {
    id: "ricochet_mark",
    name: "Ricochet Mark",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sling"],
    requiredStat: "DEX",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "expose", "proliferate"],
    emitTagsOnUse: ["projectile"],
    buildupHint: { expose: 45 },
    proliferateWeakness: { families: ["expose"], to: "adjacent", ratio: 0.5, maxTargets: 1 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.ricochet_mark;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const baseBuildup = ability?.buildupHint?.expose ?? 45;
      const spreadMeta = [];

      if (scene && target && typeof scene._getUnitColumn === 'function' && typeof scene._getColumnBySlotId === 'function') {
        const column = scene._getUnitColumn(target);
        if (column) {
          const sideSlots = target?.isEnemy ? scene.enemySlots : scene.allySlots;
          const neighbors = sideSlots
            ?.filter(slot => slot?.char && slot.char !== target && slot.char.status !== 'incapacitated' && scene._getColumnBySlotId(slot.slotId) === column)
            .map(slot => slot.char) || [];
          const maxTargets = ability?.proliferateWeakness?.maxTargets ?? 1;
          const ratio = ability?.proliferateWeakness?.ratio ?? 0.5;
          const sourceMeter = target?.weakness?.meters?.expose || 0;

          neighbors.slice(0, maxTargets).forEach(char => {
            const transfer = Math.max(0, Math.floor(sourceMeter * ratio));
            if (transfer > 0) {
              char.weakness = char.weakness || { meters: {}, tiers: {} };
              char.weakness.meters = char.weakness.meters || {};
              char.weakness.tiers = char.weakness.tiers || {};
              char.weakness.meters.expose = (char.weakness.meters.expose || 0) + transfer;
              char.weakness.tiers.expose = weaknessTierFromMeter(char.weakness.meters.expose);
              spreadMeta.push({ targetId: char.id || char.name, family: 'expose', amount: transfer });
            }
          });
        }
      }

      return {
        ...roll,
        amount,
        buildup: { expose: baseBuildup },
        proliferatedWeakness: spreadMeta.length ? spreadMeta : undefined,
      };
    },
    description: "Bank the shot-your opening pressure transfers to a nearby foe."
  },

  'lodging_stone': {
    id: "lodging_stone",
    name: "Lodging Stone",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sling"],
    requiredStat: "DEX",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "lodge"],
    emitTagsOnUse: ["projectile", "lodge"],
    buildupHint: { lodged: 80 },
    // turns:999 = lasts the whole fight; stackable:true = each hit adds another arrow
    statusEffects: [{ id: "lodged", turns: 999, stackable: true }],
    apply: (attacker, target) => {
      const ability = SKILLS?.lodging_stone;
      const roll = calculateDamage(attacker, target, ability);
      const amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const statusEffects = Array.isArray(ability?.statusEffects)
        ? ability.statusEffects.map(effect => ({ ...effect }))
        : undefined;
      const buildup = ability?.buildupHint?.lodged ?? 80;

      return {
        ...roll,
        amount,
        buildup: { lodged: buildup },
        statusEffects,
      };
    },
    description: "A flat, sharp stone that lodges in the wound and stays until removed. Each cast adds another arrow."
  },

  'steady_breath': {
    id: "steady_breath",
    name: "Steady Breath",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sling"],
    requiredStat: "WIS",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 0,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["support", "mp", "stance"],
    statusEffects: [{ id: "steady_breath", turns: 1, mpRestoreFlat: 2, nextProjectileAccPct: 10 }],
    apply: (attacker) => {
      const ability = SKILLS?.steady_breath;
      const statusEffects = Array.isArray(ability?.statusEffects)
        ? ability.statusEffects.map(effect => ({ ...effect }))
        : [];

      return {
        amount: 0,
        statusEffects,
      };
    },
    description: "Focus and breathe-restore a little MP and line up your next shot."
  },

  // -------- Payoff (6) --------
  'shatter_lodge': {
    id: "shatter_lodge",
    name: "Shatter Lodge",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sling"],
    requiredStat: "DEX",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "consume"],
    // canExecute gates on lodged status stacks rather than weakness tier
    canExecute: ({ target }) => {
      const stacks = (target?.statusEffects || []).filter(e => e.id === 'lodged').length;
      if (stacks === 0) return { ok: false, reason: "Target has no lodged stones." };
      return true;
    },
    apply: (attacker, target) => {
      const ability = SKILLS?.shatter_lodge;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      // Burst damage = 8 per lodged stack
      const stacks = (target?.statusEffects || []).filter(e => e.id === 'lodged').length;
      const burst = stacks * 8;
      amount += burst;

      return {
        ...roll,
        amount,
        consumeWeakness: ['lodged'],
        log: burst ? `${attacker?.name || 'The slinger'} shatters ${stacks} lodged stone${stacks > 1 ? 's' : ''} for +${burst} damage!` : undefined,
      };
    },
    description: "Strike the lodged stones to shatter them inside the wound. +8 damage per lodged stack. Consumes all stacks."
  },

  'skull_crack': {
    id: "skull_crack",
    name: "Skull Crack",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sling"],
    requiredStat: "STR",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "disorient", "finisher"],
    requiresWeakness: { family: "disorient", tierAtLeast: 1 },
    rewardIfWeak: { family: "disorient", tierAtLeast: 2, buff: { damagePct: 18 } },
    apply: (attacker, target) => {
      const ability = SKILLS?.skull_crack;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const meter = target?.weakness?.meters?.disorient || 0;
      const tier = target?.weakness?.tiers?.disorient || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      if (tier >= 1) {
        amount = Math.floor(amount * (1 + 0.18 * tier));
      }
      if (intensity > 1) {
        amount = Math.floor(amount * (1 + Math.max(0, intensity - 1) * 0.2));
      }
      if (tier >= (ability?.rewardIfWeak?.tierAtLeast ?? 2)) {
        const bonus = ability?.rewardIfWeak?.buff?.damagePct ?? 18;
        amount = Math.floor(amount * (1 + bonus / 100));
      }

      return {
        ...roll,
        amount,
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
      };
    },
    description: "A brutal, temple-seeking shot that thrives on a rattled foe."
  },

  'ice_breaker': {
    id: "ice_breaker",
    name: "Ice Breaker",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sling"],
    requiredStat: "INT",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "cold", "amplify"],
    requiresWeakness: { family: "cold", tierAtLeast: 1 },
    rewardIfWeak: { family: "cold", tierAtLeast: 2, buff: { armorDownPct: 12, turns: 2 } },
    apply: (attacker, target) => {
      const ability = SKILLS?.ice_breaker;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: 'cold',
        skipGearMultiplier: true,
      }));

      const meter = target?.weakness?.meters?.cold || 0;
      const tier = target?.weakness?.tiers?.cold || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      if (tier >= 1) {
        amount = Math.floor(amount * (1 + 0.15 * tier));
      }
      if (intensity > 1) {
        amount = Math.floor(amount * (1 + Math.max(0, intensity - 1) * 0.2));
      }

      return {
        ...roll,
        amount,
        isMagic: true,
        element: 'cold',
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
      };
    },
    description: "A cracking shot that exploits frost-at higher Cold tiers, it fractures armor."
  },

  'toxin_bloom': {
    id: "toxin_bloom",
    name: "Toxin Bloom",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sling"],
    requiredStat: "DEX",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "toxic", "consume"],
    requiresWeakness: { family: "toxic", tierAtLeast: 1 },
    consumeWeakness: ["toxic"],
    rewardIfWeak: { family: "toxic", tierAtLeast: 2, buff: { extraRapidTicks: 1 } },
    apply: (attacker, target) => {
      const ability = SKILLS?.toxin_bloom;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const meter = target?.weakness?.meters?.toxic || 0;
      const tier = target?.weakness?.tiers?.toxic || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      const burst = Math.max(0, Math.floor((meter / 13) + (tier * 5) + Math.max(0, intensity - 1) * 6));
      amount += burst;

      return {
        ...roll,
        amount,
        consumeWeakness: ability?.consumeWeakness ? [...ability.consumeWeakness] : undefined,
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
        log: burst ? `${attacker?.name || 'The slinger'} ruptures the poison for +${burst} damage.` : undefined,
      };
    },
    description: "Detonate built-up Poison into rapid ticks; adds an extra tick at higher tiers."
  },

  'thread_the_gap': {
    id: "thread_the_gap",
    name: "Thread the Gap",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sling"],
    requiredStat: "DEX",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "finisher"],
    requiresWeakness: { family: "expose", tierAtLeast: 1 },
    rewardIfWeak: { family: "expose", tierAtLeast: 2, buff: { critMultBonus: 0.4 } },
    apply: (attacker, target) => {
      const ability = SKILLS?.thread_the_gap;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const exposeTier = target?.weakness?.tiers?.expose || 0;
      const meter = target?.weakness?.meters?.expose || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      if (exposeTier > 1) {
        amount = Math.floor(amount * (1 + 0.25 * (exposeTier - 1)));
      }
      if (intensity > 1) {
        amount = Math.floor(amount * (1 + Math.max(0, intensity - 1) * 0.2));
      }
      if (exposeTier >= (ability?.rewardIfWeak?.tierAtLeast ?? 2)) {
        const critBonus = ability?.rewardIfWeak?.buff?.critMultBonus ?? 0.4;
        amount = Math.floor(amount * (1 + critBonus));
      }

      return {
        ...roll,
        amount,
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
      };
    },
    description: "A pinpoint strike that sails through a small opening; deadlier at deeper Expose."
  },

  'ricochet_spread': {
    id: "ricochet_spread",
    name: "Ricochet Spread",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sling"],
    requiredStat: "DEX",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "proliferate", "aoe"],
    emitTagsOnUse: ["projectile"],
    aoe: { shape: "column", scale: 1 },
    proliferateWeakness: { families: ["expose", "disorient", "cold", "toxic", "lacerate", "lodged"], to: "column", ratio: 0.4, maxTargets: 2 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.ricochet_spread;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const splash = [];
      const spreadMeta = [];

      if (scene && target && typeof scene._getUnitColumn === 'function' && typeof scene._getColumnBySlotId === 'function') {
        const column = scene._getUnitColumn(target);
        if (column) {
          const sideSlots = target?.isEnemy ? scene.enemySlots : scene.allySlots;
          const others = sideSlots
            ?.filter(slot => slot?.char && slot.char !== target && slot.char.status !== 'incapacitated' && scene._getColumnBySlotId(slot.slotId) === column)
            .map(slot => slot.char) || [];
          const splashAmount = Math.max(1, Math.floor(amount * 0.8));
          const families = ability?.proliferateWeakness?.families || [];
          let chosenFamily = null;
          let bestTier = -1;
          let bestMeter = 0;
          families.forEach(fam => {
            const tier = target?.weakness?.tiers?.[fam] || 0;
            const meter = target?.weakness?.meters?.[fam] || 0;
            if (tier > bestTier || (tier === bestTier && meter > bestMeter)) {
              bestTier = tier;
              bestMeter = meter;
              chosenFamily = fam;
            }
          });
          if (bestTier <= 0) {
            chosenFamily = null;
            bestMeter = 0;
          }

          const maxTargets = ability?.proliferateWeakness?.maxTargets ?? 2;
          const ratio = ability?.proliferateWeakness?.ratio ?? 0.4;

          others.forEach((char, idx) => {
            splash.push({
              target: char,
              amount: splashAmount,
              tags: ability?.tags,
            });

            if (idx < maxTargets && chosenFamily && bestMeter > 0) {
              const transfer = Math.max(0, Math.floor(bestMeter * ratio));
              if (transfer > 0) {
                char.weakness = char.weakness || { meters: {}, tiers: {} };
                char.weakness.meters = char.weakness.meters || {};
                char.weakness.tiers = char.weakness.tiers || {};
                char.weakness.meters[chosenFamily] = (char.weakness.meters[chosenFamily] || 0) + transfer;
                char.weakness.tiers[chosenFamily] = weaknessTierFromMeter(char.weakness.meters[chosenFamily]);
                spreadMeta.push({ targetId: char.id || char.name, family: chosenFamily, amount: transfer });
              }
            }
          });
        }
      }

      return {
        ...roll,
        amount,
        splash: splash.length ? splash : undefined,
        proliferatedWeakness: spreadMeta.length ? spreadMeta : undefined,
      };
    },
    description: "A trick shot — REMOVED."
  */
  // ===============================
  // v3.21 - Bow (2h) (13)
  // ===============================

  // -------- Generation (7) --------
  'pinning_shot': {
    id: "pinning_shot",
    name: "Pinning Shot",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["bow"],
    requiredStat: "DEX",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "expose"],
    emitTagsOnUse: ["projectile"],
    buildupHint: { expose: 60 },
    apply: (attacker, target) => {
      const ability = SKILLS?.pinning_shot;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const exposeTier = target?.weakness?.tiers?.expose || 0;
      const meter = target?.weakness?.meters?.expose || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      let buildup = ability?.buildupHint?.expose ?? 60;
      if (exposeTier >= 1) {
        amount = Math.floor(amount * (1 + 0.08 * exposeTier));
        buildup += Math.max(5, Math.floor(6 * intensity));
      }

      return {
        ...roll,
        amount,
        buildup: { expose: buildup },
      };
    },
    description: "A precise shaft that opens the target's guard and builds Expose."
  },

  'barbed_arrow': {
    id: "barbed_arrow",
    name: "Barbed Arrow",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["bow"],
    requiredStat: "DEX",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "lacerate"],
    emitTagsOnUse: ["projectile"],
    buildupHint: { lacerate: 700 }, //testing
    rewardIfWeak: { family: "expose", tierAtLeast: 1, buff: { addBuildup: { lacerate: 25 } } },
    apply: (attacker, target) => {
      const ability = SKILLS?.barbed_arrow;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const exposeTier = target?.weakness?.tiers?.expose || 0;
      let buildup = ability?.buildupHint?.lacerate ?? 700; //testing
      if (exposeTier >= 1) {
        amount = Math.floor(amount * (1 + 0.1 * exposeTier));
        buildup += ability?.rewardIfWeak?.buff?.addBuildup?.lacerate ?? 25;
      }

      return {
        ...roll,
        amount,
        buildup: { lacerate: buildup },
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
      };
    },
    description: "Barbed head tears flesh, seeding Bleed-worse on an Exposed foe."
  },

  'tainted_arrow': {
    id: "tainted_arrow",
    name: "Tainted Arrow",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["bow"],
    requiredStat: "DEX",
    requiredValue: 13,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "toxic"],
    emitTagsOnUse: ["projectile"],
    buildupHint: { toxic: 60 },
    rewardIfWeak: { family: "expose", tierAtLeast: 1, buff: { addBuildup: { toxic: 20 } } },
    apply: (attacker, target) => {
      const ability = SKILLS?.tainted_arrow;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const exposeTier = target?.weakness?.tiers?.expose || 0;
      let buildup = ability?.buildupHint?.toxic ?? 60;
      if (exposeTier >= 1) {
        amount = Math.floor(amount * (1 + 0.1 * exposeTier));
        buildup += ability?.rewardIfWeak?.buff?.addBuildup?.toxic ?? 20;
      }

      return {
        ...roll,
        amount,
        buildup: { toxic: buildup },
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
      };
    },
    description: "A resin-coated tip that poisons the wound; Exposed targets take more buildup."
  },

  'frosthead_arrow': {
    id: "frosthead_arrow",
    name: "Frosthead Arrow",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["bow"],
    requiredStat: "INT",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "cold"],
    emitTagsOnUse: ["projectile"],
    buildupHint: { cold: 60 },
    rewardIfTierCross: [{ family: "cold", tier: 1, debuff: { speedDownPct: 10, turns: 1 } }],
    apply: (attacker, target) => {
      const ability = SKILLS?.frosthead_arrow;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: 'cold',
        skipGearMultiplier: true,
      }));

      const coldTier = target?.weakness?.tiers?.cold || 0;
      const meter = target?.weakness?.meters?.cold || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      let buildup = ability?.buildupHint?.cold ?? 60;
      if (coldTier >= 1) {
        amount = Math.floor(amount * (1 + 0.12 * coldTier));
        buildup += Math.max(4, Math.floor(6 * intensity));
      }

      return {
        ...roll,
        amount,
        isMagic: true,
        element: 'cold',
        buildup: { cold: buildup },
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
      };
    },
    description: "A chilled arrow; crossing Cold T1 briefly slows the target."
  },

  'marking_volley': {
    id: "marking_volley",
    name: "Marking Volley",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["bow"],
    requiredStat: "DEX",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "expose", "aoe"],
    emitTagsOnUse: ["projectile"],
    aoe: { shape: "column", scale: 1 },
    buildupHint: { expose: 40 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.marking_volley;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const baseBuildup = ability?.buildupHint?.expose ?? 40;
      const splash = [];

      if (scene && target && typeof scene._getUnitColumn === 'function' && typeof scene._getColumnBySlotId === 'function') {
        const column = scene._getUnitColumn(target);
        if (column) {
          const sideSlots = target?.isEnemy ? scene.enemySlots : scene.allySlots;
          const neighbors = sideSlots
            ?.filter(slot => slot?.char && slot.char !== target && slot.char.status !== 'incapacitated' && scene._getColumnBySlotId(slot.slotId) === column)
            .map(slot => slot.char) || [];
          const splashAmount = Math.max(1, Math.floor(amount * 0.75));
          const splashBuildup = Math.max(1, Math.floor(baseBuildup * 0.7));
          neighbors.forEach(char => {
            splash.push({
              target: char,
              amount: splashAmount,
              buildup: { expose: splashBuildup },
              tags: ability?.tags,
            });
          });
        }
      }

      return {
        ...roll,
        amount,
        buildup: { expose: baseBuildup },
        splash: splash.length ? splash : undefined,
      };
    },
    description: "Loose several shafts to lightly Expose every foe down the line."
  },

  'lodging_arrow': {
    id: "lodging_arrow",
    name: "Lodging Arrow",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["bow"],
    requiredStat: "DEX",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "lodge"],
    emitTagsOnUse: ["projectile", "lodge"],
    buildupHint: { lodged: 90 },
    statusEffects: [{ id: "lodged", turns: 2, stacks: 1 }],
    apply: (attacker, target) => {
      const ability = SKILLS?.lodging_arrow;
      const roll = calculateDamage(attacker, target, ability);
      const amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const statusEffects = Array.isArray(ability?.statusEffects)
        ? ability.statusEffects.map(effect => ({ ...effect }))
        : undefined;

      return {
        ...roll,
        amount,
        buildup: { lodged: ability?.buildupHint?.lodged ?? 90 },
        statusEffects,
      };
    },
    description: "A broadhead designed to stick; leaves an arrow lodged in the target."
  },

  'eagle_focus': {
    id: "eagle_focus",
    name: "Eagle Focus",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["bow"],
    requiredStat: "WIS",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 0,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["support", "mp", "stance"],
    statusEffects: [{ id: "eagle_focus", turns: 1, mpRestoreFlat: 2, nextProjectileAccPct: 10 }],
    apply: (attacker) => {
      const ability = SKILLS?.eagle_focus;
      const statusEffects = Array.isArray(ability?.statusEffects)
        ? ability.statusEffects.map(effect => ({ ...effect }))
        : [];

      return {
        amount: 0,
        statusEffects,
      };
    },
    description: "Steady your aim-restore a little MP and line up your next shot."
  },

  // -------- Payoff (6) --------
  'shaft_splinter': {
    id: "shaft_splinter",
    name: "Shaft Splinter",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["bow"],
    requiredStat: "DEX",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "consume"],
    requiresWeakness: { family: "lodged", tierAtLeast: 1 },
    consumeWeakness: ["lodged"],
    apply: (attacker, target) => {
      const ability = SKILLS?.shaft_splinter;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const meter = target?.weakness?.meters?.lodged || 0;
      const tier = target?.weakness?.tiers?.lodged || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      const burst = Math.max(0, Math.floor((meter / 12) + (tier * 8) + Math.max(0, intensity - 1) * 8));
      amount += burst;

      return {
        ...roll,
        amount,
        consumeWeakness: ability?.consumeWeakness ? [...ability.consumeWeakness] : undefined,
        log: burst ? `${attacker?.name || 'The archer'} splinters the lodged arrow for +${burst} damage.` : undefined,
      };
    },
    description: "Strike the embedded arrow to splinter it internally for burst damage."
  },

  'ice_lance': {
    id: "ice_lance",
    name: "Ice Lance",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["bow"],
    requiredStat: "INT",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "cold", "amplify"],
    requiresWeakness: { family: "cold", tierAtLeast: 1 },
    rewardIfWeak: { family: "cold", tierAtLeast: 2, buff: { armorDownPct: 12, turns: 2 } },
    apply: (attacker, target) => {
      const ability = SKILLS?.ice_lance;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: 'cold',
        skipGearMultiplier: true,
      }));

      const meter = target?.weakness?.meters?.cold || 0;
      const tier = target?.weakness?.tiers?.cold || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      if (tier >= 1) {
        amount = Math.floor(amount * (1 + 0.15 * tier));
      }
      if (intensity > 1) {
        amount = Math.floor(amount * (1 + Math.max(0, intensity - 1) * 0.2));
      }

      return {
        ...roll,
        amount,
        isMagic: true,
        element: 'cold',
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
      };
    },
    description: "A condensed shard of frost; at higher Cold tiers, it fractures armor."
  },

  'skull_pierce': {
    id: "skull_pierce",
    name: "Skull Pierce",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["bow"],
    requiredStat: "STR",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "disorient", "finisher"],
    requiresWeakness: { family: "disorient", tierAtLeast: 1 },
    rewardIfWeak: { family: "disorient", tierAtLeast: 2, buff: { damagePct: 18 } },
    apply: (attacker, target) => {
      const ability = SKILLS?.skull_pierce;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const meter = target?.weakness?.meters?.disorient || 0;
      const tier = target?.weakness?.tiers?.disorient || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      if (tier >= 1) {
        amount = Math.floor(amount * (1 + 0.18 * tier));
      }
      if (intensity > 1) {
        amount = Math.floor(amount * (1 + Math.max(0, intensity - 1) * 0.2));
      }
      if (tier >= (ability?.rewardIfWeak?.tierAtLeast ?? 2)) {
        const bonus = ability?.rewardIfWeak?.buff?.damagePct ?? 18;
        amount = Math.floor(amount * (1 + bonus / 100));
      }

      return {
        ...roll,
        amount,
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
      };
    },
    description: "A temple-seeking shot that thrives on a rattled foe."
  },

  'toxin_burst': {
    id: "toxin_burst",
    name: "Toxin Burst",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["bow"],
    requiredStat: "DEX",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "toxic", "consume"],
    requiresWeakness: { family: "toxic", tierAtLeast: 1 },
    consumeWeakness: ["toxic"],
    rewardIfWeak: { family: "toxic", tierAtLeast: 2, buff: { extraRapidTicks: 1 } },
    apply: (attacker, target) => {
      const ability = SKILLS?.toxin_burst;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const meter = target?.weakness?.meters?.toxic || 0;
      const tier = target?.weakness?.tiers?.toxic || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      const burst = Math.max(0, Math.floor((meter / 13) + (tier * 5) + Math.max(0, intensity - 1) * 6));
      amount += burst;

      return {
        ...roll,
        amount,
        consumeWeakness: ability?.consumeWeakness ? [...ability.consumeWeakness] : undefined,
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
        log: burst ? `${attacker?.name || 'The archer'} detonates the poison for +${burst} damage.` : undefined,
      };
    },
    description: "Rupture the poisoned wound to force rapid ticks; adds an extra tick at higher tiers."
  },

  'perfect_release': {
    id: "perfect_release",
    name: "Perfect Release",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["bow"],
    requiredStat: "DEX",
    requiredValue: 17,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "finisher"],
    requiresWeakness: { family: "expose", tierAtLeast: 1 },
    rewardIfWeak: { family: "expose", tierAtLeast: 2, buff: { critMultBonus: 0.4 } },
    apply: (attacker, target) => {
      const ability = SKILLS?.perfect_release;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const exposeTier = target?.weakness?.tiers?.expose || 0;
      const meter = target?.weakness?.meters?.expose || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      if (exposeTier > 1) {
        amount = Math.floor(amount * (1 + 0.25 * (exposeTier - 1)));
      }
      if (intensity > 1) {
        amount = Math.floor(amount * (1 + Math.max(0, intensity - 1) * 0.2));
      }
      if (exposeTier >= (ability?.rewardIfWeak?.tierAtLeast ?? 2)) {
        const critBonus = ability?.rewardIfWeak?.buff?.critMultBonus ?? 0.4;
        amount = Math.floor(amount * (1 + critBonus));
      }

      return {
        ...roll,
        amount,
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
      };
    },
    description: "A perfect draw and loose through a narrow opening; deadlier at deeper Expose."
  },

  'weakpoint_cascade': {
    id: "weakpoint_cascade",
    name: "Weakpoint Cascade",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["bow"],
    requiredStat: "DEX",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "proliferate", "aoe"],
    emitTagsOnUse: ["projectile"],
    aoe: { shape: "column", scale: 1 },
    proliferateWeakness: { families: ["expose", "disorient", "cold", "toxic", "lacerate", "lodged"], to: "column", ratio: 0.4, maxTargets: 2 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.weakpoint_cascade;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const splash = [];
      const spreadMeta = [];

      if (scene && target && typeof scene._getUnitColumn === 'function' && typeof scene._getColumnBySlotId === 'function') {
        const column = scene._getUnitColumn(target);
        if (column) {
          const sideSlots = target?.isEnemy ? scene.enemySlots : scene.allySlots;
          const others = sideSlots
            ?.filter(slot => slot?.char && slot.char !== target && slot.char.status !== 'incapacitated' && scene._getColumnBySlotId(slot.slotId) === column)
            .map(slot => slot.char) || [];
          const splashAmount = Math.max(1, Math.floor(amount * 0.8));
          const families = ability?.proliferateWeakness?.families || [];
          let chosenFamily = null;
          let bestTier = -1;
          let bestMeter = 0;
          families.forEach(fam => {
            const tier = target?.weakness?.tiers?.[fam] || 0;
            const meter = target?.weakness?.meters?.[fam] || 0;
            if (tier > bestTier || (tier === bestTier && meter > bestMeter)) {
              bestTier = tier;
              bestMeter = meter;
              chosenFamily = fam;
            }
          });
          if (bestTier <= 0) {
            chosenFamily = null;
            bestMeter = 0;
          }

          const maxTargets = ability?.proliferateWeakness?.maxTargets ?? 2;
          const ratio = ability?.proliferateWeakness?.ratio ?? 0.4;

          others.forEach((char, idx) => {
            splash.push({
              target: char,
              amount: splashAmount,
              tags: ability?.tags,
            });

            if (idx < maxTargets && chosenFamily && bestMeter > 0) {
              const transfer = Math.max(0, Math.floor(bestMeter * ratio));
              if (transfer > 0) {
                char.weakness = char.weakness || { meters: {}, tiers: {} };
                char.weakness.meters = char.weakness.meters || {};
                char.weakness.tiers = char.weakness.tiers || {};
                char.weakness.meters[chosenFamily] = (char.weakness.meters[chosenFamily] || 0) + transfer;
                char.weakness.tiers[chosenFamily] = weaknessTierFromMeter(char.weakness.meters[chosenFamily]);
                spreadMeta.push({ targetId: char.id || char.name, family: chosenFamily, amount: transfer });
              }
            }
          });
        }
      }

      return {
        ...roll,
        amount,
        splash: splash.length ? splash : undefined,
        proliferatedWeakness: spreadMeta.length ? spreadMeta : undefined,
      };
    },
    description: "A trick sequence that threads multiple foes, spreading the primary target's condition."
  },

  // ===============================
  // v3.21 - Gun (2h) (13)
  // ===============================

  // -------- Generation (7) --------
  'sighting_shot': {
    id: "sighting_shot",
    name: "Sighting Shot",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["gun"],
    requiredStat: "DEX",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "expose"],
    emitTagsOnUse: ["projectile"],
    buildupHint: { expose: 55 },
    apply: (attacker, target) => {
      const ability = SKILLS?.sighting_shot;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const exposeTier = target?.weakness?.tiers?.expose || 0;
      const meter = target?.weakness?.meters?.expose || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      let buildup = ability?.buildupHint?.expose ?? 55;
      if (exposeTier >= 1) {
        amount = Math.floor(amount * (1 + 0.07 * exposeTier));
        buildup += Math.max(4, Math.floor(5 * intensity));
      }

      return {
        ...roll,
        amount,
        buildup: { expose: buildup },
      };
    },
    description: "A careful opening shot that pressures guard and builds Expose."
  },

  'stagger_round': {
    id: "stagger_round",
    name: "Stagger Round",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["gun"],
    requiredStat: "STR",
    requiredValue: 13,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "disorient"],
    emitTagsOnUse: ["projectile"],
    buildupHint: { disorient: 65 },
    rewardIfWeak: { family: "expose", tierAtLeast: 1, buff: { addBuildup: { disorient: 25 } } },
    apply: (attacker, target) => {
      const ability = SKILLS?.stagger_round;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const exposeTier = target?.weakness?.tiers?.expose || 0;
      let buildup = ability?.buildupHint?.disorient ?? 65;
      if (exposeTier >= 1) {
        amount = Math.floor(amount * (1 + 0.1 * exposeTier));
        buildup += ability?.rewardIfWeak?.buff?.addBuildup?.disorient ?? 25;
      }

      return {
        ...roll,
        amount,
        buildup: { disorient: buildup },
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
      };
    },
    description: "A heavy slug that rattles the target; worse if they're already Exposed."
  },

  'alchemical_slug': {
    id: "alchemical_slug",
    name: "Alchemical Slug",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["gun"],
    requiredStat: "DEX",
    requiredValue: 13,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "toxic"],
    emitTagsOnUse: ["projectile"],
    buildupHint: { toxic: 60 },
    rewardIfWeak: { family: "expose", tierAtLeast: 1, buff: { addBuildup: { toxic: 20 } } },
    apply: (attacker, target) => {
      const ability = SKILLS?.alchemical_slug;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const exposeTier = target?.weakness?.tiers?.expose || 0;
      let buildup = ability?.buildupHint?.toxic ?? 60;
      if (exposeTier >= 1) {
        amount = Math.floor(amount * (1 + 0.1 * exposeTier));
        buildup += ability?.rewardIfWeak?.buff?.addBuildup?.toxic ?? 20;
      }

      return {
        ...roll,
        amount,
        buildup: { toxic: buildup },
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
      };
    },
    description: "A resin-laced shot that poisons the wound; Exposed targets accrue more toxin."
  },

  'cryo_round': {
    id: "cryo_round",
    name: "Cryo Round",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["gun"],
    requiredStat: "INT",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "cold"],
    emitTagsOnUse: ["projectile"],
    buildupHint: { cold: 60 },
    rewardIfTierCross: [{ family: "cold", tier: 1, debuff: { speedDownPct: 10, turns: 1 } }],
    apply: (attacker, target) => {
      const ability = SKILLS?.cryo_round;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: 'cold',
        skipGearMultiplier: true,
      }));

      const coldTier = target?.weakness?.tiers?.cold || 0;
      const meter = target?.weakness?.meters?.cold || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      let buildup = ability?.buildupHint?.cold ?? 60;
      if (coldTier >= 1) {
        amount = Math.floor(amount * (1 + 0.12 * coldTier));
        buildup += Math.max(4, Math.floor(6 * intensity));
      }

      return {
        ...roll,
        amount,
        isMagic: true,
        element: 'cold',
        buildup: { cold: buildup },
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
      };
    },
    description: "A chilled cartridge; crossing Cold T1 briefly slows the target."
  },

  'ricochet_lane': {
    id: "ricochet_lane",
    name: "Ricochet Lane",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["gun"],
    requiredStat: "DEX",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "expose", "proliferate", "aoe"],
    emitTagsOnUse: ["projectile"],
    aoe: { shape: "column", scale: 1 },
    buildupHint: { expose: 40 },
    proliferateWeakness: { families: ["expose"], to: "column", ratio: 0.5, maxTargets: 1 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.ricochet_lane;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const baseBuildup = ability?.buildupHint?.expose ?? 40;
      const splash = [];
      const spreadMeta = [];

      if (scene && target && typeof scene._getUnitColumn === 'function' && typeof scene._getColumnBySlotId === 'function') {
        const column = scene._getUnitColumn(target);
        if (column) {
          const sideSlots = target?.isEnemy ? scene.enemySlots : scene.allySlots;
          const neighbors = sideSlots
            ?.filter(slot => slot?.char && slot.char !== target && slot.char.status !== 'incapacitated' && scene._getColumnBySlotId(slot.slotId) === column)
            .map(slot => slot.char) || [];
          const splashAmount = Math.max(1, Math.floor(amount * 0.8));
          const splashBuildup = Math.max(1, Math.floor(baseBuildup * 0.7));
          neighbors.forEach((char, idx) => {
            splash.push({
              target: char,
              amount: splashAmount,
              buildup: { expose: splashBuildup },
              tags: ability?.tags,
            });

            if (idx < (ability?.proliferateWeakness?.maxTargets ?? 1)) {
              const ratio = ability?.proliferateWeakness?.ratio ?? 0.5;
              const sourceMeter = target?.weakness?.meters?.expose || 0;
              const transfer = Math.max(0, Math.floor(sourceMeter * ratio));
              if (transfer > 0) {
                char.weakness = char.weakness || { meters: {}, tiers: {} };
                char.weakness.meters = char.weakness.meters || {};
                char.weakness.tiers = char.weakness.tiers || {};
                char.weakness.meters.expose = (char.weakness.meters.expose || 0) + transfer;
                char.weakness.tiers.expose = weaknessTierFromMeter(char.weakness.meters.expose);
                spreadMeta.push({ targetId: char.id || char.name, family: 'expose', amount: transfer });
              }
            }
          });
        }
      }

      return {
        ...roll,
        amount,
        buildup: { expose: baseBuildup },
        splash: splash.length ? splash : undefined,
        proliferatedWeakness: spreadMeta.length ? spreadMeta : undefined,
      };
    },
    description: "Skip a shot down the lane, passing the opening pressure along the column."
  },

  'lodging_slug': {
    id: "lodging_slug",
    name: "Lodging Slug",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["gun"],
    requiredStat: "DEX",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "lodge"],
    emitTagsOnUse: ["projectile", "lodge"],
    buildupHint: { lodged: 90 },
    statusEffects: [{ id: "lodged", turns: 2, stacks: 1 }],
    apply: (attacker, target) => {
      const ability = SKILLS?.lodging_slug;
      const roll = calculateDamage(attacker, target, ability);
      const amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const statusEffects = Array.isArray(ability?.statusEffects)
        ? ability.statusEffects.map(effect => ({ ...effect }))
        : undefined;

      return {
        ...roll,
        amount,
        buildup: { lodged: ability?.buildupHint?.lodged ?? 90 },
        statusEffects,
      };
    },
    description: "A soft-nosed round likely to lodge in the wound."
  },

  'steady_aim': {
    id: "steady_aim",
    name: "Steady Aim",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["gun"],
    requiredStat: "WIS",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 0,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["support", "mp", "stance"],
    statusEffects: [{ id: "steady_aim", turns: 1, mpRestoreFlat: 2, nextProjectileAccPct: 10 }],
    apply: (attacker) => {
      const ability = SKILLS?.steady_aim;
      const statusEffects = Array.isArray(ability?.statusEffects)
        ? ability.statusEffects.map(effect => ({ ...effect }))
        : [];

      return {
        amount: 0,
        statusEffects,
      };
    },
    description: "Control breath and trigger-restore a little MP and line up your next shot."
  },

  // -------- Payoff (6) --------
  'implode_lodge': {
    id: "implode_lodge",
    name: "Implode Lodge",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["gun"],
    requiredStat: "DEX",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "consume"],
    requiresWeakness: { family: "lodged", tierAtLeast: 1 },
    consumeWeakness: ["lodged"],
    apply: (attacker, target) => {
      const ability = SKILLS?.implode_lodge;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const meter = target?.weakness?.meters?.lodged || 0;
      const tier = target?.weakness?.tiers?.lodged || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      const burst = Math.max(0, Math.floor((meter / 12) + (tier * 8) + Math.max(0, intensity - 1) * 8));
      amount += burst;

      return {
        ...roll,
        amount,
        consumeWeakness: ability?.consumeWeakness ? [...ability.consumeWeakness] : undefined,
        log: burst ? `${attacker?.name || 'The gunner'} collapses the lodged slug for +${burst} damage.` : undefined,
      };
    },
    description: "A precise follow-up that collapses a lodged slug inside the wound for burst damage."
  },

  'temple_shot': {
    id: "temple_shot",
    name: "Temple Shot",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["gun"],
    requiredStat: "STR",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "disorient", "finisher"],
    requiresWeakness: { family: "disorient", tierAtLeast: 1 },
    rewardIfWeak: { family: "disorient", tierAtLeast: 2, buff: { damagePct: 18 } },
    apply: (attacker, target) => {
      const ability = SKILLS?.temple_shot;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const meter = target?.weakness?.meters?.disorient || 0;
      const tier = target?.weakness?.tiers?.disorient || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      if (tier >= 1) {
        amount = Math.floor(amount * (1 + 0.18 * tier));
      }
      if (intensity > 1) {
        amount = Math.floor(amount * (1 + Math.max(0, intensity - 1) * 0.2));
      }
      if (tier >= (ability?.rewardIfWeak?.tierAtLeast ?? 2)) {
        const bonus = ability?.rewardIfWeak?.buff?.damagePct ?? 18;
        amount = Math.floor(amount * (1 + bonus / 100));
      }

      return {
        ...roll,
        amount,
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
      };
    },
    description: "A brutal headshot that thrives on a rattled foe."
  },

  'glacial_core': {
    id: "glacial_core",
    name: "Glacial Core",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["gun"],
    requiredStat: "INT",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "cold", "amplify"],
    requiresWeakness: { family: "cold", tierAtLeast: 1 },
    rewardIfWeak: { family: "cold", tierAtLeast: 2, buff: { armorDownPct: 12, turns: 2 } },
    apply: (attacker, target) => {
      const ability = SKILLS?.glacial_core;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: 'cold',
        skipGearMultiplier: true,
      }));

      const meter = target?.weakness?.meters?.cold || 0;
      const tier = target?.weakness?.tiers?.cold || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      if (tier >= 1) {
        amount = Math.floor(amount * (1 + 0.15 * tier));
      }
      if (intensity > 1) {
        amount = Math.floor(amount * (1 + Math.max(0, intensity - 1) * 0.2));
      }

      return {
        ...roll,
        amount,
        isMagic: true,
        element: 'cold',
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
      };
    },
    description: "A core-chilled round that fractures armor when Cold is already high."
  },

  'toxin_rupture': {
    id: "toxin_rupture",
    name: "Toxin Rupture",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["gun"],
    requiredStat: "DEX",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "toxic", "consume"],
    requiresWeakness: { family: "toxic", tierAtLeast: 1 },
    consumeWeakness: ["toxic"],
    rewardIfWeak: { family: "toxic", tierAtLeast: 2, buff: { extraRapidTicks: 1 } },
    apply: (attacker, target) => {
      const ability = SKILLS?.toxin_rupture;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const meter = target?.weakness?.meters?.toxic || 0;
      const tier = target?.weakness?.tiers?.toxic || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      const burst = Math.max(0, Math.floor((meter / 13) + (tier * 5) + Math.max(0, intensity - 1) * 6));
      amount += burst;

      return {
        ...roll,
        amount,
        consumeWeakness: ability?.consumeWeakness ? [...ability.consumeWeakness] : undefined,
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
        log: burst ? `${attacker?.name || 'The gunner'} ruptures the poison for +${burst} damage.` : undefined,
      };
    },
    description: "Burst the poisoned wound to force rapid ticks; adds an extra tick at higher tiers."
  },

  'weakpoint_drill': {
    id: "weakpoint_drill",
    name: "Weakpoint Drill",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["gun"],
    requiredStat: "DEX",
    requiredValue: 17,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "finisher"],
    requiresWeakness: { family: "expose", tierAtLeast: 1 },
    rewardIfWeak: { family: "expose", tierAtLeast: 2, buff: { critMultBonus: 0.4 } },
    apply: (attacker, target) => {
      const ability = SKILLS?.weakpoint_drill;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const exposeTier = target?.weakness?.tiers?.expose || 0;
      const meter = target?.weakness?.meters?.expose || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      if (exposeTier > 1) {
        amount = Math.floor(amount * (1 + 0.25 * (exposeTier - 1)));
      }
      if (intensity > 1) {
        amount = Math.floor(amount * (1 + Math.max(0, intensity - 1) * 0.2));
      }
      if (exposeTier >= (ability?.rewardIfWeak?.tierAtLeast ?? 2)) {
        const critBonus = ability?.rewardIfWeak?.buff?.critMultBonus ?? 0.4;
        amount = Math.floor(amount * (1 + critBonus));
      }

      return {
        ...roll,
        amount,
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
      };
    },
    description: "A tight grouping through a small opening; deadlier at deeper Expose."
  },

  'shrapnel_spray': {
    id: "shrapnel_spray",
    name: "Shrapnel Spray",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["gun"],
    requiredStat: "DEX",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "proliferate", "aoe"],
    emitTagsOnUse: ["projectile"],
    aoe: { shape: "column", scale: 1 },
    proliferateWeakness: { families: ["expose", "disorient", "cold", "toxic", "lacerate", "lodged"], to: "column", ratio: 0.4, maxTargets: 2 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.shrapnel_spray;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const splash = [];
      const spreadMeta = [];

      if (scene && target && typeof scene._getUnitColumn === 'function' && typeof scene._getColumnBySlotId === 'function') {
        const column = scene._getUnitColumn(target);
        if (column) {
          const sideSlots = target?.isEnemy ? scene.enemySlots : scene.allySlots;
          const others = sideSlots
            ?.filter(slot => slot?.char && slot.char !== target && slot.char.status !== 'incapacitated' && scene._getColumnBySlotId(slot.slotId) === column)
            .map(slot => slot.char) || [];
          const splashAmount = Math.max(1, Math.floor(amount * 0.8));
          const families = ability?.proliferateWeakness?.families || [];
          let chosenFamily = null;
          let bestTier = -1;
          let bestMeter = 0;
          families.forEach(fam => {
            const tier = target?.weakness?.tiers?.[fam] || 0;
            const meter = target?.weakness?.meters?.[fam] || 0;
            if (tier > bestTier || (tier === bestTier && meter > bestMeter)) {
              bestTier = tier;
              bestMeter = meter;
              chosenFamily = fam;
            }
          });
          if (bestTier <= 0) {
            chosenFamily = null;
            bestMeter = 0;
          }

          const maxTargets = ability?.proliferateWeakness?.maxTargets ?? 2;
          const ratio = ability?.proliferateWeakness?.ratio ?? 0.4;

          others.forEach((char, idx) => {
            splash.push({
              target: char,
              amount: splashAmount,
              tags: ability?.tags,
            });

            if (idx < maxTargets && chosenFamily && bestMeter > 0) {
              const transfer = Math.max(0, Math.floor(bestMeter * ratio));
              if (transfer > 0) {
                char.weakness = char.weakness || { meters: {}, tiers: {} };
                char.weakness.meters = char.weakness.meters || {};
                char.weakness.tiers = char.weakness.tiers || {};
                char.weakness.meters[chosenFamily] = (char.weakness.meters[chosenFamily] || 0) + transfer;
                char.weakness.tiers[chosenFamily] = weaknessTierFromMeter(char.weakness.meters[chosenFamily]);
                spreadMeta.push({ targetId: char.id || char.name, family: chosenFamily, amount: transfer });
              }
            }
          });
        }
      }

      return {
        ...roll,
        amount,
        splash: splash.length ? splash : undefined,
        proliferatedWeakness: spreadMeta.length ? spreadMeta : undefined,
      };
    },
    description: "Scatter shrapnel through the rank, spreading the primary condition to others."
  },

  // ===============================
  // v3.21 - Wand (1h) (13)
  // ===============================

  // -------- Generation (7) --------
  'spark_mark': {
    id: "spark_mark",
    name: "Spark Mark",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["wand"],
    requiredStat: "INT",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "lightning", "expose"],
    emitTagsOnUse: ["spell", "lightning"],
    buildupHint: { expose: 40, lightning: 40 },
    apply: (attacker, target) => {
      const ability = SKILLS?.spark_mark;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: 'lightning',
        isMagic: true,
        skipGearMultiplier: true,
      }));

      const exposeTier = target?.weakness?.tiers?.expose || 0;
      const lightningTier = target?.weakness?.tiers?.lightning || 0;
      const exposeMeter = target?.weakness?.meters?.expose || 0;
      const lightningMeter = target?.weakness?.meters?.lightning || 0;
      const exposeIntensity = Math.max(1, weaknessIntensityMult(exposeMeter) || 1);
      const lightningIntensity = Math.max(1, weaknessIntensityMult(lightningMeter) || 1);

      let exposeBuildup = ability?.buildupHint?.expose ?? 40;
      let lightningBuildup = ability?.buildupHint?.lightning ?? 40;

      if (exposeTier >= 1) {
        amount = Math.floor(amount * (1 + 0.05 * exposeTier));
        exposeBuildup += Math.max(3, Math.floor(4 * exposeIntensity));
      }
      if (lightningTier >= 1) {
        amount = Math.floor(amount * (1 + 0.08 * lightningTier));
        lightningBuildup += Math.max(4, Math.floor(6 * lightningIntensity));
      }

      return {
        ...roll,
        amount,
        isMagic: true,
        element: 'lightning',
        buildup: { expose: exposeBuildup, lightning: lightningBuildup },
      };
    },
    description: "A pricking spark that opens guard and seeds a little Shock."
  },

  'hex_pin': {
    id: "hex_pin",
    name: "Hex Pin",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["wand"],
    requiredStat: "INT",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "curse"],
    buildupHint: { curse: 60 },
    apply: (attacker, target) => {
      const ability = SKILLS?.hex_pin;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        isMagic: true,
        skipGearMultiplier: true,
      }));

      const meter = target?.weakness?.meters?.curse || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      amount = Math.floor(amount * (1 + Math.max(0, intensity - 1) * 0.15));

      const buildup = Math.max(1, Math.floor((ability?.buildupHint?.curse ?? 60) * intensity));

      return {
        ...roll,
        amount,
        isMagic: true,
        buildup: { curse: buildup },
      };
    },
    description: "Affix a minor curse that lingers and prepares targets for curse synergies."
  },

  'chill_thread': {
    id: "chill_thread",
    name: "Chill Thread",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["wand"],
    requiredStat: "INT",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "cold"],
    buildupHint: { cold: 60 },
    rewardIfTierCross: [{ family: "cold", tier: 1, debuff: { speedDownPct: 10, turns: 1 } }],
    apply: (attacker, target) => {
      const ability = SKILLS?.chill_thread;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: 'cold',
        isMagic: true,
        skipGearMultiplier: true,
      }));

      const coldTier = target?.weakness?.tiers?.cold || 0;
      const meter = target?.weakness?.meters?.cold || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      let buildup = ability?.buildupHint?.cold ?? 60;
      if (coldTier >= 1) {
        amount = Math.floor(amount * (1 + 0.12 * coldTier));
        buildup += Math.max(4, Math.floor(6 * intensity));
      }

      return {
        ...roll,
        amount,
        isMagic: true,
        element: 'cold',
        buildup: { cold: buildup },
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
      };
    },
    description: "A thread of frost; crossing Cold T1 briefly slows the target."
  },

  'venom_sigil': {
    id: "venom_sigil",
    name: "Venom Sigil",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["wand"],
    requiredStat: "INT",
    requiredValue: 13,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "toxic"],
    buildupHint: { toxic: 60 },
    rewardIfWeak: { family: "expose", tierAtLeast: 1, buff: { addBuildup: { toxic: 20 } } },
    apply: (attacker, target) => {
      const ability = SKILLS?.venom_sigil;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        isMagic: true,
        skipGearMultiplier: true,
      }));

      const exposeTier = target?.weakness?.tiers?.expose || 0;
      let buildup = ability?.buildupHint?.toxic ?? 60;
      if (exposeTier >= 1) {
        amount = Math.floor(amount * (1 + 0.1 * exposeTier));
        buildup += ability?.rewardIfWeak?.buff?.addBuildup?.toxic ?? 20;
      }

      return {
        ...roll,
        amount,
        isMagic: true,
        buildup: { toxic: buildup },
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
      };
    },
    description: "Inscribe venomous runes; Exposed foes accrue more Poison."
  },

  'fracture_rune': {
    id: "fracture_rune",
    name: "Fracture Rune",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["wand"],
    requiredStat: "INT",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "expose", "proliferate"],
    emitTagsOnUse: ["spell"],
    buildupHint: { expose: 50 },
    proliferateWeakness: { families: ["expose"], to: "adjacent", ratio: 0.5, maxTargets: 1 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.fracture_rune;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        isMagic: true,
        skipGearMultiplier: true,
      }));

      const baseBuildup = ability?.buildupHint?.expose ?? 50;
      const spreadMeta = [];

      if (scene && target && typeof scene._getUnitColumn === 'function' && typeof scene._getColumnBySlotId === 'function') {
        const column = scene._getUnitColumn(target);
        if (column) {
          const sideSlots = target?.isEnemy ? scene.enemySlots : scene.allySlots;
          const neighbors = sideSlots
            ?.filter(slot => slot?.char && slot.char !== target && slot.char.status !== 'incapacitated' && scene._getColumnBySlotId(slot.slotId) === column)
            .map(slot => slot.char) || [];
          const maxTargets = ability?.proliferateWeakness?.maxTargets ?? 1;
          const ratio = ability?.proliferateWeakness?.ratio ?? 0.5;
          const sourceMeter = target?.weakness?.meters?.expose || 0;

          neighbors.slice(0, maxTargets).forEach(char => {
            const transfer = Math.max(0, Math.floor(sourceMeter * ratio));
            if (transfer > 0) {
              char.weakness = char.weakness || { meters: {}, tiers: {} };
              char.weakness.meters = char.weakness.meters || {};
              char.weakness.tiers = char.weakness.tiers || {};
              char.weakness.meters.expose = (char.weakness.meters.expose || 0) + transfer;
              char.weakness.tiers.expose = weaknessTierFromMeter(char.weakness.meters.expose);
              spreadMeta.push({ targetId: char.id || char.name, family: 'expose', amount: transfer });
            }
          });
        }
      }

      return {
        ...roll,
        amount,
        isMagic: true,
        buildup: { expose: baseBuildup },
        proliferatedWeakness: spreadMeta.length ? spreadMeta : undefined,
      };
    },
    description: "A shattering glyph that transfers opening pressure to a nearby foe."
  },

  'focus_meditation': {
    id: "focus_meditation",
    name: "Focus Meditation",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["wand"],
    requiredStat: "WIS",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 0,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["support", "mp", "stance"],
    statusEffects: [{ id: "focus_meditation", turns: 1, mpRestoreFlat: 3, nextSpellAccPct: 10 }],
    apply: (attacker) => {
      const ability = SKILLS?.focus_meditation;
      const statusEffects = Array.isArray(ability?.statusEffects)
        ? ability.statusEffects.map(effect => ({ ...effect }))
        : [];

      return {
        amount: 0,
        statusEffects,
      };
    },
    description: "Steady mind and channel-restore MP and steady your next spell."
  },

  'conductive_touch': {
    id: "conductive_touch",
    name: "Conductive Touch",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["wand"],
    requiredStat: "CHA",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "lightning"],
    buildupHint: { lightning: 50 },
    rewardIfWeak: { family: "lightning", tierAtLeast: 1, buff: { chanceExtraHitPct: 25 } },
    apply: (attacker, target) => {
      const ability = SKILLS?.conductive_touch;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: 'lightning',
        isMagic: true,
        skipGearMultiplier: true,
      }));

      const lightningTier = target?.weakness?.tiers?.lightning || 0;
      let buildup = ability?.buildupHint?.lightning ?? 50;
      if (lightningTier >= 1) {
        amount = Math.floor(amount * (1 + 0.12 * lightningTier));
        buildup += 10 * lightningTier;
      }

      let extraDamage = 0;
      if (lightningTier >= (ability?.rewardIfWeak?.tierAtLeast ?? 1)) {
        const pct = ability?.rewardIfWeak?.buff?.chanceExtraHitPct ?? 25;
        extraDamage = Math.max(1, Math.floor(amount * (pct / 100)));
        amount += extraDamage;
      }

      return {
        ...roll,
        amount,
        isMagic: true,
        element: 'lightning',
        buildup: { lightning: buildup },
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
        extraHits: extraDamage ? [{ amount: extraDamage, element: 'lightning', isMagic: true, repeat: true }] : undefined,
      };
    },
    description: "A palm-channelled jolt; Shocked foes may suffer an extra zap."
  },

  // -------- Payoff (6) --------
  'curse_snap_wand': {
    id: "curse_snap_wand",
    name: "Curse Snap",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["wand"],
    requiredStat: "INT",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "curse", "amplify"],
    requiresWeakness: { family: "curse", tierAtLeast: 1 },
    apply: (attacker, target) => {
      const ability = SKILLS?.curse_snap_wand;
      const roll = calculateDamage(attacker, target, ability);
      const intBonus = Math.floor((attacker?.totalStats?.INT || 0) / 3);
      const base = roll.amount + intBonus;
      let amount = Math.max(1, applyDamageModifiers(base, attacker, target, {
        ability,
        tags: ability?.tags,
        element: 'curse',
        isMagic: true,
        skipGearMultiplier: true,
      }));

      const meter = target?.weakness?.meters?.curse || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      amount = Math.floor(amount * (1 + Math.max(0, intensity - 1) * 0.08));

      const status = { id: 'curse_snap', turns: 1, doubleCurseTicks: true };

      return {
        ...roll,
        amount,
        isMagic: true,
        statusEffects: [status],
      };
    },
    description: "For one turn, all Curse effects on the target tick twice (amplify only; no consume)."
  },

  'ice_shatter_wand': {
    id: "ice_shatter_wand",
    name: "Ice Shatter",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["wand"],
    requiredStat: "INT",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "cold", "amplify"],
    requiresWeakness: { family: "cold", tierAtLeast: 1 },
    rewardIfWeak: { family: "cold", tierAtLeast: 2, buff: { armorDownPct: 12, turns: 2 } },
    apply: (attacker, target) => {
      const ability = SKILLS?.ice_shatter_wand;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: 'cold',
        isMagic: true,
        skipGearMultiplier: true,
      }));

      const meter = target?.weakness?.meters?.cold || 0;
      const tier = target?.weakness?.tiers?.cold || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      if (tier >= 1) {
        amount = Math.floor(amount * (1 + 0.15 * tier));
      }
      if (intensity > 1) {
        amount = Math.floor(amount * (1 + Math.max(0, intensity - 1) * 0.2));
      }

      return {
        ...roll,
        amount,
        isMagic: true,
        element: 'cold',
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
      };
    },
    description: "Exploit brittle frost; at higher Cold tiers, it fractures armor."
  },

  'venom_bloom_wand': {
    id: "venom_bloom_wand",
    name: "Venom Bloom",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["wand"],
    requiredStat: "INT",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "toxic", "consume"],
    requiresWeakness: { family: "toxic", tierAtLeast: 1 },
    consumeWeakness: ["toxic"],
    rewardIfWeak: { family: "toxic", tierAtLeast: 2, buff: { extraRapidTicks: 1 } },
    apply: (attacker, target) => {
      const ability = SKILLS?.venom_bloom_wand;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        isMagic: true,
        skipGearMultiplier: true,
      }));

      const meter = target?.weakness?.meters?.toxic || 0;
      const tier = target?.weakness?.tiers?.toxic || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      const burst = Math.max(0, Math.floor((meter / 13) + (tier * 5) + Math.max(0, intensity - 1) * 6));
      amount += burst;

      return {
        ...roll,
        amount,
        isMagic: true,
        consumeWeakness: ability?.consumeWeakness ? [...ability.consumeWeakness] : undefined,
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
        log: burst ? `${attacker?.name || 'The caster'} blooms the toxin for +${burst} damage.` : undefined,
      };
    },
    description: "Consume Poison to trigger rapid ticks; adds an extra tick at higher tiers."
  },

  'arc_resonance': {
    id: "arc_resonance",
    name: "Arc Resonance",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["wand"],
    requiredStat: "INT",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "lightning", "amplify"],
    requiresWeakness: { family: "lightning", tierAtLeast: 1 },
    rewardIfWeak: { family: "lightning", tierAtLeast: 2, buff: { repeatStrikeOnce: true, repeatPowerPct: 55 } },
    apply: (attacker, target) => {
      const ability = SKILLS?.arc_resonance;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: 'lightning',
        isMagic: true,
        skipGearMultiplier: true,
      }));

      const meter = target?.weakness?.meters?.lightning || 0;
      const tier = target?.weakness?.tiers?.lightning || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      if (tier >= 1) {
        amount = Math.floor(amount * (1 + 0.15 * tier));
      }
      if (intensity > 1) {
        amount = Math.floor(amount * (1 + Math.max(0, intensity - 1) * 0.2));
      }

      let repeatDamage = 0;
      if (tier >= (ability?.rewardIfWeak?.tierAtLeast ?? 2)) {
        const pct = ability?.rewardIfWeak?.buff?.repeatPowerPct ?? 55;
        repeatDamage = Math.max(1, Math.floor(amount * (pct / 100)));
        amount += repeatDamage;
      }

      return {
        ...roll,
        amount,
        isMagic: true,
        element: 'lightning',
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
        extraHits: repeatDamage ? [{ amount: repeatDamage, element: 'lightning', isMagic: true, repeat: true }] : undefined,
      };
    },
    description: "Tune to the target's Shock and echo the discharge once at reduced power."
  },

  'rune_conversion': {
    id: "rune_conversion",
    name: "Rune Conversion",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["wand"],
    requiredStat: "INT",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "transform"],
    requiresWeakness: { family: "lacerate", tierAtLeast: 1 },
    transformWeakness: { from: "lacerate", to: "curse", ratio: 0.7 },
    buildupHint: { lacerate: 100 },
    apply: (attacker, target) => {
      const ability = SKILLS?.rune_conversion;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        isMagic: true,
        skipGearMultiplier: true,
      }));

      const transform = ability?.transformWeakness;
      let transformed;
      if (transform && target?.weakness) {
        const fromKey = transform.from;
        const toKey = transform.to;
        const ratio = transform.ratio ?? 1;
        const current = target.weakness.meters?.[fromKey] || 0;
        if (current > 0) {
          const transfer = Math.max(0, Math.floor(current * ratio));
          const remaining = Math.max(0, current - transfer);
          target.weakness.meters[fromKey] = remaining;
          target.weakness.meters[toKey] = (target.weakness.meters[toKey] || 0) + transfer;
          if (target.weakness.tiers) {
            target.weakness.tiers[fromKey] = weaknessTierFromMeter(target.weakness.meters[fromKey]);
            target.weakness.tiers[toKey] = weaknessTierFromMeter(target.weakness.meters[toKey]);
          }
          transformed = { from: fromKey, to: toKey, amount: transfer };
        }
      }

      return {
        ...roll,
        amount,
        isMagic: true,
        transformedWeakness: transformed,
      };
    },
    description: "Convert physical Bleed into a binding Curse to shift the weakness profile."
  },

  'weakpoint_lance': {
    id: "weakpoint_lance",
    name: "Weakpoint Lance",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["wand"],
    requiredStat: "INT",
    requiredValue: 17,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "finisher"],
    requiresWeakness: { family: "expose", tierAtLeast: 1 },
    rewardIfWeak: { family: "expose", tierAtLeast: 2, buff: { critMultBonus: 0.4 } },
    apply: (attacker, target) => {
      const ability = SKILLS?.weakpoint_lance;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        isMagic: true,
        skipGearMultiplier: true,
      }));

      const exposeTier = target?.weakness?.tiers?.expose || 0;
      const meter = target?.weakness?.meters?.expose || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      if (exposeTier > 1) {
        amount = Math.floor(amount * (1 + 0.25 * (exposeTier - 1)));
      }
      if (intensity > 1) {
        amount = Math.floor(amount * (1 + Math.max(0, intensity - 1) * 0.2));
      }
      if (exposeTier >= (ability?.rewardIfWeak?.tierAtLeast ?? 2)) {
        const critBonus = ability?.rewardIfWeak?.buff?.critMultBonus ?? 0.4;
        amount = Math.floor(amount * (1 + critBonus));
      }

      return {
        ...roll,
        amount,
        isMagic: true,
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
      };
    },
    description: "Condense mana into a piercing ray that drills through a narrow opening."
  },

  // ===============================
  // v3.21 - Shield (13)
  // ===============================

  // -------- Generation (7) --------
  'edge_probe': {
    id: "edge_probe",
    name: "Edge Probe",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["shield"],
    requiredStat: "DEX",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 1,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "expose"],
    emitTagsOnUse: ["bash"],
    buildupHint: { expose: 55 },
    apply: (attacker, target) => {
      const ability = SKILLS?.edge_probe;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const exposeTier = target?.weakness?.tiers?.expose || 0;
      const meter = target?.weakness?.meters?.expose || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      let buildup = ability?.buildupHint?.expose ?? 55;
      if (exposeTier >= 1) {
        amount = Math.floor(amount * (1 + 0.08 * exposeTier));
        buildup += Math.max(4, Math.floor(5 * intensity));
      }

      return {
        ...roll,
        amount,
        buildup: { expose: buildup },
      };
    },
    description: "Test the foe with the shield's rim, prying open a small guard gap."
  },

  'stagger_bash': {
    id: "stagger_bash",
    name: "Stagger Bash",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["shield"],
    requiredStat: "STR",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "disorient"],
    buildupHint: { disorient: 65 },
    rewardIfWeak: { family: "expose", tierAtLeast: 1, buff: { addBuildup: { disorient: 25 } } },
    apply: (attacker, target) => {
      const ability = SKILLS?.stagger_bash;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const exposeTier = target?.weakness?.tiers?.expose || 0;
      let buildup = ability?.buildupHint?.disorient ?? 65;
      if (exposeTier >= 1) {
        amount = Math.floor(amount * (1 + 0.1 * exposeTier));
        buildup += ability?.rewardIfWeak?.buff?.addBuildup?.disorient ?? 25;
      }

      return {
        ...roll,
        amount,
        buildup: { disorient: buildup },
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
      };
    },
    description: "A jarring slam that rattles the head; worse if the foe is already Exposed."
  },

  'brace_and_press': {
    id: "brace_and_press",
    name: "Brace and Press",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["shield"],
    requiredStat: "CON",
    requiredValue: 14,
    actionCost: "bonus",
    mpCost: 0,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["stance", "support", "expose"],
    buildupHint: { expose: 30 },
    statusEffects: [{ id: "braced", turns: 1, guardPct: 15 }],
    rewardIfTierCross: [{ family: "expose", tier: 1, buff: { accPct: 10, turns: 1 } }],
    apply: (attacker) => {
      const ability = SKILLS?.brace_and_press;
      const statusEffects = Array.isArray(ability?.statusEffects)
        ? ability.statusEffects.map(effect => ({ ...effect }))
        : [];

      return {
        amount: 0,
        statusEffects,
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
      };
    },
    description: "Raise the shield and pressure forward-gain guard; if you open a guard this turn, gain accuracy."
  },

  'line_bulldoze': {
    id: "line_bulldoze",
    name: "Line Bulldoze",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["shield"],
    requiredStat: "STR",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "expose", "aoe"],
    emitTagsOnUse: ["bash", "push"],
    aoe: { shape: "column", scale: 1 },
    buildupHint: { expose: 40 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.line_bulldoze;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const baseBuildup = ability?.buildupHint?.expose ?? 40;
      const splash = [];

      if (scene && target && typeof scene._getUnitColumn === 'function' && typeof scene._getColumnBySlotId === 'function') {
        const column = scene._getUnitColumn(target);
        if (column) {
          const sideSlots = target?.isEnemy ? scene.enemySlots : scene.allySlots;
          const neighbors = sideSlots
            ?.filter(slot => slot?.char && slot.char !== target && slot.char.status !== 'incapacitated' && scene._getColumnBySlotId(slot.slotId) === column)
            .map(slot => slot.char) || [];
          const splashAmount = Math.max(1, Math.floor(amount * 0.8));
          const splashBuildup = Math.max(1, Math.floor(baseBuildup * 0.75));
          neighbors.forEach(char => {
            splash.push({
              target: char,
              amount: splashAmount,
              buildup: { expose: splashBuildup },
              tags: ability?.tags,
            });
          });
        }
      }

      return {
        ...roll,
        amount,
        buildup: { expose: baseBuildup },
        splash: splash.length ? splash : undefined,
      };
    },
    description: "Drive the formation back with a wall of iron; lightly Exposes every foe in the column."
  },

  'ringing_rim': {
    id: "ringing_rim",
    name: "Ringing Rim",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["shield"],
    requiredStat: "STR",
    requiredValue: 13,
    actionCost: "bonus",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "disorient"],
    buildupHint: { disorient: 55 },
    rewardIfTierCross: [{ family: "disorient", tier: 1, debuff: { accDownPct: 10, turns: 1 } }],
    apply: (attacker, target) => {
      const ability = SKILLS?.ringing_rim;
      const roll = calculateDamage(attacker, target, ability);
      const amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const buildup = ability?.buildupHint?.disorient ?? 55;

      return {
        ...roll,
        amount,
        buildup: { disorient: buildup },
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
      };
    },
    description: "Clip the ear with the rim; crossing Disorient T1 rattles aim."
  },

  'frost_ward': {
    id: "frost_ward",
    name: "Frost Ward",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["shield"],
    requiredStat: "INT",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "cold"],
    buildupHint: { cold: 60 },
    rewardIfWeak: { family: "expose", tierAtLeast: 1, buff: { addBuildup: { cold: 20 } } },
    apply: (attacker, target) => {
      const ability = SKILLS?.frost_ward;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: 'cold',
        isMagic: true,
        skipGearMultiplier: true,
      }));

      const exposeTier = target?.weakness?.tiers?.expose || 0;
      let buildup = ability?.buildupHint?.cold ?? 60;
      if (exposeTier >= 1) {
        amount = Math.floor(amount * (1 + 0.1 * exposeTier));
        buildup += ability?.rewardIfWeak?.buff?.addBuildup?.cold ?? 20;
      }

      return {
        ...roll,
        amount,
        isMagic: true,
        element: 'cold',
        buildup: { cold: buildup },
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
      };
    },
    description: "Channel cold across the bossing and strike; Exposed foes chill faster."
  },

  'lockstep': {
    id: "lockstep",
    name: "Lockstep",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["shield"],
    requiredStat: "WIS",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 1,
    requiresTarget: false,
    targetRequirement: "ally",
    tags: ["support", "mp", "stance"],
    statusEffects: [{ id: "lockstep", turns: 1, teamGuardPct: 5, nextBlockBonusPct: 15 }],
    apply: (attacker) => {
      const ability = SKILLS?.lockstep;
      const statusEffects = Array.isArray(ability?.statusEffects)
        ? ability.statusEffects.map(effect => ({ ...effect }))
        : [];

      return {
        amount: 0,
        statusEffects,
      };
    },
    description: "Set the cadence for the line; minor team guard and a boosted first block."
  },

  // -------- Payoff (6) --------
  'shield_hook': {
    id: "shield_hook",
    name: "Shield Hook",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["shield"],
    requiredStat: "STR",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "consume", "expose"],
    requiresWeakness: { family: "expose", tierAtLeast: 1 },
    consumeWeakness: ["expose"],
    statusEffects: [{ id: "immobilized", turns: 1 }],
    apply: (attacker, target) => {
      const ability = SKILLS?.shield_hook;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const meter = target?.weakness?.meters?.expose || 0;
      const tier = target?.weakness?.tiers?.expose || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      const bonus = Math.max(0, Math.floor((meter / 10) + (tier * 6) + Math.max(0, intensity - 1) * 6));
      amount += bonus;

      const statusEffects = Array.isArray(ability?.statusEffects)
        ? ability.statusEffects.map(effect => ({ ...effect }))
        : undefined;

      return {
        ...roll,
        amount,
        statusEffects,
        consumeWeakness: ability?.consumeWeakness ? [...ability.consumeWeakness] : undefined,
        log: bonus ? `${attacker?.name || 'The shieldbearer'} hooks the target for +${bonus} damage.` : undefined,
      };
    },
    description: "Hook and yank-consume Expose and briefly immobilize the target."
  },

  'body_check': {
    id: "body_check",
    name: "Body Check",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["shield"],
    requiredStat: "CON",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "finisher"],
    requiresWeakness: { family: "disorient", tierAtLeast: 1 },
    rewardIfWeak: { family: "disorient", tierAtLeast: 2, buff: { damagePct: 18 } },
    apply: (attacker, target) => {
      const ability = SKILLS?.body_check;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const tier = target?.weakness?.tiers?.disorient || 0;
      const meter = target?.weakness?.meters?.disorient || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      if (tier >= 1) {
        amount = Math.floor(amount * (1 + 0.18 * tier));
      }
      if (intensity > 1) {
        amount = Math.floor(amount * (1 + Math.max(0, intensity - 1) * 0.15));
      }
      if (tier >= (ability?.rewardIfWeak?.tierAtLeast ?? 2)) {
        const bonus = ability?.rewardIfWeak?.buff?.damagePct ?? 18;
        amount = Math.floor(amount * (1 + bonus / 100));
      }

      return {
        ...roll,
        amount,
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
      };
    },
    description: "Lead with the shoulder; excels when the enemy is rattled."
  },

  'shield_crush': {
    id: "shield_crush",
    name: "Shield Crush",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["shield"],
    requiredStat: "STR",
    requiredValue: 17,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "amplify"],
    requiresWeakness: { family: "expose", tierAtLeast: 1 },
    rewardIfWeak: { family: "expose", tierAtLeast: 2, buff: { armorDownPct: 18, turns: 2 } },
    apply: (attacker, target) => {
      const ability = SKILLS?.shield_crush;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const meter = target?.weakness?.meters?.expose || 0;
      const tier = target?.weakness?.tiers?.expose || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      if (tier >= 1) {
        amount = Math.floor(amount * (1 + 0.18 * tier));
      }
      if (intensity > 1) {
        amount = Math.floor(amount * (1 + Math.max(0, intensity - 1) * 0.15));
      }
      if (tier >= (ability?.rewardIfWeak?.tierAtLeast ?? 2)) {
        const bonus = ability?.rewardIfWeak?.buff?.armorDownPct ?? 0;
        amount = Math.floor(amount * (1 + (bonus / 100) * 0.5));
      }

      return {
        ...roll,
        amount,
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
      };
    },
    description: "Pulverize an opening to crack armor; nastier at deeper Expose."
  },

  'cold_pin': {
    id: "cold_pin",
    name: "Cold Pin",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["shield"],
    requiredStat: "INT",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "cold", "consume"],
    requiresWeakness: { family: "cold", tierAtLeast: 2 },
    consumeWeakness: ["cold"],
    statusEffects: [{ id: "immobilized", turns: 1 }],
    apply: (attacker, target) => {
      const ability = SKILLS?.cold_pin;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: 'cold',
        isMagic: true,
        skipGearMultiplier: true,
      }));

      const meter = target?.weakness?.meters?.cold || 0;
      const tier = target?.weakness?.tiers?.cold || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      const burst = Math.max(0, Math.floor((meter / 12) + (tier * 6) + Math.max(0, intensity - 1) * 7));
      amount += burst;

      const statusEffects = Array.isArray(ability?.statusEffects)
        ? ability.statusEffects.map(effect => ({ ...effect }))
        : undefined;

      return {
        ...roll,
        amount,
        isMagic: true,
        element: 'cold',
        statusEffects,
        consumeWeakness: ability?.consumeWeakness ? [...ability.consumeWeakness] : undefined,
        log: burst ? `${attacker?.name || 'The shieldbearer'} pins the frozen target for +${burst} damage.` : undefined,
      };
    },
    description: "Drive the frozen edge in and pin-consumes Cold and roots the target briefly."
  },

  'bulwark_slam': {
    id: "bulwark_slam",
    name: "Bulwark Slam",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["shield"],
    requiredStat: "STR",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "aoe", "finisher"],
    aoe: { shape: "column", scale: 1 },
    requiresWeakness: { family: "expose", tierAtLeast: 1 },
    rewardIfWeak: { family: "expose", tierAtLeast: 2, buff: { damagePct: 16 } },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.bulwark_slam;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const exposeTier = target?.weakness?.tiers?.expose || 0;
      if (exposeTier >= 1) {
        amount = Math.floor(amount * (1 + 0.18 * exposeTier));
      }
      if (exposeTier >= (ability?.rewardIfWeak?.tierAtLeast ?? 2)) {
        const bonus = ability?.rewardIfWeak?.buff?.damagePct ?? 16;
        amount = Math.floor(amount * (1 + bonus / 100));
      }

      const splash = [];
      if (scene && target && typeof scene._getUnitColumn === 'function' && typeof scene._getColumnBySlotId === 'function') {
        const column = scene._getUnitColumn(target);
        if (column) {
          const sideSlots = target?.isEnemy ? scene.enemySlots : scene.allySlots;
          const others = sideSlots
            ?.filter(slot => slot?.char && slot.char !== target && slot.char.status !== 'incapacitated' && scene._getColumnBySlotId(slot.slotId) === column)
            .map(slot => slot.char) || [];
          const splashAmount = Math.max(1, Math.floor(amount * 0.8));
          others.forEach(char => {
            splash.push({
              target: char,
              amount: splashAmount,
              tags: ability?.tags,
            });
          });
        }
      }

      return {
        ...roll,
        amount,
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
        splash: splash.length ? splash : undefined,
      };
    },
    description: "A driving wall-of-iron impact that excels against Exposed ranks."
  },

  'standfast_rebuke': {
    id: "standfast_rebuke",
    name: "Standfast Rebuke",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["shield"],
    requiredStat: "WIS",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "amplify", "disorient"],
    requiresWeakness: { family: "disorient", tierAtLeast: 1 },
    rewardIfWeak: { family: "disorient", tierAtLeast: 2, buff: { guardBreakPct: 20, turns: 1 } },
    apply: (attacker, target) => {
      const ability = SKILLS?.standfast_rebuke;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const meter = target?.weakness?.meters?.disorient || 0;
      const tier = target?.weakness?.tiers?.disorient || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      if (tier >= 1) {
        amount = Math.floor(amount * (1 + 0.2 * tier));
      }
      if (intensity > 1) {
        amount = Math.floor(amount * (1 + Math.max(0, intensity - 1) * 0.18));
      }

      return {
        ...roll,
        amount,
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
      };
    },
    description: "A disciplined rebuke that capitalizes on rattled minds, briefly worsening guard break."
  },

  // ===============================
  // v3.22 - Staff (2h) (16)
  // ===============================

  // -------- Generation --------

  'conclave_circle': {
    id: "conclave_circle",
    name: "Conclave Circle",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["staff"],
    requiredStat: "WIS",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 6,
    cooldown: 6,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["magic", "spell", "zone", "mana"],
    // Zone-toggle utility cast, not a repeatable damage/buildup spell —
    // Rune Channel's recast mechanic would only ever waste the caster's own
    // self-punishment for zero benefit (and casting Rune Channel itself
    // would otherwise become instantly eligible to recast ITSELF the moment
    // it turns its own mod on). See noRecast check in _applyAbilityToTarget.
    noRecast: true,
    apply: (attacker, target, scene) => {
      attacker.statusEffects = attacker.statusEffects || [];
      if (getRunicZone(attacker)) {
        return { amount: 0, log: `${attacker?.name ?? 'Mage'} already has an active runic zone.` };
      }
      attacker.statusEffects.push({
        id: 'runic_zone',
        turns: 4,
        mpPerTurn: 2,
        ownerSlotId: attacker._slot?.slotId,
        mods: { kindlingRite: false, wardWeave: false, runeChannel: false },
      });
      // TODO (CombatScene): each turn caster is in zone, restore mpPerTurn MP
      // TODO (CombatScene): on caster movement, find and remove runic_zone effect
      // TODO (CombatScene): apply kindlingRite/wardWeave/runeChannel tick effects per turn
      scene?._refreshRunicZoneSprite?.(attacker);
      return { amount: 0, log: `${attacker?.name ?? 'Mage'} traces a runic circle of power!` };
    },
    description: "Trace a runic circle at your feet. Lasts 4 turns, generates 2 MP/turn. Dissipates if you move. Required for zone modification skills."
  },

  'frost_swell': {
    id: "frost_swell",
    name: "Frost Swell",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["staff"],
    requiredStat: "INT",
    requiredValue: 13,
    actionCost: "major",
    mpCost: 4,
    cooldown: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "cold", "elemental"],
    buildupHint: { cold: 65 },
    // If target is at least Chilled (Cold T1): flat +20% damage and +20
    // additional Cold buildup — both flat now, replacing the old per-tier/
    // intensity-scaled formulas. Crossing Frostbitten (Cold T2) steals up to
    // 5 Initiative from the target (genuine theft, capped by what they
    // actually have — see stealInitiative in CombatScene.js).
    rewardIfWeak: [{ family: "cold", tierAtLeast: 1, buff: { damagePct: 20, addBuildup: { cold: 20 } } }],
    rewardIfTierCross: [{ family: "cold", tier: 2, stealInitiative: 5 }],
    apply: (attacker, target, scene, opts = {}) => {
      const ability = SKILLS?.frost_swell;
      // powerScale (default 1) — set by a Rune Channel recast at 0.60. Only
      // damage and buildup scale; rewardIfTierCross's stealInitiative is a
      // discrete effect the engine grants separately from amount/buildup, so
      // it's untouched here and stays full value on a recast, same as a
      // normal cast — see project_damage_pipeline_reorder memory.
      const powerScale = Number.isFinite(opts?.powerScale) ? opts.powerScale : 1;
      const roll = calculateDamage(attacker, target, ability);

      const coldTier = target?.weakness?.tiers?.cold || 0;
      const rule = findRewardIfWeakRule(ability, coldTier);
      const bonusPct = rule?.buff?.damagePct || 0;
      const bonusBuildup = rule?.buff?.addBuildup?.cold || 0;

      const basePct = 100 + bonusPct;
      const scaledPct = basePct * powerScale;
      const powerNote = powerScale !== 1 ? ` × ${Math.round(powerScale * 100)}% power` : '';

      // Whole hit reflavored as Cold/Elemental regardless of the weapon's own
      // physical/elemental split — a frost spell, not a physical staff swing.
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: scaledPct,
          skillLabel: `${ability?.name || 'Skill'} weapon damage (${basePct}%${bonusPct ? ` + ${bonusPct}% Chilled` : ''}${powerNote})`,
          isCrit: roll.isCrit, critMult: roll.critMult,
          skillConversion: { physToElemPct: 100 },
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      const coldBuildup = Math.floor(((ability?.buildupHint?.cold ?? 65) + bonusBuildup) * powerScale);

      return {
        ...roll,
        physical, elemental, necrotic, amount,
        isMagic: true,
        element: 'cold',
        buildup: { cold: coldBuildup },
        rewardIfWeak: cloneRewardOrList(ability?.rewardIfWeak),
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
      };
    },
    description: "Deals 100% weapon damage as Cold, +65 Cold buildup. If target is at least Chilled (Cold T1): +20% damage, +20 additional Cold buildup. Crossing Frostbitten (Cold T2): steals up to 5 Initiative from the target."
  },

  'galvanic_touch': {
    id: "galvanic_touch",
    name: "Galvanic Touch",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["staff"],
    requiredStat: "INT",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 2,
    cooldown: 1,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "lightning", "elemental"],
    buildupHint: { lightning: 55 },
    apply: (attacker, target) => {
      const ability = SKILLS?.galvanic_touch;
      const roll = calculateDamage(attacker, target, ability);

      const lightningTier = target?.weakness?.tiers?.lightning || 0;
      const lightningMeter = target?.weakness?.meters?.lightning || 0;

      // Whole hit reflavored as Lightning/Elemental — a bonus-action spark,
      // not a physical staff swing.
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 80, skillLabel: `${ability?.name || 'Skill'} weapon damage (80%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
          skillConversion: { physToElemPct: 100 },
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      // +10 Lightning buildup per tier (T1 = +10, T2 = +20 total) — flat,
      // not intensity-scaled.
      const lightningBuildup = (ability?.buildupHint?.lightning ?? 55) + 10 * lightningTier;

      // Small chance of an extra hit once at least Zapped (Lightning T1+),
      // scaling with the target's current meter — same meter-scaled-chance
      // model Static Prick/Hex Stitch already use, capped modest since this
      // is only a bonus action. The generic repeatChance mechanic
      // (CombatScene.js) carries element/isMagic/buildup through correctly,
      // which is everything this hit has since it's 100% elemental after
      // the conversion above — nothing gets lost.
      const repeatChance = lightningTier >= 1 ? Math.min(0.20, lightningMeter / 1000) : 0;

      return {
        ...roll,
        physical, elemental, necrotic, amount,
        isMagic: true,
        element: 'lightning',
        buildup: { lightning: lightningBuildup },
        repeatChance,
      };
    },
    description: "Bonus action. Deals 80% weapon damage as Lightning, +55 Lightning buildup. If target is at least Zapped (Lightning T1+): +10 additional Lightning buildup per tier (up to +20 at T2), plus a small meter-scaled chance (up to 20%) of an extra hit carrying the same damage and buildup."
  },

  'kindling_rite': {
    id: "kindling_rite",
    name: "Kindling Rite",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["staff"],
    requiredStat: "INT",
    requiredValue: 13,
    actionCost: "major",
    mpCost: 5,
    cooldown: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "fire", "elemental", "zone"],
    buildupHint: { fire: 120 },
    apply: (attacker, target, scene, opts = {}) => {
      const zone = getRunicZone(attacker);
      if (!zone) return { amount: 0, log: "Kindling Rite requires an active runic zone." };
      const ability = SKILLS?.kindling_rite;
      // powerScale (default 1) — set by a Rune Channel recast at 0.60. Damage
      // and buildup scale; the zone stack (below) does NOT scale — a recast
      // is still a genuine second cast, so it stacks a second time at full
      // value, same as the user's explicit spec for Frost Swell's rewards.
      const powerScale = Number.isFinite(opts?.powerScale) ? opts.powerScale : 1;
      const roll = calculateDamage(attacker, target, ability);

      const basePct = 80;
      const scaledPct = basePct * powerScale;
      const powerNote = powerScale !== 1 ? ` × ${Math.round(powerScale * 100)}% power` : '';

      // Whole hit reflavored as Fire/Elemental — a fire spell, not a physical
      // staff swing. Step 3.5 in applyTypedDamageModifiers (CombatLogic.js)
      // reads THIS caster's own runic_zone kindlingRite stacks and adds the
      // ongoing +20%/stack elemental buff on top, using whatever stack count
      // was active BEFORE this cast (the stack incremented by THIS cast,
      // below, only benefits casts/recasts after it — not retroactively).
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: scaledPct,
          skillLabel: `${ability?.name || 'Skill'} weapon damage (${basePct}%${powerNote})`,
          isCrit: roll.isCrit, critMult: roll.critMult,
          skillConversion: { physToElemPct: 100 },
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      // Stacks the zone's Kindling Rite mod, capped at 3. A Rune Channel
      // recast re-runs this whole apply() a second time, so it naturally
      // stacks TWICE in one action if the recast fires — per explicit
      // request, not something the engine needs to special-case.
      zone.mods = zone.mods || {};
      const stacksBefore = zone.mods.kindlingRiteStacks || 0;
      const stacksAfter = Math.min(3, stacksBefore + 1);
      zone.mods.kindlingRiteStacks = stacksAfter;
      zone.mods.kindlingRite = true; // legacy boolean — still read by the "active mod count" tint logic
      scene?._refreshRunicZoneSprite?.(attacker);

      const fireBuildup = Math.floor((ability?.buildupHint?.fire ?? 120) * powerScale);

      return {
        ...roll,
        physical, elemental, necrotic, amount,
        isMagic: true,
        element: 'fire',
        buildup: { fire: fireBuildup },
        log: `The runic zone ignites with flames! (Kindling Rite ${stacksAfter}/3 stacks)`,
      };
    },
    description: "Req zone. Deals 80% weapon damage as Fire, +120 Fire buildup. Modifies zone: stacks up to 3 times. Each stack: caster takes 80 Fire buildup/turn, caster deals +20% elemental damage. At max stacks: 240 Fire buildup/turn, +60% elemental damage."
  },

  'cone_of_blight': {
    id: "cone_of_blight",
    name: "Cone of Blight",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["staff"],
    requiredStat: "INT",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 7,
    cooldown: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "toxic", "aoe", "necrotic"],
    buildupHint: { toxic: 90 },
    // "Small cone": only the front rank (1,2,3) and mid rank (4,5) are valid
    // primary targets — the back rank has nothing further behind it to cone
    // into. See aoeResolver.js's "smallCone" shape for the exact per-slot
    // splash mapping (front rank fans into mid rank; mid rank fans into
    // back rank). Enemy slots share the identical row/slot-ID layout as
    // allies (just X-mirrored), so this needs no per-side translation.
    targetSlots: [1, 2, 3, 4, 5],
    aoe: { shape: 'smallCone' },
    apply: (attacker, target, scene, opts = {}) => {
      const ability = SKILLS?.cone_of_blight;
      const powerScale = Number.isFinite(opts?.powerScale) ? opts.powerScale : 1;
      const roll = calculateDamage(attacker, target, ability);

      const basePct = 90;
      const scaledPct = basePct * powerScale;
      const powerNote = powerScale !== 1 ? ` × ${Math.round(powerScale * 100)}% power` : '';

      // Whole hit reflavored as Necrotic — the old legacy version used
      // isMagic:true for a necrotic-typed hit, which can only ever mean
      // "elemental" (isMagic's one real limitation — see
      // project_gear_damage_audit memory), so it was silently mitigated by
      // the target's Elemental Resist instead of Necrotic Resist.
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: scaledPct,
          skillLabel: `${ability?.name || 'Skill'} weapon damage (${basePct}%${powerNote})`,
          isCrit: roll.isCrit, critMult: roll.critMult,
          skillConversion: { physToNecroPct: 100, elemToNecroPct: 100 },
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      const toxicBuildup = Math.floor((ability?.buildupHint?.toxic ?? 90) * powerScale);

      const SPLASH_SCALE = 0.70;
      const splash = resolveAOESplash(scene, target, ability.aoe).map(tgt => {
        const spPhysical = Math.floor(physical * SPLASH_SCALE);
        const spElemental = Math.floor(elemental * SPLASH_SCALE);
        const spNecrotic = Math.floor(necrotic * SPLASH_SCALE);
        return {
          target: tgt, amount: Math.max(1, spPhysical + spElemental + spNecrotic),
          physical: spPhysical, elemental: spElemental, necrotic: spNecrotic,
          buildup: { toxic: Math.floor(toxicBuildup * SPLASH_SCALE) },
          tags: ability?.tags,
        };
      });

      return {
        ...roll,
        physical, elemental, necrotic, amount,
        isMagic: true,
        buildup: { toxic: toxicBuildup },
        splash: splash.length ? splash : undefined,
      };
    },
    description: "Deals 90% weapon damage as Necrotic + 90 Toxic buildup to a target in the front two ranks. Also hits the 1-2 slots directly behind it in a small cone, for 70% damage/buildup."
  },

  'ward_weave': {
    id: "ward_weave",
    name: "Ward Weave",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["staff"],
    requiredStat: "CON",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 4,
    cooldown: 4,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["magic", "spell", "defensive", "zone"],
    // Zone-toggle utility cast, not a repeatable damage/buildup spell — see
    // conclave_circle's noRecast comment.
    noRecast: true,
    apply: (attacker, target, scene) => {
      const zone = getRunicZone(attacker);
      if (!zone) return { amount: 0, log: "Ward Weave requires an active runic zone." };
      zone.mods = zone.mods || {};
      zone.mods.wardWeave = true;
      // Implemented in CombatScene.js: _startTurnStatusEffects drains 3
      // Initiative/turn (replacing the zone's normal MP restore) while this
      // mod is active, and _processGuardStatusEffects grants a flat 15%
      // damage-reduction guard on every hit taken.
      scene?._refreshRunicZoneSprite?.(attacker);
      return { amount: 0, log: "Protective wards weave through the runic circle!" };
    },
    description: "Req zone. Modifies zone: drains 3 initiative/turn (replaces MP gain), caster takes 15% less damage while in zone."
  },

  'silence_crescent': {
    id: "silence_crescent",
    name: "Silence Crescent",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["staff"],
    requiredStat: "WIS",
    requiredValue: 13,
    actionCost: "major",
    mpCost: 6,
    cooldown: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "disorient", "aoe"],
    buildupHint: { disorient: 80 },
    // Fixed "back crescent" — always the back rank + mid rank {8,4,5,6},
    // regardless of which of those four is targeted. Same mechanic as
    // Sacred Shockwave's diamond, just a different fixed group — see
    // aoeResolver.js's "backCrescent" shape.
    targetSlots: [8, 4, 5, 6],
    aoe: { shape: 'backCrescent' },
    // Crossing Disorient T2 gives the target -20% damage dealt for 1 turn —
    // declared here so EVERY enemy hit (primary AND each splash target)
    // independently checks their own tier-cross via the generic
    // rewardIfTierCross engine, instead of the old version which only ever
    // checked the primary target's own crossing. Also fixes a real bug: the
    // old debuff wrote a `DamageDealt` status mod that was never read
    // anywhere in the codebase — this now routes through the actual working
    // AttackPower mechanic (see damageDealtDownPct in
    // CombatScene.js's _applyRewardDebuff).
    rewardIfTierCross: [{ family: "disorient", tier: 2, debuff: { damageDealtDownPct: 20, turns: 1 } }],
    apply: (attacker, target, scene, opts = {}) => {
      const ability = SKILLS?.silence_crescent;
      const powerScale = Number.isFinite(opts?.powerScale) ? opts.powerScale : 1;
      const roll = calculateDamage(attacker, target, ability);

      const basePct = 85;
      const scaledPct = basePct * powerScale;
      const powerNote = powerScale !== 1 ? ` × ${Math.round(powerScale * 100)}% power` : '';

      // No skillConversion — a disorient/support spell, not tied to a
      // specific elemental type, so it keeps whatever physical/elemental
      // split the weapon naturally rolls (same pattern as Sword Flourish).
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: scaledPct,
          skillLabel: `${ability?.name || 'Skill'} weapon damage (${basePct}%${powerNote})`,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      const disorientBuildup = Math.floor((ability?.buildupHint?.disorient ?? 80) * powerScale);

      const SPLASH_SCALE = 0.60;
      const splash = resolveAOESplash(scene, target, ability.aoe).map(tgt => {
        const spPhysical = Math.floor(physical * SPLASH_SCALE);
        const spElemental = Math.floor(elemental * SPLASH_SCALE);
        const spNecrotic = Math.floor(necrotic * SPLASH_SCALE);
        return {
          target: tgt, amount: Math.max(1, spPhysical + spElemental + spNecrotic),
          physical: spPhysical, elemental: spElemental, necrotic: spNecrotic,
          buildup: { disorient: Math.floor(disorientBuildup * SPLASH_SCALE) },
          tags: ability?.tags,
          rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
        };
      });

      return {
        ...roll,
        physical, elemental, necrotic, amount,
        isMagic: true,
        buildup: { disorient: disorientBuildup },
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
        splash: splash.length ? splash : undefined,
      };
    },
    description: "Deals 85% weapon damage + 80 Disorient buildup to a target in the back crescent (slots 8,4,5,6 — always hits the other three regardless of which is targeted, at 60% damage/buildup). Any enemy hit whose Disorient crosses T2 takes -20% damage dealt for 1 turn."
  },

  'rune_channel': {
    id: "rune_channel",
    name: "Rune Channel",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["staff"],
    requiredStat: "INT",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 6,
    cooldown: 5,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["magic", "spell", "zone"],
    // Zone-toggle utility cast, not a repeatable damage/buildup spell — and
    // critically, without this flag Rune Channel could recast ITSELF the
    // instant it's first cast, since its own apply() (below) turns
    // mods.runeChannel on before the recast-eligibility check later in
    // _applyAbilityToTarget ever runs — a same-cast bootstrapping paradox
    // the user caught in testing. See conclave_circle's noRecast comment.
    noRecast: true,
    apply: (attacker, target, scene) => {
      const zone = getRunicZone(attacker);
      if (!zone) return { amount: 0, log: "Rune Channel requires an active runic zone." };
      zone.mods = zone.mods || {};
      zone.mods.runeChannel = true;
      // Implemented in CombatScene.js's _applyAbilityToTarget:
      // - spells (tags includes 'spell') have a 25% chance to fully RECAST
      //   themselves at 60% power (damage/buildup only — rewardIfTierCross
      //   rewards like Frost Swell's Initiative steal still grant full
      //   value; MP/cooldown/action cost are untouched, it's a free proc).
      //   Capped at one recast per original cast — a recast can't itself
      //   trigger another rune channel recast.
      // - every cast OR recast, the caster takes 80 lightning buildup then 1
      //   lightning damage, unmitigated — that 1 damage can itself trigger
      //   Lightning Jolt on the caster if they're sufficiently
      //   Zapped/Shocked from their own accumulated buildup.
      // - a skill's own hit-repeat (repeatChance) does NOT re-trigger any of
      //   this — only a genuine recast (or the original cast) does.
      scene?._refreshRunicZoneSprite?.(attacker);
      return { amount: 0, log: "Lightning crackles through the runes!" };
    },
    description: "Req zone. Modifies zone: spells have a 25% chance to fully recast at 60% power (tier-cross rewards still grant full value). Every cast or recast, the caster takes 80 lightning buildup and 1 lightning damage — which can itself trigger Lightning Jolt if the caster is sufficiently charged."
  },

  'ward_focus': {
    id: "ward_focus",
    name: "Ward Focus",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["staff"],
    requiredStat: "WIS",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 0,
    cooldown: 3,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["support", "mana"],
    apply: (attacker) => {
      return {
        amount: 0,
        mpGain: 3,
        // permanent (not turns:1) — persists until actually consumed by the
        // next damaging hit, however many turns away that is, instead of a
        // fixed 1-turn window that could expire unused. onHit:{} +
        // nextHitOnly:true piggybacks on the existing attacker-side onHit
        // consumption mechanic (CombatScene.js's "Attacker-side onHit procs"
        // block) purely for its "remove after next damage-dealing hit"
        // behavior — Accuracy itself is a flat stat (not a percentage; see
        // getEffectiveDerived's 100-baseline hit-chance formula), read
        // generically via the mods field the whole time it's active.
        statusEffects: [{
          id: 'ward_focus_accuracy', permanent: true,
          mods: { Accuracy: 50 }, onHit: {}, nextHitOnly: true,
        }],
        log: `${attacker?.name ?? 'Mage'} focuses, restoring 3 MP!`,
      };
    },
    description: "Bonus action, 0 MP. Restore 3 MP and gain +50 Accuracy, consumed on your next damaging hit (persists until then, not just for 1 turn)."
  },

  // -------- Payoff --------

  'flame_pillar': {
    id: "flame_pillar",
    name: "Flame Pillar",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["staff"],
    requiredStat: "INT",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 10,
    cooldown: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "fire", "aoe", "elemental"],
    requiresWeakness: { family: "fire", tierAtLeast: 2 },
    buildupHint: { fire: 60 },
    // Diamond AOE — fixed centre-mass slots {2,4,5,7}, same shape (and same
    // targetSlots restriction) Sacred Shockwave uses. The primary target
    // must be one of the four diamond slots — otherwise the "diamond" would
    // just be a bonus AOE tacked onto an unrelated primary target instead of
    // the primary target always being part of the same four-enemy formation
    // it hits.
    targetSlots: [2, 4, 5, 7],
    aoe: { shape: 'diamond' },
    apply: (attacker, target, scene, opts = {}) => {
      const ability = SKILLS?.flame_pillar;
      const powerScale = Number.isFinite(opts?.powerScale) ? opts.powerScale : 1;
      const roll = calculateDamage(attacker, target, ability);

      const basePct = 140;
      const scaledPct = basePct * powerScale;
      const powerNote = powerScale !== 1 ? ` × ${Math.round(powerScale * 100)}% power` : '';

      // Whole hit reflavored as Fire/Elemental — a fire spell, not a
      // physical staff swing (same pattern as Frost Swell/Kindling Rite).
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: scaledPct,
          skillLabel: `${ability?.name || 'Skill'} weapon damage (${basePct}%${powerNote})`,
          isCrit: roll.isCrit, critMult: roll.critMult,
          skillConversion: { physToElemPct: 100 },
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      const fireBuildup = Math.floor((ability?.buildupHint?.fire ?? 60) * powerScale);

      // Splash buildup now scales with the 80% damage split (previously
      // flat — every other AOE skill this pass scales buildup proportionally
      // with the damage share, this brings Flame Pillar in line).
      const SPLASH_SCALE = 0.80;
      const splash = resolveAOESplash(scene, target, ability.aoe).map(tgt => {
        const spPhysical = Math.floor(physical * SPLASH_SCALE);
        const spElemental = Math.floor(elemental * SPLASH_SCALE);
        const spNecrotic = Math.floor(necrotic * SPLASH_SCALE);
        return {
          target: tgt, amount: Math.max(1, spPhysical + spElemental + spNecrotic),
          physical: spPhysical, elemental: spElemental, necrotic: spNecrotic,
          buildup: { fire: Math.floor(fireBuildup * SPLASH_SCALE) },
          tags: ability?.tags,
        };
      });

      return {
        ...roll,
        physical, elemental, necrotic, amount,
        isMagic: true,
        element: 'fire',
        buildup: { fire: fireBuildup },
        splash: splash.length ? splash : undefined,
      };
    },
    description: "Requires the target to already be Ablaze (Fire T2). Deals 140% weapon damage as Fire + 60 Fire buildup, plus a diamond AOE (fixed slots 2,4,5,7) at 80% damage/buildup to whoever else stands in that formation."
  },

  'toxic_bloom': {
    id: "toxic_bloom",
    name: "Toxic Bloom",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["staff"],
    requiredStat: "INT",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 9,
    cooldown: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "toxic", "consume", "aoe", "necrotic"],
    requiresWeakness: { family: "toxic", tierAtLeast: 1 },
    apply: (attacker, target, scene, opts = {}) => {
      const ability = SKILLS?.toxic_bloom;
      const powerScale = Number.isFinite(opts?.powerScale) ? opts.powerScale : 1;
      const roll = calculateDamage(attacker, target, ability);

      const basePct = 110;
      const scaledPct = basePct * powerScale;
      const powerNote = powerScale !== 1 ? ` × ${Math.round(powerScale * 100)}% power` : '';

      // Whole hit reflavored as Necrotic — the old legacy version used
      // isMagic:true for a necrotic-typed hit, which can only ever mean
      // "elemental" (isMagic's one real limitation — see
      // project_gear_damage_audit memory), so it was silently mitigated by
      // Elemental Resist instead of Necrotic Resist.
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: scaledPct,
          skillLabel: `${ability?.name || 'Skill'} weapon damage (${basePct}%${powerNote})`,
          isCrit: roll.isCrit, critMult: roll.critMult,
          skillConversion: { physToNecroPct: 100, elemToNecroPct: 100 },
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      // Consumes only WHOLE 100-increments, capped at 400 — a target sitting
      // on 350 toxic only has 300 drained (3 clean increments), leaving the
      // leftover 50 behind rather than wastefully consuming it for no extra
      // tier benefit. (Several other weakness-consuming skills across
      // dagger/1h-sword/mace/staff likely have this same "consumes past the
      // last clean increment" issue in various forms — flagged for a
      // dedicated audit pass later, see project_weakness_consume_increments
      // memory; not fixed project-wide in this pass.)
      const currentToxic = target?.weakness?.meters?.toxic || 0;
      const consumed = Math.min(400, Math.floor(currentToxic / 100) * 100);
      if (target?.weakness?.meters != null) {
        target.weakness.meters.toxic = Math.max(0, currentToxic - consumed);
        target.weakness.tiers.toxic = weaknessTierFromMeter(target.weakness.meters.toxic);
      }

      // Proliferate half the consumed toxic to adjacent enemies as buildup
      // — a one-time spread at cast time, distinct from the ongoing debuff
      // below. Not powerScale-scaled: this is a real quantity actually
      // drained from the target, not a %-of-damage bonus.
      const adjacentSplash = resolveAOESplash(scene, target, { shape: 'adjacent' }).map(tgt => ({
        target: tgt, amount: 0, buildup: { toxic: Math.floor(consumed * 0.50) }, tags: ability?.tags,
      }));

      // Debuff, tiered by how much toxic was actually drained (per 100):
      // 1/2/3/4 HP healed to whoever hits this target, per hit, for 3 turns
      // — plus 10/15/20/25 Toxic buildup (also tiered) to the target AND
      // adjacent enemies on each of those hits. Uses the generic onHitBy
      // shape (see _processTargetHitRiders in CombatScene.js), so this now
      // correctly triggers on ANY hit the target takes — primary, AOE
      // splash, or a repeat — not just direct hits, and NOT on this cast's
      // own hit (the preHitRiderRefs snapshot excludes a status a skill
      // just applied on the same cast that created it). Registered in
      // StatusEffects.js as 'toxic_bloom_debuff' / display name "Toxic
      // Bloom" — no "rider" in anything user-facing.
      const tier = Math.min(4, Math.floor(consumed / 100));
      const tierBuildup = 5 + tier * 5; // tier 1→10, 2→15, 3→20, 4→25
      const statusEffects = tier > 0
        ? [{
          id: 'toxic_bloom_debuff', turns: 3,
          onHitBy: { healAttacker: tier, buildup: { toxic: tierBuildup }, buildupAdjacent: { toxic: tierBuildup } },
        }]
        : undefined;

      return {
        ...roll,
        physical, elemental, necrotic, amount,
        isMagic: true,
        statusEffects,
        splash: adjacentSplash.length ? adjacentSplash : undefined,
        log: consumed > 0 ? `Toxic Bloom consumes ${consumed} toxic and spreads it to adjacent enemies!` : undefined,
      };
    },
    description: "Deals 110% weapon damage as Necrotic. Consumes up to 400 Toxic buildup from the target, proliferating half of it to adjacent enemies. Based on toxic consumed (per 100, up to 4): applies a 3-turn debuff — whoever hits this target heals 1/2/3/4 HP per hit and deals 10/15/20/25 Toxic buildup to the target and adjacent enemies per hit."
  },

  'mana_fountain': {
    id: "mana_fountain",
    name: "Mana Fountain",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    requiredWeapon: ["staff"],
    requiredStat: "WIS",
    requiredValue: 13,
    actionCost: "bonus",
    mpCost: 0,
    cooldown: 3,
    requiresTarget: false,
    targetRequirement: "self",
    // No "spell"/"magic" tag — same pattern as Ward Focus — so this is
    // never eligible for Rune Channel's recast check (gated on tags
    // including 'spell') without needing an explicit noRecast flag; a
    // simple self-utility buff, not a real recast candidate.
    tags: ["support", "mana", "zone"],
    apply: (attacker) => {
      const zone = getRunicZone(attacker);
      if (!zone) return { amount: 0, log: "Mana Fountain requires an active runic zone." };
      zone.turns += 1;
      const maxMP = attacker?.maxMP ?? attacker?.derivedStats?.maxMP ?? 0;
      const mpGain = Math.max(1, Math.floor(maxMP * 0.20));
      return {
        amount: 0,
        mpGain,
        log: `${attacker?.name ?? 'Mage'} taps the zone — restores ${mpGain} MP and extends it by 1 turn!`,
      };
    },
    description: "Req zone. Bonus action, 0 MP. Extends zone +1 turn and restores 20% max MP."
  },

  'silencing_shockwave': {
    id: "silencing_shockwave",
    name: "Silencing Shockwave",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["staff"],
    requiredStat: "WIS",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 9,
    cooldown: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "disorient", "consume"],
    requiresWeakness: { family: "disorient", tierAtLeast: 2 },
    apply: (attacker, target, scene, opts = {}) => {
      const ability = SKILLS?.silencing_shockwave;
      const powerScale = Number.isFinite(opts?.powerScale) ? opts.powerScale : 1;
      const roll = calculateDamage(attacker, target, ability);

      // Consumes up to 400 current Disorient for bonus damage (excess
      // beyond 400 stays on the target, not wasted — same "don't consume
      // past what's actually used" rule as Toxic Bloom's clean-increment
      // fix): +2% per 10 consumed, capped at +80% (400/10×2), folded
      // directly into skillPct (Category A, additive with the base 130% —
      // see feedback_additive_damage_bonuses) rather than a separate
      // post-hoc add. This does NOT have its own repeat mechanic — no
      // repeatChance here, per explicit design: it's only ever repeated via
      // a Rune Channel recast, which re-runs this WHOLE function fresh, so
      // each cast independently reads whatever's CURRENTLY on the target at
      // that moment. If the original cast already consumed the target's
      // Disorient down below 400, the recast's own bonusPct naturally comes
      // out lower (or 0) instead of inheriting the original's bonus — "the
      // second cast is inherently weaker," by design, not a bug to work
      // around.
      const currentDisorient = target?.weakness?.meters?.disorient || 0;
      const consumed = Math.min(400, currentDisorient);
      const bonusPct = (consumed / 10) * 2;
      const basePct = 130;
      const scaledPct = (basePct + bonusPct) * powerScale;
      const powerNote = powerScale !== 1 ? ` × ${Math.round(powerScale * 100)}% power` : '';

      // Necrotic reflavor if the target is critically low on mana (below
      // 20% max MP) — otherwise keeps the weapon's own natural physical/
      // elemental split (no forced conversion), same as Silence Crescent.
      const targetMaxMP = target?.maxMP ?? target?.derivedStats?.maxMP ?? 0;
      const lowMana = targetMaxMP > 0 && (target?.currentMP || 0) < targetMaxMP * 0.20;

      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: scaledPct,
          skillLabel: `${ability?.name || 'Skill'} weapon damage (${basePct}%${bonusPct ? ` + ${bonusPct.toFixed(1)}% Disorient consumed` : ''}${powerNote})`,
          isCrit: roll.isCrit, critMult: roll.critMult,
          skillConversion: lowMana ? { physToNecroPct: 100, elemToNecroPct: 100 } : undefined,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      if (target?.weakness?.meters != null) {
        target.weakness.meters.disorient = Math.max(0, currentDisorient - consumed);
        target.weakness.tiers.disorient = weaknessTierFromMeter(target.weakness.meters.disorient);
      }

      return {
        ...roll,
        physical, elemental, necrotic, amount,
        isMagic: true,
        log: consumed > 0 ? `Silencing Shockwave consumes ${consumed} disorient for bonus damage!` : undefined,
      };
    },
    description: "Requires Disorient T2 (Silenced). Deals 130% weapon damage — converts to Necrotic if the target is below 20% max MP. Consumes up to 400 Disorient buildup for bonus damage (+2% per 10 consumed, up to +80%); any excess beyond 400 is left on the target."
  },

  'curse_suppression': {
    id: "curse_suppression",
    name: "Curse Suppression",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    requiredWeapon: ["staff"],
    requiredStat: "CON",
    requiredValue: 14,
    actionCost: "bonus",
    mpCost: 6,
    cooldown: 5,
    requiresTarget: true,
    // "ally" targeting already includes the caster's own slot (allySlots
    // covers everyone on your side, self included — confirmed in
    // _enterTargetingMode) — no separate self/ally distinction needed here.
    targetRequirement: "ally",
    tags: ["support", "cleanse", "defensive"],
    requiresWeakness: { family: "curse", tierAtLeast: 1 },
    apply: (attacker, target) => {
      const currentCurse = target?.weakness?.meters?.curse || 0;
      const curseRemoved = Math.min(400, currentCurse);
      // +1 Resilience per 10 curse removed (up to +40 at the 400 cap) — a
      // flat reduction to ALL incoming weakness buildup, same real stat WIS
      // derives permanently (see CharacterBuilder.js), just granted
      // temporarily here via mods.Resilience (now summed by
      // _sumStatusEffectMods alongside the character's own permanent
      // value — see CombatLogic.js). Replaces the old BuildupReceived %
      // mod entirely, per explicit request.
      const resilienceGain = Math.floor(curseRemoved / 10);
      if (target?.weakness?.meters != null) {
        target.weakness.meters.curse = Math.max(0, currentCurse - curseRemoved);
        target.weakness.tiers.curse = weaknessTierFromMeter(target.weakness.meters.curse);
      }
      const statusEffects = resilienceGain > 0
        ? [{ id: 'curse_suppression_ward', turns: 3, mods: { Resilience: resilienceGain } }]
        : undefined;
      return {
        amount: 0,
        isHeal: false,
        statusEffects,
        log: `${curseRemoved} curse suppressed — ${target?.name ?? 'ally'} gains +${resilienceGain} Resilience!`,
      };
    },
    description: "Bonus action. Requires the target (self or ally) to have Curse T1+. Removes up to 400 Curse buildup, granting +1 Resilience per 10 removed (up to +40) for 3 turns."
  },

  'arcane_avalanche': {
    id: "arcane_avalanche",
    name: "Arcane Avalanche",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["staff"],
    requiredStat: "WIS",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 10,
    cooldown: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "aoe"],
    // Fixed front-rank entry — the player must click one of the three front
    // slots, but ALL THREE fire regardless of which specific one was
    // clicked (same "fixed formation, restricted click" pattern Sacred
    // Shockwave/Flame Pillar use for their diamond).
    targetSlots: [1, 2, 3],
    // Declarative cascade graph — see _resolvePenetrationChain
    // (CombatScene.js) for the full mechanic. Three lines, fired in THIS
    // exact order (a slot hit by more than one line needs its HP tracked
    // cumulatively across them):
    //   Line 1 (front-bottom): 1 -> splits (5,6) -> 5's own overflow -> 6
    //   Line 2 (front-mid):    2 -> splits (4,5) -> 4+5's combined overflow -> 7
    //   Line 3 (front-top):    3 -> splits (4,8) -> 4's own overflow -> 8
    penetrationChain: {
      lines: [
        { entry: 1, splitTo: [5, 6], overflow: { from: 5, to: 6 } },
        { entry: 2, splitTo: [4, 5], overflow: { from: [4, 5], to: 7 } },
        { entry: 3, splitTo: [4, 8], overflow: { from: 4, to: 8 } },
      ],
    },
    apply: (attacker, target, scene, opts = {}) => {
      const ability = SKILLS?.arcane_avalanche;
      const powerScale = Number.isFinite(opts?.powerScale) ? opts.powerScale : 1;
      const roll = calculateDamage(attacker, target, ability);

      const basePct = 100;
      const scaledPct = basePct * powerScale;
      const powerNote = powerScale !== 1 ? ` × ${Math.round(powerScale * 100)}% power` : '';

      // No skillConversion — "arcane" damage keeps the weapon's own natural
      // physical/elemental split, same as Silence Crescent/Arc Echo's
      // pre-conversion pattern. Gear conversion + gear% and Lightning Jolt
      // are NOT applied here — they happen independently PER HIT inside
      // _resolvePenetrationChain, since every step of the cascade (each
      // front entry, each split half, each overflow) is its own separate
      // instance, same as any other splash gets elsewhere in this file.
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: scaledPct,
          skillLabel: `${ability?.name || 'Skill'} weapon damage (${basePct}%${powerNote})`,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );

      // amount/physical/elemental/necrotic stay at 0 — this is deliberately
      // NOT a direct hit on `target`. Every real hit (all three front-rank
      // entries and everything they cascade into) is dealt entirely by
      // _resolvePenetrationChain, triggered by ability.penetrationChain +
      // _penetrationBreakdown below (see the "Penetration chain" hook in
      // _applyAbilityToTarget).
      return {
        ...roll,
        amount: 0, physical: 0, elemental: 0, necrotic: 0,
        isMagic: true,
        _penetrationBreakdown: { physical, elemental, necrotic },
      };
    },
    description: "Stampedes the front rank in 3 lines (slots 1/2/3), each fanning out 2 ranks back. Deals 100% weapon damage to each occupied front slot. Any overkill — or the WHOLE hit, if the slot is empty or the target is at Fire/Cold/Lightning T2+ — splits 50/50 into that line's two slots behind it, cascading one rank further the same way."
  },

  // Moved out of the dead Staff surplus block (below) — kept as-is for now,
  // still on the legacy scalar damage path, not yet brought up to v3.23.
  'restoration_light': {
    id: "restoration_light",
    name: "Restoration Light",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    requiredWeapon: ["staff"],
    requiredStat: "WIS",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "ally",
    // "spell" tag added — this is the actual reason it couldn't recast from
    // Rune Channel before; the recast check gates on tags.includes('spell').
    tags: ["magic", "spell", "holy", "heal", "regen"],
    cooldown: 3,
    apply: (attacker, target, scene, opts = {}) => {
      const ability = SKILLS?.restoration_light;
      const powerScale = Number.isFinite(opts?.powerScale) ? opts.powerScale : 1;
      // First skill on the new heal pipeline — calculateHealRoll (weapon die
      // only, no STR/WIS, per explicit design decision) + applyHealModifiers
      // (skillPct -> HealingPower buff -> crit). Proficiency and
      // target.healingReceivedBonus still apply afterward, same as before,
      // in the engine's own heal-application code — see project memory for
      // the full pipeline writeup.
      const roll = calculateHealRoll(attacker, ability);

      // 150% is a first-guess placeholder, not a tuned number — this
      // replaces a flat WIS-based formula with a weapon-die-based one for
      // the first time, and the actual weapon damage tables aren't visible
      // from here. Needs a live-testing pass to land on the right %.
      const basePct = 150;
      const scaledPct = basePct * powerScale;
      const powerNote = powerScale !== 1 ? ` × ${Math.round(powerScale * 100)}% power` : '';

      const healAmount = Math.max(1, applyHealModifiers(roll.amount, attacker, {
        ability, skillPct: scaledPct,
        skillLabel: `${ability?.name || 'Skill'} healing (${basePct}%${powerNote})`,
        isCrit: roll.isCrit, critMult: roll.critMult,
      }));

      // Both the instant heal and the Regen tick scale with power; the
      // Regen's DURATION does not (matches every other recastable skill
      // this pass — only magnitude scales, not turns). Regen's own tick is
      // NOT crit-affected — only the instant portion crits.
      const regenTick = Math.max(1, Math.floor(3 * powerScale));

      return {
        amount: healAmount,
        isHeal: true,
        isCrit: roll.isCrit,
        statusEffects: [{ id: "regen", turns: 2, tickHeal: regenTick }],
      };
    },
    description: "Heals 150% of your weapon roll and grants Regen (2 turns, 3 HP/turn)."
  },

  'curse_cinders': {
    id: "curse_cinders",
    name: "Curse of Cinders",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["staff"],
    requiredStat: "INT",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 1,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "curse", "fire"],
    cooldown: 2,
    requiresWeakness: { family: "curse", tierAtLeast: 1 },
    buildupHint: { curse: 50 },
    apply: (attacker, target) => {
      const ability = SKILLS?.curse_cinders;
      const roll = calculateDamage(attacker, target, ability);

      // Whole hit reflavored as Fire/Elemental regardless of the weapon's own
      // physical/elemental split — a curse-fire bolt, not a physical staff swing.
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 100, skillLabel: `${ability?.name || 'Skill'} weapon damage (100%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
          skillConversion: { physToElemPct: 100 },
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      // Permanent rider (Curse T1+ gate enforced by requiresWeakness above):
      // overrides the target's own Fire-T1 "acting loses Fire buildup"
      // penalty into a GAIN instead — see the per-action trigger in
      // CombatScene.js. Only added once; recasting on an already-cursed
      // target just deals damage again.
      target.statusEffects = target.statusEffects || [];
      const alreadyCindered = target.statusEffects.some(se => se?.id === 'curse_cinders');
      const statusEffects = alreadyCindered ? undefined : [{
        id: "curse_cinders", name: "Curse of Cinders", permanent: true,
        onAct: { fireBuildupOverride: true },
      }];

      return {
        ...roll,
        physical, elemental, necrotic, amount,
        isMagic: true,
        element: 'fire',
        buildup: { curse: ability?.buildupHint?.curse ?? 50 },
        statusEffects,
      };
    },
    description: "Deals 100% weapon damage as Fire, +50 Curse buildup. Requires target at least Hexed. Applies a permanent rider: while cursed, acting gains Fire buildup instead of losing it, scaling with Curse intensity — works regardless of the target's own Fire tier."
  },

  // ===============================
  // SURPLUS - v3.21 Staff (awaiting rework as class/high-req skills)
  // ===============================
  /*
  'sigil_mark': {
    id: "sigil_mark",
    name: "Sigil Mark",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["staff"],
    requiredStat: "INT",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "expose"],
    emitTagsOnUse: ["spell"],
    buildupHint: { expose: 50 },
    apply: (attacker, target) => {
      const ability = SKILLS?.sigil_mark;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        isMagic: true,
        skipGearMultiplier: true,
      }));

      const exposeTier = target?.weakness?.tiers?.expose || 0;
      const meter = target?.weakness?.meters?.expose || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      let buildup = ability?.buildupHint?.expose ?? 50;
      if (exposeTier >= 1) {
        amount = Math.floor(amount * (1 + 0.08 * exposeTier));
        buildup += Math.max(5, Math.floor(6 * intensity));
      }

      return {
        ...roll,
        amount,
        isMagic: true,
        buildup: { expose: buildup },
      };
    },
    description: "Etch a binding sigil that pries at defenses and builds Expose."
  },

  'hex_bind': {
    id: "hex_bind",
    name: "Hex Bind",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["staff"],
    requiredStat: "INT",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "curse"],
    buildupHint: { curse: 70 },
    rewardIfWeak: { family: "expose", tierAtLeast: 1, buff: { addBuildup: { curse: 25 } } },
    apply: (attacker, target) => {
      const ability = SKILLS?.hex_bind;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        isMagic: true,
        skipGearMultiplier: true,
      }));

      const exposeTier = target?.weakness?.tiers?.expose || 0;
      let buildup = ability?.buildupHint?.curse ?? 70;
      if (exposeTier >= 1) {
        amount = Math.floor(amount * (1 + 0.1 * exposeTier));
        buildup += ability?.rewardIfWeak?.buff?.addBuildup?.curse ?? 25;
      }

      return {
        ...roll,
        amount,
        isMagic: true,
        buildup: { curse: buildup },
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
      };
    },
    description: "A constricting hex that lingers; Exposed targets suffer stronger binding."
  },

  'frost_swell': {
    id: "frost_swell",
    name: "Frost Swell",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["staff"],
    requiredStat: "INT",
    requiredValue: 13,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "cold"],
    buildupHint: { cold: 65 },
    rewardIfTierCross: [{ family: "cold", tier: 1, debuff: { speedDownPct: 10, turns: 1 } }],
    apply: (attacker, target) => {
      const ability = SKILLS?.frost_swell;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: 'cold',
        isMagic: true,
        skipGearMultiplier: true,
      }));

      const coldTier = target?.weakness?.tiers?.cold || 0;
      const meter = target?.weakness?.meters?.cold || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      let buildup = ability?.buildupHint?.cold ?? 65;
      if (coldTier >= 1) {
        amount = Math.floor(amount * (1 + 0.12 * coldTier));
        buildup += Math.max(5, Math.floor(6 * intensity));
      }

      return {
        ...roll,
        amount,
        isMagic: true,
        element: 'cold',
        buildup: { cold: buildup },
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
      };
    },
    description: "A wave of chill; crossing Cold T1 briefly slows the target."
  },

  'galvanic_touch': {
    id: "galvanic_touch",
    name: "Galvanic Touch",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["staff"],
    requiredStat: "INT",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "lightning"],
    buildupHint: { lightning: 55 },
    rewardIfWeak: { family: "lightning", tierAtLeast: 1, buff: { chanceExtraHitPct: 25 } },
    apply: (attacker, target) => {
      const ability = SKILLS?.galvanic_touch;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: 'lightning',
        isMagic: true,
        skipGearMultiplier: true,
      }));

      const lightningTier = target?.weakness?.tiers?.lightning || 0;
      let buildup = ability?.buildupHint?.lightning ?? 55;
      if (lightningTier >= 1) {
        amount = Math.floor(amount * (1 + 0.12 * lightningTier));
        buildup += 10 * lightningTier;
      }

      let extraDamage = 0;
      if (lightningTier >= (ability?.rewardIfWeak?.tierAtLeast ?? 1)) {
        const pct = ability?.rewardIfWeak?.buff?.chanceExtraHitPct ?? 25;
        extraDamage = Math.max(1, Math.floor(amount * (pct / 100)));
        amount += extraDamage;
      }

      return {
        ...roll,
        amount,
        isMagic: true,
        element: 'lightning',
        buildup: { lightning: buildup },
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
        extraHits: extraDamage ? [{ amount: extraDamage, element: 'lightning', isMagic: true, repeat: true }] : undefined,
      };
    },
    description: "Channel an arc through the focus; Shocked targets may suffer an extra jolt."
  },

  'miasma_trace': {
    id: "miasma_trace",
    name: "Miasma Trace",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["staff"],
    requiredStat: "INT",
    requiredValue: 13,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "toxic"],
    buildupHint: { toxic: 60 },
    rewardIfWeak: { family: "expose", tierAtLeast: 1, buff: { addBuildup: { toxic: 20 } } },
    apply: (attacker, target) => {
      const ability = SKILLS?.miasma_trace;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        isMagic: true,
        skipGearMultiplier: true,
      }));

      const exposeTier = target?.weakness?.tiers?.expose || 0;
      let buildup = ability?.buildupHint?.toxic ?? 60;
      if (exposeTier >= 1) {
        amount = Math.floor(amount * (1 + 0.1 * exposeTier));
        buildup += ability?.rewardIfWeak?.buff?.addBuildup?.toxic ?? 20;
      }

      return {
        ...roll,
        amount,
        isMagic: true,
        buildup: { toxic: buildup },
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
      };
    },
    description: "Lace the air with poison threads; Exposed foes accumulate toxin faster."
  },

  'rune_diffusion': {
    id: "rune_diffusion",
    name: "Rune Diffusion",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["staff"],
    requiredStat: "INT",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "expose", "proliferate", "aoe"],
    aoe: { shape: "column", scale: 1 },
    buildupHint: { expose: 40 },
    proliferateWeakness: { families: ["expose"], to: "column", ratio: 0.5, maxTargets: 1 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.rune_diffusion;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        isMagic: true,
        skipGearMultiplier: true,
      }));

      const baseBuildup = ability?.buildupHint?.expose ?? 40;
      const spreadMeta = [];
      const splash = [];

      if (scene && target && typeof scene._getUnitColumn === 'function' && typeof scene._getColumnBySlotId === 'function') {
        const column = scene._getUnitColumn(target);
        if (column) {
          const sideSlots = target?.isEnemy ? scene.enemySlots : scene.allySlots;
          const neighbors = sideSlots
            ?.filter(slot => slot?.char && slot.char !== target && slot.char.status !== 'incapacitated' && scene._getColumnBySlotId(slot.slotId) === column)
            .map(slot => slot.char) || [];
          const splashAmount = Math.max(1, Math.floor(amount * 0.75));
          const splashBuildup = Math.max(1, Math.floor(baseBuildup * 0.7));
          neighbors.forEach((char, idx) => {
            splash.push({
              target: char,
              amount: splashAmount,
              buildup: { expose: splashBuildup },
              tags: ability?.tags,
            });

            if (idx < (ability?.proliferateWeakness?.maxTargets ?? 1)) {
              const ratio = ability?.proliferateWeakness?.ratio ?? 0.5;
              const sourceMeter = target?.weakness?.meters?.expose || 0;
              const transfer = Math.max(0, Math.floor(sourceMeter * ratio));
              if (transfer > 0) {
                char.weakness = char.weakness || { meters: {}, tiers: {} };
                char.weakness.meters = char.weakness.meters || {};
                char.weakness.tiers = char.weakness.tiers || {};
                char.weakness.meters.expose = (char.weakness.meters.expose || 0) + transfer;
                char.weakness.tiers.expose = weaknessTierFromMeter(char.weakness.meters.expose);
                spreadMeta.push({ targetId: char.id || char.name, family: 'expose', amount: transfer });
              }
            }
          });
        }
      }

      return {
        ...roll,
        amount,
        isMagic: true,
        buildup: { expose: baseBuildup },
        splash: splash.length ? splash : undefined,
        proliferatedWeakness: spreadMeta.length ? spreadMeta : undefined,
      };
    },
    description: "Unravel a glyph to carry Expose down the rank."
  },

  'ward_focus': {
    id: "ward_focus",
    name: "Ward Focus",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["staff"],
    requiredStat: "WIS",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 0,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["support", "mp", "stance"],
    statusEffects: [{ id: "ward_focus", turns: 1, mpRestoreFlat: 3, nextSpellAccPct: 10 }],
    apply: (attacker) => {
      const ability = SKILLS?.ward_focus;
      const statusEffects = Array.isArray(ability?.statusEffects)
        ? ability.statusEffects.map(effect => ({ ...effect }))
        : [];

      return {
        amount: 0,
        statusEffects,
      };
    },
    description: "Reinforce the flow-restore MP and steady your next spell."
  },

  // -------- Payoff (6) --------
  'curse_snap_staff': {
    id: "curse_snap_staff",
    name: "Curse Snap",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["staff"],
    requiredStat: "INT",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "curse", "amplify"],
    requiresWeakness: { family: "curse", tierAtLeast: 1 },
    apply: (attacker, target) => {
      const ability = SKILLS?.curse_snap_staff;
      const roll = calculateDamage(attacker, target, ability);
      const intBonus = Math.floor((attacker?.totalStats?.INT || 0) / 3);
      const base = roll.amount + intBonus;
      let amount = Math.max(1, applyDamageModifiers(base, attacker, target, {
        ability,
        tags: ability?.tags,
        element: 'curse',
        isMagic: true,
        skipGearMultiplier: true,
      }));

      const meter = target?.weakness?.meters?.curse || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      amount = Math.floor(amount * (1 + Math.max(0, intensity - 1) * 0.08));

      const status = { id: 'curse_snap', turns: 1, doubleCurseTicks: true };

      return {
        ...roll,
        amount,
        isMagic: true,
        statusEffects: [status],
      };
    },
    description: "For one turn, all Curse effects on the target tick twice (amplify only; no consume)."
  },

  'ice_fracture_staff': {
    id: "ice_fracture_staff",
    name: "Ice Fracture",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["staff"],
    requiredStat: "INT",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "cold", "amplify"],
    requiresWeakness: { family: "cold", tierAtLeast: 1 },
    rewardIfWeak: { family: "cold", tierAtLeast: 2, buff: { armorDownPct: 14, turns: 2 } },
    apply: (attacker, target) => {
      const ability = SKILLS?.ice_fracture_staff;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: 'cold',
        isMagic: true,
        skipGearMultiplier: true,
      }));

      const meter = target?.weakness?.meters?.cold || 0;
      const tier = target?.weakness?.tiers?.cold || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      if (tier >= 1) {
        amount = Math.floor(amount * (1 + 0.15 * tier));
      }
      if (intensity > 1) {
        amount = Math.floor(amount * (1 + Math.max(0, intensity - 1) * 0.2));
      }

      return {
        ...roll,
        amount,
        isMagic: true,
        element: 'cold',
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
      };
    },
    description: "Shatter brittle frost-higher Cold tiers crack armor more."
  },

  'venom_bloom_staff': {
    id: "venom_bloom_staff",
    name: "Venom Bloom",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["staff"],
    requiredStat: "INT",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "toxic", "consume"],
    requiresWeakness: { family: "toxic", tierAtLeast: 1 },
    consumeWeakness: ["toxic"],
    rewardIfWeak: { family: "toxic", tierAtLeast: 2, buff: { extraRapidTicks: 1 } },
    apply: (attacker, target) => {
      const ability = SKILLS?.venom_bloom_staff;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        isMagic: true,
        skipGearMultiplier: true,
      }));

      const meter = target?.weakness?.meters?.toxic || 0;
      const tier = target?.weakness?.tiers?.toxic || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      const burst = Math.max(0, Math.floor((meter / 13) + (tier * 5) + Math.max(0, intensity - 1) * 6));
      amount += burst;

      return {
        ...roll,
        amount,
        isMagic: true,
        consumeWeakness: ability?.consumeWeakness ? [...ability.consumeWeakness] : undefined,
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
        log: burst ? `${attacker?.name || 'The caster'} blooms the toxin for +${burst} damage.` : undefined,
      };
    },
    description: "Consume Poison to force rapid ticks; adds a bonus tick at higher tiers."
  },

  'arc_echo': {
    id: "arc_echo",
    name: "Arc Echo",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["staff"],
    requiredStat: "INT",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 6,
    cooldown: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "lightning", "elemental"],
    requiresWeakness: { family: "lightning", tierAtLeast: 1 },
    apply: (attacker, target, scene, opts = {}) => {
      const ability = SKILLS?.arc_echo;
      const powerScale = Number.isFinite(opts?.powerScale) ? opts.powerScale : 1;
      const roll = calculateDamage(attacker, target, ability);

      // Tier and intensity bonuses combined additively into ONE skillPct
      // (Category A — see feedback_additive_damage_bonuses) instead of two
      // sequential multiplies, which compound instead of add.
      const meter = target?.weakness?.meters?.lightning || 0;
      const tier = target?.weakness?.tiers?.lightning || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      const tierPct = 15 * tier;
      const intensityPct = 20 * Math.max(0, intensity - 1);
      const basePct = 100;
      const scaledPct = (basePct + tierPct + intensityPct) * powerScale;
      const powerNote = powerScale !== 1 ? ` × ${Math.round(powerScale * 100)}% power` : '';

      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: scaledPct,
          skillLabel: `${ability?.name || 'Skill'} weapon damage (${basePct}%${tierPct ? ` + ${tierPct}% tier` : ''}${intensityPct ? ` + ${intensityPct}% intensity` : ''}${powerNote})`,
          isCrit: roll.isCrit, critMult: roll.critMult,
          skillConversion: { physToElemPct: 100 },
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      // Lightning T2+ (Shocked): guaranteed repeat at 55% power, using the
      // real repeatChance/repeatScale mechanism (the old version declared
      // repeatDamageFraction/extraHits — neither field was ever read
      // anywhere in the engine, so the "echo" never actually happened; it
      // just quietly folded a bonus number into the same hit instead).
      // +5 Initiative on the same threshold, unchanged from before.
      const repeatChance = tier >= 2 ? 1.0 : 0;
      const initiativeGained = tier >= 2 ? 5 : 0;

      return {
        ...roll,
        physical, elemental, necrotic, amount,
        isMagic: true,
        element: 'lightning',
        repeatChance,
        repeatScale: 0.55,
        initiativeGained: initiativeGained || undefined,
      };
    },
    description: "Requires Lightning T1+. Deals 100% weapon damage as Lightning, +15% per tier and +20% per intensity step above 1. At Lightning T2+ (Shocked): guaranteed repeat at 55% power, and gain 5 Initiative."
  },

  'hemorrhage_rite': {
    id: "hemorrhage_rite",
    name: "Hemorrhage Rite",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["staff"],
    requiredStat: "INT",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "transform", "aoe"],
    aoe: { shape: "circle", scale: 1 },
    requiresWeakness: { family: "lacerate", tierAtLeast: 1 },
    transformWeakness: { from: "lacerate", to: "curse", ratio: 0.6 },
    proliferateWeakness: { families: ["curse"], to: "adjacent", ratio: 0.5, maxTargets: 2 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.hemorrhage_rite;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        isMagic: true,
        skipGearMultiplier: true,
      }));

      let transformed;
      const transform = ability?.transformWeakness;
      if (transform && target?.weakness) {
        const fromKey = transform.from;
        const toKey = transform.to;
        const ratio = transform.ratio ?? 1;
        const current = target.weakness.meters?.[fromKey] || 0;
        if (current > 0) {
          const transfer = Math.max(0, Math.floor(current * ratio));
          const remaining = Math.max(0, current - transfer);
          target.weakness.meters[fromKey] = remaining;
          target.weakness.meters[toKey] = (target.weakness.meters[toKey] || 0) + transfer;
          target.weakness.tiers = target.weakness.tiers || {};
          target.weakness.tiers[fromKey] = weaknessTierFromMeter(target.weakness.meters[fromKey]);
          target.weakness.tiers[toKey] = weaknessTierFromMeter(target.weakness.meters[toKey]);
          transformed = { from: fromKey, to: toKey, amount: transfer };
        }
      }

      const spreadMeta = [];
      if (scene && target && typeof scene._getUnitColumn === 'function') {
        const originColumn = scene._getUnitColumn(target);
        const sideSlots = target?.isEnemy ? scene.enemySlots : scene.allySlots;
        const neighbors = sideSlots
          ?.filter(slot => slot?.char && slot.char !== target && slot.char.status !== 'incapacitated')
          .map(slot => slot.char) || [];
        const maxTargets = ability?.proliferateWeakness?.maxTargets ?? 2;
        const ratio = ability?.proliferateWeakness?.ratio ?? 0.5;
        neighbors.slice(0, maxTargets).forEach(char => {
          const transfer = Math.max(0, Math.floor((target?.weakness?.meters?.curse || 0) * ratio));
          if (transfer > 0) {
            char.weakness = char.weakness || { meters: {}, tiers: {} };
            char.weakness.meters.curse = (char.weakness.meters.curse || 0) + transfer;
            char.weakness.tiers.curse = weaknessTierFromMeter(char.weakness.meters.curse);
            spreadMeta.push({ targetId: char.id || char.name, family: 'curse', amount: transfer });
          }
        });
      }

      return {
        ...roll,
        amount,
        isMagic: true,
        transformedWeakness: transformed,
        proliferatedWeakness: spreadMeta.length ? spreadMeta : undefined,
      };
    },
    description: "Subvert bleeding into binding hexes and spread the malediction nearby."
  },

  'weakpoint_lattice': {
    id: "weakpoint_lattice",
    name: "Weakpoint Lattice",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["staff"],
    requiredStat: "INT",
    requiredValue: 17,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "finisher"],
    requiresWeakness: { family: "expose", tierAtLeast: 1 },
    rewardIfWeak: { family: "expose", tierAtLeast: 2, buff: { critMultBonus: 0.4 } },
    apply: (attacker, target) => {
      const ability = SKILLS?.weakpoint_lattice;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        isMagic: true,
        skipGearMultiplier: true,
      }));

      const exposeTier = target?.weakness?.tiers?.expose || 0;
      const meter = target?.weakness?.meters?.expose || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      if (exposeTier > 1) {
        amount = Math.floor(amount * (1 + 0.25 * (exposeTier - 1)));
      }
      if (intensity > 1) {
        amount = Math.floor(amount * (1 + Math.max(0, intensity - 1) * 0.2));
      }
      if (exposeTier >= (ability?.rewardIfWeak?.tierAtLeast ?? 2)) {
        const critBonus = ability?.rewardIfWeak?.buff?.critMultBonus ?? 0.4;
        amount = Math.floor(amount * (1 + critBonus));
      }

      return {
        ...roll,
        amount,
        isMagic: true,
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
      };
    },
    description: "Weave mana along stress lines and lance through the opening."
  },
  */

  // ===============================
  // v3.21 - 1h Spear (13)
  // ===============================

  // -------- Generation (7) --------
  'reach_test': {
    id: "reach_test",
    name: "Reach Test",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["spear_1h"],
    requiredStat: "DEX",
    requiredValue: 13,
    actionCost: "major",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "expose"],
    emitTagsOnUse: ["thrust"],
    buildupHint: { expose: 55 },
    apply: (attacker, target) => {
      const ability = SKILLS?.reach_test;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const exposeTier = target?.weakness?.tiers?.expose || 0;
      const meter = target?.weakness?.meters?.expose || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      let buildup = ability?.buildupHint?.expose ?? 55;
      if (exposeTier >= 1) {
        amount = Math.floor(amount * (1 + 0.08 * exposeTier));
        buildup += Math.max(4, Math.floor(5 * intensity));
      }

      return {
        ...roll,
        amount,
        buildup: { expose: buildup },
      };
    },
    description: "Probe from a safe distance to pry an opening."
  },

  'tendon_pick': {
    id: "tendon_pick",
    name: "Tendon Pick",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["spear_1h"],
    requiredStat: "DEX",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lacerate"],
    emitTagsOnUse: ["thrust"],
    buildupHint: { lacerate: 70 },
    rewardIfWeak: { family: "expose", tierAtLeast: 1, buff: { addBuildup: { lacerate: 25 } } },
    apply: (attacker, target) => {
      const ability = SKILLS?.tendon_pick;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const exposeTier = target?.weakness?.tiers?.expose || 0;
      let buildup = ability?.buildupHint?.lacerate ?? 70;
      if (exposeTier >= 1) {
        amount = Math.floor(amount * (1 + 0.12 * exposeTier));
        buildup += ability?.rewardIfWeak?.buff?.addBuildup?.lacerate ?? 25;
      }

      return {
        ...roll,
        amount,
        buildup: { lacerate: buildup },
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
      };
    },
    description: "A gouging thrust that seeds Bleed; worse on Exposed foes."
  },

  'stagger_set': {
    id: "stagger_set",
    name: "Stagger Set",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["spear_1h"],
    requiredStat: "STR",
    requiredValue: 14,
    actionCost: "bonus",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "disorient"],
    buildupHint: { disorient: 55 },
    rewardIfTierCross: [{ family: "disorient", tier: 1, debuff: { accDownPct: 10, turns: 1 } }],
    apply: (attacker, target) => {
      const ability = SKILLS?.stagger_set;
      const roll = calculateDamage(attacker, target, ability);
      const amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const buildup = ability?.buildupHint?.disorient ?? 55;

      return {
        ...roll,
        amount,
        buildup: { disorient: buildup },
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
      };
    },
    description: "Butt-end jab that rattles; crossing Disorient T1 jolts aim."
  },

  'frost_tip': {
    id: "frost_tip",
    name: "Frost Tip",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["spear_1h"],
    requiredStat: "INT",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "cold"],
    buildupHint: { cold: 60 },
    rewardIfTierCross: [{ family: "cold", tier: 1, debuff: { speedDownPct: 10, turns: 1 } }],
    apply: (attacker, target) => {
      const ability = SKILLS?.frost_tip;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: 'cold',
        skipGearMultiplier: true,
      }));

      const coldTier = target?.weakness?.tiers?.cold || 0;
      const meter = target?.weakness?.meters?.cold || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      let buildup = ability?.buildupHint?.cold ?? 60;
      if (coldTier >= 1) {
        amount = Math.floor(amount * (1 + 0.12 * coldTier));
        buildup += Math.max(4, Math.floor(6 * intensity));
      }

      return {
        ...roll,
        amount,
        buildup: { cold: buildup },
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
      };
    },
    description: "A chilled point; crossing Cold T1 briefly slows the target."
  },

  'line_probe': {
    id: "line_probe",
    name: "Line Probe",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["spear_1h"],
    requiredStat: "STR",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "expose", "aoe"],
    emitTagsOnUse: ["thrust"],
    aoe: { shape: "column", scale: 1 },
    buildupHint: { expose: 40 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.line_probe;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const baseBuildup = ability?.buildupHint?.expose ?? 40;
      const splash = [];

      if (scene && target && typeof scene._getUnitColumn === 'function' && typeof scene._getColumnBySlotId === 'function') {
        const column = scene._getUnitColumn(target);
        if (column) {
          const sideSlots = target?.isEnemy ? scene.enemySlots : scene.allySlots;
          const neighbors = sideSlots
            ?.filter(slot => slot?.char && slot.char !== target && slot.char.status !== 'incapacitated' && scene._getColumnBySlotId(slot.slotId) === column)
            .map(slot => slot.char) || [];
          const splashAmount = Math.max(1, Math.floor(amount * 0.75));
          const splashBuildup = Math.max(1, Math.floor(baseBuildup * 0.7));
          neighbors.forEach(char => {
            splash.push({
              target: char,
              amount: splashAmount,
              buildup: { expose: splashBuildup },
              tags: ability?.tags,
            });
          });
        }
      }

      return {
        ...roll,
        amount,
        buildup: { expose: baseBuildup },
        splash: splash.length ? splash : undefined,
      };
    },
    description: "Drive a thrust through the rank, lightly Exposing a column."
  },

  'anchor_stance': {
    id: "anchor_stance",
    name: "Anchor Stance",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["spear_1h"],
    requiredStat: "CON",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 0,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["stance", "support", "expose"],
    buildupHint: { expose: 30 },
    statusEffects: [{ id: "anchor_stance", turns: 1, guardPct: 12 }],
    rewardIfTierCross: [{ family: "expose", tier: 1, buff: { accPct: 10, turns: 1 } }],
    apply: (attacker) => {
      const ability = SKILLS?.anchor_stance;
      const statusEffects = Array.isArray(ability?.statusEffects)
        ? ability.statusEffects.map(effect => ({ ...effect }))
        : [];

      return {
        amount: 0,
        statusEffects,
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
      };
    },
    description: "Set the haft and pressure forward-gain guard; opening a guard sharpens accuracy."
  },

  'barbed_set': {
    id: "barbed_set",
    name: "Barbed Set",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["spear_1h"],
    requiredStat: "DEX",
    requiredValue: 13,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lacerate", "proliferate"],
    emitTagsOnUse: ["thrust"],
    buildupHint: { lacerate: 60 },
    proliferateWeakness: { families: ["lacerate"], to: "adjacent", ratio: 0.5, maxTargets: 1 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.barbed_set;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      let buildup = ability?.buildupHint?.lacerate ?? 60;
      const spreadMeta = [];

      if (scene && target && typeof scene._getUnitColumn === 'function' && typeof scene._getColumnBySlotId === 'function') {
        const column = scene._getUnitColumn(target);
        if (column) {
          const sideSlots = target?.isEnemy ? scene.enemySlots : scene.allySlots;
          const neighbors = sideSlots
            ?.filter(slot => slot?.char && slot.char !== target && slot.char.status !== 'incapacitated' && scene._getColumnBySlotId(slot.slotId) === column)
            .map(slot => slot.char) || [];
          const maxTargets = ability?.proliferateWeakness?.maxTargets ?? 1;
          const ratio = ability?.proliferateWeakness?.ratio ?? 0.5;
          const sourceMeter = target?.weakness?.meters?.lacerate || 0;

          neighbors.slice(0, maxTargets).forEach(char => {
            const transfer = Math.max(0, Math.floor(sourceMeter * ratio));
            if (transfer > 0) {
              char.weakness = char.weakness || { meters: {}, tiers: {} };
              char.weakness.meters.lacerate = (char.weakness.meters.lacerate || 0) + transfer;
              char.weakness.tiers.lacerate = weaknessTierFromMeter(char.weakness.meters.lacerate);
              spreadMeta.push({ targetId: char.id || char.name, family: 'lacerate', amount: transfer });
            }
          });
        }
      }

      return {
        ...roll,
        amount,
        buildup: { lacerate: buildup },
        proliferatedWeakness: spreadMeta.length ? spreadMeta : undefined,
      };
    },
    description: "Set the barbs and twist, letting the wound bleed into a nearby foe."
  },

  // -------- Payoff (6) --------
  'impale': {
    id: "impale",
    name: "Impale",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["spear_1h"],
    requiredStat: "DEX",
    requiredValue: 17,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "finisher"],
    requiresWeakness: { family: "expose", tierAtLeast: 1 },
    rewardIfWeak: { family: "expose", tierAtLeast: 2, buff: { critMultBonus: 0.45 } },
    apply: (attacker, target) => {
      const ability = SKILLS?.impale;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const exposeTier = target?.weakness?.tiers?.expose || 0;
      const meter = target?.weakness?.meters?.expose || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      if (exposeTier > 1) {
        amount = Math.floor(amount * (1 + 0.25 * (exposeTier - 1)));
      }
      if (intensity > 1) {
        amount = Math.floor(amount * (1 + Math.max(0, intensity - 1) * 0.2));
      }
      if (exposeTier >= (ability?.rewardIfWeak?.tierAtLeast ?? 2)) {
        const critBonus = ability?.rewardIfWeak?.buff?.critMultBonus ?? 0.45;
        amount = Math.floor(amount * (1 + critBonus));
      }

      return {
        ...roll,
        amount,
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
      };
    },
    description: "Drive through a narrow opening; devastating at deeper Expose."
  },

  'arterial_burst': {
    id: "arterial_burst",
    name: "Arterial Burst",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["spear_1h"],
    requiredStat: "DEX",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lacerate", "consume"],
    requiresWeakness: { family: "lacerate", tierAtLeast: 1 },
    consumeWeakness: ["lacerate"],
    apply: (attacker, target) => {
      const ability = SKILLS?.arterial_burst;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const meter = target?.weakness?.meters?.lacerate || 0;
      const tier = target?.weakness?.tiers?.lacerate || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      const burst = Math.max(0, Math.floor((meter / 12) + (tier * 6) + Math.max(0, intensity - 1) * 7));
      amount += burst;

      return {
        ...roll,
        amount,
        consumeWeakness: ability?.consumeWeakness ? [...ability.consumeWeakness] : undefined,
        log: burst ? `${attacker?.name || 'The lancer'} tears the wound for +${burst} damage.` : undefined,
      };
    },
    description: "Tear the wound open for immediate burst damage, consuming Bleed."
  },

  'brain_stem': {
    id: "brain_stem",
    name: "Brain Stem",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["spear_1h"],
    requiredStat: "STR",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "disorient", "finisher"],
    requiresWeakness: { family: "disorient", tierAtLeast: 1 },
    rewardIfWeak: { family: "disorient", tierAtLeast: 2, buff: { damagePct: 18 } },
    apply: (attacker, target) => {
      const ability = SKILLS?.brain_stem;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const tier = target?.weakness?.tiers?.disorient || 0;
      const meter = target?.weakness?.meters?.disorient || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      if (tier >= 1) {
        amount = Math.floor(amount * (1 + 0.18 * tier));
      }
      if (intensity > 1) {
        amount = Math.floor(amount * (1 + Math.max(0, intensity - 1) * 0.15));
      }
      if (tier >= (ability?.rewardIfWeak?.tierAtLeast ?? 2)) {
        const bonus = ability?.rewardIfWeak?.buff?.damagePct ?? 18;
        amount = Math.floor(amount * (1 + bonus / 100));
      }

      return {
        ...roll,
        amount,
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
      };
    },
    description: "A brutal cranial pick that thrives on a rattled foe."
  },

  'ice_wedge': {
    id: "ice_wedge",
    name: "Ice Wedge",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["spear_1h"],
    requiredStat: "INT",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "cold", "amplify"],
    requiresWeakness: { family: "cold", tierAtLeast: 1 },
    rewardIfWeak: { family: "cold", tierAtLeast: 2, buff: { armorDownPct: 12, turns: 2 } },
    apply: (attacker, target) => {
      const ability = SKILLS?.ice_wedge;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: 'cold',
        skipGearMultiplier: true,
      }));

      const meter = target?.weakness?.meters?.cold || 0;
      const tier = target?.weakness?.tiers?.cold || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      if (tier >= 1) {
        amount = Math.floor(amount * (1 + 0.15 * tier));
      }
      if (intensity > 1) {
        amount = Math.floor(amount * (1 + Math.max(0, intensity - 1) * 0.2));
      }

      return {
        ...roll,
        amount,
        element: 'cold',
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
      };
    },
    description: "Hammer a wedge of ice into brittle seams to fracture armor."
  },

  'line_skewer': {
    id: "line_skewer",
    name: "Line Skewer",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["spear_1h"],
    requiredStat: "STR",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "aoe", "finisher"],
    aoe: { shape: "column", scale: 1 },
    requiresWeakness: { family: "expose", tierAtLeast: 1 },
    rewardIfWeak: { family: "expose", tierAtLeast: 2, buff: { damagePct: 18 } },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.line_skewer;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const exposeTier = target?.weakness?.tiers?.expose || 0;
      if (exposeTier >= 1) {
        amount = Math.floor(amount * (1 + 0.18 * exposeTier));
      }
      if (exposeTier >= (ability?.rewardIfWeak?.tierAtLeast ?? 2)) {
        const bonus = ability?.rewardIfWeak?.buff?.damagePct ?? 18;
        amount = Math.floor(amount * (1 + bonus / 100));
      }

      const splash = [];
      if (scene && target && typeof scene._getUnitColumn === 'function' && typeof scene._getColumnBySlotId === 'function') {
        const column = scene._getUnitColumn(target);
        if (column) {
          const sideSlots = target?.isEnemy ? scene.enemySlots : scene.allySlots;
          const neighbors = sideSlots
            ?.filter(slot => slot?.char && slot.char !== target && slot.char.status !== 'incapacitated' && scene._getColumnBySlotId(slot.slotId) === column)
            .map(slot => slot.char) || [];
          const splashAmount = Math.max(1, Math.floor(amount * 0.8));
          neighbors.forEach(char => {
            splash.push({
              target: char,
              amount: splashAmount,
              tags: ability?.tags,
            });
          });
        }
      }

      return {
        ...roll,
        amount,
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
        splash: splash.length ? splash : undefined,
      };
    },
    description: "Run them through and catch the rank behind-excels against Exposed formations."
  },

  'sever_sinew': {
    id: "sever_sinew",
    name: "Sever Sinew",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["spear_1h"],
    requiredStat: "DEX",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "transform"],
    requiresWeakness: { family: "lacerate", tierAtLeast: 1 },
    transformWeakness: { from: "lacerate", to: "toxic", ratio: 0.6 },
    buildupHint: { lacerate: 100 },
    apply: (attacker, target) => {
      const ability = SKILLS?.sever_sinew;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const transform = ability?.transformWeakness;
      let transformed;
      if (transform && target?.weakness) {
        const fromKey = transform.from;
        const toKey = transform.to;
        const ratio = transform.ratio ?? 1;
        const current = target.weakness.meters?.[fromKey] || 0;
        if (current > 0) {
          const transfer = Math.max(0, Math.floor(current * ratio));
          const remaining = Math.max(0, current - transfer);
          target.weakness.meters[fromKey] = remaining;
          target.weakness.meters[toKey] = (target.weakness.meters[toKey] || 0) + transfer;
          target.weakness.tiers = target.weakness.tiers || {};
          target.weakness.tiers[fromKey] = weaknessTierFromMeter(target.weakness.meters[fromKey]);
          target.weakness.tiers[toKey] = weaknessTierFromMeter(target.weakness.meters[toKey]);
          transformed = { from: fromKey, to: toKey, amount: transfer };
        }
      }

      const exposeTier = target?.weakness?.tiers?.expose || 0;
      const toxicBuildup = exposeTier >= 1 ? { toxic: 30 } : undefined;

      return {
        ...roll,
        amount,
        transformedWeakness: transformed,
        buildup: toxicBuildup,
      };
    },
    description: "Twist the blade and infuse the wound-convert Bleed into Poison."
  },

});

// ===============================
// v3.21 - Legacy Weapon Conversions
// ===============================

Object.assign(RAW_SKILLS, {

  // --- Dagger (1h) --- v3.22
  // -------- Generation --------
  'needle_feint': {
    id: "needle_feint",
    name: "Needle Feint",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["dagger"],
    requiredStat: "DEX",
    requiredValue: 10,
    actionCost: "bonus",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "expose"],
    cooldown: 2,
    buildupHint: { expose: 70 },
    // Declarative — the engine's generic tier-cross reward system applies this
    // itself using the REAL post-buildup tiers (see Pressure Point for the
    // full rationale on why this can't be safely self-computed in apply()).
    // Fires on crossing EITHER threshold (Raw or Flayed), same bonus either way.
    rewardIfTierCross: [
      { family: "expose", tier: 1, buff: { critChanceBonusPct: 15, turns: 1, statusId: "reward_needle_feint_crit" } },
      { family: "expose", tier: 2, buff: { critChanceBonusPct: 15, turns: 1, statusId: "reward_needle_feint_crit" } },
    ],
    apply: (attacker, target) => {
      const ability = SKILLS?.needle_feint;
      const roll = calculateDamage(attacker, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 100, skillLabel: `${ability?.name || 'Skill'} weapon damage (100%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      const exposeBuildup = ability?.buildupHint?.expose ?? 70;
      return {
        ...roll,
        physical, elemental, necrotic, amount,
        buildup: { expose: exposeBuildup },
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
      };
    },
    description: "Deals 100% weapon damage."
  },

  'needle_venom': {
    id: "needle_venom",
    name: "Needle Venom",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    // Marks this skill as migrated to the typed (physical/elemental/necrotic)
    // damage pipeline — the bar for "demo ready." Skills without this flag still
    // use the old scalar applyDamageModifiers() path.
    typedDamage: true,
    requiredWeapon: ["dagger"],
    requiredStat: "DEX",
    requiredValue: 11,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "toxic", "necrotic"],
    cooldown: 2,
    buildupHint: { toxic: 90 },
    // Tiered: Exposed (T1) only adds bonus Toxic buildup, no damage. Flayed (T2)
    // is the only tier that adds damage. apply() reads these values directly so
    // the tooltip and the real effect can never drift out of sync.
    rewardIfWeak: [
      { family: "expose", tierAtLeast: 1, buff: { addBuildup: { toxic: 30 } } },
      { family: "expose", tierAtLeast: 2, buff: { damagePct: 20, addBuildup: { toxic: 30 } } },
    ],
    apply: (attacker, target) => {
      const ability = SKILLS?.needle_venom;
      const roll = calculateDamage(attacker, target, ability);

      // This skill's own Expose-triggered bonus is a Category A "this skill hits
      // harder" reward (NOT an effect of the weakness system itself) — combined
      // additively with the 100% base into ONE skillPct, per applyTypedDamageModifiers
      // below, rather than two chained multiplies.
      const exposeTier = target?.weakness?.tiers?.expose || 0;
      const activeRule = findRewardIfWeakRule(ability, exposeTier);
      const dmgPct = activeRule?.buff?.damagePct || 0;

      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 100 + dmgPct, isCrit: roll.isCrit, critMult: roll.critMult }
      );

      let toxicBuildup = ability?.buildupHint?.toxic ?? 90;
      if (activeRule) {
        toxicBuildup += activeRule.buff?.addBuildup?.toxic || 0;
      }

      const amount = Math.max(1, physical + elemental + necrotic);

      return {
        ...roll,
        physical,
        elemental,
        necrotic,
        amount,
        buildup: { toxic: toxicBuildup },
        rewardIfWeak: cloneRewardOrList(ability?.rewardIfWeak),
      };
    },
    description: "Deals 100% weapon damage. Stronger if the target is Raw or Flayed."
  },

  'pressure_point': {
    id: "pressure_point",
    name: "Pressure Point",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["dagger"],
    requiredStat: "DEX",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "expose", "fire"],
    cooldown: 3,
    buildupHint: { expose: 100 },
    // Declarative — the engine's generic tier-cross reward system (in
    // CombatScene, right after the REAL buildup application) detects the
    // cross and applies this itself. This used to be self-computed inline in
    // apply() using the declared buildupHint value as a prediction of the
    // real result — but the real applied amount can differ (gear buildup%,
    // Hunter's Mark, devBuildup's 5x, etc.), so a target could actually skip
    // straight past T1 to T2 while the self-computed check still thought only
    // T1 was reached, silently never firing. The engine mechanism compares
    // real pre/post tiers (>=, not ===), so a skipped tier still counts.
    rewardIfTierCross: [{
      family: "expose",
      tier: 2,
      debuff: {
        statusId: "pressure_point_ignition",
        permanent: true,
        onNextDamageTaken: { bonusDamagePercent: 30, buildup: { fire: 80 } },
      },
    }],
    apply: (attacker, target) => {
      const ability = SKILLS?.pressure_point;
      const roll = calculateDamage(attacker, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 100, skillLabel: `${ability?.name || 'Skill'} weapon damage (100%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      const exposeBuildup = ability?.buildupHint?.expose ?? 100;
      return {
        ...roll,
        physical, elemental, necrotic, amount,
        buildup: { expose: exposeBuildup },
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
      };
    },
    description: "Deals 100% weapon damage."
  },

  'ghoststep': {
    id: "ghoststep",
    name: "Ghoststep",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["dagger"],
    requiredStat: "DEX",
    requiredValue: 11,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "curse"],
    cooldown: 2,
    buildupHint: { curse: 90 },
    // Current-tier check, not a tier-cross — fires whenever the target is
    // already Dazed or worse, no crossing required.
    rewardIfWeak: [
      { family: "disorient", tierAtLeast: 1, buff: { addBuildup: { curse: 40 } } },
    ],
    apply: (attacker, target) => {
      const ability = SKILLS?.ghoststep;
      const roll = calculateDamage(attacker, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 100, skillLabel: `${ability?.name || 'Skill'} weapon damage (100%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      const disorientTier = target?.weakness?.tiers?.disorient || 0;
      const rule = findRewardIfWeakRule(ability, disorientTier);
      let curseBuildup = ability?.buildupHint?.curse ?? 90;
      if (rule) curseBuildup += rule.buff?.addBuildup?.curse || 0;
      return { ...roll, physical, elemental, necrotic, amount, buildup: { curse: curseBuildup } };
    },
    description: "Deals 100% weapon damage."
  },

  // -------- Escalation --------
  'hex_stitch': {
    id: "hex_stitch",
    name: "Hex Stitch",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["dagger"],
    requiredStat: "CHA",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "curse", "necrotic"],
    cooldown: 3,
    buildupHint: { curse: 60 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.hex_stitch;
      const roll = calculateDamage(attacker, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 100, skillLabel: `${ability?.name || 'Skill'} weapon damage (100%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      const primaryCurse = ability?.buildupHint?.curse ?? 60;
      const splashCurse = Math.floor(primaryCurse * 0.50);
      const toxicMeter = target?.weakness?.meters?.toxic || target?.currentStats?.toxic || 0;
      const repeatChance = Math.min(0.50, toxicMeter / 1000);
      const splash = resolveAOESplash(scene, target, { shape: "column" }).map(tgt => ({
        target: tgt, amount: 0, tags: ability?.tags, buildup: { curse: splashCurse },
      }));
      return {
        ...roll,
        physical, elemental, necrotic, amount,
        buildup: { curse: primaryCurse },
        splash: splash.length ? splash : undefined,
        repeatChance,
      };
    },
    description: "Deals 100% weapon damage. Splashes 50% of the Curse buildup to same-rank enemies (no damage to them). Chance to repeat the hit for free, scaling with the target's Toxic meter (max 50%)."
  },

  'static_prick': {
    id: "static_prick",
    name: "Static Prick",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["dagger"],
    requiredStat: "DEX",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lightning"],
    cooldown: 2,
    buildupHint: { lightning: 60 },
    // Declarative so the tooltip can show it and apply() reads the same
    // numbers instead of duplicating them inline.
    rewardIfWeak: [
      { family: "fire", tierAtLeast: 2, buff: { damagePct: 25 } },
    ],
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.static_prick;
      const roll = calculateDamage(attacker, target, ability);

      // 100% base + 25% if target is at least Ablaze (Fire T2) — Category A,
      // combined additively into ONE skillPct instead of a second chained
      // multiply.
      const fireTier = target?.weakness?.tiers?.fire || 0;
      const rule = findRewardIfWeakRule(ability, fireTier);
      const bonusPct = rule?.buff?.damagePct || 0;

      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 100 + bonusPct,
          skillLabel: `${ability?.name || 'Skill'} weapon damage (100%${bonusPct ? ` + ${bonusPct}% Fire tier` : ''})`,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      const lightningMeter = target?.weakness?.meters?.lightning || target?.currentStats?.lightning || 0;
      const repeatChance = Math.min(0.40, lightningMeter / 1000);
      return {
        ...roll,
        physical, elemental, necrotic, amount,
        buildup: { lightning: ability?.buildupHint?.lightning ?? 60 },
        repeatChance,
      };
    },
    description: "Deals 100% weapon damage. Chance to repeat the hit for free, scaling with the target's Lightning meter (max 40%)."
  },

  'street_panacea': {
    id: "street_panacea",
    name: "Street Panacea",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["dagger"],
    requiredStat: "CHA",
    requiredValue: 11,
    actionCost: "bonus",
    mpCost: 0,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["utility", "support", "mana"],
    cooldown: 3,
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.street_panacea;
      const enemySlots = attacker?.isEnemy ? scene?.allySlots : scene?.enemySlots;
      let totalDisease = 0;
      (enemySlots || []).forEach(s => {
        const char = s?.char;
        if (!char || char.status === 'incapacitated') return;
        totalDisease += char?.weakness?.meters?.disease || 0;
      });
      // mpGain scales 1 MP per 100 total enemy Disease, floored at 2 and capped
      // at 8 (so it takes 800+ combined enemy Disease to hit the ceiling).
      const mpGain = Math.max(2, Math.min(8, Math.floor(totalDisease / 100)));
      // Self-cleanse scales WITH mpGain (not a flat amount) — 50 self-Disease
      // purged per MP gained, so it rides the same 2-8 range: 100 at minimum,
      // up to 400 at the mpGain=8 ceiling.
      const cleanseAmount = mpGain * 50;
      if (attacker?.weakness?.meters?.disease != null) {
        attacker.weakness.meters.disease = Math.max(0, attacker.weakness.meters.disease - cleanseAmount);
        attacker.weakness.tiers.disease = weaknessTierFromMeter(attacker.weakness.meters.disease);
      }

      // Applied directly here (not via result.mpGain) so we can log a message
      // that mentions the disease consumed alongside the MP gained, and so it
      // shows even when the caster is already at full MP.
      if (attacker) {
        const maxMP = attacker.maxMP || attacker.derived?.maxMP || 0;
        const before = attacker.currentMP || 0;
        attacker.currentMP = Math.min(maxMP || 99, before + mpGain);
        const actualGain = attacker.currentMP - before;
        const gainText = actualGain > 0 ? `gains ${actualGain} MP` : 'is already at full MP';
        scene?._log?.(`${attacker.name || "The rogue"} extracts enemy disease — ${gainText} and purges ${cleanseAmount} disease.`);
      }

      return { amount: 0 };
    },
    description: "Reads total Disease across all living enemies: 100 Disease = 1 MP restored (minimum 2, maximum 8). Purges your own Disease at 50 per MP gained (minimum 100, maximum 400)."
  },

  'poison_extraction': {
    id: "poison_extraction",
    name: "Poison Extraction",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["dagger"],
    requiredStat: "DEX",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 0,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["utility", "mana", "toxic"],
    cooldown: 3,
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.poison_extraction;
      const toxicMeter = target?.weakness?.meters?.toxic || 0;
      // 5 bands keyed off the raw METER, not tier — Toxic only ever reaches
      // tier 2, so gating this on toxicTier could never reach the top (250)
      // band. Banding by meter directly makes all 5 steps reachable.
      // 50 minimum: below that there's nothing meaningful to extract — this
      // used to let band 0 fire on ANY toxic including 0, restoring free
      // party MP off a target with no toxic buildup at all. True fizzle
      // (skips costs/cooldown/action-spend, same as requiresWeakness gates)
      // rather than "using" the skill for a no-op result.
      if (toxicMeter < 50) {
        return { fizzle: true, log: `${attacker?.name || "The rogue"} finds no meaningful toxic buildup to extract from ${target?.name || "the target"}.` };
      }
      const band = Math.min(4, Math.floor(toxicMeter / 50) - 1);
      const consumeCap = (band + 1) * 50; // 50, 100, 150, 200, 250
      const consumed = Math.min(toxicMeter, consumeCap);
      if (target?.weakness?.meters?.toxic != null) {
        target.weakness.meters.toxic = Math.max(0, toxicMeter - consumed);
        target.weakness.tiers.toxic = weaknessTierFromMeter(target.weakness.meters.toxic);
      }
      const mpTable = [2, 4, 6, 8, 10];
      const mpGain = mpTable[band];

      // Party-wide: every living character on the attacker's own side gets
      // mpGain (not just the caster) — applied directly here rather than via
      // the generic single-target result.mpGain path, so don't also return
      // mpGain below or the caster would get it twice.
      const allySlots = attacker?.isEnemy ? scene?.enemySlots : scene?.allySlots;
      const party = (allySlots || [])
        .map(slot => slot?.char)
        .filter(char => char && char.status !== 'incapacitated');

      scene?._log?.(`${attacker?.name || "The rogue"} extracts ${consumed} toxic from ${target?.name || "the target"}.`);
      party.forEach(char => {
        const maxMP = char.maxMP || char.derived?.maxMP || 0;
        const before = char.currentMP || 0;
        char.currentMP = Math.min(maxMP || 99, before + mpGain);
        const actualGain = char.currentMP - before;
        if (actualGain > 0) {
          scene?._log?.(`${char.name} recovers ${actualGain} MP.`);
        } else {
          scene?._log?.(`${char.name} is already at full MP.`);
        }
      });

      return { amount: 0 };
    },
    description: "Requires at least 50 Toxic on the target. Consumes up to 250 Toxic buildup, in 50-point steps based on their current meter. Restores 2/4/6/8/10 MP to your entire party, scaling with how much was consumed."
  },

  // -------- Payoff --------
  'heartpiercer': {
    id: "heartpiercer",
    name: "Heartpiercer",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["dagger"],
    requiredStat: "DEX",
    requiredValue: 14,
    actionCost: ["major", "bonus"],
    mpCost: 8,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "expose", "lacerate"],
    cooldown: 4,
    // Fizzles (no cost/cooldown spent) if the target isn't at least Raw —
    // enforced generically in CombatScene._applyAbilityToTarget.
    requiresWeakness: { family: "expose", tierAtLeast: 1 },
    // On a critical hit, applies a 2-turn bleed dealing 15% of the FINAL
    // damage this hit deals (after target DR and any other riders) per tick.
    // Handled generically in CombatScene, post-mitigation — see the
    // "Crit-triggered bleed" block there — not computed here, since apply()
    // only ever sees the pre-mitigation amount.
    critBleedPct: 15,
    critBleedTurns: 2,
    critBleedStatusId: "heartpierced",
    apply: (attacker, target) => {
      const ability = SKILLS?.heartpiercer;
      const roll = calculateDamage(attacker, target, ability);

      // 160% base (100% + 60%) + 30% more if target is at least Hemorrhaging
      // (Lacerate T2) — Category A, combined additively into ONE skillPct
      // (was two sequential multiplies: 1.6x then 1.3x = 208% instead of the
      // intended 190% at the Lacerate T2 cap).
      const lacTier = target?.weakness?.tiers?.lacerate || 0;
      const lacPct = lacTier >= 2 ? 30 : 0;
      const skillPct = 160 + lacPct;

      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct,
          skillLabel: `${ability?.name || 'Skill'} weapon damage (160%${lacPct ? ` + ${lacPct}% Lacerate tier` : ''})`,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      return { ...roll, physical, elemental, necrotic, amount };
    },
    description: "Heavy two-action strike, req target at least Raw (160% + Lacerate T2: +30% damage). On crit, inflicts Heartpierced — a 2-turn bleed dealing 15% of the hit as damage per turn."
  },

  'venom_bloom': {
    id: "venom_bloom",
    name: "Venom Bloom",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["dagger"],
    requiredStat: "DEX",
    requiredValue: 13,
    actionCost: "major",
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["toxic", "necrotic"],
    cooldown: 4,
    // Only usable on a target already Envenomed (Toxic T2) — fizzles for
    // free otherwise, enforced generically in CombatScene._applyAbilityToTarget.
    requiresWeakness: { family: "toxic", tierAtLeast: 2 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.venom_bloom;
      const w = target?.weakness;
      const meter = w?.meters?.toxic || 0;
      const intensity = weaknessIntensityMult(meter) || 1;

      // Plain 100% weapon damage strike, nothing added — same shape as every
      // other basic hit this session (Needle Venom, Needle Feint, etc.).
      const roll = calculateDamage(attacker, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 100, skillLabel: `${ability?.name || 'Skill'} weapon damage (100%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      // Snapshot the SAME formula the natural Envenomed (Toxic T2) start-of-
      // turn tick uses (base x intensity, necrotic/magic, target's own magic
      // DR) — see CombatScene's "TOXIC — Envenomed start-of-turn tick" block,
      // which this mirrors rather than calls directly (that one is written
      // for the afflicted unit's own turn, not an attacker-driven hit).
      const tickBase = WeaknessV3?.families?.toxic?.t2?.startTickBase ?? 0;
      const raw = Math.max(1, Math.floor(tickBase * intensity));
      let dmgEach = Math.max(1, applyDamageModifiers(raw, null, target, {
        ability, isMagic: true, element: 'necrotic', skipGearMultiplier: true,
      }));
      const dr = getDamageReductionFraction(target, { damageType: 'necrotic' });
      if (dr) dmgEach = Math.max(0, Math.floor(dmgEach * (1 - dr)));

      // Diseased (T1+) target: one extra tick.
      const diseaseTier = w?.tiers?.disease || 0;
      const count = diseaseTier >= 1 ? 3 : 2;

      // Using this ability also triggers ONE toxic decay tick on the target —
      // same formula AND same intensity-scaled bypass chance as the normal
      // end-of-turn decay (mirrors _weaknessDecayUnit's toxic-specific
      // handling, including the intensity scaling on decayBypassChance). So
      // the burst isn't free: it also eats into the buildup you'd need to
      // rebuild toward the next Envenomed window, unless the bypass roll
      // saves it — and a heavier overflow is more likely to dodge it, same
      // as it would naturally.
      if (w) {
        const toxicTier = w.tiers?.toxic || 0;
        const bypassBase = WeaknessV3?.families?.toxic?.t1?.decayBypassChance ?? 0;
        const bypassCap = WeaknessV3?.families?.toxic?.t1?.decayBypassChanceCap ?? 1;
        const bypassChance = toxicTier >= 1 ? Math.min(bypassCap, bypassBase * intensity) : 0;
        const bypassed = bypassChance > 0 && Math.random() < bypassChance;
        if (bypassed) {
          scene?._log?.(`${target?.name || 'The target'}'s toxic decay is bypassed (${Math.round(bypassChance * 100)}% chance, I=${intensity.toFixed(2)}).`);
        } else {
          const baseDecay = WeaknessV3?.families?.toxic?.baseDecay ?? 30;
          const decay = weaknessDecayAmount(baseDecay, meter);
          const after = Math.max(0, meter - decay);
          w.meters.toxic = after;
          w.tiers.toxic = weaknessTierFromMeter(after);
          scene?._log?.(`${target?.name || 'The target'}'s toxic weakness decays by ${decay} from the disturbance.`);
        }
      }

      return {
        ...roll,
        physical, elemental, necrotic, amount,
        poisonTicks: { count, damageEach: dmgEach },
      };
    },
    description: "Deals 100% weapon damage. Requires target at least Envenomed (Toxic T2). Immediately triggers the Envenomed damage tick twice (three times if target is also Diseased), then applies one toxic decay tick to the target (subject to the normal, intensity-scaled decay-bypass chance)."
  },

  'silent_order': {
    id: "silent_order",
    name: "Silent Order",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    typedDamage: true,
    requiredWeapon: ["dagger"],
    requiredStat: "DEX",
    requiredValue: 13,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "expose"],
    cooldown: 3,
    buildupHint: { expose: 50 },
    // Bonus crit chance vs an Exposed target — a per-ability rule (see
    // critChanceIfWeak in CombatLogic.js's calculateDamage), not the global
    // Expose T2 crit bonus every attack already gets.
    critChanceIfWeak: [{ family: "expose", tierAtLeast: 1, bonusPct: 10 }],
    // On crit: gain initiative equal to CHA, doubled if the target is at
    // least Dazed (Disorient T1). Generic engine hook lives in CombatScene.js
    // right after the crit-bleed rider — any skill can reuse this shape.
    critInitiative: {
      stat: "CHA",
      mult: 1,
      weaknessBonus: [{ family: "disorient", tierAtLeast: 1, mult: 2 }],
    },
    apply: (attacker, target) => {
      const ability = SKILLS?.silent_order;
      const roll = calculateDamage(attacker, target, ability);

      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 115, isCrit: roll.isCrit, critMult: roll.critMult }
      );

      const amount = Math.max(1, physical + elemental + necrotic);

      return {
        ...roll,
        physical,
        elemental,
        necrotic,
        amount,
        buildup: { expose: ability?.buildupHint?.expose ?? 50 },
      };
    },
    description: "Deals 115% weapon damage. Stronger if the target is Raw or Dazed. Grants initiative on crit."
  },

  'curse_of_needles': {
    id: "curse_of_needles",
    name: "Curse of Needles",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["dagger"],
    requiredStat: "CHA",
    requiredValue: 13,
    actionCost: "major",
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "curse", "necrotic"],
    cooldown: 4,
    requiresWeakness: { family: "curse", tierAtLeast: 1 },
    apply: (attacker, target) => {
      const ability = SKILLS?.curse_of_needles;
      const roll = calculateDamage(attacker, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 110, skillLabel: `${ability?.name || 'Skill'} weapon damage (110%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      target.statusEffects = target.statusEffects || [];
      const alreadyCursed = target.statusEffects.some(se => se?.id === 'curse_of_needles');
      if (!alreadyCursed) {
        // Tier 1 rider ("+X weapon damage") — weaponDamageFlat is read inside
        // calculateDamage() (applyCurseWeaponRiders) and baked directly into
        // the base weapon roll, before skill%/buffs/gear/crit, for ANY hit
        // this target takes while cursed. curseScaled: true amplifies it
        // while the target is Afflicted (Curse T2), same as before.
        target.statusEffects.push({
          id: "curse_of_needles", name: "Curse of Needles", permanent: true,
          onHit: { weaponDamageFlat: 2, curseScaled: true },
        });
      }
      return { ...roll, physical, elemental, necrotic, amount };
    },
    description: "Deals 110% weapon damage. Requires target at least Hexed. Applies a permanent rider: hits against the target deal +2 weapon damage while at least Hexed, amplified while Afflicted."
  },

  'flash_overload': {
    id: "flash_overload",
    name: "Flash Overload",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["dagger"],
    requiredStat: "DEX",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 8,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lightning"],
    cooldown: 4,
    requiresWeakness: { family: "lightning", tierAtLeast: 1 },
    buildupHint: { disorient: 40 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.flash_overload;
      const roll = calculateDamage(attacker, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 125, skillLabel: `${ability?.name || 'Skill'} weapon damage (125%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      const lightningTier = target?.weakness?.tiers?.lightning || 0;
      const repeatChance = lightningTier >= 2 ? 1.0 : 0;

      // All OTHER living enemies take Disorient buildup (no damage) — built as
      // a splash payload instead of applied directly here, so the guaranteed
      // repeat at Lightning T2 re-fans it too (same generic repeat/splash
      // mechanism Hex Stitch's curse splash uses), hitting every other enemy
      // with it twice instead of just once on the initial cast.
      const disorientAmt = ability?.buildupHint?.disorient ?? 40;
      const enemySlots = attacker?.isEnemy ? scene?.allySlots : scene?.enemySlots;
      const splash = (enemySlots || [])
        .map(s => s?.char)
        .filter(enemy => enemy && enemy !== target && enemy.status !== 'incapacitated')
        .map(enemy => ({ target: enemy, amount: 0, tags: ability?.tags, buildup: { disorient: disorientAmt } }));

      return {
        ...roll,
        physical, elemental, necrotic, amount,
        repeatChance,
        splash: splash.length ? splash : undefined,
        buildup: { disorient: disorientAmt },
      };
    },
    description: "Deals 125% weapon damage. Requires the target to be at least Zapped. Applies Disorient to all enemies. If the target is Shocked, the hit is guaranteed to repeat for free — including the Disorient applied to every other enemy."
  },

  'vein_tap': {
    id: "vein_tap",
    name: "Vein Tap",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    typedDamage: true,
    requiredWeapon: ["dagger"],
    requiredStat: "DEX",
    requiredValue: 13,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lacerate", "toxic", "necrotic"],
    cooldown: 3,
    // Declarative so the tooltip can show it and apply() reads the same
    // number instead of duplicating it inline — same pattern as Needle
    // Venom/Static Prick's rewardIfWeak.
    rewardIfWeak: [
      { family: "lacerate", tierAtLeast: 2, buff: { damagePct: 30, damageType: "necrotic" } },
    ],
    apply: (attacker, target) => {
      const ability = SKILLS?.vein_tap;
      const roll = calculateDamage(attacker, target, ability);

      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 100, isCrit: roll.isCrit, critMult: roll.critMult }
      );

      const lacMeter = target?.weakness?.meters?.lacerate || 0;
      const lacTier = target?.weakness?.tiers?.lacerate || 0;
      const exposeTier = target?.weakness?.tiers?.expose || 0;
      const conversionRate = exposeTier >= 1 ? 1.20 : 1.0;
      const toxicGenerated = Math.floor(lacMeter * conversionRate);
      // Consume all lacerate
      if (target?.weakness?.meters?.lacerate != null) {
        target.weakness.meters.lacerate = 0;
        target.weakness.tiers.lacerate = 0;
      }

      // Lacerate T2 (Hemorrhaging): this skill's own "hits harder while
      // draining a Hemorrhaging target" reward — added as pure NECROTIC
      // damage (the draining flavor) instead of scaling the whole hit
      // uniformly, so it's reduced by the target's Necrotic DR specifically
      // rather than whatever type the base weapon swing happens to be.
      // Goes through the SAME applyDamagePctBonus() helper (and breakdown-
      // tooltip entry shape: mult/from/to, not a flat add) every other
      // dagger skill's damage% bonus uses, just applied to the necrotic
      // share of the total instead of the scalar amount.
      const rule = findRewardIfWeakRule(ability, lacTier);
      if (rule) {
        const preBonus = physical + elemental + necrotic;
        const boosted = applyDamagePctBonus(preBonus, rule.buff?.damagePct || 0, `${ability?.name || 'Skill'} Hemorrhaging drain (necrotic)`);
        necrotic += (boosted - preBonus);
      }

      const amount = Math.max(1, physical + elemental + necrotic);

      return {
        ...roll,
        physical, elemental, necrotic,
        amount,
        buildup: { toxic: toxicGenerated },
        rewardIfWeak: cloneRewardOrList(ability?.rewardIfWeak),
      };
    },
    description: "Deals 100% weapon damage. Consumes all Lacerate, converting it to Toxic buildup (120% if target is at least Raw). Stronger if the target is Hemorrhaging."
  },

  // --- Sword (1h) --- v3.22
  // -------- Generation --------
  'marked_cut': {
    id: "marked_cut",
    name: "Marked Cut",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    typedDamage: true,
    requiredWeapon: ["sword_1h"],
    requiredStat: "DEX",
    requiredValue: 10,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "expose"],
    cooldown: 2,
    buildupHint: { expose: 80 },
    // Bonus Lacerate on ACTUALLY crossing an Expose tier — routed through the
    // generic rewardIfTierCross engine (CombatScene.js), which snapshots
    // tiers before/after the REAL buildup application (post Hunter's Mark,
    // weapon buildup%, resilience, etc.), instead of predicting the cross
    // from the raw declared buildup number here. Self-predicting like that
    // was the exact bug Pressure Point and Needle Feint had — a hit
    // amplified or reduced before landing could silently cross (or fail to
    // cross) a tier the ability itself never actually saw happen.
    rewardIfTierCross: [
      { family: "expose", tier: 1, debuff: { addBuildup: { lacerate: 60 } } },
      { family: "expose", tier: 2, debuff: { addBuildup: { lacerate: 120 } } },
    ],
    apply: (attacker, target) => {
      const ability = SKILLS?.marked_cut;
      const roll = calculateDamage(attacker, target, ability);

      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 100, isCrit: roll.isCrit, critMult: roll.critMult }
      );

      const amount = Math.max(1, physical + elemental + necrotic);

      return {
        ...roll,
        physical, elemental, necrotic,
        amount,
        buildup: { expose: ability?.buildupHint?.expose ?? 80 },
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
      };
    },
    description: "Deals 100% weapon damage. Applies Expose. Crossing a tier also opens a bleeding wound (bonus Lacerate)."
  },

  'guarded_slash': {
    id: "guarded_slash",
    name: "Guarded Slash",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    typedDamage: true,
    requiredWeapon: ["sword_1h"],
    requiredStat: "STR",
    requiredValue: 11,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "cold", "defensive"],
    cooldown: 3,
    buildupHint: { cold: 70 },
    // Self PhysicalResist on ACTUALLY crossing EITHER Cold tier — routed
    // through the generic rewardIfTierCross engine (same fix as Marked
    // Cut/Pressure Point/Needle Feint) instead of predicting the cross here
    // from the raw declared buildup number, which can silently drift from
    // what really lands once Hunter's Mark/weapon buildup%/resilience are in
    // play. Two rules (not just T1) so reaching Frostbitten later in the
    // fight re-triggers the guard too, not just the first Chilled crossing.
    // guardPct is _applyRewardBuff's existing PhysicalResist mapping — no
    // engine changes needed, just declaring the reward.
    rewardIfTierCross: [
      { family: "cold", tier: 1, buff: { guardPct: 15, turns: 1, statusId: "guarded_stance" } },
      { family: "cold", tier: 2, buff: { guardPct: 15, turns: 1, statusId: "guarded_stance" } },
    ],
    apply: (attacker, target) => {
      const ability = SKILLS?.guarded_slash;
      const roll = calculateDamage(attacker, target, ability);

      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 100, isCrit: roll.isCrit, critMult: roll.critMult }
      );

      const amount = Math.max(1, physical + elemental + necrotic);

      return {
        ...roll,
        physical, elemental, necrotic,
        amount,
        buildup: { cold: ability?.buildupHint?.cold ?? 70 },
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
      };
    },
    description: "Deals 100% weapon damage. Applies Cold. Reaching Chilled or Frostbitten grants +15% Physical Resist for 1 turn."
  },

  'rally_blow': {
    id: "rally_blow",
    name: "Rally Blow",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    typedDamage: true,
    grantsRhythm: true,
    requiredWeapon: ["sword_1h"],
    requiredStat: "CHA",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "mana", "support"],
    cooldown: 2,
    requiresWeakness: { family: "expose", tierAtLeast: 2 },
    // Declarative so the tooltip can show it and apply() reads the same
    // number instead of duplicating it inline — same pattern as Needle
    // Venom/Static Prick/Vein Tap.
    rewardIfWeak: [
      { family: "disorient", tierAtLeast: 1, buff: { damagePct: 10 } },
    ],
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.rally_blow;
      const roll = calculateDamage(attacker, target, ability);

      const disorientTier = target?.weakness?.tiers?.disorient || 0;
      const rule = findRewardIfWeakRule(ability, disorientTier);
      const dmgPct = rule?.buff?.damagePct || 0;

      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 100 + dmgPct, isCrit: roll.isCrit, critMult: roll.critMult }
      );

      const statusEffects = [];
      if (rule) {
        statusEffects.push({ id: "rallied_vulnerability", turns: 1, mods: { PhysicalResist: -10 } });
      }

      const amount = Math.max(1, physical + elemental + necrotic);

      // Restore MP to all allies
      const mpRestored = 3;
      const allySlots = attacker?.isEnemy ? scene?.enemySlots : scene?.allySlots;
      (allySlots || []).forEach(s => {
        const ally = s?.char;
        if (!ally || ally.status === 'incapacitated') return;
        const maxMP = ally.maxMP ?? ally.derivedStats?.maxMP ?? 0;
        ally.currentMP = Math.min(maxMP, (ally.currentMP || 0) + mpRestored);
      });
      scene?._log?.(`${attacker?.name || "The swordsman"} rallies the party, restoring ${mpRestored} MP to all allies.`);

      applyRhythmStack(attacker);

      return {
        ...roll,
        physical, elemental, necrotic,
        amount,
        statusEffects: statusEffects.length ? statusEffects : undefined,
        rewardIfWeak: cloneRewardOrList(ability?.rewardIfWeak),
      };
    },
    description: "Deals 100% weapon damage. Requires target at least Flayed. Restores MP to all allies and builds Rhythm. Stronger if the target is Dazed."
  },

  'soft_spot_exposed': {
    id: "soft_spot_exposed",
    name: "Soft Spot Exposed",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    typedDamage: true,
    requiredWeapon: ["sword_1h"],
    requiredStat: "STR",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "expose", "necrotic"],
    cooldown: 3,
    buildupHint: { expose: 90 },
    // Builds Rhythm if the target is at least Flayed — reuses the rewardIfWeak
    // convention (grantsRhythm instead of damagePct/addBuildup) so the
    // tooltip shows it and apply() reads the same condition instead of a
    // separate hardcoded check. Kept as its own rule (not merged with the
    // necrotic-weakness bonus below) since findRewardIfWeakRule doesn't
    // filter by family — mixing two independently-gated rules in one array
    // risks one tier check accidentally matching the other's rule.
    rewardIfWeak: [
      { family: "expose", tierAtLeast: 2, buff: { grantsRhythm: true } },
    ],
    apply: (attacker, target) => {
      const ability = SKILLS?.soft_spot_exposed;
      const roll = calculateDamage(attacker, target, ability);

      // Bonus damage if the target has ANY necrotic-family weakness active —
      // a whole-hit "this skill hits harder" reward (Category A), combined
      // additively with the 100% base into ONE skillPct rather than a second
      // chained multiply.
      const hasNecroticWeakness = (target?.weakness?.tiers?.toxic || 0) >= 1
        || (target?.weakness?.tiers?.disease || 0) >= 1
        || (target?.weakness?.tiers?.curse || 0) >= 1;

      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: hasNecroticWeakness ? 125 : 100, isCrit: roll.isCrit, critMult: roll.critMult }
      );

      const exposeTier = target?.weakness?.tiers?.expose || 0;
      const rule = findRewardIfWeakRule(ability, exposeTier);
      if (rule?.buff?.grantsRhythm) applyRhythmStack(attacker);

      const amount = Math.max(1, physical + elemental + necrotic);

      return {
        ...roll,
        physical, elemental, necrotic,
        amount,
        buildup: { expose: ability?.buildupHint?.expose ?? 90 },
        rewardIfWeak: cloneRewardOrList(ability?.rewardIfWeak),
      };
    },
    description: "Deals 100% weapon damage. Applies Expose. +25% damage if the target has any necrotic weakness (Toxic, Disease, or Curse)."
  },

  'sword_flourish': {
    id: "sword_flourish",
    name: "Sword Flourish",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    typedDamage: true,
    requiredWeapon: ["sword_1h"],
    requiredStat: "DEX",
    requiredValue: 13,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "disorient", "aoe"],
    cooldown: 4,
    // Declared at the ability level purely so the tooltip can show it —
    // apply() clones this same array onto each splash payload below, since
    // the rewardIfTierCross engine consumer needs the rules attached to the
    // SPLASH TARGET (whoever the disorient spread actually lands on), not
    // the ability itself. Rhythm grants on ANY tier crossed; the Initiative
    // drain additionally requires the column-mate to already be at least
    // Chilled (Cold T1+).
    rewardIfTierCross: [
      {
        family: "disorient", tier: 1,
        buff: { grantsRhythm: true },
        debuff: { initiativeGaugeDrop: 8, alsoRequires: { family: "cold", tierAtLeast: 1 } },
      },
      {
        family: "disorient", tier: 2,
        buff: { grantsRhythm: true },
        debuff: { initiativeGaugeDrop: 8, alsoRequires: { family: "cold", tierAtLeast: 1 } },
      },
    ],
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.sword_flourish;
      const roll = calculateDamage(attacker, target, ability);

      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 100, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      // Spread 100% of primary's disorient meter to column-mates. Each splash
      // entry carries its own copy of rewardIfTierCross so the reward is
      // checked against the REAL post-buildup tier (Hunter's Mark/weapon
      // buildup%/resilience all apply first) instead of a self-predicted
      // guess made here before any of that runs — see
      // _applySplashTierCrossRewards in CombatScene.js.
      const spreadAmt = target?.weakness?.meters?.disorient || 0;
      const splash = resolveAOESplash(scene, target, { shape: "column" }).map(char => ({
        target: char,
        amount: 0,
        buildup: { disorient: spreadAmt },
        tags: ability?.tags,
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
      }));

      return { ...roll, physical, elemental, necrotic, amount, splash: splash.length ? splash : undefined };
    },
    description: "Deals 100% weapon damage to the primary target. Spreads their full Disorient meter to their rank. If this pushes a rank-mate into a new Disorient tier: builds Rhythm, and also drains their Initiative Gauge if they're at least Chilled."
  },

  // --- Sword (1h) Reactions ---
  'read_and_react': {
    id: "read_and_react",
    name: "Read and React",
    type: "weapon",
    mechanic: "reaction",
    versionTag: "v3.22",
    requiredWeapon: ["sword_1h"],
    requiredStat: "WIS",
    requiredValue: 12,
    actionCost: "reaction",
    mpCost: 4,
    cooldown: 3,
    requiresTarget: false,
    positionRequirement: ["front", "mid"],
    reaction: {
      trigger: "self_hit",
      cooldownOn: "trigger",
      // Broadened from "attacker is Exposed" to "attacker has ANY active
      // weakness (any family, tier 1+)" per request.
      //
      // Melee check: don't rely SOLELY on the attacking ability tagging
      // itself 'melee' — basic_attack (very commonly used by enemies) has no
      // tags at all, which silently failed this check 100% of the time
      // against any enemy using it. Falls back to the attacker's own
      // equipped weapon type (reliably set on char.weaponType at combat
      // start) when the ability itself doesn't say either way.
      canTrigger: ({ attacker, sourceAbility, sourceIntent }) => {
        const RANGED_WEAPON_TYPES = ['bow', 'sling', 'gun'];
        const hitTags = sourceIntent?.tags || sourceAbility?.tags || [];
        const taggedRanged = Array.isArray(hitTags) && hitTags.includes('ranged');
        const taggedMelee = Array.isArray(hitTags) && hitTags.includes('melee');
        const isMelee = !taggedRanged && (taggedMelee || !RANGED_WEAPON_TYPES.includes(attacker?.weaponType));
        if (!isMelee) return false;
        const tiers = attacker?.weakness?.tiers || {};
        return Object.values(tiers).some(t => (t || 0) >= 1);
      },
      exec: ({ owner, scene, incoming }) => {
        if (incoming) {
          incoming.damageReduction = Math.max(incoming.damageReduction || 0, 0.25);
        }
        const mpRestore = 3;
        const maxMP = owner.maxMP ?? 0;
        owner.currentMP = Math.min(maxMP, (owner.currentMP || 0) + mpRestore);
        scene?._log?.(`${owner.name} reads the attack — damage reduced 25%, ${mpRestore} MP restored!`);
      },
    },
    description: "Reaction: prepare to read an incoming melee hit. If the attacker has any active weakness, the hit is reduced 25% and restores 3 MP."
  },

  'blazing_fervor': {
    id: "blazing_fervor",
    name: "Blazing Fervor",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["sword_1h"],
    requiredStat: "CHA",
    requiredValue: 14,
    actionCost: "bonus",
    mpCost: 6,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["support", "buff", "fire"],
    cooldown: 6,
    // Spending initiative is this skill's whole job — below the minimum
    // spend tier, it has nothing to do, so it should fizzle instead of
    // silently firing for free. Checked generically in _applyAbilityToTarget.
    requiresInitiativeGauge: 10,
    apply: (attacker, _target, scene) => {
      // Spend initiative — three tiers (10/20/30), spends the HIGHEST tier
      // the current gauge can fully afford. Was checking `gauge <= 40 ? 20`
      // before falling to the 30 case, a leftover boundary from the old
      // 2-tier version that never got adjusted when the 30 tier was added —
      // meant e.g. a gauge of 32 got the 20 tier instead of the 30 it could
      // actually afford. Still automatic, not a player choice: a smaller
      // spend is picked when the bank can't afford a bigger one.
      const gauge = attacker?.initiativeGauge || 0;
      const spend = gauge >= 30 ? 30 : gauge >= 20 ? 20 : 10;
      attacker.initiativeGauge = Math.max(0, (attacker.initiativeGauge || 0) - spend);

      // +2 fire damage and +20 fire buildup per 10 initiative spent (was a
      // flat 5/40 or 10/40 two-tier split) — 10/20/30 spend now gives
      // 2/4/6 damage and 20/40/60 buildup.
      const steps = spend / 10;
      const fireDmgOnHit = 2 * steps;
      const fireBuildupOnHit = 20 * steps;

      // Apply buff to all allies including self. Routed through
      // scene._addStatusEffects (not a direct push) so a recast on an ally
      // who already has the buff coalesces into one entry — keeping the
      // stronger of the two onHit values — instead of stacking two live
      // entries that both fire on every hit.
      const buff = { id: "blazing_fervor_buff", turns: 2, onHit: { fireDamage: fireDmgOnHit, fireBuildup: fireBuildupOnHit } };
      const allySlots = attacker?.isEnemy ? scene?.enemySlots : scene?.allySlots;
      (allySlots || []).forEach(s => {
        const ally = s?.char;
        if (!ally || ally.status === 'incapacitated') return;
        scene?._addStatusEffects?.(ally, [{ ...buff }]);
      });
      scene?._log?.(`${attacker?.name || "The swordsman"} blazes with fervor (spent ${spend} initiative) — allies deal +${fireDmgOnHit} fire damage and +${fireBuildupOnHit} fire buildup on hit for 2 turns.`);
      return { amount: 0 };
    },
    description: "Spend initiative (10/20/30, based on current gauge) to rally allies with fire: +2 fire damage and +20 fire buildup per 10 initiative spent, on their attacks, for 2 turns."
  },

  // -------- Payoff --------
  'power_stab': {
    id: "power_stab",
    name: "Power Stab",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    typedDamage: true,
    requiredWeapon: ["sword_1h"],
    requiredStat: "STR",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "consume", "expose"],
    cooldown: 4,
    requiresWeakness: { family: "expose", tierAtLeast: 1 },
    // Declarative so the tooltip can show the real rate/cap and apply() reads
    // the same numbers instead of duplicating them inline.
    consumeWeaknessBonus: { family: "expose", pctPer100: 20, maxConsume: 400 },
    apply: (attacker, target) => {
      const ability = SKILLS?.power_stab;
      const roll = calculateDamage(attacker, target, ability);

      // Base 120% weapon damage + up to +80% from consumed Expose — these two
      // are ADDITIVE percentages of the same base (120% + 80% = 200% total
      // at the cap), not sequential multipliers, so they're combined into ONE
      // skillPct below instead of two chained multiplies (which would compound
      // to 216% instead of the intended 200% at the cap).
      const cfg = ability.consumeWeaknessBonus;
      const currentMeter = target?.weakness?.meters?.[cfg.family] || 0;
      const consumed = Math.min(cfg.maxConsume, currentMeter);
      const bonusPct = Math.floor(consumed / 100) * cfg.pctPer100;
      const basePct = 120;

      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: basePct + bonusPct, skillLabel: `${ability?.name || 'Skill'} weapon damage (${basePct}% base + ${bonusPct}% Expose consumed)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );

      if (consumed > 0 && target?.weakness?.meters) {
        target.weakness.meters[cfg.family] = Math.max(0, currentMeter - consumed);
        if (target.weakness.tiers) target.weakness.tiers[cfg.family] = weaknessTierFromMeter(target.weakness.meters[cfg.family]);
      }

      const amount = Math.max(1, physical + elemental + necrotic);

      // Crit reapplies 50 Expose — was reading roll.crit, a field that
      // doesn't exist on calculateDamage()'s return (the real field is
      // isCrit), so this never actually fired before.
      const buildup = roll.isCrit ? { expose: 50 } : undefined;

      return { ...roll, physical, elemental, necrotic, amount, buildup };
    },
    description: "Deals 120% weapon damage. Consumes up to 400 Expose for +20% damage per 100 consumed (up to +80%). Crits reapply 50 Expose."
  },

  'glacial_strike': {
    id: "glacial_strike",
    name: "Glacial Strike",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["sword_1h"],
    requiredStat: "WIS",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 9,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "consume", "cold", "control"],
    cooldown: 6,
    requiresWeakness: { family: "cold", tierAtLeast: 2 },
    apply: (attacker, target) => {
      const ability = SKILLS?.glacial_strike;
      const roll = calculateDamage(attacker, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target, { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 130, isCrit: roll.isCrit, critMult: roll.critMult }
      );

      const statusEffects = [];

      // Cold only immobilizes once it reaches the 400 threshold — below that,
      // the skill still fires (T2 = 200+ is enough to use it) but does not
      // consume or immobilize.
      const coldMeter = target?.weakness?.meters?.cold || 0;
      let consumedCold = 0;
      if (coldMeter >= 400) {
        consumedCold = 400;
        if (target?.weakness?.meters) {
          target.weakness.meters.cold = Math.max(0, coldMeter - consumedCold);
          if (target.weakness.tiers) target.weakness.tiers.cold = weaknessTierFromMeter(target.weakness.meters.cold);
        }
        statusEffects.push({ id: "immobilized", turns: 1 });
      }

      // Fire T2+: consume up to 400 fire, independent of the cold threshold above.
      const buildup = {};
      const hasFireT2 = (target?.weakness?.tiers?.fire || 0) >= 2;
      let consumedFire = 0;
      if (hasFireT2) {
        const currentFire = target?.weakness?.meters?.fire || 0;
        consumedFire = Math.min(400, currentFire);
        if (target?.weakness?.meters) {
          target.weakness.meters.fire = Math.max(0, currentFire - consumedFire);
          if (target.weakness.tiers) target.weakness.tiers.fire = weaknessTierFromMeter(target.weakness.meters.fire);
        }
        // Added afterward — this cold does NOT count toward this cast's own 400 threshold above.
        buildup.cold = Math.floor(consumedFire * 0.5);
        const steps = Math.floor(consumedFire / 100);
        if (steps > 0) {
          statusEffects.push({
            id: "glacial_scorch",
            turns: 1,
            fireBuildupMul: 1 + steps * 0.1,
            // General elemental vulnerability (not fire-only) — reuses the same
            // Resist-as-mitigation-points convention as torn_defenses/rallied_vulnerability.
            mods: { ElementalResist: -(steps * 10) },
            onTurnEndOnce: { damage: steps * 10, isMagic: true },
          });
        }
      }

      const amount = Math.max(1, physical + elemental + necrotic);
      return {
        ...roll, physical, elemental, necrotic, amount,
        statusEffects: statusEffects.length ? statusEffects : undefined,
        buildup: Object.keys(buildup).length ? buildup : undefined,
        log: `${attacker?.name || "The swordsman"} strikes with glacial force!`
          + (consumedCold ? ` The frost locks ${target?.name || 'the target'} in place!` : "")
          + (consumedFire ? " Trapped fire will flare at the end of their next turn." : ""),
      };
    },
    description: "Deals 130% weapon damage. If the target has 400+ Cold, consumes it to immobilize them for 1 turn. If the target has Fire T2+, consumes up to 400 Fire: adds Cold buildup equal to 50% consumed, increases Fire buildup taken by 10% per 100 consumed, and makes the target vulnerable to all Elemental damage by 10% per 100 consumed for 1 turn — at the end of their next turn, the trapped fire deals 10 damage per 100 consumed."
  },

  'taunting_cry': {
    id: "taunting_cry",
    name: "Taunting Cry",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["sword_1h"],
    requiredStat: "CHA",
    requiredValue: 13,
    actionCost: "bonus",
    mpCost: 5,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["support", "taunt", "control"],
    cooldown: 5,
    apply: (attacker, _target, scene) => {
      const initiativeSpend = 15;
      attacker.initiativeGauge = Math.max(0, (attacker.initiativeGauge || 0) - initiativeSpend);
      // Rattle all disoriented enemies for 1 turn — every attack they make
      // this turn (including multi-hit skills) rolls against this Accuracy
      // penalty, via the shared computeHitChance()/getEffectiveDerived() pipeline.
      let affected = 0;
      const enemySlots = attacker?.isEnemy ? scene?.allySlots : scene?.enemySlots;
      (enemySlots || []).forEach(s => {
        const enemy = s?.char;
        if (!enemy || enemy.status === 'incapacitated') return;
        if ((enemy?.weakness?.tiers?.disorient || 0) < 1) return;
        scene?._addStatusEffects?.(enemy, [{ id: "shaken_aim", turns: 1, mods: { Accuracy: -50 } }]);
        affected++;
      });
      return {
        amount: 0,
        log: affected > 0
          ? `${attacker?.name || "The swordsman"} rattles ${affected} disoriented foe${affected > 1 ? "s" : ""} — their aim falters!`
          : `${attacker?.name || "The swordsman"} cries out but no disoriented foes respond.`,
      };
    },
    description: "Spend 15 initiative: all disoriented enemies have Accuracy reduced by 50 for 1 turn, greatly increasing their chance to miss on every attack they make (including multi-hit skills). Deals no damage."
  },

  'crescent_cleave': {
    id: "crescent_cleave",
    name: "Crescent Cleave",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["sword_1h"],
    requiredStat: "STR",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 8,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "aoe", "lacerate"],
    cooldown: 5,
    // Must target an enemy standing in one of the two flank arcs — center-row
    // slots (7, 2) aren't valid targets for this skill. See aoeResolver.js's
    // "arc" shape for the matching splash resolution (top {8,4,3} / bottom {6,5,1}).
    targetSlots: [8, 4, 3, 6, 5, 1],
    aoe: { shape: "arc" },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.crescent_cleave;
      const roll = calculateDamage(attacker, target, ability);
      const hasLacerate = (target?.weakness?.tiers?.lacerate || 0) >= 1;
      const totalPct = 110 + (hasLacerate ? 20 : 0);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target, { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: totalPct, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      // Lifesteal vs Lacerated foes — same "heal = damage dealt × pct" formula as
      // the gear lifesteal check in _applyAbilityToTarget, just scoped to this
      // skill's own hits and gated on each target's own Lacerate tier.
      const LIFESTEAL_PCT = 0.3;
      let healAmt = hasLacerate ? Math.ceil(amount * LIFESTEAL_PCT) : 0;

      const SPLASH_SCALE = 0.85;
      const splash = resolveAOESplash(scene, target, ability.aoe).map(char => {
        const splashPhysical = Math.floor(physical * SPLASH_SCALE);
        const splashElemental = Math.floor(elemental * SPLASH_SCALE);
        const splashNecrotic = Math.floor(necrotic * SPLASH_SCALE);
        const splashAmount = Math.max(1, splashPhysical + splashElemental + splashNecrotic);
        if ((char?.weakness?.tiers?.lacerate || 0) >= 1) {
          healAmt += Math.ceil(splashAmount * LIFESTEAL_PCT);
        }
        return {
          target: char, amount: splashAmount,
          physical: splashPhysical, elemental: splashElemental, necrotic: splashNecrotic,
          tags: ability?.tags,
        };
      });

      if (healAmt > 0 && attacker) {
        const maxHP = attacker.maxHP ?? attacker.derivedStats?.maxHP ?? 0;
        attacker.currentHP = Math.min(maxHP, (attacker.currentHP || 0) + healAmt);
      }

      return {
        ...roll, physical, elemental, necrotic, amount,
        splash: splash.length ? splash : undefined,
        log: healAmt > 0 ? `${attacker?.name || "The swordsman"} cleaves the arc and drains ${healAmt} HP from lacerated foes!` : undefined,
      };
    },
    description: "Arc cleave at 110% (+20% vs Lacerated) against an enemy in either flank arc — top (8,4,3) or bottom (6,5,1); hits the other two enemies in that same arc for 85% damage. Heals 30% of damage dealt to any Lacerated enemy hit."
  },

  'momentum_strike': {
    id: "momentum_strike",
    name: "Momentum Strike",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    // First skill to use a rank-conditional reward — same idea as
    // rewardIfWeak/rewardIfTierCross, just keyed on the attacker's own rank
    // instead of a target's weakness. Read by both apply() below and
    // skillTooltip.js's generic renderer, so logic and tooltip can't drift
    // apart. Expect this shape to recur on future skills.
    rankVariants: {
      front: { damagePct: 25 },
      middle: { initiativePerRhythmStack: 10, consumesRhythm: true },
      back: { grantsRhythm: true },
    },
    requiredWeapon: ["sword_1h"],
    requiredStat: "DEX",
    requiredValue: 13,
    actionCost: "free",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "movement", "initiative"],
    cooldown: 3,
    conditionHint: { requiresMovedThisTurn: true },
    apply: (attacker, target, scene) => {
      if (!scene?.currentActorMovedThisTurn) {
        return { amount: 0, fizzle: true, log: `${attacker?.name || "The swordsman"} hasn't moved this turn — Momentum Strike fizzles.` };
      }
      const ability = SKILLS?.momentum_strike;
      const roll = calculateDamage(attacker, target, ability);

      const FRONT = [1, 2, 3], MIDDLE = [4, 5], BACK = [6, 7, 8];
      const slotId = attacker?._slot?.slotId ?? attacker?.slotId;
      const rank = FRONT.includes(slotId) ? 'front' : MIDDLE.includes(slotId) ? 'middle' : BACK.includes(slotId) ? 'back' : null;
      const variant = rank ? ability.rankVariants?.[rank] : null;
      const skillPct = 100 + (variant?.damagePct || 0);

      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true, skillPct,
          skillLabel: variant?.damagePct ? `${ability?.name || 'Skill'} front-rank bonus (${skillPct}%)` : undefined,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      let log;
      if (variant?.grantsRhythm) {
        applyRhythmStack(attacker);
        log = `${attacker?.name || "The swordsman"} strikes from the back rank, building rhythm!`;
      } else if (variant?.initiativePerRhythmStack) {
        const totalStacks = Math.min(3, (attacker.statusEffects || []).filter(se => se?.id === 'rhythm_stack').length);
        const gain = totalStacks * variant.initiativePerRhythmStack;
        if (gain > 0) {
          if (variant.consumesRhythm) {
            attacker.statusEffects = (attacker.statusEffects || []).filter(se => se?.id !== 'rhythm_stack');
          }
          const max = attacker.initiativeGaugeMax || 100;
          attacker.initiativeGauge = Math.min(max, (attacker.initiativeGauge || 0) + gain);
          log = `${attacker?.name || "The swordsman"} consumes ${totalStacks} Rhythm stack${totalStacks !== 1 ? 's' : ''} for +${gain} initiative!`;
        }
      }

      return { ...roll, physical, elemental, necrotic, amount, log };
    },
    description: "FREE action after moving this turn: 100% weapon damage. The bonus depends on your current rank."
  },

  'balancing_blow': {
    id: "balancing_blow",
    name: "Balancing Blow",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["sword_1h"],
    requiredStat: "CON",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "heal", "necrotic"],
    cooldown: 4,
    requiresWeakness: { anyOf: [{ family: "toxic", tierAtLeast: 1 }, { family: "disease", tierAtLeast: 1 }, { family: "curse", tierAtLeast: 1 }] },
    apply: (attacker, target) => {
      const ability = SKILLS?.balancing_blow;
      const roll = calculateDamage(attacker, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target, { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 100, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      const totalNecrotic = (target?.weakness?.meters?.toxic || 0)
        + (target?.weakness?.meters?.disease || 0)
        + (target?.weakness?.meters?.curse || 0);
      const healAmt = Math.floor(totalNecrotic / 25);
      if (healAmt > 0 && attacker) {
        const maxHP = attacker.maxHP ?? attacker.derivedStats?.maxHP ?? 0;
        attacker.currentHP = Math.min(maxHP, (attacker.currentHP || 0) + healAmt);
      }
      return {
        ...roll, physical, elemental, necrotic, amount,
        log: healAmt > 0 ? `${attacker?.name || "The swordsman"} siphons life — heals ${healAmt} HP from ${totalNecrotic} necrotic buildup.` : undefined,
      };
    },
    description: "100% damage vs necrotically afflicted; heals 1 HP per 25 total necrotic buildup (toxic + disease + curse)."
  },

  'shattering_cut': {
    id: "shattering_cut",
    name: "Shattering Cut",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["sword_1h"],
    requiredStat: "STR",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 9,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "consume", "lacerate"],
    cooldown: 6,
    apply: (attacker, target) => {
      const ability = SKILLS?.shattering_cut;
      const roll = calculateDamage(attacker, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target, { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 125, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      const currentLacerate = target?.weakness?.meters?.lacerate || 0;
      const consumed = Math.min(400, currentLacerate);
      if (consumed > 0 && target?.weakness?.meters) {
        target.weakness.meters.lacerate = Math.max(0, currentLacerate - consumed);
        if (target.weakness.tiers) target.weakness.tiers.lacerate = weaknessTierFromMeter(target.weakness.meters.lacerate);
      }
      const pdrReduction = Math.floor(consumed / 100) * 10;
      const statusEffects = [];
      if (pdrReduction > 0) {
        statusEffects.push({ id: "shattered_defenses", turns: 3, mods: { PhysicalResist: -pdrReduction } });
      }
      if (consumed >= 200) {
        // Lacerate-buildup vulnerability, not a resist debuff — target takes
        // +50% Lacerate buildup from any source for 2 turns. Uses the same
        // generic <family>BuildupMul enforcement added for Glacial Strike's
        // Trapped Fire (_applyWeaknessBuildup in CombatScene.js).
        statusEffects.push({ id: "torn_defenses", turns: 2, lacerateBuildupMul: 1.5 });
      }
      return {
        ...roll, physical, elemental, necrotic, amount,
        statusEffects: statusEffects.length ? statusEffects : undefined,
        log: consumed > 0
          ? `${attacker?.name || "The swordsman"} shatters armor — -${pdrReduction}% PDR${consumed >= 200 ? ", +50% Lacerate buildup taken" : ""}.`
          : undefined,
      };
    },
    description: "125% damage; consume up to 400 lacerate for -10% PDR per 100 for 3 turns. 200+ consumed also makes the target take +50% Lacerate buildup for 2 turns."
  },

  // --- Sword (1h) Reactions ---
  'cover_strike': {
    id: "cover_strike",
    name: "Cover Strike",
    type: "weapon",
    mechanic: "reaction",
    versionTag: "v3.21",
    actionCost: "reaction",
    requiredStat: "DEX",
    requiredValue: 16,
    requiredWeapon: ["sword_1h"],
    mpCost: 0,
    cooldown: 0,
    requiresTarget: false,
    positionRequirement: ["front", "mid"],
    apply: (attacker) => {
      return { armReaction: true, consumeOn: "trigger", log: `${attacker.name} watches over their rank.` };
    },
    reaction: {
      trigger: "ally_hit",
      priority: 1,
      canTrigger: ({ owner, target, scene }) => {
        const colA = scene?._getUnitColumn?.(owner);
        const colB = scene?._getUnitColumn?.(target);
        return colA && colB && colA === colB;
      },
      exec: ({ owner, attacker, scene }) => {
        scene?._log?.(`${owner.name} strikes back to protect their ally!`);
        const basic = SKILLS?.basic_attack;
        if (basic) {
          scene.time?.delayedCall(50, () => {
            scene._applyAbilityToTarget(owner, attacker, basic, { isReaction: true, tags: basic.tags || [] });
          });
        }
      }
    },
    description: "Arm yourself to strike back when an ally in your rank is attacked."
  },

  'riposte': {
    id: "riposte",
    name: "Riposte",
    type: "weapon",
    mechanic: "reaction",
    versionTag: "v3.21",
    actionCost: "reaction",
    requiredStat: "DEX",
    requiredValue: 15,
    requiredWeapon: ["sword_1h"],
    mpCost: 0,
    cooldown: 1,
    requiresTarget: false,
    positionRequirement: ["front", "mid"],
    apply: (attacker) => {
      return { armReaction: true, consumeOn: "trigger", log: `${attacker.name} prepares a riposte.` };
    },
    reaction: {
      trigger: "self_hit",
      canTrigger: ({ owner }) => {
        const w = owner?.weaponType;
        return w === "sword_1h";
      },
      exec: ({ owner, attacker, scene, incoming }) => {
        incoming.damageReduction = Math.max(incoming.damageReduction || 0, 0.5);
        scene?._log?.(`${owner.name} parries!`);
        const basic = SKILLS?.basic_attack;
        if (basic) {
          scene.time?.delayedCall(50, () => {
            scene._applyAbilityToTarget(owner, attacker, basic, { isReaction: true, tags: basic.tags || [] });
          });
        }
      }
    },
    description: "Arm a parry stance; the first hit until your next turn is reduced and countered."
  },

  // --- Sword (2h) ---
  'searing_brand': {
    id: "searing_brand",
    name: "Searing Brand",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sword_2h"],
    requiredStat: "INT",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "fire"],
    cooldown: 2,
    buildupHint: { fire: 60 },
    rewardIfTierCross: [{ family: "fire", tier: 2, healMP: 3 }],
    apply: (attacker, target) => {
      const ability = SKILLS?.searing_brand;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: "fire",
        isMagic: true,
        skipGearMultiplier: true,
      }));
      const coldTier = target?.weakness?.tiers?.cold || 0;
      if (coldTier >= 1) amount = Math.floor(amount * 1.2);
      const consumeWeakness = coldTier === 2 ? ["cold"] : undefined;
      return {
        ...roll,
        amount,
        isMagic: true,
        element: "fire",
        buildup: { fire: ability?.buildupHint?.fire ?? 60 },
        consumeWeakness,
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
      };
    },
    description: "Engraves a burning sigil; stronger on chilled targets."
  },

  'column_rally': {
    id: "column_rally",
    name: "Column Rally",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sword_2h"],
    requiredStat: "CHA",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 0,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["support", "buff"],
    cooldown: 3,
    teamBuff: { scope: "column", effect: { id: "rally", turns: 2, atkMul: 1.10, accBonus: 5 } },
    apply: () => {
      return {
        teamBuff: {
          scope: "column",
          effect: { id: "rally", turns: 2, atkMul: 1.10, accBonus: 5 }
        }
      };
    },
    description: "Bolster allies in your column, raising attack and accuracy."
  },

  // --- Axe (2h) --- v3.22
  'rending_hew': {
    id: "rending_hew",
    name: "Rending Hew",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["axe_2h"],
    requiredStat: "STR",
    requiredValue: 10,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lacerate"],
    emitTagsOnUse: ["slash"],
    cooldown: 2,
    buildupHint: { lacerate: 80 },
    apply: (attacker, target) => {
      const ability = SKILLS?.rending_hew;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      const tier = target?.weakness?.tiers?.lacerate || 0;
      if (tier >= 1) amount = Math.floor(amount * 1.2);
      return {
        ...roll,
        amount,
        buildup: { lacerate: ability?.buildupHint?.lacerate ?? 80 },
      };
    },
    description: "A savage swing that opens a bleeding wound; heavier when the foe is already bleeding."
  },

  'trophy_cry': {
    id: "trophy_cry",
    name: "Trophy Cry",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["axe_2h"],
    requiredStat: "CON",
    requiredValue: 14,
    actionCost: "bonus",
    mpCost: 3,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["support", "hp", "party"],
    cooldown: 3,
    conditionHint: { requiresKillThisTurn: true },
    apply: (attacker, _target, scene) => {
      if (!scene?.enemyDiedThisTurn) {
        return { amount: 0, log: `${attacker?.name || "The axeman"} finds no trophy to cry for yet.` };
      }
      const maxHP = attacker?.maxHP ?? attacker?.derivedStats?.maxHP ?? 0;
      const healAmt = Math.floor(maxHP * 0.1);
      if (healAmt > 0 && attacker) {
        attacker.currentHP = Math.min(maxHP, (attacker.currentHP ?? 0) + healAmt);
      }
      const allySlots = attacker?.isEnemy ? scene?.enemySlots : scene?.allySlots;
      (allySlots || []).forEach(s => {
        const ally = s?.char;
        if (!ally || ally.status === 'incapacitated') return;
        const meters = ally?.weakness?.meters;
        if (!meters) return;
        Object.keys(meters).forEach(fam => {
          meters[fam] = Math.max(0, (meters[fam] || 0) - 50);
          if (ally.weakness.tiers) ally.weakness.tiers[fam] = weaknessTierFromMeter(meters[fam]);
        });
      });
      return {
        amount: 0,
        log: `${attacker?.name || "The axeman"} roars over the fallen, healing ${healAmt} HP and rallying the party.`,
      };
    },
    description: "After a kill this turn, roar in triumph to heal 10% HP and reduce all ally status buildups by 50."
  },

  'wound_opener': {
    id: "wound_opener",
    name: "Wound Opener",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["axe_2h"],
    requiredStat: "STR",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lacerate"],
    emitTagsOnUse: ["twist"],
    cooldown: 3,
    requiresWeakness: { family: "lacerate", tierAtLeast: 1 },
    buildupHint: { lacerate: 100 },
    apply: (attacker, target) => {
      const ability = SKILLS?.wound_opener;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      const toxicTier = target?.weakness?.tiers?.toxic || 0;
      const diseaseTier = target?.weakness?.tiers?.disease || 0;
      if (toxicTier >= 1 || diseaseTier >= 1) amount = Math.floor(amount * 1.25);
      return {
        ...roll,
        amount,
        buildup: { lacerate: ability?.buildupHint?.lacerate ?? 100 },
      };
    },
    description: "Twist the axe into existing wounds; deals 25% bonus damage if the target is also poisoned or diseased."
  },

  'butchers_march': {
    id: "butchers_march",
    name: "Butcher's March",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["axe_2h"],
    requiredStat: "CON",
    requiredValue: 14,
    actionCost: "bonus",
    mpCost: 5,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["support", "stance", "self-buff"],
    cooldown: 5,
    statusEffects: [{ id: "butchers_march_buff", turns: 3, onCritRestore: { hpPct: 5, initiativeGain: 5 } }],
    apply: (attacker) => {
      const ability = SKILLS?.butchers_march;
      const statusEffects = Array.isArray(ability?.statusEffects)
        ? ability.statusEffects.map(e => ({ ...e }))
        : undefined;
      return {
        amount: 0,
        statusEffects,
        log: `${attacker?.name || "The axeman"} enters a relentless march — crits restore HP and initiative.`,
      };
    },
    description: "Enter a bloodthirsty stance for 3 turns; critical strikes restore 5% HP and gain 5 initiative."
  },

  'bone_notch': {
    id: "bone_notch",
    name: "Bone Notch",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["axe_2h"],
    requiredStat: "STR",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 10,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lacerate"],
    emitTagsOnUse: ["slash"],
    cooldown: 4,
    buildupHint: { lacerate: 100 },
    conditionHint: { requiresCrit: true },
    apply: (attacker, target) => {
      const ability = SKILLS?.bone_notch;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      const isCrit = !!roll?.crit;
      const lacTier = target?.weakness?.tiers?.lacerate || 0;
      const expTier = target?.weakness?.tiers?.expose || 0;
      const fullHit = isCrit && (lacTier >= 1 || expTier >= 1);
      if (fullHit) amount = Math.floor(amount * 1.5);
      return {
        ...roll,
        amount,
        buildup: fullHit ? { lacerate: ability?.buildupHint?.lacerate ?? 100 } : {},
        log: !fullHit ? `${attacker?.name || "The axeman"} swings but fails to notch the bone cleanly.` : undefined,
      };
    },
    description: "On a crit vs a bleeding or exposed foe, deal 150% damage and deepen the wound."
  },

  'war_cry': {
    id: "war_cry",
    name: "War Cry",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["axe_2h"],
    requiredStat: "CHA",
    requiredValue: 14,
    actionCost: "bonus",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["support", "shout", "expose", "aoe"],
    emitTagsOnUse: ["shout"],
    cooldown: 3,
    buildupHint: { expose: 80 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.war_cry;
      // Amplified if target already has expose T1+
      const expTier = target?.weakness?.tiers?.expose || 0;
      const amplified = expTier >= 1;
      const initiativeSpend = amplified ? 30 : 10;
      const exposeBuildup = amplified ? 130 : 80;
      if (attacker) attacker.initiativeGauge = (attacker.initiativeGauge || 0) + initiativeSpend;

      // Expose enemy column
      const splash = [];
      if (scene && target && typeof scene._getUnitColumn === "function" && typeof scene._getColumnBySlotId === "function") {
        const column = scene._getUnitColumn(target);
        if (column) {
          const sideSlots = target?.isEnemy ? scene.enemySlots : scene.allySlots;
          (sideSlots || [])
            .filter(slot => slot?.char && slot.char !== target && slot.char.status !== "incapacitated" && scene._getColumnBySlotId(slot.slotId) === column)
            .map(slot => slot.char)
            .forEach(char => splash.push({ target: char, amount: 0, buildup: { expose: exposeBuildup }, tags: ability?.tags }));
        }
        // AttackPower +15% to ally column for 2 turns
        const atkBuff = { id: "war_cry_atk_buff", turns: 2, AttackPower: 15 };
        const attackerCol = scene._getUnitColumn?.(attacker);
        const allySlots = attacker?.isEnemy ? scene?.enemySlots : scene?.allySlots;
        if (attackerCol) {
          (allySlots || [])
            .filter(slot => slot?.char && slot.char !== attacker && slot.char.status !== "incapacitated" && scene._getColumnBySlotId(slot.slotId) === attackerCol)
            .forEach(slot => {
              slot.char.statusEffects = slot.char.statusEffects || [];
              slot.char.statusEffects.push({ ...atkBuff });
            });
        }
        if (attacker) {
          attacker.statusEffects = attacker.statusEffects || [];
          attacker.statusEffects.push({ ...atkBuff });
        }
      }

      return {
        amount: 0,
        buildup: { expose: exposeBuildup },
        splash: splash.length ? splash : undefined,
        log: `${attacker?.name || "The axeman"} bellows a war cry${amplified ? " with full fury" : ""}, exposing foes and bolstering allies.`,
      };
    },
    description: "A bonus-action shout that exposes an enemy column and grants allies +15% AttackPower. Amplifies if the target is already exposed."
  },

  'scarlet_rush': {
    id: "scarlet_rush",
    name: "Scarlet Rush",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["axe_2h"],
    requiredStat: "STR",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lacerate"],
    emitTagsOnUse: ["slash"],
    cooldown: 3,
    buildupHint: { lacerate: 100 },
    rewardIfTierCross: [
      { family: "lacerate", tier: 1, healMP: 3 },
      { family: "lacerate", tier: 2, healMP: 6 },
    ],
    apply: (attacker, target) => {
      const ability = SKILLS?.scarlet_rush;
      const roll = calculateDamage(attacker, target, ability);
      const amount = Math.max(1, Math.floor(
        applyDamageModifiers(roll.amount, attacker, target, {
          ability,
          tags: ability?.tags,
          skipGearMultiplier: true,
        }) * 0.95
      ));
      return {
        ...roll,
        amount,
        buildup: { lacerate: ability?.buildupHint?.lacerate ?? 100 },
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
      };
    },
    description: "A swift raking strike that builds lacerate; restores MP when a tier is crossed."
  },

  // -------- Payoff --------
  'hemorrhage_strike': {
    id: "hemorrhage_strike",
    name: "Hemorrhage Strike",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["axe_2h"],
    requiredStat: "STR",
    requiredValue: 18,
    actionCost: "major",
    mpCost: 8,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "finisher", "consume"],
    emitTagsOnUse: ["slash"],
    cooldown: 5,
    requiresWeakness: { family: "lacerate", tierAtLeast: 2 },
    apply: (attacker, target) => {
      const ability = SKILLS?.hemorrhage_strike;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      amount = Math.floor(amount * 1.2);
      const currentMeter = target?.weakness?.meters?.lacerate || 0;
      const consumed = Math.min(600, currentMeter);
      if (consumed > 0 && target?.weakness?.meters) {
        const remaining = Math.max(0, currentMeter - consumed);
        target.weakness.meters.lacerate = remaining;
        if (target.weakness.tiers) target.weakness.tiers.lacerate = weaknessTierFromMeter(remaining);
      }
      const tickDamage = consumed > 0 ? Math.floor(consumed / 10) : 0;
      const statusEffects = tickDamage > 0 ? [{ id: "hemorrhage_dot", turns: 3, tickDamage }] : undefined;
      return {
        ...roll,
        amount,
        statusEffects,
        log: consumed > 0 ? `${attacker?.name || "The axeman"} opens a hemorrhage — ${tickDamage} bleed damage per turn for 3 turns.` : undefined,
      };
    },
    description: "A brutal finisher that consumes up to 600 lacerate and converts it into a hemorrhage DOT."
  },

  'blood_surge': {
    id: "blood_surge",
    name: "Blood Surge",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["axe_2h"],
    requiredStat: "CON",
    requiredValue: 16,
    actionCost: "bonus",
    mpCost: 5,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["support", "heal", "aoe"],
    emitTagsOnUse: ["roar"],
    cooldown: 4,
    conditionHint: { requiresAnyLacerate: true },
    apply: (attacker, _target, scene) => {
      const ability = SKILLS?.blood_surge;
      const splash = [];
      let healAmt = 0;
      (scene?.enemySlots || []).forEach(s => {
        const victim = s?.char;
        if (!victim || victim.status === 'incapacitated') return;
        const lacTier = victim?.weakness?.tiers?.lacerate || 0;
        if (lacTier < 1) return;
        const baseRoll = calculateDamage(attacker, victim, ability);
        const splashAmt = Math.max(1, Math.floor(
          applyDamageModifiers(baseRoll.amount, attacker, victim, {
            ability,
            tags: ability?.tags,
            skipGearMultiplier: true,
          }) * 0.5
        ));
        splash.push({ target: victim, amount: splashAmt, tags: ability?.tags });
        if (lacTier >= 2 && attacker) {
          const maxHP = attacker?.maxHP ?? attacker?.derivedStats?.maxHP ?? 0;
          healAmt += Math.floor(maxHP * 0.05);
        }
      });
      if (healAmt > 0 && attacker) {
        const maxHP = attacker?.maxHP ?? attacker?.derivedStats?.maxHP ?? 0;
        attacker.currentHP = Math.min(maxHP, (attacker.currentHP ?? 0) + healAmt);
      }
      return {
        amount: 0,
        splash: splash.length ? splash : undefined,
        log: healAmt > 0
          ? `${attacker?.name || "The axeman"} surges on blood, striking bleeders and healing ${healAmt} HP.`
          : `${attacker?.name || "The axeman"} surges on blood, striking bleeders.`,
      };
    },
    description: "Strike all lacerate T1+ enemies for 50% damage; heal 5% HP per enemy in hemorrhage tier."
  },

  'inferno_arc': {
    id: "inferno_arc",
    name: "Inferno Arc",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["axe_2h"],
    requiredStat: "STR",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 8,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "fire", "consume"],
    emitTagsOnUse: ["slash"],
    cooldown: 5,
    requiresWeakness: { family: "lacerate", tierAtLeast: 2 },
    buildupHint: { fire: 80 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.inferno_arc;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: "fire",
        isMagic: true,
        skipGearMultiplier: true,
      }));
      amount = Math.floor(amount * 1.1);
      const currentLac = target?.weakness?.meters?.lacerate || 0;
      const consumed = Math.min(400, currentLac);
      if (consumed > 0 && target?.weakness?.meters) {
        target.weakness.meters.lacerate = Math.max(0, currentLac - consumed);
        if (target.weakness.tiers) target.weakness.tiers.lacerate = weaknessTierFromMeter(target.weakness.meters.lacerate);
      }
      const fireBuildup = (ability?.buildupHint?.fire ?? 80) + Math.floor(consumed / 5);
      const splash = [];
      const necTier = target?.weakness?.tiers?.necrotic || 0;
      if (necTier >= 2 && scene && typeof scene._getUnitColumn === "function" && typeof scene._getColumnBySlotId === "function") {
        const column = scene._getUnitColumn(target);
        if (column) {
          const sideSlots = target?.isEnemy ? scene.enemySlots : scene.allySlots;
          (sideSlots || [])
            .filter(slot => slot?.char && slot.char !== target && slot.char.status !== "incapacitated" && scene._getColumnBySlotId(slot.slotId) === column)
            .map(slot => slot.char)
            .forEach(char => splash.push({
              target: char,
              amount: Math.max(1, Math.floor(amount * 0.7)),
              isMagic: true,
              element: "fire",
              buildup: { fire: Math.floor(fireBuildup * 0.6) },
              tags: ability?.tags,
            }));
        }
      }
      return {
        ...roll,
        amount,
        isMagic: true,
        element: "fire",
        buildup: { fire: fireBuildup },
        splash: splash.length ? splash : undefined,
      };
    },
    description: "Ignite an open wound — converts up to 400 lacerate into fire buildup; scorches the column if the foe is necrotic."
  },

  'artery_sever': {
    id: "artery_sever",
    name: "Artery Sever",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["axe_2h"],
    requiredStat: "STR",
    requiredValue: 17,
    actionCost: "major",
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lacerate", "finisher", "consume"],
    emitTagsOnUse: ["thrust"],
    cooldown: 4,
    apply: (attacker, target) => {
      const ability = SKILLS?.artery_sever;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      amount = Math.floor(amount * 1.15);
      const currentMeter = target?.weakness?.meters?.lacerate || 0;
      const consumed = Math.min(400, currentMeter);
      if (consumed > 0 && target?.weakness?.meters) {
        target.weakness.meters.lacerate = Math.max(0, currentMeter - consumed);
        if (target.weakness.tiers) target.weakness.tiers.lacerate = weaknessTierFromMeter(target.weakness.meters.lacerate);
      }
      const bonusPct = Math.floor(consumed / 100) * 0.125;
      if (bonusPct > 0) amount = Math.floor(amount * (1 + bonusPct));
      const statusEffects = consumed >= 200
        ? [{ id: "artery_necrotic_vuln", turns: 3, necroticVulnPct: 25 }]
        : undefined;
      return {
        ...roll,
        amount,
        statusEffects,
        log: consumed >= 200 ? `${attacker?.name || "The axeman"} severs the artery — the target becomes vulnerable to necrotic damage.` : undefined,
      };
    },
    description: "Consume up to 400 lacerate for bonus damage (+12.5% per 100); 200+ consumed applies necrotic vulnerability."
  },

  'harvest_momentum': {
    id: "harvest_momentum",
    name: "Harvest Momentum",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["axe_2h"],
    requiredStat: "WIS",
    requiredValue: 15,
    actionCost: "bonus",
    mpCost: 4,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["support", "initiative"],
    cooldown: 5,
    apply: (attacker, _target, scene) => {
      let totalLacMeter = 0;
      (scene?.enemySlots || []).forEach(s => { totalLacMeter += s?.char?.weakness?.meters?.lacerate || 0; });
      const initiativeGain = Math.min(20, Math.floor(totalLacMeter / 50));
      if (initiativeGain > 0 && attacker) {
        attacker.initiativeGauge = Math.max(0, (attacker.initiativeGauge || 0) - initiativeGain);
      }
      return {
        amount: 0,
        log: initiativeGain > 0
          ? `${attacker?.name || "The axeman"} harvests momentum from ${totalLacMeter} lacerate — gains ${initiativeGain} initiative.`
          : `${attacker?.name || "The axeman"} finds no momentum to harvest yet.`,
      };
    },
    description: "Convert all enemy lacerate meters into initiative (1 per 50 meters, cap 20)."
  },

  'bloodletting_cleave': {
    id: "bloodletting_cleave",
    name: "Bloodletting Cleave",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["axe_2h"],
    requiredStat: "STR",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 9,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lacerate", "aoe"],
    emitTagsOnUse: ["slash"],
    cooldown: 6,
    buildupHint: { lacerate: 60 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.bloodletting_cleave;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      amount = Math.floor(amount * 1.1);
      const baseBuildup = ability?.buildupHint?.lacerate ?? 60;
      const necTier = target?.weakness?.tiers?.necrotic || 0;
      const splash = [];
      resolveAOESplash(scene, target, { shape: "column" }).forEach(char => {
        const splashBuildup = { lacerate: baseBuildup };
        if (necTier >= 2) splashBuildup.necrotic = 80;
        splash.push({
          target: char,
          amount: Math.max(1, Math.floor(amount * 0.75)),
          buildup: splashBuildup,
          tags: ability?.tags,
        });
      });
      return {
        ...roll,
        amount,
        buildup: { lacerate: baseBuildup },
        splash: splash.length ? splash : undefined,
      };
    },
    description: "A heavy column sweep at 110%/75%; spreads necrotic buildup to splash targets if the primary is decaying."
  },

  'death_blow': {
    id: "death_blow",
    name: "Death Blow",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["axe_2h"],
    requiredStat: "STR",
    requiredValue: 18,
    actionCost: "major",
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "execute", "consume"],
    emitTagsOnUse: ["slash"],
    cooldown: 8,
    conditionHint: { requiresLowHP: true },
    apply: (attacker, target) => {
      const ability = SKILLS?.death_blow;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      const hp = target?.currentHP ?? 9999;
      const maxHP = target?.maxHP ?? target?.derivedStats?.maxHP ?? 0;
      const threshold = maxHP ? Math.floor(maxHP * 0.4) : 0;
      if (maxHP > 0 && hp > threshold) {
        return {
          ...roll,
          amount: Math.floor(amount * 0.5),
          log: `${attacker?.name || "The axeman"} swings wide — the target is not yet broken.`,
        };
      }
      amount = Math.floor(amount * 2.0);
      const lacMeter = target?.weakness?.meters?.lacerate || 0;
      const expMeter = target?.weakness?.meters?.expose || 0;
      const totalConsumed = lacMeter + expMeter;
      const bonusPct = Math.floor(totalConsumed / 100) * 0.05;
      if (bonusPct > 0) amount = Math.floor(amount * (1 + bonusPct));
      if (target?.weakness?.meters) {
        target.weakness.meters.lacerate = 0;
        target.weakness.meters.expose = 0;
        if (target.weakness.tiers) {
          target.weakness.tiers.lacerate = weaknessTierFromMeter(0);
          target.weakness.tiers.expose = weaknessTierFromMeter(0);
        }
      }
      return {
        ...roll,
        amount,
        log: `${attacker?.name || "The headsman"} delivers the Death Blow — ${totalConsumed} buildup consumed.`,
      };
    },
    description: "Execute a target below 40% HP at 200% base damage (+5% per 100 lacerate/expose consumed)."
  },

  // -------- Generation (elemental / utility) --------
  'decapitating_arc': {
    id: "decapitating_arc",
    name: "Decapitating Arc",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["axe_2h"],
    requiredStat: "STR",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "aoe"],
    emitTagsOnUse: ["chop"],
    cooldown: 4,
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.decapitating_arc;
      const roll = calculateDamage(attacker, target, ability);
      const amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      const splash = [];
      resolveAOESplash(scene, target, { shape: "column" }).slice(0, 2).forEach(char => {
        splash.push({ target: char, amount: Math.max(1, Math.floor(amount * 0.85)), tags: ability?.tags });
      });
      return { ...roll, amount, splash: splash.length ? splash : undefined };
    },
    description: "A sweeping arc that cleaves through a column — 100% primary, 85% to up to 2 column-mates."
  },

  'ember_cleave': {
    id: "ember_cleave",
    name: "Ember Cleave",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["axe_2h"],
    requiredStat: "STR",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "fire", "elemental", "buildup"],
    emitTagsOnUse: ["chop"],
    cooldown: 2,
    buildupHint: { fire: 60 },
    apply: (attacker, target) => {
      const ability = SKILLS?.ember_cleave;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: "fire",
        isMagic: true,
        skipGearMultiplier: true,
      }));
      let fireBuildup = ability?.buildupHint?.fire ?? 60;
      const coldTier = target?.weakness?.tiers?.cold || 0;
      if (coldTier >= 1) { amount = Math.floor(amount * 1.15); fireBuildup += 20; }
      return { ...roll, amount, isMagic: true, element: "fire", buildup: { fire: fireBuildup } };
    },
    description: "Fiery chop with 60 fire buildup; deals 15% more and gains +20 buildup vs chilled/frostbitten foes."
  },

  'rime_chop': {
    id: "rime_chop",
    name: "Rime Chop",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["axe_2h"],
    requiredStat: "CON",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 0,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "cold", "elemental", "buildup", "necrotic"],
    emitTagsOnUse: ["chop"],
    cooldown: 3,
    buildupHint: { cold: 60 },
    apply: (attacker, target) => {
      const ability = SKILLS?.rime_chop;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: "cold",
        isMagic: true,
        skipGearMultiplier: true,
      }));
      const coldTier = target?.weakness?.tiers?.cold || 0;
      const buildup = { cold: ability?.buildupHint?.cold ?? 60 };
      if (coldTier >= 2) {
        amount += Math.floor(amount * 0.30);
        const toxicMeter  = target?.weakness?.meters?.toxic   || 0;
        const diseaseMeter = target?.weakness?.meters?.disease || 0;
        const curseMeter  = target?.weakness?.meters?.curse   || 0;
        const necFamilies = (toxicMeter > 0 ? 1 : 0) + (diseaseMeter > 0 ? 1 : 0) + (curseMeter > 0 ? 1 : 0);
        if (necFamilies >= 1) buildup.toxic   = 80;
        if (necFamilies >= 2) buildup.disease = 80;
        if (necFamilies >= 3) buildup.curse   = 80;
      }
      return { ...roll, amount, isMagic: true, element: "cold", buildup };
    },
    description: "Cold chop with 60 cold buildup; vs Frostbitten (T2) deals +30% necrotic damage and spreads necrotic buildups."
  },

  'storm_splitter': {
    id: "storm_splitter",
    name: "Storm Splitter",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["axe_2h"],
    requiredStat: "CHA",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 0,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lightning", "elemental", "buildup", "initiative"],
    emitTagsOnUse: ["chop"],
    cooldown: 3,
    buildupHint: { lightning: 70 },
    apply: (attacker, target) => {
      const ability = SKILLS?.storm_splitter;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: "lightning",
        isMagic: true,
        skipGearMultiplier: true,
      }));
      const coldTier = target?.weakness?.tiers?.cold || 0;
      if (coldTier >= 1) amount = Math.floor(amount * 1.25);
      const lightningBuildup = ability?.buildupHint?.lightning ?? 70;
      if (coldTier >= 2 && attacker) {
        const initiativeGain = Math.floor(lightningBuildup / 10);
        attacker.initiativeGauge = Math.max(0, (attacker.initiativeGauge || 0) - initiativeGain);
      }
      return { ...roll, amount, isMagic: true, element: "lightning", buildup: { lightning: lightningBuildup } };
    },
    description: "Lightning chop with 70 buildup; +25% vs chilled foes, gains 7 initiative vs Frostbitten (T2)."
  },

  'blood_frenzy': {
    id: "blood_frenzy",
    name: "Blood Frenzy",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["axe_2h"],
    requiredStat: "CON",
    requiredValue: 14,
    actionCost: "bonus",
    mpCost: 0,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["support", "mana"],
    cooldown: 3,
    conditionHint: { requiresKillThisTurn: true, requiresLacerate: true },
    apply: (attacker, _target, scene) => {
      const lacTier = scene?.killedEnemyLacerateTier || 0;
      if (!scene?.enemyDiedThisTurn || lacTier < 1) {
        return { amount: 0, log: `${attacker?.name || "The axeman"} has not fed on bleeding prey yet.` };
      }
      const mpRestored = lacTier >= 2 ? 7 : 4;
      if (attacker) {
        const maxMP = attacker?.maxMP ?? attacker?.derivedStats?.maxMP ?? 0;
        attacker.currentMP = Math.min(maxMP, (attacker.currentMP ?? 0) + mpRestored);
      }
      return {
        amount: 0,
        mpGain: mpRestored,
        log: `${attacker?.name || "The axeman"} feeds on the carnage, restoring ${mpRestored} MP.`,
      };
    },
    description: "After killing a lacerate T1 enemy: restore 4 MP. T2 enemy: restore 7 MP."
  },

  // -------- Payoff (armor shred) --------
  'overhead_hew': {
    id: "overhead_hew",
    name: "Overhead Hew",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["axe_2h"],
    requiredStat: "STR",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "debuff"],
    emitTagsOnUse: ["chop"],
    cooldown: 4,
    apply: (attacker, target) => {
      const ability = SKILLS?.overhead_hew;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      amount = Math.floor(amount * 1.15);
      const statusEffects = [{ id: "shattered_armor", turns: 3, mods: { PhysicalResist: -10 } }];
      return { ...roll, amount, statusEffects };
    },
    description: "A 115% cleaving blow that shatters armor, reducing the target's physical damage reduction by 10% for 3 turns."
  },

  // --- Mace (2h) ---
  'quake_mark': {
    id: "quake_mark",
    name: "Quake Mark",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    typedDamage: true,
    requiredWeapon: ["mace_2h"],
    requiredStat: "STR",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "disorient", "terrain"],
    emitTagsOnUse: ["smash"],
    cooldown: 3,
    buildupHint: { disorient: 80 },
    // Zone: brownish tint (element: 'physical'); enemies standing in it take
    // +50 disorient buildup at the end of their own turn, for 3 turns.
    slotEffect: {
      id: "quake_mark_zone",
      isQuakeZone: true,
      element: "physical",
      tickPctMaxHP: 0.0,
      turns: 3,
      buildupFamilies: { disorient: 50 },
    },
    apply: (attacker, target) => {
      const ability = SKILLS?.quake_mark;
      const roll = calculateDamage(attacker, target, ability);

      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 90, skillLabel: `${ability?.name || 'Skill'} weapon damage (90%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      const buildupVal = ability?.buildupHint?.disorient ?? 80;
      // Spread slotEffect from definition so buildupFamilies is preserved
      const slotEffect = ability?.slotEffect ? { ...ability.slotEffect } : undefined;
      return {
        ...roll,
        physical, elemental, necrotic, amount,
        buildup: { disorient: buildupVal },
        slotEffect,
      };
    },
    description: "Deals 90% weapon damage, smashing the ground and applying Disorient on hit. Leaves a trembling zone for 3 turns — enemies standing in it suffer +50 Disorient buildup at the end of their turn."
  },

  'ringing_blow': {
    id: "ringing_blow",
    name: "Ringing Blow",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    typedDamage: true,
    requiredWeapon: ["mace_2h"],
    requiredStat: "STR",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "disorient"],
    cooldown: 2,
    buildupHint: { disorient: 60 },
    // Was `physVulnPct` — didn't match the field CombatScene.js's
    // rewardIfTierCross consumer and the tooltip's buffToText() both actually
    // read (`physicalVulnPct`), so this debuff never applied in combat and
    // never rendered a real number in the tooltip. Renamed to match.
    // Fires on crossing EITHER threshold (Dazed or Concussed), same debuff
    // either way — same pattern as Needle Feint's crit-chance reward.
    rewardIfTierCross: [
      { family: "disorient", tier: 1, debuff: { physicalVulnPct: 15, turns: 2 } },
      { family: "disorient", tier: 2, debuff: { physicalVulnPct: 15, turns: 2 } },
    ],
    apply: (attacker, target) => {
      const ability = SKILLS?.ringing_blow;
      const roll = calculateDamage(attacker, target, ability);

      // 100% base + 20% vs a Lacerated (Bleeding+) target — additive into ONE
      // skillPct (Category A: a skill-specific reward for hitting a bleeding target).
      const lacerateTier = target?.weakness?.tiers?.lacerate || 0;
      const bonusPct = lacerateTier >= 1 ? 20 : 0;
      const basePct = 100;

      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: basePct + bonusPct,
          skillLabel: `${ability?.name || 'Skill'} weapon damage (${basePct}%${bonusPct ? ` + ${bonusPct}% vs Lacerated` : ''})`,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      return {
        ...roll,
        physical, elemental, necrotic, amount,
        buildup: { disorient: ability?.buildupHint?.disorient ?? 60 },
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
      };
    },
    description: "Deals 100% weapon damage, +20% against a Bleeding (Lacerate) target. Builds Disorient. Crossing either Disorient tier applies a physical vulnerability debuff."
  },

  'bedrock_guard': {
    id: "bedrock_guard",
    name: "Bedrock Guard",
    type: "weapon",
    mechanic: "reaction",
    versionTag: "v3.22",
    requiredWeapon: ["mace_2h"],
    requiredStat: "CON",
    requiredValue: 15,
    actionCost: "reaction",
    mpCost: 3,
    cooldown: 3,
    requiresTarget: false,
    tags: ["support", "cold"],
    reaction: {
      trigger: "self_hit",
      cooldownOn: "trigger",
      // Only trigger when hit as a SPLASH target of an AOE (not the primary
      // target) — per request, this rewards being caught in someone else's
      // blast rather than competing with single-target mitigation. Needs
      // _applyDirectResult (CombatScene.js) to emit self_hit with
      // intent.isSplash for splash hits, which it now does.
      canTrigger: ({ sourceIntent }) => !!sourceIntent?.isSplash,
      exec: ({ owner, scene, incoming }) => {
        // Zero the incoming hit directly rather than setting
        // damageReduction — that field is capped at 95% and, on the typed
        // per-component mitigation path, only ever discounts the physical
        // component (elemental/necrotic untouched) with a minimum-1-per-type
        // floor on top, so it could never actually reach true 0 damage the
        // way this skill promises. Zeroing amount/physical/elemental/
        // necrotic directly on the mutable payload sidesteps all of that.
        if (incoming) {
          incoming.amount = 0;
          incoming.physical = 0;
          incoming.elemental = 0;
          incoming.necrotic = 0;
        }
        scene?._addStatusEffects?.(owner, [{
          id: "bedrock_guard_charge",
          name: "Bedrock Guard",
          turns: 1,
          nextHitOnly: true,
          onHit: { buildup: { cold: 100 } },
        }]);
        scene?._log?.(`${owner.name} braces against the blast — the splash damage is completely negated! Their next attack carries a surge of cold.`);
      },
    },
    description: "Reaction: when you're caught in the splash of an AOE attack (not the primary target), negate that instance's damage entirely. Your next attack applies +100 Cold buildup."
  },

  'frozen_quake': {
    id: "frozen_quake",
    name: "Frozen Quake",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    typedDamage: true,
    requiredWeapon: ["mace_2h"],
    requiredStat: "WIS",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "cold", "terrain"],
    emitTagsOnUse: ["smash"],
    cooldown: 3,
    requiresWeakness: { family: "cold", tierAtLeast: 1 },
    buildupHint: { cold: 80 },
    // immobilizes: true — stub, requires CombatScene support to enforce
    slotEffect: { id: "frozen_quake_zone", isQuakeZone: true, element: "cold", tickPctMaxHP: 0.0, turns: 2, buildupFamilies: { cold: 50 }, immobilizes: true },
    apply: (attacker, target) => {
      const ability = SKILLS?.frozen_quake;
      const roll = calculateDamage(attacker, target, ability);

      // Whole hit reflavored as Cold/Elemental regardless of the weapon's own
      // physical/elemental split — matches the pre-migration element:'cold',
      // isMagic:true behavior (a magic frost attack, not a physical mace
      // swing). Declared via skillConversion so it runs at the correct pipeline
      // stage (right after skillPct, before any onHit rider/combat buff/crit
      // is added) — see project_damage_pipeline_reorder memory.
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 95, skillLabel: `${ability?.name || 'Skill'} weapon damage (95%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
          skillConversion: { physToElemPct: 100 },
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      const baseBuildup = ability?.buildupHint?.cold ?? 80;

      // Lightning synergy: if the target is ALSO already Zapped (Lightning
      // T1+) at cast time, the resulting zone additionally makes anyone
      // standing in it take +20% elemental damage — checked once here, baked
      // into the zone's own properties, not re-checked per occupant later.
      const lightningTier = target?.weakness?.tiers?.lightning || 0;
      const slotEffect = ability?.slotEffect ? {
        ...ability.slotEffect,
        ...(lightningTier >= 1 ? { elementalVulnPct: 20 } : {}),
      } : undefined;

      return {
        ...roll,
        physical, elemental, necrotic, amount,
        isMagic: true,
        element: "cold",
        buildup: { cold: baseBuildup },
        slotEffect,
      };
    },
    description: "Requires Cold T1. Deals 95% weapon damage, smashing a frost crack beneath a single foe and leaving a chilling hazard zone for 2 turns. Enemies standing in the zone are immobilized and suffer +50 Cold buildup at the end of their turn. If the target is also Zapped (Lightning T1+), the zone also makes anyone standing in it take +20% elemental damage."
  },

  'fel_chant': {
    id: "fel_chant",
    name: "Fel Chant",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["mace_2h"],
    requiredStat: "CHA",
    requiredValue: 14,
    actionCost: "bonus",
    mpCost: 3,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["support", "stance", "disease"],
    cooldown: 3,
    buildupHint: { disease: 50 },
    // guardDiseaseTierPct scales the guard % by the ATTACKER's own Disease
    // tier (25% vs Diseased/T1, 50% vs Plagued/T2) — implemented generically
    // in _processGuardStatusEffects (CombatScene.js). guardHits limits it to
    // 2 triggers before the buff is consumed.
    // Status effect id also renamed (was iron_chant) — the buff icon system
    // falls back to title-casing the id when there's no STATUS_ICON_LIBRARY
    // entry, so leaving the old id here would've still shown "Iron Chant" on
    // buffed allies even after the skill's own display name changed.
    teamBuff: { scope: "column", effect: { id: "fel_chant", turns: 1, guardDiseaseTierPct: { 1: 25, 2: 50 }, guardHits: 2, retaliateBuildup: { disease: 50 } } },
    apply: () => {
      const ability = SKILLS?.fel_chant;
      const effect = ability?.teamBuff?.effect ? {
        ...ability.teamBuff.effect,
        retaliateBuildup: { disease: ability?.buildupHint?.disease ?? 50 }
      } : undefined;
      return {
        amount: 0,
        teamBuff: effect ? { scope: "column", effect } : undefined,
      };
    },
    description: "Chant a harsh mantra, granting your rank guard against Diseased attackers: -25% damage taken from a Sickened (T1) attacker, -50% from a Plagued (T2) one. Lasts 2 hits. Attackers accrue Disease when the guard triggers."
  },

  'searing_clout': {
    id: "searing_clout",
    name: "Searing Clout",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    typedDamage: true,
    requiredWeapon: ["mace_2h"],
    requiredStat: "STR",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    // Was Staggering Clout — redundant with the mace block's several other
    // Disorient-buildup skills, and the block had no Fire skill at all.
    // Reworked to fill that gap: same 15%/30% conditional-bonus shape, now
    // keyed off Fire instead of Disorient, and the hit itself is Fire damage.
    tags: ["melee", "attack", "fire"],
    emitTagsOnUse: ["swing"],
    cooldown: 2,
    buildupHint: { fire: 70 },
    apply: (attacker, target) => {
      const ability = SKILLS?.searing_clout;
      const roll = calculateDamage(attacker, target, ability);

      // 100% base + 15%/30% at Fire T1/T2 — flat per tier (not stacking),
      // combined into ONE skillPct.
      const fireTier = target?.weakness?.tiers?.fire || 0;
      const bonusPct = fireTier >= 2 ? 30 : fireTier >= 1 ? 15 : 0;
      const basePct = 100;

      // Whole hit reflavored as Fire/Elemental regardless of the weapon's own
      // physical/elemental split — a searing mace blow, not a physical swing.
      // Declared via skillConversion, not a manual post-step — see
      // project_damage_pipeline_reorder memory for why the timing matters.
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: basePct + bonusPct,
          skillLabel: `${ability?.name || 'Skill'} weapon damage (${basePct}%${bonusPct ? ` + ${bonusPct}% Fire tier` : ''})`,
          isCrit: roll.isCrit, critMult: roll.critMult,
          skillConversion: { physToElemPct: 100 },
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      return {
        ...roll,
        physical, elemental, necrotic, amount,
        isMagic: true,
        element: "fire",
        buildup: { fire: ability?.buildupHint?.fire ?? 70 },
      };
    },
    description: "Deals 100% weapon damage, +15% against a Singed (Fire T1) target (+30% instead if Ablaze, Fire T2). Builds Fire."
  },

  // -------- Payoff --------
  'gravity_slam': {
    id: "gravity_slam",
    name: "Gravity Slam",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["mace_2h"],
    requiredStat: "STR",
    requiredValue: 17,
    actionCost: "major",
    mpCost: 0,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "finisher", "consume", "terrain"],
    emitTagsOnUse: ["smash"],
    cooldown: 3,
    // Now requires Concussed (Disorient T2) specifically, not just Dazed —
    // strong enough a payoff that it earns the steeper requirement.
    requiresWeakness: { family: "disorient", tierAtLeast: 2 },
    // Costs Initiative instead of MP now — this is the finisher of the two
    // (vs. Earthshatter, which reverted back to a normal MP cost since it's
    // too situational to also gate behind Initiative). Same flat-spend
    // pattern as Earthshatter/Blazing Fervor.
    requiresInitiativeGauge: 20,
    // Consume config for the MP drain below — no damage bonus attached to
    // this consumption (unlike Power Stab's consumeWeaknessBonus, which this
    // deliberately does NOT reuse: that field's generic tooltip text always
    // reads "+X% damage per 100 consumed," which would misdescribe this).
    consumeDisorientForDrain: { maxConsume: 400, drainPctPer100: 5 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.gravity_slam;
      const roll = calculateDamage(attacker, target, ability);

      const meter = target?.weakness?.meters?.disorient || 0;
      const intensity = weaknessIntensityMult(meter) || 1;

      // 130% base (Disorient T2 is required to even cast this now, so no
      // more tier branching) + an overflow bonus (+10% per intensity point
      // above 1.0) — Category A, combined additively. The Disorient
      // consumption below is a pure resource drain, not a damage source.
      const basePct = 130;
      const overflowPct = intensity > 1 ? Math.round((intensity - 1) * 10) : 0;
      const skillPct = basePct + overflowPct;

      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct,
          skillLabel: `${ability?.name || 'Skill'} weapon damage (${basePct}% base${overflowPct ? ` + ${overflowPct}% overflow` : ''})`,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      // Consume up to 400 Disorient buildup, draining 5% of the target's
      // CURRENT MP per 100 consumed (up to 20% at the cap) — a scaling
      // version of the skill's old flat 20% drain, now tied to how much
      // Disorient is actually available to consume.
      const cfg = ability.consumeDisorientForDrain;
      const consumed = Math.min(cfg.maxConsume, meter);
      let manaDrained = 0;
      if (consumed > 0 && target?.weakness?.meters) {
        target.weakness.meters.disorient = Math.max(0, meter - consumed);
        if (target.weakness.tiers) target.weakness.tiers.disorient = weaknessTierFromMeter(target.weakness.meters.disorient);
        const drainPct = Math.floor(consumed / 100) * cfg.drainPctPer100;
        if (drainPct > 0 && (target.currentMP || 0) > 0) {
          manaDrained = Math.floor(target.currentMP * (drainPct / 100));
          target.currentMP = Math.max(0, (target.currentMP || 0) - manaDrained);
        }
      }

      // Extend every active quake zone (Quake Mark / Frozen Quake / Plague
      // Slam / Sanctified Slam) by 1 turn.
      if (scene?.slotEffects) {
        Object.values(scene.slotEffects).forEach(zoneList => {
          if (!Array.isArray(zoneList)) return;
          zoneList.forEach(eff => {
            if (eff?.isQuakeZone && eff.turns > 0) eff.turns += 1;
          });
        });
      }

      const initiativeSpend = 20;
      attacker.initiativeGauge = Math.max(0, (attacker.initiativeGauge || 0) - initiativeSpend);

      return {
        ...roll,
        physical, elemental, necrotic, amount,
        manaDrained: manaDrained > 0 ? manaDrained : undefined,
      };
    },
    description: "Requires Concussed (Disorient T2). Deals 130% weapon damage, +10% per intensity point of overflow. Consumes up to 400 Disorient, draining 5% of the target's current MP per 100 consumed (up to 20%). Extends every active quake zone by 1 turn. Spends 20 Initiative."
  },

  'miasma_crush': {
    id: "miasma_crush",
    name: "Miasma Crush",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    typedDamage: true,
    requiredWeapon: ["mace_2h"],
    requiredStat: "WIS",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "disease", "proliferate"],
    emitTagsOnUse: ["smash"],
    cooldown: 3,
    requiresWeakness: { family: "disease", tierAtLeast: 2 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.miasma_crush;
      const roll = calculateDamage(attacker, target, ability);

      const meter = target?.weakness?.meters?.disease || 0;
      const tier = target?.weakness?.tiers?.disease || 0;
      const intensity = weaknessIntensityMult(meter) || 1;
      // Disease overflow amplifies the hit; base 15% per tier, plus intensity overflow
      const tierPct = 15 * tier;
      const overflowPct = Math.max(0, intensity - 1) * 15;
      const skillPct = 100 + tierPct + overflowPct;

      // Force necrotic typing regardless of the weapon's own physical/elemental
      // split — this is a rotting/necrotic crush, not a physical mace swing.
      // Both physToNecroPct and elemToNecroPct declared so BOTH the physical
      // base AND any weapon elemental flat end up necrotic — see
      // project_damage_pipeline_reorder memory for why this runs as
      // skillConversion rather than a manual post-step.
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct,
          skillLabel: `${ability?.name || 'Skill'} weapon damage (100% + ${tierPct}% Disease tier + ${Math.round(overflowPct)}% overflow)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
          skillConversion: { physToNecroPct: 100, elemToNecroPct: 100 },
        }
      );

      // Spread 50% of disease meter to up to 2 adjacent (movement-range-1)
      // neighbors — uses the same grid-adjacency system player movement and
      // other skills' "adjacent" AOE shape use, not same-column.
      const spreadMeta = [];
      if (scene && target) {
        const neighbors = resolveAOESplash(scene, target, { shape: 'adjacent' });
        const transfer = meter > 0 ? Math.max(20, Math.floor(meter * 0.5)) : 0;
        neighbors.slice(0, 2).forEach(char => {
          if (!char) return;
          char.weakness = char.weakness || { meters: {}, tiers: {} };
          char.weakness.meters = char.weakness.meters || {};
          char.weakness.tiers = char.weakness.tiers || {};
          char.weakness.meters.disease = (char.weakness.meters.disease || 0) + transfer;
          char.weakness.tiers.disease = weaknessTierFromMeter(char.weakness.meters.disease);
          spreadMeta.push({ targetId: char.id || char.name, family: "disease", amount: transfer });
        });
      }

      // Clear disease on the target
      if (target?.weakness?.meters) {
        target.weakness.meters.disease = 0;
        if (target.weakness.tiers) target.weakness.tiers.disease = weaknessTierFromMeter(0);
      }

      const finalAmount = Math.max(1, necrotic);
      return {
        ...roll,
        physical: 0,
        elemental: 0,
        necrotic: finalAmount,
        amount: finalAmount,
        proliferatedWeakness: spreadMeta.length ? spreadMeta : undefined,
      };
    },
    description: "Requires Disease T2. Deals 100% weapon damage (+15% per Disease tier, plus overflow), converting the entire hit to Necrotic damage. Spreads 50% of the target's Disease meter to up to 2 adjacent enemies before clearing it."
  },

  'fault_line': {
    id: "fault_line",
    name: "Fault Line",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["mace_2h"],
    requiredStat: "STR",
    requiredValue: 18,
    actionCost: "major",
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "terrain"],
    emitTagsOnUse: ["smash"],
    cooldown: 4,
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.fault_line;
      const roll = calculateDamage(attacker, target, ability);

      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 100, skillLabel: `${ability?.name || 'Skill'} weapon damage (100%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      // If the target is standing in any active quake zone, copy every zone
      // effect there (with its CURRENT remaining turns, not reset) onto a
      // random adjacent enemy's tile, WITHOUT clearing the original — then
      // trigger both tiles' zone effects at once, without consuming any of
      // their remaining duration (same skipTurnDecrement mechanism Tremor
      // Echo/Earthshatter use). No-ops if the target isn't in a zone; the
      // hit itself always lands regardless.
      let copiedTo = null;
      const targetSlotKey = scene?._charSlotKey?.(target);
      const targetZones = targetSlotKey != null ? (scene?.slotEffects?.[targetSlotKey] || []) : [];
      const quakeZonesOnTarget = targetZones.filter(eff => eff?.isQuakeZone && (eff.turns || 0) > 0);

      if (quakeZonesOnTarget.length && scene) {
        const adjacentEnemies = resolveAOESplash(scene, target, { shape: 'adjacent' });
        if (adjacentEnemies.length) {
          const pick = adjacentEnemies[Math.floor(Math.random() * adjacentEnemies.length)];
          const pickSlotKey = scene._charSlotKey?.(pick);
          if (pickSlotKey != null) {
            scene.slotEffects[pickSlotKey] = scene.slotEffects[pickSlotKey] || [];
            quakeZonesOnTarget.forEach(eff => {
              scene.slotEffects[pickSlotKey].push({ ...eff });
            });
            scene._refreshGroundSprites?.(pickSlotKey);
            copiedTo = pick;
          }
        }

        scene._applySlotEffectsTick?.(target, { skipTurnDecrement: true });
        if (copiedTo) scene._applySlotEffectsTick?.(copiedTo, { skipTurnDecrement: true });
      }

      return {
        ...roll,
        physical, elemental, necrotic, amount,
        log: copiedTo
          ? `${attacker?.name || "The warrior"}'s blow splits the ground, copying the quake to ${copiedTo.name}.`
          : undefined,
      };
    },
    description: "Deals 100% weapon damage. If the target is standing in a quake zone, copies every active zone effect there (with its current remaining duration) onto a random adjacent enemy's tile without clearing the original, then triggers both tiles' zone effects at once — without consuming any of their remaining duration."
  },

  'bell_ringer': {
    id: "bell_ringer",
    name: "Bell Ringer",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["mace_2h"],
    requiredStat: "CON",
    requiredValue: 17,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack"],
    emitTagsOnUse: ["smash"],
    cooldown: 3,
    // Genuine dual gate now — BOTH must be true to even cast. (The old
    // conditionHint claimed this was already enforced, but conditionHint is
    // never read anywhere in src/ and the actual check only required
    // Disorient; removed as dead weight.)
    requiresWeakness: [
      { family: "disorient", tierAtLeast: 1 },
      { family: "expose", tierAtLeast: 1 },
    ],
    statusEffects: [{ id: "bell_ringer_concuss", turns: 2, mods: { Initiative: -15, speedDownPct: 12 } }],
    apply: (attacker, target) => {
      const ability = SKILLS?.bell_ringer;
      const roll = calculateDamage(attacker, target, ability);

      const disorientTier = target?.weakness?.tiers?.disorient || 0;
      const disorientMeter = target?.weakness?.meters?.disorient || 0;
      const disorientIntensity = weaknessIntensityMult(disorientMeter) || 1;

      const exposeTier = target?.weakness?.tiers?.expose || 0;
      const exposeMeter = target?.weakness?.meters?.expose || 0;
      const exposeIntensity = weaknessIntensityMult(exposeMeter) || 1;

      // Damage scales with Disorient alone — both requirements are already
      // guaranteed by requiresWeakness above, so no AND-check needed here,
      // just Disorient's own tier/intensity. 100% base + 8%/tier + 10%/
      // intensity-overflow, Category A, combined additively into ONE skillPct.
      const disorientTierPct = 8 * disorientTier;
      const disorientOverflowPct = Math.max(0, disorientIntensity - 1) * 10;
      const skillPct = 100 + disorientTierPct + disorientOverflowPct;

      // Crit multiplier scales with Expose instead — a separate, skill-own
      // bonus stacked on top of the universal Expose T2 crit chance/damage
      // system (applyExposeCritBonuses, CombatLogic.js) that already applies
      // to every attack in the game regardless of this skill. 15%/tier +
      // 10%/intensity-overflow, using Expose's own numbers.
      const exposeTierPct = 15 * exposeTier;
      const exposeOverflowPct = Math.max(0, exposeIntensity - 1) * 10;
      const critMultBonusPct = exposeTierPct + exposeOverflowPct;
      const boostedCritMult = (roll.critMult || 1.5) * (1 + critMultBonusPct / 100);

      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct,
          skillLabel: `${ability?.name || 'Skill'} weapon damage (100%${disorientTierPct ? ` + ${disorientTierPct}% Disorient tier` : ''}${disorientOverflowPct ? ` + ${Math.round(disorientOverflowPct)}% overflow` : ''})`,
          isCrit: roll.isCrit, critMult: boostedCritMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      const statusEffects = Array.isArray(ability?.statusEffects)
        ? ability.statusEffects.map(effect => ({ ...effect }))
        : [];

      // On crit: the target takes +50% Disorient buildup for 1 turn — a
      // reward for landing the crit, distinct from Gravity Slam's own
      // Disorient-finisher identity (this doesn't consume any buildup at
      // all, just a temporary incoming-buildup vulnerability).
      if (roll.isCrit) {
        statusEffects.push({ id: "bell_ringer_rattled", turns: 1, disorientBuildupMul: 1.5 });
      }

      return {
        ...roll,
        physical, elemental, necrotic, amount,
        statusEffects: statusEffects.length ? statusEffects : undefined,
      };
    },
    description: "Requires Disorient T1+ and Expose T1+. Deals 100% weapon damage, +8% per Disorient tier, plus overflow. Crit multiplier is separately boosted +15% per Expose tier, plus overflow — on top of the universal Expose T2 crit bonus every attack already gets. If this hit crits, the target also takes +50% Disorient buildup for 1 turn. Applies an Initiative/speed penalty debuff."
  },

  'boulder_toss': {
    id: "boulder_toss",
    name: "Boulder Toss",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    typedDamage: true,
    requiredWeapon: ["mace_2h"],
    requiredStat: "STR",
    requiredValue: 16,
    actionCost: ["major", "bonus"],
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["attack", "blunt"],
    emitTagsOnUse: ["throw"],
    cooldown: 3,
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.boulder_toss;
      const roll = calculateDamage(attacker, target, ability);

      const coldTier = target?.weakness?.tiers?.cold || 0;
      const lightningTier = target?.weakness?.tiers?.lightning || 0;
      const fireTier = target?.weakness?.tiers?.fire || 0;

      // 125% base + 15% per elemental tier reached, SUMMED across all three
      // families (up to 2 each, 6 total) rather than just the highest single
      // family — a target Chilled+Zapped+Ablaze all at once now stacks all
      // three instead of only counting whichever is highest.
      const elemTier = coldTier + lightningTier + fireTier;
      const elemPct = 15 * elemTier;

      // Ablaze (Fire T2): the hit's physical component converts to Elemental
      // — physical→elemental is a valid one-way conversion. Declared via
      // skillConversion (only when Ablaze) so it runs at the correct pipeline
      // stage — right after skillPct, before any onHit rider/combat buff/
      // crit gets added — see project_damage_pipeline_reorder memory.
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 125 + elemPct,
          skillLabel: `${ability?.name || 'Skill'} weapon damage (125%${elemPct ? ` + ${elemPct}% elemental tier` : ''})`,
          isCrit: roll.isCrit, critMult: roll.critMult,
          skillConversion: fireTier >= 2 ? { physToElemPct: 100 } : undefined,
        }
      );

      const amount = Math.max(1, physical + elemental + necrotic);

      // Frostbitten (Cold T2): this hit ignores the target's Evasion
      // entirely — a per-cast override (resultMutable.autoHit), not a
      // permanent flag on the shared ability.
      const autoHit = coldTier >= 2 ? true : undefined;

      // Shocked (Lightning T2): 50% chance to repeat the hit at 50% damage,
      // capped at one repeat. Uses the same generic repeatChance/repeatScale
      // mechanism Hex Stitch/Static Prick/Flash Overload use (previously
      // this rolled its own chance here and manually pushed a same-target
      // splash entry — which meant it displayed as "(splash)" in the log/
      // tooltip instead of reading as a genuine repeat like every other
      // lightning skill's does).
      const repeatChance = lightningTier >= 2 ? 0.5 : 0;

      // All three (Ablaze/Frostbitten/Shocked) can apply together if the
      // target carries all three weaknesses at once. No longer an AOE — this
      // hits only the primary target (plus its own Shocked repeat above).
      return {
        ...roll,
        physical, elemental, necrotic, amount,
        autoHit,
        repeatChance,
        repeatScale: 0.5,
      };
    },
    description: "Hurl a boulder at a single enemy for 125% damage, +15% per elemental weakness tier reached, summed across Cold/Lightning/Fire (up to +90% at all 6 tiers). If Ablaze (Fire T2), the hit's physical damage converts to Elemental. If Frostbitten (Cold T2), the hit cannot miss. If Shocked (Lightning T2), 50% chance to repeat the hit at 50% damage (max once)."
  },

  'sacred_shockwave': {
    id: "sacred_shockwave",
    name: "Sacred Shockwave",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["mace_2h"],
    requiredStat: "CHA",
    requiredValue: 17,
    actionCost: "major",
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["attack", "holy", "aoe", "support"],
    emitTagsOnUse: ["smash"],
    cooldown: 4,
    // Diamond: fixed slots {2,4,5,7} — the four centre positions. Cannot be moved.
    aoe: { shape: "diamond" },
    // Since the diamond AOE is an absolute fixed pattern (not relative to
    // whoever you target), the primary target selection itself is restricted
    // to those same 4 slots — targeting someone outside the diamond would
    // otherwise be a valid-looking selection that doesn't actually align
    // with what the AOE hits. Enforced generically via the existing
    // targetSlots filter in CombatScene's targeting logic.
    targetSlots: [2, 4, 5, 7],
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.sacred_shockwave;
      const roll = calculateDamage(attacker, target, ability);

      // Flat 25% weapon damage to every enemy in the diamond — this is a
      // utility/support hit, not a nuke, per dev notes. Shared typed baseline
      // computed once, applied uniformly to every victim (no per-victim scaling).
      const { physical: baseP, elemental: baseE, necrotic: baseN } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 25, skillLabel: `${ability?.name || 'Skill'} weapon damage (25%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, baseP + baseE + baseN);

      let totalDisorientCleared = 0;
      let totalToxicDiseaseCleared = 0;

      // Hit an enemy: clear Disorient/Toxic/Disease, tally the cleared meter
      // amounts (for ally healing) and the cleared tiers (for the enemy's own
      // damage-dealt debuff), then apply that debuff.
      const hitAndClear = (victim) => {
        if (!victim) return;
        const w = victim.weakness;
        const disorientMeter = w?.meters?.disorient || 0;
        const toxicMeter = w?.meters?.toxic || 0;
        const diseaseMeter = w?.meters?.disease || 0;
        const tierSum = (w?.tiers?.disorient || 0) + (w?.tiers?.toxic || 0) + (w?.tiers?.disease || 0);

        totalDisorientCleared += disorientMeter;
        totalToxicDiseaseCleared += toxicMeter + diseaseMeter;

        if (w?.meters) {
          w.meters.disorient = 0;
          w.meters.toxic = 0;
          w.meters.disease = 0;
          if (w.tiers) {
            w.tiers.disorient = weaknessTierFromMeter(0);
            w.tiers.toxic = weaknessTierFromMeter(0);
            w.tiers.disease = weaknessTierFromMeter(0);
          }
        }

        // -5% damage dealt per tier cleared (summed across all three
        // families, so max 3 families x T2 x 5% = -30% cap), 2-turn debuff.
        const weakenPct = Math.min(30, tierSum * 5);
        if (weakenPct > 0) {
          scene?._addStatusEffects?.(victim, [{ id: "sacred_shockwave_weakened", turns: 2, mods: { AttackPower: -weakenPct } }]);
        }
      };

      hitAndClear(target);

      // Diamond AOE: fixed slots {2,4,5,7} via aoeResolver. Every victim takes
      // the SAME flat baseline (no per-victim scaling), so the splash entries
      // carry the identical physical/elemental/necrotic breakdown as the
      // primary hit — lets _resolveMitigation mitigate each victim's own
      // PDR/EDR/NDR correctly instead of collapsing to a single isMagic flag.
      const splashChars = resolveAOESplash(scene, target, ability?.aoe);
      const splash = splashChars.map(char => {
        hitAndClear(char);
        return { target: char, amount, physical: baseP, elemental: baseE, necrotic: baseN, tags: ability?.tags };
      });

      // Heal allies: 1 MP per 50 total Disorient cleared, 1 HP per 50 total
      // Toxic+Disease cleared — summed across every enemy hit. Finer
      // 50-point breakpoints (rather than 100) so less cleared buildup goes
      // "wasted" with no reward before crossing the next threshold.
      // NOTE: attacker.team is a STRING ('ally'/'enemy'), not an array of
      // teammates — calling .forEach on it throws, which used to get caught
      // by CombatScene's ability-apply try/catch and logged as "fizzled,"
      // discarding the damage that had already been computed above. The
      // correct way to enumerate the attacker's own side is via
      // scene.allySlots/enemySlots, same pattern every other skill in this
      // file already uses.
      let healedAllies;
      const healMP = Math.floor(totalDisorientCleared / 50);
      const healHP = Math.floor(totalToxicDiseaseCleared / 50);
      const ownSlots = attacker?.isEnemy ? scene?.enemySlots : scene?.allySlots;
      const ownTeam = (ownSlots || [])
        .map(s => s?.char)
        .filter(c => c && c.status !== 'incapacitated');
      if (ownTeam.length && (healMP > 0 || healHP > 0)) {
        healedAllies = [];
        ownTeam.forEach(ally => {
          if (!ally) return;
          const maxHP = ally.maxHP ?? ally.derivedStats?.maxHP ?? 0;
          const maxMP = ally.maxMP ?? ally.derivedStats?.maxMP ?? 0;
          const hpBefore = ally.currentHP ?? 0;
          const mpBefore = ally.currentMP ?? 0;
          const hpAfter = maxHP > 0 ? Math.min(maxHP, hpBefore + healHP) : hpBefore;
          const mpAfter = maxMP > 0 ? Math.min(maxMP, mpBefore + healMP) : mpBefore;
          ally.currentHP = hpAfter;
          ally.currentMP = mpAfter;
          healedAllies.push({ id: ally.id || ally.name, healedHP: hpAfter - hpBefore, healedMP: mpAfter - mpBefore });
        });
      }

      return {
        ...roll,
        physical: baseP, elemental: baseE, necrotic: baseN, amount,
        splash: splash.length ? splash : undefined,
        healedAllies: healedAllies && healedAllies.length ? healedAllies : undefined,
      };
    },
    description: "Deals 25% weapon damage to every enemy in the formation's diamond (slots 2,4,5,7), clearing their Disorient, Toxic, and Disease buildup. Each enemy hit takes a 2-turn damage-dealt debuff, -5% per tier cleared (max -30%). Allies gain 1 MP per 50 total Disorient cleared and 1 HP per 50 total Toxic+Disease cleared."
  },

  'earthen_tempest': {
    id: "earthen_tempest",
    name: "Earthen Tempest",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["mace_2h"],
    requiredStat: "WIS",
    requiredValue: 17,
    actionCost: "major",
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["attack", "aoe", "proliferate", "disorient"],
    emitTagsOnUse: ["swing"],
    cooldown: 4,
    requiresWeakness: { family: "disorient", tierAtLeast: 1 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.earthen_tempest;
      const roll = calculateDamage(attacker, target, ability);

      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 95, skillLabel: `${ability?.name || 'Skill'} weapon damage (95%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      const sourceMeter = target?.weakness?.meters?.disorient || 0;
      const sourceTier = target?.weakness?.tiers?.disorient || 0;
      const spreadMeta = [];

      // Gather all eligible enemies (excluding the main target)
      const allEnemies = [];
      if (scene) {
        const sideSlots = target?.isEnemy ? scene.enemySlots : scene.allySlots;
        if (sideSlots) {
          sideSlots.forEach(slot => {
            if (slot?.char && slot.char !== target && slot.char.status !== "incapacitated") {
              allEnemies.push(slot.char);
            }
          });
        }
      }

      // Randomly select up to 3 enemies to receive the Disorient spread
      const shuffled = allEnemies.sort(() => Math.random() - 0.5);
      shuffled.slice(0, 3).forEach(char => {
        if (!char) return;
        char.weakness = char.weakness || { meters: {}, tiers: {} };
        char.weakness.meters = char.weakness.meters || {};
        char.weakness.tiers = char.weakness.tiers || {};
        // Copy disorient meter
        char.weakness.meters.disorient = (char.weakness.meters.disorient || 0) + sourceMeter;
        char.weakness.tiers.disorient = weaknessTierFromMeter(char.weakness.meters.disorient);
        spreadMeta.push({ targetId: char.id || char.name, family: "disorient", amount: sourceMeter });
        // T2 disorient on source: also spread elemental weaknesses (cold, lightning, fire)
        if (sourceTier >= 2) {
          for (const fam of ["cold", "lightning", "fire"]) {
            const elemMeter = target?.weakness?.meters?.[fam] || 0;
            if (elemMeter > 0) {
              char.weakness.meters[fam] = (char.weakness.meters[fam] || 0) + elemMeter;
              char.weakness.tiers[fam] = weaknessTierFromMeter(char.weakness.meters[fam]);
              spreadMeta.push({ targetId: char.id || char.name, family: fam, amount: elemMeter });
            }
          }
        }
      });

      // Do NOT clear the main target's disorient — the gale copies, not transfers

      return {
        ...roll,
        physical, elemental, necrotic, amount,
        proliferatedWeakness: spreadMeta.length ? spreadMeta : undefined,
      };
    },
    description: "Requires Disorient T1. Deals 95% weapon damage, whipping up an earthen gale that copies the target's Disorient meter to 3 random enemies. At T2, also copies any Cold/Fire/Lightning weakness. Does not clear the source."
  },

  'bonecrusher': {
    id: "bonecrusher",
    name: "Bonecrusher",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["mace_2h"],
    requiredStat: "STR",
    requiredValue: 10,
    actionCost: "major",
    mpCost: 0,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "blunt", "disorient"],
    cooldown: 2,
    // Was 310 — a stray leftover test value (every other mace skill's
    // buildupHint sits in the 40-100 range, and this is the free/basic-tier
    // poke, so it should be at the low end, not far above the paid skills).
    buildupHint: { disorient: 40 },
    apply: (attacker, target) => {
      const ability = SKILLS?.bonecrusher;
      const roll = calculateDamage(attacker, target, ability);

      // Rewards each physical weakness family the target already carries —
      // +30% for Bleeding (Lacerate T1+), +30% for Raw (Expose T1+), +30%
      // for Dazed (Disorient T1+). Combines additively into ONE skillPct
      // (Category A bonuses), so a target weak from all three sits at
      // 100% + 30% + 30% + 30% = 190% weapon damage.
      const tiers = target?.weakness?.tiers || {};
      let skillPct = 100;
      if ((tiers.lacerate | 0) >= 1) skillPct += 30;
      if ((tiers.expose | 0) >= 1) skillPct += 30;
      if ((tiers.disorient | 0) >= 1) skillPct += 30;

      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct, skillLabel: `${ability?.name || 'Skill'} weapon damage (${skillPct}%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return {
        ...roll,
        physical, elemental, necrotic, amount,
        buildup: { disorient: ability?.buildupHint?.disorient ?? 40 },
      };
    },
    description: "Deals 100% weapon damage, +30% each against a Bleeding (Lacerate), Raw (Expose), or Dazed (Disorient) target — up to 190% against a foe weak from all three. Builds Disorient."
  },

  'plague_slam': {
    id: "plague_slam",
    name: "Plague Slam",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["mace_2h"],
    requiredStat: "STR",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "disease", "terrain"],
    emitTagsOnUse: ["smash"],
    cooldown: 3,
    buildupHint: { disease: 80 },
    // Zone: enemies standing in it take +50 Disease buildup at the end of
    // their own turn, for 3 turns — same shape as Quake Mark's zone, just
    // Disease-flavored instead of Disorient. Additionally, if an occupant is
    // Ablaze (Fire T2) at the moment the zone ticks, they combust for Fire
    // damage = 2 per 100 CURRENT Disease, scaled by their current Fire
    // intensity — read live at trigger time (see _zoneFireBurnPreview,
    // CombatScene.js). Entirely separate from Ablaze's own standalone
    // end-of-turn weakness DOT, which this doesn't touch.
    slotEffect: {
      id: "plague_quake_zone",
      isQuakeZone: true,
      element: "disease",
      tickPctMaxHP: 0.0,
      turns: 3,
      buildupFamilies: { disease: 50 },
      fireBurnProc: { perHundredDisease: 2 },
    },
    apply: (attacker, target) => {
      const ability = SKILLS?.plague_slam;
      const roll = calculateDamage(attacker, target, ability);

      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 90, skillLabel: `${ability?.name || 'Skill'} weapon damage (90%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      const buildupVal = ability?.buildupHint?.disease ?? 80;
      const slotEffect = ability?.slotEffect ? { ...ability.slotEffect } : undefined;
      return {
        ...roll,
        physical, elemental, necrotic, amount,
        buildup: { disease: buildupVal },
        slotEffect,
      };
    },
    description: "Deals 90% weapon damage, smashing the ground and applying Disease on hit. Leaves a festering zone for 3 turns — enemies standing in it suffer +50 Disease buildup at the end of their turn. If an occupant is Ablaze (Fire T2), they also combust for 2 per 100 Disease buildup, scaled by their Fire intensity — read live when the zone triggers."
  },

  'earthshatter': {
    id: "earthshatter",
    name: "Earthshatter",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    requiredWeapon: ["mace_2h"],
    requiredStat: "STR",
    requiredValue: 16,
    actionCost: "major",
    // Reverted back to a normal MP cost — too situational (needs the target
    // already standing in a zone) to also gate behind Initiative; that
    // resource instead went to Gravity Slam, which is more of a reliable
    // finisher.
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["support", "terrain", "finisher"],
    cooldown: 3,
    apply: (attacker, target, scene) => {
      const slotKey = scene?._charSlotKey?.(target);
      const hasZone = slotKey != null && (scene?.slotEffects?.[slotKey]?.length > 0);
      if (!hasZone) {
        return { fizzle: true, log: `${attacker?.name || "The warrior"} finds no active quake zone beneath ${target?.name || "the target"}.` };
      }

      // Repeatedly trigger every zone stacked on the target's tile (same
      // skipTurnDecrement mechanism Tremor Echo uses — doesn't consume any
      // zone's remaining duration) as long as the LAST pass pushed the
      // target across at least one weakness tier boundary (0→T1 or T1→T2,
      // any family). Weakness tiers cap at 2, so a pass eventually MUST
      // produce zero new crossings — MAX_TICKS is just a defensive backstop.
      let ticks = 0;
      const MAX_TICKS = 10;
      while (ticks < MAX_TICKS) {
        if (target.status === 'incapacitated') break;
        const before = { ...(target.weakness?.tiers || {}) };
        scene._applySlotEffectsTick?.(target, { skipTurnDecrement: true });
        ticks++;
        const after = target.weakness?.tiers || {};
        const crossed = Object.keys(after).some(fam => (after[fam] | 0) > (before[fam] | 0));
        if (!crossed) break;
      }

      return {
        amount: 0,
        log: `${attacker?.name || "The warrior"} shatters the earth beneath ${target?.name || "the target"}, chaining ${ticks} quake tick${ticks === 1 ? "" : "s"}.`,
      };
    },
    description: "Requires the target to already be standing in an active quake zone (fizzles otherwise). Triggers every zone stacked on the target's tile without consuming their remaining duration. If this pushes the target across a weakness tier (any family), the zones trigger again — repeating until a pass causes no new tier crossings. Deals no weapon damage."
  },

  'sanctified_slam': {
    id: "sanctified_slam",
    name: "Sanctified Slam",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    typedDamage: true,
    requiredWeapon: ["mace_2h"],
    requiredStat: "WIS",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lightning", "holy", "terrain"],
    cooldown: 2,
    buildupHint: { lightning: 40 },
    // Zone spawned only if target has lightning t1+: yellow tint, attackers hitting enemies in it gain 2 MP
    slotEffect: {
      id: "sanctified_quake_zone",
      isQuakeZone: true,
      element: "lightning",
      tickPctMaxHP: 0.0,
      turns: 2,
      onHitMpGain: 2,
    },
    apply: (attacker, target) => {
      const ability = SKILLS?.sanctified_slam;
      const roll = calculateDamage(attacker, target, ability);

      // 100% base + 15% vs a zapped (Lightning T1+) target.
      const lightningTier = target?.weakness?.tiers?.lightning || 0;
      const bonusPct = lightningTier >= 1 ? 15 : 0;

      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 100 + bonusPct,
          skillLabel: `${ability?.name || 'Skill'} weapon damage (100%${bonusPct ? ` + ${bonusPct}% vs Lightning` : ''})`,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      // Only drop the zone if target already has lightning weakness t1+
      const slotEffect = (lightningTier >= 1 && ability?.slotEffect)
        ? { ...ability.slotEffect }
        : undefined;
      return {
        ...roll,
        physical, elemental, necrotic, amount,
        buildup: { lightning: ability?.buildupHint?.lightning ?? 40 },
        slotEffect,
      };
    },
    description: "Deals 100% weapon damage, +15% against a Zapped (Lightning T1+) target. If the target has Lightning weakness (T1+), consecrates the tile for 2 turns — attackers hitting enemies on it gain 2 MP per strike."
  },

  'tremor_echo': {
    id: "tremor_echo",
    name: "Tremor Echo",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["mace_2h"],
    requiredStat: "STR",
    requiredValue: 14,
    actionCost: "bonus",
    mpCost: 0,
    requiresTarget: false,
    tags: ["support", "terrain"],
    cooldown: 2,
    // Reworked into a pure MP-support skill — no longer deals weapon damage
    // or requires a target. Triggers every active quake-family zone's own
    // effect (damage/buildup/vuln) on whoever's actually standing in it,
    // WITHOUT consuming any of the zone's remaining duration (see
    // _applySlotEffectsTick's skipTurnDecrement option), then restores 5 MP
    // per DISTINCT enemy caught in any zone — a unit in two zones at once
    // still only counts once, and unoccupied zones (or zones with only
    // allies in them) trigger their effect but grant no MP.
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.tremor_echo;

      const activeZoneKeys = Object.keys(scene?.slotEffects || {}).filter(key =>
        (scene.slotEffects[key] || []).some(eff => eff?.isQuakeZone && (eff.turns || 0) > 0)
      );

      if (!activeZoneKeys.length) {
        return { fizzle: true, log: `${attacker?.name || "The warrior"} finds no active quake zones to draw on.` };
      }

      const allUnits = (scene?.turnOrder || [])
        .filter(u => u && u.status !== "incapacitated");
      const enemiesHit = new Set();

      activeZoneKeys.forEach(key => {
        const occupant = allUnits.find(u => scene._charSlotKey?.(u) === key);
        if (!occupant) return;
        scene._applySlotEffectsTick?.(occupant, { skipTurnDecrement: true });
        if (!!occupant.isEnemy !== !!attacker?.isEnemy) enemiesHit.add(occupant);
      });

      const mpGain = enemiesHit.size * 5;
      if (mpGain > 0 && attacker) {
        const maxMP = attacker.maxMP ?? 0;
        attacker.currentMP = Math.min(maxMP, (attacker.currentMP || 0) + mpGain);
      }

      return {
        amount: 0,
        log: mpGain > 0
          ? `${attacker?.name || "The warrior"} draws on ${enemiesHit.size} enem${enemiesHit.size === 1 ? "y" : "ies"} caught in active quake zones, restoring ${mpGain} MP.`
          : `${attacker?.name || "The warrior"} triggers the active quake zones, but no enemies are caught in them.`,
      };
    },
    description: "Requires at least one active Quake zone. Triggers the effect of every active Quake zone on whoever's standing in it, without using up any of their remaining duration. Restores 5 MP per distinct enemy caught in a zone."
  },

  'concussive_drain': {
    id: "concussive_drain",
    name: "Concussive Drain",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["mace_2h"],
    requiredStat: "STR",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "disorient"],
    emitTagsOnUse: ["smash"],
    cooldown: 2,
    buildupHint: { disorient: 80 },
    // Restores MP on crossing Disorient tier thresholds — healMP handled by rewardIfTierCross pipeline
    rewardIfTierCross: [
      { family: "disorient", tier: 1, healMP: 2 },
      { family: "disorient", tier: 2, healMP: 4 },
    ],
    apply: (attacker, target) => {
      const ability = SKILLS?.concussive_drain;
      const roll = calculateDamage(attacker, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 100, skillLabel: `${ability?.name || 'Skill'} weapon damage (100%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return {
        ...roll,
        physical, elemental, necrotic, amount,
        buildup: { disorient: ability?.buildupHint?.disorient ?? 80 },
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
      };
    },
    description: "Deals 100% weapon damage, saps mental coherence. Restores 2 MP on pushing a foe to Disorient T1, and 4 MP on T2 (both fire if a single hit skips straight past T1)."
  },

  // --- Spear (1h) ---
  'grounding_pierce': {
    id: "grounding_pierce",
    name: "Grounding Pierce",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["spear_1h"],
    requiredStat: "WIS",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 0,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lightning"],
    cooldown: 2,
    buildupHint: { lightning: 40 },
    apply: (attacker, target) => {
      const ability = SKILLS?.grounding_pierce;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: "lightning",
        isMagic: true,
        skipGearMultiplier: true,
      }));
      const lightningTier = target?.weakness?.tiers?.lightning || 0;
      if (lightningTier === 2) {
        const statusEffects = [{ id: "stunned", turns: 1 }];
        return {
          ...roll,
          amount,
          element: "lightning",
          isMagic: true,
          consumeWeakness: ["lightning"],
          statusEffects,
        };
      }
      return {
        ...roll,
        amount,
        element: "lightning",
        isMagic: true,
        buildup: { lightning: ability?.buildupHint?.lightning ?? 40 },
      };
    },
    description: "Pins current through the foe; fully charged targets are stunned and discharged."
  },

  'glacial_thrust': {
    id: "glacial_thrust",
    name: "Glacial Thrust",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["spear_1h"],
    requiredStat: "DEX",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 0,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "cold"],
    cooldown: 1,
    buildupHint: { cold: 50 },
    rewardIfTierCross: [{ family: "cold", tier: 2, healHPpct: 0.03 }],
    apply: (attacker, target) => {
      const ability = SKILLS?.glacial_thrust;
      const roll = calculateDamage(attacker, target, ability);
      const amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: "cold",
        isMagic: true,
        skipGearMultiplier: true,
      }));
      return {
        ...roll,
        amount,
        isMagic: true,
        element: "cold",
        buildup: { cold: ability?.buildupHint?.cold ?? 50 },
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
      };
    },
    description: "Cold-driven thrust that rewards you for freezing the enemy."
  },

  // --- Sling (1h) v3.21 surplus — superseded by v3.22 section above ---
  /*
  'rebounding_shot_SURPLUS': {
    id: "rebounding_shot",
    name: "Rebounding Shot",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sling"],
    requiredStat: "DEX",
    requiredValue: 20,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "bounce"],
    cooldown: 4,
    apply: (attacker, target) => {
      const ability = SKILLS?.rebounding_shot;
      const roll = calculateDamage(attacker, target, ability);
      const amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      return { ...roll, amount, bounce: true };
    },
    description: "Hits one enemy, then bounces to another."
  },

  'searing_pitch': {
    id: "searing_pitch",
    name: "Searing Pitch",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sling"],
    requiredStat: "INT",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 0,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "fire"],
    cooldown: 2,
    buildupHint: { fire: 60 },
    apply: (attacker, target) => {
      const ability = SKILLS?.searing_pitch;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: "fire",
        isMagic: true,
        skipGearMultiplier: true,
      }));
      const coldTier = target?.weakness?.tiers?.cold || 0;
      let fireBuildup = ability?.buildupHint?.fire ?? 60;
      if (coldTier >= 1) {
        amount = Math.floor(amount * 1.2);
        fireBuildup += 20;
      }
      return {
        ...roll,
        amount,
        isMagic: true,
        element: "fire",
        buildup: { fire: fireBuildup },
      };
    },
    description: "Sticky, burning shot. Extra scorch on chilled foes."
  },

  'frost_pebble': {
    id: "frost_pebble",
    name: "Frost Pebble",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sling"],
    requiredStat: "WIS",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 0,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "cold"],
    cooldown: 1,
    buildupHint: { cold: 50 },
    apply: (attacker, target) => {
      const ability = SKILLS?.frost_pebble;
      const roll = calculateDamage(attacker, target, ability);
      const amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: "cold",
        isMagic: true,
        skipGearMultiplier: true,
      }));
      return {
        ...roll,
        amount,
        isMagic: true,
        element: "cold",
        buildup: { cold: ability?.buildupHint?.cold ?? 50 },
      };
    },
    description: "A chilling lob that builds Cold."
  },

  'thunder_skip': {
    id: "thunder_skip",
    name: "Thunder Skip",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sling"],
    requiredStat: "DEX",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 0,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "lightning", "bounce"],
    cooldown: 2,
    buildupHint: { lightning: 60 },
    apply: (attacker, target) => {
      const ability = SKILLS?.thunder_skip;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: "lightning",
        isMagic: true,
        skipGearMultiplier: true,
      }));
      const fireTier = target?.weakness?.tiers?.fire || 0;
      if (fireTier === 2) {
        amount = Math.floor(amount * 1.2);
      }
      return {
        ...roll,
        amount,
        isMagic: true,
        element: "lightning",
        buildup: { lightning: ability?.buildupHint?.lightning ?? 60 },
        bounce: true,
      };
    },
    description: "Charged shot that arcs to a second target; bites harder on Ablaze foes."
  },
  */

  // --- Bow (2h) --- v3.22
  // -------- Generation --------

  'lodge_arrow': {
    id: "lodge_arrow",
    name: "Lodge Arrow",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["bow"],
    requiredStat: "DEX",
    requiredValue: 10,
    actionCost: "major",
    mpCost: 3,
    cooldown: 1,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["ranged", "attack", "lodge"],
    apply: (attacker, target) => {
      const ability = SKILLS?.lodge_arrow;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability, tags: ability?.tags, skipGearMultiplier: true,
      }));
      amount = Math.floor(amount * 0.75);
      const baseDamage = Math.max(1, roll.amount);
      target.statusEffects = target.statusEffects || [];
      target.statusEffects.push({ id: 'lodged', baseDamage, scalingBonus: 0.10 });
      const lodgeCount = target.statusEffects.filter(se => se?.id === 'lodged').length;
      return {
        ...roll, amount,
        log: `${attacker?.name ?? 'Archer'} lodges an arrow in ${target?.name ?? 'the target'} (${lodgeCount} lodge${lodgeCount !== 1 ? 's' : ''}).`,
      };
    },
    description: "75% damage — lodges a scaling arrow (+10% per additional lodge on dislodge)."
  },

  'frost_pin': {
    id: "frost_pin",
    name: "Frost Pin",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["bow"],
    requiredStat: "WIS",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 5,
    cooldown: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["ranged", "attack", "cold", "buildup"],
    buildupHint: { family: "cold", amount: 80 },
    apply: (attacker, target) => {
      const ability = SKILLS?.frost_pin;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability, tags: ability?.tags, element: "cold", skipGearMultiplier: true,
      }));
      const coldBuildup = 80;
      const prevTier = target?.weakness?.tiers?.cold || 0;
      const newTier = weaknessTierFromMeter((target?.weakness?.meters?.cold || 0) + coldBuildup);
      if (newTier > prevTier) {
        if (newTier >= 1) amount = Math.floor(amount * 1.25);
        if (newTier >= 2) amount = Math.floor(amount * 1.50);
      }
      // Lightning T2 10% repeat chance — repeat mechanic not yet implemented, noted as TODO
      return { ...roll, amount, element: "cold", buildup: { cold: coldBuildup } };
    },
    description: "100% cold + 80 cold buildup. Tier cross: T1 +25%, T2 additional +50%. (Lightning T2 10% repeat: TODO)"
  },

  'volley': {
    id: "volley",
    name: "Volley",
    type: "weapon",
    mechanic: "reaction",
    versionTag: "v3.22",
    requiredWeapon: ["bow"],
    requiredStat: "DEX",
    requiredValue: 14,
    actionCost: "bonus",
    mpCost: 8,
    cooldown: 5,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["support", "reaction"],
    apply: (attacker) => {
      attacker.statusEffects = attacker.statusEffects || [];
      attacker.statusEffects.push({ id: 'volley_armed', turns: 1, onAllyProjectile: { copyCount: 2, effectiveness: 0.35 } });
      return {
        amount: 0,
        log: `${attacker?.name ?? 'Archer'} readies Volley — will echo the next ally projectile twice at 35%. (Echo trigger: TODO)`,
      };
    },
    description: "Bonus: arm Volley — next ally bow/sling/gun skill copied twice at 35%. (Ally-projectile event hookup: TODO)"
  },

  'hunters_mark': {
    id: "hunters_mark",
    name: "Hunter's Mark",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["bow"],
    requiredStat: "WIS",
    requiredValue: 13,
    actionCost: "bonus",
    mpCost: 5,
    cooldown: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["support", "mark"],
    apply: (attacker, target) => {
      target.statusEffects = target.statusEffects || [];
      target.statusEffects = target.statusEffects.filter(se => se?.id !== 'hunters_mark');
      target.statusEffects.push({ id: 'hunters_mark', turns: 2, mods: { BuildupReceived: 50, LodgeDamage: 25 } });
      return {
        amount: 0,
        log: `${attacker?.name ?? 'Archer'} marks ${target?.name ?? 'the target'} — +50% buildup received, +25% lodge damage.`,
      };
    },
    description: "Bonus: Hunter's Mark 2 turns — +25% lodge damage (wired in dislodgeLodges) + +50% buildup received (BuildupReceived: TODO)."
  },

  'barbed_shaft': {
    id: "barbed_shaft",
    name: "Barbed Shaft",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["bow"],
    requiredStat: "DEX",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 4,
    cooldown: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["ranged", "attack", "lodge", "lacerate"],
    apply: (attacker, target) => {
      const hasLodge = (target?.statusEffects || []).some(se => se?.id === 'lodged');
      if (!hasLodge) {
        return { amount: 0, log: `${attacker?.name ?? 'Archer'}: barbed shaft requires a lodge already in target.` };
      }
      const ability = SKILLS?.barbed_shaft;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability, tags: ability?.tags, skipGearMultiplier: true,
      }));
      amount = Math.floor(amount * 0.75);
      const baseDamage = Math.max(1, Math.floor(roll.amount * 0.25));
      target.statusEffects.push({ id: 'lodged', baseDamage, lacerateOnDislodge: 100 });
      const lodgeCount = target.statusEffects.filter(se => se?.id === 'lodged').length;
      return {
        ...roll, amount,
        log: `${attacker?.name ?? 'Archer'} drives a barbed shaft in (${lodgeCount} lodges — applies 100 lacerate on dislodge).`,
      };
    },
    description: "Req 1+ lodge. 75% damage. Adds barbed lodge (25% damage + 100 lacerate on dislodge — no scalingBonus)."
  },

  'snipe_pose': {
    id: "snipe_pose",
    name: "Snipe Pose",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["bow"],
    requiredStat: "INT",
    requiredValue: 13,
    actionCost: "bonus",
    mpCost: 4,
    cooldown: 3,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["support", "buff", "expose"],
    apply: (attacker) => {
      attacker.statusEffects = attacker.statusEffects || [];
      attacker.statusEffects = attacker.statusEffects.filter(se => se?.id !== 'snipe_pose');
      attacker.statusEffects.push({ id: 'snipe_pose', turns: 1, bonusDmgPct: 50, exposeBuildup: 80 });
      return {
        amount: 0,
        log: `${attacker?.name ?? 'Archer'} takes careful aim — next attack +50% damage and +80 expose.`,
      };
    },
    description: "Bonus: next attack +50% damage +80 expose buildup (consumed on hit via CombatScene Snipe Pose hook)."
  },

  'scavenge_arrows': {
    id: "scavenge_arrows",
    name: "Scavenge Arrows",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["bow"],
    requiredStat: "DEX",
    requiredValue: 11,
    actionCost: "free",
    mpCost: 0,
    cooldown: 3,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["support", "mana"],
    apply: (attacker, _target, scene) => {
      const count = scene?.lodgesDislodgedThisTurn || 0;
      if (count === 0) {
        return { amount: 0, log: `${attacker?.name ?? 'Archer'}: no lodges dislodged this turn.` };
      }
      const mpGain = count * 2;
      return {
        amount: 0, mpGain,
        log: `${attacker?.name ?? 'Archer'} scavenges ${count} arrow${count !== 1 ? 's' : ''}, restoring ${mpGain} MP.`,
      };
    },
    description: "FREE: restore 2 MP per lodge dislodged this turn (reads scene.lodgesDislodgedThisTurn)."
  },

  // -------- Payoff --------

  'piercing_release': {
    id: "piercing_release",
    name: "Piercing Release",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["bow"],
    requiredStat: "DEX",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 7,
    cooldown: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["ranged", "attack", "dislodge"],
    apply: (attacker, target, scene) => {
      const lodgeCount = (target?.statusEffects || []).filter(se => se?.id === 'lodged').length;
      if (lodgeCount === 0) return { amount: 0, log: `${target?.name ?? 'Target'} has no lodges.` };
      const ability = SKILLS?.piercing_release;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability, tags: ability?.tags, skipGearMultiplier: true,
      }));
      const { totalDamage, lacerateBuildup, dislodged } = dislodgeLodges(target, scene);
      amount += totalDamage;
      const exposeGain = dislodged * 35;
      const lacerateGain = (lacerateBuildup || 0) + dislodged * 35;
      return {
        ...roll, amount,
        buildup: { expose: exposeGain, lacerate: lacerateGain },
        log: `${attacker?.name ?? 'Archer'} releases all — ${dislodged} arrow${dislodged !== 1 ? 's' : ''} dislodged for ${totalDamage} bonus damage!`,
      };
    },
    description: "100% + dislodge ALL lodges (each lodge uses its own scalingBonus). 35 expose + 35 lacerate per lodge dislodged."
  },

  'frost_shatter': {
    id: "frost_shatter",
    name: "Frost Shatter",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["bow"],
    requiredStat: "WIS",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 9,
    cooldown: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["ranged", "attack", "consume", "cold", "expose"],
    apply: (attacker, target) => {
      if ((target?.weakness?.tiers?.cold || 0) < 2) {
        return { amount: 0, log: `${target?.name ?? 'Target'} needs cold T2 (Frostbitten).` };
      }
      const ability = SKILLS?.frost_shatter;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability, tags: ability?.tags, element: "cold", skipGearMultiplier: true,
      }));
      amount = Math.floor(amount * 1.20);
      const consumedCold = target?.weakness?.meters?.cold || 0;
      amount += Math.floor(consumedCold / 10);
      const exposeBuildup = Math.floor(consumedCold * 0.50);
      if (target?.weakness?.meters) {
        target.weakness.meters.cold = 0;
        if (target.weakness.tiers) target.weakness.tiers.cold = 0;
      }
      return {
        ...roll, amount, element: "cold",
        buildup: { expose: exposeBuildup },
        log: `${attacker?.name ?? 'Archer'} shatters ${consumedCold} cold — +${Math.floor(consumedCold / 10)} damage, ${exposeBuildup} expose!`,
      };
    },
    description: "Req cold T2. 120% cold + consume all cold (+1 dmg/10). Converts 50% cold into expose buildup."
  },

  'hail_of_arrows': {
    id: "hail_of_arrows",
    name: "Hail of Arrows",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["bow"],
    requiredStat: "DEX",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 8,
    cooldown: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["ranged", "attack", "aoe"],
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.hail_of_arrows;
      const roll = calculateDamage(attacker, target, ability);
      const calcAmount = (tgt) => {
        let a = Math.max(1, applyDamageModifiers(roll.amount, attacker, tgt, {
          ability, tags: ability?.tags, skipGearMultiplier: true,
        }));
        a = Math.floor(a * 0.90);
        let mul = 1.0;
        const t = tgt?.weakness?.tiers || {};
        if ((t.expose || 0) >= 2 || (t.lacerate || 0) >= 2) mul += 0.20;
        if ((t.fire || 0) >= 2 || (t.cold || 0) >= 2 || (t.lightning || 0) >= 2) mul += 0.20;
        if ((t.toxic || 0) >= 2 || (t.disease || 0) >= 2 || (t.curse || 0) >= 2) mul += 0.20;
        return Math.floor(a * mul);
      };
      const amount = calcAmount(target);
      const splash = resolveAOESplash(scene, target, { shape: "adjacent" }).map(tgt => ({
        target: tgt, amount: calcAmount(tgt), tags: ability?.tags,
      }));
      return { ...roll, amount, splash: splash.length ? splash : undefined };
    },
    description: "90% to primary + adjacent. +20% per family with T2 weakness (physical/elemental/necrotic). Max +60% at all three T2."
  },

  'barbed_bloom': {
    id: "barbed_bloom",
    name: "Barbed Bloom",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["bow"],
    requiredStat: "DEX",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 7,
    cooldown: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["ranged", "attack", "aoe", "lacerate", "necrotic"],
    apply: (attacker, target, scene) => {
      if ((target?.weakness?.tiers?.lacerate || 0) < 1) {
        return { amount: 0, log: `${target?.name ?? 'Target'} has no lacerate buildup.` };
      }
      const ability = SKILLS?.barbed_bloom;
      const roll = calculateDamage(attacker, target, ability);
      const amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability, tags: ability?.tags, skipGearMultiplier: true,
      }));
      const lacMeter = target?.weakness?.meters?.lacerate || 0;
      const aoeBonus = Math.floor(lacMeter / 100) * 10;
      const aoeDmg = Math.floor(amount * 0.70 * (1 + aoeBonus / 100));
      const necroSpread = {
        toxic:   Math.floor((target?.weakness?.meters?.toxic   || 0) * 0.25),
        disease: Math.floor((target?.weakness?.meters?.disease || 0) * 0.25),
        curse:   Math.floor((target?.weakness?.meters?.curse   || 0) * 0.25),
      };
      const hasNecro = Object.values(necroSpread).some(v => v > 0);
      const splash = resolveAOESplash(scene, target, { shape: "column" }).map(tgt => ({
        target: tgt, amount: aoeDmg, tags: ability?.tags,
        buildup: hasNecro ? { ...necroSpread } : undefined,
      }));
      return { ...roll, amount, splash: splash.length ? splash : undefined };
    },
    description: "Req lacerate T1. 100% primary + column AOE (70% + 10% per 100 lacerate). Spreads 75% of primary's necrotic buildups."
  },

  'hunters_finish': {
    id: "hunters_finish",
    name: "Hunter's Finish",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["bow"],
    requiredStat: "WIS",
    requiredValue: 16,
    actionCost: ["major", "bonus"],
    mpCost: 10,
    cooldown: 8,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["ranged", "attack", "consume", "finisher"],
    apply: (attacker, target, scene) => {
      const hasMark  = (target?.statusEffects || []).some(se => se?.id === 'hunters_mark' && (se.turns || 0) > 0);
      const hasLodge = (target?.statusEffects || []).some(se => se?.id === 'lodged');
      if (!hasMark || !hasLodge) {
        return { amount: 0, log: `Hunter's Finish requires both Hunter's Mark and at least 1 lodge on target.` };
      }
      const ability = SKILLS?.hunters_finish;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability, tags: ability?.tags, skipGearMultiplier: true,
      }));
      amount = Math.floor(amount * 1.50);
      const fireMeter  = target?.weakness?.meters?.fire      || 0;
      const coldMeter  = target?.weakness?.meters?.cold      || 0;
      const lightMeter = target?.weakness?.meters?.lightning || 0;
      const elemBonus  = Math.floor(fireMeter / 10) + Math.floor(coldMeter / 10) + Math.floor(lightMeter / 10);
      amount += elemBonus;
      if (target?.weakness?.meters) {
        target.weakness.meters.fire = 0; target.weakness.meters.cold = 0; target.weakness.meters.lightning = 0;
        if (target.weakness.tiers) {
          target.weakness.tiers.fire = 0; target.weakness.tiers.cold = 0; target.weakness.tiers.lightning = 0;
        }
      }
      const { dislodged } = dislodgeLodges(target, scene);
      target.statusEffects = (target.statusEffects || []).filter(se => se?.id !== 'hunters_mark');
      return {
        ...roll, amount,
        log: `Hunter's Finish — ${dislodged} lodges, ${fireMeter + coldMeter + lightMeter} elemental consumed (+${elemBonus} damage)!`,
      };
    },
    description: "Req Hunter's Mark + 1 lodge + costs major+bonus. 150% + consume all elemental. Clears lodges and mark."
  },

  'farsight_volley': {
    id: "farsight_volley",
    name: "Farsight Volley",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["bow"],
    requiredStat: "CHA",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 8,
    cooldown: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["ranged", "attack", "aoe", "mana"],
    apply: (attacker, target, scene) => {
      // Gate: player must target a backline enemy (slots 6, 7, 8 = 'back' column)
      const targetCol = scene?._getColumnBySlotId?.(target?._slot?.slotId);
      if (targetCol !== 'back') {
        return { amount: 0, log: `${attacker?.name ?? 'Archer'}: Farsight Volley only targets the back rank.` };
      }
      const ability = SKILLS?.farsight_volley;
      const roll = calculateDamage(attacker, target, ability);
      const calcAmt = (tgt) => Math.max(1, Math.floor(applyDamageModifiers(roll.amount, attacker, tgt, {
        ability, tags: ability?.tags, skipGearMultiplier: true,
      }) * 0.85));
      // Hit all enemies in the same rank (same column = same depth) as the target
      const others = resolveAOESplash(scene, target, { shape: "column" });
      let totalMpGain = 0;
      for (const tgt of [target, ...others]) {
        const disorient = tgt?.weakness?.meters?.disorient || 0;
        const drained = Math.floor(disorient / 50);
        if (drained > 0) {
          totalMpGain += drained;
          if (tgt.currentMP != null) tgt.currentMP = Math.max(0, tgt.currentMP - drained);
          if (tgt?.weakness?.meters) {
            tgt.weakness.meters.disorient = 0;
            if (tgt.weakness.tiers) tgt.weakness.tiers.disorient = 0;
          }
        }
      }
      const amount = calcAmt(target);
      const splash = others.map(tgt => ({ target: tgt, amount: calcAmt(tgt), tags: ability?.tags }));
      return {
        ...roll, amount,
        splash: splash.length ? splash : undefined,
        mpGain: totalMpGain || undefined,
        log: totalMpGain > 0 ? `${attacker?.name ?? 'Archer'} volleys the back rank — drains ${totalMpGain} MP from disoriented foes!` : undefined,
      };
    },
    description: "Target a back-rank enemy — 85% to all back-rank enemies. Drains 1 MP per 50 disorient from each and restores to you."
  },

  'quivering_burst': {
    id: "quivering_burst",
    name: "Quivering Burst",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.22",
    requiredWeapon: ["bow"],
    requiredStat: "INT",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 9,
    cooldown: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["ranged", "attack", "aoe", "lightning", "dislodge"],
    buildupHint: { family: "toxic", amount: 40 },
    apply: (attacker, target, scene) => {
      const lodgeCount = (target?.statusEffects || []).filter(se => se?.id === 'lodged').length;
      if (lodgeCount < 2 || (target?.weakness?.tiers?.lightning || 0) < 2) {
        return { amount: 0, log: `Quivering Burst requires 2+ lodges and lightning T2 on target.` };
      }
      const ability = SKILLS?.quivering_burst;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability, tags: ability?.tags, element: "lightning", skipGearMultiplier: true,
      }));
      amount = Math.floor(amount * 1.10);
      const { totalDamage, dislodged } = dislodgeLodges(target, scene);
      amount += totalDamage;
      const toxicBuildup = ability?.buildupHint?.amount ?? 40;
      const lightMeter   = target?.weakness?.meters?.lightning || 0;
      const repeatChance = Math.min(0.60, lightMeter / 1000);
      const aoeDmg = Math.floor(amount * 0.65);
      const splash = resolveAOESplash(scene, target, { shape: "adjacent" }).map(tgt => ({
        target: tgt, amount: aoeDmg, tags: ability?.tags,
        buildup: { toxic: toxicBuildup },
      }));
      return {
        ...roll, amount, element: "lightning",
        buildup: { toxic: toxicBuildup },
        splash: splash.length ? splash : undefined,
        log: `${attacker?.name ?? 'Archer'} electrifies ${dislodged} lodges! ${aoeDmg} AOE, ${Math.round(repeatChance * 100)}% repeat. (Repeat trigger: TODO)`,
      };
    },
    description: "Req 2+ lodges + lightning T2. 110% lightning + dislodge all + 65% adjacent AOE + 40 toxic. Repeat chance = lightning/1000 capped at 60% (TODO)."
  },

  // --- Gun (2h) ---
  'capacitor_round': {
    id: "capacitor_round",
    name: "Capacitor Round",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["gun"],
    requiredStat: "INT",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 0,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "lightning"],
    cooldown: 2,
    buildupHint: { lightning: 60 },
    statusEffects: [{ id: "stunned", turns: 1 }],
    rewardIfTierCross: [{ family: "lightning", tier: 2, healMP: 4 }],
    apply: (attacker, target) => {
      const ability = SKILLS?.capacitor_round;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: "lightning",
        isMagic: true,
        skipGearMultiplier: true,
      }));
      const lightningTier = target?.weakness?.tiers?.lightning || 0;
      if (lightningTier === 2) {
        const statusEffects = Array.isArray(ability?.statusEffects) ? ability.statusEffects.map(s => ({ ...s })) : undefined;
        return {
          ...roll,
          amount,
          isMagic: true,
          element: "lightning",
          consumeWeakness: ["lightning"],
          statusEffects,
          rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
        };
      }
      return {
        ...roll,
        amount,
        isMagic: true,
        element: "lightning",
        buildup: { lightning: ability?.buildupHint?.lightning ?? 60 },
      };
    },
    description: "Charges the target; if fully charged, discharges to stun and restore MP."
  },

  'incendiary_shot': {
    id: "incendiary_shot",
    name: "Incendiary Shot",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["gun"],
    requiredStat: "STR",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 0,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "fire", "terrain"],
    cooldown: 3,
    buildupHint: { fire: 50 },
    slotEffect: { id: "burning_ground", element: "fire", buildup: 20, tickPctMaxHP: 0.02, turns: 2 },
    apply: (attacker, target) => {
      const ability = SKILLS?.incendiary_shot;
      const roll = calculateDamage(attacker, target, ability);
      const amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: "fire",
        isMagic: true,
        skipGearMultiplier: true,
      }));
      const slotEffect = ability?.slotEffect ? { ...ability.slotEffect } : undefined;
      return {
        ...roll,
        amount,
        isMagic: true,
        element: "fire",
        buildup: { fire: ability?.buildupHint?.fire ?? 50 },
        slotEffect,
      };
    },
    description: "Ignites the target's tile with burning ground."
  },

  // --- Wand (1h) ---
  'scorching_ray': {
    id: "scorching_ray",
    name: "Scorching Ray",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["wand"],
    requiredStat: "INT",
    requiredValue: 10,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "fire"],
    cooldown: 1,
    apply: (attacker, target) => {
      const ability = SKILLS?.scorching_ray;
      const roll = calculateDamage(attacker, target, ability);
      const amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: "fire",
        isMagic: true,
        skipGearMultiplier: true,
      }));
      return { ...roll, amount, isMagic: true, element: "fire" };
    },
    description: "A focused beam of flame fired from a wand."
  },

  'hex_bolt': {
    id: "hex_bolt",
    name: "Hex Bolt",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["wand"],
    requiredStat: "INT",
    requiredValue: 14,
    actionCost: "bonus",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "curse"],
    cooldown: 1,
    buildupHint: { curse: 600 },
    apply: (attacker, target) => {
      const ability = SKILLS?.hex_bolt;
      const roll = calculateDamage(attacker, target, ability);
      const amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        isMagic: true,
        skipGearMultiplier: true,
      }));
      return {
        ...roll,
        amount,
        isMagic: true,
        buildup: { curse: ability?.buildupHint?.curse ?? 600 },
      };
    },
    description: "Quick malediction for CURSE buildup testing."
  },

  'conduction_bolt': {
    id: "conduction_bolt",
    name: "Conduction Bolt",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["wand"],
    requiredStat: "INT",
    requiredValue: 10,
    actionCost: "bonus",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "lightning"],
    cooldown: 1,
    buildupHint: { lightning: 500 },
    apply: (attacker, target) => {
      const ability = SKILLS?.conduction_bolt;
      const roll = calculateDamage(attacker, target, ability);
      const amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: "lightning",
        isMagic: true,
        skipGearMultiplier: true,
      }));
      return {
        ...roll,
        amount,
        isMagic: true,
        element: "lightning",
        buildup: { lightning: ability?.buildupHint?.lightning ?? 500 },
      };
    },
    description: "A precise arc that builds Lightning."
  },

  'warmth': {
    id: "warmth",
    name: "Warmth",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["wand"],
    requiredStat: "WIS",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "ally",
    tags: ["magic", "support", "heal"],
    cooldown: 2,
    apply: (_attacker, ally) => {
      const maxHP = Math.max(1, ally?.maxHP || ally?.derivedStats?.maxHP || 1);
      const heal = Math.floor(maxHP * 0.18);
      return { amount: heal, isHeal: true };
    },
    description: "Restore a moderate amount of HP to an ally."
  },

  // --- Staff (2h) surplus (moved to v3.22 surplus block above) ---
  /*
  'fireball': {
    id: "fireball",
    name: "Fireball",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["staff"],
    requiredStat: "INT",
    requiredValue: 18,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "fire", "aoe"],
    cooldown: 3,
    aoe: { shape: "column", scale: 0.5 },
    buildupHint: { fire: 700, splash: 40 },
    splashScale: 0.5,
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.fireball;
      const roll = calculateFireballDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: "fire",
        isMagic: true,
        skipGearMultiplier: true,
      }));

      const splash = [];
      if (scene && target && typeof scene._getUnitColumn === "function" && typeof scene._getColumnBySlotId === "function") {
        const col = scene._getUnitColumn(target);
        const sideSlots = target.isEnemy ? scene.enemySlots : scene.allySlots;
        const sameColChars = sideSlots
          ?.filter(s => scene._getColumnBySlotId?.(s.slotId) === col && s.char && s.char !== target && s.char.status !== "incapacitated")
          .map(s => s.char) || [];
        const scale = ability?.splashScale ?? 0.5;
        const splashBuildup = ability?.buildupHint?.splash ?? 40;
        sameColChars.forEach(u => {
          splash.push({
            target: u,
            amount: Math.max(1, Math.floor(amount * scale)),
            isMagic: true,
            element: "fire",
            buildup: { fire: splashBuildup },
            tags: ability?.tags,
          });
        });
      }

      return {
        ...roll,
        amount,
        isMagic: true,
        element: "fire",
        buildup: { fire: ability?.buildupHint?.fire ?? 700 },
        splash: splash.length ? splash : undefined,
      };
    },
    description: "Hurl a burning fireball that explodes in a column, dealing high damage and scorching nearby foes."
  },

  'frostlash': {
    id: "frostlash",
    name: "Frostlash",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["staff"],
    requiredStat: "INT",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "cold"],
    cooldown: 4,
    buildupHint: { cold: 60 },
    apply: (attacker, target) => {
      const ability = SKILLS?.frostlash;
      const roll = calculateDamage(attacker, target, ability);
      const amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: "cold",
        isMagic: true,
        skipGearMultiplier: true,
      }));
      return {
        ...roll,
        amount,
        isMagic: true,
        element: "cold",
        buildup: { cold: ability?.buildupHint?.cold ?? 60 },
      };
    },
    description: "A chilling strike that builds Cold on the enemy."
  },

  'curse_surge': {
    id: "curse_surge",
    name: "Curse Surge",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["staff"],
    requiredStat: "INT",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 1,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "curse", "necrotic"],
    cooldown: 1,
    buildupHint: { curse: 700 },
    apply: (attacker, target) => {
      const ability = SKILLS?.curse_surge;
      const intStat = attacker?.totalStats?.INT ?? attacker?.INT ?? 0;
      const base = 8 + (intStat >> 1);
      const amount = Math.max(1, applyDamageModifiers(base, attacker, target, {
        ability,
        tags: ability?.tags,
        element: "necrotic",
        isMagic: true,
        skipGearMultiplier: true,
      }));
      return {
        amount,
        isMagic: true,
        element: "necrotic",
        dealsDamage: true,
        buildup: { curse: ability?.buildupHint?.curse ?? 700 },
      };
    },
    description: "A heavy malediction that surges the CURSE meter."
  },

  'ember_ward': {
    id: "ember_ward",
    name: "Ember Ward",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["staff"],
    requiredStat: "WIS",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 2,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["support", "buff"],
    cooldown: 3,
    teamBuff: { scope: "column", effect: { id: "ember_ward", turns: 2, fireResBonus: 0.2 } },
    apply: () => {
      return {
        teamBuff: {
          scope: "column",
          effect: { id: "ember_ward", turns: 2, fireResBonus: 0.2 }
        }
      };
    },
    description: "Protect your column with resistance to fire."
  },

  'glacier_wall': {
    id: "glacier_wall",
    name: "Glacier Wall",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["staff"],
    requiredStat: "INT",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "cold", "terrain"],
    cooldown: 3,
    buildupHint: { cold: 60 },
    slotEffect: { id: "ice_slick", element: "cold", buildup: 15, tickPctMaxHP: 0.0, turns: 2 },
    apply: (attacker, target) => {
      const ability = SKILLS?.glacier_wall;
      const roll = calculateDamage(attacker, target, ability);
      const amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: "cold",
        isMagic: true,
        skipGearMultiplier: true,
      }));
      const slotEffect = ability?.slotEffect ? { ...ability.slotEffect } : undefined;
      return {
        ...roll,
        amount,
        isMagic: true,
        element: "cold",
        buildup: { cold: ability?.buildupHint?.cold ?? 60 },
        slotEffect,
      };
    },
    description: "Erects frigid terrain on the target's tile; stacks Cold."
  },
  */

  // --- Shield ---
  'shield_ram': {
    id: "shield_ram",
    name: "Shield Ram",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["shield"],
    requiredStat: "STR",
    requiredValue: 18,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "control"],
    cooldown: 3,
    apply: (attacker, target) => {
      const ability = SKILLS?.shield_ram;
      const roll = calculateDamage(attacker, target, ability);
      const amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      return {
        ...roll,
        amount,
        knockback: 1,
        disorientOnCollision: true,
      };
    },
    description: "Bash the enemy back; if they collide, they are disoriented."
  },

  'brace_up': {
    id: "brace_up",
    name: "Brace Up",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["shield"],
    requiredStat: "CON",
    requiredValue: 10,
    actionCost: "bonus",
    mpCost: 3,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["stance", "support"],
    cooldown: 3,
    statusEffects: [{ id: "brace_up", turns: 1, guardPct: 15, damageReduction: 0.15 }],
    apply: () => {
      const ability = SKILLS?.brace_up;
      const statusEffects = Array.isArray(ability?.statusEffects)
        ? ability.statusEffects.map(effect => ({ ...effect }))
        : undefined;
      return { amount: 0, statusEffects };
    },
    description: "Brace for impact, reducing damage taken until your next turn."
  },

  'shield_bash': {
    id: "shield_bash",
    name: "Shield Bash",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["shield"],
    requiredStat: "STR",
    requiredValue: 10,
    actionCost: "major",
    mpCost: 0,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "control"],
    cooldown: 2,
    statusEffects: [{ id: "stunned", turns: 1 }],
    apply: (attacker, target) => {
      const ability = SKILLS?.shield_bash;
      const roll = calculateDamage(attacker, target, ability);
      const amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      const lightningTier = target?.weakness?.tiers?.lightning || 0;
      const statusEffects = lightningTier >= 1
        ? (Array.isArray(ability?.statusEffects) ? ability.statusEffects.map(effect => ({ ...effect })) : undefined)
        : undefined;
      return { ...roll, amount, statusEffects };
    },
    description: "A concussive slam; charged foes may be stunned."
  },

  'bulwark_column': {
    id: "bulwark_column",
    name: "Bulwark Column",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["shield"],
    requiredStat: "CON",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 0,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["support", "stance"],
    cooldown: 3,
    teamBuff: { scope: "column", effect: { id: "bulwark", turns: 2, physResBonus: 0.2 } },
    apply: () => {
      return {
        teamBuff: {
          scope: "column",
          effect: { id: "bulwark", turns: 2, physResBonus: 0.2 }
        }
      };
    },
    description: "Brace your column, raising physical resistance."
  },

  // --- Whip ---
  'gust_lash': {
    id: "gust_lash",
    name: "Gust Lash",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["whip"],
    requiredStat: "DEX",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 0,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "wind"],
    cooldown: 2,
    statusEffects: [{ id: "wind_exposed", turns: 2, fireBuildupMul: 1.25, lightningBuildupMul: 1.25 }],
    apply: (attacker, target) => {
      const ability = SKILLS?.gust_lash;
      const roll = calculateDamage(attacker, target, ability);
      const amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      const statusEffects = Array.isArray(ability?.statusEffects)
        ? ability.statusEffects.map(effect => ({ ...effect }))
        : undefined;
      return { ...roll, amount, statusEffects };
    },
    description: "A cutting snap that leaves the foe vulnerable to fire and lightning."
  },

  'scorch_crack': {
    id: "scorch_crack",
    name: "Scorch Crack",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["whip"],
    requiredStat: "INT",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "fire"],
    cooldown: 2,
    buildupHint: { fire: 60 },
    apply: (attacker, target) => {
      const ability = SKILLS?.scorch_crack;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: "fire",
        isMagic: true,
        skipGearMultiplier: true,
      }));
      const coldTier = target?.weakness?.tiers?.cold || 0;
      if (coldTier >= 1) amount = Math.floor(amount * 1.2);
      return {
        ...roll,
        amount,
        isMagic: true,
        element: "fire",
        buildup: { fire: ability?.buildupHint?.fire ?? 60 },
      };
    },
    description: "A fiery lash that sears worse on chilled foes."
  },

  // v3.21 Whip additions
  'lash_of_doubt': {
    id: "lash_of_doubt",
    name: "Lash of Doubt",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["whip"],
    requiredStat: "CHA",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "disorient"],
    cooldown: 2,
    buildupHint: { disorient: 100 },
    apply: (attacker, target) => {
      const ability = SKILLS?.lash_of_doubt;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      const chainCount = getWhipChainCount(attacker);
      if (chainCount > 0) {
        amount = Math.floor(amount * 1.05);
      }
      markWhipUse(attacker);
      return {
        ...roll,
        amount,
        buildup: { disorient: ability?.buildupHint?.disorient ?? 100 },
      };
    },
    description: "A stinging crack that shakes focus, building Disorient."
  },

  'herding_lash': {
    id: "herding_lash",
    name: "Herding Lash",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["whip"],
    requiredStat: "DEX",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "control"],
    emitTagsOnUse: ["snap"],
    cooldown: 2,
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.herding_lash;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      amount = Math.max(1, Math.floor(amount * 0.9));

      let pulled = false;
      if (scene && target && typeof scene._pullTarget === "function") {
        pulled = scene._pullTarget(target, attacker, 1);
      }

      markWhipUse(attacker);
      return {
        ...roll,
        amount,
        pull: 1,
        pulled,
      };
    },
    description: "A precision snap that repositions the foe, nudging them into line."
  },

  'marking_crack': {
    id: "marking_crack",
    name: "Marking Crack",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["whip"],
    requiredStat: "DEX",
    requiredValue: 13,
    actionCost: "major",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "expose"],
    cooldown: 2,
    buildupHint: { expose: 100 },
    apply: (attacker, target) => {
      const ability = SKILLS?.marking_crack;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      markWhipUse(attacker);
      return {
        ...roll,
        amount,
        buildup: { expose: ability?.buildupHint?.expose ?? 100 },
      };
    },
    description: "A quick lash that exposes a gap in the foe's guard."
  },

  'choir_of_pain': {
    id: "choir_of_pain",
    name: "Choir of Pain",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["whip"],
    requiredStat: "WIS",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "curse", "aoe"],
    emitTagsOnUse: ["whirl"],
    cooldown: 3,
    aoe: { shape: "column", scale: 1 },
    buildupHint: { curse: 100 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.choir_of_pain;
      const roll = calculateDamage(attacker, target, ability);
      const baseBuildup = ability?.buildupHint?.curse ?? 100;
      const amount = 0;
      const splash = [];
      if (scene && target && typeof scene._getUnitColumn === "function" && typeof scene._getColumnBySlotId === "function") {
        const column = scene._getUnitColumn(target);
        if (column) {
          const sideSlots = target?.isEnemy ? scene.enemySlots : scene.allySlots;
          const others = sideSlots
            ?.filter(slot => slot?.char && slot.char.status !== "incapacitated" && scene._getColumnBySlotId(slot.slotId) === column)
            .map(slot => slot.char) || [];
          others.forEach(char => {
            splash.push({
              target: char,
              amount: 0,
              buildup: { curse: baseBuildup },
              tags: ability?.tags,
            });
          });
        }
      }
      markWhipUse(attacker);
      return {
        ...roll,
        amount,
        buildup: { curse: baseBuildup },
        splash: splash.length ? splash : undefined,
      };
    },
    description: "Whirl the whip and call a curse onto nearby foes."
  },

  'rhythm_keeper': {
    id: "rhythm_keeper",
    name: "Rhythm Keeper",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["whip"],
    requiredStat: "CHA",
    requiredValue: 15,
    actionCost: "bonus",
    mpCost: 0,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["support", "mp", "stance"],
    cooldown: 2,
    apply: (attacker) => {
      const chainBefore = getWhipChainCount(attacker);
      const mpGain = chainBefore > 0 ? 3 : 2;
      if (attacker) {
        const maxMP = attacker.maxMP ?? attacker.derivedStats?.maxMP ?? 0;
        const before = attacker.currentMP ?? 0;
        const after = maxMP > 0 ? Math.min(maxMP, before + mpGain) : before + mpGain;
        attacker.currentMP = after;
      }
      const count = markWhipUse(attacker);
      return {
        amount: 0,
        log: mpGain > 0 ? `${attacker?.name || "The taskmaster"} keeps tempo and regains ${mpGain} MP (chain ${count}).` : undefined,
      };
    },
    description: "Maintain tempo; restore a bit of MP when chaining whip techniques."
  },

  'binding_whiplash': {
    id: "binding_whiplash",
    name: "Binding Whiplash",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["whip"],
    requiredStat: "DEX",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "disorient", "expose"],
    emitTagsOnUse: ["lash"],
    cooldown: 3,
    apply: (attacker, target) => {
      const ability = SKILLS?.binding_whiplash;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      const disorientTier = target?.weakness?.tiers?.disorient || 0;
      const exposeTier = target?.weakness?.tiers?.expose || 0;
      const buildup = disorientTier >= 1 ? { expose: 100 } : { disorient: 100 };
      if (disorientTier >= 1 || exposeTier >= 1) {
        amount = Math.floor(amount * 1.1);
      }
      markWhipUse(attacker);
      return {
        ...roll,
        amount,
        buildup,
      };
    },
    description: "Entangle the foe; if they're already off balance, add Expose-otherwise, sow Disorient."
  },

  // Payoff
  'entrapping_pull': {
    id: "entrapping_pull",
    name: "Entrapping Pull",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["whip"],
    requiredStat: "DEX",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "control", "consume"],
    emitTagsOnUse: ["yank"],
    cooldown: 3,
    requiresWeakness: { family: "disorient", tierAtLeast: 1 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.entrapping_pull;
      const roll = calculateDamage(attacker, target, ability);
      const disTier = target?.weakness?.tiers?.disorient || 0;
      const curseTier = target?.weakness?.tiers?.curse || 0;
      const valid = disTier >= 2 || curseTier >= 2;
      if (!valid) {
        return { ...roll, amount: 0, log: `${attacker?.name || "The handler"} fails to get a firm pull.` };
      }
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      amount = Math.floor(amount * 1.25);

      let pulled = false;
      if (scene && typeof scene._pullTarget === "function") {
        pulled = scene._pullTarget(target, attacker, 1);
      }

      if (target?.weakness?.meters) {
        if (disTier >= 2) {
          target.weakness.meters.disorient = Math.max(0, (target.weakness.meters.disorient || 0) - 100);
          if (target.weakness.tiers) target.weakness.tiers.disorient = weaknessTierFromMeter(target.weakness.meters.disorient);
        } else if (curseTier >= 2) {
          target.weakness.meters.curse = Math.max(0, (target.weakness.meters.curse || 0) - 100);
          if (target.weakness.tiers) target.weakness.tiers.curse = weaknessTierFromMeter(target.weakness.meters.curse);
        }
      }

      markWhipUse(attacker);
      return {
        ...roll,
        amount,
        pull: 1,
        pulled,
        consumeWeakness: disTier >= 2 ? ["disorient"] : ["curse"],
      };
    },
    description: "A vicious yank dragging cursed or dazed foes closer, sapping their balance."
  },

  'scourge_of_shame': {
    id: "scourge_of_shame",
    name: "Scourge of Shame",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["whip"],
    requiredStat: "CHA",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "curse", "consume"],
    emitTagsOnUse: ["lash"],
    cooldown: 3,
    requiresWeakness: { family: "curse", tierAtLeast: 1 },
    consumeWeakness: ["curse"],
    apply: (attacker, target) => {
      const ability = SKILLS?.scourge_of_shame;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      const tier = target?.weakness?.tiers?.curse || 0;
      const meter = target?.weakness?.meters?.curse || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      if (tier > 0) amount = Math.floor(amount * (1 + 0.15 * tier));
      if (intensity > 1) amount = Math.floor(amount * (1 + Math.max(0, intensity - 1) * 0.2));
      if (target?.weakness?.meters) {
        target.weakness.meters.curse = 0;
        if (target.weakness.tiers) target.weakness.tiers.curse = weaknessTierFromMeter(0);
      }
      markWhipUse(attacker);
      return {
        ...roll,
        amount,
        consumeWeakness: ability?.consumeWeakness ? [...ability.consumeWeakness] : undefined,
      };
    },
    description: "A brutal series of lashes that scale with the target's Curse, stripping it away."
  },

  'snapback_rebound': {
    id: "snapback_rebound",
    name: "Snapback Rebound",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["whip"],
    requiredStat: "DEX",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "multi"],
    emitTagsOnUse: ["snap"],
    cooldown: 2,
    apply: (attacker, target) => {
      const ability = SKILLS?.snapback_rebound;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      amount = Math.max(1, Math.floor(amount * 0.92));
      const disTier = target?.weakness?.tiers?.disorient || 0;
      let extraHit = 0;
      if (disTier >= 1) {
        extraHit = Math.max(1, Math.floor(amount * 0.6));
        amount += extraHit;
      }
      markWhipUse(attacker);
      return {
        ...roll,
        amount,
        extraHits: extraHit ? [{ amount: extraHit, tags: ability?.tags }] : undefined,
      };
    },
    description: "Lash out and let the whip snap back; disoriented targets suffer a second strike."
  },

  'scarring_lattice': {
    id: "scarring_lattice",
    name: "Scarring Lattice",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["whip"],
    requiredStat: "WIS",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "curse", "proliferate", "aoe"],
    emitTagsOnUse: ["weave"],
    cooldown: 3,
    aoe: { shape: "column", scale: 1 },
    conditionHint: { requiresCurse: true },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.scarring_lattice;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      amount = Math.max(1, Math.floor(amount * 0.9));
      const sourceMeter = target?.weakness?.meters?.curse || 0;
      const splash = [];
      const spreadMeta = [];
      if (scene && target && typeof scene._getUnitColumn === "function" && typeof scene._getColumnBySlotId === "function") {
        const column = scene._getUnitColumn(target);
        if (column) {
          const sideSlots = target?.isEnemy ? scene.enemySlots : scene.allySlots;
          const others = sideSlots
            ?.filter(slot => slot?.char && slot.char !== target && slot.char.status !== "incapacitated" && scene._getColumnBySlotId(slot.slotId) === column)
            .map(slot => slot.char) || [];
          others.forEach(char => {
            const splashAmount = Math.max(1, Math.floor(amount * 0.75));
            splash.push({
              target: char,
              amount: splashAmount,
              tags: ability?.tags,
            });
            if (sourceMeter > 0) {
              char.weakness = char.weakness || { meters: {}, tiers: {} };
              char.weakness.meters = char.weakness.meters || {};
              char.weakness.tiers = char.weakness.tiers || {};
              char.weakness.meters.curse = (char.weakness.meters.curse || 0) + Math.max(100, Math.floor(sourceMeter * 0.5));
              char.weakness.tiers.curse = weaknessTierFromMeter(char.weakness.meters.curse);
              spreadMeta.push({ targetId: char.id || char.name, family: "curse", amount: Math.max(100, Math.floor(sourceMeter * 0.5)) });
            }
          });
        }
      }
      if (target?.weakness?.meters && sourceMeter > 0) {
        const newMeter = Math.max(0, sourceMeter - 100);
        target.weakness.meters.curse = newMeter;
        if (target.weakness.tiers) target.weakness.tiers.curse = weaknessTierFromMeter(newMeter);
      }
      markWhipUse(attacker);
      return {
        ...roll,
        amount,
        splash: splash.length ? splash : undefined,
        proliferatedWeakness: spreadMeta.length ? spreadMeta : undefined,
      };
    },
    description: "Weave a lattice of pain, copying a curse stack from the primary target to others before trimming it."
  },

  'stinging_taunt': {
    id: "stinging_taunt",
    name: "Stinging Taunt",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["whip"],
    requiredStat: "CHA",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "expose", "debuff"],
    emitTagsOnUse: ["lash"],
    cooldown: 3,
    requiresWeakness: { family: "expose", tierAtLeast: 1 },
    statusEffects: [{ id: "stinging_taunt", turns: 1, mods: { AttackPower: -10 } }],
    apply: (attacker, target) => {
      const ability = SKILLS?.stinging_taunt;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      amount = Math.floor(amount * 1.2);
      const statusEffects = Array.isArray(ability?.statusEffects)
        ? ability.statusEffects.map(effect => ({ ...effect }))
        : undefined;
      if (target?.weakness?.meters) {
        const newMeter = Math.max(0, (target.weakness.meters.expose || 0) - 100);
        target.weakness.meters.expose = newMeter;
        if (target.weakness.tiers) target.weakness.tiers.expose = weaknessTierFromMeter(newMeter);
      }
      markWhipUse(attacker);
      return {
        ...roll,
        amount,
        statusEffects,
      };
    },
    description: "A humiliating strike that punishes exposed foes and saps their attack."
  },

  'disciplinarian': {
    id: "disciplinarian",
    name: "Disciplinarian",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["whip"],
    requiredStat: "CON",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["support", "debuff"],
    emitTagsOnUse: ["lash"],
    cooldown: 3,
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.disciplinarian;
      const roll = calculateDamage(attacker, target, ability);
      const debuffCount = target ? Object.values(target?.weakness?.tiers || {}).reduce((a, b) => a + ((b || 0) > 0 ? 1 : 0), 0) : 0;
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      if (debuffCount > 0) {
        amount = Math.floor(amount * (1 + 0.08 * debuffCount));
      }
      let healedAllies;
      // KNOWN BUG, not yet fixed (found while fixing the identical issue in
      // Sacred Shockwave): attacker.team is a STRING ('ally'/'enemy'), not an
      // array of teammates — .forEach on it throws, gets caught by
      // CombatScene's ability-apply try/catch, and the whole cast silently
      // "fizzles" (discarding damage already computed above) whenever this
      // block is reached with debuffCount > 0. Fix: enumerate via
      // scene.allySlots/enemySlots instead, same as every other skill in
      // this file. Left alone for now — revisit when Whip gets its own pass.
      if (scene && attacker?.team && debuffCount > 0) {
        healedAllies = [];
        attacker.team.forEach(ally => {
          if (!ally) return;
          const maxHP = ally.maxHP ?? ally.derivedStats?.maxHP ?? 0;
          if (maxHP <= 0) return;
          const heal = debuffCount * 2;
          const before = ally.currentHP ?? 0;
          const after = Math.min(maxHP, before + heal);
          ally.currentHP = after;
          healedAllies.push({ id: ally.id || ally.name, healed: after - before });
        });
      }
      markWhipUse(attacker);
      return {
        ...roll,
        amount,
        healedAllies: healedAllies && healedAllies.length ? healedAllies : undefined,
      };
    },
    description: "Punish the foe and share their suffering-heal nearby allies per debuff on the target."
  },

  'chain_reaction': {
    id: "chain_reaction",
    name: "Chain Reaction",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["whip"],
    requiredStat: "INT",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "attack", "transform"],
    emitTagsOnUse: ["lash"],
    cooldown: 3,
    requiresWeakness: { family: "curse", tierAtLeast: 1 },
    transformWeakness: { from: "curse", to: "toxic", ratio: 1.0 },
    apply: (attacker, target) => {
      const ability = SKILLS?.chain_reaction;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      amount = Math.floor(amount * 1.05);
      let transformed;
      if (target?.weakness) {
        const fromKey = ability?.transformWeakness?.from || "curse";
        const toKey = ability?.transformWeakness?.to || "toxic";
        const ratio = ability?.transformWeakness?.ratio ?? 1;
        const current = target.weakness.meters?.[fromKey] || 0;
        if (current > 0) {
          const transfer = Math.max(0, Math.floor(current * ratio));
          const remaining = Math.max(0, current - transfer);
          target.weakness.meters[fromKey] = remaining;
          target.weakness.meters[toKey] = (target.weakness.meters[toKey] || 0) + transfer;
          if (target.weakness.tiers) {
            target.weakness.tiers[fromKey] = weaknessTierFromMeter(target.weakness.meters[fromKey]);
            target.weakness.tiers[toKey] = weaknessTierFromMeter(target.weakness.meters[toKey]);
          }
          transformed = { from: fromKey, to: toKey, amount: transfer };
        }
      }
      markWhipUse(attacker);
      return {
        ...roll,
        amount,
        transformWeakness: ability?.transformWeakness ? { ...ability.transformWeakness } : undefined,
        transformedWeakness: transformed,
      };
    },
    description: "Convert curses into poison, triggering a chain of agony."
  },

});

// ===============================================================
// OUTDATED — pulled from the active roster, kept for reference only.
// Needs a rework pass before it's reintroduced (if ever). Not inside an
// Object.assign(RAW_SKILLS, ...) call, so none of this registers as a
// playable skill.
// ===============================================================
//
// 'curse_snap' — dagger, INT 18, requires target Curse T1+. Was a v3.21
// leftover that never got a v3.22 companion like its dagger siblings did;
// its INT/magic/curse design doesn't match the DEX/CHA flavor of the rest
// of the current dagger kit.
//
// 'curse_snap': {
//   id: "curse_snap",
//   name: "Curse Snap",
//   type: "weapon",
//   mechanic: "active",
//   versionTag: "v3.21",
//   requiredWeapon: ["dagger"],
//   requiredStat: "INT",
//   requiredValue: 18,
//   actionCost: "major",
//   mpCost: 7,
//   requiresTarget: true,
//   targetRequirement: "enemy",
//   tags: ["curse", "amplify", "magic"],
//   requiresWeakness: { family: "curse", tierAtLeast: 1 },
//   apply: (attacker, target) => {
//     const ability = SKILLS?.curse_snap;
//     const roll = calculateDamage(attacker, target, ability);
//     const intBonus = Math.floor((attacker?.totalStats?.INT || 0) / 3);
//     const base = roll.amount + intBonus;
//     let amount = Math.max(1, applyDamageModifiers(base, attacker, target, {
//       ability,
//       tags: ability?.tags,
//       element: 'curse',
//       isMagic: true,
//       skipGearMultiplier: true,
//     }));
//
//     const meter = target?.weakness?.meters?.curse || 0;
//     const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
//     amount = Math.floor(amount * (1 + Math.max(0, intensity - 1) * 0.08));
//
//     const status = { id: 'curse_snap', turns: 1, doubleCurseTicks: true };
//
//     return {
//       ...roll,
//       amount,
//       isMagic: true,
//       statusEffects: [status],
//     };
//   },
//   description: "For one turn, all Curse effects on the target tick twice (amplify only; no consume)."
// },

Object.assign(SKILLS, buildSkillRegistry(RAW_SKILLS));
