// @ts-nocheck
// server/client_test.mjs
//
// Drives the REAL browser client (src/systems/CoopClient.js) against the REAL
// server over real sockets. Two clients, one hunt, played to the end.
//
// e2e_test.mjs proves the server; this proves the code the game will actually
// ship — including that a client discards stale boards, which is the rule that
// broke the first end-to-end run.
//
// Run: node server/client_test.mjs      (after `cd server && npm install`)

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { installPhaserStub } from '../tools/headless/phaserStub.js';
installPhaserStub(606, { deterministic: false });

const { createCoopClient, CoopStatus } = await import('../src/systems/CoopClient.js');
const { toWireCharacter } = await import('../src/systems/CoopWire.js');
const { makeParty } = await import('../tools/headless/fixtures.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8791;
const URL = `ws://127.0.0.1:${PORT}`;

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Wait for a condition, rather than sleeping a guessed amount and hoping.
 *
 * The `await` on the predicate matters: an async predicate returns a Promise,
 * which is ALWAYS truthy. Without it the health check below passed instantly
 * against a server that had not started, and the first failure was an empty
 * WebSocket error with no explanation.
 */
async function until(fn, label, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(20);
  }
  throw new Error('timed out waiting for ' + label);
}

const server = spawn(process.execPath, [path.join(HERE, 'index.js')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = '';
server.stdout.on('data', d => { serverOut += d; });
server.stderr.on('data', d => { serverOut += d; });
const stop = () => { try { server.kill(); } catch { } };
process.on('exit', stop);

try {
  await until(async () => {
    if (server.exitCode != null) throw new Error('server exited:\n' + serverOut);
    try { return (await fetch(`http://127.0.0.1:${PORT}/health`)).ok; } catch { return false; }
  }, 'the server to be healthy');

  const roster = makeParty().map(toWireCharacter);
  const take = (n, from) => JSON.parse(JSON.stringify(roster.slice(from, from + n)));

  console.log('=== two real clients, one lobby ===');
  const alice = createCoopClient({ url: URL });
  const bob = createCoopClient({ url: URL });
  const errors = { alice: [], bob: [] };
  alice.on('error', r => errors.alice.push(r));
  bob.on('error', r => errors.bob.push(r));

  await alice.connect();
  await bob.connect();
  check('both clients connected', alice.status === CoopStatus.CONNECTED
    && bob.status === CoopStatus.CONNECTED);

  alice.createLobby({ name: 'Alice', scenarioId: 'training_encounter_1', hunters: take(3, 0) });
  await until(() => alice.code, 'the lobby code');
  check('the host got a code and is host', !!alice.code && alice.isHost, alice.code);

  bob.joinLobby({ code: alice.code, name: 'Bob', hunters: take(3, 3) });
  await until(() => bob.playerId, 'bob to join');
  check('the guest joined and is NOT host', bob.playerId === 'p2' && !bob.isHost);

  await until(() => alice.lobby?.used === 6, 'the lobby to show six');
  check('the lobby reports six of six used', alice.lobby.used === 6);

  console.log('=== starting ===');
  alice.setReady(true);
  bob.setReady(true);
  await until(() => alice.lobby?.players?.every(p => p.ready), 'everyone ready');
  alice.startHunt();
  await until(() => alice.state && bob.state, 'the opening board');
  check('both clients hold the opening board',
    alice.status === CoopStatus.FIGHTING && bob.status === CoopStatus.FIGHTING);
  check('exactly one client believes it is their turn',
    (alice.isMyTurn ? 1 : 0) + (bob.isMyTurn ? 1 : 0) === 1,
    alice.isMyTurn ? 'alice' : 'bob');

  console.log('=== the wrong client is refused ===');
  {
    const idle = alice.isMyTurn ? bob : alice;
    const who = idle === alice ? 'alice' : 'bob';
    const before = errors[who].length;
    idle.act({ actor: idle.state.current.ref, skill: 'basic_attack' });
    await until(() => errors[who].length > before, 'a refusal');
    check('acting out of turn is refused', /not yours|not .*turn/.test(errors[who].slice(-1)[0]),
      errors[who].slice(-1)[0]);
  }

  console.log('=== a hunt, played by the real client code ===');
  let over = null;
  alice.on('over', m => { over = m; });
  let bobOver = null;
  bob.on('over', m => { bobOver = m; });

  let turns = 0;
  while (!over && turns < 300) {
    const actor = alice.isMyTurn ? alice : (bob.isMyTurn ? bob : null);
    if (!actor) break;

    const v = actor.state.version;
    const foe = actor.state.units.find(u => u.side === 'enemy' && u.hp > 0);
    if (foe) {
      actor.act({ actor: actor.state.current.ref, skill: 'basic_attack', target: foe.ref });
      await until(() => actor.state.version > v, 'the board after acting');
    }
    if (over) break;

    const v2 = actor.state.version;
    actor.endTurn();
    await until(() => actor.state.version > v2 || over, 'the board after ending the turn');
    turns++;
  }

  check('the hunt finished', !!over, over?.outcome + ' after ' + turns + ' turns');
  check('both clients saw the outcome', !!bobOver);
  check('both clients agree on the final board',
    alice.state.version === bob.state.version, 'v' + alice.state.version + ' vs v' + bob.state.version);
  check('the combat log accumulated', alice.log.length > 0, alice.log.length + ' lines');
  check('no unexpected refusals', errors.alice.length + errors.bob.length === 1,
    JSON.stringify([...errors.alice, ...errors.bob]));

  console.log('=== disconnect ===');
  alice.disconnect();
  bob.disconnect();
  await until(async () => {
    const h = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
    return h.lobbies === 0;
  }, 'the lobby to be cleaned up');
  check('the lobby was cleaned up', true);

} catch (err) {
  // A WebSocket failure arrives as an Event, which has no `.message` - report
  // something useful instead of an empty line.
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
