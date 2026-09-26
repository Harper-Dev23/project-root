// tools/headless/huntmap.mjs
//
// The hunt-map generator (Exploration System v2, chunk 5). Every map here is
// made by the REAL generateHuntMap, and every property is read back with the
// real exported functions (HexGrid, grounds, HuntMapGen). No formula is
// re-derived to check it; the only thing this file computes itself is an
// independent walk of the finished map, to prove reachability without trusting
// the generator's own walk.
//
// What it proves (IMPLEMENTATION_PLAN, chunk 5 "proves"):
//   - hex math: neighbours, distance, rings, ranges, lines, offset round trip,
//     the 13 x 11 section box
//   - the ground, relief and region data is complete and points at real things
//   - every PLACEMENT_NEEDS key has a generator handler, and no handler is
//     unlisted; every objective's needs are in the list
//   - 500 seeds per starter region and size (3,000 maps): every map valid,
//     every placed thing reachable from the entry, every primary and bonus
//     objective completable. The primary objective cycles through all five
//     and the bonus objectives through all 36 pairs, so every primary meets
//     every pair; half the seeds carry every demand prefix at its T1 maximum
//   - the same inputs give the same map (determinism)
//   - the plan modifiers the generator reads really move the map (Teeming,
//     Elder Grounds, Lean Country, Blighted)
//   - a real rolled plan feeds the generator (planMapInputs)
//   - seed -> map golden: a hash over all 3,000 maps, six sample maps drawn
//     out, and the measured statistics
//
// USAGE
//   node tools/headless/huntmap.mjs                  run the checks
//   node tools/headless/huntmap.mjs --json out.json  also write the golden
//   node tools/headless/huntmap.mjs --diff old.json  also compare against one

import fs from 'node:fs';
import crypto from 'node:crypto';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const pct = (n, d) => round(100 * n / Math.max(1, d), 1);

const store = new Map();
globalThis.localStorage = {
  get length() { return store.size; },
  key: (i) => [...store.keys()][i] ?? null,
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => store.clear(),
};
const { installPhaserStub } = await import('./phaserStub.js');
installPhaserStub(17);

const Hex = await import('../../src/systems/HexGrid.js');
const { GROUNDS, RELIEF, FORD, isPassable, tileCosts } = await import('../../data/grounds.js');
const { MAP_SIZES, PRIMARY_OBJECTIVES, GRADES, COMPOSITIONS, UNMASK_MAX_CONCEALMENT } = await import('../../data/huntMapGen.js');
const { PLACEMENT_NEEDS, BONUS_OBJECTIVES } = await import('../../data/planAffixes.js');
const { ZONES } = await import('../../data/zones.js');
const { HUNT_BEASTS } = await import('../../data/beastParts.js');
const { EVENT_TEMPLATES } = await import('../../data/events.js');
const Gen = await import('../../src/systems/HuntMapGen.js');
const { generateHuntMap, validateHuntMap, unhandledNeeds, NEED_HANDLERS, occupantConcealment,
        revealableShare, yieldingSpots, objectiveRouteTime, swiftDeadline, planMapInputs, shiftGrades } = Gen;
const { createItemInstance, huntPlanView } = await import('../../src/systems/ItemFactory.js');
const { makeBasicPlan } = await import('../../src/systems/HuntPlans.js');
const { makeRng } = await import('../../src/systems/seededRng.js');

const golden = {};
const ZONE_IDS = ['reeds_of_gethsemane', 'bay_of_solace'];
const SIZES = Object.keys(MAP_SIZES);
const PRIMARIES = Object.keys(PRIMARY_OBJECTIVES);
const BONUSES = Object.keys(BONUS_OBJECTIVES);
const PAIRS = [];
for (let i = 0; i < BONUSES.length; i++) for (let j = i + 1; j < BONUSES.length; j++) PAIRS.push([BONUSES[i], BONUSES[j]]);
const MAX_DEMANDS = { encounterChancePercent: 20, gradeShiftPercent: 30, leanCountryPercent: 50, blightPatches: 5 };
const SEEDS = 500;

// =============================================================================
console.log('=== hex coordinates ===');
{
  const c = { q: 2, r: -1 };
  const ns = Hex.neighbors(c.q, c.r);
  check('six neighbours, each one step away, each seeing us back',
    ns.length === 6 && ns.every(n => Hex.distance(c, n) === 1)
    && ns.every(n => Hex.neighbors(n.q, n.r).some(m => m.q === c.q && m.r === c.r)));
  let ringsOk = true, rangeOk = true;
  for (let k = 0; k <= 5; k++) {
    const ring = Hex.ring(c, k);
    if (ring.length !== (k === 0 ? 1 : 6 * k) || !ring.every(p => Hex.distance(c, p) === k)) ringsOk = false;
    if (Hex.range(c, k).length !== 3 * k * (k + 1) + 1) rangeOk = false;
  }
  check('ring k holds 6k hexes, all at distance k', ringsOk);
  check('range k holds 3k(k+1)+1 hexes: 37 / 61 / 91 at 3 / 4 / 5, the size tiers',
    rangeOk && Hex.range(c, 3).length === 37 && Hex.range(c, 4).length === 61 && Hex.range(c, 5).length === 91);
  const rng = makeRng(3);
  let lineOk = true;
  for (let i = 0; i < 2000; i++) {
    const a = { q: Math.floor(rng() * 21) - 10, r: Math.floor(rng() * 21) - 10 };
    const b = { q: Math.floor(rng() * 21) - 10, r: Math.floor(rng() * 21) - 10 };
    const L = Hex.line(a, b);
    const d = Hex.distance(a, b);
    if (L.length !== d + 1 || L[0].q !== a.q || L[0].r !== a.r || L.at(-1).q !== b.q || L.at(-1).r !== b.r) lineOk = false;
    for (let j = 1; j < L.length; j++) if (Hex.distance(L[j - 1], L[j]) !== 1) lineOk = false;
  }
  check('2,000 random lines: distance + 1 hexes, ends right, every step a neighbour', lineOk);
  let box = 0, trip = true;
  for (let row = 0; row < Hex.SECTION_ROWS; row++) for (let col = 0; col < Hex.SECTION_COLS; col++) {
    const a = Hex.fromOffset(col, row);
    const o = Hex.toOffset(a.q, a.r);
    if (o.col !== col || o.row !== row) trip = false;
    if (Hex.inSectionBounds(a.q, a.r)) box++;
  }
  check('odd-r offset <-> axial round trip over the 13 x 11 box; 143 cells in bounds', trip && box === 143);
  const p = Hex.parseTileId(Hex.tileId(1, 3, -1));
  check('tile id "1:3,-1" round trips', Hex.tileId(1, 3, -1) === '1:3,-1' && p.section === 1 && p.q === 3 && p.r === -1);
}

// =============================================================================
console.log('=== grounds, relief, regions ===');
{
  const ids = Object.keys(GROUNDS);
  check('15 grounds (TERRAIN_TYPES)', ids.length === 15, ids.join(' '));
  const impassable = ids.filter(g => !GROUNDS[g].passable);
  check('impassable: exactly cliff and water', same(impassable.sort(), ['cliff', 'water']));
  const costsOk = ids.filter(g => GROUNDS[g].passable).every(g => {
    const c = tileCosts({ ground: g, relief: 'flat' });
    return c.supply >= 1 && c.supply <= 4 && c.time >= 1 && c.time <= 4;
  });
  check('every passable ground costs 1-4 in supplies and in time', costsOk);
  check('relief adds 0 / +1 / +2 and hills+highland block sight with +1 range',
    tileCosts({ ground: 'grass', relief: 'hills' }).time === 2 && tileCosts({ ground: 'grass', relief: 'highland' }).supply === 3
    && RELIEF.hills.blocksSight && RELIEF.highland.blocksSight && RELIEF.hills.sightBonus === 1 && !RELIEF.flat.blocksSight);
  check('a ford makes water passable at its own cost', isPassable({ ground: 'water', relief: 'flat', ford: true })
    && !isPassable({ ground: 'water', relief: 'flat' }) && tileCosts({ ground: 'water', relief: 'flat', ford: true }).time === FORD.cost);
  check('blight: hides nothing (low), costs more supplies, corrupts, forages nothing',
    GROUNDS.blight.concealment <= 20 && tileCosts({ ground: 'blight', relief: 'flat' }).supply === 3 && GROUNDS.blight.corrupts && GROUNDS.blight.forage === 'none');
  const allNatives = new Set(ZONE_IDS.flatMap(z => Object.keys(ZONES[z].natives)));
  check('every family a ground favours is native somewhere', ids.every(g => GROUNDS[g].families.every(f => allNatives.has(f))));
  for (const z of ZONE_IDS) {
    const zone = ZONES[z];
    // Event templates live in data/events.js since chunk 11a; the shrine is a set piece there.
    check(`${zone.name}: palette of real grounds, no blight; relief of real relief; apex (and its escort) real hunt families; shrine is a real event; house ${zone.divineAlignment}`,
      Object.keys(zone.palette).every(g => GROUNDS[g] && g !== 'blight') && Object.values(zone.palette).some(w => w > 0)
      && Object.keys(zone.relief).every(r => RELIEF[r])
      // 14a: the apex may be apex-only (the Reeds' Vowback Crocodile), not a native.
      && !!HUNT_BEASTS[zone.apex.family] && (zone.apex.escort || []).every(e => !!HUNT_BEASTS[e.family])
      && !!EVENT_TEMPLATES[zone.setPieces.shrine]?.appears?.setPiece && !!zone.divineAlignment);
  }
}

// =============================================================================
console.log('=== every placement need is implemented ===');
{
  const { missing, extra } = unhandledNeeds();
  check('every PLACEMENT_NEEDS key has a handler', missing.length === 0, missing.join(', '));
  check('no handler outside PLACEMENT_NEEDS', extra.length === 0, extra.join(', '));
  check('every handler places and checks', Object.values(NEED_HANDLERS).every(h => typeof h.place === 'function' && typeof h.check === 'function'));
  const used = new Set([...Object.values(PRIMARY_OBJECTIVES).flatMap(o => o.needs), ...Object.values(BONUS_OBJECTIVES).flatMap(o => o.placement.needs)]);
  check('every need an objective declares is listed', [...used].every(n => PLACEMENT_NEEDS[n]));
  check('every listed need is used by some objective', Object.keys(PLACEMENT_NEEDS).every(n => used.has(n)));
  check('every primary objective has params for all three sizes', PRIMARIES.every(p => SIZES.every(s => PRIMARY_OBJECTIVES[p].params[s])));
  console.log(`    ${Object.keys(PLACEMENT_NEEDS).length} needs: ${Object.keys(PLACEMENT_NEEDS).join(', ')}`);
}

// =============================================================================
// An independent walk of a finished map: HexGrid neighbours inside a section,
// the passage pairs across, grounds' isPassable. Deliberately not the
// generator's reachableFrom.
function walk(map) {
  const seen = new Set([map.entry]);
  const queue = [map.entry];
  while (queue.length) {
    const id = queue.shift();
    const { section, q, r } = Hex.parseTileId(id);
    const next = Hex.neighbors(q, r).map(n => Hex.tileId(section, n.q, n.r));
    for (const p of map.passages) { if (p.a === id) next.push(p.b); if (p.b === id) next.push(p.a); }
    for (const n of next) {
      if (seen.has(n) || !map.tiles[n] || !isPassable(map.tiles[n])) continue;
      seen.add(n); queue.push(n);
    }
  }
  return seen;
}

function objectiveProblems(map) {
  const reach = walk(map);
  const out = [];
  const zone = ZONES[map.zoneId];
  const occ = (id) => map.occupants.find(o => o.id === id);
  const beasts = map.occupants.filter(o => o.kind === 'beast' && reach.has(o.tile));
  const famCount = (f) => beasts.filter(o => o.family === f).reduce((n, o) => n + o.roster.length, 0);
  const hasGrade = (gs) => beasts.some(o => o.roster.some(m => gs.includes(m.grade)));
  for (const o of [map.objectives.primary, ...map.objectives.bonus]) {
    const bad = (why) => out.push(`${o.id}: ${why}`);
    switch (o.id) {
      case 'scout': {
        const sites = map.features.filter(f => f.kind === 'scout_site' && reach.has(f.tile));
        if (sites.length < o.params.sites) bad(`${sites.length} of ${o.params.sites} sites`);
        break;
      }
      case 'apex': {
        const a = occ(o.occupant);
        if (!a || !a.apex || a.family !== zone.apex.family || !reach.has(a.tile) || a.roster[0].grade !== 'great' || a.state !== 'rooted') bad('apex missing or wrong');
        break;
      }
      case 'cull': case 'named_quarry':
        if (!zone.natives[o.family] || famCount(o.family) < o.params.count) bad(`${famCount(o.family)} ${o.family}`);
        break;
      case 'retrieve':
        if (!map.features.some(f => f.kind === 'retrieve_site' && reach.has(f.tile)) || !map.exits.some(e => reach.has(e))) bad('site or exit');
        break;
      case 'commune':
        if (!map.features.some(f => f.kind === 'shrine' && f.eventId === zone.setPieces.shrine && reach.has(f.tile))) bad('shrine');
        break;
      case 'pathfinder':
        if (revealableShare(map) * 100 < o.params.revealPct) bad(`reveal ${pct(revealableShare(map), 1)}%`);
        break;
      case 'provisioner':
        if (yieldingSpots(map) < o.params.count) bad(`${yieldingSpots(map)} spots`);
        break;
      case 'trophy':
        if (!hasGrade(['prime', 'great'])) bad('no Prime+');
        break;
      case 'great_quarry':
        if (!hasGrade(['great'])) bad('no Great');
        break;
      case 'unmask':
        // A cult band (it never moves) hidden past 100 but within the cap a
        // party can reach (owner, chunk 8): UNMASK_MAX_CONCEALMENT.
        if (!map.occupants.some(x => reach.has(x.tile) && x.kind === 'cultist'
            && occupantConcealment(map, x) > 100 && occupantConcealment(map, x) <= UNMASK_MAX_CONCEALMENT)) bad('no cult band hidden in 101-' + UNMASK_MAX_CONCEALMENT);
        break;
      case 'cleanse':
        if (![...reach].some(id => map.tiles[id].ground === 'blight')) bad('no reachable blight');
        break;
      case 'swift_return': {
        const t = objectiveRouteTime(map);
        if (!Number.isFinite(t) || o.beforeDay !== swiftDeadline(t, o.params) || o.beforeDay < o.params.beforeDay) bad(`route ${t}, day ${o.beforeDay}`);
        break;
      }
      case 'unbroken': break;
      default: bad('unknown objective');
    }
  }
  return { reach, problems: out };
}

// =============================================================================
console.log(`=== ${SEEDS} seeds per starter region and size: valid, reachable, completable ===`);
const stats = {};
const hash = crypto.createHash('sha256');
const samples = {};
{
  const t0 = Date.now();
  for (const zoneId of ZONE_IDS) for (const size of SIZES) {
    const key = `${zoneId}/${size}`;
    const mk = () => ({
      maps: 0, invalid: 0, unreachable: 0, incompletable: 0, nondeterministic: 0, retried: 0, maxAttempt: 0,
      twoSections: 0, grounds: {}, relief: {}, fords: 0, hostiles: 0, cultists: 0, events: 0, spots: 0, barren: 0,
      waystones: 0, marks: {}, grades: {}, compositions: {}, deadlines: [], pocketTiles: 0, blightTiles: 0,
    });
    // Measured separately: seeds with no plan modifiers, and seeds carrying
    // every demand prefix at its T1 maximum. The pass/fail totals are both.
    const byMods = { plain: stats[`${key}/plain`] = mk(), demands: stats[`${key}/T1 demands`] = mk() };
    const tot = { maps: 0, invalid: 0, unreachable: 0, incompletable: 0, nondeterministic: 0, retried: 0, maxAttempt: 0 };
    let firstBad = null;
    for (let seed = 0; seed < SEEDS; seed++) {
      const objective = PRIMARIES[seed % PRIMARIES.length];
      const bonusObjectives = PAIRS[Math.floor(seed / PRIMARIES.length) % PAIRS.length];
      const mods = seed % 2 ? MAX_DEMANDS : {};
      const input = { zoneId, objective, size, seed: 1000 + seed, bonusObjectives, mods };
      const s = seed % 2 ? byMods.demands : byMods.plain;
      let map;
      try { map = generateHuntMap(input); } catch (e) { s.invalid++; tot.invalid++; firstBad = firstBad || `seed ${1000 + seed}: ${e.message}`; continue; }
      s.maps++; tot.maps++;
      hash.update(JSON.stringify(map));
      if (seed < 1) samples[key] = map;
      const v = validateHuntMap(map);
      if (!v.ok) { s.invalid++; tot.invalid++; firstBad = firstBad || `seed ${1000 + seed}: ${v.problems.join('; ')}`; }
      const { reach, problems } = objectiveProblems(map);
      const things = [...map.features, ...map.occupants].map(x => x.tile);
      if (!things.every(t => reach.has(t)) || !map.passages.every(p => reach.has(p.a) && reach.has(p.b))) { s.unreachable++; tot.unreachable++; }
      if (problems.length) { s.incompletable++; tot.incompletable++; firstBad = firstBad || `seed ${1000 + seed}: ${problems.join('; ')}`; }
      if (seed % 5 === 0 && JSON.stringify(generateHuntMap(input)) !== JSON.stringify(map)) { s.nondeterministic++; tot.nondeterministic++; }
      if (map.attempt > 0) { s.retried++; tot.retried++; }
      s.maxAttempt = Math.max(s.maxAttempt, map.attempt);
      tot.maxAttempt = Math.max(tot.maxAttempt, map.attempt);
      if (map.sections.length === 2) s.twoSections++;
      for (const [id, t] of Object.entries(map.tiles)) {
        s.grounds[t.ground] = (s.grounds[t.ground] || 0) + 1;
        s.relief[t.relief] = (s.relief[t.relief] || 0) + 1;
        if (t.ford) s.fords++;
        if (t.barren) s.barren++;
        if (t.ground === 'blight') s.blightTiles++;
        if (isPassable(t) && !reach.has(id)) s.pocketTiles++;
      }
      s.spots += map.forage.spots;
      for (const o of map.occupants) {
        if (o.kind === 'event') { s.events++; continue; }
        s.hostiles++;
        if (o.kind === 'cultist') { s.cultists++; continue; }
        s.marks[o.mark] = (s.marks[o.mark] || 0) + 1;
        s.compositions[o.composition] = (s.compositions[o.composition] || 0) + 1;
        for (const m of o.roster) s.grades[m.grade] = (s.grades[m.grade] || 0) + 1;
      }
      s.waystones += map.features.filter(f => f.kind === 'waystone').length;
      const sw = map.objectives.bonus.find(o => o.id === 'swift_return');
      if (sw) s.deadlines.push(sw.beforeDay);
    }
    const ok = tot.invalid === 0 && tot.unreachable === 0 && tot.incompletable === 0 && tot.nondeterministic === 0;
    check(`${key}: ${tot.maps} maps valid, all reachable, all objectives completable, deterministic`, ok && tot.maps === SEEDS,
      ok ? `re-rolled ${tot.retried} (max attempt ${tot.maxAttempt})` : firstBad);
  }
  console.log(`    ${ZONE_IDS.length * SIZES.length * SEEDS} maps in ${Date.now() - t0} ms`);
}

// =============================================================================
console.log('=== measured, per region and size (seed -> map golden) ===');
const measured = {};
for (const [key, s] of Object.entries(stats)) {
  const tiles = Object.values(s.grounds).reduce((a, b) => a + b, 0);
  const beasts = Object.values(s.compositions).reduce((a, b) => a + b, 0);
  const members = Object.values(s.grades).reduce((a, b) => a + b, 0);
  const d = [...s.deadlines].sort((a, b) => a - b);
  const m = measured[key] = {
    groundsPct: Object.fromEntries(Object.entries(s.grounds).sort().map(([g, n]) => [g, pct(n, tiles)])),
    reliefPct: Object.fromEntries(Object.entries(s.relief).sort().map(([g, n]) => [g, pct(n, tiles)])),
    twoSectionPct: pct(s.twoSections, s.maps),
    fordsPerMap: round(s.fords / s.maps),
    blightPct: pct(s.blightTiles, tiles),
    unreachablePocketPct: pct(s.pocketTiles, tiles),
    hostilesPerMap: round(s.hostiles / s.maps),
    cultistPct: pct(s.cultists, s.hostiles),
    eventSitesPerMap: round(s.events / s.maps),
    forageSpotsPerMap: round(s.spots / s.maps),
    barrenPerMap: round(s.barren / s.maps),
    marksPct: Object.fromEntries(Object.entries(s.marks).sort().map(([k, n]) => [k, pct(n, beasts)])),
    compositionsPct: Object.fromEntries(Object.entries(s.compositions).sort().map(([k, n]) => [k, pct(n, beasts)])),
    gradesPct: Object.fromEntries(GRADES.map(g => [g, pct(s.grades[g] || 0, members)])),
    waystonesPer100: round(100 * s.waystones / s.maps, 1),
    swiftDeadlineDay: d.length ? { min: d[0], median: d[d.length >> 1], max: d.at(-1) } : null,
    retriedPct: pct(s.retried, s.maps),
  };
  console.log(`  ${key}`);
  console.log(`    grounds % ${JSON.stringify(m.groundsPct)}  relief % ${JSON.stringify(m.reliefPct)}`);
  console.log(`    fights/map ${m.hostilesPerMap} (cultists ${m.cultistPct}%)  events/map ${m.eventSitesPerMap}  forage spots/map ${m.forageSpotsPerMap} (barren ${m.barrenPerMap})  fords/map ${m.fordsPerMap}  blight ${m.blightPct}%  cut-off land ${m.unreachablePocketPct}%`);
  console.log(`    marks % ${JSON.stringify(m.marksPct)}  grades % ${JSON.stringify(m.gradesPct)}`);
  console.log(`    compositions % ${JSON.stringify(m.compositionsPct)}  two sections ${m.twoSectionPct}%  waystones/100 maps ${m.waystonesPer100}  Swift Return deadline day ${JSON.stringify(m.swiftDeadlineDay)}  re-rolled ${m.retriedPct}%`);
}
golden.measured = measured;
golden.mapsHash = hash.digest('hex');
console.log(`    sha256 of all maps: ${golden.mapsHash}`);

// =============================================================================
console.log('=== pack size follows the danger (chunk 13c) ===');
{
  // Every Pack, every Alpha's followers and every Cull quarry pack on real
  // maps sits inside its region's PACK_SIZE_BY_DANGER band, inside
  // ENCOUNTERS' 4-8.
  const { PACK_SIZE_BY_DANGER } = await import('../../data/huntMapGen.js');
  let packs = 0, alphas = 0, culls = 0;
  const bad = [];
  for (const zoneId of Object.keys(ZONES).filter(id => ZONES[id].palette)) {
    const band = PACK_SIZE_BY_DANGER.find(b => (ZONES[zoneId].danger || 1) <= b.maxDanger);
    for (let k = 0; k < 100; k++) for (const objective of ['cull', 'scout', 'apex']) {
      const m = Gen.generateHuntMap({ zoneId, objective, size: ['small', 'medium', 'large'][k % 3], seed: 31000 + k });
      const cullFamily = m.objectives.primary.id === 'cull' ? m.objectives.primary.family : null;
      for (const o of m.occupants) {
        if (o.composition === 'pack') {
          packs++; if (o.family === cullFamily) culls++;
          if (o.roster.length < band.pack[0] || o.roster.length > band.pack[1]) bad.push(`${zoneId} ${o.id} pack of ${o.roster.length}`);
        } else if (o.composition === 'alpha') {
          alphas++;
          const f = o.roster.length - 1;
          if (f < band.alphaFollowers[0] || f > band.alphaFollowers[1]) bad.push(`${zoneId} ${o.id} alpha with ${f}`);
        }
      }
    }
  }
  check('every pack, alpha and Cull quarry pack is within its danger band (4-8 overall)',
    !bad.length && packs > 0 && alphas > 0 && culls > 0 && PACK_SIZE_BY_DANGER.every(b => b.pack[0] >= 4 && b.pack[1] <= 8),
    bad.length ? bad.slice(0, 5).join('; ') : `${packs} packs (${culls} Cull quarry), ${alphas} alphas on 600 maps`);
}

console.log('=== the Reeds roster: shapes, the apex brood, cult bands (chunk 14a) ===');
{
  const { CULT_BANDS } = await import('../../data/beastParts.js');
  const reeds = ZONES.reeds_of_gethsemane;
  let turtles = 0, turtleBad = [], cullBad = [], apexOk = 0, apexN = 0, bands = 0, bandBad = [];
  for (let k = 0; k < 60; k++) for (const objective of ['cull', 'apex', 'scout']) {
    const m = Gen.generateHuntMap({ zoneId: 'reeds_of_gethsemane', objective, size: ['small', 'medium', 'large'][k % 3], seed: 32000 + k });
    for (const o of m.occupants) {
      if (o.family === 'snapping_turtle') { turtles++; if (!(reeds.natives.snapping_turtle.compositions || []).includes(o.composition)) turtleBad.push(`${o.composition}`); }
      if (o.kind === 'cultist') { bands++; if (o.cult !== reeds.falseGod || !CULT_BANDS[o.cult]) bandBad.push(String(o.cult)); }
    }
    if (objective === 'cull' && m.objectives.primary.family === 'snapping_turtle') cullBad.push(32000 + k);
    if (objective === 'apex') {
      apexN++;
      const ap = m.occupants.find(o => o.apex);
      const esc = reeds.apex.escort[0];
      if (ap && ap.family === reeds.apex.family && ap.roster[0].grade === 'great' && ap.roster[0].type === reeds.apex.family
        && ap.roster.length === 1 + esc.count && ap.roster.slice(1).every(r => r.type === esc.family && r.grade === esc.grade)) apexOk++;
    }
  }
  check('Snapping Turtles only alone or with young, never a Cull quarry (natives compositions)', turtles > 0 && !turtleBad.length && !cullBad.length,
    `${turtles} turtle occupants${turtleBad.length ? '; bad: ' + turtleBad.slice(0, 3) : ''}${cullBad.length ? '; culls: ' + cullBad.slice(0, 3) : ''}`);
  check('the Vowback Crocodile is always Great, with its brood of Grown Crocodiles (apex escort)', apexOk === apexN, `${apexOk}/${apexN}`);
  check("every Reeds cult band serves the region's false god and has a cult (CULT_BANDS)", bands > 0 && !bandBad.length, `${bands} bands`);
}

console.log('=== the demand prefixes move the map (paired seeds, real generator) ===');
{
  const N = 200;
  const run = (mods, fn, extra = {}) => {
    let total = 0;
    for (let i = 0; i < N; i++) {
      for (const zoneId of ZONE_IDS) {
        total += fn(generateHuntMap({ zoneId, objective: 'scout', size: 'medium', seed: 50000 + i, mods, ...extra }));
      }
    }
    return total / (N * ZONE_IDS.length);
  };
  const hostiles = m => m.occupants.filter(o => o.kind !== 'event').length;
  const bigGrades = m => {
    const all = m.occupants.filter(o => o.kind === 'beast').flatMap(o => o.roster);
    return all.filter(x => x.grade === 'prime' || x.grade === 'great').length / Math.max(1, all.length);
  };
  const blight = m => Object.values(m.tiles).filter(t => t.ground === 'blight').length;
  const e0 = run({}, hostiles), e1 = run({ encounterChancePercent: 20 }, hostiles);
  check('Teeming 20%: more fights per map', e1 > e0, `${round(e0)} -> ${round(e1)}`);
  const g0 = run({}, bigGrades), g1 = run({ gradeShiftPercent: 30 }, bigGrades);
  check('Elder Grounds 30%: more Prime and Great', g1 > g0, `${pct(g0, 1)}% -> ${pct(g1, 1)}%`);
  const w = shiftGrades({ yearling: 40, grown: 45, prime: 13, great: 2 }, 30);
  check('...the shift keeps the total weight', round(w.yearling + w.grown + w.prime + w.great) === 100);
  const f0 = run({}, m => yieldingSpots(m)), f1 = run({ leanCountryPercent: 50 }, m => yieldingSpots(m));
  check('Lean Country 50%: fewer forage spots', f1 < f0, `${round(f0)} -> ${round(f1)}`);
  const fp = run({ leanCountryPercent: 50 }, m => yieldingSpots(m), { bonusObjectives: ['provisioner'] });
  check('...but never under Provisioner\'s floor of 6', fp >= f1, `with Provisioner ${round(fp)}`);
  const b0 = run({}, blight), b1 = run({ blightPatches: 3 }, blight);
  check('Blighted 3: blight appears, none without it', b0 === 0 && b1 > 0, `${round(b0)} -> ${round(b1)} tiles`);
  golden.prefixEffects = { teeming: [round(e0), round(e1)], elder: [pct(g0, 1), pct(g1, 1)], lean: [round(f0), round(f1)], blight: [round(b0), round(b1)] };
}

// =============================================================================
console.log('=== real plans feed the generator ===');
{
  const basic = planMapInputs(huntPlanView(makeBasicPlan()));
  const m = generateHuntMap({ zoneId: 'reeds_of_gethsemane', seed: 1, ...basic });
  check('the basic plan: Scout, Small, no bonus, no modifiers -> a 37-tile map with 2 scout sites',
    basic.objective === 'scout' && basic.size === 'small' && basic.bonusObjectives.length === 0
    && Object.keys(m.tiles).length === 37 && m.features.filter(f => f.kind === 'scout_site').length === 2);
  let n = 0, bad = 0;
  const rng = makeRng(21);
  // Chunk 8c: every sold plan is a base type carrying its objective and size,
  // so the plan alone decides the map (no override).
  const { PLAN_BASE_IDS } = await import('../../src/systems/HuntPlans.js');
  let wrongShape = 0;
  for (let i = 0; i < 300; i++) {
    const inst = createItemInstance(PLAN_BASE_IDS[i % PLAN_BASE_IDS.length], { rarity: 'epic', itemLevel: 1 + (i % 10), rng });
    const inp = planMapInputs(huntPlanView(inst));
    const map = generateHuntMap({ zoneId: ZONE_IDS[i % 2], seed: i, ...inp });
    n++;
    if (map.objective !== inp.objective || map.size !== inp.size || Object.keys(map.tiles).length !== MAP_SIZES[inp.size].tiles) wrongShape++;
    if (!validateHuntMap(map).ok || objectiveProblems(map).problems.length) bad++;
  }
  check('300 rolled epic plans of all 15 base types, item levels 1-10: each map has its base objective and size, and is completable',
    bad === 0 && wrongShape === 0, `${n} maps, ${wrongShape} wrong shape`);
}

// =============================================================================
console.log('=== seed -> map, drawn ===');
// Two characters a cell: ground, then what is on it. Odd rows sit half a hex
// right (odd-r). Ground: g grass, h heath, s shingle, d dunes, w woodland,
// t thicket, m marsh, b bog, x blight, ~ water, = ford. On it: E entry,
// P passage, B beast (A apex), K cultists, V event, S scout site, R retrieve,
// H shrine, W waystone, X blight source.
const GROUND_CH = { grass: 'g', heath: 'h', shingle: 's', hardpan: 'p', dunes: 'd', snowfield: 'n', woodland: 'w',
  rainforest: 'r', thicket: 't', marsh: 'm', bog: 'b', scree: 'c', blight: 'x', cliff: '#', water: '~' };
const THING_CH = { scout_site: 'S', retrieve_site: 'R', shrine: 'H', waystone: 'W', blight_source: 'X' };
function draw(map) {
  const on = new Map();
  for (const f of map.features) on.set(f.tile, THING_CH[f.kind] || '?');
  for (const o of map.occupants) on.set(o.tile, o.kind === 'event' ? 'V' : o.kind === 'cultist' ? 'K' : o.apex ? 'A' : 'B');
  for (const p of map.passages) { on.set(p.a, 'P'); on.set(p.b, 'P'); }
  on.set(map.entry, 'E');
  const lines = [];
  for (const sec of map.sections) {
    lines.push(`section ${sec.index}`);
    for (let row = 0; row < Hex.SECTION_ROWS; row++) {
      let line = row & 1 ? ' ' : '';
      for (let col = 0; col < Hex.SECTION_COLS; col++) {
        const { q, r } = Hex.fromOffset(col, row);
        const id = Hex.tileId(sec.index, q, r);
        const t = map.tiles[id];
        line += t ? (t.ford ? '=' : GROUND_CH[t.ground]) + (on.get(id) || (t.relief === 'hills' ? '^' : t.relief === 'highland' ? 'A' : ' ')) : '  ';
      }
      lines.push(line.replace(/\s+$/, ''));
    }
  }
  return lines;
}
golden.samples = {};
for (const [key, map] of Object.entries(samples)) {
  const d = draw(map);
  console.log(`  ${key}, seed ${map.seed}, ${map.objective} + ${map.bonusObjectives.join(' + ')}`);
  for (const l of d) console.log('    ' + l);
  golden.samples[key] = {
    seed: map.seed, objective: map.objective, bonus: map.bonusObjectives, drawn: d,
    occupants: map.occupants.map(o => o.kind === 'event' ? `${o.tile} event ${o.eventId}`
      : o.kind === 'cultist' ? `${o.tile} cultists x${o.roster.length}${o.ambush ? ' ambush' : ''}`
      : `${o.tile} ${o.mark} ${o.family} ${COMPOSITIONS[o.composition].name}: ${o.roster.map(m => m.grade).join(',')} (${o.state}, concealment ${occupantConcealment(map, o)})`),
    objectives: [map.objectives.primary, ...map.objectives.bonus].map(o => ({ ...o })),
  };
}

// =============================================================================
const args = process.argv.slice(2);
const jsonAt = args.indexOf('--json');
const diffAt = args.indexOf('--diff');
if (jsonAt >= 0) {
  fs.writeFileSync(args[jsonAt + 1], JSON.stringify(golden, null, 1) + '\n');
  console.log(`golden written -> ${args[jsonAt + 1]}`);
}
if (diffAt >= 0) {
  console.log('=== golden diff ===');
  const old = JSON.parse(fs.readFileSync(args[diffAt + 1], 'utf8'));
  const keys = new Set([...Object.keys(old), ...Object.keys(golden)]);
  const changed = [...keys].filter(k => !same(old[k], golden[k]));
  check('maps identical to the golden', changed.length === 0, changed.length ? `changed: ${changed.join(', ')}` : '');
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
