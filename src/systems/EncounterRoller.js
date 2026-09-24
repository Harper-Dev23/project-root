// src/systems/EncounterRoller.js
// Resolves a single roll for the old Advance loop's tick (HuntManager.createHunt),
// which only old saves still run (the hex map replaced it in chunk 8):
//
//   1. ~50/50 a fight, or a quiet turn. The other half used to be an event
//      (choice/check/puzzle); the Advance loop's events were retired in chunk
//      11a (owner, 2026-09-24) when events moved to data/events.js for hunts
//      on the map. The same rng draw is kept, so a quiet turn costs the same.
//   2. Within a fight, 'beast' vs 'cultist' — biased toward beast by
//      `beastChanceWeight` (from combined Hunt Plan/zone/weather modifiers).
//
// Fights route to CombatScene via the scenarioId below — see
// data/combatScenarios.js (hunt_beast_solo / hunt_cultist_solo, plus
// variants) and data/enemyTypes.js.

import { getZone } from '../../data/zones.js';

const ENCOUNTER_CHANCE = 0.5; // a fight vs a quiet turn

const FIGHT_SCENARIOS = {
  beast: ['hunt_beast_solo', 'hunt_beast_marked'],
  cultist: ['hunt_cultist_solo', 'hunt_cultist_acolyte'],
};

function pickEntry(entries, rng = Math.random) {
  return entries[Math.floor(rng() * entries.length)];
}

export const EncounterRoller = {
  /**
   * Rolls one Advance turn for the given zone: a fight, or null (nothing
   * happens). `isNight` is kept in the signature for the callers.
   *
   * `rng` is the hunt's own seeded stream (see createHunt in HuntManager.js),
   * so a saved hunt rolls the same thing after a reload. Defaults to
   * Math.random for any caller without one.
   */
  roll(zoneId, _depth = 0, beastChanceWeight = 0, _isNight = false, rng = Math.random) {
    const zone = getZone(zoneId);
    if (!zone) return null;
    const table = zone.encounterTable || {};

    if (rng() >= ENCOUNTER_CHANCE) return null;
    const beastWeight = 1 + Math.max(0, beastChanceWeight);
    const isBeast = rng() * (beastWeight + 1) < beastWeight;
    const type = isBeast ? 'beast' : 'cultist';
    const flavorPool = table[type === 'beast' ? 'beasts' : 'cultists'] || [];
    const entry = flavorPool.length > 0 ? pickEntry(flavorPool, rng) : null;
    return {
      kind: 'encounter',
      type,
      source: zoneId,
      label: entry?.label || 'Something stirs nearby.',
      scenarioId: pickEntry(FIGHT_SCENARIOS[type], rng),
    };
  },
};
