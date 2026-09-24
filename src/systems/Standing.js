// src/systems/Standing.js
//
// Standing, save-wide (Exploration System v2, chunk 10a; design in the vault's
// STANDING, DEATH_AND_REVIVAL and WORLD_SIM notes, decisions in the
// IMPLEMENTATION_PLAN's "Chunk 10 — split and decisions"). Numbers live in
// data/standing.js.
//
// One plain record, kept on ProgressionManager.standing and saved with it.
// Every function here is pure over that record (plus what it is handed), so
// the harness drives the real rules with no game around them.
//
//   bond      house -> Bond standing: the player's account with each house.
//             Rises with favor, is SPENT on intercession (10c). Never resets.
//   legacy    house -> legacy: only grows, mostly when a season ends in that
//             house's name. Gives next season a devotion head start.
//   devotion  tribe -> house -> devotion THIS SEASON: the claiming table.
//             The player's tribe's row rises from the same favor as the Bond
//             but is never spent (decision 1), so paying for an intercession
//             never costs you your house. Rivals' rows tick daily.
//   holds     house -> the tribe holding it, or null. The house your tribe
//             holds is the house your lodge follows.
//   rivals    tribe -> { prefs, pace }: each rival's house order and courting
//             pace, rolled per season from the record's own seed.
//   season    { n, startDay }: the season number and the save-clock day it
//             began on (ProgressionManager.daysElapsed).
//   seasons   one result per ended season: winner, what you held, legacy.
//   repCarry  Hunt Points not yet turned into reputation.
//
// The claiming rule (STANDING, amended by the owner 2026-09-24, idea A):
//   - a house is claimable at CLAIM_THRESHOLD devotion; a held house can be
//     taken by leading its holder by TAKE_MARGIN;
//   - rivals claim automatically, the day they reach the threshold;
//   - the PLAYER only becomes eligible, and holds a house once they accept it
//     (acceptHouse, the lodge shrine in 10c). Accepting another house switches:
//     the old one is released for the rivals, its devotion kept;
//   - until you accept, a rival reaching the threshold first takes it
//     (dithering has a cost). Rivals never court a house anyone holds, so a
//     house you hold is yours for the season;
//   - rivals start after RIVAL_GRACE_DAYS of each season, and only once the
//     player has a tribe (a save still in the tutorial blocks nobody, because
//     nobody is ticking yet).
//
// A season ends SEASON_DAYS after it began. endSeason records the Hunt Point
// winner, pays legacy for the house your tribe held (more if it won), then
// newSeason clears devotion and holds, gives your tribe a head start from
// legacy, and rolls the rivals again. Resetting the tribes' Hunt Points is the
// caller's (GAME_WORLD.dayBreaks), since they live on ProgressionManager.

import { TRIBE_IDS } from './TribeRelations.js';
import { makeRng } from './seededRng.js';
import {
  HOUSES, HOUSE_MINORS, CLAIM_THRESHOLD, TAKE_MARGIN, RIVAL_GRACE_DAYS, RIVAL_PACE, RIVAL_HOLD_PACE,
  SEASON_DAYS, LEGACY_SEASON_GAIN, LEGACY_WIN_BONUS, LEGACY_HEAD_START, HEAD_START_CAP, HUNT_POINTS_PER_REP,
} from '../../data/standing.js';

export const STANDING_VERSION = 1;

const perHouse = (v = 0) => Object.fromEntries(HOUSES.map(h => [h, v]));

/** The major house a region's prophet belongs to (a minor counts as its major's). */
export function houseOf(prophet) {
  if (!prophet) return null;
  if (HOUSES.includes(prophet)) return prophet;
  return HOUSES.find(h => HOUSE_MINORS[h].includes(prophet)) || null;
}

/** A fresh record: season 1 beginning on `startDay` of the save clock. */
export function newStanding(seed, startDay = 0) {
  const st = {
    v: STANDING_VERSION,
    seed: seed >>> 0,
    bond: perHouse(),
    legacy: perHouse(),
    devotion: {},
    holds: perHouse(null),
    rivals: {},
    season: { n: 0, startDay },
    seasons: [],
    repCarry: 0,
  };
  newSeason(st, startDay, null);
  return st;
}

/**
 * Start the next season on `day`: clear the table, give `playerTribe` its
 * legacy head start, roll each tribe's house order and pace. The rolls come
 * from the record's seed and the season number alone, so they are the same on
 * every reload. A tribe chosen later still gets its head start (followedHouse
 * and devotion read legacy through devotionOf).
 */
export function newSeason(st, day, playerTribe) {
  st.season = { n: (st.season?.n || 0) + 1, startDay: day };
  st.holds = perHouse(null);
  st.devotion = Object.fromEntries(TRIBE_IDS.map(t => [t, perHouse()]));
  if (playerTribe) st.devotion[playerTribe] = headStart(st);
  const rng = makeRng((st.seed ^ Math.imul(st.season.n, 0x9E3779B1)) >>> 0);
  st.rivals = {};
  for (const t of TRIBE_IDS) {
    const prefs = [...HOUSES];
    for (let i = prefs.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [prefs[i], prefs[j]] = [prefs[j], prefs[i]]; }
    const pace = RIVAL_PACE.min + Math.floor(rng() * (RIVAL_PACE.max - RIVAL_PACE.min + 1));
    st.rivals[t] = { prefs, pace };
  }
  return st;
}

/** Next season's starting devotion for the player's tribe, from legacy. */
export function headStart(st) {
  return Object.fromEntries(HOUSES.map(h => [h, Math.min(HEAD_START_CAP, (st.legacy[h] || 0) * LEGACY_HEAD_START)]));
}

/**
 * The player's tribe was chosen after the season began (a new save pledges in
 * the tutorial). Its row starts from legacy, once. Safe to call on every load.
 */
export function joinSeason(st, playerTribe) {
  if (!playerTribe || st.joined === playerTribe) return;
  const row = st.devotion[playerTribe];
  const hs = headStart(st);
  for (const h of HOUSES) row[h] = Math.max(row[h] || 0, hs[h]);
  st.joined = playerTribe;
}

export function devotionOf(st, tribe, house) {
  return st.devotion?.[tribe]?.[house] || 0;
}

/** Which tribe holds `house` this season, or null. */
export function holderOf(st, house) {
  return st.holds?.[house] || null;
}

/** The house `tribe` holds (for the player: follows), or null. */
export function followedHouse(st, tribe) {
  if (!tribe) return null;
  return HOUSES.find(h => st.holds[h] === tribe) || null;
}

/**
 * Favor earned with a house (10b calls this from the hunt, through
 * GAME_WORLD): the Bond's standing and the player's tribe's devotion rise
 * together. A negative amount lowers both (chunk 11's events).
 */
export function earnFavor(st, playerTribe, house, amount) {
  if (!HOUSES.includes(house) || !Number.isFinite(amount) || amount === 0) return false;
  st.bond[house] = (st.bond[house] || 0) + amount;
  if (playerTribe) st.devotion[playerTribe][house] = Math.max(0, devotionOf(st, playerTribe, house) + amount);
  return true;
}

/** Spend Bond standing (intercession, 10c). Refused, and nothing spent, if the Bond cannot pay. */
export function spendBond(st, house, cost) {
  if (!HOUSES.includes(house) || !(cost >= 0)) return { ok: false, reason: 'bad spend' };
  if ((st.bond[house] || 0) < cost) return { ok: false, reason: 'not enough standing' };
  st.bond[house] -= cost;
  return { ok: true, left: st.bond[house] };
}

/** Whether the player's tribe may accept `house` now, and why not. */
export function canAccept(st, playerTribe, house) {
  if (!playerTribe) return { ok: false, reason: 'no tribe' };
  if (!HOUSES.includes(house)) return { ok: false, reason: 'not a house' };
  const holder = holderOf(st, house);
  if (holder === playerTribe) return { ok: false, reason: 'already followed' };
  const mine = devotionOf(st, playerTribe, house);
  if (mine < CLAIM_THRESHOLD) return { ok: false, reason: 'not enough devotion', need: CLAIM_THRESHOLD - mine };
  if (holder) {
    const theirs = devotionOf(st, holder, house);
    if (mine < theirs + TAKE_MARGIN) return { ok: false, reason: 'held', holder, need: theirs + TAKE_MARGIN - mine };
  }
  return { ok: true, holder };
}

/** Every house the player could accept right now. */
export function eligibleHouses(st, playerTribe) {
  return HOUSES.filter(h => canAccept(st, playerTribe, h).ok);
}

/**
 * Accept a house at the lodge shrine: your tribe holds it and your lodge
 * follows it. A house you held before is released (its devotion stays); a
 * rival holding this one loses it.
 */
export function acceptHouse(st, playerTribe, house) {
  const can = canAccept(st, playerTribe, house);
  if (!can.ok) return can;
  const released = followedHouse(st, playerTribe);
  if (released) st.holds[released] = null;
  st.holds[house] = playerTribe;
  return { ok: true, house, released, took: can.holder || null };
}

/**
 * One in-game day of the rivals (STANDING's daily tick). Returns what
 * happened: [{ kind: 'claim', tribe, house }].
 */
export function rivalDay(st, day, playerTribe) {
  const events = [];
  if (!playerTribe) return events;
  if (day - st.season.startDay < RIVAL_GRACE_DAYS) return events;
  for (const t of TRIBE_IDS) {
    if (t === playerTribe) continue;
    const r = st.rivals[t];
    const held = followedHouse(st, t);
    if (held) { st.devotion[t][held] += RIVAL_HOLD_PACE; continue; }
    const target = r.prefs.find(h => !st.holds[h]);
    if (!target) continue;
    st.devotion[t][target] += r.pace;
    if (st.devotion[t][target] >= CLAIM_THRESHOLD) {
      st.holds[target] = t;
      events.push({ kind: 'claim', tribe: t, house: target });
    }
  }
  return events;
}

/** True when the season that began on st.season.startDay is over on `day`. */
export function seasonOver(st, day) {
  return day - st.season.startDay >= SEASON_DAYS;
}

/**
 * End the season: record the Hunt Point winner (ties go to the earliest tribe
 * in TRIBE_IDS order, which is fixed), pay legacy for the house the player's
 * tribe held, then start the next season on `day`.
 */
export function endSeason(st, day, playerTribe, tribeHuntPoints = {}) {
  let winner = null, best = -1;
  for (const t of TRIBE_IDS) { const p = tribeHuntPoints[t] || 0; if (p > best) { best = p; winner = t; } }
  if (best <= 0) winner = null;
  const held = followedHouse(st, playerTribe);
  const won = !!playerTribe && winner === playerTribe;
  const legacyGain = held ? LEGACY_SEASON_GAIN + (won ? LEGACY_WIN_BONUS : 0) : 0;
  if (held) st.legacy[held] += legacyGain;
  const result = { season: st.season.n, endedDay: day, winner, points: { ...tribeHuntPoints }, held, won, legacyGain };
  st.seasons.push(result);
  newSeason(st, day, playerTribe);
  if (playerTribe) st.joined = playerTribe;
  return result;
}

/**
 * The day broke (GAME_WORLD.dayBreaks, after the save clock advanced to
 * `day`). A season that is over ends first; otherwise the rivals take their
 * day. Returns { events, season } where season is endSeason's result or null.
 */
export function dayBreak(st, day, playerTribe, tribeHuntPoints) {
  if (seasonOver(st, day)) return { events: [], season: endSeason(st, day, playerTribe, tribeHuntPoints) };
  return { events: rivalDay(st, day, playerTribe), season: null };
}

/**
 * Hunt Points earned -> whole points of own-tribe reputation (decision 10),
 * carrying the remainder so nothing is lost to rounding.
 */
export function repFromHuntPoints(st, huntPoints) {
  if (!(huntPoints > 0)) return 0;
  const total = (st.repCarry || 0) + huntPoints;
  const rep = Math.floor(total / HUNT_POINTS_PER_REP);
  st.repCarry = total - rep * HUNT_POINTS_PER_REP;
  return rep;
}

// ── Where a hunter fell (DEATH_AND_REVIVAL) ──────────────────────────────────

/**
 * The record a hunter carries onto the Slain roster: the region, its house,
 * its death rule, and the save-clock day. Read by routesBack (and 10c's lodge
 * shrine and the on-the-spot intercession).
 */
export function fellRecord({ zoneId = null, prophet = null, rule = 'watched', day = null } = {}) {
  return { zoneId, house: houseOf(prophet), rule, day };
}

/** An old save's Slain (before chunk 10): a Watched death, no house (owner, 2026-09-18). */
export const LEGACY_FELL = Object.freeze({ zoneId: null, house: null, rule: 'watched', day: null, legacy: true });

/**
 * Which ways back are open for a fallen hunter (DEATH_AND_REVIVAL, decisions
 * 11-13): the lesser rite for any Watched death; intercession only for a
 * Watched death in the lands of the house your tribe follows. A Forsaken
 * death is a False God's (chunk 11).
 */
export function routesBack(st, playerTribe, fell) {
  const f = fell || LEGACY_FELL;
  const followed = followedHouse(st, playerTribe);
  return {
    rite: f.rule === 'watched',
    intercession: f.rule === 'watched' && !!f.house && f.house === followed,
  };
}
