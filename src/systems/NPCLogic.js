import { SKILLS } from '../../data/skills.js';

const isAlive = unit => unit && unit.status !== 'incapacitated';
const hpRatio = unit => {
  const max = Math.max(1, unit?.maxHP || 1);
  return Math.max(0, (unit?.currentHP || 0) / max);
};
const randRange = (min = 0, max = 1) => min + Math.random() * (max - min);
const hasStatus = (unit, id) => Array.isArray(unit?.statusEffects) && unit.statusEffects.some(se => se?.id === id);

function meetsWeaknessRequirement(target, requirement) {
  if (!requirement) return true;
  const reqs = Array.isArray(requirement) ? requirement : [requirement];
  for (const req of reqs) {
    if (!req?.family) continue;
    const tiers = target?.weakness?.tiers || {};
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

function pickTargetFrom(list, ability, opts = {}) {
  const requirement = opts.requirement ?? ability?.requiresWeakness;
  const candidates = (list || []).filter(u => isAlive(u) && meetsWeaknessRequirement(u, requirement));
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
  if ((npc.actionsLeft?.[type] || 0) <= 0) return false;
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

    let target = null;
    if (ability.requiresTarget) {
      const poolList = ability.targetRequirement === 'ally' ? allies : livingEnemies;
      target = pickTargetFrom(poolList, ability, { preferLowHP: ability.targetRequirement !== 'ally' ? true : undefined });
      if (!target && ability.targetRequirement === 'ally') {
        target = pickTargetFrom(poolList, ability, { preferLowHP: true }); // heal something if requirement missed
      }
    }

    if (ability.requiresTarget && !target) continue;
    candidates.push({ type, skill: id, target, weight: abilityWeight(ability, target) });
  }

  if (!candidates.length) return null;
  return weightedPick(candidates, c => c.weight);
}
