// src/systems/Boons.js
//
// Prophet boons during a hunt (Exploration System v2, chunk 10b). Pure rules
// over the numbers and content in data/boons.js; the hunt keeps its boon in
// HuntEngine's state as { house, followed, favor, level }.
//
//   killFavor    favor a won fight pays: every member of a MARKED beast
//                occupant by grade. Unmarked and corrupted kills pay nothing
//                and cost nothing (owner, 2026-09-24: a penalty comes only
//                from specific chunk 11 events). Cultists pay nothing.
//   gain         raw favor -> what the hunt books, +FOLLOWED_FAVOR_PERCENT in
//                the lands of the house your tribe follows
//   levelFor     favor -> level, capped at UNFOLLOWED_MAX unless followed
//   boonEffects  a house and level -> the combined effects: later levels'
//                values for a key replace earlier ones; explore fields and
//                status mods of every level up to it; the capstone at 5

import {
  FAVOR_BY_GRADE, SHRINE_FAVOR, FOLLOWED_FAVOR_PERCENT, BOON_THRESHOLDS, UNFOLLOWED_MAX, BOONS,
} from '../../data/boons.js';

export { SHRINE_FAVOR };

/** The raw favor a won fight against `occ` pays. */
export function killFavor(occ) {
  if (!occ || occ.kind !== 'beast' || occ.mark !== 'marked') return 0;
  return (occ.roster || []).reduce((t, m) => t + (FAVOR_BY_GRADE[m.grade] || 0), 0);
}

/** Raw favor as the hunt books it: faster in your followed house's lands. */
export function gain(raw, followed) {
  if (!(raw > 0)) return 0;
  return followed ? raw * (1 + FOLLOWED_FAVOR_PERCENT / 100) : raw;
}

/** The boon level `favor` reaches. Level 5 only where your tribe's house watches. */
export function levelFor(favor, followed) {
  let lvl = 0;
  for (const t of BOON_THRESHOLDS) if (favor >= t) lvl++;
  return Math.min(lvl, followed ? BOON_THRESHOLDS.length : UNFOLLOWED_MAX);
}

/** Favor still needed for the next level, or null at the top (for the HUD). */
export function toNext(favor, followed) {
  const lvl = levelFor(favor, followed);
  const max = followed ? BOON_THRESHOLDS.length : UNFOLLOWED_MAX;
  return lvl >= max ? null : BOON_THRESHOLDS[lvl] - favor;
}

/** Whether `house` has boons written (only Jeremiah and Ezekiel so far). */
export function hasBoons(house) {
  return !!BOONS[house];
}

/**
 * What a house's boon does at `level`: every level up to it combined. Empty
 * at level 0 or for a house with no boons.
 */
export function boonEffects(house, level) {
  const out = { party: {}, enemies: {}, explore: {}, capstone: null, names: [] };
  const def = BOONS[house];
  if (!def) return out;
  for (const L of def.levels.slice(0, Math.max(0, level))) {
    Object.assign(out.party, L.party || {});
    Object.assign(out.enemies, L.enemies || {});
    for (const [k, v] of Object.entries(L.explore || {})) out.explore[k] = v;
    if (L.capstone) out.capstone = { ...L.capstone };
    out.names.push(L.name);
  }
  return out;
}

/** The level's own entry, for the level-up notice. */
export function levelDef(house, level) {
  return BOONS[house]?.levels[level - 1] || null;
}

export function houseTitle(house) {
  return BOONS[house]?.title || null;
}
