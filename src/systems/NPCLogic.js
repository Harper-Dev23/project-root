import { SKILLS } from '../../data/skills.js';

const isAlive = unit => unit && unit.status !== 'incapacitated';
const hpRatio = unit => {
  const max = Math.max(1, unit?.maxHP || 1);
  return Math.max(0, (unit?.currentHP || 0) / max);
};
const randRange = (min = 0, max = 1) => min + Math.random() * (max - min);
const hasStatus = (unit, id) => Array.isArray(unit?.statusEffects) && unit.statusEffects.some(se => se?.id === id);

function meetsWeaknessRequirement(user, target, requirement) {
  if (!requirement) return true;
  const reqs = Array.isArray(requirement) ? requirement : [requirement];
  for (const req of reqs) {
    if (!req?.family) continue;
    // req.on === 'self' checks the ACTING unit's own weakness, not the
    // target's (e.g. a skill gated on the caster's own Fire tier) — this
    // was always checking `target` regardless, silently wrong for any
    // skill using that field (none of the currently-flagged fizzles hit
    // this specifically, found auditing the surrounding checks).
    const location = req.on === 'self' ? user : target;
    const tiers = location?.weakness?.tiers || {};
    const minTier = req.tierAtLeast ?? req.tier ?? 1;
    if ((tiers[req.family] || 0) < minTier) return false;
  }
  return true;
}

function weightedPick(list, weightFn = () => 1) {
  if (!Array.isArray(list) || !list.length) return null;
  let total = 0;
  const scored = [];
  for (const item of list) {
    const weight = Math.max(0, weightFn(item) || 0);
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
}

function targetWeight(target, ability, opts = {}) {
  const noise = randRange(0.25, opts.noiseMax ?? 0.85);
  const hpBias = opts.preferLowHP === false ? 0 : (1 - hpRatio(target)) * 2;
  const families = [];
  const req = ability?.requiresWeakness;
  if (req) {
    (Array.isArray(req) ? req : [req]).forEach(r => { if (r?.family) families.push(r.family); });
  }
  if (Array.isArray(ability?.consumeWeakness)) families.push(...ability.consumeWeakness);
  if (Array.isArray(opts.preferWeaknessFamilies)) families.push(...opts.preferWeaknessFamilies);
  const tiers = target?.weakness?.tiers || {};
  const weaknessBias = families.reduce((sum, fam) => sum + (tiers[fam] || 0) * (opts.weaknessWeight ?? 1.25), 0);
  const markBias = hasStatus(target, 'huntsman_marked') ? 1.25 : 0;
  const allyHeals = ability?.targetRequirement === 'ally';
  const allyBias = allyHeals ? (1 - hpRatio(target)) * 2.2 : 0;
  return Math.max(0.1, 1 + noise + hpBias + weaknessBias + markBias + allyBias);
}

function pickTargetFrom(user, list, ability, opts = {}) {
  const requirement = opts.requirement ?? ability?.requiresWeakness;
  const candidates = (list || []).filter(u => isAlive(u) && meetsWeaknessRequirement(user, u, requirement));
  if (!candidates.length) return null;
  return weightedPick(candidates, t => targetWeight(t, ability, opts));
}

function abilityWeight(ability, target) {
  const base = 1 + randRange(0.3, 1.1);
  const finisherBias = target ? (1 - hpRatio(target)) : 0;
  const payoff = ability.requiresWeakness ? 1.4 : 0;
  const consume = Array.isArray(ability.consumeWeakness) && ability.consumeWeakness.length ? 0.8 : 0;
  const cooldownBias = ability.cooldown ? Math.min(1.2, ability.cooldown * 0.25) : 0;
  const mpBias = ability.mpCost ? Math.min(1, ability.mpCost / 8) : 0;
  return Math.max(0.1, base + finisherBias + payoff + consume + cooldownBias + mpBias);
}

function canAfford(npc, ability) {
  if (!ability) return false;
  const type = ability.actionCost || 'major';
  const mpCost = Math.max(0, ability.mpCost || 0);
  // 'free' actions bypass the action-point economy entirely — actionsLeft
  // never carries a 'free' key (see AIProfiles.js's canUseSkill, same fix),
  // so this always fell through to false for any free-cost skill.
  if (type !== 'free' && (npc.actionsLeft?.[type] || 0) <= 0) return false;
  if ((npc.cooldowns?.[ability.id] || 0) > 0) return false;
  return (npc.currentMP ?? 0) >= mpCost;
}

export function chooseNPCAction(npc, enemies, scene = null) {
  if (!npc) return null;

  const pool = npc.actionsLeft || {};
  const skillIds = [...new Set([...(npc.skills || []), ...(npc.weaponSkills || [])])]
    .map(s => typeof s === 'string' ? s : s?.id)
    .filter(Boolean);

  const abilities = skillIds
    .map(id => ({ id, ability: SKILLS[id] }))
    .filter(entry => entry.ability && (!entry.ability.actionCost || (pool[entry.ability.actionCost] || 0) > 0));

  if (!abilities.length) return null;

  const allies = scene?.enemies?.filter(isAlive) || [];
  const livingEnemies = (enemies || []).filter(isAlive);

  const candidates = [];
  for (const { id, ability } of abilities) {
    const type = ability.actionCost || 'major';
    if (type === 'reaction') continue;
    if (!canAfford(npc, ability)) continue;

    // Generic Initiative Gauge gate (e.g. Bulwark Call, Mending Wave) — the
    // same check _applyAbilityToTarget enforces downstream. Without this,
    // this fallback picker would happily "choose" one of these skills any
    // time it's off cooldown and affordable, only for it to fizzle the
    // moment it's actually cast — repeatedly, since AI_PROFILES.decide()
    // returning null for one action slot is exactly when this fallback runs.
    if (Number.isFinite(ability.requiresInitiativeGauge) && ability.requiresInitiativeGauge > 0) {
      if ((npc.initiativeGauge || 0) < ability.requiresInitiativeGauge) continue;
    }

    let target = null;
    if (ability.requiresTarget) {
      const poolList = ability.targetRequirement === 'ally' ? allies : livingEnemies;
      target = pickTargetFrom(npc, poolList, ability, { preferLowHP: ability.targetRequirement !== 'ally' ? true : undefined });
      if (!target && ability.targetRequirement === 'ally') {
        target = pickTargetFrom(npc, poolList, ability, { preferLowHP: true }); // heal something if requirement missed
      }
    }

    if (ability.requiresTarget && !target) continue;

    // canExecute — custom gates a declarative field can't express (e.g.
    // Finishing Strike's "target has 2+ weakness families", Reckless
    // Immolation's ">80% own HP"). Same check _executeSkill/
    // _applyAbilityToTarget run before actually casting — this fallback
    // picker needs it too, or it'll "choose" a skill that's just going to
    // fizzle downstream.
    if (typeof ability.canExecute === 'function') {
      const verdict = ability.canExecute({ user: npc, target, scene }) ?? true;
      const failed = (typeof verdict === 'object') ? (verdict.ok === false) : (verdict === false);
      if (failed) continue;
    }

    candidates.push({ type, skill: id, target, weight: abilityWeight(ability, target) });
  }

  if (!candidates.length) return null;
  return weightedPick(candidates, c => c.weight);
}
