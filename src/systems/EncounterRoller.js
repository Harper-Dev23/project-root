// src/systems/EncounterRoller.js
// Resolves a single roll for HuntManager's tick loop, two stages deep:
//
//   1. ~50/50 'encounter' (a fight) vs 'event' (choice/check/puzzle — see
//      EventResolver.js and HuntEncounterOverlay.js for how these resolve).
//   2. Within an 'encounter', 'beast' vs 'cultist' — biased toward beast by
//      `beastChanceWeight` (from combined Hunt Plan/zone/weather modifiers).
//      Within an 'event', a category (environmental/microZone/flexible) and
//      one of its entries — filtered by isNight against any nightOnly/dayOnly
//      tag on that entry (see data/zones.js).
//
// Fights route to CombatScene via the scenarioId below — see
// data/combatScenarios.js (hunt_beast_solo / hunt_cultist_solo, plus
// variants) and data/enemyTypes.js. All placeholders — no real Hunt enemy
// roster exists yet.

import { getZone } from '../../data/zones.js';

const ENCOUNTER_CHANCE = 0.5; // 'encounter' (fight) vs 'event'

const FIGHT_SCENARIOS = {
  beast: ['hunt_beast_solo', 'hunt_beast_marked'],
  cultist: ['hunt_cultist_solo', 'hunt_cultist_acolyte'],
};

const EVENT_CATEGORIES = ['environmental', 'microZone', 'flexible'];

// TEMP — testing aid for the dice-token/check flow. When true, any 'event'
// roll that has at least one 'check'-kind candidate available will always
// pick from those, skipping choice/puzzle entirely, so check events show up
// far more often without grinding through many Advances. Set back to false
// (or delete this block) once you're done testing.
const DEV_PRIORITIZE_CHECK_EVENTS = true;

function pickEntry(entries) {
  return entries[Math.floor(Math.random() * entries.length)];
}

function availableNow(entry, isNight) {
  if (entry.nightOnly && !isNight) return false;
  if (entry.dayOnly && isNight) return false;
  return true;
}

export const EncounterRoller = {
  /**
   * Rolls one Hunt turn result for the given zone. Depth is accepted for
   * future weighting (deeper = rarer categories more likely) but isn't used
   * yet. Returns null if the zone has nothing rollable right now.
   */
  roll(zoneId, _depth = 0, beastChanceWeight = 0, isNight = false) {
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
      const scenarioPool = FIGHT_SCENARIOS[type];

      return {
        kind: 'encounter',
        type,
        source: zoneId,
        label: entry?.label || 'Something stirs nearby.',
        scenarioId: pickEntry(scenarioPool),
      };
    }

    // ── Event (no fight): choice/check/puzzle, picked from the zone's table ──
    const candidates = [];
    for (const category of EVENT_CATEGORIES) {
      for (const entry of table[category] || []) {
        if (availableNow(entry, isNight)) candidates.push({ category, entry });
      }
    }
    if (candidates.length === 0) return null;

    let pool = candidates;
    if (DEV_PRIORITIZE_CHECK_EVENTS) {
      const checksOnly = candidates.filter(c => c.entry.kind === 'check');
      if (checksOnly.length > 0) pool = checksOnly;
    }

    const { category, entry } = pickEntry(pool);

    return {
      kind: 'event',
      type: category,
      source: zoneId,
      label: entry.label,
      eventDef: entry,
    };
  },
};
