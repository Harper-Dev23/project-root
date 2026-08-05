export const COMBAT_SCENARIOS = {
  training_encounter_1: {
    name: 'Basic Training I',
    description: 'Six stationary dummies for safe sparring.',
    longDescription: 'Start with fundamentals against practice dummies that simply sway in place. Perfect for verifying positioning, targeting and basic skill flow with no incoming pressure.',
    portraitKey: 'dummy_portrait',
    enemies: [
      { type: 'stationary_training_dummy', slotId: 2 },
      { type: 'stationary_training_dummy', slotId: 3 },
      { type: 'stationary_training_dummy', slotId: 4 },
      { type: 'stationary_training_dummy', slotId: 5 },
      { type: 'stationary_training_dummy', slotId: 6 },
      { type: 'stationary_training_dummy', slotId: 7 }
    ]
  },

  training_encounter_2: {
    name: 'Basic Training II',
    description: 'Six reinforced dummies that shuffle around — practice range and AOE shapes.',
    longDescription: 'These sturdier targets deal no damage but move erratically and dodge out of ground hazards, giving you a safe way to practice range, positioning, and AOE shapes before facing anything that hits back.',
    portraitKey: 'dummy_portrait',
    enemies: [
      { type: 'mobile_training_dummy_elite', slotId: 3, name: 'Dummy Lenny' },
      { type: 'mobile_training_dummy_elite', slotId: 4, name: 'Dummy Gary' },
      { type: 'mobile_training_dummy_elite', slotId: 5, name: 'Dummy Stan' },
      { type: 'mobile_training_dummy_elite', slotId: 6, name: 'Dummy Doug' },
      { type: 'mobile_training_dummy_elite', slotId: 7, name: 'Dummy Mo' },
      { type: 'mobile_training_dummy_elite', slotId: 8, name: 'Dummy Chad' }
    ]
  },

  training_encounter_3: {
    name: 'The Animated Six',
    description: 'Chad, Stan, Gary, Doug, Mo, and Lenny — six animated constructs covering every classic RPG role, with real tactics instead of scripted swings.',
    longDescription: 'Six training constructs animated into distinct classes: Chad tanks and can redirect a blow onto himself, Stan channels genuine healing magic across the party, Gary and Lenny fight with the same layered tactics a real caster would use, and Doug and Mo react the instant an ally is struck — Mo with a curse that saps your next attack. Expect real synergy and payoffs, not six copies of the same dummy.',
    portraitKey: 'dummy_portrait_equipped_fighter',
    // Same six dummies as encounter 2 (Lenny/Gary/Stan/Doug/Mo/Chad),
    // repurposed and geared up — names carried over so the crowd (Local
    // tab) can recognize them as the same characters growing into these
    // roles, not a fresh anonymous roster.
    enemies: [
      { type: 'animated_fighter_dummy', slotId: 1, name: 'Chad the Unbreakable', drops: [
        { equip: 'weaponMain', itemId: 'crude_sword_1h', rarity: 'common', rollAffixes: false, droppable: false },
        { equip: 'head', droppable: true },
      ] },
      { type: 'animated_healer_dummy',  slotId: 5, name: 'Stan, of the Light',   drops: [
        { equip: 'weaponMain', itemId: 'crude_staff', rarity: 'common', rollAffixes: false, droppable: false },
        { equip: 'head', droppable: true },
      ] },
      { type: 'animated_warlock_dummy', slotId: 7, name: 'Gary the Grim',        drops: [
        { equip: 'weaponMain', itemId: 'crude_dagger', rarity: 'common', rollAffixes: false, droppable: false },
        { equip: 'head', droppable: true },
      ] },
      { type: 'animated_ranger_dummy',  slotId: 6, name: 'Doug Longshot',        drops: [
        { equip: 'weaponMain', itemId: 'crude_bow', rarity: 'common', rollAffixes: false, droppable: false },
        { equip: 'head', droppable: true },
      ] },
      { type: 'animated_rogue_dummy',   slotId: 2, name: 'Shifty-Eyed Mo',       drops: [
        { equip: 'weaponMain', itemId: 'crude_dagger', rarity: 'common', rollAffixes: false, droppable: false },
        { equip: 'head', droppable: true },
      ] },
      { type: 'animated_wizard_dummy',  slotId: 8, name: 'Lenny the Magnificent', drops: [
        { equip: 'weaponMain', itemId: 'crude_staff', rarity: 'common', rollAffixes: false, droppable: false },
        { equip: 'head', droppable: true },
      ] },
    ]
  },

  training_encounter_4: {
    name: 'Huntsman & Beasts',
    description: 'Coordinate against a huntsman commander and his beasts.',
    longDescription: 'A ranged huntsman marks targets and directs two beasts—Oskar the ripper and Kiro the venom-spewer. Expect layered weaknesses, coordinated bursts and pack-wide buffs.',
    portraitKey: 'portrait_styx_commander',
    enemies: [
      // Fixed/soulbound weapons (droppable: false, same convention as the
      // other training_encounter_N enemies) — give calculateDamage() real
      // weapon dice to roll now that these three are on the typed pipeline
      // instead of flat `amount` numbers.
      { type: 'huntsman_commander', slotId: 8, name: 'Cade', drops: [
        { equip: 'weaponMain', itemId: 'crude_bow', rarity: 'common', rollAffixes: false, droppable: false },
        // Fixed uncommon ("green") armor set, soulbound — same convention as
        // berserker_boss's gear (training_encounter_6): rarity fixed rather
        // than left to the normal random roll, none of it drops on defeat.
        { equip: 'chest', rarity: 'uncommon', droppable: false },
        { equip: 'head', rarity: 'uncommon', droppable: false },
        { equip: 'legs', rarity: 'uncommon', droppable: false },
        { equip: 'gloves', rarity: 'uncommon', droppable: false },
        { equip: 'boots', rarity: 'uncommon', droppable: false },
      ] },
      // name overrides added — neither had one before, so both were
      // displaying their raw type string ("beast_oskar"/"beast_kiro") in
      // combat despite the encounter's own longDescription already calling
      // them "Oskar the ripper"/"Kiro the venom-spewer".
      { type: 'beast_oskar', slotId: 2, name: 'Oskar', drops: [
        { equip: 'weaponMain', itemId: 'crude_dagger', rarity: 'common', rollAffixes: false, droppable: false },
      ] },
      { type: 'beast_kiro', slotId: 3, name: 'Kiro', drops: [
        { equip: 'weaponMain', itemId: 'crude_dagger', rarity: 'common', rollAffixes: false, droppable: false },
      ] }
    ]
  },

  training_encounter_5: {
    name: 'Elemental Duelists',
    description: 'Battle elite fire and ice duelists leveraging elemental reactions.',
    longDescription: 'Two elite duelists wield opposing elements. They coordinate Fire and Cold buildup to trigger Thermal Shock-style payoffs and field-wide bursts.',
    portraitKey: 'portrait_lesse_duelist_ice',
    enemies: [
      // Fixed/soulbound weapon (common, real weapon dice for the typed
      // pipeline) plus a full soulbound RARE ("blue") armor set — same
      // convention as berserker_boss/Cade's gear, rarity fixed rather than
      // left to the normal random roll, none of it drops on defeat.
      { type: 'fire_duelist', slotId: 2, name: 'Ember', drops: [
        { equip: 'weaponMain', itemId: 'crude_sword_1h', rarity: 'common', rollAffixes: false, droppable: false },
        { equip: 'chest', rarity: 'rare', droppable: false },
        { equip: 'head', rarity: 'rare', droppable: false },
        { equip: 'legs', rarity: 'rare', droppable: false },
        { equip: 'gloves', rarity: 'rare', droppable: false },
        { equip: 'boots', rarity: 'rare', droppable: false },
      ] },
      { type: 'ice_duelist', slotId: 3, name: 'Rime', drops: [
        { equip: 'weaponMain', itemId: 'crude_sword_1h', rarity: 'common', rollAffixes: false, droppable: false },
        { equip: 'chest', rarity: 'rare', droppable: false },
        { equip: 'head', rarity: 'rare', droppable: false },
        { equip: 'legs', rarity: 'rare', droppable: false },
        { equip: 'gloves', rarity: 'rare', droppable: false },
        { equip: 'boots', rarity: 'rare', droppable: false },
      ] }
    ]
  },

  training_encounter_6: {
    name: 'Gorrek',
    description: 'Gorrek — a relentless berserker who punishes hesitation and tears open his own wounds for power.',
    // Rewritten alongside this session's kit expansion — the old text
    // predated Unstoppable Rush's glare redesign and Reckless
    // Harvest/Bloodrite entirely.
    longDescription: "Gorrek fights on a hair trigger: initiative builds fast, his glare punishes anyone who stands still, and he'll tear open his own wounds for a burst of power if you let his bleeding go unchecked. Survive the opening rush, watch for Death Spiral once he's built Expose and Lacerate, and don't ignore his glare.",
    portraitKey: 'berserker_portrait',
    enemies: [
      {
        type: 'berserker_boss', slotId: 2, name: 'Gorrek',
        drops: [
          // Historic/soulbound — not a random loot drop. rarity/rollAffixes
          // set explicitly so _equipEnemyItem's normal random-rarity roll
          // can't override this fixed item's own 'historic' tier.
          { equip: 'weaponMain', itemId: 'bloodthirster', rarity: 'historic', rollAffixes: false, droppable: false },
          // Full "decent" armor set (everything but jewelry), fixed at
          // uncommon rather than left to the normal random roll so it's
          // consistent between test runs. None of it drops — unlike normal
          // encounters/mobs, this boss keeps his gear on defeat.
          { equip: 'chest', rarity: 'uncommon', droppable: false },
          { equip: 'head', rarity: 'uncommon', droppable: false },
          { equip: 'legs', rarity: 'uncommon', droppable: false },
          { equip: 'gloves', rarity: 'uncommon', droppable: false },
          { equip: 'boots', rarity: 'uncommon', droppable: false },
        ],
      }
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
