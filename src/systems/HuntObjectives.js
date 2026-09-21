// src/systems/HuntObjectives.js
//
// How far a map hunt has got with its plan, and what leaving pays
// (Exploration System v2, chunk 7d). Design: the vault's HUNT_PLANS (what
// completes a hunt), PLAN_AFFIXES (bonus objectives, "carried home"),
// HUNT_STRUCTURE (the completion reward is paid at the exit; leaving early
// keeps everything earned but forfeits it).
//
// Pure: reads a map hunt's state (HuntEngine.js) and nothing else. Each
// objective's `params` and the ids the generator resolved it to (obj.sites,
// obj.occupant, obj.family, obj.site, obj.beforeDay) are on the map, so a
// deploy cannot change what a live hunt is asking for.
//
// Every objective is checkable since chunk 9d: Unbroken off the hunt's
// knock-out count (9c), Trophy off the core parts of Prime-or-better beasts in
// the pack (9d). PENDING_UNTIL stays, empty, for objectives yet to come.
//
// All numbers are placeholders until chunk 13.

import { PLAN_TIER_IMPLICITS, planTierFor } from '../../data/planAffixes.js';
import { Items } from '../../data/items.js';
import { TROPHY_GRADES } from '../../data/beastParts.js';
import { clockAt } from './HuntRules.js';

/** The completion reward, in Hunt Points, by map size (chunk 7 decision 11),
 *  before the plan's completionRewardPercent. */
export const COMPLETION_HUNT_POINTS = { small: 20, medium: 35, large: 50 };

/**
 * A done bonus objective pays this many Hunt Points per plan item level
 * (PLAN_AFFIXES: "its reward scales with the plan's item level"). A
 * placeholder Claude chose in 7d: no note set the number.
 */
export const BONUS_HUNT_POINTS_PER_ITEM_LEVEL = 5;

/** Objectives that wait for the combat hookup, and what they wait for. */
export const PENDING_UNTIL = {};

/** The plan's completion-reward percent: its prefixes' share plus its tier's implicit. */
export function completionRewardPercent(planMods = {}, itemLevel = 1) {
  const implicit = PLAN_TIER_IMPLICITS[planTierFor(itemLevel)]?.completionRewardPercent || 0;
  return (Number(planMods.completionRewardPercent) || 0) + implicit;
}

/** The completion reward in Hunt Points for a size and percent, whole points. */
export function completionReward(size, percent) {
  return Math.round((COMPLETION_HUNT_POINTS[size] || 0) * (1 + (percent || 0) / 100));
}

/** A done bonus objective's reward at a plan item level. */
export function bonusReward(itemLevel = 1) {
  return BONUS_HUNT_POINTS_PER_ITEM_LEVEL * Math.max(1, Math.floor(itemLevel || 1));
}

function killedMembers(s, pred) {
  let n = 0;
  for (const k of s.kills) for (const m of k.roster) if (pred(k, m)) n++;
  return n;
}

/** Gathered food still in the pack (Provisioner counts what is carried home). */
function gatheredFoodCarried(s) {
  let n = 0;
  for (const it of s.pack.found) {
    const f = Items[it.id]?.food;
    if (f && (f.kind === 'forage' || f.kind === 'fish')) n += it.qty || 1;
  }
  return n;
}

/**
 * One objective's progress. `atExit` is true when judging a clean exit, which
 * is where "carried home" objectives and Swift Return are decided.
 * Returns { id, name, have, need, done, pending?, carriedHome? }.
 */
function judge(s, obj, { atExit }) {
  const seen = (id) => !!s.fog[id];
  switch (obj.id) {
    case 'scout': {
      const have = obj.sites.filter(seen).length;
      return { have, need: obj.sites.length, done: have >= obj.sites.length };
    }
    case 'apex': {
      const done = s.kills.some(k => k.occId === obj.occupant);
      return { have: done ? 1 : 0, need: 1, done };
    }
    case 'cull':
    case 'named_quarry': {
      const need = obj.count ?? obj.params.count;
      const have = killedMembers(s, (k) => k.kind === 'beast' && k.family === obj.family);
      return { have, need, done: have >= need, family: obj.family };
    }
    case 'retrieve': {
      // Taken by standing on the site; it counts when carried out.
      const have = s.retrieved ? 1 : 0;
      return { have, need: 1, done: !!s.retrieved && atExit, carriedHome: true };
    }
    case 'commune': {
      // Reaching the shrine, until Events v2 (chunk 11) gives it a resolution.
      const have = s.communed ? 1 : 0;
      return { have, need: 1, done: !!s.communed };
    }
    case 'pathfinder': {
      const total = Object.keys(s.map.tiles).length;
      const have = Math.floor(Object.keys(s.fog).length / total * 100);
      return { have, need: obj.params.revealPct, done: have >= obj.params.revealPct };
    }
    case 'provisioner': {
      const have = gatheredFoodCarried(s);
      return { have, need: obj.params.count, done: atExit && have >= obj.params.count, carriedHome: true };
    }
    case 'swift_return': {
      const day = clockAt(s.time).day;
      return { have: day, need: obj.beforeDay, done: atExit && day < obj.beforeDay, beforeDay: obj.beforeDay };
    }
    case 'cleanse': {
      const have = s.cleansed.length;
      return { have, need: 1, done: have >= 1 };
    }
    case 'great_quarry': {
      const have = killedMembers(s, (k, m) => k.kind === 'beast' && m.grade === 'great');
      return { have, need: 1, done: have >= 1 };
    }
    case 'unmask': {
      const have = s.unmasked.length;
      return { have, need: 1, done: have >= 1 };
    }
    // Carry home a core part from a Prime-or-better beast (PLAN_AFFIXES):
    // harvested parts record their beast's grade, stacks included.
    case 'trophy': {
      const have = s.pack.found.filter(it => Items[it.id]?.part?.core && TROPHY_GRADES.includes(it.grade))
        .reduce((t, it) => t + (it.qty || 1), 0);
      return { have, need: 1, done: atExit && have >= 1, carriedHome: true };
    }
    // No hunter knocked out in any fight this hunt, fled fights included
    // (chunk 9 decision 15). A hunt with no fight won has not earned it: a
    // hunt that avoided every fight is not "unbroken", it is untested (a
    // Claude call in 9c, flagged to the owner).
    case 'unbroken': {
      const ko = s.knockouts || 0;
      const done = ko === 0 && (s.kills || []).length > 0;
      return { have: done ? 1 : 0, need: 1, done, knockouts: ko };
    }
    default:
      throw new Error(`no completion check for objective '${obj.id}'`);
  }
}

/** Every objective id judge() can check: the harness fails if one is missing. */
export const CHECKED_OBJECTIVES = ['scout', 'apex', 'cull', 'retrieve', 'commune', 'pathfinder', 'named_quarry',
  'provisioner', 'trophy', 'unbroken', 'swift_return', 'cleanse', 'great_quarry', 'unmask'];

/** The hunt's objectives, primary first, with their progress now. */
export function objectiveProgress(s, { atExit = false } = {}) {
  const { primary, bonus } = s.map.objectives;
  return [
    { kind: 'primary', id: primary.id, ...judge(s, primary, { atExit }) },
    ...bonus.map(b => ({ kind: 'bonus', id: b.id, ...judge(s, b, { atExit }) })),
  ];
}

/**
 * What a clean exit pays, in Hunt Points. The completion reward only if the
 * primary objective is done; each done bonus objective on top, whatever the
 * primary (bonus objectives stay available until you leave, and count at a
 * clean exit). A wipe pays none of it.
 */
export function exitReward(s) {
  const progress = objectiveProgress(s, { atExit: true });
  const primaryDone = progress[0].done;
  const completion = primaryDone ? completionReward(s.plan.size, s.plan.completionRewardPercent) : 0;
  const bonuses = progress.filter(p => p.kind === 'bonus' && p.done).map(p => ({ id: p.id, huntPoints: bonusReward(s.plan.itemLevel) }));
  return {
    primaryDone,
    completion,
    bonuses,
    huntPoints: completion + bonuses.reduce((t, b) => t + b.huntPoints, 0),
    progress,
  };
}
