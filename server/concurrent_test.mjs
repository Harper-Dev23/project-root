// @ts-nocheck
// server/concurrent_test.mjs
//
// Two fights in ONE process, turn by turn interleaved (Exploration System v2,
// chunk 12a). Before 12a, every host's __begin assigned the module-singleton
// GameState.party, so the fight begun FIRST judged deaths against the SECOND
// fight's party: a wiped party kept "fighting" because defeat was never
// detected. Each host now owns its party (host.hostParty, read through
// CombatScene._party()), and the server writes nothing into its own
// GameState: no loot in its bag, no autosave, no scenario progression.
//
// What it proves:
//   - fight A (set to wipe) and fight B (set to win; encounter 3, which drops
//     six droppable items, so a leak into the server's bag would show), begun A then B and
//     played a turn each in turn, BOTH end, A in defeat and B in victory
//   - the same pair begun the other way round (B then A) does the same
//   - two hunt fights from two map hunts, one won and one lost, interleaved:
//     the winner's hunt records its kill, the loser's hunt is over
//   - the server's own GameState is untouched: party, inventory, the
//     autosave key, and ProgressionManager's completed scenarios
//   - the hub lets a second lobby start while the first is live
//
// Run: node server/concurrent_test.mjs

import { installPhaserStub } from '../tools/headless/phaserStub.js';
installPhaserStub(0, { deterministic: false });   // as server/index.js does

const { createSession, toWireCharacter } = await import('./session.js');
const { createHub } = await import('./protocol.js');
const { makeParty, slotMapFor } = await import('../tools/headless/fixtures.js');
const { createCombatHost } = await import('../tools/headless/combatHost.js');
const { startCombat, endTurn, cast } = await import('../tools/headless/fight.js');
const CombatSceneMod = await import('../src/scenes/CombatScene.js');
const CombatScene = CombatSceneMod.default
  || Object.values(CombatSceneMod).find(v => typeof v === 'function');
const GameState = (await import('../src/systems/GameState.js')).default;
const ProgressionManager = (await import('../src/systems/ProgressionManager.js')).default;
const HE = await import('../src/systems/HuntEngine.js');
const { walkingAway } = await import('../tools/headless/walkAway.js');
const { createMapHunt } = walkingAway({ createMapHunt: HE.createMapHunt, restoreMapHunt: HE.restoreMapHunt });
const { makeRng } = await import('../src/systems/seededRng.js');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};

const basicAttack = (h, actor) => {
  const atk = (actor.skills || []).find(s => s.id === 'basic_attack');
  const foe = h.enemies.find(e => e.status !== 'incapacitated' && e.currentHP > 0);
  return (atk && foe) ? [{ ability: atk, target: foe }] : [];
};
const doNothing = () => [];

/** One turn of a fight, the way fight.js's runFight takes one. */
function step(host, plan) {
  if (host.combatEnded) return;
  const actor = host._currentChar();
  if (!actor) return;
  if (actor.isEnemy) {
    const before = host.currentTurnIndex;
    host.__drain();
    if (host.currentTurnIndex === before && !host.combatEnded) { host._takeEnemyTurn_viaLogic(actor); host.__drain(); }
    return;
  }
  for (const s of plan(host, actor) || []) { if (host.combatEnded) break; cast(host, actor, s.ability, s.target); }
  if (!host.combatEnded) endTurn(host);
}

/** Play several fights a turn each in turn until all end or the budget runs out. */
function interleave(fights, maxTurns = 1600) {
  // A fight judged against the wrong party never sees its own wipe: its
  // enemies take turns forever until the virtual clock's runaway guard throws.
  // That was the pre-12a failure; record it rather than crash the suite.
  const live = (f) => !f.host.combatEnded && !f.error;
  for (let t = 0; t < maxTurns && fights.some(live); t++) {
    for (const f of fights) {
      if (!live(f)) continue;
      try { step(f.host, f.plan); } catch (e) { f.error = e.message; }
    }
  }
  for (const f of fights) if (f.error) console.log('    (a fight threw: ' + f.error.slice(0, 90) + ')');
}

const allDown = (party) => party.every(c => c.status === 'incapacitated' || c.status === 'dead');
const logHas = (host, re) => host.__logLines().some(l => re.test(l));

const wire = makeParty().map(toWireCharacter);
const hunters = (from, n) => JSON.parse(JSON.stringify(wire.slice(from, from + n)));

/** A co-op session made to lose (1 HP hunters, enemies that cannot die) or win. */
function session(scenarioId, outcome, tag) {
  const s = createSession({
    CombatScene, scenarioId, seed: null,
    players: [{ id: tag + 'a', name: tag + 'A', hunters: hunters(0, 3) }, { id: tag + 'b', name: tag + 'B', hunters: hunters(3, 3) }],
  });
  if (outcome === 'lose') {
    for (const u of s.party) u.currentHP = 1;
    for (const e of s.host.enemies) { e.maxHP = 99999; e.currentHP = 99999; }
  } else {
    for (const u of s.party) { u.maxHP = 99999; u.currentHP = 99999; }
  }
  return { host: s.host, plan: outcome === 'lose' ? doNothing : basicAttack, party: s.party };
}

// What the server's own GameState holds before any fight: it must not change.
const before = {
  party: GameState.party,
  inventory: GameState.inventory.length,
  autosave: globalThis.localStorage.getItem('bmSave_autosave'),
  progress: JSON.stringify(ProgressionManager.completedScenarios),
};

console.log('=== two co-op fights, interleaved: the wipe begun FIRST ===');
{
  const A = session('training_encounter_3', 'lose', 'x');
  const B = session('training_encounter_3', 'win', 'y');
  check('each host owns its own party', A.host._party?.() === A.party && B.host._party?.() === B.party && A.party !== B.party);
  interleave([A, B]);
  check('A (the wipe) ends', A.host.combatEnded);
  check('...in defeat: every A hunter down, and the loss logged', allDown(A.party) && logHas(A.host, /All allies knocked out/));
  check('B (the win) ends in victory', B.host.combatEnded && logHas(B.host, /Victory! All enemies defeated/));
  check('...and B\'s hunters were never judged by A\'s', !allDown(B.party));
}

console.log('=== the same pair begun the other way round ===');
{
  const B = session('training_encounter_3', 'win', 'y');
  const A = session('training_encounter_3', 'lose', 'x');
  interleave([B, A]);
  check('A (the wipe, begun second) ends in defeat', A.host.combatEnded && allDown(A.party) && logHas(A.host, /All allies knocked out/));
  check('B (the win, begun first) ends in victory', B.host.combatEnded && logHas(B.host, /Victory! All enemies defeated/));
}

console.log('=== two map-hunt fights, interleaved ===');
{
  /** Walk a hunt until it meets a beast pack. */
  function meet(fromSeed) {
    for (let n = fromSeed; n < fromSeed + 200; n++) {
      const p = makeParty();
      const world = { party: () => p, nightFalls() {}, dayBreaks() {}, awardHuntPoints() {}, bankItems() {} };
      const h = createMapHunt('reeds_of_gethsemane', { plan: { objective: 'cull', size: 'medium', mods: {}, bonusObjectives: [] }, supplies: 300, seed: n }, world);
      const pick = makeRng(n);
      for (let i = 0; i < 120; i++) {
        const e = h.encounter();
        if (e) { if (e.kind === 'beast') return { h, party: p }; h.flee(); continue; }
        const mv = h.view().moves; if (!mv.length) break;
        h.move(mv[Math.floor(pick() * mv.length)].tile);
      }
    }
    return null;
  }
  const hostOn = (m) => {
    const spec = m.h.beginFight();
    const host = createCombatHost(CombatScene);
    host.isAuthoritativeHost = true;
    host.__begin({ party: m.party, partySlots: slotMapFor(m.party), huntFight: { ...spec, hunt: m.h } });
    startCombat(host);
    return host;
  };
  const lose = meet(100), win = meet(400);
  check('two hunts each met a beast pack', !!lose && !!win);
  if (lose && win) {
    const occId = win.h.getState().encounter.occId;
    const L = { host: hostOn(lose), plan: doNothing };
    for (const u of lose.party) u.currentHP = 1;
    for (const e of L.host.enemies) { e.maxHP = 99999; e.currentHP = 99999; }
    const W = { host: hostOn(win), plan: basicAttack };
    for (const u of win.party) { u.maxHP = 9999; u.currentHP = 9999; }
    interleave([L, W]);
    check('the losing hunt fight ends, and its hunt is over (wiped)', L.host.combatEnded && allDown(lose.party) === false && lose.h.getState().finished === 'wipe',
      JSON.stringify({ ended: L.host.combatEnded, finished: lose.h.getState().finished }));
    check('the winning hunt fight ends and its hunt records the kill', W.host.combatEnded && win.h.getState().kills.some(k => k.occId === occId));
  }
}

console.log('=== the server writes nothing into its own GameState ===');
{
  check('GameState.party was never assigned', GameState.party === before.party);
  check('no loot reached the server\'s bag', GameState.inventory.length === before.inventory, `${before.inventory} -> ${GameState.inventory.length}`);
  check('no autosave was written', globalThis.localStorage.getItem('bmSave_autosave') === before.autosave);
  check('no scenario progression was recorded', JSON.stringify(ProgressionManager.completedScenarios) === before.progress);
}

console.log('=== the hub runs two lobbies at once ===');
{
  let n = 0;
  const hub = createHub({ CombatScene, codeFactory: () => ['ONE1', 'TWO2'][n++] });
  const conn = (label) => ({ label, inbox: [], send(m) { this.inbox.push(m); }, last(t) { return [...this.inbox].reverse().find(m => m.t === t) || null; }, errors() { return this.inbox.filter(m => m.t === 'error').map(m => m.reason); } });
  const a = conn('a'), b = conn('b');
  hub.handle(a, { t: 'create', name: 'A', hunters: hunters(0, 1) });
  hub.handle(b, { t: 'create', name: 'B', hunters: hunters(1, 1) });
  hub.handle(a, { t: 'ready', ready: true }); hub.handle(a, { t: 'start' });
  hub.handle(b, { t: 'ready', ready: true }); hub.handle(b, { t: 'start' });
  check('the first lobby starts', !!a.last('started'), a.errors().join('; '));
  check('the second starts while the first is live', !!b.last('started') && !b.errors().length, b.errors().join('; '));
}

console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
