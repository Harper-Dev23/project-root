// tools/headless/huntrules.mjs
//
// The hunt rules engine (Exploration System v2, chunk 7). Drives the REAL
// HuntEngine (createMapHunt / restoreMapHunt) on REAL generated maps with the
// REAL fixture party, and checks the rules through the real exports of
// HuntRules.js. No rule or formula is re-derived here: where a number is
// compared, both sides come from the game's own functions.
//
// Chunk 7 lands in four steps (7a-7d); this file covers all four.
//
// What it proves (7a):
//   - rules on hand-built maps: Detection's three bands at their edges, the
//     clock's phase boundaries, the move-cost floor, Sight blocking / relief /
//     Far Sight's range / ignores
//   - scripted walks, 2 zones x 3 sizes x 25 seeds, every step checked:
//       supplies never negative and never rise; a move never costs under the
//       floor; time only moves forward; night and day alternate through the
//       world; the party's tile is always visible;
//       FOG NEVER UN-REVEALS; every sighting on a visible tile is the band
//       Detection gives it now; nothing undetected is shown
//   - running out of supplies does not stop the party moving
//   - save -> reload at any step continues identically (state and stream)
//   - two hunts interleaved behave exactly as each alone
//   - the hunt's stats ARE partyStats(party, the hunt's bundle), plan-only
//     fields included; a dead hunter stops counting at once
//   - Far Sight widens sight; Naturalist shows the exact roster; scout
//     resolves sensed to identified, costs time only, and refuses what it must
//   - the golden: a hash of every scripted walk, three walks in full, and the
//     statistics (moves per day, reveal, first-sight Detection bands)
//
// USAGE
//   node tools/headless/huntrules.mjs                  run the checks
//   node tools/headless/huntrules.mjs --json out.json  also write the golden
//   node tools/headless/huntrules.mjs --diff old.json  also compare against one

import fs from 'node:fs';
import crypto from 'node:crypto';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const r4 = (x) => +(+x).toFixed(4);
const EPS = 1e-9;

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
installPhaserStub(9);

const { makeParty } = await import('./fixtures.js');
const { createMapHunt, restoreMapHunt } = await import('../../src/systems/HuntEngine.js');
const R = await import('../../src/systems/HuntRules.js');
const { partyStats } = await import('../../src/systems/PartyStats.js');
const { mapNeighbors } = await import('../../src/systems/HuntMapGen.js');
const { tileCosts, isPassable, GROUNDS } = await import('../../data/grounds.js');
const { tileId } = await import('../../src/systems/HexGrid.js');
const { makeRng } = await import('../../src/systems/seededRng.js');
const { getZone } = await import('../../data/zones.js');

const golden = {};
const ZONES = ['reeds_of_gethsemane', 'bay_of_solace'];
const SIZES = ['small', 'medium', 'large'];
const SEEDS = 25;
const STEPS = 60;

/** A pending encounter is won (the combat hookup's seam), so a scripted walk
 *  can carry on. Walks that test fleeing do it themselves. */
function settle(h) {
  if (h.encounter()) h.winEncounter();
}

function recordingWorld(party) {
  const calls = [];
  return { calls, party: () => party, nightFalls: () => calls.push('night'), dayBreaks: () => calls.push('day') };
}

// =============================================================================
console.log('=== rules on hand-built inputs ===');
{
  const P = 50;
  check('Detection: at the concealment -> identified', R.detectionBand(P, P) === 'identified');
  check(`Detection: ${R.SENSED_MARGIN} below -> sensed`, R.detectionBand(P, P + R.SENSED_MARGIN) === 'sensed');
  check(`Detection: ${R.SENSED_MARGIN + 1} below -> nothing`, R.detectionBand(P, P + R.SENSED_MARGIN + 1) === 'nothing');
  golden.constants = {
    BASE_SIGHT_RANGE: R.BASE_SIGHT_RANGE, SENSED_MARGIN: R.SENSED_MARGIN,
    MIN_MOVE_COST_SHARE: R.MIN_MOVE_COST_SHARE, PHASE_UNITS: R.PHASE_UNITS, SCOUT_TIME: R.SCOUT_TIME,
  };

  const clocks = [0, 5.999, 6, 11.9, 12, 18, 24].map(t => ({ t, ...R.clockAt(t) }));
  check('clock: day 1 until 6, night 6-12, day 2 at 12, night at 18, day 3 at 24',
    same(clocks.map(c => [c.day, c.isNight]), [[1, false], [1, false], [1, true], [1, true], [2, false], [2, true], [3, false]]));
  golden.clock = clocks;

  const noEff = { supplyEfficiencyPercent: 0, travelTimePercent: 0 };
  const huge = { supplyEfficiencyPercent: 500, travelTimePercent: 500 };
  const bog = R.moveCost({ ground: 'bog', relief: 'flat' }, noEff);
  check('cost: bog with no efficiency = its authored cost', bog.supply === 4 && bog.time === 4);
  const floor = R.moveCost({ ground: 'grass', relief: 'hills' }, huge);
  check('cost: huge efficiency stops at the floor share, never free',
    Math.abs(floor.supply - 2 * R.MIN_MOVE_COST_SHARE) < EPS && Math.abs(floor.time - 2 * R.MIN_MOVE_COST_SHARE) < EPS);
  check('cost: water cannot be entered; a ford can', R.moveCost({ ground: 'water' }, noEff) === null
    && R.moveCost({ ground: 'water', ford: true }, noEff)?.supply === tileCosts({ ground: 'water', ford: true }).supply);
  const neg = R.moveCost({ ground: 'grass', relief: 'flat' }, { supplyEfficiencyPercent: -20, travelTimePercent: 0 });
  check('cost: negative efficiency (a harsh zone) costs more', Math.abs(neg.supply - 1.2) < EPS);

  // Sight on a 7 x 5 block of grass. The party stands at (1,2).
  const mk = (over = {}) => {
    const tiles = {};
    for (let r = 0; r < 5; r++) for (let q = -2; q < 7; q++) tiles[tileId(0, q, r)] = { ground: 'grass', relief: 'flat' };
    for (const [id, t] of Object.entries(over)) tiles[id] = { ...tiles[id], ...t };
    return { tiles, passages: [] };
  };
  const from = tileId(0, 1, 2), mid = tileId(0, 2, 2), far = tileId(0, 3, 2), farther = tileId(0, 4, 2);
  const vis = (map, opts) => new Set(R.visibleTiles(map, from, opts));
  const open = mk();
  check('sight: base range reaches 2 steps, not 3',
    vis(open, { range: R.sightRange(open, from) }).has(far) && !vis(open, { range: R.sightRange(open, from) }).has(farther));
  const wood = mk({ [mid]: { ground: 'woodland' } });
  const vw = vis(wood, { range: 2 });
  check('sight: a woodland is seen but hides the tile behind it', vw.has(mid) && !vw.has(far));
  check('sight: sightIgnores lets it through', vis(wood, { range: 2, ignores: ['woodland'] }).has(far));
  const hill = mk({ [mid]: { relief: 'hills' } });
  check('sight: hills block past them', !vis(hill, { range: 2 }).has(far));
  const onHill = mk({ [from]: { relief: 'hills' }, [mid]: { ground: 'thicket' } });
  check('sight: standing on hills gives +1 range; the party\'s own tile never blocks',
    R.sightRange(onHill, from) === R.BASE_SIGHT_RANGE + 1 && vis(mk({ [from]: { ground: 'thicket' } }), { range: 2 }).has(far));
  check('sight: Far Sight\'s +1 reaches 3 steps', vis(open, { range: R.sightRange(open, from, 1) }).has(farther));
  const pass = mk();
  pass.tiles[tileId(1, 0, 0)] = { ground: 'grass', relief: 'flat' };
  pass.tiles[tileId(1, 1, 0)] = { ground: 'grass', relief: 'flat' };
  pass.passages = [{ a: from, b: tileId(1, 0, 0) }];
  const vp = vis(pass, { range: 2 });
  check('sight: across a passage only its partner tile is seen', vp.has(tileId(1, 0, 0)) && !vp.has(tileId(1, 1, 0)));
}

// =============================================================================
console.log('=== scripted walks: invariants at every step ===');

/**
 * A scripted walk: at each step, the first passable neighbour not yet stood
 * on in a harness-seeded shuffle, else any passable neighbour. The shuffle is
 * the harness's own stream; the hunt's rules decide everything else.
 */
function chooseMove(hunt, pick, stood) {
  const st = hunt.getState();
  const opts = mapNeighbors(st.map, st.pos).filter(n => isPassable(st.map.tiles[n]));
  const order = [...opts].sort((a, b) => (a < b ? -1 : 1));
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(pick() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  return order.find(n => !stood.has(n)) ?? order[0];
}

function walk({ zoneId, size, seed, supplies = 60, steps = STEPS, planMods = {}, party = makeParty(), onStep = null }) {
  const world = recordingWorld(party);
  const plan = { objective: 'scout', size, mods: planMods };
  let hunt = createMapHunt(zoneId, { plan, supplies, seed }, world);
  const pick = makeRng(seed ^ 0x5eed);
  const stood = new Set([hunt.getState().pos]);
  const trace = [];
  const problems = [];
  let prev = hunt.getState();
  let seen = new Set(Object.keys(prev.fog));
  const firstBands = {};
  for (const [id, sg] of Object.entries(prev.sightings)) firstBands[id] = sg.band;
  let charged = 0, movedAtZero = 0, contacts = { identified: 0, sensed: 0, nothing: 0 };
  for (let i = 0; i < steps; i++) {
    if (onStep) hunt = onStep(hunt, i, world) || hunt;
    const to = chooseMove(hunt, pick, stood);
    const before = hunt.getState();
    const res = hunt.move(to);
    if (res.ok) settle(hunt);
    if (!res.ok) { problems.push(`step ${i}: move refused: ${res.reason}`); break; }
    stood.add(to);
    charged += res.supply;
    const s = hunt.getState();
    const st = hunt.stats();
    const expected = R.moveCost(s.map.tiles[to], st);
    if (before.supplies <= EPS) movedAtZero++;
    if (res.contact) contacts[res.contact.knew]++;
    // --- invariants ---
    if (s.supplies < 0) problems.push(`step ${i}: supplies negative (${s.supplies})`);
    if (s.supplies > before.supplies + EPS) problems.push(`step ${i}: supplies rose`);
    if (Math.abs(res.supply - expected.supply) > EPS || Math.abs(res.time - expected.time) > EPS) problems.push(`step ${i}: charged ${res.supply}/${res.time}, moveCost says ${expected.supply}/${expected.time}`);
    const base = tileCosts(s.map.tiles[to]);
    if (res.supply < base.supply * R.MIN_MOVE_COST_SHARE - EPS || res.time < base.time * R.MIN_MOVE_COST_SHARE - EPS) problems.push(`step ${i}: under the floor`);
    if (!(s.time > before.time)) problems.push(`step ${i}: time did not advance`);
    if (s.fog[s.pos] !== 'visible') problems.push(`step ${i}: the party's own tile is not visible`);
    const nowSeen = new Set(Object.keys(s.fog));
    for (const id of seen) if (!nowSeen.has(id)) problems.push(`step ${i}: fog un-revealed ${id}`);
    for (const [id, f] of Object.entries(before.fog)) if (!s.fog[id]) problems.push(`step ${i}: ${id} went back to unseen (was ${f})`);
    seen = nowSeen;
    const range = R.sightRange(s.map, s.pos, st.passives.sightRangeBonus);
    const vis = new Set(R.visibleTiles(s.map, s.pos, { range }));
    for (const [id, f] of Object.entries(s.fog)) if ((f === 'visible') !== vis.has(id)) problems.push(`step ${i}: fog of ${id} is ${f}, Sight disagrees`);
    for (const occ of s.map.occupants) {
      if (!vis.has(occ.tile)) continue;
      const band = s.scouted.includes(occ.id) ? 'identified' : R.occupantBand(s.map, occ, st.perception);
      const have = s.sightings[occ.id]?.band || 'nothing';
      if (have !== band) problems.push(`step ${i}: ${occ.id} shows ${have}, Detection says ${band}`);
      if (!(occ.id in firstBands)) firstBands[occ.id] = band;
    }
    for (const v of hunt.view().occupants) if (v.band === 'nothing') problems.push(`step ${i}: an undetected occupant is shown`);
    trace.push([to, r4(s.supplies), r4(s.time), res.contact ? `${res.contact.id}:${res.contact.knew}` : 0, Object.keys(s.fog).length]);
    prev = s;
  }
  const flips = world.calls;
  const c = R.clockAt(prev.time);
  if (flips.length !== c.phase) problems.push(`world got ${flips.length} flips, the clock is at phase ${c.phase}`);
  if (flips.some((f, k) => f !== (k % 2 === 0 ? 'night' : 'day'))) problems.push('night and day did not alternate');
  return { hunt, trace, problems, firstBands, charged, movedAtZero, contacts, flips, final: prev };
}

const walkHashes = {};
const stats = {};
const firstBandTally = { identified: 0, sensed: 0, nothing: 0 };
let allProblems = [], totalMovedAtZero = 0, huntsRanDry = 0;
for (const zoneId of ZONES) {
  for (const size of SIZES) {
    const key = `${zoneId}/${size}`;
    const agg = { hunts: 0, moves: 0, days: 0, revealed: 0, timePerMove: 0, supplyPerMove: 0,
                  contacts: { identified: 0, sensed: 0, nothing: 0 } };
    const h = crypto.createHash('sha256');
    for (let k = 0; k < SEEDS; k++) {
      const seed = 7000 + k;
      const w = walk({ zoneId, size, seed });
      allProblems.push(...w.problems.map(p => `${key} seed ${seed}: ${p}`));
      h.update(JSON.stringify(w.trace));
      const s = w.final;
      agg.hunts++;
      agg.moves += w.trace.length;
      agg.days += R.clockAt(s.time).day;
      agg.revealed += Object.keys(s.fog).length / Object.keys(s.map.tiles).length;
      agg.timePerMove += s.time / w.trace.length;
      agg.supplyPerMove += w.charged / w.trace.length;
      for (const b of Object.keys(agg.contacts)) agg.contacts[b] += w.contacts[b];
      for (const b of Object.values(w.firstBands)) firstBandTally[b]++;
      totalMovedAtZero += w.movedAtZero;
      if (w.movedAtZero) huntsRanDry++;
      if (zoneId === ZONES[0] && k === 0) golden[`walk ${key} seed ${seed}`] = w.trace;
    }
    walkHashes[key] = h.digest('hex').slice(0, 16);
    stats[key] = {
      hunts: agg.hunts,
      movesEach: agg.moves / agg.hunts,
      daysAtEnd: r4(agg.days / agg.hunts),
      mapRevealed: r4(agg.revealed / agg.hunts),
      timePerMove: r4(agg.timePerMove / agg.hunts),
      supplyPerMove: r4(agg.supplyPerMove / agg.hunts),
      contactsBy: agg.contacts,
    };
  }
}
check(`${ZONES.length * SIZES.length * SEEDS} walks x ${STEPS} moves: every invariant held at every step`,
  allProblems.length === 0, allProblems.slice(0, 3).join(' | '));
check('fog never un-reveals; supplies never negative; the party always sees its tile (part of the above)', allProblems.length === 0);
check('running out of supplies never stops the party', totalMovedAtZero > 0,
  `${huntsRanDry} hunts ran dry, ${totalMovedAtZero} moves made at 0 supplies`);
golden.walkHashes = walkHashes;
golden.walkStats = stats;
golden.firstSightBands = firstBandTally;
console.log('    first-sight Detection bands, test party (Perception 50):', JSON.stringify(firstBandTally));
for (const [k, v] of Object.entries(stats)) console.log(`    ${k}: ${JSON.stringify(v)}`);

// =============================================================================
console.log('=== save -> reload continues identically ===');
{
  let bad = 0, runs = 0;
  for (const zoneId of ZONES) {
    for (const size of SIZES) {
      const seed = 7100;
      const straight = walk({ zoneId, size, seed, steps: 30 });
      for (const at of [0, 1, 7, 15, 29]) {
        runs++;
        const w = walk({ zoneId, size, seed, steps: 30, onStep: (hunt, i, world) => (i === at
          ? restoreMapHunt(JSON.parse(JSON.stringify(hunt.serialize())), world) : null) });
        if (!same(w.hunt.serialize(), straight.hunt.serialize()) || !same(w.trace, straight.trace)) bad++;
      }
    }
  }
  check(`reload at 5 points x 6 maps: identical state, stream and trace`, bad === 0, `${runs} runs, ${bad} differ`);
  const h = walk({ zoneId: ZONES[0], size: 'small', seed: 7101, steps: 5 }).hunt;
  const data = h.serialize();
  const bads = [
    ['a version it does not know', { ...data, v: 99 }],
    ['a position off its map', { ...data, pos: '9:9,9' }],
    ['a fog entry that is not a state', { ...data, fog: { ...data.fog, [data.pos]: 'maybe' } }],
    ['no stream state', { ...data, rngState: undefined }],
  ];
  for (const [label, d] of bads) {
    let threw = false;
    try { restoreMapHunt(d, recordingWorld(makeParty())); } catch { threw = true; }
    check(`restore refuses ${label}`, threw);
  }
}

// =============================================================================
console.log('=== hunts are instances ===');
{
  const alone = [walk({ zoneId: ZONES[0], size: 'medium', seed: 7200, steps: 25 }), walk({ zoneId: ZONES[1], size: 'large', seed: 7201, steps: 25 })];
  const pa = makeParty(), pb = makeParty();
  const wa = recordingWorld(pa), wb = recordingWorld(pb);
  const a = createMapHunt(ZONES[0], { plan: { objective: 'scout', size: 'medium' }, supplies: 60, seed: 7200 }, wa);
  const b = createMapHunt(ZONES[1], { plan: { objective: 'scout', size: 'large' }, supplies: 60, seed: 7201 }, wb);
  const pickA = makeRng(7200 ^ 0x5eed), pickB = makeRng(7201 ^ 0x5eed);
  const sa = new Set([a.getState().pos]), sb = new Set([b.getState().pos]);
  for (let i = 0; i < 25; i++) {
    const ta = chooseMove(a, pickA, sa); a.move(ta); settle(a); sa.add(ta);
    const tb = chooseMove(b, pickB, sb); b.move(tb); settle(b); sb.add(tb);
  }
  check('two hunts interleaved = each run alone', same(a.serialize(), alone[0].hunt.serialize()) && same(b.serialize(), alone[1].hunt.serialize()));
}

// =============================================================================
console.log('=== partyStats is the reader of every stat used ===');
{
  const party = makeParty();
  const world = recordingWorld(party);
  const planMods = { perceptionBonus: 10, travelTimePercent: 12, supplyEfficiencyPercent: 8, harvestYieldPercent: 5 };
  const hunt = createMapHunt(ZONES[0], { plan: { objective: 'scout', size: 'small', mods: planMods }, supplies: 60, seed: 7300 }, world);
  const s = hunt.getState();
  const bundle = R.huntMods(getZone(ZONES[0]).modifiers, s.weather.modifiers, planMods);
  check('the hunt keeps the bundle huntMods builds (zone + weather + plan, plan-only fields added)', same(s.mods, bundle));
  check('plan-only fields ride in the bundle', s.mods.perceptionBonus === 10 && s.mods.travelTimePercent === 12 && s.mods.harvestYieldPercent === 5);
  const hs = hunt.stats(), ps = partyStats(party, bundle);
  check('hunt.stats() is partyStats(party, bundle)', same(hs, ps));
  check('of Keen Eyes reaches Detection: perception = best-of + 10', hs.perception === partyStats(party, {}).perception + 10, `${hs.perception}`);
  check('supplyEfficiencyPercent includes the zone and the plan (replaces the raw bundle value)',
    Math.abs(hs.supplyEfficiencyPercent - (partyStats(party, {}).supplyEfficiencyPercent + bundle.supplyEfficiencyPercent)) < EPS,
    `${r4(hs.supplyEfficiencyPercent)}% = curve + zone ${getZone(ZONES[0]).modifiers.supplyEfficiencyPercent} + weather + plan 8`);
  golden.testPartyStats = { perception: hs.perception, supplyEfficiencyPercent: r4(hs.supplyEfficiencyPercent), travelTimePercent: r4(hs.travelTimePercent) };

  const shep = party.find(c => c.baseClass === 'Shepherd');
  const before = hunt.stats().perception;
  shep.status = 'dead';
  const after = hunt.stats().perception;
  check('a dead hunter stops counting at once (the Shepherd was the best eye)', after < before, `${before} -> ${after}`);
  shep.status = undefined;
}

// =============================================================================
console.log('=== passives: Far Sight, Naturalist ===');
{
  const plain = makeParty();
  const far = makeParty();
  const s = far.find(c => c.baseClass === 'Shepherd');
  s.level = 6; s.exploration = { picks: { 6: { passive: 'far_sight' } } };
  let wider = 0, narrower = 0, n = 0;
  for (let k = 0; k < 20; k++) {
    for (const zoneId of ZONES) {
      const a = createMapHunt(zoneId, { plan: { objective: 'scout', size: 'medium' }, supplies: 60, seed: 7400 + k }, recordingWorld(plain));
      const b = createMapHunt(zoneId, { plan: { objective: 'scout', size: 'medium' }, supplies: 60, seed: 7400 + k }, recordingWorld(far));
      const va = Object.keys(a.getState().fog).length, vb = Object.keys(b.getState().fog).length;
      n++; if (vb > va) wider++; if (vb < va) narrower++;
    }
  }
  check('Far Sight: never sees less, and sees more from most entries', narrower === 0 && wider > n / 2, `${wider}/${n} wider`);

  // Naturalist: find an identified beast in sight of some entry.
  const nat = makeParty();
  const scholar = nat.find(c => c.baseClass === 'Scholar');
  scholar.exploration = { picks: { 2: { passive: 'naturalist' } } };
  let shown = null;
  for (let k = 0; k < 200 && !shown; k++) {
    const hA = createMapHunt(ZONES[0], { plan: { objective: 'cull', size: 'medium' }, supplies: 60, seed: 7500 + k }, recordingWorld(makeParty()));
    const beast = hA.view().occupants.find(v => v.kind === 'beast' && v.band === 'identified');
    if (!beast) continue;
    const hB = createMapHunt(ZONES[0], { plan: { objective: 'cull', size: 'medium' }, supplies: 60, seed: 7500 + k }, recordingWorld(nat));
    shown = { plain: beast, naturalist: hB.occupantViewOf(beast.id), occ: hA.getState().map.occupants.find(o => o.id === beast.id) };
  }
  check('found an identified beast at a hunt\'s entry', !!shown);
  if (shown) {
    check('identified, no Naturalist: kind, size word, top grade, mark; no roster',
      shown.plain.size && shown.plain.topGrade && shown.plain.mark && !shown.plain.roster);
    check('identified, Naturalist: the exact roster and the composition\'s name',
      same(shown.naturalist.roster, shown.occ.roster) && typeof shown.naturalist.composition === 'string');
    golden.naturalistExample = { plain: shown.plain, naturalist: shown.naturalist };
  }
}

// =============================================================================
console.log('=== the scout action ===');
{
  let tested = null;
  for (let k = 0; k < 300 && !tested; k++) {
    for (const zoneId of ZONES) {
      const world = recordingWorld(makeParty());
      const h = createMapHunt(zoneId, { plan: { objective: 'scout', size: 'medium' }, supplies: 60, seed: 7600 + k }, world);
      const sensed = h.view().occupants.find(v => v.band === 'sensed');
      if (!sensed) continue;
      const hidden = h.getState().map.occupants.find(o => !h.getState().sightings[o.id]);
      const before = h.getState();
      const res = h.scout(sensed.id);
      const after = h.getState();
      tested = {
        res, again: h.scout(sensed.id), hiddenFound: !!hidden, hiddenTry: hidden ? h.scout(hidden.id) : { ok: false },
        timeSpent: after.time - before.time, suppliesSame: after.supplies === before.supplies, posSame: after.pos === before.pos,
        occ: after.map.occupants.find(o => o.id === sensed.id),
      };
      break;
    }
  }
  check('found a sensed occupant at some entry', !!tested);
  if (tested) {
    check('scout: sensed -> identified with the exact roster', tested.res.ok && tested.res.view.band === 'identified'
      && tested.res.view.exact && same(tested.res.view.roster, tested.occ.roster));
    check(`scout: costs ${R.SCOUT_TIME} time, no supplies, the party stays put`,
      Math.abs(tested.timeSpent - R.SCOUT_TIME) < EPS && tested.suppliesSame && tested.posSame);
    check('scout: refuses the same occupant twice', !tested.again.ok);
    check('scout: refuses an occupant nothing was detected of', tested.hiddenFound && !tested.hiddenTry.ok);
  }
}

// =============================================================================
// 7b: food, hunger and camp
// =============================================================================
const { Items } = await import('../../data/items.js');
const { countInList } = await import('../../src/systems/ItemStacks.js');
const { rationPackCap } = R;

/** Serialize with instance ids dropped: ids are labels drawn from Math.random
 *  when a stack is made or split, not hunt state. Everything else must match. */
const noIds = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === 'instanceId' ? undefined : x)));

console.log('=== 7b rules on hand-built inputs ===');
{
  const H = (o) => R.hungerStage({ supplies: 10, zeroSince: null, satedUntil: 0, time: 20, ...o });
  check('hunger: supplies above 0 = fed; with a meal still on = sated',
    H({}) === 'fed' && H({ satedUntil: 21 }) === 'sated' && H({ satedUntil: 20 }) === 'fed');
  check(`hunger: at 0 = hungry, starving after ${R.STARVING_AFTER} units at 0; running out ends Sated`,
    H({ supplies: 0, zeroSince: 15 }) === 'hungry' && H({ supplies: 0, zeroSince: 14 }) === 'starving'
    && H({ supplies: 0, zeroSince: 19, satedUntil: 99 }) === 'hungry');
  check('starving: loses 5% of max HP (at least 1), never below 1, never touches 1 or 0',
    R.starvedHP({ currentHP: 100, maxHP: 100 }) === 95 && R.starvedHP({ currentHP: 3, maxHP: 100 }) === 1
    && R.starvedHP({ currentHP: 1, maxHP: 100 }) === 1 && R.starvedHP({ currentHP: 0, maxHP: 100 }) === 0
    && R.starvedHP({ currentHP: 5, maxHP: 10 }) === 4);
  const fish = Items[R.FISH_ITEM], cress = Items.marsh_cress, tuber = Items.reed_tuber;
  const d = fish.food.difficulty + cress.food.difficulty;
  check('cooking: plain below the difficulty, hearty at it, fine at +FINE_MARGIN',
    R.cookDish(fish, cress, d - 1).quality === 'plain' && R.cookDish(fish, cress, d).quality === 'hearty'
    && R.cookDish(fish, cress, d + R.FINE_MARGIN - 1).quality === 'hearty' && R.cookDish(fish, cress, d + R.FINE_MARGIN).quality === 'fine');
  check('cooking: plain gives only supplies; hearty adds Sated; fine adds the addition\'s buff',
    !R.cookDish(fish, cress, 0).sated && R.cookDish(fish, cress, d).sated && !R.cookDish(fish, cress, d).buff
    && R.cookDish(fish, cress, 999).buff?.field === cress.food.buff.field
    && R.cookDish(fish, tuber, 999).buff === null && R.cookDish(fish, cress, 0).supply === fish.supply + cress.supply);
  check('camp recovery: day 20, night 35, Field Rites +25% of it',
    R.campRecoveryPercent(false) === 20 && R.campRecoveryPercent(true) === 35 && R.campRecoveryPercent(false, 25) === 25);
  check('recovered: rounds, caps at max', R.recovered(10, 100, 20) === 30 && R.recovered(95, 100, 20) === 100 && R.recovered(0, 0, 50) === 0);

  // Every forage band that yields must have something growing on every ground in it.
  const yielding = Object.entries(GROUNDS).filter(([, g]) => (R.FORAGE_YIELD[g.forage] || 0) > 0);
  const bare = yielding.filter(([id]) => R.forageCandidates(Items, id).length === 0).map(([id]) => id);
  check('every ground that yields forage has at least one food growing on it', bare.length === 0, bare.join(', '));
  const foods = Object.values(Items).filter(i => i.type === 'food');
  check('every food names real grounds and a positive supply',
    foods.every(f => f.supply > 0 && (f.food.kind !== 'forage' || f.food.grounds.every(g => GROUNDS[g]))));
  // Declared-but-unenforced guard: each buff field must actually move partyStats.
  const party = makeParty();
  const base = partyStats(party, {});
  const dead = foods.filter(f => f.food.buff).filter(f => {
    const withBuff = partyStats(party, { [f.food.buff.field]: f.food.buff.amount });
    return same(withBuff, base);
  }).map(f => f.id);
  check('every food buff writes a field partyStats reads (no dead buff)', dead.length === 0, dead.join(', '));
  golden.foods = Object.fromEntries(foods.map(f => [f.id, { supply: f.supply, ...f.food }]));
  golden.food7b = { STARVING_AFTER: R.STARVING_AFTER, SATED_TIME: R.SATED_TIME, HUNGER_INITIATIVE: R.HUNGER_INITIATIVE,
    FORAGE_YIELD: R.FORAGE_YIELD, FISH_YIELD: R.FISH_YIELD, CAMP_TIME: R.CAMP_TIME, CAMP_SUPPLY: R.CAMP_SUPPLY,
    CAMP_RECOVERY: R.CAMP_RECOVERY, FINE_MARGIN: R.FINE_MARGIN, RATIONS_PACK_CAP: R.RATIONS_PACK_CAP };
}

console.log('=== Pack Mule and the packing cap ===');
{
  const p = makeParty();
  const grunts = p.filter(c => c.baseClass === 'Grunt');
  const plain = rationPackCap(p);
  grunts[0].exploration = { picks: { 2: { passive: 'pack_mule' } } };
  const one = rationPackCap(p);
  grunts[1].exploration = { picks: { 2: { passive: 'pack_mule' } } };
  const two = rationPackCap(p);
  check('packing cap: 60 without Pack Mule (chunk 8c; was 100), 80 with it, and it counts once per party',
    plain === 60 && plain === R.RATIONS_PACK_CAP && one === R.RATIONS_PACK_CAP + 20 && two === one, `${plain} / ${one} / ${two}`);
  check('the Hunt screen packs up to rationPackCap(GameState.party), not its own constant',
    /rationPackCap\(GameState\.party\)/.test(fs.readFileSync('src/scenes/overlays/HuntHubOverlay.js', 'utf8'))
    && !/MAX_RATIONS_PACKED/.test(fs.readFileSync('src/scenes/overlays/HuntHubOverlay.js', 'utf8')));
}

console.log('=== hunger in a hunt: initiative, and Starving never kills ===');
{
  const party = makeParty();
  const world = recordingWorld(party);
  const h = createMapHunt(ZONES[0], { plan: { objective: 'scout', size: 'large' }, supplies: 3, seed: 7700 }, world);
  const fedInit = h.stats().partyInitiative;
  const pick = makeRng(77);
  const stood = new Set([h.getState().pos]);
  const stages = [];
  let firstStarveAt = null, hpLossWhileNotStarving = 0;
  // Low HP everywhere, including someone already at 1.
  party.forEach((c, i) => { c.currentHP = [1, 2, 3, 7, 20, c.maxHP][i]; });
  const startHP = party.map(c => c.currentHP);
  let belowOne = 0, rose = 0;
  for (let i = 0; i < 120; i++) {
    const before = party.map(c => c.currentHP);
    const stageBefore = h.hunger();
    const to = chooseMove(h, pick, stood); stood.add(to);
    const res = h.move(to);
    settle(h);
    const stage = h.hunger();
    stages.push(stage);
    if (stage === 'starving' && firstStarveAt === null) firstStarveAt = h.getState().time - h.getState().zeroSince;
    party.forEach((c, k) => {
      if (c.currentHP < 1 && startHP[k] >= 1) belowOne++;
      if (c.currentHP > before[k]) rose++;
      if (c.currentHP < before[k] && stage !== 'starving') hpLossWhileNotStarving++;
    });
  }
  const st = h.getState();
  check('supplies ran out and stayed at 0, never negative', st.supplies === 0 && stages.includes('hungry'));
  check(`Hungry first, then Starving once ${R.STARVING_AFTER} units passed at 0`,
    stages.indexOf('hungry') < stages.indexOf('starving') && firstStarveAt >= R.STARVING_AFTER - EPS);
  check('120 moves, most of them Starving: no hunter below 1 HP, none dead, HP never rose',
    belowOne === 0 && rose === 0 && party.every(c => c.status !== 'dead') && party.every(c => c.currentHP >= 1),
    `HP now ${party.map(c => c.currentHP).join('/')}`);
  check('HP is only ever lost on a Starving move', hpLossWhileNotStarving === 0);
  check('a hunter at 1 HP when starvation began is still at 1', party[0].currentHP === 1);
  const starvInit = h.stats().partyInitiative;
  check('party initiative: Starving is 4 below Fed', Math.abs(fedInit - starvInit - 4) < EPS, `${r4(fedInit)} -> ${r4(starvInit)}`);
  golden.starvingRun = { stagesSeen: [...new Set(stages)], hpAtEnd: party.map(c => c.currentHP), fedInit: r4(fedInit), starvInit: r4(starvInit) };
}

/** A hunt standing somewhere it can forage and somewhere it can fish. */
function findHunt(test, { zones = ZONES, size = 'medium', party = () => makeParty(), from = 7800, tries = 300 } = {}) {
  for (let k = 0; k < tries; k++) {
    for (const zoneId of zones) {
      const p = party();
      const world = recordingWorld(p);
      const h = createMapHunt(zoneId, { plan: { objective: 'scout', size }, supplies: 60, seed: from + k }, world);
      if (test(h)) return { h, p, world, seed: from + k, zoneId };
    }
  }
  return null;
}

/** Walk the hunt one step to the neighbour `pred` accepts, if any. */
function stepTo(h, pred) {
  const s = h.getState();
  const n = mapNeighbors(s.map, s.pos).find(id => isPassable(s.map.tiles[id]) && pred(s.map.tiles[id], id));
  if (!n) return null;
  const r = h.move(n);
  settle(h);
  return r;
}

console.log('=== forage and fish ===');
{
  const f = findHunt(h => { const t = h.getState().map.tiles[h.getState().pos]; return !t.barren && t.fishing && (R.FORAGE_YIELD[GROUNDS[t.ground].forage] || 0) > 0; });
  check('found an entry that can be foraged and fished', !!f);
  if (f) {
    const { h } = f;
    const s0 = h.getState(), tile = s0.map.tiles[s0.pos];
    const st = h.stats();
    const r1 = h.forage();
    const s1 = h.getState();
    check('forage: yields a food that grows on this ground, in the amount gatherQty gives',
      r1.ok && R.forageCandidates(Items, tile.ground).includes(r1.item)
      && r1.qty === R.gatherQty(R.FORAGE_YIELD[GROUNDS[tile.ground].forage], st.forageYieldPercent, Items[r1.item].supply),
      `${r1.qty} ${r1.item} on ${tile.ground}`);
    check('forage: into the pack\'s found list, costs FORAGE_TIME, no supplies',
      countInList(s1.pack.found, r1.item) === r1.qty && Math.abs(s1.time - s0.time - R.FORAGE_TIME) < EPS && s1.supplies === s0.supplies);
    const again = h.forage(), fishToo = h.fish();
    check('a tile gives food once: forage again and fish both refused, no time spent',
      !again.ok && !fishToo.ok && h.getState().time === s1.time);
    // Fish on a fresh fishing tile.
    const moved = stepTo(h, (t, id) => t.fishing && !t.barren && !h.getState().gathered[id]);
    if (moved) {
      const st2 = h.stats();
      const r2 = h.fish();
      check('fish: raw fish in the amount gatherQty gives',
        r2.ok && r2.item === R.FISH_ITEM && r2.qty === R.gatherQty(R.FISH_YIELD, st2.fishYieldPercent, Items[R.FISH_ITEM].supply), `${r2.qty}`);
    } else check('fish: a neighbouring fishing tile to test on', false);
  }
  // Blight comes from a Blighted plan. Stand the party on it through the save
  // (restore checks only that the tile is on the map), then ask.
  const bh = createMapHunt(ZONES[0], { plan: { objective: 'scout', size: 'large', mods: { blightPatches: 3 } }, supplies: 60, seed: 7850 }, recordingWorld(makeParty()));
  const bd = bh.serialize();
  const blightTile = Object.keys(bd.map.tiles).find(id => bd.map.tiles[id].ground === 'blight');
  if (blightTile) {
    const onBlight = restoreMapHunt({ ...bd, pos: blightTile }, recordingWorld(makeParty()));
    const r = onBlight.forage();
    check('blight: nothing to forage, and no time spent', !r.ok && onBlight.getState().time === bd.time, r.reason);
  } else check('a Blighted plan places blight', false);
  const dry = findHunt(h => !h.getState().map.tiles[h.getState().pos].fishing);
  check('fish refused where there is no water', dry && !dry.h.fish().ok);
  const lean = (() => {
    for (let k = 0; k < 200; k++) {
      const h = createMapHunt(ZONES[0], { plan: { objective: 'scout', size: 'medium', mods: { leanCountryPercent: 50 } }, supplies: 60, seed: 7900 + k }, recordingWorld(makeParty()));
      const t = h.getState().map.tiles[h.getState().pos];
      if (t.barren) return h;
    }
    return null;
  })();
  check('Lean Country: a barren tile is refused, no time spent', lean && !lean.forage().ok && !lean.fish().ok && lean.getState().time === 0);
}

console.log('=== eat ===');
{
  const f = findHunt(h => { const t = h.getState().map.tiles[h.getState().pos]; return t.fishing && !t.barren; });
  const { h } = f;
  h.fish();
  const got = h.foodInPack();
  check('raw fish cannot be eaten: it must be cooked', !h.eat(R.FISH_ITEM).ok);
  // Put the party at 0 and eat something raw.
  const g = findHunt(h2 => { const t = h2.getState().map.tiles[h2.getState().pos]; return !t.barren && R.forageCandidates(Items, t.ground).some(id => Items[id].food.rawEdible); }, { from: 8000 });
  let ateOk = false, detail = '';
  {
    const hh = createMapHunt(g.zoneId, { plan: { objective: 'scout', size: 'medium' }, supplies: 0, seed: g.seed }, recordingWorld(makeParty()));
    for (let tries = 0; tries < 30; tries++) {
      const r = hh.forage();
      if (r.ok && Items[r.item].food.rawEdible) {
        const before = hh.getState();
        const e = hh.eat(r.item, r.qty);
        const after = hh.getState();
        ateOk = e.ok && Math.abs(after.supplies - r.qty * Items[r.item].supply) < EPS && after.zeroSince === null && hh.hunger() === 'fed'
          && countInList(after.pack.found, r.item) === 0 && after.time === before.time;
        detail = `${r.qty} ${r.item} -> ${after.supplies} supplies`;
        check('eating more than the pack holds is refused', !hh.eat(r.item, 1).ok);
        break;
      }
      if (!stepTo(hh, (t, id) => !t.barren && !hh.getState().gathered[id])) break;
    }
  }
  check('eat: raw food goes into supplies, leaves the pack, clears Hungry, takes no time', ateOk, detail);
  check('eating a non-food is refused', !h.eat('rations').ok && got[R.FISH_ITEM] > 0);
}

console.log('=== camp ===');
{
  // A cook who can reach Fine on fish + marsh cress: Halvard (Cooking 45) with a +10 pick.
  const cookParty = () => {
    const p = makeParty();
    const cook = p.find(c => c.name === 'Halvard');
    cook.exploration = { picks: { 2: { rating: 'cooking' }, 4: { passive: 'field_rites' } } };
    return p;
  };
  const f = findHunt(h => { const t = h.getState().map.tiles[h.getState().pos]; return t.fishing && !t.barren; }, { party: cookParty, from: 8100 });
  const { h, p } = f;
  h.fish();
  // Fish a second tile too, for two meals.
  stepTo(h, (t, id) => t.fishing && !t.barren && !h.getState().gathered[id]) && h.fish();
  const st = h.stats();
  check('the test cook: best Cooking 55 with the pick, Field Rites taken', st.cooking === 55 && st.passives.campRecoveryPercent === 25, `${st.cooking}`);
  p.forEach(c => { c.currentHP = Math.max(1, Math.floor(c.maxHP / 4)); c.currentMP = 0; });
  p[5].status = 'dead'; const deadHP = p[5].currentHP;
  // Give the pack one marsh cress (a found forage) the honest way is too rare to script; put it in through the pack.
  const pre = JSON.stringify(h.getState());
  const refuse = h.camp({ meals: [{ main: 'marsh_cress' }] });
  check('camp refuses a meal whose main is not fish or meat, and changes nothing', !refuse.ok && JSON.stringify(h.getState()) === pre);
  const refuse2 = h.camp({ meals: [{ main: R.FISH_ITEM }, { main: R.FISH_ITEM }, { main: R.FISH_ITEM }, { main: R.FISH_ITEM }, { main: R.FISH_ITEM }, { main: R.FISH_ITEM }, { main: R.FISH_ITEM }, { main: R.FISH_ITEM }, { main: R.FISH_ITEM }] });
  check('camp refuses meals the pack cannot cover', !refuse2.ok);
  const before = h.getState();
  const hpBefore = p.map(c => c.currentHP);
  const night = R.clockAt(before.time).isNight;
  const fishN = h.foodInPack()[R.FISH_ITEM];
  const c1 = h.camp({ meals: [{ main: R.FISH_ITEM }] });
  const after = h.getState();
  const pct = R.campRecoveryPercent(night, 25);
  check('camp: CAMP_TIME passes; supplies = before + dishes - CAMP_SUPPLY',
    c1.ok && Math.abs(after.time - before.time - R.CAMP_TIME) < EPS
    && Math.abs(after.supplies - (before.supplies + Items[R.FISH_ITEM].supply - R.CAMP_SUPPLY)) < EPS);
  check('camp: the living recover the camp percent of max (Field Rites included); the dead do not',
    p.slice(0, 5).every((c, i) => c.currentHP === R.recovered(hpBefore[i], c.maxHP, pct) && c.currentMP === R.recovered(0, c.maxMP, pct))
    && p[5].currentHP === deadHP, `${r4(pct)}% (${night ? 'night' : 'day'})`);
  check('camp: fish alone (difficulty 30) at Cooking 55 is Fine, but with no addition there is no buff; Sated for SATED_TIME',
    c1.dishes[0].quality === 'fine' && c1.dishes[0].buff === null && after.foodBuff === null
    && h.hunger() === 'sated' && after.satedUntil === after.time + R.SATED_TIME);
  const initSated = h.stats().partyInitiative;
  check('party initiative: Sated is 2 above Fed', Math.abs(initSated - partyStats(p, h.getState().mods).partyInitiative - 2) < EPS);
  check('camp: the fish came out of the pack', h.foodInPack()[R.FISH_ITEM] === fishN - 1 || (fishN === 1 && !h.foodInPack()[R.FISH_ITEM]));
  // Night camp and a Fine meal: add a marsh cress to the pack as a find (the camp reads the pack, whatever put it there).
  const s = h.getState();
  const { makeStack, addToList } = await import('../../src/systems/ItemStacks.js');
  // Use serialize/restore to put the cress in, so nothing reaches into the live state.
  const data = h.serialize();
  addToList(data.pack.found, makeStack('marsh_cress', 1));
  const h2 = restoreMapHunt(data, recordingWorld(p));
  while (!R.clockAt(h2.getState().time).isNight) stepTo(h2, () => true);
  const travelBefore = h2.stats().travelTimePercent;
  const hpB = p.map(c => c.currentHP);
  if (h2.foodInPack()[R.FISH_ITEM]) {
    const c2 = h2.camp({ meals: [{ main: R.FISH_ITEM, addition: 'marsh_cress' }] });
    check('camp at night: recovers 35% (x1.25 Field Rites)', c2.ok && c2.night && Math.abs(c2.recoveryPercent - 35 * 1.25) < EPS
      && p.slice(0, 5).every((c, i) => c.currentHP === R.recovered(hpB[i], c.maxHP, 35 * 1.25)));
    check('fish + marsh cress at Cooking 55 is Fine: its buff lands and moves travelTimePercent by 10',
      c2.dishes[0].quality === 'fine' && h2.view().foodBuff?.field === 'travelTimePercent'
      && Math.abs(h2.stats().travelTimePercent - travelBefore - 10) < EPS);
    const until = h2.getState().foodBuff.until;
    while (h2.getState().time < until) stepTo(h2, () => true);
    check('the buff ends when its time runs out', h2.view().foodBuff === null && Math.abs(h2.stats().travelTimePercent - travelBefore) < EPS);
  } else check('a second fish for the night camp', false);
  // Camp at 0 supplies with nothing to cook.
  const z = createMapHunt(ZONES[0], { plan: { objective: 'scout', size: 'small' }, supplies: 0, seed: 8200 }, recordingWorld(makeParty()));
  const zc = z.camp();
  check('camp at 0 supplies: allowed, supplies stay 0, never negative', zc.ok && z.getState().supplies === 0);
}

console.log('=== mixed actions: invariants, reload, golden ===');
{
  /** A scripted hunt mixing every 7b action with moves, chosen by the harness's stream. */
  function mixed({ zoneId, size, seed, steps = 80, onStep = null }) {
    const party = makeParty();
    const world = recordingWorld(party);
    let h = createMapHunt(zoneId, { plan: { objective: 'scout', size }, supplies: 30, seed }, world);
    const pick = makeRng(seed ^ 0xf00d);
    const stood = new Set([h.getState().pos]);
    const trace = [], problems = [];
    let seen = new Set(Object.keys(h.getState().fog));
    const tally = { move: 0, forage: 0, fish: 0, eat: 0, camp: 0, refused: 0, dishes: { plain: 0, hearty: 0, fine: 0 }, gathered: 0 };
    for (let i = 0; i < steps; i++) {
      if (onStep) h = onStep(h, i, world) || h;
      const before = h.getState();
      const hpBefore = party.map(c => c.currentHP);
      const r = pick();
      let res, kind;
      if (r < 0.2) { kind = 'forage'; res = h.forage(); }
      else if (r < 0.3) { kind = 'fish'; res = h.fish(); }
      else if (r < 0.38) {
        kind = 'eat';
        const raw = Object.keys(h.foodInPack()).filter(id => Items[id].food.rawEdible).sort();
        res = raw.length ? h.eat(raw[0], 1) : { ok: false };
      } else if (r < 0.44) {
        kind = 'camp';
        const food = h.foodInPack();
        const add = Object.keys(food).filter(id => Items[id].food.kind === 'forage').sort()[0];
        res = h.camp({ meals: food[R.FISH_ITEM] ? [{ main: R.FISH_ITEM, addition: add }] : [] });
        if (res.ok) for (const d of res.dishes) tally.dishes[d.quality]++;
      } else {
        kind = 'move';
        const to = chooseMove(h, pick, stood); stood.add(to);
        res = h.move(to);
      }
      // Encounters from any action are settled in the same step (win or flee,
      // by the harness's stream), so no step starts with a fight pending.
      for (let k = 0; k < 5 && h.encounter(); k++) {
        if (pick() < 0.5) h.flee(); else h.winEncounter();
      }
      settle(h);
      if (res.ok) tally[kind]++; else tally.refused++;
      const s = h.getState();
      if (s.supplies < 0) problems.push(`step ${i}: supplies negative`);
      if (s.time < before.time) problems.push(`step ${i}: time went back`);
      if (!res.ok && (s.time !== before.time || s.supplies !== before.supplies)) problems.push(`step ${i}: a refused ${kind} changed the hunt`);
      if (party.some(c => c.currentHP < 1)) problems.push(`step ${i}: a hunter below 1 HP`);
      if (kind !== 'camp' && party.some((c, k) => c.currentHP > hpBefore[k])) problems.push(`step ${i}: HP rose outside a camp`);
      for (const id of seen) if (!s.fog[id]) problems.push(`step ${i}: fog un-revealed ${id}`);
      seen = new Set(Object.keys(s.fog));
      if (Object.values(s.gathered).length > new Set(Object.keys(s.gathered)).size) problems.push('a tile gathered twice');
      if (s.supplies > 0 && s.zeroSince !== null) problems.push(`step ${i}: zeroSince set above 0 supplies`);
      if (s.supplies === 0 && s.zeroSince === null) problems.push(`step ${i}: at 0 supplies with no zeroSince`);
      trace.push([kind, res.ok ? 1 : 0, r4(s.supplies), r4(s.time), h.hunger(), noIds(s.pack.found).map(it => `${it.id}x${it.qty || 1}`).join(',')]);
    }
    tally.gathered = Object.keys(h.getState().gathered).length;
    return { h, trace, problems, tally };
  }
  const probs = [], hashes = {}, tallies = {};
  for (const zoneId of ZONES) {
    for (const size of SIZES) {
      const hsh = crypto.createHash('sha256');
      const agg = { move: 0, forage: 0, fish: 0, eat: 0, camp: 0, refused: 0, dishes: { plain: 0, hearty: 0, fine: 0 }, gathered: 0 };
      for (let k = 0; k < 15; k++) {
        const m = mixed({ zoneId, size, seed: 8300 + k });
        probs.push(...m.problems.map(p => `${zoneId}/${size} ${8300 + k}: ${p}`));
        hsh.update(JSON.stringify(m.trace));
        for (const key of ['move', 'forage', 'fish', 'eat', 'camp', 'refused', 'gathered']) agg[key] += m.tally[key];
        for (const q of Object.keys(agg.dishes)) agg.dishes[q] += m.tally.dishes[q];
        if (zoneId === ZONES[0] && size === 'small' && k === 0) golden['mixed reeds small 8300'] = m.trace;
      }
      hashes[`${zoneId}/${size}`] = hsh.digest('hex').slice(0, 16);
      tallies[`${zoneId}/${size}`] = agg;
    }
  }
  check('90 mixed hunts x 80 actions: supplies never negative, no one below 1 HP, fog never un-reveals, refusals change nothing, hunger bookkeeping honest',
    probs.length === 0, probs.slice(0, 3).join(' | '));
  golden.mixedHashes = hashes;
  golden.mixedTallies = tallies;
  for (const [k, v] of Object.entries(tallies)) console.log(`    ${k}: ${JSON.stringify(v)}`);

  let bad = 0, runs = 0;
  for (const zoneId of ZONES) {
    const straight = mixed({ zoneId, size: 'medium', seed: 8400, steps: 50 });
    for (const at of [1, 9, 23, 41]) {
      runs++;
      const w = mixed({ zoneId, size: 'medium', seed: 8400, steps: 50, onStep: (hunt, i, world) => (i === at
        ? restoreMapHunt(JSON.parse(JSON.stringify(hunt.serialize())), world) : null) });
      if (!same(noIds(w.h.serialize()), noIds(straight.h.serialize())) || !same(w.trace, straight.trace)) bad++;
    }
  }
  check('reload in the middle of mixed actions continues identically (instance ids aside)', bad === 0, `${runs} runs, ${bad} differ`);
}

// =============================================================================
// 7c: the world tick, encounters, flee, camp found, blight, corruption
// =============================================================================
const W = await import('../../src/systems/HuntWorld.js');
const HMG = await import('../../data/huntMapGen.js');
const B = await import('../../src/systems/HuntBeasts.js');

console.log('=== 7c rules on hand-built inputs ===');
{
  // Chunk 9a: an occupant's initiative is its members' average, each from its
  // real enemy type (HuntBeasts; beastparts.mjs checks it in depth).
  check('occupant initiative: the average of its members real types (chunk 9a)',
    B.occupantInitiative({ kind: 'beast', family: 'marsh_stalker', roster: [{ type: 'marsh_stalker', grade: 'great' }, { type: 'marsh_stalker', grade: 'yearling' }] })
      === B.memberInitiative('hunt_marsh_stalker')
    && B.occupantInitiative({ id: 'o1', kind: 'cultist', roster: [{ type: 'cultist', grade: null }, { type: 'cultist', grade: null }] })
      === (B.memberInitiative('hunt_cult_zealot') + B.memberInitiative('hunt_cult_adept')) / 2);
  check('who acts first: ambush is decisive; otherwise higher initiative, ties to the party',
    W.whoActsFirst({ ambush: true, partyInitiative: 99, enemyInitiative: 1 }) === 'enemy'
    && W.whoActsFirst({ ambush: false, partyInitiative: 7, enemyInitiative: 7 }) === 'party'
    && W.whoActsFirst({ ambush: false, partyInitiative: 7, enemyInitiative: 7.5 }) === 'enemy');
  check(`trail lost: a day, half a day when the party's Speed beats ${HMG.PACK_SPEED}`,
    W.trailLostTime(HMG.PACK_SPEED) === W.TRAIL_LOST_TIME && W.trailLostTime(HMG.PACK_SPEED + 1) === W.TRAIL_LOST_TIME_FAST);
  check(`camp found: pack perception ${HMG.PACK_PERCEPTION} at or above the camp's concealment`,
    W.packFindsCamp(HMG.PACK_PERCEPTION) && !W.packFindsCamp(HMG.PACK_PERCEPTION + 1));
  const tr = { family: 'marsh_stalker', to: '0:1,1', at: 0 };
  const conc = GROUNDS.grass.concealment + W.TRAIL_CONCEALMENT;
  check('trails read through the Detection bands; age only with Perception well above',
    W.trailView(tr, 'grass', conc - R.SENSED_MARGIN - 1, 5) === null
    && W.trailView(tr, 'grass', conc - 1, 5)?.band === 'sensed' && W.trailView(tr, 'grass', conc - 1, 5).family === undefined
    && W.trailView(tr, 'grass', conc, 5)?.family === 'marsh_stalker' && W.trailView(tr, 'grass', conc, 5).age === undefined
    && W.trailView(tr, 'grass', conc + W.TRAIL_AGE_MARGIN, 5)?.age === 5);
  golden.world7c = {
    ROAM_STEP: W.ROAM_STEP, HUNT_STEP: W.HUNT_STEP, TRAIL_LOST_TIME: W.TRAIL_LOST_TIME, TRAIL_LOST_TIME_FAST: W.TRAIL_LOST_TIME_FAST,
    TRAIL_TIME: W.TRAIL_TIME, TRAIL_CONCEALMENT: W.TRAIL_CONCEALMENT, TRAIL_AGE_MARGIN: W.TRAIL_AGE_MARGIN,
    BLIGHT_START_RADIUS: W.BLIGHT_START_RADIUS, CORRUPT_TIME: W.CORRUPT_TIME, CLEANSE_TIME: W.CLEANSE_TIME,
    PACK_PERCEPTION: HMG.PACK_PERCEPTION, PACK_SPEED: HMG.PACK_SPEED,
  };
}

console.log('=== a hundred in-game days: the world keeps its rules ===');
const secOf = (id) => Number(String(id).split(':')[0]);
function longHunt({ zoneId, size, seed, days = 100, planMods = {}, onStep = null, party = makeParty() }) {
  const world = recordingWorld(party);
  let h = createMapHunt(zoneId, { plan: { objective: 'scout', size, mods: planMods }, supplies: 200, seed }, world);
  const pick = makeRng(seed ^ 0xbeef);
  const stood = new Set([h.getState().pos]);
  const s0 = h.getState();
  const home = Object.fromEntries(s0.map.occupants.map(o => [o.id, { tile: o.tile, sec: secOf(o.tile), state: o.state }]));
  const startCount = s0.map.occupants.length;
  const problems = [], trace = [], encounters = [];
  let lastWorld = 0, seen = new Set(Object.keys(s0.fog));
  const tally = { steps: 0, encounters: 0, ambush: 0, byCause: { party: 0, pack: 0, camp: 0 }, flees: 0, wins: 0, caughtAgain: 0, cleansed: 0, trailsSeen: 0 };
  let fledFrom = null;
  for (let i = 0; i < 20000 && h.getState().time < days * 12; i++) {
    if (onStep) h = onStep(h, i, world) || h;
    const before = h.getState();
    const r = pick();
    let res, kind;
    const onBlight = before.map.tiles[before.pos].ground === 'blight';
    if (onBlight && r < 0.3) { kind = 'cleanse'; res = h.cleanse(); if (res.ok) tally.cleansed++; }
    else if (r < 0.4) { kind = 'camp'; res = h.camp(); }
    else if (r < 0.45) { kind = 'forage'; res = h.forage(); }
    else {
      kind = 'move';
      const to = chooseMove(h, pick, stood); stood.add(to);
      res = h.move(to);
    }
    const s = h.getState();
    tally.steps++;
    // --- the encounter, if one started ---
    const e = h.encounter();
    if (e) {
      tally.encounters++; tally.byCause[e.cause]++; if (e.ambush) tally.ambush++;
      if (fledFrom && e.occId === fledFrom && e.cause === 'pack') tally.caughtAgain++;
      encounters.push(e);
      if (e.ambush !== (e.cause === 'camp' || e.knew === 'nothing')) problems.push(`step ${i}: ambush ${e.ambush} but cause ${e.cause}, knew ${e.knew}`);
      if (e.first !== W.whoActsFirst(e)) problems.push(`step ${i}: first ${e.first} disagrees with whoActsFirst`);
      const occ = s.map.occupants.find(o => o.id === e.occId);
      if (!occ || occ.tile !== s.pos) problems.push(`step ${i}: the encounter's occupant is not on the party's tile`);
      if (!occ?.loadout || occ.loadout.length !== occ.roster.length) problems.push(`step ${i}: the encounter's occupant has no loadout (chunk 9a)`);
      if (Math.abs(e.enemyInitiative - B.occupantInitiative(occ)) > EPS) problems.push(`step ${i}: enemy initiative is not occupantInitiative`);
      // Frozen: every action is refused and changes nothing.
      const frozenBefore = JSON.stringify(noIds(h.serialize()));
      const tries = [h.move(mapNeighbors(s.map, s.pos)[0]), h.camp(), h.forage(), h.fish(), h.scout(e.occId), h.cleanse(), h.eat('bitterroot')];
      if (tries.some(t => t.ok) || JSON.stringify(noIds(h.serialize())) !== frozenBefore) problems.push(`step ${i}: the hunt was not frozen during a fight`);
      if (pick() < 0.5) {
        const fromTile = s.from;
        const f = h.flee();
        tally.flees++; fledFrom = e.occId;
        const sf = h.getState();
        const pack = sf.map.occupants.find(o => o.id === e.occId);
        if (!f.ok || !f.enemyFreeRound) problems.push(`step ${i}: flee refused or no free round`);
        if (pack?.kind === 'beast' && !(pack.alerted)) problems.push(`step ${i}: the pack fled from was not alerted`);
        if (sf.supplies !== s.supplies) problems.push(`step ${i}: fleeing cost supplies`);
        if (e.cause === 'party' && f.to && f.to !== fromTile) problems.push(`step ${i}: fled to ${f.to}, came from ${fromTile}`);
        for (let k = 0; k < 5 && h.encounter(); k++) h.winEncounter();
      } else {
        const n = h.getState().map.occupants.length;
        const wr = h.winEncounter();
        tally.wins++;
        if (!wr.ok || h.getState().map.occupants.length !== n - 1) problems.push(`step ${i}: a win did not remove exactly one occupant`);
      }
    }
    const s2 = h.getState();
    // --- the world's invariants ---
    if (s2.map.occupants.length + s2.kills.length !== startCount) problems.push(`step ${i}: occupants + kills ${s2.map.occupants.length + s2.kills.length} != ${startCount} (a spawn, or a loss)`);
    // One HOSTILE occupant per tile. A Hunting pack that catches the party on an
    // event site fights it there, so a pack and an event may share a tile.
    const tiles = s2.map.occupants.filter(o => o.kind !== 'event').map(o => o.tile);
    if (new Set(tiles).size !== tiles.length) problems.push(`step ${i}: two hostile occupants on one tile`);
    for (const o of s2.map.occupants) {
      const hm = home[o.id];
      if (o.kind !== 'beast' && o.tile !== hm.tile) problems.push(`step ${i}: ${o.kind} ${o.id} moved`);
      if (o.kind === 'beast' && !o.alerted && hm.state === 'rooted' && o.tile !== hm.tile) problems.push(`step ${i}: rooted ${o.id} moved`);
      if (o.kind === 'beast' && !o.alerted && secOf(o.tile) !== hm.sec) problems.push(`step ${i}: roaming ${o.id} left its section`);
      if (!isPassable(s2.map.tiles[o.tile])) problems.push(`step ${i}: ${o.id} on impassable ground`);
      if (o.mark === 'corrupted' && o.concealment !== HMG.OCCUPANT_CONCEALMENT.corrupted) problems.push(`step ${i}: corrupted ${o.id} kept its old concealment`);
    }
    for (const o of s0.map.occupants) {
      const now = s2.map.occupants.find(x => x.id === o.id);
      if (now && o.mark && now.mark !== o.mark && !(o.mark === 'unmarked' && now.mark === 'corrupted')) problems.push(`step ${i}: ${o.id} went ${o.mark} -> ${now.mark}`);
    }
    if (s2.world.time < lastWorld - EPS) problems.push(`step ${i}: the world clock went back`);
    if (s2.world.time > s2.time + EPS) problems.push(`step ${i}: the world ran ahead of the hunt`);
    if (res?.ok && !h.encounter() && kind !== 'eat' && Math.abs(s2.world.time - s2.time) > EPS && !e) problems.push(`step ${i}: the world did not catch up (${s2.world.time} vs ${s2.time})`);
    lastWorld = s2.world.time;
    const living = s2.map.features.filter(f => f.kind === 'blight_source' && !f.destroyed).map(f => f.tile);
    for (const [id, t] of Object.entries(s2.map.tiles)) {
      if (t.ground !== 'blight' || !t.blightedFrom) continue;   // spread-made blight
      const p = parseTileId(id);
      if (!s2.map.features.some(f => f.kind === 'blight_source' && secOf(f.tile) === p.section
        && distance(parseTileId(f.tile), p) <= W.BLIGHT_START_RADIUS + s2.world.day)) problems.push(`step ${i}: blight at ${id} out of any source's reach`);
    }
    if (!living.length) {
      const nowBlight = Object.values(s2.map.tiles).filter(t => t.ground === 'blight').length;
      const was = Object.values(before.map.tiles).filter(t => t.ground === 'blight').length;
      if (nowBlight > was) problems.push(`step ${i}: blight spread with no living source`);
    }
    for (const id of seen) if (!s2.fog[id]) problems.push(`step ${i}: fog un-revealed ${id}`);
    seen = new Set(Object.keys(s2.fog));
    if (s2.supplies < 0) problems.push(`step ${i}: supplies negative`);
    if (party.some(c => c.currentHP < 1)) problems.push(`step ${i}: a hunter below 1 HP`);
    tally.trailsSeen += h.view().trails.length;
    trace.push([kind, res?.ok ? 1 : 0, s2.pos, r4(s2.time), e ? `${e.occId}:${e.cause}:${e.first}` : 0,
      s2.map.occupants.filter(o => o.kind === 'beast').map(o => `${o.id}@${o.tile}:${o.state[0]}${o.mark === 'corrupted' ? '*' : ''}`).join(' ')]);
  }
  const s = h.getState();
  tally.days = R.clockAt(s.time).day;
  tally.blightTiles = Object.values(s.map.tiles).filter(t => t.ground === 'blight').length;
  tally.corrupted = s.map.occupants.filter(o => o.mark === 'corrupted').length;
  tally.stillHunting = s.map.occupants.filter(o => o.state === 'hunting').length;
  return { h, trace, problems, tally, encounters };
}

const { parseTileId, distance } = await import('../../src/systems/HexGrid.js');
{
  const probs = [], hashes = {}, tallies = {};
  let allEnc = [];
  for (const zoneId of ZONES) {
    for (const size of SIZES) {
      const hsh = crypto.createHash('sha256');
      const agg = {};
      for (let k = 0; k < 6; k++) {
        const planMods = k % 2 ? { blightPatches: 2, restlessPercent: 25 } : {};
        const L = longHunt({ zoneId, size, seed: 9000 + k, planMods });
        probs.push(...L.problems.map(p => `${zoneId}/${size} ${9000 + k}: ${p}`));
        hsh.update(JSON.stringify(L.trace));
        allEnc = allEnc.concat(L.encounters);
        for (const [key, v] of Object.entries(L.tally)) {
          if (typeof v === 'object') { agg[key] = agg[key] || {}; for (const [a, b] of Object.entries(v)) agg[key][a] = (agg[key][a] || 0) + b; }
          else agg[key] = (agg[key] || 0) + v;
        }
        if (zoneId === ZONES[0] && size === 'medium' && k === 1) golden['world reeds medium 9001 (first 60 steps)'] = L.trace.slice(0, 60);
      }
      hashes[`${zoneId}/${size}`] = hsh.digest('hex').slice(0, 16);
      tallies[`${zoneId}/${size}`] = agg;
    }
  }
  check('36 hunts x 100 in-game days: no spawns, one hostile occupant per tile, rooted stay, roamers keep their section, the world never runs ahead or falls behind, blight only within a living source\'s reach, marks only turn corrupted',
    probs.length === 0, probs.slice(0, 3).join(' | '));
  check('every encounter: ambush exactly when the party knew nothing or a camp was found; who goes first is whoActsFirst; the hunt is frozen until it is won or fled',
    probs.length === 0 && allEnc.length > 0, `${allEnc.length} encounters`);
  const kinds = { identifiedNotAmbush: allEnc.some(e => e.knew === 'identified' && !e.ambush), ambushEnemyFirst: allEnc.some(e => e.ambush && e.first === 'enemy'),
    packCame: allEnc.some(e => e.cause === 'pack'), campFound: allEnc.some(e => e.cause === 'camp'), partyFirst: allEnc.some(e => e.first === 'party') };
  check('seen in play: identified contacts, ambushes, packs that came, camps found, parties acting first', Object.values(kinds).every(Boolean), JSON.stringify(kinds));
  golden.worldHashes = hashes;
  golden.worldTallies = tallies;
  for (const [k, v] of Object.entries(tallies)) console.log(`    ${k}: ${JSON.stringify(v)}`);

  // Determinism and reload over a long world run.
  const a = longHunt({ zoneId: ZONES[0], size: 'large', seed: 9100, days: 30, planMods: { blightPatches: 2, restlessPercent: 25 } });
  const b = longHunt({ zoneId: ZONES[0], size: 'large', seed: 9100, days: 30, planMods: { blightPatches: 2, restlessPercent: 25 } });
  check('the same seed and script give the same world, twice', same(a.trace, b.trace) && same(noIds(a.h.serialize()), noIds(b.h.serialize())));
  let bad = 0;
  for (const at of [3, 40, 111, 200]) {
    const c = longHunt({ zoneId: ZONES[0], size: 'large', seed: 9100, days: 30, planMods: { blightPatches: 2, restlessPercent: 25 },
      onStep: (hunt, i, world) => (i === at ? restoreMapHunt(JSON.parse(JSON.stringify(hunt.serialize())), world) : null) });
    if (!same(c.trace, a.trace) || !same(noIds(c.h.serialize()), noIds(a.h.serialize()))) bad++;
  }
  check('reload anywhere in 30 days of world continues identically (both streams saved)', bad === 0, `${bad} of 4 differ`);
}

/** Build a scene through the save: edit serialized state, restore it. The
 *  rules then run on it as they would on any hunt. Test setup only. */
function scene(zoneId, seed, edit, { party = makeParty(), size = 'medium', planMods = {} } = {}) {
  const h0 = createMapHunt(zoneId, { plan: { objective: 'scout', size, mods: planMods }, supplies: 100, seed }, recordingWorld(party));
  const d = h0.serialize();
  edit(d);
  const world = recordingWorld(party);
  return { h: restoreMapHunt(d, world), party, world };
}

/** An open land tile and a neighbour of it, same section, both passable, not the entry, nothing on them. */
function openPair(d, ground) {
  const taken = new Set(d.map.occupants.map(o => o.tile));
  for (const id of Object.keys(d.map.tiles).sort()) {
    const t = d.map.tiles[id];
    if (!isPassable(t) || t.ford || taken.has(id) || id === d.pos) continue;
    const n = mapNeighbors(d.map, id).find(x => isPassable(d.map.tiles[x]) && !d.map.tiles[x].ford && !taken.has(x) && x !== d.pos && secOf(x) === secOf(id));
    if (!n) continue;
    if (ground) { t.ground = ground; t.relief = 'flat'; delete t.blightedFrom; }
    return [id, n];
  }
  return null;
}

console.log('=== found in camp ===');
{
  const campWith = (ground, { lowProfile = false } = {}) => {
    const party = makeParty();
    if (lowProfile) party.find(c => c.baseClass === 'Beggar').exploration = { picks: { 2: { passive: 'low_profile' } } };
    let packId = null;
    const { h } = scene(ZONES[0], 9200, (d) => {
      const [camp, next] = openPair(d, ground);
      d.pos = camp; d.from = null;
      const beast = d.map.occupants.find(o => o.kind === 'beast');
      packId = beast.id;
      beast.tile = next;
      W.alert(beast, d.time);
      d.world.time = d.time;
      for (const o of d.map.occupants) if (o !== beast && o.kind === 'beast') { o.state = 'rooted'; o.home = 'rooted'; o.nextStepAt = null; }
    }, { party });
    party.forEach(c => { c.currentHP = 1; });
    const r = h.camp();
    return { r, h, packId, party };
  };
  const open = campWith('grass');
  check(`camping on grass (${GROUNDS.grass.concealment}): a hunting pack finds it; ambush, enemy first, the camp broken off`,
    open.r.ok && open.r.found && open.r.encounter?.cause === 'camp' && open.r.encounter.ambush && open.r.encounter.first === 'enemy'
    && open.r.time < R.CAMP_TIME, `slept ${r4(open.r.time)} of ${R.CAMP_TIME}`);
  check('a broken-off camp recovers only the share slept',
    Math.abs(open.r.recoveryPercent - R.campRecoveryPercent(open.r.night) * open.r.time / R.CAMP_TIME) < EPS);
  const hidden = campWith('thicket');
  check(`camping in a thicket (${GROUNDS.thicket.concealment}): not found, the full camp, no fight`,
    hidden.r.ok && !hidden.r.found && hidden.r.time === R.CAMP_TIME && !hidden.h.encounter());
  const heath = campWith('heath');
  const heathLP = campWith('heath', { lowProfile: true });
  check(`heath (${GROUNDS.heath.concealment}) is found; Low Profile (+20) hides the same camp`,
    heath.r.found && !heathLP.r.found && heathLP.r.time === R.CAMP_TIME);
}

console.log('=== flee, pursuit and losing the trail ===');
{
  const runAway = (h, packId) => {
    // Each move: the open neighbour furthest from the pack (the harness's own choice).
    for (let k = 0; k < 40; k++) {
      const s = h.getState();
      const pack = s.map.occupants.find(o => o.id === packId);
      if (!pack) return 'gone';
      if (pack.state !== 'hunting') return 'lost';
      const opts = mapNeighbors(s.map, s.pos).filter(n => isPassable(s.map.tiles[n]) && !s.map.occupants.some(o => o.tile === n)).sort();
      if (!opts.length) return 'cornered';
      const far = (id) => (secOf(id) === secOf(pack.tile) ? distance(parseTileId(id), parseTileId(pack.tile)) : 99);
      const to = opts.reduce((best, n) => (far(n) > far(best) ? n : best), opts[0]);
      h.move(to);
      const e = h.encounter();
      if (e) { const again = e.occId === packId && e.cause === 'pack'; h.winEncounter(); if (again) return 'caught'; }
    }
    return 'still hunting';
  };
  const fast = () => {
    const p = makeParty();
    p.forEach(c => { c.level = 10; c.exploration = { picks: { 2: { rating: 'speed' }, 4: { rating: 'speed' }, 6: { rating: 'speed' }, 8: { rating: 'speed' }, 10: { rating: 'speed' } } }; });
    return p;
  };
  const outcomes = { normal: {}, fast: {} };
  let checkedFlee = false;
  for (const [label, mkParty] of [['normal', makeParty], ['fast', fast]]) {
    for (let k = 0; k < 120; k++) {
      const zoneId = ZONES[k % 2];
      const party = mkParty();
      const h = createMapHunt(zoneId, { plan: { objective: 'scout', size: 'large' }, supplies: 200, seed: 9300 + k }, recordingWorld(party));
      const pick = makeRng(9300 + k);
      const stood = new Set([h.getState().pos]);
      let e = null;
      for (let i = 0; i < 80 && !e; i++) {
        const to = chooseMove(h, pick, stood); stood.add(to);
        h.move(to);
        e = h.encounter();
        if (e && (e.kind !== 'beast' || e.cause !== 'party')) { h.winEncounter(); e = null; }
      }
      if (!e) continue;
      const before = h.getState();
      const f = h.flee();
      const after = h.getState();
      if (!checkedFlee) {
        checkedFlee = true;
        const pack = after.map.occupants.find(o => o.id === e.occId);
        const cost = R.moveCost(after.map.tiles[before.from], h.stats()).time;
        check('flee: back to the tile it came from, one move of time, no supplies, the pack stays and hunts',
          f.ok && after.pos === before.from && Math.abs(f.time - cost) < EPS && after.supplies === before.supplies
          && pack && pack.tile === before.pos && pack.alerted && after.flees === 1);
        check(`flee: the hunting pack's first step waits for the end of the retreat + ${W.HUNT_STEP}`,
          !pack || pack.state !== 'hunting' || pack.nextStepAt >= before.time + f.time + W.HUNT_STEP - EPS || h.encounter());
      }
      if (h.encounter()) { h.winEncounter(); outcomes[label].caughtAtOnce = (outcomes[label].caughtAtOnce || 0) + 1; continue; }
      const o = runAway(h, e.occId);
      outcomes[label][o] = (outcomes[label][o] || 0) + 1;
    }
  }
  const fastSpeed = partyStats(fast(), {}).speed;
  console.log(`    pursuit after a flee, running away (party Speed ${r4(partyStats(makeParty(), {}).speed)} vs fast ${r4(fastSpeed)}; pack ${HMG.PACK_SPEED}):`);
  console.log(`      normal: ${JSON.stringify(outcomes.normal)}`);
  console.log(`      fast:   ${JSON.stringify(outcomes.fast)}`);
  check('some fled packs lose the trail, some catch up: pursuit is a race, not a certainty',
    (outcomes.normal.lost || 0) + (outcomes.fast.lost || 0) > 0 && (outcomes.normal.caught || 0) + (outcomes.fast.caught || 0) > 0);
  check('a party faster than the pack shakes it off more often', (outcomes.fast.lost || 0) / Object.values(outcomes.fast).reduce((a, b) => a + b, 0)
    > (outcomes.normal.lost || 0) / Object.values(outcomes.normal).reduce((a, b) => a + b, 0));
  golden.pursuit = outcomes;

  // A reload with a fight pending is a flee.
  let reloadOk = false;
  for (let k = 0; k < 60 && !reloadOk; k++) {
    const party = makeParty();
    const world = recordingWorld(party);
    const h = createMapHunt(ZONES[0], { plan: { objective: 'scout', size: 'medium' }, supplies: 100, seed: 9500 + k }, world);
    const pick = makeRng(9500 + k), stood = new Set([h.getState().pos]);
    for (let i = 0; i < 60 && !h.encounter(); i++) { const to = chooseMove(h, pick, stood); stood.add(to); h.move(to); }
    const e = h.encounter();
    if (!e || e.cause !== 'party' || e.kind !== 'beast') continue;
    const d = h.serialize();
    const r = restoreMapHunt(JSON.parse(JSON.stringify(d)), world);
    const s = r.getState();
    reloadOk = s.flees === 1 && s.pos === d.from && s.map.occupants.find(o => o.id === e.occId)?.alerted && s.log.some(l => l.kind === 'flee' && l.reason === 'reload');
  }
  check('a hunt reloaded mid-fight comes back fled: retreated, the pack alerted, logged as a reload', reloadOk);
}

console.log('=== blight, cleansing and corruption ===');
{
  // A Blighted map, the party put on a spread-made blight tile inside a living source's reach.
  const bh = createMapHunt(ZONES[0], { plan: { objective: 'scout', size: 'medium', mods: { blightPatches: 1 } }, supplies: 200, seed: 9600 }, recordingWorld(makeParty()));
  const d = bh.serialize();
  const src = d.map.features.find(f => f.kind === 'blight_source');
  check('a Blighted plan places a source', !!src);
  if (src) {
    const ring1 = mapNeighbors(d.map, src.tile).find(id => d.map.tiles[id].ground === 'blight' && !d.map.occupants.some(o => o.tile === id));
    const world = recordingWorld(makeParty());
    const h = restoreMapHunt({ ...d, pos: ring1, from: null }, world);
    const before = h.getState();
    const c = h.cleanse();
    const after = h.getState();
    check('cleanse: the tile goes back to land (the region\'s main ground when the generator painted it), CLEANSE_TIME passes',
      c.ok && after.map.tiles[ring1].ground === after.landGround && Math.abs(after.time - before.time - W.CLEANSE_TIME) < EPS
      && after.cleansed.includes(ring1) && !c.sourceDestroyed);
    check('cleanse: refused where there is no blight', !h.cleanse().ok);
    const countBlight = (x) => Object.values(x.map.tiles).filter(t => t.ground === 'blight').length;
    const n0 = countBlight(after);
    while (h.getState().world.day < after.world.day + 1) h.camp();
    const a1 = h.getState();
    check('the next day, blight spreads a ring and takes the cleansed tile back while its source lives',
      a1.map.tiles[ring1].ground === 'blight' && countBlight(a1) > n0, `${n0} -> ${countBlight(a1)} tiles`);
    // Now kill the source.
    const h2 = restoreMapHunt({ ...h.serialize(), pos: src.tile, from: null, encounter: null }, recordingWorld(makeParty()));
    const k = h2.cleanse();
    const n1 = countBlight(h2.getState());
    for (let day = h2.getState().world.day, i = 0; h2.getState().world.day < day + 3 && i < 50; i++) h2.camp();
    check('cleansing the source\'s tile destroys it; after three more days the blight has not grown',
      k.ok && k.sourceDestroyed && countBlight(h2.getState()) <= n1, `${n1} -> ${countBlight(h2.getState())}`);
    golden.blightExample = { ring1, before: n0, nextDay: countBlight(a1), afterSourceKilled: countBlight(h2.getState()) };
  }

  // Corruption: an unmarked beast standing in blight turns; a marked one never.
  const turn = (mark) => {
    let id = null;
    const { h } = scene(ZONES[0], 9700, (dd) => {
      const [tile] = openPair(dd, 'blight');
      const beast = dd.map.occupants.find(o => o.kind === 'beast');
      id = beast.id;
      beast.tile = tile; beast.mark = mark; beast.state = 'rooted'; beast.home = 'rooted'; beast.nextStepAt = null; beast.blightSince = null;
      dd.world.time = dd.time;
    });
    for (let i = 0; i < 5; i++) h.camp();
    return h.getState().map.occupants.find(o => o.id === id);
  };
  const u = turn('unmarked'), m = turn('marked');
  check(`corruption: an unmarked beast in blight for ${W.CORRUPT_TIME} turns corrupted, concealment ${HMG.OCCUPANT_CONCEALMENT.corrupted}`,
    u.mark === 'corrupted' && u.concealment === HMG.OCCUPANT_CONCEALMENT.corrupted && Number.isFinite(u.corruptedAt));
  check('corruption: a marked beast in blight never turns', m.mark === 'marked');
}

console.log('=== trails and Restless ===');
{
  let seenTrails = 0, fadedOk = true, bandOk = true;
  for (let k = 0; k < 10; k++) {
    const h = createMapHunt(ZONES[k % 2], { plan: { objective: 'scout', size: 'medium', mods: { restlessPercent: 50 } }, supplies: 200, seed: 9800 + k }, recordingWorld(makeParty()));
    for (let i = 0; i < 8; i++) h.camp();
    const s = h.getState(), st = h.stats(), v = h.view();
    for (const t of Object.values(s.trails)) if (s.world.time - t.at > W.TRAIL_TIME + EPS) fadedOk = false;
    for (const tv of v.trails) {
      seenTrails++;
      const real = W.trailView(s.trails[tv.tile], s.map.tiles[tv.tile].ground, st.perception, s.time);
      if (!same({ tile: tv.tile, ...real }, tv)) bandOk = false;
    }
  }
  check('packs that move leave trails; none older than TRAIL_TIME is kept', fadedOk && seenTrails > 0, `${seenTrails} trails in sight`);
  check('the trails in view are exactly what trailView reads for this party', bandOk);

  let rootedPlain = 0, rootedRestless = 0, quarryMoved = 0;
  for (let k = 0; k < 60; k++) {
    for (const [pct, add] of [[0, (n) => { rootedPlain += n; }], [30, (n) => { rootedRestless += n; }]]) {
      const h = createMapHunt(ZONES[k % 2], { plan: { objective: 'apex', size: 'medium', mods: { restlessPercent: pct } }, supplies: 60, seed: 9900 + k }, recordingWorld(makeParty()));
      const occ = h.getState().map.occupants.filter(o => o.kind === 'beast');
      add(occ.filter(o => o.state === 'rooted').length);
      if (occ.some(o => o.quarry && o.state !== 'rooted')) quarryMoved++;
    }
  }
  check('Restless 30 turns a share of Rooted packs Roaming; the plan\'s quarry never', rootedRestless < rootedPlain && quarryMoved === 0,
    `rooted packs over 60 maps: ${rootedPlain} -> ${rootedRestless}`);
  golden.restless = { rootedPlain, rootedRestless };
}

// =============================================================================
// 7d: objectives, exit, wipe, the completion reward
// =============================================================================
const O = await import('../../src/systems/HuntObjectives.js');
const { PRIMARY_OBJECTIVES } = HMG;
const { BONUS_OBJECTIVES, PLAN_TIER_IMPLICITS, planTierFor } = await import('../../data/planAffixes.js');
const { FORAGE_YIELDING } = await import('../../data/grounds.js');

/** A world that also records Hunt Points paid and items banked. */
function payingWorld(party) {
  const w = recordingWorld(party);
  w.paid = []; w.banked = [];
  w.awardHuntPoints = (n) => { w.paid.push(n); };
  w.bankItems = (items, { found }) => { w.banked.push({ found, items: items.map(i => `${i.id}x${i.qty || 1}`) }); };
  return w;
}

console.log('=== 7d rules ===');
{
  check('every objective the plans can ask for has a completion check',
    [...Object.keys(PRIMARY_OBJECTIVES), ...Object.keys(BONUS_OBJECTIVES)].every(id => O.CHECKED_OBJECTIVES.includes(id)));
  check('completion percent = the plan\'s prefixes + its tier implicit',
    O.completionRewardPercent({ completionRewardPercent: 15 }, 8) === 15 + PLAN_TIER_IMPLICITS[3].completionRewardPercent
    && O.completionRewardPercent({}, 1) === 0 && O.completionRewardPercent({}, 5) === PLAN_TIER_IMPLICITS[2].completionRewardPercent);
  check('completion reward: 20 / 35 / 50 by size, scaled by the percent, whole points',
    O.completionReward('small', 0) === 20 && O.completionReward('medium', 0) === 35 && O.completionReward('large', 0) === 50
    && O.completionReward('small', 35) === 27);
  check(`bonus reward: ${O.BONUS_HUNT_POINTS_PER_ITEM_LEVEL} per plan item level`, O.bonusReward(1) === 5 && O.bonusReward(8) === 40);
  golden.leaving7d = { COMPLETION_HUNT_POINTS: O.COMPLETION_HUNT_POINTS, BONUS_HUNT_POINTS_PER_ITEM_LEVEL: O.BONUS_HUNT_POINTS_PER_ITEM_LEVEL, PENDING_UNTIL: O.PENDING_UNTIL };
}

/**
 * The harness's solver: a simple strategy that uses TRUE positions from the
 * state (it is proving objectives completable, not playing fair). It walks the
 * shortest path to what the next unfinished objective needs, wins every fight
 * (combat is chunk 9), then walks to the nearest exit and leaves.
 */
function nextStep(h, isGoal, { avoid = true } = {}) {
  const s = h.getState();
  const hostileAt = new Set(s.map.occupants.filter(o => o.kind !== 'event').map(o => o.tile));
  const prev = new Map([[s.pos, null]]);
  const queue = [s.pos];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    if (id !== s.pos && isGoal(id)) {
      let at = id;
      while (prev.get(at) !== s.pos) at = prev.get(at);
      return at;
    }
    for (const n of [...mapNeighbors(s.map, id)].sort()) {
      if (prev.has(n) || !isPassable(s.map.tiles[n])) continue;
      if (avoid && hostileAt.has(n) && !isGoal(n)) continue;
      prev.set(n, id);
      queue.push(n);
    }
  }
  return avoid ? nextStep(h, isGoal, { avoid: false }) : null;
}

function solve({ zoneId, size, objective = 'scout', bonus = [], seed, planMods = {}, itemLevel = 5, party = makeParty(), maxActions = 900 }) {
  const world = payingWorld(party);
  const h = createMapHunt(zoneId, { plan: { objective, size, bonusObjectives: bonus, mods: planMods, itemLevel }, supplies: 400, seed }, world);
  const exitTiles = new Set(h.getState().map.exits);
  let stuck = null;
  for (let i = 0; i < maxActions; i++) {
    if (h.encounter()) { h.winEncounter(); continue; }
    const s = h.getState();
    const prog = h.objectives();
    const open = prog.find(p => !p.done && !p.pending && !(p.id === 'swift_return') && !(p.carriedHome && p.have >= p.need));
    let step = null;
    if (open) {
      const o = open.kind === 'primary' ? s.map.objectives.primary : s.map.objectives.bonus.find(b => b.id === open.id);
      const occs = s.map.occupants;
      switch (open.id) {
        case 'scout': step = nextStep(h, id => o.sites.includes(id) && !s.fog[id]); break;
        case 'apex': step = nextStep(h, id => occs.some(x => x.id === o.occupant && x.tile === id)); break;
        case 'cull': case 'named_quarry': step = nextStep(h, id => occs.some(x => x.kind === 'beast' && x.family === o.family && x.tile === id)); break;
        case 'retrieve': case 'commune': step = nextStep(h, id => id === o.site); break;
        case 'pathfinder': step = nextStep(h, id => !s.fog[id]) || nextStep(h, id => mapNeighbors(s.map, id).some(n => !s.fog[n])); break;
        case 'great_quarry': step = nextStep(h, id => occs.some(x => x.kind === 'beast' && x.tile === id && x.roster.some(m => m.grade === 'great'))); break;
        case 'provisioner': {
          const t = s.map.tiles[s.pos];
          const canForage = !s.gathered[s.pos] && !t.barren && (R.FORAGE_YIELD[GROUNDS[t.ground].forage] || 0) > 0 && R.forageCandidates(Items, t.ground).length > 0;
          if (canForage) { h.forage(); continue; }
          if (!s.gathered[s.pos] && t.fishing && !t.barren) { h.fish(); continue; }
          step = nextStep(h, id => { const x = s.map.tiles[id]; return !s.gathered[id] && !x.barren && (x.fishing || FORAGE_YIELDING.includes(GROUNDS[x.ground].forage)); });
          break;
        }
        case 'cleanse': {
          if (s.map.tiles[s.pos].ground === 'blight') { h.cleanse(); continue; }
          step = nextStep(h, id => s.map.tiles[id].ground === 'blight');
          break;
        }
        case 'unmask': {
          const hid = occs.filter(x => occupantConcealment(s.map, x) > 100 && !s.unmasked.includes(x.id));
          const sensed = hid.find(x => s.sightings[x.id]?.band === 'sensed' && s.sightings[x.id].tile === x.tile && s.fog[x.tile] === 'visible');
          if (sensed) { h.scout(sensed.id); continue; }
          step = nextStep(h, id => hid.some(x => mapNeighbors(s.map, x.tile).includes(id)));
          break;
        }
        default: stuck = `no strategy for ${open.id}`;
      }
      if (stuck) break;
    } else {
      if (exitTiles.has(s.pos)) {
        const r = h.exit();
        return { h, world, exited: r.ok, r, actions: i };
      }
      step = nextStep(h, id => exitTiles.has(id));
    }
    if (!step) { stuck = `no path (${open ? open.id : 'exit'})`; break; }
    h.move(step);
  }
  return { h, world, exited: false, stuck: stuck || 'ran out of actions' };
}
const { occupantConcealment } = await import('../../src/systems/HuntMapGen.js');

console.log('=== every objective is completable and pays at the exit ===');
{
  const table = {}, fails = [];
  // Primaries: every zone, size, objective.
  for (const zoneId of ZONES) {
    for (const size of SIZES) {
      for (const objective of Object.keys(PRIMARY_OBJECTIVES)) {
        const row = { runs: 0, done: 0, days: 0, huntPoints: 0 };
        for (let k = 0; k < 6; k++) {
          const itemLevel = 1 + (k % 10);
          const planMods = { completionRewardPercent: k % 2 ? 9 : 0 };
          const r = solve({ zoneId, size, objective, seed: 10000 + k, itemLevel, planMods });
          row.runs++;
          const want = O.completionReward(size, O.completionRewardPercent(planMods, itemLevel));
          if (r.exited && r.r.reward.primaryDone && r.r.reward.completion === want && r.world.paid.reduce((a, b) => a + b, 0) === r.r.reward.huntPoints) {
            row.done++; row.days += R.clockAt(r.h.getState().time).day; row.huntPoints += r.r.reward.huntPoints;
          } else fails.push(`${zoneId}/${size}/${objective} ${10000 + k}: ${r.stuck || JSON.stringify(r.r?.reward?.progress?.[0])}`);
        }
        row.avgDay = row.done ? r4(row.days / row.done) : null; delete row.days;
        table[`${objective} ${zoneId}/${size}`] = row;
      }
    }
  }
  check('all 5 primaries x 2 regions x 3 sizes x 6 seeds: completed, left, and paid exactly completionReward', fails.length === 0, fails.slice(0, 3).join(' | '));
  // Bonuses, on a Scout plan.
  const bonusFails = [], pendingOk = [];
  for (const id of Object.keys(BONUS_OBJECTIVES)) {
    const row = { runs: 0, done: 0 };
    for (const zoneId of ZONES) {
      for (const size of SIZES) {
        for (let k = 0; k < 3; k++) {
          if (id === 'unmask') continue;   // measured on its own below: it depends on Perception
          const r = solve({ zoneId, size, bonus: [id], seed: 11000 + k, itemLevel: 8 });
          row.runs++;
          const b = r.r?.reward?.progress?.find(p => p.id === id);
          if (O.PENDING_UNTIL[id]) {
            pendingOk.push(!!b?.pending && !b.done && !r.r.reward.bonuses.some(x => x.id === id));
            continue;
          }
          if (r.exited && b?.done && r.r.reward.bonuses.some(x => x.id === id && x.huntPoints === O.bonusReward(8))) row.done++;
          else bonusFails.push(`${id} ${zoneId}/${size} ${11000 + k}: ${r.stuck || JSON.stringify(b)}`);
        }
      }
    }
    table[`bonus ${id}`] = row;
  }
  check('every bonus objective the engine can check: completed on every map and paid its reward at the exit',
    bonusFails.length === 0, bonusFails.slice(0, 3).join(' | '));
  check('Trophy and Unbroken report pending (chunk 9) and are never done or paid', pendingOk.length > 0 && pendingOk.every(Boolean));
  // Unmask, at the best Perception the game can reach today: a level-10
  // Ferrow Shepherd with five Perception picks (100) and a T1 of Keen Eyes (+20).
  {
    const eyes = () => { const p = makeParty(); const s = p.find(c => c.baseClass === 'Shepherd');
      s.level = 10; s.exploration = { picks: { 2: { rating: 'perception' }, 4: { rating: 'perception' }, 6: { rating: 'perception' }, 8: { rating: 'perception' }, 10: { rating: 'perception' } } }; return p; };
    const best = partyStats(eyes(), { perceptionBonus: 20 }).perception;
    let runs = 0, done = 0, reachableButFailed = 0;
    const concs = [];
    for (const zoneId of ZONES) for (const size of SIZES) for (let k = 0; k < 10; k++) {
      const r = solve({ zoneId, size, bonus: ['unmask'], seed: 11000 + k, itemLevel: 8, planMods: { perceptionBonus: 20 }, party: eyes() });
      runs++;
      const s0 = createMapHunt(zoneId, { plan: { objective: 'scout', size, bonusObjectives: ['unmask'], itemLevel: 8 }, supplies: 1, seed: 11000 + k }, recordingWorld(makeParty())).getState();
      // Only occupants that stay put can be counted on: a roaming beast in a
      // thicket is hidden past 100 only until it walks out of it.
      const hidden = s0.map.occupants.filter(o => (o.kind === 'cultist' || o.state === 'rooted') && occupantConcealment(s0.map, o) > 100).map(o => occupantConcealment(s0.map, o));
      const reachable = hidden.some(c => c <= best + R.SENSED_MARGIN);
      concs.push(...hidden);
      const b = r.r?.reward?.progress?.find(p => p.id === 'unmask');
      if (r.exited && b?.done) done++;
      else if (reachable) reachableButFailed++;
    }
    check(`Unmask: completed on every map where an occupant that stays put is hidden within reach (Perception ${best} + ${R.SENSED_MARGIN} to scout it)`,
      reachableButFailed === 0);
    // Chunk 8 (owner): Unmask's band is capped at the best reachable
    // Perception + SENSED_MARGIN, so it can be done on EVERY map. The cap is a
    // data constant; if the Perception ceiling moves, this fails until someone
    // decides what the cap should be.
    check(`Unmask's cap (${HMG.UNMASK_MAX_CONCEALMENT}) is the best reachable Perception (${best}) + SENSED_MARGIN (${R.SENSED_MARGIN})`,
      HMG.UNMASK_MAX_CONCEALMENT === best + R.SENSED_MARGIN);
    check(`Unmask: completed on every map at the best reachable Perception (${best})`, done === runs,
      `${done} of ${runs}; hidden concealments seen: ${[...new Set(concs)].sort((a, b) => a - b).join(', ')}`);
    golden.unmaskReach = { perception: best, runs, done, concealments: [...concs].sort((a, b) => a - b) };
    table['bonus unmask (best Perception)'] = { runs, done, perception: best };
  }
  golden.objectivesSolved = table;
  for (const [k, v] of Object.entries(table)) if (v.done !== v.runs && !k.includes('trophy') && !k.includes('unbroken')) console.log(`    ${k}: ${JSON.stringify(v)}`);
  const days = Object.entries(table).filter(([k]) => !k.startsWith('bonus')).map(([k, v]) => `${k.split(' ')[0]} ${k.split('/')[1]}: day ${v.avgDay}`);
  console.log(`    exit day by objective and size (solver, fights free): ${[...new Set(days)].slice(0, 15).join('; ')}`);
}

console.log('=== leaving early, the exit rules, the wipe ===');
{
  const party = makeParty();
  const world = payingWorld(party);
  const { makeStack } = await import('../../src/systems/ItemStacks.js');
  const h = createMapHunt(ZONES[0], { plan: { objective: 'scout', size: 'medium', itemLevel: 5 }, supplies: 100, seed: 12000, bring: [makeStack('rations', 40)] }, world);
  // Walk one step off the entry: leaving is refused there.
  const off = mapNeighbors(h.getState().map, h.getState().pos).find(n => isPassable(h.getState().map.tiles[n]) && !h.getState().map.tiles[n].exit);
  h.move(off); settle(h);
  check('exit is refused off an exit-capable tile', !h.exit().ok);
  h.move(h.getState().from); settle(h);
  const before = h.getState();
  const r = h.exit();
  check('leaving early from the entry: allowed; no completion reward, nothing paid', r.ok && !r.reward.primaryDone && r.reward.completion === 0 && world.paid.length === 0);
  check('leaving early: the pack comes home through settlePack (unspent Rations banked)',
    r.pack.keeps && r.pack.rationsPacked === 40 && world.banked.some(b => !b.found && b.items.some(x => x.startsWith('rations'))),
    `${r.pack.rationsLeft} of 40 Rations home`);
  const after = h.getState();
  const tries = [h.move(off), h.camp(), h.forage(), h.exit(), h.wipe(), h.flee(), h.winEncounter()];
  check('after the exit the hunt is over: every action refused', after.finished === 'exit' && tries.every(t => !t.ok));

  // During a fight: exit refused. Find a fight on the entry's doorstep.
  let refusedInFight = null;
  for (let k = 0; k < 80 && refusedInFight === null; k++) {
    const hh = createMapHunt(ZONES[k % 2], { plan: { objective: 'scout', size: 'medium' }, supplies: 100, seed: 12100 + k }, payingWorld(makeParty()));
    const pick = makeRng(k), stood = new Set([hh.getState().pos]);
    for (let i = 0; i < 40 && !hh.encounter(); i++) { const to = chooseMove(hh, pick, stood); stood.add(to); hh.move(to); }
    if (!hh.encounter()) continue;
    refusedInFight = !hh.exit().ok && hh.exit().reason.includes('fight');
  }
  check('exit is refused while a fight is pending', refusedInFight === true);

  // The wipe, by death rule.
  const wipeWith = (deathRule) => {
    const w = payingWorld(makeParty());
    const hh = createMapHunt(ZONES[0], { plan: { objective: 'scout', size: 'small' }, supplies: 100, seed: 12200, bring: [makeStack('rations', 30)] }, w);
    hh.forage();
    const d = hh.serialize();
    d.deathRule = deathRule;
    const h2 = restoreMapHunt(d, w);
    const out = h2.wipe();
    return { out, w, h2 };
  };
  const sh = wipeWith('sheltered'), wa = wipeWith('watched');
  check('wipe, Sheltered: the pack comes home; nothing is paid', sh.out.ok && sh.out.pack.keeps && sh.w.banked.length > 0 && sh.w.paid.length === 0);
  check('wipe, Watched: the pack is lost; nothing banked, nothing paid', wa.out.ok && !wa.out.pack.keeps && wa.w.banked.length === 0 && wa.w.paid.length === 0);
  check('after a wipe the hunt is over', sh.h2.getState().finished === 'wipe' && !sh.h2.move(mapNeighbors(sh.h2.getState().map, sh.h2.getState().pos)[0]).ok && !sh.h2.exit().ok);

  // A Waystone is an exit: walk to one and leave from it.
  let waystoneOk = null;
  for (let k = 0; k < 300 && waystoneOk === null; k++) {
    const w = payingWorld(makeParty());
    const hh = createMapHunt(ZONES[k % 2], { plan: { objective: 'scout', size: 'large', bonusObjectives: ['swift_return'], itemLevel: 8 }, supplies: 400, seed: 12300 + k }, w);
    const ways = hh.getState().map.features.filter(f => f.kind === 'waystone').map(f => f.tile);
    if (!ways.length) continue;
    for (let i = 0; i < 400 && !ways.includes(hh.getState().pos); i++) {
      if (hh.encounter()) { hh.winEncounter(); continue; }
      const step = nextStep(hh, id => ways.includes(id));
      if (!step) break;
      hh.move(step);
    }
    if (hh.encounter()) hh.winEncounter();
    waystoneOk = ways.includes(hh.getState().pos) && hh.exit().ok;
  }
  check('a Waystone is an exit: the party walks to one and leaves from it', waystoneOk === true);
}

// =============================================================================
// 8a: the map scene's view. The scene reads view() and nothing else, so view()
// must hold everything it draws and nothing the party has not seen. No golden
// entries: these are checks only, so adding them moves nothing.
// =============================================================================
console.log('=== 8a: view() is all the scene needs, and never more ===');

/** Problems with one view() against the hunt's own state. */
function viewProblems(h) {
  const out = [];
  const s = h.getState(), v = h.view(), st = h.stats();
  const fogged = (id) => !!s.fog[id];
  // Tiles: exactly the seen ones, each as the map has it (ground as last seen).
  const tileIds = Object.keys(v.tiles);
  if (!same([...tileIds].sort(), Object.keys(s.fog).sort())) out.push('tiles are not exactly the seen tiles');
  for (const id of tileIds) {
    const t = s.map.tiles[id], vt = v.tiles[id];
    if (vt.ground !== v.ground[id]) out.push(`${id}: tile ground ${vt.ground} vs ground ${v.ground[id]}`);
    if (vt.relief !== (t.relief || 'flat') || !!vt.ford !== !!t.ford || !!vt.exit !== !!t.exit) out.push(`${id}: relief/ford/exit differ from the map`);
    if ((vt.gathered || null) !== (s.gathered[id] || null)) out.push(`${id}: gathered differs`);
  }
  // Layout: the current section's shape, all of it, nothing from another section.
  const sec = parseTileId(s.pos).section;
  const want = Object.keys(s.map.tiles).filter(id => parseTileId(id).section === sec).sort();
  if (v.section !== sec || !same([...v.layout].sort(), want)) out.push('layout is not the current section\'s shape');
  // Passages and features: only on seen tiles, and all of those.
  const wantPass = s.map.passages.flatMap(({ a, b }) => [`${a}>${b}`, `${b}>${a}`]).filter(p => fogged(p.split('>')[0])).sort();
  if (!same(v.passages.map(p => `${p.tile}>${p.to}`).sort(), wantPass)) out.push('passages are not exactly the seen ones');
  const wantFeat = s.map.features.filter(f => fogged(f.tile)).map(f => `${f.kind}@${f.tile}${f.destroyed ? '!' : ''}`).sort();
  if (!same(v.features.map(f => `${f.kind}@${f.tile}${f.destroyed ? '!' : ''}`).sort(), wantFeat)) out.push('features are not exactly the seen ones');
  // Objective sites: the primary's own, only for Scout / Retrieve / Commune.
  const p = s.map.objectives.primary;
  const sites = { scout: p.sites, retrieve: [p.site], commune: [p.site] }[p.id] || [];
  if (!same(v.objectiveSites.map(o => o.tile), sites) || v.objectiveSites.some(o => o.objective !== p.id)) out.push(`objective sites wrong for ${p.id}`);
  // Moves: every enterable neighbour at moveCost, nothing else.
  const wantMoves = mapNeighbors(s.map, s.pos).filter(id => isPassable(s.map.tiles[id]))
    .map(id => { const c = R.moveCost(s.map.tiles[id], st); return { tile: id, supply: c.supply, time: c.time }; });
  if (!same(v.moves, wantMoves)) out.push('moves differ from moveCost over the enterable neighbours');
  // Occupants: only detected ones, only on seen tiles.
  for (const o of v.occupants) if (o.band === 'nothing' || !fogged(o.tile)) out.push('an undetected or unseen occupant is shown');
  // No leak: an occupant the party never detected and never met is nowhere in
  // the view, not even its id; nor are the generator's routes or concealments.
  const text = JSON.stringify(v);
  const met = new Set(s.log.filter(l => l.occId || l.occupant).map(l => l.occId || l.occupant));
  for (const o of s.map.occupants) if (!s.sightings[o.id] && !met.has(o.id) && text.includes(`"${o.id}"`)) out.push(`${o.id} (undetected) leaks into the view`);
  if (/"route"|"concealment"/.test(text)) out.push('a route or a concealment number is in the view');
  return out;
}

{
  const PRIMS = ['scout', 'apex', 'cull', 'retrieve', 'commune'];
  const probs = [];
  let steps = 0, sectionsCrossed = 0, sitesMarked = 0, featuresSeen = 0;
  for (const zoneId of ZONES) for (const size of SIZES) for (const objective of PRIMS) for (let k = 0; k < 3; k++) {
    const seed = 13000 + k;
    const h = createMapHunt(zoneId, { plan: { objective, size, bonusObjectives: ['unmask'], mods: { blightPatches: 1 }, itemLevel: 8 }, supplies: 200, seed }, recordingWorld(makeParty()));
    const pick = makeRng(seed ^ 0x8a);
    const stood = new Set([h.getState().pos]);
    let lastSec = parseTileId(h.getState().pos).section;
    const first = h.view();
    sitesMarked += first.objectiveSites.length;
    for (const o of first.objectiveSites) if (o.objective === 'scout' ? false : o.done) probs.push(`${zoneId}/${size}/${objective}: a site starts done`);
    for (let i = 0; i < 40; i++) {
      if (h.encounter()) { (i % 3 ? h.winEncounter() : h.flee()); }
      else if (i % 11 === 5) h.camp();
      else if (i % 7 === 3) h.forage();
      else { const to = chooseMove(h, pick, stood); stood.add(to); h.move(to); }
      steps++;
      const sec = parseTileId(h.getState().pos).section;
      if (sec !== lastSec) { sectionsCrossed++; lastSec = sec; }
      for (const pr of viewProblems(h)) probs.push(`${zoneId}/${size}/${objective} seed ${seed} step ${i}: ${pr}`);
    }
    featuresSeen += h.view().features.length;
  }
  check('view(): tiles, layout, passages, features, sites and moves are exactly what the party has seen, at every step',
    probs.length === 0, probs.length ? probs.slice(0, 3).join(' | ') : `${steps} steps, ${sectionsCrossed} section crossings, ${sitesMarked} sites marked, ${featuresSeen} features seen at the end`);
  check('view(): nothing undetected leaks (no id, route or concealment), including Unmask\'s hidden band', probs.every(p => !/leak|route|concealment/.test(p)));

  // A fresh hunt: only the section shape is known beyond what is in sight.
  const h = createMapHunt(ZONES[0], { plan: { objective: 'retrieve', size: 'large' }, supplies: 60, seed: 13100 }, recordingWorld(makeParty()));
  const v = h.view();
  check('at departure: the section shape is whole, only tiles in sight have ground, the Retrieve site is marked',
    v.layout.length > Object.keys(v.tiles).length && v.objectiveSites.length === 1 && v.objectiveSites[0].objective === 'retrieve' && !v.objectiveSites[0].done,
    `${v.layout.length} hexes in the shape, ${Object.keys(v.tiles).length} seen`);
  const ap = createMapHunt(ZONES[1], { plan: { objective: 'apex', size: 'medium' }, supplies: 60, seed: 13101 }, recordingWorld(makeParty()));
  const cu = createMapHunt(ZONES[1], { plan: { objective: 'cull', size: 'medium' }, supplies: 60, seed: 13101 }, recordingWorld(makeParty()));
  check('Apex and Cull targets are never marked', ap.view().objectiveSites.length === 0 && cu.view().objectiveSites.length === 0);
  const vv = h.view();
  vv.tiles[vv.pos].ground = 'changed'; vv.layout.push('x'); vv.plan.bonusObjectives.push('x');
  check('view() is a copy: changing it changes nothing in the hunt', h.view().tiles[vv.pos].ground !== 'changed' && !h.view().layout.includes('x') && !h.view().plan.bonusObjectives.includes('x'));
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
  check('hunt rules identical to the golden', changed.length === 0,
    changed.length ? `changed: ${changed.join(', ')}` : `${keys.size} tables`);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
