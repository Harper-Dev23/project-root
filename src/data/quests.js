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

const TRIBE_LEADER_FLAGS = {
  elseth: 'elseth_leader_challenge',
  styx:   'styx_leader_challenge',
  lesse:  'lesse_leader_challenge',
  zafaar: 'zafaar_leader_challenge',
};
const TRIBE_LEADER_SCENARIOS = {
  elseth: 'training_encounter_2',
  styx:   'training_encounter_3',
  lesse:  'training_encounter_4',
  zafaar: 'training_encounter_5',
};

const tribeLeaderFlag     = (pm) => pm.tribe ? TRIBE_LEADER_FLAGS[pm.tribe]     : null;
const tribeLeaderScenario = (pm) => pm.tribe ? TRIBE_LEADER_SCENARIOS[pm.tribe] : null;

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
        id:          'prologue_elder',
        label:       'Speak with the Elder',
        description: 'A wise elder waits in the tower at the heart of camp. Heed their counsel before venturing further.',
        isActive:   (pm) => pm.hasQuestFlag('orientation_elder'),
        // Complete if the flag is gone and the game has moved on (vendor_row or
        // later flags confirm the elder visit happened).
        isComplete: (pm) =>
          !pm.hasQuestFlag('orientation_elder') && (
            pm.hasQuestFlag('vendor_row')  ||
            pm.hasQuestFlag('tribe_choice') ||
            pm.tribe !== null              ||
            sc(pm, 'training_encounter_1')
          ),
      },
      {
        id:          'prologue_first_trial',
        label:       'Enter the Combat Pit',
        description: 'Prove your party\'s mettle in the Combat Pit. The elder expects results.',
        isActive:   (pm) => !sc(pm, 'training_encounter_1') && !pm.hasQuestFlag('orientation_elder'),
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
    description: 'Every recruit must choose their tribe. Explore the lodges before pledging your allegiance — this decision is permanent.',
    isAvailable: (pm) => sc(pm, 'training_encounter_1'),
    steps: [
      {
        id:          'bas_choose_tribe',
        label:       'Choose Your Tribe',
        description: 'Visit the four lodges — Styx, Zafaar, Elseth, and Le\'sse — then return to the Elder\'s Tower to pledge.',
        isActive:   (pm) => pm.hasQuestFlag('tribe_choice') || anyLodgeFlag(pm),
        isComplete: (pm) => pm.tribe !== null,
      },
      {
        id:          'bas_tribe_vendor',
        label:       'Visit the Tribe Vendor',
        description: 'Your tribe grants access to exclusive wares. Spend your Tribe Ticket at the tribe vendor row.',
        isActive:   (pm) => pm.tribe !== null && pm.hasQuestFlag('tribe_vendor'),
        isComplete: (pm) => pm.tribe !== null && !pm.hasQuestFlag('tribe_vendor'),
      },
      {
        id:          'bas_leader_challenge',
        label:       'Answer Your Leader\'s Call',
        description: 'Your tribe\'s leader has taken notice of your efforts. Seek them out and prove your worth.',
        isActive:   (pm) => {
          const flag = tribeLeaderFlag(pm);
          return flag ? pm.hasQuestFlag(flag) : false;
        },
        isComplete: (pm) => {
          const flag = tribeLeaderFlag(pm);
          const req  = tribeLeaderScenario(pm);
          if (!flag || !req) return false;
          return sc(pm, req) && !pm.hasQuestFlag(flag);
        },
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  //  DIVINE  (placeholder)
  // ═══════════════════════════════════════════════════════════════════════════

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
