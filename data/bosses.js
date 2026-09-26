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
//                          HuntPlanPickerOverlay (a boss plan is its region's only)

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

/**
 * `plan` is the boss hunt plan item (data/items.js, `boss: <id>`); `unlockFlag`
 * is the quest flag that unlocks it (its questline's last step); `offerAfter`
 * is the flag that makes the tribe's first, free offer available (the step
 * before it).
 */
export const BOSSES = {
  mourning_beast: {
    name: 'The Mourning Beast',
    zone: 'reeds_of_gethsemane',
    plan: 'mourners_offering',
    unlockFlag: 'mb_offer_taken',
    offerAfter: 'mb_signs_found',
  },
};
