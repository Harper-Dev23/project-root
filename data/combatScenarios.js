export const COMBAT_SCENARIOS = {
  training_easy_1: {
    name: "Basic Training I",
    description: "Three stationary dummies to test your skills.",
    longDescription: "This first stage of training pits you against three completely stationary practice dummies. A safe way to get comfortable with movement, targeting, and basic attacks without the risk of taking damage.",
    portraitKey: "dummy_portrait",
    enemies: [
      { type: "training_dummy", slotId: 3, hp: 20 },
      { type: "training_dummy", slotId: 4, hp: 20 },
      { type: "training_dummy", slotId: 5, hp: 20 },
      { type: "training_dummy", slotId: 6, hp: 20 },
      { type: "training_dummy", slotId: 7, hp: 20 }
    ]
  },

  training_easy_2: {
    name: "Basic Training II",
    description: "Slightly sturdier dummies for extended practice.",
    longDescription: "A continuation of your basic training. The dummies here are reinforced...",
    portraitKey: "dummy_portrait",
    enemies: [
      { type: "moving_dummy", slotId: 5, hp: 30 },
      { type: "moving_dummy", slotId: 6, hp: 30 },
      { type: "moving_dummy", slotId: 7, hp: 30 }
    ]
  },

  training_medium_1: {
    name: "Moving Targets I",
    description: "Dummies that can move around to avoid attacks.",
    longDescription: "These dummies have been mounted on mobile stands, allowing them to sway or roll out of your strikes. Accuracy and timing become more important here.",
    portraitKey: "dummy_portrait",
    enemies: [
      { type: "moving_dummy", slotId: 5, hp: 30 },
      { type: "moving_dummy", slotId: 6, hp: 30 },
      { type: "moving_dummy", slotId: 7, hp: 30 }
    ]
  },

  training_medium_2: {
    name: "Moving Targets II",
    description: "Faster and tougher moving targets.",
    longDescription: "The moving targets here are quicker and more resilient. You’ll need to combine your positioning skills with sustained damage output to bring them down.",
    portraitKey: "dummy_portrait",
    enemies: [
      { type: "moving_dummy", slotId: 5, hp: 35 },
      { type: "moving_dummy", slotId: 6, hp: 35 },
      { type: "moving_dummy", slotId: 7, hp: 35 }
    ]
  },

  training_hard: {
    name: "Armed Opponents",
    description: "Training soldiers that fight back.",
    longDescription: "This is no longer passive target practice. These soldiers will engage with basic combat skills, blocking and striking when the opportunity arises. Treat them with caution.",
    portraitKey: "soldier_portrait",
    enemies: [
      { type: "armed_soldier", slotId: 1},
      { type: "armed_soldier", slotId: 2},
      { type: "armed_soldier", slotId: 6}
    ]
  },

  training_savage: {
    name: "Savage Arena",
    description: "Dangerous foes to truly test your limits.",
    longDescription: "This is the ultimate training challenge. Savage beasts with powerful attacks and high endurance will push your skills to the breaking point. Victory here marks you as a true combatant.",
    portraitKey: "beast_portrait",
    enemies: [
      { type: "savage_beast", slotId: 5, hp: 50 },
      { type: "savage_beast", slotId: 6, hp: 50 },
      { type: "savage_beast", slotId: 7, hp: 50 }
    ]
  }
};
