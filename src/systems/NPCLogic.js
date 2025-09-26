import { SKILLS } from '../../data/skills.js';

const isAlive = unit => unit && unit.status !== 'incapacitated';

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
function firstTarget(list, predicate = () => true) {
  if (!Array.isArray(list)) return null;
  for (const unit of list) {
    if (!isAlive(unit)) continue;
    if (!predicate(unit)) continue;
    return unit;
  }
 return null;
}

export function chooseNPCAction(npc, enemies, scene = null) {
  if (!npc) return null;

  const pool = npc.actionsLeft || {};
  const skillIds = (npc.skills || npc.weaponSkills || [])
    .map(s => typeof s === 'string' ? s : s?.id)
    .filter(Boolean);

  const abilities = skillIds
    .map(id => ({ id, ability: SKILLS[id] }))
    .filter(entry => entry.ability && (!entry.ability.actionCost || (pool[entry.ability.actionCost] || 0) > 0));

  if (!abilities.length) return null;

  const allies = scene?.enemies?.filter(isAlive) || [];
  const livingEnemies = (enemies || []).filter(isAlive);

  // Payoffs first (skills that explicitly require weakness or consume it)
  abilities.sort((a, b) => {
    const payoff = entry => (entry.ability.requiresWeakness || (Array.isArray(entry.ability.consumeWeakness) && entry.ability.consumeWeakness.length)) ? 1 : 0;
    const payoffDiff = payoff(b) - payoff(a);
    if (payoffDiff !== 0) return payoffDiff;
    const generator = entry => entry.ability.buildup ? 1 : 0;
    return generator(b) - generator(a);
  });

  const pickTarget = (ability) => {
    if (!ability.requiresTarget) return null;
    const req = ability.requiresWeakness;
    if (ability.targetRequirement === 'ally') {
      return firstTarget(allies, ally => meetsWeaknessRequirement(ally, req));
    }
    return firstTarget(livingEnemies, foe => meetsWeaknessRequirement(foe, req));
  };
  for (const { id, ability } of abilities) {
    const type = ability.actionCost || 'major';
    if (type === 'reaction') continue;
    if (pool[type] <= 0) continue;
    const target = pickTarget(ability);
    if (ability.requiresTarget && !target) continue;
    return { type, skill: id, target };
  }

  return null;
}
