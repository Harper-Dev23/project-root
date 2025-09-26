export const ENEMY_TYPES = {
  stationary_training_dummy: {
    skin: 'dummy_portrait',
    maxHP: 25,
    maxMP: 0,
    skills: ['dummy_sway'],
    aiProfile: 'stationary_dummy',
    isEnemy: true,
    actionsLeft: { major: 1, bonus: 1, class: 1, reaction: 1 },
  },

  stationary_training_dummy_elite: {
    skin: 'dummy_portrait',
    maxHP: 40,
    maxMP: 0,
    skills: ['dummy_sway'],
    aiProfile: 'stationary_dummy',
    isEnemy: true,
    actionsLeft: { major: 1, bonus: 1, class: 1, reaction: 1 },
  },

  training_warmup_dummy: {
    skin: 'dummy_portrait',
    maxHP: 90,
    maxMP: 30,
    skills: ['dummy_sway', 'warmup_swing', 'warmup_patch'],
    aiProfile: 'warmup_dummy',
    isEnemy: true,
    actionsLeft: { major: 1, bonus: 1, class: 1, reaction: 1 },
  },

  training_defender_dummy: {
    skin: 'dummy_portrait',
    maxHP: 110,
    maxMP: 40,
    skills: ['defender_guard_raise', 'defender_taunt', 'defender_small_heal'],
    aiProfile: 'defensive_dummy',
    isEnemy: true,
    actionsLeft: { major: 1, bonus: 1, class: 1, reaction: 1 },
  },

  training_offender_dummy: {
    skin: 'dummy_portrait',
    maxHP: 85,
    maxMP: 30,
    skills: ['offender_expose_strike', 'dummy_shuffle'],
    aiProfile: 'offensive_dummy',
    isEnemy: true,
    actionsLeft: { major: 1, bonus: 1, class: 1, reaction: 1 },
  },

  animated_fighter_dummy: {
    skin: 'soldier_portrait',
    maxHP: 180,
    maxMP: 60,
    skills: ['fighter_heavy_slash', 'fighter_guarded_blow', 'fighter_taunt', 'fighter_executioner'],
    aiProfile: 'fighter_dummy',
    isEnemy: true,
    actionsLeft: { major: 1, bonus: 1, class: 1, reaction: 1 },
  },

  animated_healer_dummy: {
    skin: 'priest_portrait',
    maxHP: 140,
    maxMP: 120,
    skills: ['healer_heal', 'healer_cleanse', 'healer_blessing', 'healer_flame_flick'],
    aiProfile: 'healer_dummy',
    isEnemy: true,
    actionsLeft: { major: 1, bonus: 1, class: 1, reaction: 1 },
  },

  animated_warlock_dummy: {
    skin: 'warlock_portrait',
    maxHP: 130,
    maxMP: 120,
    skills: ['warlock_hex', 'warlock_dark_bolts', 'warlock_curse_amplify', 'warlock_drain_life'],
    aiProfile: 'warlock_dummy',
    isEnemy: true,
    actionsLeft: { major: 1, bonus: 1, class: 1, reaction: 1 },
  },

  animated_ranger_dummy: {
    skin: 'ranger_portrait',
    maxHP: 150,
    maxMP: 80,
    skills: ['ranger_quick_shot', 'ranger_frost_arrow', 'ranger_volley', 'ranger_aimed_shot'],
    aiProfile: 'ranger_dummy',
    isEnemy: true,
    actionsLeft: { major: 1, bonus: 1, class: 1, reaction: 1 },
  },

  animated_rogue_dummy: {
    skin: 'rogue_portrait',
    maxHP: 140,
    maxMP: 70,
    skills: ['rogue_poisoned_knife', 'rogue_hamstring', 'rogue_evasion', 'rogue_sneak_attack', 'rogue_finishing_strike'],
    aiProfile: 'rogue_dummy',
    isEnemy: true,
    actionsLeft: { major: 1, bonus: 1, class: 1, reaction: 1 },
  },

  huntsman_commander: {
    skin: 'hunter_portrait',
    maxHP: 220,
    maxMP: 100,
    skills: ['huntsman_mark', 'huntsman_command', 'huntsman_trap_shot', 'huntsman_empower_pack'],
    aiProfile: 'huntsman',
    isEnemy: true,
    actionsLeft: { major: 1, bonus: 1, class: 1, reaction: 1 },
  },


  beast_oskar: {
    skin: 'beast_portrait',
    maxHP: 260,
    maxMP: 60,
    skills: ['oskar_rending_bite', 'oskar_infectious_claw', 'oskar_maw_rip', 'oskar_rotting_maw'],
    aiProfile: 'oskar_beast',
    isEnemy: true,
    tags: ['beast'],
    actionsLeft: { major: 1, bonus: 1, class: 1, reaction: 1 },
  },

  beast_kiro: {
    skin: 'beast_portrait',
    maxHP: 220,
    maxMP: 80,
    skills: ['kiro_toxic_spit', 'kiro_venomous_swipe', 'kiro_poison_cloud', 'kiro_corrosive_bite'],
    aiProfile: 'kiro_beast',
    isEnemy: true,
    tags: ['beast'],
    actionsLeft: { major: 1, bonus: 1, class: 1, reaction: 1 },
  },

  fire_duelist: {
    skin: 'fire_duelist',
    maxHP: 260,
    maxMP: 120,
    skills: ['fire_flame_slash', 'fire_heated_guard', 'fire_burst', 'fire_flare_wave'],
    aiProfile: 'fire_duelist',
    isEnemy: true,
    actionsLeft: { major: 1, bonus: 1, class: 1, reaction: 1 },
  },

  ice_duelist: {
    skin: 'ice_duelist',
    maxHP: 260,
    maxMP: 120,
    skills: ['ice_frost_strike', 'ice_icy_guard', 'ice_freeze_point', 'ice_shard_storm'],
    aiProfile: 'ice_duelist',
    isEnemy: true,
    actionsLeft: { major: 1, bonus: 1, class: 1, reaction: 1 },
  },

  berserker_boss: {
    skin: 'berserker_portrait',
    maxHP: 420,
    maxMP: 150,
    skills: [
      'berserker_crushing_blow',
      'berserker_disrupting_roar',
      'berserker_bleeding_sweep',
      'berserker_guarded_fury',
      'berserker_battle_frenzy',
      'berserker_death_spiral',
      'berserker_unstoppable_rush',
      'berserker_blood_fury'
    ],
    aiProfile: 'berserker_boss',
    isEnemy: true,
    actionsLeft: { major: 1, bonus: 1, class: 1, reaction: 1 },
  }
};
