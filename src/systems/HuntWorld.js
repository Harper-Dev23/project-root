// src/systems/HuntWorld.js
//
// The world simulation of a map hunt (Exploration System v2, chunk 7c).
// Design: the vault's WORLD_SIM (one world tick, pack states, trails, blight,
// corruption), ENCOUNTERS (the encounter trigger, ambush, party initiative,
// flee), PARTY_STATS Part B (the found-in-camp check).
//
// ── One world tick, driven by in-game time ──────────────────────────────────
// Whenever the hunt's clock advances, the world catches up (worldTick). It has
// its own clock, s.world.time, which only ever moves forward. Events happen at
// exact times, in a fixed order, so the result is the same for the same inputs:
//   1. packs step (Roaming every ROAM_STEP, Hunting every HUNT_STEP), in
//      occupant-id order
//   2. at each day boundary, blight spreads one ring from every living source
//   3. corruption resolves: an unmarked beast that has stood in blight for
//      CORRUPT_TIME turns
// Rivals advance once a day through the injected world's dayBreaks, which the
// hunt's clock already calls (HuntEngine._advanceTime).
//
// It draws from its OWN seeded stream (the hunt's world stream), never
// Math.random and never the hunt's action stream, so a pack's wandering never
// shifts what a forage finds.
//
// When an encounter starts, the world freezes (the hunt is frozen during a
// fight, AUTHORITY_MODEL). The world clock stays at the moment it started;
// the next tick after the fight catches up from there.
//
// No mid-hunt spawns (WORLD_SIM): packs move and change, they never appear.
// A corrupted beast is the same occupant with a new mark.
//
// All numbers are placeholders the owner signed off 2026-09-19 (chunk 7
// decisions 5, 7, 8, 9); tuning is chunk 13.

import { parseTileId, distance } from './HexGrid.js';
import { GROUNDS, isPassable } from '../../data/grounds.js';
import {
  DAY_TIME_UNITS, PACK_PERCEPTION, PACK_SPEED, OCCUPANT_CONCEALMENT,
} from '../../data/huntMapGen.js';
import { mapNeighbors } from './HuntMapGen.js';
import { detectionBand } from './HuntRules.js';
import { occupantInitiative } from './HuntBeasts.js';

/** A Roaming pack steps every ROAM_STEP units; a Hunting one every HUNT_STEP. */
export const ROAM_STEP = 4;
export const HUNT_STEP = 2;
/** A Hunting pack that has not got closer for this long loses the trail:
 *  a day, or half a day if the party's Speed rating beats PACK_SPEED. */
export const TRAIL_LOST_TIME = 12;
export const TRAIL_LOST_TIME_FAST = 6;
/** Trails fade after a day. */
export const TRAIL_TIME = 12;
/** A trail hides like an occupant would: the ground's concealment plus this.
 *  Read through the Detection bands (WORLD_SIM, "Tracking"). */
export const TRAIL_CONCEALMENT = 20;
/** "High Perception" reads a trail's age: this far above its concealment. */
export const TRAIL_AGE_MARGIN = 20;
/** Blight around a source starts at ring 1 (the generator's patch) and grows
 *  one ring each in-game day while the source lives. */
export const BLIGHT_START_RADIUS = 1;
/** An unmarked beast in blight this long turns corrupted. */
export const CORRUPT_TIME = 12;
/** The cleanse action (decision 9). */
export const CLEANSE_TIME = 2;

const EPS = 1e-9;
const occNum = (o) => Number(String(o.id).replace(/\D/g, '')) || 0;

// ── Initiative (ENCOUNTERS) ──────────────────────────────────────────────────
// An occupant's own initiative comes from its real enemy types and loadout
// (HuntBeasts.occupantInitiative, chunk 9a), which replaced chunk 7's
// placeholder table by grade.

/**
 * Which block acts first. Ambush is decisive: the enemy goes first whatever
 * the numbers. Otherwise the higher party initiative wins, ties to the party.
 */
export function whoActsFirst({ ambush, partyInitiative, enemyInitiative }) {
  if (ambush) return 'enemy';
  return partyInitiative >= enemyInitiative ? 'party' : 'enemy';
}

/** How long a Hunting pack keeps a trail it is not closing on. */
export function trailLostTime(partySpeed) {
  return partySpeed > PACK_SPEED ? TRAIL_LOST_TIME_FAST : TRAIL_LOST_TIME;
}

/** Whether a searching pack finds a camp: Detection, reversed. */
export function packFindsCamp(campConcealment) {
  return detectionBand(PACK_PERCEPTION, campConcealment) === 'identified';
}

/** What a party reads of a trail on a visible tile (WORLD_SIM, "Tracking"). */
export function trailView(trail, ground, perception, now) {
  const conc = (GROUNDS[ground]?.concealment || 0) + TRAIL_CONCEALMENT;
  const band = detectionBand(perception, conc);
  if (band === 'nothing') return null;
  if (band === 'sensed') return { band };
  const v = { band, family: trail.family, toward: trail.to };
  if (perception >= conc + TRAIL_AGE_MARGIN) v.age = now - trail.at;
  return v;
}

// ── Setting the world up ─────────────────────────────────────────────────────

const moves = (occ) => occ.kind === 'beast';

/**
 * At departure: every beast remembers the state it rests in (`home`), Restless
 * turns that share of Rooted packs Roaming (never the plan's quarry, which the
 * generator placed Rooted on purpose), and Roaming packs get their first step.
 */
export function initWorld(map, { restlessPercent = 0, rng }) {
  const pct = Math.max(0, Math.min(100, Number(restlessPercent) || 0));
  for (const occ of [...map.occupants].sort((a, b) => occNum(a) - occNum(b))) {
    if (!moves(occ)) continue;
    if (pct > 0 && occ.state === 'rooted' && !occ.quarry && rng() < pct / 100) {
      occ.state = 'roaming';
      occ.restless = true;
    }
    occ.home = occ.state;
    occ.nextStepAt = occ.state === 'roaming' ? ROAM_STEP : null;
    occ.blightSince = null;
  }
  return { time: 0, day: 0 };
}

/** A pack you fled from, or woke: it hunts the party, starting after `from`. */
export function alert(occ, from) {
  occ.state = 'hunting';
  occ.closest = Infinity;
  occ.closerAt = from;
  occ.nextStepAt = from + HUNT_STEP;
  occ.alerted = true;
}

export function loseTrail(occ, now) {
  occ.state = occ.home === 'rooted' ? 'rooted' : 'roaming';
  delete occ.closest;
  delete occ.closerAt;
  occ.nextStepAt = occ.state === 'roaming' ? now + ROAM_STEP : null;
}

function occupantAt(s, id, except) {
  return s.map.occupants.find(o => o.tile === id && o !== except) || null;
}

/**
 * Shortest route for a Hunting pack toward the party: passable tiles, through
 * passages, never through another occupant. Returns the next tile and the
 * distance, or null if the party cannot be reached.
 */
function stepToward(s, occ) {
  const goal = s.pos;
  const dist = new Map([[goal, 0]]);
  const queue = [goal];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    for (const n of mapNeighbors(s.map, id)) {
      if (dist.has(n)) continue;
      if (n !== occ.tile && (!isPassable(s.map.tiles[n]) || occupantAt(s, n, occ))) continue;
      dist.set(n, dist.get(id) + 1);
      if (n !== occ.tile) queue.push(n);
    }
  }
  if (!dist.has(occ.tile)) return null;
  const opts = mapNeighbors(s.map, occ.tile).filter(n => dist.has(n) && dist.get(n) === dist.get(occ.tile) - 1).sort();
  return opts.length ? { next: opts[0], dist: dist.get(occ.tile) } : null;
}

// ── The tick ─────────────────────────────────────────────────────────────────

/**
 * Run the world forward to `to`. `ctx`:
 *   rng        the hunt's world stream
 *   stats()    the party's stats now (Speed for pursuit, party initiative)
 *   campFrom   when set, the party is camping from this time on: a pack
 *              stepping onto it must find the camp first (Detection reversed)
 *   campConcealment   the camp tile's concealment + Low Profile
 *   bandOf(occ) what the party had detected of this occupant where it stands
 *   onEvent()  after each event time, so Detection keeps up with moving packs
 * Returns { stoppedAt, encounter }: an encounter freezes the world at once.
 */
export function worldTick(s, to, ctx) {
  const w = s.world;
  for (let guard = 0; guard < 100000; guard++) {
    if (s.encounter) break;
    const beasts = s.map.occupants.filter(moves).sort((a, b) => occNum(a) - occNum(b));
    const dayAt = (w.day + 1) * DAY_TIME_UNITS;
    let next = dayAt;
    for (const o of beasts) {
      if (o.nextStepAt != null) next = Math.min(next, o.nextStepAt);
      if (o.blightSince != null) next = Math.min(next, o.blightSince + CORRUPT_TIME);
    }
    if (next > to + EPS) break;
    w.time = Math.max(w.time, next);
    const now = w.time;
    for (const o of beasts) {
      if (o.nextStepAt != null && o.nextStepAt <= now + EPS && s.map.occupants.includes(o)) {
        stepPack(s, o, now, ctx);
        if (s.encounter) { ctx.onEvent?.(); return { stoppedAt: now, encounter: s.encounter }; }
      }
    }
    if (dayAt <= now + EPS) {
      w.day += 1;
      spreadBlight(s);
    }
    resolveCorruption(s, now);
    ctx.onEvent?.();
  }
  if (!s.encounter) w.time = Math.max(w.time, to);
  fadeTrails(s);
  return { stoppedAt: s.encounter ? w.time : to, encounter: s.encounter };
}

function leaveTrail(s, occ, from, to, now) {
  s.trails[from] = { occ: occ.id, family: occ.family || occ.kind, to, at: now };
}

function fadeTrails(s) {
  for (const [id, t] of Object.entries(s.trails)) if (s.world.time - t.at > TRAIL_TIME + EPS) delete s.trails[id];
}

function stepPack(s, occ, now, ctx) {
  const from = occ.tile;
  if (occ.state === 'roaming') {
    occ.nextStepAt = now + ROAM_STEP;
    // Roaming packs keep to their section and are indifferent to the party:
    // they never walk into it (only Hunting packs come for you).
    const sec = parseTileId(from).section;
    const opts = mapNeighbors(s.map, from)
      .filter(n => parseTileId(n).section === sec && isPassable(s.map.tiles[n]) && n !== s.pos && !occupantAt(s, n, occ))
      .sort();
    if (!opts.length) return;
    const to = opts[Math.floor(ctx.rng() * opts.length)];
    leaveTrail(s, occ, from, to, now);
    occ.tile = to;
    return;
  }
  if (occ.state !== 'hunting') { occ.nextStepAt = null; return; }
  occ.nextStepAt = now + HUNT_STEP;
  const route = stepToward(s, occ);
  if (route && route.dist < occ.closest) { occ.closest = route.dist; occ.closerAt = now; }
  if (now - occ.closerAt >= trailLostTime(ctx.stats().speed) - EPS) { loseTrail(occ, now); return; }
  if (!route) return;
  if (route.next === s.pos) {
    const camping = ctx.campFrom != null && now >= ctx.campFrom - EPS;
    // A camp is found only if the pack can see through its concealment; if it
    // can't, the pack does not come in (and is not getting any closer).
    if (camping && !packFindsCamp(ctx.campConcealment)) return;
    const knew = ctx.bandOf(occ);
    // Its loadout sets its initiative, so it is rolled before the encounter.
    ctx.ensureLoadout?.(occ);
    leaveTrail(s, occ, from, s.pos, now);
    occ.tile = s.pos;
    s.encounter = makeEncounter(occ, {
      cause: camping ? 'camp' : 'pack',
      knew,
      // A camp that is found is an ambush (a sleeping camp); on the move, only
      // a pack the party had not detected is.
      ambush: camping || knew === 'nothing',
      partyInitiative: ctx.stats().partyInitiative,
      at: now,
      tile: s.pos,
    });
    return;
  }
  leaveTrail(s, occ, from, route.next, now);
  occ.tile = route.next;
}

/** The record an encounter leaves on the hunt until it is won or fled. */
export function makeEncounter(occ, { cause, knew, ambush, partyInitiative, at, tile }) {
  const enemyInitiative = occupantInitiative(occ);
  return {
    occId: occ.id, kind: occ.kind, tile, cause, knew, ambush,
    partyInitiative, enemyInitiative,
    first: whoActsFirst({ ambush, partyInitiative, enemyInitiative }),
    at,
  };
}

/**
 * Blight grows from every living source: every passable land tile of the
 * source's section within BLIGHT_START_RADIUS + days becomes blight. Cleansed
 * tiles inside that reach go back, which is what makes cleansing against a
 * living source a losing game (WORLD_SIM).
 */
export function spreadBlight(s) {
  const radius = BLIGHT_START_RADIUS + s.world.day;
  for (const f of s.map.features) {
    if (f.kind !== 'blight_source' || f.destroyed) continue;
    const src = parseTileId(f.tile);
    for (const [id, t] of Object.entries(s.map.tiles)) {
      const p = parseTileId(id);
      if (p.section !== src.section || distance(p, src) > radius) continue;
      if (t.ford || !GROUNDS[t.ground]?.passable || t.ground === 'blight') continue;
      t.blightedFrom = t.ground;
      t.ground = 'blight';
    }
  }
}

function resolveCorruption(s, now) {
  for (const occ of s.map.occupants) {
    if (!moves(occ)) continue;
    const onBlight = s.map.tiles[occ.tile]?.ground === 'blight';
    if (occ.mark !== 'unmarked' || !onBlight) { occ.blightSince = null; continue; }
    if (occ.blightSince == null) { occ.blightSince = now; continue; }
    if (now - occ.blightSince >= CORRUPT_TIME - EPS) {
      occ.mark = 'corrupted';
      occ.concealment = OCCUPANT_CONCEALMENT.corrupted;
      occ.corruptedAt = now;
      occ.blightSince = null;
    }
  }
}
