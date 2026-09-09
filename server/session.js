// @ts-nocheck
// server/session.js
//
// One co-op hunt, as pure logic. No sockets, no framework, no dependencies.
//
// A session owns a combat host, a roster of players, and the rules about who
// may do what. Transport is deliberately somewhere else: everything here can
// be driven and verified in a plain Node process, which is what let this be
// written and tested before any hosting decision was made.
//
// IT RUNS THE SAME HOST THE TEST HARNESS DOES. `createCombatHost` is imported
// from tools/headless/ rather than copied, so the fight a server runs is the
// exact object the golden master exercises across 276 skills, 13 reactions and
// 160 enemy skills. A second implementation would be a second thing to keep
// correct; there is only one.
//
// LOAD ORDER: installPhaserStub() must run before this module is imported.

if (!globalThis.Phaser) {
  throw new Error('server/session.js imported before installPhaserStub().');
}

import { createCombatHost } from '../tools/headless/combatHost.js';
import { seed as seedRng } from '../tools/headless/phaserStub.js';
import { startCombat, snapshotBoard } from '../tools/headless/fight.js';
import { SKILLS } from '../data/skills.js';
import { rebuildCharacterStats } from '../src/systems/CharacterBuilder.js';

/** The shared party cap. Already the game's own limit in five places. */
export const PARTY_LIMIT = 6;

// ---------------------------------------------------------------------------
// The wire
//
// A character JSON round-trips WITHOUT ERROR and silently loses every skill's
// apply() function -- 15 of 19 on a level-5 hunter. Sending a character
// straight down a socket and using what comes out the other end would leave
// every skill fizzling, and CombatScene's try/catch would swallow the
// TypeError and log "fizzled" rather than anything diagnosable.
//
// So skills cross the wire as IDS and are rehydrated from SKILLS on arrival.
// Both sides already have data/skills.js; there is nothing to send.
// ---------------------------------------------------------------------------

/** A character reduced to what is safe to send. */
export function toWireCharacter(char) {
  const wire = {};
  for (const [k, v] of Object.entries(char || {})) {
    if (typeof v === 'function') continue;
    if (k === 'skills' || k === '_slot' || k === 'icon') continue;
    if (k === 'hpBar' || k === 'mpBar' || k === 'initBar') continue;
    try { JSON.stringify(v); } catch { continue; }   // drop anything circular
    wire[k] = v;
  }
  wire.skillIds = (char?.skills || []).map(s => s?.id).filter(Boolean);
  return wire;
}

/**
 * Rebuild a usable character from wire data.
 *
 * Throws on an unknown skill id rather than dropping it. A hunter quietly
 * missing one skill is the kind of desync that surfaces ten minutes later as
 * "why did nothing happen", and it means the two clients disagree about what
 * the game contains.
 */
export function fromWireCharacter(wire) {
  const char = { ...wire };
  delete char.skillIds;

  char.skills = (wire?.skillIds || []).map(id => {
    const skill = SKILLS[id];
    if (!skill) throw new Error(`unknown skill id from the wire: ${id}`);
    return { ...skill, id };
  });

  // Derived stats and gearEffects are recomputed rather than trusted. They are
  // a pure function of stats and equipment, so recomputing costs nothing and
  // removes a whole class of "the client said its Accuracy was 400".
  rebuildCharacterStats(char);
  return char;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/**
 * players: [{ id, name, hunters: [wireCharacter, ...] }]
 *
 * The hunters of every player are merged into ONE party of at most six, which
 * is already the game's own cap. Because the party size is fixed, the turn
 * order does not grow with the player count -- a six-player session resolves
 * exactly as fast as a two-player one.
 */
export function createSession({ CombatScene, players = [], scenarioId = 'training_encounter_1', seed = 1 }) {
  if (!CombatScene) throw new Error('createSession needs the CombatScene class');
  if (!players.length) throw new Error('a session needs at least one player');

  const ids = players.map(p => p.id);
  if (new Set(ids).size !== ids.length) throw new Error('duplicate player id');

  const total = players.reduce((n, p) => n + (p.hunters?.length || 0), 0);
  if (total < 1) throw new Error('the party is empty');
  if (total > PARTY_LIMIT) {
    throw new Error(`the party is ${total} hunters; the shared limit is ${PARTY_LIMIT}`);
  }

  seedRng(seed);
  const host = createCombatHost(CombatScene);

  // Stamp ownership as the party is assembled. Every hunter gets an owner
  // here, which is what makes _resolveAction's fail-closed check safe to rely
  // on: an unowned hunter would be refused for everyone, so a missed stamp
  // shows up immediately as "has no owner" rather than as shared control.
  const party = [];
  const slotMap = {};
  let slotCursor = 0;
  const SLOT_ORDER = [1, 2, 3, 4, 5, 6];

  for (const player of players) {
    for (const wire of (player.hunters || [])) {
      const char = fromWireCharacter(wire);
      char.ownerId = player.id;
      char.currentHP = char.maxHP;
      char.currentMP = char.maxMP;
      char.status = 'active';
      party.push(char);
      slotMap[SLOT_ORDER[slotCursor++]] = char.instanceId || char.id;
    }
  }

  host.__begin({ party, partySlots: slotMap, scenarioId });
  startCombat(host);

  const session = {
    scenarioId,
    seed,
    players: players.map(p => ({ id: p.id, name: p.name })),
    host,
    party,

    /** Whose turn it is, and whether a human owns them. */
    current() {
      const actor = host._currentChar?.();
      if (!actor) return null;
      return {
        ref: host._unitRef(actor),
        name: actor.name,
        ownerId: actor.ownerId ?? null,
        isEnemy: !!actor.isEnemy,
      };
    },

    get isOver() { return !!host.combatEnded; },

    /**
     * The broadcast payload. Deliberately the whole state, every time: it is
     * about 4 KB, and a turn-based game gains nothing from deltas except a
     * class of bug where the two sides disagree about what changed.
     */
    state() {
      const lean = (u) => ({
        ref: host._unitRef(u),
        owner: u.ownerId ?? null,
        name: u.name,
        slot: u._slot?.slotId ?? u.slotId ?? null,
        side: u.isEnemy ? 'enemy' : 'ally',
        hp: u.currentHP, maxHP: u.maxHP,
        mp: u.currentMP, maxMP: u.maxMP,
        gauge: u.initiativeGauge ?? 0,
        shield: u.shieldHP || 0,
        status: u.status,
        actions: u.actionsLeft,
        meters: u.weakness?.meters,
        tiers: u.weakness?.tiers,
        effects: (u.statusEffects || []).map(e => ({ id: e.id, turns: e.turns })),
        cooldowns: Object.fromEntries(
          Object.entries(u.cooldowns || {}).filter(([, v]) => v > 0)),
      });

      return {
        scenarioId,
        round: host.combatRound,
        ended: host.combatEnded,
        current: session.current(),
        turnOrder: (host.turnOrder || []).map(u => host._unitRef(u)),
        zones: host.slotEffects,
        units: [...party, ...(host.enemies || [])].map(lean),
        logLength: host.combatEntries.length,
      };
    },

    /** Combat log lines from `from` onward, for incremental display. */
    logSince(from = 0) {
      return host.__logLines().slice(from);
    },

    /**
     * Apply one player's action.
     *
     * playerId is passed straight to _resolveAction, which owns the ownership
     * check. The session does not re-implement it -- one gate, one place.
     */
    act(playerId, intent = {}) {
      if (host.combatEnded) return { ok: false, reason: 'the fight is over' };
      const from = host.combatEntries.length;

      const verdict = host._resolveAction(
        { actor: intent.actor, skill: intent.skill, target: intent.target },
        { playerId }
      );
      host.__drain();

      return {
        ok: verdict.ok,
        reason: verdict.reason,
        log: session.logSince(from),
        state: session.state(),
      };
    },

    /**
     * End the current player's turn, then run the board forward until a human
     * is due to act again (or the fight ends).
     *
     * Enemy turns need no prompting: _advanceTurn schedules them on the host's
     * clock and the drain runs them. A player's turn schedules nothing, so the
     * loop naturally comes to rest there.
     */
    endTurn(playerId) {
      if (host.combatEnded) return { ok: false, reason: 'the fight is over' };

      const actor = host._currentChar?.();
      if (!actor) return { ok: false, reason: 'nobody is acting' };
      if (actor.ownerId == null) return { ok: false, reason: `${actor.name} is not player-controlled` };
      if (actor.ownerId !== playerId) return { ok: false, reason: `it is not your turn` };

      const from = host.combatEntries.length;
      host._advanceTurn({ playerEndedTurn: true });
      host.__drain();

      // Guard, not a tuning knob: reaching it means the board cannot hand the
      // turn back to a human, which is a bug to look at rather than a limit.
      let guard = 0;
      while (!host.combatEnded && (host._currentChar?.()?.ownerId == null)) {
        if (++guard > 200) throw new Error('turn loop never returned to a player');
        const before = host.currentTurnIndex;
        host.__drain();
        if (host.currentTurnIndex === before && !host.combatEnded) {
          const npc = host._currentChar();
          if (npc?.isEnemy) host._takeEnemyTurn_viaLogic(npc);
          else host._advanceTurn();
          host.__drain();
        }
      }

      return { ok: true, log: session.logSince(from), state: session.state() };
    },
  };

  return session;
}
