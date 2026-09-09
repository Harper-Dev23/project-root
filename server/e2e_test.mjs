// @ts-nocheck
// server/e2e_test.mjs
//
// The real thing: starts the actual server process, connects two real
// WebSocket clients, and plays a co-op hunt to victory over the network.
//
// protocol_test.mjs proves the rules with fake connections; this proves the
// socket layer wired them up correctly. Node 24 ships a WebSocket CLIENT, so
// this needs no dependency of its own.
//
// Run: node server/e2e_test.mjs      (after `cd server && npm install`)

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8788;
const URL = `ws://127.0.0.1:${PORT}`;

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};

if (typeof WebSocket !== 'function') {
  console.error('This Node has no global WebSocket client (needs Node 22+). Skipping.');
  process.exit(0);
}

// ---- start the real server -------------------------------------------------
const server = spawn(process.execPath, [path.join(HERE, 'index.js')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = '';
server.stdout.on('data', d => { serverOut += d; });
server.stderr.on('data', d => { serverOut += d; });

const stop = () => { try { server.kill(); } catch { } };
process.on('exit', stop);

/** Wait for the health endpoint to answer, rather than sleeping and hoping. */
async function waitForServer(ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (server.exitCode != null) throw new Error('server exited:\n' + serverOut);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (res.ok) return await res.json();
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('server never became healthy:\n' + serverOut);
}

/** A test client that records what it receives and can await a message type. */
function client(name) {
  const ws = new WebSocket(URL);
  const inbox = [];
  const waiters = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    inbox.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].type === msg.t) { waiters.splice(i, 1)[0].resolve(msg); }
    }
  });
  return {
    name, ws, inbox,
    open: new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', rej);
    }),
    send(msg) { ws.send(JSON.stringify(msg)); },
    last(type) { return [...inbox].reverse().find(m => m.t === type) || null; },
    errors() { return inbox.filter(m => m.t === 'error').map(m => m.reason); },
    /**
     * Resolves with a message of this type at or after `since` in the inbox.
     *
     * Taking an index matters: a broadcast can land BEFORE the caller gets
     * around to awaiting it, and a waiter that only listens for future
     * messages would then hang forever waiting for one that already arrived.
     * Callers capture `c.inbox.length` before sending and pass it here.
     */
    next(type, since = 0, ms = 8000) {
      const already = inbox.findIndex((m, i) => i >= since && m.t === type);
      if (already !== -1) return Promise.resolve(inbox[already]);
      return new Promise((resolve, reject) => {
        waiters.push({ type, resolve });
        setTimeout(() => reject(new Error(
          `${name}: timed out waiting for "${type}"; last saw ` +
          JSON.stringify(inbox.slice(-3).map(m => m.t + (m.reason ? ':' + m.reason : '')))
        )), ms);
      });
    },

    /**
     * Wait for a board strictly NEWER than the one we acted on.
     *
     * This is how a real client has to work. Several broadcasts can be in
     * flight at once, so "the next state message" is not necessarily the one
     * caused by your action - taking it produced a client that acted twice on
     * a stale board and was then told it was not its turn.
     */
    async nextState(afterVersion, ms = 8000) {
      const deadline = Date.now() + ms;
      for (;;) {
        const fresh = inbox.filter(m => m.t === 'state' && m.state.version > afterVersion);
        if (fresh.length) return fresh[fresh.length - 1].state;
        const err = inbox.filter(m => m.t === 'error').slice(-1)[0];
        if (Date.now() > deadline) {
          throw new Error(`${name}: no state newer than v${afterVersion}` +
            (err ? ` (last error: ${err.reason})` : ''));
        }
        await new Promise(r => setTimeout(r, 20));
      }
    },
    close() { try { ws.close(); } catch { } },
  };
}

try {
  console.log('=== the server starts ===');
  const health = await waitForServer();
  check('health endpoint answers', health.ok === true, JSON.stringify(health));

  // Build hunters exactly as a client would: from its own local save data.
  const { installPhaserStub } = await import('../tools/headless/phaserStub.js');
  installPhaserStub(99);
  const { makeParty } = await import('../tools/headless/fixtures.js');
  const { toWireCharacter } = await import('./session.js');
  const roster = makeParty().map(toWireCharacter);
  const take = (n, from) => JSON.parse(JSON.stringify(roster.slice(from, from + n)));

  console.log('=== two real sockets join a lobby ===');
  const alice = client('alice');
  const bob = client('bob');
  await alice.open;
  await bob.open;

  alice.send({ t: 'create', name: 'Alice', scenarioId: 'training_encounter_1', hunters: take(3, 0) });
  const joined = await alice.next('joined');
  check('host joined and got a lobby code', !!joined.code, joined.code);

  bob.send({ t: 'join', code: joined.code, name: 'Bob', hunters: take(3, 3) });
  const bobJoined = await bob.next('joined');
  check('second player joined over the socket', bobJoined.playerId === 'p2');

  const view = await bob.next('lobby');
  check('the lobby shows six of six used', view?.used === 6, 'used ' + view?.used);

  console.log('=== starting over the wire ===');
  const aReady = alice.inbox.length, bReady = bob.inbox.length;
  alice.send({ t: 'ready', ready: true });
  bob.send({ t: 'ready', ready: true });
  await alice.next('lobby', aReady);
  await bob.next('lobby', bReady);

  const aStart = alice.inbox.length, bStart = bob.inbox.length;
  alice.send({ t: 'start' });

  const started = await alice.next('started', aStart);
  const bobStarted = await bob.next('started', bStart);
  check('both clients received the opening board',
    !!started.state && !!bobStarted.state);
  check('the board has six hunters and live enemies',
    started.state.units.filter(u => u.side === 'ally').length === 6 &&
    started.state.units.some(u => u.side === 'enemy' && u.hp > 0));

  console.log('=== a hunt, played over real sockets ===');
  const conns = { p1: alice, p2: bob };
  let state = started.state;
  let over = null;
  let turns = 0;

  while (!over && turns < 300) {
    const cur = state.current;
    if (!cur || cur.ownerId == null) break;
    const me = conns[cur.ownerId];
    const foe = state.units.find(u => u.side === 'enemy' && u.hp > 0);

    if (turns === 0) {
      // The wrong player's action must be refused, over the real socket.
      const other = cur.ownerId === 'p1' ? bob : alice;
      const mark = other.inbox.length;
      other.send({ t: 'act', actor: cur.ref, skill: 'basic_attack', target: foe.ref });
      const err = await other.next('error', mark);
      check('the wrong player is refused over the wire', /not yours/.test(err.reason), err.reason);
    }

    if (foe) {
      me.send({ t: 'act', actor: cur.ref, skill: 'basic_attack', target: foe.ref });
      state = await me.nextState(state.version);
    }
    if (state.ended) { over = alice.last('over'); break; }

    me.send({ t: 'endTurn' });
    state = await me.nextState(state.version);
    if (process.env.DEBUG_E2E) {
      console.log(`    [turn ${turns}] v${state.version} current=${state.current?.name} (${state.current?.ownerId})`);
    }
    over = alice.last('over');
    turns++;
  }

  check('the hunt finished over the network', !!over,
    over?.outcome + ' after ' + turns + ' player turns');
  check('both clients were told the outcome', !!bob.last('over'));

  console.log('=== disconnect ===');
  alice.close();
  bob.close();
  await new Promise(r => setTimeout(r, 300));
  const after = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
  check('the lobby is cleaned up when everyone leaves', after.lobbies === 0,
    after.lobbies + ' lobbies still open');

} catch (err) {
  console.log('  FAIL  ' + err.message);
  failures++;
} finally {
  stop();
}

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
