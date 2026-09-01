// Gear loadouts shared between a base fight and every one of its Reckoning
// tiers. These exist because the tiers were originally written without any
// drops at all, which silently left those enemies with NO weapon (falling back
// to the 1-2 default dice, so their damage collapsed) and no armour. Defining
// each loadout once and referencing it from both places makes that class of
// drift impossible rather than merely unlikely.
const W = (itemId) => ({ equip: 'weaponMain', itemId, rarity: 'common', rollAffixes: false, droppable: false });
const ARMOUR = (rarity) => ['chest', 'head', 'legs', 'gloves', 'boots']
  .map(equip => ({ equip, rarity, droppable: false }));

// Encounter 3 — a common weapon each, plus one droppable head slot.
const ENC3_DROPS = {
  fighter: [W('crude_sword_1h'), { equip: 'head', droppable: true }],
  healer:  [W('crude_staff'),    { equip: 'head', droppable: true }],
  warlock: [W('crude_dagger'),   { equip: 'head', droppable: true }],
  ranger:  [W('crude_bow'),      { equip: 'head', droppable: true }],
  rogue:   [W('crude_dagger'),   { equip: 'head', droppable: true }],
  wizard:  [W('crude_staff'),    { equip: 'head', droppable: true }],
};

// Encounter 4 — Cade carries a full uncommon set; the beasts are stat-equipped
// with a weapon only (they need real dice, not gear).
const ENC4_CADE_DROPS  = [W('crude_bow'), ...ARMOUR('uncommon')];
const ENC4_BEAST_DROPS = [W('crude_dagger')];

// Encounter 5 — common weapon plus a full soulbound RARE armour set.
const ENC5_DUELIST_DROPS = [W('crude_sword_1h'), ...ARMOUR('rare')];

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
      { type: 'animated_fighter_dummy', slotId: 1, name: 'Chad the Unbreakable', drops: ENC3_DROPS.fighter },
      { type: 'animated_healer_dummy', slotId: 5, name: 'Stan, of the Light', drops: ENC3_DROPS.healer },
      { type: 'animated_warlock_dummy', slotId: 7, name: 'Gary the Grim', drops: ENC3_DROPS.warlock },
      { type: 'animated_ranger_dummy', slotId: 6, name: 'Doug Longshot', drops: ENC3_DROPS.ranger },
      { type: 'animated_rogue_dummy', slotId: 2, name: 'Shifty-Eyed Mo', drops: ENC3_DROPS.rogue },
      { type: 'animated_wizard_dummy', slotId: 8, name: 'Lenny the Magnificent', drops: ENC3_DROPS.wizard },
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
      { type: 'beast_oskar', slotId: 2, name: 'Oskar', drops: ENC4_BEAST_DROPS },
      { type: 'beast_kiro', slotId: 3, name: 'Kiro', drops: ENC4_BEAST_DROPS }
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
      { type: 'fire_duelist', slotId: 2, name: 'Ember', drops: ENC5_DUELIST_DROPS },
      { type: 'ice_duelist', slotId: 3, name: 'Rime', drops: ENC5_DUELIST_DROPS }
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
  training_encounter_2_reckoning_1: {
    name: 'Basic Training II — Reckoning I',
    description: 'The same six dummies, tougher — and now on a clock.',
    longDescription: "Reckoning I: the crowd has started betting on the clock. Six dummies, five rounds, no excuses. They still cannot hurt you; the only thing that can beat you here is being too slow.",
    portraitKey: 'dummy_portrait',
    // Timed DPS race: 5 full rounds, enforced generically by
    // CombatScene._advanceTurn's turnLimit check. The dummies deal no
    // damage at all, so the clock is the only way to lose.
    turnLimit: 5,
    enemies: [
      { type: 'mobile_training_dummy_reckoning_1', slotId: 3, name: 'Dummy Lenny' },
      { type: 'mobile_training_dummy_reckoning_1', slotId: 4, name: 'Dummy Gary' },
      { type: 'mobile_training_dummy_reckoning_1', slotId: 5, name: 'Dummy Stan' },
      { type: 'mobile_training_dummy_reckoning_1', slotId: 6, name: 'Dummy Doug' },
      { type: 'mobile_training_dummy_reckoning_1', slotId: 7, name: 'Dummy Mo' },
      { type: 'mobile_training_dummy_reckoning_1', slotId: 8, name: 'Dummy Chad' },
    ]
  },
  training_encounter_2_reckoning_2: {
    name: 'Basic Training II — Reckoning II',
    description: 'Sturdier dummies, same five rounds.',
    longDescription: "Reckoning II: someone has been reinforcing them between bouts. Same five rounds, half again as much to chew through.",
    portraitKey: 'dummy_portrait',
    // Timed DPS race: 5 full rounds, enforced generically by
    // CombatScene._advanceTurn's turnLimit check. The dummies deal no
    // damage at all, so the clock is the only way to lose.
    turnLimit: 5,
    enemies: [
      { type: 'mobile_training_dummy_reckoning_2', slotId: 3, name: 'Dummy Lenny' },
      { type: 'mobile_training_dummy_reckoning_2', slotId: 4, name: 'Dummy Gary' },
      { type: 'mobile_training_dummy_reckoning_2', slotId: 5, name: 'Dummy Stan' },
      { type: 'mobile_training_dummy_reckoning_2', slotId: 6, name: 'Dummy Doug' },
      { type: 'mobile_training_dummy_reckoning_2', slotId: 7, name: 'Dummy Mo' },
      { type: 'mobile_training_dummy_reckoning_2', slotId: 8, name: 'Dummy Chad' },
    ]
  },
  training_encounter_2_reckoning_3: {
    name: 'Basic Training II — Reckoning III',
    description: 'The thickest dummies in the pit, still five rounds.',
    longDescription: "Reckoning III: the pit's heaviest practice stock, and not one second more to deal with it. Bring your whole turn every round.",
    portraitKey: 'dummy_portrait',
    // Timed DPS race: 5 full rounds, enforced generically by
    // CombatScene._advanceTurn's turnLimit check. The dummies deal no
    // damage at all, so the clock is the only way to lose.
    turnLimit: 5,
    enemies: [
      { type: 'mobile_training_dummy_reckoning_3', slotId: 3, name: 'Dummy Lenny' },
      { type: 'mobile_training_dummy_reckoning_3', slotId: 4, name: 'Dummy Gary' },
      { type: 'mobile_training_dummy_reckoning_3', slotId: 5, name: 'Dummy Stan' },
      { type: 'mobile_training_dummy_reckoning_3', slotId: 6, name: 'Dummy Doug' },
      { type: 'mobile_training_dummy_reckoning_3', slotId: 7, name: 'Dummy Mo' },
      { type: 'mobile_training_dummy_reckoning_3', slotId: 8, name: 'Dummy Chad' },
    ]
  },
  training_encounter_3_reckoning_1: {
    name: 'The Animated Six — Reckoning I',
    description: 'The Animated Six, reinforced.',
    longDescription: "Reckoning I: the constructs have been rebuilt with denser cores. Same six minds, noticeably more to cut through.",
    portraitKey: 'dummy_portrait_equipped_fighter',
    // Pure toughness tier, per design: HP and mitigation only, no extra
    // damage and no turn limit. enemyScale is applied in
    // CombatScene._placeEnemies — hpMult multiplies, derivedBonus ADDS on
    // top of each archetype's own resists, so Chad stays the physical wall
    // (30 + 8) and Lenny the elemental one rather than all six flattening
    // into the same profile.
    enemyScale: {
      hpMult: 1.5,
      derivedBonus: { PhysicalResist: 8, ElementalResist: 8, NecroticResist: 8, Resilience: 20 },
    },
    enemies: [
      { type: 'animated_fighter_dummy', slotId: 1, name: 'Chad the Unbreakable', drops: ENC3_DROPS.fighter },
      { type: 'animated_rogue_dummy', slotId: 2, name: 'Shifty-Eyed Mo', drops: ENC3_DROPS.rogue },
      { type: 'animated_healer_dummy', slotId: 5, name: 'Stan, of the Light', drops: ENC3_DROPS.healer },
      { type: 'animated_ranger_dummy', slotId: 6, name: 'Doug Longshot', drops: ENC3_DROPS.ranger },
      { type: 'animated_warlock_dummy', slotId: 7, name: 'Gary the Grim', drops: ENC3_DROPS.warlock },
      { type: 'animated_wizard_dummy', slotId: 8, name: 'Lenny the Magnificent', drops: ENC3_DROPS.wizard },
    ]
  },
  training_encounter_3_reckoning_2: {
    name: 'The Animated Six — Reckoning II',
    description: 'The Animated Six at siege weight.',
    longDescription: "Reckoning II: reinforced to the point of absurdity, and warded on top of it. Chip damage will not finish this.",
    portraitKey: 'dummy_portrait_equipped_fighter',
    // Pure toughness tier, per design: HP and mitigation only, no extra
    // damage and no turn limit. enemyScale is applied in
    // CombatScene._placeEnemies — hpMult multiplies, derivedBonus ADDS on
    // top of each archetype's own resists, so Chad stays the physical wall
    // (30 + 20) and Lenny the elemental one rather than all six flattening
    // into the same profile.
    enemyScale: {
      hpMult: 2.2,
      derivedBonus: { PhysicalResist: 20, ElementalResist: 20, NecroticResist: 20, Resilience: 45 },
    },
    enemies: [
      { type: 'animated_fighter_dummy', slotId: 1, name: 'Chad the Unbreakable', drops: ENC3_DROPS.fighter },
      { type: 'animated_rogue_dummy', slotId: 2, name: 'Shifty-Eyed Mo', drops: ENC3_DROPS.rogue },
      { type: 'animated_healer_dummy', slotId: 5, name: 'Stan, of the Light', drops: ENC3_DROPS.healer },
      { type: 'animated_ranger_dummy', slotId: 6, name: 'Doug Longshot', drops: ENC3_DROPS.ranger },
      { type: 'animated_warlock_dummy', slotId: 7, name: 'Gary the Grim', drops: ENC3_DROPS.warlock },
      { type: 'animated_wizard_dummy', slotId: 8, name: 'Lenny the Magnificent', drops: ENC3_DROPS.wizard },
    ]
  },
  training_encounter_3_reckoning_3: {
    name: 'The Animated Six — Reckoning III',
    description: 'The Animated Six as siege engines. Bring everything.',
    longDescription: "Reckoning III: barely constructs any more. Every one of them shrugs off a third of what you throw, the wall in front shrugs off two thirds, and there is three times the mass behind it. This is the deep end.",
    portraitKey: 'dummy_portrait_equipped_fighter',
    // Pure toughness tier, per design: HP and mitigation only, no extra
    // damage and no turn limit. enemyScale is applied in
    // CombatScene._placeEnemies — hpMult multiplies, derivedBonus ADDS on
    // top of each archetype's own resists, so Chad stays the physical wall
    // (30 + 35) and Lenny the elemental one rather than all six flattening
    // into the same profile.
    enemyScale: {
      hpMult: 3.0,
      derivedBonus: { PhysicalResist: 35, ElementalResist: 35, NecroticResist: 35, Resilience: 70 },
    },
    enemies: [
      { type: 'animated_fighter_dummy', slotId: 1, name: 'Chad the Unbreakable', drops: ENC3_DROPS.fighter },
      { type: 'animated_rogue_dummy', slotId: 2, name: 'Shifty-Eyed Mo', drops: ENC3_DROPS.rogue },
      { type: 'animated_healer_dummy', slotId: 5, name: 'Stan, of the Light', drops: ENC3_DROPS.healer },
      { type: 'animated_ranger_dummy', slotId: 6, name: 'Doug Longshot', drops: ENC3_DROPS.ranger },
      { type: 'animated_warlock_dummy', slotId: 7, name: 'Gary the Grim', drops: ENC3_DROPS.warlock },
      { type: 'animated_wizard_dummy', slotId: 8, name: 'Lenny the Magnificent', drops: ENC3_DROPS.wizard },
    ]
  },
  training_encounter_5_reckoning_1: {
    name: 'Elemental Duelists — Reckoning I',
    description: 'Ember and Rime, and the things they call up.',
    longDescription: "Reckoning I: they have stopped duelling you honestly. Each of them tears a piece of their own element loose when pressed.",
    portraitKey: 'portrait_lesse_duelist_ice',
    // enemyScale multiplies the duelists AND anything they summon, so
    // the adds stay relevant per tier without separate templates.
    enemyScale: {
      hpMult: 1.35,
      derivedBonus: { PhysicalResist: 8, ElementalResist: 8, NecroticResist: 8, Resilience: 20 },
    },
    enemies: [
      {
        type: 'fire_duelist', slotId: 2, name: 'Ember', drops: ENC5_DUELIST_DROPS,
        // Fires ONCE per threshold (tracked on the enemy), so healing
        // back over the line cannot re-trigger it.
        summon: {
          type: 'lava_spawn', name: 'Lava Spawn', maxHP: 25,
          drops: [{ equip: 'weaponMain', itemId: 'crude_mace_2h', rarity: 'common', rollAffixes: false, droppable: false }],
          thresholds: [
            { atPct: 75, count: 1 },
            { atPct: 35, count: 1 },
          ],
        },
      },
      {
        type: 'ice_duelist', slotId: 3, name: 'Rime', drops: ENC5_DUELIST_DROPS,
        summon: {
          type: 'ice_spawn', name: 'Ice Spawn', maxHP: 25,
          drops: [{ equip: 'weaponMain', itemId: 'crude_mace_2h', rarity: 'common', rollAffixes: false, droppable: false }],
          thresholds: [
            { atPct: 75, count: 1 },
            { atPct: 35, count: 1 },
          ],
        },
      },
    ]
  },
  training_encounter_5_reckoning_2: {
    name: 'Elemental Duelists — Reckoning II',
    description: 'Hardier duelists, same summoning trick.',
    longDescription: "Reckoning II: tougher, better warded, and no less willing to flood the floor with their own element.",
    portraitKey: 'portrait_lesse_duelist_ice',
    // enemyScale multiplies the duelists AND anything they summon, so
    // the adds stay relevant per tier without separate templates.
    enemyScale: {
      hpMult: 1.7,
      derivedBonus: { PhysicalResist: 18, ElementalResist: 18, NecroticResist: 18, Resilience: 40 },
    },
    enemies: [
      {
        type: 'fire_duelist', slotId: 2, name: 'Ember', drops: ENC5_DUELIST_DROPS,
        // Fires ONCE per threshold (tracked on the enemy), so healing
        // back over the line cannot re-trigger it.
        summon: {
          type: 'lava_spawn', name: 'Lava Spawn', maxHP: 35,
          drops: [{ equip: 'weaponMain', itemId: 'crude_mace_2h', rarity: 'common', rollAffixes: false, droppable: false }],
          thresholds: [
            { atPct: 75, count: 1 },
            { atPct: 35, count: 1 },
          ],
        },
      },
      {
        type: 'ice_duelist', slotId: 3, name: 'Rime', drops: ENC5_DUELIST_DROPS,
        summon: {
          type: 'ice_spawn', name: 'Ice Spawn', maxHP: 35,
          drops: [{ equip: 'weaponMain', itemId: 'crude_mace_2h', rarity: 'common', rollAffixes: false, droppable: false }],
          thresholds: [
            { atPct: 75, count: 1 },
            { atPct: 35, count: 1 },
          ],
        },
      },
    ]
  },
  training_encounter_5_reckoning_3: {
    name: 'Elemental Duelists — Reckoning III',
    description: 'Both duelists at their peak, and the floor is never empty.',
    longDescription: "Reckoning III: at the brink each of them tears loose not one fragment but two. Expect the field to be crowded, and expect to have to choose what you are actually killing.",
    portraitKey: 'portrait_lesse_duelist_ice',
    // enemyScale multiplies the duelists AND anything they summon, so
    // the adds stay relevant per tier without separate templates.
    enemyScale: {
      hpMult: 2.1,
      derivedBonus: { PhysicalResist: 30, ElementalResist: 30, NecroticResist: 30, Resilience: 62 },
    },
    enemies: [
      {
        type: 'fire_duelist', slotId: 2, name: 'Ember', drops: ENC5_DUELIST_DROPS,
        // Fires ONCE per threshold (tracked on the enemy), so healing
        // back over the line cannot re-trigger it.
        summon: {
          type: 'lava_spawn', name: 'Lava Spawn', maxHP: 45,
          drops: [{ equip: 'weaponMain', itemId: 'crude_mace_2h', rarity: 'common', rollAffixes: false, droppable: false }],
          thresholds: [
            { atPct: 75, count: 1 },
            { atPct: 35, count: 2 },
          ],
        },
      },
      {
        type: 'ice_duelist', slotId: 3, name: 'Rime', drops: ENC5_DUELIST_DROPS,
        summon: {
          type: 'ice_spawn', name: 'Ice Spawn', maxHP: 45,
          drops: [{ equip: 'weaponMain', itemId: 'crude_mace_2h', rarity: 'common', rollAffixes: false, droppable: false }],
          thresholds: [
            { atPct: 75, count: 1 },
            { atPct: 35, count: 2 },
          ],
        },
      },
    ]
  },
  training_encounter_4_reckoning_1: {
    name: 'Huntsman & Beasts — Reckoning I',
    description: 'Cade brings a third beast to the hunt.',
    longDescription: "Reckoning I: the huntsman does not make the same mistake twice. He brings more of the pack.",
    portraitKey: 'portrait_styx_commander',
    enemyScale: {
      hpMult: 1.3,
      derivedBonus: { PhysicalResist: 8, ElementalResist: 8, NecroticResist: 8, Resilience: 20 },
    },
    enemies: [
      { type: 'huntsman_commander', slotId: 8, name: 'Cade', drops: ENC4_CADE_DROPS },
      { type: 'beast_oskar', slotId: 2, name: 'Oskar', drops: ENC4_BEAST_DROPS },
      { type: 'beast_kiro', slotId: 3, name: 'Kiro', drops: ENC4_BEAST_DROPS },
      // Laki, the third beast — present from Reckoning I, and NOT marked
      // isAdd, so she counts toward victory like Oskar and Kiro. Stat-equipped
      // with a weapon only (same as the other beasts) so calculateDamage has
      // real dice; enemyScale above applies to her too.
      { type: 'beast_laki', slotId: 4, name: 'Laki', drops: ENC4_BEAST_DROPS },
    ]
  },
  training_encounter_4_reckoning_2: {
    name: 'Huntsman & Beasts — Reckoning II',
    description: 'A hardier pack, better commanded.',
    longDescription: "Reckoning II: the beasts are heavier and Cade has stopped holding anything back.",
    portraitKey: 'portrait_styx_commander',
    enemyScale: {
      hpMult: 1.65,
      derivedBonus: { PhysicalResist: 18, ElementalResist: 18, NecroticResist: 18, Resilience: 40 },
    },
    enemies: [
      { type: 'huntsman_commander', slotId: 8, name: 'Cade', drops: ENC4_CADE_DROPS },
      { type: 'beast_oskar', slotId: 2, name: 'Oskar', drops: ENC4_BEAST_DROPS },
      { type: 'beast_kiro', slotId: 3, name: 'Kiro', drops: ENC4_BEAST_DROPS },
      // Laki, the third beast — present from Reckoning I, and NOT marked
      // isAdd, so she counts toward victory like Oskar and Kiro. Stat-equipped
      // with a weapon only (same as the other beasts) so calculateDamage has
      // real dice; enemyScale above applies to her too.
      { type: 'beast_laki', slotId: 4, name: 'Laki', drops: ENC4_BEAST_DROPS },
    ]
  },
  training_encounter_4_reckoning_3: {
    name: 'Huntsman & Beasts — Reckoning III',
    description: 'The full pack, at full strength.',
    longDescription: "Reckoning III: every beast at its peak and a commander who expects to win. Killing the pack first is a choice, not a formality.",
    portraitKey: 'portrait_styx_commander',
    enemyScale: {
      hpMult: 2.0,
      derivedBonus: { PhysicalResist: 30, ElementalResist: 30, NecroticResist: 30, Resilience: 62 },
    },
    enemies: [
      { type: 'huntsman_commander', slotId: 8, name: 'Cade', drops: ENC4_CADE_DROPS },
      { type: 'beast_oskar', slotId: 2, name: 'Oskar', drops: ENC4_BEAST_DROPS },
      { type: 'beast_kiro', slotId: 3, name: 'Kiro', drops: ENC4_BEAST_DROPS },
      // Laki, the third beast — present from Reckoning I, and NOT marked
      // isAdd, so she counts toward victory like Oskar and Kiro. Stat-equipped
      // with a weapon only (same as the other beasts) so calculateDamage has
      // real dice; enemyScale above applies to her too.
      { type: 'beast_laki', slotId: 4, name: 'Laki', drops: ENC4_BEAST_DROPS },
    ]
  },
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
        // Carried forward from the tier he first equipped it — his kit is
        // cumulative across Reckoning tiers.
        { equip: 'amulet', itemId: 'zafaar_amulet_lacerate', rarity: 'uncommon', droppable: false },
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
        // Carried forward from the tier he first equipped it — his kit is
        // cumulative across Reckoning tiers.
        { equip: 'amulet', itemId: 'zafaar_amulet_lacerate', rarity: 'uncommon', droppable: false },
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
        // Carried forward from the tier he first equipped it — his kit is
        // cumulative across Reckoning tiers.
        { equip: 'amulet', itemId: 'zafaar_amulet_lacerate', rarity: 'uncommon', droppable: false },
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
        // Carried forward from the tier he first equipped it — his kit is
        // cumulative across Reckoning tiers.
        { equip: 'amulet', itemId: 'zafaar_amulet_lacerate', rarity: 'uncommon', droppable: false },
        { equip: 'ring', itemId: 'zafaar_ring_half_damage', rarity: 'uncommon', droppable: false },
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
