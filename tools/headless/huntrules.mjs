// tools/headless/huntrules.mjs
//
// The hunt rules engine (Exploration System v2, chunk 7). Drives the REAL
// HuntEngine (createMapHunt / restoreMapHunt) on REAL generated maps with the
// REAL fixture party, and checks the rules through the real exports of
// HuntRules.js. No rule or formula is re-derived here: where a number is
// compared, both sides come from the game's own functions.
//
// Chunk 7 lands in four steps (7a-7d); this file grows with each. Now: 7a.
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
const { tileCosts, isPassable } = await import('../../data/grounds.js');
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
