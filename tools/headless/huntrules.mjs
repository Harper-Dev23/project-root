// tools/headless/huntrules.mjs
//
// The hunt rules engine (Exploration System v2, chunk 7). Drives the REAL
// HuntEngine (createMapHunt / restoreMapHunt) on REAL generated maps with the
// REAL fixture party, and checks the rules through the real exports of
// HuntRules.js. No rule or formula is re-derived here: where a number is
// compared, both sides come from the game's own functions.
//
// Chunk 7 lands in four steps (7a-7d); this file grows with each. Now: 7a + 7b.
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
    const ta = chooseMove(a, pickA, sa); a.move(ta); sa.add(ta);
    const tb = chooseMove(b, pickB, sb); b.move(tb); sb.add(tb);
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
  check('packing cap: 100 without Pack Mule, 120 with it, and it counts once per party',
    plain === R.RATIONS_PACK_CAP && one === R.RATIONS_PACK_CAP + 20 && two === one, `${plain} / ${one} / ${two}`);
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
  return n ? h.move(n) : null;
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
