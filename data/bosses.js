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
 *  is, no omens gather at all). Claimed plans are items and uncapped. */
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
 *
 * `loot` (owner, 2026-09-26: every kill, the first too, is worth it beyond
 * the Historic item; when the Historic item is held, something takes its
 * place). Read by src/systems/BossLoot.js:
 *   family       a HUNT_BEASTS family (data/beastParts.js) whose parts drop
 *   parts        the slots that drop, as harvestable spoils (like a beast's)
 *   rarityFloor  no part rolls below this (Great-grade odds, then the floor)
 *   bodies       bodies of meat to butcher (Great grade)
 *   substitute   in the chest instead of the Historic item while it is held:
 *                that part again at that rarity, a specimen for the pack
 *
 * A boss whose members wear real gear (the Ghost Party) says so per member:
 *   weaponType   rolls a weapon of that type (a current type), soulbound
 *   armor        the slots that roll armour, soulbound
 *   dropSlot     the ONE slot that drops (not soulbound), rolled at least
 *                `kit.dropFloor`
 *   historicSlot this member wears the boss's Historic item there while it
 *                is in the wild (droppable, and it works on him: gear effects)
 *   substituteSlot  while it is held, this slot instead rolls `kit.substitute`
 *                and drops
 * and `historicWorn: true`: the Historic item comes off its wearer, never
 * out of a chest. `lair.night`: the lair can only be entered at night.
 */
export const BOSSES = {
  ghost_party: {
    name: 'The Ghost Party',
    zone: 'reeds_of_gethsemane',
    plan: 'tethered_soul',
    unlockFlag: 'gp_offer_taken',
    offerAfter: 'gp_names_known',
    historic: 'the_unconfessed',
    historicWorn: true,
    lair: {
      name: 'The Drowned Camp',
      night: true,
      text: 'Tents gone black with water, a fire that burns without heat, and six hunters sitting round it who have not moved in years. They turn their heads toward you all at once. This is a boss fight: camp and ready the party first if you need to.',
    },
    kit: { soulboundRarity: 'uncommon', dropFloor: 'rare', substitute: 'epic' },
    fight: {
      name: 'The Ghost Party',
      // Every member's damage, as the scenario dial encounter 4 uses (bosscal).
      damagePct: -27,
      members: [
        { type: 'hunt_ghost_captain',   slotId: 2, name: 'Ghost Captain',   weaponType: 'sword_1h', armor: ['head', 'chest', 'legs', 'gloves', 'boots'], dropSlot: 'chest', historicSlot: 'amulet', substituteSlot: 'gloves' },
        { type: 'hunt_ghost_reaver',    slotId: 1, name: 'Ghost Reaver',    weaponType: 'axe_2h',   armor: ['head', 'chest', 'legs', 'boots'], dropSlot: 'weaponMain' },
        { type: 'hunt_ghost_cutthroat', slotId: 3, name: 'Ghost Cutthroat', weaponType: 'dagger',   armor: ['head', 'chest', 'gloves', 'boots'], dropSlot: 'boots' },
        { type: 'hunt_ghost_chaplain',  slotId: 5, name: 'Ghost Chaplain',  weaponType: 'mace_2h',  armor: ['head', 'chest', 'legs'], dropSlot: 'head' },
        { type: 'hunt_ghost_tracker',   slotId: 7, name: 'Ghost Tracker',   weaponType: 'bow',      armor: ['head', 'chest', 'legs', 'boots'], dropSlot: 'legs' },
        { type: 'hunt_ghost_magus',     slotId: 8, name: 'Ghost Magus',     weaponType: 'staff',    armor: ['head', 'chest', 'gloves'], dropSlot: 'gloves' },
      ],
    },
  },
  mourning_beast: {
    name: 'The Mourning Beast',
    zone: 'reeds_of_gethsemane',
    plan: 'mourners_offering',
    unlockFlag: 'mb_offer_taken',
    offerAfter: 'mb_signs_found',
    historic: 'burden_of_dreams',
    loot: {
      family: 'mourning_beast',
      parts: ['weaponMain', 'head', 'chest', 'gloves', 'ring', 'amulet'],
      rarityFloor: 'rare',
      bodies: 2,
      substitute: { slot: 'amulet', rarity: 'epic' },   // a second Grief-Heart, epic
    },
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
        { type: 'hunt_mourning_head', slotId: 2, name: 'Head', pool: 'core', weapon: 'mourning_maw' },
        { type: 'hunt_mourning_limb', slotId: 1, name: 'Left Limb', weapon: 'mourning_claw' },
        { type: 'hunt_mourning_limb', slotId: 3, name: 'Right Limb', weapon: 'mourning_claw' },
        { type: 'hunt_mourning_body', slotId: 5, name: 'Body', pool: 'core', weapon: 'mourning_bulk' },
      ],
    },
  },
};
