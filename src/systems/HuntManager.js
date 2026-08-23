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
// are combined once at start() via HuntModifiers.combineModifiers() and read
// from for the rest of the hunt — none of the three sources change mid-hunt.
//
// Session-only: this state is NOT persisted across a save/reload. Starting a
// hunt then reloading the game drops the player back in Town — a deliberate
// v1 simplification (see the Exploration & Hunt System plan).

import { EncounterRoller } from './EncounterRoller.js';
import { TribeHuntSimulator } from './TribeHuntSimulator.js';
import { getPlayerPartyId } from '../../data/tribeHuntingParties.js';
import { combineModifiers } from './HuntModifiers.js';
import { rollWeather } from '../../data/weather.js';
import { getZone } from '../../data/zones.js';
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

let _zoneId = null;
let _supplies = 0;
let _maxSupplies = 0;
let _day = 1;
let _isNight = false;
let _depth = 0;
let _advancesSinceFlip = 0;
let _sessionHuntPoints = 0;
let _log = [];
let _pendingEncounter = null;
let _weather = null;
let _combinedModifiers = null;

export const HuntManager = {
  isActive() {
    return _zoneId !== null;
  },

  hasPendingEncounter() {
    return _pendingEncounter !== null;
  },

  /**
   * @param {string} zoneId
   * @param {{ supplies?: number, huntPlanModifiers?: object }} opts
   */
  start(zoneId, { supplies = 100, huntPlanModifiers = null } = {}) {
    _zoneId = zoneId;
    _supplies = supplies;
    _maxSupplies = supplies;
    _day = 1;
    _isNight = false;
    _depth = 0;
    _advancesSinceFlip = 0;
    _sessionHuntPoints = 0;
    _log = [];
    _pendingEncounter = null;

    _weather = rollWeather();
    const zone = getZone(zoneId);
    _combinedModifiers = combineModifiers(zone?.modifiers, _weather.modifiers, huntPlanModifiers);
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
    if (!this.isActive() || this.hasPendingEncounter()) return null;

    const drain = Math.max(
      MIN_SUPPLY_DRAIN,
      SUPPLY_DRAIN_PER_ADVANCE * (1 - _combinedModifiers.supplyEfficiencyPercent / 100)
    );
    _supplies = Math.max(0, _supplies - drain);
    _depth += 1;
    _advancesSinceFlip += 1;

    if (_advancesSinceFlip >= DAY_NIGHT_ADVANCES) {
      _advancesSinceFlip = 0;
      _isNight = !_isNight;
      // Save-wide elapsed time. _day/_isNight above are per-hunt and reset
      // on end(); these accumulate for the life of the save so a future
      // hunt-season limit has a real clock to read.
      if (_isNight) {
        ProgressionManager.advanceNight();
      } else {
        _day += 1;
        ProgressionManager.advanceDay();
        // Other tribes' background progress ticks once per in-game day —
        // far coarser than the player's own per-advance turn.
        TribeHuntSimulator.tick();
      }
    }

    const chance = Math.min(
      MAX_ENCOUNTER_CHANCE,
      BASE_ENCOUNTER_CHANCE + _depth * DEPTH_CHANCE_MULTIPLIER + _combinedModifiers.encounterChancePercent / 100
    );

    if (Math.random() < chance) {
      _pendingEncounter = EncounterRoller.roll(_zoneId, _depth, _combinedModifiers.beastChanceWeight, _isNight);
    }

    return {
      ...this.getState(),
      ended: _supplies <= 0,
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
    if (!_pendingEncounter || _pendingEncounter.kind !== 'event' || !outcome) return null;

    const pending = _pendingEncounter;
    _pendingEncounter = null;

    const huntPoints = Math.round((outcome.huntPoints || 0) * (1 + _combinedModifiers.huntPointsPercent / 100));

    if (outcome.xp > 0) GameState.awardPartyXP(outcome.xp);
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
    const living = GameState.party.filter(c => c.status !== 'dead' && c.status !== 'incapacitated');
    if (living.length === 0) return;
    const target = living[Math.floor(Math.random() * living.length)];
    target.currentHP = Phaser.Math.Clamp(target.currentHP + amount, 1, target.maxHP);
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
    if (!_pendingEncounter || _pendingEncounter.kind !== 'encounter') return null;

    const pending = _pendingEncounter;
    _pendingEncounter = null;
    if (!won) return null;

    const huntPoints = type === 'beast'
      ? Math.round(BASE_BEAST_FIGHT_HUNT_POINTS * (1 + _combinedModifiers.huntPointsPercent / 100))
      : 0;

    const resolved = { ...pending, huntPoints };
    this._awardAndLog(resolved);
    return resolved;
  },

  /** Shared by resolveEncounter/resolveCombatEncounter — awards Hunt Points and logs the result. */
  _awardAndLog(resolved) {
    _sessionHuntPoints += resolved.huntPoints;
    ProgressionManager.addHuntPoints(resolved.huntPoints);
    if (ProgressionManager.tribe) {
      const playerPartyId = getPlayerPartyId(ProgressionManager.tribe);
      if (playerPartyId) ProgressionManager.addPartyPoints(ProgressionManager.tribe, playerPartyId, resolved.huntPoints);
    }
    _log.push(resolved);
    if (_log.length > LOG_LIMIT) _log.shift();
  },

  getState() {
    return {
      zoneId: _zoneId,
      supplies: _supplies,
      maxSupplies: _maxSupplies,
      day: _day,
      isNight: _isNight,
      depth: _depth,
      sessionHuntPoints: _sessionHuntPoints,
      log: [..._log],
      pendingEncounter: _pendingEncounter,
      weather: _weather,
      combinedModifiers: _combinedModifiers,
    };
  },

  end() {
    _zoneId = null;
    _supplies = 0;
    _maxSupplies = 0;
    _day = 1;
    _isNight = false;
    _depth = 0;
    _advancesSinceFlip = 0;
    _sessionHuntPoints = 0;
    _log = [];
    _pendingEncounter = null;
    _weather = null;
    _combinedModifiers = null;
  },
};
