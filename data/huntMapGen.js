// data/huntMapGen.js
//
// Data the hunt-map generator (src/systems/HuntMapGen.js) reads that belongs
// to no single region: map sizes, the primary objectives, how occupants are
// built, how dense the map is. Region-specific data (palette, relief, native
// beasts, set pieces) lives on each zone in data/zones.js.
//
// Design: GRID_FUNDAMENTALS, HUNT_PLANS, ENCOUNTERS, EVENTS, PLAN_AFFIXES in
// the vault. Every number is a placeholder until chunk 13 (tuning).
// The reader of everything in this file is HuntMapGen.generateHuntMap unless a
// line says otherwise.

/**
 * Size tiers are a whole zone's tile budget (owner, 2026-09-16: 37 / 61 / 91).
 * Small and Medium fit one section. Large is one compact section or two as a
 * long zone joined by a passage (GRID_FUNDAMENTALS rule 4); `twoSectionChance`
 * is how often it is the long one.
 */
export const MAP_SIZES = {
  small:  { name: 'Small',  tiles: 37 },
  medium: { name: 'Medium', tiles: 61 },
  large:  { name: 'Large',  tiles: 91, twoSectionChance: 0.5 },
};

/**
 * The five launch objectives (HUNT_PLANS). This is the plan base-type
 * catalogue's generator half: a base type is objective + size, and `params`
 * says what that size asks for. `needs` are PLACEMENT_NEEDS keys
 * (data/planAffixes.js), the same vocabulary bonus objectives use, so one
 * generator handles both. Readers of `params` beyond placement: the completion
 * check (HuntObjectives.objectiveProgress).
 */
export const PRIMARY_OBJECTIVES = {
  scout:    { name: 'Scout',    doneWhen: 'Reveal every marked site.',
              needs: ['scout_sites'],
              params: { small: { sites: 2 }, medium: { sites: 3 }, large: { sites: 4 } } },
  apex:     { name: 'Apex',     doneWhen: "Kill the region's apex beast.",
              needs: ['apex_beast'],
              params: { small: {}, medium: {}, large: {} } },
  cull:     { name: 'Cull',     doneWhen: 'Kill N beasts of one native family.',
              needs: ['native_family'],
              params: { small: { count: 4 }, medium: { count: 6 }, large: { count: 8 } } },
  retrieve: { name: 'Retrieve', doneWhen: 'Take the item from its site and carry it to an exit.',
              needs: ['retrieve_site', 'exit'],
              params: { small: {}, medium: {}, large: {} } },
  commune:  { name: 'Commune',  doneWhen: "Reach and resolve the region's shrine.",
              needs: ['shrine'],
              params: { small: {}, medium: {}, large: {} } },
};

/**
 * Density (ENCOUNTERS, EVENTS): about one fight per 12-13 tiles (~3 / ~5 / ~7)
 * and one event site per 8 tiles. The region's and the plan's
 * encounterChancePercent scale the fight count; what the objectives require is
 * a floor the scaling never goes under.
 */
export const DENSITY = {
  tilesPerFight: 12.5,
  tilesPerEvent: 8,
  /** Tiles around the entry kept clear of hostile occupants, in steps. */
  entryClearance: 1,
};

/** In-game time units in one day + night: 12 advances today (HuntManager's
 *  DAY_NIGHT_ADVANCES x 2). Read for Swift Return's route check; the clock
 *  itself is HuntRules.clockAt (PHASE_UNITS is half of this). */
export const DAY_TIME_UNITS = 12;

/** Grades, weakest first (ENCOUNTERS, locked 2026-09-17). */
export const GRADES = ['yearling', 'grown', 'prime', 'great'];

/**
 * Base grade weights by region danger. Elder Grounds (gradeShiftPercent) moves
 * that share of the Yearling + Grown weight onto Prime and Great, 2 : 1.
 * Danger 1 is the only band the two starter zones use; the others are here so
 * a zone at any danger generates, and are tuning (chunk 13).
 */
export const GRADE_WEIGHTS_BY_DANGER = [
  { maxDanger: 2,  weights: { yearling: 40, grown: 45, prime: 13, great: 2 } },
  { maxDanger: 5,  weights: { yearling: 25, grown: 45, prime: 24, great: 6 } },
  { maxDanger: 7,  weights: { yearling: 15, grown: 40, prime: 33, great: 12 } },
  { maxDanger: 10, weights: { yearling: 8,  grown: 35, prime: 37, great: 20 } },
];

/**
 * Named compositions (ENCOUNTERS): an occupant is a roster of 1-8 members, each
 * with its own grade. `weight` is how often each is chosen for a filler pack;
 * Scourge only appears from `minDanger`. `concealment` is the occupant's own,
 * added to the ground's (ENCOUNTERS: "total = occupant + terrain"); `state` is
 * the pack's starting state, read by the world sim (HuntWorld.initWorld): Rooted stays put
 * (lairs, the apex, nesting mothers), Roaming wanders its section.
 */
export const COMPOSITIONS = {
  lone:      { name: 'Lone',                weight: 20, concealment: 40, state: 'roaming' },
  matriarch: { name: 'Matriarch and young', weight: 20, concealment: 20, state: 'rooted' },
  alpha:     { name: 'Alpha and pack',      weight: 15, concealment: 20, state: 'roaming' },
  pack:      { name: 'Pack',                weight: 45, concealment: 20, state: 'roaming' },
  scourge:   { name: 'Scourge',             weight: 5,  concealment: 10, state: 'roaming', minDanger: 6 },
};

/** Own concealment for occupants that are not ordinary packs (ENCOUNTERS). */
export const OCCUPANT_CONCEALMENT = {
  corrupted: 80,       // very high, but blight (20) hides nothing: 100, not above
  cultist: 30,         // a camp
  cultAmbusher: 90,    // intended to exceed a reachable Perception
  event: 0,            // event sites are not hiding
};

/**
 * Unmask's hidden band is never concealed past this (owner, chunk 8,
 * 2026-09-19). It is the best Perception the game can reach today (120: a
 * level-10 Ferrow Shepherd with five Perception picks and a T1 of Keen Eyes)
 * plus SENSED_MARGIN (15), the reach of the scout action. Without it 8 of 60
 * maps had no band any party could find. The harness fails if the Perception
 * ceiling moves away from it. Boons (chunk 10) may raise it.
 */
export const UNMASK_MAX_CONCEALMENT = 135;

/** Cultist band size, members (grade does not apply to cultists). */
export const CULTIST_BAND = { min: 2, max: 4 };

/** Share of beast occupants a region's prophet has marked, when it has one.
 *  A region with no house marks nothing. Primary-objective quarry is always
 *  marked where a house watches: the plan sends you for it. */
export const MARKED_SHARE = 0.5;

/** How many times the generator re-rolls a seed that fails validation before
 *  giving up. Each retry is its own deterministic sub-seed. */
export const MAX_ATTEMPTS = 40;

// ── What occupants bring to the world sim (chunk 7c) ────────────────────────
// Reader: src/systems/HuntWorld.js (the world tick and the encounter trigger).
// Placeholders the owner signed off 2026-09-19 (chunk 7 decisions 5, 7, 8);
// chunk 9 replaces OCCUPANT_INITIATIVE with the real enemy types' Initiative
// once a family maps to a combat type. Tuning is chunk 13.

/** An occupant's initiative is the average of its members' (decision 5), on the
 *  same CHA-based scale as the party's (the test party averages ~7). */
export const OCCUPANT_INITIATIVE = { yearling: 5, grown: 7, prime: 9, great: 11, cultist: 7 };

/** A searching pack's "perception", against a camp's concealment (decision 7). */
export const PACK_PERCEPTION = 40;

/** A pack's speed on the party's 0-100 rating scale (decision 8). A party whose
 *  Speed rating beats it shakes off a Hunting pack in half the time. */
export const PACK_SPEED = 30;
