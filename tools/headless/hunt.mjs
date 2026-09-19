// tools/headless/hunt.mjs
//
// The hunt engine's golden master, and the proof that a hunt survives a save.
// Exploration's counterpart to tools/combat_snapshot.js. It drives the REAL
// createHunt / restoreHunt / GameState.save / GameState.load; nothing is
// re-implemented here, and event outcomes go through the real EventResolver.
//
// What it proves (IMPLEMENTATION_PLAN, chunk 1):
//   - save -> reload mid-hunt gives an identical state AND identical next rolls
//   - a real v3 save (tools/snapshots/save-v3-fixture.json, written by the v3
//     build before the format changed) migrates cleanly
//   - a real v4 save written MID-HUNT by the chunk-2 build
//     (tools/snapshots/save-v4-fixture.json) migrates to v5, and its v1 hunt
//     comes back as a v2 hunt with an empty pack
//   - hunts are instances: two run interleaved behave exactly as run alone
//   - reloading mid-fight is a flee, not a second attempt
//
// The golden (tools/snapshots/hunt-golden.json) records whole scripted hunts,
// step by step, for fixed seeds. It answers "did the hunt engine change?".
// Any change to hunt rules, zone tables or weather will move it, on purpose;
// regenerate it in the same commit and say so.
//
// USAGE
//   node tools/headless/hunt.mjs                  run the checks, print a summary
//   node tools/headless/hunt.mjs --json out.json  also write the golden
//   node tools/headless/hunt.mjs --diff old.json  also compare against one
//
// The "Saved -> ..." lines are real GameState.save calls, into the throwaway
// localStorage installed below.

// Chunk 8c added: the real v6 fixture (an Advance hunt from the 8b build)
// still loads and advances, and a hunt on the hex map goes into the save with
// `mode: 'map'`, comes back identically, flees when reloaded mid-fight, and is
// dropped once it is over.

import fs from 'node:fs';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- a throwaway localStorage, installed before GameState loads ------------
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

const GameState = (await import('../../src/systems/GameState.js')).default;
const { SAVE_VERSION } = await import('../../src/systems/GameState.js');
const ProgressionManager = (await import('../../src/systems/ProgressionManager.js')).default;
const { HuntManager, createHunt, restoreHunt, HUNT_STATE_VERSION } = await import('../../src/systems/HuntManager.js');
const { makeRng, rngFromState } = await import('../../src/systems/seededRng.js');
const { EventResolver } = await import('../../src/systems/EventResolver.js');
const { ZONES } = await import('../../data/zones.js');
const { makeParty } = await import('./fixtures.js');

const ZONE_IDS = Object.keys(ZONES);
const PLAN_MODS = { encounterChancePercent: 20, supplyEfficiencyPercent: 25, huntPointsPercent: 50 };

// ---- driving a hunt ---------------------------------------------------------

/** A world that records what the hunt asked of the game, instead of doing it. */
function recordingWorld(party) {
  const calls = [];
  return {
    calls,
    nightFalls: () => calls.push('night'),
    dayBreaks: () => calls.push('day'),
    awardHuntPoints: (n) => calls.push(`hp${n}`),
    awardXP: (n) => calls.push(`xp${n}`),
    party: () => party,
  };
}

/** Fixed test party for hpDelta: plain HP records, so the golden does not move with character balance. */
function testParty() {
  return ['A', 'B', 'C'].map(id => ({ id, status: 'alive', currentHP: 30, maxHP: 30 }));
}

/**
 * The outcome a player would reach, through the real resolver. Choices take the
 * first option and puzzles the first answer: a fixed script, not a strategy.
 * Checks use the die the hunt rolled, against a flat stat of 12.
 */
function outcomeFor(eventDef) {
  if (eventDef.kind === 'choice') return EventResolver.resolveChoice(eventDef, 0);
  if (eventDef.kind === 'puzzle') return EventResolver.resolvePuzzle(eventDef, 0);
  return null;
}
function checkOutcome(pending) {
  const def = pending.eventDef;
  const r = EventResolver.rollCheck(def.stat, def.dc, { [def.stat]: 12 }, pending.dieRoll);
  return r.success ? def.success : def.failure;
}

/**
 * One scripted step: resolve what is pending, otherwise advance. Fights are
 * engaged and won. Returns a compact record of what happened, or null when the
 * hunt is over (no supplies, nothing pending).
 */
function step(hunt) {
  const st = hunt.getState();
  const p = st.pendingEncounter;
  if (p?.kind === 'event') {
    const outcome = p.eventDef.kind === 'check' ? checkOutcome(p) : outcomeFor(p.eventDef);
    const r = hunt.resolveEncounter(outcome);
    return { do: 'event', id: p.eventDef.id, die: p.dieRoll ?? null, hp: r?.huntPoints ?? null };
  }
  if (p?.kind === 'encounter') {
    hunt.engagePending();
    const r = hunt.resolveCombatEncounter({ won: true, type: p.type });
    return { do: 'fight', type: p.type, scenario: p.scenarioId, hp: r?.huntPoints ?? null };
  }
  if (st.supplies <= 0) return null;
  const a = hunt.advance();
  const q = a.pendingEncounter;
  return {
    do: 'advance', supplies: a.supplies, depth: a.depth, day: a.day, night: a.isNight,
    rolled: q ? (q.kind === 'event' ? `event:${q.eventDef.id}` : `fight:${q.scenarioId}`) : null,
  };
}

function playOut(hunt, maxSteps = 500) {
  const trace = [];
  for (let i = 0; i < maxSteps; i++) {
    const s = step(hunt);
    if (!s) break;
    trace.push(s);
  }
  return trace;
}

// =============================================================================
console.log('=== the random stream: state out, same numbers back ===');
{
  const r = makeRng(12345);
  const first = [r(), r(), r()];
  const r2 = makeRng(12345);
  check('makeRng still yields the same sequence for a seed', same(first, [r2(), r2(), r2()]));

  let ok = true;
  for (const at of [0, 1, 7, 100, 999]) {
    const a = makeRng(42);
    for (let i = 0; i < at; i++) a();
    const b = rngFromState(a.getState());
    for (let i = 0; i < 200; i++) if (a() !== b()) ok = false;
  }
  check('rngFromState(getState()) continues identically, at 5 points in the stream', ok);
  check('a zero seed still degenerates to 1 (unchanged guard)', makeRng(0)() === makeRng(1)());
  const z = rngFromState(0);
  check('state 0 is a real position, not re-guarded to 1', z() !== makeRng(1)());
}

// =============================================================================
console.log('=== golden: scripted hunts for fixed seeds ===');
const golden = { rngHead: [], hunts: {} };
{
  const r = makeRng(12345);
  golden.rngHead = Array.from({ length: 5 }, () => r());

  for (const zoneId of ZONE_IDS) {
    for (const [label, opts] of [
      ['s1', { seed: 1 }], ['s2', { seed: 2 }], ['s777', { seed: 777 }],
      ['s3-plan', { seed: 3, huntPlanModifiers: PLAN_MODS }],
    ]) {
      const world = recordingWorld(testParty());
      const hunt = createHunt(zoneId, { supplies: 60, ...opts }, world);
      const start = hunt.getState();
      const trace = playOut(hunt);
      const end = hunt.getState();
      golden.hunts[`${zoneId}/${label}`] = {
        weather: start.weather.id,
        modifiers: start.combinedModifiers,
        trace,
        world: world.calls,
        partyHP: world.party().map(c => c.currentHP),
        end: { day: end.day, depth: end.depth, sessionHuntPoints: end.sessionHuntPoints },
      };
    }
  }
  const n = Object.keys(golden.hunts).length;
  const steps = Object.values(golden.hunts).reduce((t, h) => t + h.trace.length, 0);
  const every = Object.values(golden.hunts).every(h => h.trace.length > 0 && h.trace.at(-1));
  check(`${n} scripted hunts ran to the end`, n === ZONE_IDS.length * 4 && every, `${steps} steps`);

  const checks = Object.values(golden.hunts).flatMap(h => h.trace.filter(s => s.do === 'event' && s.die !== null));
  check('every check event carried a die rolled by the hunt, 1-20',
    checks.length > 0 && checks.every(s => Number.isInteger(s.die) && s.die >= 1 && s.die <= 20), `${checks.length} checks`);

  const again = playOut(createHunt(ZONE_IDS[0], { supplies: 60, seed: 1 }, recordingWorld(testParty())));
  check('the same seed plays the same hunt twice', same(again, golden.hunts[`${ZONE_IDS[0]}/s1`].trace));
}

// =============================================================================
console.log('=== hunts are instances ===');
{
  const alone = (zoneId, seed) => playOut(createHunt(zoneId, { supplies: 60, seed }, recordingWorld(testParty())));
  const soloA = alone(ZONE_IDS[0], 11);
  const soloB = alone(ZONE_IDS[1], 22);

  const a = createHunt(ZONE_IDS[0], { supplies: 60, seed: 11 }, recordingWorld(testParty()));
  const b = createHunt(ZONE_IDS[1], { supplies: 60, seed: 22 }, recordingWorld(testParty()));
  const ta = [], tb = [];
  for (let i = 0; i < 500; i++) {
    const sa = step(a); if (sa) ta.push(sa);
    const sb = step(b); if (sb) tb.push(sb);
    if (!sa && !sb) break;
  }
  check('two hunts interleaved play exactly as each did alone', same(ta, soloA) && same(tb, soloB),
    `${ta.length} + ${tb.length} steps`);
}

// =============================================================================
console.log('=== save -> reload mid-hunt, through the real GameState ===');
function freshGame() {
  GameState.reset();
  ProgressionManager.reset?.();
  const party = makeParty().slice(0, 3);
  GameState.characters = party;
  GameState.party = party.slice();
}

{
  let allState = true, allNext = true, points = 0;
  for (const zoneId of ZONE_IDS) {
    for (const seed of [5, 6, 7]) {
      for (const at of [0, 3, 9, 17, 26]) {
        freshGame();
        HuntManager.start(zoneId, { supplies: 60, seed });
        for (let i = 0; i < at; i++) step(HuntManager.current());
        GameState.save('hunt_rt');
        const saved = HuntManager.current().serialize();

        // What happens next, without reloading.
        const nextA = [];
        for (let i = 0; i < 12; i++) { step(HuntManager.current()); nextA.push(HuntManager.current().serialize()); }

        // Reload, and do the same.
        GameState.load('hunt_rt');
        const restored = HuntManager.current()?.serialize();
        const nextB = [];
        for (let i = 0; i < 12; i++) { step(HuntManager.current()); nextB.push(HuntManager.current().serialize()); }

        if (!same(saved, restored)) allState = false;
        if (!same(nextA, nextB)) allNext = false;
        points++;
      }
    }
  }
  check('reload gives an identical hunt state', allState, `${points} save points, 2 zones x 3 seeds x 5 depths`);
  check('...and identical next rolls (12 steps on from each)', allNext);

  // A pending check: its die survives the reload.
  freshGame();
  HuntManager.start(ZONE_IDS[0], { supplies: 60, seed: 1 });
  let guard = 0;
  while (HuntManager.getState().pendingEncounter?.eventDef?.kind !== 'check' && guard++ < 400) {
    const s = step(HuntManager.current());
    if (!s) { HuntManager.start(ZONE_IDS[0], { supplies: 60, seed: 100 + guard }); }
  }
  const die = HuntManager.getState().pendingEncounter?.dieRoll;
  GameState.save('hunt_die');
  GameState.load('hunt_die');
  check('a pending check keeps its die across a reload', Number.isInteger(die) && HuntManager.getState().pendingEncounter?.dieRoll === die, `die ${die}`);

  // The saved hunt is plain JSON.
  const s = HuntManager.current().serialize();
  check('serialize() is plain JSON (survives a JSON round trip unchanged)', same(JSON.parse(JSON.stringify(s)), s));
  check(`serialized hunts carry v${HUNT_STATE_VERSION} and a stream state`, s.v === HUNT_STATE_VERSION && Number.isFinite(s.rngState));
}

// =============================================================================
console.log('=== reloading mid-fight is a flee ===');
{
  freshGame();
  HuntManager.start(ZONE_IDS[0], { supplies: 60, seed: 5 });
  let guard = 0;
  while (HuntManager.getState().pendingEncounter?.kind !== 'encounter' && guard++ < 400) step(HuntManager.current());
  const pending = HuntManager.getState().pendingEncounter;
  check('found a pending fight to test with', pending?.kind === 'encounter', pending?.scenarioId);

  // Not engaged yet: a reload keeps it.
  GameState.save('hunt_fight');
  GameState.load('hunt_fight');
  check('an un-engaged fight is still pending after a reload',
    same(HuntManager.getState().pendingEncounter, pending));

  // Engaged: the hub autosaves at this point, then combat starts.
  const pointsBefore = HuntManager.getState().sessionHuntPoints;
  HuntManager.engagePending();
  GameState.save('hunt_fight');
  GameState.load('hunt_fight');
  const st = HuntManager.getState();
  check('an engaged fight is gone after a reload', st.pendingEncounter === null);
  check('...logged as a flee that paid nothing',
    st.log.at(-1)?.kind === 'flee' && st.log.at(-1)?.huntPoints === 0 && st.sessionHuntPoints === pointsBefore,
    st.log.at(-1)?.label);
  check('...and the hunt carries on', HuntManager.advance() !== null);
}

// =============================================================================
console.log('=== the v3 fixture save ===');
{
  const fixture = JSON.parse(fs.readFileSync(new URL('../snapshots/save-v3-fixture.json', import.meta.url), 'utf8'));
  check('the fixture really is a v3 save with no hunt field', fixture.version === 3 && !('hunt' in fixture));
  check(`this build writes v${SAVE_VERSION}`, SAVE_VERSION === 7);

  const checked = GameState.checkSave(fixture);
  check('checkSave accepts it (the import path)', checked.ok, checked.reason || '');

  // Loading it replaces a live hunt: the save has none.
  freshGame();
  HuntManager.start(ZONE_IDS[0], { supplies: 60, seed: 1 });
  store.set('bmSave_v3', JSON.stringify(fixture));
  const loaded = GameState.load('v3');
  check('load() accepts it', loaded === true, GameState.lastLoadError || '');
  check('no hunt after loading it, even though one was live before', HuntManager.isActive() === false);
  check('its 3 hunters and their party came through',
    GameState.characters.length === 3 && GameState.party.length === 3);
  check('its bag came through (the Hunt Plan)', GameState.inventory.some(i => i?.id === 'hunt_plan'));
  check('its progression came through (4 tickets, 37 Hunt Points)',
    ProgressionManager.huntTickets === 4 && ProgressionManager.huntPoints === 37);

  GameState.save('v3');
  const rewritten = JSON.parse(store.get('bmSave_v3'));
  check('re-saved as v7 with hunt: null', rewritten.version === 7 && rewritten.hunt === null);
}

// =============================================================================
console.log('=== the v4 fixture save, mid-hunt ===');
{
  // Written by the chunk-2 build (25c26ac): a Reeds hunt one step in, with a
  // pending event, supplies 87.7 bought under the old ticket rule.
  const fixture = JSON.parse(fs.readFileSync(new URL('../snapshots/save-v4-fixture.json', import.meta.url), 'utf8'));
  check('the fixture really is a v4 save holding a v1 hunt', fixture.version === 4 && fixture.hunt?.v === 1 && !('pack' in fixture.hunt));
  check('checkSave accepts it (the import path)', GameState.checkSave(fixture).ok);

  freshGame();
  store.set('bmSave_v4', JSON.stringify(fixture));
  const loaded = GameState.load('v4');
  check('load() accepts it', loaded === true, GameState.lastLoadError || '');
  const st = HuntManager.getState();
  check('its hunt came back, where it was', HuntManager.isActive() && st.zoneId === fixture.hunt.zoneId
    && st.supplies === fixture.hunt.supplies && st.depth === fixture.hunt.depth && st.weather.id === fixture.hunt.weather.id,
    `${st.zoneId}, supplies ${st.supplies}, depth ${st.depth}`);
  check('...with its pending event and its stream intact',
    same(st.pendingEncounter, fixture.hunt.pendingEncounter) && HuntManager.current().serialize().rngState === fixture.hunt.rngState);
  check('...upgraded to a v2 hunt: an empty pack and its zone death rule',
    same(st.pack.brought, []) && same(st.pack.found, []) && st.pack.rationsLeft === 0 && st.deathRule === 'sheltered');
  check('its bag came through unstacked, as it was',
    same(GameState.inventory.map(i => [i.id, i.qty ?? null]), fixture.inventory.map(i => [i.id, i.qty ?? null])),
    GameState.inventory.map(i => i.id).join(', '));

  GameState.save('v4');
  const rewritten = JSON.parse(store.get('bmSave_v4'));
  check('re-saved as v7, its hunt as v2', rewritten.version === 7 && rewritten.hunt?.v === HUNT_STATE_VERSION && HUNT_STATE_VERSION === 2);

  // Exiting the old hunt returns no Rations: it packed none, it bought supplies.
  const out = HuntManager.exit();
  check('exiting it banks nothing (the old tickets bought supplies, not Rations)',
    out.rationsPacked === 0 && out.home.brought.length === 0 && GameState.inventory.length === fixture.inventory.length);
}

// =============================================================================
console.log('=== the v6 fixture save, mid Advance hunt (chunk 8c) ===');
{
  // Written by the chunk-8b build (8fb5f6d) through the Hunt screen's own
  // buttons, in headless Edge: a Reeds Advance hunt 3 advances in with Rations
  // in the pack, a rolled generic hunt_plan left in the bag, a Perception
  // pick on the first hunter, and a plan-vendor stock saved without bases.
  const fixture = JSON.parse(fs.readFileSync(new URL('../snapshots/save-v6-fixture.json', import.meta.url), 'utf8'));
  check('the fixture really is a v6 save holding a v2 Advance hunt with no mode',
    fixture.version === 6 && fixture.hunt?.v === 2 && !('mode' in fixture.hunt) && fixture.hunt.pack.brought.length === 1);
  check('checkSave accepts it (the import path)', GameState.checkSave(fixture).ok);

  freshGame();
  store.set('bmSave_v6', JSON.stringify(fixture));
  const loaded = GameState.load('v6');
  check('load() accepts it', loaded === true, GameState.lastLoadError || '');
  const st = HuntManager.getState();
  check('its Advance hunt came back where it was, as an Advance hunt',
    HuntManager.mode() === 'advance' && st.depth === fixture.hunt.depth && st.supplies === fixture.hunt.supplies
    && HuntManager.current().serialize().rngState === fixture.hunt.rngState, `depth ${st.depth}, supplies ${st.supplies}`);
  check('...its packed Rations still in the pack', same(st.pack.brought.map(i => [i.id, i.qty]), fixture.hunt.pack.brought.map(i => [i.id, i.qty])));
  check('...and it still advances', HuntManager.advance() !== null);
  const { huntPlanView } = await import('../../src/systems/ItemFactory.js');
  const bagPlan = GameState.inventory.find(i => i.id === 'hunt_plan');
  check('the generic plan in the bag now reads as Scout on a Small map (legacy base, not migrated)',
    !!bagPlan && huntPlanView(bagPlan).objective === 'scout' && huntPlanView(bagPlan).size === 'small'
    && same(bagPlan, fixture.inventory.find(i => i.id === 'hunt_plan')));
  check('the exploration pick came through', GameState.characters[0].exploration?.picks?.[2]?.rating === 'perception');
  const { currentPlanStock, PLAN_BASE_IDS } = await import('../../src/systems/HuntPlans.js');
  const oldStock = JSON.stringify(ProgressionManager.planVendorStock);
  const stock = currentPlanStock(ProgressionManager, { partyLevel: 5, rollRarity: () => 'rare', rng: makeRng(1) });
  check('its vendor stock had no bases and is rolled again, every slot with a base',
    !JSON.parse(oldStock).slots.some(s => s.base) && stock.slots.every(s => PLAN_BASE_IDS.includes(s.base)));

  GameState.save('v6');
  const rewritten = JSON.parse(store.get('bmSave_v6'));
  check('re-saved as v7, its Advance hunt still with no mode', rewritten.version === 7 && rewritten.hunt?.v === 2 && !('mode' in rewritten.hunt));
  HuntManager.end();
}

// =============================================================================
console.log('=== a map hunt in the save (chunk 8c) ===');
{
  const { createMapHunt, restoreMapHunt } = await import('../../src/systems/HuntEngine.js');
  const strip = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === 'instanceId' ? undefined : x)));
  freshGame();
  const plan = { objective: 'retrieve', size: 'medium', bonusObjectives: ['swift_return'], mods: { perceptionBonus: 10 }, itemLevel: 5 };
  HuntManager.startMap(ZONE_IDS[0], { plan, supplies: 80, seed: 77 });
  check('startMap: the holder has a map hunt', HuntManager.mode() === 'map' && HuntManager.isActive());
  check('...and the Advance-only calls do nothing to it',
    HuntManager.advance() === null && HuntManager.resolveEncounter('x') === null && HuntManager.engagePending() === false
    && HuntManager.addFound({ id: 'x' }) === false && HuntManager.exit() === null && HuntManager.hasPendingEncounter() === false);
  check('...getState() reports idle (CombatScene cannot read a map hunt as an Advance hunt)',
    HuntManager.getState().zoneId === null && HuntManager.getState().combinedModifiers === null);
  const h = HuntManager.current();
  for (let i = 0; i < 6; i++) { if (h.encounter()) h.flee(); const m = h.view().moves; h.move(m[i % m.length].tile); }
  if (h.encounter()) h.flee();
  const before = strip(h.serialize());
  GameState.save('map1');
  const raw = JSON.parse(store.get('bmSave_map1'));
  check('saved as v7, the hunt with mode "map" beside HuntEngine\'s own shape', raw.version === 7 && raw.hunt?.mode === 'map' && raw.hunt.v === 1);
  check('checkSave accepts it (the import path)', GameState.checkSave(raw).ok);
  HuntManager.end();
  GameState.load('map1');
  check('a reload brings the map hunt back identically (both streams included)', HuntManager.mode() === 'map' && same(strip(HuntManager.current().serialize()), before));

  // Reloading mid-fight is a flee (SAVE_COMPATIBILITY rec. 4).
  const h2 = HuntManager.current();
  let steps = 0;
  const { mapNeighbors } = await import('../../src/systems/HuntMapGen.js');
  const { isPassable } = await import('../../data/grounds.js');
  while (!h2.encounter() && steps++ < 400) {
    const s = h2.getState();
    const targets = new Set(s.map.occupants.filter(o => o.kind === 'beast' || o.kind === 'cultist').map(o => o.tile));
    const prev = new Map([[s.pos, null]]); const q = [s.pos]; let goal = null;
    for (let k = 0; k < q.length && !goal; k++) for (const n of mapNeighbors(s.map, q[k])) {
      if (prev.has(n) || !isPassable(s.map.tiles[n])) continue; prev.set(n, q[k]); q.push(n); if (targets.has(n)) { goal = n; break; }
    }
    if (!goal) break;
    let t = goal; while (prev.get(t) !== s.pos) t = prev.get(t);
    h2.move(t);
  }
  check('found a fight to reload in', !!h2.encounter());
  GameState.save('map_fight');
  HuntManager.end();
  GameState.load('map_fight');
  const back = HuntManager.current();
  check('a hunt saved mid-fight comes back fled: no fight pending, logged as a reload',
    HuntManager.mode() === 'map' && !back.encounter() && back.view().log.some(l => l.kind === 'flee' && l.reason === 'reload'));

  // Leaving: the holder drops the finished hunt, so the save no longer holds it.
  const h3 = HuntManager.startMap(ZONE_IDS[1], { plan: { objective: 'scout', size: 'small', itemLevel: 1 }, supplies: 40, seed: 5 });
  const left = h3.exit();
  check('exit from the entry works on the holder\'s hunt', left.ok === true);
  check('clearFinished drops a finished map hunt, and only a finished one',
    HuntManager.clearFinished() === true && !HuntManager.isActive() && HuntManager.clearFinished() === false);
  GameState.save('map_done');
  check('...and the save then holds no hunt', JSON.parse(store.get('bmSave_map_done')).hunt === null);
  const h4 = HuntManager.startMap(ZONE_IDS[1], { plan: { objective: 'scout', size: 'small', itemLevel: 1 }, supplies: 40, seed: 6 });
  check('clearFinished leaves a hunt in progress alone', HuntManager.clearFinished() === false && HuntManager.current() === h4);

  // A hunt with a mode this build does not know is dropped, not the save.
  GameState.save('map_odd');
  const odd = JSON.parse(store.get('bmSave_map_odd'));
  odd.hunt.mode = 'teleport';
  store.set('bmSave_map_odd', JSON.stringify(odd));
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  const okOdd = GameState.load('map_odd');
  console.error = orig;
  check('an unknown hunt mode: the save loads, the hunt is dropped, and it says so',
    okOdd === true && !HuntManager.isActive() && errors.some(e => /unknown hunt mode/.test(e)));

  // What an older build does: a save newer than it is refused, not half-loaded.
  const newer = { ...raw, version: SAVE_VERSION + 1 };
  check('a save newer than this build is refused (why v7 exists: a pre-8c build must refuse a map hunt)',
    GameState.checkSave(newer).ok === false);
  void createMapHunt; void restoreMapHunt;
  HuntManager.end();
}

// =============================================================================
console.log('=== a hunt that cannot be restored is dropped, not the save ===');
{
  freshGame();
  HuntManager.start(ZONE_IDS[0], { supplies: 60, seed: 1 });
  GameState.save('hunt_bad');
  const bad = JSON.parse(store.get('bmSave_hunt_bad'));
  bad.hunt.v = 99;
  store.set('bmSave_hunt_bad', JSON.stringify(bad));

  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  const ok = GameState.load('hunt_bad');
  console.error = orig;
  check('the save still loads', ok === true);
  check('the hunt is dropped', HuntManager.isActive() === false);
  check('...and it says so', errors.some(e => /could not be restored/.test(e)), errors[0]);

  let threw = false;
  try { restoreHunt({ ...HuntManager.current()?.serialize(), v: 1, zoneId: 'nowhere', rngState: 1 }); } catch { threw = true; }
  check('restoreHunt refuses an unknown zone', threw);
}

// =============================================================================
console.log('=== new game ===');
{
  HuntManager.start(ZONE_IDS[0], { supplies: 60, seed: 1 });
  GameState.reset();
  check('GameState.reset() leaves no hunt', HuntManager.isActive() === false);
  check('getState() while idle still reports null modifiers (CombatScene reads it)',
    HuntManager.getState().combinedModifiers === null);
}

// =============================================================================
console.log('=== zone data is never written through ===');
{
  const before = JSON.stringify(ZONES);
  const hunt = createHunt(ZONE_IDS[0], { supplies: 60, seed: 1 }, recordingWorld(testParty()));
  let guard = 0;
  while (!hunt.getState().pendingEncounter?.eventDef && guard++ < 400) step(hunt);
  const p = hunt.getState().pendingEncounter;
  if (p?.eventDef) p.eventDef.label = 'SCRIBBLED';
  check('a pending event is a copy of its zone entry', JSON.stringify(ZONES) === before);
}

// =============================================================================
console.log('=== size ===');
{
  const hunt = createHunt(ZONE_IDS[0], { supplies: 60, seed: 1 }, recordingWorld(testParty()));
  playOut(hunt);
  const bytes = JSON.stringify(hunt.serialize()).length;
  check('a played-out hunt serializes small', bytes < 20000, `${bytes} bytes`);
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
  const keys = new Set([...Object.keys(old.hunts || {}), ...Object.keys(golden.hunts)]);
  const changed = [...keys].filter(k => !same(old.hunts?.[k], golden.hunts[k]));
  check('random stream head unchanged', same(old.rngHead, golden.rngHead));
  check('every scripted hunt identical to the golden', changed.length === 0,
    changed.length ? `changed: ${changed.join(', ')}` : `${keys.size} hunts`);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
