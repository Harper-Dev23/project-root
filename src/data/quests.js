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

// ── Shorthand helpers used inside step functions ──────────────────────────────

const sc = (pm, id) => pm.completedScenarios.includes(id);

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
        label:       'Create a Character',
        description: 'Visit the bonfire at the heart of camp. A hunter must have hunters.',
        isActive:   (pm) => pm.hasQuestFlag('orientation_bonfire'),
        isComplete: (pm) => !pm.hasQuestFlag('orientation_bonfire'),
      },
      {
        id:          'prologue_elder',
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
        label:       'Equip Yourself',
        description: 'Visit the vendor row and prepare your party for the trials ahead.',
        isActive:   (pm) => pm.hasQuestFlag('vendor_row'),
        isComplete: (pm) =>
          !pm.hasQuestFlag('vendor_row') &&
          !pm.hasQuestFlag('orientation_elder') &&
          !pm.hasQuestFlag('orientation_bonfire'),
      },
      {
        id:          'prologue_first_trial',
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
        label:       'Heed the Elder\'s Call',
        description: 'Return to the Elder\'s Tower. The time has come to choose your allegiance.',
        isActive:   (pm) => pm.hasQuestFlag('tribe_choice') || anyLodgeFlag(pm),
        isComplete: (pm) => pm.tribe !== null,
      },
      {
        id:          'ktt_tribe_vendor',
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
        label:       'Complete the Second Trial',
        description: 'Return to the Combat Pit. Your tribe is watching.',
        isActive:   (pm) => pm.tribe !== null && !sc(pm, 'training_encounter_2'),
        isComplete: (pm) => sc(pm, 'training_encounter_2'),
      },
      {
        id:          'lr_elder_bonepile',
        label:       'Return to the Elder',
        description: 'The elder has knowledge to share about the Bone Pile and its risks.',
        isActive:   (pm) => pm.hasQuestFlag('elder_bonepile'),
        isComplete: (pm) => sc(pm, 'training_encounter_2') && !pm.hasQuestFlag('elder_bonepile'),
      },
      {
        id:          'lr_s3',
        label:       'Complete the Third Trial',
        description: 'Steel your party and return to the Combat Pit.',
        isActive:   (pm) => sc(pm, 'training_encounter_2') && !pm.hasQuestFlag('elder_bonepile') && !sc(pm, 'training_encounter_3'),
        isComplete: (pm) => sc(pm, 'training_encounter_3'),
      },
      {
        id:          'lr_elder_leveling',
        label:       'Return to the Elder',
        description: 'The elder will explain how your party grows stronger over time.',
        isActive:   (pm) => pm.hasQuestFlag('elder_leveling'),
        isComplete: (pm) => sc(pm, 'training_encounter_3') && !pm.hasQuestFlag('elder_leveling'),
      },
      {
        id:          'lr_s4',
        label:       'Complete the Fourth Trial',
        description: 'Another trial awaits in the Combat Pit.',
        isActive:   (pm) => sc(pm, 'training_encounter_3') && !pm.hasQuestFlag('elder_leveling') && !sc(pm, 'training_encounter_4'),
        isComplete: (pm) => sc(pm, 'training_encounter_4'),
      },
      {
        id:          'lr_samuel',
        label:       'Meet Samuel Mourne',
        description: 'A solitary figure lingers at the edge of camp. Seek them out.',
        isActive:   (pm) => pm.hasQuestFlag('samuel_mourne'),
        isComplete: (pm) => sc(pm, 'training_encounter_4') && !pm.hasQuestFlag('samuel_mourne'),
      },
      {
        id:          'lr_s5',
        label:       'Complete the Fifth Trial',
        description: 'The Combat Pit calls again. Answer it.',
        isActive:   (pm) => sc(pm, 'training_encounter_4') && !pm.hasQuestFlag('samuel_mourne') && !sc(pm, 'training_encounter_5'),
        isComplete: (pm) => sc(pm, 'training_encounter_5'),
      },
      {
        id:          'lr_s6',
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
        label:       'Choose Your Tribe',
        description: 'Visit the four lodges — Styx, Zafaar, Elseth, and Le\'sse — then return to the Elder\'s Tower to pledge your allegiance.',
        isActive:   (pm) => pm.hasQuestFlag('tribe_choice') || anyLodgeFlag(pm),
        isComplete: (pm) => pm.tribe !== null,
      },
      {
        id:          'bas_tribe_vendor',
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
        label:       'Answer the Elseth Animancer\'s Call',
        description: (pm) =>
          pm.hasQuestFlag('elseth_leader_handin')
            ? 'Return to the Elseth lodge to collect your reward.'
            : pm.hasQuestFlag('elseth_leader_challenge')
              ? 'The Animancer is waiting. Return to the Elseth lodge.'
              : 'The Elseth leader has taken notice of your party. Visit the Elseth lodge before the next trial.',
        isActive:   (pm) => pm.hasQuestFlag('elseth_leader_brief') || pm.hasQuestFlag('elseth_leader_challenge') || pm.hasQuestFlag('elseth_leader_handin'),
        isComplete: (pm) => !pm.hasQuestFlag('elseth_leader_brief') && !pm.hasQuestFlag('elseth_leader_challenge') && !pm.hasQuestFlag('elseth_leader_handin') && sc(pm, 'training_encounter_3'),
      },
      {
        id:          'bas_styx_leader',
        label:       'Meet the Styx Tactician',
        description: (pm) =>
          pm.hasQuestFlag('styx_leader_handin')
            ? 'Return to the Styx lodge to collect your reward.'
            : pm.hasQuestFlag('styx_leader_challenge')
              ? 'The Tactician is waiting. Return to the Styx lodge.'
              : 'The Styx leader wants to size up your party. Visit the Styx lodge before the next trial.',
        isActive:   (pm) => pm.hasQuestFlag('styx_leader_brief') || pm.hasQuestFlag('styx_leader_challenge') || pm.hasQuestFlag('styx_leader_handin'),
        isComplete: (pm) => !pm.hasQuestFlag('styx_leader_brief') && !pm.hasQuestFlag('styx_leader_challenge') && !pm.hasQuestFlag('styx_leader_handin') && sc(pm, 'training_encounter_4'),
      },
      {
        id:          'bas_lesse_leader',
        label:       "Heed Le'sse's Mystics",
        description: (pm) =>
          pm.hasQuestFlag('lesse_leader_handin')
            ? "Return to the Le'sse lodge to collect your reward."
            : pm.hasQuestFlag('lesse_leader_challenge')
              ? "The elders are waiting. Return to the Le'sse lodge."
              : "Le'sse's elders have opened their doors. Visit before the next trial.",
        isActive:   (pm) => pm.hasQuestFlag('lesse_leader_brief') || pm.hasQuestFlag('lesse_leader_challenge') || pm.hasQuestFlag('lesse_leader_handin'),
        isComplete: (pm) => !pm.hasQuestFlag('lesse_leader_brief') && !pm.hasQuestFlag('lesse_leader_challenge') && !pm.hasQuestFlag('lesse_leader_handin') && sc(pm, 'training_encounter_5'),
      },
      {
        id:          'bas_zafaar_leader',
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
        label:       'Seek Out Samuel Mourne',
        description: 'A solitary figure lingers near the camp. Seek him out and hear what he has to say.',
        isActive:   (pm) => pm.hasQuestFlag('samuel_mourne'),
        isComplete: (pm) => !pm.hasQuestFlag('samuel_mourne') &&
          (pm.hasQuestFlag('waystone_visit') || pm.hasQuestFlag('samuel_waystone_return') ||
           pm.hasQuestFlag('waystone_attuned') || pm.hasQuestFlag('waystone_shard_collected')),
      },
      {
        id:          'attune_waystone',
        label:       'Attune to the Waystone',
        description: 'Samuel has directed you to the waystone at the edge of camp. Approach it and allow it to attune to your presence.',
        isActive:   (pm) => pm.hasQuestFlag('waystone_visit'),
        isComplete: (pm) => pm.hasQuestFlag('waystone_attuned'),
      },
      {
        id:          'collect_waystone_shard',
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
        label:      'Speak with Samuel Mourne',
        description: 'Return to Samuel\'s tent. He has spoken of an "Awakening."',
        isActive:   (pm) => pm.hasQuestFlag('samuel_awakening'),
        isComplete: (pm) =>
          pm.hasQuestFlag('seers_awakening') || pm.hasQuestFlag('awakening_complete'),
      },
      {
        id:         'seers_awakening_step',
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

  // ═══════════════════════════════════════════════════════════════════════════
  //  WEAPON  (placeholder)
  // ═══════════════════════════════════════════════════════════════════════════

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
  { id: 'tribe',        label: 'Tribe'        },
  { id: 'divine',       label: 'Divine'       },
  { id: 'weapon',       label: 'Weapon'       },
  { id: 'generational', label: 'Generational' },
];

// ── State derivation helpers (used by QuestOverlay) ───────────────────────────

export function getStepState(step, pm) {
  if (step.isComplete(pm)) return 'completed';
  if (step.isActive(pm))   return 'active';
  return 'upcoming';
}

export function getQuestState(quest, pm) {
  if (quest.isPlaceholder) return 'placeholder';
  if (quest.steps.length === 0) return quest.isAvailable(pm) ? 'available' : 'locked';

  const states = quest.steps.map(s => getStepState(s, pm));

  if (states.every(s => s === 'completed'))              return 'completed';
  if (states.some(s => s === 'active' || s === 'completed')) return 'active';
  if (quest.isAvailable(pm))                             return 'available';
  return 'locked';
}
