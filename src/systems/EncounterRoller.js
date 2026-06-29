// src/systems/EncounterRoller.js
// Resolves a single roll for HuntManager's tick loop, two stages deep:
//
//   1. ~50/50 'encounter' (a fight) vs 'event' (today's flavor-text stub).
//   2. Within an 'encounter', 'beast' vs 'cultist' — biased toward beast by
//      `beastChanceWeight` (from combined Hunt Plan/zone/weather modifiers).
//      Within an 'event', a flavor-text category with a small Hunt Points
//      award, same as before (just without the 'beasts' category, since
//      beasts are now always real fights).
//
// Fights route to CombatScene via the scenarioId below — see
// data/combatScenarios.js (hunt_beast_solo / hunt_cultist_solo) and
// data/enemyTypes.js (hunt_beast_lesser / hunt_cultist_lesser). Both are
// placeholders — no real Hunt enemy roster exists yet.

import { getZone } from '../../data/zones.js';

const ENCOUNTER_CHANCE = 0.5; // 'encounter' (fight) vs 'event' (flavor-only)

const FIGHT_SCENARIOS = {
  beast: 'hunt_beast_solo',
  cultist: 'hunt_cultist_solo',
};

// Stub Hunt Points awarded per 'event' flavor category. Fights (beast/cultist)
// are NOT here — their rewards come from actually winning the fight.
const HUNT_POINTS_BY_EVENT_CATEGORY = {
  environmental: 1,
  microZone: 2,
  flexible: 1,
};

const EVENT_CATEGORIES = Object.keys(HUNT_POINTS_BY_EVENT_CATEGORY);

function pickEntry(entries) {
  return entries[Math.floor(Math.random() * entries.length)];
}

export const EncounterRoller = {
  /**
   * Rolls one Hunt turn result for the given zone. Depth is accepted for
   * future weighting (deeper = rarer categories more likely) but isn't used
   * yet. Returns null if the zone has nothing to roll.
   */
  roll(zoneId, _depth = 0, beastChanceWeight = 0) {
    const zone = getZone(zoneId);
    if (!zone) return null;

    const table = zone.encounterTable || {};

    if (Math.random() < ENCOUNTER_CHANCE) {
      // ── Encounter (fight): beast vs cultist ──────────────────────────────
      const beastWeight = 1 + Math.max(0, beastChanceWeight);
      const isBeast = Math.random() * (beastWeight + 1) < beastWeight;
      const type = isBeast ? 'beast' : 'cultist';

      const flavorPool = table[type === 'beast' ? 'beasts' : 'cultists'] || [];
      const entry = flavorPool.length > 0 ? pickEntry(flavorPool) : null;

      return {
        kind: 'encounter',
        type,
        source: zoneId,
        label: entry?.label || 'Something stirs nearby.',
        scenarioId: FIGHT_SCENARIOS[type],
      };
    }

    // ── Event (no fight): flavor text + a small Hunt Points award ──────────
    const nonEmptyCategories = EVENT_CATEGORIES.filter(cat => (table[cat] || []).length > 0);
    if (nonEmptyCategories.length === 0) return null;

    const category = pickEntry(nonEmptyCategories);
    const entry = pickEntry(table[category]);

    return {
      kind: 'event',
      type: category,
      source: zoneId,
      label: entry.label,
      huntPoints: HUNT_POINTS_BY_EVENT_CATEGORY[category],
    };
  },
};
