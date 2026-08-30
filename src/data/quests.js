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
        description: 'Visit the vendor row and prepare your party for the trials ahead.',
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
        description: 'Return to the Combat Pit. Your tribe is watching.',
        isActive:   (pm) => pm.tribe !== null && !sc(pm, 'training_encounter_2'),
        isComplete: (pm) => sc(pm, 'training_encounter_2'),
      },
      {
        id:          'lr_elder_bonepile',
        flags:          ['elder_bonepile'],
        label:       'Return to the Elder',
        description: 'The elder has knowledge to share about the Bone Pile and its risks.',
        isActive:   (pm) => pm.hasQuestFlag('elder_bonepile'),
        isComplete: (pm) => sc(pm, 'training_encounter_2') && !pm.hasQuestFlag('elder_bonepile'),
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
        isActive:   (pm) => pm.hasQuestFlag('samuel_mourne'),
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

  // ═══════════════════════════════════════════════════════════════════════════
  //  WEAPON
  // ═══════════════════════════════════════════════════════════════════════════

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
        isActive:   (pm) =>
          pm.hasQuestFlag('bloodthirster_quest') &&
          !pm.hasQuestFlag('bloodthirster_elder_visit') &&
          !pm.hasQuestFlag('bloodthirster_elder_explained'),
        isComplete: (pm) =>
          pm.hasQuestFlag('bloodthirster_elder_visit') || pm.hasQuestFlag('bloodthirster_elder_explained'),
      },
      {
        id:          'bt_intro_elder',
        flags:          ['bloodthirster_elder_visit'],
        label:       "Visit the Elders' Tower — Floor 2",
        description: 'The Elders study relics of power. Bring the blade to the second floor and see what they make of it.',
        isActive:   (pm) => pm.hasQuestFlag('bloodthirster_elder_visit'),
        isComplete: (pm) => pm.hasQuestFlag('bloodthirster_elder_explained'),
      },
      {
        id:          'bt_intro_reinspect',
        label:       'Re-inspect the Bloodthirster',
        description: 'Now that the Elders have explained what you hold — inspect the blade again. Read its history.',
        isActive:   (pm) =>
          pm.hasQuestFlag('bloodthirster_elder_explained') &&
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

  // Was `states.some(active || completed) -> 'active'`, checked before this
  // — that treated "some steps completed, nothing currently active, the
  // rest still upcoming/not yet unlocked" (e.g. Blood and Soil between
  // finishing the tribe-vendor step and one of the four leader-brief flags
  // actually firing) as still "Active", even though there's nothing for the
  // player to act on right now. Checking active FIRST, then falling back to
  // completed-if-any, puts that gap in the Completed section instead —
  // nothing left to do currently reads the same as fully done, and a
  // genuinely-in-progress quest (an actual active step) is unaffected.
  if (states.some(s => s === 'active'))    return 'active';
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
