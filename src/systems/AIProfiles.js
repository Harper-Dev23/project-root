// Advanced encounter AI profiles

const isAlive = unit => unit && unit.status !== 'incapacitated';

const hasAction = (npc, type) => (npc?.actionsLeft?.[type] || 0) > 0;

const firstAlive = list => Array.isArray(list) ? list.find(isAlive) : null;

const weakest = list => {
  const alive = (list || []).filter(isAlive);
  if (!alive.length) return null;
  return alive.reduce((a, b) => ((a.currentHP / (a.maxHP || 1)) <= (b.currentHP / (b.maxHP || 1))) ? a : b);
};

const highestWeakness = (targets, family, minTier = 1) => {
  const filtered = (targets || []).filter(t => isAlive(t) && ((t.weakness?.tiers?.[family] || 0) >= minTier));
  if (!filtered.length) return null;
  return filtered.reduce((best, curr) => {
    const bestMeter = best?.weakness?.meters?.[family] || 0;
    const currMeter = curr?.weakness?.meters?.[family] || 0;
    return currMeter > bestMeter ? curr : best;
  }, filtered[0]);
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
  return (enemies || []).find(e => Array.isArray(e?.statusEffects) && e.statusEffects.some(se => se?.id === 'huntsman_marked')) || null;
}

export const AI_PROFILES = {


  stationary_dummy: {
    decide(npc) {
      if (hasAction(npc, 'major') && (npc.skills || []).includes('dummy_sway')) {
        return { type: 'major', skill: 'dummy_sway', target: null };
      }
      return null;
    }
  },

  warmup_dummy: {
    decide(npc, scene, enemies) {
      const { foes } = buildTargetList(npc, scene, enemies);
      const target = weakest(foes);
      if (!target) return null;
      if (hasAction(npc, 'class') && (npc.currentHP || 0) <= 0.6 * (npc.maxHP || 1)) {
        return { type: 'class', skill: 'warmup_patch', target: npc };
      }
      if (hasAction(npc, 'major')) {
        return { type: 'major', skill: 'warmup_swing', target };
      }
      if (hasAction(npc, 'bonus')) {
        return { type: 'bonus', skill: 'dummy_sway', target: null };
      }
      return null;
    }
  },

  defensive_dummy: {
    decide(npc, scene, enemies) {
      const { allies, foes } = buildTargetList(npc, scene, enemies);
      const allyToHeal = allies.find(a => (a.currentHP || 0) < 0.65 * (a.maxHP || 1));
      if (hasAction(npc, 'class') && allyToHeal) {
        return { type: 'class', skill: 'defender_small_heal', target: allyToHeal };
      }
      if (hasAction(npc, 'bonus') && !hasStatus(npc, 'defender_guard')) {
        return { type: 'bonus', skill: 'defender_guard_raise', target: npc };
      }
      if (hasAction(npc, 'major')) {
        const exposedTarget = highestWeakness(foes, 'expose', 1) || weakest(foes);
        if (!exposedTarget) return null;
        return { type: 'major', skill: 'defender_taunt', target: exposedTarget };
      }
      return null;
    }
  },

  offensive_dummy: {
    decide(npc, scene, enemies) {
      const { foes } = buildTargetList(npc, scene, enemies);
      const target = weakest(foes);
      if (!target) return null;
      if (hasAction(npc, 'major')) {
        return { type: 'major', skill: 'offender_expose_strike', target };
      }
      if (hasAction(npc, 'bonus') && Math.random() < 0.4) {
        return { type: 'bonus', skill: 'dummy_shuffle', target: null };
      }
      return null;
    }
  },

  fighter_dummy: {
    decide(npc, scene, enemies) {
      const { foes } = buildTargetList(npc, scene, enemies);
      const executionTarget = highestWeakness(foes, 'expose', 2);
      if (hasAction(npc, 'major') && executionTarget) {
        return { type: 'major', skill: 'fighter_executioner', target: executionTarget };
      }
      const tauntTarget = highestWeakness(foes, 'expose', 1);
      if (hasAction(npc, 'class') && tauntTarget) {
        return { type: 'class', skill: 'fighter_taunt', target: tauntTarget };
      }
      if (hasAction(npc, 'bonus') && !hasStatus(npc, 'fighter_guard')) {
        const target = weakest(foes);
        if (target) return { type: 'bonus', skill: 'fighter_guarded_blow', target };
      }
      if (hasAction(npc, 'major')) {
        const target = weakest(foes);
        if (target) return { type: 'major', skill: 'fighter_heavy_slash', target };
      }
      return null;
    }
  },

  healer_dummy: {
    decide(npc, scene, enemies) {
      const { allies, foes } = buildTargetList(npc, scene, enemies);
      const lowAlly = allies.find(a => (a.currentHP || 0) < 0.75 * (a.maxHP || 1));
      if (hasAction(npc, 'major') && lowAlly) {
        return { type: 'major', skill: 'healer_heal', target: lowAlly };
      }
      const afflicted = allies.find(a => hasAnyWeakness(a, ['curse', 'disease', 'toxic']));
      if (hasAction(npc, 'class') && afflicted) {
        return { type: 'class', skill: 'healer_cleanse', target: afflicted };
      }
      if (hasAction(npc, 'bonus')) {
        const blessTarget = allies.find(a => !hasStatus(a, 'healer_blessing'));
        if (blessTarget) {
          return { type: 'bonus', skill: 'healer_blessing', target: blessTarget };
        }
        const enemy = weakest(foes);
        if (enemy) return { type: 'bonus', skill: 'healer_flame_flick', target: enemy };
      }
      return null;
    }
  },

  warlock_dummy: {
    decide(npc, scene, enemies) {
      const { foes } = buildTargetList(npc, scene, enemies);
      const cursed = highestWeakness(foes, 'curse', 2) || highestWeakness(foes, 'curse', 1);
      if (hasAction(npc, 'major') && cursed) {
        return { type: 'major', skill: 'warlock_drain_life', target: cursed };
      }
      if (hasAction(npc, 'class')) {
        const amplifyTarget = highestWeakness(foes, 'curse', 1);
        if (amplifyTarget) {
          return { type: 'class', skill: 'warlock_curse_amplify', target: amplifyTarget };
        }
      }
      if (hasAction(npc, 'bonus')) {
        const target = weakest(foes);
        if (target) return { type: 'bonus', skill: 'warlock_dark_bolts', target };
      }
      if (hasAction(npc, 'major')) {
        const target = weakest(foes);
        if (target) return { type: 'major', skill: 'warlock_hex', target };
      }
      return null;
    }
  },

  ranger_dummy: {
    decide(npc, scene, enemies) {
      const { foes } = buildTargetList(npc, scene, enemies);
      const exposed = highestWeakness(foes, 'expose', 1);
      if (hasAction(npc, 'major') && exposed) {
        return { type: 'major', skill: 'ranger_aimed_shot', target: exposed };
      }
      if (hasAction(npc, 'class') && foes.length >= 2) {
        return { type: 'class', skill: 'ranger_volley', target: foes[0] };
      }
      if (hasAction(npc, 'major')) {
        const target = weakest(foes);
        if (target) return { type: 'major', skill: 'ranger_frost_arrow', target };
      }
      if (hasAction(npc, 'bonus')) {
        const target = weakest(foes);
        if (target) return { type: 'bonus', skill: 'ranger_quick_shot', target };
      }
      return null;
    }
  },

  rogue_dummy: {
    decide(npc, scene, enemies) {
      const { foes } = buildTargetList(npc, scene, enemies);
      const weaknessFamilies = ['expose', 'toxic', 'cold', 'fire', 'lacerate', 'disease', 'curse'];
      const finishingTarget = foes.find(t => countWeaknessFamilies(t, weaknessFamilies, 1) >= 2);
      if (hasAction(npc, 'class') && finishingTarget) {
        return { type: 'class', skill: 'rogue_finishing_strike', target: finishingTarget };
      }
      const exposed = highestWeakness(foes, 'expose', 1);
      if (hasAction(npc, 'major') && exposed) {
        return { type: 'major', skill: 'rogue_sneak_attack', target: exposed };
      }
      if (hasAction(npc, 'bonus')) {
        const target = weakest(foes);
        if (target) return { type: 'bonus', skill: 'rogue_poisoned_knife', target };
      }
      if (hasAction(npc, 'major')) {
        const target = weakest(foes);
        if (target) return { type: 'major', skill: 'rogue_hamstring', target };
      }
      if (hasAction(npc, 'bonus')) {
        return { type: 'bonus', skill: 'rogue_evasion', target: npc };
      }
      return null;
    }
  },
  huntsman: {
    decide(npc, scene, enemies) {
      const { allies, foes } = buildTargetList(npc, scene, enemies);
      const marked = pickMarkedTarget(foes);
      if (hasAction(npc, 'bonus') && !marked) {
        const target = weakest(foes);
        if (target) return { type: 'bonus', skill: 'huntsman_mark', target };
      }
      if (hasAction(npc, 'class')) {
        const beasts = allies.filter(a => a !== npc && a.tags?.includes('beast'));
        const beast = firstAlive(beasts);
        if (beast) return { type: 'class', skill: 'huntsman_command', target: beast };
      }
      if (hasAction(npc, 'bonus') && marked && hasAnyWeakness(marked, ['expose', 'lacerate', 'disease', 'toxic'], 2)) {
        return { type: 'bonus', skill: 'huntsman_empower_pack', target: marked };
      }
      if (hasAction(npc, 'major')) {
        const target = marked || weakest(foes);
        if (target) return { type: 'major', skill: 'huntsman_trap_shot', target };
      }
      return null;
    }
  },
  oskar_beast: {
    decide(npc, scene, enemies) {
      const { foes } = buildTargetList(npc, scene, enemies);
      const lacTarget = highestWeakness(foes, 'lacerate', 1);
      if (hasAction(npc, 'major') && lacTarget && hasAnyWeakness(lacTarget, ['lacerate'], 2)) {
        return { type: 'major', skill: 'oskar_maw_rip', target: lacTarget };
      }
      const diseaseTarget = highestWeakness(foes, 'disease', 2);
      if (hasAction(npc, 'class') && diseaseTarget) {
        return { type: 'class', skill: 'oskar_rotting_maw', target: diseaseTarget };
      }
      if (hasAction(npc, 'major')) {
        const target = weakest(foes);
        if (target) return { type: 'major', skill: 'oskar_rending_bite', target };
      }
      if (hasAction(npc, 'bonus')) {
        const target = weakest(foes);
        if (target) return { type: 'bonus', skill: 'oskar_infectious_claw', target };
      }
      return null;
    }
  },

  kiro_beast: {
    decide(npc, scene, enemies) {
      const { foes } = buildTargetList(npc, scene, enemies);
      const toxicTarget = highestWeakness(foes, 'toxic', 2);
      if (hasAction(npc, 'major') && toxicTarget) {
        return { type: 'major', skill: 'kiro_corrosive_bite', target: toxicTarget };
      }
      const spreadTarget = highestWeakness(foes, 'toxic', 1);
      if (hasAction(npc, 'class') && spreadTarget) {
        return { type: 'class', skill: 'kiro_poison_cloud', target: spreadTarget };
      }
      if (hasAction(npc, 'bonus')) {
        const target = weakest(foes);
        if (target) return { type: 'bonus', skill: 'kiro_toxic_spit', target };
      }
      if (hasAction(npc, 'major')) {
        const target = weakest(foes);
        if (target) return { type: 'major', skill: 'kiro_venomous_swipe', target };
      }
      return null;
    }
  },

  fire_duelist: {
    decide(npc, scene, enemies) {
      const { foes } = buildTargetList(npc, scene, enemies);
      const fireCharged = highestWeakness(foes, 'fire', 2);
      if (hasAction(npc, 'class') && fireCharged) {
        return { type: 'class', skill: 'fire_burst', target: fireCharged };
      }
      if (hasAction(npc, 'bonus') && !hasStatus(npc, 'heated_guard')) {
        return { type: 'bonus', skill: 'fire_heated_guard', target: npc };
      }
      if (hasAction(npc, 'major')) {
        const target = weakest(foes);
        if (target) return { type: 'major', skill: 'fire_flame_slash', target };
      }
      if (hasAction(npc, 'major') && foes.length >= 2) {
        return { type: 'major', skill: 'fire_flare_wave', target: foes[0] };
      }
      return null;
    }
  },

  ice_duelist: {
    decide(npc, scene, enemies) {
      const { foes } = buildTargetList(npc, scene, enemies);
      const frozen = highestWeakness(foes, 'cold', 2);
      if (hasAction(npc, 'class') && frozen) {
        return { type: 'class', skill: 'ice_freeze_point', target: frozen };
      }
      if (hasAction(npc, 'bonus') && !hasStatus(npc, 'icy_guard')) {
        return { type: 'bonus', skill: 'ice_icy_guard', target: npc };
      }
      if (hasAction(npc, 'major') && foes.length >= 2) {
        return { type: 'major', skill: 'ice_shard_storm', target: foes[0] };
      }
      if (hasAction(npc, 'major')) {
        const target = weakest(foes);
        if (target) return { type: 'major', skill: 'ice_frost_strike', target };
      }
      return null;
    }
  },

  berserker_boss: {
    decide(npc, scene, enemies) {
      const { foes } = buildTargetList(npc, scene, enemies);
      const heavyTarget = foes.find(t => hasAnyWeakness(t, ['expose', 'lacerate'], 2));
      if (hasAction(npc, 'class') && heavyTarget) {
        return { type: 'class', skill: 'berserker_death_spiral', target: heavyTarget };
      }
      if (hasAction(npc, 'bonus') && !hasStatus(npc, 'battle_frenzy')) {
        return { type: 'bonus', skill: 'berserker_battle_frenzy', target: npc };
      }
      if (hasAction(npc, 'major') && (npc.initiativeGauge || 0) >= 50) {
        const target = weakest(foes);
        if (target) return { type: 'major', skill: 'berserker_unstoppable_rush', target };
      }
      if (hasAction(npc, 'major')) {
        const target = weakest(foes);
        if (target) return { type: 'major', skill: 'berserker_crushing_blow', target };
      }
      if (hasAction(npc, 'bonus')) {
        const target = weakest(foes);
        if (target) return { type: 'bonus', skill: 'berserker_guarded_fury', target };
      }
      if (hasAction(npc, 'class')) {
        return { type: 'class', skill: 'berserker_disrupting_roar', target: npc };
      }
      return null;
    }
  }
};
