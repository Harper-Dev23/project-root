/**
 * quests.js — Static quest definitions.
 *
 * Each quest line belongs to one tab category and contains an ordered list
 * of steps. State is derived at render time from ProgressionManager — nothing
 * is stored here. This makes the file purely declarative and easy to extend.
 *
 * Step state:
 *   'completed' → isComplete(pm) returns true
 *   'active'    → isActive(pm) returns true (and not complete)
 *   'upcoming'  → neither — step hasn't triggered yet
 *
 * Quest-line state:
 *   'completed'  → all steps complete
 *   'active'     → at least one step complete or active
 *   'available'  → no steps triggered yet but isAvailable(pm) is true
 *   'locked'     → prerequisites not yet met (not shown)
 *   'placeholder'→ future content stub (shown with "Coming Soon" note)
 */

import { VOWBACK_CROCODILE, ZONES } from '../../data/zones.js';

// ── Shorthand helpers used inside step functions ──────────────────────────────

const sc = (pm, id) => pm.completedScenarios.includes(id);

// The Elder's Historic talk (ProgressionManager.requestHistoricTalk and
// friends), read from flags alone so a bare flag-reader works here too. The
// bloodthirster_elder_* flags are a save's from before the talk was general.
const historicExplained = (pm) =>
  pm.hasQuestFlag('historic_elder_explained') || pm.hasQuestFlag('bloodthirster_elder_explained');
const historicTalkPending = (pm) => !historicExplained(pm)
  && (pm.hasQuestFlag('historic_elder_visit') || pm.hasQuestFlag('bloodthirster_elder_visit'));
const firstHistoricFlag = (pm) => (pm.questFlags || []).find(f => f.startsWith('historic_first:')) || null;

/** The Vowback is dead. (Since the split, owner 2026-10-03, the Lament Pools
 *  come BEFORE it, so reaching them no longer counts.) */
const pastTheVowback = (pm) => pm.hasQuestFlag('vowback_slain');
/** A hunt-plan flag (`hunted`, `hunted_cull`, `apex_slain`, ...) in ANY
 *  region: The Hunter's Trade is done wherever the party hunts. */
const anyRegion = (pm, prefix) => Object.keys(ZONES).some(z => pm.hasQuestFlag(`${prefix}:${z}`));

/**
 * A cult's questline opens (owner 2026-09-29, batch 4b chunk 3): when the
 * Vowback is reported to the Elder, or earlier, the first time the party
 * fights a band of that cult (the engine's cult_slain:<god>), so each can
 * start on its own. Both lines run side by side. A line already started
 * stays open.
 */
const cultLineOpen = (pm, god, startedFlag) =>
  (pastTheVowback(pm) && isReported(pm, 'wr_apex'))
  || pm.hasQuestFlag(`cult_slain:${god}`) || pm.hasQuestFlag(startedFlag);

/** The Unconfessed Dead is open once the Mourner's signs are found (owner
 *  2026-10-03: the Vowback was too late), or the Vowback slain (a save that
 *  got there first), or a save already on it. The Reeds' apex no longer
 *  opens it: since the split that kill comes early, in The Hunter's Trade. */
const ghostPartyOpen = (pm) =>
  pm.hasQuestFlag('mb_signs_found') || pm.hasQuestFlag('vowback_slain') || pm.hasQuestFlag('gp_soul_found');

const anyLodgeFlag = (pm) =>
  pm.hasQuestFlag('lodge_styx') || pm.hasQuestFlag('lodge_zafaar') ||
  pm.hasQuestFlag('lodge_elseth') || pm.hasQuestFlag('lodge_lesse');

// ── Quest Definitions ─────────────────────────────────────────────────────────

export const QUEST_LINES = [

  // ═══════════════════════════════════════════════════════════════════════════
  //  MAIN
  // ═══════════════════════════════════════════════════════════════════════════

  {
    id:          'prologue',
    category:    'main',
    title:       'Prologue',
    description: 'Orient yourself within the crossroads camp and take your first steps as a recruit.',
    isAvailable: (_pm) => true,
    steps: [
      {
        id:          'prologue_create_character',
        flags:          ['orientation_bonfire'],
        label:       'Create a Character',
        description: 'Visit the bonfire at the heart of camp. A hunt must have hunters.',
        isActive:   (pm) => pm.hasQuestFlag('orientation_bonfire'),
        isComplete: (pm) => !pm.hasQuestFlag('orientation_bonfire'),
      },
      {
        id:          'prologue_elder',
        flags:          ['orientation_elder'],
        label:       'Speak with the Elder',
        description: 'A wise elder waits in the tower at the heart of camp. Heed their counsel before venturing further.',
        isActive:   (pm) => pm.hasQuestFlag('orientation_elder'),
        isComplete: (pm) =>
          !pm.hasQuestFlag('orientation_elder') && (
            pm.hasQuestFlag('vendor_row')  ||
            pm.hasQuestFlag('tribe_choice') ||
            pm.tribe !== null              ||
            sc(pm, 'training_encounter_1')
          ),
      },
      {
        id:          'prologue_equip',
        flags:          ['vendor_row'],
        label:       'Equip Yourself',
        description: "Visit the vendor row and prepare your party for the trials ahead: weapons at the Ironbinder's Stand, armour at the Watershade Armory. Both are free.",
        isActive:   (pm) => pm.hasQuestFlag('vendor_row'),
        // `vendor_row` is only ever set BY visiting the Elder, so a player who
        // walks straight past him to the Combat Pit could never satisfy either
        // branch: never active (no flag), never complete (orientation_elder is
        // still set) -- the step sat on "upcoming" forever. Clearing the first
        // trial now closes it regardless of the route taken there.
        isComplete: (pm) =>
          sc(pm, 'training_encounter_1') || (
            !pm.hasQuestFlag('vendor_row') &&
            !pm.hasQuestFlag('orientation_elder') &&
            !pm.hasQuestFlag('orientation_bonfire')
          ),
      },
      {
        id:          'prologue_first_trial',
        flags:          ['combat_pit'],
        label:       'Enter the Combat Pit',
        description: 'Prove your party\'s mettle in the Combat Pit. The elder expects results.',
        isActive:   (pm) => !sc(pm, 'training_encounter_1') && !pm.hasQuestFlag('vendor_row') && !pm.hasQuestFlag('orientation_elder'),
        isComplete: (pm) => sc(pm, 'training_encounter_1'),
      },
    ],
  },

  {
    id:          'know_the_tribes',
    category:    'main',
    title:       'Get to Know the Tribes',
    description: 'While the trials demand your attention, take time to understand those who fight beside you. Your tribe will define you.',
    // Visible as "available" between S1 completion and tribe pledge
    isAvailable: (pm) => sc(pm, 'training_encounter_1'),
    steps: [
      {
        id:          'ktt_choose_tribe',
        flags:          ['tribe_choice', 'lodge_styx', 'lodge_zafaar', 'lodge_elseth', 'lodge_lesse'],
        label:       'Heed the Elder\'s Call',
        description: 'Return to the Elder\'s Tower. The time has come to choose your allegiance.',
        isActive:   (pm) => pm.hasQuestFlag('tribe_choice') || anyLodgeFlag(pm),
        isComplete: (pm) => pm.tribe !== null,
      },
      {
        id:          'ktt_tribe_vendor',
        flags:          ['tribe_vendor'],
        label:       'Visit the Tribe Vendor',
        description: 'Your new allegiance grants access to exclusive wares. Spend your Tribe Ticket wisely.',
        isActive:   (pm) => pm.tribe !== null && pm.hasQuestFlag('tribe_vendor'),
        isComplete: (pm) => pm.tribe !== null && !pm.hasQuestFlag('tribe_vendor'),
      },
    ],
  },

  {
    id:          'the_long_road',
    category:    'main',
    title:       'The Long Road',
    description: 'The trials grow harder. The elder has more to teach between each encounter — seek their counsel after every victory.',
    isAvailable: (pm) => sc(pm, 'training_encounter_1') && pm.tribe !== null,
    steps: [
      {
        id:          'lr_s2',
        flags:          ['combat_pit'],
        label:       'Complete the Second Trial',
        // Either route opens the Bone Pile (FEATURE_UNLOCKS orFirstHunt), so
        // say so, or a hunt-led player reads this as the only way on.
        description: 'Return to the Combat Pit for the second trial, or take your first hunt from the Hunt Gate. Either opens the Bone Pile.',
        isActive:   (pm) => pm.tribe !== null && !sc(pm, 'training_encounter_2'),
        isComplete: (pm) => sc(pm, 'training_encounter_2'),
      },
      {
        id:          'lr_elder_bonepile',
        flags:          ['elder_bonepile'],
        label:       'Return to the Elder',
        description: 'The elder has knowledge to share about the Bone Pile and its risks.',
        // Raised by Trial 2 or by the first hunt (ProgressionManager
        // offerBonepileAfterHunt); `bonepile_explained` is set when he speaks.
        isActive:   (pm) => pm.hasQuestFlag('elder_bonepile'),
        isComplete: (pm) => (sc(pm, 'training_encounter_2') || pm.hasQuestFlag('bonepile_explained')) && !pm.hasQuestFlag('elder_bonepile'),
      },
      {
        id:          'lr_s3',
        flags:          ['combat_pit'],
        label:       'Complete the Third Trial',
        description: 'Steel your party and return to the Combat Pit.',
        isActive:   (pm) => sc(pm, 'training_encounter_2') && !pm.hasQuestFlag('elder_bonepile') && !sc(pm, 'training_encounter_3'),
        isComplete: (pm) => sc(pm, 'training_encounter_3'),
      },
      {
        id:          'lr_elder_leveling',
        flags:          ['elder_leveling'],
        label:       'Return to the Elder',
        description: 'The elder will explain how your party grows stronger over time.',
        isActive:   (pm) => pm.hasQuestFlag('elder_leveling'),
        isComplete: (pm) => sc(pm, 'training_encounter_3') && !pm.hasQuestFlag('elder_leveling'),
      },
      {
        id:          'lr_s4',
        flags:          ['combat_pit'],
        label:       'Complete the Fourth Trial',
        description: 'Another trial awaits in the Combat Pit.',
        isActive:   (pm) => sc(pm, 'training_encounter_3') && !pm.hasQuestFlag('elder_leveling') && !sc(pm, 'training_encounter_4'),
        isComplete: (pm) => sc(pm, 'training_encounter_4'),
      },
      {
        id:          'lr_samuel',
        flags:          ['samuel_mourne'],
        label:       'Meet Samuel Mourne',
        description: 'A solitary figure lingers at the edge of camp. Seek them out.',
        // Samuel can also come after the first hunt (ProgressionManager
        // offerSamuelAfterHunt); before Trial 4 his marker belongs to The
        // Prophet's Fragment, not to this line, which would show it out of order.
        isActive:   (pm) => sc(pm, 'training_encounter_4') && pm.hasQuestFlag('samuel_mourne'),
        isComplete: (pm) => sc(pm, 'training_encounter_4') && !pm.hasQuestFlag('samuel_mourne'),
      },
      {
        id:          'lr_s5',
        flags:          ['combat_pit'],
        label:       'Complete the Fifth Trial',
        description: 'The Combat Pit calls again. Answer it.',
        isActive:   (pm) => sc(pm, 'training_encounter_4') && !pm.hasQuestFlag('samuel_mourne') && !sc(pm, 'training_encounter_5'),
        isComplete: (pm) => sc(pm, 'training_encounter_5'),
      },
      {
        id:          'lr_s6',
        flags:          ['combat_pit'],
        label:       'Complete the Final Trial',
        description: 'This is the last trial of the demo. Whatever awaits beyond — face it with everything you have.',
        isActive:   (pm) => sc(pm, 'training_encounter_5') && !sc(pm, 'training_encounter_6'),
        isComplete: (pm) => sc(pm, 'training_encounter_6'),
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  //  TRIBE
  // ═══════════════════════════════════════════════════════════════════════════

  {
    id:          'blood_and_soil',
    category:    'tribe',
    title:       'Blood and Soil',
    description: 'Every recruit must choose their tribe. But pledging allegiance is only the beginning — the four lodges will test you on your way up.',
    isAvailable: (pm) => sc(pm, 'training_encounter_1'),
    steps: [
      {
        id:          'bas_choose_tribe',
        flags:          ['tribe_choice', 'lodge_styx', 'lodge_zafaar', 'lodge_elseth', 'lodge_lesse'],
        label:       'Choose Your Tribe',
        description: 'Visit the four lodges — Styx, Zafaar, Elseth, and Le\'sse — then return to the Elder\'s Tower to pledge your allegiance.',
        isActive:   (pm) => pm.hasQuestFlag('tribe_choice') || anyLodgeFlag(pm),
        isComplete: (pm) => pm.tribe !== null,
      },
      {
        id:          'bas_tribe_vendor',
        flags:          ['tribe_vendor'],
        label:       'Visit the Tribe Vendor',
        description: 'Your new allegiance grants access to exclusive wares. Spend your Tribe Ticket at your tribe\'s vendor.',
        isActive:   (pm) => pm.tribe !== null && pm.hasQuestFlag('tribe_vendor'),
        isComplete: (pm) => pm.tribe !== null && !pm.hasQuestFlag('tribe_vendor'),
      },
      // ── Leader encounters — three-phase quest.
      //    Brief flag    (orange !)  → visit the lodge for a pre-encounter briefing
      //    Challenge flag(orange !)  → encounter done; visit to transition to hand-in
      //    Handin flag   (gold ★)   → return to collect reward (Complete button)
      {
        id:          'bas_elseth_leader',
        flags:          ['elseth_leader_brief', 'elseth_leader_challenge', 'elseth_leader_handin'],
        label:       "Answer Wren the Animancer's Call",
        description: (pm) =>
          pm.hasQuestFlag('elseth_leader_handin')
            ? 'Return to the Elseth lodge to collect your reward.'
            : pm.hasQuestFlag('elseth_leader_challenge')
              ? 'Wren is waiting. Return to the Elseth lodge.'
              : 'Wren, the Elseth Animancer, has taken notice of your party. Visit the Elseth lodge before the next trial.',
        isActive:   (pm) => pm.hasQuestFlag('elseth_leader_brief') || pm.hasQuestFlag('elseth_leader_challenge') || pm.hasQuestFlag('elseth_leader_handin'),
        isComplete: (pm) => !pm.hasQuestFlag('elseth_leader_brief') && !pm.hasQuestFlag('elseth_leader_challenge') && !pm.hasQuestFlag('elseth_leader_handin') && sc(pm, 'training_encounter_3'),
      },
      {
        id:          'bas_styx_leader',
        flags:          ['styx_leader_brief', 'styx_leader_challenge', 'styx_leader_handin'],
        label:       "Meet Cade, the Styx Tactician",
        description: (pm) =>
          pm.hasQuestFlag('styx_leader_handin')
            ? 'Return to the Styx lodge to collect your reward.'
            : pm.hasQuestFlag('styx_leader_challenge')
              ? 'Cade is waiting. Return to the Styx lodge.'
              : 'Cade, the Styx Tactician, wants to size up your party. Visit the Styx lodge before the next trial.',
        isActive:   (pm) => pm.hasQuestFlag('styx_leader_brief') || pm.hasQuestFlag('styx_leader_challenge') || pm.hasQuestFlag('styx_leader_handin'),
        isComplete: (pm) => !pm.hasQuestFlag('styx_leader_brief') && !pm.hasQuestFlag('styx_leader_challenge') && !pm.hasQuestFlag('styx_leader_handin') && sc(pm, 'training_encounter_4'),
      },
      {
        id:          'bas_lesse_leader',
        flags:          ['lesse_leader_brief', 'lesse_leader_challenge', 'lesse_leader_handin'],
        label:       "Face Ember and Rime",
        description: (pm) =>
          pm.hasQuestFlag('lesse_leader_handin')
            ? "Return to the Le'sse lodge to collect your reward."
            : pm.hasQuestFlag('lesse_leader_challenge')
              ? "Ember and Rime are waiting. Return to the Le'sse lodge."
              : "Ember and Rime, twin elemental duelists of the Le'sse, have taken notice of your party. Visit the Le'sse lodge before the next trial.",
        isActive:   (pm) => pm.hasQuestFlag('lesse_leader_brief') || pm.hasQuestFlag('lesse_leader_challenge') || pm.hasQuestFlag('lesse_leader_handin'),
        isComplete: (pm) => !pm.hasQuestFlag('lesse_leader_brief') && !pm.hasQuestFlag('lesse_leader_challenge') && !pm.hasQuestFlag('lesse_leader_handin') && sc(pm, 'training_encounter_5'),
      },
      {
        id:          'bas_zafaar_leader',
        flags:          ['zafaar_leader_brief', 'zafaar_leader_challenge', 'zafaar_leader_handin'],
        label:       'The Zafaar Champion Awaits',
        description: (pm) =>
          pm.hasQuestFlag('zafaar_leader_handin')
            ? 'Return to the Zafaar lodge to collect your reward.'
            : pm.hasQuestFlag('zafaar_leader_challenge')
              ? 'The champion is waiting. Return to the Zafaar lodge.'
              : 'The most formidable warrior in the Zafaar lodge has acknowledged your progress. Visit before the next trial.',
        isActive:   (pm) => pm.hasQuestFlag('zafaar_leader_brief') || pm.hasQuestFlag('zafaar_leader_challenge') || pm.hasQuestFlag('zafaar_leader_handin'),
        isComplete: (pm) => !pm.hasQuestFlag('zafaar_leader_brief') && !pm.hasQuestFlag('zafaar_leader_challenge') && !pm.hasQuestFlag('zafaar_leader_handin') && sc(pm, 'training_encounter_6'),
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  //  REGIONS (chunk 14b-2)
  // ═══════════════════════════════════════════════════════════════════════════
  // A step with `huntSite` makes every hunt in that region hold the site while
  // the step is active (src/systems/HuntQuests.js). `hunted:<zone>` and
  // `apex_slain:<zone>` are set by the hunt engine.
  //
  // A step with `reward: { huntTickets, text }` is reported to Elder Varek at
  // the Elders' Tower, who pays it once (src/systems/QuestRewards.js), `text`
  // in his voice; the rest of its line waits on the report (getStepState,
  // below). The hunt-side source of Hunt Tickets beside the Combat Pit's
  // (owner 2026-09-29).

  {
    // Split from The Weeping in the Reeds (owner 2026-10-03, co-op playtest):
    // the plan types, learned in order, in ANY region (four starting regions
    // to come). Its step ids are the old ones, so a save's reports carry over.
    id:          'hunters_trade',
    category:    'main',
    title:       "The Hunter's Trade",
    description: 'Every region is learned the same way: hunt it, thin its herds, and kill what rules it.',
    isAvailable: (pm) => pm.tribe !== null,
    steps: [
      {
        id:          'wr_hunt',
        // A marker over the Hunt Gate while this is the step to do (TownScene
        // DERIVED_MARKERS: no save flag, the step's own state decides).
        flags:       ['hunt_gate'],
        label:       'Hunt a Region',
        reward:      { huntTickets: 4, item: { base: 'plan_cull_small', rarity: 'common' },
                       text: 'You came back with the work done. The camp pays for that. Now thin the herds: take this plan.' },
        description: 'Leave by the Hunt Gate with a hunt plan for any region, and see its main objective done.',
        isActive:   (pm) => pm.tribe !== null,
        isComplete: (pm) => anyRegion(pm, 'hunted') || anyRegion(pm, 'apex_slain'),
      },
      {
        id:          'wr_cull',
        label:       'Thin the Herds',
        // Elder Varek hands out another if it is lost (QuestRewards.replacementPlan).
        planFrom:    'wr_hunt',
        reward:      { huntTickets: 4, item: { base: 'plan_apex_small', rarity: 'uncommon' },
                       text: 'The herds are thinner, and quieter for it. Something larger rules them. Find it.' },
        description: 'Take a Cull plan into any region and see its main objective done. Elder Varek gave you one, and will give you another if you lose it; the Greenhollow Satchel sells them too.',
        isActive:   (pm) => anyRegion(pm, 'hunted'),
        isComplete: (pm) => anyRegion(pm, 'hunted_cull'),
      },
      {
        id:          'wr_apexpool',
        label:       'Kill the Apex',
        planFrom:    'wr_cull',
        reward:      { huntTickets: 6, text: 'So that is what rules there. Every region has its own; now you know how to find them.' },
        description: 'Take an Apex plan into any region and kill the beast that rules it. Elder Varek gave you one, and will give you another if you lose it.',
        isActive:   (pm) => anyRegion(pm, 'hunted_cull'),
        isComplete: (pm) => anyRegion(pm, 'hunted_apex'),
      },
    ],
  },

  {
    // The Reeds' own line (owner 2026-10-03): opens after one hunt there, and
    // leads to its first boss. The Vowback now comes after the signs, before
    // the tribe's offer (for now; it may become a bounty).
    id:          'weeping_in_the_reeds',
    category:    'region',
    title:       'The Weeping in the Reeds',
    description: 'The Reeds of Gethsemane grieve. Something in them grieves loudest of all.',
    isAvailable: (pm) => pm.hasQuestFlag('hunted:reeds_of_gethsemane'),
    steps: [
      {
        id:          'wr_pools',
        label:       'The Lament Pools',
        reward:      { huntTickets: 4, text: 'You heard the weeping and held your ground. Few do.' },
        description: 'Something weeps in the Reeds at night. Your next Reeds hunt will mark the Lament Pools on its map. Be there after dark.',
        huntSite:    { zone: 'reeds_of_gethsemane', eventId: 'reeds_lament_pools', far: true },
        isActive:   (pm) => pm.hasQuestFlag('hunted:reeds_of_gethsemane'),
        isComplete: (pm) => pm.hasQuestFlag('mb_weeping_heard'),
      },
      {
        id:          'wr_signs',
        label:       'Signs of the Mourner',
        reward:      { huntTickets: 4, text: 'You tracked the mourner to ground. The mourners say an old crocodile keeps watch near there.' },
        description: 'Follow the weeping to where it goes to ground. Your next Reeds hunt will mark the trail.',
        huntSite:    { zone: 'reeds_of_gethsemane', eventId: 'reeds_mourner_signs', far: true },
        isActive:   (pm) => pm.hasQuestFlag('mb_weeping_heard'),
        isComplete: (pm) => pm.hasQuestFlag('mb_signs_found'),
      },
      {
        id:          'wr_apex',
        label:       'The Vowback Crocodile',
        // Reporting it opens both cult lines (cultLineOpen, chunk 3): his line says why.
        reward:      { huntTickets: 8, text: 'The Vowback is dead? Then the mourners can walk the reeds again. They tell me of other things now: singing under the water at night, and offerings sunk in the still pools. Look into both. And go to your tribe: they know what the signs mean.' },
        description: 'The mourners speak of an old crocodile grown over with prayer stones, keeping watch where the mourner goes to ground. Your next Reeds hunt will mark where it lies with its brood. Kill it.',
        // A quest BEAST (owner 2026-09-27: it was the Reeds' apex every hunt).
        huntSite:    { zone: 'reeds_of_gethsemane', beast: { ...VOWBACK_CROCODILE, flag: 'vowback_slain' }, far: true },
        isActive:   (pm) => pm.hasQuestFlag('mb_signs_found'),
        // A save that took the tribe's offer under the old order is past it.
        isComplete: (pm) => pastTheVowback(pm) || pm.hasQuestFlag('mb_offer_taken'),
      },
      {
        // Completed by taking the tribe's first Mourner's Offering at the
        // lodge (TribeHQOverlay, Omens.takeFirstOffer; 14b-3).
        id:          'wr_offer',
        label:       'The Tribe\'s Offer',
        description: "Visit your tribe's lodge and open Tribe HQ. Your tribe knows what the signs mean, and has something for you.",
        // The signs too: a save that killed the Vowback under the old order
        // (before the Pools) still walks them first.
        isActive:   (pm) => pastTheVowback(pm) && pm.hasQuestFlag('mb_signs_found'),
        isComplete: (pm) => pm.hasQuestFlag('mb_offer_taken'),
      },
    ],
  },

  {
    id:          'unconfessed_dead',
    category:    'region',
    title:       'The Unconfessed Dead',
    description: 'A hunting party drowned in the Reeds and never made its confession. It is still out there, after dark.',
    // Opens on the Vowback's kill (owner's playtest 2026-09-29: it opened on
    // the Reeds' apex, and since batch 3 the Vowback is a quest beast, not the
    // apex, so a run of scout hunts never opened it).
    isAvailable: (pm) => ghostPartyOpen(pm),
    steps: [
      {
        id:          'ud_camp',
        label:       'The Drowned Camp',
        reward:      { huntTickets: 5, text: 'A drowned camp, still waiting for its dead. I will enter it in the tally.' },
        description: 'Something waits at a drowned camp in the Reeds. Your next Reeds hunt will mark it on its map. It only shows itself at night.',
        huntSite:    { zone: 'reeds_of_gethsemane', eventId: 'reeds_drowned_camp', far: true },
        isActive:   (pm) => ghostPartyOpen(pm),
        isComplete: (pm) => pm.hasQuestFlag('gp_soul_found'),
      },
      {
        id:          'ud_graves',
        label:       'Unmarked Graves',
        reward:      { huntTickets: 5, text: 'Their names are known again. That is worth more than tickets, but tickets are what I have.' },
        description: 'Find where the drowned party was buried. Your next Reeds hunt will mark the graves.',
        huntSite:    { zone: 'reeds_of_gethsemane', eventId: 'reeds_unmarked_graves', far: true },
        isActive:   (pm) => pm.hasQuestFlag('gp_soul_found'),
        isComplete: (pm) => pm.hasQuestFlag('gp_names_known'),
      },
      {
        // Completed by taking the tribe's first Tethered Soul at the lodge
        // (TribeHQOverlay, Omens.takeFirstOffer).
        id:          'ud_offer',
        label:       "The Tribe's Offer",
        description: "Visit your tribe's lodge and open Tribe HQ. Your tribe knows how to call the dead to account.",
        isActive:   (pm) => pm.hasQuestFlag('gp_names_known'),
        isComplete: (pm) => pm.hasQuestFlag('gp_offer_taken'),
      },
    ],
  },

  {
    // The Drowned Choir's questline (owner, 2026-09-27; vault CONTENT_INBOX).
    // Its first step opens parley with Choir camps (data/cultMarkets.js
    // CULT_PARLEY); its last opens the Tithe-Boat, their black market.
    id:          'hymn_beneath_the_water',
    category:    'region',
    title:       'The Hymn Beneath the Water',
    description: 'The Drowned Choir sing to Yar\'galeth under the reeds. They could be talked to, and traded with, by someone they know.',
    isAvailable: (pm) => cultLineOpen(pm, 'yargaleth', 'choir_heard'),
    steps: [
      {
        id:          'hb_singing',
        label:       'Singing Under the Water',
        reward:      { huntTickets: 3, text: 'So the Choir sing under the water. Better to know it than to wonder.' },
        description: 'Something sings under the reeds at night. Your next Reeds hunt will mark where. Once the Choir know you, their camps will talk instead of fight.',
        huntSite:    { zone: 'reeds_of_gethsemane', eventId: 'choir_singing', far: true },
        isActive:   (pm) => cultLineOpen(pm, 'yargaleth', 'choir_heard'),
        isComplete: (pm) => pm.hasQuestFlag('choir_heard'),
      },
      {
        id:          'hb_cantor',
        label:       "The Cantor's Price",
        reward:      { huntTickets: 3, text: 'A page of their hymn. Guard it.' },
        description: 'A Choir cantor has a page of their hymn. Trade fish for it on your next Reeds hunt, or take it from any Drowned Choir band.',
        huntSite:    { zone: 'reeds_of_gethsemane', eventId: 'choir_cantor', far: false },
        isActive:   (pm) => pm.hasQuestFlag('choir_heard'),
        isComplete: (pm) => pm.hasQuestFlag('choir_page') || pm.hasQuestFlag('cult_slain:yargaleth'),
      },
      {
        id:          'hb_hymn',
        label:       'The Unfinished Hymn',
        reward:      { huntTickets: 4, text: 'You read it aloud and lived. Remarkable.' },
        description: 'The page stops mid-verse. Your next Reeds hunt will mark where to read it aloud.',
        huntSite:    { zone: 'reeds_of_gethsemane', eventId: 'choir_unfinished_hymn', far: true },
        isActive:   (pm) => pm.hasQuestFlag('choir_page') || pm.hasQuestFlag('cult_slain:yargaleth'),
        isComplete: (pm) => pm.hasQuestFlag('choir_hymn'),
      },
      {
        id:          'hb_boat',
        label:       'The Tithe-Boat',
        reward:      { huntTickets: 5, text: 'Trade with the Choir if you must. Keep your wits about you on that boat.' },
        description: 'The Choir want to meet you on their boat. Your next Reeds hunt will mark it.',
        huntSite:    { zone: 'reeds_of_gethsemane', eventId: 'choir_tithe_offer', far: false },
        isActive:   (pm) => pm.hasQuestFlag('choir_hymn'),
        isComplete: (pm) => pm.hasQuestFlag('choir_market_open'),
      },
    ],
  },

  {
    // The Temple of the Gill's questline (owner, 2026-09-27). Its first step
    // opens parley with Temple camps; its last opens the Gill Market.
    id:          'offered_breath',
    category:    'region',
    title:       'The Offered Breath',
    description: 'The Temple of the Gill feed Dagon from the Reeds\' still pools. Get close enough, and they trade.',
    isAvailable: (pm) => cultLineOpen(pm, 'dagon', 'gill_offerings_read'),
    steps: [
      {
        id:          'ob_offerings',
        label:       'Drowned Offerings',
        reward:      { huntTickets: 3, text: 'Offerings to Dagon, in our own reeds. I would rather know than not.' },
        description: 'Someone sinks offerings at a reed shrine. Your next Reeds hunt will mark it. Once the Temple know you, their camps will talk instead of fight.',
        huntSite:    { zone: 'reeds_of_gethsemane', eventId: 'gill_offerings', far: false },
        isActive:   (pm) => cultLineOpen(pm, 'dagon', 'gill_offerings_read'),
        isComplete: (pm) => pm.hasQuestFlag('gill_offerings_read'),
      },
      {
        id:          'ob_baptism',
        label:       'Baptism in the Gill',
        reward:      { huntTickets: 4, text: 'You let a gill-priest put you under, and you came back up. That is something.' },
        description: 'A gill-priest waits in the water. Your next Reeds hunt will mark where.',
        huntSite:    { zone: 'reeds_of_gethsemane', eventId: 'gill_baptism', far: true },
        isActive:   (pm) => pm.hasQuestFlag('gill_offerings_read'),
        isComplete: (pm) => pm.hasQuestFlag('gill_baptised'),
      },
      {
        id:          'ob_channel',
        label:       "The Smugglers' Channel",
        reward:      { huntTickets: 3, text: 'The smugglers\' channel. Useful, and dangerous, like every useful thing.' },
        description: 'The Temple\'s smugglers will take you to their Deep Priest for meat (2 lean game). Your next Reeds hunt will mark them.',
        huntSite:    { zone: 'reeds_of_gethsemane', eventId: 'gill_smugglers', far: false },
        isActive:   (pm) => pm.hasQuestFlag('gill_baptised'),
        isComplete: (pm) => pm.hasQuestFlag('gill_channel'),
      },
      {
        id:          'ob_priest',
        label:       'The Deep Priest',
        reward:      { huntTickets: 5, text: 'You stood before the Deep Priest and walked away. The Temple will remember you.' },
        description: 'The Temple\'s eldest waits in a church of reeds. Your next Reeds hunt will mark it.',
        huntSite:    { zone: 'reeds_of_gethsemane', eventId: 'gill_deep_priest', far: true },
        isActive:   (pm) => pm.hasQuestFlag('gill_channel'),
        isComplete: (pm) => pm.hasQuestFlag('gill_market_open'),
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  //  DIVINE
  // ═══════════════════════════════════════════════════════════════════════════

  {
    id:          'prophets_fragment',
    category:    'divine',
    title:       "The Prophet's Fragment",
    description: 'A wandering figure named Samuel Mourne has drawn your attention. He speaks of prophets — ancient beings who walk the island in the form of great beasts — and of a waystone network attuned to those who hunt here.',
    isAvailable: (pm) =>
      sc(pm, 'training_encounter_4') ||
      pm.hasQuestFlag('samuel_mourne') ||
      pm.hasQuestFlag('waystone_visit') ||
      pm.hasQuestFlag('samuel_waystone_return') ||
      pm.hasQuestFlag('waystone_attuned') ||
      pm.hasQuestFlag('waystone_shard_collected'),
    steps: [
      {
        id:          'meet_samuel_mourne',
        flags:          ['samuel_mourne'],
        label:       'Seek Out Samuel Mourne',
        description: 'A solitary figure lingers near the camp. Seek him out and hear what he has to say.',
        isActive:   (pm) => pm.hasQuestFlag('samuel_mourne'),
        isComplete: (pm) => !pm.hasQuestFlag('samuel_mourne') &&
          (pm.hasQuestFlag('waystone_visit') || pm.hasQuestFlag('samuel_waystone_return') ||
           pm.hasQuestFlag('waystone_attuned') || pm.hasQuestFlag('waystone_shard_collected')),
      },
      {
        id:          'attune_waystone',
        flags:          ['waystone_visit'],
        label:       'Attune to the Waystone',
        description: 'Samuel has directed you to the waystone at the edge of camp. Approach it and allow it to attune to your presence.',
        isActive:   (pm) => pm.hasQuestFlag('waystone_visit'),
        isComplete: (pm) => pm.hasQuestFlag('waystone_attuned'),
      },
      {
        id:          'collect_waystone_shard',
        flags:          ['samuel_waystone_return'],
        label:       'Collect the Waystone Shard',
        description: (pm) => pm.hasQuestFlag('samuel_waystone_return')
          ? 'Return to Samuel Mourne and collect your reward — a personal shard of the waystone network.'
          : 'The waystone has attuned to you. Return to Samuel Mourne and receive your reward.',
        isActive:   (pm) => pm.hasQuestFlag('waystone_attuned') && !pm.hasQuestFlag('waystone_shard_collected'),
        isComplete: (pm) => pm.hasQuestFlag('waystone_shard_collected'),
      },
    ],
  },

  {
    id:          'the_awakening',
    category:    'divine',
    title:       'The Awakening',
    description: 'Samuel Mourne believes you stand at the threshold of something ancient. The Seers watch — and wait.',
    isAvailable: (pm) =>
      sc(pm, 'training_encounter_6') ||
      pm.hasQuestFlag('samuel_awakening') ||
      pm.hasQuestFlag('seers_awakening') ||
      pm.hasQuestFlag('awakening_complete'),
    steps: [
      {
        id:         'samuel_awakening_step',
        flags:         ['samuel_awakening'],
        label:      'Speak with Samuel Mourne',
        description: 'Return to Samuel\'s tent. He has spoken of an "Awakening."',
        isActive:   (pm) => pm.hasQuestFlag('samuel_awakening'),
        isComplete: (pm) =>
          pm.hasQuestFlag('seers_awakening') || pm.hasQuestFlag('awakening_complete'),
      },
      {
        id:         'seers_awakening_step',
        flags:         ['seers_awakening'],
        label:      'Visit the Seers\' Tent',
        description: 'The Seers do not speak. But they will show you something.',
        isActive:   (pm) => pm.hasQuestFlag('seers_awakening'),
        isComplete: (pm) => pm.hasQuestFlag('awakening_complete'),
      },
      {
        id:         'awaken',
        label:      'Awaken',
        description: 'Accept what is waiting on the other side of the threshold.',
        isActive:   (pm) =>
          pm.hasQuestFlag('seers_awakening') || pm.hasQuestFlag('awakening_complete'),
        isComplete: (pm) => pm.hasQuestFlag('awakening_complete'),
      },
    ],
  },

  {
    id:           'divine_placeholder',
    category:     'divine',
    title:        'Voices of the Ancients',
    description:  'The old gods stir. Their servants move through the camp unseen — for now.',
    isAvailable:  (_pm) => true,
    isPlaceholder: true,
    steps: [],
  },

  // A hunt-map quest with no quest code (chunk 11d; EVENTS example 3): the
  // eel-catcher events in data/events.js set and read these flags.
  {
    id:          'eel_catcher',
    category:    'tribe',
    title:       'The Eel-Catcher',
    description: 'An old fisher in the Reeds of Gethsemane traded what they knew for three fish, and promised more.',
    isAvailable: (pm) => pm.hasQuestFlag('eel_catcher_owed') || pm.hasQuestFlag('eel_catcher_paid'),
    steps: [
      {
        id:          'eel_catcher_return',
        label:       'Find the eel-catcher again',
        description: 'The fisher owes you. They mend their nets in the Reeds; look for them on a later hunt.',
        isActive:   (pm) => pm.hasQuestFlag('eel_catcher_owed'),
        isComplete: (pm) => pm.hasQuestFlag('eel_catcher_paid'),
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  //  WEAPON
  // ═══════════════════════════════════════════════════════════════════════════

  {
    // The Elder's talk, for whichever Historic item was inspected first
    // (owner's playtest 2026-09-29). Shown when that was not the Bloodthirster,
    // whose own introduction below walks the same steps.
    id:          'historic_intro',
    category:    'weapon',
    title:       'Historic Items',
    description: 'Something you carry is older than it looks, and will not yet say what it is.',
    isAvailable: (pm) => !!firstHistoricFlag(pm) && firstHistoricFlag(pm) !== 'historic_first:bloodthirster',
    steps: [
      {
        id:          'hi_elder',
        flags:       ['historic_elder_visit'],
        label:       "Visit the Elders' Tower — Floor 2",
        description: 'The Elders study relics of power. Bring what you found to the second floor and see what they make of it.',
        isActive:   (pm) => historicTalkPending(pm),
        isComplete: (pm) => historicExplained(pm),
      },
      {
        id:          'hi_reinspect',
        label:       'Inspect It Again',
        description: 'Now that the Elders have explained what you hold, press [✦ Inspect] on it again. Read what it carries.',
        isActive:   (pm) => historicExplained(pm) && !pm.hasQuestFlag('historic_inspect_2'),
        isComplete: (pm) => pm.hasQuestFlag('historic_inspect_2'),
      },
    ],
  },

  {
    id:          'bloodthirster_intro',
    category:    'weapon',
    title:       'Bloodthirster — Introduction',
    description: 'You have come into possession of a weapon unlike any you have held before. Something stirs within it — and demands to be understood.',
    isAvailable: (pm) => pm.hasQuestFlag('bloodthirster_quest'),
    steps: [
      {
        id:          'bt_intro_inspect',
        label:       'Inspect the Bloodthirster',
        description: 'Open your inventory and press [✦ Inspect] on the Bloodthirster. You cannot yet read what it holds.',
        // The Elder's talk is shared by every Historic item: if another one
        // brought it first, these steps are already behind the player.
        isActive:   (pm) =>
          pm.hasQuestFlag('bloodthirster_quest') && !historicTalkPending(pm) && !historicExplained(pm),
        isComplete: (pm) => historicTalkPending(pm) || historicExplained(pm),
      },
      {
        id:          'bt_intro_elder',
        flags:          ['historic_elder_visit', 'bloodthirster_elder_visit'],
        label:       "Visit the Elders' Tower — Floor 2",
        description: 'The Elders study relics of power. Bring the blade to the second floor and see what they make of it.',
        isActive:   (pm) => historicTalkPending(pm),
        isComplete: (pm) => historicExplained(pm),
      },
      {
        id:          'bt_intro_reinspect',
        label:       'Re-inspect the Bloodthirster',
        description: 'Now that the Elders have explained what you hold — inspect the blade again. Read its history.',
        isActive:   (pm) =>
          historicExplained(pm) &&
          !pm.hasQuestFlag('bloodthirster_inspect_2'),
        isComplete: (pm) => pm.hasQuestFlag('bloodthirster_inspect_2'),
      },
    ],
  },

  {
    id:           'weapon_placeholder',
    category:     'weapon',
    title:        'A Blade Unnamed',
    description:  'Somewhere in this world, a weapon waits to be claimed. Its legend is yet to be written.',
    isAvailable:  (_pm) => true,
    isPlaceholder: true,
    steps: [],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  //  GENERATIONAL  (placeholder)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    id:           'generational_placeholder',
    category:     'generational',
    title:        'Seeds for the Future',
    description:  'The choices you make now will echo through bloodlines not yet born.',
    isAvailable:  (_pm) => true,
    isPlaceholder: true,
    steps: [],
  },
];

/** Ordered tab definitions used by the UI. */
export const QUEST_CATEGORIES = [
  { id: 'main',         label: 'Main'         },
  { id: 'region',       label: 'Regions'      },
  { id: 'tribe',        label: 'Tribe'        },
  { id: 'divine',       label: 'Divine'       },
  { id: 'weapon',       label: 'Weapon'       },
  { id: 'generational', label: 'Generational' },
];

// ── State derivation helpers (used by QuestOverlay) ───────────────────────────

// ── Reporting to Elder Varek (owner 2026-09-29, playtest batch 4b chunk 1) ───
// A step with `reward` is reported: once its condition is met in the field it
// reads 'report' until the party visits the Elders' Tower, which pays it and
// records it (QuestRewards.claimQuestRewards, pm.markStepDone). Every later
// step of its questline waits on that report, so the log (and the next hunt's
// sites) move on only then. A save that was paid before this counts as
// reported: payment and report are the same record.

/** stepId -> the nearest earlier rewarded step in its questline. */
const PREV_REPORT = new Map();
for (const quest of QUEST_LINES) {
  let prev = null;
  for (const step of quest.steps || []) {
    if (prev) PREV_REPORT.set(step.id, prev);
    if (step.reward) prev = step.id;
  }
}

/** True once a rewarded step was reported. A bare flag-reader with no
 *  report record (a test's stand-in save) counts every step as reported. */
function isReported(pm, stepId) {
  return typeof pm?.isStepDone === 'function' ? pm.isStepDone(stepId) : true;
}

/**
 * 'completed' | 'report' (done in the field, not yet reported to the Elder)
 * | 'active' | 'upcoming'.
 */
export function getStepState(step, pm) {
  // A step already reported is done, wherever its line now puts it (the
  // split, owner 2026-10-03: a save that reported the Vowback before the
  // Pools existed ahead of it).
  if (step.reward && typeof pm?.isStepDone === 'function' && pm.isStepDone(step.id)) return 'completed';
  const prev = PREV_REPORT.get(step.id);
  if (prev && !isReported(pm, prev)) return 'upcoming';
  if (step.isComplete(pm)) return step.reward && !isReported(pm, step.id) ? 'report' : 'completed';
  if (step.isActive(pm))   return 'active';
  return 'upcoming';
}

/** Steps waiting to be reported to Elder Varek, in quest order: [{ quest, step }]. */
export function pendingReports(pm) {
  const out = [];
  for (const quest of QUEST_LINES) {
    for (const step of quest.steps || []) {
      if (step.reward && getStepState(step, pm) === 'report') out.push({ quest, step });
    }
  }
  return out;
}

export function getQuestState(quest, pm) {
  if (quest.isPlaceholder) return 'placeholder';
  if (quest.steps.length === 0) return quest.isAvailable(pm) ? 'available' : 'locked';

  const states = quest.steps.map(s => getStepState(s, pm));

  // Was `states.some(active || completed) -> 'active'`, checked before this
  // — that treated "some steps completed, nothing currently active, the
  // rest still upcoming/not yet unlocked" (e.g. Blood and Soil between
  // finishing the tribe-vendor step and one of the four leader-brief flags
  // actually firing) as still "Active", even though there's nothing for the
  // player to act on right now. Checking active FIRST, then falling back to
  // completed-if-any, puts that gap in the Completed section instead —
  // nothing left to do currently reads the same as fully done, and a
  // genuinely-in-progress quest (an actual active step) is unaffected.
  if (states.some(s => s === 'active' || s === 'report')) return 'active';
  if (states.some(s => s === 'completed')) return 'completed';
  if (quest.isAvailable(pm))               return 'available';
  return 'locked';
}

// ── Marker → quest-step lookup (used by TownScene's map markers) ──────────────
//
// Each step declares the quest-flag ids that raise a map marker for it
// (`flags: [...]` above). That keeps the marker's hover text and the Quest Log
// reading from ONE source: reword a step here and the map updates with it.
//
// A step may own several flags (the leader lines use brief/challenge/handin and
// pick their wording inside `description`), and a flag may appear on several
// steps (`combat_pit` belongs to every trial). Resolution therefore filters to
// the step that is currently ACTIVE, which is exactly the one the marker is
// standing for.

/** The active quest step a given map-marker flag currently represents, or null. */
export function getStepForFlag(flagId, pm) {
  for (const quest of QUEST_LINES) {
    for (const step of quest.steps) {
      if (!step.flags || !step.flags.includes(flagId)) continue;
      if (step.isActive(pm) && !step.isComplete(pm)) return { quest, step };
    }
  }
  return null;
}

/** `description` may be a plain string or a (pm) => string. Normalises both. */
export function resolveStepDescription(step, pm) {
  const d = step?.description;
  return (typeof d === 'function' ? d(pm) : d) || '';
}
