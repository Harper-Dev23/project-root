// src/systems/HuntMapGen.js
//
// The hunt-map generator (Exploration System v2, chunk 5). Design: the vault's
// GRID_FUNDAMENTALS (layout, sections, validation), TERRAIN_TYPES (grounds,
// relief, palettes, blight, fords), ENCOUNTERS (occupants, rosters, grades,
// concealment, density), HUNT_PLANS and PLAN_AFFIXES (what objectives require),
// EVENTS (event-site density).
//
//   region + plan (objective, size, bonus objectives, modifiers) + seed  ->  map
//
// It runs in the order GRID_FUNDAMENTALS sets:
//   1. layout      section count and shapes, exactly the size tier's tiles
//   2. terrain     grounds from the region palette, relief as a second axis
//   3. insertions  entry, passages, blight, fords; then what the objectives
//                  need (PLACEMENT_NEEDS), then density, then event sites and
//                  forage spots
//   5. validation  every placed thing reachable from the entry, every objective
//                  completable. A seed that fails is re-rolled as a derived
//                  sub-seed, so the result is still a pure function of the seed.
// (Step 4, authored set pieces, is the shrine a Commune plan places; the other
// set pieces wait for the events chunk.)
//
// Pure: no Phaser, no GameState, no Math.random. The same inputs give the same
// map on every machine, which is what lets co-op send a seed instead of a map.
// Nothing in the game calls it yet: the hunt runs on the map from chunk 7/8.
// The map is plain JSON; tile ids are "section:q,r" (HexGrid.js).

import { neighbors, distance, tileId, parseTileId, fromOffset, inSectionBounds,
         SECTION_COLS, SECTION_ROWS } from './HexGrid.js';
import { GROUNDS, RELIEF, FORAGE_YIELDING, tileCosts, isPassable } from '../../data/grounds.js';
import { MAP_SIZES, PRIMARY_OBJECTIVES, DENSITY, DAY_TIME_UNITS, GRADES, GRADE_WEIGHTS_BY_DANGER,
         COMPOSITIONS, OCCUPANT_CONCEALMENT, CULTIST_BAND, MARKED_SHARE, MAX_ATTEMPTS } from '../../data/huntMapGen.js';
import { PLACEMENT_NEEDS, BONUS_OBJECTIVES } from '../../data/planAffixes.js';
import { getZone } from '../../data/zones.js';
import { makeRng } from './seededRng.js';

/** Shape version of a generated map. Bump when the output shape changes. */
export const HUNT_MAP_VERSION = 1;

const EVENT_CATEGORIES = ['environmental', 'microZone', 'flexible'];
const GRADE_RANK = Object.fromEntries(GRADES.map((g, i) => [g, i]));

// ── small helpers ────────────────────────────────────────────────────────────

function pickWeighted(rng, entries) {
  let total = 0;
  for (const [, w] of entries) total += Math.max(0, w);
  if (total <= 0) return null;
  let x = rng() * total;
  for (const [k, w] of entries) {
    if (w <= 0) continue;
    x -= w;
    if (x < 0) return k;
  }
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i][1] > 0) return entries[i][0];
  return null;
}

const randInt = (rng, min, max) => min + Math.floor(rng() * (max - min + 1));
const posKey = (q, r) => `${q},${r}`;

/** The stream for re-roll `attempt` of a seed in a zone. The zone id is mixed
 *  in so one seed does not draw the same layout in every region. */
function attemptSeed(seed, attempt, zoneId) {
  let h = 0x811C9DC5;                                   // FNV-1a over the zone id
  for (let i = 0; i < zoneId.length; i++) h = Math.imul(h ^ zoneId.charCodeAt(i), 0x01000193);
  return (seed ^ h ^ Math.imul(attempt, 0x9E3779B1)) >>> 0;
}

/** Canonical tile order: section, then row, then column. */
function compareIds(a, b) {
  const A = parseTileId(a), B = parseTileId(b);
  return A.section - B.section || A.r - B.r || A.q - B.q;
}

// ── map queries (exported: movement, the harness and chunk 7 read them) ─────

// Adjacency depends only on which tiles exist and on the passages, both fixed
// once the layout is done, so it is built once per map and reused. Rebuilt if
// the tiles object is replaced or a passage is added.
const ADJ = new WeakMap();
function adjacency(map) {
  let c = ADJ.get(map);
  if (c && c.tiles === map.tiles && c.passages === map.passages.length) return c;
  const ids = Object.keys(map.tiles);
  const index = new Map(ids.map((id, i) => [id, i]));
  const lists = new Map();
  for (const id of ids) {
    const { section, q, r } = parseTileId(id);
    const out = [];
    for (const n of neighbors(q, r)) {
      const nid = tileId(section, n.q, n.r);
      if (map.tiles[nid]) out.push(nid);
    }
    for (const p of map.passages) {
      if (p.a === id) out.push(p.b);
      else if (p.b === id) out.push(p.a);
    }
    lists.set(id, out);
  }
  c = { tiles: map.tiles, passages: map.passages.length, ids, index, lists };
  ADJ.set(map, c);
  return c;
}

/** Tiles next to `id` on the map, including a passage partner. Do not mutate
 *  the returned array: it is shared. */
export function mapNeighbors(map, id) {
  return adjacency(map).lists.get(id) || [];
}

/** Every tile the party can reach from `from` (the entry by default), with its
 *  distance in steps. Only passable tiles and fords can be stood on. */
export function reachableFrom(map, from = map.entry) {
  const dist = new Map([[from, 0]]);
  const queue = [from];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    for (const n of mapNeighbors(map, id)) {
      if (dist.has(n) || !isPassable(map.tiles[n])) continue;
      dist.set(n, dist.get(id) + 1);
      queue.push(n);
    }
  }
  return dist;
}

/** Least in-game time to reach every reachable tile from `from`, paying each
 *  entered tile's time cost (tileCosts, data/grounds.js). */
export function travelTimes(map, from) {
  const { ids, index, lists } = adjacency(map);
  const n = ids.length;
  const time = ids.map(id => tileCosts(map.tiles[id])?.time ?? null);
  const best = new Array(n).fill(Infinity);
  const done = new Array(n).fill(false);
  best[index.get(from)] = 0;
  for (;;) {
    let cur = -1, curT = Infinity;
    for (let i = 0; i < n; i++) if (!done[i] && best[i] < curT) { cur = i; curT = best[i]; }
    if (cur < 0) break;
    done[cur] = true;
    for (const nid of lists.get(ids[cur])) {
      const j = index.get(nid);
      if (done[j] || time[j] === null) continue;
      const t = curT + time[j];
      if (t < best[j]) best[j] = t;
    }
  }
  const out = new Map();
  for (let i = 0; i < n; i++) if (best[i] < Infinity) out.set(ids[i], best[i]);
  return out;
}

/** Total concealment of an occupant where it stands: its own plus the
 *  ground's (ENCOUNTERS, owner 2026-09-17). Read by Detection (chunk 7). */
export function occupantConcealment(map, occ) {
  const tile = map.tiles[occ.tile];
  return (occ.concealment || 0) + (GROUNDS[tile?.ground]?.concealment || 0);
}

/** Beast members of one family on reachable occupants. */
function familyCount(map, family, reach) {
  let n = 0;
  for (const o of map.occupants) {
    if (o.kind === 'beast' && o.family === family && reach.has(o.tile)) n += o.roster.length;
  }
  return n;
}

function bestGradeOf(occ) {
  return occ.roster.reduce((m, x) => Math.max(m, GRADE_RANK[x.grade] ?? -1), -1);
}

/** Share of the map revealed if every reachable tile is visited, counting only
 *  the tile itself and its neighbours (sight of at least 1). Sight range is
 *  chunk 7's, so this is the floor, not the real figure. */
export function revealableShare(map, reach = reachableFrom(map)) {
  const seen = new Set();
  for (const id of reach.keys()) {
    seen.add(id);
    for (const n of mapNeighbors(map, id)) seen.add(n);
  }
  return seen.size / Object.keys(map.tiles).length;
}

/** Forage spots that yield real food (good or modest ground, or fishing),
 *  reachable and not stripped by Lean Country. */
export function yieldingSpots(map, reach = reachableFrom(map)) {
  let n = 0;
  for (const id of reach.keys()) {
    const t = map.tiles[id];
    if (t.barren) continue;
    if (FORAGE_YIELDING.includes(GROUNDS[t.ground].forage) || t.fishing) n++;
  }
  return n;
}

/**
 * The in-game time to do a hunt's site objectives and walk out: from the
 * entry, to the nearest unvisited target each time, then to the nearest exit.
 * Greedy, so it overestimates the best route, which is the safe direction for
 * a deadline check. Fights and actions cost time too; that is chunk 7's clock.
 */
export function objectiveRouteTime(map) {
  const targets = [...new Set(allObjectives(map).flatMap(o => o.route || []))];
  let at = map.entry, total = 0;
  const left = new Set(targets.filter(t => t !== at));
  while (left.size) {
    const times = travelTimes(map, at);
    let next = null, nt = Infinity;
    for (const t of left) { const v = times.get(t) ?? Infinity; if (v < nt) { nt = v; next = t; } }
    if (next === null || nt === Infinity) return Infinity;
    total += nt; at = next; left.delete(next);
  }
  const times = travelTimes(map, at);
  const home = Math.min(...map.exits.map(e => times.get(e) ?? Infinity));
  return total + home;
}

function allObjectives(map) {
  return [map.objectives.primary, ...map.objectives.bonus];
}

/** Swift Return's deadline for a route of `routeTime`: leave before this day.
 *  The hunt starts on day 1, so "before day N" allows N - 1 whole days. */
export function swiftDeadline(routeTime, { beforeDay, routeSlack }) {
  return Math.max(beforeDay, Math.ceil(routeTime * routeSlack / DAY_TIME_UNITS) + 1);
}

// ── the needs: one place() and one check() per PLACEMENT_NEEDS key ──────────
//
// place(ctx, obj) puts on the map what the objective needs and records on
// `obj` which occupants/features it resolved to; `route` lists the tiles a
// party must visit, for Swift Return's route check. check(map, obj, reach)
// re-derives from the finished map alone whether the need is met: it is the
// validation step, and the harness runs it on every map it generates.

export const NEED_HANDLERS = {
  scout_sites: {
    place(ctx, obj) {
      const n = obj.params.sites;
      const ids = [];
      for (let i = 0; i < n; i++) {
        // Spread them out: the free tile farthest from the entry and the
        // sites already placed, from the three farthest at random.
        const cands = ctx.freeTiles({ minEntryDist: 2 })
          .map(id => [id, Math.min(ctx.entryDist.get(id), ...ids.map(s => ctx.stepDist(s, id)))])
          .sort((a, b) => b[1] - a[1] || compareIds(a[0], b[0]));
        if (!cands.length) return ctx.fail('no tile for a scout site');
        const pick = cands[Math.floor(ctx.rng() * Math.min(3, cands.length))][0];
        ids.push(ctx.addFeature({ kind: 'scout_site', tile: pick }).tile);
      }
      obj.sites = ids;
      obj.route = [...ids];
    },
    check(map, obj, reach) {
      const sites = map.features.filter(f => f.kind === 'scout_site' && reach.has(f.tile));
      return sites.length >= obj.params.sites && obj.sites.every(t => sites.some(s => s.tile === t));
    },
  },

  apex_beast: {
    place(ctx, obj) {
      const tile = ctx.pickTile({ minEntryDist: ctx.farDist(), noBlight: true, hostile: true, weight: 'encounter' })
                || ctx.pickTile({ noBlight: true, hostile: true, weight: 'encounter' });
      if (!tile) return ctx.fail('no tile for the apex');
      const occ = ctx.addBeast(tile, { family: ctx.zone.apex.family, composition: 'lone',
        roster: [{ type: ctx.zone.apex.family, grade: 'great' }], state: 'rooted', quarry: true });
      occ.apex = true;
      obj.occupant = occ.id;
      obj.family = occ.family;
      obj.route = [tile];
    },
    check(map, obj, reach) {
      const o = map.occupants.find(x => x.id === obj.occupant);
      return !!o && o.apex && reach.has(o.tile) && o.roster.some(m => m.grade === 'great');
    },
  },

  native_family: {
    place(ctx, obj) {
      const natives = Object.keys(ctx.zone.natives);
      obj.family = natives[Math.floor(ctx.rng() * natives.length)];
      obj.count = obj.params.count;
      while (familyCount(ctx.map, obj.family, ctx.reach) < obj.count) {
        const need = obj.count - familyCount(ctx.map, obj.family, ctx.reach);
        const tile = ctx.pickTile({ noBlight: true, hostile: true, weight: 'encounter', family: obj.family });
        if (!tile) return ctx.fail(`no tile for ${obj.family}`);
        const size = Math.max(4, Math.min(8, need));
        const grade = ctx.rollGrade();
        ctx.addBeast(tile, { family: obj.family, composition: 'pack',
          roster: Array.from({ length: size }, () => ({ type: obj.family, grade })), quarry: true });
      }
      obj.route = ctx.nearestFamilyTiles(obj.family, obj.count);
    },
    check(map, obj, reach) {
      return familyCount(map, obj.family, reach) >= obj.count;
    },
  },

  retrieve_site: {
    place(ctx, obj) {
      const tile = ctx.pickTile({ minEntryDist: ctx.farDist() }) || ctx.pickTile({ minEntryDist: 2 });
      if (!tile) return ctx.fail('no tile for the retrieve site');
      ctx.addFeature({ kind: 'retrieve_site', tile });
      obj.site = tile;
      obj.route = [tile];
    },
    check(map, obj, reach) {
      return map.features.some(f => f.kind === 'retrieve_site' && f.tile === obj.site) && reach.has(obj.site);
    },
  },

  shrine: {
    place(ctx, obj) {
      const eventId = ctx.zone.setPieces?.shrine;
      if (!eventId || !ctx.eventDefs.has(eventId)) return ctx.fail(`zone has no shrine set piece`);
      const tile = ctx.pickTile({ minEntryDist: 2, noBlight: true }) || ctx.pickTile({ noBlight: true });
      if (!tile) return ctx.fail('no tile for the shrine');
      ctx.addFeature({ kind: 'shrine', tile, eventId });
      obj.site = tile;
      obj.eventId = eventId;
      obj.route = [tile];
    },
    check(map, obj, reach) {
      return map.features.some(f => f.kind === 'shrine' && f.tile === obj.site && f.eventId === obj.eventId) && reach.has(obj.site);
    },
  },

  exit: {
    // Every map has one exit, the entry. A deadline (Swift Return) is set by
    // the map: the route through the site objectives and out, times
    // routeSlack, rounded up to whole days, never before params.beforeDay. If
    // the route would push it past that earliest day, a Waystone (an
    // exit-capable tile, HUNT_STRUCTURE) goes near the far end of the route to
    // shorten the way out. Placed last, once every site is placed.
    late: true,
    place(ctx, obj) {
      obj.route = obj.route || [];
      if (!obj.params?.beforeDay) return;
      let t = objectiveRouteTime(ctx.map);
      if (swiftDeadline(t, obj.params) > obj.params.beforeDay) {
        const far = allObjectives(ctx.map).flatMap(o => o.route || [])
          .sort((a, b) => ctx.entryDist.get(b) - ctx.entryDist.get(a) || compareIds(a, b))[0];
        const times = far ? travelTimes(ctx.map, far) : new Map();
        const spot = ctx.freeTiles({})
          .filter(id => times.has(id))
          .sort((a, b) => times.get(a) - times.get(b) || compareIds(a, b))[0];
        if (spot) {
          ctx.addFeature({ kind: 'waystone', tile: spot });
          ctx.map.tiles[spot].exit = true;
          ctx.map.exits.push(spot);
        }
        t = objectiveRouteTime(ctx.map);
      }
      obj.routeTime = t;
      obj.beforeDay = swiftDeadline(t, obj.params);
    },
    check(map, obj, reach) {
      if (!map.exits.length || !map.exits.every(e => reach.has(e) && map.tiles[e].exit)) return false;
      if (!obj.params?.beforeDay) return true;
      const t = objectiveRouteTime(map);
      return Number.isFinite(t) && obj.beforeDay >= obj.params.beforeDay
        && t * obj.params.routeSlack <= (obj.beforeDay - 1) * DAY_TIME_UNITS;
    },
  },

  reachable_tiles: {
    place(ctx, obj) { obj.route = obj.route || []; },
    check(map, obj, reach) { return revealableShare(map, reach) * 100 >= obj.params.revealPct; },
  },

  forage_spots: {
    // Placed by the forage step, which never lets Lean Country cut below the
    // floor (a plan's demand is a floor, as with density).
    place(ctx, obj) { obj.route = obj.route || []; ctx.forageFloor = Math.max(ctx.forageFloor, obj.params.count); },
    check(map, obj, reach) { return yieldingSpots(map, reach) >= obj.params.count; },
  },

  prime_beast: {
    // "Carrying a core part": every beast carries core parts (weaponMain,
    // head, chest, eyes, vital: BEAST_PARTS), so a Prime-or-better beast is
    // the whole need. Parts themselves are chunk 9.
    late: true,
    place(ctx, obj) {
      if (!ctx.anyBeast(o => bestGradeOf(o) >= GRADE_RANK.prime)) {
        const tile = ctx.pickTile({ noBlight: true, hostile: true, weight: 'encounter' });
        if (!tile) return ctx.fail('no tile for a Prime beast');
        const fam = ctx.pickFamily(tile);
        ctx.addBeast(tile, { family: fam, composition: 'matriarch', state: 'rooted',
          roster: [{ type: fam, grade: 'prime' }, ...Array.from({ length: randInt(ctx.rng, 2, 3) }, () => ({ type: fam, grade: 'yearling' }))] });
      }
      obj.route = [ctx.nearestBeast(o => bestGradeOf(o) >= GRADE_RANK.prime)];
    },
    check(map, obj, reach) {
      return map.occupants.some(o => o.kind === 'beast' && reach.has(o.tile) && bestGradeOf(o) >= GRADE_RANK.prime);
    },
  },

  great_beast: {
    late: true,
    place(ctx, obj) {
      if (!ctx.anyBeast(o => bestGradeOf(o) >= GRADE_RANK.great)) {
        const tile = ctx.pickTile({ noBlight: true, hostile: true, weight: 'encounter' });
        if (!tile) return ctx.fail('no tile for a Great beast');
        const fam = ctx.pickFamily(tile);
        ctx.addBeast(tile, { family: fam, composition: 'lone', roster: [{ type: fam, grade: 'great' }] });
      }
      obj.route = [ctx.nearestBeast(o => bestGradeOf(o) >= GRADE_RANK.great)];
    },
    check(map, obj, reach) {
      return map.occupants.some(o => o.kind === 'beast' && reach.has(o.tile) && bestGradeOf(o) >= GRADE_RANK.great);
    },
  },

  concealed_occupant: {
    // A cult ambush band on ground that hides it past 100. Nothing at danger 1
    // is that well hidden otherwise, so Unmask places its own.
    late: true,
    place(ctx, obj) {
      const hidden = o => occupantConcealment(ctx.map, o) > 100;
      if (!ctx.map.occupants.some(o => ctx.reach.has(o.tile) && hidden(o))) {
        const own = OCCUPANT_CONCEALMENT.cultAmbusher;
        const tile = ctx.pickTile({ hostile: true, weight: 'concealment',
          filter: id => own + GROUNDS[ctx.map.tiles[id].ground].concealment > 100 });
        if (!tile) return ctx.fail('no ground to hide an ambush');
        ctx.addCultists(tile, { ambush: true });
      }
      obj.route = [ctx.map.occupants.filter(o => ctx.reach.has(o.tile) && hidden(o))
        .sort((a, b) => ctx.entryDist.get(a.tile) - ctx.entryDist.get(b.tile))[0].tile];
    },
    check(map, obj, reach) {
      return map.occupants.some(o => reach.has(o.tile) && occupantConcealment(map, o) > 100);
    },
  },

  blight_tile: {
    // The blight step lays at least one patch when this is asked for.
    place(ctx, obj) {
      obj.route = [ctx.map.features.filter(f => f.kind === 'blight_source' && ctx.reach.has(f.tile))
        .map(f => f.tile).sort((a, b) => ctx.entryDist.get(a) - ctx.entryDist.get(b))[0]].filter(Boolean);
    },
    check(map, obj, reach) {
      return [...reach.keys()].some(id => map.tiles[id].ground === 'blight');
    },
  },
};

// ── the generator ────────────────────────────────────────────────────────────

/**
 * What the generator needs from a plan instance: its objective and size (on
 * the base type; only the basic plan has them until the base-type catalogue
 * is on the items), its bonus objectives, and the modifiers it reads.
 */
export function planMapInputs(view) {
  return {
    objective: view.objective,
    size: view.size,
    bonusObjectives: view.bonusObjectives.map(o => o.id),
    mods: view.mods || {},
  };
}

/**
 * Generate a hunt map. Throws on bad input; returns a map that passed
 * validation, or throws if MAX_ATTEMPTS sub-seeds all failed (the harness
 * counts how often a seed needs a re-roll).
 *
 * @param {object} o
 * @param {string} o.zoneId          a zone with generator data (data/zones.js)
 * @param {string} o.objective       a PRIMARY_OBJECTIVES key
 * @param {string} o.size            a MAP_SIZES key
 * @param {number} o.seed
 * @param {string[]} [o.bonusObjectives]  BONUS_OBJECTIVES keys
 * @param {object} [o.mods]          the plan's modifier fields: encounterChancePercent,
 *                                   gradeShiftPercent, leanCountryPercent, blightPatches
 */
export function generateHuntMap({ zoneId, objective, size, seed, bonusObjectives = [], mods = {} }) {
  const zone = getZone(zoneId);
  if (!zone) throw new Error(`unknown zone '${zoneId}'`);
  if (!zone.palette || !zone.relief || !zone.natives || !zone.apex) throw new Error(`zone '${zoneId}' has no generator data`);
  if (!PRIMARY_OBJECTIVES[objective]) throw new Error(`unknown objective '${objective}'`);
  if (!MAP_SIZES[size]) throw new Error(`unknown size '${size}'`);
  if (!Number.isFinite(seed)) throw new Error('seed must be a number');
  for (const b of bonusObjectives) if (!BONUS_OBJECTIVES[b]) throw new Error(`unknown bonus objective '${b}'`);

  const problems = [];
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const map = tryGenerate({ zone, objective, size, seed: seed >>> 0, attempt, bonusObjectives, mods });
    if (map.failed) { problems.push(map.failed); continue; }
    const v = validateHuntMap(map);
    if (v.ok) return map;
    problems.push(v.problems.join('; '));
  }
  throw new Error(`no valid map for ${zoneId}/${objective}/${size} seed ${seed}: ${problems.slice(-3).join(' | ')}`);
}

function tryGenerate({ zone, objective, size, seed, attempt, bonusObjectives, mods }) {
  const rng = makeRng(attemptSeed(seed, attempt, zone.id));
  const sizeDef = MAP_SIZES[size];
  const map = {
    v: HUNT_MAP_VERSION, seed, attempt, zoneId: zone.id, objective, size,
    bonusObjectives: [...bonusObjectives],
    mods: {
      encounterChancePercent: mods.encounterChancePercent || 0,
      gradeShiftPercent: mods.gradeShiftPercent || 0,
      leanCountryPercent: mods.leanCountryPercent || 0,
      blightPatches: mods.blightPatches || 0,
    },
    sections: [], tiles: {}, entry: null, exits: [], passages: [],
    features: [], occupants: [], objectives: null,
  };
  let failed = null;
  const fail = (why) => { failed = failed || why; };

  // ── 1. layout ──────────────────────────────────────────────────────────────
  const twoSections = !!sizeDef.twoSectionChance && rng() < sizeDef.twoSectionChance;
  const budgets = twoSections ? [Math.ceil(sizeDef.tiles / 2), Math.floor(sizeDef.tiles / 2)] : [sizeDef.tiles];
  budgets.forEach((n, s) => {
    const cells = growSection(rng, n);
    for (const c of cells) map.tiles[tileId(s, c.q, c.r)] = { ground: null, relief: 'flat' };
  });

  // ── 2. terrain ─────────────────────────────────────────────────────────────
  const paletteEntries = Object.entries(zone.palette).filter(([g]) => g !== 'blight');
  const reliefEntries = Object.entries(zone.relief);
  for (let s = 0; s < budgets.length; s++) {
    const ids = Object.keys(map.tiles).filter(id => parseTileId(id).section === s);
    paintVoronoi(rng, ids, Math.max(3, Math.round(ids.length / 5)), () => pickWeighted(rng, paletteEntries),
      (id, g) => { map.tiles[id].ground = g; });
    paintVoronoi(rng, ids, Math.max(2, Math.round(ids.length / 7)), () => pickWeighted(rng, reliefEntries),
      (id, rel) => { map.tiles[id].relief = GROUNDS[map.tiles[id].ground].passable ? rel : 'flat'; });
  }
  // Canonical order from here on, so the output does not depend on growth order.
  map.tiles = Object.fromEntries(Object.keys(map.tiles).sort(compareIds).map(id => [id, map.tiles[id]]));
  const allIds = Object.keys(map.tiles);
  for (let s = 0; s < budgets.length; s++) {
    map.sections.push({ index: s, tiles: allIds.filter(id => parseTileId(id).section === s).length });
  }

  const landGround = paletteEntries.filter(([g]) => GROUNDS[g].passable).sort((a, b) => b[1] - a[1])[0][0];
  const makeLand = (id) => {
    const t = map.tiles[id];
    if (!GROUNDS[t.ground].passable) { t.ground = landGround; t.relief = 'flat'; }
  };
  const isEdge = (id) => {
    const { section, q, r } = parseTileId(id);
    return neighbors(q, r).some(n => !map.tiles[tileId(section, n.q, n.r)]);
  };

  // ── 3a. entry and passages ─────────────────────────────────────────────────
  const edge0 = allIds.filter(id => parseTileId(id).section === 0 && isEdge(id));
  map.entry = edge0[Math.floor(rng() * edge0.length)];
  makeLand(map.entry);
  map.tiles[map.entry].exit = true;
  map.exits.push(map.entry);
  if (twoSections) {
    const e = parseTileId(map.entry);
    const far = edge0.filter(id => id !== map.entry)
      .map(id => [id, distance(parseTileId(id), e)]).sort((a, b) => b[1] - a[1] || compareIds(a[0], b[0]));
    const top = far.filter(([, d]) => d === far[0][1]);
    const a = top[Math.floor(rng() * top.length)][0];
    const edge1 = allIds.filter(id => parseTileId(id).section === 1 && isEdge(id));
    const b = edge1[Math.floor(rng() * edge1.length)];
    makeLand(a); makeLand(b);
    map.passages.push({ a, b });
  }
  const reserved = new Set([map.entry, ...map.passages.flatMap(p => [p.a, p.b])]);

  // ── 3b. fords: join land cut off by a single water tile ────────────────────
  for (;;) {
    const reach = reachableFrom(map);
    const bridges = allIds.filter(id => {
      const t = map.tiles[id];
      if (t.ford || t.ground !== 'water') return false;
      const ns = mapNeighbors(map, id);
      return ns.some(n => reach.has(n)) && ns.some(n => !reach.has(n) && isPassable(map.tiles[n]));
    });
    if (!bridges.length) break;
    map.tiles[bridges[Math.floor(rng() * bridges.length)]].ford = true;
  }
  if (map.passages.length && !reachableFrom(map).has(map.passages[0].b)) fail('second section unreachable');
  const landReach = reachableFrom(map);

  // ── 3c. blight: placed around a source, never rolled. Blight is passable, so
  //    painting it cannot cut anything off; its source is always reachable. ───────────────────────
  const wantsBlight = [objective, ...bonusObjectives].some(o => needsOf(o).includes('blight_tile'));
  const patches = Math.max(map.mods.blightPatches, wantsBlight ? 1 : 0);
  const e0 = parseTileId(map.entry);
  for (let i = 0; i < patches; i++) {
    const cands = allIds.filter(id => landReach.has(id) && !reserved.has(id) && !map.tiles[id].ford && GROUNDS[map.tiles[id].ground].passable
      && map.tiles[id].ground !== 'blight' && !map.features.some(f => f.tile === id)
      && (parseTileId(id).section !== 0 || distance(parseTileId(id), e0) >= 3));
    if (!cands.length) { fail('no room for blight'); break; }
    const src = cands[Math.floor(rng() * cands.length)];
    map.features.push({ kind: 'blight_source', tile: src });
    for (const id of [src, ...mapNeighbors(map, src)]) {
      if (reserved.has(id) || !GROUNDS[map.tiles[id].ground].passable) continue;
      map.tiles[id].ground = 'blight';
    }
  }

  // ── placement context ──────────────────────────────────────────────────────
  const reach = reachableFrom(map);
  const entryDist = reach;
  const maxEntryDist = Math.max(...reach.values());
  const occupied = new Set([...reserved, ...map.features.map(f => f.tile)]);
  const eventDefs = new Map();
  for (const cat of EVENT_CATEGORIES) for (const ev of zone.encounterTable?.[cat] || []) eventDefs.set(ev.id, { ...ev, category: cat });
  const danger = zone.danger || 1;
  const house = zone.divineAlignment || null;
  let nextOcc = 1;

  const baseGrades = (GRADE_WEIGHTS_BY_DANGER.find(b => danger <= b.maxDanger) || GRADE_WEIGHTS_BY_DANGER.at(-1)).weights;
  const gradeWeights = shiftGrades(baseGrades, map.mods.gradeShiftPercent);

  const ctx = {
    rng, map, zone, reach, entryDist, eventDefs, fail, forageFloor: 0,
    stepDist: (a, b) => {
      const A = parseTileId(a), B = parseTileId(b);
      return A.section === B.section ? distance(A, B) : (entryDist.get(a) ?? 0) + (entryDist.get(b) ?? 0);
    },
    farDist: () => Math.max(2, Math.ceil(maxEntryDist * 0.5)),
    freeTiles({ minEntryDist = 0, noBlight = false, hostile = false, filter = null }) {
      const clear = hostile ? Math.max(minEntryDist, DENSITY.entryClearance + 1) : minEntryDist;
      return [...reach.keys()].filter(id => !occupied.has(id) && entryDist.get(id) >= clear
        && !(noBlight && map.tiles[id].ground === 'blight') && (!filter || filter(id)));
    },
    pickTile(opts = {}) {
      const ids = ctx.freeTiles(opts);
      if (!ids.length) return null;
      const w = (id) => {
        const t = map.tiles[id];
        let x = opts.weight === 'encounter' ? (t.ford ? 1 : GROUNDS[t.ground].encounterBias)
              : opts.weight === 'concealment' ? 1 + GROUNDS[t.ground].concealment : 1;
        if (opts.family && GROUNDS[t.ground].families.includes(opts.family)) x *= 3;
        return x;
      };
      return pickWeighted(rng, ids.map(id => [id, w(id)])) ?? ids[0];
    },
    pickFamily(tile) {
      const fams = GROUNDS[map.tiles[tile].ground].families;
      return pickWeighted(rng, Object.keys(zone.natives).map(f => [f, fams.includes(f) ? 3 : 1]));
    },
    rollGrade: () => pickWeighted(rng, GRADES.map(g => [g, gradeWeights[g]])),
    addFeature(f) { map.features.push(f); occupied.add(f.tile); return f; },
    addBeast(tile, { family, composition, roster, state, quarry = false }) {
      const comp = COMPOSITIONS[composition];
      const corrupted = !!GROUNDS[map.tiles[tile].ground].corrupts;
      const mark = corrupted ? 'corrupted' : (house && (quarry || rng() < MARKED_SHARE)) ? 'marked' : 'unmarked';
      const occ = {
        id: `o${nextOcc++}`, kind: 'beast', tile, family, composition, roster, mark,
        state: state || comp.state,
        concealment: corrupted ? OCCUPANT_CONCEALMENT.corrupted : comp.concealment,
      };
      map.occupants.push(occ); occupied.add(tile);
      return occ;
    },
    addCultists(tile, { ambush = false } = {}) {
      const flavor = zone.encounterTable?.cultists || [];
      const occ = {
        id: `o${nextOcc++}`, kind: 'cultist', tile,
        variant: flavor.length ? flavor[Math.floor(rng() * flavor.length)].id : null,
        roster: Array.from({ length: randInt(rng, CULTIST_BAND.min, CULTIST_BAND.max) }, () => ({ type: 'cultist', grade: null })),
        state: 'rooted',
        concealment: ambush ? OCCUPANT_CONCEALMENT.cultAmbusher : OCCUPANT_CONCEALMENT.cultist,
      };
      if (ambush) occ.ambush = true;
      map.occupants.push(occ); occupied.add(tile);
      return occ;
    },
    anyBeast: (pred) => map.occupants.some(o => o.kind === 'beast' && reach.has(o.tile) && pred(o)),
    nearestBeast: (pred) => map.occupants.filter(o => o.kind === 'beast' && reach.has(o.tile) && pred(o))
      .sort((a, b) => entryDist.get(a.tile) - entryDist.get(b.tile) || compareIds(a.tile, b.tile))[0]?.tile,
    nearestFamilyTiles(family, count) {
      const out = [];
      let n = 0;
      for (const o of map.occupants.filter(x => x.kind === 'beast' && x.family === family && reach.has(x.tile))
        .sort((a, b) => entryDist.get(a.tile) - entryDist.get(b.tile) || compareIds(a.tile, b.tile))) {
        if (n >= count) break;
        out.push(o.tile); n += o.roster.length;
      }
      return out;
    },
  };

  // ── 3d. what the objectives need ───────────────────────────────────────────
  const size_ = size;
  const primary = { id: objective, params: { ...PRIMARY_OBJECTIVES[objective].params[size_] } };
  const bonus = bonusObjectives.map(id => ({ id, params: { ...BONUS_OBJECTIVES[id].params } }));
  map.objectives = { primary, bonus };
  const jobs = [primary, ...bonus].flatMap(obj => needsOf(obj.id).map(need => ({ obj, need })));
  if (!failed) for (const { obj, need } of jobs.filter(j => !NEED_HANDLERS[j.need].late)) NEED_HANDLERS[need].place(ctx, obj);
  if (!failed) for (const { obj, need } of jobs.filter(j => NEED_HANDLERS[j.need].late && j.need !== 'exit')) NEED_HANDLERS[need].place(ctx, obj);
  for (const o of [primary, ...bonus]) if (!o.route) o.route = [];

  // ── 3e. density: the plan's floor, scaled by region and plan ───────────────
  const hostiles = () => map.occupants.filter(o => o.kind === 'beast' || o.kind === 'cultist').length;
  const pct = (zone.modifiers?.encounterChancePercent || 0) + map.mods.encounterChancePercent;
  const target = Math.max(hostiles(), Math.round(allIds.length / DENSITY.tilesPerFight * (1 + pct / 100)));
  map.density = { floor: hostiles(), target };
  const comps = Object.entries(COMPOSITIONS).filter(([, c]) => !c.minDanger || danger >= c.minDanger).map(([k, c]) => [k, c.weight]);
  while (!failed && hostiles() < target) {
    const tile = ctx.pickTile({ hostile: true, weight: 'encounter' });
    if (!tile) break;
    if (rng() < (zone.cultistShare || 0)) { ctx.addCultists(tile); continue; }
    const fam = ctx.pickFamily(tile);
    const comp = pickWeighted(rng, comps);
    ctx.addBeast(tile, { family: fam, composition: comp, roster: buildRoster(rng, comp, fam, ctx.rollGrade, gradeWeights) });
  }

  // ── 3f. event sites, about one per 8 tiles ─────────────────────────────────
  const setPieceIds = new Set(Object.values(zone.setPieces || {}));
  const eventPool = [...eventDefs.values()].filter(ev => !setPieceIds.has(ev.id));
  const eventCount = Math.round(allIds.length / DENSITY.tilesPerEvent);
  let deck = [];
  for (let i = 0; i < eventCount && eventPool.length && !failed; i++) {
    if (!deck.length) deck = shuffle(rng, eventPool.map(ev => ev.id));
    const tile = ctx.pickTile({ minEntryDist: 1 });
    if (!tile) break;
    const id = deck.pop();
    map.occupants.push({ id: `o${nextOcc++}`, kind: 'event', tile, eventId: id,
      category: eventDefs.get(id).category, concealment: OCCUPANT_CONCEALMENT.event });
    occupied.add(tile);
  }

  // ── 3g. forage and fishing spots ───────────────────────────────────────────
  const spots = [];
  for (const id of allIds) {
    const t = map.tiles[id];
    if (!isPassable(t) || t.ford) continue;
    if (mapNeighbors(map, id).some(n => map.tiles[n].ground === 'water')) t.fishing = true;
    if (GROUNDS[t.ground].forage !== 'none' || t.fishing) spots.push(id);
  }
  const cut = Math.round(spots.length * map.mods.leanCountryPercent / 100);
  const shuffled = shuffle(rng, spots);
  for (let i = 0; i < cut; i++) map.tiles[shuffled[i]].barren = true;
  // The floor wins over Lean Country: restore stripped yielding spots.
  for (let i = cut - 1; i >= 0 && yieldingSpots(map, reach) < ctx.forageFloor; i--) delete map.tiles[shuffled[i]].barren;
  map.forage = { spots: spots.length, barren: spots.filter(id => map.tiles[id].barren).length, floor: ctx.forageFloor };

  // ── 3h. exits last: a deadline is checked against the finished route ──────
  if (!failed) for (const { obj, need } of jobs.filter(j => j.need === 'exit')) NEED_HANDLERS.exit.place(ctx, obj);

  if (failed) return { failed };
  return map;
}

function needsOf(objectiveId) {
  if (PRIMARY_OBJECTIVES[objectiveId]) return PRIMARY_OBJECTIVES[objectiveId].needs;
  return BONUS_OBJECTIVES[objectiveId]?.placement?.needs || [];
}

/**
 * Grow one section: a connected blob of exactly `n` cells inside the 13 x 11
 * box, from the centre outward. A cell with more placed neighbours is likelier
 * to be taken, so the blob stays compact but never a perfect hexagon.
 */
function growSection(rng, n) {
  const c = fromOffset(Math.floor(SECTION_COLS / 2), Math.floor(SECTION_ROWS / 2));
  const cells = [c];
  const inSet = new Set([posKey(c.q, c.r)]);
  const frontier = new Map();
  const touch = (p) => {
    for (const nb of neighbors(p.q, p.r)) {
      const k = posKey(nb.q, nb.r);
      if (inSet.has(k) || !inSectionBounds(nb.q, nb.r)) continue;
      const f = frontier.get(k);
      if (f) f.n++; else frontier.set(k, { q: nb.q, r: nb.r, n: 1 });
    }
  };
  touch(c);
  while (cells.length < n) {
    const entries = [...frontier.entries()].map(([k, f]) => [k, f.n * f.n * Math.exp(-0.25 * distance(f, c))]);
    const k = pickWeighted(rng, entries);
    const f = frontier.get(k);
    frontier.delete(k);
    inSet.add(k);
    cells.push({ q: f.q, r: f.r });
    touch(f);
  }
  return cells;
}

/** Paint `ids` in patches: k seed tiles each get a value, every tile takes the
 *  value of its nearest seed, with a little jitter so borders are ragged. */
function paintVoronoi(rng, ids, k, pickValue, apply) {
  const seeds = shuffle(rng, ids).slice(0, Math.min(k, ids.length)).map(id => ({ p: parseTileId(id), v: pickValue() }));
  for (const id of ids) {
    const p = parseTileId(id);
    let best = null, bd = Infinity;
    for (const s of seeds) {
      const d = distance(p, s.p) + rng() * 0.9;
      if (d < bd) { bd = d; best = s; }
    }
    apply(id, best.v);
  }
}

function shuffle(rng, arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Elder Grounds: move `pct`% of the Yearling + Grown weight onto Prime and
 *  Great, 2 : 1 (ENCOUNTERS; PLAN_AFFIXES). */
export function shiftGrades(weights, pct) {
  const p = Math.max(0, Math.min(100, pct || 0)) / 100;
  const out = { ...weights };
  const moved = (weights.yearling + weights.grown) * p;
  out.yearling = weights.yearling * (1 - p);
  out.grown = weights.grown * (1 - p);
  out.prime = weights.prime + moved * 2 / 3;
  out.great = weights.great + moved / 3;
  return out;
}

/** A filler occupant's roster from its named composition (ENCOUNTERS). */
function buildRoster(rng, comp, family, rollGrade, weights) {
  const m = (grade) => ({ type: family, grade });
  switch (comp) {
    case 'lone': {
      const a = rollGrade(), b = rollGrade();
      return [m(GRADE_RANK[a] >= GRADE_RANK[b] ? a : b)];      // usually higher grade
    }
    case 'matriarch':
      return [m('prime'), ...Array.from({ length: randInt(rng, 2, 3) }, () => m('yearling'))];
    case 'alpha': {
      const lead = pickWeighted(rng, [['prime', weights.prime], ['great', weights.great]]);
      return [m(lead), ...Array.from({ length: randInt(rng, 4, 6) }, () => m('grown'))];
    }
    case 'scourge':
      return Array.from({ length: randInt(rng, 6, 8) }, () => m('great'));
    case 'pack':
    default: {
      const g = rollGrade();
      return Array.from({ length: randInt(rng, 4, 8) }, () => m(g));
    }
  }
}

// ── validation (step 5) ──────────────────────────────────────────────────────

/**
 * Re-derives from the finished map alone that it is playable: the shape is the
 * size tier, every section fits one screen, one thing per tile, every placed
 * thing reachable from the entry, and every objective's needs met.
 */
export function validateHuntMap(map) {
  const problems = [];
  const ids = Object.keys(map.tiles);
  const want = MAP_SIZES[map.size]?.tiles;
  if (ids.length !== want) problems.push(`${ids.length} tiles, want ${want}`);
  for (const id of ids) {
    const { q, r } = parseTileId(id);
    if (!inSectionBounds(q, r)) problems.push(`${id} outside 13x11`);
    if (!GROUNDS[map.tiles[id].ground]) problems.push(`${id} unknown ground`);
    if (!RELIEF[map.tiles[id].relief]) problems.push(`${id} unknown relief`);
  }
  const reach = reachableFrom(map);
  if (!isPassable(map.tiles[map.entry])) problems.push('entry not passable');
  const things = [...map.features.map(f => f.tile), ...map.occupants.map(o => o.tile)];
  if (new Set(things).size !== things.length) problems.push('two things on one tile');
  for (const t of things) if (!reach.has(t)) problems.push(`${t} unreachable`);
  for (const p of map.passages) if (!reach.has(p.a) || !reach.has(p.b)) problems.push('passage unreachable');
  for (const o of map.occupants) {
    if (o.roster && (o.roster.length < 1 || o.roster.length > 8)) problems.push(`${o.id} roster ${o.roster.length}`);
  }
  for (const obj of allObjectives(map)) {
    for (const need of needsOf(obj.id)) {
      if (!NEED_HANDLERS[need].check(map, obj, reach)) problems.push(`${obj.id}: ${need} not met`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/** Every PLACEMENT_NEEDS key has a handler, and no handler is unlisted. */
export function unhandledNeeds() {
  return {
    missing: Object.keys(PLACEMENT_NEEDS).filter(k => !NEED_HANDLERS[k]),
    extra: Object.keys(NEED_HANDLERS).filter(k => !PLACEMENT_NEEDS[k]),
  };
}

