import { SKILLS } from '../../data/skills.js';

// Advanced encounter AI profiles
//test
const isAlive = unit => unit && unit.status !== 'incapacitated';
const hasAction = (npc, type) => (npc?.actionsLeft?.[type] || 0) > 0;

const hpRatio = (unit) => {
  const max = Math.max(1, unit?.maxHP || 1);
  return Math.max(0, (unit?.currentHP || 0) / max);
};
const mpAvailable = npc => Math.max(0, npc?.currentMP ?? 0);
const cooldownFor = (npc, skillId) => npc?.cooldowns?.[skillId] || 0;
const actionTypeFor = skillId => SKILLS?.[skillId]?.actionCost || 'major';
const buildAction = (skillId, target = null) => ({ type: actionTypeFor(skillId), skill: skillId, target });

const canUseSkill = (npc, skillId) => {
  const skill = SKILLS?.[skillId];
  if (!skill) return false;
  const actionType = skill.actionCost || 'major';
  if (!hasAction(npc, actionType)) return false;
  if (cooldownFor(npc, skillId) > 0) return false;
  const mpCost = Math.max(0, skill.mpCost || 0);
  return mpAvailable(npc) >= mpCost;
};

const randomRange = (min = 0.1, max = 0.6) => min + Math.random() * (max - min);
const weightedPick = (list, weightFn) => {
  if (!Array.isArray(list) || !list.length) return null;
  let total = 0;
  const scored = [];
  for (const item of list) {
    const weight = Math.max(0, weightFn?.(item) || 0);
    if (weight <= 0) continue;
    total += weight;
    scored.push({ item, total });
  }
  if (!scored.length || total <= 0) return null;
  const roll = Math.random() * total;
  for (const entry of scored) {
    if (roll <= entry.total) return entry.item;
  }
  return scored[scored.length - 1].item;
};

const targetScore = (target, opts = {}) => {
  const noise = randomRange(0, opts.noise ?? 0.9);
  const hpBias = opts.preferLowHP ? (1 - hpRatio(target)) * 2.4 : 0.5 * (1 - hpRatio(target));
  const families = Array.isArray(opts.preferWeakness) ? opts.preferWeakness : (opts.preferWeakness ? [opts.preferWeakness] : []);
  const weaknessBias = families.reduce((sum, fam) => {
    const tier = target?.weakness?.tiers?.[fam] || 0;
    if (opts.minTier && tier < opts.minTier) return sum;
    const meter = target?.weakness?.meters?.[fam] || 0;
    return sum + tier * (opts.weaknessWeight ?? 1.4) + meter / 80;
  }, 0);
  const markBias = opts.preferMarked && Array.isArray(target?.statusEffects) && target.statusEffects.some(se => se?.id === 'huntsman_marked') ? 1.6 : 0;
  return Math.max(0.1, 1 + noise + hpBias + weaknessBias + markBias);
};

const pickTarget = (list, opts = {}) => {
  const alive = (list || []).filter(isAlive);
  if (!alive.length) return null;
  return weightedPick(alive, t => targetScore(t, opts));
};

const firstAlive = list => pickTarget(list, { noise: 0.8, preferLowHP: false }) || null;
const weakest = list => pickTarget(list, { preferLowHP: true, noise: 1.1 }) || null;
const highestWeakness = (targets, family, minTier = 1) => {
  const filtered = (targets || []).filter(t => isAlive(t) && ((t.weakness?.tiers?.[family] || 0) >= minTier));
  if (!filtered.length) return null;
  return weightedPick(filtered, t => {
    const tier = t?.weakness?.tiers?.[family] || 0;
    const meter = t?.weakness?.meters?.[family] || 0;
    return Math.max(0.1, tier * 2 + meter / 60 + randomRange(0, 0.8));
  });
};
const alliesOf = (npc, scene) => (scene?.enemies || []).filter(unit => unit && unit.isEnemy === npc.isEnemy && isAlive(unit));
const enemiesOf = enemies => (enemies || []).filter(isAlive);

const hasStatus = (unit, id) => Array.isArray(unit?.statusEffects) && unit.statusEffects.some(se => se?.id === id);

const hasAnyWeakness = (unit, families, tier = 1) => families.some(f => (unit?.weakness?.tiers?.[f] || 0) >= tier);

const countWeaknessFamilies = (unit, families, tier = 1) => families.reduce((sum, fam) => sum + ((unit?.weakness?.tiers?.[fam] || 0) >= tier ? 1 : 0), 0);

const buildTargetList = (npc, scene, enemies) => ({
  allies: alliesOf(npc, scene),
  foes: enemiesOf(enemies),
});

function pickMarkedTarget(enemies) {
  const marked = (enemies || []).filter(e => Array.isArray(e?.statusEffects) && e.statusEffects.some(se => se?.id === 'huntsman_marked'));
  if (!marked.length) return null;
  return weightedPick(marked, t => targetScore(t, { preferLowHP: true, preferMarked: true, noise: 0.9 }));
}

export const AI_PROFILES = {


  stationary_dummy: {
    decide(npc) {
      if (canUseSkill(npc, 'dummy_sway')) {
        return buildAction('dummy_sway', null);
      }
      return null;
    }
  },

  // No offense — deals no damage, same as stationary_dummy. Only difference
  // is movement: bounces around erratically (teaching players about range/
  // AOE shapes) and always prioritizes moving off a hazardous tile (e.g. a
  // Quake zone) if currently standing on one. Hazard-awareness itself lives
  // in the movement helpers (_enemyTryShuffleOneColumn skips hazardous
  // destinations) — this profile just decides WHEN to move.
  mobile_dummy: {
    decide(npc, scene) {
      const onHazard = !!scene?._slotIsHazardous?.(npc?._slot, npc?.isEnemy);
      if (onHazard && canUseSkill(npc, 'dummy_shuffle')) {
        return buildAction('dummy_shuffle', null);
      }
      if (canUseSkill(npc, 'dummy_shuffle') && Math.random() < 0.5) {
        return buildAction('dummy_shuffle', null);
      }
      if (canUseSkill(npc, 'dummy_sway')) {
        return buildAction('dummy_sway', null);
      }
      return null;
    }
  },

  warmup_dummy: {
    decide(npc, scene, enemies) {
      const { foes } = buildTargetList(npc, scene, enemies);
      const target = weakest(foes);
      if (!target) return null;
      const hpPct = hpRatio(npc);
      if (canUseSkill(npc, 'warmup_patch') && hpPct <= 0.6) {
        return buildAction('warmup_patch', npc);
      }
      if (canUseSkill(npc, 'warmup_swing')) {
        return buildAction('warmup_swing', target);
      }
      if (canUseSkill(npc, 'dummy_sway')) {
        return buildAction('dummy_sway', null);
      }
      return null;
    }
  },

  defensive_dummy: {
    decide(npc, scene, enemies) {
      const { allies, foes } = buildTargetList(npc, scene, enemies);
      const allyToHeal = pickTarget(allies, { preferLowHP: true, noise: 1 });
      if (canUseSkill(npc, 'defender_small_heal') && allyToHeal) {
        return buildAction('defender_small_heal', allyToHeal);
      }
      if (canUseSkill(npc, 'defender_guard_raise') && !hasStatus(npc, 'defender_guard')) {
        return buildAction('defender_guard_raise', npc);
      }
      const exposedTarget = highestWeakness(foes, 'expose', 1) || weakest(foes);
      if (canUseSkill(npc, 'defender_taunt') && exposedTarget) {
        return buildAction('defender_taunt', exposedTarget);
      }
      return null;
    }
  },

  offensive_dummy: {
    decide(npc, scene, enemies) {
      const { foes } = buildTargetList(npc, scene, enemies);
      const target = weakest(foes);
      if (!target) return null;
      if (canUseSkill(npc, 'offender_expose_strike')) {
        return buildAction('offender_expose_strike', target);
      }
      if (canUseSkill(npc, 'dummy_shuffle') && Math.random() < 0.45) {
        return buildAction('dummy_shuffle', null);
      }
      return null;
    }
  },

  fighter_dummy: {
    decide(npc, scene, enemies) {
      // Guardian's Stand — armed once and left armed (idempotent, same
      // pattern berserker_boss uses for Blood Fury), so it can fire off-turn
      // via the 'ally_hit' reaction the moment it's needed.
      const alreadyArmed = scene?.reactions?.listPrepared?.(npc)?.some(r => r.id === 'fighter_guardians_stand');
      if (!alreadyArmed && scene?.reactions?.arm && npc.skills?.includes('fighter_guardians_stand')) {
        scene.reactions.arm(npc, SKILLS.fighter_guardians_stand);
      }

      const { allies, foes } = buildTargetList(npc, scene, enemies);

      // Bulwark Call — held back for when the party's actually hurting for
      // HP or MP, same "sometimes" pacing Mending Wave uses.
      const needsSupport = allies.some(a => hpRatio(a) < 0.8 || (a.currentMP || 0) < (a.maxMP || 1) * 0.5);
      if (canUseSkill(npc, 'fighter_bulwark_call') && (npc.initiativeGauge || 0) >= 30 && needsSupport) {
        return buildAction('fighter_bulwark_call', null);
      }

      const executionTarget = highestWeakness(foes, 'expose', 2);
      if (canUseSkill(npc, 'fighter_executioner') && executionTarget) {
        return buildAction('fighter_executioner', executionTarget);
      }
      const tauntTarget = highestWeakness(foes, 'expose', 1);
      if (canUseSkill(npc, 'fighter_taunt') && tauntTarget) {
        return buildAction('fighter_taunt', tauntTarget);
      }
      if (canUseSkill(npc, 'fighter_guarded_blow') && !hasStatus(npc, 'fighter_guard')) {
        const target = weakest(foes);
        if (target) return buildAction('fighter_guarded_blow', target);
      }
      if (canUseSkill(npc, 'fighter_heavy_slash')) {
        const target = weakest(foes);
        if (target) return buildAction('fighter_heavy_slash', target);
      }
      // Out of MP/actions for everything above (or no valid target) — fall
      // back to a harmless Sway instead of falling through to the generic
      // chooseNPCAction picker, which was trying (and failing) real skills
      // and spamming "lacks the MP" in the log every turn. Same fallback the
      // encounters 1/2 dummy profiles already use.
      if (canUseSkill(npc, 'dummy_sway')) {
        return buildAction('dummy_sway', null);
      }
      return null;
    }
  },

  healer_dummy: {
    decide(npc, scene, enemies) {
      const { allies, foes } = buildTargetList(npc, scene, enemies);

      // Mending Wave — Stan's signature, held back for when it actually
      // matters (2+ allies meaningfully hurt) rather than spammed the moment
      // Initiative allows, so it reads as a "sometimes" move worth a crowd
      // reaction rather than a routine heal.
      const hurtAllies = allies.filter(a => hpRatio(a) < 0.7);
      if (canUseSkill(npc, 'healer_mending_wave') && (npc.initiativeGauge || 0) >= 30 && hurtAllies.length >= 2) {
        const anchor = pickTarget(hurtAllies, { preferLowHP: true, noise: 1 }) || hurtAllies[0];
        return buildAction('healer_mending_wave', anchor);
      }

      const lowAlly = pickTarget(allies, { preferLowHP: true, noise: 1 });
      if (canUseSkill(npc, 'healer_heal') && lowAlly) {
        return buildAction('healer_heal', lowAlly);
      }
      const afflicted = pickTarget(allies, { preferWeakness: ['curse', 'disease', 'toxic'], minTier: 1, preferLowHP: true });
      if (canUseSkill(npc, 'healer_cleanse') && afflicted) {
        return buildAction('healer_cleanse', afflicted);
      }
      if (canUseSkill(npc, 'healer_blessing')) {
        const blessTarget = pickTarget(allies.filter(a => !hasStatus(a, 'healer_blessing')), { noise: 1, preferLowHP: false });
        if (blessTarget) {
          return buildAction('healer_blessing', blessTarget);
        }
      }
      if (canUseSkill(npc, 'healer_flame_flick')) {
        const enemy = weakest(foes);
        if (enemy) return buildAction('healer_flame_flick', enemy);
      }
      if (canUseSkill(npc, 'dummy_sway')) {
        return buildAction('dummy_sway', null);
      }
      return null;
    }
  },

  warlock_dummy: {
    decide(npc, scene, enemies) {
      const { foes } = buildTargetList(npc, scene, enemies);

      // Reckless Immolation — opportunistic HP-cost payoff. canExecute
      // already enforces ">80% HP", checked again here so the AI doesn't
      // attempt a cast that's just going to fizzle.
      const singedTarget = highestWeakness(foes, 'fire', 1);
      const garyHpPct = (npc.currentHP || 0) / Math.max(1, npc.maxHP || 1);
      if (canUseSkill(npc, 'warlock_reckless_immolation') && garyHpPct > 0.8 && singedTarget) {
        return buildAction('warlock_reckless_immolation', singedTarget);
      }

      const cursed = highestWeakness(foes, 'curse', 2) || highestWeakness(foes, 'curse', 1);
      if (canUseSkill(npc, 'warlock_drain_life') && cursed) {
        return buildAction('warlock_drain_life', cursed);
      }
      if (canUseSkill(npc, 'warlock_curse_amplify')) {
        const amplifyTarget = highestWeakness(foes, 'curse', 1);
        if (amplifyTarget) {
          return buildAction('warlock_curse_amplify', amplifyTarget);
        }
      }
      // Curse of Needles — Gary's signature, gated the same way the player
      // version is (target must already be at least Hexed) — so the target
      // picked here MUST already carry Curse T1+, never a fallback to
      // "whoever's weakest," or the cast would just fizzle against the
      // requiresWeakness gate. Prefers refreshing whoever already carries
      // the rider (keeps the Curse meter topped up) over a fresh cursed
      // target.
      if (canUseSkill(npc, 'warlock_curse_needles')) {
        const riderTarget = foes.find(f =>
          (f?.weakness?.tiers?.curse || 0) >= 1 &&
          Array.isArray(f?.statusEffects) && f.statusEffects.some(se => se?.id === 'warlock_curse_needles')
        );
        const focusTarget = riderTarget || highestWeakness(foes, 'curse', 1);
        if (focusTarget) return buildAction('warlock_curse_needles', focusTarget);
      }
      // Hex — establishes Curse buildup from scratch when nobody's cursed
      // yet, so Curse of Needles has something to extend once it's off
      // cooldown. Checked before Dark Bolts so curse actually gets started
      // instead of being crowded out by plain filler damage.
      if (canUseSkill(npc, 'warlock_hex')) {
        const target = weakest(foes);
        if (target) return buildAction('warlock_hex', target);
      }
      if (canUseSkill(npc, 'warlock_dark_bolts')) {
        const target = weakest(foes);
        if (target) return buildAction('warlock_dark_bolts', target);
      }
      if (canUseSkill(npc, 'dummy_sway')) {
        return buildAction('dummy_sway', null);
      }
      return null;
    }
  },

  ranger_dummy: {
    decide(npc, scene, enemies) {
      // Covering Shot — armed once and left armed, same idempotent pattern
      // as every other enemy reaction this pass.
      const alreadyArmed = scene?.reactions?.listPrepared?.(npc)?.some(r => r.id === 'ranger_covering_shot');
      if (!alreadyArmed && scene?.reactions?.arm && npc.skills?.includes('ranger_covering_shot')) {
        scene.reactions.arm(npc, SKILLS.ranger_covering_shot);
      }

      const { foes } = buildTargetList(npc, scene, enemies);
      const exposed = highestWeakness(foes, 'expose', 1);
      if (canUseSkill(npc, 'ranger_aimed_shot') && exposed) {
        return buildAction('ranger_aimed_shot', exposed);
      }
      if (canUseSkill(npc, 'ranger_volley') && foes.length >= 2) {
        const focus = pickTarget(foes, { preferLowHP: true, noise: 0.9 }) || foes[0];
        return buildAction('ranger_volley', focus);
      }
      if (canUseSkill(npc, 'ranger_frost_arrow')) {
        const target = weakest(foes);
        if (target) return buildAction('ranger_frost_arrow', target);
      }
      if (canUseSkill(npc, 'ranger_quick_shot')) {
        const target = weakest(foes);
        if (target) return buildAction('ranger_quick_shot', target);
      }
      if (canUseSkill(npc, 'dummy_sway')) {
        return buildAction('dummy_sway', null);
      }
      return null;
    }
  },

  rogue_dummy: {
    decide(npc, scene, enemies) {
      // Distracting Feint — armed once and left armed.
      const alreadyArmed = scene?.reactions?.listPrepared?.(npc)?.some(r => r.id === 'rogue_distracting_feint');
      if (!alreadyArmed && scene?.reactions?.arm && npc.skills?.includes('rogue_distracting_feint')) {
        scene.reactions.arm(npc, SKILLS.rogue_distracting_feint);
      }

      const { foes } = buildTargetList(npc, scene, enemies);

      // Curse Twist — bonus action, high priority whenever a target already
      // carries Gary's Curse of Needles rider. Costing only a bonus action
      // means this doesn't compete with whatever Mo does with his major/
      // class action the same turn.
      const curseRiderTarget = foes.find(f => Array.isArray(f?.statusEffects) && f.statusEffects.some(se => se?.id === 'warlock_curse_needles'));
      if (canUseSkill(npc, 'rogue_curse_twist') && curseRiderTarget) {
        return buildAction('rogue_curse_twist', curseRiderTarget);
      }

      const weaknessFamilies = ['expose', 'toxic', 'cold', 'fire', 'lacerate', 'disease', 'curse'];
      const finishingTarget = pickTarget(foes.filter(t => countWeaknessFamilies(t, weaknessFamilies, 1) >= 2), { preferLowHP: true, noise: 1 });
      if (canUseSkill(npc, 'rogue_finishing_strike') && finishingTarget) {
        return buildAction('rogue_finishing_strike', finishingTarget);
      }
      const exposed = highestWeakness(foes, 'expose', 1);
      if (canUseSkill(npc, 'rogue_sneak_attack') && exposed) {
        return buildAction('rogue_sneak_attack', exposed);
      }
      if (canUseSkill(npc, 'rogue_poisoned_knife')) {
        const target = weakest(foes);
        if (target) return buildAction('rogue_poisoned_knife', target);
      }
      if (canUseSkill(npc, 'rogue_hamstring')) {
        const target = weakest(foes);
        if (target) return buildAction('rogue_hamstring', target);
      }
      if (canUseSkill(npc, 'rogue_evasion')) {
        return buildAction('rogue_evasion', npc);
      }
      if (canUseSkill(npc, 'dummy_sway')) {
        return buildAction('dummy_sway', null);
      }
      return null;
    }
  },
  wizard_dummy: {
    decide(npc, scene, enemies) {
      const { foes } = buildTargetList(npc, scene, enemies);

      // Committed to the channeled Inferno the instant it's armed — always
      // takes priority over everything else, guaranteeing the release
      // actually happens the turn after Channel: Inferno is cast.
      if (hasStatus(npc, 'channeling_inferno') && canUseSkill(npc, 'wizard_inferno_release')) {
        const target = weakest(foes) || foes[0];
        if (target) return buildAction('wizard_inferno_release', target);
      }

      const charged = highestWeakness(foes, 'lightning', 1);
      if (canUseSkill(npc, 'wizard_overload') && charged) {
        return buildAction('wizard_overload', charged);
      }
      if (canUseSkill(npc, 'wizard_inferno_channel')) {
        return buildAction('wizard_inferno_channel', null);
      }
      if (canUseSkill(npc, 'wizard_mana_shield') && !hasStatus(npc, 'wizard_mana_shield')) {
        return buildAction('wizard_mana_shield', npc);
      }
      if (canUseSkill(npc, 'wizard_static_field')) {
        const target = weakest(foes);
        if (target) return buildAction('wizard_static_field', target);
      }
      if (canUseSkill(npc, 'wizard_arcane_bolt')) {
        const target = weakest(foes);
        if (target) return buildAction('wizard_arcane_bolt', target);
      }
      if (canUseSkill(npc, 'dummy_sway')) {
        return buildAction('dummy_sway', null);
      }
      return null;
    }
  },

  huntsman: {
    decide(npc, scene, enemies) {
      const { allies, foes } = buildTargetList(npc, scene, enemies);
      const marked = pickMarkedTarget(foes);
      if (canUseSkill(npc, 'huntsman_mark') && !marked) {
        const target = weakest(foes);
        if (target) return buildAction('huntsman_mark', target);
      }
      if (canUseSkill(npc, 'huntsman_command')) {
        const beasts = allies.filter(a => a !== npc && a.tags?.includes('beast'));
        const beast = firstAlive(beasts);
        if (beast) return buildAction('huntsman_command', beast);
      }
      if (canUseSkill(npc, 'huntsman_empower_pack') && marked && hasAnyWeakness(marked, ['expose', 'lacerate', 'disease', 'toxic'], 2)) {
        return buildAction('huntsman_empower_pack', marked);
      }
      if (canUseSkill(npc, 'huntsman_trap_shot')) {
        const target = marked || weakest(foes);
        if (target) return buildAction('huntsman_trap_shot', target);
      }
      return null;
    }
  },
  oskar_beast: {
    decide(npc, scene, enemies) {
      const { foes } = buildTargetList(npc, scene, enemies);
      const lacTarget = highestWeakness(foes, 'lacerate', 1);
      if (canUseSkill(npc, 'oskar_maw_rip') && lacTarget && hasAnyWeakness(lacTarget, ['lacerate'], 2)) {
        return buildAction('oskar_maw_rip', lacTarget);
      }
      const diseaseTarget = highestWeakness(foes, 'disease', 2);
      if (canUseSkill(npc, 'oskar_rotting_maw') && diseaseTarget) {
        return buildAction('oskar_rotting_maw', diseaseTarget);
      }
      if (canUseSkill(npc, 'oskar_rending_bite')) {
        const target = weakest(foes);
        if (target) return buildAction('oskar_rending_bite', target);
      }
      if (canUseSkill(npc, 'oskar_infectious_claw')) {
        const target = weakest(foes);
        if (target) return buildAction('oskar_infectious_claw', target);
      }
      return null;
    }
  },

  kiro_beast: {
    decide(npc, scene, enemies) {
      const { foes } = buildTargetList(npc, scene, enemies);
      const toxicTarget = highestWeakness(foes, 'toxic', 2);
      if (canUseSkill(npc, 'kiro_corrosive_bite') && toxicTarget) {
        return buildAction('kiro_corrosive_bite', toxicTarget);
      }
      const spreadTarget = highestWeakness(foes, 'toxic', 1);
      if (canUseSkill(npc, 'kiro_poison_cloud') && spreadTarget) {
        return buildAction('kiro_poison_cloud', spreadTarget);
      }
      if (canUseSkill(npc, 'kiro_toxic_spit')) {
        const target = weakest(foes);
        if (target) return buildAction('kiro_toxic_spit', target);
      }
      if (canUseSkill(npc, 'kiro_venomous_swipe')) {
        const target = weakest(foes);
        if (target) return buildAction('kiro_venomous_swipe', target);
      }
      return null;
    }
  },

  fire_duelist: {
    decide(npc, scene, enemies) {
      const { foes } = buildTargetList(npc, scene, enemies);
      const fireCharged = highestWeakness(foes, 'fire', 2);
      if (canUseSkill(npc, 'fire_burst') && fireCharged) {
        return buildAction('fire_burst', fireCharged);
      }
      if (canUseSkill(npc, 'fire_heated_guard') && !hasStatus(npc, 'heated_guard')) {
        return buildAction('fire_heated_guard', npc);
      }
      if (canUseSkill(npc, 'fire_flare_wave') && foes.length >= 2) {
        const target = weakest(foes) || foes[0];
        return buildAction('fire_flare_wave', target);
      }
      if (canUseSkill(npc, 'fire_flame_slash')) {
        const target = weakest(foes);
        if (target) return buildAction('fire_flame_slash', target);
      }
      return null;
    }
  },

  ice_duelist: {
    decide(npc, scene, enemies) {
      const { foes } = buildTargetList(npc, scene, enemies);
      const frozen = highestWeakness(foes, 'cold', 2);
      if (canUseSkill(npc, 'ice_freeze_point') && frozen) {
        return buildAction('ice_freeze_point', frozen);
      }
      if (canUseSkill(npc, 'ice_icy_guard') && !hasStatus(npc, 'icy_guard')) {
        return buildAction('ice_icy_guard', npc);
      }
      if (canUseSkill(npc, 'ice_shard_storm') && foes.length >= 2) {
        const target = weakest(foes) || foes[0];
        return buildAction('ice_shard_storm', target);
      }
      if (canUseSkill(npc, 'ice_frost_strike')) {
        const target = weakest(foes);
        if (target) return buildAction('ice_frost_strike', target);
      }
      return null;
    }
  },

  berserker_boss: {
    decide(npc, scene, enemies) {
      // Bosses don't go through the player's manual "prepare a reaction" UI,
      // so the AI arms Blood Fury itself, once, and keeps it armed for the
      // whole fight (arm() is idempotent, but gate on listPrepared anyway so
      // this doesn't spam "readies Blood Fury" into the log every turn).
      const alreadyArmed = scene?.reactions?.listPrepared?.(npc)?.some(r => r.id === 'berserker_blood_fury');
      if (!alreadyArmed && scene?.reactions?.arm) {
        scene.reactions.arm(npc, SKILLS.berserker_blood_fury);
      }

      const { foes } = buildTargetList(npc, scene, enemies);
      const heavyTarget = pickTarget(foes.filter(t => hasAnyWeakness(t, ['expose', 'lacerate'], 2)), { preferLowHP: true, noise: 0.9 });
      if (canUseSkill(npc, 'berserker_death_spiral') && heavyTarget) {
        return buildAction('berserker_death_spiral', heavyTarget);
      }
      if (canUseSkill(npc, 'berserker_battle_frenzy') && !hasStatus(npc, 'battle_frenzy')) {
        return buildAction('berserker_battle_frenzy', npc);
      }
      if (canUseSkill(npc, 'berserker_unstoppable_rush') && (npc.initiativeGauge || 0) >= 50) {
        const target = weakest(foes);
        if (target) return buildAction('berserker_unstoppable_rush', target);
      }
      // Both AOE moves now need a real primary target (see their definitions
      // in skills.js for why) — picked the same way every other single-target
      // move here already picks one.
      if (canUseSkill(npc, 'berserker_disrupting_roar')) {
        const target = weakest(foes);
        if (target) return buildAction('berserker_disrupting_roar', target);
      }
      if (canUseSkill(npc, 'berserker_bleeding_sweep')) {
        const target = weakest(foes);
        if (target) return buildAction('berserker_bleeding_sweep', target);
      }
      if (canUseSkill(npc, 'berserker_crushing_blow')) {
        const target = weakest(foes);
        if (target) return buildAction('berserker_crushing_blow', target);
      }
      if (canUseSkill(npc, 'berserker_guarded_fury')) {
        const target = weakest(foes);
        if (target) return buildAction('berserker_guarded_fury', target);
      }
      // Free fallback — every move above costs MP, so without this he'd go
      // completely idle on any turn he can't afford anything.
      if (canUseSkill(npc, 'berserker_reckless_strike')) {
        const target = weakest(foes);
        if (target) return buildAction('berserker_reckless_strike', target);
      }
      return null;
    }
  }
};
