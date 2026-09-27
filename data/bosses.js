// data/bosses.js
//
// Region bosses and the Omen meter (chunk 14b-3; vault IMPLEMENTATION_PLAN,
// "Bosses, omens and boss hunts", owner-approved 2026-09-26).
//
// Each region has one Omen meter. Anything done there fills it (OMEN_SOURCES,
// booked at a clean exit: HuntObjectives.exitReward -> world.omens). When it is
// full the player picks one of the region's UNLOCKED bosses and gets that
// boss's hunt plan item (Omens.claimBossPlan). A boss unlocks when its
// questline's last step is done (`unlockFlag`), which also gives the first
// plan free (Omens.takeFirstOffer).
//
// Readers:
//   OMEN_FULL, OMEN_BANK   src/systems/Omens.js (claim, the cap)
//   OMEN_SOURCES           HuntObjectives.exitReward (what a hunt books)
//   BOSSES                 Omens.js, HuntHubOverlay (the meter and the claim),
//                          HuntPlanPickerOverlay (a boss plan is its region's only),
//                          HuntMapGen boss_lair (the lair: `lair`, `fight`),
//                          HuntBeasts.fightScenario (`fight`), HuntEngine
//                          (the warning before the lair: `lair`)

/** Omens a boss hunt costs. Tuned by the hunt simulator (huntsim --omens):
 *  about two to three full hunts. */
export const OMEN_FULL = 100;

/** Full meters a region may bank once a boss there is unlocked (before one
 *  is, the meter stops at one full). Claimed plans are items and uncapped. */
export const OMEN_BANK = 3;

/** What a hunt books toward its region's meter. Objectives pay more than
 *  kills, so playing a hunt out beats grinding fights. */
export const OMEN_SOURCES = {
  primary: 30,   // the plan's primary objective done (clean exit)
  bonus: 10,     // each bonus objective done
  apex: 15,      // the region's apex killed (on top of its fight)
  fight: 3,      // each fight won (beasts and cult bands)
  event: 3,      // each event seen through (not walked away from)
};

/** A boss kill's Hunt Points, and its XP pool as a multiple of an ordinary
 *  fight's (HuntEngine FIGHT_XP_POOL). Read by HuntEngine.fightSpec/winEncounter. */
export const BOSS_HUNT_POINTS = 60;
export const BOSS_XP_MULT = 5;

/**
 * `plan` is the boss hunt plan item (data/items.js, `boss: <id>`); `unlockFlag`
 * is the quest flag that unlocks it (its questline's last step); `offerAfter`
 * is the flag that makes the tribe's first, free offer available (the step
 * before it).
 *
 * `lair` is what the map and the warning say. `fight` is the enemy side of the
 * board, member by member: an enemy type (data/enemyTypes.js), the board slot
 * it stands in (boardGeometry: 1-3 the front column, 2 its centre; 4-5 the
 * middle; 6-8 the back), a display name, and `pool`: members naming the same
 * pool share one HP pool (CombatScene._linkSharedPools); when it is empty the
 * whole boss collapses. `weapon`: the member's natural weapon (data/items.js,
 * `natural`, so it never drops or rolls), which its damage dice come from, as
 * a beast's come from its weaponMain part. `historic`: the Historic item in its lair's chest,
 * guaranteed while it is in the wild (owner, 2026-09-25); none while held.
 */
export const BOSSES = {
  mourning_beast: {
    name: 'The Mourning Beast',
    zone: 'reeds_of_gethsemane',
    plan: 'mourners_offering',
    unlockFlag: 'mb_offer_taken',
    offerAfter: 'mb_signs_found',
    historic: 'burden_of_dreams',
    lair: {
      name: "The Mourning Beast's Lair",
      text: 'A hollow beneath the Lament Pools, walled in burial cloth. The weeping comes from inside. This is a boss fight: camp and ready the party first if you need to.',
    },
    // Four parts (owner, 2026-09-25): the Head and Body share one pool (14b-4b),
    // the two Limbs are their own. Portraits are placeholders until the owner's
    // art lands (ART_ASSET_LIST: portrait_mourning_beast_head/body/limbs).
    fight: {
      name: 'The Mourning Beast',
      members: [
        { type: 'hunt_mourning_head', slotId: 2, name: 'Mourning Beast (Head)', pool: 'core', weapon: 'mourning_maw' },
        { type: 'hunt_mourning_limb', slotId: 1, name: 'Mourning Beast (Left Limb)', weapon: 'mourning_claw' },
        { type: 'hunt_mourning_limb', slotId: 3, name: 'Mourning Beast (Right Limb)', weapon: 'mourning_claw' },
        { type: 'hunt_mourning_body', slotId: 5, name: 'Mourning Beast (Body)', pool: 'core', weapon: 'mourning_bulk' },
      ],
    },
  },
};
