// data/falseGods.js
//
// False gods' pact boons (Exploration System v2, chunk 11c; design in the
// vault's STANDING and EVENTS notes, content signed off by the owner
// 2026-09-24 as drafted in IMPLEMENTATION_PLAN "11c"). Logic: Boons.pactEffects
// and HuntEngine's pact step (the `falseGod` verb with { pact: true }).
//
// A pact starts at PACT_START when a temptation is accepted, and each later
// temptation in the same hunt raises it by one, to PACT_MAX. The prophet's
// boon ends for that hunt. Levels are cumulative (4 carries 3); unlike a
// prophet's boon, values of the same key ADD, and the curse adds its per-level
// amount times the pact level.
//
// Each step's price (PACT_PRICE), paid by the engine:
//   hidden   hidden false-god standing + hiddenPerLevel x the level reached
//   bond     Bond standing with the region's house - bondPerLevel x the level
//   curse    this god's curse, for the rest of the hunt, at the pact's level
//
// Readers:
//   FALSE_GODS[god].levels   Boons.pactEffects -> HuntEngine.stats (explore),
//                            _boonForFight (party, enemies, capstone)
//   FALSE_GODS[god].curse    Boons.pactEffects (x pact level)
//   PACT_START, PACT_MAX,    HuntEngine._pactStep
//   PACT_PRICE
//   zones' falseGod          HuntEngine roles ({falsegod}) and _pactStep

export const PACT_START = 3;
export const PACT_MAX = 5;
export const PACT_PRICE = { hiddenPerLevel: 1, bondPerLevel: 5 };

export const FALSE_GODS = {
  dagon: {
    name: 'Dagon',
    title: 'The River Lurker',
    levels: {
      3: { name: 'The Offered Breath', text: '+10 life steal on every hunter; forage and harvest yield +30%.',
        party: { LifeStealPct: 10 }, explore: { harvestYieldPercent: 30 } },
      4: { name: 'The Still Water', text: '+15 Physical Resist; moves cost 20% fewer supplies.',
        party: { PhysicalResist: 15 }, explore: { supplyEfficiencyPercent: 20 } },
      5: { name: 'What Waits Below', text: 'A hunter who lands a killing blow heals 15% of their max HP.',
        capstone: { id: 'what_waits_below', healPercent: 15 } },
    },
    curse: { name: 'The River Never Sated', text: 'Moves cost 10% more supplies per pact level.',
      explore: { supplyEfficiencyPercent: -10 } },
  },
  yargaleth: {
    name: "Yar'galeth",
    title: 'The Submerged Mouth',
    levels: {
      3: { name: 'Answers Unasked', text: '+2 sight range; +10 Crit Chance.',
        party: { CritChance: 10 }, explore: { sightRangeBonus: 2 } },
      4: { name: 'The Undertow', text: 'Enemies -10 Evasion; +10 party initiative.',
        enemies: { Evasion: -10 }, explore: { partyInitiativeBonus: 10 } },
      5: { name: 'The Word That Is Always True', text: "Each hunter's first attack in a fight cannot miss, and crits.",
        capstone: { id: 'the_true_word' } },
    },
    curse: { name: 'Orphaned Revelation', text: '-5 Accuracy per pact level on every hunter.',
      party: { Accuracy: -5 } },
  },
};
