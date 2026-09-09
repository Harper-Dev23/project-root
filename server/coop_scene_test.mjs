// @ts-nocheck
// server/coop_scene_test.mjs
//
// Co-op mode in CombatScene itself, driven by a live server over real sockets.
//
// Two clients each build a board the way the scene does — `_placeCoopParty`
// from the roster, `_wireCoopClient` to listen — then play a fight by calling
// the scene's own `_resolveAction`. In co-op that must SEND rather than
// resolve, so the proof is twofold: the fight progresses, and neither client
// ever moved its own board except by applying a broadcast.
//
// The server runs in its own process, which also keeps the GameState singleton
// out of the way: only client boards exist here.
//
// Run: node server/coop_scene_test.mjs

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { installPhaserStub } from '../tools/headless/phaserStub.js';
installPhaserStub(4711, { deterministic: false });

const { createCombatHost } = await import('../tools/headless/combatHost.js');
const { createCoopClient } = await import('../src/systems/CoopClient.js');
const { toWireCharacter } = await import('../src/systems/CoopWire.js');
const { makeParty } = await import('../tools/headless/fixtures.js');
const GameState = (await import('../src/systems/GameState.js')).default;
const CombatSceneMod = await import('../src/scenes/CombatScene.js');
const CombatScene = CombatSceneMod.default
  || Object.values(CombatSceneMod).find(v => typeof v === 'function');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8793;
const URL = `ws://127.0.0.1:${PORT}`;
const SCENARIO = 'training_encounter_1';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, label, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await fn()) return true; await sleep(20); }
  throw new Error('timed out waiting for ' + label);
}

const server = spawn(process.execPath, [path.join(HERE, 'index.js')], {
  env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = '';
server.stdout.on('data', d => { serverOut += d; });
server.stderr.on('data', d => { serverOut += d; });
const stop = () => { try { server.kill(); } catch { } };
process.on('exit', stop);

/** Stand up the co-op half of CombatScene against a connected client. */
function buildScene(client) {
  const host = createCombatHost(CombatScene);
  host.isCoop = true;
  host.coopClient = client;
  host.coopParty = [];
  host._coopUnsubs = [];
  host.scenarioId = SCENARIO;

  host._placeCoopParty();          // the real method
  host._placeEnemies(SCENARIO);    // the real method
  host.turnOrder = [...host.coopParty, ...host.enemies];
  host._wireCoopClient();          // the real method
  return host;
}

try {
  await until(async () => {
    if (server.exitCode != null) throw new Error('server exited:\n' + serverOut);
    try { return (await fetch(`http://127.0.0.1:${PORT}/health`)).ok; } catch { return false; }
  }, 'the server to be healthy');

  const roster = makeParty().map(toWireCharacter);
  const take = (n, from) => JSON.parse(JSON.stringify(roster.slice(from, from + n)));

  const alice = createCoopClient({ url: URL });
  const bob = createCoopClient({ url: URL });
  await alice.connect();
  await bob.connect();

  alice.createLobby({ name: 'Alice', scenarioId: SCENARIO, hunters: take(3, 0) });
  await until(() => alice.code, 'a lobby code');
  bob.joinLobby({ code: alice.code, name: 'Bob', hunters: take(3, 3) });
  await until(() => bob.playerId, 'bob to join');
  alice.setReady(true); bob.setReady(true);
  await until(() => alice.lobby?.players?.every(p => p.ready), 'everyone ready');
  alice.startHunt();
  await until(() => alice.state && bob.state && alice.roster.length, 'the opening board');

  console.log('=== the roster arrives and builds a board ===');
  check('the roster carries every hunter, not just ours',
    alice.roster.length === 6, alice.roster.length + ' hunters');
  check('each roster entry names its owner',
    alice.roster.every(h => h.ownerId), [...new Set(alice.roster.map(h => h.ownerId))].join(' + '));

  const scenes = { p1: buildScene(alice), p2: buildScene(bob) };

  check('_placeCoopParty built the whole shared party',
    scenes.p1.coopParty.length === 6, scenes.p1.coopParty.length + ' hunters on the board');
  check('hunters know whose they are',
    scenes.p1.coopParty.filter(c => c.isLocal).length === 3,
    scenes.p1.coopParty.filter(c => c.isLocal).length + ' local to Alice');
  check('their skills are real functions, not lost on the wire',
    scenes.p1.coopParty.every(c => c.skills.some(s => typeof s.apply === 'function')));
  // A real assertion, not a formality: _placeCoopParty must never write the
  // shared roster into the local player's saved party, or another player's
  // hunters would land in this player's save the next time anything autosaved.
  const coopIds = new Set(scenes.p1.coopParty.map(c => c.instanceId || c.id));
  check('the local saved party was NOT touched by the fight',
    !(GameState.party || []).some(c => coopIds.has(c.instanceId || c.id)),
    'GameState.party holds ' + (GameState.party || []).length);

  console.log('=== acting sends, and never resolves locally ===');
  {
    const client = alice.isMyTurn ? alice : bob;
    const scene = alice.isMyTurn ? scenes.p1 : scenes.p2;
    const before = JSON.stringify(scene.turnOrder.map(u => u.currentHP));
    const v = client.state.version;

    const foe = client.state.units.find(u => u.side === 'enemy' && u.hp > 0);
    const verdict = scene._resolveAction({
      actor: client.state.current.ref, skill: 'basic_attack', target: foe.ref,
    });
    check('_resolveAction reports that it sent rather than resolved',
      verdict.ok === true && verdict.sent === true, JSON.stringify(verdict.reason ?? 'sent'));
    check('the local board did not move on its own',
      JSON.stringify(scene.turnOrder.map(u => u.currentHP)) === before);

    await until(() => client.state.version > v, 'the server to answer');
    await sleep(50);
    check('and then the server\'s board landed',
      JSON.stringify(scene.turnOrder.map(u => u.currentHP)) !== before);
  }

  // The block above spent that hunter's major action, so hand the turn over
  // before the loop starts — otherwise its first act is refused and the test
  // waits for a board that is never coming.
  {
    const client = alice.isMyTurn ? alice : bob;
    const v = client.state.version;
    client.endTurn();
    await until(() => client.state.version > v, 'the turn to pass');
  }

  console.log('=== a whole fight, played through the scene ===');
  let over = null;
  alice.on('over', m => { over = m; });
  const refusals = [];
  alice.on('error', r => refusals.push('alice: ' + r));
  bob.on('error', r => refusals.push('bob: ' + r));

  let turns = 0;
  while (!over && turns < 300) {
    const client = alice.isMyTurn ? alice : (bob.isMyTurn ? bob : null);
    if (!client) break;
    const scene = client === alice ? scenes.p1 : scenes.p2;

    const foe = client.state.units.find(u => u.side === 'enemy' && u.hp > 0);
    if (foe) {
      const v = client.state.version;
      const errs = refusals.length;
      scene._resolveAction({
        actor: client.state.current.ref, skill: 'basic_attack', target: foe.ref,
      });
      // Either the board moves or the server says why not. Waiting only for a
      // board turns any refusal into an eight-second hang that reports nothing.
      await until(() => client.state.version > v || refusals.length > errs || over,
        'the board, or a reason it did not move');
    }
    if (over) break;

    const v2 = client.state.version;
    client.endTurn();
    await until(() => client.state.version > v2 || over, 'the board after the turn ended');
    turns++;
  }
  await sleep(100);

  check('the fight finished', !!over, over?.outcome + ' after ' + turns + ' turns');
  check('no action was refused along the way', refusals.length === 0,
    refusals.slice(0, 3).join(' | '));
  check('both scenes ended in agreement',
    JSON.stringify(scenes.p1.turnOrder.map(u => [u.name, u.currentHP])) ===
    JSON.stringify(scenes.p2.turnOrder.map(u => [u.name, u.currentHP])));
  check('both scenes agree with the server\'s last word',
    scenes.p1.enemies.every(e => {
      const said = alice.state.units.find(u => u.ref === e.uid);
      return said && said.hp === e.currentHP;
    }));
  check('the combat log reached the scene', scenes.p1.combatEntries.length > 0,
    scenes.p1.combatEntries.length + ' lines');

  alice.disconnect(); bob.disconnect();

} catch (err) {
  console.log('  FAIL  ' + (err?.message || err?.type || String(err)));
  if (serverOut.trim()) {
    console.log('  server said:');
    serverOut.trim().split('\n').forEach(l => console.log('    ' + l));
  }
  failures++;
} finally {
  stop();
}

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
