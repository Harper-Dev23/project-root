// src/systems/CoopClient.js
//
// The browser's side of a co-op hunt. Owns the socket, speaks the protocol,
// and hands the game plain events.
//
// Deliberately free of Phaser, so it can be driven headlessly against the real
// server (see server/client_test.mjs). Nothing here decides a rule -- the
// server owns those. This connects, sends intents, and keeps the newest board.
//
// Uses the platform WebSocket, which both browsers and Node 22+ provide, so
// the game gains no dependency and stays a static site.

const NOOP = () => { };

/**
 * States a client can be in. Worth naming, because "connected" and "in a
 * lobby" and "in a fight" are three different things and the UI needs to tell
 * them apart.
 */
/**
 * A stable id for THIS TAB, so a dropped socket can reclaim its seat.
 *
 * sessionStorage, NOT localStorage, and the difference is the whole point.
 * localStorage is shared by every tab of a browser profile, so two tabs would
 * carry the SAME id -- and since a seat already on a live socket is refused,
 * the second tab could not join at all. That is exactly how co-op gets tested
 * locally, two windows side by side, so it would have broken the normal way of
 * playing while claiming to make it more robust. sessionStorage is per tab and
 * survives a reload, which is the case reconnecting is actually for.
 *
 * Deliberately not an account and not an identity: never shown, never typed,
 * meaningless outside a lobby this tab is already sitting in.
 *
 * When there is no storage at all -- a Node test, a locked-down browser -- a
 * FRESH id is returned each time rather than a cached one. Without storage
 * there is nothing to persist, so caching would only make separate clients in
 * one process collide, which is the same trap in a different costume.
 */
let _cachedClientId = null;
export function coopClientId() {
  if (_cachedClientId) return _cachedClientId;
  const KEY = 'coop_client_id';
  const made = 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  try {
    const saved = sessionStorage.getItem(KEY);
    if (saved) return (_cachedClientId = saved);
    sessionStorage.setItem(KEY, made);
    return (_cachedClientId = made);
  } catch {
    return made;   // no storage: unique per call, cached never
  }
}

export const CoopStatus = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  LOBBY: 'lobby',
  FIGHTING: 'fighting',
  ENDED: 'ended',
  CLOSED: 'closed',
};

export function createCoopClient({ url, WebSocketImpl } = {}) {
  const WS = WebSocketImpl || globalThis.WebSocket;
  if (!WS) throw new Error('no WebSocket available in this environment');

  const listeners = new Map();
  let socket = null;

  const client = {
    url,
    status: CoopStatus.IDLE,
    playerId: null,
    hostId: null,
    code: null,
    lobby: null,
    state: null,      // newest board
    roster: [],       // every player's hunters, from the 'started' message
    openLobbies: [],  // public lobbies, from the last browse()
    log: [],          // combat log accumulated across broadcasts
    lastError: null,

    /** Subscribe. Returns an unsubscribe function. */
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event)?.delete(fn);
    },

    get isHost() { return this.playerId != null && this.playerId === this.hostId; },

    /** True when it is this player's turn to act. */
    get isMyTurn() {
      return this.state?.current?.ownerId != null
        && this.state.current.ownerId === this.playerId;
    },

    connect() {
      if (socket) return Promise.resolve(client);
      client.status = CoopStatus.CONNECTING;
      emit('status', client.status);

      return new Promise((resolve, reject) => {
        try { socket = new WS(url); }
        catch (err) { reject(err); return; }

        socket.addEventListener('open', () => {
          client.status = CoopStatus.CONNECTED;
          emit('status', client.status);
          resolve(client);
        });

        socket.addEventListener('message', (ev) => {
          let msg;
          try { msg = JSON.parse(ev.data); }
          catch { return; }          // a server that talks nonsense is not fatal
          handle(msg);
        });

        socket.addEventListener('error', (err) => {
          client.lastError = 'connection error';
          emit('error', client.lastError);
          reject(err);
        });

        socket.addEventListener('close', () => {
          socket = null;
          client.status = CoopStatus.CLOSED;
          emit('status', client.status);
          emit('closed');
        });
      });
    },

    disconnect() {
      try { socket?.close(); } catch { /* already gone */ }
      socket = null;
    },

    // ---- outbound -----------------------------------------------------------
    send(msg) {
      if (!socket || socket.readyState !== 1) return false;   // 1 === OPEN
      socket.send(JSON.stringify(msg));
      return true;
    },

    createLobby({ name, scenarioId, hunters, quickCombat = false, isPublic = false }) {
      return client.send({ t: 'create', name, scenarioId, hunters, quickCombat, isPublic,
        clientId: coopClientId() });
    },
    joinLobby({ code, name, hunters }) {
      // Sending the id on an ordinary join is what makes reconnecting work
      // without a separate "rejoin" flow: the server recognises a seat this
      // browser already holds and hands it back, fight in progress and all.
      // Typing the same code you were already in IS the reconnect.
      return client.send({ t: 'join', code, name, hunters, clientId: coopClientId() });
    },
    setHunters(hunters) { return client.send({ t: 'setHunters', hunters }); },
    setReady(ready = true) { return client.send({ t: 'ready', ready }); },
    /** Place one of YOUR hunters. `slotId: null` picks it back up. */
    claimSlot(ref, slotId) { return client.send({ t: 'claimSlot', ref, slotId }); },
    startHunt() { return client.send({ t: 'start' }); },
    endTurn() { return client.send({ t: 'endTurn' }); },
    requestSync() { return client.send({ t: 'sync' }); },
    say(text) { return client.send({ t: 'say', text }); },
    browse() { return client.send({ t: 'browse' }); },
    setPublic(isPublic) { return client.send({ t: 'setPublic', isPublic }); },

    /**
     * Send one action. Refusals come back as an 'error' event rather than a
     * rejected promise: the server refusing is a normal outcome the UI shows,
     * not an exception.
     */
    act({ actor, skill, target }) {
      return client.send({ t: 'act', actor, skill, target });
    },
  };

  function emit(event, payload) {
    for (const fn of (listeners.get(event) || [])) {
      try { fn(payload); } catch (err) { console.error(`[coop:${event}]`, err); }
    }
  }

  function handle(msg) {
    switch (msg.t) {
      case 'joined':
        client.resumed = !!msg.resumed;
        client.playerId = msg.playerId;
        client.hostId = msg.hostId;
        client.code = msg.code;
        client.status = CoopStatus.LOBBY;
        emit('joined', msg);
        emit('status', client.status);
        break;

      case 'lobby':
        client.lobby = msg;
        client.hostId = msg.hostId ?? client.hostId;
        emit('lobby', msg);
        break;

      case 'started':
        client.state = msg.state;
        // The full hunter data for EVERY player, sent once. The board cannot
        // be built from the lobby view alone, which carries only names.
        client.roster = msg.roster || [];
        client.status = CoopStatus.FIGHTING;
        emit('started', { state: msg.state, roster: client.roster });
        emit('status', client.status);
        break;

      case 'state':
        // Stale boards are DISCARDED, not applied.
        //
        // Several broadcasts are routinely in flight at once - an action, then
        // the end of turn that follows it - and they can arrive out of order.
        // Applying an older one would rewind the board and, worse, tell this
        // player it is still their turn after they ended it. That is not
        // hypothetical; it is how the first end-to-end run failed.
        if (client.state && msg.state.version <= client.state.version) break;
        client.state = msg.state;
        if (Array.isArray(msg.log) && msg.log.length) {
          client.log.push(...msg.log);
          emit('log', msg.log);
        }
        // Visuals are emitted BEFORE the board, so a listener can start the
        // animation and then let the authoritative state land underneath it.
        if (Array.isArray(msg.events) && msg.events.length) emit('events', msg.events);
        emit('state', msg.state);
        break;

      case 'lobbies':
        client.openLobbies = msg.lobbies || [];
        emit('lobbies', client.openLobbies);
        break;

      case 'said':
        emit('said', msg);
        break;

      case 'privateLog':
        // Only this player was sent these — the privacy is the server's doing,
        // not a flag here. They go into the local log like any other lines, so
        // the combat log reads normally for the player who caused them.
        if (Array.isArray(msg.log) && msg.log.length) {
          client.log.push(...msg.log);
          emit('log', msg.log);
        }
        break;

      case 'over':
        client.status = CoopStatus.ENDED;
        emit('over', msg);
        emit('status', client.status);
        break;

      case 'error':
        client.lastError = msg.reason;
        emit('error', msg.reason);
        break;

      default:
        emit('unknown', msg);
    }
  }

  return client;
}

/** Convenience for the common "connect, then create/join" flow. */
export async function connectAndJoin(opts) {
  const client = createCoopClient(opts);
  await client.connect();
  if (opts.code) client.joinLobby(opts);
  else client.createLobby(opts);
  return client;
}

export default createCoopClient;
