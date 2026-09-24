// server/summons_test.mjs
//
// HP-threshold summons in co-op (owner report, 2026-09-24: co-op did not
// spawn viable minions on Ember/Rime). Two causes, both fixed:
//   - the server runs the headless fight host, whose _updateHealthBars stub
//     skipped the summon check, so the server never summoned at all;
//   - each client's real CombatScene DID run the check, and put its own local
//     add on its board, one the server never knew (never acted, could not be
//     hit for real).
// Now the server summons, a co-op client never does, and a client builds the
// server's add from the broadcast (CombatScene._applyNetState).
//
// A real server session (session.js) on encounter 5's Reckoning I, and a real
// co-op client scene built the way coop_scene_test.mjs builds one, fed the
// server's own state. No sockets: the wire is the state object itself.
//
// Run: node server/summons_test.mjs

import { installPhaserStub } from '../tools/headless/phaserStub.js';
installPhaserStub(2025);

const { createSession, toWireCharacter } = await import('./session.js');
const { createCombatHost } = await import('../tools/headless/combatHost.js');
const { makeParty } = await import('../tools/headless/fixtures.js');
const CombatSceneMod = await import('../src/scenes/CombatScene.js');
const CombatScene = CombatSceneMod.default || Object.values(CombatSceneMod).find(v => typeof v === 'function');

const SCENARIO = 'training_encounter_5_reckoning_1';
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};

const wire = makeParty().map(toWireCharacter);
const copy = (a) => JSON.parse(JSON.stringify(a));
const session = createSession({
  CombatScene, scenarioId: SCENARIO, seed: 55,
  players: [{ id: 'alice', name: 'Alice', hunters: copy(wire.slice(0, 3)) }, { id: 'bob', name: 'Bob', hunters: copy(wire.slice(3, 6)) }],
});
const server = session.host;
const adds = () => server.enemies.filter(e => e.isAdd);
/** Take a summoner to a share of its max HP, the way damage does: then the HP hook runs. */
const hurt = (unit, pct) => {
  unit.currentHP = Math.floor(unit.maxHP * pct);
  server._updateHealthBars();
  server.__drain();
};

console.log('=== the server summons ===');
const ember = server.enemies.find(e => e.name === 'Ember');
const rime = server.enemies.find(e => e.name === 'Rime');
check('encounter 5 Reckoning I has Ember and Rime, each with a summon', !!ember?.summon && !!rime?.summon);
hurt(ember, 0.9);
check('above 75%: nothing is summoned', adds().length === 0);
hurt(ember, 0.7);
const first = adds();
check('Ember below 75%: the server summons one add', first.length === 1 && first[0].name === ember.summon.name, first.map(a => a.name).join(','));
check('...it is on the board and in the turn order, and knows who called it',
  !!first[0]?._slot && server.turnOrder.includes(first[0]) && first[0]._summonerRef === server._unitRef(ember));
hurt(ember, 0.6);
check('...once per threshold: no second add above the next one', adds().length === 1);
hurt(ember, 0.3);
check('Ember below 35%: the second add', adds().length === 2);
hurt(rime, 0.7);
check('Rime below 75%: its own add', adds().length === 3 && adds().at(-1).name === rime.summon.name);
{
  // Viable: the add takes a real enemy turn on the server and lands on the party.
  const add = first[0];
  const hpBefore = session.party.reduce((t, c) => t + c.currentHP, 0);
  const logBefore = server.combatEntries.length;
  server._takeEnemyTurn_viaLogic(add);
  server.__drain();
  const acted = server.combatEntries.slice(logBefore).some(e => (e.segments || []).some(sg => String(sg.text).includes(add.name)));
  const dealt = hpBefore - session.party.reduce((t, c) => t + c.currentHP, 0);
  check('the add takes a real turn on the server, and it lands on the party', acted && dealt > 0, `${dealt} damage`);
}
const state = session.state();
const addUnits = state.units.filter(u => u.add);
check('the broadcast state names each add and who called it',
  addUnits.length === 3 && addUnits.every(u => u.side === 'enemy' && u.slot != null)
  && addUnits.filter(u => u.add.summoner === server._unitRef(ember)).length === 2
  && addUnits.filter(u => u.add.summoner === server._unitRef(rime)).length === 1,
  JSON.stringify(addUnits.map(u => [u.ref, u.slot, u.add.summoner])));
check('...and every other unit carries no add marker', state.units.filter(u => !u.add).every(u => !server.enemies.find(e => server._unitRef(e) === u.ref)?.isAdd));

console.log('=== a co-op client builds the server\'s adds, and never its own ===');
{
  const client = createCombatHost(CombatScene);
  client.isCoop = true;
  client.coopClient = {
    roster: session.party.map(c => ({ ...toWireCharacter(c), ownerId: c.ownerId })),
    playerId: 'alice', gearSeed: session.gearSeed,
    on: () => () => {}, requestSync: () => {},
  };
  client.coopParty = [];
  client._coopUnsubs = [];
  client.scenarioId = SCENARIO;
  client.gearSeed = session.gearSeed;
  client._placeCoopParty();
  client._placeEnemies(SCENARIO);
  client.turnOrder = [...client.coopParty, ...client.enemies];

  const cEmber = client.enemies.find(e => e.name === 'Ember');
  cEmber.currentHP = Math.floor(cEmber.maxHP * 0.3);
  client._updateHealthBars();
  client.__drain();
  check('the client\'s own summoner below both thresholds summons nothing locally', client.enemies.filter(e => e.isAdd).length === 0);

  const report = client._applyNetState(state);
  const cAdds = client.enemies.filter(e => e.isAdd);
  check('applying the server\'s state resolves every unit (no resync needed)', report.ok && report.unknown.length === 0, JSON.stringify(report.unknown));
  check('...the client now has exactly the server\'s three adds, under the server\'s ids',
    cAdds.length === 3 && addUnits.every(u => cAdds.some(a => a.uid === u.ref)));
  check('...each in the slot the server put it, with the server\'s HP',
    addUnits.every(u => { const a = cAdds.find(x => x.uid === u.ref); return a?._slot?.slotId === u.slot && a.currentHP === u.hp; }));
  check('...and the turn order matches the server\'s', client.turnOrder.map(u => client._unitRef(u)).join('|') === state.turnOrder.join('|'));
  const again = client._applyNetState(session.state());
  check('a second broadcast builds nothing new', again.ok && client.enemies.filter(e => e.isAdd).length === 3);
}
{
  // A client whose own enemy count has run ahead of the server's (a board
  // rebuilt on reconnect, say): its adds must still take the server's ids,
  // or every later broadcast about them goes unresolved.
  const client = createCombatHost(CombatScene);
  client.isCoop = true;
  client.coopClient = { roster: session.party.map(c => ({ ...toWireCharacter(c), ownerId: c.ownerId })), playerId: 'bob', gearSeed: session.gearSeed, on: () => () => {}, requestSync: () => {} };
  client.coopParty = []; client._coopUnsubs = []; client.scenarioId = SCENARIO; client.gearSeed = session.gearSeed;
  client._placeCoopParty();
  client._placeEnemies(SCENARIO);
  client.turnOrder = [...client.coopParty, ...client.enemies];
  client._nextEnemyUid = 40;
  const report = client._applyNetState(session.state());
  check("a client whose enemy count ran ahead still gives each add the server's id", report.ok
    && addUnits.every(u => client.enemies.some(e => e.isAdd && e.uid === u.ref)), JSON.stringify(report.unknown));
}

console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
