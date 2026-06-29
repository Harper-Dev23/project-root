export const COMBAT_SCENARIOS = {
  training_encounter_1: {
    name: 'Basic Training I',
    description: 'Five stationary dummies for safe sparring.',
    longDescription: 'Start with fundamentals against practice dummies that simply sway in place. Perfect for verifying positioning, targeting and basic skill flow with no incoming pressure.',
    portraitKey: 'dummy_portrait',
    enemies: [
      { type: 'stationary_training_dummy', slotId: 3 },
      { type: 'stationary_training_dummy', slotId: 4 },
      { type: 'stationary_training_dummy', slotId: 5 },
      { type: 'stationary_training_dummy', slotId: 6 },
      { type: 'stationary_training_dummy', slotId: 7 }
    ]
  },

  training_encounter_2: {
    name: 'Basic Training II',
    description: 'Reinforced stationary dummies built for longer drills.',
    longDescription: 'These sturdier targets remain fixed in place so you can focus on rotations, weakness application tests and UI exercises without reactive behaviour from the enemy side.',
    portraitKey: 'dummy_portrait',
    enemies: [
      { type: 'stationary_training_dummy_elite', slotId: 4 },
      { type: 'stationary_training_dummy_elite', slotId: 5 },
      { type: 'stationary_training_dummy_elite', slotId: 6 },
      { type: 'stationary_training_dummy_elite', slotId: 7 },
      { type: 'stationary_training_dummy_elite', slotId: 8 }
    ]
  },

  training_encounter_3: {
    name: 'Animated Party Test',
    description: 'Five animated dummies demonstrating classic RPG roles.',
    longDescription: 'A coordinated team of training constructs—fighter, healer, warlock, ranger and rogue—showcases weakness synergies, payoffs and interlocking behaviour.',
    portraitKey: 'dummy_party',
    enemies: [
      { type: 'animated_fighter_dummy', slotId: 1, drops: [{ equip: 'chest', droppable: true }] },
      { type: 'animated_healer_dummy',  slotId: 5, drops: [{ equip: 'chest', droppable: true }] },
      { type: 'animated_warlock_dummy', slotId: 7, drops: [{ equip: 'chest', droppable: true }] },
      { type: 'animated_ranger_dummy',  slotId: 6, drops: [{ equip: 'chest', droppable: true }] },
      { type: 'animated_rogue_dummy',   slotId: 2, drops: [{ equip: 'chest', droppable: true }] }
    ]
  },

  training_encounter_4: {
    name: 'Huntsman & Beasts',
    description: 'Coordinate against a huntsman commander and his beasts.',
    longDescription: 'A ranged huntsman marks targets and directs two beasts—Oskar the ripper and Kiro the venom-spewer. Expect layered weaknesses, coordinated bursts and pack-wide buffs.',
    portraitKey: 'hunter_portrait',
    enemies: [
      { type: 'huntsman_commander', slotId: 8 },
      { type: 'beast_oskar', slotId: 2 },
      { type: 'beast_kiro', slotId: 3 }
    ]
  },

  training_encounter_5: {
    name: 'Elemental Duelists',
    description: 'Battle elite fire and ice duelists leveraging elemental reactions.',
    longDescription: 'Two elite duelists wield opposing elements. They coordinate Fire and Cold buildup to trigger Thermal Shock-style payoffs and field-wide bursts.',
    portraitKey: 'elemental_duelists',
    enemies: [
      { type: 'fire_duelist', slotId: 2 },
      { type: 'ice_duelist', slotId: 3 }
    ]
  },

  training_encounter_6: {
    name: 'Berserker Boss',
    description: 'A relentless foe with wide coverage and reactionary strikes.',
    longDescription: 'The berserker stresses every system: high initiative generation, layered weaknesses and punishing reactions. Survive the rush, manage his initiative and plan around Death Spiral.',
    portraitKey: 'berserker_portrait',
    enemies: [
      { type: 'berserker_boss', slotId: 2 }
    ]
  },

  // === Hunt encounters (placeholder — no real enemy roster yet) ===
  hunt_beast_solo: {
    name: 'Beast Encounter',
    description: 'A lone beast blocks the path.',
    portraitKey: 'beast_portrait',
    enemies: [
      { type: 'hunt_beast_lesser', slotId: 2 }
    ]
  },

  hunt_cultist_solo: {
    name: 'Cultist Ambush',
    description: 'A lone cultist springs from cover.',
    portraitKey: 'soldier_portrait',
    enemies: [
      { type: 'hunt_cultist_lesser', slotId: 2, drops: [{ equip: 'chest', droppable: true }] }
    ]
  },

  hunt_beast_marked: {
    name: 'Marked Beast',
    description: 'A beast bearing a faint sacred mark blocks the path.',
    portraitKey: 'beast_portrait',
    enemies: [
      { type: 'hunt_beast_marked', slotId: 2 }
    ]
  },

  hunt_cultist_acolyte: {
    name: 'Cultist Acolyte',
    description: 'A lone acolyte strikes from the shadows.',
    portraitKey: 'rogue_portrait',
    enemies: [
      { type: 'hunt_cultist_acolyte', slotId: 2, drops: [{ equip: 'chest', droppable: true }] }
    ]
  }
};
