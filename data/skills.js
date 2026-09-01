// @ts-nocheck
// data/skills.js
import { calculateDamage } from '../src/systems/CombatLogic.js';
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


// Transpose Fire/Lightning/Cold (Performer class skills) share one
// cooldown across all 3 distinct skill ids — see stampTransposeCooldowns.
const TRANSPOSE_COOLDOWN = 3;
const stampTransposeCooldowns = (user) => {
  user.cooldowns = user.cooldowns || {};
  user.cooldowns.transpose_fire = TRANSPOSE_COOLDOWN;
  user.cooldowns.transpose_lightning = TRANSPOSE_COOLDOWN;
  user.cooldowns.transpose_cold = TRANSPOSE_COOLDOWN;
};

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
export function applyRhythmStack(char, scene) {
  if (!char) return;
  char.statusEffects = char.statusEffects || [];
  const existing = char.statusEffects.filter(se => se?.id === 'rhythm_stack');
  existing.forEach(se => { se.turns = 2; }); // always refresh duration on all stacks
  if (existing.length < 3) {
    char.statusEffects.push({ id: 'rhythm_stack', turns: 2, stackable: true, mods: { AttackPower: 5 } });
    scene?._playStatusVFX?.(char, { kind: 'buff_power' });
  }
}

/**
 * dislodgeLodges(target, scene, count?)
 * Removes up to `count` lodged arrows from target.statusEffects and returns damage/effects.
 * Each lodge has an optional scalingBonus (e.g. 0.10 = +10% per additional lodge on target)
 * for its own baseDamage, and an optional { buildupOnDislodge: { family, amount },
 * buildupScalingBonus } pair for a buildup family it grants on pop (family is generic — any
 * lodge can name ANY weakness family here, e.g. Barbed Shaft names lacerate, a lightning-lodge
 * names lightning). Both damage and buildup scaling read off the TOTAL lodge count present at
 * pop time, mixed types included (e.g. a Lodge Arrow lodge counts toward a Barbed Shaft lodge's
 * own scaling, and vice versa).
 * Hunter's Mark on target amplifies all lodge DAMAGE by its own LodgeDamage% mod. The returned
 * `buildup` map is raw (NOT mark-amplified here, and NOT summed per-family across dislodge
 * calls beyond this one pop) — callers feed it through their own result.buildup like any other
 * buildup source, which is where Hunter's Mark's separate BuildupReceived% mod applies
 * generically (_applyWeaknessBuildup, CombatScene.js).
 */
export function dislodgeLodges(target, scene, count = Infinity, opts = {}) {
  if (!target) return { totalDamage: 0, totalHeal: 0, buildup: {}, dislodged: 0 };
  // Optional predicate scoping which lodges this pop actually touches — e.g.
  // Mending Barb's auto-dislodge-on-crit only wants to pop ITS OWN
  // healOnCrit lodges, never a damage lodge that happened to also be
  // present (in practice these never mix, since damage lodges go on
  // enemies and healing ones go on allies, but the filter makes that
  // explicit rather than assumed).
  const pool = typeof opts.filter === 'function'
    ? (target.statusEffects || []).filter(se => se?.id === 'lodged' && opts.filter(se))
    : (target.statusEffects || []).filter(se => se?.id === 'lodged');
  const allLodges = (target.statusEffects || []).filter(se => se?.id === 'lodged');
  const toRemove = isFinite(count) ? pool.slice(0, count) : pool;
  if (toRemove.length === 0) return { totalDamage: 0, totalHeal: 0, buildup: {}, dislodged: 0 };

  // Scaling reads off the TOTAL lodge count present (all lodges, not just
  // the ones this pop is removing) — same "every lodge on the target counts
  // toward everyone's scaling" rule the damage lodges already use.
  const totalLodges = allLodges.length;
  const huntersMark = (target.statusEffects || []).find(se => se?.id === 'hunters_mark' && (se.turns || 0) > 0);
  // Was hardcoded to a flat 1.25 regardless of what the mark's own
  // mods.LodgeDamage actually said — the field was rolled/stored but never
  // read, so editing it would have silently done nothing. Reads it live now.
  const markBonus = huntersMark ? 1 + ((huntersMark.mods?.LodgeDamage || 0) / 100) : 1.0;

  let totalDamage = 0;
  let totalHeal = 0;
  const buildup = {};
  for (const lodge of toRemove) {
    const additionalLodges = totalLodges - 1;
    const scale = lodge.scalingBonus ? (1 + lodge.scalingBonus * additionalLodges) : 1;
    totalDamage += Math.floor((lodge.baseDamage || 0) * scale * markBonus);
    // Heal side — symmetric to baseDamage/scalingBonus above, just no
    // Hunter's Mark amplification (that mod is explicitly damage-only).
    const healScale = lodge.healScalingBonus ? (1 + lodge.healScalingBonus * additionalLodges) : 1;
    totalHeal += Math.floor((lodge.baseHeal || 0) * healScale);
    const bo = lodge.buildupOnDislodge;
    if (bo?.family && bo?.amount) {
      const buScale = lodge.buildupScalingBonus ? (1 + lodge.buildupScalingBonus * additionalLodges) : 1;
      buildup[bo.family] = (buildup[bo.family] || 0) + Math.floor(bo.amount * buScale);
    }
  }

  const removeSet = new Set(toRemove);
  target.statusEffects = (target.statusEffects || []).filter(se => !removeSet.has(se));
  if (scene) {
    scene.lodgesDislodgedThisTurn = (scene.lodgesDislodgedThisTurn || 0) + toRemove.length;
    scene._refreshLodgeSprites?.(target);
  }
  return { totalDamage, totalHeal, buildup, dislodged: toRemove.length };
}

// Shared by hail_of_arrows and its own hail_of_arrows_shot sub-skill —
// each recipient's own weakness-category bonus, off THEIR OWN weakness
// tiers (any active tier counts, not just T2).
function hailOfArrowsMult(tgt) {
  let mul = 1.0;
  const t = tgt?.weakness?.tiers || {};
  if ((t.expose || 0) >= 1 || (t.lacerate || 0) >= 1 || (t.disorient || 0) >= 1) mul += 0.20;
  if ((t.fire || 0) >= 1 || (t.cold || 0) >= 1 || (t.lightning || 0) >= 1) mul += 0.20;
  if ((t.toxic || 0) >= 1 || (t.disease || 0) >= 1 || (t.curse || 0) >= 1) mul += 0.20;
  return mul;
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
    if (skill.hidden) continue;

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
    performer: ['transpose_fire', 'transpose_lightning', 'transpose_cold'],
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
    if (s.hidden) continue;

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
    typedDamage: true,
    actionCost: 'major',
    mpCost: 0,
    hpCost: 0,
    range: 1,
    positionRequirement: ['front', 'mid', 'back'],
    requiresTarget: true,
    targetRequirement: 'enemy',
    targetColumns: ['front', 'mid', 'back'],
    tags: ['melee', 'attack'],
    cooldown: 0,
    // Migrated to the typed pipeline (2026-07) for tooltip/architecture
    // consistency with the rest of the game — this was the single most-used
    // legacy-path skill left (gear% applied early instead of the very last
    // stage like every typed skill), which is exactly what made its
    // tooltip read differently from any modernized ability even though the
    // final damage number was always correct either way. calculateDamage()
    // still detects and folds in dual-wielding automatically regardless.
    apply: (attacker, target) => {
      const ability = SKILLS?.basic_attack;
      const roll = calculateDamage(attacker, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 100, skillLabel: 'Basic Attack weapon damage (100%)',
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return { ...roll, physical, elemental, necrotic, amount };
    },
    description: 'A quick physical strike.',
  },

  // --- Class Skills ---------------------------------------------------------
  // All six were pure stubs until this pass: each set a dead field
  // (user.hidden, target.blessing, ally.guardedBy, user.blockade,
  // ally.musicalMemory, user.statuses['dazed']) that nothing anywhere in
  // combat logic ever read. Rewired onto the same real status-effect system
  // (scene._addStatusEffects + the tracked mod keys in
  // CombatLogic._sumStatusEffectMods) that fighter_bulwark_call/
  // healer_blessing already use — these now actually do something in a
  // fight instead of silently no-oping.
  'meditate': {
    id: 'meditate',
    name: 'Meditate',
    type: 'class',
    actionCost: 'class',
    mpCost: 0,
    hpCost: 0,
    requiresTarget: false,
    cooldown: 2,
    description: 'Scholar: restore a bonus action and shake off crowd-control effects.',
    apply: (user, _target, scene) => {
      user.actionsLeft = user.actionsLeft || {};
      user.actionsLeft.bonus = (user.actionsLeft.bonus || 0) + 1;

      // The only real crowd-control this engine enforces is (a) blocksAction
      // (skip your whole turn — currently only 'frozen') and (b) the
      // 'immobilized' id (blocks repositioning specifically). Everything
      // else with a CC-sounding name (stunned, rooted) is a dead icon entry
      // no skill ever actually applies — nothing to clear there.
      const blocked = (user.statusEffects || []).filter(se => se?.blocksAction || se?.id === 'immobilized');
      blocked.forEach(se => scene?._clearScopedStatus?.(user, se.id));

      const parts = [`${user.name} meditates, ready to act again.`, 'Bonus action restored.'];
      if (blocked.length) parts.push(`Shakes off ${blocked.length === 1 ? 'a binding effect' : 'binding effects'}.`);
      scene?._log?.(parts.join(' '));
      scene?._playStatusVFX?.(user, { kind: 'buff_increase' });
      return { amount: 0 };
    }
  },

  // Usable only from the back row (requiresColumn — see the matching gate
  // in CombatScene._applyAbilityToTarget). Ends immediately with NO reward
  // if the Beggar takes any damage (breaksOnHitTaken, including AOE
  // splash). If instead the Beggar ATTACKS while still hidden (never having
  // been hit), that very attack gets +15 Accuracy via sneakAttackBonus —
  // CombatScene._applyAbilityToTarget grants it just before the hit roll,
  // specifically so it lands on the attack that breaks stealth rather than
  // some later one. (A first version tried granting the bonus only when
  // Hide's OWN timer naturally ticked to 0 via _tickDownStatusDurations —
  // found via a real playthrough that this never actually worked, since
  // that tick only fires at the OWNER'S OWN turn-end, always one full cycle
  // behind whenever the character could next act — the reward was never
  // present in time for the attack it was meant to reward.) onExpire below
  // is a fallback for the character never attacking at all while hidden —
  // grants the same bonus for whatever attack comes after Hide naturally
  // times out. Repositioning is safe — nothing here hooks movement at all.
  'hide': {
    id: 'hide',
    name: 'Hide',
    type: 'class',
    actionCost: 'class',
    mpCost: 0,
    hpCost: 0,
    requiresTarget: false,
    requiresColumn: 'back',
    cooldown: 3,
    description: 'Beggar: vanish into the crowd (back row only) for heavy Evasion. Ends if you\'re hit; attack while still hidden for bonus Accuracy.',
    apply: (user, _target, scene) => {
      scene?._addStatusEffects?.(user, [{
        id: 'hide', turns: 2,
        mods: { Evasion: 35 },
        breaksOnAttack: true,
        breaksOnHitTaken: true,
        sneakAttackBonus: 15,
        onExpire: { id: 'hide_reward', turns: 3, mods: { Accuracy: 15 }, breaksOnAttack: true, vfx: { kind: 'buff_increase' } },
        vfx: { kind: 'buff_increase' },
      }]);
      scene?._log?.(`${user.name} melts into the shadows.`);
      return { amount: 0 };
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
    description: 'Acolyte: bless an ally with +10 Accuracy and +10% damage for 3 turns.',
    apply: (user, target, scene) => {
      if (!target) return { amount: 0, log: `${user.name} tries to bless, but finds no target.` };
      scene?._addStatusEffects?.(target, [{ id: 'blessing', turns: 3, mods: { Accuracy: 10, AttackPower: 10 }, vfx: { kind: 'buff_increase' } }]);
      scene?._log?.(`${user.name} blesses ${target.name}.`);
      return { amount: 0 };
    }
  },

  // guardianWatch is a 4th _processTargetHitRiders shape (see that function
  // in CombatScene.js): when the warded ally takes a hit, the ward's own
  // duration is bumped up and the ATTACKER is marked vulnerable to bonus
  // damage specifically from this Shepherd (via the generic
  // data.vulnerableToId rider, also handled there).
  //
  // turns:2, not 1 — _tickDownStatusDurations ticks a status down once on
  // its OWNER'S OWN turn-end, not once per full round. A turns:1 status
  // applied to a character during (or before) their own turn dies at the
  // end of THAT SAME turn, before the enemy ever gets to act against it —
  // found via a real playthrough report (cast Watch Over on an ally who
  // hadn't acted yet, then Blockade on self; both vanished the instant that
  // turn ended, never surviving to the enemy's turn at all). turns:2 is the
  // established convention for "protect through the next enemy turn"
  // elsewhere (fighter_guard/heated_guard/icy_guard all use it for the same
  // reason).
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
    description: 'Shepherd: guard an ally, boosting their Resists. The ward holds longer if they\'re struck, and attackers take bonus damage from you.',
    apply: (user, ally, scene) => {
      if (!ally) return { amount: 0, log: `${user.name} looks for someone to guard.` };
      scene?._addStatusEffects?.(ally, [{
        id: 'watch_over', turns: 2,
        mods: { PhysicalResist: 10, ElementalResist: 10, NecroticResist: 10 },
        guardianWatch: { guardianId: user.id, guardianName: user.name, extendTurns: 3, markTurns: 2, markMult: 0.2 },
        // debuff_leer, not a buff kind — visually it's just a set of watchful
        // eyes, which fits "someone is looking out for you" better than any
        // of the actual buff assets, per explicit request.
        vfx: { kind: 'debuff_leer' },
      }]);
      scene?._log?.(`${user.name} watches over ${ally.name}.`);
      return { amount: 0 };
    }
  },

  // Usable only from the front row (requiresColumn:'front'), and its
  // enemyTargetingLocksFront data flag is read by
  // CombatScene._takeEnemyTurn_viaLogic to restrict ALL enemy targeting to
  // front-row characters for its duration — a deliberately simple first
  // test case for a real targeting-restriction system (not built out
  // further than this single flag yet).
  //
  // turns:2, not 1 — see watch_over's comment above for why a self-buff
  // meant to protect against the very next enemy turn needs 2, not 1
  // (_tickDownStatusDurations ticks on the OWNER's own turn-end, so
  // turns:1 dies at the end of the SAME turn it was cast, before the enemy
  // ever acts).
  'blockade': {
    id: 'blockade',
    name: 'Blockade',
    type: 'class',
    actionCost: 'class',
    mpCost: 0,
    hpCost: 0,
    requiresTarget: false,
    requiresColumn: 'front',
    cooldown: 3,
    description: 'Grunt: form a wall (front row only), boosting your own Resists and forcing enemies to target the front row.',
    apply: (user, _target, scene) => {
      scene?._addStatusEffects?.(user, [{
        id: 'blockade', turns: 2,
        mods: { PhysicalResist: 25, ElementalResist: 25, NecroticResist: 25 },
        data: { enemyTargetingLocksFront: true },
        vfx: { kind: 'buff_harden' },
      }]);
      scene?._log?.(`${user.name} forms a blockade — enemies must go through the front line.`);
      return { amount: 0 };
    }
  },

  // Replaces the old flat "Musical Memory" crit buff with 3 real spells —
  // Performer now gets all 3 as separate class-skill slots (getClassSkillsFor
  // already supports more than one id per class). They share ONE cooldown
  // (each apply() stamps all three cooldown keys, not just its own) so
  // using one doesn't leave the other two instantly available. The actual
  // conversion — redirecting the attacker's next buildup-applying hit into
  // one family, even physical/necrotic — happens in
  // CombatScene._applyWeaknessBuildup via the transposeBuildupTo rider;
  // this is a one-shot consumed on the first hit that has ANY buildup to
  // redirect (a pure damage hit with zero buildup component won't consume
  // it, and won't be spent on other characters' unrelated procs, either).
  'transpose_fire': {
    id: 'transpose_fire',
    name: 'Transpose: Fire',
    type: 'class',
    actionCost: 'class',
    mpCost: 5,
    hpCost: 0,
    requiresTarget: false,
    cooldown: TRANSPOSE_COOLDOWN,
    description: 'Performer: your next hit converts all its buildup into pure Fire. Shares a cooldown with the other Transpose spells.',
    apply: (user, _target, scene) => {
      scene?._addStatusEffects?.(user, [{ id: 'transpose_fire', turns: 3, transposeBuildupTo: 'fire', vfx: { kind: 'buff_magic' } }]);
      stampTransposeCooldowns(user);
      scene?._log?.(`${user.name} hums a searing refrain.`);
      return { amount: 0 };
    }
  },
  'transpose_lightning': {
    id: 'transpose_lightning',
    name: 'Transpose: Lightning',
    type: 'class',
    actionCost: 'class',
    mpCost: 5,
    hpCost: 0,
    requiresTarget: false,
    cooldown: TRANSPOSE_COOLDOWN,
    description: 'Performer: your next hit converts all its buildup into pure Lightning. Shares a cooldown with the other Transpose spells.',
    apply: (user, _target, scene) => {
      scene?._addStatusEffects?.(user, [{ id: 'transpose_lightning', turns: 3, transposeBuildupTo: 'lightning', vfx: { kind: 'buff_magic' } }]);
      stampTransposeCooldowns(user);
      scene?._log?.(`${user.name} hums a crackling refrain.`);
      return { amount: 0 };
    }
  },
  'transpose_cold': {
    id: 'transpose_cold',
    name: 'Transpose: Cold',
    type: 'class',
    actionCost: 'class',
    mpCost: 5,
    hpCost: 0,
    requiresTarget: false,
    cooldown: TRANSPOSE_COOLDOWN,
    description: 'Performer: your next hit converts all its buildup into pure Cold. Shares a cooldown with the other Transpose spells.',
    apply: (user, _target, scene) => {
      scene?._addStatusEffects?.(user, [{ id: 'transpose_cold', turns: 3, transposeBuildupTo: 'cold', vfx: { kind: 'buff_magic' } }]);
      stampTransposeCooldowns(user);
      scene?._log?.(`${user.name} hums a chilling refrain.`);
      return { amount: 0 };
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
    description: 'Cleanse all physical buildup (Lacerate, Expose, Disorient) from an ally. CD 2.'
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
    description: 'Cleanse all necrotic buildup (Disease, Curse, Toxic) from an ally. CD 2.'
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
    description: 'Cleanse all elemental buildup (Fire, Cold, Lightning) from an ally. CD 2.'
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
    description: 'Reduce all cooldowns of an ally by 3 turns. CD 3.'
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
    description: 'All damage dealt becomes elemental this turn. CD 3.'
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
    description: 'All damage dealt becomes physical this turn. CD 3.'
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
    description: 'All damage dealt becomes necrotic this turn. CD 3.'
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
    },
    description: 'Shifts one column sideways, changing which of your ranks can reach it.'
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

  // Encounter 3 - Animated Party Test
  'fighter_heavy_slash': {
    id: 'fighter_heavy_slash',
    name: 'Heavy Slash',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'major',
    mpCost: 5,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['melee','attack','expose'],
    // buildupHint added — see project_encounter3_vfx_sfx_pass. Mirrors the
    // flat buildup this already applies; static field is what
    // CombatScene._dominantBuildupFamily reads for attack-VFX tint, invisible
    // to it before this since it only saw the runtime apply() return.
    buildupHint: { expose: 90 },
    apply: (user, target) => {
      const ability = SKILLS?.fighter_heavy_slash;
      const roll = calculateDamage(user, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        user, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 66, skillLabel: `${ability?.name || 'Skill'} weapon damage (66%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return { ...roll, physical, elemental, necrotic, amount, buildup: { expose: 90 } };
    },
    description: "Deals 66% weapon damage and applies 90 Expose buildup."
  },
  'fighter_guarded_blow': {
    id: 'fighter_guarded_blow',
    name: 'Guarded Blow',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'bonus',
    mpCost: 4,
    cooldown: 2,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    // buildupHint added — see fighter_heavy_slash's comment above.
    buildupHint: { cold: 60 },
    // Guard buff was returned via statusEffects, which the engine ALWAYS
    // applies to the TARGET (see _applyAbilityToTarget's
    // `this._addStatusEffects(target, result.statusEffects)`) — meaning this
    // was actually granting +15 Physical Resist to whoever got hit, not the
    // fighter bracing itself. Applied directly to `user` instead, via the
    // same scene._addStatusEffects(char, effects) pattern fighter_bulwark_call
    // already uses for its own party-wide buff below.
    apply: (user, target, scene) => {
      scene?._addStatusEffects?.(user, [{ id: 'fighter_guard', turns: 2, mods: { PhysicalResist: 15 }, vfx: { kind: 'buff_harden' } }]);
      const ability = SKILLS?.fighter_guarded_blow;
      const roll = calculateDamage(user, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        user, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 33, skillLabel: `${ability?.name || 'Skill'} weapon damage (33%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
          skillConversion: { physToElemPct: 100 },
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return { ...roll, physical, elemental, necrotic, amount, isMagic: true, buildup: { cold: 60 } };
    },
    description: "Deals 33% weapon damage as Cold and applies 60 Cold buildup, while bracing itself for 2 turns (+15 Physical Resist)."
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
      return { amount: 0, statusEffects: [{ id: 'taunted', turns: 1, data: { forcedTarget: user?.id || null }, vfx: { kind: 'debuff_leer' } }] };
    },
    description: "Requires the target to be Exposed (T1+). Forces them to attack you on their next turn — no damage of its own."
  },
  'fighter_executioner': {
    id: 'fighter_executioner',
    name: "Executioner's Strike",
    type: 'enemy',
    typedDamage: true,
    actionCost: 'major',
    mpCost: 8,
    cooldown: 2,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['melee','attack','expose','consume'],
    requiresWeakness: { family: 'expose', tier: 2 },
    apply: (user, target) => {
      const ability = SKILLS?.fighter_executioner;
      const roll = calculateDamage(user, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        user, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 121, skillLabel: `${ability?.name || 'Skill'} weapon damage (121%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return { ...roll, physical, elemental, necrotic, amount, consumeWeakness: ['expose'] };
    },
    description: "Requires the target to be Flayed (Expose T2+). Deals 121% weapon damage and consumes their Expose buildup."
  },

  // Chad's signature — arms itself via the fighter_dummy AI profile (same
  // idempotent-arm pattern berserker_boss uses for Blood Fury). Redesigned
  // onto the new 'pre_hit' trigger (ReactionSystem.checkPreHit,
  // CombatScene._applyAbilityToTarget) — fires BEFORE the target's hit is
  // rolled at all, so this doesn't block/negate the hit, it substitutes
  // itself as the actual target: the attack resolves fresh against Chad's
  // own stats. Naturally only ever sees primary single-target resolution —
  // splash/AoE instances never route through this checkpoint, so there's no
  // separate "isSplash" flag to check here (unlike the old ally_hit version).
  'fighter_guardians_stand': {
    id: 'fighter_guardians_stand',
    name: "Guardian's Stand",
    type: 'enemy',
    mechanic: 'reaction',
    actionCost: 'reaction',
    mpCost: 4,
    cooldown: 3,
    enemyOnly: true,
    requiresTarget: false,
    reaction: {
      trigger: 'pre_hit',
      cooldownOn: 'trigger',
      canTrigger: ({ owner, target, scene }) =>
        scene?._getUnitColumn?.(owner) === scene?._getUnitColumn?.(target),
      exec: ({ owner, scene }) => {
        scene?._logLocal?.({ segments: [{ text: 'Chad! Chad! Chad!', color: '#ffd166' }] });
        return { redirectTo: owner };
      },
    },
    description: "Reaction: when an ally in your rank is targeted by a single-target attack, intercept it — the attack resolves against you instead."
  },

  // Chad's second signature — same initiative-spend-scales-the-effect shape
  // as Stan's Mending Wave. MP restore is fixed at 25% (not spend-scaled,
  // per the ask); the resist buff is what scales with spend.
  'fighter_bulwark_call': {
    id: 'fighter_bulwark_call',
    name: 'Bulwark Call',
    type: 'enemy',
    actionCost: 'class',
    mpCost: 6,
    cooldown: 4,
    enemyOnly: true,
    requiresTarget: false,
    requiresInitiativeGauge: 30,
    apply: (attacker, _target, scene) => {
      const spend = Math.min(attacker?.initiativeGauge || 0, 60);
      attacker.initiativeGauge = Math.max(0, (attacker.initiativeGauge || 0) - spend);
      // +10 all resists at the 30 minimum, up to +20 at the 60 cap.
      const resistBonus = Math.floor(spend / 3);

      const allySlots = attacker?.isEnemy ? scene?.enemySlots : scene?.allySlots;
      (allySlots || []).forEach(s => {
        const ally = s?.char;
        if (!ally || ally.status === 'incapacitated') return;
        scene?._addStatusEffects?.(ally, [{
          id: 'bulwark_call', turns: 2,
          mods: { PhysicalResist: resistBonus, ElementalResist: resistBonus, NecroticResist: resistBonus },
          vfx: { kind: 'buff_harden' },
        }]);
        const mpRestore = Math.floor((ally.maxMP || 0) * 0.25);
        if (mpRestore > 0) {
          ally.currentMP = Math.min(ally.maxMP || 0, (ally.currentMP || 0) + mpRestore);
          scene?._playStatusVFX?.(ally, { kind: 'mana' });
        }
      });

      scene?._log?.(`${attacker?.name || 'Chad'} rallies the party — damage taken reduced, MP restored!`);
      return { amount: 0 };
    },
    description: "Spends 30-60 Initiative to bolster the whole party: +10 to +20 all Resists for 2 turns, and restores 25% MP to everyone."
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
    apply: (_user, target, scene) => {
      if (!target) return { amount: 0 };
      const heal = Math.max(14, Math.floor((target.maxHP || 50) * 0.35));
      target.currentHP = Math.min(target.maxHP || heal, (target.currentHP || 0) + heal);
      scene?._playStatusVFX?.(target, { kind: 'heal' });
      return { amount: 0 };
    },
    description: "Restores 35% of an ally's max HP (minimum 14)."
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
        scene?._playStatusVFX?.(target, { kind: 'mana' });
      }
      return { amount: 0 };
    },
    description: "Clears an ally's Curse, Disease, and Toxic buildup entirely. Restores 4 MP if anything was cleansed."
  },
  // Display name changed from "Blessing" to avoid colliding with the
  // player Acolyte's own class skill of the same original name — same
  // effect, just no longer reads as the same ability in combat logs/UI.
  'healer_blessing': {
    id: 'healer_blessing',
    name: 'Sacred Ward',
    type: 'enemy',
    actionCost: 'bonus',
    mpCost: 6,
    cooldown: 3,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'ally',
    apply: (_user, target) => ({
      amount: 0,
      statusEffects: [{ id: 'healer_blessing', turns: 3, mods: { Accuracy: 10 }, data: { mpRegen: 2 }, vfx: { kind: 'buff_increase' } }]
    }),
    description: "Grants an ally +10 Accuracy for 3 turns."
  },
  'healer_flame_flick': {
    id: 'healer_flame_flick',
    name: 'Flame Flick',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'bonus',
    mpCost: 3,
    cooldown: 1,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    // 'projectile' + buildupHint added — Stan is a staff caster with no
    // melee shape to fall back on (same gap the 12 player staff skills had —
    // see project_weapon_vfx_systematic_plan), so without this tag his one
    // real attack skill would render as a melee puncture pop instead of a
    // fire bolt. See project_encounter3_vfx_sfx_pass.
    tags: ['ranged','attack','fire','projectile'],
    buildupHint: { fire: 70 },
    apply: (user, target) => {
      const ability = SKILLS?.healer_flame_flick;
      const roll = calculateDamage(user, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        user, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 27, skillLabel: `${ability?.name || 'Skill'} weapon damage (27%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
          skillConversion: { physToElemPct: 100 },
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return { ...roll, physical, elemental, necrotic, amount, isMagic: true, buildup: { fire: 70 } };
    },
    description: "Deals 27% weapon damage as Fire and applies 70 Fire buildup."
  },

  // Stan's signature — real heal pipeline (calculateHealRoll/
  // applyHealModifiers, same functions Restoration Light uses), not the
  // flat-formula healer_heal above. Spends 30-60 Initiative (gated via
  // requiresInitiativeGauge, checked generically by the engine); bigger
  // spend scales the heal up. Hits the whole party via splash, same shape
  // ranger_volley/war_cry already use for their own AoE payloads.
  'healer_mending_wave': {
    id: 'healer_mending_wave',
    name: 'Mending Wave',
    type: 'enemy',
    actionCost: 'class',
    mpCost: 6,
    cooldown: 4,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'ally',
    requiresInitiativeGauge: 30,
    vfxHint: { kind: 'heal' },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.healer_mending_wave;
      // requiresInitiativeGauge (checked generically before apply() ever
      // runs) already guarantees at least 30 here — just cap the spend.
      const spend = Math.min(attacker?.initiativeGauge || 0, 60);
      attacker.initiativeGauge = Math.max(0, (attacker.initiativeGauge || 0) - spend);
      // 100% at the 30 minimum, scaling up to 220% at the 60 cap.
      const skillPct = 100 + Math.floor((spend - 30) * 4);

      const roll = calculateHealRoll(attacker, ability);
      const amount = Math.max(1, applyHealModifiers(roll.amount, attacker, {
        ability, skillPct,
        skillLabel: `${ability?.name || 'Skill'} healing (${skillPct}%)`,
        isCrit: roll.isCrit, critMult: roll.critMult,
      }));

      const allySlots = attacker?.isEnemy ? scene?.enemySlots : scene?.allySlots;
      const others = (allySlots || [])
        .map(s => s?.char)
        .filter(ally => ally && ally !== target && ally.status !== 'incapacitated');

      scene?._logLocal?.({ segments: [{ text: 'Stan! Stan! Stan!', color: '#ffd166' }] });
      scene?._log?.(`${attacker?.name || 'Stan'} unleashes a wave of light, mending the whole party!`);

      return {
        amount, isHeal: true, isCrit: roll.isCrit,
        splash: others.map(ally => ({ target: ally, amount, isHeal: true })),
      };
    },
    description: "Spends 30-60 Initiative to heal the whole party at once — the more Initiative spent, the stronger the heal."
  },

  'warlock_hex': {
    id: 'warlock_hex',
    name: 'Hex',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'major',
    mpCost: 5,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['ranged','attack','curse','necrotic'],
    // buildupHint added — see fighter_heavy_slash's comment above.
    buildupHint: { curse: 100 },
    apply: (user, target) => {
      const ability = SKILLS?.warlock_hex;
      const roll = calculateDamage(user, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        user, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 25, skillLabel: `${ability?.name || 'Skill'} weapon damage (25%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
          skillConversion: { physToNecroPct: 100 },
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return { ...roll, physical, elemental, necrotic, amount, isMagic: true, buildup: { curse: 100 } };
    },
    description: "Deals 25% weapon damage as Necrotic and applies 100 Curse buildup."
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
    apply: (user, target, scene) => {
      const tier = target?.weakness?.tiers?.curse || 0;
      const dmg = 4;
      const heal = tier >= 2 ? 18 : 10;
      if (user) {
        user.currentHP = Math.min(user.maxHP || heal, (user.currentHP || 0) + heal);
        scene?._playStatusVFX?.(user, { kind: 'heal' });
      }
      return { amount: dmg };
    },
    description: "Requires the target to be Cursed (T1+). Deals 4 damage and heals Gary for 10 — 18 if the target is Afflicted (Curse T2+)."
  },

  // Gary's second signature — costs HP instead of MP (canExecute enforces
  // "only above 80% HP" so this can't be used recklessly into a losing
  // position, despite the name). Requires target already Singed (Fire T1+).
  'warlock_reckless_immolation': {
    id: 'warlock_reckless_immolation',
    name: 'Reckless Immolation',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'major',
    mpCost: 0,
    cooldown: 3,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    requiresWeakness: { family: 'fire', tier: 1 },
    // tags + buildupHint added — had no tags array at all before this
    // (typedDamage skills still worked mechanically via the isEnemyOffensiveSkill
    // hit-roll fallback, but VFX/tag-fallback systems had nothing to read).
    tags: ['melee', 'attack', 'fire'],
    buildupHint: { fire: 160 },
    canExecute: ({ user }) => {
      const hpPct = (user?.currentHP || 0) / Math.max(1, user?.maxHP || 1);
      return hpPct > 0.8 ? true : { ok: false, reason: `${user?.name || 'Gary'} needs more than 80% HP to risk this.` };
    },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.warlock_reckless_immolation;
      const hpCost = Math.max(1, Math.floor((attacker?.maxHP || 0) * 0.15));
      attacker.currentHP = Math.max(1, (attacker.currentHP || 0) - hpCost);

      const roll = calculateDamage(attacker, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 105, skillLabel: `${ability?.name || 'Skill'} weapon damage (105%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
          skillConversion: { physToElemPct: 100 },
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      scene?._log?.(`${attacker?.name || 'Gary'} burns ${hpCost} of his own HP to fuel a reckless blast!`);
      scene?._logLocal?.({ segments: [{ text: "Gary's so cool!", color: '#ffd166' }] });

      return {
        ...roll, physical, elemental, necrotic, amount,
        isMagic: true, element: 'fire',
        buildup: { fire: 160 },
      };
    },
    description: "Costs 15% of Gary's own max HP instead of MP (only usable above 80% HP). Requires target at least Singed. Deals 105% weapon damage as Fire and applies heavy Fire buildup."
  },

  'warlock_dark_bolts': {
    id: 'warlock_dark_bolts',
    name: 'Dark Bolts',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'bonus',
    mpCost: 4,
    cooldown: 1,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['ranged','attack','disease','necrotic'],
    // buildupHint added — see fighter_heavy_slash's comment above.
    buildupHint: { disease: 70 },
    apply: (user, target) => {
      const ability = SKILLS?.warlock_dark_bolts;
      const roll = calculateDamage(user, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        user, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 38, skillLabel: `${ability?.name || 'Skill'} weapon damage (38%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
          skillConversion: { physToNecroPct: 100 },
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return { ...roll, physical, elemental, necrotic, amount, isMagic: true, buildup: { disease: 70 } };
    },
    description: "Deals 38% weapon damage as Necrotic and applies 70 Disease buildup."
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
    },
    description: "Requires the target to be Cursed (T1+). Doubles their current Curse buildup meter. No damage of its own."
  },

  // Gary's signature — now functionally identical to the player's own
  // curse_of_needles (dagger): same typed pipeline, same 110% skillPct, same
  // requiresWeakness gate (target must already be at least Hexed), same
  // permanent onHit rider, no self-applied curse buildup. Rebuilt here
  // rather than reused directly only so enemyOnly/AI concerns stay separate
  // from the shared player skill object. Gary establishes the curse via
  // warlock_hex first (already in his kit, applies Curse buildup) — this
  // skill extends/maintains it, it doesn't start it.
  'warlock_curse_needles': {
    id: 'warlock_curse_needles',
    name: 'Curse of Needles',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'major',
    mpCost: 7,
    cooldown: 3,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    requiresWeakness: { family: 'curse', tierAtLeast: 1 },
    tags: ['melee', 'attack', 'curse'],
    apply: (attacker, target) => {
      const ability = SKILLS?.warlock_curse_needles;
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
      const alreadyCursed = target.statusEffects.some(se => se?.id === 'warlock_curse_needles');
      const statusEffects = alreadyCursed ? undefined : [{
        id: 'warlock_curse_needles', name: 'Curse of Needles', permanent: true,
        onHit: { weaponDamageFlat: 2, curseScaled: true },
        vfx: { kind: 'debuff_weak' },
      }];

      return { ...roll, physical, elemental, necrotic, amount, statusEffects };
    },
    description: "Deals 110% weapon damage. Requires target at least Hexed. Applies a permanent rider: hits against the target deal +2 weapon damage while cursed, amplified while Afflicted."
  },

  'ranger_quick_shot': {
    id: 'ranger_quick_shot',
    name: 'Quick Shot',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'bonus',
    mpCost: 3,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['ranged','attack','projectile','expose'],
    // buildupHint added — see fighter_heavy_slash's comment above. Bow's own
    // VFX (_playBowArrowVFX) always flies as an arrow regardless of tags, so
    // this only affects tint, not shape.
    buildupHint: { expose: 60 },
    apply: (user, target) => {
      const ability = SKILLS?.ranger_quick_shot;
      const roll = calculateDamage(user, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        user, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 34, skillLabel: `${ability?.name || 'Skill'} weapon damage (34%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return { ...roll, physical, elemental, necrotic, amount, buildup: { expose: 60 } };
    },
    description: "Deals 34% weapon damage and applies 60 Expose buildup."
  },
  'ranger_frost_arrow': {
    id: 'ranger_frost_arrow',
    name: 'Frost Arrow',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'major',
    mpCost: 5,
    cooldown: 1,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['ranged','attack','projectile','cold'],
    // buildupHint added — see fighter_heavy_slash's comment above.
    buildupHint: { cold: 90 },
    apply: (user, target) => {
      const ability = SKILLS?.ranger_frost_arrow;
      const roll = calculateDamage(user, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        user, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 34, skillLabel: `${ability?.name || 'Skill'} weapon damage (34%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
          skillConversion: { physToElemPct: 100 },
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return { ...roll, physical, elemental, necrotic, amount, isMagic: true, buildup: { cold: 90 } };
    },
    description: "Deals 34% weapon damage as Cold and applies 90 Cold buildup."
  },
  'ranger_volley': {
    id: 'ranger_volley',
    name: 'Volley',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'class',
    mpCost: 8,
    cooldown: 2,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    apply: (user, target, scene) => {
      // Was scene.turnOrder?.filter(...).slice(1) — silently bypassed
      // Blockade's wall (see CombatScene._getTargetableEnemiesFor) since it
      // read the raw roster directly instead of the same filtered candidate
      // list the AI's own primary-target selection already respects.
      const foes = (scene?._getTargetableEnemiesFor?.(user) || []).filter(u => u !== target);
      const ability = SKILLS?.ranger_volley;
      const roll = calculateDamage(user, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        user, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 25, skillLabel: `${ability?.name || 'Skill'} weapon damage (25%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      // Splash kept at the original 2:3 ratio to the primary hit.
      const splashAmount = Math.max(1, Math.floor(amount * 0.67));
      return {
        ...roll,
        physical, elemental, necrotic,
        amount,
        splash: foes.map(t => ({ target: t, amount: splashAmount, tags: ability?.tags })),
      };
    },
    description: "Deals 25% weapon damage to the target and 67% of that to every other party member."
  },
  'ranger_aimed_shot': {
    id: 'ranger_aimed_shot',
    name: 'Aimed Shot',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'major',
    mpCost: 8,
    cooldown: 2,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['ranged','attack','projectile','expose','consume'],
    requiresWeakness: { family: 'expose', tier: 1 },
    apply: (user, target) => {
      const ability = SKILLS?.ranger_aimed_shot;
      const roll = calculateDamage(user, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        user, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 59, skillLabel: `${ability?.name || 'Skill'} weapon damage (59%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return { ...roll, physical, elemental, necrotic, amount, consumeWeakness: ['expose'] };
    },
    description: "Requires the target to be Exposed (T1+). Deals 59% weapon damage and consumes their Expose buildup."
  },

  // Doug's signature — needs BOTH triggers (himself hit directly, OR a
  // same-rank ally hit) to cover "he or a same rank ally is the target".
  // reaction.exec always runs regardless of which trigger fired it
  // (_fireReaction reads reactSkill.reaction.exec unconditionally), so a
  // primary `reaction.trigger` plus a secondary `triggers[]` entry is enough
  // to register both without duplicating the executor.
  'ranger_covering_shot': {
    id: 'ranger_covering_shot',
    name: 'Covering Shot',
    type: 'enemy',
    mechanic: 'reaction',
    actionCost: 'reaction',
    mpCost: 4,
    cooldown: 3,
    enemyOnly: true,
    requiresTarget: false,
    reaction: {
      trigger: 'self_hit',
      cooldownOn: 'trigger',
      canTrigger: ({ owner, target, scene, event, sourceAbility, sourceIntent }) => {
        const isProjectile = (sourceIntent?.tags || []).includes('projectile') || (sourceAbility?.tags || []).includes('projectile');
        if (!isProjectile) return false;
        if (event === 'self_hit') return true;
        return scene?._getUnitColumn?.(owner) === scene?._getUnitColumn?.(target);
      },
      exec: ({ owner, scene, incoming }) => {
        if (Math.random() < 0.5) {
          if (incoming) {
            incoming.amount = 0;
            incoming.physical = 0;
            incoming.elemental = 0;
            incoming.necrotic = 0;
            incoming.buildup = null;
            incoming.statusEffects = null;
          }
          scene?._log?.(`${owner?.name || 'Doug'} shoots the projectile out of the air!`);
          scene?._logLocal?.({ segments: [{ text: 'Doug! Doug! Doug!', color: '#ffd166' }] });
        } else {
          scene?._log?.(`${owner?.name || 'Doug'} tries to intercept the shot, but misses!`);
        }
      },
    },
    triggers: [{ event: 'ally_hit' }],
    description: "Reaction: when you or an ally in your rank is struck by a projectile, 50% chance to shoot it down entirely — no damage, no effects."
  },

  'rogue_poisoned_knife': {
    id: 'rogue_poisoned_knife',
    name: 'Poisoned Knife',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'bonus',
    mpCost: 3,
    cooldown: 1,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    // buildupHint added — see fighter_heavy_slash's comment above.
    buildupHint: { toxic: 70 },
    apply: (user, target) => {
      const exposeTier = target?.weakness?.tiers?.expose || 0;
      const ability = SKILLS?.rogue_poisoned_knife;
      const roll = calculateDamage(user, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        user, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 37, skillLabel: `${ability?.name || 'Skill'} weapon damage (37%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      const toxic = 70 + (exposeTier >= 1 ? 40 : 0);
      return { ...roll, physical, elemental, necrotic, amount, buildup: { toxic } };
    },
    description: "Deals 37% weapon damage and applies 70 Toxic buildup — 110 if the target is already Exposed (T1+)."
  },
  'rogue_hamstring': {
    id: 'rogue_hamstring',
    name: 'Hamstring',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'major',
    mpCost: 5,
    cooldown: 1,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['melee','attack','lacerate'],
    // buildupHint added — see fighter_heavy_slash's comment above.
    buildupHint: { lacerate: 80 },
    apply: (user, target) => {
      const ability = SKILLS?.rogue_hamstring;
      const roll = calculateDamage(user, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        user, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 62, skillLabel: `${ability?.name || 'Skill'} weapon damage (62%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return { ...roll, physical, elemental, necrotic, amount, buildup: { lacerate: 80 }, statusEffects: [{ id: 'slowed', turns: 2, mods: { Initiative: -3 } }] };
    },
    description: "Deals 62% weapon damage and applies 80 Lacerate buildup. Slows the target (-3 Initiative for 2 turns)."
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
        scene?._playStatusVFX?.(user, { kind: 'mana' });
      }
      return { amount: 0, statusEffects: [{ id: 'rogue_evasion', turns: 1, mods: { Evasion: 20 }, vfx: { kind: 'buff_increase' } }] };
    },
    description: "Grants +20 Evasion for 1 turn. Also restores 3 MP if any party member is Cursed or Poisoned (Toxic T1+)."
  },
  'rogue_sneak_attack': {
    id: 'rogue_sneak_attack',
    name: 'Sneak Attack',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'major',
    mpCost: 7,
    cooldown: 1,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['melee','attack'],
    requiresWeakness: { family: 'expose', tier: 1 },
    apply: (user, target) => {
      const ability = SKILLS?.rogue_sneak_attack;
      const roll = calculateDamage(user, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        user, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 111, skillLabel: `${ability?.name || 'Skill'} weapon damage (111%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return { ...roll, physical, elemental, necrotic, amount };
    },
    description: "Requires the target to be Exposed (T1+). Deals 111% weapon damage."
  },
  'rogue_finishing_strike': {
    id: 'rogue_finishing_strike',
    name: 'Finishing Strike',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'class',
    mpCost: 10,
    cooldown: 2,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['melee','attack','consume'],
    canExecute: ({ target }) => {
      if (!target?.weakness?.tiers) return { ok: false };
      const tiers = target.weakness.tiers;
      const families = ['expose', 'toxic', 'curse', 'disease', 'cold', 'fire', 'lacerate'];
      const count = families.reduce((n, fam) => n + ((tiers[fam] || 0) >= 1 ? 1 : 0), 0);
      return count >= 2 ? true : { ok: false, reason: `${target.name} lacks layered weaknesses.` };
    },
    apply: (user, target) => {
      const ability = SKILLS?.rogue_finishing_strike;
      const roll = calculateDamage(user, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        user, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 160, skillLabel: `${ability?.name || 'Skill'} weapon damage (160%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return { ...roll, physical, elemental, necrotic, amount, consumeWeakness: ['expose', 'toxic'] };
    },
    description: "Requires the target to have at least 2 active weaknesses (Expose/Toxic/Curse/Disease/Cold/Fire/Lacerate). Deals 160% weapon damage and consumes their Expose and Toxic buildup."
  },

  // Mo's signature — redesigned onto 'pre_hit' (see Guardian's Stand's
  // comment for why that trigger exists), OPPOSITE spatial rule from it:
  // only when the ally being targeted is in a rank BEHIND Mo's own. Now
  // genuinely affects the incoming hit's own damage rather than debuffing
  // the attacker's NEXT action — a scoped AttackPower debuff, applied right
  // before apply()/calculateDamage() run and stripped immediately after by
  // the caller (_applyAbilityToTarget), so it can't leak into a second
  // attack this same turn. AttackPower specifically (not Accuracy) because
  // it's a field the damage pipeline is already confirmed to read during
  // this exact resolution — Accuracy's hit/miss timing relative to this
  // checkpoint isn't established, so it wasn't a safe bet to build on.
  'rogue_distracting_feint': {
    id: 'rogue_distracting_feint',
    name: 'Distracting Feint',
    type: 'enemy',
    mechanic: 'reaction',
    actionCost: 'reaction',
    mpCost: 3,
    cooldown: 2,
    enemyOnly: true,
    requiresTarget: false,
    reaction: {
      trigger: 'pre_hit',
      cooldownOn: 'trigger',
      canTrigger: ({ owner, target, scene }) => {
        const rank = { front: 0, mid: 1, back: 2 };
        const ownerRank = rank[scene?._getUnitColumn?.(owner)];
        const targetRank = rank[scene?._getUnitColumn?.(target)];
        return Number.isFinite(ownerRank) && Number.isFinite(targetRank) && targetRank > ownerRank;
      },
      exec: ({ owner, attacker, scene }) => {
        if (!attacker) return null;
        scene?._addStatusEffects?.(attacker, [{ id: 'distracting_feint_scoped', turns: 1, mods: { AttackPower: -50 } }]);
        scene?._log?.(`${owner?.name || 'Mo'} darts into view, throwing off ${attacker.name}'s aim!`);
        return { scopedDebuffId: 'distracting_feint_scoped' };
      },
    },
    description: "Reaction: when an ally behind you is targeted, distract the attacker — this attack's damage is reduced by 50% AttackPower."
  },

  // Mo's third signature — bonus action, so it doesn't compete with his
  // major/class-cost options; only usable once Gary's Curse of Needles
  // rider is actually on the target (checked by id, not just Curse weakness
  // tier, per the ask — "only when a target is affected by curse of
  // needles"). Feeds the same Curse meter Gary's own kit builds/spends.
  'rogue_curse_twist': {
    id: 'rogue_curse_twist',
    name: 'Curse Twist',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'bonus',
    mpCost: 3,
    cooldown: 2,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['melee','attack','curse','necrotic'],
    canExecute: ({ target }) => {
      const hasRider = Array.isArray(target?.statusEffects) && target.statusEffects.some(se => se?.id === 'warlock_curse_needles');
      return hasRider ? true : { ok: false, reason: `${target?.name || 'Target'} isn't afflicted by Curse of Needles.` };
    },
    // buildupHint added — see fighter_heavy_slash's comment above.
    buildupHint: { curse: 50 },
    apply: (user, target) => {
      const ability = SKILLS?.rogue_curse_twist;
      const roll = calculateDamage(user, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        user, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 49, skillLabel: `${ability?.name || 'Skill'} weapon damage (49%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
          skillConversion: { physToNecroPct: 100 },
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return { ...roll, physical, elemental, necrotic, amount, isMagic: true, buildup: { curse: 50 } };
    },
    description: "Requires the target already afflicted by Curse of Needles. Deals 49% weapon damage as Necrotic and applies 50 Curse buildup."
  },

  'wizard_arcane_bolt': {
    id: 'wizard_arcane_bolt',
    name: 'Arcane Bolt',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'bonus',
    mpCost: 3,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    // 'projectile' + buildupHint added — see healer_flame_flick's comment
    // above; Lenny is also a staff caster with the same gap.
    tags: ['ranged','attack','lightning','projectile'],
    buildupHint: { lightning: 60 },
    apply: (user, target) => {
      const ability = SKILLS?.wizard_arcane_bolt;
      const roll = calculateDamage(user, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        user, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 39, skillLabel: `${ability?.name || 'Skill'} weapon damage (39%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
          skillConversion: { physToElemPct: 100 },
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return { ...roll, physical, elemental, necrotic, amount, isMagic: true, buildup: { lightning: 60 } };
    },
    description: "Deals 39% weapon damage as Lightning and applies 60 Lightning buildup."
  },
  'wizard_static_field': {
    id: 'wizard_static_field',
    name: 'Static Field',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'major',
    mpCost: 5,
    cooldown: 1,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    // 'projectile' + buildupHint added — see healer_flame_flick's comment above.
    tags: ['ranged','attack','lightning','projectile'],
    buildupHint: { lightning: 90 },
    apply: (user, target) => {
      const ability = SKILLS?.wizard_static_field;
      const roll = calculateDamage(user, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        user, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 39, skillLabel: `${ability?.name || 'Skill'} weapon damage (39%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
          skillConversion: { physToElemPct: 100 },
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return { ...roll, physical, elemental, necrotic, amount, isMagic: true, buildup: { lightning: 90 } };
    },
    description: "Deals 39% weapon damage as Lightning and applies 90 Lightning buildup."
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
      statusEffects: [{ id: 'wizard_mana_shield', turns: 2, mods: { ElementalResist: 20 }, vfx: { kind: 'buff_harden' } }]
    }),
    description: "Grants +20 Elemental Resist for 2 turns."
  },
  'wizard_overload': {
    id: 'wizard_overload',
    name: 'Overload',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'class',
    mpCost: 8,
    cooldown: 2,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    requiresWeakness: { family: 'lightning', tier: 1 },
    // 'projectile' added — see healer_flame_flick's comment above. Also
    // carries 'lightning' so the tag-fallback in _dominantBuildupFamily
    // still tints it even though this skill grants no NEW buildup itself.
    tags: ['ranged','attack','lightning','projectile'],
    apply: (user, target) => {
      const ability = SKILLS?.wizard_overload;
      const roll = calculateDamage(user, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        user, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 88, skillLabel: `${ability?.name || 'Skill'} weapon damage (88%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
          skillConversion: { physToElemPct: 100 },
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return { ...roll, physical, elemental, necrotic, amount, isMagic: true, consumeWeakness: ['lightning'] };
    },
    description: "Requires the target to be Zapped (Lightning T1+). Deals 88% weapon damage as Lightning and consumes their Lightning buildup."
  },

  // Lenny's signature — two-phase channel. Phase 1 deals no damage, just
  // applies a self status (turns:2, since _tickDownStatusDurations ticks
  // down at the END of the casting turn — turns:1 would expire before
  // Lenny's next turn ever started). Phase 2 is picked automatically and
  // unconditionally by the wizard_dummy AI profile the moment the status is
  // present, so the release is guaranteed the following turn.
  'wizard_inferno_channel': {
    id: 'wizard_inferno_channel',
    name: 'Channel: Inferno',
    type: 'enemy',
    actionCost: 'major',
    mpCost: 4,
    cooldown: 5,
    enemyOnly: true,
    requiresTarget: false,
    apply: (attacker, _target, scene) => {
      scene?._addStatusEffects?.(attacker, [{ id: 'channeling_inferno', turns: 2, vfx: { kind: 'buff_power' } }]);
      scene?._log?.(`${attacker?.name || 'Lenny'} begins channeling a massive inferno...`);
      return { amount: 0 };
    },
    description: "Begins channeling a massive Fire AoE — unleashed automatically on your next turn."
  },

  // The payoff — real typed pipeline (applyTypedDamageModifiers +
  // skillConversion), the same functions/shape player fire spells use, so
  // this is properly split into physical/elemental/necrotic and mitigated
  // by each target's own resists rather than a flat legacy `amount`. Splash
  // reuses the primary target's already-converted split (same convention
  // berserker_disrupting_roar/bleeding_sweep use for their own party AoEs),
  // not a per-target reroll.
  'wizard_inferno_release': {
    id: 'wizard_inferno_release',
    name: 'Inferno',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'major',
    mpCost: 0,
    cooldown: 0,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    // 'projectile'/'ranged' added — see healer_flame_flick's comment above.
    tags: ['aoe', 'fire', 'ranged', 'projectile'],
    buildupHint: { fire: 60 },
    aoe: { shape: 'party', scale: 1 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.wizard_inferno_release;
      const roll = calculateDamage(attacker, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 90, skillLabel: `${ability?.name || 'Skill'} weapon damage (90%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
          skillConversion: { physToElemPct: 100 },
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      // Was scene.turnOrder?.filter(...) — silently bypassed Blockade's wall
      // (see CombatScene._getTargetableEnemiesFor).
      const others = (scene?._getTargetableEnemiesFor?.(attacker) || []).filter(u => u !== target);

      return {
        ...roll, physical, elemental, necrotic, amount,
        isMagic: true, element: 'fire',
        buildup: { fire: 60 },
        splash: others.map(t => ({
          target: t, physical, elemental, necrotic, amount,
          isMagic: true, element: 'fire', buildup: { fire: 60 },
        })),
      };
    },
    description: "Unleashes the channeled inferno — 90% weapon damage as Fire to the entire party."
  },

  // Encounter 4 - Huntsman & Beasts
  'huntsman_mark': {
    id: 'huntsman_mark',
    name: "Huntmaster's Mark",
    type: 'enemy',
    typedDamage: true,
    actionCost: 'bonus',
    mpCost: 4,
    cooldown: 1,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['ranged', 'attack'],
    apply: (user, target) => {
      const ability = SKILLS?.huntsman_mark;
      const roll = calculateDamage(user, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        user, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 35, skillLabel: `${ability?.name || 'Skill'} weapon damage (35%)`, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return {
        ...roll, physical, elemental, necrotic, amount,
        // +50% then another +25% buildup across encounter 4 (was 80, then 120).
        buildup: { expose: 150 },
        statusEffects: [{ id: 'huntsman_marked', turns: 3, data: { markedBy: user?.id || null }, vfx: { kind: 'debuff_leer' } }]
      };
    },
    description: "Deals 35% weapon damage and applies 150 Expose buildup. Marks the target for 3 turns, making allies more likely to focus their attacks on it."
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
      statusEffects: [{ id: 'commanded', turns: 1, mods: { Initiative: 15, Accuracy: 10 }, vfx: { kind: 'buff_increase' } }]
    }),
    description: "Grants an ally beast +15 Initiative and +10 Accuracy for 1 turn."
  },
  'huntsman_trap_shot': {
    id: 'huntsman_trap_shot',
    name: 'Trap Shot',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'major',
    mpCost: 6,
    cooldown: 1,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['ranged', 'attack'],
    apply: (user, target) => {
      const ability = SKILLS?.huntsman_trap_shot;
      const roll = calculateDamage(user, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        user, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 80, skillLabel: `${ability?.name || 'Skill'} weapon damage (80%)`, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return {
        ...roll, physical, elemental, necrotic, amount,
        // +50% then another +25% buildup across encounter 4 (was 90, then 135).
        buildup: { lacerate: 169 }, statusEffects: [{ id: 'immobilized', turns: 2, vfx: { kind: 'debuff_shock' } }]
      };
    },
    description: "Deals 80% weapon damage and applies 169 Lacerate buildup. Immobilizes the target for 2 turns."
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
        scene?._addStatusEffects?.(beast, [{ id: 'empowered_pack', turns: 2, mods: { Initiative: 20, Accuracy: 10 }, vfx: { kind: 'buff_increase' } }]);
      }
      return { amount: 0 };
    },
    description: "Requires the target to have at least 2 active weaknesses (Expose/Lacerate/Disease/Toxic). Grants every beast ally +20 Initiative and +10 Accuracy for 2 turns."
  },

  // Huntsman's initiative spender — "calls in" a coordinated burst against
  // the marked target. Spend-scaled like fighter_bulwark_call: minimum 30 to
  // use at all, up to 60 spent for the full bonus.
  'huntsman_coordinated_volley': {
    id: 'huntsman_coordinated_volley',
    name: 'Coordinated Volley',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'class',
    mpCost: 6,
    cooldown: 4,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    requiresInitiativeGauge: 30,
    tags: ['ranged', 'attack'],
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.huntsman_coordinated_volley;
      const spend = Math.min(attacker?.initiativeGauge || 0, 60);
      attacker.initiativeGauge = Math.max(0, (attacker.initiativeGauge || 0) - spend);
      // 100% at the 30 minimum, up to 130% at the 60 cap.
      const skillPct = 100 + Math.floor(spend / 2);

      const roll = calculateDamage(attacker, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct, skillLabel: `${ability?.name || 'Skill'} weapon damage (${skillPct}%)`, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      scene?._log?.(`${attacker?.name || 'The huntsman'} whistles — the beasts converge for a coordinated strike!`);
      // +50% then another +25% buildup across encounter 4 (was 80, then 120).
      return { ...roll, physical, elemental, necrotic, amount, buildup: { expose: 150 } };
    },
    description: "Spend 30-60 initiative: deals 100-130% weapon damage (scaling with spend) and applies Expose buildup."
  },

  'oskar_rending_bite': {
    id: 'oskar_rending_bite',
    name: 'Rending Bite',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'major',
    mpCost: 5,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['melee', 'attack'],
    // buildupHint added — the actual buildup object is only built at runtime
    // inside apply(), so it's invisible to CombatScene._dominantBuildupFamily
    // (which reads this static field to pick attack-VFX tint) without this.
    // Same convention every player skill already uses; enemy skills never
    // had it wired before. See project_weapon_vfx_systematic_plan.
    buildupHint: { lacerate: 1 },
    apply: (user, target) => {
      const ability = SKILLS?.oskar_rending_bite;
      const roll = calculateDamage(user, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        user, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 90, skillLabel: `${ability?.name || 'Skill'} weapon damage (90%)`, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      // +50% then another +25% buildup across encounter 4 (was 90, then 135).
      return { ...roll, physical, elemental, necrotic, amount, buildup: { lacerate: 169 } };
    },
    description: "Deals 90% weapon damage and applies 169 Lacerate buildup."
  },
  'oskar_infectious_claw': {
    id: 'oskar_infectious_claw',
    name: 'Infectious Claw',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'bonus',
    mpCost: 4,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['melee', 'attack'],
    // buildupHint added — see oskar_rending_bite's comment above.
    buildupHint: { disease: 1 },
    apply: (user, target) => {
      const ability = SKILLS?.oskar_infectious_claw;
      const roll = calculateDamage(user, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        user, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillConversion: { physToNecroPct: 40 }, skillPct: 65, skillLabel: `${ability?.name || 'Skill'} weapon damage (65%)`, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      const hasLac = (target?.weakness?.tiers?.lacerate || 0) >= 1;
      // +50% then another +25% buildup across encounter 4 (was 140/80, then 210/120).
      return { ...roll, physical, elemental, necrotic, amount, buildup: { disease: hasLac ? 263 : 150 } };
    },
    description: "Deals 65% weapon damage and applies 150 Disease buildup — 263 if the target is already Lacerated (T1+)."
  },
  'oskar_maw_rip': {
    id: 'oskar_maw_rip',
    name: 'Maw Rip',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'major',
    mpCost: 8,
    cooldown: 2,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    requiresWeakness: { family: 'lacerate', tier: 1 },
    tags: ['melee', 'attack'],
    // buildupHint added — see oskar_rending_bite's comment above.
    buildupHint: { lacerate: 1 },
    apply: (user, target) => {
      const ability = SKILLS?.oskar_maw_rip;
      const roll = calculateDamage(user, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        user, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 140, skillLabel: `${ability?.name || 'Skill'} weapon damage (140%)`, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return { ...roll, physical, elemental, necrotic, amount, consumeWeakness: ['lacerate'] };
    },
    description: "Requires the target to be Lacerated (T1+). Deals 140% weapon damage and consumes their Lacerate buildup."
  },
  'oskar_rotting_maw': {
    id: 'oskar_rotting_maw',
    name: 'Rotting Maw',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'class',
    mpCost: 10,
    cooldown: 3,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    requiresWeakness: { family: 'disease', tier: 2 },
    tags: ['melee', 'attack'],
    // buildupHint added — see oskar_rending_bite's comment above. Toxic, not
    // disease, since that's the family this skill actually leaves behind.
    buildupHint: { toxic: 1 },
    apply: (user, target) => {
      const ability = SKILLS?.oskar_rotting_maw;
      const roll = calculateDamage(user, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        user, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillConversion: { physToNecroPct: 60 }, skillPct: 115, skillLabel: `${ability?.name || 'Skill'} weapon damage (115%)`, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      if (target?.weakness) {
        const val = target.weakness.meters?.disease || 0;
        target.weakness.meters.disease = 0;
        target.weakness.tiers.disease = 0;
        target.weakness.meters.toxic = (target.weakness.meters.toxic || 0) + val;
      }
      return { ...roll, physical, elemental, necrotic, amount };
    },
    description: "Requires the target to be Plagued (Disease T2+). Deals 115% weapon damage and converts their entire Disease buildup into Toxic buildup."
  },

  // Oskar's reaction — snaps back on reflex when struck. Armed idempotently
  // by the oskar_beast AI profile, same pattern fighter_dummy uses for
  // Guardian's Stand; the actual counter-hit is fired via a delayed
  // _applyAbilityToTarget call, same mechanism Riposte/Cover Strike use.
  'oskar_reflex_bite': {
    id: 'oskar_reflex_bite',
    name: 'Reflex Bite',
    type: 'enemy',
    mechanic: 'reaction',
    typedDamage: true,
    actionCost: 'reaction',
    mpCost: 3,
    cooldown: 2,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['melee', 'attack'],
    // buildupHint added — see oskar_rending_bite's comment above.
    buildupHint: { lacerate: 1 },
    apply: (user, target) => {
      const ability = SKILLS?.oskar_reflex_bite;
      const roll = calculateDamage(user, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        user, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 70, skillLabel: `${ability?.name || 'Skill'} weapon damage (70%)`, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      // +50% then another +25% buildup across encounter 4 (was 60, then 90).
      return { ...roll, physical, elemental, necrotic, amount, buildup: { lacerate: 113 } };
    },
    reaction: {
      trigger: 'self_hit',
      cooldownOn: 'trigger',
      canTrigger: () => true,
      exec: ({ owner, attacker, scene }) => {
        if (!attacker) return;
        const ability = SKILLS?.oskar_reflex_bite;
        scene?._log?.(`${owner?.name || 'Oskar'} snaps back on reflex!`);
        scene.time?.delayedCall(50, () => {
          scene._applyAbilityToTarget(owner, attacker, ability, { isReaction: true, tags: ability?.tags || [] });
        });
      },
    },
    description: "Reaction: when struck, bite back at the attacker for 70% weapon damage and apply Lacerate buildup."
  },

  'kiro_toxic_spit': {
    id: 'kiro_toxic_spit',
    name: 'Toxic Spit',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'bonus',
    mpCost: 4,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['ranged', 'attack'],
    // buildupHint added — see oskar_rending_bite's comment above.
    buildupHint: { toxic: 1 },
    apply: (user, target) => {
      const ability = SKILLS?.kiro_toxic_spit;
      const roll = calculateDamage(user, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        user, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillConversion: { physToNecroPct: 100 }, skillPct: 55, skillLabel: `${ability?.name || 'Skill'} weapon damage (55%)`, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      // +50% then another +25% buildup across encounter 4 (was 90, then 135).
      return { ...roll, physical, elemental, necrotic, amount, buildup: { toxic: 169 } };
    },
    description: "Deals 55% weapon damage and applies 169 Toxic buildup."
  },
  'kiro_venomous_swipe': {
    id: 'kiro_venomous_swipe',
    name: 'Venomous Swipe',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'major',
    mpCost: 5,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['melee', 'attack'],
    // buildupHint added — see oskar_rending_bite's comment above.
    buildupHint: { disease: 1 },
    apply: (user, target) => {
      const ability = SKILLS?.kiro_venomous_swipe;
      const roll = calculateDamage(user, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        user, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillConversion: { physToNecroPct: 70 }, skillPct: 85, skillLabel: `${ability?.name || 'Skill'} weapon damage (85%)`, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      // +50% then another +25% buildup across encounter 4 (was 90, then 135).
      return { ...roll, physical, elemental, necrotic, amount, buildup: { disease: 169 } };
    },
    description: "Deals 85% weapon damage and applies 169 Disease buildup."
  },
  'kiro_poison_cloud': {
    id: 'kiro_poison_cloud',
    name: 'Poison Cloud',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'class',
    mpCost: 8,
    cooldown: 2,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    requiresWeakness: { family: 'toxic', tier: 1 },
    tags: ['ranged', 'attack', 'aoe'],
    // buildupHint added — see oskar_rending_bite's comment above.
    buildupHint: { toxic: 1 },
    apply: (user, target, scene) => {
      const ability = SKILLS?.kiro_poison_cloud;
      const roll = calculateDamage(user, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        user, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillConversion: { physToNecroPct: 100 }, skillPct: 45, skillLabel: `${ability?.name || 'Skill'} weapon damage (45%)`, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      const SPLASH_SCALE = 0.65;
      // Was scene.turnOrder?.filter(...) — silently bypassed Blockade's wall
      // (see CombatScene._getTargetableEnemiesFor).
      const foes = (scene?._getTargetableEnemiesFor?.(user) || []).filter(u => u !== target);
      const splash = foes.map(t => {
        const splashPhysical = Math.floor(physical * SPLASH_SCALE);
        const splashElemental = Math.floor(elemental * SPLASH_SCALE);
        const splashNecrotic = Math.floor(necrotic * SPLASH_SCALE);
        const splashAmount = Math.max(1, splashPhysical + splashElemental + splashNecrotic);
        return {
          target: t, amount: splashAmount,
          physical: splashPhysical, elemental: splashElemental, necrotic: splashNecrotic,
          // +50% then another +25% buildup across encounter 4 (was 60, then 90).
          buildup: { toxic: 113 }, tags: ability?.tags,
        };
      });

      return {
        ...roll, physical, elemental, necrotic, amount,
        consumeWeakness: ['toxic'],
        splash: splash.length ? splash : undefined,
      };
    },
    description: "Requires the target to be Poisoned (Toxic T1+). Deals 45% weapon damage and consumes their Toxic buildup, plus 65% damage and 113 Toxic buildup to every other party member."
  },
  'kiro_corrosive_bite': {
    id: 'kiro_corrosive_bite',
    name: 'Corrosive Bite',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'major',
    mpCost: 8,
    cooldown: 2,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    requiresWeakness: { family: 'toxic', tier: 2 },
    tags: ['melee', 'attack'],
    // buildupHint added — see oskar_rending_bite's comment above. Toxic
    // (the required/consumed family) rather than the conditional curse
    // bonus, since toxic is what this skill is always about.
    buildupHint: { toxic: 1 },
    apply: (user, target) => {
      const ability = SKILLS?.kiro_corrosive_bite;
      const roll = calculateDamage(user, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        user, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillConversion: { physToNecroPct: 70 }, skillPct: 145, skillLabel: `${ability?.name || 'Skill'} weapon damage (145%)`, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      const payload = { ...roll, physical, elemental, necrotic, amount, consumeWeakness: ['toxic'] };
      if ((target?.weakness?.tiers?.disease || 0) >= 1) {
        // +50% then another +25% buildup across encounter 4 (was 80, then 120).
        payload.buildup = { curse: 150 };
      }
      return payload;
    },
    description: "Requires the target to be Envenomed (Toxic T2+). Deals 145% weapon damage and consumes their Toxic buildup — also applies 150 Curse buildup if they're Sickened (Disease T1+)."
  },

  // Kiro's reaction — venom-spit counter when struck. Same idempotent-arm +
  // delayed _applyAbilityToTarget pattern as Oskar's Reflex Bite.
  'kiro_venom_reflex': {
    id: 'kiro_venom_reflex',
    name: 'Venom Reflex',
    type: 'enemy',
    mechanic: 'reaction',
    typedDamage: true,
    actionCost: 'reaction',
    mpCost: 3,
    cooldown: 2,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['ranged', 'attack'],
    // buildupHint added — see oskar_rending_bite's comment above.
    buildupHint: { toxic: 1 },
    apply: (user, target) => {
      const ability = SKILLS?.kiro_venom_reflex;
      const roll = calculateDamage(user, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        user, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillConversion: { physToNecroPct: 100 }, skillPct: 55, skillLabel: `${ability?.name || 'Skill'} weapon damage (55%)`, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      // +50% then another +25% buildup across encounter 4 (was 70, then 105).
      return { ...roll, physical, elemental, necrotic, amount, buildup: { toxic: 131 } };
    },
    reaction: {
      trigger: 'self_hit',
      cooldownOn: 'trigger',
      canTrigger: () => true,
      exec: ({ owner, attacker, scene }) => {
        if (!attacker) return;
        const ability = SKILLS?.kiro_venom_reflex;
        scene?._log?.(`${owner?.name || 'Kiro'} spits venom in reflex!`);
        scene.time?.delayedCall(50, () => {
          scene._applyAbilityToTarget(owner, attacker, ability, { isReaction: true, tags: ability?.tags || [] });
        });
      },
    },
    description: "Reaction: when struck, spit venom back at the attacker for 55% weapon damage and apply Toxic buildup."
  },

  // Kiro's initiative spender — sheds his skin to regenerate HP. Same
  // spend/scaling shape as huntsman_coordinated_volley (30 minimum, up to 60
  // spent for the full bonus), just a self-heal instead of a damage burst.
  'kiro_molt': {
    id: 'kiro_molt',
    name: 'Molt',
    type: 'enemy',
    actionCost: 'class',
    mpCost: 0,
    cooldown: 3,
    enemyOnly: true,
    requiresTarget: false,
    // Lowered 30→20 (and the spend cap 60→40 below) — his low CHA already
    // meant slow gauge regen, and Cold's own gauge-drain (T1 regen penalty,
    // T2 flat start-of-turn drain) made 30 rarely reachable in practice.
    requiresInitiativeGauge: 20,
    apply: (attacker, _target, scene) => {
      const spend = Math.min(attacker?.initiativeGauge || 0, 40);
      attacker.initiativeGauge = Math.max(0, (attacker.initiativeGauge || 0) - spend);
      // Same 15-30% HP range as before, rescaled onto the new 20-40 spend
      // window (0.75 = 15/20, so spend=20 -> 15%, spend=40 -> 30%).
      const healPct = Math.floor(spend * 0.75);
      const maxHP = attacker.maxHP || 0;
      const healAmt = Math.floor(maxHP * (healPct / 100));
      const before = attacker.currentHP || 0;
      attacker.currentHP = Math.min(maxHP, before + healAmt);
      const actualHealed = attacker.currentHP - before;

      scene?._log?.(`${attacker?.name || 'Kiro'} sheds his old skin, regenerating ${actualHealed} HP!`);
      scene?._showFloatingNumber?.(actualHealed, attacker, /*isHeal=*/true, /*isCrit=*/false);
      scene?._playStatusVFX?.(attacker, { kind: 'heal' });
      scene?._updateHealthBars?.();
      scene?._updateHPMPBars?.();

      return { amount: 0 };
    },
    description: "Spend 20-40 initiative: shed your skin to regenerate 15-30% max HP (scaling with spend)."
  },

  // Encounter 5 - Elemental Duelists (Ember/fire, Rime/ice) — full v3.23
  // typed-pipeline pass, same standard as encounter 4. All damage converts
  // fully phys→elemental (skillConversion: {physToElemPct:100}) since these
  // are cast spells, not physical sword swings, unlike Oskar/Kiro's kit.
  // ==== Encounter 5 Reckoning: summoned adds ====
  // Deliberately small kits. An add's job is board pressure and buildup, not
  // damage — they exist so the player has to decide between clearing them and
  // pushing the duelist, and so AoE shapes have something to catch. Both cost
  // 0 MP (adds have no MP pool) and are single-target melee.
  // ==== Laki — encounter 4's third beast (owl, Disorient) ====
  // Disorient is the MP-pressure family: T1 raises the target's skill costs,
  // T2 drains MP at the start of their turn. So Laki is built as attrition on
  // the party's resources rather than their health — she is the reason a long
  // encounter-4 fight starts running dry. Everything is typed pipeline from
  // the start (see project_enemy_damage_pipeline_audit).

  'laki_piercing_screech': {
    id: 'laki_piercing_screech',
    name: 'Piercing Screech',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'major',
    mpCost: 7,
    cooldown: 3,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['ranged', 'attack', 'aoe', 'disorient'],
    aoe: { shape: 'party', scale: 0.6 },
    buildupHint: { disorient: 100 },
    apply: (user, target, scene) => {
      const ability = SKILLS?.laki_piercing_screech;
      const roll = calculateDamage(user, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        user, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 70, skillLabel: `${ability?.name || 'Skill'} weapon damage (70%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      const splashAmount = Math.max(1, Math.floor(amount * 0.60));
      const others = (scene?._getTargetableEnemiesFor?.(user) || []).filter(u => u !== target);
      return {
        ...roll,
        physical, elemental, necrotic,
        amount,
        buildup: { disorient: 100 },
        splash: others.map(t => ({ target: t, amount: splashAmount, buildup: { disorient: 100 }, tags: ability?.tags })),
      };
    },
    description: "A screech across the whole party — 70% weapon damage to the target, 60% of that to everyone else, and 100 Disorient buildup to all of them."
  },

  'laki_silent_dive': {
    id: 'laki_silent_dive',
    name: 'Silent Dive',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'major',
    mpCost: 5,
    cooldown: 2,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['melee', 'attack', 'disorient'],
    buildupHint: { disorient: 60 },
    // Her single-target payoff, and the only place her damage is real: hits
    // harder the deeper the target is already Disoriented, so the screech
    // above is genuine setup rather than just chip.
    apply: (user, target) => {
      const ability = SKILLS?.laki_silent_dive;
      const roll = calculateDamage(user, target, ability);
      const dTier = target?.weakness?.tiers?.disorient || 0;
      const bonusPct = dTier >= 2 ? 60 : (dTier >= 1 ? 30 : 0);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        user, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 110 + bonusPct,
          skillLabel: `${ability?.name || 'Skill'} weapon damage (110%${bonusPct ? ` + ${bonusPct}% Disorient tier` : ''})`,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return { ...roll, physical, elemental, necrotic, amount, buildup: { disorient: 60 } };
    },
    description: "Drops on one target in silence: 110% weapon damage, +30% if they are Rattled (Disorient T1) or +60% if Reeling (T2). Applies 60 Disorient buildup."
  },

  'laki_hooting_taunt': {
    id: 'laki_hooting_taunt',
    name: 'Maddening Hoots',
    type: 'enemy',
    actionCost: 'bonus',
    mpCost: 3,
    cooldown: 2,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['ranged', 'disorient'],
    buildupHint: { disorient: 120 },
    // No damage at all — pure buildup. This is the skill that actually makes
    // her a resource threat, and it costs her only a bonus action.
    apply: (user, target, scene) => {
      scene?._log?.(`${user?.name || 'The owl'} calls, and the sound will not sit still.`);
      return { amount: 0, buildup: { disorient: 120 } };
    },
    description: "No damage — applies 120 Disorient buildup for a bonus action."
  },

  'laki_night_eyes': {
    id: 'laki_night_eyes',
    name: 'Night Eyes',
    type: 'enemy',
    actionCost: 'class',
    mpCost: 4,
    cooldown: 4,
    enemyOnly: true,
    requiresTarget: false,
    targetRequirement: 'self',
    tags: ['support'],
    apply: (user, _target, scene) => {
      scene?._addStatusEffects?.(user, [{
        id: 'laki_night_eyes', turns: 3,
        mods: { Evasion: 25, Accuracy: 15 },
        vfx: { kind: 'buff_increase' },
      }]);
      return { amount: 0 };
    },
    description: "Self: +25 Evasion and +15 Accuracy for 3 turns."
  },

  'laki_startle': {
    id: 'laki_startle',
    name: 'Startle',
    type: 'enemy',
    mechanic: 'reaction',
    actionCost: 'reaction',
    mpCost: 0,
    cooldown: 2,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['ranged', 'disorient'],
    buildupHint: { disorient: 70 },
    // Answers a hit with noise rather than damage, in keeping with the rest
    // of her kit — being attacked makes the party's next actions cost more.
    apply: (user, target) => ({
      amount: 0,
      buildup: { disorient: 70 },
    }),
    // Same shape Kiro's Venom Reflex uses — `reaction: { trigger: 'self_hit' }`
    // is the real convention; a bare `reactionTrigger` field is read by nothing.
    reaction: {
      trigger: 'self_hit',
      cooldownOn: 'trigger',
      canTrigger: () => true,
      exec: ({ owner, attacker, scene }) => {
        if (!attacker) return;
        const ability = SKILLS?.laki_startle;
        scene?._log?.(`${owner?.name || 'Laki'} erupts into a startled shriek!`);
        scene.time?.delayedCall(50, () => {
          scene._applyAbilityToTarget(owner, attacker, ability, { isReaction: true, tags: ability?.tags || [] });
        });
      },
    },
    description: "Reaction: when struck, shrieks for 70 Disorient buildup on the attacker."
  },

  'lava_spawn_lash': {
    id: 'lava_spawn_lash',
    name: 'Molten Lash',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'major',
    mpCost: 0,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['melee', 'attack', 'fire'],
    buildupHint: { fire: 90 },
    apply: (user, target) => {
      const ability = SKILLS?.lava_spawn_lash;
      const roll = calculateDamage(user, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        user, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 110, skillLabel: `${ability?.name || 'Skill'} weapon damage (110%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
          skillConversion: { physToElemPct: 100 },
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return {
        ...roll, physical, elemental, necrotic, amount,
        isMagic: true, element: 'fire', buildup: { fire: 90 },
      };
    },
    description: "Deals 110% weapon damage as Fire and applies 90 Fire buildup."
  },

  // ==== Encounter 5 Reckoning: summoned adds ====
  // Deliberately small kits. An add's job is board pressure and buildup, not
  // damage — they exist so the player has to decide between clearing them and
  // pushing the duelist, and so AoE shapes have something to catch. Both cost
  // 0 MP (adds have no MP pool) and are single-target melee.
  'ice_spawn_lash': {
    id: 'ice_spawn_lash',
    name: 'Rime Lash',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'major',
    mpCost: 0,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['melee', 'attack', 'cold'],
    buildupHint: { cold: 90 },
    apply: (user, target) => {
      const ability = SKILLS?.ice_spawn_lash;
      const roll = calculateDamage(user, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        user, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 110, skillLabel: `${ability?.name || 'Skill'} weapon damage (110%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
          skillConversion: { physToElemPct: 100 },
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return {
        ...roll, physical, elemental, necrotic, amount,
        isMagic: true, element: 'ice', buildup: { cold: 90 },
      };
    },
    description: "Deals 110% weapon damage as Ice and applies 90 Cold buildup."
  },

  'fire_flame_slash': {
    id: 'fire_flame_slash',
    name: 'Flame Slash',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'major',
    mpCost: 5,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['melee', 'attack', 'fire'],
    // buildupHint added — 'fire' tag already made tint work via
    // _dominantBuildupFamily's tag-fallback scan, but every other real
    // skill in the game declares this explicitly rather than relying on the
    // fallback; added for consistency. See project_encounter5_vfx_sfx_pass.
    buildupHint: { fire: 140 },
    apply: (user, target, scene) => {
      const ability = SKILLS?.fire_flame_slash;
      const roll = calculateDamage(user, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        user, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 100, skillLabel: `${ability?.name || 'Skill'} weapon damage (100%)`, isCrit: roll.isCrit, critMult: roll.critMult, skillConversion: { physToElemPct: 100 } }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      // +40% buildup, matching encounter 4's own harder-than-before pass (was 100).
      const result = { ...roll, physical, elemental, necrotic, amount, isMagic: true, element: 'fire', buildup: { fire: 140 } };

      // Enraged: her regular go-to move becomes a full-field AOE instead of
      // single-target — the "abilities gain a different effect" ask, not
      // just the separate enrage-exclusive ultimate.
      if ((user?.statusEffects || []).some(se => se?.id === 'duelist_fury')) {
        // Was scene.turnOrder?.filter(...) — silently bypassed Blockade's
        // wall (see CombatScene._getTargetableEnemiesFor).
        const foes = (scene?._getTargetableEnemiesFor?.(user) || []).filter(u => u !== target);
        result.splash = foes.map(t => ({
          target: t, amount, physical, elemental, necrotic,
          buildup: { fire: 140 }, tags: ability?.tags,
        }));
      }
      return result;
    },
    description: "Deals 100% weapon damage as Fire and applies 140 Fire buildup. While Enraged, strikes the entire enemy party instead of a single target."
  },
  'fire_heated_guard': {
    id: 'fire_heated_guard',
    name: 'Heated Guard',
    type: 'enemy',
    actionCost: 'bonus',
    mpCost: 4,
    cooldown: 1,
    enemyOnly: true,
    requiresTarget: false,
    apply: (user) => ({
      amount: 0,
      statusEffects: [{ id: 'heated_guard', turns: 2, mods: { PhysicalResist: 15 }, vfx: { kind: 'buff_harden' } }]
    }),
    description: "Grants +15 Physical Resist for 2 turns."
  },
  'fire_burst': {
    id: 'fire_burst',
    name: 'Fire Burst',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'class',
    mpCost: 10,
    cooldown: 1,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    requiresWeakness: { family: 'fire', tier: 2 },
    tags: ['melee', 'attack', 'fire'],
    apply: (user, target) => {
      const ability = SKILLS?.fire_burst;
      // Thermal Shock: bonus damage if the target is ALSO chilled — the
      // "coordinate Fire and Cold buildup" payoff the encounter's own
      // longDescription already advertised but never actually implemented.
      const hasCold = (target?.weakness?.tiers?.cold || 0) >= 1;
      const skillPct = 130 + (hasCold ? 30 : 0);
      const roll = calculateDamage(user, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        user, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct, skillLabel: `${ability?.name || 'Skill'} weapon damage (${skillPct}%${hasCold ? ' incl. Thermal Shock' : ''})`, isCrit: roll.isCrit, critMult: roll.critMult, skillConversion: { physToElemPct: 100 } }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return { ...roll, physical, elemental, necrotic, amount, isMagic: true, element: 'fire', consumeWeakness: ['fire'] };
    },
    description: "Requires target at Fire T2. Deals 130% weapon damage as Fire, +30% more (Thermal Shock) if the target is also at least Chilled."
  },
  'fire_flare_wave': {
    id: 'fire_flare_wave',
    name: 'Flare Wave',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'major',
    mpCost: 12,
    cooldown: 2,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['ranged', 'attack', 'aoe', 'fire'],
    // buildupHint added — see fire_flame_slash's comment above.
    buildupHint: { fire: 85 },
    apply: (user, target, scene) => {
      const ability = SKILLS?.fire_flare_wave;
      const roll = calculateDamage(user, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        user, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 90, skillLabel: `${ability?.name || 'Skill'} weapon damage (90%)`, isCrit: roll.isCrit, critMult: roll.critMult, skillConversion: { physToElemPct: 100 } }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      const SPLASH_SCALE = 0.8;
      // Was scene.turnOrder?.filter(...) — silently bypassed Blockade's wall
      // (see CombatScene._getTargetableEnemiesFor).
      const foes = (scene?._getTargetableEnemiesFor?.(user) || []).filter(u => u !== target);
      const splash = foes.map(t => {
        const splashPhysical = Math.floor(physical * SPLASH_SCALE);
        const splashElemental = Math.floor(elemental * SPLASH_SCALE);
        const splashNecrotic = Math.floor(necrotic * SPLASH_SCALE);
        const splashAmount = Math.max(1, splashPhysical + splashElemental + splashNecrotic);
        return {
          target: t, amount: splashAmount,
          physical: splashPhysical, elemental: splashElemental, necrotic: splashNecrotic,
          // +40% buildup, matching encounter 4's pass (was 60).
          buildup: { fire: 85 }, tags: ability?.tags,
        };
      });

      return {
        ...roll, physical, elemental, necrotic, amount,
        isMagic: true, element: 'fire',
        buildup: { fire: 85 },
        splash: splash.length ? splash : undefined,
      };
    },
    description: "Deals 90% weapon damage as Fire and applies 85 Fire buildup to the target, plus 80% damage and 85 Fire buildup to every other party member."
  },

  'ice_frost_strike': {
    id: 'ice_frost_strike',
    name: 'Frost Strike',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'major',
    mpCost: 5,
    cooldown: 1,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['melee', 'attack', 'cold'],
    // buildupHint added — see fire_flame_slash's comment above.
    buildupHint: { cold: 140 },
    apply: (user, target, scene) => {
      const ability = SKILLS?.ice_frost_strike;
      const roll = calculateDamage(user, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        user, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 100, skillLabel: `${ability?.name || 'Skill'} weapon damage (100%)`, isCrit: roll.isCrit, critMult: roll.critMult, skillConversion: { physToElemPct: 100 } }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      // +40% buildup, matching encounter 4's own harder-than-before pass (was 100).
      const result = { ...roll, physical, elemental, necrotic, amount, isMagic: true, element: 'cold', buildup: { cold: 140 } };

      // Enraged: same "regular ability becomes full-field AOE" treatment as
      // Ember's Flame Slash.
      if ((user?.statusEffects || []).some(se => se?.id === 'duelist_fury')) {
        // Was scene.turnOrder?.filter(...) — silently bypassed Blockade's
        // wall (see CombatScene._getTargetableEnemiesFor).
        const foes = (scene?._getTargetableEnemiesFor?.(user) || []).filter(u => u !== target);
        result.splash = foes.map(t => ({
          target: t, amount, physical, elemental, necrotic,
          buildup: { cold: 140 }, tags: ability?.tags,
        }));
      }
      return result;
    },
    description: "Deals 100% weapon damage as Cold and applies 140 Cold buildup. While Enraged, strikes the entire enemy party instead of a single target."
  },
  'ice_icy_guard': {
    id: 'ice_icy_guard',
    name: 'Icy Guard',
    type: 'enemy',
    actionCost: 'bonus',
    mpCost: 4,
    cooldown: 1,
    enemyOnly: true,
    requiresTarget: false,
    apply: () => ({ amount: 0, statusEffects: [{ id: 'icy_guard', turns: 2, mods: { PhysicalResist: 15 }, vfx: { kind: 'buff_harden' } }] }),
    description: "Grants +15 Physical Resist for 2 turns."
  },
  'ice_freeze_point': {
    id: 'ice_freeze_point',
    name: 'Freeze Point',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'class',
    mpCost: 10,
    cooldown: 1,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    requiresWeakness: { family: 'cold', tier: 2 },
    tags: ['melee', 'attack', 'cold'],
    apply: (user, target) => {
      const ability = SKILLS?.ice_freeze_point;
      // Thermal Shock: bonus damage if the target is ALSO singed.
      const hasFire = (target?.weakness?.tiers?.fire || 0) >= 1;
      const skillPct = 130 + (hasFire ? 30 : 0);
      const roll = calculateDamage(user, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        user, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct, skillLabel: `${ability?.name || 'Skill'} weapon damage (${skillPct}%${hasFire ? ' incl. Thermal Shock' : ''})`, isCrit: roll.isCrit, critMult: roll.critMult, skillConversion: { physToElemPct: 100 } }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return {
        ...roll, physical, elemental, necrotic, amount,
        isMagic: true, element: 'cold',
        consumeWeakness: ['cold'],
        statusEffects: [{ id: 'frozen', turns: 1, blocksAction: true, vfx: { kind: 'debuff_shock' } }],
      };
    },
    description: "Requires target at Cold T2. Deals 130% weapon damage as Cold, +30% more (Thermal Shock) if the target is also at least Singed. Applies Frozen (skip next action)."
  },
  'ice_shard_storm': {
    id: 'ice_shard_storm',
    name: 'Shard Storm',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'major',
    mpCost: 12,
    cooldown: 2,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['ranged', 'attack', 'aoe', 'cold'],
    // buildupHint added — see fire_flame_slash's comment above.
    buildupHint: { cold: 70 },
    apply: (user, target, scene) => {
      const ability = SKILLS?.ice_shard_storm;
      const roll = calculateDamage(user, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        user, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 90, skillLabel: `${ability?.name || 'Skill'} weapon damage (90%)`, isCrit: roll.isCrit, critMult: roll.critMult, skillConversion: { physToElemPct: 100 } }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      const SPLASH_SCALE = 0.8;
      // Was scene.turnOrder?.filter(...) — silently bypassed Blockade's wall
      // (see CombatScene._getTargetableEnemiesFor).
      const foes = (scene?._getTargetableEnemiesFor?.(user) || []).filter(u => u !== target);
      const splash = foes.map(t => {
        const splashPhysical = Math.floor(physical * SPLASH_SCALE);
        const splashElemental = Math.floor(elemental * SPLASH_SCALE);
        const splashNecrotic = Math.floor(necrotic * SPLASH_SCALE);
        const splashAmount = Math.max(1, splashPhysical + splashElemental + splashNecrotic);
        return {
          target: t, amount: splashAmount,
          physical: splashPhysical, elemental: splashElemental, necrotic: splashNecrotic,
          // +40% buildup, matching encounter 4's pass (was 50).
          buildup: { cold: 70 }, tags: ability?.tags,
        };
      });

      return {
        ...roll, physical, elemental, necrotic, amount,
        isMagic: true, element: 'cold',
        buildup: { cold: 70 },
        splash: splash.length ? splash : undefined,
      };
    },
    description: "Deals 90% weapon damage as Cold and applies 70 Cold buildup to the target, plus 80% damage and 70 Cold buildup to every other party member."
  },

  // Defensive self-wards — Ember hardens against Fire, Rime against Cold:
  // +20% Elemental Resist (the only damage-side lever the engine has that
  // isn't per-element) PLUS a genuine per-family incoming-buildup reduction
  // (fireBuildupMul/coldBuildupMul < 1, the same generic vulnerability
  // mechanism Wind Exposed/Trapped Fire use to INCREASE it — see
  // CombatScene.js's generic buildupMul reader) so each is specifically
  // harder to set ablaze/freeze, not just take less raw damage.
  'ember_fire_ward': {
    id: 'ember_fire_ward',
    name: "Ember's Ward",
    type: 'enemy',
    actionCost: 'bonus',
    mpCost: 5,
    cooldown: 1,
    enemyOnly: true,
    requiresTarget: false,
    apply: () => ({
      amount: 0,
      statusEffects: [{ id: 'ember_fire_ward', turns: 2, mods: { ElementalResist: 20 }, fireBuildupMul: 0.5, vfx: { kind: 'buff_harden' } }]
    }),
    description: "Self-buff: +20% Elemental Resist and half incoming Fire buildup for 2 turns."
  },
  'rime_cold_ward': {
    id: 'rime_cold_ward',
    name: "Rime's Ward",
    type: 'enemy',
    actionCost: 'bonus',
    mpCost: 5,
    cooldown: 1,
    enemyOnly: true,
    requiresTarget: false,
    apply: () => ({
      amount: 0,
      statusEffects: [{ id: 'rime_cold_ward', turns: 2, mods: { ElementalResist: 20 }, coldBuildupMul: 0.5, vfx: { kind: 'buff_harden' } }]
    }),
    description: "Self-buff: +20% Elemental Resist and half incoming Cold buildup for 2 turns."
  },

  // Ember's initiative spender — same spend/scaling shape as
  // huntsman_coordinated_volley, tuned for Ember's own lower CHA/gauge regen
  // (25 minimum, up to 50 spent for the full bonus).
  'ember_inferno_surge': {
    id: 'ember_inferno_surge',
    name: 'Inferno Surge',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'class',
    mpCost: 8,
    cooldown: 3,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    requiresInitiativeGauge: 25,
    tags: ['melee', 'attack', 'fire'],
    // buildupHint added — see fire_flame_slash's comment above. The real
    // buildup this grants is flat 160 (unlike skillPct, it doesn't scale
    // with spend), so this is exact, not just a representative value.
    buildupHint: { fire: 160 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.ember_inferno_surge;
      const spend = Math.min(attacker?.initiativeGauge || 0, 50);
      attacker.initiativeGauge = Math.max(0, (attacker.initiativeGauge || 0) - spend);
      // 125% at the 25 minimum, up to 150% at the 50 cap.
      const skillPct = 100 + spend;
      const roll = calculateDamage(attacker, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct, skillLabel: `${ability?.name || 'Skill'} weapon damage (${skillPct}%)`, isCrit: roll.isCrit, critMult: roll.critMult, skillConversion: { physToElemPct: 100 } }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      scene?._log?.(`${attacker?.name || 'Ember'} erupts in a surge of flame!`);
      return { ...roll, physical, elemental, necrotic, amount, isMagic: true, element: 'fire', buildup: { fire: 160 } };
    },
    description: "Spend 25-50 initiative: deal 125-150% weapon damage as Fire (scaling with spend) and apply heavy Fire buildup."
  },

  // Rime's initiative spender — mirrors Inferno Surge exactly.
  'rime_absolute_zero': {
    id: 'rime_absolute_zero',
    name: 'Absolute Zero',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'class',
    mpCost: 8,
    cooldown: 3,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    requiresInitiativeGauge: 25,
    tags: ['melee', 'attack', 'cold'],
    // buildupHint added — see fire_flame_slash's comment above.
    buildupHint: { cold: 160 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.rime_absolute_zero;
      const spend = Math.min(attacker?.initiativeGauge || 0, 50);
      attacker.initiativeGauge = Math.max(0, (attacker.initiativeGauge || 0) - spend);
      const skillPct = 100 + spend;
      const roll = calculateDamage(attacker, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct, skillLabel: `${ability?.name || 'Skill'} weapon damage (${skillPct}%)`, isCrit: roll.isCrit, critMult: roll.critMult, skillConversion: { physToElemPct: 100 } }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      scene?._log?.(`${attacker?.name || 'Rime'} exhales a wave of absolute cold!`);
      return { ...roll, physical, elemental, necrotic, amount, isMagic: true, element: 'cold', buildup: { cold: 160 } };
    },
    description: "Spend 25-50 initiative: deal 125-150% weapon damage as Cold (scaling with spend) and apply heavy Cold buildup."
  },

  // Ember's reaction — replaces the old heated_guard `data:{retaliateFire:true}`
  // field, which was declared but never actually read/enforced anywhere
  // (same "declared but unenforced" bug class as Glacial Strike's old status
  // fields). Armed idempotently by the fire_duelist AI profile; only
  // triggers a real counter-hit while Heated Guard is actually up.
  'ember_flame_retaliation': {
    id: 'ember_flame_retaliation',
    name: 'Flame Retaliation',
    type: 'enemy',
    mechanic: 'reaction',
    typedDamage: true,
    actionCost: 'reaction',
    mpCost: 0,
    cooldown: 1,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['melee', 'attack', 'fire'],
    // buildupHint added — see fire_flame_slash's comment above.
    buildupHint: { fire: 70 },
    apply: (user, target) => {
      const ability = SKILLS?.ember_flame_retaliation;
      const roll = calculateDamage(user, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        user, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 60, skillLabel: `${ability?.name || 'Skill'} weapon damage (60%)`, isCrit: roll.isCrit, critMult: roll.critMult, skillConversion: { physToElemPct: 100 } }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return { ...roll, physical, elemental, necrotic, amount, isMagic: true, element: 'fire', buildup: { fire: 70 } };
    },
    reaction: {
      trigger: 'self_hit',
      cooldownOn: 'trigger',
      canTrigger: ({ owner }) => (owner?.statusEffects || []).some(se => se?.id === 'heated_guard'),
      exec: ({ owner, attacker, scene }) => {
        if (!attacker) return;
        const ability = SKILLS?.ember_flame_retaliation;
        scene?._log?.(`${owner?.name || 'Ember'}'s guard flares back in retaliation!`);
        scene.time?.delayedCall(50, () => {
          scene._applyAbilityToTarget(owner, attacker, ability, { isReaction: true, tags: ability?.tags || [] });
        });
      },
    },
    description: "Reaction: while Heated Guard is active, retaliate against an attacker for 60% weapon damage as Fire."
  },

  // Rime's reaction — mirrors Flame Retaliation, gated on Icy Guard.
  'rime_frost_retaliation': {
    id: 'rime_frost_retaliation',
    name: 'Frost Retaliation',
    type: 'enemy',
    mechanic: 'reaction',
    typedDamage: true,
    actionCost: 'reaction',
    mpCost: 0,
    cooldown: 1,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['melee', 'attack', 'cold'],
    // buildupHint added — see fire_flame_slash's comment above.
    buildupHint: { cold: 70 },
    apply: (user, target) => {
      const ability = SKILLS?.rime_frost_retaliation;
      const roll = calculateDamage(user, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        user, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 60, skillLabel: `${ability?.name || 'Skill'} weapon damage (60%)`, isCrit: roll.isCrit, critMult: roll.critMult, skillConversion: { physToElemPct: 100 } }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return { ...roll, physical, elemental, necrotic, amount, isMagic: true, element: 'cold', buildup: { cold: 70 } };
    },
    reaction: {
      trigger: 'self_hit',
      cooldownOn: 'trigger',
      canTrigger: ({ owner }) => (owner?.statusEffects || []).some(se => se?.id === 'icy_guard'),
      exec: ({ owner, attacker, scene }) => {
        if (!attacker) return;
        const ability = SKILLS?.rime_frost_retaliation;
        scene?._log?.(`${owner?.name || 'Rime'}'s guard bites back in retaliation!`);
        scene.time?.delayedCall(50, () => {
          scene._applyAbilityToTarget(owner, attacker, ability, { isReaction: true, tags: ability?.tags || [] });
        });
      },
    },
    description: "Reaction: while Icy Guard is active, retaliate against an attacker for 60% weapon damage as Cold."
  },

  // Enrage-exclusive ultimates — unlocked onto the survivor's skills array
  // by enrageOnAllyDeath (enemyTypes.js templates) the moment their twin
  // falls. canExecute is declarative/defensive here; the REAL gate that
  // matters is each AI profile's own hasStatus('duelist_fury') check, since
  // canExecute is only enforced by the legacy _executeSkill path, not the
  // one AI/normal actions actually use (_applyAbilityToTarget).
  'ember_wildfire_unleashed': {
    id: 'ember_wildfire_unleashed',
    name: 'Wildfire Unleashed',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'major',
    mpCost: 10,
    cooldown: 2,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['melee', 'attack', 'fire'],
    // buildupHint added — see fire_flame_slash's comment above.
    buildupHint: { fire: 200 },
    canExecute: ({ user }) => (user?.statusEffects || []).some(se => se?.id === 'duelist_fury')
      ? true : { ok: false, reason: `${user?.name || 'Ember'} isn't enraged yet.` },
    apply: (user, target) => {
      const ability = SKILLS?.ember_wildfire_unleashed;
      const roll = calculateDamage(user, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        user, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 180, skillLabel: `${ability?.name || 'Skill'} weapon damage (180%)`, isCrit: roll.isCrit, critMult: roll.critMult, skillConversion: { physToElemPct: 100 } }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return { ...roll, physical, elemental, necrotic, amount, isMagic: true, element: 'fire', buildup: { fire: 200 }, consumeWeakness: ['fire'] };
    },
    description: "Enraged only. Deals 180% weapon damage as Fire and applies massive Fire buildup."
  },
  'rime_eternal_frost': {
    id: 'rime_eternal_frost',
    name: 'Eternal Frost',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'major',
    mpCost: 10,
    cooldown: 2,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['melee', 'attack', 'cold'],
    // buildupHint added — see fire_flame_slash's comment above.
    buildupHint: { cold: 200 },
    canExecute: ({ user }) => (user?.statusEffects || []).some(se => se?.id === 'duelist_fury')
      ? true : { ok: false, reason: `${user?.name || 'Rime'} isn't enraged yet.` },
    apply: (user, target) => {
      const ability = SKILLS?.rime_eternal_frost;
      const roll = calculateDamage(user, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        user, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 180, skillLabel: `${ability?.name || 'Skill'} weapon damage (180%)`, isCrit: roll.isCrit, critMult: roll.critMult, skillConversion: { physToElemPct: 100 } }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return {
        ...roll, physical, elemental, necrotic, amount,
        isMagic: true, element: 'cold',
        buildup: { cold: 200 }, consumeWeakness: ['cold'],
        statusEffects: [{ id: 'frozen', turns: 1, blocksAction: true, vfx: { kind: 'debuff_shock' } }],
      };
    },
    description: "Enraged only. Deals 180% weapon damage as Cold, applies massive Cold buildup, and Freezes the target (skip next action)."
  },

  // Encounter 6 - Berserker Boss
  'berserker_reckless_strike': {
    id: 'berserker_reckless_strike',
    name: 'Reckless Strike',
    type: 'enemy',
    typedDamage: true,
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
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 100, skillLabel: `${ability?.name || 'Skill'} weapon damage (100%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return { ...roll, physical, elemental, necrotic, amount };
    },
    description: "A free, no-frills swing — always available, even at 0 MP."
  },

  'berserker_crushing_blow': {
    id: 'berserker_crushing_blow',
    name: 'Crushing Blow',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'major',
    mpCost: 6,
    cooldown: 1,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['melee', 'attack', 'expose', 'lacerate'],
    // buildupHint added — mirrors the real (larger) return values below;
    // description text above still says "90/80" from before a rebalance
    // pass bumped these to 110/100 — pre-existing text drift, not something
    // this VFX pass touches. See project_encounter6_vfx_sfx_pass.
    buildupHint: { expose: 110, lacerate: 100 },
    apply: (attacker, target) => {
      const ability = SKILLS?.berserker_crushing_blow;
      const roll = calculateDamage(attacker, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 100, skillLabel: `${ability?.name || 'Skill'} weapon damage (100%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return { ...roll, physical, elemental, necrotic, amount, buildup: { expose: 110, lacerate: 100 } };
    },
    description: "Deals weapon damage and applies 110 Expose and 100 Lacerate buildup."
  },
  'berserker_disrupting_roar': {
    id: 'berserker_disrupting_roar',
    name: 'Disrupting Roar',
    type: 'enemy',
    typedDamage: true,
    // Was 'class' — moved to 'bonus' (same pool as Bleeding Sweep below) so
    // the two full-party AoEs can no longer both fire in the same turn; they
    // used to sit on separate action pools (class + major) and the AI would
    // happily use both back to back, hitting the whole party twice at full
    // splash in one turn. See project_encounter6_rework memory.
    actionCost: 'bonus',
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
    // buildupHint added — see berserker_crushing_blow's comment above.
    buildupHint: { disorient: 100 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.berserker_disrupting_roar;
      const roll = calculateDamage(attacker, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 100, skillLabel: `${ability?.name || 'Skill'} weapon damage (100%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      // 70% splash — matches the convention every other AoE in the game
      // uses (Barbed Bloom, etc.). Was a flat 100% copy of the primary's
      // own hit to the ENTIRE party, no discount at all — a big piece of
      // why this fight could nearly wipe a party in one turn.
      const splashAmount = Math.max(1, Math.floor(amount * 0.70));
      // Was scene.turnOrder?.filter(...) — silently bypassed Blockade's wall
      // (see CombatScene._getTargetableEnemiesFor).
      const others = (scene?._getTargetableEnemiesFor?.(attacker) || []).filter(u => u !== target);
      return {
        ...roll,
        physical, elemental, necrotic,
        amount,
        buildup: { disorient: 100 },
        splash: others.map(t => ({ target: t, amount: splashAmount, buildup: { disorient: 100 } })),
      };
    },
    description: "Roars, disorienting the whole party. Deals damage to the primary target and 70% of that to the rest, building Disorient on every foe."
  },
  'berserker_bleeding_sweep': {
    id: 'berserker_bleeding_sweep',
    name: 'Bleeding Sweep',
    type: 'enemy',
    typedDamage: true,
    // Was 'major' — see berserker_disrupting_roar's comment above for why
    // this now shares the bonus-action pool with it.
    actionCost: 'bonus',
    mpCost: 8,
    cooldown: 2,
    enemyOnly: true,
    // Same fix as Disrupting Roar — was 100% splash with no real primary
    // target, so it could never emit self_hit for any reaction to see.
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['melee', 'aoe', 'lacerate'],
    aoe: { shape: 'party', scale: 1 },
    // buildupHint added — see berserker_crushing_blow's comment above.
    buildupHint: { lacerate: 110 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.berserker_bleeding_sweep;
      const roll = calculateDamage(attacker, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 100, skillLabel: `${ability?.name || 'Skill'} weapon damage (100%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      // 70% splash — see berserker_disrupting_roar's comment above.
      const splashAmount = Math.max(1, Math.floor(amount * 0.70));
      // Was scene.turnOrder?.filter(...) — silently bypassed Blockade's wall
      // (see CombatScene._getTargetableEnemiesFor).
      const others = (scene?._getTargetableEnemiesFor?.(attacker) || []).filter(u => u !== target);
      return {
        ...roll,
        physical, elemental, necrotic,
        amount,
        buildup: { lacerate: 110 },
        splash: others.map(t => ({ target: t, amount: splashAmount, buildup: { lacerate: 110 } })),
      };
    },
    description: "A wide, bleeding sweep — full damage to the primary target, 70% of that to the rest of the party."
  },
  'berserker_guarded_fury': {
    id: 'berserker_guarded_fury',
    name: 'Guarded Fury',
    type: 'enemy',
    typedDamage: true,
    // Was 'bonus' — moved to 'major' so he has a second real major-action
    // option now that Unstoppable Rush no longer costs an action at all
    // (see its own comment below).
    actionCost: 'major',
    mpCost: 5,
    cooldown: 2,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    // Was 'cold' buildup — switched to 'disorient', matching his other
    // physical-family-focused abilities (Crushing Blow/Bleeding Sweep/Blood
    // Fury) instead of being his kit's one lone elemental outlier.
    tags: ['melee', 'attack', 'disorient'],
    // buildupHint added — see berserker_crushing_blow's comment above.
    buildupHint: { disorient: 90 },
    // Guard buff was returned via statusEffects, which the engine ALWAYS
    // applies to the TARGET (see fighter_guarded_blow's fix above, same
    // exact bug) — meaning this was granting +15 Physical Resist to whoever
    // got hit, not the berserker bracing itself. Applied directly to
    // `attacker` instead.
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.berserker_guarded_fury;
      const roll = calculateDamage(attacker, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 100, skillLabel: `${ability?.name || 'Skill'} weapon damage (100%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      scene?._addStatusEffects?.(attacker, [{ id: 'berserker_guard', turns: 2, mods: { PhysicalResist: 15 }, vfx: { kind: 'buff_harden' } }]);
      return { ...roll, physical, elemental, necrotic, amount, buildup: { disorient: 90 } };
    },
    description: "Deals weapon damage and applies 90 Disorient buildup, while bracing itself for 2 turns (+15 Physical Resist)."
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
      statusEffects: [{ id: 'battle_frenzy', turns: 2, mods: { Initiative: 30, Accuracy: 20 }, vfx: { kind: 'buff_increase' } }]
    }),
    description: "Grants +30 Initiative and +20 Accuracy for 2 turns."
  },
  'berserker_death_spiral': {
    id: 'berserker_death_spiral',
    name: 'Death Spiral',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'class',
    mpCost: 12,
    cooldown: 3,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['melee', 'attack', 'finisher'],
    // Was T1+ each — raised to T2+ each, a real commitment to build toward
    // rather than an easy early-fight gate.
    requiresWeakness: [
      { family: 'expose', tier: 2 },
      { family: 'lacerate', tier: 2 }
    ],
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.berserker_death_spiral;
      const roll = calculateDamage(attacker, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 100, skillLabel: `${ability?.name || 'Skill'} weapon damage (100%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      // He cuts himself open finishing the spiral — self-Lacerate buildup so
      // Reckless Harvest (his own self-Lacerate-consume skill) has real fuel
      // to work with across the fight instead of depending entirely on the
      // party's own Lacerate hits landing on him.
      scene?._applyWeaknessBuildup?.(attacker, { lacerate: 150 }, { user: attacker });
      return { ...roll, physical, elemental, necrotic, amount, consumeWeakness: ['expose', 'lacerate'] };
    },
    description: "Requires the target to be both Exposed and Lacerated (T2+ each). Deals heavy weapon damage, consumes both their Expose and Lacerate buildup, and cuts himself for 150 Lacerate buildup."
  },
  'berserker_unstoppable_rush': {
    id: 'berserker_unstoppable_rush',
    name: 'Unstoppable Rush',
    type: 'enemy',
    // Full redesign — was a major-action damage rush, now a genuinely FREE
    // tactical threat: no action-economy cost at all, gated purely on
    // Initiative via requiresInitiativeGauge (the same generic engine gate
    // Coordinated Volley/Blazing Fervor use — also fires the
    // onInitiativeAbilityUsed local-chat hook for free). Deals no direct
    // damage; marks a target instead, resolved at the END of THEIR next
    // turn (see the berserker_glare handling in _applyEndOfTurnProcs,
    // CombatScene.js) — functionally similar in spirit to a hazard-zone
    // punish but deliberately built independent of the quake-zone/
    // slotEffects ground-hazard system (no shared tags/references).
    actionCost: 'free',
    requiresInitiativeGauge: 50,
    mpCost: 0,
    cooldown: 2,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['tactical'],
    apply: (attacker, target) => {
      if (attacker) {
        attacker.initiativeGauge = Math.max(0, (attacker.initiativeGauge || 0) - 50);
      }
      return {
        amount: 0,
        statusEffects: [{ id: 'berserker_glare', turns: 2, vfx: { kind: 'debuff_leer' } }],
        log: `${attacker?.name || 'The Berserker'} fixes a murderous glare on ${target?.name || 'the target'}.`,
      };
    },
    description: "Free action — costs no action economy, only 50 Initiative. Marks a target: if they don't move by the end of their own next turn, they take a massive chunk of physical damage."
  },
  'berserker_blood_fury': {
    id: 'berserker_blood_fury',
    name: 'Blood Fury',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'reaction',
    mpCost: 4,
    cooldown: 2,
    mechanic: 'reaction',
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['melee', 'attack', 'expose', 'disorient'],
    // buildupHint added — see berserker_crushing_blow's comment above.
    buildupHint: { expose: 80, disorient: 80 },
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
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 100, skillLabel: `${ability?.name || 'Skill'} weapon damage (100%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return { ...roll, physical, elemental, necrotic, amount, buildup: { expose: 80, disorient: 80 } };
    },
    description: "Reaction: lashes back at whoever strikes him, dealing damage and building Expose and Disorient."
  },
  'berserker_reckless_harvest': {
    id: 'berserker_reckless_harvest',
    name: 'Reckless Harvest',
    type: 'enemy',
    actionCost: 'bonus',
    mpCost: 0,
    cooldown: 4,
    enemyOnly: true,
    requiresTarget: false,
    targetRequirement: 'self',
    tags: ['self'],
    // Reactive to being hit, per explicit design choice — only meaningful
    // once the party's own Lacerate hits have landed on HIM (requiresWeakness
    // supports checking the caster's own weakness via on:'self'). Death
    // Spiral also seeds a real chunk of self-Lacerate on its own use now, so
    // this has fuel to work with even against an all-caster party eventually.
    requiresWeakness: [{ family: 'lacerate', tier: 1, on: 'self' }],
    apply: (attacker, _target, scene) => {
      const meter = Math.min(400, attacker?.weakness?.meters?.lacerate || 0);
      // +5% AttackPower per 50 consumed, capped at +40% (400 consumed).
      const atkPowerPct = Math.floor(meter / 50) * 5;
      // "Power AND health" — self-damage proportional to what he harvested,
      // not an either/or choice (an AI can't meaningfully pick between two
      // payout modes).
      const selfDamage = Math.max(1, Math.floor(meter * 0.05));
      if (attacker?.weakness?.meters) {
        attacker.weakness.meters.lacerate = 0;
        if (attacker.weakness.tiers) attacker.weakness.tiers.lacerate = 0;
      }
      attacker.currentHP = Math.max(0, (attacker.currentHP || 0) - selfDamage);
      scene?._showFloatingNumber?.(selfDamage, attacker, false, false);
      scene?._updateHealthBars?.(); scene?._updateHPMPBars?.();
      scene?._addStatusEffects?.(attacker, [{ id: 'reckless_harvest_buff', turns: 3, mods: { AttackPower: atkPowerPct }, vfx: { kind: 'buff_power' } }]);
      return {
        amount: 0,
        log: `${attacker?.name || 'The Berserker'} tears at his own wounds, harvesting ${meter} Lacerate for +${atkPowerPct}% power (${selfDamage} self-damage).`,
      };
    },
    description: "Requires the Berserker himself to be Lacerated (T1+). Consumes his own Lacerate buildup (up to 400) for +5% AttackPower per 50 consumed (max +40%, 3 turns), at a cost of self-damage equal to 5% of what was consumed."
  },
  'berserker_bloodrite': {
    id: 'berserker_bloodrite',
    name: 'Bloodrite',
    type: 'enemy',
    actionCost: 'bonus',
    mpCost: 4,
    cooldown: 4,
    enemyOnly: true,
    requiresTarget: false,
    targetRequirement: 'self',
    tags: ['self'],
    apply: (attacker, _target, scene) => {
      scene?._addStatusEffects?.(attacker, [{ id: 'bloodrite_buff', turns: 2, mods: { LifeStealPct: 10 }, vfx: { kind: 'buff_health' } }]);
      return { amount: 0, log: `${attacker?.name || 'The Berserker'} howls a bloodrite — his wounds will mend faster.` };
    },
    description: "Grants +10% Lifesteal for 2 turns, doubling his Bloodthirster's own 10% while active."
  },

  // Gorrek's Reckoning-tier II unlock — nothing in his base kit protects
  // him from Disorient at all (Disrupting Roar/Guarded Fury/Blood Fury all
  // apply it to OTHERS, none of them touch his own). Disorient T2 raises
  // his own MP costs and drains MP at turn start — for a boss whose entire
  // kit already runs on MP with only one free fallback, a coordinated
  // party could otherwise lock him down hard. Same self-tier-check gate
  // shape as Reckless Harvest (requiresWeakness + on:'self'), and the same
  // generic <family>BuildupMul rider every vulnerability status in the game
  // already uses — just inverted below 1.0 for resistance instead of above
  // 1.0 for vulnerability.
  'berserker_steel_mind': {
    id: 'berserker_steel_mind',
    name: 'Steel Mind',
    type: 'enemy',
    actionCost: 'bonus',
    mpCost: 3,
    cooldown: 4,
    enemyOnly: true,
    requiresTarget: false,
    targetRequirement: 'self',
    tags: ['self'],
    requiresWeakness: [{ family: 'disorient', tier: 1, on: 'self' }],
    apply: (attacker, _target, scene) => {
      if (attacker?.weakness?.meters) {
        attacker.weakness.meters.disorient = 0;
        if (attacker.weakness.tiers) attacker.weakness.tiers.disorient = 0;
      }
      scene?._addStatusEffects?.(attacker, [{
        id: 'steel_mind_buff', turns: 3, disorientBuildupMul: 0.5, vfx: { kind: 'buff_harden' },
      }]);
      return { amount: 0, log: `${attacker?.name || 'The Berserker'} clears his head, shrugging off the daze.` };
    },
    description: "Requires the Berserker himself to be at least Dazed. Clears his own Disorient buildup and halves incoming Disorient buildup for 3 turns."
  },

  // Free filler strike — no action-economy pool spent at all (same
  // "free" shape berserker_unstoppable_rush uses), just a short cooldown so
  // it can't be spammed every single retry within one turn. Added because
  // his class pool has exactly one skill in it (Death Spiral) and sits
  // completely idle any turn that isn't castable — this fires on top of his
  // normal major/bonus/class actions instead of competing with them, and
  // the AI (berserker_boss profile) deliberately targets whoever's
  // healthiest/least-focused so it spreads damage across the party rather
  // than piling more onto whoever he's already been hitting — the actual
  // fix for one-shot-by-crit risk, not just a numbers trim.
  'berserker_opportunist_strike': {
    id: 'berserker_opportunist_strike',
    name: 'Opportunist Strike',
    type: 'enemy',
    typedDamage: true,
    actionCost: 'free',
    mpCost: 0,
    cooldown: 1,
    enemyOnly: true,
    requiresTarget: true,
    targetRequirement: 'enemy',
    tags: ['melee', 'attack'],
    apply: (attacker, target) => {
      const ability = SKILLS?.berserker_opportunist_strike;
      const roll = calculateDamage(attacker, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          // Was a post-hoc Math.floor(full * 0.5). Expressed as skillPct so the
          // halving happens inside the pipeline, where it is carried as a float
          // and floored once at the end rather than truncating twice.
          skillPct: 50, skillLabel: `${ability?.name || 'Skill'} weapon damage (50%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return { ...roll, physical, elemental, necrotic, amount };
    },
    description: "A free opportunistic jab — no action cost, only a short cooldown. Deals 50% weapon damage."
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
    mpCost: 4,
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
        const cap = attacker.initiativeGaugeMax ?? 100;
        attacker.initiativeGauge = Math.min(cap, before + 15);
        const gain = Math.max(0, attacker.initiativeGauge - before);
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
    mpCost: 5,
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
    mpCost: 5,
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
    mpCost: 5,
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
    mpCost: 4,
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
    mpCost: 6,
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
    mpCost: 5,
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
    mpCost: 4,
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
    mpCost: 5,
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
    mpCost: 6,
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
    mpCost: 5,
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
    mpCost: 6,
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
    mpCost: 5,
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
    mpCost: 6,
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
    mpCost: 5,
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
    mpCost: 5,
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
    statusEffects: [{ id: "lodged", turns: 2, stackable: true }],
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
    mpCost: 5,
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
    mpCost: 5,
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
    mpCost: 5,
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
    mpCost: 6,
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
    mpCost: 4,
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
    mpCost: 5,
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
    mpCost: 5,
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
    mpCost: 5,
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
    mpCost: 6,
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
    mpCost: 5,
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
    mpCost: 6,
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
    mpCost: 4,
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
    mpCost: 4,
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
    mpCost: 4,
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
    mpCost: 5,
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
    mpCost: 5,
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
    mpCost: 5,
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
    mpCost: 5,
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
    mpCost: 0,
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
    description: "Trace a runic circle at your feet. Lasts 4 turns and draws 2 MP each turn to sustain. Dissipates if you move. Required for every zone-modifying skill."
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
    // 'projectile' added — staff is a ranged weapon and this (like every
    // other real staff attack spell) is cast AT the target, not swung in
    // melee, but none of them carried the tag that actually matters for
    // that (ally_projectile_used/Volley, and CombatScene VFX dispatch) —
    // same gap Boulder Toss had, just found across the whole weapon this
    // time instead of one skill. See project_weapon_vfx_systematic_plan.
    tags: ["magic", "spell", "cold", "elemental", "projectile"],
    buildupHint: { cold: 82 },
    // If target is at least Chilled (Cold T1): flat +20% damage and +20
    // additional Cold buildup — both flat now, replacing the old per-tier/
    // intensity-scaled formulas. Crossing Frostbitten (Cold T2) steals up to
    // 8 Initiative from the target (genuine theft, capped by what they
    // actually have — see stealInitiative in CombatScene.js).
    rewardIfWeak: [{ family: "cold", tierAtLeast: 1, buff: { damagePct: 20, addBuildup: { cold: 25 } } }],
    rewardIfTierCross: [{ family: "cold", tier: 2, stealInitiative: 8 }],
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

      const coldBuildup = Math.floor(((ability?.buildupHint?.cold ?? 82) + bonusBuildup) * powerScale);

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
    description: "A swell of biting cold — deals 100% weapon damage as Cold and applies Cold buildup. It bites harder into an already Chilled target, and steals Initiative from one driven to Frostbitten."
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
    // 'projectile' was added during an earlier pass (see frost_swell's
    // comment) but reverted — this is a melee touch spell (the name says
    // so), not a ranged bolt, and the user confirmed it was melee before.
    tags: ["magic", "spell", "lightning", "elemental"],
    buildupHint: { lightning: 69 },
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
      const lightningBuildup = (ability?.buildupHint?.lightning ?? 69) + 10 * lightningTier;

      // Small chance of an extra hit once at least Zapped (Lightning T1+),
      // scaling with the target's current meter — same meter-scaled-chance
      // model Static Prick/Hex Stitch already use, capped modest since this
      // is only a bonus action. The generic repeatChance mechanic
      // (CombatScene.js) carries element/isMagic/buildup through correctly,
      // which is everything this hit has since it's 100% elemental after
      // the conversion above — nothing gets lost.
      const repeatChance = lightningTier >= 1 ? Math.min(0.40, lightningMeter / 1000) : 0;

      return {
        ...roll,
        physical, elemental, necrotic, amount,
        isMagic: true,
        element: 'lightning',
        buildup: { lightning: lightningBuildup },
        repeatChance,
      };
    },
    description: "A crackling touch — deals 80% weapon damage as Lightning. Against a Zapped target (Lightning T1+) it applies +10 further Lightning buildup per tier, and may arc into a second hit carrying the same damage and buildup: a 1% chance per 10 of their Lightning meter, up to 40% at 400."
  },

  // Same formula/shape as Marked Cut (sword_1h) — see Vital Mark's (dagger)
  // comment for the full rationale. Disorient instead of Lacerate here: a
  // piercing arc that, once it truly shocks the target, leaves them reeling.
  'thunder_mark': {
    id: "thunder_mark",
    name: "Thunder Mark",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["staff"],
    requiredStat: "INT",
    requiredValue: 13,
    // Moved Major → Bonus (cross-weapon balance audit, staff variety pass)
    // — damage nerfed 100%→65%; Lightning buildup and the tier-cross
    // Disorient reward are untouched.
    actionCost: "bonus",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    // 'projectile' added — see frost_swell's comment above.
    tags: ["magic", "spell", "lightning", "elemental", "projectile"],
    cooldown: 2,
    buildupHint: { lightning: 85 },
    rewardIfTierCross: [
      { family: "lightning", tier: 1, debuff: { addBuildup: { disorient: 75 } } },
      { family: "lightning", tier: 2, debuff: { addBuildup: { disorient: 150 } } },
    ],
    apply: (attacker, target) => {
      const ability = SKILLS?.thunder_mark;
      const roll = calculateDamage(attacker, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 65, skillLabel: `${ability?.name || 'Skill'} weapon damage (65%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
          skillConversion: { physToElemPct: 100 },
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return {
        ...roll,
        physical, elemental, necrotic, amount,
        isMagic: true, element: 'lightning',
        buildup: { lightning: ability?.buildupHint?.lightning ?? 85 },
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
      };
    },
    description: "Deals 65% weapon damage as Lightning. Applies Lightning buildup. Crossing a tier leaves them reeling from the shock (bonus Disorient)."
  },

  // Same formula/shape as Marked Cut — see Vital Mark's (dagger) comment for
  // the full rationale. Disease instead of Lightning/Cold/Fire/Toxic/Curse/
  // Expose/Disorient (everything else staff already covers): no plague/
  // sickness spell existed on this weapon type yet. Reflavored as Necrotic
  // via skillConversion, same as Cone of Blight — disease/toxic/curse are
  // all necrotic-family for mitigation purposes, isMagic alone can't carry
  // that (see Cone of Blight's own comment on the bug this avoids). Toxic
  // secondary: once the sickness truly takes hold, it festers into poison.
  'pestilent_word': {
    id: "pestilent_word",
    name: "Pestilent Word",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["staff"],
    requiredStat: "INT",
    requiredValue: 14,
    // Moved Major → Bonus (cross-weapon balance audit, staff variety pass)
    // — damage nerfed 100%→65%; Disease buildup and the tier-cross Toxic
    // reward are untouched.
    actionCost: "bonus",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    // 'projectile' added — see frost_swell's comment above.
    tags: ["magic", "spell", "disease", "necrotic", "projectile"],
    cooldown: 2,
    buildupHint: { disease: 85 },
    rewardIfTierCross: [
      { family: "disease", tier: 1, debuff: { addBuildup: { toxic: 75 } } },
      { family: "disease", tier: 2, debuff: { addBuildup: { toxic: 150 } } },
    ],
    apply: (attacker, target) => {
      const ability = SKILLS?.pestilent_word;
      const roll = calculateDamage(attacker, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 65, skillLabel: `${ability?.name || 'Skill'} weapon damage (65%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
          skillConversion: { physToNecroPct: 100, elemToNecroPct: 100 },
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return {
        ...roll,
        physical, elemental, necrotic, amount,
        isMagic: true,
        buildup: { disease: ability?.buildupHint?.disease ?? 85 },
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
      };
    },
    description: "Deals 65% weapon damage as Necrotic. Applies Disease. Crossing a tier lets the sickness fester into poison (bonus Toxic)."
  },

  // Staff's own projectile skill — same shape as Ghost Step/Dagger Throw
  // (weapon damage + a rewardIfWeak current-tier check), 'projectile'-
  // tagged so it can trigger an ally's armed Volley reaction the same way
  // bow/sling already do. Builds Expose, which no staff skill uses yet
  // (frost_swell/galvanic_touch/thunder_mark/pestilent_word/kindling_rite/
  // cone_of_blight/silence_crescent/curse_cinders cover cold/lightning/
  // disease/fire/toxic/disorient/curse — Expose was the one fully unused
  // family left). Left as plain typed damage (no isMagic/skillConversion),
  // same as Ghost Step — the buildup family doesn't need to match the
  // damage type. rewardIfWeak checks Curse specifically since it's one of
  // staff's own established families (curse_cinders, hex_stitch elsewhere).
  'arcane_needle': {
    id: "arcane_needle",
    name: "Arcane Needle",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["staff"],
    requiredStat: "INT",
    requiredValue: 13,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "projectile", "expose"],
    cooldown: 2,
    // Numbers normalized to match the standard "100% dmg + single buildupHint
    // + rewardIfWeak" template every other weapon's version of this skill
    // uses (ghoststep/dagger_throw: 113 base, +50 reward) — this was the one
    // outlier still on old 85/+40 numbers, found while building axe's own
    // version of this same template (Axe Throw).
    buildupHint: { expose: 113 },
    rewardIfWeak: [
      { family: "curse", tierAtLeast: 1, buff: { addBuildup: { expose: 50 } } },
    ],
    apply: (attacker, target) => {
      const ability = SKILLS?.arcane_needle;
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
      const curseTier = target?.weakness?.tiers?.curse || 0;
      const rule = findRewardIfWeakRule(ability, curseTier);
      let exposeBuildup = ability?.buildupHint?.expose ?? 113;
      if (rule) exposeBuildup += rule.buff?.addBuildup?.expose || 0;
      return { ...roll, physical, elemental, necrotic, amount, buildup: { expose: exposeBuildup } };
    },
    description: "A needle-thin bolt of force — deals 100% weapon damage and applies Expose buildup. If the target is already Cursed, applies even more."
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
    mpCost: 4,
    // No cooldown — requiring an active runic zone (below) plus the MP cost
    // is already enough of a natural downside per the user's call.
    requiresTarget: true,
    targetRequirement: "enemy",
    // 'projectile' added — see frost_swell's comment above.
    tags: ["magic", "spell", "fire", "elemental", "zone", "projectile"],
    buildupHint: { fire: 150 },
    // Declares the "Req zone" its description already promised. Before this the
    // requirement lived only in prose: apply() quietly did nothing while the
    // action AND the MP were still spent. Also what the Usable filter and
    // targeting read, so the skill hides itself until a zone is up.
    canExecute: ({ user }) => (user?.statusEffects || []).some(se => se?.id === 'runic_zone' && (se.turns || 0) > 0)
      ? true
      : { ok: false, reason: `${user?.name || 'You'} has no active runic zone.` },
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

      const basePct = 100;
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

      const fireBuildup = Math.floor((ability?.buildupHint?.fire ?? 150) * powerScale);

      return {
        ...roll,
        physical, elemental, necrotic, amount,
        isMagic: true,
        element: 'fire',
        buildup: { fire: fireBuildup },
        log: `The runic zone ignites with flames! (Kindling Rite ${stacksAfter}/3 stacks)`,
      };
    },
    description: "Feed the circle to the flame — deals 100% weapon damage as Fire. Modifies your zone, stacking up to 3 times: each stack gives you +20% elemental damage and burns you for 60 Fire buildup per turn."
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
    mpCost: 6,
    cooldown: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    // 'projectile' added — see frost_swell's comment above.
    tags: ["magic", "spell", "toxic", "aoe", "necrotic", "projectile"],
    buildupHint: { toxic: 113 },
    // "Small cone": only the front rank (1,2,3) and mid rank (4,5) are valid
    // primary targets — the back rank has nothing further behind it to cone
    // into. See aoeResolver.js's "smallCone" shape for the exact per-slot
    // splash mapping (front rank fans into mid rank; mid rank fans into
    // back rank). Enemy slots share the identical row/slot-ID layout as
    // allies (just X-mirrored), so this needs no per-side translation.
    targetSlots: [1, 2, 3, 4, 5],
    aoe: { shape: 'smallCone', scale: 0.70 },
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

      const toxicBuildup = Math.floor((ability?.buildupHint?.toxic ?? 113) * powerScale);

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
    description: "A creeping wave of rot — deals 90% weapon damage as Necrotic and applies Toxic buildup to a target in the front two ranks, splashing the slots directly behind it."
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
    // Declares the "Req zone" its description already promised. Before this the
    // requirement lived only in prose: apply() quietly did nothing while the
    // action AND the MP were still spent. Also what the Usable filter and
    // targeting read, so the skill hides itself until a zone is up.
    canExecute: ({ user }) => (user?.statusEffects || []).some(se => se?.id === 'runic_zone' && (se.turns || 0) > 0)
      ? true
      : { ok: false, reason: `${user?.name || 'You'} has no active runic zone.` },
    apply: (attacker, target, scene) => {
      const zone = getRunicZone(attacker);
      if (!zone) return { amount: 0, log: "Ward Weave requires an active runic zone." };
      zone.mods = zone.mods || {};
      zone.mods.wardWeave = true;
      // Implemented in CombatScene.js: _startTurnStatusEffects drains 3
      // Initiative/turn (replacing the zone's normal MP restore) while this
      // mod is active, and _applyEndOfTurnProcs heals the whole party for
      // 50% weapon-die healing (real heal pipeline — calculateHealRoll/
      // applyHealModifiers, so it benefits from WIS/gear/Proficiency same as
      // any other heal) at the end of the caster's turn. Was a flat 15%
      // damage-reduction guard instead — redesigned into an actual AoE heal
      // per user request.
      scene?._refreshRunicZoneSprite?.(attacker);
      return { amount: 0, log: "Protective wards weave through the runic circle!" };
    },
    description: "Weave the circle into a ward — it drains 3 Initiative each turn on top of the zone’s own mana upkeep, and heals the whole party at the end of every turn it holds."
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
    // Moved Major → Bonus (cross-weapon balance audit, staff variety pass)
    // — an AoE hitting up to 4 targets deserves a bigger cut than a
    // single-target skill, so base nerfed 85%→55% (not the usual ~65%);
    // Disorient buildup and the tier-cross damage-down debuff are untouched.
    actionCost: "bonus",
    mpCost: 5,
    cooldown: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    // 'projectile' added — see frost_swell's comment above.
    tags: ["magic", "spell", "disorient", "aoe", "projectile"],
    buildupHint: { disorient: 100 },
    // Fixed "back crescent" — always the back rank + mid rank {8,4,5,6},
    // regardless of which of those four is targeted. Same mechanic as
    // Sacred Shockwave's diamond, just a different fixed group — see
    // aoeResolver.js's "backCrescent" shape.
    targetSlots: [8, 4, 5, 6],
    aoe: { shape: 'backCrescent', scale: 0.60 },
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

      const basePct = 120;
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

      const disorientBuildup = Math.floor((ability?.buildupHint?.disorient ?? 100) * powerScale);

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
    description: "A ringing arc across the back line — deals 120% weapon damage to a target in the back crescent, and always catches the other three slots of that crescent at 60% regardless of which you aim at."
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
    actionCost: "bonus",
    mpCost: 5,
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
    // Declares the "Req zone" its description already promised. Before this the
    // requirement lived only in prose: apply() quietly did nothing while the
    // action AND the MP were still spent. Also what the Usable filter and
    // targeting read, so the skill hides itself until a zone is up.
    canExecute: ({ user }) => (user?.statusEffects || []).some(se => se?.id === 'runic_zone' && (se.turns || 0) > 0)
      ? true
      : { ok: false, reason: `${user?.name || 'You'} has no active runic zone.` },
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
    description: "Req zone. Modifies zone: spells have a 25% chance to fully recast at 60% power (tier-cross rewards still grant full value). Every cast or recast, you take 40 Lightning buildup and 1 Lightning damage — which can itself set off your own Lightning Jolt if you are charged enough."
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
      // 10% of MAX MP rather than a flat 3 — a flat number stopped meaning
      // anything once a caster's pool grew past the early game.
      const mpGain = Math.max(1, Math.floor((attacker?.maxMP ?? attacker?.derivedStats?.maxMP ?? 0) * 0.10));
      return {
        amount: 0,
        mpGain,
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
          vfx: { kind: 'buff_increase' },
        }],
        log: `${attacker?.name ?? 'Mage'} focuses, restoring ${mpGain} MP!`,
      };
    },
    description: "Gather yourself — restores 10% of your maximum MP and grants +50 Accuracy, held until your next damaging hit rather than expiring after a turn."
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
    mpCost: 9,
    cooldown: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    // 'projectile' added — see frost_swell's comment above.
    tags: ["magic", "spell", "fire", "aoe", "elemental", "projectile"],
    requiresWeakness: { family: "fire", tierAtLeast: 2 },
    buildupHint: { fire: 75 },
    // Diamond AOE — fixed centre-mass slots {2,4,5,7}, same shape (and same
    // targetSlots restriction) Sacred Shockwave uses. The primary target
    // must be one of the four diamond slots — otherwise the "diamond" would
    // just be a bonus AOE tacked onto an unrelated primary target instead of
    // the primary target always being part of the same four-enemy formation
    // it hits.
    targetSlots: [2, 4, 5, 7],
    aoe: { shape: 'diamond', scale: 0.80 },
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

      const fireBuildup = Math.floor((ability?.buildupHint?.fire ?? 75) * powerScale);

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
    description: "Requires the target to already be Ablaze (Fire T2). Deals 140% weapon damage as Fire + 75 Fire buildup, plus a diamond AOE (fixed slots 2,4,5,7) at 80% damage/buildup to whoever else stands in that formation."
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
    mpCost: 6,
    cooldown: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    // 'projectile' added — see frost_swell's comment above.
    tags: ["magic", "spell", "toxic", "consume", "aoe", "necrotic", "projectile"],
    requiresWeakness: { family: "toxic", tierAtLeast: 1 },
    apply: (attacker, target, scene, opts = {}) => {
      const ability = SKILLS?.toxic_bloom;
      const powerScale = Number.isFinite(opts?.powerScale) ? opts.powerScale : 1;
      const roll = calculateDamage(attacker, target, ability);

      const basePct = 140;
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
        target: tgt, amount: 0, buildup: { toxic: Math.floor(consumed * 0.625) }, tags: ability?.tags,
      }));

      // Debuff, tiered by how much toxic was actually drained (per 100):
      // 2/3/4/5 HP healed to whoever hits this target, per hit, for 3 turns
      // — plus 12/18/24/30 Toxic buildup (also tiered) to the target AND
      // adjacent enemies on each of those hits. Uses the generic onHitBy
      // shape (see _processTargetHitRiders in CombatScene.js), so this now
      // correctly triggers on ANY hit the target takes — primary, AOE
      // splash, or a repeat — not just direct hits, and NOT on this cast's
      // own hit (the preHitRiderRefs snapshot excludes a status a skill
      // just applied on the same cast that created it). Registered in
      // StatusEffects.js as 'toxic_bloom_debuff' / display name "Toxic
      // Bloom" — no "rider" in anything user-facing.
      const tier = Math.min(4, Math.floor(consumed / 100));
      const tierHeal = tier + 1; // tier 1→2, 2→3, 3→4, 4→5
      const tierBuildup = 6 * (tier + 1); // tier 1→12, 2→18, 3→24, 4→30
      const statusEffects = tier > 0
        ? [{
          id: 'toxic_bloom_debuff', turns: 3,
          onHitBy: { healAttacker: tierHeal, buildup: { toxic: tierBuildup }, buildupAdjacent: { toxic: tierBuildup } },
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
    description: "Deals 140% weapon damage as Necrotic. Consumes up to 400 Toxic buildup from the target, proliferating 62.5% of it to adjacent enemies. Based on toxic consumed (per 100, up to 4): applies a 3-turn debuff — whoever hits this target heals 2/3/4/5 HP per hit and deals 12/18/24/30 Toxic buildup to the target and adjacent enemies per hit."
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
    vfxHint: { kind: 'mana' },
    // Declares the "Req zone" its description already promised. Before this the
    // requirement lived only in prose: apply() quietly did nothing while the
    // action AND the MP were still spent. Also what the Usable filter and
    // targeting read, so the skill hides itself until a zone is up.
    canExecute: ({ user }) => (user?.statusEffects || []).some(se => se?.id === 'runic_zone' && (se.turns || 0) > 0)
      ? true
      : { ok: false, reason: `${user?.name || 'You'} has no active runic zone.` },
    apply: (attacker) => {
      const zone = getRunicZone(attacker);
      if (!zone) return { amount: 0, log: "Mana Fountain requires an active runic zone." };
      zone.turns += 1;
      const maxMP = attacker?.maxMP ?? attacker?.derivedStats?.maxMP ?? 0;
      const mpGain = Math.max(1, Math.floor(maxMP * 0.35));
      return {
        amount: 0,
        mpGain,
        log: `${attacker?.name ?? 'Mage'} taps the zone — restores ${mpGain} MP and extends it by 1 turn!`,
      };
    },
    description: "Draw deeply on the circle — extends the zone by 1 turn and restores 35% of your maximum MP."
  },

  'silencing_shockwave': {
    id: "silencing_shockwave",
    name: "Skulltap",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["staff"],
    requiredStat: "WIS",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 6,
    cooldown: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    // 'projectile' added — see frost_swell's comment above.
    tags: ["magic", "spell", "disorient", "consume", "projectile"],
    requiresWeakness: { family: "disorient", tierAtLeast: 2 },
    apply: (attacker, target, scene, opts = {}) => {
      const ability = SKILLS?.silencing_shockwave;
      const powerScale = Number.isFinite(opts?.powerScale) ? opts.powerScale : 1;
      const roll = calculateDamage(attacker, target, ability);

      // Consumes up to 400 current Disorient for bonus damage (excess
      // beyond 400 stays on the target, not wasted — same "don't consume
      // past what's actually used" rule as Toxic Bloom's clean-increment
      // fix): +2.5% per 10 consumed, capped at +100% (400/10×2.5), folded
      // directly into skillPct (Category A, additive with the base 165% —
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
      const bonusPct = (consumed / 10) * 2.5;
      const basePct = 165;
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
        log: consumed > 0 ? `Skulltap consumes ${consumed} disorient for bonus damage!` : undefined,
      };
    },
    description: "Drive the ringing in their skull inward. Requires a Concussed target (Disorient T2). Deals 165% weapon damage, converted to Necrotic if the target is below 20% max MP. Consumes up to 400 of their Disorient for +2.5% damage per 10 consumed (up to +100%); anything past 400 is left on them."
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
    mpCost: 5,
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
      // +1 Resilience per 8 curse removed (up to +50 at the 400 cap) — a
      // flat reduction to ALL incoming weakness buildup, same real stat WIS
      // derives permanently (see CharacterBuilder.js), just granted
      // temporarily here via mods.Resilience (now summed by
      // _sumStatusEffectMods alongside the character's own permanent
      // value — see CombatLogic.js). Replaces the old BuildupReceived %
      // mod entirely, per explicit request.
      const resilienceGain = Math.floor(curseRemoved / 8);
      if (target?.weakness?.meters != null) {
        target.weakness.meters.curse = Math.max(0, currentCurse - curseRemoved);
        target.weakness.tiers.curse = weaknessTierFromMeter(target.weakness.meters.curse);
      }
      const statusEffects = resilienceGain > 0
        ? [{ id: 'curse_suppression_ward', turns: 3, mods: { Resilience: resilienceGain }, vfx: { kind: 'buff_harden' } }]
        : undefined;
      return {
        amount: 0,
        isHeal: false,
        statusEffects,
        log: `${curseRemoved} curse suppressed — ${target?.name ?? 'ally'} gains +${resilienceGain} Resilience!`,
      };
    },
    description: "Requires the target (self or ally) to have Curse T1+. Removes up to 400 Curse buildup, granting +1 Resilience per 8 removed (up to +50) for 3 turns."
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
    mpCost: 9,
    cooldown: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    // 'projectile' added — see frost_swell's comment above.
    tags: ["magic", "spell", "aoe", "projectile"],
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
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "ally",
    // "spell" tag added — this is the actual reason it couldn't recast from
    // Rune Channel before; the recast check gates on tags.includes('spell').
    tags: ["magic", "spell", "holy", "heal", "regen"],
    cooldown: 3,
    vfxHint: { kind: 'heal' },
    apply: (attacker, target, scene, opts = {}) => {
      const ability = SKILLS?.restoration_light;
      const powerScale = Number.isFinite(opts?.powerScale) ? opts.powerScale : 1;
      // First skill on the new heal pipeline — calculateHealRoll (weapon die
      // + WIS bonus, see calculateHealRoll's own comment) + applyHealModifiers
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
      //
      // Was a flat "3, x powerScale" number completely disconnected from the
      // caster's own roll — investing in a bigger staff or more WIS did
      // nothing for it. Now 35% of that same base roll (roll.amount — the
      // weapon die + WIS bonus, pre-skillPct/pre-crit), so it scales with
      // the same formula as the instant heal instead of being a hardcoded
      // constant. Deliberately NOT run back through applyHealModifiers a
      // second time (would double-push gear%/HealingPower breakdown lines
      // onto the same tooltip) and deliberately excludes crit, matching the
      // existing "regen isn't crit-affected" design above.
      const regenTick = Math.max(1, Math.floor(roll.amount * 0.35 * powerScale));

      return {
        amount: healAmount,
        isHeal: true,
        isCrit: roll.isCrit,
        statusEffects: [{ id: "regen", turns: 2, tickHeal: regenTick, vfx: { kind: 'heal' } }],
      };
    },
    description: "Heals 150% of your weapon roll. Also grants Regen for 2 turns, healing 35% of that same base roll each turn."
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
    // 'projectile' added — see frost_swell's comment above.
    tags: ["magic", "spell", "curse", "fire", "projectile"],
    cooldown: 2,
    requiresWeakness: { family: "curse", tierAtLeast: 1 },
    buildupHint: { curse: 63 },
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
        buildup: { curse: ability?.buildupHint?.curse ?? 63 },
        statusEffects,
      };
    },
    description: "Deals 100% weapon damage as Fire, +63 Curse buildup. Requires target at least Hexed. Applies a permanent rider: while cursed, acting gains Fire buildup instead of losing it, scaling with Curse intensity — works regardless of the target's own Fire tier."
  },

  // --- Staff Reaction ---
  // First skill on the new "T2 weakness cross" reaction trigger
  // (ReactionSystem._onWeaknessTierCross, fed by CombatScene's
  // _onWeaknessTierChanged — see that function's comment for why it's a
  // cause-agnostic hook). Fires off ANY enemy crossing into Cold T2
  // (Frostbitten) from ANY source — a hit from this caster, an ally's
  // attack, a DOT tick, decay recompute — not just a hit this caster
  // personally lands, unlike every other reaction in the game. The theft
  // math mirrors frost_swell's existing rewardIfTierCross.stealInitiative
  // (same "steal only what's actually available" rule, bumped to 20 —
  // meaningfully bigger since this is a standalone reaction rather than a
  // rider on an attack that's already dealing its own damage).
  'frostbitten_reflex': {
    id: "frostbitten_reflex",
    name: "Frostbitten Reflex",
    type: "weapon",
    mechanic: "reaction",
    versionTag: "v3.23",
    requiredWeapon: ["staff"],
    requiredStat: "INT",
    requiredValue: 12,
    actionCost: "reaction",
    mpCost: 4,
    cooldown: 3,
    requiresTarget: false,
    reaction: {
      trigger: "weakness_tier_cross",
      weaknessFamily: "cold",
      cooldownOn: "trigger",
      exec: ({ owner, target, scene }) => {
        if (!owner || !target) return;
        const avail = target.initiativeGauge || 0;
        const stolen = Math.min(20, avail);
        if (stolen > 0) {
          target.initiativeGauge = Math.max(0, avail - stolen);
          const cap = owner.initiativeGaugeMax ?? 100;
          owner.initiativeGauge = Math.min(cap, (owner.initiativeGauge || 0) + stolen);
          scene?._log?.(`${owner.name} seizes the opening as ${target.name} turns Frostbitten — steals ${stolen} Initiative.`);
          scene?._playStatusVFX?.(owner, { kind: 'buff_power' });
        }
      },
    },
    description: "Reaction: whenever an enemy becomes Frostbitten (Cold T2), from any source, steal up to 20 Initiative from them."
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
    buildupHint: { expose: 63 },
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
      let buildup = ability?.buildupHint?.expose ?? 63;
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
    buildupHint: { curse: 88 },
    rewardIfWeak: { family: "expose", tierAtLeast: 1, buff: { addBuildup: { curse: 32 } } },
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
      let buildup = ability?.buildupHint?.curse ?? 88;
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
    buildupHint: { toxic: 75 },
    rewardIfWeak: { family: "expose", tierAtLeast: 1, buff: { addBuildup: { toxic: 25 } } },
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
      let buildup = ability?.buildupHint?.toxic ?? 75;
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
    buildupHint: { expose: 50 },
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

      const baseBuildup = ability?.buildupHint?.expose ?? 50;
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
    mpCost: 5,
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
    mpCost: 6,
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
    mpCost: 5,
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
    mpCost: 5,
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
    mpCost: 5,
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
    mpCost: 6,
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
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "expose"],
    cooldown: 2,
    buildupHint: { expose: 88 },
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
      const exposeBuildup = ability?.buildupHint?.expose ?? 88;
      return {
        ...roll,
        physical, elemental, necrotic, amount,
        buildup: { expose: exposeBuildup },
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
      };
    },
    description: "Deals 100% weapon damage."
  },

  // Same formula/shape as Marked Cut (sword_1h): weapon damage + a primary
  // family's buildup, and a BONUS buildup in a SECOND family on actually
  // crossing a tier of the first — via the generic rewardIfTierCross engine
  // (real post-buildup tier snapshot, not a self-predicted guess; see Marked
  // Cut's own comment for why that matters). Toxic instead of Lacerate here:
  // a dagger finds the weak point and lets poison seep into it, rather than
  // tearing it open further.
  'vital_mark': {
    id: "vital_mark",
    name: "Vital Mark",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["dagger"],
    requiredStat: "DEX",
    requiredValue: 11,
    // Moved Major → Bonus (cross-weapon balance audit, dagger variety pass)
    // — damage nerfed 100%→65%; Expose buildup and the tier-cross Toxic
    // reward are untouched.
    actionCost: "bonus",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "expose"],
    cooldown: 2,
    buildupHint: { expose: 85 },
    rewardIfTierCross: [
      { family: "expose", tier: 1, debuff: { addBuildup: { toxic: 75 } } },
      { family: "expose", tier: 2, debuff: { addBuildup: { toxic: 150 } } },
    ],
    apply: (attacker, target) => {
      const ability = SKILLS?.vital_mark;
      const roll = calculateDamage(attacker, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 65, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return {
        ...roll,
        physical, elemental, necrotic, amount,
        buildup: { expose: ability?.buildupHint?.expose ?? 85 },
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
      };
    },
    description: "Deals 65% weapon damage. Applies Expose. Crossing a tier lets poison seep into the wound (bonus Toxic)."
  },

  // Same formula/shape as Marked Cut — see Vital Mark's comment above for the
  // full rationale. Fire instead of Expose: dagger had no Fire skill at all
  // until now. Bonus action, matching Needle Feint's role as a quick setup
  // move — a fire opener meant to go out early and set up whatever's next,
  // not a big committed major-action strike. Disorient secondary (not
  // Expose, to stay distinct from Vital Mark right above): once they're
  // truly burning, the pain leaves them reeling.
  'ember_strike': {
    id: "ember_strike",
    name: "Ember Strike",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["dagger"],
    requiredStat: "DEX",
    requiredValue: 10,
    actionCost: "bonus",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "fire"],
    cooldown: 2,
    buildupHint: { fire: 85 },
    rewardIfTierCross: [
      { family: "fire", tier: 1, debuff: { addBuildup: { disorient: 75 } } },
      { family: "fire", tier: 2, debuff: { addBuildup: { disorient: 150 } } },
    ],
    apply: (attacker, target) => {
      const ability = SKILLS?.ember_strike;
      const roll = calculateDamage(attacker, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 100, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return {
        ...roll,
        physical, elemental, necrotic, amount,
        buildup: { fire: ability?.buildupHint?.fire ?? 85 },
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
      };
    },
    description: "Deals 100% weapon damage. Applies Fire. Crossing a tier leaves them reeling from the burn (bonus Disorient)."
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
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "toxic", "necrotic"],
    cooldown: 2,
    buildupHint: { toxic: 113 },
    // Tiered: Exposed (T1) only adds bonus Toxic buildup, no damage. Flayed (T2)
    // is the only tier that adds damage. apply() reads these values directly so
    // the tooltip and the real effect can never drift out of sync.
    rewardIfWeak: [
      { family: "expose", tierAtLeast: 1, buff: { addBuildup: { toxic: 38 } } },
      { family: "expose", tierAtLeast: 2, buff: { damagePct: 20, addBuildup: { toxic: 38 } } },
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

      let toxicBuildup = ability?.buildupHint?.toxic ?? 113;
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
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "expose", "fire"],
    cooldown: 3,
    buildupHint: { expose: 125 },
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
        onNextDamageTaken: { bonusDamagePercent: 30, buildup: { fire: 100 } },
        vfx: { kind: 'debuff_burn' },
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
      const exposeBuildup = ability?.buildupHint?.expose ?? 125;
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
    // Moved Major → Bonus (cross-weapon balance audit, dagger variety pass)
    // — dagger has two "template" skills (this one + Dagger Throw); keeping
    // Dagger Throw Major and moving this one, same treatment sword's Ember
    // Arc got (template skill stays Major) vs. Broken Cadence (moved).
    // Damage nerfed 100%→65%; Curse buildup and the Disorient-tier bonus
    // are untouched.
    actionCost: "bonus",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "curse"],
    cooldown: 2,
    buildupHint: { curse: 113 },
    // Current-tier check, not a tier-cross — fires whenever the target is
    // already Dazed or worse, no crossing required.
    rewardIfWeak: [
      { family: "disorient", tierAtLeast: 1, buff: { addBuildup: { curse: 50 } } },
    ],
    apply: (attacker, target) => {
      const ability = SKILLS?.ghoststep;
      const roll = calculateDamage(attacker, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 65, skillLabel: `${ability?.name || 'Skill'} weapon damage (65%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      const disorientTier = target?.weakness?.tiers?.disorient || 0;
      const rule = findRewardIfWeakRule(ability, disorientTier);
      let curseBuildup = ability?.buildupHint?.curse ?? 113;
      if (rule) curseBuildup += rule.buff?.addBuildup?.curse || 0;
      return { ...roll, physical, elemental, necrotic, amount, buildup: { curse: curseBuildup } };
    },
    description: "Deals 65% weapon damage and applies Curse buildup. If the target is at least Dazed (Disorient T1+), applies even more."
  },

  // Dagger's own projectile skill — same shape as Ghost Step right above
  // (weapon damage + a rewardIfWeak current-tier check, not a tier-cross),
  // but 'projectile'-tagged so it can trigger an ally's armed Volley
  // reaction (CombatScene.js's ally_projectile_used bus event already
  // fires for ANY 'projectile'-tagged skill regardless of weapon — bow and
  // sling already carry it, this is dagger's first). Builds Lacerate,
  // which no other dagger skill uses yet (vital_mark/pressure_point/
  // ghoststep/etc. cover expose/curse/toxic/lightning/disorient/fire —
  // Lacerate was the one fully unused family left, and fits a thrown-blade
  // bleeding wound thematically). rewardIfWeak checks Expose specifically
  // because it's dagger's own most-built family (vital_mark, pressure_point,
  // silent_order) — throwing after either of those already landed pays off.
  'dagger_throw': {
    id: "dagger_throw",
    name: "Dagger Throw",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["dagger"],
    requiredStat: "DEX",
    requiredValue: 11,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "lacerate"],
    cooldown: 2,
    buildupHint: { lacerate: 113 },
    rewardIfWeak: [
      { family: "expose", tierAtLeast: 1, buff: { addBuildup: { lacerate: 50 } } },
    ],
    apply: (attacker, target) => {
      const ability = SKILLS?.dagger_throw;
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
      const exposeTier = target?.weakness?.tiers?.expose || 0;
      const rule = findRewardIfWeakRule(ability, exposeTier);
      let lacerateBuildup = ability?.buildupHint?.lacerate ?? 113;
      if (rule) lacerateBuildup += rule.buff?.addBuildup?.lacerate || 0;
      return { ...roll, physical, elemental, necrotic, amount, buildup: { lacerate: lacerateBuildup } };
    },
    description: "Hurls your dagger at the target — deals 100% weapon damage and applies Lacerate buildup. If the target is already Exposed, applies even more."
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
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "curse", "necrotic", "aoe"],
    // Was passed inline to resolveAOESplash, so the shape never reached the
    // tooltip. The splash carries curse buildup only (amount: 0), no damage.
    aoe: { shape: "column", scale: 0.50, damage: false },
    cooldown: 3,
    buildupHint: { curse: 75 },
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
      const primaryCurse = ability?.buildupHint?.curse ?? 75;
      const splashCurse = Math.floor(primaryCurse * 0.50);
      const toxicMeter = target?.weakness?.meters?.toxic || target?.currentStats?.toxic || 0;
      const repeatChance = Math.min(0.50, toxicMeter / 1000);
      const splash = resolveAOESplash(scene, target, ability.aoe).map(tgt => ({
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
    // Moved Major → Bonus (cross-weapon balance audit, dagger variety pass)
    // — damage nerfed 100%→65%; the Lightning buildup and free-repeat
    // chance (scaling with the target's Lightning meter, up to 40%) are
    // untouched, since those are the actual utility hook.
    actionCost: "bonus",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lightning"],
    cooldown: 2,
    buildupHint: { lightning: 75 },
    // Declarative so the tooltip can show it and apply() reads the same
    // numbers instead of duplicating them inline.
    rewardIfWeak: [
      { family: "fire", tierAtLeast: 2, buff: { damagePct: 25 } },
    ],
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.static_prick;
      const roll = calculateDamage(attacker, target, ability);

      // 65% base + 25% if target is at least Ablaze (Fire T2) — Category A,
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
          skillPct: 65 + bonusPct,
          skillLabel: `${ability?.name || 'Skill'} weapon damage (65%${bonusPct ? ` + ${bonusPct}% Fire tier` : ''})`,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      const lightningMeter = target?.weakness?.meters?.lightning || target?.currentStats?.lightning || 0;
      const repeatChance = Math.min(0.40, lightningMeter / 1000);
      return {
        ...roll,
        physical, elemental, necrotic, amount,
        buildup: { lightning: ability?.buildupHint?.lightning ?? 75 },
        repeatChance,
      };
    },
    description: "Deals 65% weapon damage. Chance to repeat the hit for free, scaling with the target's Lightning meter (max 40%)."
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
      // mpGain scales 1 MP per 80 total enemy Disease, floored at 2 and capped
      // at 8 (so it takes 640+ combined enemy Disease to hit the ceiling).
      const mpGain = Math.max(2, Math.min(8, Math.floor(totalDisease / 80)));
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
        // Direct MP mutation, not routed through result.mpGain, so called directly.
        if (actualGain > 0) scene?._playStatusVFX?.(attacker, { kind: 'mana' });
      }

      return { amount: 0 };
    },
    description: "Reads total Disease across all living enemies: 80 Disease = 1 MP restored (minimum 2, maximum 8). Purges your own Disease at 50 per MP gained (minimum 100, maximum 400)."
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
      const mpTable = [3, 5, 8, 10, 13];
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
          scene?._playStatusVFX?.(char, { kind: 'mana' });
        } else {
          scene?._log?.(`${char.name} is already at full MP.`);
        }
      });

      return { amount: 0 };
    },
    description: "Requires at least 50 Toxic on the target. Consumes up to 250 Toxic buildup, in 50-point steps based on their current meter. Restores 3/5/8/10/13 MP to your entire party, scaling with how much was consumed."
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
    mpCost: 4,
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
    critBleedPct: 50,
    critBleedTurns: 2,
    // Also lands WITHOUT a crit once the target is Flayed (Expose T2) — the
    // skill already requires Raw (T1) to fire at all, so pushing Expose one
    // tier further converts this from a crit-lottery rider into a guaranteed
    // one. Handled generically in CombatScene alongside critBleedPct.
    bleedAlsoAtTier: { family: "expose", tierAtLeast: 2 },
    critBleedStatusId: "heartpierced",
    critBleedVfxKind: 'debuff_sick',
    apply: (attacker, target) => {
      const ability = SKILLS?.heartpiercer;
      const roll = calculateDamage(attacker, target, ability);

      // 160% base (100% + 60%) + 30% more if target is at least Hemorrhaging
      // (Lacerate T2) — Category A, combined additively into ONE skillPct
      // (was two sequential multiplies: 1.6x then 1.3x = 208% instead of the
      // intended 190% at the Lacerate T2 cap).
      //
      // Briefly raised to 200 in the dagger pass and put back. That buff was
      // justified against a measurement that counted only the immediate hit,
      // which is the wrong basis for THIS skill twice over: Heartpierced adds
      // a full 100% of the hit back over its two ticks, and the Power Stab it
      // was compared to had been measured at the FLOOR of its Expose consume
      // (100 banked, its minimum) rather than anywhere near its 400 ceiling.
      // Measured properly, 200% + the now-guaranteed bleed put Heartpiercer at
      // 68 total at Expose T2 versus ~33 for a best-case alternative dagger
      // turn. The bleed already carries this skill; the base does not need to.
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
    description: "Heavy two-action strike, req target at least Raw (160% + Lacerate T2: +30% damage). Inflicts Heartpierced on a crit, or automatically if the target is Flayed — a 2-turn bleed dealing 50% of the hit as damage per turn."
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
    mpCost: 4,
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
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "expose"],
    cooldown: 3,
    buildupHint: { expose: 63 },
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
        buildup: { expose: ability?.buildupHint?.expose ?? 63 },
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
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "curse", "necrotic"],
    cooldown: 4,
    requiresWeakness: { family: "curse", tierAtLeast: 1 },
    buildupHint: { curse: 60 },
    apply: (attacker, target, scene) => {
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
      const alreadyCursed = (target.statusEffects || []).some(se => se?.id === 'curse_of_needles');
      if (!alreadyCursed) {
        // Tier 1 rider ("+X weapon damage") — weaponDamageFlat is read inside
        // calculateDamage() (applyCurseWeaponRiders) and baked directly into
        // the base weapon roll, before skill%/buffs/gear/crit, for ANY hit
        // this target takes while cursed. curseScaled: true amplifies it
        // while the target is Afflicted (Curse T2), same as before. Routed
        // through _addStatusEffects (not a raw .push()) so the vfx hint
        // below actually fires, and so a recast coalesces correctly.
        scene?._addStatusEffects?.(target, [{
          id: "curse_of_needles", name: "Curse of Needles", permanent: true,
          onHit: { weaponDamageFlat: 2, curseScaled: true },
          vfx: { kind: 'debuff_weak' },
        }]);
      }
      return { ...roll, physical, elemental, necrotic, amount, buildup: { curse: 60 } };
    },
    description: "Deals 110% weapon damage and applies 60 Curse buildup. Requires target at least Hexed. Applies a permanent rider: hits against the target deal +2 weapon damage while at least Hexed, amplified while Afflicted."
  },

  // Dagger's healing skill — generator, not a payoff (dagger has no other
  // Disease source, unlike Toxic which Needle Venom already covers). Uses
  // the same rewardIfTierCross engine Crushing Mark/Staggering Point/etc.
  // already use, gated on the REAL post-buildup tier the target actually
  // crosses (not a self-predicted guess) — see _applyRewardDebuff's onHitBy
  // forwarding, added for this skill specifically.
  'festering_contagion': {
    id: "festering_contagion",
    name: "Festering Contagion",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["dagger"],
    requiredStat: "CHA",
    requiredValue: 13,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "disease", "necrotic", "aoe"],
    cooldown: 4,
    buildupHint: { disease: 90 },
    rewardIfTierCross: [
      {
        family: "disease", tier: 1,
        debuff: { statusId: "festering_contagion_t1", turns: 3, onHitBy: { healAttacker: 1 }, vfx: { kind: 'buff_health' } },
      },
      {
        family: "disease", tier: 2,
        debuff: { statusId: "festering_contagion_t2", turns: 3, onHitBy: { healAttacker: 3, buildup: { disease: 10 } }, vfx: { kind: 'buff_health' } },
      },
    ],
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.festering_contagion;
      const roll = calculateDamage(attacker, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 100, skillLabel: `${ability?.name || 'Skill'} weapon damage (100%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
          skillConversion: { physToNecroPct: 100, elemToNecroPct: 100 },
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      // Contagion spreads — half the same Disease buildup also lands on
      // whoever's adjacent, matching the "spreads to others" naming.
      const buildupVal = ability?.buildupHint?.disease ?? 90;
      const adjacentSplash = resolveAOESplash(scene, target, { shape: 'adjacent' }).map(tgt => ({
        target: tgt, amount: 0, buildup: { disease: Math.floor(buildupVal * 0.5) }, tags: ability?.tags,
      }));

      return {
        ...roll, physical, elemental, necrotic, amount,
        isMagic: true,
        buildup: { disease: buildupVal },
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
        splash: adjacentSplash.length ? adjacentSplash : undefined,
      };
    },
    description: "Deals 100% weapon damage as Necrotic and applies 90 Disease buildup, spreading half of that to adjacent enemies. Crossing Disease T1 (Sickened) marks the target — whoever hits them heals 1 HP for 3 turns. Crossing T2 (Plagued) instead grows this to 3 HP and re-feeds 10 Disease to the target on every one of those hits."
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
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lightning", "aoe"],
    // Targets every other living enemy inline (not via resolveAOESplash);
    // declared so the tooltip can draw it. Disorient buildup only.
    aoe: { shape: "all", scale: 1.0, damage: false },
    cooldown: 4,
    requiresWeakness: { family: "lightning", tierAtLeast: 1 },
    buildupHint: { disorient: 50 },
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
      const disorientAmt = ability?.buildupHint?.disorient ?? 50;
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

  // New curse-rider skill (dagger's second, alongside Curse of Needles) —
  // same intensity-scaling shape used across the whole "seven curses"
  // batch: base magnitude at Curse T1, scaling continuously past T2 via
  // weaknessIntensityMult on the target's own Curse meter, computed once at
  // cast time (same technique Rime Chop/Bell Ringer already use for their
  // own tier/overflow scaling) rather than a live-reading generic flag.
  'curse_of_normality': {
    id: "curse_of_normality",
    name: "Curse of Normality",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["dagger"],
    requiredStat: "CHA",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "curse", "necrotic"],
    cooldown: 4,
    requiresWeakness: { family: "curse", tierAtLeast: 1 },
    buildupHint: { curse: 60 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.curse_of_normality;
      const roll = calculateDamage(attacker, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 100, skillLabel: `${ability?.name || 'Skill'} weapon damage (100%)`, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      const curseTier = target?.weakness?.tiers?.curse || 0;
      const curseMeter = target?.weakness?.meters?.curse || 0;
      const basePct = 20;
      const scaledPct = curseTier >= 2 ? Math.round(basePct * weaknessIntensityMult(curseMeter)) : basePct;
      const alreadyCursed = (target.statusEffects || []).some(se => se?.id === 'curse_of_normality');
      if (!alreadyCursed) {
        scene?._addStatusEffects?.(target, [{
          id: "curse_of_normality", name: "Curse of Normality", permanent: true,
          mods: { AttackPower: -scaledPct },
          vfx: { kind: 'debuff_decrease' },
        }]);
      }
      return { ...roll, physical, elemental, necrotic, amount, buildup: { curse: 60 } };
    },
    description: "Deals 100% weapon damage and applies 60 Curse buildup. Requires target at least Hexed. Applies a permanent rider: -20% AttackPower, scaling up to -50% at max Curse intensity."
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
    mpCost: 4,
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

  // --- Dagger Reaction ---
  // Second consumer of the new "T2 weakness cross" reaction trigger (see
  // frostbitten_reflex, staff section, for the shared engine plumbing this
  // rides on). Reacts to an enemy crossing Lacerate T2 (Hemorrhaging) from
  // ANY source and punishes it with a free, reduced-power swing — a real
  // counterattack, distinct from Staff's resource-theft flavor. The swing
  // is a hidden sub-skill (carrion_strike_swing) rather than basic_attack
  // itself, since basic_attack's apply() hardcodes skillPct:100 with no
  // override hook — same "hidden sub-skill, suffixed id, identical name"
  // pattern hail_of_arrows_shot/farsight_volley_shot already use.
  'carrion_strike_swing': {
    id: "carrion_strike_swing",
    name: "Carrion Strike",
    type: "weapon",
    hidden: true,
    typedDamage: true,
    tags: ["melee", "attack"],
    apply: (attacker, target) => {
      const ability = SKILLS?.carrion_strike_swing;
      const roll = calculateDamage(attacker, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 60, skillLabel: 'Carrion Strike weapon damage (60%)',
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return { ...roll, physical, elemental, necrotic, amount };
    },
    description: "A reduced-power free strike, granted by Carrion Strike's reaction."
  },

  'carrion_strike': {
    id: "carrion_strike",
    name: "Carrion Strike",
    type: "weapon",
    mechanic: "reaction",
    versionTag: "v3.23",
    requiredWeapon: ["dagger"],
    requiredStat: "DEX",
    requiredValue: 14,
    actionCost: "reaction",
    mpCost: 2,
    cooldown: 3,
    requiresTarget: false,
    reaction: {
      trigger: "weakness_tier_cross",
      weaknessFamily: "lacerate",
      cooldownOn: "trigger",
      exec: ({ owner, target, scene }) => {
        const swing = SKILLS?.carrion_strike_swing;
        if (!owner || !target || !swing) return;
        scene?._log?.(`${owner.name} smells blood — ${target.name} is Hemorrhaging, and pays for it!`);
        // Same generic <family>BuildupMul mechanism as Curse of Pendulums/
        // Bell Ringer/Shattering Cut — an open wound just takes more of
        // everything for a couple turns, not just more damage.
        scene?._addStatusEffects?.(target, [{
          id: "carrion_marked", turns: 2,
          lacerateBuildupMul: 1.25, toxicBuildupMul: 1.25, diseaseBuildupMul: 1.25,
          vfx: { kind: 'debuff_sick' },
        }]);
        scene.time?.delayedCall?.(50, () => {
          scene._applyAbilityToTarget(owner, target, swing, { isReaction: true, tags: swing.tags || [] });
        });
      },
    },
    description: "Reaction: whenever an enemy becomes Hemorrhaging (Lacerate T2), from any source, strike them for free at 60% weapon damage and mark them for 2 turns to take +25% Lacerate/Toxic/Disease buildup."
  },

  // Dagger's Initiative Gauge SPENDER — deliberately mirrors Blazing Fervor
  // (sword_1h) shape-for-shape: same 10/20/30 spend-highest-affordable-tier,
  // same 2/4/6-per-tier scaling, same 2-turn party-wide onHit rider, same
  // bonus-action/cooldown-2 cost. Fire→Necrotic, buildup→Disease. The
  // necroticDamage half of the onHit rider needed a new engine consumer
  // (added alongside fireDamage/fireBuildup in _applyAbilityToTarget); the
  // buildup half reuses the already-generic onHit.buildup rider as-is.
  'withering_fervor': {
    id: "withering_fervor",
    name: "Withering Fervor",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    requiredWeapon: ["dagger"],
    requiredStat: "CHA",
    requiredValue: 14,
    actionCost: "bonus",
    mpCost: 4,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["support", "buff", "necrotic"],
    cooldown: 2,
    // Spending initiative is this skill's whole job — below the minimum
    // spend tier, it has nothing to do, so it should fizzle instead of
    // silently firing for free. Checked generically in _applyAbilityToTarget.
    requiresInitiativeGauge: 10,
    apply: (attacker, _target, scene) => {
      // Spend initiative — three tiers (10/20/30), spends the HIGHEST tier
      // the current gauge can fully afford. Same logic as Blazing Fervor.
      const gauge = attacker?.initiativeGauge || 0;
      const spend = gauge >= 30 ? 30 : gauge >= 20 ? 20 : 10;
      attacker.initiativeGauge = Math.max(0, (attacker.initiativeGauge || 0) - spend);

      // +2 necrotic damage and +20 disease buildup per 10 initiative spent.
      const steps = spend / 10;
      const necroticDmgOnHit = 2 * steps;
      const diseaseBuildupOnHit = 20 * steps;

      // Apply buff to all allies including self. Routed through
      // scene._addStatusEffects (not a direct push) so a recast on an ally
      // who already has the buff coalesces into one entry — keeping the
      // stronger of the two onHit values — instead of stacking two live
      // entries that both fire on every hit.
      const buff = { id: "withering_fervor_buff", turns: 2, onHit: { necroticDamage: necroticDmgOnHit, buildup: { disease: diseaseBuildupOnHit } }, vfx: { kind: 'debuff_sick' } };
      const allySlots = attacker?.isEnemy ? scene?.enemySlots : scene?.allySlots;
      (allySlots || []).forEach(s => {
        const ally = s?.char;
        if (!ally || ally.status === 'incapacitated') return;
        scene?._addStatusEffects?.(ally, [{ ...buff }]);
      });
      scene?._log?.(`${attacker?.name || "The rogue"} withers with fervor (spent ${spend} initiative) — allies deal +${necroticDmgOnHit} necrotic damage and +${diseaseBuildupOnHit} disease buildup on hit for 2 turns.`);
      return { amount: 0 };
    },
    description: "Spend initiative (10/20/30, based on current gauge) to rally allies with decay: +2 necrotic damage and +20 disease buildup per 10 initiative spent, on their attacks, for 2 turns."
  },

  // Dagger's Initiative Gauge GENERATOR — per user request, triggers off
  // crossing Disease OR Lacerate (whichever the target already has stacked),
  // not off crit like Silent Order. New `grantInitiative` reward type (pure
  // gain, doesn't touch the target's own gauge — added alongside the
  // existing stealInitiative in the same rewardIfTierCross consumer).
  // Applies both families at once specifically so either one crossing is
  // enough to pay off — a target already worked over by Vein Tap/Festering
  // Contagion/Carrion Strike is exactly when this generates the most.
  'grave_strike': {
    id: "grave_strike",
    name: "Grave Strike",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["dagger"],
    requiredStat: "DEX",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "necrotic", "disease", "lacerate"],
    cooldown: 3,
    buildupHint: { lacerate: 70, disease: 70 },
    rewardIfTierCross: [
      { family: "disease", tier: 1, grantInitiative: 6 },
      { family: "disease", tier: 2, grantInitiative: 12 },
      { family: "lacerate", tier: 1, grantInitiative: 6 },
      { family: "lacerate", tier: 2, grantInitiative: 12 },
    ],
    apply: (attacker, target) => {
      const ability = SKILLS?.grave_strike;
      const roll = calculateDamage(attacker, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 100, skillLabel: 'Grave Strike weapon damage (100%)',
          isCrit: roll.isCrit, critMult: roll.critMult,
          skillConversion: { physToNecroPct: 100, elemToNecroPct: 100 },
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      return {
        ...roll, physical, elemental, necrotic, amount,
        isMagic: true,
        buildup: { lacerate: 70, disease: 70 },
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
      };
    },
    description: "Deals 100% weapon damage as Necrotic. Applies 70 Lacerate and 70 Disease buildup. Crossing either Bleeding/Hemorrhaging or Sickened/Plagued generates Initiative (6 at T1, 12 at T2, per family)."
  },

  // ==== Dagger: the two ungated damage skills ====
  // Both added in the dagger balance pass. The kit measured 22 skills deep but
  // had only ONE damage skill that wasn't tied to the weakness system, and its
  // ceiling (Silent Order, 16.4 dual-wielding) sat 26% under sword_1h's own
  // ungated best. Every dagger skill above that number was weakness-gated, so a
  // damage-focused build had no button to press. These two are deliberately
  // free of requiresWeakness and of any rewardIfWeak/rewardIfTierCross scaling:
  // their damage never depends on setup.

  // Ungated payoff. Two separate strikes rather than one big number, because
  // dagger is the kit that dual-wields — calculateDamage already folds a second
  // weapon in at 75%/75% per swing, so a dual-wielder's two hits here inherit
  // that automatically and a shield user still gets a clean, if smaller, hit.
  // No hand-count branching needed: the advantage falls out of the existing
  // rollWeaponSwing math. 2 x 80% = 160% total.
  'twin_fang': {
    id: "twin_fang",
    name: "Twin Fang",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    // Resolves as two independent casts — see multiHit in CombatScene's
    // Transpose block, which holds the charge across the whole flurry.
    multiHit: true,
    requiredWeapon: ["dagger"],
    requiredStat: "DEX",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lacerate"],
    cooldown: 4,
    buildupHint: { lacerate: 50 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.twin_fang;
      const roll = calculateDamage(attacker, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 80, skillLabel: 'Twin Fang weapon damage (80%)',
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      // Second fang: a genuinely independent cast with its own hit-roll and
      // its own crit roll, same architecture as Hail of Arrows' per-target
      // shots — not shared-hit-roll splash. Two chances to crit is the point.
      const second = SKILLS?.twin_fang_offhand;
      scene?.time?.delayedCall(140, () => {
        if (scene.combatEnded || target?.status === 'incapacitated') return;
        // isSubCast belongs in the 5th arg (options); the 4th is intentOverride.
        scene._applyAbilityToTarget(attacker, target, second, { isReaction: true, tags: second?.tags || [] }, { isSubCast: true });
      });
      // Both blades count as ONE attack for Transpose (2 strikes total).
      scene?._beginMultiHit?.(attacker, 2);

      return { ...roll, physical, elemental, necrotic, amount, buildup: { lacerate: 25 } };
    },
    description: "Strikes twice, each blade rolling to hit and crit on its own. Each strike deals 80% weapon damage and applies 25 Lacerate. Needs no weakness setup."
  },

  // Not player-selectable — Twin Fang's second strike. Needs to be its own
  // skill (not a repeat) so it gets a real independent hit-roll; twin_fang's
  // own apply() is already spoken for by the first strike, same reason
  // hail_of_arrows_shot exists separately from hail_of_arrows.
  'twin_fang_offhand': {
    id: "twin_fang_offhand",
    name: "Twin Fang",
    type: "weapon",
    hidden: true,
    typedDamage: true,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lacerate"],
    apply: (attacker, target) => {
      const ability = SKILLS?.twin_fang_offhand;
      const roll = calculateDamage(attacker, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 80, skillLabel: 'Twin Fang weapon damage (80%)',
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return { ...roll, physical, elemental, necrotic, amount, buildup: { lacerate: 25 } };
    },
    description: "Deals 80% weapon damage and applies 25 Lacerate."
  },

  // Initiative spender. Grave Strike is the kit's initiative GENERATOR (up to
  // 24 on a double tier-cross); this is the sink that gives that generation
  // somewhere to go. Deliberately variable: requiresInitiativeGauge gates it at
  // one increment (the engine fizzles it for free below that, spending no
  // action/MP), then apply() converts the banked gauge into cuts at 10 per cut,
  // capped at 5 cuts / 50 spent.
  //
  // 50 is the real ceiling because players run far less Charisma than the
  // harness's 16 — around 10 on a high-CHA build, which regenerates 11 gauge
  // per turn. So one cut is roughly one turn banked and a full five-cut Rush
  // is about four and a half turns of restraint. That is a heavy enough price
  // to justify 5 x 80% = 400% total, on top of the free upside that splitting
  // into five separate strikes carries: each cut rolls its own hit and crit
  // and re-triggers Jolt, on-hit riders and buildup independently.
  'arterial_rush': {
    id: "arterial_rush",
    name: "Arterial Rush",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    // Every cut is its own cast — Transpose must cover the whole flurry.
    multiHit: true,
    requiredWeapon: ["dagger"],
    requiredStat: "DEX",
    requiredValue: 13,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lacerate"],
    cooldown: 3,
    requiresInitiativeGauge: 10,
    buildupHint: { lacerate: 20 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.arterial_rush;
      const gauge = attacker?.initiativeGauge || 0;
      const hits = Math.max(1, Math.min(5, Math.floor(gauge / 10)));
      // Spend only what was actually converted, so leftover gauge under the
      // next 20 threshold is banked rather than burned.
      if (attacker) attacker.initiativeGauge = Math.max(0, gauge - hits * 10);

      const roll = calculateDamage(attacker, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 80, skillLabel: 'Arterial Rush weapon damage (80%)',
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      // Cut 1 is this cast; the rest are independent sub-casts, each with its
      // own hit and crit roll (see twin_fang_offhand's note).
      const cut = SKILLS?.arterial_rush_cut;
      for (let i = 1; i < hits; i++) {
        scene?.time?.delayedCall(130 * i, () => {
          if (scene.combatEnded || target?.status === 'incapacitated') return;
          // isSubCast belongs in the 5th arg (options); the 4th is intentOverride.
          scene._applyAbilityToTarget(attacker, target, cut, { isReaction: true, tags: cut?.tags || [] }, { isSubCast: true });
        });
      }
      // One attack, N cuts: the charge drops when the last cut resolves.
      scene?._beginMultiHit?.(attacker, hits);

      return {
        ...roll, physical, elemental, necrotic, amount,
        buildup: { lacerate: 20 },
        log: attacker && attacker.name
          ? attacker.name + ' spends ' + (hits * 10) + ' Initiative — ' + hits + (hits === 1 ? ' cut!' : ' cuts!')
          : undefined,
      };
    },
    description: "Spends 10 Initiative per cut, up to 5 cuts (50 Initiative). Each cut deals 80% weapon damage, applies 20 Lacerate, and rolls to hit and crit on its own — so each can separately trigger Jolt and on-hit effects. Needs no weakness setup."
  },

  // Not player-selectable — one cut of Arterial Rush past the first.
  'arterial_rush_cut': {
    id: "arterial_rush_cut",
    name: "Arterial Rush",
    type: "weapon",
    hidden: true,
    typedDamage: true,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lacerate"],
    apply: (attacker, target) => {
      const ability = SKILLS?.arterial_rush_cut;
      const roll = calculateDamage(attacker, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 80, skillLabel: 'Arterial Rush weapon damage (80%)',
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return { ...roll, physical, elemental, necrotic, amount, buildup: { lacerate: 20 } };
    },
    description: "Deals 80% weapon damage and applies 20 Lacerate."
  },

  // --- Sword (1h) --- v3.22
  // -------- Generation --------

  // Three sword_1h skills closing buildup-family gaps the kit had zero
  // coverage for (Fire/Disorient/Lacerate) — see the cross-weapon balance
  // audit. Each intentionally borrows a DIFFERENT existing shape rather than
  // all three using one template. Placed here at the top of Generation
  // (not down with the finisher/payoff skills) since these are meant to be
  // early-turn buildup generators, not scaling payoffs.

  // Fire: the "100% dmg + single buildup family + cross-family rewardIfWeak
  // bonus" template every other kit already has one of (Dagger Throw→
  // Lacerate, Ghoststep→Curse, Axe Throw→Disorient, Arcane Needle→Expose) —
  // sword's turn, keyed to Fire, reusing Arcane Needle's own curse-gate.
  'ember_arc': {
    id: "ember_arc",
    name: "Ember Arc",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["sword_1h"],
    requiredStat: "CHA",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "fire"],
    cooldown: 3,
    buildupHint: { fire: 113 },
    rewardIfWeak: [
      { family: "curse", tierAtLeast: 1, buff: { addBuildup: { fire: 50 } } },
    ],
    apply: (attacker, target) => {
      const ability = SKILLS?.ember_arc;
      const roll = calculateDamage(attacker, target, ability);
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
      const curseTier = target?.weakness?.tiers?.curse || 0;
      const rule = findRewardIfWeakRule(ability, curseTier);
      let fireBuildup = ability?.buildupHint?.fire ?? 113;
      if (rule) fireBuildup += rule.buff?.addBuildup?.fire || 0;
      return { ...roll, physical, elemental, necrotic, amount, buildup: { fire: fireBuildup } };
    },
    description: "A searing arc of flame — deals 100% weapon damage as Fire and applies Fire buildup. If the target is already Cursed, applies even more."
  },

  // Disorient: deliberately NOT the cross-family template — scales off the
  // caster's OWN Rhythm stacks instead. Builds (or refreshes) a stack FIRST,
  // then reads the resulting total, so a cold start still guarantees one
  // stack's worth rather than reading 0 before the stack exists. Closes the
  // real gap Sword Flourish left: that skill only ever SPREADS an existing
  // Disorient meter, nothing in the kit actually generates fresh Disorient.
  'broken_cadence': {
    id: "broken_cadence",
    name: "Broken Cadence",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["sword_1h"],
    requiredStat: "DEX",
    requiredValue: 13,
    // Bonus action from the start (cross-weapon balance audit — sword
    // needed more Bonus-slot variety) — damage set to 65% rather than a
    // full 100% swing, since the Rhythm-scaled Disorient buildup is the
    // actual payoff here, not the weapon damage.
    actionCost: "bonus",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "disorient"],
    cooldown: 3,
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.broken_cadence;
      const roll = calculateDamage(attacker, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 65, skillLabel: 'Broken Cadence weapon damage (65%)', isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      applyRhythmStack(attacker, scene);
      const totalStacks = Math.min(3, (attacker.statusEffects || []).filter(se => se?.id === 'rhythm_stack').length);
      const disorientBuildup = 60 * totalStacks;

      return { ...roll, physical, elemental, necrotic, amount, buildup: { disorient: disorientBuildup } };
    },
    description: "Deals 65% weapon damage. Builds a Rhythm stack, then applies Disorient buildup scaled by your total Rhythm stacks (60 per stack, up to 180 at 3 stacks)."
  },

  // Lacerate: borrows Searing Clout's (mace_2h/fire) shape — a flat %
  // damage bonus gated on the TARGET'S OWN current tier in the SAME family
  // this hit is building, checked live pre-hit rather than via the
  // rewardIfTierCross engine path (which only fires status-effect rewards
  // AFTER damage is already committed, so it can't buff this same hit).
  'widening_cut': {
    id: "widening_cut",
    name: "Widening Cut",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["sword_1h"],
    requiredStat: "DEX",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lacerate"],
    cooldown: 3,
    buildupHint: { lacerate: 80 },
    apply: (attacker, target) => {
      const ability = SKILLS?.widening_cut;
      const roll = calculateDamage(attacker, target, ability);

      // 100% base + 15%/30% at Lacerate T1/T2 — flat per tier, not
      // stacking, folded into ONE skillPct, same shape as Searing Clout.
      const lacTier = target?.weakness?.tiers?.lacerate || 0;
      const bonusPct = lacTier >= 2 ? 30 : lacTier >= 1 ? 15 : 0;
      const basePct = 100;

      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
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

      return { ...roll, physical, elemental, necrotic, amount, buildup: { lacerate: 80 } };
    },
    description: "Deals 100% weapon damage, +15%/+30% if the target is already Bleeding/Hemorrhaging. Applies 80 Lacerate buildup."
  },

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
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "expose"],
    cooldown: 2,
    buildupHint: { expose: 85 },
    // Bonus Lacerate on ACTUALLY crossing an Expose tier — routed through the
    // generic rewardIfTierCross engine (CombatScene.js), which snapshots
    // tiers before/after the REAL buildup application (post Hunter's Mark,
    // weapon buildup%, resilience, etc.), instead of predicting the cross
    // from the raw declared buildup number here. Self-predicting like that
    // was the exact bug Pressure Point and Needle Feint had — a hit
    // amplified or reduced before landing could silently cross (or fail to
    // cross) a tier the ability itself never actually saw happen.
    rewardIfTierCross: [
      { family: "expose", tier: 1, debuff: { addBuildup: { lacerate: 75 } } },
      { family: "expose", tier: 2, debuff: { addBuildup: { lacerate: 150 } } },
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
        buildup: { expose: ability?.buildupHint?.expose ?? 85 },
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
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "cold", "defensive"],
    cooldown: 3,
    buildupHint: { cold: 88 },
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
      { family: "cold", tier: 1, buff: { guardPct: 15, turns: 1, statusId: "guarded_stance", vfx: { kind: 'buff_harden' } } },
      { family: "cold", tier: 2, buff: { guardPct: 15, turns: 1, statusId: "guarded_stance", vfx: { kind: 'buff_harden' } } },
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
        buildup: { cold: ability?.buildupHint?.cold ?? 88 },
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
      };
    },
    description: "Deals 100% weapon damage. Applies Cold. Reaching Chilled or Frostbitten grants +15% Physical Resist for 1 turn."
  },

  // Same formula/shape as Marked Cut — see Vital Mark's (dagger) comment for
  // the full rationale. Lightning instead of Expose/Cold: sword_1h's only
  // two buildup-applying skills so far were Expose (Marked Cut) and Cold
  // (Guarded Slash above) — no elemental-storm flavor yet despite Blazing
  // Fervor already dipping into Fire on this weapon type. Expose secondary:
  // once the target's truly shocked, the follow-through finds them wide open.
  'storm_cut': {
    id: "storm_cut",
    name: "Storm Cut",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["sword_1h"],
    requiredStat: "DEX",
    requiredValue: 11,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lightning", "elemental"],
    cooldown: 2,
    buildupHint: { lightning: 85 },
    rewardIfTierCross: [
      { family: "lightning", tier: 1, debuff: { addBuildup: { expose: 75 } } },
      { family: "lightning", tier: 2, debuff: { addBuildup: { expose: 150 } } },
    ],
    apply: (attacker, target) => {
      const ability = SKILLS?.storm_cut;
      const roll = calculateDamage(attacker, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 100, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return {
        ...roll,
        physical, elemental, necrotic, amount,
        buildup: { lightning: ability?.buildupHint?.lightning ?? 85 },
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
      };
    },
    description: "Deals 100% weapon damage. Applies Lightning. Crossing a tier catches them wide open from the shock (bonus Expose)."
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
    // Moved Major → Bonus (per the cross-weapon balance audit — sword was
    // the most Major-skewed kit) — this is a support/utility pick (MP
    // restore + Rhythm), not a finisher, so damage nerfed 100%→60% (was
    // 100/110 with the Disorient reward) to offset the action-economy gain
    // of getting a real attack roll on the bonus slot; the MP restore/
    // Rhythm build/vulnerability rider are untouched, since those were
    // always the actual point of the skill.
    actionCost: "bonus",
    mpCost: 2,
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
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 60 + dmgPct, isCrit: roll.isCrit, critMult: roll.critMult }
      );

      const statusEffects = [];
      if (rule) {
        statusEffects.push({ id: "rallied_vulnerability", turns: 1, mods: { PhysicalResist: -10 }, vfx: { kind: 'debuff_decrease' } });
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
        scene?._playStatusVFX?.(ally, { kind: 'mana' });
      });
      scene?._log?.(`${attacker?.name || "The swordsman"} rallies the party, restoring ${mpRestored} MP to all allies.`);

      applyRhythmStack(attacker, scene);

      return {
        ...roll,
        physical, elemental, necrotic,
        amount,
        statusEffects: statusEffects.length ? statusEffects : undefined,
        rewardIfWeak: cloneRewardOrList(ability?.rewardIfWeak),
      };
    },
    description: "Deals 60% weapon damage. Requires target at least Flayed. Restores MP to all allies and builds Rhythm. Stronger if the target is Dazed."
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
    // Moved Major → Bonus (cross-weapon balance audit) — an Expose buildup
    // generator that also grants Rhythm at T2, not a finisher, so damage
    // nerfed 100/125% → 60/75% (the necrotic-weakness bonus kept as a
    // relative +25% on top) to offset the action-economy gain; buildup and
    // the Rhythm grant are untouched.
    actionCost: "bonus",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "expose", "necrotic"],
    cooldown: 3,
    buildupHint: { expose: 113 },
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
    apply: (attacker, target, scene) => {
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
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: hasNecroticWeakness ? 75 : 60, isCrit: roll.isCrit, critMult: roll.critMult }
      );

      const exposeTier = target?.weakness?.tiers?.expose || 0;
      const rule = findRewardIfWeakRule(ability, exposeTier);
      if (rule?.buff?.grantsRhythm) applyRhythmStack(attacker, scene);

      const amount = Math.max(1, physical + elemental + necrotic);

      return {
        ...roll,
        physical, elemental, necrotic,
        amount,
        buildup: { expose: ability?.buildupHint?.expose ?? 113 },
        rewardIfWeak: cloneRewardOrList(ability?.rewardIfWeak),
      };
    },
    description: "Deals 60% weapon damage. Applies Expose. +25% damage (75% total) if the target has any necrotic weakness (Toxic, Disease, or Curse). Grants Rhythm if the target is at least Flayed."
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
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "disorient", "aoe"],
    // Inline shape lifted onto the skill so the tooltip can draw it. Spreads
    // the target's FULL Disorient meter to their rank, dealing no damage.
    aoe: { shape: "column", scale: 1.0, damage: false },
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
      const splash = resolveAOESplash(scene, target, ability.aoe).map(char => ({
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
    mpCost: 3,
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
        scene?._playStatusVFX?.(owner, { kind: 'mana' });
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
    mpCost: 4,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["support", "buff", "fire"],
    cooldown: 2,
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
      const buff = { id: "blazing_fervor_buff", turns: 2, onHit: { fireDamage: fireDmgOnHit, fireBuildup: fireBuildupOnHit }, vfx: { kind: 'buff_magic' } };
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
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "consume", "expose"],
    cooldown: 4,
    requiresWeakness: { family: "expose", tierAtLeast: 1 },
    // Declarative so the tooltip can show the real rate/cap and apply() reads
    // the same numbers instead of duplicating them inline.
    consumeWeaknessBonus: { family: "expose", pctPer100: 25, maxConsume: 400 },
    apply: (attacker, target) => {
      const ability = SKILLS?.power_stab;
      const roll = calculateDamage(attacker, target, ability);

      // Base 150% weapon damage + up to +100% from consumed Expose — these two
      // are ADDITIVE percentages of the same base (150% + 100% = 250% total
      // at the cap), not sequential multipliers, so they're combined into ONE
      // skillPct below instead of two chained multiplies (which would compound
      // higher than the intended 250% at the cap).
      const cfg = ability.consumeWeaknessBonus;
      const currentMeter = target?.weakness?.meters?.[cfg.family] || 0;
      // Consumes only whole 100-increments (same rule as Toxic Bloom) — a
      // target sitting on 350 only has 300 drained, leaving the leftover 50
      // behind rather than destroying it for no extra bonusPct.
      const consumed = Math.min(cfg.maxConsume, Math.floor(currentMeter / 100) * 100);
      const bonusPct = Math.floor(consumed / 100) * cfg.pctPer100;
      const basePct = 150;

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

      // Crit reapplies 63 Expose — was reading roll.crit, a field that
      // doesn't exist on calculateDamage()'s return (the real field is
      // isCrit), so this never actually fired before.
      const buildup = roll.isCrit ? { expose: 63 } : undefined;

      return { ...roll, physical, elemental, necrotic, amount, buildup };
    },
    description: "Deals 150% weapon damage. Consumes up to 400 Expose for +25% damage per 100 consumed (up to +100%). Crits reapply 63 Expose."
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
    mpCost: 5,
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
        attacker, target, { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 160, isCrit: roll.isCrit, critMult: roll.critMult }
      );

      const statusEffects = [];

      // Cold locks the target's bonus action once it reaches the 200
      // threshold — the same T2 floor that already gates casting this skill
      // at all, so landing the hit now always locks the bonus action.
      // Consumption is capped at 200 even if the target is sitting on more
      // (e.g. T3+) — any excess above 200 is left behind. Frost-Numbed
      // (turns:1) is checked once at the start of the target's own next
      // turn (see the actionsLeft reset in _advanceTurn/_takeEnemyTurn),
      // so it fires exactly once, then expires — same timing model as
      // Trapped Fire below.
      const coldMeter = target?.weakness?.meters?.cold || 0;
      let consumedCold = 0;
      if (coldMeter >= 200) {
        consumedCold = 200;
        if (target?.weakness?.meters) {
          target.weakness.meters.cold = Math.max(0, coldMeter - consumedCold);
          if (target.weakness.tiers) target.weakness.tiers.cold = weaknessTierFromMeter(target.weakness.meters.cold);
        }
        statusEffects.push({ id: "frost_numbed", turns: 1, vfx: { kind: 'debuff_shock' } });
      }

      // Fire T2+: consume up to 400 fire, independent of the cold threshold above.
      const buildup = {};
      const hasFireT2 = (target?.weakness?.tiers?.fire || 0) >= 2;
      let consumedFire = 0;
      if (hasFireT2) {
        const currentFire = target?.weakness?.meters?.fire || 0;
        // Consumes only whole 100-increments (same rule as Toxic Bloom) — a
        // target sitting on 350 fire only has 300 drained, leaving the
        // leftover 50 behind rather than destroying it for no extra `steps`
        // (the buildup.cold conversion below is per-point anyway, but the
        // vuln/resist/delayed-burn rider effects are all step-based).
        consumedFire = Math.min(400, Math.floor(currentFire / 100) * 100);
        if (target?.weakness?.meters) {
          target.weakness.meters.fire = Math.max(0, currentFire - consumedFire);
          if (target.weakness.tiers) target.weakness.tiers.fire = weaknessTierFromMeter(target.weakness.meters.fire);
        }
        // Added afterward — this cold does NOT count toward this cast's own 400 threshold above.
        buildup.cold = Math.floor(consumedFire * 0.625);
        const steps = Math.floor(consumedFire / 100);
        if (steps > 0) {
          statusEffects.push({
            id: "glacial_scorch",
            turns: 1,
            fireBuildupMul: 1 + steps * 0.125,
            // General elemental vulnerability (not fire-only) — reuses the same
            // Resist-as-mitigation-points convention as torn_defenses/rallied_vulnerability.
            mods: { ElementalResist: -(steps * 13) },
            onTurnEndOnce: { damage: steps * 13, isMagic: true },
            vfx: { kind: 'debuff_burn' },
          });
        }
      }

      const amount = Math.max(1, physical + elemental + necrotic);
      return {
        ...roll, physical, elemental, necrotic, amount,
        statusEffects: statusEffects.length ? statusEffects : undefined,
        buildup: Object.keys(buildup).length ? buildup : undefined,
        log: `${attacker?.name || "The swordsman"} strikes with glacial force!`
          + (consumedCold ? ` The frost numbs ${target?.name || 'the target'}'s reflexes!` : "")
          + (consumedFire ? " Trapped fire will flare at the end of their next turn." : ""),
      };
    },
    description: "Deals 160% weapon damage. If the target has 200+ Cold, consumes up to 200 to disable their bonus action for their next turn (Frost-Numbed). If the target has Fire T2+, consumes up to 400 Fire: adds Cold buildup equal to 62.5% consumed, increases Fire buildup taken by 12.5% per 100 consumed, and makes the target vulnerable to all Elemental damage by 13% per 100 consumed for 1 turn — at the end of their next turn, the trapped fire deals 13 damage per 100 consumed."
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
    mpCost: 3,
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
        scene?._addStatusEffects?.(enemy, [{ id: "shaken_aim", turns: 1, mods: { Accuracy: -50 }, vfx: { kind: 'debuff_confuse' } }]);
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
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "aoe", "lacerate"],
    cooldown: 5,
    // Must target an enemy standing in one of the two flank arcs — center-row
    // slots (7, 2) aren't valid targets for this skill. See aoeResolver.js's
    // "arc" shape for the matching splash resolution (top {8,4,3} / bottom {6,5,1}).
    targetSlots: [8, 4, 3, 6, 5, 1],
    aoe: { shape: "arc", scale: 0.85 },
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
    mpCost: 3,
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
        applyRhythmStack(attacker, scene);
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
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "heal", "necrotic"],
    cooldown: 4,
    // NOT a gate. This used to declare
    //   requiresWeakness: { anyOf: [toxic T1, disease T1, curse T1] }
    // which no gate ever enforced -- both _applyAbilityToTarget and
    // _executeSkill do `const fam = req?.family; if (!fam) continue;`, and the
    // anyOf shape has no .family, so the requirement was skipped entirely.
    // That was a landmine: enforcing anyOf would have made the skill unusable
    // against a clean target, which is NOT the design. The heal already scales
    // continuously -- floor(total necrotic / 25) -- and is simply 0 with no
    // buildup, so it needs no requirement at all.
    // `relatesToFamilies` is purely descriptive: it keeps the skill listed
    // under the toxic/disease/curse filter pills without claiming a gate or a
    // reward. Read only by CombatScene._weaknessFamiliesOf().
    relatesToFamilies: ["toxic", "disease", "curse"],
    apply: (attacker, target, scene) => {
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
        scene?._playStatusVFX?.(attacker, { kind: 'heal' });
      }
      return {
        ...roll, physical, elemental, necrotic, amount,
        log: healAmt > 0 ? `${attacker?.name || "The swordsman"} siphons life — heals ${healAmt} HP from ${totalNecrotic} necrotic buildup.` : undefined,
      };
    },
    description: "100% damage vs necrotically afflicted; heals 1 HP per 25 total necrotic buildup (toxic + disease + curse)."
  },

  // Sword's curse-rider — same intensity-scaling shape as Curse of
  // Normality (dagger)/Curse of Pendulums (mace)/Curse of Doubt (bow)/Curse
  // of Static (axe), just targeting Accuracy for this kit.
  'curse_of_visions': {
    id: "curse_of_visions",
    name: "Curse of Visions",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["sword_1h"],
    requiredStat: "CHA",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "curse", "necrotic"],
    cooldown: 4,
    requiresWeakness: { family: "curse", tierAtLeast: 1 },
    buildupHint: { curse: 60 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.curse_of_visions;
      const roll = calculateDamage(attacker, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 100, skillLabel: `${ability?.name || 'Skill'} weapon damage (100%)`, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      const curseTier = target?.weakness?.tiers?.curse || 0;
      const curseMeter = target?.weakness?.meters?.curse || 0;
      const basePct = 20;
      const scaledPct = curseTier >= 2 ? Math.round(basePct * weaknessIntensityMult(curseMeter)) : basePct;
      const alreadyCursed = (target.statusEffects || []).some(se => se?.id === 'curse_of_visions');
      if (!alreadyCursed) {
        scene?._addStatusEffects?.(target, [{
          id: "curse_of_visions", name: "Curse of Visions", permanent: true,
          mods: { Accuracy: -scaledPct },
          vfx: { kind: 'debuff_confuse' },
        }]);
      }
      return { ...roll, physical, elemental, necrotic, amount, buildup: { curse: 60 } };
    },
    description: "Deals 100% weapon damage and applies 60 Curse buildup. Requires target at least Hexed. Applies a permanent rider: -20 Accuracy, scaling up to -50 at max Curse intensity."
  },

  // Sword's healing skill — fizzles (no cost/cooldown spent) if the caster
  // has no active Rhythm at all, since this skill's whole point is scaling
  // off it. Uses the exact same applyRhythmStack every other Rhythm-granting
  // skill shares (adds a stack if under the 3 cap, refreshes ALL existing
  // stacks' duration either way) — deliberately does NOT consume anything,
  // per explicit request.
  'harmonic_strike': {
    id: "harmonic_strike",
    name: "Harmonic Strike",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["sword_1h"],
    requiredStat: "CHA",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "heal", "support"],
    cooldown: 4,
    apply: (attacker, target, scene) => {
      const hasRhythm = (attacker?.statusEffects || []).some(se => se?.id === 'rhythm_stack');
      if (!hasRhythm) {
        return { amount: 0, fizzle: true, log: `${attacker?.name || "The swordsman"} has no rhythm to draw on — Harmonic Strike fizzles.` };
      }
      const ability = SKILLS?.harmonic_strike;
      const roll = calculateDamage(attacker, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 100, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      applyRhythmStack(attacker, scene);
      const stackCount = (attacker.statusEffects || []).filter(se => se?.id === 'rhythm_stack').length;

      const healRoll = calculateHealRoll(attacker, ability);
      const healPct = 20 * stackCount;
      const healAmt = Math.max(1, applyHealModifiers(healRoll.amount, attacker, {
        ability, skillPct: healPct,
        skillLabel: `${ability?.name || 'Skill'} rhythm healing (${healPct}%, ${stackCount} stack${stackCount !== 1 ? 's' : ''})`,
        isCrit: healRoll.isCrit, critMult: healRoll.critMult,
      }));

      const allySlots = attacker?.isEnemy ? scene?.enemySlots : scene?.allySlots;
      (allySlots || []).forEach(s => {
        const ally = s?.char;
        if (!ally || ally.status === 'incapacitated') return;
        const before = ally.currentHP || 0;
        const maxHP = ally.maxHP || before;
        ally.currentHP = Math.min(maxHP, before + healAmt);
        if (ally.currentHP > before) {
          scene?._showFloatingNumber?.(ally.currentHP - before, ally, true, false);
          scene?._playStatusVFX?.(ally, { kind: 'heal' });
        }
      });
      scene?._log?.(`${attacker?.name || "The swordsman"} strikes in rhythm (${stackCount} stack${stackCount !== 1 ? 's' : ''}) — the party heals ${healAmt} HP!`);

      return { ...roll, physical, elemental, necrotic, amount };
    },
    description: "Requires at least one active Rhythm stack. Deals 100% weapon damage, then builds/refreshes your own Rhythm (does not consume it) and heals your whole party — 20% of your heal roll per active Rhythm stack (up to 60% at 3 stacks)."
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
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "consume", "lacerate"],
    cooldown: 6,
    apply: (attacker, target) => {
      const ability = SKILLS?.shattering_cut;
      const roll = calculateDamage(attacker, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target, { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 155, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      const currentLacerate = target?.weakness?.meters?.lacerate || 0;
      // Consumes only whole 100-increments (same rule as Toxic Bloom) — a
      // target sitting on 350 only has 300 drained, leaving the leftover 50
      // behind rather than destroying it for no extra pdrReduction.
      const consumed = Math.min(400, Math.floor(currentLacerate / 100) * 100);
      if (consumed > 0 && target?.weakness?.meters) {
        target.weakness.meters.lacerate = Math.max(0, currentLacerate - consumed);
        if (target.weakness.tiers) target.weakness.tiers.lacerate = weaknessTierFromMeter(target.weakness.meters.lacerate);
      }
      const steps = Math.floor(consumed / 100);
      const pdrReduction = steps * 13;
      const statusEffects = [];
      if (pdrReduction > 0) {
        statusEffects.push({ id: "shattered_defenses", turns: 3, mods: { PhysicalResist: -pdrReduction }, vfx: { kind: 'debuff_decrease' } });
      }
      // Lacerate-buildup vulnerability now scales continuously with steps
      // instead of a flat +50% at the 200 breakpoint — +25% per 100 past
      // 100, capping at +100% (double) at the full 400 consumed. Uses the
      // same generic <family>BuildupMul enforcement added for Glacial
      // Strike's Trapped Fire (_applyWeaknessBuildup in CombatScene.js).
      const lacerateVulnPct = steps >= 2 ? steps * 25 : 0;
      if (lacerateVulnPct > 0) {
        statusEffects.push({ id: "torn_defenses", turns: 2, lacerateBuildupMul: 1 + lacerateVulnPct / 100, vfx: { kind: 'debuff_sick' } });
      }
      return {
        ...roll, physical, elemental, necrotic, amount,
        statusEffects: statusEffects.length ? statusEffects : undefined,
        log: consumed > 0
          ? `${attacker?.name || "The swordsman"} shatters armor — -${pdrReduction}% PDR${lacerateVulnPct > 0 ? `, +${lacerateVulnPct}% Lacerate buildup taken` : ""}.`
          : undefined,
      };
    },
    description: "155% damage; consume up to 400 lacerate for -13% PDR per 100 for 3 turns. 200+ consumed also makes the target take extra Lacerate buildup for 2 turns, scaling from +50% at 200 up to +100% at 400."
  },

  // --- Sword (1h) Reactions ---
  // Disabled by explicit user request — believed to no longer belong in
  // the current sword_1h kit (sword_1h's reaction trio is the last one in
  // the file still at v3.21/v3.22, never modernized alongside everything
  // else). Kept in the file (not deleted) so it can be restored if that
  // turns out to be wrong. See read_and_react below for the still-live
  // self_hit sword reaction.
  'cover_strike': {
    id: "cover_strike",
    name: "Cover Strike",
    type: "weapon",
    mechanic: "reaction",
    versionTag: "v3.21",
    disabled: true,
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

  // Disabled by explicit user request — same reasoning as cover_strike
  // above. read_and_react (v3.22) is the currently-live self_hit reaction
  // for sword_1h.
  'riposte': {
    id: "riposte",
    name: "Riposte",
    type: "weapon",
    mechanic: "reaction",
    versionTag: "v3.21",
    disabled: true,
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
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["axe_2h"],
    requiredStat: "STR",
    requiredValue: 10,
    // Moved Major → Bonus (cross-weapon balance audit, axe variety pass) —
    // damage nerfed 100%→65% base; Lacerate buildup and the own-tier bonus
    // are untouched.
    actionCost: "bonus",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lacerate"],
    cooldown: 2,
    buildupHint: { lacerate: 88 },
    apply: (attacker, target) => {
      const ability = SKILLS?.rending_hew;
      const roll = calculateDamage(attacker, target, ability);

      // Same tiered-bonus shape as Searing Clout (mace_2h/fire), just keyed
      // off Lacerate instead — flat 15%/30% per tier, not stacking, folded
      // into one skillPct alongside the base.
      const lacerateTier = target?.weakness?.tiers?.lacerate || 0;
      const bonusPct = lacerateTier >= 2 ? 30 : lacerateTier >= 1 ? 15 : 0;
      const basePct = 65;

      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: basePct + bonusPct,
          skillLabel: `${ability?.name || 'Skill'} weapon damage (${basePct}%${bonusPct ? ` + ${bonusPct}% Lacerate tier` : ''})`,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return {
        ...roll, physical, elemental, necrotic, amount,
        buildup: { lacerate: ability?.buildupHint?.lacerate ?? 88 },
      };
    },
    description: "Deals 65% weapon damage, +15% against a Bleeding (Lacerate T1) target (+30% instead if Hemorrhaging, Lacerate T2). Builds Lacerate."
  },

  'trophy_cry': {
    id: "trophy_cry",
    name: "Trophy Cry",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
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
        // Real fizzle — no bonus action, MP, or cooldown spent (same
        // result.fizzle mechanism Momentum Strike uses for its own
        // can't-know-until-apply-time condition). Was returning a normal
        // result, which still consumed the bonus action on an accidental
        // click even though nothing happened.
        return { fizzle: true, log: `${attacker?.name || "The axeman"} finds no trophy to cry for yet.` };
      }
      const maxHP = attacker?.maxHP ?? attacker?.derivedStats?.maxHP ?? 0;
      const healAmt = Math.floor(maxHP * 0.25);
      if (healAmt > 0 && attacker) {
        attacker.currentHP = Math.min(maxHP, (attacker.currentHP ?? 0) + healAmt);
        // Direct HP mutation, not routed through the generic isHeal
        // pipeline — vfxHint wouldn't fire here, so this is called directly.
        scene?._playStatusVFX?.(attacker, { kind: 'heal' });
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
    description: "If any enemy died this turn, heal 25% of your own max HP and reduce your whole party's weakness buildup by 50."
  },

  'wound_opener': {
    id: "wound_opener",
    name: "Wound Opener",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["axe_2h"],
    requiredStat: "STR",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lacerate"],
    cooldown: 3,
    requiresWeakness: { family: "lacerate", tier: 1 },
    buildupHint: { lacerate: 50 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.wound_opener;
      const roll = calculateDamage(attacker, target, ability);
      const toxicTier = target?.weakness?.tiers?.toxic || 0;
      const diseaseTier = target?.weakness?.tiers?.disease || 0;
      const necroticBonus = toxicTier >= 1 || diseaseTier >= 1;
      const totalPct = 100 + (necroticBonus ? 25 : 0);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: totalPct,
          skillLabel: `${ability?.name || 'Skill'} weapon damage (${totalPct}%${necroticBonus ? ', Necrotic' : ''})`,
          isCrit: roll.isCrit, critMult: roll.critMult,
          // Same conversion pattern as pestilent_word (staff) — only the
          // toxic/disease-triggered hit actually turns necrotic; the plain
          // 100% hit (Lacerate T1 alone) stays physical.
          ...(necroticBonus ? { skillConversion: { physToNecroPct: 100, elemToNecroPct: 100 } } : {}),
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      // Real 2-of-the-TARGET'S-OWN-turns decay pause on Lacerate/Toxic/
      // Disease — uses the existing weakness.grace per-family counter
      // (_endTurnWeakness/_weaknessDecayUnit already reads it, decrementing
      // once per that unit's own turn; this is the same field a family's
      // own config-driven starting grace period already uses, not a new
      // bolted-on mechanic). Always applied — the skill already requires
      // Lacerate T1 to be cast at all, independent of the toxic/disease
      // damage bonus above.
      if (target?.weakness?.grace) {
        target.weakness.grace.lacerate = Math.max(target.weakness.grace.lacerate || 0, 2);
        target.weakness.grace.toxic = Math.max(target.weakness.grace.toxic || 0, 2);
        target.weakness.grace.disease = Math.max(target.weakness.grace.disease || 0, 2);
      }
      // Purely cosmetic status entry — the real effect above already lives
      // in weakness.grace (which _endTurnWeakness reads directly, no status
      // effect involved), but the status-icon system only ever looks at
      // target.statusEffects, so without this the debuff was invisible on
      // the enemy despite working correctly. No mods: real mechanic is
      // untouched by this; ticks down in lockstep with grace since both are
      // decremented once per the TARGET's own end-of-turn.
      scene?._addStatusEffects?.(target, [{ id: 'wound_opener_seal', turns: 2, vfx: { kind: 'debuff_sick' } }]);

      return {
        ...roll, physical, elemental, necrotic, amount,
        ...(necroticBonus ? { isMagic: true } : {}),
        buildup: { lacerate: ability?.buildupHint?.lacerate ?? 50 },
      };
    },
    description: "Requires the target to be Bleeding (Lacerate T1+). Deals 100% weapon damage, or 125% as Necrotic if the target is also Poisoned (Toxic T1) or Sickened (Disease T1). Prevents the target's Lacerate, Toxic, and Disease buildup from decaying for 2 of their turns."
  },

  // -------- Moved up from the end of the axe block (disorient/disease/curse
  // — the 3 weakness families axe's original 20-skill kit never generated
  // as a primary buildupHint target) — repositioned here, right after the
  // first 3 skills, so they land in the Generator section of the action
  // menu instead of the tail end, at the user's request. --------

  // Axe's own version of the "100% dmg + single buildupHint + rewardIfWeak"
  // template every other weapon has (dagger_throw/ghoststep, arcane_needle
  // after its own number fix above) — 'projectile'-tagged so it correctly
  // triggers an ally's armed Volley reaction like every other thrown/shot
  // skill. Disorient fits a heavy thrown weapon impact (stagger on landing);
  // the reward triggers off Lacerate T1+ — axe's own most-built family,
  // mirroring how dagger_throw's reward checks Expose (dagger's own most-
  // built family) instead of a generic unrelated one.
  'axe_throw': {
    id: "axe_throw",
    name: "Axe Throw",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["axe_2h"],
    requiredStat: "STR",
    requiredValue: 11,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "disorient"],
    cooldown: 2,
    buildupHint: { disorient: 113 },
    rewardIfWeak: [
      { family: "lacerate", tierAtLeast: 1, buff: { addBuildup: { disorient: 50 } } },
    ],
    apply: (attacker, target) => {
      const ability = SKILLS?.axe_throw;
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
      const lacTier = target?.weakness?.tiers?.lacerate || 0;
      const rule = findRewardIfWeakRule(ability, lacTier);
      let disorientBuildup = ability?.buildupHint?.disorient ?? 113;
      if (rule) disorientBuildup += rule.buff?.addBuildup?.disorient || 0;
      return { ...roll, physical, elemental, necrotic, amount, buildup: { disorient: disorientBuildup } };
    },
    description: "Hurls your axe end over end — deals 100% weapon damage and applies Disorient buildup. If the target is already bleeding, applies even more."
  },

  // Axe's two "marked_cut-style" skills — the other common 2-per-weapon
  // template (100% dmg + single buildupHint + rewardIfTierCross granting
  // bonus buildup in a DIFFERENT family on an actual tier-cross, not just a
  // precondition check). Every other real weapon has exactly 2 of these;
  // axe had zero using this exact shape (scarlet_rush is close but rewards
  // healMP, not a cross-family buildup chain). Both reward branches loop
  // back into families axe's own kit already cares about — Lacerate (its
  // core economy, fed by Hemorrhage Strike/Artery Sever/Inferno Arc) and
  // Expose (War Cry's own family) — rather than borrowing an unrelated
  // pairing from another weapon's version of this template.
  'festering_cleave': {
    id: "festering_cleave",
    name: "Festering Cleave",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["axe_2h"],
    requiredStat: "STR",
    requiredValue: 12,
    // Moved Major → Bonus (cross-weapon balance audit, axe variety pass) —
    // damage nerfed 100%→65%; Disease buildup and the tier-cross Lacerate
    // reward are untouched.
    actionCost: "bonus",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "disease"],
    cooldown: 2,
    buildupHint: { disease: 85 },
    rewardIfTierCross: [
      { family: "disease", tier: 1, debuff: { addBuildup: { lacerate: 75 } } },
      { family: "disease", tier: 2, debuff: { addBuildup: { lacerate: 150 } } },
    ],
    apply: (attacker, target) => {
      const ability = SKILLS?.festering_cleave;
      const roll = calculateDamage(attacker, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 65, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return {
        ...roll, physical, elemental, necrotic, amount,
        buildup: { disease: ability?.buildupHint?.disease ?? 85 },
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
      };
    },
    description: "A filthy chop that festers on contact — deals 65% weapon damage and applies Disease buildup. Crossing a Disease tier deepens the wound, adding bonus Lacerate buildup."
  },

  'hexed_cleave': {
    id: "hexed_cleave",
    name: "Hexed Cleave",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["axe_2h"],
    requiredStat: "STR",
    requiredValue: 13,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "curse"],
    cooldown: 2,
    buildupHint: { curse: 85 },
    rewardIfTierCross: [
      { family: "curse", tier: 1, debuff: { addBuildup: { expose: 75 } } },
      { family: "curse", tier: 2, debuff: { addBuildup: { expose: 150 } } },
    ],
    apply: (attacker, target) => {
      const ability = SKILLS?.hexed_cleave;
      const roll = calculateDamage(attacker, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 100, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return {
        ...roll, physical, elemental, necrotic, amount,
        buildup: { curse: ability?.buildupHint?.curse ?? 85 },
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
      };
    },
    description: "A cleave laced with a battlefield hex — deals 100% weapon damage and applies Curse buildup. Crossing a Curse tier lays the target bare, adding bonus Expose buildup."
  },

  'butchers_march': {
    id: "butchers_march",
    name: "Butcher's March",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    requiredWeapon: ["axe_2h"],
    requiredStat: "CON",
    requiredValue: 14,
    actionCost: "bonus",
    mpCost: 4,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["support", "stance", "self-buff"],
    cooldown: 5,
    statusEffects: [{ id: "butchers_march_buff", turns: 3, onCritRestore: { hpPct: 5, initiativeGain: 5 }, vfx: { kind: 'buff_power' } }],
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

  // Reworked from a crit-conditional active strike into a reaction, modeled
  // on read_and_react's live (v3.22) shape: no apply() — arming happens
  // purely through the reaction-prep menu — and canTrigger reuses its exact
  // tag+weaponType fallback pattern (inverted for ranged instead of melee),
  // since as of the encounter 3/5/6 VFX pass several enemy skills (Huntsman,
  // Kiro, the wizards) DO carry real 'ranged'/'projectile' tags now — this
  // isn't blocked on missing data the way it would have been earlier in the
  // project. Uses 'pre_hit' rather than 'self_hit' because the Accuracy
  // debuff has to land on the attacker BEFORE rollToHit() runs for this same
  // attack — checkPreHit fires strictly before the usesHitRoll block in
  // _applyAbilityToTarget, and computeHitChance() reads the attacker's
  // statusEffects live via getEffectiveDerived(), so this is confirmed to
  // actually affect the incoming hit's chance, not just look like it does.
  'bone_notch': {
    id: "bone_notch",
    name: "Blinding Glint",
    type: "weapon",
    mechanic: "reaction",
    versionTag: "v3.23",
    requiredWeapon: ["axe_2h"],
    requiredStat: "STR",
    requiredValue: 15,
    actionCost: "reaction",
    mpCost: 3,
    cooldown: 3,
    requiresTarget: false,
    reaction: {
      trigger: "pre_hit",
      cooldownOn: "trigger",
      canTrigger: ({ attacker, sourceAbility }) => {
        const RANGED_WEAPON_TYPES = ['bow', 'sling', 'gun'];
        const tags = sourceAbility?.tags || [];
        if (tags.includes('melee')) return false;
        return tags.includes('ranged') || RANGED_WEAPON_TYPES.includes(attacker?.weaponType);
      },
      exec: ({ owner, attacker, scene }) => {
        if (!attacker) return null;
        scene?._addStatusEffects?.(attacker, [{ id: 'blinding_glint_scoped', turns: 1, mods: { Accuracy: -25 }, vfx: { kind: 'debuff_confuse' } }]);
        scene?._log?.(`${owner?.name || "The axeman"} catches the light on their blade, dazzling ${attacker.name}!`);
        return { scopedDebuffId: 'blinding_glint_scoped' };
      },
    },
    description: "Reaction: when targeted by a ranged attack, catch the light off your axe blade — the attacker's Accuracy is reduced by 25 for that attack."
  },

  'war_cry': {
    id: "war_cry",
    name: "War Cry",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    requiredWeapon: ["axe_2h"],
    requiredStat: "CHA",
    requiredValue: 14,
    actionCost: "bonus",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["support", "shout", "expose", "aoe", "initiative"],
    // Column filter is done inline via _getColumnBySlotId; declared here so
    // the tooltip can draw it. Splash applies Expose buildup only.
    aoe: { shape: "column", scale: 1.0, damage: false },
    cooldown: 3,
    buildupHint: { expose: 80 },
    // Spending initiative is this skill's whole job — below the minimum
    // spend tier, it has nothing to do, so it should fizzle instead of
    // silently firing for free. Checked generically in _applyAbilityToTarget.
    requiresInitiativeGauge: 10,
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.war_cry;
      // Same auto-pick-the-highest-affordable-tier shape as Blazing Fervor:
      // 10/20/30, not a player choice.
      const gauge = attacker?.initiativeGauge || 0;
      const spend = gauge >= 30 ? 30 : gauge >= 20 ? 20 : 10;
      attacker.initiativeGauge = Math.max(0, (attacker.initiativeGauge || 0) - spend);
      const steps = spend / 10;
      const exposeBuildup = 80 + 25 * (steps - 1); // 80 / 105 / 130
      const atkPowerPct = 10 + 5 * steps; // 15 / 20 / 25

      // Expose enemy column
      const splash = [];
      // Shared resolver instead of a hand-rolled duplicate of its 'column' rule.
      if (scene && target) {
        {
          resolveAOESplash(scene, target, ability.aoe)
            .forEach(char => splash.push({ target: char, amount: 0, buildup: { expose: exposeBuildup }, tags: ability?.tags }));
        }
        // AttackPower buff to the caster's whole column, scaled by spend tier.
        // Nested under mods (not a top-level field) — _sumStatusEffectMods
        // only ever reads se.mods.AttackPower, so a top-level field here
        // would silently do nothing, which is exactly what the old version did.
        const atkBuff = { id: "war_cry_atk_buff", turns: 2, mods: { AttackPower: atkPowerPct }, vfx: { kind: 'warcry' } };
        const attackerCol = scene._getUnitColumn?.(attacker);
        const allySlots = attacker?.isEnemy ? scene?.enemySlots : scene?.allySlots;
        if (attackerCol) {
          (allySlots || [])
            .filter(slot => slot?.char && slot.char !== attacker && slot.char.status !== "incapacitated" && scene._getColumnBySlotId(slot.slotId) === attackerCol)
            .forEach(slot => scene._addStatusEffects?.(slot.char, [{ ...atkBuff }]));
        }
        if (attacker) scene._addStatusEffects?.(attacker, [{ ...atkBuff }]);
      }

      return {
        amount: 0,
        buildup: { expose: exposeBuildup },
        splash: splash.length ? splash : undefined,
        log: `${attacker?.name || "The axeman"} bellows a war cry (spent ${spend} initiative), exposing foes for ${exposeBuildup} and granting allies +${atkPowerPct}% AttackPower.`,
      };
    },
    description: "Spend initiative (10/20/30, based on current gauge) to expose an enemy column and grant your own column +AttackPower for 2 turns. Both the Expose buildup (80/105/130) and the AttackPower bonus (15/20/25%) scale with how much you spend."
  },

  'scarlet_rush': {
    id: "scarlet_rush",
    name: "Scarlet Rush",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["axe_2h"],
    requiredStat: "STR",
    requiredValue: 12,
    // Moved Major → Bonus (cross-weapon balance audit, axe variety pass) —
    // damage nerfed 95%→60%; the MP-restore-on-tier-cross utility (the
    // actual point of the skill) is untouched.
    actionCost: "bonus",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lacerate"],
    cooldown: 3,
    buildupHint: { lacerate: 80 },
    rewardIfTierCross: [
      { family: "lacerate", tier: 1, healMP: 3 },
      { family: "lacerate", tier: 2, healMP: 6 },
    ],
    apply: (attacker, target) => {
      const ability = SKILLS?.scarlet_rush;
      const roll = calculateDamage(attacker, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 60, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return {
        ...roll, physical, elemental, necrotic, amount,
        buildup: { lacerate: ability?.buildupHint?.lacerate ?? 80 },
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
      };
    },
    description: "Deals 60% weapon damage. Restores 3 MP if this hit crosses the target into Lacerate T1 (Bleeding), or 6 MP if it crosses into T2 (Hemorrhaging)."
  },

  // -------- Payoff --------
  'blood_surge': {
    id: "blood_surge",
    name: "Blood Surge",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["axe_2h"],
    requiredStat: "CON",
    requiredValue: 16,
    actionCost: "bonus",
    mpCost: 4,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["support", "heal", "aoe"],
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
        let { physical, elemental, necrotic } = applyTypedDamageModifiers(
          { physical: baseRoll.physical, elemental: baseRoll.elemental, necrotic: baseRoll.necrotic },
          attacker, victim,
          { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 50, isCrit: baseRoll.isCrit, critMult: baseRoll.critMult }
        );
        const splashAmt = Math.max(1, physical + elemental + necrotic);
        splash.push({ target: victim, amount: splashAmt, physical, elemental, necrotic, tags: ability?.tags });
        if (lacTier >= 2 && attacker) {
          const maxHP = attacker?.maxHP ?? attacker?.derivedStats?.maxHP ?? 0;
          healAmt += Math.floor(maxHP * 0.05);
        }
      });
      if (healAmt > 0 && attacker) {
        const maxHP = attacker?.maxHP ?? attacker?.derivedStats?.maxHP ?? 0;
        attacker.currentHP = Math.min(maxHP, (attacker.currentHP ?? 0) + healAmt);
        // Direct HP mutation, same as Trophy Cry — bypasses the generic
        // isHeal pipeline, so this is called directly rather than via vfxHint.
        scene?._playStatusVFX?.(attacker, { kind: 'heal' });
      }
      return {
        amount: 0,
        splash: splash.length ? splash : undefined,
        log: splash.length === 0
          ? `${attacker?.name || "The axeman"} finds no bleeders to surge on.`
          : healAmt > 0
            ? `${attacker?.name || "The axeman"} surges on blood, striking bleeders and healing ${healAmt} HP.`
            : `${attacker?.name || "The axeman"} surges on blood, striking bleeders.`,
      };
    },
    description: "Deals 50% weapon damage to every enemy with Lacerate T1+. Heals 5% of your own max HP for each of those enemies that's Hemorrhaging (Lacerate T2+)."
  },

  'harvest_momentum': {
    id: "harvest_momentum",
    name: "Harvest Momentum",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
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
      const initiativeGain = Math.min(30, Math.floor(totalLacMeter / 50) * 2);
      if (initiativeGain > 0 && attacker) {
        const cap = attacker.initiativeGaugeMax ?? 100;
        attacker.initiativeGauge = Math.min(cap, (attacker.initiativeGauge || 0) + initiativeGain);
      }
      return {
        amount: 0,
        log: initiativeGain > 0
          ? `${attacker?.name || "The axeman"} harvests momentum from ${totalLacMeter} lacerate — gains ${initiativeGain} initiative.`
          : `${attacker?.name || "The axeman"} finds no momentum to harvest yet.`,
      };
    },
    description: "Draws momentum from enemy bleeding: gain 2 Initiative per 50 total enemy Lacerate, up to 30. Does not consume their Lacerate."
  },

  'bloodletting_cleave': {
    id: "bloodletting_cleave",
    name: "Bloodletting Cleave",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["axe_2h"],
    requiredStat: "STR",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lacerate", "aoe"],
    cooldown: 3,
    aoe: { shape: "column", scale: 0.75 },
    buildupHint: { lacerate: 60 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.bloodletting_cleave;
      const roll = calculateDamage(attacker, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 110, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      const baseBuildup = ability?.buildupHint?.lacerate ?? 60;
      // 'disease' — see inferno_arc's comment; this checked the nonexistent
      // 'necrotic' family before (dead condition, fixed during migration).
      const diseaseTier = target?.weakness?.tiers?.disease || 0;
      const splash = resolveAOESplash(scene, target, ability.aoe).map(char => {
        const splashPhysical = Math.floor(physical * 0.75);
        const splashElemental = Math.floor(elemental * 0.75);
        const splashNecrotic = Math.floor(necrotic * 0.75);
        const splashBuildup = { lacerate: baseBuildup };
        if (diseaseTier >= 2) splashBuildup.disease = 80;
        return {
          target: char,
          amount: Math.max(1, splashPhysical + splashElemental + splashNecrotic),
          physical: splashPhysical, elemental: splashElemental, necrotic: splashNecrotic,
          buildup: splashBuildup,
          tags: ability?.tags,
        };
      });
      return {
        ...roll, physical, elemental, necrotic, amount,
        buildup: { lacerate: baseBuildup },
        splash: splash.length ? splash : undefined,
      };
    },
    description: "Deals 110% weapon damage to the primary target and 75% to the rest of their rank, applying 60 Lacerate buildup to each. If the primary target is Plagued (Disease T2+), the rest of the rank also gains 80 Disease buildup."
  },

  'death_blow': {
    id: "death_blow",
    name: "Death Blow",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["axe_2h"],
    requiredStat: "STR",
    requiredValue: 18,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "execute", "consume"],
    cooldown: 8,
    requiresTargetHPPctBelow: 40,
    apply: (attacker, target) => {
      const ability = SKILLS?.death_blow;
      const roll = calculateDamage(attacker, target, ability);
      const expMeter = target?.weakness?.meters?.expose || 0;
      const fireMeter = target?.weakness?.meters?.fire || 0;
      const expConsumed = Math.min(400, expMeter);
      const fireConsumed = Math.min(400, fireMeter);
      const totalConsumed = expConsumed + fireConsumed;
      const bonusPct = Math.floor(totalConsumed / 100) * 15;
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 150 + bonusPct, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      if (target?.weakness?.meters) {
        target.weakness.meters.expose = Math.max(0, expMeter - expConsumed);
        target.weakness.meters.fire = Math.max(0, fireMeter - fireConsumed);
        if (target.weakness.tiers) {
          target.weakness.tiers.expose = weaknessTierFromMeter(target.weakness.meters.expose);
          target.weakness.tiers.fire = weaknessTierFromMeter(target.weakness.meters.fire);
        }
      }
      return {
        ...roll, physical, elemental, necrotic, amount,
        log: `${attacker?.name || "The headsman"} delivers the Death Blow — ${totalConsumed} buildup consumed.`,
      };
    },
    description: "Requires the target to be below 40% HP. Deals 150% weapon damage, plus 15% per 100 combined Expose/Fire buildup consumed (up to 400 of each, +120% max), and consumes that buildup."
  },

  // -------- Generation (elemental / utility) --------
  'ember_cleave': {
    id: "ember_cleave",
    name: "Ember Cleave",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["axe_2h"],
    requiredStat: "STR",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "fire", "elemental", "buildup"],
    cooldown: 2,
    buildupHint: { fire: 80 },
    apply: (attacker, target) => {
      const ability = SKILLS?.ember_cleave;
      const roll = calculateDamage(attacker, target, ability);
      const coldTier = target?.weakness?.tiers?.cold || 0;
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: coldTier >= 1 ? 115 : 100, isCrit: roll.isCrit, critMult: roll.critMult,
          skillConversion: { physToElemPct: 100 },
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      let fireBuildup = ability?.buildupHint?.fire ?? 80;
      if (coldTier >= 1) fireBuildup += 50;
      return { ...roll, physical, elemental, necrotic, amount, isMagic: true, element: "fire", buildup: { fire: fireBuildup } };
    },
    description: "Fiery chop with 80 fire buildup; deals 15% more and gains +50 buildup (130 total) vs chilled/frostbitten foes."
  },

  'rime_chop': {
    id: "rime_chop",
    name: "Rime Chop",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["axe_2h"],
    requiredStat: "CON",
    requiredValue: 12,
    actionCost: "major",
    // Was 0 — brought up to a regular cost matching Ember Cleave's tier
    // (same major/cooldown-2-3 generator shape).
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "cold", "elemental", "buildup", "necrotic"],
    cooldown: 3,
    buildupHint: { cold: 80 },
    apply: (attacker, target) => {
      const ability = SKILLS?.rime_chop;
      const roll = calculateDamage(attacker, target, ability);
      const coldTier = target?.weakness?.tiers?.cold || 0;
      const toNecrotic = coldTier >= 2;
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: toNecrotic ? 130 : 100, isCrit: roll.isCrit, critMult: roll.critMult,
          // Below T2: physical converts to elemental (cold), same as before.
          // At T2: the WHOLE hit converts to necrotic instead of cold.
          skillConversion: toNecrotic
            ? { physToNecroPct: 100, elemToNecroPct: 100 }
            : { physToElemPct: 100 },
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      const buildup = { cold: ability?.buildupHint?.cold ?? 80 };
      if (toNecrotic) {
        // Independent per-family check now — 80 to EACH necrotic-flavored
        // family (Toxic/Disease/Curse) the target already has any presence
        // of, not an escalating count-gated ladder like the old version.
        const toxicMeter  = target?.weakness?.meters?.toxic   || 0;
        const diseaseMeter = target?.weakness?.meters?.disease || 0;
        const curseMeter  = target?.weakness?.meters?.curse   || 0;
        if (toxicMeter > 0) buildup.toxic = 80;
        if (diseaseMeter > 0) buildup.disease = 80;
        if (curseMeter > 0) buildup.curse = 80;
      }
      return { ...roll, physical, elemental, necrotic, amount, isMagic: true, element: toNecrotic ? "necrotic" : "cold", buildup };
    },
    description: "Deals 100% weapon damage as Cold, applying 80 Cold buildup. Vs Frostbitten (Cold T2+), deals 130% instead and the whole hit converts to Necrotic damage — also applying 80 buildup to each of the target's active Toxic/Disease/Curse weaknesses."
  },

  'storm_splitter': {
    id: "storm_splitter",
    name: "Storm Splitter",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["axe_2h"],
    requiredStat: "CHA",
    requiredValue: 12,
    actionCost: "major",
    // Was 0 — brought up to a regular cost, same tier as Ember Cleave/Rime Chop.
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lightning", "elemental", "buildup", "initiative"],
    cooldown: 3,
    buildupHint: { lightning: 80 },
    apply: (attacker, target) => {
      const ability = SKILLS?.storm_splitter;
      const roll = calculateDamage(attacker, target, ability);
      const coldTier = target?.weakness?.tiers?.cold || 0;
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: coldTier >= 1 ? 125 : 100, isCrit: roll.isCrit, critMult: roll.critMult,
          skillConversion: { physToElemPct: 100 },
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      const lightningBuildup = ability?.buildupHint?.lightning ?? 80;
      if (coldTier >= 2 && attacker) {
        const initiativeGain = Math.floor(lightningBuildup / 10);
        const cap = attacker.initiativeGaugeMax ?? 100;
        attacker.initiativeGauge = Math.min(cap, (attacker.initiativeGauge || 0) + initiativeGain);
      }
      return { ...roll, physical, elemental, necrotic, amount, isMagic: true, element: "lightning", buildup: { lightning: lightningBuildup } };
    },
    description: "Deals 100% weapon damage as Lightning, applying 80 Lightning buildup. Deals 125% instead vs Chilled (Cold T1+) foes, and gains 8 initiative vs Frostbitten (Cold T2+)."
  },

  // -------- Payoff (armor shred) --------
  // Axe's curse-rider — deliberately separate from Hexed Cleave, which
  // stays untouched. Boosts each INDIVIDUAL Lightning Jolt roll the cursed
  // target takes (see applyLightningJolt, CombatLogic.js), not a one-time
  // flat add — since Jolt can roll up to 4 times on a single hit at
  // Lightning T2+ with high intensity, this compounds fast by design.
  'curse_of_static': {
    id: "curse_of_static",
    name: "Curse of Static",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["axe_2h"],
    requiredStat: "CHA",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "curse", "necrotic"],
    cooldown: 4,
    requiresWeakness: { family: "curse", tierAtLeast: 1 },
    buildupHint: { curse: 60 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.curse_of_static;
      const roll = calculateDamage(attacker, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 100, skillLabel: `${ability?.name || 'Skill'} weapon damage (100%)`, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      const curseTier = target?.weakness?.tiers?.curse || 0;
      const curseMeter = target?.weakness?.meters?.curse || 0;
      const baseBonus = 1;
      const scaledBonus = curseTier >= 2 ? Math.round(baseBonus * weaknessIntensityMult(curseMeter)) : baseBonus;
      const alreadyCursed = (target.statusEffects || []).some(se => se?.id === 'curse_static');
      if (!alreadyCursed) {
        scene?._addStatusEffects?.(target, [{
          id: "curse_static", name: "Curse of Static", permanent: true,
          joltRollBonus: scaledBonus,
          vfx: { kind: 'debuff_shock' },
        }]);
      }
      return { ...roll, physical, elemental, necrotic, amount, buildup: { curse: 60 } };
    },
    description: "Deals 100% weapon damage and applies 60 Curse buildup. Requires target at least Hexed. Applies a permanent rider: +1 damage to each Lightning Jolt roll against the target (up to +3 at max Curse intensity), compounding with T2's multi-jolt procs."
  },

  'overhead_hew': {
    id: "overhead_hew",
    name: "Overhead Hew",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["axe_2h"],
    requiredStat: "STR",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "debuff", "initiative"],
    cooldown: 4,
    // Spend-tiered like War Cry/Blazing Fervor — auto-picks the highest of
    // 10/20/30 the current gauge can afford, not a player choice. Below the
    // minimum spend tier it has nothing to do, so it fizzles instead of
    // firing for free (checked generically in _applyAbilityToTarget).
    requiresInitiativeGauge: 10,
    apply: (attacker, target) => {
      const ability = SKILLS?.overhead_hew;
      const gauge = attacker?.initiativeGauge || 0;
      const spend = gauge >= 30 ? 30 : gauge >= 20 ? 20 : 10;
      attacker.initiativeGauge = Math.max(0, (attacker.initiativeGauge || 0) - spend);
      const steps = spend / 10;
      const skillPct = 115 + 15 * (steps - 1); // 115 / 130 / 145
      const shredPct = 20 * steps; // 20 / 40 / 60
      const roll = calculateDamage(attacker, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      const statusEffects = [{ id: "shattered_armor", turns: 3, mods: { PhysicalResist: -shredPct }, vfx: { kind: 'debuff_decrease' } }];
      return {
        ...roll, physical, elemental, necrotic, amount, statusEffects,
        log: `${attacker?.name || "The axeman"} cleaves overhead (spent ${spend} initiative) — shatters armor for -${shredPct}% PhysicalResist.`,
      };
    },
    description: "Spend initiative (10/20/30, based on current gauge) for a cleaving blow that scales from 115% to 145% weapon damage, and shatters the target's armor for -20% to -60% PhysicalResist (3 turns), based on how much you spend."
  },

  // Both moved to the very end of the axe block, at the user's request —
  // these are the only two axe skills with a hard requiresWeakness T2 gate
  // (Lacerate T2/Hemorrhaging), so everything above (Rime Chop, Storm
  // Splitter, etc.) is usable from a cold start and these two are true
  // payoffs, gated on state only a few other skills can even set up.
  'hemorrhage_strike': {
    id: "hemorrhage_strike",
    name: "Hemorrhage Strike",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["axe_2h"],
    requiredStat: "STR",
    requiredValue: 18,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "finisher", "consume"],
    cooldown: 5,
    requiresWeakness: { family: "lacerate", tier: 2 },
    apply: (attacker, target) => {
      const ability = SKILLS?.hemorrhage_strike;
      const roll = calculateDamage(attacker, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 120, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      const currentMeter = target?.weakness?.meters?.lacerate || 0;
      const consumed = Math.min(400, currentMeter);
      if (consumed > 0 && target?.weakness?.meters) {
        const remaining = Math.max(0, currentMeter - consumed);
        target.weakness.meters.lacerate = remaining;
        if (target.weakness.tiers) target.weakness.tiers.lacerate = weaknessTierFromMeter(remaining);
      }
      const tickDamage = consumed > 0 ? Math.floor(consumed / 5) : 0;
      const statusEffects = tickDamage > 0 ? [{ id: "hemorrhage_dot", turns: 3, tickDamage }] : undefined;
      return {
        ...roll, physical, elemental, necrotic, amount,
        statusEffects,
        log: consumed > 0 ? `${attacker?.name || "The axeman"} opens a hemorrhage — ${tickDamage} bleed damage per turn for 3 turns.` : undefined,
      };
    },
    description: "Requires the target to be Hemorrhaging (Lacerate T2+). Deals 120% weapon damage and consumes up to 400 of the target's Lacerate buildup, converting it into a bleed that deals (consumed ÷ 5) damage per turn for 3 turns."
  },

  'inferno_arc': {
    id: "inferno_arc",
    name: "Inferno Arc",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["axe_2h"],
    requiredStat: "STR",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "fire", "elemental", "consume", "aoe"],
    // Splash only fires against a Diseased target (see diseaseTier gate in
    // apply); the shape itself is the same same-rank column every other
    // column skill uses.
    aoe: { shape: "column", scale: 0.70 },
    cooldown: 5,
    requiresWeakness: { family: "lacerate", tier: 2 },
    buildupHint: { fire: 80 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.inferno_arc;
      const roll = calculateDamage(attacker, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        {
          ability, tags: ability?.tags, skipGearMultiplier: true,
          skillPct: 110, isCrit: roll.isCrit, critMult: roll.critMult,
          skillConversion: { physToElemPct: 100 },
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      const currentLac = target?.weakness?.meters?.lacerate || 0;
      const consumed = Math.min(400, currentLac);
      if (consumed > 0 && target?.weakness?.meters) {
        target.weakness.meters.lacerate = Math.max(0, currentLac - consumed);
        if (target.weakness.tiers) target.weakness.tiers.lacerate = weaknessTierFromMeter(target.weakness.meters.lacerate);
      }
      const fireBuildup = (ability?.buildupHint?.fire ?? 80) + consumed;
      const splash = [];
      // 'disease' — the family rime_chop's own necrotic-spread mechanic
      // already treats as "the necrotic-flavored family" (there's no family
      // literally named 'necrotic'; this checked that nonexistent key
      // before, so the branch could never fire — fixed during migration).
      const diseaseTier = target?.weakness?.tiers?.disease || 0;
      // Column resolution goes through the shared resolver like every other AOE
      // skill. This used to hand-roll the identical predicate inline (same
      // _getUnitColumn lookup, same alive/not-primary filter) -- a second copy
      // of the same rule that the tooltip couldn't see. Splash is still gated
      // on Disease T1+: the AOE only happens against a diseased target.
      if (diseaseTier >= 1) {
        {
          const splashPhysical = 0;
          const splashElemental = Math.max(1, Math.floor(elemental * 0.7));
          resolveAOESplash(scene, target, ability.aoe)
            .forEach(char => splash.push({
              target: char,
              amount: splashElemental,
              physical: splashPhysical, elemental: splashElemental, necrotic: 0,
              isMagic: true,
              element: "fire",
              buildup: { fire: Math.floor(fireBuildup * 0.6) },
              tags: ability?.tags,
            }));
        }
      }
      return {
        ...roll, physical, elemental, necrotic, amount,
        isMagic: true,
        element: "fire",
        buildup: { fire: fireBuildup },
        splash: splash.length ? splash : undefined,
      };
    },
    description: "Requires the target to be Hemorrhaging (Lacerate T2+). Deals 110% weapon damage as Fire and consumes up to 400 of the target's Lacerate buildup, converting it 1:1 into bonus Fire buildup (up to +400). If the target is also Sickened (Disease T1+), the fire arcs to the rest of their column for 70% of this hit's elemental damage and 60% of the Fire buildup."
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
    buildupHint: { disorient: 100 },
    // Zone: brownish tint (element: 'physical'); enemies standing in it take
    // +63 disorient buildup at the end of their own turn, for 3 turns.
    slotEffect: {
      id: "quake_mark_zone",
      isQuakeZone: true,
      element: "physical",
      tickPctMaxHP: 0.0,
      turns: 3,
      buildupFamilies: { disorient: 63 },
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

      const buildupVal = ability?.buildupHint?.disorient ?? 100;
      // Spread slotEffect from definition so buildupFamilies is preserved
      const slotEffect = ability?.slotEffect ? { ...ability.slotEffect } : undefined;
      return {
        ...roll,
        physical, elemental, necrotic, amount,
        buildup: { disorient: buildupVal },
        slotEffect,
      };
    },
    description: "Deals 90% weapon damage, smashing the ground and applying Disorient on hit. Leaves a trembling zone for 3 turns — enemies standing in it suffer +63 Disorient buildup at the end of their turn."
  },

  // Same formula/shape as Marked Cut (sword_1h) — see Vital Mark's (dagger)
  // comment for the full rationale. Disorient instead of Lacerate here: a
  // heavy blow that cracks the target's guard open, and once it's truly
  // gone, leaves them reeling. Also mace's first Expose-buildup skill —
  // every other mace skill so far builds Disorient/Cold/Disease/Fire/
  // Lightning, never Expose.
  'crushing_mark': {
    id: "crushing_mark",
    name: "Crushing Mark",
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
    tags: ["melee", "attack", "expose"],
    cooldown: 2,
    buildupHint: { expose: 85 },
    rewardIfTierCross: [
      { family: "expose", tier: 1, debuff: { addBuildup: { disorient: 75 } } },
      { family: "expose", tier: 2, debuff: { addBuildup: { disorient: 150 } } },
    ],
    apply: (attacker, target) => {
      const ability = SKILLS?.crushing_mark;
      const roll = calculateDamage(attacker, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 100, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return {
        ...roll,
        physical, elemental, necrotic, amount,
        buildup: { expose: ability?.buildupHint?.expose ?? 85 },
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
      };
    },
    description: "Deals 100% weapon damage. Applies Expose. Crossing a tier leaves them reeling from the blow (bonus Disorient)."
  },

  // Same formula/shape as Marked Cut — see Vital Mark's (dagger) comment for
  // the full rationale. Toxic instead of Disorient/Cold/Disease/Fire/
  // Lightning/Expose (everything else mace already covers): an extension of
  // mace's existing plague/disease motif (Fel Chant, Plague Slam) into a
  // second necrotic-family flavor. No skillConversion — stays a plain
  // physical crush, same as every other mace skill; the buildup carries the
  // Toxic theming, not the damage type. Curse secondary: once the poison
  // truly rots them, it festers into something worse.
  'rotcrusher': {
    id: "rotcrusher",
    name: "Rotcrusher",
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
    tags: ["melee", "attack", "toxic"],
    cooldown: 2,
    buildupHint: { toxic: 85 },
    rewardIfTierCross: [
      { family: "toxic", tier: 1, debuff: { addBuildup: { curse: 75 } } },
      { family: "toxic", tier: 2, debuff: { addBuildup: { curse: 150 } } },
    ],
    apply: (attacker, target) => {
      const ability = SKILLS?.rotcrusher;
      const roll = calculateDamage(attacker, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 100, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return {
        ...roll,
        physical, elemental, necrotic, amount,
        buildup: { toxic: ability?.buildupHint?.toxic ?? 85 },
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
      };
    },
    description: "Deals 100% weapon damage. Applies Toxic. Crossing a tier festers the poison into something worse (bonus Curse)."
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
    // Moved Major → Bonus (cross-weapon balance audit, mace variety pass) —
    // nerfed to 65% (was 100, briefly 80 — bumped down further per
    // follow-up request); Disorient buildup and the tier-cross
    // vulnerability debuff are untouched.
    actionCost: "bonus",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "disorient"],
    cooldown: 2,
    buildupHint: { disorient: 75 },
    // Was `physVulnPct` — didn't match the field CombatScene.js's
    // rewardIfTierCross consumer and the tooltip's buffToText() both actually
    // read (`physicalVulnPct`), so this debuff never applied in combat and
    // never rendered a real number in the tooltip. Renamed to match.
    // Fires on crossing EITHER threshold (Dazed or Concussed), same debuff
    // either way — same pattern as Needle Feint's crit-chance reward.
    rewardIfTierCross: [
      { family: "disorient", tier: 1, debuff: { physicalVulnPct: 15, turns: 2, vfx: { kind: 'debuff_decrease' } } },
      { family: "disorient", tier: 2, debuff: { physicalVulnPct: 15, turns: 2, vfx: { kind: 'debuff_decrease' } } },
    ],
    apply: (attacker, target) => {
      const ability = SKILLS?.ringing_blow;
      const roll = calculateDamage(attacker, target, ability);

      // 100% base + 20% vs a Lacerated (Bleeding+) target — additive into ONE
      // skillPct (Category A: a skill-specific reward for hitting a bleeding target).
      const lacerateTier = target?.weakness?.tiers?.lacerate || 0;
      const bonusPct = lacerateTier >= 1 ? 20 : 0;
      const basePct = 65;

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
        buildup: { disorient: ability?.buildupHint?.disorient ?? 75 },
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
      };
    },
    description: "Deals 65% weapon damage, +20% against a Bleeding (Lacerate) target. Builds Disorient. Crossing either Disorient tier applies a physical vulnerability debuff."
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
          vfx: { kind: 'buff_power' },
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
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "cold", "terrain"],
    emitTagsOnUse: ["smash"],
    cooldown: 3,
    requiresWeakness: { family: "cold", tierAtLeast: 1 },
    buildupHint: { cold: 100 },
    // immobilizes: true — enforced generically, a live check against this
    // zone's own active state at movement-attempt time (_moveUnitToSlot),
    // not a per-turn status grant. elementalVulnPct (below, set only when
    // the Lightning synergy condition is met) works the same way now — see
    // _syncZoneElementalVuln's comment (CombatScene.js) for why this needs
    // to be a continuous, occupancy-based sync rather than a turn-based
    // status grant, matching the description's own wording exactly
    // ("makes anyone standing in it take +20% elemental damage" — no
    // turn-based qualifier, unlike the Cold buildup line right next to it).
    // The zone ALWAYS carries the elemental vulnerability; what is conditional
    // is who it applies to. elementalVulnRequires is re-evaluated per occupant
    // on every sync (_syncZoneElementalVuln), so the +20% lands on whoever is
    // standing here while Zapped and lifts the moment that stops being true.
    slotEffect: {
      id: "frozen_quake_zone", isQuakeZone: true, element: "cold",
      tickPctMaxHP: 0.0, turns: 2, buildupFamilies: { cold: 63 }, immobilizes: true,
      elementalVulnPct: 20,
      elementalVulnRequires: { family: "lightning", tierAtLeast: 1 },
    },
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
      const baseBuildup = ability?.buildupHint?.cold ?? 100;

      // Lightning synergy used to be snapshotted HERE, off the cast-time
      // target's tier, and baked into the zone permanently — so the zone's
      // behaviour depended on someone who might since have died or walked
      // away, and a newly-Zapped occupant got nothing. It is now a property
      // of the zone (elementalVulnRequires) evaluated against whoever is
      // actually standing in it, matching Plague Slam's fire proc and
      // Sanctified Slam's MP payout. Same shape, all three zones.
      const slotEffect = ability?.slotEffect ? { ...ability.slotEffect } : undefined;

      return {
        ...roll,
        physical, elemental, necrotic, amount,
        isMagic: true,
        element: "cold",
        buildup: { cold: baseBuildup },
        slotEffect,
      };
    },
    description: "Requires Cold T1. Deals 95% weapon damage, smashing a frost crack beneath a single foe and leaving a chilling hazard zone for 2 turns. Enemies standing in the zone are immobilized and suffer +63 Cold buildup at the end of their turn. Anyone standing in the zone while Zapped (Lightning T1+) takes +20% elemental damage, checked continuously rather than at cast time."
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
    buildupHint: { disease: 63 },
    // guardDiseaseTierPct scales the guard % by the ATTACKER's own Disease
    // tier (25% vs Diseased/T1, 50% vs Plagued/T2) — implemented generically
    // in _processGuardStatusEffects (CombatScene.js). guardHits limits it to
    // 2 triggers before the buff is consumed.
    // Status effect id also renamed (was iron_chant) — the buff icon system
    // falls back to title-casing the id when there's no STATUS_ICON_LIBRARY
    // entry, so leaving the old id here would've still shown "Iron Chant" on
    // buffed allies even after the skill's own display name changed.
    teamBuff: { scope: "column", effect: { id: "fel_chant", turns: 1, guardDiseaseTierPct: { 1: 25, 2: 50 }, guardHits: 2, retaliateBuildup: { disease: 63 }, vfx: { kind: 'buff_harden' } } },
    apply: () => {
      const ability = SKILLS?.fel_chant;
      const effect = ability?.teamBuff?.effect ? {
        ...ability.teamBuff.effect,
        retaliateBuildup: { disease: ability?.buildupHint?.disease ?? 63 }
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
    buildupHint: { fire: 88 },
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
        buildup: { fire: ability?.buildupHint?.fire ?? 88 },
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
    consumeDisorientForDrain: { maxConsume: 400, drainPctPer100: 6 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.gravity_slam;
      const roll = calculateDamage(attacker, target, ability);

      const meter = target?.weakness?.meters?.disorient || 0;
      const intensity = weaknessIntensityMult(meter) || 1;

      // 160% base (Disorient T2 is required to even cast this now, so no
      // more tier branching) + an overflow bonus (+10% per intensity point
      // above 1.0) — Category A, combined additively. The Disorient
      // consumption below is a pure resource drain, not a damage source.
      const basePct = 160;
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

      // Consume up to 400 Disorient buildup, draining 6% of the target's
      // CURRENT MP per 100 consumed (up to 24% at the cap) — a scaling
      // version of the skill's old flat 20% drain, now tied to how much
      // Disorient is actually available to consume.
      const cfg = ability.consumeDisorientForDrain;
      // Consumes only whole 100-increments (same rule as Toxic Bloom) — a
      // target sitting on 350 only has 300 drained, leaving the leftover 50
      // behind rather than destroying it for no extra drainPct.
      const consumed = Math.min(cfg.maxConsume, Math.floor(meter / 100) * 100);
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
    description: "Requires Concussed (Disorient T2). Deals 160% weapon damage, +10% per intensity point of overflow. Consumes up to 400 Disorient, draining 6% of the target's current MP per 100 consumed (up to 24%). Extends every active quake zone by 1 turn. Spends 20 Initiative."
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
    mpCost: 5,
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
    mpCost: 6,
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
    mpCost: 5,
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
        statusEffects.push({ id: "bell_ringer_rattled", turns: 1, disorientBuildupMul: 1.5, vfx: { kind: 'debuff_confuse' } });
      }

      return {
        ...roll,
        physical, elemental, necrotic, amount,
        statusEffects: statusEffects.length ? statusEffects : undefined,
      };
    },
    description: "Requires Disorient T1+ and Expose T1+. Deals 100% weapon damage, +8% per Disorient tier, plus overflow. Crit multiplier is separately boosted +15% per Expose tier, plus overflow — on top of the universal Expose T2 crit bonus every attack already gets. If this hit crits, the target also takes +50% Disorient buildup for 1 turn."
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
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    // Added 'projectile' — the skill is literally named "Boulder Toss" and
    // already had emitTagsOnUse:['throw'], but that field is never actually
    // read anywhere in the engine (confirmed: 0 consumers across src/,
    // despite 92 skills declaring it — a much bigger dead-field finding,
    // out of scope here, flagged separately). The REAL tag any system
    // checks (ally_projectile_used/Volley, and this skill's own VFX
    // dispatch in CombatScene._playMaceVFX) is `tags`, so a thrown mace
    // skill needs 'projectile' here specifically to actually behave like
    // one — it didn't before this fix.
    tags: ["attack", "blunt", "projectile"],
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
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["attack", "holy", "aoe", "support"],
    emitTagsOnUse: ["smash"],
    cooldown: 4,
    // Diamond: fixed slots {2,4,5,7} — the four centre positions. Cannot be moved.
    aoe: { shape: "diamond", scale: 1.0 },   // uniform: every target takes the same 25%
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
          scene?._addStatusEffects?.(victim, [{ id: "sacred_shockwave_weakened", turns: 2, mods: { AttackPower: -weakenPct }, vfx: { kind: 'debuff_decrease' } }]);
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
          if (hpAfter > hpBefore) scene?._playStatusVFX?.(ally, { kind: 'heal' });
          if (mpAfter > mpBefore) scene?._playStatusVFX?.(ally, { kind: 'mana' });
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
    mpCost: 6,
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
    // Was 0 MP — same "stray leftover test value" issue the buildupHint
    // comment below already flagged once (that was 310, fixed to 50). A
    // Major action that could scale to 190% weapon damage (all three
    // physical weaknesses stacked) with only a 2-turn cooldown had no
    // business being completely free; basic_attack is the one deliberately-
    // 0-MP skill in the game (explicitly documented as an always-available
    // fallback) — this isn't that. Priced to match its cd2 siblings
    // (Ringing Blow/Concussive Drain at mp3, Crushing Mark/Rotcrusher at
    // mp4). Also moved Major → Bonus (cross-weapon balance audit, mace
    // variety pass) with a base-damage nerf (100%→65%, briefly 80 —
    // bumped down further per follow-up request) — the per-family
    // scaling bonuses are untouched.
    actionCost: "bonus",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "blunt", "disorient"],
    cooldown: 2,
    // Was 310 — a stray leftover test value (every other mace skill's
    // buildupHint sits in the 40-100 range, and this is the free/basic-tier
    // poke, so it should be at the low end, not far above the paid skills).
    buildupHint: { disorient: 50 },
    apply: (attacker, target) => {
      const ability = SKILLS?.bonecrusher;
      const roll = calculateDamage(attacker, target, ability);

      // Rewards each physical weakness family the target already carries —
      // +30% for Bleeding (Lacerate T1+), +30% for Raw (Expose T1+), +30%
      // for Dazed (Disorient T1+). Combines additively into ONE skillPct
      // (Category A bonuses), so a target weak from all three sits at
      // 65% + 30% + 30% + 30% = 155% weapon damage.
      const tiers = target?.weakness?.tiers || {};
      let skillPct = 65;
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
        buildup: { disorient: ability?.buildupHint?.disorient ?? 50 },
      };
    },
    description: "Deals 65% weapon damage, +30% each against a Bleeding (Lacerate), Raw (Expose), or Dazed (Disorient) target — up to 155% against a foe weak from all three. Builds Disorient."
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
    buildupHint: { disease: 100 },
    // Zone: enemies standing in it take +63 Disease buildup at the end of
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
      buildupFamilies: { disease: 63 },
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

      const buildupVal = ability?.buildupHint?.disease ?? 100;
      const slotEffect = ability?.slotEffect ? { ...ability.slotEffect } : undefined;
      return {
        ...roll,
        physical, elemental, necrotic, amount,
        buildup: { disease: buildupVal },
        slotEffect,
      };
    },
    description: "Deals 90% weapon damage, smashing the ground and applying Disease on hit. Leaves a festering zone for 3 turns — enemies standing in it suffer +63 Disease buildup at the end of their turn. If an occupant is Ablaze (Fire T2), they also combust for 2 per 100 Disease buildup, scaled by their Fire intensity — read live when the zone triggers."
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
    mpCost: 4,
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
    buildupHint: { lightning: 50 },
    // The zone is now spawned UNCONDITIONALLY — consecrating the ground is
    // what the slam does. What used to gate the zone's existence (target at
    // Lightning T1+) instead gates its PAYOUT, via onHitMpRequires below:
    // anyone hitting a target standing here gets the MP only while that
    // target is Zapped. Reads more intuitively than "the slam sometimes
    // leaves no ground at all", and means the ground is worth placing before
    // the buildup has landed rather than only after.
    slotEffect: {
      id: "sanctified_quake_zone",
      isQuakeZone: true,
      element: "lightning",
      tickPctMaxHP: 0.0,
      turns: 2,
      onHitMpGain: 2,
      // Declarative, not hardcoded to lightning in the engine — any future
      // zone can gate its MP payout on any weakness family/tier.
      onHitMpRequires: { family: "lightning", tierAtLeast: 1 },
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

      // Always consecrate the tile — the Lightning gate lives on the zone's
      // MP payout now (slotEffect.onHitMpRequires), not on whether the zone
      // gets created at all.
      const slotEffect = ability?.slotEffect ? { ...ability.slotEffect } : undefined;
      return {
        ...roll,
        physical, elemental, necrotic, amount,
        buildup: { lightning: ability?.buildupHint?.lightning ?? 50 },
        slotEffect,
      };
    },
    description: "Deals 100% weapon damage, +15% against a Zapped (Lightning T1+) target. Always consecrates the tile for 2 turns — attackers hitting an enemy standing on it gain 2 MP per strike, but only while that enemy is Zapped (Lightning T1+)."
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
    // Already fizzled correctly from inside apply(); declaring it here as well
    // is what lets the Usable filter hide it before it is ever clicked.
    canExecute: ({ scene }) => Object.values(scene?.slotEffects || {})
      .some(arr => (arr || []).some(e => e?.isQuakeZone && (e.turns || 0) > 0))
      ? true
      : { ok: false, reason: 'No active quake zones.' },
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
        scene?._playStatusVFX?.(attacker, { kind: 'mana' });
      }

      return {
        amount: 0,
        log: mpGain > 0
          ? `${attacker?.name || "The warrior"} draws on ${enemiesHit.size} enem${enemiesHit.size === 1 ? "y" : "ies"} caught in active quake zones, restoring ${mpGain} MP.`
          : `${attacker?.name || "The warrior"} triggers the active quake zones, but no enemies are caught in them.`,
      };
    },
    description: "Requires at least one active Quake zone. Triggers the effect of every active Quake zone on whoever's standing in it (including Hallowed Ground's healing on an ally), without using up any of their remaining duration. Restores 5 MP per distinct ENEMY caught in a zone — allies don't grant MP."
  },

  // Mace's healing skill — a real quake zone (isQuakeZone:true), same
  // family as Quake Mark/Fault Line/etc., just planted on an ally's own
  // tile instead of an enemy's and carrying no damage/buildup of its own.
  // Being a real quake zone means Tremor Echo already triggers it for free
  // (that skill's own enemiesHit tally only ever counts opposite-side
  // occupants toward its MP reward, so an ally standing in this zone gets
  // the heal/buildup-ease without granting any MP — no extra code needed
  // for that, it falls out of Tremor Echo's existing side-check). Earthshatter
  // can never touch it either way — that skill is enemy-only targeting.
  'hallowed_ground': {
    id: "hallowed_ground",
    name: "Hallowed Ground",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    requiredWeapon: ["mace_2h"],
    requiredStat: "WIS",
    requiredValue: 13,
    actionCost: "bonus",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "ally",
    tags: ["support", "heal", "terrain"],
    cooldown: 4,
    slotEffect: {
      id: "hallowed_ground_zone",
      isQuakeZone: true,
      element: "holy",
      turns: 3,
      tickPctMaxHP: 0,
      reduceAllBuildupBy: 20,
    },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.hallowed_ground;
      // Same heal pipeline as Restoration Light — computed once now with
      // the caster's own stats, baked into the zone as a flat per-tick
      // amount (same "compute once, reference later" convention the lodge
      // baseDamage/baseHeal fields use), not recomputed at tick time.
      const roll = calculateHealRoll(attacker, ability);
      const healFlat = Math.max(1, applyHealModifiers(roll.amount, attacker, {
        ability, skillPct: 50,
        skillLabel: `${ability?.name || 'Skill'} zone healing (50%)`,
        isCrit: roll.isCrit, critMult: roll.critMult,
      }));
      const slotEffect = ability?.slotEffect ? { ...ability.slotEffect, healFlat } : undefined;
      return {
        amount: 0,
        slotEffect,
        log: `${attacker?.name || "The cleric"} sanctifies the ground beneath ${target?.name || "an ally"}.`,
      };
    },
    description: "Bonus: sanctify the ground beneath an ally for 3 turns. At the end of each of their turns standing in it, they heal a flat amount and lose 20 of every active weakness buildup."
  },

  // Mace's curse-rider — bumped to a 30% base (vs. 20% on the other four)
  // and spread across the whole physical family (Expose/Lacerate/Disorient
  // together via the generic <family>BuildupMul mechanism, the same one
  // Bell Ringer's disorientBuildupMul/Shattering Cut's lacerateBuildupMul
  // already use) rather than a single-stat mods debuff.
  'curse_of_pendulums': {
    id: "curse_of_pendulums",
    name: "Curse of Pendulums",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["mace_2h"],
    requiredStat: "CHA",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "curse", "necrotic"],
    cooldown: 4,
    requiresWeakness: { family: "curse", tierAtLeast: 1 },
    buildupHint: { curse: 60 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.curse_of_pendulums;
      const roll = calculateDamage(attacker, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 100, skillLabel: `${ability?.name || 'Skill'} weapon damage (100%)`, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      const curseTier = target?.weakness?.tiers?.curse || 0;
      const curseMeter = target?.weakness?.meters?.curse || 0;
      const basePct = 30;
      const scaledPct = curseTier >= 2 ? Math.round(basePct * weaknessIntensityMult(curseMeter)) : basePct;
      const mul = 1 + scaledPct / 100;
      const alreadyCursed = (target.statusEffects || []).some(se => se?.id === 'curse_of_pendulums');
      if (!alreadyCursed) {
        scene?._addStatusEffects?.(target, [{
          id: "curse_of_pendulums", name: "Curse of Pendulums", permanent: true,
          exposeBuildupMul: mul, lacerateBuildupMul: mul, disorientBuildupMul: mul,
          vfx: { kind: 'debuff_decrease' },
        }]);
      }
      return { ...roll, physical, elemental, necrotic, amount, buildup: { curse: 60 } };
    },
    description: "Deals 100% weapon damage and applies 60 Curse buildup. Requires target at least Hexed. Applies a permanent rider: +30% Expose/Lacerate/Disorient buildup taken, scaling up to +75% at max Curse intensity."
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
    // Moved Major → Bonus (cross-weapon balance audit, mace variety pass) —
    // nerfed to 65% (was 100, briefly 80 — bumped down further per
    // follow-up request); MP restore/Disorient buildup untouched.
    actionCost: "bonus",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "disorient"],
    emitTagsOnUse: ["smash"],
    cooldown: 2,
    buildupHint: { disorient: 100 },
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
          skillPct: 65, skillLabel: `${ability?.name || 'Skill'} weapon damage (65%)`,
          isCrit: roll.isCrit, critMult: roll.critMult,
        }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return {
        ...roll,
        physical, elemental, necrotic, amount,
        buildup: { disorient: ability?.buildupHint?.disorient ?? 100 },
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
      };
    },
    description: "Deals 65% weapon damage, saps mental coherence. Restores 2 MP on pushing a foe to Disorient T1, and 4 MP on T2 (both fire if a single hit skips straight past T1)."
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
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["bow"],
    requiredStat: "DEX",
    requiredValue: 10,
    actionCost: "bonus",
    mpCost: 3,
    cooldown: 1,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["ranged", "attack", "projectile", "lodge"],
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.lodge_arrow;
      const roll = calculateDamage(attacker, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 75, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      // `amount` here IS the real, actual raw damage this hit deals — post
      // skillPct, post crit, post AttackPower buffs — pre-target-mitigation
      // (that happens later, generically, in CombatScene.js) and pre any
      // Tier-3 riders like Lightning Jolt (also added later, by the engine,
      // AFTER this function returns — so it's automatically excluded here,
      // nothing to manually subtract).
      const amount = Math.max(1, physical + elemental + necrotic);

      // The lodge banks 70% of THAT real number — not a separately
      // recomputed roll. If this cast crits or a buff is active, the lodge
      // is bigger too; it's simply a fraction of whatever actually landed.
      // Kept as a direct statusEffects.push (not _addStatusEffects) since
      // multiple lodges must each stay their own entry with their own
      // baseDamage/scalingBonus — same convention every other lodge-
      // generating skill (Barbed Shaft, etc.) already uses; dislodgeLodges
      // (top of this file) reads them generically, re-mitigated against
      // the target's CURRENT resistances only once it's actually popped.
      const baseDamage = Math.max(1, Math.floor(amount * 0.70));

      // Deferred to onHitLanded (only runs if this shot's own hit-roll
      // actually connects) — pushing the lodge here unconditionally meant a
      // MISSED Lodge Arrow still stuck an arrow in the target for real.
      const onHitLanded = () => {
        target.statusEffects = target.statusEffects || [];
        // stackable:true is purely a DISPLAY grouping flag, read only by
        // combineStatusEffects (statusEffectIcons.js) to collapse same-id
        // entries into one icon with an "x{count}" badge — it does NOT affect
        // this raw push or dislodgeLodges' own per-entry accounting, which
        // still reads each lodge's own baseDamage/scalingBonus individually.
        // Without it, every stacked lodge rendered as its own separate icon.
        target.statusEffects.push({ id: 'lodged', baseDamage, scalingBonus: 0.10, stackable: true });
        const lodgeCount = target.statusEffects.filter(se => se?.id === 'lodged').length;

        // Draw the actual arrow sprite (fx_lodge_arrow) stuck in the target —
        // _refreshLodgeSprites already existed and already handles staggering
        // multiple arrows around the portrait with a jittered angle/radius,
        // but it was previously only ever called from the DISLODGE side
        // (dislodgeLodges, on remove) — nothing called it on ADD, so no arrow
        // ever actually appeared when a lodge landed. Generic for any
        // lodge-count on this character, not bow-specific.
        scene?._refreshLodgeSprites?.(target);

        return {
          log: `${attacker?.name ?? 'Archer'} lodges an arrow in ${target?.name ?? 'the target'} (${lodgeCount} lodge${lodgeCount !== 1 ? 's' : ''}).`,
        };
      };

      return { ...roll, physical, elemental, necrotic, amount, onHitLanded };
    },
    description: "Deals 75% weapon damage. Lodges an arrow worth 70% of the damage dealt — +10% more per additional lodge already on the target when it's eventually dislodged."
  },

  'frost_pin': {
    id: "frost_pin",
    name: "Frost Pin",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["bow"],
    requiredStat: "WIS",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 4,
    cooldown: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["ranged", "attack", "projectile", "cold"],
    // Flat {family: amount} shape — the OLD {family:"cold", amount:80} shape
    // rendered as garbage in the tooltip (skillTooltip.js does
    // Object.entries(buildupHint), which expects the family name as the KEY).
    buildupHint: { cold: 80 },
    apply: (attacker, target) => {
      const ability = SKILLS?.frost_pin;
      // Bonus scales off the target's EXISTING Cold tier, checked BEFORE
      // this hit's own buildup below is applied — not a self-predicted
      // "would MY buildup cross a new tier" check like the old version had
      // (the exact self-predicted-crossing bug rewardIfTierCross exists to
      // avoid elsewhere, e.g. Marked Cut). rewardIfTierCross itself doesn't
      // fit here though — that engine grants a SEPARATE bonus reward after
      // a real post-buildup tier snapshot, it can't retroactively amplify
      // the CURRENT hit's own damage. Reading the pre-existing tier instead
      // sidesteps prediction entirely, same idea as the Thermal Shock check
      // on fire_burst/ice_freeze_point.
      const coldTier = target?.weakness?.tiers?.cold || 0;
      let skillPct = 100;
      if (coldTier >= 1) skillPct = 125;
      if (coldTier >= 2) skillPct = 175; // T1 +25%, T2 an ADDITIONAL +50% on top

      const roll = calculateDamage(attacker, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct, skillLabel: `${ability?.name || 'Skill'} weapon damage (${skillPct}%)`, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      // Lightning T2 (Shocked): 50% chance to repeat this hit at 50% damage —
      // expected value is repeatChance × repeatScale = 0.25, a 25% average
      // damage increase while Shocked, matching Boulder Toss's own identical
      // Shocked-repeat numbers (same generic repeatChance/repeatScale
      // mechanism, handled centrally by the engine; nothing else to wire up
      // here). Was left as a 10%/50% TODO placeholder originally (only a 5%
      // average increase); tuned to the requested 25%.
      const lightningTier = target?.weakness?.tiers?.lightning || 0;
      const repeatChance = lightningTier >= 2 ? 0.50 : 0;

      return {
        ...roll, physical, elemental, necrotic, amount,
        buildup: { cold: 80 },
        repeatChance, repeatScale: 0.5,
      };
    },
    description: "Deals 100% weapon damage (125% vs a Chilled target, 175% vs Frostbitten). Applies Cold. 50% chance to repeat at 50% damage if the target is Shocked (Lightning T2) — a 25% average damage increase while Shocked."
  },

  // Same underlying shape as sword_1h/dagger/staff/mace_2h's own pairs
  // (e.g. sword_1h's Marked Cut/Storm Cut, dagger's Vital Mark/Ember
  // Strike): weapon damage + a primary family's buildup, and a BONUS
  // buildup in a SECOND family on actually crossing a tier of the first —
  // via the generic rewardIfTierCross engine (real post-buildup tier
  // snapshot, not a self-predicted guess, unlike Frost Pin above, which
  // still has the old self-predicted-crossing bug those other weapons'
  // pairs were built specifically to avoid). Disorient primary: bow had no
  // Disorient-buildup skill yet. Stays pure physical damage (no
  // skillConversion) — same convention as every other weapon's pair below
  // a magic-only weapon type (staff); a blunt/concussive arrowhead, not a
  // spell.
  'staggering_point': {
    id: "staggering_point",
    name: "Staggering Point",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["bow"],
    requiredStat: "DEX",
    requiredValue: 12,
    // Moved Major → Bonus (cross-weapon balance audit, bow variety pass) —
    // damage nerfed 100%→65% to offset the action-economy gain; the
    // Disorient buildup and tier-cross Expose reward are untouched.
    actionCost: "bonus",
    mpCost: 4,
    cooldown: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["ranged", "attack", "projectile", "disorient"],
    buildupHint: { disorient: 85 },
    rewardIfTierCross: [
      { family: "disorient", tier: 1, debuff: { addBuildup: { expose: 75 } } },
      { family: "disorient", tier: 2, debuff: { addBuildup: { expose: 150 } } },
    ],
    apply: (attacker, target) => {
      const ability = SKILLS?.staggering_point;
      const roll = calculateDamage(attacker, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 65, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return {
        ...roll,
        physical, elemental, necrotic, amount,
        buildup: { disorient: ability?.buildupHint?.disorient ?? 85 },
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
      };
    },
    description: "Deals 65% weapon damage. Applies Disorient. Crossing a tier also opens the target's guard (bonus Expose)."
  },

  // Same shape as Staggering Point above. Curse primary: bow had no
  // Curse-buildup skill yet — a hunter's old ritual arrowhead, marked for
  // something worse than a clean kill. Toxic secondary hasn't been used as
  // a REWARD family anywhere else yet either (only ever a primary), fitting
  // the "the curse festers into poison" idea.
  'hexpoint_arrow': {
    id: "hexpoint_arrow",
    name: "Hexpoint Arrow",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["bow"],
    requiredStat: "DEX",
    requiredValue: 13,
    actionCost: "major",
    mpCost: 4,
    cooldown: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["ranged", "attack", "projectile", "curse"],
    buildupHint: { curse: 85 },
    rewardIfTierCross: [
      { family: "curse", tier: 1, debuff: { addBuildup: { toxic: 75 } } },
      { family: "curse", tier: 2, debuff: { addBuildup: { toxic: 150 } } },
    ],
    apply: (attacker, target) => {
      const ability = SKILLS?.hexpoint_arrow;
      const roll = calculateDamage(attacker, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 100, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return {
        ...roll,
        physical, elemental, necrotic, amount,
        buildup: { curse: ability?.buildupHint?.curse ?? 85 },
        rewardIfTierCross: cloneRewardList(ability?.rewardIfTierCross),
      };
    },
    description: "Deals 100% weapon damage. Applies Curse. Crossing a tier also festers into sickness (bonus Toxic)."
  },

  // Simplified from the original "copy and refire the ally's own skill"
  // design (too complex to balance) — now a flat, self-contained payoff:
  // once armed, the next time ANY ally lands ANY 'projectile'-tagged skill
  // (not weapon-restricted — the trigger below already just checks the tag,
  // see CombatScene.js's ally_projectile_used emission — bow, sling, and
  // now dagger's Dagger Throw and staff's Arcane Needle all qualify), this
  // archer fires 2 arrows of their own at that ally's target, each at 35%
  // weapon damage with 50 buildup to a random PHYSICAL weakness family.
  // Wired through the engine's 'ally_projectile_used' bus event
  // (CombatScene.js) + ReactionSystem._onAllyProjectileUsed, a friendly-
  // side counterpart to the hostile-only self_hit/ally_hit pair.
  'volley': {
    id: "volley",
    name: "Volley",
    type: "weapon",
    mechanic: "reaction",
    versionTag: "v3.23",
    requiredWeapon: ["bow"],
    requiredStat: "DEX",
    requiredValue: 14,
    actionCost: "bonus",
    mpCost: 5,
    cooldown: 5,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["support", "reaction"],
    apply: (attacker) => {
      return { armReaction: true, consumeOn: 'trigger', log: `${attacker?.name ?? 'Archer'} readies Volley.` };
    },
    reaction: {
      trigger: 'ally_projectile_used',
      cooldownOn: 'trigger',
      exec: ({ owner, target, scene }) => {
        if (!owner || !target) return;
        const arrow = SKILLS?.volley_arrow;
        if (!arrow) return;
        scene?._log?.(`${owner.name} looses Volley — two arrows streak toward ${target.name}!`);
        const fire = () => {
          if (!owner || owner.status === 'incapacitated') return;
          if (!target || target.status === 'incapacitated') return;
          scene._applyAbilityToTarget(owner, target, arrow, { isReaction: true, tags: arrow.tags || [] });
        };
        scene.time?.delayedCall(50, fire);
        scene.time?.delayedCall(150, fire);
      },
    },
    description: "Bonus: ready Volley. The next time an ally lands any projectile skill, fire 2 arrows at their target — each dealing 35% weapon damage and applying 50 buildup to a random physical weakness (Expose/Lacerate/Disorient)."
  },

  // Not player-selectable (no entry in any class's skill list) — purely the
  // per-arrow payload Volley's reaction.exec fires twice. Kept as its own
  // skill (rather than reusing volley's own `apply`) because `apply` is
  // already spoken for by the arming cast (returns { armReaction:true }) —
  // same reason Cover Strike/Riposte fire `basic_attack` instead of
  // themselves from their own exec().
  'volley_arrow': {
    id: "volley_arrow",
    name: "Volley",
    type: "weapon",
    // Not player-selectable — see the comment on this entry above. Without
    // this, getWeaponSkillsFor's blanket type:'weapon' scan (gated only on
    // enemyOnly/disabled/stat/weapon-requirement, none of which this skill
    // sets) surfaced it in the Weapon Skills menu under the name "Volley",
    // reading as if the reaction itself had leaked into the wrong submenu.
    hidden: true,
    typedDamage: true,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["ranged", "attack"],
    apply: (attacker, target) => {
      const ability = SKILLS?.volley_arrow;
      const roll = calculateDamage(attacker, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        { ability, tags: ability?.tags, skillPct: 35, skillLabel: `${ability?.name || 'Volley'} weapon damage (35%)`, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      const physicalFamilies = ['expose', 'lacerate', 'disorient'];
      const fam = physicalFamilies[Math.floor(Math.random() * physicalFamilies.length)];
      return { ...roll, physical, elemental, necrotic, amount, buildup: { [fam]: 50 } };
    },
    description: "Deals 35% weapon damage and applies 50 buildup to a random physical weakness (Expose/Lacerate/Disorient)."
  },

  'hunters_mark': {
    id: "hunters_mark",
    name: "Hunter's Mark",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    requiredWeapon: ["bow"],
    requiredStat: "WIS",
    requiredValue: 13,
    actionCost: "bonus",
    mpCost: 4,
    cooldown: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["support", "mark"],
    apply: (attacker, target, scene) => {
      scene?._addStatusEffects?.(target, [{ id: 'hunters_mark', turns: 2, mods: { BuildupReceived: 50, LodgeDamage: 25 }, vfx: { kind: 'debuff_weak' } }]);
      return {
        amount: 0,
        log: `${attacker?.name ?? 'Archer'} marks ${target?.name ?? 'the target'} — +50% buildup received, +25% lodge damage.`,
      };
    },
    // Both mods confirmed wired and read live: BuildupReceived by
    // _applyWeaknessBuildup (CombatScene.js), LodgeDamage by dislodgeLodges
    // (top of this file — was hardcoded to a flat 1.25 ignoring this field
    // entirely until now). Previous description's "BuildupReceived: TODO"
    // was stale — that part was already working, just never noted as such.
    description: "Bonus: marks the target for 2 turns — all buildup it receives is increased 50%, and any lodge dislodged from it deals 25% more damage."
  },

  'barbed_shaft': {
    id: "barbed_shaft",
    name: "Barbed Shaft",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    requiredWeapon: ["bow"],
    requiredStat: "DEX",
    requiredValue: 12,
    // Moved Major → Bonus (cross-weapon balance audit, bow variety pass) —
    // was already a lighter 75% base (a "quick tag" skill by design), nerfed
    // further to 50% to offset the action-economy gain; the lodge/dislodge
    // payoff (25% of the real computed hit, scaling with other lodges
    // present) is untouched and scales down proportionally on its own.
    actionCost: "bonus",
    mpCost: 4,
    cooldown: 2,
    typedDamage: true,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["ranged", "attack", "projectile", "lodge", "lacerate"],
    apply: (attacker, target, scene) => {
      // No lodge prerequisite — functions the same way Lodge Arrow does
      // (immediate hit + places its own lodge), not a "consume an existing
      // lodge" finisher like Piercing Release.
      const ability = SKILLS?.barbed_shaft;
      const roll = calculateDamage(attacker, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        { ability, tags: ability?.tags, skillPct: 50, skillLabel: `${ability?.name || 'Skill'} weapon damage (50%)`, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      // Banks 25% of the REAL, already-computed hit (post skillPct/crit/buffs)
      // — same "no separate recompute" philosophy Lodge Arrow's own final
      // design uses (see its comments above), applied consistently here.
      const baseDamage = Math.max(1, Math.floor(amount * 0.25));

      // Deferred to onHitLanded (only runs if this shot's own hit-roll
      // actually connects) — same fix as Lodge Arrow's identical bug: pushing
      // the lodge unconditionally meant a MISSED Barbed Shaft still stuck one
      // in the target for real.
      const onHitLanded = () => {
        target.statusEffects.push({
          id: 'lodged', baseDamage,
          // buildupOnDislodge/buildupScalingBonus: generic dislodgeLodges
          // fields (any family, not just lacerate) — +10% per OTHER lodge
          // present at dislodge time (any type — Lodge Arrow lodges count
          // too, dislodgeLodges' totalLodges is a mixed count), same
          // convention/magnitude as baseDamage's own scalingBonus elsewhere.
          // The raw amount dislodgeLodges returns is NOT mark-amplified
          // there — it flows through THIS skill's own result.buildup like
          // any other buildup source, so Hunter's Mark's BuildupReceived%
          // mod applies to it automatically and generically
          // (_applyWeaknessBuildup, CombatScene.js) with no special-casing needed.
          buildupOnDislodge: { family: 'lacerate', amount: 100 },
          buildupScalingBonus: 0.10,
          stackable: true,
          // Deep red hue — visually distinguishes a barbed lodge from a plain
          // Lodge Arrow one on the portrait (see _refreshLodgeSprites,
          // CombatScene.js, which reads this generically for any lodge).
          tint: 0xaa2020,
        });
        // fx_lodge_arrow was never drawn on ADD for this skill either (same gap
        // Lodge Arrow had before its own fix) — refreshed here now too.
        scene?._refreshLodgeSprites?.(target);
        const lodgeCount = target.statusEffects.filter(se => se?.id === 'lodged').length;
        return {
          log: `${attacker?.name ?? 'Archer'} drives a barbed shaft in (${lodgeCount} lodge${lodgeCount !== 1 ? 's' : ''} on target).`,
        };
      };

      return { ...roll, physical, elemental, necrotic, amount, onHitLanded };
    },
    description: "Deals 50% weapon damage and drives in a barbed lodge worth 25% of that damage. When eventually dislodged, it applies 100 Lacerate buildup — +10% more per other lodge on the target at that moment."
  },

  // Bow's healing skill — an ally-targeted lodge (a first for the family;
  // every other lodge goes on an enemy). Uses the new baseHeal/
  // healScalingBonus pair on dislodgeLodges (symmetric to baseDamage/
  // scalingBonus) and the new healOnCrit marker _processTargetHitRiders
  // reads generically: when the wearer takes a crit, EVERY stacked lodge
  // pops at once, each one's own healScalingBonus reading off the total
  // lodge count present — same "more stacked = bigger combined payoff"
  // shape the damage lodges already have, just for a heal instead.
  'mending_barb': {
    id: "mending_barb",
    name: "Mending Barb",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    requiredWeapon: ["bow"],
    requiredStat: "WIS",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 3,
    cooldown: 2,
    requiresTarget: true,
    targetRequirement: "ally",
    tags: ["support", "heal", "lodge"],
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.mending_barb;
      // Real heal pipeline (calculateHealRoll/applyHealModifiers, same as
      // Restoration Light) — computed once now with the caster's own
      // stats/gear/Proficiency, then baked into the lodge exactly like
      // baseDamage is on every other lodge, not recomputed at pop time.
      const roll = calculateHealRoll(attacker, ability);
      const baseHeal = Math.max(1, applyHealModifiers(roll.amount, attacker, {
        ability, skillPct: 40,
        skillLabel: `${ability?.name || 'Skill'} lodge healing (40%)`,
        isCrit: roll.isCrit, critMult: roll.critMult,
      }));

      target.statusEffects = target.statusEffects || [];
      target.statusEffects.push({
        id: 'lodged', baseHeal, healScalingBonus: 0.10, healOnCrit: true, stackable: true,
        // Soft blue-white hue — visually distinct from a damage lodge's
        // reds/golds on the portrait (see _refreshLodgeSprites).
        tint: 0x9fd6ff,
      });
      scene?._refreshLodgeSprites?.(target);
      const lodgeCount = target.statusEffects.filter(se => se?.id === 'lodged').length;
      return {
        amount: 0,
        log: `${attacker?.name ?? 'Archer'} lodges a mending barb in ${target?.name ?? 'the ally'} (${lodgeCount} lodge${lodgeCount !== 1 ? 's' : ''}).`,
      };
    },
    description: "Bonus: lodge a mending barb in an ally. The next time they take a critical hit, every mending barb on them bursts at once, healing them — each one's own payout growing 10% per OTHER lodge (of any kind) present."
  },

  // Same shape as Barbed Shaft, re-themed to Lightning — a charged
  // arrowhead instead of a barbed one. Uses the same generic
  // buildupOnDislodge/buildupScalingBonus fields dislodgeLodges reads for
  // ANY family, so this needed zero engine changes beyond what Barbed
  // Shaft's own conversion already generalized.
  'storm_barb': {
    id: "storm_barb",
    name: "Storm Barb",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    requiredWeapon: ["bow"],
    requiredStat: "DEX",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 4,
    cooldown: 2,
    typedDamage: true,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["ranged", "attack", "projectile", "lodge", "lightning"],
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.storm_barb;
      const roll = calculateDamage(attacker, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        { ability, tags: ability?.tags, skillPct: 75, skillLabel: `${ability?.name || 'Skill'} weapon damage (75%)`, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      const baseDamage = Math.max(1, Math.floor(amount * 0.25));

      // Deferred to onHitLanded (only runs if this shot's own hit-roll
      // actually connects) — same fix as Lodge Arrow/Barbed Shaft's
      // identical bug: pushing the lodge unconditionally meant a MISSED
      // shot still stuck one in the target for real.
      const onHitLanded = () => {
        target.statusEffects.push({
          id: 'lodged', baseDamage,
          buildupOnDislodge: { family: 'lightning', amount: 100 },
          buildupScalingBonus: 0.10,
          stackable: true,
          // Gold hue — visually distinguishes a storm barb from a plain
          // Lodge Arrow (untinted) or a Barbed Shaft (deep red) lodge on
          // the portrait (see _refreshLodgeSprites, CombatScene.js).
          tint: 0xe6c447,
        });
        scene?._refreshLodgeSprites?.(target);
        const lodgeCount = target.statusEffects.filter(se => se?.id === 'lodged').length;
        return {
          log: `${attacker?.name ?? 'Archer'} drives a storm barb in (${lodgeCount} lodge${lodgeCount !== 1 ? 's' : ''} on target).`,
        };
      };

      return { ...roll, physical, elemental, necrotic, amount, onHitLanded };
    },
    description: "Deals 75% weapon damage and drives in a charged lodge worth 25% of that damage. When eventually dislodged, it applies 100 Lightning buildup — +10% more per other lodge on the target at that moment."
  },

  'snipe_pose': {
    id: "snipe_pose",
    name: "Snipe Pose",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    requiredWeapon: ["bow"],
    requiredStat: "INT",
    requiredValue: 13,
    actionCost: "bonus",
    mpCost: 4,
    cooldown: 3,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["support", "buff", "expose"],
    apply: (attacker, _target, scene) => {
      // mods.AttackPower (not a bespoke bonusDmgPct field) so this reads
      // through the SAME generic Category-A pool applyDamageModifiers/
      // applyTypedDamageModifiers already sum every active AttackPower
      // source into (Rhythm, War Cry, etc. — see CombatLogic.js's "Combat
      // buffs (Category A)" step, comment: "two +20% buffs = +40% total, not
      // 1.2×1.2"). This makes it combine ADDITIVELY with Rhythm instead of
      // multiplying on top of an already-fully-buffed number, and it makes
      // the bonus show up in the damage tooltip's own "Generic increased
      // damage" breakdown line — same one Rhythm already produces — for
      // free, with no separate tooltip wiring needed.
      scene?._addStatusEffects?.(attacker, [{ id: 'snipe_pose', turns: 1, mods: { AttackPower: 50 }, exposeBuildup: 80, vfx: { kind: 'buff_power' } }]);
      return {
        amount: 0,
        log: `${attacker?.name ?? 'Archer'} takes careful aim — next attack +50% increased damage and +80 expose.`,
      };
    },
    description: "Bonus: take aim. Your next attack deals 50% increased damage and applies 80 extra Expose buildup."
  },

  'scavenge_arrows': {
    id: "scavenge_arrows",
    name: "Scavenge Arrows",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    requiredWeapon: ["bow"],
    requiredStat: "DEX",
    requiredValue: 11,
    actionCost: "free",
    mpCost: 0,
    cooldown: 3,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["support", "mana"],
    vfxHint: { kind: 'mana' },
    // Declarative form of the same gate apply() enforces below. This is what
    // makes the "Usable" pill hide the skill when there is nothing to pick up:
    // the filter runs _skillIsUsable -> _abilityActorGateReason, which routes
    // canExecute for any skill with requiresTarget:false. The apply() check
    // stays as the real enforcement (NPCLogic reaches apply directly).
    canExecute: ({ scene }) => (
      (scene?.lodgesDislodgedThisTurn || 0) > 0
        ? true
        : { ok: false, reason: 'no lodges dislodged this turn' }
    ),
    apply: (attacker, _target, scene) => {
      const count = scene?.lodgesDislodgedThisTurn || 0;
      if (count === 0) {
        // fizzle:true — was missing before, so failing this gate (can't be a
        // declarative field, it reads scene state) still burned the 3-turn
        // cooldown for a free skill that did nothing. Same "no costs, no
        // cooldown" convention every other fizzle in this file follows.
        return { amount: 0, fizzle: true, log: `${attacker?.name ?? 'Archer'}: no lodges dislodged this turn.` };
      }
      const mpGain = count * 4;
      return {
        amount: 0, mpGain,
        log: `${attacker?.name ?? 'Archer'} scavenges ${count} arrow${count !== 1 ? 's' : ''}, restoring ${mpGain} MP.`,
      };
    },
    description: "Free. Requires at least one lodge dislodged this turn. Restores 4 MP per lodge dislodged."
  },

  // -------- Payoff --------

  'piercing_release': {
    id: "piercing_release",
    name: "Piercing Release",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    requiredWeapon: ["bow"],
    requiredStat: "DEX",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 6,
    cooldown: 4,
    typedDamage: true,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["ranged", "attack", "projectile", "dislodge"],
    // Already fizzled correctly from inside apply(); declared here so the Usable
    // filter and targeting can see it — with no lodges anywhere, no enemy is a
    // legal target and the skill drops out of the list.
    canExecute: ({ target }) => (target?.statusEffects || []).some(se => se?.id === 'lodged')
      ? true
      : { ok: false, reason: `${target?.name || 'Target'} has no lodges.` },
    apply: (attacker, target, scene) => {
      const lodgeCount = (target?.statusEffects || []).filter(se => se?.id === 'lodged').length;
      if (lodgeCount === 0) {
        // fizzle:true — was missing before, so failing this in-apply() gate
        // still spent MP/cooldown/the action for nothing.
        return { amount: 0, fizzle: true, log: `${target?.name ?? 'Target'} has no lodges.` };
      }
      const ability = SKILLS?.piercing_release;
      const roll = calculateDamage(attacker, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        { ability, tags: ability?.tags, skillPct: 100, skillLabel: `${ability?.name || 'Skill'} weapon damage (100%)`, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      // Popping the lodges is deferred to onHitLanded (CombatScene.js — only
      // invoked if this shot's own hit-roll actually lands) instead of
      // happening right here. dislodgeLodges() MUTATES target.statusEffects
      // for real — calling it unconditionally inside apply() (which runs
      // BEFORE the engine's hit-roll) meant a miss still popped every lodge,
      // just with the damage zeroed out afterward. The lodges themselves
      // were already gone regardless.
      const onHitLanded = () => {
        const { totalDamage, buildup, dislodged } = dislodgeLodges(target, scene);
        // Dislodge payout stays isolated from the CASTER's own gear%/
        // conversion (each lodge's damage was frozen at lodge-creation time,
        // possibly by a different character) — returned as physicalRiderDamage,
        // added generically AFTER gear conversion (CombatScene.js), same
        // treatment Lightning Jolt gets. Still gets its own visible Formula-
        // line entry via _pushBreakdown, same as before.
        if (totalDamage > 0) {
          try { _pushBreakdown({ label: 'Lodge dislodge', flat: totalDamage }); } catch { }
        }
        // Piercing Release's own flat per-lodge bonuses, added on top of
        // whatever each individual lodge's own buildupOnDislodge already
        // contributed (e.g. Barbed Shaft's lacerate, a lightning-lodge's
        // lightning) — merged, not overwritten, so mixed lodge types on the
        // same target all pay out together.
        const finalBuildup = { ...buildup };
        finalBuildup.expose = (finalBuildup.expose || 0) + dislodged * 35;
        finalBuildup.lacerate = (finalBuildup.lacerate || 0) + dislodged * 35;
        return {
          physicalRiderDamage: totalDamage,
          buildup: finalBuildup,
          log: `${attacker?.name ?? 'Archer'} releases all — ${dislodged} arrow${dislodged !== 1 ? 's' : ''} dislodged for ${totalDamage} bonus damage!`,
        };
      };

      return {
        ...roll, physical, elemental, necrotic, amount,
        onHitLanded,
      };
    },
    description: "Requires at least one lodge. Deals 100% weapon damage and dislodges every lodge on the target for bonus damage, plus 35 Expose and 35 Lacerate buildup per lodge dislodged."
  },

  'frost_shatter': {
    id: "frost_shatter",
    name: "Frost Shatter",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    requiredWeapon: ["bow"],
    requiredStat: "WIS",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 6,
    cooldown: 6,
    typedDamage: true,
    requiresTarget: true,
    targetRequirement: "enemy",
    // Declarative gate (was a manual in-apply() check returning a non-fizzle
    // no-op that still spent MP/cooldown/action) — the engine checks this
    // BEFORE apply() ever runs, so failing it now costs nothing at all.
    requiresWeakness: { family: "cold", tier: 2 },
    tags: ["ranged", "attack", "projectile", "consume", "cold", "expose"],
    apply: (attacker, target) => {
      const ability = SKILLS?.frost_shatter;
      // Capped at 400 — the damage bonus and Expose conversion below both
      // scale off this capped value, not however high the meter actually
      // built up to.
      const consumedCold = Math.min(target?.weakness?.meters?.cold || 0, 400);
      // +2% weapon damage per 10 consumed (was a flat +1 damage per 10,
      // uncapped) — up to +80% at the 400 cap, on top of the base 120%.
      const skillPct = 120 + Math.floor(consumedCold / 10) * 2;
      const roll = calculateDamage(attacker, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        { ability, tags: ability?.tags, skillPct, skillLabel: `${ability?.name || 'Skill'} weapon damage (${skillPct}%)`, isCrit: roll.isCrit, critMult: roll.critMult, skillConversion: { physToElemPct: 100 } }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      const exposeBuildup = Math.floor(consumedCold * 0.50);
      return {
        ...roll, physical, elemental, necrotic, amount,
        buildup: { expose: exposeBuildup },
        // Generic engine mechanism (CombatScene.js) — zeroes the target's
        // Cold meter/tier for real. Reads consumedCold above BEFORE this
        // runs, so the capture and the actual consumption can't drift apart.
        consumeWeakness: ['cold'],
        log: `${attacker?.name ?? 'Archer'} shatters ${consumedCold} cold — ${skillPct}% damage, ${exposeBuildup} expose!`,
      };
    },
    description: "Requires the target to be Frostbitten (Cold T2+). Deals 120% weapon damage as Cold, +2% more per 10 Cold buildup consumed (capped at 400 consumed, up to +80%). Consumes all Cold buildup and converts up to half of the consumed amount into Expose buildup."
  },

  'hail_of_arrows': {
    id: "hail_of_arrows",
    name: "Hail of Arrows",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    requiredWeapon: ["bow"],
    requiredStat: "DEX",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 5,
    cooldown: 5,
    typedDamage: true,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["ranged", "attack", "projectile", "aoe"],
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.hail_of_arrows;
      const roll = calculateDamage(attacker, target, ability);
      const skillPct = 90 * hailOfArrowsMult(target);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        { ability, tags: ability?.tags, skillPct, skillLabel: `${ability?.name || 'Skill'} weapon damage (${skillPct}%)`, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      // smallCone: the 1-2 slots directly behind the target in the next
      // column back (see SMALL_CONE_MAP, aoeResolver.js). Each is fired as
      // its own genuinely INDEPENDENT shot — a real _applyAbilityToTarget
      // cast with its own hit-roll — not shared-hit-roll splash, same
      // architecture Volley's two arrows use. This is "arrows raining down"
      // (each can individually hit or miss), not "one hit splashing
      // outward" — unlike the primary target here, which still resolves
      // through the NORMAL pipeline's own hit-roll unaffected by any of this.
      const others = resolveAOESplash(scene, target, { shape: "smallCone" });
      const shot = SKILLS?.hail_of_arrows_shot;
      others.forEach((tgt, i) => {
        scene.time?.delayedCall(60 * (i + 1), () => {
          if (scene.combatEnded || tgt.status === 'incapacitated') return;
          scene._applyAbilityToTarget(attacker, tgt, shot, { isReaction: true, tags: shot?.tags || [] });
        });
      });

      return { ...roll, physical, elemental, necrotic, amount };
    },
    description: "Small cone: fires an arrow at the target and 1-2 more at the slots directly behind it. Every recipient deals 90% weapon damage, +20% more per weakness category they personally have (Physical/Elemental/Necrotic, any tier) — up to 150% with all three."
  },

  // Not player-selectable — the independent per-target shot Hail of Arrows
  // fires at each OTHER cone recipient (see above). Can't reuse
  // hail_of_arrows' own apply() (already spoken for by the primary cast,
  // same reason volley_arrow exists separately from volley) — each of these
  // needs its own real hit-roll, which only a genuine separate
  // _applyAbilityToTarget cast provides.
  'hail_of_arrows_shot': {
    id: "hail_of_arrows_shot",
    name: "Hail of Arrows",
    type: "weapon",
    hidden: true,
    typedDamage: true,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["ranged", "attack", "projectile"],
    apply: (attacker, target) => {
      const ability = SKILLS?.hail_of_arrows_shot;
      const roll = calculateDamage(attacker, target, ability);
      const skillPct = 90 * hailOfArrowsMult(target);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        { ability, tags: ability?.tags, skillPct, skillLabel: `${ability?.name || 'Skill'} weapon damage (${skillPct}%)`, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      return { ...roll, physical, elemental, necrotic, amount };
    },
    description: "Deals 90% weapon damage, +20% more per weakness category the target has (Physical/Elemental/Necrotic, any tier)."
  },

  'barbed_bloom': {
    id: "barbed_bloom",
    name: "Barbed Bloom",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    requiredWeapon: ["bow"],
    requiredStat: "DEX",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 6,
    cooldown: 5,
    typedDamage: true,
    requiresTarget: true,
    targetRequirement: "enemy",
    // Declarative gate (was a manual in-apply() check that still spent
    // MP/cooldown/action on a non-fizzle no-op) — free fizzle now.
    requiresWeakness: { family: "lacerate", tier: 1 },
    tags: ["ranged", "attack", "projectile", "aoe", "lacerate", "necrotic"],
    // Inline shape lifted onto the skill; matches its SPLASH_SCALE of 0.70.
    aoe: { shape: "column", scale: 0.70 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.barbed_bloom;
      // Capped at 400 (same convention as Frost Shatter) — +10% weapon
      // damage per 100 Lacerate on the target, up to +40% at the cap. This
      // now scales the PRIMARY hit itself, not just the splash (see below).
      const lacMeter = Math.min(target?.weakness?.meters?.lacerate || 0, 400);
      const skillPct = 100 + Math.floor(lacMeter / 100) * 10;
      const roll = calculateDamage(attacker, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        { ability, tags: ability?.tags, skillPct, skillLabel: `${ability?.name || 'Skill'} weapon damage (${skillPct}%)`, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      // Splash is 70% of THIS primary hit's own final typed breakdown — not
      // a separately-rolled 70% weapon-damage calc — so it automatically
      // reflects the same Lacerate bonus (and any crit/buffs) the primary
      // got, per-component, same "single roll, per-target scaling" splash
      // precedent fire_flare_wave/ice_shard_storm already use.
      const SPLASH_SCALE = 0.70;
      const necroSpread = {
        toxic:   Math.floor((target?.weakness?.meters?.toxic   || 0) * 0.25),
        disease: Math.floor((target?.weakness?.meters?.disease || 0) * 0.25),
        curse:   Math.floor((target?.weakness?.meters?.curse   || 0) * 0.25),
      };
      const hasNecro = Object.values(necroSpread).some(v => v > 0);
      const splash = resolveAOESplash(scene, target, ability.aoe).map(tgt => {
        const splashPhysical = Math.floor(physical * SPLASH_SCALE);
        const splashElemental = Math.floor(elemental * SPLASH_SCALE);
        const splashNecrotic = Math.floor(necrotic * SPLASH_SCALE);
        return {
          target: tgt,
          amount: Math.max(1, splashPhysical + splashElemental + splashNecrotic),
          physical: splashPhysical, elemental: splashElemental, necrotic: splashNecrotic,
          tags: ability?.tags,
          buildup: hasNecro ? { ...necroSpread } : undefined,
        };
      });
      return { ...roll, physical, elemental, necrotic, amount, splash: splash.length ? splash : undefined };
    },
    description: "Requires the target to be Bleeding (Lacerate T1+). Deals 100% weapon damage, +10% per 100 Lacerate on the target (capped at 400, up to +40%). Splashes 70% of that same hit to the rest of the target's rank, and spreads 25% of the target's Toxic/Disease/Curse buildup to them too. Does not consume any weakness."
  },

  'hunters_finish': {
    id: "hunters_finish",
    name: "Hunter's Finish",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    requiredWeapon: ["bow"],
    requiredStat: "WIS",
    requiredValue: 16,
    actionCost: ["major", "bonus"],
    // Cost/cooldown toned down along with dropping the old hard dual-
    // requirement gate (was 10/8) — this skill no longer requires anything
    // to be present on the target at all, Hunter's Mark is now an optional
    // bonus rather than a prerequisite, and it no longer touches lodges.
    mpCost: 5,
    cooldown: 6,
    typedDamage: true,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["ranged", "attack", "projectile", "consume", "finisher"],
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.hunters_finish;
      const roll = calculateDamage(attacker, target, ability);

      const w = target?.weakness;
      // Each family capped individually at 400 (Frost Shatter/Barbed Bloom
      // convention) before summing for the damage bonus below — the actual
      // meter clear a few lines down still consumes the FULL amount
      // regardless of this cap, same "cap only bounds the bonus" pattern.
      const fireConsumed = Math.min(w?.meters?.fire || 0, 400);
      const coldConsumed = Math.min(w?.meters?.cold || 0, 400);
      const lightConsumed = Math.min(w?.meters?.lightning || 0, 400);
      const totalConsumed = fireConsumed + coldConsumed + lightConsumed;
      // +2% weapon damage per 10 elemental consumed (was a flat +1 damage
      // per 10, uncapped).
      const skillPct = 150 + Math.floor(totalConsumed / 10) * 2;

      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        { ability, tags: ability?.tags, skillPct, skillLabel: `${ability?.name || 'Skill'} weapon damage (${skillPct}%)`, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      // Deferred to onHitLanded (only runs if this shot's own hit-roll
      // actually connects) — the meter-clear and Hunter's Mark reapply both
      // mutate real state; doing them unconditionally here meant a MISSED
      // Hunter's Finish still wiped the target's elemental buildup and
      // consumed the mark for real.
      const onHitLanded = () => {
        // Consume all 3 elemental meters now, in full — the 400 cap above
        // only bounds the damage bonus, not how much actually clears. Done
        // BEFORE any Hunter's Mark reapply below (not via the generic
        // consumeWeakness result field, which applies generically even
        // later than this — too late, it would wipe out the reapplied
        // buildup the mark grants).
        if (w?.meters) {
          w.meters.fire = 0; w.meters.cold = 0; w.meters.lightning = 0;
          if (w.tiers) { w.tiers.fire = 0; w.tiers.cold = 0; w.tiers.lightning = 0; }
        }

        // Hunter's Mark synergy — optional now, not a requirement, and this
        // skill no longer touches lodges at all. If the mark is active,
        // reapply HALF of each family's own capped-consumed amount as fresh
        // buildup, then consume the mark. Called directly via
        // scene._applyWeaknessBuildup (not result.buildup/consumeWeakness —
        // those apply generically, elsewhere) specifically so the mark's
        // own BuildupReceived% bonus reads correctly while it's still
        // active, right before it's removed.
        const mark = (target?.statusEffects || []).find(se => se?.id === 'hunters_mark' && (se.turns || 0) > 0);
        let markLog = '';
        if (mark) {
          const reapply = {
            fire: Math.floor(fireConsumed * 0.5),
            cold: Math.floor(coldConsumed * 0.5),
            lightning: Math.floor(lightConsumed * 0.5),
          };
          scene?._applyWeaknessBuildup?.(target, reapply, { user: attacker, ability });
          target.statusEffects = target.statusEffects.filter(se => se !== mark);
          markLog = ` Hunter's Mark consumed — reapplies half the buildup!`;
        }

        return {
          log: `Hunter's Finish — ${totalConsumed} elemental consumed (${skillPct}% damage).${markLog}`,
        };
      };

      return { ...roll, physical, elemental, necrotic, amount, onHitLanded };
    },
    description: "Deals 150% weapon damage, +2% more per 10 elemental buildup consumed (each of Fire/Cold/Lightning capped at 400 for this bonus). Consumes all elemental buildup on the target. If Hunter's Mark is active, consumes it too and reapplies half the consumed buildup as fresh buildup, boosted by the mark's own bonus."
  },

  'farsight_volley': {
    id: "farsight_volley",
    name: "Farsight Volley",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    requiredWeapon: ["bow"],
    requiredStat: "CHA",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 5,
    cooldown: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    // Restricts which enemy slots are even selectable in the first place
    // (existing generic mechanism, read by _enterTargetingMode) — the
    // player can no longer pick a non-back-rank enemy at all, rather than
    // picking one and having it silently fizzle after the fact.
    targetColumns: ["back"],
    // No 'attack'/'ranged'/'projectile' here — this cast itself never deals
    // damage (see apply() below), so it shouldn't roll its own hit/miss or
    // show a damage breakdown of its own; every real hit comes from the
    // independent farsight_volley_shot casts this fires off.
    tags: ["support", "aoe", "mana"],
    // Fires an independent arrow at every BACK-rank enemy, targeted inline.
    // Display-only: the resolver has no backRank case, and this skill does
    // not use it -- the declaration exists so the tooltip can draw the rank.
    aoe: { shape: "backRank", scale: 1.0 },
    apply: (attacker, target, scene) => {
      // Defensive fallback only — normal play can't reach this anymore
      // (targetColumns above already restricts targeting), but any other
      // call path still gets a clean, free fizzle instead of a silent
      // non-effect that still spends resources.
      const targetCol = scene?._getColumnBySlotId?.(target?._slot?.slotId);
      if (targetCol !== 'back') {
        return { amount: 0, fizzle: true, log: `${attacker?.name ?? 'Archer'}: Farsight Volley only targets the back rank.` };
      }

      // The clicked target is purely a formality — required so the ability
      // has SOME target to satisfy requiresTarget/targetColumns, but Farsight
      // Volley doesn't favor it over the rest of the back rank in any way.
      // Every back-rank enemy (this one included) is hit as a genuinely
      // independent shot — its own real _applyAbilityToTarget cast, own
      // hit-roll, own damage breakdown — same architecture Hail of Arrows
      // and Volley use, NOT a single hit-roll gating a shared splash. This
      // wrapper cast itself deals no damage and shows no breakdown of its own.
      const sideSlots = target?.isEnemy ? scene?.enemySlots : scene?.allySlots;
      const backRank = (sideSlots || [])
        .map(s => s?.char)
        .filter(c => c && c.status !== 'incapacitated' && scene?._getColumnBySlotId?.(c._slot?.slotId) === 'back');

      const shot = SKILLS?.farsight_volley_shot;
      backRank.forEach((tgt, i) => {
        scene.time?.delayedCall(60 * (i + 1), () => {
          if (scene.combatEnded || tgt.status === 'incapacitated') return;
          scene._applyAbilityToTarget(attacker, tgt, shot, { isReaction: true, tags: shot?.tags || [] });
        });
      });

      return { amount: 0 };
    },
    description: "Requires targeting a back-rank enemy. Fires an independent arrow at every back-rank enemy. Every arrow deals 85% weapon damage and drains 1 MP per 50 Disorient buildup on that target (capped at 200 buildup, max 4 MP), restoring it to you."
  },

  // Not player-selectable — the independent per-target shot Farsight Volley
  // fires at EVERY back-rank enemy, including the one clicked (see above).
  // Can't reuse farsight_volley's own apply() (already spoken for by the
  // wrapper cast, same reason volley_arrow/hail_of_arrows_shot exist
  // separately) — each shot needs its own real hit-roll and its own MP
  // drain gated on THAT shot actually landing.
  'farsight_volley_shot': {
    id: "farsight_volley_shot",
    name: "Farsight Volley",
    type: "weapon",
    hidden: true,
    typedDamage: true,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["ranged", "attack", "projectile"],
    vfxHint: { kind: 'mana' },
    apply: (attacker, target) => {
      const ability = SKILLS?.farsight_volley_shot;
      const roll = calculateDamage(attacker, target, ability);
      const { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        { ability, tags: ability?.tags, skillPct: 85, skillLabel: `${ability?.name || 'Skill'} weapon damage (85%)`, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      // MP drain deferred to onHitLanded (only runs if THIS shot's own
      // hit-roll actually connects) — mutating target.currentMP/weakness
      // unconditionally inside apply() would drain MP even on a miss, same
      // class of bug Piercing Release's lodge dislodge had.
      const onHitLanded = () => {
        const disorient = target?.weakness?.meters?.disorient || 0;
        // Capped at 200 for the drain calc (max 4 MP) — the meter still
        // fully clears when it drains at all, same as before, just bounded
        // going into the drain math itself.
        const drainedMeter = Math.min(disorient, 200);
        const drained = Math.floor(drainedMeter / 50);
        if (drained <= 0) return {};
        target.currentMP = Math.max(0, (target.currentMP || 0) - drained);
        if (target?.weakness?.meters) {
          target.weakness.meters.disorient = 0;
          if (target.weakness.tiers) target.weakness.tiers.disorient = 0;
        }
        // mpGain is read generically by the engine and added straight to
        // the attacker's own currentMP — the same number subtracted from
        // this target above. Each shot pays out separately, but they all
        // sum onto the same caster over the course of the volley, so
        // drained-from-enemies still always equals gained-by-caster, 1:1.
        return {
          mpGain: drained,
          log: `${attacker?.name ?? 'Archer'} drains ${drained} MP from ${target?.name ?? 'the target'}!`,
        };
      };

      return { ...roll, physical, elemental, necrotic, amount, onHitLanded };
    },
    description: "Deals 85% weapon damage. Drains 1 MP per 50 Disorient buildup on the target (capped at 200 buildup, max 4 MP) and restores it to you."
  },

  'quivering_burst': {
    id: "quivering_burst",
    name: "Quivering Burst",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    requiredWeapon: ["bow"],
    requiredStat: "INT",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 6,
    cooldown: 6,
    typedDamage: true,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["ranged", "attack", "projectile", "lightning"],
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.quivering_burst;
      const roll = calculateDamage(attacker, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        { ability, tags: ability?.tags, skillPct: 110, skillLabel: `${ability?.name || 'Skill'} weapon damage (110%)`, isCrit: roll.isCrit, critMult: roll.critMult, skillConversion: { physToElemPct: 100 } }
      );
      const amount = Math.max(1, physical + elemental + necrotic);

      // Arcing repeat — same meter-scaled chance formula the staff and
      // dagger's own lightning skills already use (chance ramps smoothly
      // with the target's CURRENT lightning meter, capped — not a tier
      // threshold). Doesn't consume any of that meter itself.
      //
      // This can't be the generic repeatChance/repeatScale engine mechanic
      // (that only ever re-hits the SAME target) — an arc needs to spread
      // to OTHER nearby targets instead, so it's rolled and resolved by
      // hand here, deferred to onHitLanded (only runs if this shot's own
      // hit-roll connects) via the same real _applyDirectResult path
      // splash/repeats already use internally — full mitigation, reactions,
      // floating numbers, all of it, nothing bypassed.
      const lightMeter = target?.weakness?.meters?.lightning || 0;
      const arcChance = Math.min(0.60, lightMeter / 1000);
      const ARC_SCALE = 0.60;
      const onHitLanded = (liveResult) => {
        if (Math.random() >= arcChance) return {};
        // Basis is the CORE hit — post-gear-conversion, but BEFORE Jolt (a
        // target-side trigger effect, not part of the hit's own
        // composition) — same snapshot the generic repeatChance/repeatScale
        // mechanic already uses (_buildRepeatPayload, CombatScene.js). Reads
        // liveResult (the engine's own resultMutable, passed into this
        // callback) rather than the physical/elemental/necrotic closed over
        // above, since THOSE are from before gear-conversion ran.
        const core = liveResult?._coreBreakdown;
        const baseP = core?.physical ?? physical;
        const baseE = core?.elemental ?? elemental;
        const baseN = core?.necrotic ?? necrotic;

        const nearby = resolveAOESplash(scene, target, { shape: "adjacent" });
        // Re-hits the original target (a normal repeat) plus any nearby
        // enemy with an active Lightning tier ("Jolted or Shocked" — any
        // tier, not specifically Shocked/T2).
        const arcTargets = [target, ...nearby.filter(t => (t?.weakness?.tiers?.lightning || 0) >= 1)];

        arcTargets.forEach((t, i) => {
          scene.time?.delayedCall(80 * (i + 1), () => {
            if (scene.combatEnded || t.status === 'incapacitated') return;
            const p = Math.floor(baseP * ARC_SCALE);
            const e = Math.floor(baseE * ARC_SCALE);
            const n = Math.floor(baseN * ARC_SCALE);
            scene._applyDirectResult(attacker, t, {
              amount: Math.max(1, p + e + n),
              physical: p, elemental: e, necrotic: n,
              isMagic: true, element: 'lightning',
            }, { isSplash: true, ability });
          });
        });
        return { log: `${attacker?.name ?? 'Archer'}'s shot arcs${arcTargets.length > 1 ? ` — hits ${arcTargets.length} targets` : ''}!` };
      };

      return { ...roll, physical, elemental, necrotic, amount, onHitLanded };
    },
    description: "Deals 110% weapon damage as Lightning. Chance to arc, equal to the target's own Lightning buildup ÷ 1000 — repeats 60% damage against the target again, plus any nearby enemy with an active Lightning weakness. Does not consume the target's Lightning buildup."
  },

  // Bow's initiative spender — modeled directly on blazing_fervor (sword_1h):
  // same discrete 3-tier spend (10/20/30, picks the HIGHEST tier the current
  // gauge can afford, not a player choice), same per-step scaling shape,
  // same bonus/cooldown, applied to the whole party (self included) via
  // scene._addStatusEffects so a recast on an already-buffed ally coalesces
  // to the stronger value instead of stacking two live entries. Party-wide
  // Accuracy instead of fire damage/buildup on hit. No existing bow skill
  // spent Initiative at all before this.
  // Bow's curse-rider — same shape as Curse of Normality/Visions, targeting
  // Evasion: they second-guess their own ability to dodge.
  'curse_of_doubt': {
    id: "curse_of_doubt",
    name: "Curse of Doubt",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    typedDamage: true,
    requiredWeapon: ["bow"],
    requiredStat: "CHA",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["ranged", "attack", "projectile", "curse", "necrotic"],
    cooldown: 4,
    requiresWeakness: { family: "curse", tierAtLeast: 1 },
    buildupHint: { curse: 60 },
    apply: (attacker, target, scene) => {
      const ability = SKILLS?.curse_of_doubt;
      const roll = calculateDamage(attacker, target, ability);
      let { physical, elemental, necrotic } = applyTypedDamageModifiers(
        { physical: roll.physical, elemental: roll.elemental, necrotic: roll.necrotic },
        attacker, target,
        { ability, tags: ability?.tags, skipGearMultiplier: true, skillPct: 100, skillLabel: `${ability?.name || 'Skill'} weapon damage (100%)`, isCrit: roll.isCrit, critMult: roll.critMult }
      );
      const amount = Math.max(1, physical + elemental + necrotic);
      const curseTier = target?.weakness?.tiers?.curse || 0;
      const curseMeter = target?.weakness?.meters?.curse || 0;
      const basePct = 20;
      const scaledPct = curseTier >= 2 ? Math.round(basePct * weaknessIntensityMult(curseMeter)) : basePct;
      const alreadyCursed = (target.statusEffects || []).some(se => se?.id === 'curse_of_doubt');
      if (!alreadyCursed) {
        scene?._addStatusEffects?.(target, [{
          id: "curse_of_doubt", name: "Curse of Doubt", permanent: true,
          mods: { Evasion: -scaledPct },
          vfx: { kind: 'debuff_decrease' },
        }]);
      }
      return { ...roll, physical, elemental, necrotic, amount, buildup: { curse: 60 } };
    },
    description: "Deals 100% weapon damage and applies 60 Curse buildup. Requires target at least Hexed. Applies a permanent rider: -20 Evasion, scaling up to -50 at max Curse intensity."
  },

  'trueshot_call': {
    id: "trueshot_call",
    name: "Trueshot Call",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.23",
    requiredWeapon: ["bow"],
    requiredStat: "CHA",
    requiredValue: 15,
    actionCost: "bonus",
    mpCost: 5,
    cooldown: 2,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["support", "buff"],
    // Spending initiative is this skill's whole job — below the minimum
    // spend tier, it has nothing to do, so it should fizzle instead of
    // silently firing for free. Checked generically in _applyAbilityToTarget.
    requiresInitiativeGauge: 10,
    apply: (attacker, _target, scene) => {
      // Three tiers (10/20/30), spends the HIGHEST tier the current gauge
      // can fully afford — same automatic-pick shape blazing_fervor uses,
      // not a player choice.
      const gauge = attacker?.initiativeGauge || 0;
      const spend = gauge >= 30 ? 30 : gauge >= 20 ? 20 : 10;
      attacker.initiativeGauge = Math.max(0, (attacker.initiativeGauge || 0) - spend);

      // +10 Accuracy per 10 initiative spent — 10/20/30 spend gives
      // +10/+20/+30 Accuracy.
      const steps = spend / 10;
      const accBonus = 10 * steps;

      const allySlots = attacker?.isEnemy ? scene?.enemySlots : scene?.allySlots;
      (allySlots || []).forEach(s => {
        const ally = s?.char;
        if (!ally || ally.status === 'incapacitated') return;
        scene?._addStatusEffects?.(ally, [{ id: 'trueshot_call', turns: 2, mods: { Accuracy: accBonus }, vfx: { kind: 'buff_increase' } }]);
      });

      scene?._log?.(`${attacker?.name || 'The archer'} calls a true shot (spent ${spend} initiative) — allies gain +${accBonus} Accuracy for 2 turns.`);
      return { amount: 0 };
    },
    description: "Spend initiative (10/20/30, based on current gauge) to rally allies' aim: +10 Accuracy per 10 initiative spent, for 2 turns."
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
    mpCost: 4,
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
    mpCost: 5,
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
    buildupHint: { cold: 75 },
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
        buildup: { cold: ability?.buildupHint?.cold ?? 75 },
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
    buildupHint: { cold: 75 },
    slotEffect: { id: "ice_slick", element: "cold", buildup: 19, tickPctMaxHP: 0.0, turns: 2 },
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
        buildup: { cold: ability?.buildupHint?.cold ?? 75 },
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
    mpCost: 4,
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
    mpCost: 5,
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
    mpCost: 5,
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
    mpCost: 5,
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
    mpCost: 4,
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
    mpCost: 4,
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
    mpCost: 5,
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
