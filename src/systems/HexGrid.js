// src/systems/HexGrid.js
//
// Hex coordinates for the hunt map (Exploration System v2, GRID_FUNDAMENTALS).
//
// Pointy-top hexes, stored as AXIAL (q, r); the third cube coordinate is
// s = -q - r and is derived, never stored. Distance, neighbours, lines and
// rings are exact in cube coordinates, with no diagonal special cases.
//
// A zone is one or more SECTIONS. A section always fits one screen: at the
// fixed 64 px hex that is at most 13 columns x 11 rows (owner, 2026-09-16).
// Those bounds are in ODD-R OFFSET coordinates (odd rows shoved right), which
// is the brick offset the combat board already uses. Axial coordinates are
// local to their section, and a tile's id is "section:q,r", e.g. "1:3,-1".
//
// Pure functions, no Phaser, no state: the generator, movement, sight, the
// save and the co-op wire all read the same ids.

export const SECTION_COLS = 13;
export const SECTION_ROWS = 11;

/** The six axial directions, clockwise from east. */
export const DIRECTIONS = Object.freeze([
  [1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1],
]);

/** "section:q,r" */
export function tileId(section, q, r) {
  return `${section}:${q},${r}`;
}

/** "section:q,r" -> { section, q, r }. Throws on anything else. */
export function parseTileId(id) {
  const m = /^(\d+):(-?\d+),(-?\d+)$/.exec(String(id));
  if (!m) throw new Error(`bad tile id '${id}'`);
  return { section: Number(m[1]), q: Number(m[2]), r: Number(m[3]) };
}

/** Axial -> odd-r offset (column, row) inside a section's 13 x 11 box. */
export function toOffset(q, r) {
  return { col: q + (r - (r & 1)) / 2, row: r };
}

/** Odd-r offset -> axial. */
export function fromOffset(col, row) {
  return { q: col - (row - (row & 1)) / 2, r: row };
}

/** True if the axial position lies inside one section's 13 x 11 box. */
export function inSectionBounds(q, r) {
  const { col, row } = toOffset(q, r);
  return col >= 0 && col < SECTION_COLS && row >= 0 && row < SECTION_ROWS;
}

/** The six axial neighbours, unbounded. */
export function neighbors(q, r) {
  return DIRECTIONS.map(([dq, dr]) => ({ q: q + dq, r: r + dr }));
}

/** Hex distance in steps. */
export function distance(a, b) {
  const dq = a.q - b.q, dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

/** Every position within `radius` steps of `center`, center included. */
export function range(center, radius) {
  const out = [];
  for (let dq = -radius; dq <= radius; dq++) {
    for (let dr = Math.max(-radius, -dq - radius); dr <= Math.min(radius, -dq + radius); dr++) {
      out.push({ q: center.q + dq, r: center.r + dr });
    }
  }
  return out;
}

/** The positions exactly `radius` steps from `center`. */
export function ring(center, radius) {
  if (radius === 0) return [{ q: center.q, r: center.r }];
  const out = [];
  let q = center.q + DIRECTIONS[4][0] * radius;
  let r = center.r + DIRECTIONS[4][1] * radius;
  for (let side = 0; side < 6; side++) {
    for (let step = 0; step < radius; step++) {
      out.push({ q, r });
      q += DIRECTIONS[side][0];
      r += DIRECTIONS[side][1];
    }
  }
  return out;
}

function cubeRound(fq, fr) {
  const fs = -fq - fr;
  let q = Math.round(fq), r = Math.round(fr), s = Math.round(fs);
  const dq = Math.abs(q - fq), dr = Math.abs(r - fr), ds = Math.abs(s - fs);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return { q, r };
}

/**
 * The hexes a straight line from a to b passes through, both ends included:
 * distance + 1 of them, each a neighbour of the last. Read by Sight (chunk 7),
 * which walks it to find blocking terrain. The tiny nudge keeps a line that
 * runs exactly along a hex edge from flip-flopping between its two sides.
 */
export function line(a, b) {
  const n = distance(a, b);
  if (n === 0) return [{ q: a.q, r: a.r }];
  const out = [];
  const aq = a.q + 1e-6, ar = a.r + 1e-6, bq = b.q + 1e-6, br = b.r + 1e-6;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push(cubeRound(aq + (bq - aq) * t, ar + (br - ar) * t));
  }
  return out;
}
