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
import { fromWireCharacter } from '../src/systems/CoopWire.js';
import { GameplaySettings } from '../src/systems/GameplaySettings.js';

/** The shared party cap. Already the game's own limit in five places. */
export const PARTY_LIMIT = 6;

// ---------------------------------------------------------------------------
// The wire
//
// toWireCharacter / fromWireCharacter live in src/systems/CoopWire.js, not
// here: the BROWSER needs them too (it packs its own hunters before joining a
// lobby), and two implementations of "what a character is on the wire" would
// eventually disagree. Re-exported so server code can keep importing them from
// the session module it already uses.
// ---------------------------------------------------------------------------

export { toWireCharacter, fromWireCharacter } from '../src/systems/CoopWire.js';

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
 *
 * `seed` is for REPRODUCING a fight (a replay, a bug report). Pass null - as a
 * server should - and the ambient randomness is left alone. Seeding here
 * replaces the global Math.random, so a server that seeded every session would
 * have each new hunt reset the randomness of every hunt already in progress.
 */
export function createSession({ CombatScene, players = [], scenarioId = 'training_encounter_1', seed = null, quickCombat = false }) {
  if (!CombatScene) throw new Error('createSession needs the CombatScene class');
  if (!players.length) throw new Error('a session needs at least one player');

  const ids = players.map(p => p.id);
  if (new Set(ids).size !== ids.length) throw new Error('duplicate player id');

  const total = players.reduce((n, p) => n + (p.hunters?.length || 0), 0);
  if (total < 1) throw new Error('the party is empty');
  if (total > PARTY_LIMIT) {
    throw new Error(`the party is ${total} hunters; the shared limit is ${PARTY_LIMIT}`);
  }

  // The SAME hunter cannot be brought twice.
  //
  // This is not hypothetical, and it is the first thing local testing hits:
  // two browser tabs on one machine share localStorage, so both players load
  // the same save and can each pick the same character. Two units answering to
  // one instanceId makes every reference to them ambiguous, and
  // _findUnitByRef correctly refuses to guess — so actions would simply stop
  // working, with nothing on screen explaining why. Better to refuse at the
  // door and say so.
  const hunterIds = players.flatMap(p => (p.hunters || []).map(h => h.instanceId || h.id));
  const dupes = hunterIds.filter((id, i) => hunterIds.indexOf(id) !== i);
  if (dupes.length) {
    const names = players
      .flatMap(p => (p.hunters || []))
      .filter(h => dupes.includes(h.instanceId || h.id))
      .map(h => h.name);
    throw new Error(`the same hunter cannot be brought twice: ${[...new Set(names)].join(', ')}`);
  }

  if (seed != null) seedRng(seed);

  // The recording is made at the pace it will be WATCHED at, and clients replay
  // it one to one.
  //
  // Scaling on the client cannot work, because the engine's delays are a
  // deliberate mix: VFX waits are multiplied by animDurationMult, while the
  // structural gaps between enemy actions (150ms, 200ms, 400ms) are explicitly
  // NOT. Multiplying the whole recorded timeline stretches waits that single
  // player never stretches, so the fight drifts further from its own rhythm the
  // longer it runs. Applying the multiplier on BOTH sides made it worse again:
  // four times four, which is how an enemy round came to take half a minute.
  //
  // So the pace is set once, here, from the lobby host's own setting, and the
  // timeline that goes out is exactly what the engine would have produced on
  // that player's screen. Everyone in the hunt watches the same thing at the
  // same speed, which is the right answer for a shared fight anyway.
  GameplaySettings.set('quickCombat', !!quickCombat);

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

  // Every state that goes out carries a version, bumped once per mutation.
  //
  // Without it a client cannot tell a fresh board from a stale one. Two
  // broadcasts are routinely in flight at once — an action and the end of turn
  // that follows it — and a client that simply takes "the next state message"
  // can act twice on the older of the two. That is not hypothetical: it is
  // exactly how the first end-to-end run failed, with a player told it was
  // still their turn after they had ended it.
  let version = 0;

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
        version,
        round: host.combatRound,
        ended: host.combatEnded,
        current: session.current(),
        turnOrder: (host.turnOrder || []).map(u => host._unitRef(u)),
        zones: host.slotEffects,
        units: [...party, ...(host.enemies || [])].map(lean),
        logLength: host.combatEntries.length,
      };
    },

    /**
     * Combat log entries from `from` onward, for incremental display.
     *
     * STRUCTURED, not flattened. The detailed damage breakdown a player can
     * hover lives on a segment as `tooltipData`, and a client sent only text
     * has nothing to show. See host.__wireLogEntry for what has to be turned
     * into a reference on the way out.
     */
    logSince(from = 0) {
      return host.combatEntries.slice(from).map(e => host.__wireLogEntry(e));
    },

    /**
     * Everything about the board that an action could change, as one string.
     *
     * Used to tell a real action from one that fizzled. A skill refused BEFORE
     * it runs never reaches the log at all, but one that starts and then gives
     * up logs its reason through the shared combat log, which broadcasts it to
     * everybody — so a player is told, in public, why someone else's spell did
     * not work. Comparing the board before and after separates the two without
     * having to pattern-match the text of a message.
     */
    fingerprint() {
      return JSON.stringify([...party, ...(host.enemies || [])].map(u => [
        u.currentHP, u.currentMP, u.initiativeGauge, u.shieldHP || 0, u.status,
        u.weakness?.meters, u.weakness?.tiers,
        (u.statusEffects || []).map(e => e.id + ':' + e.turns),
        u.actionsLeft, u.cooldowns,
      ]));
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
      const before = session.fingerprint();

      const verdict = host._resolveAction(
        { actor: intent.actor, skill: intent.skill, target: intent.target },
        { playerId }
      );
      host.__drain();
      if (verdict.ok) version++;

      // Nothing moved: the skill started, gave up, and explained itself. That
      // explanation belongs to the player who tried it, not to the room.
      const changedNothing = session.fingerprint() === before;
      const lines = session.logSince(from);

      return {
        ok: verdict.ok,
        reason: verdict.reason,
        log: changedNothing ? [] : lines,
        privateLog: changedNothing ? lines : [],
        // What the engine WOULD have drawn, in order, with the virtual clock's
        // timestamps. The client replays this to get the game's own VFX and
        // pacing back; without it a co-op board simply jumps from before to
        // after. See RECORDED_METHODS in combatHost.js.
        events: host.__takeEvents(),
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
      version++;
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

      return {
        ok: true,
        log: session.logSince(from),
        events: host.__takeEvents(),
        state: session.state(),
      };
    },
  };

  return session;
}
