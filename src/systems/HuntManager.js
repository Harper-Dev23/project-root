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
// rules (map hunts, HuntEngine.js: 7c's flee).
//
// ── The hunt pack ───────────────────────────────────────────────────────────
// Everything taken into a hunt and everything found on it travels in the pack
// (HUNT_STRUCTURE, amendment of 2026-09-18), and the pack is what is at risk:
//
//                 clean exit        Sheltered wipe    Watched/Forsaken wipe
//   brought       leftovers home    leftovers home    lost
//   found         into the bag      into the bag      lost
//
// The camp bag (GameState.inventory) is never at risk. Equipped gear is not in
// the pack; its loss waits for soulbound (DEATH_AND_REVIVAL).
//
// Supplies are Rations, a stackable item. The camp issues CAMP_ISSUE supplies
// free on every departure, and the rations a player packs sit on top; the
// issue is eaten first, so what comes home is min(rations packed, supplies
// left). A free issue that came home would be free rations for walking out of
// the gate, so it never does. `supplies` itself stays one number: it is the
// fuel the hunt burns, and the golden records it.
//
// The death rule is read from the zone ONCE, at departure, and kept on the
// hunt, like the modifiers: a deploy cannot change what a live hunt risks.

import { EncounterRoller } from './EncounterRoller.js';
import { TribeHuntSimulator } from './TribeHuntSimulator.js';
import * as Standing from './Standing.js';
import { completeRites } from './Revival.js';
import { getPlayerPartyId } from '../../data/tribeHuntingParties.js';
import { combineModifiers } from './HuntModifiers.js';
import { rollWeather } from '../../data/weather.js';
import { getZone } from '../../data/zones.js';
import { makeRng, rngFromState, randomSeed, isSeed } from './seededRng.js';
import { Items } from '../../data/items.js';
import { addToList, stackQty, makeStack } from './ItemStacks.js';
import { isItemInstance } from './ItemFactory.js';
import { InventorySystem } from './InventorySystem.js';
import ProgressionManager from './ProgressionManager.js';
import GameState from './GameState.js';
import { createMapHunt, restoreMapHunt } from './HuntEngine.js';

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
export const HUNT_STATE_VERSION = 2; // 2: the hunt pack and the death rule

/**
 * Supplies the camp gives every departure, free. Eaten first; never comes
 * home. It was the Hunt screen's BASE_SUPPLIES, unchanged at 60.
 */
export const CAMP_ISSUE = 60;

/**
 * What a region does on a wipe (DEATH_AND_REVIVAL). Read here for the pack;
 * who dies, and how they come back, is the combat hookup (chunk 9). A zone
 * with no rule gets the design's default, Watched.
 */
export const DEATH_RULES = ['sheltered', 'watched', 'forsaken'];
const DEFAULT_DEATH_RULE = 'watched';

/** The zone's death rule, validated. */
export function zoneDeathRule(zone) {
  const r = zone?.deathRule ?? DEFAULT_DEATH_RULE;
  if (!DEATH_RULES.includes(r)) throw new Error(`unknown death rule '${r}' on zone '${zone?.id}'`);
  return r;
}

/** The real game's side of a hunt. See the header. */
export const GAME_WORLD = {
  nightFalls() {
    // Save-wide elapsed time. A hunt's own day/isNight reset per hunt; these
    // accumulate for the life of the save so a hunt-season limit has a clock.
    ProgressionManager.advanceNight();
  },
  dayBreaks() {
    ProgressionManager.advanceDay();
    // Standing (chunk 10a): the rivals court their houses once a day, and a
    // season that has run its length ends here (Standing.dayBreak), BEFORE
    // the tribes' day below, so the new day's points count for the new
    // season. The Hunt Point race lives on ProgressionManager, so its reset
    // is done here, after the winner was read.
    const pm = ProgressionManager;
    const r = Standing.dayBreak(pm.getStanding(), pm.getDaysElapsed(), pm.tribe, { ...pm.tribeHuntPoints });
    if (r.season) pm.resetSeasonRace();
    // Other tribes' background progress ticks once per in-game day — far
    // coarser than the player's own per-advance turn. It still rolls with
    // Math.random: it is save-wide world state, written by the same autosave
    // as the move that caused it, so a reload cannot re-roll it separately.
    TribeHuntSimulator.tick();
    // The lesser rite (chunk 10c): a hunter whose days have passed comes back.
    r.revived = completeRites(pm.getDaysElapsed()).map(c => c.name);
    return r;
  },
  awardHuntPoints(amount) {
    ProgressionManager.addHuntPoints(amount);
    if (ProgressionManager.tribe) {
      const playerPartyId = getPlayerPartyId(ProgressionManager.tribe);
      if (playerPartyId) ProgressionManager.addPartyPoints(ProgressionManager.tribe, playerPartyId, amount);
      // Your own tribe's regard grows with what you bring home (decision 10).
      const rep = Standing.repFromHuntPoints(ProgressionManager.getStanding(), amount);
      if (rep > 0) ProgressionManager.addTribeRep(ProgressionManager.tribe, rep);
    }
  },
  awardXP(pool) {
    // A hunt's XP is a pool split across the party, not paid to each hunter.
    GameState.awardXPPool(pool);
  },
  // Standing (chunk 10b): favor earned on a hunt raises the Bond's standing
  // and your tribe's devotion with that house at once; the hunt reads which
  // house your tribe follows once, at departure.
  favor(house, amount) {
    Standing.earnFavor(ProgressionManager.getStanding(), ProgressionManager.tribe, house, amount);
  },
  followedHouse() {
    return Standing.followedHouse(ProgressionManager.getStanding(), ProgressionManager.tribe);
  },
  bankItems(items, { found }) {
    // Found items are new acquisitions and get the inventory's "new" dot;
    // leftovers of what was brought are coming back, not arriving.
    for (const inst of items) InventorySystem.addGlobalItem(inst, { isNew: !!found });
  },
  party() {
    return GameState.party || [];
  },
};

/**
 * Start a new hunt.
 *
 * @param {string} zoneId
 * @param {{ supplies?: number, huntPlanModifiers?: object, seed?: number, bring?: object[] }} opts
 *   `seed` is for replays and the harness; the game leaves it out and gets a
 *   fresh one. It is kept on the hunt only as a label — the saved stream
 *   state, not the seed, is what a reload continues from.
 *   `bring` is the item instances packed at departure, already taken out of
 *   the bag by the caller (a Rations stack, today). `supplies` is the total
 *   the hunt starts with, and must already include the rations in `bring`.
 * @param {object} world  see GAME_WORLD
 */
export function createHunt(zoneId, { supplies = 100, huntPlanModifiers = null, seed = randomSeed(), bring = [] } = {}, world = GAME_WORLD) {
  const rng = makeRng(seed);
  // The plan's Foul Weather prefix leans the roll harsher (data/weather.js).
  const weather = rollWeather(rng, huntPlanModifiers?.foulWeatherPercent || 0);
  const zone = getZone(zoneId);
  const { pack, extraSupplies } = packAtDeparture(bring, huntPlanModifiers);
  supplies += extraSupplies;
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
    deathRule: zoneDeathRule(zone),
    pack,
    finished: null,
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
  if (!getZone(data.zoneId)) throw new Error(`unknown hunt zone '${data.zoneId}'`);
  data = upgradeHuntState(data);
  if (data.v !== HUNT_STATE_VERSION) {
    throw new Error(`unknown hunt state version ${data.v} (this build reads ${HUNT_STATE_VERSION})`);
  }
  if (!DEATH_RULES.includes(data.deathRule)) throw new Error(`hunt has no valid death rule ('${data.deathRule}')`);
  if (!Array.isArray(data.pack?.brought) || !Array.isArray(data.pack?.found)
      || ![...data.pack.brought, ...data.pack.found].every(isItemInstance)) {
    throw new Error('hunt pack is not two lists of items');
  }
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

/**
 * Older hunt shapes, brought forward one version at a time. Returns a copy and
 * never edits what it was given. A version it does not know passes through
 * untouched, for restoreHunt to refuse.
 *   1 -> 2  the pack and the death rule. A v1 hunt's supplies were bought with
 *           tickets under the old rule, where nothing came home, so its pack
 *           starts empty: it brought nothing that could be returned.
 */
function upgradeHuntState(data) {
  let d = data;
  if (d.v === 1) {
    d = { ...clone(d), v: 2, deathRule: zoneDeathRule(getZone(d.zoneId)), pack: { brought: [], found: [] }, finished: null };
  }
  return d;
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

/**
 * The hunt pack at departure: the instances the caller packed, plus the plan's
 * "of Provision" Rations on top. Those are packed Rations like any other, so
 * what is left of them comes home on a clean exit. `extraSupplies` is what the
 * Provision Rations add to the starting supplies. Shared by createHunt and the
 * map hunt (HuntEngine.js), so both pack the same way.
 */
export function packAtDeparture(bring = [], huntPlanModifiers = null) {
  const pack = { brought: [], found: [] };
  for (const inst of bring) {
    if (!isItemInstance(inst)) throw new Error('only item instances can be packed');
    addToList(pack.brought, clone(inst));
  }
  const provision = Math.max(0, Math.floor(huntPlanModifiers?.provisionRations || 0));
  let extraSupplies = 0;
  if (provision > 0) {
    addToList(pack.brought, makeStack('rations', provision));
    extraSupplies = provision * supplyPerRation();
  }
  return { pack, extraSupplies };
}

/**
 * What the pack holds, and what an ending does with it (see the header). Rations
 * left are the supplies still unspent (the camp issue eaten first), capped at
 * what was packed. Every other brought item is still whole. Pure: changes
 * nothing. Shared by createHunt's hunt and the map hunt (HuntEngine.js).
 */
export function settlePack({ pack, supplies, deathRule, ending }) {
  if (ending !== 'exit' && ending !== 'wipe') throw new Error(`unknown hunt ending '${ending}'`);
  const rationsPacked = pack.brought.reduce((n, it) => (it.id === 'rations' ? n + stackQty(it) : n), 0);
  const rationsLeft = Math.min(rationsPacked, Math.floor(supplies / supplyPerRation() + 1e-9));

  const brought = [];
  let rationsPlaced = false;
  for (const it of pack.brought) {
    if (it.id !== 'rations') { brought.push(clone(it)); continue; }
    // Every packed ration comes back as one stack of what is left.
    if (rationsPlaced || rationsLeft <= 0) continue;
    brought.push({ ...clone(it), qty: rationsLeft });
    rationsPlaced = true;
  }
  const found = clone(pack.found);

  const keeps = ending === 'exit' || deathRule === 'sheltered';
  const none = { brought: [], found: [] };
  return {
    ending,
    deathRule,
    keeps,
    rationsPacked,
    rationsLeft,
    home: keeps ? { brought, found } : none,
    lost: keeps ? none : { brought, found },
  };
}

/** Supplies one Rations unit is worth (data/items.js). */
function supplyPerRation() {
  const k = Items.rations?.supply;
  return Number.isFinite(k) && k > 0 ? k : 1;
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
        deathRule: s.deathRule,
        pack: {
          brought: clone(s.pack.brought),
          found: clone(s.pack.found),
          rationsLeft: this.packOutcome('exit').rationsLeft,
        },
      };
    },

    /**
     * Put an item found on the hunt into the pack, where it is at risk until
     * the hunt ends (see the header). Stackables merge. This is the writer the
     * combat hookup (chunk 9) calls for drops; until then drops still go
     * straight to the bag.
     */
    addFound(inst) {
      if (s.finished || !isItemInstance(inst)) return false;
      addToList(s.pack.found, clone(inst));
      return true;
    },

    /**
     * What the pack holds now, and what an ending would do with it. Rations
     * left are the supplies still unspent — the camp issue eaten first —
     * capped at what was packed. Every other brought item is still whole.
     * Pure: changes nothing.
     */
    packOutcome(ending) {
      return settlePack({ pack: s.pack, supplies: s.supplies, deathRule: s.deathRule, ending });
    },

    /**
     * End the hunt: 'exit' (the party walked out) or 'wipe'. Settles the pack
     * through the world — what comes home is banked into the camp bag — and
     * returns packOutcome(). Only the first call does anything; after that it
     * returns null, so a pack can never be banked twice.
     */
    finish(ending) {
      if (s.finished) return null;
      const out = this.packOutcome(ending);
      s.finished = ending;
      if (out.home.brought.length) world.bankItems(out.home.brought, { found: false });
      if (out.home.found.length) world.bankItems(out.home.found, { found: true });
      return out;
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
  deathRule: null,
  pack: null,
});

// Which kind of hunt the holder has (chunk 8c, owner decision 1): 'map' for a
// hunt on the hex map (HuntEngine.js), 'advance' for the old Advance hunt,
// which only old saves can still hold (no new one is ever started from the
// Hunt screen). Every Advance-only method below does nothing for a map hunt;
// the map scene acts on current() directly.
let _mode = null;

export const HuntManager = {
  /** The live hunt instance, or null. */
  current() {
    return _current;
  },

  /** 'map', 'advance', or null with no hunt. */
  mode() {
    return _current ? _mode : null;
  },

  isActive() {
    return _current !== null;
  },

  hasPendingEncounter() {
    return _mode === 'advance' && !!_current?.hasPendingEncounter();
  },

  /**
   * Start a hunt on the hex map (HuntEngine.createMapHunt), in the real game's
   * world. `plan` is planMapInputs(huntPlanView(inst)) plus its itemLevel.
   */
  startMap(zoneId, { plan, supplies, bring = [], seed } = {}) {
    const opts = { plan, supplies, bring };
    if (seed !== undefined) opts.seed = seed;
    _current = createMapHunt(zoneId, opts, GAME_WORLD);
    _mode = 'map';
    return _current;
  },

  /**
   * A map hunt is over (it exited or wiped; the engine already banked the
   * pack and paid the reward). Drop it, so the save no longer holds it.
   */
  clearFinished() {
    if (_mode === 'map' && _current?.view().finished) { _current = null; _mode = null; return true; }
    return false;
  },

  /**
   * @param {string} zoneId
   * @param {{ supplies?: number, huntPlanModifiers?: object, seed?: number }} opts
   */
  start(zoneId, opts = {}) {
    _current = createHunt(zoneId, opts);
    _mode = 'advance';
  },

  advance() {
    return _mode === 'advance' && _current ? _current.advance() : null;
  },

  resolveEncounter(outcome) {
    return _mode === 'advance' && _current ? _current.resolveEncounter(outcome) : null;
  },

  engagePending() {
    return _mode === 'advance' && _current ? _current.engagePending() : false;
  },

  resolveCombatEncounter(result) {
    return _mode === 'advance' && _current ? _current.resolveCombatEncounter(result) : null;
  },

  /** The Advance hunt's state. A map hunt reports idle here: its scene reads
   *  view(), and nothing that reads this (CombatScene's hunt modifiers) can
   *  run during a map hunt before chunk 9. */
  getState() {
    return _mode === 'advance' && _current ? _current.getState() : { ...IDLE_STATE, log: [] };
  },

  addFound(inst) {
    return _mode === 'advance' && _current ? _current.addFound(inst) : false;
  },

  /**
   * The party left the map. Banks the pack and ends the hunt; returns the
   * pack outcome (see finish in makeHunt). Autosave straight after.
   */
  exit() {
    if (_mode !== 'advance') return null;   // a map hunt exits through its own exit()
    const out = _current ? _current.finish('exit') : null;
    _current = null;
    _mode = null;
    return out;
  },

  /** The party wiped. The pack comes home or is lost by the region's death rule. */
  wipe() {
    const out = !_current ? null : _mode === 'map' ? _current.wipe() : _current.finish('wipe');
    _current = null;
    _mode = null;
    return out;
  },

  /**
   * Drops the hunt from memory WITHOUT settling the pack. For leaving to the
   * main menu, where the save still holds the hunt and a reload resumes it.
   * A hunt that is over ends through exit() or wipe(), never this.
   */
  end() {
    _current = null;
    _mode = null;
  },
};

// The save reaches the live hunt through these hooks. GameState cannot import
// this file (it imports GameState), so HuntManager hands itself over instead.
// A saved hunt that cannot be restored is dropped with an error rather than
// failing the whole load: losing a hunt is recoverable, losing a save is not.
GameState.attachHunt({
  // A map hunt is saved with `mode: 'map'` beside HuntEngine's own shape; an
  // Advance hunt is saved as it always was, with no mode (SAVE_VERSION 7).
  serialize: () => (!_current ? null : _mode === 'map' ? { mode: 'map', ..._current.serialize() } : _current.serialize()),
  restore: (data) => {
    _current = null;
    _mode = null;
    if (!data) return;
    try {
      if (data.mode === 'map') {
        const { mode, ...rest } = data;
        _current = restoreMapHunt(rest, GAME_WORLD);
        _mode = 'map';
      } else if (data.mode === undefined) {
        _current = restoreHunt(data);
        _mode = 'advance';
      } else {
        throw new Error(`unknown hunt mode '${data.mode}'`);
      }
    } catch (e) {
      console.error(`[HuntManager] The saved hunt could not be restored and was dropped: ${e.message}`);
    }
  },
});
