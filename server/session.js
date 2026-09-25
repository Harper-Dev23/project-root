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
import { randomSeed } from '../src/systems/seededRng.js';
import { startCombat, snapshotBoard } from '../tools/headless/fight.js';
import { fromWireCharacter } from '../src/systems/CoopWire.js';
import { GameplaySettings } from '../src/systems/GameplaySettings.js';
import { isItemInstance } from '../src/systems/ItemFactory.js';
import { COMBAT_SCENARIOS } from '../data/combatScenarios.js';

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
 * An enemy's equipment flags for the co-op broadcast: { slot: 'I' | 'D' | 'ID' }.
 * I = revealed by an Identify tonic, D = droppable. See the `gear` field in state().
 */
function gearFlags(unit) {
  const out = {};
  for (const [slot, inst] of Object.entries(unit.equipment || {})) {
    if (!isItemInstance(inst)) continue;   // rolled gear only; see _equipEnemyItem
    const code = (inst._identified ? 'I' : '') + (inst._droppable ? 'D' : '');
    if (code) out[slot] = code;
  }
  return out;
}

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
 *
 * `huntFight` makes this a map-hunt fight (Exploration v2, chunk 12b): the
 * host's HuntEngine.beginFight() spec, as JSON (see huntFightFrom). The hunt
 * itself stays on the host's client; the scene gets a recording stand-in, and
 * `session.huntOutcome` is what the host applies to its real hunt afterwards.
 * `vitals` ({ ref: { hp, mp, status } }) carry each hunter's state in from the
 * map, because a hunt's fights do not start at full health.
 */
/**
 * A hunter's HP and MP from the map, onto the fighter the session just built.
 * Only a real number within the hunter's own maximum is taken, and HP is at
 * least 1: on the map nobody is ever down (Starving never kills; the knocked
 * out stand at 1 HP after every fight, flee and Sheltered wipe), and a hunter
 * handed in at 0 sat in the turn order unable to act -- a fight could open on
 * their turn. Status is not taken from the wire.
 */
function applyVitals(char, v) {
  if (!v || typeof v !== 'object') return;
  const clamp = (n, min, max) => Math.max(min, Math.min(max, Math.floor(n)));
  if (Number.isFinite(v.hp)) char.currentHP = clamp(v.hp, 1, char.maxHP);
  if (Number.isFinite(v.mp)) char.currentMP = clamp(v.mp, 0, char.maxMP);
}

/**
 * The host's beginFight() spec (JSON, as it crossed the wire) made into what
 * CombatScene reads as `huntFight`, with a stand-in for the hunt.
 *
 * The real hunt lives on the host's client (AUTHORITY_MODEL); the server never
 * holds one. CombatScene calls hunt.winEncounter / flee / wipe / survive where
 * the fight ends, and hunt.getState() for the zone; the stand-in answers
 * getState from the spec's zoneId and RECORDS the ending, which the protocol
 * sends back for the host to apply to its real hunt. `reopen` and
 * `onFinished` belong to the single-player map scene and are left out.
 */
export function huntFightFrom(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('a hunt fight needs its spec');
  const scenario = spec.scenario;
  if (!scenario || typeof scenario !== 'object' || !Array.isArray(scenario.enemies) || !scenario.enemies.length) {
    throw new Error('a hunt fight needs a scenario with enemies');
  }
  if (typeof scenario.id !== 'string') throw new Error('a hunt fight scenario needs an id');
  const out = { spec, outcome: null };
  const record = (result, extra = {}) => {
    out.outcome = { result, deathRule: spec.deathRule ?? null, ...extra };
    return { ok: true };
  };
  const stand = {
    getState: () => ({ zoneId: spec.zoneId ?? null }),
    winEncounter: ({ loot = [], knockedOut = 0 } = {}) => record('won', { loot, knockedOut }),
    flee: ({ knockedOut = 0 } = {}) => record('fled', { knockedOut }),
    wipe: () => record('wipe'),
    // No intercession on the spot in co-op v1 (chunk 12 decision 5), so the
    // scene never calls this here; if it ever did, it is recorded, not lost.
    survive: ({ knockedOut = 0 } = {}) => record('survived', { knockedOut }),
  };
  out.fight = { ...spec, scenario, hunt: stand };
  return out;
}

export function createSession({ CombatScene, players = [], scenarioId = 'training_encounter_1', seed = null, quickCombat = false, gearSeed = null, huntFight = null, vitals = null }) {
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

  // A hunter placed in the lobby stands where its player put it. Everyone
  // else fills the remaining slots in order, which is what the whole party
  // used to do unconditionally.
  //
  // Position is not decoration: front, middle and back change what
  // rankVariants skills do, which shapes are in range, and who gets hit
  // first. Deciding it by join order meant whoever connected first chose the
  // formation for everyone.
  // From the board itself, NOT a local list. A hardcoded [1..6] here was a
  // FOURTH definition of the grid, kept while the commit that added
  // ALLY_SLOT_IDS claimed to have reduced it to one -- and it silently
  // disagreed with the lobby, which offers all eight. A guest who claimed
  // slots 7 and 8 had them fall through to the fill and land in 4 and 5: the
  // formation they chose was quietly overwritten between the lobby and the
  // board. The party cap of six limits how many hunters there are, never which
  // of the eight positions they may stand in.
  const SLOT_ORDER = CombatScene?.ALLY_SLOT_IDS || [1, 2, 3, 4, 5, 6, 7, 8];

  const claimed = new Set();
  const roster = [];
  for (const player of players) {
    for (const wire of (player.hunters || [])) {
      const char = fromWireCharacter(wire);
      char.ownerId = player.id;
      char.currentHP = char.maxHP;
      char.currentMP = char.maxMP;
      char.status = 'active';
      // A hunt fight starts where the map left each hunter (applyVitals).
      applyVitals(char, vitals?.[char.instanceId || char.id]);
      party.push(char);

      const want = Number(wire.slotId);
      // Two hunters cannot hold one slot. The lobby refuses that, so a
      // collision here means the guard failed; the second one falls through to
      // the fill rather than overwriting the first.
      if (SLOT_ORDER.includes(want) && !claimed.has(want)) {
        claimed.add(want);
        slotMap[want] = char.instanceId || char.id;
      } else {
        roster.push(char);
      }
    }
  }
  let slotCursor = 0;
  for (const char of roster) {
    while (claimed.has(SLOT_ORDER[slotCursor])) slotCursor++;
    const slot = SLOT_ORDER[slotCursor];
    if (slot === undefined) break;
    claimed.add(slot);
    slotMap[slot] = char.instanceId || char.id;
  }

  // Enemy gear is ROLLED, and every client runs placement locally to draw the
  // board, so without a shared seed each player saw a different Gorrek with
  // different derived stats. One seed decided here, sent to everyone, makes
  // every board identical. Must be set BEFORE __begin, which is what places
  // the enemies. Unlike `seed` above this touches nothing global, so
  // concurrent hunts cannot disturb each other's randomness.
  const fightGearSeed = Number.isFinite(gearSeed) ? gearSeed : randomSeed();
  host.gearSeed = fightGearSeed;

  // This host rules on the board but owns nobody's inventory, so a combat item
  // (Identify tonic, Severing Chant) must be applied without demanding a copy
  // from the server's own empty bag. The acting client spends the real item.
  host.isAuthoritativeHost = true;

  // A map-hunt fight: the host's spec plus a hunt that only records.
  const hunt = huntFight ? huntFightFrom(huntFight) : null;
  if (hunt) scenarioId = hunt.fight.scenario.id;

  host.__begin({ party, partySlots: slotMap, scenarioId, huntFight: hunt?.fight || null });
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
    // Sent to every client so they reproduce this board's enemy gear exactly.
    gearSeed: fightGearSeed,
    players: players.map(p => ({ id: p.id, name: p.name })),
    host,
    // A map-hunt fight's spec as the host sent it (the scenario included), for
    // the clients to build the same board; null for a pit fight.
    huntFight: hunt ? hunt.spec : null,
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
      // Same idiom as toWireCharacter: keep everything JSON-safe, drop the
      // rest, rather than naming fields and forgetting one.
      const leanEffect = (e) => {
        const out = {};
        for (const [k, v] of Object.entries(e || {})) {
          if (typeof v === 'function') continue;
          try { JSON.stringify(v); } catch { continue; }
          out[k] = v;
        }
        return out;
      };

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
        // The WHOLE effect, minus anything that cannot cross a socket -- not
        // {id, turns}, which is what this used to send and which threw away
        // every field the client draws with. Three separate reports came from
        // that one line: lodged arrows lost their `tint` and all rendered the
        // same colour, a runic zone lost its `mods` and reported no active
        // modifiers, and Rune Channel showed no sign of itself at all because
        // the flag saying it was on never arrived.
        //
        // Rules run on the server, so the client needs these for DISPLAY only;
        // functions are dropped the same way toWireCharacter drops them.
        effects: (u.statusEffects || []).map(leanEffect),
        cooldowns: Object.fromEntries(
          Object.entries(u.cooldowns || {}).filter(([, v]) => v > 0)),
        // Enemy equipment state, as { slot: 'I' | 'D' | 'ID' } -- I for revealed
        // by an Identify tonic, D for droppable (a Severing Chant sets it). Only
        // flagged slots are listed; an absent slot has neither.
        //
        // Without this a reveal happened on the server and on the screen of the
        // player who drank the tonic, and nowhere else: every other player kept
        // seeing [Uncommon] on armor their teammate had paid to read, and a lock
        // on gear that had already been cut free. The item identities themselves
        // never need to travel -- every client rolls the same gear from the
        // fight's gearSeed -- so two letters per slot is the whole payload.
        gear: u.isEnemy ? gearFlags(u) : undefined,
        // A summoned add: who called it, so each client builds the same add
        // through its own _summonEnemy (CombatScene._applyNetState).
        add: u.isAdd ? { summoner: u._summonerRef ?? null } : undefined,
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
        // Ground zones -- Conclave Circle's runic ring, quake cracks, anything
        // that persists on a tile rather than on a unit. These live in scene
        // state keyed by slot, not on any unit, so nothing about them crossed
        // the wire before and a co-op client simply never drew them.
        slotEffects: host.slotEffects || {},
        logLength: host.combatEntries.length,
      };
    },

    /**
     * What this fight is worth, for each client to apply to its OWN save.
     *
     * The server deliberately grants nothing. It reports the facts — which
     * scenario, what it pays, and which items the defeated dropped — and every
     * client runs the reward path it already has, for its own hunters. Saves
     * stay entirely local, and there is one definition of what a clear is
     * worth rather than a co-op copy that can drift.
     *
     * Loot is read exactly as `_onCombatVictory` reads it: every droppable
     * item instance on a defeated enemy, which is also how anything cut free
     * with a Severing Chant arrives.
     */
    rewards() {
      const scenario = COMBAT_SCENARIOS[scenarioId] || {};
      const loot = [];
      for (const enemy of (host.enemies || [])) {
        for (const inst of Object.values(enemy.equipment || {})) {
          if (isItemInstance(inst) && inst._droppable) loot.push(inst);
        }
      }
      if (hunt) {
        // A map-hunt fight pays an XP POOL, split over the whole party (each
        // client pays its own hunters' share), and its drops go into the
        // hunt's pack through the host's winEncounter, not into anyone's bag.
        return { scenarioId, hunt: true, xpPool: hunt.spec.xpPool ?? 0, loot };
      }
      return {
        scenarioId,
        xpReward: scenario.xpReward ?? 0,
        xpRepeatable: !!scenario.xpRepeatable,
        // Copied to everyone rather than split — the simplest thing that is
        // not unfair, and what co-op games normally do among friends.
        loot,
      };
    },

    /**
     * How a map-hunt fight ended, for the HOST to apply to its real hunt:
     * { result: 'won' | 'fled' | 'wipe', loot, knockedOut, deathRule }, or
     * null while the fight is live (and always for a pit fight). The scene
     * called the stand-in hunt exactly where it calls a real one.
     */
    get huntOutcome() {
      return hunt ? hunt.outcome : null;
    },

    /**
     * Every hunter's state at this moment, { ref: { hp, mp, status } }: what
     * the map carries on with after the fight. The mirror of `vitals` in.
     */
    vitals() {
      return Object.fromEntries(party.map(c => [c.instanceId || c.id,
        { hp: c.currentHP, mp: c.currentMP, status: c.status }]));
    },

    /**
     * The party flees a map-hunt fight (CombatScene._startFlee): on a hunter's
     * turn, every living enemy gets one free turn, then the fight ends as a
     * flee (or as a wipe, if the free round finishes the party). Who may call
     * it is the protocol's rule (the hunt's host); the session only checks
     * that it can happen now.
     */
    flee() {
      if (!hunt) return { ok: false, reason: 'there is no fleeing a pit fight' };
      if (host.combatEnded) return { ok: false, reason: 'the fight is over' };
      const actor = host._currentChar?.();
      if (!actor || actor.ownerId == null) return { ok: false, reason: "flee on one of the party's turns" };
      const from = host.combatEntries.length;
      version++;
      host._startFlee();
      host.__drain();
      let guard = 0;
      while (!host.combatEnded) {
        if (++guard > 200) throw new Error('the free round never ended');
        const before = host.currentTurnIndex;
        host.__drain();
        const npc = host._currentChar?.();
        if (!host.combatEnded && host.currentTurnIndex === before && npc?.isEnemy) {
          host._takeEnemyTurn_viaLogic(npc);
          host.__drain();
        }
      }
      return { ok: true, log: session.logSince(from), events: host.__takeEvents(), state: session.state() };
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
        // Position, so a move counts as a change even if it cost nothing.
        u._slot?.slotId ?? null,
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
        { actor: intent.actor, skill: intent.skill, target: intent.target, targetSlot: intent.targetSlot },
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
