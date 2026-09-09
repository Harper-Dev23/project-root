// @ts-nocheck
// server/session_test.mjs
//
// Drives a co-op session end to end with no network: two players, six hunters
// between them, one real fight. Run: node server/session_test.mjs

import { installPhaserStub } from '../tools/headless/phaserStub.js';
installPhaserStub(2024);

const { createSession, toWireCharacter, fromWireCharacter, PARTY_LIMIT } =
  await import('./session.js');
const { makeParty } = await import('../tools/headless/fixtures.js');
const CombatSceneMod = await import('../src/scenes/CombatScene.js');
const CombatScene = CombatSceneMod.default
  || Object.values(CombatSceneMod).find(v => typeof v === 'function');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};

// Two players' hunters, as they would arrive from each client's local save.
const roster = makeParty();
const wire = roster.map(toWireCharacter);
const alice = { id: 'alice', name: 'Alice', hunters: wire.slice(0, 3).map(w => JSON.parse(JSON.stringify(w))) };
const bob = { id: 'bob', name: 'Bob', hunters: wire.slice(3, 6).map(w => JSON.parse(JSON.stringify(w))) };

// ---- the wire round-trip ---------------------------------------------------
console.log('=== characters survive the wire ===');
{
  const before = roster[0];
  const after = fromWireCharacter(JSON.parse(JSON.stringify(toWireCharacter(before))));
  check('skills come back with real apply() functions',
    after.skills.filter(s => typeof s.apply === 'function').length ===
    before.skills.filter(s => typeof s.apply === 'function').length,
    after.skills.filter(s => typeof s.apply === 'function').length + ' of ' + after.skills.length);
  check('derived stats are recomputed, not trusted', after.maxHP === before.maxHP,
    'maxHP ' + after.maxHP);

  let threw = null;
  try { fromWireCharacter({ skillIds: ['not_a_real_skill'] }); } catch (e) { threw = e.message; }
  check('an unknown skill id throws rather than vanishing', !!threw, threw || '');
}

// ---- party assembly --------------------------------------------------------
console.log('=== the shared party of six ===');
{
  let threw = null;
  try {
    createSession({ CombatScene, players: [alice, bob, { id: 'carol', name: 'Carol', hunters: [wire[0]] }] });
  } catch (e) { threw = e.message; }
  check('a seventh hunter is refused', !!threw && /limit is 6/.test(threw), threw || '');

  let dup = null;
  try { createSession({ CombatScene, players: [alice, alice] }); } catch (e) { dup = e.message; }
  check('duplicate player ids are refused', !!dup, dup || '');
}

// ---- a real co-op fight ----------------------------------------------------
console.log('=== a two-player fight, 3 hunters each ===');
const session = createSession({
  CombatScene, players: [alice, bob], scenarioId: 'training_encounter_1', seed: 2024,
});

{
  const s = session.state();
  check('party is six, split across two owners',
    s.units.filter(u => u.side === 'ally').length === 6);
  const owners = new Set(s.units.filter(u => u.side === 'ally').map(u => u.owner));
  check('every hunter has an owner and both players are represented',
    owners.size === 2 && !owners.has(null), [...owners].join(' + '));
  check('state payload is small enough to broadcast whole',
    JSON.stringify(s).length < 12000, JSON.stringify(s).length + ' bytes');
  check('a human is due to act', s.current?.ownerId != null, s.current?.name);
}

// The wrong player cannot act.
{
  const cur = session.current();
  const wrongPlayer = cur.ownerId === 'alice' ? 'bob' : 'alice';
  const r = session.act(wrongPlayer, { actor: cur.ref, skill: 'basic_attack' });
  check('the other player cannot act for you', r.ok === false, r.reason);
  const e = session.endTurn(wrongPlayer);
  check('...nor end your turn', e.ok === false, e.reason);
}

// Play it out: whoever is up attacks, then ends their turn.
{
  let turns = 0;
  let acted = 0;
  while (!session.isOver && turns < 200) {
    const cur = session.current();
    if (!cur || cur.ownerId == null) break;
    const foe = session.state().units.find(u => u.side === 'enemy' && u.hp > 0);
    if (foe) {
      const r = session.act(cur.ownerId, { actor: cur.ref, skill: 'basic_attack', target: foe.ref });
      if (r.ok) acted++;
    }
    session.endTurn(cur.ownerId);
    turns++;
  }
  const s = session.state();
  check('the fight ran to a conclusion', session.isOver, turns + ' player turns, ' + acted + ' actions');
  check('every enemy is down', s.units.filter(u => u.side === 'enemy' && u.hp > 0).length === 0);
  check('the combat log was produced', s.logLength > 0, s.logLength + ' lines');
}

// ---- solo through the same code path ---------------------------------------
console.log('=== one player, six hunters (co-op code path, solo) ===');
{
  const solo = createSession({
    CombatScene,
    players: [{ id: 'solo', name: 'Solo', hunters: wire.map(w => JSON.parse(JSON.stringify(w))) }],
    scenarioId: 'training_encounter_1', seed: 2024,
  });
  let turns = 0;
  while (!solo.isOver && turns < 200) {
    const cur = solo.current();
    if (!cur || cur.ownerId == null) break;
    const foe = solo.state().units.find(u => u.side === 'enemy' && u.hp > 0);
    if (foe) solo.act('solo', { actor: cur.ref, skill: 'basic_attack', target: foe.ref });
    solo.endTurn('solo');
    turns++;
  }
  check('a 6/0 split works identically', solo.isOver, turns + ' turns');
}

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
