// @ts-nocheck
// server/index.js
//
// The socket shell. Deliberately thin: every decision about lobbies, the
// shared party of six, ownership and turn order lives in protocol.js and
// session.js, both of which are driven by tests with no network at all. This
// file only moves bytes and manages connections.
//
//   node server/index.js          (after `npm install` in this directory)
//   PORT=8080 node server/index.js
//
// The game itself stays a dependency-free static site on GitHub Pages. This
// directory is its own npm project so that stays true.

import http from 'node:http';

// MUST come before anything that imports CombatScene, which reaches for Phaser
// at module scope. `deterministic: false` is the important part for a server -
// see useSystemRandom in phaserStub.js for why seeding a long-running process
// is wrong in two separate ways.
import { installPhaserStub } from '../tools/headless/phaserStub.js';
installPhaserStub(0, { deterministic: false });

const { createHub } = await import('./protocol.js');
const CombatSceneMod = await import('../src/scenes/CombatScene.js');
const CombatScene = CombatSceneMod.default
  || Object.values(CombatSceneMod).find(v => typeof v === 'function');

let WebSocketServer;
try {
  ({ WebSocketServer } = await import('ws'));
} catch {
  console.error(
    'The `ws` package is not installed.\n' +
    '  cd server && npm install\n' +
    '\n' +
    'Everything except the socket layer can be exercised without it:\n' +
    '  node server/protocol_test.mjs\n' +
    '  node server/session_test.mjs'
  );
  process.exit(1);
}

const PORT = Number(process.env.PORT) || 8787;
const hub = createHub({ CombatScene });

const httpServer = http.createServer((req, res) => {
  // A health endpoint, because every host wants one and because it is the
  // quickest way to tell "the process is up" from "the socket is broken".
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, lobbies: hub.lobbies.size, uptime: process.uptime() }));
    return;
  }
  res.writeHead(404).end('Behel\'ith co-op server');
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (socket, req) => {
  // The hub speaks in objects; the socket speaks in text. This adapter is the
  // only place that difference exists.
  const conn = {
    send(msg) {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    },
  };

  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });

  socket.on('message', (data) => {
    // A message must never be able to take the server down. A malformed one is
    // already handled inside hub.handle; this catch is for the unforeseen.
    try {
      hub.handle(conn, String(data));
    } catch (err) {
      console.error('[handle]', err);
      conn.send({ t: 'error', reason: 'the server could not process that' });
    }
  });

  socket.on('close', () => hub.disconnect(conn));
  socket.on('error', () => hub.disconnect(conn));
});

// Heartbeat. A dropped connection often does not fire 'close' - the socket
// simply stops answering - and without this a lobby would wait forever for a
// player who is gone.
const HEARTBEAT_MS = 30_000;
const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (socket.isAlive === false) { socket.terminate(); continue; }
    socket.isAlive = false;
    socket.ping();
  }
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeat));

httpServer.listen(PORT, () => {
  console.log(`Behel'ith co-op server listening on :${PORT}`);
  console.log(`  health  http://localhost:${PORT}/health`);
  console.log(`  socket  ws://localhost:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n${signal} — closing`);
    clearInterval(heartbeat);
    wss.close();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
