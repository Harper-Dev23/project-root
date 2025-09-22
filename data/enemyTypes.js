export const ENEMY_TYPES = {
  training_dummy: {
    skin: 'dummy_portrait',
    maxHP: 20,
    maxMP: 0,
    skills: ["dummy_sway"],
    aiProfile: 'passive_sway',
    isEnemy: true,
    actionsLeft: { major: 1, bonus: 1, class: 1, reaction: 1 },
  },

  moving_dummy: {
    skin: 'dummy_portrait',
    maxHP: 30,
    maxMP: 0,
    skills: ["dummy_shuffle"], 
    aiProfile: 'skirmisher',
    isEnemy: true,
    actionsLeft: { major: 1, bonus: 1, class: 1, reaction: 1 },
  },

armed_soldier: {
  skin: 'soldier_portrait',
  maxHP: 400,   // boosted for testing
  maxMP: 100,   // boosted for testing
  skills: ["basic_attack", "step_forward"],
  aiProfile: 'soldier_basic',
  isEnemy: true,
  actionsLeft: { major: 1, bonus: 1, class: 1, reaction: 1 },
  weaponType: 'sword_1h',

  stats: {
    evasion: 0,
    accuracy: 0,
    initiative: 12   // base initiative for turn order
  },
  derived: {
    Evasion: 0,
    Accuracy: 0,
    Initiative: 12   // used in turn order, Cold T1 penalty applies here
  }
},

  savage_beast: {
    skin: 'beast_portrait',
    maxHP: 50,
    maxMP: 20,
    skills: ["bite", "claw"], // Placeholder skills
    aiProfile: 'beast_mauler',
    isEnemy: true,
    actionsLeft: { major: 1, bonus: 1, class: 1, reaction: 1 },
  }
};
