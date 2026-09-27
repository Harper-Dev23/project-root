// tools/headless/fightPlayer.js
//
// The hunters' autopilot for headless fights: huntsim's fight player, moved
// here unchanged (chunk 14b-4c) so the boss calibration plays hunters exactly
// as the hunt simulator does. Heals the lowest ally under `healBelow` if it
// can; otherwise casts a random ready offensive skill (not Basic Attack when
// anything else is ready) at the weakest legal target, up to four casts a turn.

import { cast } from './fight.js';
import { getWeaponSkillsFor, getClassSkillsFor } from '../../data/skills.js';

export function fightPlayer(rand, { healBelow = 0.5 } = {}) {
  const HEAL_BELOW_HP = healBelow;
  const hpShare = (c) => (c.maxHP ? c.currentHP / c.maxHP : 1);
  const alive = (c) => c && c.status !== 'incapacitated' && c.status !== 'dead' && c.currentHP > 0;
  return (host, actor) => {
    let casts = 0;
    for (let guard = 0; guard < 4 && !host.combatEnded; guard++) {
      // A reaction to the last cast can knock the actor out mid-turn.
      if (!alive(actor) || !host.turnOrder.includes(actor)) break;
      // The action menu's kit (CombatScene: own skills, weapon, class), by id.
      const kit = new Map();
      for (const s of [...(actor.skills || []), ...getWeaponSkillsFor(actor), ...getClassSkillsFor(actor)]) if (s?.id && !kit.has(s.id)) kit.set(s.id, s);
      const ready = [...kit.values()].filter(s => !s.hidden && s.mechanic !== 'reaction' && host._skillIsUsable(actor, s));
      if (!ready.length) break;
      const hurt = host._party().filter(alive).filter(c => hpShare(c) < HEAL_BELOW_HP).sort((a, b) => hpShare(a) - hpShare(b));
      const heals = ready.filter(s => (s.tags || []).includes('heal') && s.targetRequirement === 'ally');
      let pick = null, target = null;
      if (hurt.length && heals.length) {
        pick = heals[Math.floor(rand() * heals.length)];
        const legal = host._validTargetsFor(actor, pick).map(sl => sl.char);
        target = hurt.find(c => legal.includes(c)) || null;
        if (!target) pick = null;
      }
      if (!pick) {
        const offence = ready.filter(s => s.targetRequirement === 'enemy');
        if (!offence.length) break;
        const nonBasic = offence.filter(s => s.id !== 'basic_attack');
        const pool = nonBasic.length ? nonBasic : offence;
        pick = pool[Math.floor(rand() * pool.length)];
        if (pick.requiresTarget !== false) {
          const legal = host._validTargetsFor(actor, pick).map(sl => sl.char).filter(alive);
          target = legal.sort((a, b) => a.currentHP - b.currentHP)[0] || null;
          if (!target && pick.requiresTarget) break;
        }
      }
      const r = cast(host, actor, pick, target);
      if (r.ok === false) break;
      casts++;
    }
    return [];   // everything was cast above; runFight just ends the turn
  };
}

