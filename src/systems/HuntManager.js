// src/systems/HuntManager.js
// Runtime state for an active Hunt — supplies, day/night, depth, and the
// turn-based encounter loop. Same engine drives every zone for now (Bay of
// Solace and Reeds of Gethsemane); only data/zones.js content differs.
//
// Turn-based, not timer-based: advance() is called once per player click of
// an "Advance" button. If a roll produces an encounter, it sits as a
// "pending" encounter (hidden from the player) until resolveEncounter() is
// called — that's what the Investigate/Resolve flow in HuntEncounterOverlay
// drives. Hunt Points are only awarded on resolution, not on the roll.
//
// Region modifiers, the chosen Hunt Plan's modifiers, and a randomly-rolled
// weather effect (revealed only once the hunt starts, not during loadout)
// are combined once at start via HuntModifiers.combineModifiers() and read
// from for the rest of the hunt — none of the three sources change mid-hunt.
//
// ── Instances, not a singleton ──────────────────────────────────────────────
// createHunt() returns a self-contained hunt. Everything that changes during a
// hunt lives in that instance, including its own seeded random stream, so two
// hunts in one process cannot touch each other (the trap seededRng.js
// documents for global seeding). `HuntManager` at the bottom of this file is
// only the single-player HOLDER: "the one hunt this browser tab is running".
// It keeps the old call surface, so CombatScene and the overlays read it
// exactly as before.
//
// What a hunt does to the rest of the game — XP, Hunt Points, the save-wide
// day/night clock, party HP — goes through a `world` object rather than being
// imported here. The game passes GAME_WORLD; the headless harness passes its
// own. That seam is also where co-op will split "the host resolves" from "each
// client applies" (AUTHORITY_MODEL in the design vault).
//
// ── Persistence ─────────────────────────────────────────────────────────────
// A hunt survives a reload. serialize() gives plain JSON, written into the save
// as one `hunt` field (GameState.save), and restoreHunt() rebuilds it. The
// random stream's STATE is saved with it, so a reload does not re-roll what
// comes next. What was already rolled (weather, modifiers, a pending event
// and its die) is stored as rolled, not re-derived, so a deploy that changes
// the data cannot change a hunt already in progress.
//
// Reloading mid-fight counts as fleeing (design: SAVE_COMPATIBILITY rec. 4).
// A fight is marked `engaged` when the player commits to it; a restored hunt
// with an engaged fight resolves it as a flee. For now a flee costs the
// fight's reward and nothing else; its full cost arrives with the encounter
// rules (IMPLEMENTATION_PLAN chunk 7).

import { EncounterRoller } from './EncounterRoller.js';
import { TribeHuntSimulator } from './TribeHuntSimulator.js';
import { getPlayerPartyId } from '../../data/tribeHuntingParties.js';
import { combineModifiers } from './HuntModifiers.js';
import { rollWeather } from '../../data/weather.js';
import { getZone } from '../../data/zones.js';
import { makeRng, rngFromState, randomSeed, isSeed } from './seededRng.js';
import ProgressionManager from './ProgressionManager.js';
import GameState from './GameState.js';

// Tuned so a base-loadout hunt (no extra Hunt Tickets spent on supplies)
// guarantees at least one full day+night cycle (12 advances) and typically
// runs 2-3 cycles: 60 base supplies / 2 per advance = 30 advances ≈ 2.5 days.
const SUPPLY_DRAIN_PER_ADVANCE = 2;
const MIN_SUPPLY_DRAIN         = 1;      // floor — efficiency can't make travel free
const DAY_NIGHT_ADVANCES        = 6;     // advances before day/night flips (12 = one full day+night)
const BASE_ENCOUNTER_CHANCE     = 0.15;
const DEPTH_CHANCE_MULTIPLIER   = 0.01;
const MAX_ENCOUNTER_CHANCE      = 0.6;
const LOG_LIMIT                 = 50;
const BASE_BEAST_FIGHT_HUNT_POINTS = 8; // awarded on winning a Beast fight, before the Hunt Points modifier
const CHECK_DIE_SIDES           = 20;

/**
 * Shape version of a serialized hunt — the `hunt` field of a save. Separate
 * from SAVE_VERSION: the save's version says which fields exist, this says
 * what is inside this one. Bump it, and teach restoreHunt the old shape,
 * whenever serialize() changes.
 */
export const HUNT_STATE_VERSION = 1;

/** The real game's side of a hunt. See the header. */
export const GAME_WORLD = {
  nightFalls() {
    // Save-wide elapsed time. A hunt's own day/isNight reset per hunt; these
    // accumulate for the life of the save so a hunt-season limit has a clock.
    ProgressionManager.advanceNight();
  },
  dayBreaks() {
    ProgressionManager.advanceDay();
    // Other tribes' background progress ticks once per in-game day — far
    // coarser than the player's own per-advance turn. It still rolls with
    // Math.random: it is save-wide world state, written by the same autosave
    // as the move that caused it, so a reload cannot re-roll it separately.
    TribeHuntSimulator.tick();
  },
  awardHuntPoints(amount) {
    ProgressionManager.addHuntPoints(amount);
    if (ProgressionManager.tribe) {
      const playerPartyId = getPlayerPartyId(ProgressionManager.tribe);
      if (playerPartyId) ProgressionManager.addPartyPoints(ProgressionManager.tribe, playerPartyId, amount);
    }
  },
  awardXP(pool) {
    // A hunt's XP is a pool split across the party, not paid to each hunter.
    GameState.awardXPPool(pool);
  },
  party() {
    return GameState.party || [];
  },
};

/**
 * Start a new hunt.
 *
 * @param {string} zoneId
 * @param {{ supplies?: number, huntPlanModifiers?: object, seed?: number }} opts
 *   `seed` is for replays and the harness; the game leaves it out and gets a
 *   fresh one. It is kept on the hunt only as a label — the saved stream
 *   state, not the seed, is what a reload continues from.
 * @param {object} world  see GAME_WORLD
 */
export function createHunt(zoneId, { supplies = 100, huntPlanModifiers = null, seed = randomSeed() } = {}, world = GAME_WORLD) {
  const rng = makeRng(seed);
  const weather = rollWeather(rng);
  const zone = getZone(zoneId);
  const state = {
    v: HUNT_STATE_VERSION,
    seed,
    zoneId,
    supplies,
    maxSupplies: supplies,
    day: 1,
    isNight: false,
    depth: 0,
    advancesSinceFlip: 0,
    sessionHuntPoints: 0,
    log: [],
    pendingEncounter: null,
    weather,
    combinedModifiers: combineModifiers(zone?.modifiers, weather.modifiers, huntPlanModifiers),
  };
  return makeHunt(state, rng, world);
}

/**
 * Rebuild a hunt from serialize() output. Throws on anything it does not
 * recognise, rather than half-restoring a hunt the player would then play in
 * a broken state; GameState drops the hunt (not the save) when this throws.
 */
export function restoreHunt(data, world = GAME_WORLD) {
  if (!data || typeof data !== 'object') throw new Error('no hunt data');
  if (data.v !== HUNT_STATE_VERSION) {
    throw new Error(`unknown hunt state version ${data.v} (this build reads ${HUNT_STATE_VERSION})`);
  }
  if (!getZone(data.zoneId)) throw new Error(`unknown hunt zone '${data.zoneId}'`);
  if (!isSeed(data.rngState)) throw new Error('hunt has no random-stream state');
  for (const k of ['supplies', 'maxSupplies', 'day', 'depth', 'advancesSinceFlip', 'sessionHuntPoints']) {
    if (!Number.isFinite(data[k])) throw new Error(`hunt field '${k}' is not a number`);
  }
  if (!Array.isArray(data.log)) throw new Error('hunt log is not a list');
  if (!data.weather || !data.combinedModifiers) throw new Error('hunt is missing its weather or modifiers');

  const { rngState, ...rest } = data;
  const state = clone(rest);
  const hunt = makeHunt(state, rngFromState(rngState), world);

  // Reloading mid-fight counts as fleeing. See the header.
  if (state.pendingEncounter?.kind === 'encounter' && state.pendingEncounter.engaged) {
    hunt._flee('The fight was broken off. You fled, and it paid nothing.');
  }
  return hunt;
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function makeHunt(s, rng, world) {
  return {
    hasPendingEncounter() {
      return s.pendingEncounter !== null;
    },

    /**
     * Advances the hunt by one turn: drains supplies (eased by Travel
     * Efficiency), advances depth, flips day/night on a threshold, and rolls
     * an encounter chance based on depth + Encounter Chance modifier (biased
     * toward 'beasts' by Beast Encounter Weight). Refuses to advance while a
     * previous encounter is still pending — the player must Investigate it first.
     *
     * Returns a state snapshot; `ended` is true once supplies hit 0 (the
     * caller should still let any pending encounter resolve before finalizing).
     */
    advance() {
      if (s.pendingEncounter) return null;

      const drain = Math.max(
        MIN_SUPPLY_DRAIN,
        SUPPLY_DRAIN_PER_ADVANCE * (1 - s.combinedModifiers.supplyEfficiencyPercent / 100)
      );
      s.supplies = Math.max(0, s.supplies - drain);
      s.depth += 1;
      s.advancesSinceFlip += 1;

      if (s.advancesSinceFlip >= DAY_NIGHT_ADVANCES) {
        s.advancesSinceFlip = 0;
        s.isNight = !s.isNight;
        if (s.isNight) {
          world.nightFalls();
        } else {
          s.day += 1;
          world.dayBreaks();
        }
      }

      const chance = Math.min(
        MAX_ENCOUNTER_CHANCE,
        BASE_ENCOUNTER_CHANCE + s.depth * DEPTH_CHANCE_MULTIPLIER + s.combinedModifiers.encounterChancePercent / 100
      );

      if (rng() < chance) {
        const rolled = EncounterRoller.roll(s.zoneId, s.depth, s.combinedModifiers.beastChanceWeight, s.isNight, rng);
        // Copied, because a pending event carries its zone entry, which is
        // shared data and must never be written through.
        s.pendingEncounter = rolled ? clone(rolled) : null;
        // A check's die is rolled HERE, with the hunt's stream, and shown by
        // the dice token later. Rolling it when the event screen opens made
        // every reload a fresh roll of the die.
        if (s.pendingEncounter?.eventDef?.kind === 'check') {
          s.pendingEncounter.dieRoll = 1 + Math.floor(rng() * CHECK_DIE_SIDES);
        }
      }

      return {
        ...this.getState(),
        ended: s.supplies <= 0,
      };
    },

    /**
     * Resolves a pending 'event' (non-fight) encounter once HuntEncounterOverlay
     * has worked out an `outcome` via EventResolver (a choice's outcome, a
     * check's success/failure branch, or a puzzle's success/failure branch):
     * `{ text, huntPoints, xp?, hpDelta? }`. Hunt Points are scaled by the Hunt
     * Points modifier same as combat; XP goes through the shared leveling path;
     * hpDelta (rare, modest) lands on one random living party member and is
     * clamped so events can never be lethal — that's what combat is for.
     * 'encounter' (fight) pending entries are resolved by resolveCombatEncounter()
     * instead. Returns the resolved log entry, or null if nothing was pending.
     */
    resolveEncounter(outcome) {
      if (!s.pendingEncounter || s.pendingEncounter.kind !== 'event' || !outcome) return null;

      const pending = s.pendingEncounter;
      s.pendingEncounter = null;

      const huntPoints = Math.round((outcome.huntPoints || 0) * (1 + s.combinedModifiers.huntPointsPercent / 100));

      if (outcome.xp > 0) world.awardXP(outcome.xp);
      if (outcome.hpDelta) this._applyHpDelta(outcome.hpDelta);

      const resolved = {
        kind: 'event',
        type: pending.type,
        label: outcome.text ? `${pending.label} ${outcome.text}` : pending.label,
        huntPoints,
      };

      this._awardAndLog(resolved);
      return resolved;
    },

    /** Applies a (clamped, never-lethal) HP change to one random living party member. */
    _applyHpDelta(amount) {
      const living = world.party().filter(c => c.status !== 'dead' && c.status !== 'incapacitated');
      if (living.length === 0) return;
      const target = living[Math.floor(rng() * living.length)];
      target.currentHP = Math.min(target.maxHP, Math.max(1, target.currentHP + amount));
    },

    /**
     * The player has committed to the pending fight. From here a reload is a
     * flee, not a second attempt. Call it, then autosave, before combat starts.
     */
    engagePending() {
      if (s.pendingEncounter?.kind !== 'encounter') return false;
      s.pendingEncounter.engaged = true;
      return true;
    },

    /**
     * Resolves a pending 'encounter' (fight) after CombatScene reports the
     * outcome. A won Beast fight awards Hunt Points (scaled the same way as
     * resolveEncounter); a won Cultist fight awards none — its reward is the
     * equipment CombatScene already dropped into inventory. A loss just clears
     * the pending flag with no reward (the hunt itself is ended separately by
     * the caller on a full party wipe).
     */
    resolveCombatEncounter({ won, type }) {
      if (!s.pendingEncounter || s.pendingEncounter.kind !== 'encounter') return null;

      const pending = s.pendingEncounter;
      s.pendingEncounter = null;
      if (!won) return null;

      const huntPoints = type === 'beast'
        ? Math.round(BASE_BEAST_FIGHT_HUNT_POINTS * (1 + s.combinedModifiers.huntPointsPercent / 100))
        : 0;

      const resolved = { ...pending, huntPoints };
      this._awardAndLog(resolved);
      return resolved;
    },

    /** Drops the pending fight as a flee: no reward, one log line. */
    _flee(label) {
      const pending = s.pendingEncounter;
      if (pending?.kind !== 'encounter') return null;
      s.pendingEncounter = null;
      const entry = { kind: 'flee', type: pending.type, label, huntPoints: 0 };
      this._log(entry);
      return entry;
    },

    /** Shared by resolveEncounter/resolveCombatEncounter — awards Hunt Points and logs the result. */
    _awardAndLog(resolved) {
      s.sessionHuntPoints += resolved.huntPoints;
      world.awardHuntPoints(resolved.huntPoints);
      this._log(resolved);
    },

    _log(entry) {
      s.log.push(entry);
      if (s.log.length > LOG_LIMIT) s.log.shift();
    },

    getState() {
      return {
        zoneId: s.zoneId,
        supplies: s.supplies,
        maxSupplies: s.maxSupplies,
        day: s.day,
        isNight: s.isNight,
        depth: s.depth,
        sessionHuntPoints: s.sessionHuntPoints,
        log: [...s.log],
        pendingEncounter: s.pendingEncounter,
        weather: s.weather,
        combinedModifiers: s.combinedModifiers,
      };
    },

    /** Plain JSON for the save. restoreHunt(serialize()) continues identically. */
    serialize() {
      return { ...clone(s), rngState: rng.getState() };
    },
  };
}

// ── The single-player holder ────────────────────────────────────────────────

let _current = null;

// What getState() reports with no hunt running — the same values the old
// module-level singleton held after end(), so callers that read it while idle
// (CombatScene's hunt modifiers) see what they always saw.
const IDLE_STATE = Object.freeze({
  zoneId: null,
  supplies: 0,
  maxSupplies: 0,
  day: 1,
  isNight: false,
  depth: 0,
  sessionHuntPoints: 0,
  log: [],
  pendingEncounter: null,
  weather: null,
  combinedModifiers: null,
});

export const HuntManager = {
  /** The live hunt instance, or null. */
  current() {
    return _current;
  },

  isActive() {
    return _current !== null;
  },

  hasPendingEncounter() {
    return !!_current?.hasPendingEncounter();
  },

  /**
   * @param {string} zoneId
   * @param {{ supplies?: number, huntPlanModifiers?: object, seed?: number }} opts
   */
  start(zoneId, opts = {}) {
    _current = createHunt(zoneId, opts);
  },

  advance() {
    return _current ? _current.advance() : null;
  },

  resolveEncounter(outcome) {
    return _current ? _current.resolveEncounter(outcome) : null;
  },

  engagePending() {
    return _current ? _current.engagePending() : false;
  },

  resolveCombatEncounter(result) {
    return _current ? _current.resolveCombatEncounter(result) : null;
  },

  getState() {
    return _current ? _current.getState() : { ...IDLE_STATE, log: [] };
  },

  /** Ends the hunt in memory. The next autosave records that there is none. */
  end() {
    _current = null;
  },
};

// The save reaches the live hunt through these hooks. GameState cannot import
// this file (it imports GameState), so HuntManager hands itself over instead.
// A saved hunt that cannot be restored is dropped with an error rather than
// failing the whole load: losing a hunt is recoverable, losing a save is not.
GameState.attachHunt({
  serialize: () => (_current ? _current.serialize() : null),
  restore: (data) => {
    _current = null;
    if (!data) return;
    try {
      _current = restoreHunt(data);
    } catch (e) {
      console.error(`[HuntManager] The saved hunt could not be restored and was dropped: ${e.message}`);
    }
  },
});
