export const ENEMY_TYPES = {
  stationary_training_dummy: {
    name: 'Training Dummy',
    skin: 'dummy_portrait',
    maxHP: 10,
    maxMP: 0,
    baseStats: { STR: 5, DEX: 5, CON: 5, INT: 5, WIS: 5, CHA: 5 },
    skills: ['dummy_sway'],
    aiProfile: 'stationary_dummy',
    isEnemy: true,
    actionsLeft: { major: 1, bonus: 1, class: 1, reaction: 1 },
  },

  mobile_training_dummy_elite: {
    skin: 'dummy_portrait',
    maxHP: 20,
    maxMP: 0,
    baseStats: { STR: 5, DEX: 5, CON: 5, INT: 5, WIS: 5, CHA: 5 },
    // Still deals no damage — the only new element vs the basic dummy is
    // movement, to teach range/AOE shapes (Basic Training II). No typed
    // damage pipeline needed since it never attacks — baseStats here just
    // gives it real Evasion/Resist/etc. instead of an implicit zero.
    skills: ['dummy_sway', 'dummy_shuffle'],
    aiProfile: 'mobile_dummy',
    isEnemy: true,
    actionsLeft: { major: 1, bonus: 1, class: 1, reaction: 1 },
  },

  // Encounter 3's six dummies — same average (8 across all 6 core stats,
  // sum 48) but skewed per class archetype, matching how a real party
  // member of that class would be built. Weapon (crude/common tier,
  // soulbound) is equipped via combatScenarios.js's drops array, same
  // fixed-item pattern berserker_boss uses for its own weapon.
  animated_fighter_dummy: {
    skin: 'dummy_portrait_equipped_fighter',
    maxHP: 135,
    maxMP: 60,
    baseStats: { STR: 10, DEX: 6, CON: 12, INT: 5, WIS: 6, CHA: 9 },
    // Chad — natural 30% Physical Damage Reduction (Expose/Lacerate/Disorient
    // buildup is the intended way through it, not raw physical damage).
    derivedBonus: { PhysicalResist: 30 },
    // dummy_sway (also encounters 1/2's whole kit) is the no-MP fallback —
    // fighter_dummy's AI profile reaches for it once nothing else is
    // affordable, instead of falling through to the generic fallback picker
    // and spamming "lacks the MP" trying real skills.
    skills: ['fighter_heavy_slash', 'fighter_guarded_blow', 'fighter_taunt', 'fighter_executioner', 'fighter_guardians_stand', 'fighter_bulwark_call', 'dummy_sway'],
    aiProfile: 'fighter_dummy',
    isEnemy: true,
    actionsLeft: { major: 1, bonus: 1, class: 1, reaction: 1 },
  },

  animated_healer_dummy: {
    skin: 'dummy_portrait_equipped_healer',
    maxHP: 105,
    maxMP: 120,
    baseStats: { STR: 5, DEX: 5, CON: 8, INT: 6, WIS: 14, CHA: 10 },
    // Stan — +4 flat MP/turn on top of his already-high WIS/CHA regen, same
    // mechanism berserker_boss's mpRegenPerTurn uses.
    mpRegenPerTurn: 4,
    skills: ['healer_heal', 'healer_cleanse', 'healer_blessing', 'healer_flame_flick', 'healer_mending_wave', 'dummy_sway'],
    aiProfile: 'healer_dummy',
    isEnemy: true,
    actionsLeft: { major: 1, bonus: 1, class: 1, reaction: 1 },
  },

  animated_warlock_dummy: {
    skin: 'dummy_portrait_equipped_warlock',
    maxHP: 98,
    maxMP: 120,
    baseStats: { STR: 5, DEX: 6, CON: 7, INT: 9, WIS: 6, CHA: 15 },
    // Gary — natural 30% Necrotic Damage Reduction (his own curse/necrotic
    // kit shouldn't be the thing that also punches through his own defense).
    derivedBonus: { NecroticResist: 30 },
    skills: ['warlock_hex', 'warlock_dark_bolts', 'warlock_curse_amplify', 'warlock_drain_life', 'warlock_curse_needles', 'warlock_reckless_immolation', 'dummy_sway'],
    aiProfile: 'warlock_dummy',
    isEnemy: true,
    actionsLeft: { major: 1, bonus: 1, class: 1, reaction: 1 },
  },

  animated_ranger_dummy: {
    skin: 'dummy_portrait_equipped_ranger',
    maxHP: 113,
    maxMP: 80,
    baseStats: { STR: 6, DEX: 16, CON: 7, INT: 6, WIS: 7, CHA: 6 },
    // Doug — sharp-eyed marksman, +20 natural Accuracy on top of his DEX.
    derivedBonus: { Accuracy: 20 },
    skills: ['ranger_quick_shot', 'ranger_frost_arrow', 'ranger_volley', 'ranger_aimed_shot', 'ranger_covering_shot', 'dummy_sway'],
    aiProfile: 'ranger_dummy',
    isEnemy: true,
    actionsLeft: { major: 1, bonus: 1, class: 1, reaction: 1 },
  },

  animated_rogue_dummy: {
    skin: 'dummy_portrait_equipped_rogue',
    maxHP: 105,
    maxMP: 70,
    baseStats: { STR: 5, DEX: 14, CON: 6, INT: 6, WIS: 6, CHA: 11 },
    // Mo — +20 natural base Evasion, on top of (and stacking with) his own
    // rogue_evasion buff skill.
    derivedBonus: { Evasion: 20 },
    skills: ['rogue_poisoned_knife', 'rogue_hamstring', 'rogue_evasion', 'rogue_sneak_attack', 'rogue_finishing_strike', 'rogue_distracting_feint', 'rogue_curse_twist', 'dummy_sway'],
    aiProfile: 'rogue_dummy',
    isEnemy: true,
    actionsLeft: { major: 1, bonus: 1, class: 1, reaction: 1 },
  },

  animated_wizard_dummy: {
    skin: 'dummy_portrait_equipped_wizard',
    maxHP: 98,
    maxMP: 110,
    baseStats: { STR: 4, DEX: 6, CON: 7, INT: 16, WIS: 9, CHA: 6 },
    // Lenny — natural 30% Elemental Damage Reduction (Fire/Cold/Lightning
    // buildup is the intended way through his own elemental kit's defense).
    derivedBonus: { ElementalResist: 30 },
    skills: ['wizard_arcane_bolt', 'wizard_static_field', 'wizard_mana_shield', 'wizard_overload', 'wizard_inferno_channel', 'wizard_inferno_release', 'dummy_sway'],
    aiProfile: 'wizard_dummy',
    isEnemy: true,
    actionsLeft: { major: 1, bonus: 1, class: 1, reaction: 1 },
  },

  huntsman_commander: {
    skin: 'portrait_styx_commander',
    // +50% HP across the board for this encounter's three enemies.
    maxHP: 330,
    maxMP: 100,
    // Ranged marksman spread — DEX drives Accuracy, CHA feeds Initiative/gauge
    // regen for Coordinated Volley's initiative-spend gate. Run through
    // calculateDerivedStats() same as every stat-bearing enemy (_placeEnemies).
    baseStats: { STR: 8, DEX: 14, CON: 10, INT: 5, WIS: 6, CHA: 12 },
    // Natural 20% Elemental Damage Reduction — on top of (not from) his
    // equipped green armor set below, same "baked-in" convention as the
    // other encounter 3/4 enemies' derivedBonus fields.
    derivedBonus: { ElementalResist: 20 },
    skills: ['huntsman_mark', 'huntsman_command', 'huntsman_trap_shot', 'huntsman_empower_pack', 'huntsman_coordinated_volley', 'basic_attack'],
    aiProfile: 'huntsman',
    isEnemy: true,
    actionsLeft: { major: 1, bonus: 1, class: 1, reaction: 1 },
  },


  beast_oskar: {
    skin: 'portrait_oskar',
    // +50% HP, same as the other two encounter-4 enemies.
    maxHP: 390,
    maxMP: 60,
    // Brute spread — STR drives weapon damage, CON its own tankiness.
    baseStats: { STR: 16, DEX: 8, CON: 14, INT: 3, WIS: 5, CHA: 4 },
    // Thicker natural hide than Kiro — modest 20% PDR, distinct from Chad's
    // dedicated 30% tank profile in encounter 3. Plus 25 flat Resilience
    // (reduces incoming weakness buildup toward every family).
    derivedBonus: { PhysicalResist: 20, Resilience: 25 },
    skills: ['oskar_rending_bite', 'oskar_infectious_claw', 'oskar_maw_rip', 'oskar_rotting_maw', 'oskar_reflex_bite', 'basic_attack'],
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
    skin: 'portrait_kiro',
    // +50% HP, same as the other two encounter-4 enemies.
    maxHP: 330,
    maxMP: 80,
    // WIS 10→6, CHA 4→8 (same total) — his old very-low CHA meant Molt's
    // initiative-gauge gain was too slow to ever reach 30, especially once
    // Cold (which also drains the gauge) got involved; bumping CHA (and
    // lowering Molt's own gauge requirement below) fixes that.
    baseStats: { STR: 10, DEX: 10, CON: 12, INT: 6, WIS: 6, CHA: 8 },
    // More evasive than Oskar — slippery instead of tanky. Plus natural 20%
    // Necrotic Damage Reduction (his own toxic/disease kit's family). Bumped
    // 20→25 Evasion — he was the most vulnerable of the three.
    derivedBonus: { Evasion: 25, NecroticResist: 20 },
    skills: ['kiro_toxic_spit', 'kiro_venomous_swipe', 'kiro_poison_cloud', 'kiro_corrosive_bite', 'kiro_venom_reflex', 'kiro_molt', 'basic_attack'],
    aiProfile: 'kiro_beast',
    isEnemy: true,
    tags: ['beast'],
    actionsLeft: { major: 1, bonus: 1, class: 1, reaction: 1 },
  },

  // Encounter 5 needs to be harder than encounter 4 despite having only 2
  // bodies (vs. 3) — HP pushed well past a flat scale-up of the old 260, and
  // each duelist gets a real kit: typed damage, an initiative spender, a real
  // reaction (replacing the old dead retaliateFire/retaliateCold data flags,
  // never actually enforced anywhere), and an ENRAGE that fires the moment
  // their twin goes down (see enrageOnAllyDeath, read generically by
  // _onUnitKnockedOut in CombatScene.js).
  fire_duelist: {
    skin: 'portrait_lesse_duelist_fire',
    maxHP: 420,
    maxMP: 130,
    // Aggressive glass-cannon spread — STR for weapon damage, CHA for
    // Initiative/gauge regen (Inferno Surge's spend gate).
    baseStats: { STR: 14, DEX: 10, CON: 10, INT: 6, WIS: 4, CHA: 12 },
    // Fire resists Elemental broadly (his own family), plus real Resilience
    // like every other encounter-4/5 named enemy now gets.
    derivedBonus: { ElementalResist: 20, Resilience: 20 },
    skills: ['fire_flame_slash', 'fire_heated_guard', 'fire_burst', 'fire_flare_wave', 'ember_fire_ward', 'ember_inferno_surge', 'ember_flame_retaliation', 'basic_attack'],
    aiProfile: 'fire_duelist',
    isEnemy: true,
    tags: ['duelist'],
    actionsLeft: { major: 1, bonus: 1, class: 1, reaction: 1 },
    // If Rime falls first, Ember enrages: a bigger permanent buff (Resilience
    // 20+20=40 total, since duelist_fury's mods add to the base derivedBonus
    // rather than replacing it), an unlocked stronger finisher
    // (ember_wildfire_unleashed), AND her regular Flame Slash starts hitting
    // the whole field instead of one target (checked directly in its own
    // apply()) — the enrage touches her existing kit, not just a bolted-on
    // extra move.
    enrageOnAllyDeath: {
      statusId: 'duelist_fury',
      mods: { AttackPower: 30, CritChance: 15, Resilience: 20 },
      unlockSkills: ['ember_wildfire_unleashed'],
    },
  },

  ice_duelist: {
    skin: 'portrait_lesse_duelist_ice',
    maxHP: 420,
    maxMP: 130,
    // Controlled/defensive spread — DEX for Accuracy, WIS for Initiative
    // (via CharacterBuilder's derived formula) and MP.
    baseStats: { STR: 10, DEX: 14, CON: 10, INT: 6, WIS: 12, CHA: 4 },
    // Ice resists Physical broadly (frozen carapace), plus real Resilience.
    derivedBonus: { PhysicalResist: 20, Resilience: 20 },
    skills: ['ice_frost_strike', 'ice_icy_guard', 'ice_freeze_point', 'ice_shard_storm', 'rime_cold_ward', 'rime_absolute_zero', 'rime_frost_retaliation', 'basic_attack'],
    aiProfile: 'ice_duelist',
    isEnemy: true,
    tags: ['duelist'],
    actionsLeft: { major: 1, bonus: 1, class: 1, reaction: 1 },
    // If Ember falls first, Rime enrages the same way, in kind.
    enrageOnAllyDeath: {
      statusId: 'duelist_fury',
      mods: { AttackPower: 30, CritChance: 15, Resilience: 20 },
      unlockSkills: ['rime_eternal_frost'],
    },
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
