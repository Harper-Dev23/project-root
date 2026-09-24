// data/boons.js
//
// Prophet boons during a hunt (Exploration System v2, chunk 10b; design in the
// vault's STANDING note, content signed off by the owner 2026-09-24 as drafted
// in IMPLEMENTATION_PLAN "10b"). Logic lives in src/systems/Boons.js. Every
// number here is a placeholder until chunk 13.
//
// A boon belongs to the hunt: favor with the region's house fills toward
// levels 1-5, and resets when the hunt ends. Levels are cumulative, so level
// 3 carries levels 1 and 2. Level 5 is reachable only in the lands of the
// house your tribe follows.
//
// Each level may carry:
//   party    status mods put on every standing hunter at the start of a fight
//            (keys summed by CombatLogic._sumStatusEffectMods)
//   enemies  status mods put on every enemy at the start of a fight
//   explore  hunt-bundle fields added in HuntRules.momentMods and read by
//            partyStats (supplyEfficiencyPercent, travelTimePercent,
//            partyInitiativeBonus) or by its passive fields (sightRangeBonus)
//   capstone a signature mechanic CombatScene runs for the whole fight
// A later level's value for the same key REPLACES an earlier one (so "rises
// to +15" is written as 15), and a level's text says what it adds.
//
// Readers:
//   FAVOR_BY_GRADE, SHRINE_FAVOR,   Boons.killFavor / HuntEngine (winEncounter,
//   FOLLOWED_FAVOR_PERCENT          _arrive): favor earned
//   BOON_THRESHOLDS, UNFOLLOWED_MAX Boons.levelFor
//   BOONS                           Boons.boonEffects -> HuntEngine.stats
//                                   (explore), fightSpec (party, enemies,
//                                   capstone) -> CombatScene._applyHuntFightStart,
//                                   _checkFinalMercy, the echo roll

/** Favor per marked beast killed, by its grade. A pack pays for every member. */
export const FAVOR_BY_GRADE = { yearling: 1, grown: 2, prime: 3, great: 5 };
/** Reaching the region's shrine (a Commune plan's site), once per hunt. */
export const SHRINE_FAVOR = 5;
/** Favor comes this much faster in the lands of the house your tribe follows. */
export const FOLLOWED_FAVOR_PERCENT = 25;

/**
 * Favor needed for each level. Measured 2026-09-24 on 1,200 generated maps
 * (both zones, 200 seeds, per size): the favor of every marked beast on a map
 * has a median of 11 (Small), 22 (Medium), 33 (Large); one marked pack is
 * worth ~8. So one marked pack reaches 1, clearing the marked beasts of a
 * Small / Medium / Large map reaches 2 / 3 / 4, and 5 needs a big Large map in
 * your own house's lands (33 x 1.25 = ~41).
 */
export const BOON_THRESHOLDS = [5, 10, 20, 30, 40];
/** The highest level outside your followed house's lands (STANDING). */
export const UNFOLLOWED_MAX = 4;

export const BOONS = {
  jeremiah: {
    title: 'The Silent Tortoise',
    levels: [
      { name: 'Shell of Sorrow', text: '+10 Physical, Elemental and Necrotic Resist on every hunter.',
        party: { PhysicalResist: 10, ElementalResist: 10, NecroticResist: 10 } },
      { name: 'Never Halts', text: 'Moves cost 15% fewer supplies.',
        explore: { supplyEfficiencyPercent: 15 } },
      { name: 'Rust in Their Hands', text: 'Enemies deal 10% less damage. Resists rise to +15.',
        party: { PhysicalResist: 15, ElementalResist: 15, NecroticResist: 15 }, enemies: { AttackPower: -10 } },
      { name: 'The Mourning Flight', text: '+1 sight range.',
        explore: { sightRangeBonus: 1 } },
      { name: 'Final Mercy', text: 'Once per fight, when a hunter is knocked out, every standing hunter heals 20% of their max HP.',
        capstone: { id: 'final_mercy', healPercent: 20 } },
    ],
  },
  ezekiel: {
    title: 'The Patterned Visionary',
    levels: [
      { name: 'Sacred Geometry', text: '+10 Accuracy.',
        party: { Accuracy: 10 } },
      { name: 'Tilting Thresholds', text: 'Moves take 15% less time.',
        explore: { travelTimePercent: 15 } },
      { name: 'The Pattern Repeats', text: '+10 Crit Chance and +0.25 Crit Multiplier. Accuracy rises to +15.',
        party: { Accuracy: 15, CritChance: 10, CritMult: 0.25 } },
      { name: 'Déjà Vu', text: '+10 party initiative.',
        explore: { partyInitiativeBonus: 10 } },
      { name: 'The Loop', text: "Every hunter's attacks have a 20% chance to echo.",
        capstone: { id: 'the_loop', echoChance: 0.2 } },
    ],
  },
};
