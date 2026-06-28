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
// Session-only: this state is NOT persisted across a save/reload. Starting a
// hunt then reloading the game drops the player back in Town — a deliberate
// v1 simplification (see the Exploration & Hunt System plan).

import { EncounterRoller } from './EncounterRoller.js';
import ProgressionManager from './ProgressionManager.js';

const SUPPLY_DRAIN_PER_ADVANCE = 4;
const DAY_NIGHT_ADVANCES        = 6;     // advances before day/night flips
const BASE_ENCOUNTER_CHANCE     = 0.15;
const DEPTH_CHANCE_MULTIPLIER   = 0.01;
const MAX_ENCOUNTER_CHANCE      = 0.6;
const LOG_LIMIT                 = 50;

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

export const HuntManager = {
  isActive() {
    return _zoneId !== null;
  },

  hasPendingEncounter() {
    return _pendingEncounter !== null;
  },

  start(zoneId, { supplies = 100 } = {}) {
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
  },

  /**
   * Advances the hunt by one turn: drains supplies, advances depth, flips
   * day/night on a threshold, and rolls an encounter chance based on depth.
   * Refuses to advance while a previous encounter is still pending — the
   * player must Investigate it first.
   *
   * Returns a state snapshot; `ended` is true once supplies hit 0 (the
   * caller should still let any pending encounter resolve before finalizing).
   */
  advance() {
    if (!this.isActive() || this.hasPendingEncounter()) return null;

    _supplies = Math.max(0, _supplies - SUPPLY_DRAIN_PER_ADVANCE);
    _depth += 1;
    _advancesSinceFlip += 1;

    if (_advancesSinceFlip >= DAY_NIGHT_ADVANCES) {
      _advancesSinceFlip = 0;
      _isNight = !_isNight;
      if (!_isNight) _day += 1;
    }

    const chance = Math.min(MAX_ENCOUNTER_CHANCE, BASE_ENCOUNTER_CHANCE + _depth * DEPTH_CHANCE_MULTIPLIER);

    if (Math.random() < chance) {
      _pendingEncounter = EncounterRoller.roll(_zoneId, _depth);
    }

    return {
      ...this.getState(),
      ended: _supplies <= 0,
    };
  },

  /**
   * Resolves the pending encounter: awards its Hunt Points, appends it to
   * the permanent log, and clears the pending flag so advance() unblocks.
   * Returns the resolved encounter (or null if nothing was pending).
   */
  resolveEncounter() {
    if (!_pendingEncounter) return null;

    const resolved = _pendingEncounter;
    _pendingEncounter = null;

    _sessionHuntPoints += resolved.huntPoints;
    ProgressionManager.addHuntPoints(resolved.huntPoints);
    _log.push(resolved);
    if (_log.length > LOG_LIMIT) _log.shift();

    return resolved;
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
  },
};
