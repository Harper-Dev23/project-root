// data/cultMarkets.js
//
// The cults' black markets (owner, 2026-09-27; vault CONTENT_INBOX "The cult
// economy"). One per cult of a false god, on the hunt map of the regions where
// that cult lives, never at camp (canon: false gods are reached through cults
// and black markets, never at Nehemiah). Everything is priced in Sin Tickets
// and paid from, and delivered to, the buyer's own save: the camp bag, not the
// hunt pack (a pack's finds are copied to every player on a co-op hunt).
//
// A market's screen has STALLS, like the vendor row: some shared by every cult
// (SHARED_STALLS), some a cult's own (`own`). Pools are data: adding goods, or a
// market for a god not built yet, is an entry here.
//
// Readers:
//   SHARED_STALLS, CULT_MARKETS   src/systems/Market.js (the view and buying)
//   CULT_MARKETS[c].unlockFlag,   src/systems/HuntQuests.js questSitesFor (a
//   .eventId, .zones, .pct        market site on that share of hunts, once open)

/** Stalls every cult's market has. Numbers are starting points, to tune. */
export const SHARED_STALLS = {
  gamble: {
    name: 'The Cult Gamble',
    kind: 'gamble',
    cost: 1,
    // Better odds than the bone pile (60 / 30 / 10) at the same one ticket;
    // Sin Tickets are harder to come by.
    rarity: { uncommon: 30, rare: 45, epic: 25 },
    // One armour piece in a hundred comes up Corrupted (ItemFactory
    // RENOWN_ORIGINS.corrupted), as one bone-pile weapon in a hundred is Bone.
    corruptedChance: 0.01,
  },
  tinctures: {
    name: 'Tinctures',
    kind: 'goods',
    goods: [
      { id: 'tincture_red_breath', cost: 2 },
      { id: 'tincture_deep_well', cost: 2 },
    ],
  },
};

export const CULT_MARKETS = {
  // The Drowned Choir (Yar'galeth): knowledge and vestments. Its gamble leans
  // to armour.
  yargaleth: {
    name: 'The Tithe-Boat',
    cult: 'The Drowned Choir',
    zones: ['reeds_of_gethsemane', 'bay_of_solace'],
    eventId: 'tithe_boat',
    unlockFlag: 'choir_market_open',
    pct: 40,
    gamble: { armorShare: 75 },
    stalls: ['gamble', 'tinctures'],
    own: null,
  },
  // The Temple of the Gill (Dagon): goods and bodies. Its gamble leans to
  // weapons, and it smuggles rare beast parts.
  dagon: {
    name: 'The Gill Market',
    cult: 'The Temple of the Gill',
    zones: ['reeds_of_gethsemane'],
    eventId: 'gill_market',
    unlockFlag: 'gill_market_open',
    pct: 40,
    gamble: { armorShare: 25 },
    stalls: ['gamble', 'tinctures'],
    own: {
      id: 'parts',
      name: 'Smuggled Parts',
      kind: 'part',
      cost: 3,
      // A random part of one of the region's native families, never below rare.
      rarityFloor: 'rare',
    },
  },
};
