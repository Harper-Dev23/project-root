// src/systems/HuntRules.js
//
// The hunt's rules as pure functions (Exploration System v2, chunk 7). Design:
// the vault's MOVEMENT_VISION_FOG (Cost / Sight / Detection), TERRAIN_TYPES
// (costs, blocking, concealment, the three Detection bands), ENCOUNTERS (what
// a detected occupant shows, the scout action), HUNT_STRUCTURE (the clock).
//
// No state, no Phaser, no randomness. HuntEngine.js holds a hunt and calls
// these; the harness (tools/headless/huntrules.mjs) calls the same exports and
// never re-derives a rule to check it.
//
// Three primitives, one job each (MOVEMENT_VISION_FOG, owner 2026-09-17):
//   Cost       what a move spends: supplies (Endurance) and time (Speed)
//   Sight      which tiles are visible: range + blocking terrain, never Perception
//   Detection  how much you learn about what is on a visible tile: Perception
//              vs concealment, deterministic, three bands
//
// Every number here is a placeholder until chunk 13 (owner, sign-off of the
// chunk 7 decisions, 2026-09-19).

import { line, parseTileId, distance, tileId } from './HexGrid.js';
import { GROUNDS, RELIEF, tileCosts } from '../../data/grounds.js';
import { DAY_TIME_UNITS, GRADES, COMPOSITIONS } from '../../data/huntMapGen.js';
import { combineModifiers } from './HuntModifiers.js';
import { mapNeighbors, occupantConcealment } from './HuntMapGen.js';

// ── Constants ────────────────────────────────────────────────────────────────

/** Sight range everyone has before any named source (decision 2). */
export const BASE_SIGHT_RANGE = 2;

/**
 * Detection's middle band: Perception at least this far below concealment is
 * "sensed". Was 3 in TERRAIN_TYPES, written before concealment moved to the
 * 0-100 scale in steps of 10-20, where 3 almost never applied (decision 1).
 */
export const SENSED_MARGIN = 15;

/** A move always costs at least this share of the tile's cost, on each axis,
 *  however much efficiency the party has: travel is never free (decision 3). */
export const MIN_MOVE_COST_SHARE = 0.25;

/** Day and night each last half of DAY_TIME_UNITS (12): 6 units each. */
export const PHASE_UNITS = DAY_TIME_UNITS / 2;

/** The scout action's time: about one average move (ENCOUNTERS; grounds
 *  average 2.23 time). No supplies, and the party does not move. */
export const SCOUT_TIME = 2;

// ── The modifier bundle ──────────────────────────────────────────────────────

/**
 * Plan fields that are not summed by combineModifiers but are read by
 * partyStats (PartyStats.js). They are taken off the plan as they are.
 */
export const PLAN_ONLY_PARTY_FIELDS = ['perceptionBonus', 'travelTimePercent', 'harvestYieldPercent'];

/**
 * The hunt's modifier bundle, the `mods` that partyStats(party, mods) reads:
 * zone + weather + plan summed (combineModifiers), plus the plan-only fields.
 * Built once at departure and kept on the hunt, like combinedModifiers: a
 * deploy cannot change what a live hunt runs on. Hunger and food join as
 * partyInitiativeBonus in 7b.
 */
export function huntMods(zoneMods, weatherMods, planMods) {
  const mods = combineModifiers(zoneMods, weatherMods, planMods);
  for (const f of PLAN_ONLY_PARTY_FIELDS) mods[f] = Number(planMods?.[f]) || 0;
  return mods;
}

// ── Cost ─────────────────────────────────────────────────────────────────────

/**
 * What entering `tile` costs this party, or null if it cannot be entered.
 * `stats` is partyStats() output: supplyEfficiencyPercent (Endurance's curve
 * plus the bundle's share) and travelTimePercent (Speed's curve plus the
 * plan's). Fractional on purpose: a flat floor of 1 would make every
 * efficiency bonus worthless on grass (decision 3).
 */
export function moveCost(tile, stats) {
  const base = tileCosts(tile);
  if (!base) return null;
  const scale = (cost, pct) => Math.max(cost * MIN_MOVE_COST_SHARE, cost * (1 - (pct || 0) / 100));
  return {
    supply: scale(base.supply, stats.supplyEfficiencyPercent),
    time: scale(base.time, stats.travelTimePercent),
    base,
  };
}

// ── The clock ────────────────────────────────────────────────────────────────

/**
 * Where a hunt stands at `time` units elapsed. The hunt starts at 0, day 1,
 * in daylight; night falls at 6, day 2 breaks at 12, and so on.
 */
export function clockAt(time) {
  const phase = Math.floor((time + 1e-9) / PHASE_UNITS);
  return { day: Math.floor(phase / 2) + 1, isNight: phase % 2 === 1, phase };
}

// ── Sight ────────────────────────────────────────────────────────────────────

/** True if this tile stops sight past it. `ignores` lists grounds or reliefs
 *  that no longer block (MOVEMENT_VISION_FOG's sightIgnores). */
export function blocksSight(tile, ignores = []) {
  if (!tile) return false;
  const g = GROUNDS[tile.ground];
  const rel = tile.relief || 'flat';
  return (!!g?.blocksSight && !ignores.includes(tile.ground))
      || (!!RELIEF[rel]?.blocksSight && !ignores.includes(rel));
}

/**
 * The party's sight range standing on `id`: the base, +1 for hills or
 * highland underfoot, plus named sources (Far Sight's sightRangeBonus).
 * Never Perception.
 */
export function sightRange(map, id, sightRangeBonus = 0) {
  const t = map.tiles[id];
  return BASE_SIGHT_RANGE + (RELIEF[t?.relief || 'flat']?.sightBonus || 0) + (sightRangeBonus || 0);
}

/**
 * Tiles visible from `from`: every tile of the same section within `range`
 * whose straight line back to the party crosses no blocking tile. A blocking
 * tile is itself visible and hides what is behind it; the party's own tile
 * never blocks. Across a passage the other section is not in line of sight,
 * except the passage's partner tile when the party stands on the passage.
 * Returned in the map's canonical tile order.
 */
export function visibleTiles(map, from, { range, ignores = [] }) {
  const a = parseTileId(from);
  const seen = new Set([from]);
  for (const id of Object.keys(map.tiles)) {
    const b = parseTileId(id);
    if (b.section !== a.section || id === from) continue;
    if (distance(a, b) > range) continue;
    const path = line(a, b);
    let clear = true;
    for (let i = 1; i < path.length - 1; i++) {
      if (blocksSight(map.tiles[tileId(a.section, path[i].q, path[i].r)], ignores)) { clear = false; break; }
    }
    if (clear) seen.add(id);
  }
  for (const n of mapNeighbors(map, from)) seen.add(n);   // a passage partner
  return Object.keys(map.tiles).filter(id => seen.has(id));
}

// ── Detection ────────────────────────────────────────────────────────────────

export const BANDS = ['nothing', 'sensed', 'identified'];

/** Deterministic, no dice (TERRAIN_TYPES): identified at or above the
 *  concealment, sensed within SENSED_MARGIN below it, otherwise nothing. */
export function detectionBand(perception, concealment) {
  if (perception >= concealment) return 'identified';
  if (perception >= concealment - SENSED_MARGIN) return 'sensed';
  return 'nothing';
}

/** The better of two bands. */
export function betterBand(a, b) {
  return BANDS.indexOf(a) >= BANDS.indexOf(b) ? a : b;
}

/** Detection band for an occupant where it stands (its own concealment plus
 *  the ground's, occupantConcealment). */
export function occupantBand(map, occ, perception) {
  return detectionBand(perception, occupantConcealment(map, occ));
}

/** "Roughly how many" for an identified roster (ENCOUNTERS). */
export function sizeWord(n) {
  if (n <= 1) return 'one';
  if (n <= 3) return 'a few';
  if (n <= 6) return 'several';
  return 'many';
}

/**
 * What the party knows about an occupant at a band (ENCOUNTERS, "What
 * Detection shows, revised"):
 *   nothing      null: the tile looks empty
 *   sensed       that something is there, and nothing else
 *   identified   the kind, roughly how many, the highest grade present, and
 *                the mark (marked / unmarked / corrupted), which the unmarked-
 *                kill choice needs before committing
 *   + exact      (Naturalist's exactRoster, or a scout) the exact roster and
 *                the composition's name
 * An event site shows what it is once identified; it is not hiding (0).
 */
export function occupantView(occ, band, { exact = false } = {}) {
  if (band === 'nothing') return null;
  if (band === 'sensed') return { id: occ.id, band };
  const v = { id: occ.id, band, kind: occ.kind };
  if (occ.kind === 'event') return { ...v, eventId: occ.eventId };
  const roster = occ.roster || [];
  v.size = sizeWord(roster.length);
  if (occ.kind === 'beast') {
    v.family = occ.family;
    v.mark = occ.mark;
    const top = roster.reduce((m, x) => Math.max(m, GRADES.indexOf(x.grade)), -1);
    v.topGrade = top >= 0 ? GRADES[top] : null;
  }
  if (exact) {
    v.exact = true;
    v.count = roster.length;
    v.roster = roster.map(x => ({ ...x }));
    if (occ.composition) v.composition = COMPOSITIONS[occ.composition]?.name || occ.composition;
  }
  return v;
}
