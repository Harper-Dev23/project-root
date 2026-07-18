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

  mobile_training_dummy_elite: {
    skin: 'dummy_portrait',
    maxHP: 40,
    maxMP: 0,
    // Still deals no damage — the only new element vs the basic dummy is
    // movement, to teach range/AOE shapes (Basic Training II).
    skills: ['dummy_sway', 'dummy_shuffle'],
    aiProfile: 'mobile_dummy',
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
    skin: 'dummy_portrait_equipped_fighter',
    maxHP: 180,
    maxMP: 60,
    skills: ['fighter_heavy_slash', 'fighter_guarded_blow', 'fighter_taunt', 'fighter_executioner'],
    aiProfile: 'fighter_dummy',
    isEnemy: true,
    actionsLeft: { major: 1, bonus: 1, class: 1, reaction: 1 },
  },

  animated_healer_dummy: {
    skin: 'dummy_portrait_equipped_healer',
    maxHP: 140,
    maxMP: 120,
    skills: ['healer_heal', 'healer_cleanse', 'healer_blessing', 'healer_flame_flick'],
    aiProfile: 'healer_dummy',
    isEnemy: true,
    actionsLeft: { major: 1, bonus: 1, class: 1, reaction: 1 },
  },

  animated_warlock_dummy: {
    skin: 'dummy_portrait_equipped_warlock',
    maxHP: 130,
    maxMP: 120,
    skills: ['warlock_hex', 'warlock_dark_bolts', 'warlock_curse_amplify', 'warlock_drain_life'],
    aiProfile: 'warlock_dummy',
    isEnemy: true,
    actionsLeft: { major: 1, bonus: 1, class: 1, reaction: 1 },
  },

  animated_ranger_dummy: {
    skin: 'dummy_portrait_equipped_ranger',
    maxHP: 150,
    maxMP: 80,
    skills: ['ranger_quick_shot', 'ranger_frost_arrow', 'ranger_volley', 'ranger_aimed_shot'],
    aiProfile: 'ranger_dummy',
    isEnemy: true,
    actionsLeft: { major: 1, bonus: 1, class: 1, reaction: 1 },
  },

  animated_rogue_dummy: {
    skin: 'dummy_portrait_equipped_rogue',
    maxHP: 140,
    maxMP: 70,
    skills: ['rogue_poisoned_knife', 'rogue_hamstring', 'rogue_evasion', 'rogue_sneak_attack', 'rogue_finishing_strike'],
    aiProfile: 'rogue_dummy',
    isEnemy: true,
    actionsLeft: { major: 1, bonus: 1, class: 1, reaction: 1 },
  },

  animated_wizard_dummy: {
    skin: 'dummy_portrait_equipped_wizard',
    maxHP: 130,
    maxMP: 110,
    skills: ['wizard_arcane_bolt', 'wizard_static_field', 'wizard_mana_shield', 'wizard_overload'],
    aiProfile: 'wizard_dummy',
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

  // Placeholder Hunt-zone enemies — single-skill, low HP, just enough to be
  // a real (short, low-stakes) fight while no real Hunt enemy roster exists yet.
  hunt_beast_lesser: {
    skin: 'beast_portrait',
    maxHP: 70,
    maxMP: 20,
    skills: ['oskar_rending_bite'],
    aiProfile: 'oskar_beast',
    isEnemy: true,
    tags: ['beast'],
    actionsLeft: { major: 1, bonus: 1, class: 1, reaction: 1 },
  },

  hunt_cultist_lesser: {
    skin: 'soldier_portrait',
    maxHP: 80,
    maxMP: 30,
    skills: ['fighter_heavy_slash'],
    aiProfile: 'fighter_dummy',
    isEnemy: true,
    tags: ['cultist'],
    actionsLeft: { major: 1, bonus: 1, class: 1, reaction: 1 },
  },

  // A second roll of variety for each Hunt fight type — same placeholder
  // tier as the "lesser" variants above (low HP, one borrowed skill), just
  // a different look/feel so fights aren't always the same two enemies.
  hunt_beast_marked: {
    skin: 'beast_portrait',
    maxHP: 90,
    maxMP: 30,
    skills: ['kiro_toxic_spit'],
    aiProfile: 'kiro_beast',
    isEnemy: true,
    tags: ['beast'],
    actionsLeft: { major: 1, bonus: 1, class: 1, reaction: 1 },
  },

  hunt_cultist_acolyte: {
    skin: 'rogue_portrait',
    maxHP: 70,
    maxMP: 40,
    skills: ['rogue_poisoned_knife'],
    aiProfile: 'rogue_dummy',
    isEnemy: true,
    tags: ['cultist'],
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
    // Flat per-turn MP regen (see _placeEnemies in CombatScene.js) — his
    // whole kit costs MP with no free option otherwise, so he'd eventually
    // run dry and stop acting entirely without this. Stacks additively with
    // the INT-derived regen from baseStats below (small, ~+1 at INT 8).
    mpRegenPerTurn: 12,
    // Blunt overall damage dial — every ability he has deals 80% damage,
    // without touching his base stats or Bloodthirster. A quick lever while
    // he's still overtuned post-stat-rework, not a real balance pass.
    damageMultiplierPct: -20,
    // Core stats — run through the same calculateDerivedStats() players use
    // (see _placeEnemies), so these actually drive his weapon damage
    // (STR), HP (CON), Initiative/gauge regen (CHA), MP (INT/WIS/CHA),
    // Proficiency (highest of the six), and resists, on top of whatever his
    // equipped gear (Bloodthirster: +5 STR/+4 CON) adds. Traditional brute
    // spread — high STR/CON, everything else baseline-to-low, CHA nudged up
    // over INT/WIS so Initiative and MP regen have some real footing.
    baseStats: { STR: 20, DEX: 10, CON: 16, INT: 8, WIS: 8, CHA: 12 },
    skills: [
      'berserker_reckless_strike',
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
    // Lifesteal used to be a flat hardcoded stat here ("wields the
    // Bloodthirster" was just a comment — nothing actually equipped it).
    // Now genuinely tied to the Bloodthirster weapon via the scenario's
    // drops config (combatScenarios.js) + _equipEnemyItem's gearEffects
    // handling, so this template no longer needs its own copy of the number.
  }
};
