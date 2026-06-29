// src/systems/TribeHuntSimulator.js
// Background tribe progress — ticks once per in-game Hunt day, not per real
// time and not per player click. Called from HuntManager.advance() only on
// the turn where the day counter actually increments (night → day flip), so
// other tribes move at a much coarser grain than the player's own turns —
// not on a wall-clock timer, and not locked to whether the player happens to
// be hunting on any given visit either.
//
// The player's own tribe's `isPlayerSlot` party is the one exception — its
// points come directly from HuntManager.resolveEncounter(), never from here.

import { TRIBE_IDS } from './TribeRelations.js';
import { getPartiesForTribe } from '../../data/tribeHuntingParties.js';
import ProgressionManager from './ProgressionManager.js';

// Only ~2-3 ticks happen across a whole hunt (once per in-game day), versus
// the player rolling an encounter chance on every single advance — so each
// tick needs to carry real weight, not a small chance of a small amount.
// Tuned so a tier-2 party roughly keeps pace with a player's own per-hunt
// total over the same 2-3 day span; higher tiers (the Leader's party is
// tier 5) noticeably outpace it, which is the point.
const PARTY_ROLL_MIN = 4;
const PARTY_ROLL_MAX = 10;

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export const TribeHuntSimulator = {
  /** Call once per in-game Hunt day that passes (see HuntManager.advance()). */
  tick() {
    const playerTribe = ProgressionManager.getTribe();

    for (const tribeId of TRIBE_IDS) {
      for (const party of getPartiesForTribe(tribeId)) {
        if (tribeId === playerTribe && party.isPlayerSlot) continue; // player drives this one directly

        const amount = randInt(PARTY_ROLL_MIN, PARTY_ROLL_MAX) * party.tier;
        ProgressionManager.addPartyPoints(tribeId, party.id, amount);
      }
    }
  },
};
