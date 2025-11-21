// data/skills.js
import { calculateDamage, calculateDualWieldDamage } from '../src/systems/CombatLogic.js';
import { calculateFireballDamage } from '../src/systems/CombatLogic.js';
import { Items } from './items.js';
import { applyDamageModifiers } from '../src/systems/CombatLogic.js';
import { weaknessIntensityMult, weaknessTierFromMeter } from '../src/systems/StatusEffects.js';


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
const cloneArray = (arr) => (Array.isArray(arr) ? [...arr] : undefined);

const SWORD_CHAIN_STATUS_KEY = 'sword_rhythm_window';
const SWORD_RECENT_HIT_KEY = 'sword_recent_hit';
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
    rewardIfWeak: cloneRewardStruct(skill.rewardIfWeak),
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

export const SkillTypes = ['weapon', 'class', 'reaction', 'special'];
export const ActionTypes = ['major', 'bonus', 'class', 'reaction'];



export function getWeaponSkillsFor(char) {
  const unlocked = [];

  for (const [id, skill] of Object.entries(SKILLS)) {
    if (skill.type !== 'weapon') continue;
    if (skill.enemyOnly) continue;

    // ? Unify stat key case
    const statKey = skill.requiredStat?.toUpperCase();
    const statVal = statKey ? (char.totalStats?.[statKey] || 0) : null;

    if (skill.requiredStat && statVal < skill.requiredValue) continue;

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

    // stat gate
    if (s.requiredStat) {
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
    targetRequirement: 'position',       // <-- custom: we’ll handle in CombatScene
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

  // Encounter 1 – Warm-up Duel
  'warmup_swing': {
    id: 'warmup_swing',
    name: 'Practice Swing',
    type: 'enemy',
    actionCost: 'major',
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
    enemyOnly: true,
    requiresTarget: false,
    apply: (user) => {
      if (!user) return { amount: 0 };
      const heal = Math.max(3, Math.floor((user.maxHP || 40) * 0.15));
      user.currentHP = Math.min(user.maxHP || heal, (user.currentHP || 0) + heal);
      return { amount: 0 };
    }
  },

  // Encounter 2 – Defensive Trial
  'defender_guard_raise': {
    id: 'defender_guard_raise',
    name: 'Raise Shield',
    type: 'enemy',
    actionCost: 'bonus',
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

  // Encounter 3 – Animated Party Test
  'fighter_heavy_slash': {
    id: 'fighter_heavy_slash',
    name: 'Heavy Slash',
    type: 'enemy',
    actionCost: 'major',
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
    name: 'Executioner’s Strike',
    type: 'enemy',
    actionCost: 'major',
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

  // Encounter 4 – Huntsman & Beasts
  'huntsman_mark': {
    id: 'huntsman_mark',
    name: 'Huntmaster’s Mark',
    type: 'enemy',
    actionCost: 'bonus',
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

  // Encounter 5 – Elemental Duelists
  'fire_flame_slash': {
    id: 'fire_flame_slash',
    name: 'Flame Slash',
    type: 'enemy',
    actionCost: 'major',
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
    enemyOnly: true,
    requiresTarget: false,
    apply: () => ({ amount: 0, statusEffects: [{ id: 'icy_guard', turns: 2, mods: { PhysicalResist: 15 }, data: { retaliateCold: true } }] })
  },
  'ice_freeze_point': {
    id: 'ice_freeze_point',
    name: 'Freeze Point',
    type: 'enemy',
    actionCost: 'class',
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

  // Encounter 6 – Berserker Boss
  'berserker_crushing_blow': {
    id: 'berserker_crushing_blow',
    name: 'Crushing Blow',
    type: 'enemy',
    actionCost: 'major',
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    apply: () => ({ amount: 9, buildup: { expose: 90, lacerate: 80 } })
  },
  'berserker_disrupting_roar': {
    id: 'berserker_disrupting_roar',
    name: 'Disrupting Roar',
    type: 'enemy',
    actionCost: 'class',
    enemyOnly: true,
    requiresTarget: false,
    apply: (_user, _target, scene) => {
      const foes = scene?.turnOrder?.filter(u => !u.isEnemy && u.status !== 'incapacitated') || [];
      return {
        amount: 0,
        splash: foes.map(t => ({ target: t, amount: 3, buildup: { disorient: 80 } }))
      };
    }
  },
  'berserker_bleeding_sweep': {
    id: 'berserker_bleeding_sweep',
    name: 'Bleeding Sweep',
    type: 'enemy',
    actionCost: 'major',
    enemyOnly: true,
    requiresTarget: false,
    apply: (_user, _target, scene) => {
      const foes = scene?.turnOrder?.filter(u => !u.isEnemy && u.status !== 'incapacitated') || [];
      return {
        amount: 0,
        splash: foes.map(t => ({ target: t, amount: 6, buildup: { lacerate: 90 } }))
      };
    }
  },
  'berserker_guarded_fury': {
    id: 'berserker_guarded_fury',
    name: 'Guarded Fury',
    type: 'enemy',
    actionCost: 'bonus',
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    apply: (user, target) => ({
      amount: 5,
      buildup: { cold: 70 },
      statusEffects: [{ id: 'berserker_guard', turns: 2, mods: { PhysicalResist: 15 } }]
    })
  },
  'berserker_battle_frenzy': {
    id: 'berserker_battle_frenzy',
    name: 'Battle Frenzy',
    type: 'enemy',
    actionCost: 'bonus',
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
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    requiresWeakness: [
      { family: 'expose', tier: 1 },
      { family: 'lacerate', tier: 1 }
    ],
    apply: () => ({ amount: 15, consumeWeakness: ['expose', 'lacerate'] })
  },
  'berserker_unstoppable_rush': {
    id: 'berserker_unstoppable_rush',
    name: 'Unstoppable Rush',
    type: 'enemy',
    actionCost: 'major',
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    apply: (user, target) => {
      if (user) {
        user.initiativeGauge = Math.max(0, (user.initiativeGauge || 0) - 50);
      }
      const disorientStacks = target?.weakness?.tiers?.disorient || 0;
      const bonus = disorientStacks >= 1 ? 3 * disorientStacks : 0;
      return { amount: 9 + bonus };
    }
  },
  'berserker_blood_fury': {
    id: 'berserker_blood_fury',
    name: 'Blood Fury',
    type: 'enemy',
    actionCost: 'reaction',
    mechanic: 'reaction',
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    apply: () => ({ amount: 6, buildup: { expose: 60, disorient: 60 } })
  }
};
Object.assign(RAW_SKILLS, NPC_ONLY_SKILLS);

// ===============================
// v3.2 - Dagger skills (13) - injected directly; no wrapper const
// Notes: no `range`; tooltip helpers via `buildupHint`/`aoe`; event scaffolding inert.
// ===============================
Object.assign(RAW_SKILLS, {

  // -------- Generation (7) --------
  'needle_feint': {                               
    id: "needle_feint",
    name: "Needle Feint",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["dagger"],
    requiredStat: "DEX",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 2,
    hpCost: 0,
    positionRequirement: ["front", "mid"],
    requiresTarget: true,
    targetRequirement: "enemy",
    targetColumns: ["front", "mid"],
    cooldown: 1,
    tags: ["melee", "attack", "expose"],
    emitTagsOnUse: ["feint"],
    // tooltip
    buildupHint: { expose: 1110 },
    // reward on tier cross
    rewardIfTierCross: [{ family: "expose", tier: 1, buff: { critChanceBonusPct: 10, turns: 1, statusId: 'reward_needle_feint_crit' } }],
    apply: (attacker, target) => {
      const ability = SKILLS?.needle_feint;
      const roll = calculateDamage(attacker, target);
      const amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const reward = Array.isArray(ability?.rewardIfTierCross)
        ? ability.rewardIfTierCross.map(rule => ({
          ...rule,
          buff: rule.buff ? { ...rule.buff } : undefined,
          debuff: rule.debuff ? { ...rule.debuff } : undefined,
        }))
        : undefined;

      return {
        ...roll,
        amount,
        buildup: { expose: 1110 },
        rewardIfTierCross: reward,
      };
    },
    description: "Quick stab that exposes a weakness; crossing T1 grants brief crit."
  },

  'needle_venom': {
    id: "needle_venom",
    name: "Needle Venom",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["dagger"],
    requiredStat: "DEX",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "toxic"],
    buildupHint: { toxic: 70 },
    rewardIfWeak: { family: "expose", tierAtLeast: 1, buff: { addBuildup: { toxic: 30 } } },
    apply: (attacker, target) => {
      const ability = SKILLS?.needle_venom;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const exposeTier = target?.weakness?.tiers?.expose || 0;
      let toxicBuildup = 70;
      if (exposeTier >= 1) {
        amount = Math.floor(amount * 1.15);
        toxicBuildup += 30;
      }

      return {
        ...roll,
        amount,
        buildup: { toxic: toxicBuildup },
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
      };
    },
    description: "Reliable poison builder; stronger if the target is Exposed."
  },

  'pressure_point': {
    id: "pressure_point",
    name: "Pressure Point",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["dagger"],
    requiredStat: "DEX",
    requiredValue: 16,
    actionCost: "bonus",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "expose"],
    buildupHint: { expose: 80 },
    rewardIfTierCross: [{ family: "expose", tier: 2, buff: { nextSkillDamagePct: 20, turns: 1 } }],
    apply: (attacker, target) => {
      const ability = SKILLS?.pressure_point;
      const roll = calculateDamage(attacker, target, ability);
      const dex = attacker?.totalStats?.DEX || 0;
      const precisionBonus = Math.floor(dex / 6);
      let base = roll.amount + precisionBonus;
      let amount = Math.max(1, applyDamageModifiers(base, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const exposeTier = target?.weakness?.tiers?.expose || 0;
      if (exposeTier >= 1) {
        amount = Math.floor(amount * 1.1);
      }

      return {
        ...roll,
        amount,
        buildup: { expose: 80 },
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
      };
    },
    description: "Precise strike that ramps Expose; hitting T2 buffs your next skill this turn."
  },

  'ghoststep': {
    id: "ghoststep",
    name: "Ghoststep",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["dagger"],
    requiredStat: "CHA",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 4,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["stealth", "support"],
    statusEffects: [{ id: "stealth", turns: 1 }],
    rewardIfWeak: { family: "expose", tierAtLeast: 1, buff: { evasionPct: 10, turns: 1, scope: "selfNearExposed" } },
    apply: (attacker, _target, scene) => {
      const ability = SKILLS?.ghoststep;
      const statusEffects = Array.isArray(ability?.statusEffects)
        ? ability.statusEffects.map(effect => ({ ...effect }))
        : [];

      let nearExposed = false;
      if (scene && typeof scene._getUnitColumn === 'function' && typeof scene._getColumnBySlotId === 'function') {
        const column = scene._getUnitColumn(attacker);
        if (column) {
          const opposingSlots = attacker?.isEnemy ? scene.allySlots : scene.enemySlots;
          nearExposed = opposingSlots?.some(slot => {
            if (!slot || scene._getColumnBySlotId(slot.slotId) !== column) return false;
            const unit = slot.char;
            if (!unit || unit.status === 'incapacitated') return false;
            return (unit?.weakness?.tiers?.expose || 0) >= 1;
          }) || false;
        }
      }

      if (nearExposed) {
        const buff = ability?.rewardIfWeak?.buff || {};
        statusEffects.push({
          id: 'ghoststep_evasion',
          turns: buff.turns ?? 1,
          evasionPct: buff.evasionPct ?? 10,
        });
      }

      const log = nearExposed
        ? `${attacker.name} melts into shadow, drawing cover from exposed foes.`
        : `${attacker.name} slips into the shadows.`;

      return {
        amount: 0,
        statusEffects,
        log,
      };
    },
    description: "Slip into stealth; standing near Exposed foes grants extra evasion."
  },

  'hex_stitch': {
    id: "hex_stitch",
    name: "Hex Stitch",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["dagger"],
    requiredStat: "INT",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["curse", "magic", "attack"],
    buildupHint: { curse: 60 },
    aoe: { shape: "circle", scale: 1 }, // “adjacent” in your tooltip
    proliferateWeakness: { families: ["curse"], to: "adjacent", ratio: 0.5, maxTargets: 2 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.hex_stitch;
      const roll = calculateDamage(attacker, target, ability);
      const intBonus = Math.floor((attacker?.totalStats?.INT || 0) / 3);
      const preAmount = roll.amount + intBonus;
      let amount = Math.max(1, applyDamageModifiers(preAmount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: 'curse',
        isMagic: true,
        skipGearMultiplier: true,
      }));

      const curseTier = target?.weakness?.tiers?.curse || 0;
      if (curseTier > 0) {
        const meter = target?.weakness?.meters?.curse || 0;
        const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
        const tierBonus = 0.12 * curseTier;
        const overflowBonus = Math.max(0, intensity - 1) * 0.08;
        amount = Math.floor(amount * (1 + tierBonus + overflowBonus));
      }

      let splash;
      if (scene && typeof scene._getUnitColumn === 'function' && typeof scene._getColumnBySlotId === 'function') {
        const column = scene._getUnitColumn(target);
        if (column) {
          const sideSlots = target?.isEnemy ? scene.enemySlots : scene.allySlots;
          const neighbors = sideSlots
            ?.filter(slot => slot?.char && slot.char !== target && slot.char.status !== 'incapacitated' && scene._getColumnBySlotId(slot.slotId) === column)
            .slice(0, 2) || [];
          if (neighbors.length) {
            const splashAmount = Math.max(1, Math.floor(amount * 0.55));
            const splashBuildup = Math.max(1, Math.floor(ability?.buildupHint?.curse ? ability.buildupHint.curse * 0.5 : 30));
            splash = neighbors.map(slot => ({
              target: slot.char,
              amount: splashAmount,
              isMagic: true,
              buildup: { curse: splashBuildup },
              tags: ability?.tags,
            }));
          }
        }
      }

      return {
        ...roll,
        amount,
        isMagic: true,
        buildup: { curse: 60 },
        splash,
      };
    },
    description: "Applies lingering Curse; spreads half the current Curse to nearby enemies."
  },

  'static_prick': {
    id: "static_prick",
    name: "Static Prick",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["dagger"],
    requiredStat: "DEX",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lightning"],
    buildupHint: { lightning: 60 },
    rewardIfWeak: { family: "lightning", tierAtLeast: 1, buff: { chanceExtraHitPct: 25 } },
    apply: (attacker, target) => {
      const ability = SKILLS?.static_prick;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: 'lightning',
        skipGearMultiplier: true,
      }));

      const lightningTier = target?.weakness?.tiers?.lightning || 0;
      let buildup = 60;
      let extraHitAmount = 0;
      if (lightningTier >= 1) {
        amount = Math.floor(amount * 1.1);
        buildup += 20;
        const chance = ability?.rewardIfWeak?.buff?.chanceExtraHitPct || 0;
        if (chance > 0 && (Math.random() * 100) < chance) {
          extraHitAmount = Math.max(1, Math.floor(amount * 0.35));
          amount += extraHitAmount;
        }
      }

      return {
        ...roll,
        amount,
        buildup: { lightning: buildup },
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
        extraHits: extraHitAmount ? [{ amount: extraHitAmount, element: 'lightning' }] : undefined,
      };
    },
    description: "Seeds Shock; against Shocked foes, chance to add a bonus light hit."
  },

  'street_panacea': {
    id: "street_panacea",
    name: "Street Panacea",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["dagger"],
    requiredStat: "CHA",
    requiredValue: 15,
    actionCost: "bonus",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "ally",
    tags: ["support", "mp", "cleanse"],
    apply: (attacker, target, scene) => {
      if (!target) {
        return { amount: 0, log: `${attacker.name} fumbles for a vial but finds no recipient.` };
      }

      const cha = attacker?.totalStats?.CHA || 0;
      const baseRestore = 3 + Math.floor(cha / 5);
      let bonus = 0;

      if (scene && typeof scene._getUnitColumn === 'function' && typeof scene._getColumnBySlotId === 'function') {
        const column = scene._getUnitColumn(target);
        if (column) {
          const enemySlots = target?.isEnemy ? scene.allySlots : scene.enemySlots;
          const diseasedNearby = enemySlots?.some(slot => {
            if (!slot || scene._getColumnBySlotId(slot.slotId) !== column) return false;
            const foe = slot.char;
            if (!foe || foe.status === 'incapacitated') return false;
            return (foe?.weakness?.tiers?.disease || 0) >= 1;
          });
          if (diseasedNearby) bonus += 2;
        }
      }

      const restore = Math.max(0, baseRestore + bonus);
      if (restore > 0) {
        const maxMP = target.maxMP || target.derived?.maxMP || 0;
        if (maxMP > 0) {
          target.currentMP = Math.min(maxMP, (target.currentMP || 0) + restore);
        } else {
          target.currentMP = (target.currentMP || 0) + restore;
        }
      }

      let cleansed = false;
      if (target?.weakness?.meters?.disease > 0) {
        const newMeter = Math.max(0, target.weakness.meters.disease - 60);
        target.weakness.meters.disease = newMeter;
        if (target.weakness.tiers) {
          target.weakness.tiers.disease = weaknessTierFromMeter(newMeter);
        }
        cleansed = true;
      }

      const logParts = [`${attacker.name} administers a quick tonic to ${target.name}, restoring ${restore} MP.`];
      if (bonus > 0) logParts.push('Nearby illness sharpens the mixture.');
      if (cleansed) logParts.push('Some lingering disease fades.');

      return {
        amount: 0,
        log: logParts.join(' '),
      };
    },
    description: "Restore small MP to self/ally; a bit more if any nearby enemy is Diseased."
  },

  // -------- Payoff (6) --------
  'heartpiercer': {
    id: "heartpiercer",
    name: "Heartpiercer",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["dagger"],
    requiredStat: "DEX",
    requiredValue: 18,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "execute"],
    requiresWeakness: { family: "expose", tierAtLeast: 1 },
    rewardIfWeak: { family: "expose", tierAtLeast: 2, buff: { critMultBonus: 0.5 } },
    apply: (attacker, target) => {
      const ability = SKILLS?.heartpiercer;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const exposeTier = target?.weakness?.tiers?.expose || 0;
      const finisherBase = 1.35 + Math.max(0, exposeTier - 1) * 0.1;
      amount = Math.floor(amount * finisherBase);

      return {
        ...roll,
        amount,
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
      };
    },
    description: "Heavy finisher usable only on Exposed targets; bigger crits at T2. Does not consume."
  },

  'venom_bloom': {
    id: "venom_bloom",
    name: "Venom Bloom",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["dagger"],
    requiredStat: "DEX",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "toxic", "consume"],
    requiresWeakness: { family: "toxic", tierAtLeast: 1 },
    consumeWeakness: ["toxic"],
    buildupHint: { toxic: 100 }, // for tooltip: intended consumption cap
    rewardIfWeak: { family: "toxic", tierAtLeast: 2, buff: { extraRapidTicks: 1 } },
    apply: (attacker, target) => {
      const ability = SKILLS?.venom_bloom;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const toxicMeter = target?.weakness?.meters?.toxic || 0;
      const toxicTier = target?.weakness?.tiers?.toxic || 0;
      const intensity = Math.max(1, weaknessIntensityMult(toxicMeter) || 1);
      const rapidTicks = 3 + (toxicTier >= 2 ? 1 : 0);
      const tickBase = Math.max(1, Math.floor((attacker?.totalStats?.DEX || 0) / 6) + Math.floor(toxicMeter / 45));
      const rapidDamage = Math.max(0, tickBase * rapidTicks);

      amount += rapidDamage;

      return {
        ...roll,
        amount,
        consumeWeakness: ability?.consumeWeakness ? [...ability.consumeWeakness] : undefined,
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
        rapidWeakness: rapidDamage ? { family: 'toxic', ticks: rapidTicks, snapshotIntensity: intensity } : undefined,
      };
    },
    description: "Consume Toxic to trigger rapid DOT ticks (snapshot). Adds a 4th tick at T2."
  },

  'silent_order': {
    id: "silent_order",
    name: "Silent Order",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["dagger"],
    requiredStat: "CHA",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "stealth"],
    rewardIfWeak: { family: "expose", tierAtLeast: 1, buff: { damagePct: 15 } },
    apply: (attacker, target) => {
      const ability = SKILLS?.silent_order;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const exposeTier = target?.weakness?.tiers?.expose || 0;
      if (exposeTier >= 1) {
        amount = Math.floor(amount * 1.15);
      }

      return {
        ...roll,
        amount,
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
      };
    },
    description: "Stealth-friendly strike that hits harder when the target is Exposed. Does not consume Expose."
  },

  'curse_snap': {
    id: "curse_snap",
    name: "Curse Snap",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["dagger"],
    requiredStat: "INT",
    requiredValue: 18,
    actionCost: "major",
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["curse", "amplify", "magic"],
    requiresWeakness: { family: "curse", tierAtLeast: 1 },
    apply: (attacker, target) => {
      const ability = SKILLS?.curse_snap;
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

  'flash_overload': {
    id: "flash_overload",
    name: "Flash Overload",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["dagger"],
    requiredStat: "DEX",
    requiredValue: 17,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lightning", "amplify"],
    requiresWeakness: { family: "lightning", tierAtLeast: 1 },
    rewardIfWeak: { family: "lightning", tierAtLeast: 2, buff: { repeatStrikeOnce: true, repeatPowerPct: 60 } },
    apply: (attacker, target) => {
      const ability = SKILLS?.flash_overload;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: 'lightning',
        skipGearMultiplier: true,
      }));

      const lightningTier = target?.weakness?.tiers?.lightning || 0;
      let repeatDamage = 0;
      if (lightningTier >= 1) {
        amount = Math.floor(amount * 1.2);
      }
      if (lightningTier >= 2) {
        const pct = ability?.rewardIfWeak?.buff?.repeatPowerPct ?? 60;
        repeatDamage = Math.max(1, Math.floor(amount * (pct / 100)));
        amount += repeatDamage;
      }

      return {
        ...roll,
        amount,
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
        extraHits: repeatDamage ? [{ amount: repeatDamage, element: 'lightning', repeat: true }] : undefined,
      };
    },
    description: "Requires Shocked target; at T2 repeats the strike once at reduced power."
  },

  'vein_tap': {
    id: "vein_tap",
    name: "Vein Tap",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["dagger"],
    requiredStat: "INT",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 8,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "transform"],
    requiresWeakness: { family: "lacerate", tierAtLeast: 1 },
    transformWeakness: { from: "lacerate", to: "toxic", ratio: 0.75 },
    buildupHint: { lacerate: 100 }, // tooltip: transform cap
    rewardIfWeak: { family: "expose", tierAtLeast: 1, buff: { addBuildup: { toxic: 30 } } },
    apply: (attacker, target) => {
      const ability = SKILLS?.vein_tap;
      const roll = calculateDamage(attacker, target, ability);
      const intBonus = Math.floor((attacker?.totalStats?.INT || 0) / 4);
      const base = roll.amount + intBonus;
      let amount = Math.max(1, applyDamageModifiers(base, attacker, target, {
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
          if (target.weakness.tiers) {
            target.weakness.tiers[fromKey] = weaknessTierFromMeter(target.weakness.meters[fromKey]);
            target.weakness.tiers[toKey] = weaknessTierFromMeter(target.weakness.meters[toKey]);
          }
          transformed = { from: fromKey, to: toKey, amount: transfer };
        }
      }

      const exposeTier = target?.weakness?.tiers?.expose || 0;
      const buildup = exposeTier >= 1 ? { toxic: 30 } : undefined;
      const log = transformed
        ? `${attacker.name} taps the wound, turning bleed into venom.`
        : undefined;

      return {
        ...roll,
        amount,
        buildup,
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
        transformedWeakness: transformed,
        log,
      };
    },
    description: "Transforms Bleed into Poison and strikes; adds bonus Poison if the target is also Exposed."
  },

  // v3.21 1h sword skills - reactions pending 


  'marked_cut': {
    id: "marked_cut",
    name: "Marked Cut",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sword_1h"],
    requiredStat: "DEX",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "expose"],
    emitTagsOnUse: ["slash"],
    buildupHint: { expose: 60 },
    apply: (attacker, target) => {
      const ability = SKILLS?.marked_cut;
      const roll = calculateDamage(attacker, target, ability);
      const amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      if (target) markSword1hHit(target, attacker, ability?.id);
      markSword1hUse(attacker, ability?.id);
      return {
        ...roll,
        amount,
        buildup: { expose: ability?.buildupHint?.expose ?? 60 },
      };
    },
    description: "A quick slice that exposes a weakness for later exploitation."
  },

  'guarded_slash': {
    id: "guarded_slash",
    name: "Guarded Slash",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sword_1h"],
    requiredStat: "STR",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "cold"],
    buildupHint: { cold: 60 },
    rewardIfWeak: { family: "cold", tierAtLeast: 1, buff: { guardPct: 10, turns: 1 } },
    apply: (attacker, target) => {
      const ability = SKILLS?.guarded_slash;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: 'cold',
        skipGearMultiplier: true,
      }));
      const coldTier = target?.weakness?.tiers?.cold || 0;
      if (coldTier >= 1) {
        amount = Math.floor(amount * (1 + 0.08 * coldTier));
      }
      const buildupVal = ability?.buildupHint?.cold ?? 60;
      if (target) markSword1hHit(target, attacker, ability?.id);
      markSword1hUse(attacker, ability?.id);
      return {
        ...roll,
        amount,
        element: 'cold',
        buildup: { cold: buildupVal },
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
      };
    },
    description: "A guarded swing that chills the foe while raising your guard."
  },

  'rhythm_blow': {
    id: "rhythm_blow",
    name: "Rhythm Blow",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sword_1h"],
    requiredStat: "CHA",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack"],
    comboHint: { lastTurnWeapon: "sword_1h" },
    mpRestoreOnChain: 2,
    apply: (attacker, target) => {
      const ability = SKILLS?.rhythm_blow;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      amount = Math.max(1, Math.floor(amount * 0.9));
      const chainReady = hasSword1hChainReady(attacker);
      let mpRestored = 0;
      if (chainReady && ability?.mpRestoreOnChain) {
        const gain = ability.mpRestoreOnChain;
        const maxMP = attacker?.maxMP ?? attacker?.derived?.maxMP ?? 0;
        const before = attacker?.currentMP ?? 0;
        const after = maxMP > 0 ? Math.min(maxMP, before + gain) : before + gain;
        mpRestored = Math.max(0, after - before);
        attacker.currentMP = after;
      }
      const log = mpRestored > 0
        ? `${attacker?.name || 'The swordsman'} keeps tempo and regains ${mpRestored} MP.`
        : undefined;
      if (target) markSword1hHit(target, attacker, ability?.id);
      markSword1hUse(attacker, ability?.id);
      return {
        ...roll,
        amount,
        log,
      };
    },
    description: "A tempo-setter; keep the beat with a follow-up strike that restores MP when chained."
  },

  'soft_spot_exposed': {
    id: "soft_spot_exposed",
    name: "Soft Spot Exposed",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sword_1h"],
    requiredStat: "STR",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "expose"],
    buildupHint: { expose: 600 }, //testing
    rewardIfTierCross: [{ family: "expose", tier: 2, debuff: { physicalVulnPct: 10, turns: 2 } }],
    apply: (attacker, target) => {
      const ability = SKILLS?.soft_spot_exposed;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      const exposeTier = target?.weakness?.tiers?.expose || 0;
      if (exposeTier >= 1) {
        amount = Math.floor(amount * (1 + 0.08 * exposeTier));
      }
      if (target) markSword1hHit(target, attacker, ability?.id);
      markSword1hUse(attacker, ability?.id);
      return {
        ...roll,
        amount,
        buildup: { expose: ability?.buildupHint?.expose ?? 600 }, //testing
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
      };
    },
    description: "A strike that makes the target more vulnerable to physical damage."
  },

  'sword_flourish': {
    id: "sword_flourish",
    name: "Sword Flourish",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sword_1h"],
    requiredStat: "DEX",
    requiredValue: 13,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "expose"],
    aoe: { shape: "cone", scale: 1 },
    proliferateWeakness: { families: ["expose"], to: "adjacent", ratio: 1.0, maxTargets: 1 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.sword_flourish;
      const roll = calculateDamage(attacker, target, ability);
      const baseBuildup = ability?.buildupHint?.expose ?? 50;
      const ratio = ability?.proliferateWeakness?.ratio ?? 1;
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      const splash = [];
      const spreadMeta = [];
      const predictedExpose = (target?.weakness?.meters?.expose || 0) + baseBuildup;
      if (scene && target && typeof scene._getUnitColumn === 'function' && typeof scene._getColumnBySlotId === 'function') {
        const column = scene._getUnitColumn(target);
        if (column) {
          const sideSlots = target?.isEnemy ? scene.enemySlots : scene.allySlots;
          const neighbors = sideSlots
            ?.filter(slot => slot?.char && slot.char !== target && slot.char.status !== 'incapacitated' && scene._getColumnBySlotId(slot.slotId) === column)
            .map(slot => slot.char) || [];
          const maxTargets = ability?.proliferateWeakness?.maxTargets ?? 1;
          neighbors.slice(0, maxTargets).forEach(char => {
            const splashAmount = Math.max(1, Math.floor(amount * 0.7));
            const splashBuildup = Math.max(1, Math.floor(baseBuildup * 0.75));
            splash.push({
              target: char,
              amount: splashAmount,
              buildup: { expose: splashBuildup },
              tags: ability?.tags,
            });
            if (char?.weakness && predictedExpose > 0) {
              const transfer = Math.max(0, Math.floor(predictedExpose * ratio));
              if (transfer > 0) {
                char.weakness.meters = char.weakness.meters || {};
                char.weakness.tiers = char.weakness.tiers || {};
                char.weakness.meters.expose = (char.weakness.meters.expose || 0) + transfer;
                char.weakness.tiers.expose = weaknessTierFromMeter(char.weakness.meters.expose);
                spreadMeta.push({ targetId: char.id || char.name, family: 'expose', amount: transfer });
              }
            }
            markSword1hHit(char, attacker, ability?.id);
          });
        }
      }
      if (target) markSword1hHit(target, attacker, ability?.id);
      markSword1hUse(attacker, ability?.id);
      return {
        ...roll,
        amount,
        buildup: { expose: baseBuildup },
        splash: splash.length ? splash : undefined,
        proliferatedWeakness: spreadMeta.length ? spreadMeta : undefined,
      };
    },
    description: "A sweeping flourish that hits two adjacent foes."
  },

  'read_and_react': {
    id: "read_and_react",
    name: "Read and React",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sword_1h"],
    requiredStat: "WIS",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 2,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["stance", "support"],
    statusEffects: [{ id: "read_and_react", turns: 1, nextVsExposeDamagePct: 20 }],
    apply: (attacker) => {
      const ability = SKILLS?.read_and_react;
      const statusEffects = Array.isArray(ability?.statusEffects)
        ? ability.statusEffects.map(effect => ({ ...effect }))
        : [];
      markSword1hUse(attacker, ability?.id);
      return {
        amount: 0,
        statusEffects,
      };
    },
    description: "Study an opponent’s movements and prepare; later attacks against exposed enemies are empowered."
  },

  'power_riposte': {
    id: "power_riposte",
    name: "Power Riposte",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sword_1h"],
    requiredStat: "DEX",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "finisher"],
    requiresWeakness: { family: "expose", tierAtLeast: 1 },
    scaleWithTier: { family: "expose", perTierDamagePct: 15 },
    apply: (attacker, target) => {
      const ability = SKILLS?.power_riposte;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      const exposeTier = target?.weakness?.tiers?.expose || 0;
      const perTier = ability?.scaleWithTier?.perTierDamagePct ?? 15;
      if (exposeTier > 0) {
        amount = Math.floor(amount * (1 + (perTier * exposeTier) / 100));
      }
      const meter = target?.weakness?.meters?.expose || 0;
      if (meter > 0) {
        const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
        amount = Math.floor(amount * (1 + Math.max(0, intensity - 1) * 0.12));
      }
      if (target) markSword1hHit(target, attacker, ability?.id);
      markSword1hUse(attacker, ability?.id);
      return {
        ...roll,
        amount,
      };
    },
    description: "A heavy counter that punishes exposed foes; scales with Expose tier."
  },

  'glacial_parry': {
    id: "glacial_parry",
    name: "Glacial Parry",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sword_1h"],
    requiredStat: "WIS",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "cold", "consume"],
    requiresWeakness: { family: "cold", tierAtLeast: 2 },
    consumeWeakness: ["cold"],
    statusEffects: [{ id: "immobilized", turns: 1 }],
    apply: (attacker, target) => {
      const ability = SKILLS?.glacial_parry;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: 'cold',
        skipGearMultiplier: true,
      }));
      const coldMeter = target?.weakness?.meters?.cold || 0;
      if (coldMeter > 0) {
        const intensity = Math.max(1, weaknessIntensityMult(coldMeter) || 1);
        amount = Math.floor(amount * (1 + Math.max(0.15, intensity * 0.15)));
      }
      const statusEffects = Array.isArray(ability?.statusEffects)
        ? ability.statusEffects.map(effect => ({ ...effect }))
        : undefined;
      if (target) markSword1hHit(target, attacker, ability?.id);
      markSword1hUse(attacker, ability?.id);
      return {
        ...roll,
        amount,
        element: 'cold',
        statusEffects,
        consumeWeakness: ability?.consumeWeakness ? [...ability.consumeWeakness] : undefined,
      };
    },
    description: "Convert Cold stacks into a freezing slash, immobilizing the target."
  },

  'taunting_slash': {
    id: "taunting_slash",
    name: "Taunting Slash",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sword_1h"],
    requiredStat: "CHA",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "taunt"],
    requiresWeakness: { family: "expose", tierAtLeast: 2 },
    statusEffects: [{ id: "taunted", turns: 1 }],
    apply: (attacker, target) => {
      const ability = SKILLS?.taunting_slash;
      const roll = calculateDamage(attacker, target, ability);
      const chaBonus = Math.floor((attacker?.totalStats?.CHA || 0) / 4);
      const amount = Math.max(1, applyDamageModifiers(roll.amount + chaBonus, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      const turns = ability?.statusEffects?.[0]?.turns ?? 1;
      const statusEffects = [{
        id: 'taunted',
        turns,
        data: { forcedTarget: attacker?.id || attacker?.name || null },
      }];
      if (target) markSword1hHit(target, attacker, ability?.id);
      markSword1hUse(attacker, ability?.id);
      return {
        ...roll,
        amount,
        statusEffects,
      };
    },
    description: "A provoking blow that draws aggro from exposed enemies."
  },

  'crescent_cleave': {
    id: "crescent_cleave",
    name: "Crescent Cleave",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sword_1h"],
    requiredStat: "STR",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "expose", "aoe"],
    aoe: { shape: "column", scale: 1 },
    rewardIfWeak: { family: "expose", tierAtLeast: 1, buff: { damagePct: 15 } },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.crescent_cleave;
      const roll = calculateDamage(attacker, target, ability);
      const baseBuildup = ability?.buildupHint?.expose ?? 40;
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      const splash = [];
      if (scene && target && typeof scene._getUnitColumn === 'function' && typeof scene._getColumnBySlotId === 'function') {
        const column = scene._getUnitColumn(target);
        if (column) {
          const sideSlots = target?.isEnemy ? scene.enemySlots : scene.allySlots;
          const others = sideSlots
            ?.filter(slot => slot?.char && slot.char !== target && slot.char.status !== 'incapacitated' && scene._getColumnBySlotId(slot.slotId) === column)
            .map(slot => slot.char) || [];
          others.forEach(char => {
            const splashAmount = Math.max(1, Math.floor(amount * 0.75));
            const splashBuildup = Math.max(1, Math.floor(baseBuildup * 0.7));
            splash.push({
              target: char,
              amount: splashAmount,
              buildup: { expose: splashBuildup },
              tags: ability?.tags,
            });
            markSword1hHit(char, attacker, ability?.id);
          });
        }
      }
      if (target) markSword1hHit(target, attacker, ability?.id);
      markSword1hUse(attacker, ability?.id);
      return {
        ...roll,
        amount,
        buildup: { expose: baseBuildup },
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
        splash: splash.length ? splash : undefined,
      };
    },
    description: "A broad arc that cleaves through multiple foes; deals bonus to enemies with Expose."
  },

  'momentum_strike': {
    id: "momentum_strike",
    name: "Momentum Strike",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sword_1h"],
    requiredStat: "DEX",
    requiredValue: 15,
    actionCost: "bonus",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "multi"],
    conditionHint: { targetWasHitBy: "sword_1h", withinTurns: 1 },
    onTrigger: { grantExtraHitPct: 100 },
    apply: (attacker, target) => {
      const ability = SKILLS?.momentum_strike;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      const chained = targetRecentlyHitBySword1h(target, attacker);
      let extraHitAmount = 0;
      if (chained) {
        extraHitAmount = Math.max(1, Math.floor(amount * 0.65));
        amount += extraHitAmount;
      }
      if (target) markSword1hHit(target, attacker, ability?.id);
      markSword1hUse(attacker, ability?.id);
      return {
        ...roll,
        amount,
        extraHits: chained ? [{ amount: extraHitAmount, tags: ability?.tags }] : undefined,
      };
    },
    description: "A quick follow-up that flows from a recent set-up."
  },

  'balancing_blow': {
    id: "balancing_blow",
    name: "Balancing Blow",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sword_1h"],
    requiredStat: "CON",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "leech"],
    requiresWeakness: { family: "expose", tierAtLeast: 1 },
    healSelfPctMissingHpPerTier: 6,
    apply: (attacker, target) => {
      const ability = SKILLS?.balancing_blow;
      const roll = calculateDamage(attacker, target, ability);
      const amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      let heal = 0;
      if (attacker) {
        const maxHP = attacker?.maxHP ?? attacker?.derived?.maxHP ?? 0;
        const currentHP = attacker?.currentHP ?? 0;
        const missing = Math.max(0, maxHP - currentHP);
        const exposeTier = target?.weakness?.tiers?.expose || 0;
        const pctPerTier = ability?.healSelfPctMissingHpPerTier || 0;
        const healPct = pctPerTier * exposeTier;
        if (missing > 0 && healPct > 0) {
          heal = Math.max(0, Math.floor(missing * (healPct / 100)));
          const newHP = maxHP > 0 ? Math.min(maxHP, currentHP + heal) : currentHP + heal;
          attacker.currentHP = newHP;
        }
      }
      if (target) markSword1hHit(target, attacker, ability?.id);
      markSword1hUse(attacker, ability?.id);
      return {
        ...roll,
        amount,
        log: heal > 0 ? `${attacker?.name || 'The swordsman'} siphons ${heal} HP.` : undefined,
      };
    },
    description: "A measured strike that siphons life from the exposed."
  },

  'shattering_cut': {
    id: "shattering_cut",
    name: "Shattering Cut",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sword_1h"],
    requiredStat: "STR",
    requiredValue: 18,
    actionCost: "major",
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "execute", "consume"],
    requiresWeakness: { family: "expose", tierAtLeast: 2 },
    consumeWeakness: ["expose"],
    debuffOnHit: { armorDownPct: 20, turns: 2 },
    apply: (attacker, target) => {
      const ability = SKILLS?.shattering_cut;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      const exposeTier = target?.weakness?.tiers?.expose || 0;
      const meter = target?.weakness?.meters?.expose || 0;
      const tierBonus = exposeTier > 0 ? 0.3 * exposeTier : 0;
      const intensity = meter > 0 ? Math.max(1, weaknessIntensityMult(meter) || 1) : 1;
      const overflowBonus = Math.max(0, intensity - 1) * 0.4;
      amount = Math.floor(amount * (1 + tierBonus + overflowBonus));
      const debuff = ability?.debuffOnHit;
      const statusEffects = debuff ? [{
        id: 'shattering_cut_sundered',
        turns: debuff.turns ?? 2,
        mods: { PhysicalResist: -Math.abs(debuff.armorDownPct || 20) },
      }] : undefined;
      if (target) markSword1hHit(target, attacker, ability?.id);
      markSword1hUse(attacker, ability?.id);
      return {
        ...roll,
        amount,
        statusEffects,
        consumeWeakness: ability?.consumeWeakness ? [...ability.consumeWeakness] : undefined,
      };
    },
    description: "A finishing blow that wrecks defenses; clears all Expose and reduces armor briefly."
  },

  // ===============================
  // v3.21 - Sling (1h) (13)
  // ===============================

  // -------- Generation (7) --------
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
    statusEffects: [{ id: "lodged", turns: 2, stacks: 1 }],
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
    description: "A flat, sharp stone that tends to lodge in the wound."
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
    requiresWeakness: { family: "lodged", tierAtLeast: 1 },
    consumeWeakness: ["lodged"],
    apply: (attacker, target) => {
      const ability = SKILLS?.shatter_lodge;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));

      const meter = target?.weakness?.meters?.lodged || 0;
      const tier = target?.weakness?.tiers?.lodged || 0;
      const intensity = Math.max(1, weaknessIntensityMult(meter) || 1);
      const burst = Math.max(0, Math.floor((meter / 12) + (tier * 8) + Math.max(0, intensity - 1) * 7));
      amount += burst;

      return {
        ...roll,
        amount,
        consumeWeakness: ability?.consumeWeakness ? [...ability.consumeWeakness] : undefined,
        log: burst ? `${attacker?.name || 'The slinger'} shatters the lodged stone for +${burst} damage.` : undefined,
      };
    },
    description: "Strike the lodged stone to shatter it inside the wound for burst damage."
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
    description: "A trick shot that skips down the line, spreading the primary target's condition."
  },
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
  // v3.21 - Staff (2h) (13)
  // ===============================

  // -------- Generation (7) --------
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
    versionTag: "v3.21",
    requiredWeapon: ["staff"],
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
      const ability = SKILLS?.arc_echo;
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
    description: "Synchronize with Shock to echo the discharge once at reduced power."
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

  // --- Dagger (1h) ---
  'feinting_jab': {
    id: "feinting_jab",
    name: "Feinting Jab",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["dagger"],
    requiredStat: "DEX",
    requiredValue: 10,
    actionCost: "bonus",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack"],
    cooldown: 1,
    apply: (attacker, target) => {
      const ability = SKILLS?.feinting_jab;
      const roll = calculateDamage(attacker, target, ability);
      const amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      return { ...roll, amount };
    },
    description: "A deceptive jab that keeps pressure on the foe."
  },

  'hailspike_stab': {
    id: "hailspike_stab",
    name: "Hailspike Stab",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["dagger"],
    requiredStat: "DEX",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 0,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "cold"],
    cooldown: 1,
    buildupHint: { cold: 50 },
    apply: (attacker, target) => {
      const ability = SKILLS?.hailspike_stab;
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
    description: "Quick cold-infused puncture."
  },

  'arterial_feint': {
    id: "arterial_feint",
    name: "Arterial Feint",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["dagger"],
    requiredStat: "CHA",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 0,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack"],
    cooldown: 2,
    rewardIfWeak: { family: "fire", tierAtLeast: 1, healHPpct: 0.03 },
    apply: (attacker, target) => {
      const ability = SKILLS?.arterial_feint;
      const roll = calculateDamage(attacker, target, ability);
      const amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      return {
        ...roll,
        amount,
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
      };
    },
    description: "Deceptive cut; siphons HP from burning foes."
  },

  // --- Sword (1h) ---
  'flaying_strike': {
    id: "flaying_strike",
    name: "Flaying Strike",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sword_1h"],
    requiredStat: "STR",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 0,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "expose"],
    cooldown: 1,
    buildupHint: { expose: 600 },
    apply: (attacker, target) => {
      const ability = SKILLS?.flaying_strike;
      const roll = calculateDamage(attacker, target, ability);
      const amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      if (target) markSword1hHit(target, attacker, ability?.id);
      markSword1hUse(attacker, ability?.id);
      return {
        ...roll,
        amount,
        buildup: { expose: ability?.buildupHint?.expose ?? 600 },
      };
    },
    description: "Hard strip-and-slash that exposes defenses."
  },

  'chilling_slice': {
    id: "chilling_slice",
    name: "Chilling Slice",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sword_1h"],
    requiredStat: "DEX",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 0,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "cold"],
    cooldown: 2,
    buildupHint: { cold: 600 },
    apply: (attacker, target) => {
      const ability = SKILLS?.chilling_slice;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: "cold",
        isMagic: true,
        skipGearMultiplier: true,
      }));
      const fireTier = target?.weakness?.tiers?.fire || 0;
      if (fireTier >= 1) {
        amount = Math.floor(amount * 1.15);
      }
      if (target) markSword1hHit(target, attacker, ability?.id);
      markSword1hUse(attacker, ability?.id);
      return {
        ...roll,
        amount,
        isMagic: true,
        element: "cold",
        buildup: { cold: ability?.buildupHint?.cold ?? 600 },
      };
    },
    description: "Quick cut that chills the target; extra bite vs burning foes."
  },

  'runic_spark': {
    id: "runic_spark",
    name: "Runic Spark",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sword_1h"],
    requiredStat: "INT",
    requiredValue: 10,
    actionCost: "bonus",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lightning"],
    cooldown: 1,
    buildupHint: { lightning: 60 },
    apply: (attacker, target) => {
      const ability = SKILLS?.runic_spark;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        element: "lightning",
        isMagic: true,
        skipGearMultiplier: true,
      }));
      const coldTier = target?.weakness?.tiers?.cold || 0;
      let consumeWeakness;
      if (coldTier === 2) {
        amount = Math.floor(amount * 1.3);
        consumeWeakness = ["cold"];
      }
      if (target) markSword1hHit(target, attacker, ability?.id);
      markSword1hUse(attacker, ability?.id);
      return {
        ...roll,
        amount,
        isMagic: true,
        element: "lightning",
        buildup: { lightning: ability?.buildupHint?.lightning ?? 60 },
        consumeWeakness,
      };
    },
    description: "Arc-charged slash that builds Lightning; heavily punishes Frozen foes."
  },

  'goading_pommel': {
    id: "goading_pommel",
    name: "Goading Pommel",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["sword_1h"],
    requiredStat: "CHA",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 0,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "control"],
    cooldown: 2,
    statusEffects: [{ id: "dazed", turns: 1 }],
    apply: (attacker, target) => {
      const ability = SKILLS?.goading_pommel;
      const roll = calculateDamage(attacker, target, ability);
      const amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      const statusEffects = Array.isArray(ability?.statusEffects)
        ? ability.statusEffects.map(effect => ({ ...effect }))
        : undefined;
      if (target) markSword1hHit(target, attacker, ability?.id);
      markSword1hUse(attacker, ability?.id);
      return { ...roll, amount, statusEffects };
    },
    description: "Blunt strike to rattle the foe."
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
      return { armReaction: true, consumeOn: "trigger", log: `${attacker.name} watches over their column.` };
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
    description: "Arm yourself to strike back when an ally in your column is attacked."
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

  // --- Axe (2h) ---
  'overhead_hew': {
    id: "overhead_hew",
    name: "Overhead Hew",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["axe_2h"],
    requiredStat: "STR",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack"],
    cooldown: 4,
    armorDebuff: 0.10,
    apply: (attacker, target) => {
      const ability = SKILLS?.overhead_hew;
      const roll = calculateDamage(attacker, target, ability);
      const amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      return { ...roll, amount, armorDebuff: ability?.armorDebuff };
    },
    description: "A cleaving blow that reduces armor for the next round."
  },

  'ember_cleave': {
    id: "ember_cleave",
    name: "Ember Cleave",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["axe_2h"],
    requiredStat: "STR",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "fire", "aoe"],
    cooldown: 2,
    buildupHint: { fire: 60 },
    cleave: { adjacentFactor: 0.5 },
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
      const coldTier = target?.weakness?.tiers?.cold || 0;
      let fireBuildup = ability?.buildupHint?.fire ?? 60;
      if (coldTier >= 1) {
        amount = Math.floor(amount * 1.15);
        fireBuildup += 20;
      }
      return {
        ...roll,
        amount,
        isMagic: true,
        element: "fire",
        buildup: { fire: fireBuildup },
        cleave: ability?.cleave ? { ...ability.cleave } : undefined,
      };
    },
    description: "Fiery chop that singes a neighbor; stronger vs Chilled/Frozen."
  },

  'rime_chop': {
    id: "rime_chop",
    name: "Rime Chop",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["axe_2h"],
    requiredStat: "CON",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 0,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "cold"],
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
      if (coldTier === 2) amount = Math.floor(amount * 1.5);
      return {
        ...roll,
        amount,
        isMagic: true,
        element: "cold",
        buildup: { cold: ability?.buildupHint?.cold ?? 60 },
      };
    },
    description: "Cold-laden chop; devastates Frozen foes."
  },

  'storm_splitter': {
    id: "storm_splitter",
    name: "Storm Splitter",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["axe_2h"],
    requiredStat: "CHA",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 0,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lightning"],
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
      return {
        ...roll,
        amount,
        isMagic: true,
        element: "lightning",
        buildup: { lightning: ability?.buildupHint?.lightning ?? 70 },
      };
    },
    description: "Thunderous cleave that builds Lightning; bonus vs Chilled/Frozen."
  },

  // --- Mace (2h) ---
  'bonecrusher': {
    id: "bonecrusher",
    name: "Bonecrusher",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["mace_2h"],
    requiredStat: "STR",
    requiredValue: 10,
    actionCost: "major",
    mpCost: 0,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "blunt", "disorient"],
    cooldown: 2,
    buildupHint: { disorient: 310 },
    apply: (attacker, target) => {
      const ability = SKILLS?.bonecrusher;
      const roll = calculateDamage(attacker, target, ability);
      const amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      return {
        ...roll,
        amount,
        buildup: { disorient: ability?.buildupHint?.disorient ?? 310 },
      };
    },
    description: "A crushing mace strike that dazes; repeated hits can Stun."
  },

  'plague_slam': {
    id: "plague_slam",
    name: "Plague Slam",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["mace_2h"],
    requiredStat: "STR",
    requiredValue: 10,
    actionCost: "major",
    mpCost: 0,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "disease"],
    cooldown: 2,
    buildupHint: { disease: 600 },
    apply: (attacker, target) => {
      const ability = SKILLS?.plague_slam;
      const roll = calculateDamage(attacker, target, ability);
      const amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      return {
        ...roll,
        amount,
        buildup: { disease: ability?.buildupHint?.disease ?? 600 },
      };
    },
    description: "Filthy overhead slam to test DISEASE buildup."
  },

  'earthshatter': {
    id: "earthshatter",
    name: "Earthshatter",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["mace_2h"],
    requiredStat: "STR",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 0,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "finisher"],
    cooldown: 3,
    rewardIfTierCross: [{ family: "any", tier: 2, healHPpct: 0.05 }],
    apply: (attacker, target) => {
      const ability = SKILLS?.earthshatter;
      const roll = calculateDamage(attacker, target, ability);
      const amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      return {
        ...roll,
        amount,
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
      };
    },
    description: "Crushing blow; if this push hits an elemental threshold, you siphon life."
  },

  'sanctified_slam': {
    id: "sanctified_slam",
    name: "Sanctified Slam",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["mace_2h"],
    requiredStat: "WIS",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lightning", "holy"],
    cooldown: 2,
    buildupHint: { lightning: 40 },
    rewardIfWeak: { family: "lightning", tierAtLeast: 1, healMP: 3 },
    apply: (attacker, target) => {
      const ability = SKILLS?.sanctified_slam;
      const roll = calculateDamage(attacker, target, ability);
      let amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      const lightningTier = target?.weakness?.tiers?.lightning || 0;
      if (lightningTier >= 1) amount = Math.floor(amount * 1.15);
      return {
        ...roll,
        amount,
        buildup: { lightning: ability?.buildupHint?.lightning ?? 40 },
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
      };
    },
    description: "Blessed impact that restores MP when striking a charged foe."
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

  // --- Sling (1h) ---
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

  // --- Bow (2h) ---
  'venom_shot': {
    id: "venom_shot",
    name: "Venom Shot",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["bow"],
    requiredStat: "DEX",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 0,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "toxic"],
    cooldown: 1,
    buildupHint: { toxic: 600 },
    apply: (attacker, target) => {
      const ability = SKILLS?.venom_shot;
      const roll = calculateDamage(attacker, target, ability);
      const amount = Math.max(1, applyDamageModifiers(roll.amount, attacker, target, {
        ability,
        tags: ability?.tags,
        skipGearMultiplier: true,
      }));
      return {
        ...roll,
        amount,
        buildup: { toxic: ability?.buildupHint?.toxic ?? 600 },
      };
    },
    description: "Poisoned arrow for testing TOXIC buildup."
  },

  'soothing_arrow': {
    id: "soothing_arrow",
    name: "Soothing Arrow",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["bow"],
    requiredStat: "DEX",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 0,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "cold"],
    cooldown: 2,
    buildupHint: { cold: 40 },
    rewardIfWeak: { family: "cold", tierAtLeast: 1, healHPpct: 0.04 },
    apply: (attacker, target) => {
      const ability = SKILLS?.soothing_arrow;
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
        buildup: { cold: ability?.buildupHint?.cold ?? 40 },
        rewardIfWeak: cloneRewardStruct(ability?.rewardIfWeak),
      };
    },
    description: "A calming shot; heals you when striking a chilled foe."
  },

  'hail_volley': {
    id: "hail_volley",
    name: "Hail Volley",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["bow"],
    requiredStat: "WIS",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "cold", "aoe"],
    cooldown: 3,
    buildupHint: { cold: 60 },
    apply: (attacker, target) => {
      const ability = SKILLS?.hail_volley;
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
        splashTargets: 1,
      };
    },
    description: "Cold-tipped volley that can catch a nearby foe."
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

  // --- Staff (2h) ---
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

  'restoration_light': {
    id: "restoration_light",
    name: "Restoration Light",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["staff"],
    requiredStat: "WIS",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "ally",
    tags: ["magic", "holy", "heal", "regen"],
    cooldown: 3,
    statusEffects: [{ id: "regen", turns: 2, tickHeal: 3 }],
    apply: (attacker, target) => {
      const ability = SKILLS?.restoration_light;
      const wis = attacker?.totalStats?.WIS ?? attacker?.WIS ?? 0;
      const healAmount = 10 + Math.floor(wis / 2);
      const statusEffects = Array.isArray(ability?.statusEffects)
        ? ability.statusEffects.map(effect => ({ ...effect }))
        : undefined;
      return {
        amount: healAmount,
        isHeal: true,
        statusEffects,
      };
    },
    description: "Restore moderate HP and grant regen for 2 turns."
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

  'curse_cinders': {
    id: "curse_cinders",
    name: "Curse of Cinders",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.21",
    requiredWeapon: ["staff"],
    requiredStat: "INT",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 1,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "curse", "necrotic"],
    cooldown: 2,
    requiresWeakness: { family: "curse", tierAtLeast: 1 },
    buildupHint: { curse: 60 },
    statusEffects: [{ id: "curse_cinders", turns: 3 }],
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.curse_cinders;
      const meter = target?.weakness?.meters?.curse || 0;
      if (meter < 100) {
        scene?._log?.(`${target?.name || "The target"} is not Hexed; Curse of Cinders fails.`);
        return { amount: 0, dealsDamage: false };
      }
      const intStat = attacker?.totalStats?.INT ?? attacker?.INT ?? 0;
      const base = 6 + (intStat >> 3);
      const amount = Math.max(1, applyDamageModifiers(base, attacker, target, {
        ability,
        tags: ability?.tags,
        element: "necrotic",
        isMagic: true,
        skipGearMultiplier: true,
      }));
      const statusEffects = Array.isArray(ability?.statusEffects)
        ? ability.statusEffects.map(effect => ({ ...effect, sourceId: attacker?.id ?? effect.sourceId }))
        : undefined;
      return {
        amount,
        isMagic: true,
        element: "necrotic",
        dealsDamage: true,
        buildup: { curse: ability?.buildupHint?.curse ?? 60 },
        statusEffects,
      };
    },
    description: "Afflicts the target with Cinders; adds CURSE buildup and lingering burn."
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

});

export const SKILLS = buildSkillRegistry(RAW_SKILLS);
// ======== Global Skill Test Mode (opt-in) - works on SKILLS object ========
const DEV_SKILL_TEST = {
  ENABLE: true,              // flip true for dev sessions
  zeroMpCost: true,
  zeroCooldown: true,
  ignoreStatReqs: true,       // sets requiredValue to 0
  ignoreWeaknessGates: false, // if true, bypass requiresWeakness checks in your gate
  // amplifyDamagePct: 0,     // optional future knob
};

function applyTestOverridesToAll(skillsObj, cfg = DEV_SKILL_TEST) {
  if (!cfg.ENABLE || !skillsObj) return;
  for (const s of Object.values(skillsObj)) {
    if (!s || s.type !== "weapon") continue;   // only weapon skills
    s._testOverrides = true;
    if (cfg.zeroMpCost && typeof s.mpCost === "number") s.mpCost = 0;
    if (cfg.zeroCooldown && typeof s.cooldown === "number") s.cooldown = 0;
    if (cfg.ignoreStatReqs && typeof s.requiredValue === "number") s.requiredValue = 0;
    if (cfg.ignoreWeaknessGates) s._skipWeaknessGates = true; // honor in canUseSkill gate
    // if (cfg.amplifyDamagePct) s._tempDamageAmpPct = cfg.amplifyDamagePct;
  }
}

// Call once after all skills (old + new) are in SKILLS:
applyTestOverridesToAll(SKILLS);
