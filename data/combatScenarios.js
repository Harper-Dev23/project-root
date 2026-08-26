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
    description: "Six shuffling dummies — practice AOE.",
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
    description: "Six constructs, real combat AI.",
    longDescription: "Six constructs with real class roles and real combat AI. They guard, heal and answer each other — damage alone won't close this one.",
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
    description: 'A huntsman commander leads two beasts.',
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
    description: "Elite fire and ice duelists.",
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
    description: "A relentless solo berserker.",
    // Rewritten alongside this session's kit expansion — the old text
    // predated Unstoppable Rush's glare redesign and Reckless
    // Harvest/Bloodrite entirely.
    longDescription: "A solo berserker on a hair trigger. His glare punishes standing still, and he feeds on his own wounds — the longer he bleeds, the harder he hits.",
    portraitKey: 'portrait_gorrek',
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

  // Reckoning I-V — account-wide rematch tiers (ProgressionManager gates
  // each one sequentially behind the last: base clear → I → II → III → IV →
  // V), same fixed Bloodthirster/armor drops as the base fight each time.
  // Surfaced as a tier picker beside Gorrek's row in the training menu, not
  // as 5 more rows in the main list.
  training_encounter_6_reckoning_1: {
    name: 'Gorrek — Reckoning I',
    description: 'A tougher Gorrek — the first rematch tier.',
    longDescription: "He remembers losing. Reckoning I: noticeably harder to put down, though his kit hasn't grown yet.",
    portraitKey: 'portrait_gorrek',
    enemies: [{
      type: 'berserker_boss_reckoning_1', slotId: 2, name: 'Gorrek',
      drops: [
        { equip: 'weaponMain', itemId: 'bloodthirster', rarity: 'historic', rollAffixes: false, droppable: false },
        // Zafaar Pendant of Lacerations — 65-85% of his physical damage is
        // ALSO added as Lacerate buildup, on top of Bleeding Sweep's own.
        // rarity pinned to the item's declared 'uncommon' so _equipEnemyItem's
        // random-rarity roll can't override it; the fixed affix always rolls
        // regardless of rollAffixes (unique + fixedAffix short-circuits the
        // affix pool in createItemInstance).
        { equip: 'amulet', itemId: 'zafaar_amulet_lacerate', rarity: 'uncommon', droppable: false },
        { equip: 'chest', rarity: 'uncommon', droppable: false },
        { equip: 'head', rarity: 'uncommon', droppable: false },
        { equip: 'legs', rarity: 'uncommon', droppable: false },
        { equip: 'gloves', rarity: 'uncommon', droppable: false },
        { equip: 'boots', rarity: 'uncommon', droppable: false },
      ],
    }]
  },
  training_encounter_6_reckoning_2: {
    name: 'Gorrek — Reckoning II',
    description: 'A tougher Gorrek, now able to shake off Disorient.',
    longDescription: "Reckoning II: tougher still, and he's learned to clear his own head — Disorient alone won't hold him down anymore.",
    portraitKey: 'portrait_gorrek',
    enemies: [{
      type: 'berserker_boss_reckoning_2', slotId: 2, name: 'Gorrek',
      drops: [
        { equip: 'weaponMain', itemId: 'bloodthirster', rarity: 'historic', rollAffixes: false, droppable: false },
        { equip: 'chest', rarity: 'uncommon', droppable: false },
        { equip: 'head', rarity: 'uncommon', droppable: false },
        { equip: 'legs', rarity: 'uncommon', droppable: false },
        { equip: 'gloves', rarity: 'uncommon', droppable: false },
        { equip: 'boots', rarity: 'uncommon', droppable: false },
      ],
    }]
  },
  training_encounter_6_reckoning_3: {
    name: 'Gorrek — Reckoning III',
    description: 'A tougher Gorrek — the third rematch tier.',
    longDescription: "Reckoning III: even harder to wear down. Expect a long fight.",
    portraitKey: 'portrait_gorrek',
    enemies: [{
      type: 'berserker_boss_reckoning_3', slotId: 2, name: 'Gorrek',
      // Armor rarity upgraded uncommon -> rare starting here (weapon stays
      // the fixed historic-tier Bloodthirster in every tier).
      drops: [
        { equip: 'weaponMain', itemId: 'bloodthirster', rarity: 'historic', rollAffixes: false, droppable: false },
        { equip: 'chest', rarity: 'rare', droppable: false },
        { equip: 'head', rarity: 'rare', droppable: false },
        { equip: 'legs', rarity: 'rare', droppable: false },
        { equip: 'gloves', rarity: 'rare', droppable: false },
        { equip: 'boots', rarity: 'rare', droppable: false },
      ],
    }]
  },
  training_encounter_6_reckoning_4: {
    name: 'Gorrek — Reckoning IV',
    description: 'A tougher Gorrek — the fourth rematch tier.',
    longDescription: "Reckoning IV: brutally resilient. Bring everything you have.",
    portraitKey: 'portrait_gorrek',
    enemies: [{
      type: 'berserker_boss_reckoning_4', slotId: 2, name: 'Gorrek',
      drops: [
        { equip: 'weaponMain', itemId: 'bloodthirster', rarity: 'historic', rollAffixes: false, droppable: false },
        // Zafaar Band of Warding — 3-5% chance to halve any incoming damage
        // instance, rolled per hit after DR. Same fixed-rarity note as the
        // Reckoning I pendant.
        { equip: 'ring', itemId: 'zafaar_ring_half_damage', rarity: 'uncommon', droppable: false },
        { equip: 'chest', rarity: 'rare', droppable: false },
        { equip: 'head', rarity: 'rare', droppable: false },
        { equip: 'legs', rarity: 'rare', droppable: false },
        { equip: 'gloves', rarity: 'rare', droppable: false },
        { equip: 'boots', rarity: 'rare', droppable: false },
      ],
    }]
  },
  training_encounter_6_reckoning_5: {
    name: 'Gorrek — Reckoning V',
    description: 'The final rematch tier — the hardest Gorrek gets.',
    longDescription: "Reckoning V: as tough as he gets. If you can put him down here, you've earned it.",
    portraitKey: 'portrait_gorrek',
    enemies: [{
      type: 'berserker_boss_reckoning_5', slotId: 2, name: 'Gorrek',
      // Armor rarity upgraded rare -> epic at the final tier.
      drops: [
        { equip: 'weaponMain', itemId: 'bloodthirster', rarity: 'historic', rollAffixes: false, droppable: false },
        { equip: 'chest', rarity: 'epic', droppable: false },
        { equip: 'head', rarity: 'epic', droppable: false },
        { equip: 'legs', rarity: 'epic', droppable: false },
        { equip: 'gloves', rarity: 'epic', droppable: false },
        { equip: 'boots', rarity: 'epic', droppable: false },
      ],
    }]
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
