// src/systems/CoopHunt.js
//
// A co-op map hunt, on one client (Exploration System v2, chunk 12c).
//
// AUTHORITY_MODEL: the host's client runs the hunt, the server runs combat.
// This is the piece that makes a HuntEngine hunt co-op, and it is free of
// Phaser so it can be driven headlessly against the real server protocol
// (server/coophunt_test.mjs). The map scene draws whichever hunt this holds.
//
//   HOST   holds the real hunt, over the MERGED party (every player's hunters,
//          rebuilt from the roster the server sent). After every accepted
//          action it publishes a snapshot; it resolves guests' move intents
//          (refusing stale ones and ones the hunt refuses); it sends each fight
//          to the server (beginFight), and applies each fight's outcome to the
//          hunt when the server says how it ended.
//   GUEST  holds a read-only copy, rebuilt from each snapshot with
//          restoreMapHunt(..., { view: true }). It only ever calls view(); a
//          move is sent to the host as an intent (chunk 12 decision 3).
//
// Saves are not touched here. Everything the hunt would write to a save (Hunt
// Points, XP, favor, the calendar, banked items, ...) goes into a LEDGER that
// rides in every snapshot, so every player -- a guest whose host vanished
// included -- holds the whole record. Applying it to each player's own save
// is chunk 12d (COOP_EXPLORATION's seven rules).
//
// The snapshot the server relays (opaque to it):
//   { v: 1, hunt: HuntEngine serialize(), ledger: [{ verb, args }], vitals }

import { createMapHunt, restoreMapHunt } from './HuntEngine.js';
import { fromWireCharacter } from './CoopWire.js';

export const COOP_SNAPSHOT_VERSION = 1;

/**
 * The world calls whose effects belong to a SAVE. On a co-op hunt each is
 * recorded, not applied: every client applies the ledger to its own save
 * (12d). The engine's reads (followedHouse, houseHolder, ownTribe, tribeName,
 * hasQuestFlag) are answered from the host's save, because the hunt is the
 * host's: its region, its plan, its house's boons (chunk 12 decision set).
 */
export const LEDGER_VERBS = ['nightFalls', 'dayBreaks', 'awardHuntPoints', 'awardXP', 'favor', 'falseGod',
  'bond', 'rivalDevotion', 'tribeRep', 'questFlag', 'lore', 'bankItems'];
const READS = ['followedHouse', 'houseHolder', 'ownTribe', 'tribeName', 'hasQuestFlag'];

const plain = (v) => JSON.parse(JSON.stringify(v ?? null));
const refOf = (c) => c?.instanceId || c?.id;

/** The host's world: the merged party, the host's save for reads, and the ledger. */
export function hostWorld(party, reads, ledger) {
  const w = { party: () => party };
  for (const verb of LEDGER_VERBS) {
    w[verb] = (...args) => { ledger.push({ verb, args: plain(args) }); };
  }
  for (const r of READS) w[r] = (...args) => reads?.[r]?.(...args);
  // A quest flag set earlier in THIS hunt is not in the host's save yet (it is
  // in the ledger), but the hunt must see it: the eel-catcher's return event
  // reads the flag its request set.
  w.hasQuestFlag = (flag) => {
    for (let i = ledger.length - 1; i >= 0; i--) {
      const e = ledger[i];
      if (e.verb === 'questFlag' && e.args[0] === flag) return !!e.args[1];
    }
    return !!reads?.hasQuestFlag?.(flag);
  };
  return w;
}

/** A guest's world: it can draw the party and nothing else. Any write means
 *  something other than view() was called on a guest's copy, which is a bug. */
function guestWorld(party) {
  const w = { party: () => party };
  for (const verb of LEDGER_VERBS) w[verb] = () => { throw new Error(`a guest's copy of the hunt cannot ${verb}`); };
  for (const r of READS) w[r] = () => null;
  return w;
}

/**
 * @param {object} opts
 *   client   a CoopClient already seated in a hunt lobby that has started
 *            (client.roster is the merged party, client.isHost says which side)
 *   reads    the host's save, for the engine's reads (the game passes
 *            GAME_WORLD); ignored on a guest
 */
export function createCoopHunt({ client, reads = null } = {}) {
  if (!client) throw new Error('a co-op hunt needs its client');
  const listeners = new Map();
  const emit = (event, payload) => {
    for (const fn of (listeners.get(event) || [])) {
      try { fn(payload); } catch (err) { console.error(`[coophunt:${event}]`, err); }
    }
  };

  // The merged party, rebuilt once from the roster; every snapshot's vitals
  // (host: what the hunt and the fights did to it) keep it current.
  const party = (client.roster || []).map(wire => {
    const c = fromWireCharacter(wire);
    c.ownerId = wire.ownerId ?? null;
    return c;
  });
  const byRef = new Map(party.map(c => [refOf(c), c]));
  const applyVitals = (vitals) => {
    for (const [ref, v] of Object.entries(vitals || {})) {
      const c = byRef.get(ref);
      if (!c || !v) continue;
      if (Number.isFinite(v.hp)) c.currentHP = v.hp;
      if (Number.isFinite(v.mp)) c.currentMP = v.mp;
      if (typeof v.status === 'string') c.status = v.status;
    }
  };
  const vitals = () => Object.fromEntries(party.map(c => [refOf(c), { hp: c.currentHP, mp: c.currentMP, status: c.status }]));

  const ledger = [];
  const unsubs = [];

  const ch = {
    isHost: !!client.isHost,
    party,
    hunt: null,           // host: the real hunt; guest: the newest read-only copy
    version: 0,
    ledger,
    fighting: null,       // the spec of the fight in progress, as the server sent it
    ended: null,          // the huntEnded message, once the hunt is over

    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event)?.delete(fn);
    },

    view() { return ch.hunt ? ch.hunt.view() : null; },

    /** The snapshot the server stores and relays. */
    snapshot() {
      return { v: COOP_SNAPSHOT_VERSION, hunt: ch.hunt.serialize(), ledger: plain(ledger), vitals: vitals() };
    },

    /** Stop listening (the lobby or the game is leaving the hunt). */
    dispose() { for (const off of unsubs.splice(0)) { try { off(); } catch { } } },

    /** Leave the co-op hunt: stop listening and close the socket. */
    leave() { ch.dispose(); try { client.disconnect(); } catch { } },

    client,

    /**
     * The hunt as the map scene sees one (HuntFieldOverlay reads view() and
     * acts through the engine's methods). Every action goes through act(), so
     * the host publishes it and a guest is refused; move() is the one thing a
     * guest may do. Built once, so the scene can key things by it.
     */
    field() {
      if (fieldFacade) return fieldFacade;
      fieldFacade = new Proxy({}, {
        get(_, prop) {
          if (prop === 'view') return () => ch.view();
          if (prop === 'move') return (tile) => ch.move(tile);
          if (prop === 'then' || typeof prop === 'symbol') return undefined;   // not a promise
          return (...args) => ch.act(h => (typeof h[prop] === 'function'
            ? h[prop](...args) : { ok: false, reason: `the hunt cannot ${String(prop)}` }));
        },
      });
      return fieldFacade;
    },
  };
  let fieldFacade = null;

  // ── Both sides ──────────────────────────────────────────────────────────────
  unsubs.push(client.on('started', () => {
    if (!client.huntFight) return;       // a pit fight is not ours
    ch.fighting = client.huntFight;
    emit('fight', client.huntFight);
  }));
  unsubs.push(client.on('huntEnded', (msg) => {
    // A host gone past the grace period: the guests' record is the last
    // snapshot the server held, ledger and all (COOP_EXPLORATION rule 7).
    if (!ch.isHost && msg.snapshot) applySnapshot(msg.snapshot);
    ch.ended = msg;
    emit('ended', msg);
  }));
  unsubs.push(client.on('error', (reason) => emit('refused', reason)));

  // ── Host ────────────────────────────────────────────────────────────────────
  let endSent = false;
  function publish() {
    ch.version++;
    client.huntSnapshot(ch.version, ch.snapshot());
    emit('changed', ch.view());
    const fin = ch.hunt.view().finished;
    if (fin && !endSent) {
      endSent = true;
      // The report is the whole record; each save applies it (12d).
      client.huntEnd(fin, { finished: fin, ledger: plain(ledger), vitals: vitals(), version: ch.version });
    }
  }

  if (ch.isHost) {
    const world = hostWorld(party, reads, ledger);

    /** Depart: the host's plan and region, everyone's hunters. */
    ch.begin = ({ zoneId, plan, supplies, bring = [], seed } = {}) => {
      if (ch.hunt) throw new Error('this co-op hunt has already begun');
      const opts = { plan, supplies, bring };
      if (seed != null) opts.seed = seed;
      ch.hunt = createMapHunt(zoneId, opts, world);
      publish();
      return ch.hunt;
    };

    /**
     * Run one engine action (move, scout, camp, an event's choice, ...). An
     * accepted one is published; a refusal changed nothing and is returned
     * as the engine gave it. Refused while a fight is on: the hunt is frozen.
     */
    ch.act = (fn) => {
      if (!ch.hunt) return { ok: false, reason: 'the hunt has not begun' };
      if (ch.fighting) return { ok: false, reason: 'the hunt waits while the fight is on' };
      const res = fn(ch.hunt);
      if (res?.ok) publish();
      return res;
    };
    ch.move = (tile) => ch.act(h => h.move(tile));

    /** Fight the pending encounter: beginFight (the food buff is used up, so
     *  that state is published first), then the server runs it. */
    ch.fight = () => {
      if (ch.fighting) return { ok: false, reason: 'a fight is already on' };
      const spec = ch.hunt?.beginFight();
      if (!spec?.ok) return spec || { ok: false, reason: 'the hunt has not begun' };
      publish();
      client.huntFight(ch.version, plain({ ...spec, zoneId: ch.hunt.getState().zoneId }), vitals());
      return { ok: true, spec };
    };

    /** Break away from the fight in progress (the host only, decision 3). */
    ch.flee = () => (ch.fighting ? (client.flee(), { ok: true }) : { ok: false, reason: 'there is no fight to flee' });

    // A guest asked to move. The server already refused anything stale
    // against ITS version; the host checks its own as well, then the hunt
    // decides. Every refusal goes back to the one who asked.
    unsubs.push(client.on('moveIntent', (m) => {
      if (m.version !== ch.version) return client.huntRefuse(m.from, 'the hunt has moved on; try again');
      const res = ch.move(m.tile);
      if (!res?.ok) client.huntRefuse(m.from, res?.reason || 'the hunt refused that move');
      else emit('moved', { by: m.from, name: m.name, res });
    }));

    // How the fight ended, applied to the real hunt exactly where CombatScene
    // applies it in single player: winEncounter / flee / wipe. The fight's XP
    // pool goes into the ledger (single player pays it from CombatScene; here
    // each save pays its own hunters' share, 12d), and so do the fallen.
    unsubs.push(client.on('over', (msg) => {
      if (!msg?.hunt) return;
      ch.fighting = null;
      applyVitals(msg.vitals);
      const o = msg.huntOutcome || {};
      if (o.result === 'won') {
        ch.hunt.winEncounter({ loot: msg.rewards?.loot || [], knockedOut: o.knockedOut || 0 });
        if (msg.rewards?.xpPool > 0) ledger.push({ verb: 'awardXP', args: [msg.rewards.xpPool] });
      } else if (o.result === 'fled') {
        ch.hunt.flee({ knockedOut: o.knockedOut || 0 });
      } else if (o.result === 'wipe') {
        const fallen = party.filter(c => c.status === 'dead').map(refOf);
        ledger.push({ verb: 'fell', args: [o.deathRule || null, fallen] });
        ch.hunt.wipe();
      }
      publish();
      emit('fightOver', msg);
    }));
  }

  // ── Guest ───────────────────────────────────────────────────────────────────
  function applySnapshot(env) {
    if (!env || env.v !== COOP_SNAPSHOT_VERSION) {
      emit('refused', `this game cannot read the host's hunt (snapshot ${env?.v})`);
      return;
    }
    applyVitals(env.vitals);
    ch.hunt = restoreMapHunt(env.hunt, guestWorld(party), { view: true });
    ledger.splice(0, ledger.length, ...(env.ledger || []));
    emit('changed', ch.view());
  }

  if (!ch.isHost) {
    const onState = (h) => { ch.version = h.version; applySnapshot(h.snapshot); };
    unsubs.push(client.on('huntState', onState));
    // A snapshot that arrived before this was built (a resume, a slow scene).
    if (client.hunt) onState(client.hunt);

    // A guest's move is a request; the host's next snapshot is the answer.
    ch.move = (tile) => {
      if (ch.fighting) return { ok: false, reason: 'the hunt waits while the fight is on' };
      client.move(tile, ch.version);
      return { ok: true, pending: true };
    };
    ch.act = () => ({ ok: false, reason: 'only the host can do that' });
    ch.fight = () => ({ ok: false, reason: 'only the host starts the fight' });
    ch.flee = () => ({ ok: false, reason: 'only the host can call the retreat' });
    unsubs.push(client.on('over', (msg) => {
      if (!msg?.hunt) return;
      ch.fighting = null;
      emit('fightOver', msg);
    }));
  }

  return ch;
}
