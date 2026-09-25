// data/grounds.js
//
// Tile terrain for the hunt map (Exploration System v2, TERRAIN_TYPES).
//
// A GROUND is what a tile is made of: what it costs to cross, whether you can
// see past it, how well things hide on it. It is not a BIOME: biomes are
// places (data/mapRegions.js, BIOME_TINT) and a region's palette says which
// grounds it is made of (data/zones.js). RELIEF (flat / hills / highland) is a
// second, separate axis, so "desert hills" is dunes + hills, not a 16th ground.
//
// One tile = one ground + one relief + at most one placed thing.
//
// All numbers are the first pass from TERRAIN_TYPES (owner, 2026-09-17):
// the ratios and the 1-4 cost spread are accepted, the values are tuning for
// chunk 13. Named bands are turned into numbers here, once, so nothing reads a
// word that could drift from the number the engine uses:
//   concealment    very low 10, low 20, normal 40, high 60, very high 80
//   encounterBias  low 0.5, normal 1, high 1.5, very high 2
//
// ── Readers ─────────────────────────────────────────────────────────────────
//   cost, supplyCost, timeCost  move resolution (chunk 7); the generator's
//                               route-time check for Swift Return (chunk 5)
//   passable                    the generator's reachability check; pathing
//   blocksSight                 Sight (chunk 7)
//   concealment                 occupantConcealment (HuntMapGen.js) -> Detection
//   encounterBias               the generator's occupant placement weights
//   families                    the generator: which native family goes where
//   corrupts                    the generator: a beast placed here is corrupted
//   forage                      the generator's forage spots; forage yield (chunk 7)
//   tint                        the hunt scene (chunk 8), until tile art exists

export const GROUNDS = {
  grass:      { name: 'Grass',      cost: 1, passable: true,  blocksSight: false, concealment: 20, encounterBias: 0.5, forage: 'modest', families: ['nutria', 'scarlet_ibis'],                               tint: 0x8fb45a },
  heath:      { name: 'Heath',      cost: 1, passable: true,  blocksSight: false, concealment: 40, encounterBias: 1.0, forage: 'modest', families: ['shore_gull'],                   tint: 0x9a8a5e },
  shingle:    { name: 'Shingle',    cost: 1, passable: true,  blocksSight: false, concealment: 20, encounterBias: 0.5, forage: 'modest', families: ['tide_crab', 'shore_gull'],      tint: 0xb9b1a0 },
  hardpan:    { name: 'Hardpan',    cost: 1, supplyCost: 2, passable: true, blocksSight: false, concealment: 10, encounterBias: 0.5, forage: 'little', families: [],            tint: 0xc9a66b },
  dunes:      { name: 'Dunes',      cost: 3, supplyCost: 4, passable: true, blocksSight: false, concealment: 20, encounterBias: 0.5, forage: 'little', families: ['tide_crab'], tint: 0xe2cf8f },
  snowfield:  { name: 'Snowfield',  cost: 2, supplyCost: 3, passable: true, blocksSight: false, concealment: 10, encounterBias: 0.5, forage: 'little', families: [],            tint: 0xe8eef2 },
  woodland:   { name: 'Woodland',   cost: 2, timeCost: 3,   passable: true, blocksSight: true,  concealment: 60, encounterBias: 1.0, forage: 'good',   families: ['marsh_bat', 'marsh_viper'], tint: 0x4f7a3a },
  rainforest: { name: 'Rainforest', cost: 3, timeCost: 4,   passable: true, blocksSight: true,  concealment: 80, encounterBias: 1.5, forage: 'good',   families: [],            tint: 0x2f6b3a },
  thicket:    { name: 'Thicket',    cost: 2, passable: true,  blocksSight: true,  concealment: 80, encounterBias: 2.0, forage: 'good',   families: ['marsh_viper', 'nutria'],                tint: 0x6b8f3e },
  marsh:      { name: 'Marsh',      cost: 3, passable: true,  blocksSight: false, concealment: 40, encounterBias: 1.5, forage: 'good',   families: ['crocodile', 'snapping_turtle', 'bog_frog', 'swamp_crab', 'scarlet_ibis'], tint: 0x5f7f64 },
  bog:        { name: 'Bog',        cost: 4, passable: true,  blocksSight: false, concealment: 60, encounterBias: 1.5, forage: 'modest', families: ['bog_frog', 'snapping_turtle'],                 tint: 0x4b5a43 },
  scree:      { name: 'Scree',      cost: 3, timeCost: 2,   passable: true, blocksSight: false, concealment: 20, encounterBias: 0.5, forage: 'little', families: [],            tint: 0x8c8479 },
  // Blight is placed, not rolled: the generator paints it around a source
  // (TERRAIN_TYPES). It reads backwards on purpose: the worst ground to cross,
  // and it hides nothing. Beasts standing on it are corrupted.
  blight:     { name: 'Blight',     cost: 2, supplyCost: 3, passable: true, blocksSight: false, concealment: 20, encounterBias: 1.5, forage: 'none', families: [], corrupts: true, tint: 0x5b3f5e },
  cliff:      { name: 'Cliff',      cost: null, passable: false, blocksSight: true,  concealment: 0, encounterBias: 0, forage: 'none',    families: [],                               tint: 0x5a534c },
  // Rivers and lakes are tiles, not hex edges; a crossing is a FORD (below).
  // Water is fished from a tile beside it, never stood on without a ford.
  water:      { name: 'Water',      cost: null, passable: false, blocksSight: false, concealment: 0, encounterBias: 0, forage: 'fishing', families: ['crocodile'],             tint: 0x3f6f95 },
};

/** Relief overlays the ground. Hills and highland block sight past them and
 *  add +1 sight range to a party standing on them (Sight, chunk 7). */
export const RELIEF = {
  flat:     { name: 'Flat',     costAdd: 0, blocksSight: false, sightBonus: 0 },
  hills:    { name: 'Hills',    costAdd: 1, blocksSight: true,  sightBonus: 1 },
  highland: { name: 'Highland', costAdd: 2, blocksSight: true,  sightBonus: 1 },
};

/**
 * A ford makes one water tile crossable (TERRAIN_TYPES: "river is impassable
 * with ford features placed where crossing is allowed"). The generator lays
 * fords where a single water tile separates land from land. First-pass cost.
 */
export const FORD = { cost: 3 };

/** Forage yields that count as a real food source (Provisioner's floor). */
export const FORAGE_YIELDING = ['good', 'modest'];

/** Supply and time cost of entering a tile; null if it cannot be entered. */
export function tileCosts(tile) {
  const g = GROUNDS[tile.ground];
  if (!g) throw new Error(`unknown ground '${tile.ground}'`);
  const add = RELIEF[tile.relief || 'flat'].costAdd;
  if (tile.ford) return { supply: FORD.cost + add, time: FORD.cost + add };
  if (!g.passable) return null;
  return { supply: (g.supplyCost ?? g.cost) + add, time: (g.timeCost ?? g.cost) + add };
}

/** True if a tile can be entered (passable ground, or a ford). */
export function isPassable(tile) {
  return !!tile && (!!tile.ford || !!GROUNDS[tile.ground]?.passable);
}
