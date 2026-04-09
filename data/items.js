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
    name: 'Traveler’s Pants',
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
    name: 'Seer’s Wraps',
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
    description: 'Heavy soles protect against the path’s abuse.'
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
  }


};
