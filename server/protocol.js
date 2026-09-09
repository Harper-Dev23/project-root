// @ts-nocheck
// server/protocol.js
//
// The lobby and the message protocol, with no transport underneath.
//
// A "connection" here is anything with a `send(obj)` method and an identity.
// The WebSocket server passes real sockets; the tests pass plain objects that
// push into an array. That seam is the whole point: every rule about joining,
// readying, the shared party budget and whose action counts can be driven and
// verified in a plain Node process, so the socket layer stays a thin shell
// with no decisions of its own.
//
// LOAD ORDER: installPhaserStub() must run before this module is imported.

if (!globalThis.Phaser) {
  throw new Error('server/protocol.js imported before installPhaserStub().');
}

import { createSession, PARTY_LIMIT } from './session.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  // no I/O/0/1

/**
 * Lobby codes are read aloud and typed by hand, so the alphabet drops the
 * characters people confuse (I/1, O/0). Uses crypto when available rather
 * than Math.random, because the harness seeds Math.random for determinism and
 * a seeded lobby code would be guessable.
 */
function makeCode(len = 4) {
  const bytes = globalThis.crypto?.getRandomValues
    ? globalThis.crypto.getRandomValues(new Uint8Array(len))
    : Array.from({ length: len }, () => Math.floor(Math.random() * 256));
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

export function createHub({ CombatScene, codeFactory = makeCode } = {}) {
  if (!CombatScene) throw new Error('createHub needs the CombatScene class');

  const lobbies = new Map();   // code -> lobby
  const byConn = new Map();    // conn -> { code, playerId }

  const send = (conn, msg) => { try { conn.send(msg); } catch { /* dead socket */ } };
  const fail = (conn, reason) => send(conn, { t: 'error', reason });

  const lobbyView = (lobby) => ({
    t: 'lobby',
    code: lobby.code,
    scenarioId: lobby.scenarioId,
    hostId: lobby.hostId,
    limit: PARTY_LIMIT,
    used: lobby.players.reduce((n, p) => n + p.hunters.length, 0),
    started: !!lobby.session,
    players: lobby.players.map(p => ({
      id: p.id,
      name: p.name,
      ready: p.ready,
      hunters: p.hunters.map(h => ({ ref: h.instanceId || h.id, name: h.name })),
    })),
  });

  const broadcast = (lobby, msg) => {
    for (const p of lobby.players) if (p.conn) send(p.conn, msg);
  };

  const budgetLeft = (lobby, exceptPlayerId = null) =>
    PARTY_LIMIT - lobby.players
      .filter(p => p.id !== exceptPlayerId)
      .reduce((n, p) => n + p.hunters.length, 0);

  /** After any action, push the new state and the log it produced. */
  const pushResult = (lobby, result, actorConn = null) => {
    if (!result?.state) return;
    broadcast(lobby, {
      t: 'state',
      state: result.state,
      log: result.log || [],
      events: result.events || [],
    });

    // A skill that started and then gave up explained itself to the player who
    // cast it, not to the room. See session.fingerprint for how those are told
    // apart from real actions.
    if (actorConn && result.privateLog?.length) {
      send(actorConn, { t: 'privateLog', log: result.privateLog });
    }
    if (result.state.ended) {
      const units = result.state.units;
      const won = units.filter(u => u.side === 'enemy').every(u => u.hp <= 0);
      broadcast(lobby, {
        t: 'over',
        outcome: won ? 'victory' : 'defeat',
        scenarioId: lobby.scenarioId,
        // Reward DISTRIBUTION is deliberately not done here. Each client
        // applies its own rewards through the save system it already has;
        // the server only says what happened and who was present.
        survivors: units.filter(u => u.side === 'ally' && u.hp > 0).map(u => u.ref),
        players: lobby.players.map(p => p.id),
      });
    }
  };

  const handlers = {
    /** { t:'create', name, scenarioId, hunters } */
    create(conn, msg) {
      const code = codeFactory();
      const playerId = 'p1';
      const lobby = {
        code,
        scenarioId: msg.scenarioId || 'training_encounter_1',
        hostId: playerId,
        players: [],
        session: null,
        // The host's combat-speed preference paces the recording for everyone.
        quickCombat: !!msg.quickCombat,
      };
      lobbies.set(code, lobby);
      return handlers._seat(conn, lobby, playerId, msg);
    },

    /** { t:'join', code, name, hunters } */
    join(conn, msg) {
      const lobby = lobbies.get(String(msg.code || '').toUpperCase());
      if (!lobby) return fail(conn, 'no lobby with that code');
      if (lobby.session) return fail(conn, 'that hunt has already started');
      const playerId = 'p' + (lobby.players.length + 1);
      return handlers._seat(conn, lobby, playerId, msg);
    },

    _seat(conn, lobby, playerId, msg) {
      const hunters = Array.isArray(msg.hunters) ? msg.hunters : [];
      const left = budgetLeft(lobby);
      if (hunters.length > left) {
        return fail(conn, `only ${left} of the ${PARTY_LIMIT} party slots are left`);
      }
      const player = {
        id: playerId,
        name: msg.name || playerId,
        conn,
        hunters,
        ready: false,
      };
      lobby.players.push(player);
      byConn.set(conn, { code: lobby.code, playerId });
      send(conn, { t: 'joined', code: lobby.code, playerId, hostId: lobby.hostId });
      broadcast(lobby, lobbyView(lobby));
    },

    /** { t:'setHunters', hunters } - replaces this player's selection. */
    setHunters(conn, msg, lobby, player) {
      if (lobby.session) return fail(conn, 'the hunt has started');
      const hunters = Array.isArray(msg.hunters) ? msg.hunters : [];
      const left = budgetLeft(lobby, player.id);
      if (hunters.length > left) {
        return fail(conn, `only ${left} of the ${PARTY_LIMIT} party slots are left`);
      }
      player.hunters = hunters;
      player.ready = false;   // changing your party un-readies you
      broadcast(lobby, lobbyView(lobby));
    },

    /** { t:'ready', ready } */
    ready(conn, msg, lobby, player) {
      if (lobby.session) return fail(conn, 'the hunt has started');
      if (!player.hunters.length) return fail(conn, 'bring at least one hunter');
      player.ready = msg.ready !== false;
      broadcast(lobby, lobbyView(lobby));
    },

    /** { t:'start' } - host only, everyone ready. */
    start(conn, msg, lobby, player) {
      if (lobby.session) return fail(conn, 'already started');
      if (player.id !== lobby.hostId) return fail(conn, 'only the host can start');
      if (!lobby.players.every(p => p.ready)) return fail(conn, 'not everyone is ready');

      // ONE LIVE FIGHT PER PROCESS. This is not a policy choice, it is a
      // property of the engine: `GameState` is a module singleton, every
      // host's __begin() assigns `GameState.party`, and
      // _checkVictoryCondition reads `GameState.party` to decide whether the
      // party has fallen. A second concurrent session therefore silently
      // makes the FIRST one check the wrong party for deaths -- observed
      // directly: a wiped party kept "fighting", with six enemies taking
      // turns forever because defeat was never detected.
      //
      // Refusing loudly beats corrupting two fights quietly. Scaling out is
      // one process per hunt, which is cheap for a turn-based game; the
      // alternative is threading state through 23 GameState.party reads in a
      // 12,500-line file for no gameplay benefit.
      const busy = [...lobbies.values()].find(l => l !== lobby && l.session && !l.session.isOver);
      if (busy) {
        return fail(conn, 'this server is already running a hunt; only one at a time');
      }

      try {
        lobby.session = createSession({
          CombatScene,
          players: lobby.players.map(p => ({ id: p.id, name: p.name, hunters: p.hunters })),
          scenarioId: lobby.scenarioId,
          quickCombat: lobby.quickCombat,
          // No seed: the server leaves ambient randomness alone, so concurrent
          // hunts cannot reset each other's stream. See useSystemRandom.
          seed: null,
        });
      } catch (e) {
        return fail(conn, e.message);
      }
      // The roster goes out ONCE, with the opening board.
      //
      // A client only ever learned the NAMES of the other player's hunters
      // from the lobby view, which is not enough to draw them: it needs their
      // real stats, gear and skill ids to build the same board the server
      // built. Sent once at the start rather than with every broadcast, since
      // none of it changes during a fight - the per-action `state` stays small.
      const roster = lobby.players.flatMap(p =>
        (p.hunters || []).map(h => ({ ...h, ownerId: p.id })));

      broadcast(lobby, { t: 'started', state: lobby.session.state(), roster });
    },

    /** { t:'act', actor, skill, target } */
    act(conn, msg, lobby, player) {
      if (!lobby.session) return fail(conn, 'the hunt has not started');
      const result = lobby.session.act(player.id, {
        actor: msg.actor, skill: msg.skill, target: msg.target,
      });
      // A refusal goes only to the player who tried it. The others do not need
      // to see someone else's mis-click, and it keeps the broadcast a pure
      // record of what actually happened.
      if (!result.ok) return fail(conn, result.reason);
      pushResult(lobby, result, conn);
    },

    /** { t:'endTurn' } */
    endTurn(conn, msg, lobby, player) {
      if (!lobby.session) return fail(conn, 'the hunt has not started');
      const result = lobby.session.endTurn(player.id);
      if (!result.ok) return fail(conn, result.reason);
      pushResult(lobby, result);
    },

    /** { t:'say', text } - Local-tab chat, relayed to everyone in the lobby. */
    say(conn, msg, lobby, player) {
      const text = String(msg.text ?? '').slice(0, 200).trim();
      if (!text) return;
      // Relayed verbatim and attributed by the SERVER, from the seat the
      // message arrived on. Taking a name from the message body would let a
      // client speak as anyone.
      broadcast(lobby, { t: 'said', from: player.name, playerId: player.id, text });
    },

    /** { t:'sync' } - a client asking for the whole picture again. */
    sync(conn, msg, lobby) {
      if (lobby.session) send(conn, { t: 'state', state: lobby.session.state(), log: [] });
      else send(conn, lobbyView(lobby));
    },
  };

  return {
    lobbies,

    /** Route one message from one connection. */
    handle(conn, raw) {
      let msg = raw;
      if (typeof raw === 'string') {
        try { msg = JSON.parse(raw); } catch { return fail(conn, 'malformed message'); }
      }
      if (!msg || typeof msg.t !== 'string') return fail(conn, 'missing message type');

      if (msg.t === 'create' || msg.t === 'join') return handlers[msg.t](conn, msg);

      const seat = byConn.get(conn);
      if (!seat) return fail(conn, 'you are not in a lobby');
      const lobby = lobbies.get(seat.code);
      if (!lobby) return fail(conn, 'that lobby is gone');
      const player = lobby.players.find(p => p.id === seat.playerId);
      if (!player) return fail(conn, 'you are not seated');

      const fn = handlers[msg.t];
      if (!fn || msg.t.startsWith('_')) return fail(conn, `unknown message: ${msg.t}`);
      return fn(conn, msg, lobby, player);
    },

    /** A connection dropped. */
    disconnect(conn) {
      const seat = byConn.get(conn);
      byConn.delete(conn);
      if (!seat) return;
      const lobby = lobbies.get(seat.code);
      if (!lobby) return;

      const player = lobby.players.find(p => p.id === seat.playerId);
      if (player) player.conn = null;

      // A lobby that has not started can lose a player outright. One that HAS
      // started keeps their seat: their hunters are on the board and their
      // turn still has to be taken, so the seat is held for a reconnect rather
      // than deleted mid-fight.
      if (!lobby.session && player) {
        lobby.players = lobby.players.filter(p => p !== player);
      }
      if (lobby.players.every(p => !p.conn)) lobbies.delete(lobby.code);
      else broadcast(lobby, lobbyView(lobby));
    },
  };
}
