// data/standing.js
//
// The numbers behind Standing (Exploration System v2, chunk 10; design in the
// vault's STANDING, DEATH_AND_REVIVAL and WORLD_SIM notes). Logic lives in
// src/systems/Standing.js. Every number here is a placeholder until chunk 13.
//
// Readers:
//   HOUSES, HOUSE_MINORS     Standing.houseOf (a region's divineAlignment -> its
//                            major's house), every per-house table
//   CLAIM_THRESHOLD,         Standing.canAccept (the player) and
//   TAKE_MARGIN              Standing.rivalDay (rivals claim at the threshold)
//   RIVAL_GRACE_DAYS         Standing.rivalDay: rivals start after this many
//                            days of each season
//   RIVAL_PACE,              Standing.rivalDay: devotion a rival adds per day
//   RIVAL_HOLD_PACE          while courting a house / once it holds one
//   SEASON_DAYS              Standing.dayBreak: when a season ends
//   LEGACY_SEASON_GAIN,      Standing.endSeason: legacy for the house your
//   LEGACY_WIN_BONUS         tribe held at the end, more if your tribe won
//   LEGACY_HEAD_START,       Standing.endSeason / newSeason: next season's
//   HEAD_START_CAP           devotion head start from legacy
//   HUNT_POINTS_PER_REP      Standing.repFromHuntPoints <- GAME_WORLD.awardHuntPoints
//   INTERCESSION_COST_PER_LEVEL, RITE_DAYS_BASE, RITE_DAYS_PER_LEVEL,
//   RITE_TICKETS_PER_LEVEL   Revival.js: what each way back costs (10c)

/** The four major prophets' houses. Only these can be followed (STANDING). */
export const HOUSES = ['jeremiah', 'ezekiel', 'isaiah', 'daniel'];

/** Three minors each; a minor's region is its major's land (STANDING). */
export const HOUSE_MINORS = {
  jeremiah: ['habakkuk', 'nahum', 'zephaniah'],
  ezekiel:  ['joel', 'jonah', 'obadiah'],
  isaiah:   ['micah', 'hosea', 'amos'],
  daniel:   ['malachi', 'zechariah', 'haggai'],
};

/** Devotion a tribe needs with a house to hold it. */
export const CLAIM_THRESHOLD = 100;
/** How far the player must lead the holding tribe to take its house. */
export const TAKE_MARGIN = 25;

/** Days into each season before the rivals start courting (owner: ~14). */
export const RIVAL_GRACE_DAYS = 14;
/** A courting rival's devotion per day, rolled once per rival per season. */
export const RIVAL_PACE = { min: 4, max: 8 };
/** A rival that holds a house keeps building it, slowly. */
export const RIVAL_HOLD_PACE = 1;

/** A season, in in-game days (WORLD_SIM: 30 weeks). */
export const SEASON_DAYS = 210;

/** Legacy for the house your tribe holds when a season ends. */
export const LEGACY_SEASON_GAIN = 10;
/** Extra legacy when your tribe also won the season's Hunt Point race. */
export const LEGACY_WIN_BONUS = 10;
/** Next season's starting devotion per point of legacy, never past the cap. */
export const LEGACY_HEAD_START = 2;
export const HEAD_START_CAP = 75;

/** Your own tribe gains 1 reputation per this many Hunt Points you earn. */
export const HUNT_POINTS_PER_REP = 5;

// ── The ways back (DEATH_AND_REVIVAL; chunk 10c). Readers: Revival.js ────────
/** Intercession costs this much Bond standing per level of the fallen hunter. */
export const INTERCESSION_COST_PER_LEVEL = 10;
/** The lesser rite takes RITE_DAYS_BASE + RITE_DAYS_PER_LEVEL x level days. */
export const RITE_DAYS_BASE = 2;
export const RITE_DAYS_PER_LEVEL = 1;
/** ...and an offering of this many Hunt Tickets per level. */
export const RITE_TICKETS_PER_LEVEL = 5;

// ── A False God's price (DEATH_AND_REVIVAL; chunk 11c-2). Readers: Revival.js ─
/** Hidden standing with the god who takes the hunter back, per level. */
// The prophet's vigil (chunk 11d; owner, 10b): while a hunt's vigil is set,
// each unmarked kill off blight costs this much Bond standing AND devotion with
// the vigil's house (blight-mercy waives it). Placeholder until chunk 13.
// Reader: HuntEngine._unmarkedKill.
export const VIGIL_KILL_COST = 3;
// Every unmarked kill (blight too) draws the region's false god's attention:
// hidden standing + this much. Reader: HuntEngine._unmarkedKill.
export const UNMARKED_KILL_FALSE_GOD = 1;

export const FALSE_GOD_HIDDEN_PER_LEVEL = 10;
/** Bond standing lost with the house your tribe follows, per level. */
export const FALSE_GOD_BOND_PER_LEVEL = 5;
