// tribeSystems.js
// Teaser/placeholder data for the Tribe Relations systems — what a tribe
// actually DOES for (or against) you as your standing and intel with them
// change. Names, gates and flavor only; NONE of these systems are
// implemented yet. Consumed purely as read-only display data by
// TribeRelationsOverlay.
//
// Two independent tracks are modeled here, deliberately kept separate:
//
//   REP  (TribeRelations.js, already real)  — diplomatic standing, 0-6.
//         Drives how a tribe TREATS you: access, prices, quests, whether
//         they'll help you at all.
//
//   INTEL (mocked here, not yet real)       — what you KNOW about a tribe.
//         Gathered per-tribe, independent of whether they like you. Drives
//         what you can SEE and TARGET: their hunting parties, their stash,
//         and (from your own tribe) shrines, routes and prophet readings.
//
// The design intent worth preserving: rep is how they treat you, intel is
// what you can act on. High rep + low intel = a friendly tribe you can't
// exploit. Low rep + high intel = a hostile tribe you can raid precisely.
// The payoff of both together is that hunts stop being random survival and
// become targetable — you can farm a specific item, shrine, or party.
//
// `unlockIndex` values index the same 0-6 rep scale TribeRelations.js uses
// (3 = Neutral/Initiate, the default starting band).

// ── Pillars ───────────────────────────────────────────────────────────────
// What your tribe provides, gated by standing. `scope` marks whether a
// pillar is meaningful for your own (home) tribe, other tribes, or both —
// the overlay uses it to avoid promising home-tribe services from a rival.

export const TRIBE_PILLARS = [
  {
    id: 'stores',
    name: 'Stores & Supplies',
    icon: '📦',
    unlockIndex: 3,
    scope: 'own',
    summary: 'Draw from and contribute to the tribe stores.',
    detail: 'Healing supplies, rations and hunt consumables are pooled. What you '
      + 'donate raises favor; what the stores hold determines how well-provisioned '
      + 'you start a hunt.',
  },
  {
    id: 'vendor',
    name: 'Tribe Market',
    icon: '⚖️',
    unlockIndex: 3,
    scope: 'both',
    summary: 'Trade access, with prices set by your standing.',
    detail: 'Standing sets both discount and shelf. Higher rep opens stock a '
      + 'Neutral outsider never sees — and, eventually, the option to trade for '
      + 'specific high-value pieces rather than whatever happens to be out.',
  },
  {
    id: 'quests',
    name: 'Tribe Contracts',
    icon: '📜',
    unlockIndex: 4,
    scope: 'both',
    summary: 'Work the tribe only offers to people it trusts.',
    detail: 'Beyond the leader trials — standing contracts that carry real reward '
      + 'and steer the story. The important work goes to Members and above; '
      + 'Initiates get errands.',
  },
  {
    id: 'maps',
    name: 'Maps & Scouting',
    icon: '🗺️',
    unlockIndex: 4,
    scope: 'own',
    summary: 'Hunting grounds your tribe has already charted.',
    detail: 'Access to regions the tribe has scouted, and the scouting reports that '
      + 'come with them. Unmapped ground can still be hunted — you just go in blind.',
  },
  {
    id: 'routes',
    name: 'Routes & Shortcuts',
    icon: '🧭',
    unlockIndex: 5,
    scope: 'own',
    summary: 'Move through a hunt faster and safer.',
    detail: 'Trusted hunters are shown the paths the tribe keeps to itself — '
      + 'shortcuts that skip encounters, and fallbacks that let you leave a hunt '
      + 'without losing everything you carried into it.',
  },
  {
    id: 'support',
    name: 'Hunt Support',
    icon: '🤝',
    unlockIndex: 5,
    scope: 'own',
    summary: 'The tribe sends help into the field.',
    detail: 'Relief parties, resupply drops and covering fire. The tribe spends real '
      + 'resources on hunters it values, and does not spend them on strangers.',
  },
  {
    id: 'prophet',
    name: 'Prophet Readings',
    icon: '🔮',
    unlockIndex: 6,
    scope: 'own',
    summary: 'Turn a random hunt into a chosen one.',
    detail: 'The deepest privilege of a home tribe. A reading names what waits out '
      + 'there before you go — letting you hunt a specific quarry, a specific '
      + 'shrine, or a specific prize instead of taking what the wilds give you.',
  },
];

// ── Intel track ───────────────────────────────────────────────────────────
// Gathered per-tribe and independent of rep. Modeled as 0-4 so it reads as
// a shorter, sharper track than the 7-step rep ladder.

export const INTEL_MAX = 4;

export const INTEL_TIERS = [
  {
    level: 0,
    name: 'No Contacts',
    color: '#666666',
    summary: 'You know only what anyone in camp knows.',
    unlocks: [],
  },
  {
    level: 1,
    name: 'Loose Talk',
    color: '#aaaaaa',
    summary: 'Rumors, half-heard plans, names worth remembering.',
    unlocks: [
      'See roughly when this tribe has parties in the field',
      'Identify which regions they favor',
    ],
  },
  {
    level: 2,
    name: 'Watched',
    color: '#88aaff',
    summary: 'You can predict their movements well enough to act on them.',
    unlocks: [
      'Track named hunting parties to a specific hunt',
      'Ambush a rival party in the field',
      'Points of interest they have charted appear on your map',
    ],
  },
  {
    level: 3,
    name: 'Infiltrated',
    color: '#88ffaa',
    summary: 'Someone inside talks to you.',
    unlocks: [
      'Inspect the contents of their stash before committing',
      'Shrine locations and hidden sites they have found',
      'Open specific-item trade offers instead of browsing stock',
    ],
  },
  {
    level: 4,
    name: 'Compromised',
    color: '#ffdd44',
    summary: 'You know their business better than most of their own hunters.',
    unlocks: [
      'Target a named piece of their gear and hunt the party carrying it',
      'Read their supply lines — intercept a resupply mid-hunt',
      'Full stash visibility, including what they are holding back',
    ],
  },
];

// ── Favor sources ─────────────────────────────────────────────────────────
// What moves the rep number. `sign` drives the +/− marker in the UI.

export const FAVOR_SOURCES = [
  { sign: '+', label: 'Complete a tribe contract or leader trial', weight: 'Major' },
  { sign: '+', label: 'Finish a hunt under the tribe\'s banner', weight: 'Moderate' },
  { sign: '+', label: 'Donate gear and supplies to the tribe stores', weight: 'Moderate' },
  { sign: '+', label: 'Bring back healing stock and rations', weight: 'Minor' },
  { sign: '+', label: 'Hand over intel gathered on a rival tribe', weight: 'Moderate' },
  { sign: '−', label: 'Trade heavily with a rival tribe', weight: 'Minor' },
  { sign: '−', label: 'Ambush or raid a party from this tribe', weight: 'Major' },
  { sign: '−', label: 'Abandon a contract once accepted', weight: 'Major' },
];

// ── Per-tribe character ───────────────────────────────────────────────────
// Flavor + what each tribe is actually good at, so the four cards read as
// four different offers rather than one offer with four names.

// Epithets and values are the CANON ones from the Player Handbook and the
// journal's Four Tribes entry — not the specialities of whoever currently
// speaks for each tribe. (An earlier pass labelled Elseth "the Animancers"
// and Styx "the Tacticians" after Wren and Cade; those are individuals, not
// the tribe's identity. `figure` keeps the leader, `epithet` keeps the tribe.)
export const TRIBE_SPECIALTIES = {
  elseth: {
    epithet: 'Silk and Ledger',
    figure: 'Wren, Animancer',
    focus: 'Wealth, diplomacy, knowledge and binding pacts',
    offer: 'Trade and oath-making — sacred commerce drawn from ancient '
      + 'dealings with dragonkind.',
  },
  styx: {
    epithet: 'Beasts and Bone',
    figure: 'Cade, Tactician',
    focus: 'Simplicity, beast-communion, memory and instinct',
    offer: 'Beast-talkers and spirit listeners — humble, strange, and the '
      + 'closest of the four to the wild itself.',
  },
  lesse: {
    epithet: 'Bloom and Veil',
    figure: 'Ember & Rime',
    focus: 'Grace, artistry, sacred growth and subtle power',
    offer: 'Enchanters and keepers of memory, said to share distant blood '
      + 'with the ancient elves.',
  },
  zafaar: {
    epithet: 'Ash and Fang',
    figure: "Gorrek's kin",
    focus: 'Strength, fury and honor in conquest',
    offer: 'The bold, the wrathful and the unbroken — everything measured by '
      + 'what you can carry off the field.',
  },
};
