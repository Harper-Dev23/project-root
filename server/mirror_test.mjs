// @ts-nocheck
// server/mirror_test.mjs
//
// The last big technical unknown: can a client DISPLAY a fight it is not
// simulating, and stay in agreement with the server?
//
// A server session plays a hunt. A second, independent CombatScene - standing
// in for a player's browser - never simulates anything; it only receives the
// broadcast board and applies it. After every single action both boards are
// compared field by field. If they ever diverge, the two players would be
// looking at different games.
//
// Run: node server/mirror_test.mjs

import { installPhaserStub } from '../tools/headless/phaserStub.js';
installPhaserStub(5150);

const { createCombatHost } = await import('../tools/headless/combatHost.js');
const { createSession, toWireCharacter, fromWireCharacter } = await import('./session.js');
const { makeParty, slotMapFor } = await import('../tools/headless/fixtures.js');
const CombatSceneMod = await import('../src/scenes/CombatScene.js');
const CombatScene = CombatSceneMod.default
  || Object.values(CombatSceneMod).find(v => typeof v === 'function');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};

const SCENARIO = 'training_encounter_3';   // real enemies, reactions, AI

const roster = makeParty().map(toWireCharacter);
const players = [
  { id: 'p1', name: 'Alice', hunters: JSON.parse(JSON.stringify(roster.slice(0, 3))) },
  { id: 'p2', name: 'Bob', hunters: JSON.parse(JSON.stringify(roster.slice(3, 6))) },
];

// ---- the client's board, built FIRST ---------------------------------------
//
// Order matters here, and getting it wrong produced a genuinely confusing
// failure. `GameState` is a module singleton and every `__begin()` assigns
// `GameState.party`; `_checkVictoryCondition` then reads `GameState.party` to
// decide whether the party has fallen. Building the client host SECOND left
// the singleton pointing at the client's copies, so when the server's party
// was wiped the server never noticed - six enemies took turns forever and the
// harness's runaway guard fired.
//
// A real deployment never has two boards in one process (the hub now refuses a
// second concurrent hunt for exactly this reason). This test does, so it
// builds the display board first and lets the session claim the singleton.
const clientHost = createCombatHost(CombatScene);
const clientParty = players.flatMap(p => p.hunters.map(h => {
  const c = fromWireCharacter(JSON.parse(JSON.stringify(h)));
  c.ownerId = p.id;
  return c;
}));
const clientSlots = {};
clientParty.forEach((c, i) => { clientSlots[i + 1] = c.instanceId || c.id; });
clientHost.__begin({ party: clientParty, partySlots: clientSlots, scenarioId: SCENARIO });

// ---- the server's session, which now owns GameState.party -------------------
const session = createSession({ CombatScene, players, scenarioId: SCENARIO, seed: 5150 });

console.log('=== the two boards start from the same data ===');
check('same ally count', clientParty.length === session.party.length,
  clientParty.length + ' vs ' + session.party.length);
check('same enemy count and uids',
  clientHost.enemies.map(e => e.uid).join(',') === session.host.enemies.map(e => e.uid).join(','),
  clientHost.enemies.map(e => e.uid).join(','));

/** Everything a player can see about the board, as comparable text. */
const fingerprint = (host) => {
  const units = [...(host.turnOrder || [])];
  return JSON.stringify({
    round: host.combatRound,
    ended: host.combatEnded,
    current: host._unitRef(host._currentChar?.()),
    units: units
      .map(u => ({
        ref: host._unitRef(u),
        hp: u.currentHP, mp: u.currentMP,
        gauge: u.initiativeGauge ?? 0,
        shield: u.shieldHP || 0,
        status: u.status,
        meters: u.weakness?.meters || {},
        tiers: u.weakness?.tiers || {},
        effects: (u.statusEffects || []).map(e => e.id + ':' + (e.turns ?? '')).sort(),
        cd: Object.fromEntries(Object.entries(u.cooldowns || {}).filter(([, v]) => v > 0)),
      }))
      .sort((a, b) => String(a.ref).localeCompare(String(b.ref))),
  });
};

// ---- the client is a display, not a second simulation ----------------------
// Checked BEFORE the fight is played out. Run afterwards it passed for the
// wrong reason - the refusal was "combat has ended", which proves nothing
// about authority.
console.log('=== the client is a display, not a second simulation ===');
{
  const before = fingerprint(clientHost);
  const c = clientParty[0];
  const verdict = clientHost._resolveAction(
    { actor: c, skill: 'basic_attack', target: clientHost.enemies[0] },
    { playerId: 'nobody' });
  check('a local action without authority is refused',
    verdict.ok === false && /not yours|no owner/.test(verdict.reason), verdict.reason);
  check('and the board did not move', fingerprint(clientHost) === before);
}

// ---- play, mirroring after every action ------------------------------------
console.log('=== every action, mirrored and compared ===');
let turns = 0;
let syncs = 0;
let firstDivergence = null;
let unknownRefs = 0;

while (!session.isOver && turns < 400) {
  const cur = session.current();
  if (!cur || cur.ownerId == null) break;

  const foe = session.state().units.find(u => u.side === 'enemy' && u.hp > 0);
  if (foe) {
    const res = session.act(cur.ownerId, { actor: cur.ref, skill: 'basic_attack', target: foe.ref });
    if (res.ok) {
      const report = clientHost._applyNetState(res.state);
      unknownRefs += report.unknown.length;
      syncs++;
      if (!firstDivergence && fingerprint(clientHost) !== fingerprint(session.host)) {
        firstDivergence = { at: 'act on turn ' + turns };
      }
    }
  }

  const ended = session.endTurn(cur.ownerId);
  if (ended.ok) {
    const report = clientHost._applyNetState(ended.state);
    unknownRefs += report.unknown.length;
    syncs++;
    if (!firstDivergence && fingerprint(clientHost) !== fingerprint(session.host)) {
      firstDivergence = { at: 'endTurn on turn ' + turns };
    }
  }
  turns++;
}

check('the fight ran with real enemies, reactions and AI', turns > 0,
  turns + ' player turns, ' + syncs + ' state syncs');
check('no unresolvable unit references', unknownRefs === 0, unknownRefs + ' unknown');
check('the client board NEVER diverged from the server', !firstDivergence,
  firstDivergence ? 'first divergence at ' + firstDivergence.at : 'identical at all ' + syncs + ' syncs');

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
