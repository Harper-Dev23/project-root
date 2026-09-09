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

  // Two tabs on one machine share localStorage, so both players load the same
  // save and can pick the same character. Two units under one instanceId makes
  // every reference to them ambiguous.
  let sameHunter = null;
  try {
    createSession({
      CombatScene,
      players: [
        { id: 'a', name: 'A', hunters: [JSON.parse(JSON.stringify(wire[0]))] },
        { id: 'b', name: 'B', hunters: [JSON.parse(JSON.stringify(wire[0]))] },
      ],
    });
  } catch (e) { sameHunter = e.message; }
  check('the same hunter cannot be brought twice',
    !!sameHunter && /twice/.test(sameHunter), sameHunter || '');
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

// ---- recording pace --------------------------------------------------------
console.log('=== the recording is paced by the host, and replayed one to one ===');
{
  const { GameplaySettings } = await import('../src/systems/GameplaySettings.js');

  // The recording is made at the pace it will be watched at, taken from the
  // lobby host. Clients replay one to one, so this number IS the on-screen
  // duration — there is no second multiplier anywhere.
  createSession({ CombatScene, players: [alice], scenarioId: 'training_encounter_1', quickCombat: true });
  check('quickCombat: true records at 1x', GameplaySettings.animDurationMult() === 1,
    'animDurationMult() = ' + GameplaySettings.animDurationMult());
  createSession({ CombatScene, players: [alice], scenarioId: 'training_encounter_1', quickCombat: false });
  check('the default records at the game default 4x', GameplaySettings.animDurationMult() === 4,
    'animDurationMult() = ' + GameplaySettings.animDurationMult());

  // Measure a real enemy round, so the number can be sanity-checked against
  // how long it ought to feel rather than merely asserted to exist.
  const s2 = createSession({
    CombatScene,
    players: [{ id: 'solo', name: 'Solo', hunters: wire.slice(0, 3).map(w => JSON.parse(JSON.stringify(w))) }],
    scenarioId: 'training_encounter_3', seed: 7, quickCombat: true,
  });
  let span = 0, count = 0;
  for (let i = 0; i < 12 && !s2.isOver; i++) {
    const cur = s2.current();
    if (!cur || cur.ownerId == null) break;
    const foe = s2.state().units.find(u => u.side === 'enemy' && u.hp > 0);
    if (foe) s2.act('solo', { actor: cur.ref, skill: 'basic_attack', target: foe.ref });
    const r = s2.endTurn('solo');
    const evs = r.events || [];
    if (evs.length > count) {
      count = evs.length;
      span = (evs[evs.length - 1].at || 0) - (evs[0].at || 0);
    }
  }
  // Replayed one to one, so this is literally how long it takes on screen.
  check('a Quick Combat enemy round is seconds, not half a minute',
    span < 12000, span + 'ms on screen across ' + count + ' events');
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
