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

/**
 * How long an in-progress hunt survives with nobody connected.
 *
 * All hunt state is in memory, so this is the whole of a fight's durability: a
 * refresh, a dropped wifi, a laptop lid. Long enough to walk back from a
 * dropped connection, short enough that an abandoned fight does not sit in
 * memory forever. For a hunt lobby it is also how long the host may be gone.
 */
export const RESUME_GRACE_MS = 5 * 60 * 1000;

export function createHub({ CombatScene, codeFactory = makeCode,
  resumeGraceMs = RESUME_GRACE_MS } = {}) {
  // The board publishes its own slot ids. Taking them from the class the hub
  // was handed keeps one definition of the grid; a fallback exists only so a
  // test double without the static still works.
  const ALLY_SLOT_IDS = CombatScene?.ALLY_SLOT_IDS || [1, 2, 3, 4, 5, 6, 7, 8];

  if (!CombatScene) throw new Error('createHub needs the CombatScene class');

  const lobbies = new Map();   // code -> lobby
  const byConn = new Map();    // conn -> { code, playerId }

  // A lobby is under way once a pit fight or a hunt has started. A hunt lobby
  // (mode 'hunt', chunk 12b) outlives its fights: lobby.session is only ever
  // the fight in progress, and lobby.hunt is the hunt around it.
  const started = (lobby) => !!lobby.session || !!lobby.hunt;

  const send = (conn, msg) => { try { conn.send(msg); } catch { /* dead socket */ } };
  const fail = (conn, reason) => send(conn, { t: 'error', reason });

  const lobbyView = (lobby) => ({
    t: 'lobby',
    code: lobby.code,
    mode: lobby.mode,
    label: lobby.label,
    scenarioId: lobby.scenarioId,
    hostId: lobby.hostId,
    limit: PARTY_LIMIT,
    used: lobby.players.reduce((n, p) => n + p.hunters.length, 0),
    started: started(lobby),
    isPublic: !!lobby.isPublic,
    players: lobby.players.map(p => ({
      id: p.id,
      name: p.name,
      ready: p.ready,
      hunters: p.hunters.map(h => ({
        ref: h.instanceId || h.id,
        name: h.name,
        // null means "not placed yet"; the lobby fills those in left-to-right
        // at the start, exactly as an unclaimed hunter has always been placed.
        slotId: h.slotId ?? null,
      })),
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
    if (result.state.ended && lobby.hunt) return huntFightOver(lobby);
    if (result.state.ended) {
      // A finished hunt is not worth holding a seat for. The grace period on
      // disconnect exists so a dropped connection can come back to a fight in
      // progress; there is nothing to come back to once it is over.
      lobby.finished = true;
      const units = result.state.units;
      const won = units.filter(u => u.side === 'enemy').every(u => u.hp <= 0);
      broadcast(lobby, {
        t: 'over',
        outcome: won ? 'victory' : 'defeat',
        scenarioId: lobby.scenarioId,
        // Reward DISTRIBUTION is deliberately not done here. The server states
        // what the fight was worth and what dropped; each client applies it to
        // its OWN save through the reward path it already has. Saves stay
        // entirely local, and there is only one implementation of what a clear
        // is worth.
        rewards: won ? lobby.session.rewards() : null,
        survivors: units.filter(u => u.side === 'ally' && u.hp > 0).map(u => u.ref),
        players: lobby.players.map(p => p.id),
      });
    }
  };

  // ---- hunt lobbies (Exploration v2, chunk 12b) ----------------------------
  //
  // The host's client runs the hunt (AUTHORITY_MODEL); this server stores its
  // latest snapshot WITHOUT reading it, relays it to the guests, carries
  // guests' move intents to the host, and runs each fight. The rules:
  //   - every snapshot carries a version; the host's must go up, and a move
  //     aimed at any version but the latest is refused as stale
  //   - the hunt is frozen while a fight is live: moves and snapshots are
  //     refused, not queued
  //   - guests only move (chunk 12 decision 3); everything else is the host's
  //   - the host gone past the grace period ends the hunt for the guests, as a
  //     clean exit from the last snapshot (COOP_EXPLORATION rule 7)

  /** Bigger than any real snapshot (65 KB measured) by a wide margin, and
   *  inside the socket's 1 MB message cap with room for the envelope. */
  const MAX_SNAPSHOT_BYTES = 512 * 1024;

  const hostOf = (lobby) => lobby.players.find(p => p.id === lobby.hostId) || null;
  /** Every player's hunters, each stamped with its owner: what a client needs
   *  to build the merged party (a pit fight's `started` sends the same). */
  const rosterOf = (lobby) => lobby.players.flatMap(p =>
    (p.hunters || []).map(h => ({ ...h, ownerId: p.id })));
  const guestsOf = (lobby) => lobby.players.filter(p => p.id !== lobby.hostId);
  const huntView = (lobby) => ({ t: 'huntState', version: lobby.hunt.version, snapshot: lobby.hunt.snapshot });

  /**
   * A map-hunt fight has ended. Everyone is told how; the HOST also gets what
   * to apply to its real hunt (session.huntOutcome) and every hunter's state
   * for the map to carry on with. The lobby is NOT finished: the hunt goes on,
   * and the next fight gets a fresh session. The message is kept until the
   * host sends its next snapshot (proof it applied it), so a host that drops
   * at this moment gets it again on resume.
   */
  function huntFightOver(lobby) {
    const session = lobby.session;
    const outcome = session.huntOutcome;
    const msg = {
      t: 'over',
      hunt: true,
      outcome: outcome?.result === 'won' ? 'victory' : outcome?.result === 'fled' ? 'fled' : 'defeat',
      huntOutcome: outcome,
      rewards: outcome?.result === 'won' ? session.rewards() : null,
      vitals: session.vitals(),
      fightVersion: lobby.hunt.version,
      players: lobby.players.map(p => p.id),
    };
    lobby.hunt.lastOver = msg;
    lobby.session = null;
    broadcast(lobby, msg);
  }

  /** End a hunt for everyone and let the lobby go. */
  function endHunt(lobby, reason, report = null) {
    lobby.hunt.finished = true;
    lobby.finished = true;
    clearTimeout(lobby.hunt.hostGoneTimer);
    broadcast(lobby, { t: 'huntEnded', reason, report,
      version: lobby.hunt.version, snapshot: lobby.hunt.snapshot });
    lobbies.delete(lobby.code);
    for (const p of lobby.players) if (p.conn) byConn.delete(p.conn);
  }

  const handlers = {
    /** { t:'create', name, scenarioId, hunters } */
    create(conn, msg) {
      const code = codeFactory();
      const playerId = 'p1';
      const lobby = {
        code,
        scenarioId: msg.scenarioId || 'training_encounter_1',
        // 'pit' is one fight; 'hunt' is a map hunt run by the host's client,
        // with a fight on this server each time the party meets something.
        mode: msg.mode === 'hunt' ? 'hunt' : 'pit',
        hunt: null,
        // What a hunt lobby is hunting, in words the host's game wrote
        // ("Reeds of Gethsemane: Scout, Small"), for the guests and the list.
        label: String(msg.label ?? '').slice(0, 120),
        hostId: playerId,
        players: [],
        session: null,
        // The host's combat-speed preference paces the recording for everyone.
        quickCombat: !!msg.quickCombat,
        // Private by default. A lobby only appears in the public list if its
        // host asked for that — defaulting the other way would put every
        // private game between friends on a list for strangers.
        isPublic: msg.isPublic === true,
      };
      lobbies.set(code, lobby);
      return handlers._seat(conn, lobby, playerId, msg);
    },

    /** { t:'join', code, name, hunters, clientId } */
    join(conn, msg) {
      const lobby = lobbies.get(String(msg.code || '').toUpperCase());
      if (!lobby) return fail(conn, 'no lobby with that code');

      // Coming back to a seat you already hold. A dropped socket leaves the
      // player in place with conn: null -- their hunters are on the board and
      // their turn still has to be taken -- but until now nothing could
      // reattach to it, so a refresh or a flaky connection cost the fight.
      // Matching on clientId is what makes the seat reclaimable; it is the
      // browser's own id, not anything the player types.
      const mine = msg.clientId
        && lobby.players.find(p => p.clientId && p.clientId === msg.clientId);
      if (mine) return handlers._resume(conn, lobby, mine);

      if (started(lobby)) return fail(conn, 'that hunt has already started');
      const playerId = 'p' + (lobby.players.length + 1);
      return handlers._seat(conn, lobby, playerId, msg);
    },

    /**
     * Reattach a returning player to the seat they already hold.
     *
     * Sends everything a fresh client needs to rebuild the fight from nothing:
     * the seat, the lobby, and -- if a hunt is under way -- the roster and the
     * current board, which is exactly what `start` sends. A reconnecting client
     * has no history, so replaying the whole fight is neither possible nor
     * needed; the authoritative board IS the state.
     */
    _resume(conn, lobby, player) {
      if (player.conn && player.conn !== conn) {
        // Someone else is already sitting here on a live socket. Refuse rather
        // than boot them: two tabs open on one save should not fight over a
        // seat, and silently stealing it would look like a desync.
        return fail(conn, 'that seat is already connected');
      }
      player.conn = conn;
      clearTimeout(lobby._reapTimer);
      lobby._reapTimer = null;
      byConn.set(conn, { code: lobby.code, playerId: player.id });
      send(conn, { t: 'joined', code: lobby.code, playerId: player.id, hostId: lobby.hostId, resumed: true });
      // The lobby view goes FIRST, before `started`. The scene reads the
      // scenario off it when it hands over to the fight, and on a resume there
      // is no earlier copy to fall back on -- the returning client has no
      // history at all.
      send(conn, lobbyView(lobby));
      if (lobby.hunt) {
        // The hunt as it stands, then (if one is on) the fight. A returning
        // host is also told how the last fight ended if it never applied it
        // (lastOver is cleared by the host's next snapshot).
        send(conn, { t: 'huntStarted', roster: rosterOf(lobby) });
        if (lobby.hunt.snapshot != null) send(conn, huntView(lobby));
        if (player.id === lobby.hostId) {
          clearTimeout(lobby.hunt.hostGoneTimer);
          lobby.hunt.hostGoneTimer = null;
          if (lobby.hunt.lastOver && !lobby.session) send(conn, lobby.hunt.lastOver);
        }
      }
      if (lobby.session) {
        send(conn, { t: 'started', state: lobby.session.state(), roster: rosterOf(lobby),
          gearSeed: lobby.session.gearSeed, huntFight: lobby.session.huntFight });
      }
      broadcast(lobby, lobbyView(lobby));
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
        // The browser's own id, stored so this seat can be reclaimed after a
        // dropped socket. Never shown, never typed, and only meaningful within
        // this lobby -- it is not an account.
        clientId: msg.clientId || null,
      };
      lobby.players.push(player);
      byConn.set(conn, { code: lobby.code, playerId });
      send(conn, { t: 'joined', code: lobby.code, playerId, hostId: lobby.hostId });
      broadcast(lobby, lobbyView(lobby));
    },

    /** { t:'setHunters', hunters } - replaces this player's selection. */
    setHunters(conn, msg, lobby, player) {
      if (started(lobby)) return fail(conn, 'the hunt has started');
      const hunters = Array.isArray(msg.hunters) ? msg.hunters : [];
      const left = budgetLeft(lobby, player.id);
      if (hunters.length > left) {
        return fail(conn, `only ${left} of the ${PARTY_LIMIT} party slots are left`);
      }
      // A placement is only ever granted by claimSlot, never accepted from the
      // client's own payload -- otherwise a hunter could arrive pre-placed and
      // skip the "is anyone already standing there" check entirely.
      //
      // But placements already granted must SURVIVE this. Ticking one hunter in
      // the roster resends the whole list, and rebuilding it from the payload
      // wiped every slot anyone had chosen -- so the formation silently reset
      // whenever the party changed, which is what "the slots are sticking"
      // actually was. A hunter still in the list keeps where they were
      // standing; one who has been dropped takes their placement with them.
      const refOf = (h) => h?.instanceId || h?.id;
      const held = new Map(
        player.hunters.filter(h => h.slotId != null).map(h => [refOf(h), h.slotId]));
      player.hunters = hunters.map(h => {
        const { slotId, ...rest } = h || {};
        const kept = held.get(refOf(rest));
        return kept != null ? { ...rest, slotId: kept } : rest;
      });
      player.ready = false;   // changing your party un-readies you
      broadcast(lobby, lobbyView(lobby));
    },

    /**
     * { t:'claimSlot', ref, slotId }  -- place ONE OF YOUR OWN hunters.
     *
     * Fail-closed in the same way the action gate is: a hunter that is not in
     * the caller's own list is refused rather than ignored, so a client that
     * asks to move someone else's hunter is told no instead of quietly doing
     * nothing. Nobody can rearrange anybody else -- there is no host override
     * here on purpose, which is what makes the formation ungriefable.
     *
     * `slotId: null` clears a placement, which is always allowed.
     */
    claimSlot(conn, msg, lobby, player) {
      if (started(lobby)) return fail(conn, 'the hunt has started');

      const refOf = (h) => h.instanceId || h.id;
      const hunter = player.hunters.find(h => refOf(h) === msg.ref);
      if (!hunter) return fail(conn, 'that hunter is not yours to place');

      if (msg.slotId === null || msg.slotId === undefined) {
        delete hunter.slotId;
        player.ready = false;      // changing the formation un-readies you
        return broadcast(lobby, lobbyView(lobby));
      }

      const slotId = Number(msg.slotId);
      // Validated against the board's own list rather than a hardcoded 1..8,
      // so the lobby cannot offer a slot the board does not have.
      if (!ALLY_SLOT_IDS.includes(slotId)) return fail(conn, 'no such slot');

      const taken = lobby.players.some(p =>
        p.hunters.some(h => h.slotId === slotId && refOf(h) !== msg.ref));
      if (taken) return fail(conn, 'someone is already standing there');

      hunter.slotId = slotId;
      player.ready = false;
      broadcast(lobby, lobbyView(lobby));
    },

    /** { t:'ready', ready } */
    ready(conn, msg, lobby, player) {
      if (started(lobby)) return fail(conn, 'the hunt has started');
      if (!player.hunters.length) return fail(conn, 'bring at least one hunter');
      player.ready = msg.ready !== false;
      broadcast(lobby, lobbyView(lobby));
    },

    /** { t:'start' } - host only, everyone ready. */
    start(conn, msg, lobby, player) {
      if (started(lobby)) return fail(conn, 'already started');
      if (player.id !== lobby.hostId) return fail(conn, 'only the host can start');
      if (!lobby.players.every(p => p.ready)) return fail(conn, 'not everyone is ready');

      // Many fights run in one process. Each combat host owns its party
      // (CombatScene._party(), chunk 12a). Before that every host assigned
      // the module-singleton GameState.party, so a second live fight made the
      // first judge deaths against the wrong party -- a wiped party kept
      // "fighting" forever -- and this start refused. Held by
      // server/concurrent_test.mjs, which plays two fights interleaved.

      // A hunt lobby starts the HUNT, not a fight: the host's client builds
      // it from everyone's hunters and sends its first snapshot; fights come
      // later, one huntFight at a time.
      if (lobby.mode === 'hunt') {
        const total = lobby.players.reduce((n, p) => n + p.hunters.length, 0);
        if (total > PARTY_LIMIT) return fail(conn, `the party is ${total} hunters; the shared limit is ${PARTY_LIMIT}`);
        lobby.hunt = { version: 0, snapshot: null, finished: false, lastOver: null, hostGoneTimer: null };
        return broadcast(lobby, { t: 'huntStarted', roster: rosterOf(lobby) });
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

      broadcast(lobby, { t: 'started', state: lobby.session.state(), roster,
        // The fight's enemy-gear seed. Clients roll their board from this so
        // everyone's enemies carry identical equipment and derived stats.
        gearSeed: lobby.session.gearSeed });
    },

    /** { t:'act', actor, skill, target } */
    act(conn, msg, lobby, player) {
      if (!lobby.session) return fail(conn, lobby.hunt ? 'there is no fight on' : 'the hunt has not started');
      const result = lobby.session.act(player.id, {
        actor: msg.actor, skill: msg.skill, target: msg.target,
        // A movement skill's destination. Only a finite slot id is passed on.
        targetSlot: Number.isFinite(msg.targetSlot) ? msg.targetSlot : undefined,
      });
      // A refusal goes only to the player who tried it. The others do not need
      // to see someone else's mis-click, and it keeps the broadcast a pure
      // record of what actually happened.
      if (!result.ok) return fail(conn, result.reason);
      pushResult(lobby, result, conn);
    },

    /** { t:'endTurn' } */
    endTurn(conn, msg, lobby, player) {
      if (!lobby.session) return fail(conn, lobby.hunt ? 'there is no fight on' : 'the hunt has not started');
      const result = lobby.session.endTurn(player.id);
      if (!result.ok) return fail(conn, result.reason);
      pushResult(lobby, result);
    },

    /**
     * { t:'huntSnapshot', version, snapshot } - host only. The hunt as the
     * host's client now holds it (HuntEngine.serialize()), stored as-is and
     * relayed to every guest. The version must go up; that is what lets a
     * stale move be told from a current one.
     */
    huntSnapshot(conn, msg, lobby, player) {
      const h = lobby.hunt;
      if (!h || h.finished) return fail(conn, 'no hunt is under way');
      if (player.id !== lobby.hostId) return fail(conn, 'only the host runs the hunt');
      if (lobby.session) return fail(conn, 'the hunt waits while the fight is on');
      const version = Number(msg.version);
      if (!Number.isInteger(version) || version <= h.version) {
        return fail(conn, `snapshot version ${msg.version} is not newer than ${h.version}`);
      }
      if (msg.snapshot == null) return fail(conn, 'a snapshot needs its hunt');
      const bytes = JSON.stringify(msg.snapshot).length;
      if (bytes > MAX_SNAPSHOT_BYTES) return fail(conn, `the snapshot is ${bytes} bytes; the limit is ${MAX_SNAPSHOT_BYTES}`);
      h.version = version;
      h.snapshot = msg.snapshot;
      h.lastOver = null;     // the host has moved on, so it applied the last fight
      for (const g of guestsOf(lobby)) if (g.conn) send(g.conn, huntView(lobby));
    },

    /**
     * { t:'move', tile, version } - anyone asks to move the party token. The
     * host resolves it (AUTHORITY_MODEL: anyone may move, the host decides).
     * Refused here, to the asker only, if a fight is live or the move was
     * aimed at an older state than the latest.
     */
    move(conn, msg, lobby, player) {
      const h = lobby.hunt;
      if (!h || h.finished) return fail(conn, 'no hunt is under way');
      if (lobby.session) return fail(conn, 'the hunt waits while the fight is on');
      if (Number(msg.version) !== h.version) return fail(conn, 'the hunt has moved on; try again');
      if (msg.tile == null || typeof msg.tile === 'object') return fail(conn, 'a move needs a tile');
      const host = hostOf(lobby);
      if (!host?.conn) return fail(conn, 'the host is away');
      send(host.conn, { t: 'moveIntent', from: player.id, name: player.name, tile: msg.tile, version: h.version });
    },

    /** { t:'huntRefuse', to, reason } - host only: tell one player why their
     *  move was not taken (the host's hunt said no). */
    huntRefuse(conn, msg, lobby, player) {
      if (!lobby.hunt) return fail(conn, 'no hunt is under way');
      if (player.id !== lobby.hostId) return fail(conn, 'only the host can do that');
      const to = lobby.players.find(p => p.id === msg.to);
      if (to?.conn) send(to.conn, { t: 'error', reason: String(msg.reason ?? 'the host refused that').slice(0, 200) });
    },

    /**
     * { t:'huntFight', version, spec, vitals } - host only: the party met
     * something, and the host's hunt has begun the fight (beginFight()). The
     * server runs it like any co-op fight; `over` tells the host how it ended
     * (huntOutcome) to apply to its real hunt, and the hunt is frozen until
     * then. `vitals` are the hunters' HP/MP/status on the map.
     */
    huntFight(conn, msg, lobby, player) {
      const h = lobby.hunt;
      if (!h || h.finished) return fail(conn, 'no hunt is under way');
      if (player.id !== lobby.hostId) return fail(conn, 'only the host runs the hunt');
      if (lobby.session) return fail(conn, 'a fight is already on');
      if (Number(msg.version) !== h.version) return fail(conn, 'that fight is from an older state of the hunt');
      try {
        lobby.session = createSession({
          CombatScene,
          players: lobby.players.map(p => ({ id: p.id, name: p.name, hunters: p.hunters })),
          quickCombat: lobby.quickCombat,
          seed: null,
          huntFight: msg.spec,
          vitals: msg.vitals || null,
        });
      } catch (e) {
        return fail(conn, e.message);
      }
      h.lastOver = null;
      broadcast(lobby, { t: 'started', state: lobby.session.state(), roster: rosterOf(lobby),
        gearSeed: lobby.session.gearSeed, huntFight: lobby.session.huntFight });
      // A fight can end before anyone acts: an ambush that wipes the party in
      // the enemy's opening turns.
      if (lobby.session.isOver) huntFightOver(lobby);
    },

    /** { t:'flee' } - host only (chunk 12 decision 3): the party breaks away
     *  from a map-hunt fight, on one of the party's turns. */
    flee(conn, msg, lobby, player) {
      if (!lobby.hunt || !lobby.session) return fail(conn, 'there is no fight to flee');
      if (player.id !== lobby.hostId) return fail(conn, 'only the host can call the retreat');
      const result = lobby.session.flee();
      if (!result.ok) return fail(conn, result.reason);
      pushResult(lobby, result, conn);
    },

    /**
     * { t:'huntEnd', reason, report } - host only: the hunt is over (an exit,
     * a wipe). `report` is what each guest's save takes home (chunk 12d);
     * relayed as-is. The lobby goes with it.
     */
    huntEnd(conn, msg, lobby, player) {
      if (!lobby.hunt || lobby.hunt.finished) return fail(conn, 'no hunt is under way');
      if (player.id !== lobby.hostId) return fail(conn, 'only the host can end the hunt');
      if (lobby.session) return fail(conn, 'finish the fight first');
      endHunt(lobby, String(msg.reason || 'exit').slice(0, 40), msg.report ?? null);
    },

    /**
     * { t:'browse' } - the list of joinable public lobbies.
     *
     * Deliberately answered for ANY connection, seated or not: browsing is how
     * a player finds their first lobby, so requiring one first would be
     * circular. Handled before the seat lookup in `handle` for that reason.
     *
     * Codes are included because joining still goes through the same code
     * path — the list is a convenience on top of join-by-code, not a second
     * way in. A private lobby never appears here, so its code stays the only
     * way to reach it.
     */
    browse(conn) {
      const open = [...lobbies.values()]
        .filter(l => l.isPublic && !started(l))
        .filter(l => l.players.some(p => p.conn))
        .map(l => ({
          code: l.code,
          mode: l.mode,
          label: l.label,
          scenarioId: l.scenarioId,
          host: l.players.find(p => p.id === l.hostId)?.name || '?',
          players: l.players.length,
          used: l.players.reduce((n, p) => n + p.hunters.length, 0),
          limit: PARTY_LIMIT,
          quickCombat: !!l.quickCombat,
        }))
        .sort((a, b) => a.code.localeCompare(b.code));
      send(conn, { t: 'lobbies', lobbies: open });
    },

    /** { t:'setPublic', isPublic } - host only. */
    setPublic(conn, msg, lobby, player) {
      if (player.id !== lobby.hostId) return fail(conn, 'only the host can do that');
      if (started(lobby)) return fail(conn, 'the hunt has started');
      lobby.isPublic = msg.isPublic === true;
      broadcast(lobby, lobbyView(lobby));
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
      else if (lobby.hunt?.snapshot != null) send(conn, huntView(lobby));
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

      // These three need no seat: they are how a player finds or takes one.
      if (msg.t === 'create' || msg.t === 'join' || msg.t === 'browse') {
        return handlers[msg.t](conn, msg);
      }

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
      if (!started(lobby) && player) {
        lobby.players = lobby.players.filter(p => p !== player);
      }

      // The host of a hunt dropped. No host migration in v1 (AUTHORITY_MODEL):
      // if they are not back within the grace period the hunt ends, and for
      // the guests it is a clean exit from the last snapshot (COOP_EXPLORATION
      // rule 7). A returning host clears this in _resume.
      if (lobby.hunt && !lobby.hunt.finished && player?.id === lobby.hostId) {
        clearTimeout(lobby.hunt.hostGoneTimer);
        lobby.hunt.hostGoneTimer = setTimeout(() => {
          if (lobbies.get(lobby.code) === lobby && !hostOf(lobby)?.conn) endHunt(lobby, 'host_gone');
        }, resumeGraceMs);
        lobby.hunt.hostGoneTimer.unref?.();
      }

      if (!lobby.players.every(p => !p.conn)) {
        return broadcast(lobby, lobbyView(lobby));
      }

      // Everyone is gone. An unstarted lobby is worth nothing, so it goes now.
      // A hunt in progress is held for a grace period instead of deleted the
      // instant the last socket drops -- which is what used to happen, so two
      // players on one flaky connection, or one player refreshing while alone,
      // destroyed the fight outright with no way back.
      if (!started(lobby) || lobby.finished) return lobbies.delete(lobby.code);

      clearTimeout(lobby._reapTimer);
      lobby._reapTimer = setTimeout(() => {
        // Re-check rather than trust the timer: somebody may have come back.
        if (lobbies.get(lobby.code) === lobby && lobby.players.every(p => !p.conn)) {
          lobbies.delete(lobby.code);
        }
      }, resumeGraceMs);
      // Never hold the process open on this alone.
      lobby._reapTimer.unref?.();
    },
  };
}
