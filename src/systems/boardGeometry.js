// src/systems/boardGeometry.js
//
// Where the eight slots are, in terms the rules can reason about.
//
// This lived inside CombatScene.js as a module-local const, which was fine
// until something OTHER than the scene needed it. AIProfiles.js needs to know
// which rank a target is standing in, and it cannot import CombatScene —
// CombatScene already imports AIProfiles, so that is a cycle. Rather than keep
// a second copy of the grid in the AI (the mistake this project keeps making
// with shared constants), the grid moved here and both import it.
//
// Deliberately dependency-free and Phaser-free, so the headless harness and the
// co-op server load it without a stub.

/**
 * Column and row for each slot id, per side.
 *
 * Column 2 is the FRONT rank for BOTH sides. Allies face right from x=560 and
 * enemies face left from x=720, so the higher column is always the one nearer
 * the middle of the board. That symmetry is why positional logic needs no
 * side-specific branch anywhere.
 *
 * The rows are a brick-offset grid: the middle column holds two slots where the
 * outer columns hold three.
 */
export const SLOT_COORDS = {
  8: { col: 0, row: 0 },
  7: { col: 0, row: 1 },
  6: { col: 0, row: 2 },
  4: { col: 1, row: 0 },
  5: { col: 1, row: 1 },
  3: { col: 2, row: 0 },
  2: { col: 2, row: 1 },
  1: { col: 2, row: 2 }
};

/** The frontmost column index. Front is high, back is low. */
export const FRONT_COL = 2;

/** Every slot id, ascending. The board's own list, so nothing restates 1..8. */
export const ALL_SLOT_IDS = Object.keys(SLOT_COORDS).map(Number);

/** Which column a slot sits in, or null if the id is not on the board. */
export function columnOf(slotId) {
  return SLOT_COORDS[slotId]?.col ?? null;
}

/**
 * How far FORWARD a unit stands: 0 at the back rank, 1 at the front.
 *
 * A unit with no slot — in the KO area, or mid-summon — reads as mid-rank
 * rather than as either extreme, so it is never singled out or spared by an
 * accident of geometry.
 */
export function frontness(unit) {
  const col = columnOf(unit?._slot?.slotId);
  return col == null ? 0.5 : col / FRONT_COL;
}
