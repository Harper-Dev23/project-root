// data/tribeHuntingParties.js
// Static placeholder roster of hunting parties per tribe — 6 slots total.
// No canon names exist for these yet, so they're generic/numbered for now —
// easy to swap for real flavor later without touching any of the tracking
// logic that reads this file (ProgressionManager / TribeHuntSimulator /
// TribeHQOverlay all key off `id`, not name).
//
// Slot 0 is reserved for whichever tribe the player belongs to — when
// TribeHuntSimulator sees `isPlayerSlot` on the player's own tribe, it skips
// simulating that party (the player drives its points directly via
// HuntManager.resolveEncounter instead). For every OTHER tribe, that same
// slot is just another simulated NPC party — every tribe runs a symmetric
// 6-party roster so totals stay roughly even.

import { TRIBE_IDS, TRIBE_DISPLAY } from '../src/systems/TribeRelations.js';

const TIERS = [1, 2, 2, 3, 4];

function buildRosterForTribe(tribeId) {
  const tribeName = TRIBE_DISPLAY[tribeId];
  const roster = TIERS.map((tier, i) => ({
    id: `${tribeId}_party_${i + 1}`,
    name: `${tribeName} Hunting Party ${i + 1}`,
    tier,
    isPlayerSlot: i === 0,
  }));

  roster.push({
    id: `${tribeId}_party_leader`,
    name: `${tribeName} Leader's Hunting Party`,
    tier: 5,
    isLeaderParty: true,
  });

  return roster;
}

export const TRIBE_HUNTING_PARTIES = Object.fromEntries(
  TRIBE_IDS.map(tribeId => [tribeId, buildRosterForTribe(tribeId)])
);

export function getPartiesForTribe(tribeId) {
  return TRIBE_HUNTING_PARTIES[tribeId] || [];
}

export function getPlayerPartyId(tribeId) {
  return getPartiesForTribe(tribeId).find(p => p.isPlayerSlot)?.id ?? null;
}
