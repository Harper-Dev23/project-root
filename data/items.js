export const Items = {
  
  healing_potion: {
    id: 'healing_potion',
    name: 'Healing Potion',
    type: 'consumable',
    rarity: 'common',
    effect: 'heal',
    amount: 25,
    description: 'Restores a small amount of health.'
  },
  mana_potion: {
    id: 'mana_potion',
    name: 'Mana Potion',
    type: 'consumable',
    rarity: 'common',
    effect: 'mana',
    amount: 15,
    description: 'Restores a small amount of mana.'
  },

  // === Crude Weapons (Common Rarity) ===
  crude_dagger: {
    id: 'crude_dagger',
    name: 'Crude Dagger',
    type: 'weapon',
    weaponType: 'dagger',
    rarity: 'common',
    bonuses: {},
    hands: 1,
    damage: { min: 4, max: 6 },
    description: 'A dull but quick blade ideal for close jabs.'
  },

  crude_sword_1h: {
    id: 'crude_sword_1h',
    name: 'Crude Sword',
    type: 'weapon',
    weaponType: 'sword_1h',
    rarity: 'common',
    bonuses: {},
    hands: 1,
    damage: { min: 5, max: 8 },
    description: 'A rusted short sword with chipped edges.'
  },

  crude_sword_2h: {
    id: 'crude_sword_2h',
    name: 'Crude Greatsword',
    type: 'weapon',
    weaponType: 'sword_2h',
    rarity: 'common',
    bonuses: {},
    hands: 2,
    damage: { min: 7, max: 12 },
    description: 'A heavy, unwieldy blade that deals brutal strikes.'
  },

  crude_spear_1h: {
    id: 'crude_spear_1h',
    name: 'Crude Spear',
    type: 'weapon',
    weaponType: 'spear_1h',
    rarity: 'common',
    bonuses: {},
    hands: 1,
    damage: { min: 5, max: 8 },
    description: 'A splintered spear good for keeping distance.'
  },

  crude_whip: {
    id: 'crude_whip',
    name: 'Crude Whip',
    type: 'weapon',
    weaponType: 'whip',
    rarity: 'common',
    bonuses: {},
    hands: 1,
    damage: { min: 3, max: 7 },
    description: 'A worn leather whip with faded stitching.'
  },

  crude_shield: {
    id: 'crude_shield',
    name: 'Crude Shield',
    type: 'weapon',
    weaponType: 'shield',
    rarity: 'common',
    bonuses: {},
    hands: 1,
    description: 'A battered wooden shield with faded paint.'
  },

  crude_sling: {
    id: 'crude_sling',
    name: 'Crude Sling',
    type: 'weapon',
    weaponType: 'sling',
    rarity: 'common',
    bonuses: {},
    hands: 1,
    damage: { min: 4, max: 7 },
    description: 'A frayed sling made from scrap cord.'
  },

  crude_bow: {
    id: 'crude_bow',
    name: 'Crude Bow',
    type: 'weapon',
    weaponType: 'bow',
    rarity: 'common',
    bonuses: {},
    hands: 2,
    damage: { min: 6, max: 10 },
    description: 'A creaky bow that fires arrows unevenly.'
  },

  crude_gun: {
    id: 'crude_gun',
    name: 'Crude Gun',
    type: 'weapon',
    weaponType: 'gun',
    rarity: 'common',
    bonuses: {},
    hands: 2,
    damage: { min: 7, max: 11 },
    description: 'An unreliable firearm prone to misfires.'
  },

  crude_staff: {
    id: 'crude_staff',
    name: 'Crude Staff',
    type: 'weapon',
    weaponType: 'staff',
    rarity: 'common',
    bonuses: {},
    hands: 2,
    damage: { min: 5, max: 9 },
    description: 'A warped staff with faint magical traces.'
  },

  crude_wand: {
    id: 'crude_wand',
    name: 'Crude Wand',
    type: 'weapon',
    weaponType: 'wand',
    rarity: 'common',
    bonuses: {},
    hands: 1,
    damage: { min: 4, max: 7 },
    description: 'A brittle wand that sputters sparks.'
  },

  crude_mace_2h: {
    id: 'crude_mace_2h',
    name: 'Crude War Mace',
    type: 'weapon',
    weaponType: 'mace_2h',
    rarity: 'common',
    bonuses: {},
    hands: 2,
    damage: { min: 7, max: 12 },
    description: 'A massive iron mace with crushing force.'
  },

  crude_axe_2h: {
    id: 'crude_axe_2h',
    name: 'Crude Battle Axe',
    type: 'weapon',
    weaponType: 'axe_2h',
    rarity: 'common',
    bonuses: {},
    hands: 2,
    damage: { min: 8, max: 13 },
    description: 'A brutal axe with a chipped but deadly edge.'
  },

  // === Common Armor (Watershade) ===
  simple_helm_str: {
    id: 'simple_helm_str',
    name: 'Simple Helm',
    type: 'armor',
    slot: 'head',
    rarity: 'common',
    bonuses: { STR: 1 },
    description: 'A basic iron helm that strengthens the neck.'
  },
  simple_helm_dex: {
    id: 'simple_helm_dex',
    name: 'Light Cap',
    type: 'armor',
    slot: 'head',
    rarity: 'common',
    bonuses: { DEX: 1 },
    description: 'A soft leather cap, suited for nimble movement.'
  },
  simple_helm_int: {
    id: 'simple_helm_int',
    name: 'Mystic Hood',
    type: 'armor',
    slot: 'head',
    rarity: 'common',
    bonuses: { INT: 1 },
    description: 'A hood embroidered with faint glyphs.'
  },

  simple_chest_con_str: {
    id: 'simple_chest_con_str',
    name: 'Tough Vest',
    type: 'armor',
    slot: 'chest',
    rarity: 'common',
    bonuses: { CON: 1, STR: 1 },
    description: 'Worn hide layered for protection and power.'
  },
  simple_chest_dex_int: {
    id: 'simple_chest_dex_int',
    name: 'Balanced Robe',
    type: 'armor',
    slot: 'chest',
    rarity: 'common',
    bonuses: { DEX: 1, INT: 1 },
    description: 'Flexible fabric robe with slight arcane traces.'
  },
  simple_chest_wis_con: {
    id: 'simple_chest_wis_con',
    name: 'Padded Tunic',
    type: 'armor',
    slot: 'chest',
    rarity: 'common',
    bonuses: { WIS: 1, CON: 1 },
    description: 'Stuffed layers grant warmth and fortitude.'
  },

  simple_legs_con: {
    id: 'simple_legs_con',
    name: "Traveler's Pants",
    type: 'armor',
    slot: 'legs',
    rarity: 'common',
    bonuses: { CON: 1 },
    description: 'Rugged trousers built for long marches.'
  },
  simple_legs_dex: {
    id: 'simple_legs_dex',
    name: 'Tight Slacks',
    type: 'armor',
    slot: 'legs',
    rarity: 'common',
    bonuses: { DEX: 1 },
    description: 'Close-fitted pants for agile movement.'
  },
  simple_legs_wis: {
    id: 'simple_legs_wis',
    name: "Seer's Wraps",
    type: 'armor',
    slot: 'legs',
    rarity: 'common',
    bonuses: { WIS: 1 },
    description: 'Flowing wraps said to aid focus.'
  },

  simple_gloves_dex: {
    id: 'simple_gloves_dex',
    name: 'Leather Gloves',
    type: 'armor',
    slot: 'gloves',
    rarity: 'common',
    bonuses: { DEX: 1 },
    description: 'Supple gloves ideal for quick hands.'
  },
  simple_gloves_str: {
    id: 'simple_gloves_str',
    name: 'Thick Gloves',
    type: 'armor',
    slot: 'gloves',
    rarity: 'common',
    bonuses: { STR: 1 },
    description: 'Padded palms for heavy lifting.'
  },
  simple_gloves_int: {
    id: 'simple_gloves_int',
    name: 'Mage Mitts',
    type: 'armor',
    slot: 'gloves',
    rarity: 'common',
    bonuses: { INT: 1 },
    description: 'Faintly warm to the touch with energy.'
  },

  simple_boots_con: {
    id: 'simple_boots_con',
    name: 'Sturdy Boots',
    type: 'armor',
    slot: 'boots',
    rarity: 'common',
    bonuses: { CON: 1 },
    description: "Heavy soles protect against the path's abuse."
  },
  simple_boots_dex: {
    id: 'simple_boots_dex',
    name: 'Silent Footwraps',
    type: 'armor',
    slot: 'boots',
    rarity: 'common',
    bonuses: { DEX: 1 },
    description: 'Designed to minimize noise while moving.'
  },
  simple_boots_wis: {
    id: 'simple_boots_wis',
    name: 'Pilgrim Sandals',
    type: 'armor',
    slot: 'boots',
    rarity: 'common',
    bonuses: { WIS: 1 },
    description: 'Open-toed sandals used in meditation rituals.'
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // TRIBE JEWELRY — Unique Uncommon pieces sold at each tribe vendor.
  // Each item has exactly 1 affix (fixedAffix) or a granted skill (grantsSkills).
  // The fixedAffix rolls a value in [range[0], range[1]] when instanced.
  // grantsSkills items add those skill ids to the wearer's char.skills list.
  // ═══════════════════════════════════════════════════════════════════════════

  // ── ELSETH AMULETS ────────────────────────────────────────────────────────

  elseth_amulet_phys_to_elem: {
    id: 'elseth_amulet_phys_to_elem',
    name: "Converter's Pendant",
    type: 'armor',
    slot: 'amulet',
    rarity: 'uncommon',
    unique: true,
    tribe: 'elseth',
    bonuses: {},
    fixedAffix: {
      key: 'of Conversion',
      family: 'physToElemPercent',
      range: [25, 35],
    },
    description: 'Converts 25-35% of physical damage dealt to elemental.'
  },

  elseth_amulet_phys_to_necro: {
    id: 'elseth_amulet_phys_to_necro',
    name: "Blighted Pendant",
    type: 'armor',
    slot: 'amulet',
    rarity: 'uncommon',
    unique: true,
    tribe: 'elseth',
    bonuses: {},
    fixedAffix: {
      key: 'of Corruption',
      family: 'physToNecroPercent',
      range: [25, 35],
    },
    description: 'Converts 25-35% of physical damage dealt to necrotic.'
  },

  elseth_amulet_elem_to_necro: {
    id: 'elseth_amulet_elem_to_necro',
    name: "Void Pendant",
    type: 'armor',
    slot: 'amulet',
    rarity: 'uncommon',
    unique: true,
    tribe: 'elseth',
    bonuses: {},
    fixedAffix: {
      key: 'of the Void',
      family: 'elemToNecroPercent',
      range: [25, 35],
    },
    description: 'Converts 25-35% of elemental damage dealt to necrotic.'
  },

  // ── STYX AMULETS ─────────────────────────────────────────────────────────

  styx_amulet_initiative: {
    id: 'styx_amulet_initiative',
    name: "Striker's Pendant",
    type: 'armor',
    slot: 'amulet',
    rarity: 'uncommon',
    unique: true,
    tribe: 'styx',
    bonuses: {},
    fixedAffix: {
      key: 'of the First Strike',
      family: 'initBonusOnBattleStart',
      range: [15, 25],
    },
    description: 'Gain 15-25 bonus initiative at the start of each battle.'
  },

  styx_amulet_cooldown: {
    id: 'styx_amulet_cooldown',
    name: "Quickened Pendant",
    type: 'armor',
    slot: 'amulet',
    rarity: 'uncommon',
    unique: true,
    tribe: 'styx',
    bonuses: {},
    grantsSkills: ['hasten'],
    description: 'Grants Hasten: reduce all cooldowns of an ally by 3 turns. (Bonus action, CD 3)'
  },

  styx_amulet_shield: {
    id: 'styx_amulet_shield',
    name: "Warden's Pendant",
    type: 'armor',
    slot: 'amulet',
    rarity: 'uncommon',
    unique: true,
    tribe: 'styx',
    bonuses: {},
    fixedAffix: {
      key: 'of the Ward',
      family: 'shieldPctOnBattleStart',
      range: [15, 25],
    },
    description: 'Gain a shield equal to 15-25% of max HP at the start of combat. Lasts 3 turns.'
  },

  // ── ZAFAAR AMULETS ────────────────────────────────────────────────────────

  zafaar_amulet_disorient: {
    id: 'zafaar_amulet_disorient',
    name: "Rattling Pendant",
    type: 'armor',
    slot: 'amulet',
    rarity: 'uncommon',
    unique: true,
    tribe: 'zafaar',
    bonuses: {},
    fixedAffix: {
      key: 'of Disorientation',
      family: 'physBuildupOnPhysDmg',
      buildupTarget: 'disorient',
      range: [25, 35],
    },
    description: 'Physical hits apply 25-35% of their damage as additional Disorient buildup.'
  },

  zafaar_amulet_lacerate: {
    id: 'zafaar_amulet_lacerate',
    name: "Lacerating Pendant",
    type: 'armor',
    slot: 'amulet',
    rarity: 'uncommon',
    unique: true,
    tribe: 'zafaar',
    bonuses: {},
    fixedAffix: {
      key: 'of Lacerations',
      family: 'physBuildupOnPhysDmg',
      buildupTarget: 'lacerate',
      range: [25, 35],
    },
    description: 'Physical hits apply 25-35% of their damage as additional Lacerate buildup.'
  },

  zafaar_amulet_expose: {
    id: 'zafaar_amulet_expose',
    name: "Exposing Pendant",
    type: 'armor',
    slot: 'amulet',
    rarity: 'uncommon',
    unique: true,
    tribe: 'zafaar',
    bonuses: {},
    fixedAffix: {
      key: 'of Exposure',
      family: 'physBuildupOnPhysDmg',
      buildupTarget: 'expose',
      range: [25, 35],
    },
    description: 'Physical hits apply 25-35% of their damage as additional Expose buildup.'
  },

  // ── LE'SSE AMULETS ────────────────────────────────────────────────────────

  lesse_amulet_cold: {
    id: 'lesse_amulet_cold',
    name: "Frost Pendant",
    type: 'armor',
    slot: 'amulet',
    rarity: 'uncommon',
    unique: true,
    tribe: 'lesse',
    bonuses: {},
    fixedAffix: {
      key: 'of Frost',
      family: 'elemBuildupOnElemDmg',
      buildupTarget: 'cold',
      range: [25, 35],
    },
    description: 'Elemental hits apply 25-35% of their damage as additional Cold buildup.'
  },

  lesse_amulet_fire: {
    id: 'lesse_amulet_fire',
    name: "Ember Pendant",
    type: 'armor',
    slot: 'amulet',
    rarity: 'uncommon',
    unique: true,
    tribe: 'lesse',
    bonuses: {},
    fixedAffix: {
      key: 'of Embers',
      family: 'elemBuildupOnElemDmg',
      buildupTarget: 'fire',
      range: [25, 35],
    },
    description: 'Elemental hits apply 25-35% of their damage as additional Fire buildup.'
  },

  lesse_amulet_lightning: {
    id: 'lesse_amulet_lightning',
    name: "Storm Pendant",
    type: 'armor',
    slot: 'amulet',
    rarity: 'uncommon',
    unique: true,
    tribe: 'lesse',
    bonuses: {},
    fixedAffix: {
      key: 'of Storms',
      family: 'elemBuildupOnElemDmg',
      buildupTarget: 'lightning',
      range: [25, 35],
    },
    description: 'Elemental hits apply 25-35% of their damage as additional Lightning buildup.'
  },

  // ── ZAFAAR RINGS ──────────────────────────────────────────────────────────

  zafaar_ring_double_damage: {
    id: 'zafaar_ring_double_damage',
    name: "Gambler's Band",
    type: 'armor',
    slot: 'ring',
    rarity: 'uncommon',
    unique: true,
    tribe: 'zafaar',
    bonuses: {},
    fixedAffix: {
      key: 'of Doubling',
      family: 'procDoubleDamage',
      range: [1, 2],
    },
    description: '1-2% chance on each hit to deal double damage.'
  },

  zafaar_ring_half_damage: {
    id: 'zafaar_ring_half_damage',
    name: "Bulwark Band",
    type: 'armor',
    slot: 'ring',
    rarity: 'uncommon',
    unique: true,
    tribe: 'zafaar',
    bonuses: {},
    fixedAffix: {
      key: 'of Warding',
      family: 'procHalfDamageTaken',
      range: [1, 2],
    },
    description: '1-2% chance when struck to take only half damage.'
  },

  zafaar_ring_heal_proc: {
    id: 'zafaar_ring_heal_proc',
    name: "Mender's Band",
    type: 'armor',
    slot: 'ring',
    rarity: 'uncommon',
    unique: true,
    tribe: 'zafaar',
    bonuses: {},
    fixedAffix: {
      key: 'of Mending',
      family: 'procHealOnHeal',
      range: [1, 2],
    },
    description: '1-2% chance when casting a healing spell to heal for an additional 20.'
  },

  // ── ELSETH RINGS ──────────────────────────────────────────────────────────

  elseth_ring_elem_proc: {
    id: 'elseth_ring_elem_proc',
    name: "Elemental Band",
    type: 'armor',
    slot: 'ring',
    rarity: 'uncommon',
    unique: true,
    tribe: 'elseth',
    bonuses: {},
    fixedAffix: {
      key: 'of Elemental Burst',
      family: 'procElemFlat',
      range: [1, 2],
    },
    description: '1-2% chance on hit to deal 20 additional elemental damage.'
  },

  elseth_ring_necro_proc: {
    id: 'elseth_ring_necro_proc',
    name: "Necrotic Band",
    type: 'armor',
    slot: 'ring',
    rarity: 'uncommon',
    unique: true,
    tribe: 'elseth',
    bonuses: {},
    fixedAffix: {
      key: 'of Necrotic Burst',
      family: 'procNecroFlat',
      range: [1, 2],
    },
    description: '1-2% chance on hit to deal 20 additional necrotic damage.'
  },

  elseth_ring_phys_proc: {
    id: 'elseth_ring_phys_proc',
    name: "Force Band",
    type: 'armor',
    slot: 'ring',
    rarity: 'uncommon',
    unique: true,
    tribe: 'elseth',
    bonuses: {},
    fixedAffix: {
      key: 'of Force Burst',
      family: 'procPhysFlat',
      range: [1, 2],
    },
    description: '1-2% chance on hit to deal 20 additional physical damage.'
  },

  // ── STYX RINGS ────────────────────────────────────────────────────────────

  styx_ring_triage: {
    id: 'styx_ring_triage',
    name: "Triage Band",
    type: 'armor',
    slot: 'ring',
    rarity: 'uncommon',
    unique: true,
    tribe: 'styx',
    bonuses: {},
    grantsSkills: ['triage'],
    description: 'Grants Triage: cleanse all physical buildup from an ally. (Bonus action, CD 2)'
  },

  styx_ring_remedy: {
    id: 'styx_ring_remedy',
    name: "Remedy Band",
    type: 'armor',
    slot: 'ring',
    rarity: 'uncommon',
    unique: true,
    tribe: 'styx',
    bonuses: {},
    grantsSkills: ['remedy'],
    description: 'Grants Remedy: cleanse all necrotic buildup from an ally. (Bonus action, CD 2)'
  },

  styx_ring_weather: {
    id: 'styx_ring_weather',
    name: "Weather Band",
    type: 'armor',
    slot: 'ring',
    rarity: 'uncommon',
    unique: true,
    tribe: 'styx',
    bonuses: {},
    grantsSkills: ['weather'],
    description: 'Grants Weather: cleanse all elemental buildup from an ally. (Bonus action, CD 2)'
  },

  // ── LE'SSE RINGS ──────────────────────────────────────────────────────────

  lesse_ring_elemental_overload: {
    id: 'lesse_ring_elemental_overload',
    name: "Overload Band",
    type: 'armor',
    slot: 'ring',
    rarity: 'uncommon',
    unique: true,
    tribe: 'lesse',
    bonuses: {},
    grantsSkills: ['elemental_overload'],
    description: 'Grants Elemental Overload: all damage becomes elemental for 1 turn. (Bonus action, CD 3)'
  },

  lesse_ring_raw_force: {
    id: 'lesse_ring_raw_force',
    name: "Earthen Band",
    type: 'armor',
    slot: 'ring',
    rarity: 'uncommon',
    unique: true,
    tribe: 'lesse',
    bonuses: {},
    grantsSkills: ['raw_force'],
    description: 'Grants Raw Force: all damage becomes physical for 1 turn. (Bonus action, CD 3)'
  },

  lesse_ring_sever_spirit: {
    id: 'lesse_ring_sever_spirit',
    name: "Sever Band",
    type: 'armor',
    slot: 'ring',
    rarity: 'uncommon',
    unique: true,
    tribe: 'lesse',
    bonuses: {},
    grantsSkills: ['sever_spirit'],
    description: 'Grants Sever Spirit: all damage becomes necrotic for 1 turn. (Bonus action, CD 3)'
  }

};
