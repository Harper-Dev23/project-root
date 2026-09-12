// @ts-nocheck
// server/limits_test.mjs
//
// A player cannot take the server down by sending an enormous message.
//
// `ws` accepts 100 MB messages unless told otherwise, and this server never
// told it otherwise. One process runs one hunt, so a message big enough to
// exhaust memory ends the fight for everyone in it. This starts the REAL server
// process and sends real frames over a real socket — a limit set on the wrong
// object, or an oversized frame that crashes the process instead of closing one
// connection, would both pass a test that only called the hub.
//
// Run: node server/limits_test.mjs

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8789;                          // e2e_test uses 8788
const URL = `ws://127.0.0.1:${PORT}`;
const CAP = 1024 * 1024;                    // must match MAX_MESSAGE_BYTES in index.js

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};

if (typeof WebSocket !== 'function') {
  console.error('This Node has no global WebSocket client (needs Node 22+). Skipping.');
  process.exit(0);
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

async function health() {
  const res = await fetch(`http://127.0.0.1:${PORT}/health`);
  return res.ok ? res.json() : null;
}

async function waitForServer(ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (server.exitCode != null) throw new Error('server exited:\n' + serverOut);
    try { const h = await health(); if (h) return h; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('server never became healthy:\n' + serverOut);
}

/** Opens a socket and resolves once connected. Records messages and the close code. */
function connect() {
  const ws = new WebSocket(URL);
  const state = { ws, inbox: [], closeCode: null };
  ws.addEventListener('message', (ev) => { try { state.inbox.push(JSON.parse(ev.data)); } catch { } });
  state.closed = new Promise(res => ws.addEventListener('close', (ev) => { state.closeCode = ev.code; res(ev.code); }));
  state.open = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  return state;
}

/** Sends a `browse` padded to `bytes` and waits for the lobby list, or null on timeout. */
function browsePadded(c, bytes, ms = 5000) {
  const before = c.inbox.length;
  const base = JSON.stringify({ t: 'browse', pad: '' });
  c.ws.send(JSON.stringify({ t: 'browse', pad: 'x'.repeat(Math.max(0, bytes - base.length)) }));
  return new Promise((res) => {
    const deadline = Date.now() + ms;
    const tick = () => {
      const got = c.inbox.slice(before).find(m => m.t === 'lobbies');
      if (got) return res(got);
      if (Date.now() > deadline || c.closeCode != null) return res(null);
      setTimeout(tick, 25);
    };
    tick();
  });
}

try {
  const h0 = await waitForServer();
  const startedAt = h0.startedAt;
  console.log('=== message size limit (real server, real sockets) ===');

  // A bystander who is already connected — standing in for a player mid-hunt.
  const bystander = connect();
  await bystander.open;

  // A realistic large message must still work. 200 KB is 5x the biggest real
  // message (a full-party lobby create, ~40 KB).
  const normal = connect();
  await normal.open;
  const ok = await browsePadded(normal, 200 * 1024);
  check('a large but legitimate message is answered', !!ok, ok ? 'got lobbies' : 'no reply');

  // Just under the cap is accepted.
  const under = await browsePadded(normal, CAP - 64);
  check('a message just under the limit is accepted', !!under,
    `${Math.round((CAP - 64) / 1024)} KB`);

  // Over the cap: the SENDER is disconnected with 1009 (Message Too Big).
  const abuser = connect();
  await abuser.open;
  const over = await browsePadded(abuser, CAP + 1024, 5000);
  const code = await Promise.race([abuser.closed, new Promise(r => setTimeout(() => r('still open'), 5000))]);
  check('an oversized message gets no answer', over === null);
  check('...and the sender is disconnected with 1009 (Message Too Big)', code === 1009, 'close code ' + code);

  // A far larger one — the kind that could have exhausted memory — same result.
  const flood = connect();
  await flood.open;
  flood.ws.send('x'.repeat(20 * 1024 * 1024));
  const floodCode = await Promise.race([flood.closed, new Promise(r => setTimeout(() => r('still open'), 8000))]);
  check('a 20 MB message is refused the same way', floodCode === 1009, 'close code ' + floodCode);

  // The part that matters: nobody else was affected.
  await new Promise(r => setTimeout(r, 200));
  const h1 = await health();
  check('the server process is still running', server.exitCode == null && !!h1,
    server.exitCode == null ? 'alive' : 'EXITED ' + server.exitCode);
  check('...and never restarted', h1?.startedAt === startedAt, `startedAt ${h1?.startedAt}`);
  check('the already-connected player is still connected', bystander.closeCode == null,
    bystander.closeCode == null ? 'open' : 'closed ' + bystander.closeCode);
  const stillServed = await browsePadded(bystander, 256);
  check('...and is still being answered', !!stillServed);

  const late = connect();
  await late.open;
  check('a new player can still connect and be answered', !!(await browsePadded(late, 256)));

  for (const c of [bystander, normal, late]) { try { c.ws.close(); } catch { } }
} catch (err) {
  console.log('  FAIL  ' + err.message);
  failures++;
} finally {
  stop();
}

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
