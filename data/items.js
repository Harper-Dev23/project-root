// Canonical rarity ordering, low to high — the numeric-comparison source of
// truth (see RARITY_COLORS in styles.js for the matching color map; keep
// both in sync if a tier is ever added/renamed).
export const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'historic'];

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

  // === Sacred Relics ===
  waystone_shard: {
    id: 'waystone_shard',
    name: 'Waystone Shard',
    type: 'relic',
    rarity: 'rare',
    locked: true,           // cannot be transferred, moved, or sold
    onUse: 'waystone_shard_menu',
    description: 'A fragment of the island\'s sacred waystone network, attuned to your presence. It tracks hunt progress and prophet favor.',
  },

  // === Crude Weapons (Common Rarity) ===
  crude_dagger: {
    id: 'crude_dagger',
    baseTier: 1,
    name: 'Crude Dagger',
    type: 'weapon',
    weaponType: 'dagger',
    rarity: 'common',
    bonuses: {},
    hands: 1,
    damage: { min: 6, max: 7 },
    description: 'A dull but quick blade ideal for close jabs.'
  },

  crude_sword_1h: {
    id: 'crude_sword_1h',
    baseTier: 1,
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
    baseTier: 1,
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
    baseTier: 1,
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
    baseTier: 1,
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
    baseTier: 1,
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
    baseTier: 1,
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
    baseTier: 1,
    name: 'Crude Bow',
    type: 'weapon',
    weaponType: 'bow',
    rarity: 'common',
    bonuses: {},
    hands: 2,
    damage: { min: 6, max: 13 },
    description: 'A creaky bow that fires arrows unevenly.'
  },

  crude_gun: {
    id: 'crude_gun',
    baseTier: 1,
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
    baseTier: 1,
    name: 'Crude Staff',
    type: 'weapon',
    weaponType: 'staff',
    rarity: 'common',
    bonuses: {},
    hands: 2,
    damage: { min: 7, max: 12 },
    description: 'A warped staff with faint magical traces.'
  },

  crude_wand: {
    id: 'crude_wand',
    baseTier: 1,
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
    baseTier: 1,
    name: 'Crude War Mace',
    type: 'weapon',
    weaponType: 'mace_2h',
    rarity: 'common',
    bonuses: {},
    hands: 2,
    damage: { min: 8, max: 11 },
    description: 'A massive iron mace with crushing force.'
  },

  crude_axe_2h: {
    id: 'crude_axe_2h',
    baseTier: 1,
    name: 'Crude Battle Axe',
    type: 'weapon',
    weaponType: 'axe_2h',
    rarity: 'common',
    bonuses: {},
    hands: 2,
    // Was 8-13 — matched to mace_2h's 7-12 for balance (both are the same
    // "heavy 2h blunt/bleed" tier of weapon, no reason for axe to roll a
    // flat point higher on both ends).
    damage: { min: 7, max: 12 },
    description: 'A brutal axe with a chipped but deadly edge.'
  },
  // === Natural Weapons (beasts) ==============================================
  // Beasts do not wield gear. They were previously stat-equipped with a
  // `crude_dagger` purely so calculateDamage() had real weapon dice to roll,
  // which meant a Severing Chant could cut a literal dagger off an animal.
  // These exist so the dice are real and the FICTION is too.
  //
  // `natural: true` is the flag every pool and the sever/identify paths check.
  // They are never dropped, never gambled, never found, and never severed.
  // Damage matches the crude_dagger they replace exactly, so this is a
  // presentation fix with no balance change -- but each beast now has its own
  // item, so the dice CAN be dialled per beast without touching the others.
  natural_fangs: {
    id: 'natural_fangs',
    baseTier: 1,
    natural: true,
    name: 'Fangs',
    type: 'weapon',
    weaponType: 'natural',
    rarity: 'common',
    bonuses: {},
    hands: 1,
    damage: { min: 6, max: 7 },
    description: 'A jaw built for closing on something and not letting go.'
  },
  natural_claws: {
    id: 'natural_claws',
    baseTier: 1,
    natural: true,
    name: 'Claws',
    type: 'weapon',
    weaponType: 'natural',
    rarity: 'common',
    bonuses: {},
    hands: 1,
    damage: { min: 6, max: 7 },
    description: 'Four points of horn that were never made, only grown.'
  },
  natural_talons: {
    id: 'natural_talons',
    baseTier: 1,
    natural: true,
    name: 'Talons',
    type: 'weapon',
    weaponType: 'natural',
    rarity: 'common',
    bonuses: {},
    hands: 1,
    damage: { min: 6, max: 7 },
    description: 'They close before the bird has finished arriving.'
  },

  // === Hardened Weapons (base tier 2) =========================================
  // Tier 2 of the base ladder: ~20% over Crude on both ends, and nothing else.
  // The tier buys raw base damage, which every '% weapon damage' affix then
  // scales -- same reason Bone's bonus lives in `damage` rather than as a mod.
  // Bone stays a separate, PARALLEL base and is untouched by this ladder.
  hardened_dagger: {
    id: 'hardened_dagger',
    baseTier: 2,
    name: 'Hardened Dagger',
    type: 'weapon',
    weaponType: 'dagger',
    rarity: 'common',
    bonuses: {},
    hands: 1,
    damage: { min: 7, max: 8 },
    description: 'Properly tempered and set in a fitted grip. It no longer turns in the hand.'
  },
  hardened_sword_1h: {
    id: 'hardened_sword_1h',
    baseTier: 2,
    name: 'Hardened Sword',
    type: 'weapon',
    weaponType: 'sword_1h',
    rarity: 'common',
    bonuses: {},
    hands: 1,
    damage: { min: 6, max: 10 },
    description: 'Hammered flat, edged and balanced by someone who knew the trade.'
  },
  hardened_bow: {
    id: 'hardened_bow',
    baseTier: 2,
    name: 'Hardened Bow',
    type: 'weapon',
    weaponType: 'bow',
    rarity: 'common',
    bonuses: {},
    hands: 2,
    damage: { min: 7, max: 16 },
    description: 'Laminated horn over seasoned wood. It throws a shaft further than it has any right to.'
  },
  hardened_staff: {
    id: 'hardened_staff',
    baseTier: 2,
    name: 'Hardened Staff',
    type: 'weapon',
    weaponType: 'staff',
    rarity: 'common',
    bonuses: {},
    hands: 2,
    damage: { min: 8, max: 14 },
    description: 'Cut on the right day and bound at both ends. The channel runs clean through it.'
  },
  hardened_mace_2h: {
    id: 'hardened_mace_2h',
    baseTier: 2,
    name: 'Hardened War Mace',
    type: 'weapon',
    weaponType: 'mace_2h',
    rarity: 'common',
    bonuses: {},
    hands: 2,
    damage: { min: 10, max: 13 },
    description: 'A banded head sunk onto a haft that was chosen, not found.'
  },
  hardened_axe_2h: {
    id: 'hardened_axe_2h',
    baseTier: 2,
    name: 'Hardened Battle Axe',
    type: 'weapon',
    weaponType: 'axe_2h',
    rarity: 'common',
    bonuses: {},
    hands: 2,
    damage: { min: 8, max: 14 },
    description: 'Forge-set and wedged tight. The bit holds its edge through bone.'
  },
  hardened_shield: {
    id: 'hardened_shield',
    baseTier: 2,
    name: 'Hardened Shield',
    type: 'weapon',
    weaponType: 'shield',
    rarity: 'common',
    bonuses: {},
    hands: 1,
    description: 'Planked, glued crosswise and rimmed in hide. It takes a blow without splitting.'
  },

  // === Ancestral Weapons (base tier 3) =======================================
  // ~45% over Crude. Gated past the current level ceiling on purpose --
  // see BASE_TIER_RULES in ItemFactory.js.
  ancestral_dagger: {
    id: 'ancestral_dagger',
    baseTier: 3,
    name: 'Ancestral Dagger',
    type: 'weapon',
    weaponType: 'dagger',
    rarity: 'common',
    bonuses: {},
    hands: 1,
    damage: { min: 9, max: 10 },
    description: 'Passed down long enough that nobody living remembers the name on it.'
  },
  ancestral_sword_1h: {
    id: 'ancestral_sword_1h',
    baseTier: 3,
    name: 'Ancestral Sword',
    type: 'weapon',
    weaponType: 'sword_1h',
    rarity: 'common',
    bonuses: {},
    hands: 1,
    damage: { min: 7, max: 12 },
    description: 'Old steel, folded and refolded. The edge has outlasted every hand that held it.'
  },
  ancestral_bow: {
    id: 'ancestral_bow',
    baseTier: 3,
    name: 'Ancestral Bow',
    type: 'weapon',
    weaponType: 'bow',
    rarity: 'common',
    bonuses: {},
    hands: 2,
    damage: { min: 9, max: 19 },
    description: 'Strung with the same cord for three generations. It knows the draw before you do.'
  },
  ancestral_staff: {
    id: 'ancestral_staff',
    baseTier: 3,
    name: 'Ancestral Staff',
    type: 'weapon',
    weaponType: 'staff',
    rarity: 'common',
    bonuses: {},
    hands: 2,
    damage: { min: 10, max: 17 },
    description: 'Worn smooth by hands that are all dead now. What they channelled is still in the grain.'
  },
  ancestral_mace_2h: {
    id: 'ancestral_mace_2h',
    baseTier: 3,
    name: 'Ancestral War Mace',
    type: 'weapon',
    weaponType: 'mace_2h',
    rarity: 'common',
    bonuses: {},
    hands: 2,
    damage: { min: 12, max: 16 },
    description: 'The head is older than the haft, and the haft is older than the tribe.'
  },
  ancestral_axe_2h: {
    id: 'ancestral_axe_2h',
    baseTier: 3,
    name: 'Ancestral Battle Axe',
    type: 'weapon',
    weaponType: 'axe_2h',
    rarity: 'common',
    bonuses: {},
    hands: 2,
    damage: { min: 10, max: 17 },
    description: 'It has taken more than it was ever given, and it remembers the difference.'
  },
  ancestral_shield: {
    id: 'ancestral_shield',
    baseTier: 3,
    name: 'Ancestral Shield',
    type: 'weapon',
    weaponType: 'shield',
    rarity: 'common',
    bonuses: {},
    hands: 1,
    description: 'Every dent in it stopped something. None of them went through.'
  },

  // === Bone Weapons (renown-capable) =========================================
  // Their own base type, NOT a Crude weapon with a bonus attached. Damage is
  // ~20% above the Crude equivalent and is ordinary base damage, so "% weapon
  // damage" affixes scale it exactly as they scale any other weapon.
  //
  // `renownOrigin` does two jobs: createItemInstance stamps the renown fields
  // onto any instance of these, and the gamble pools exclude anything carrying
  // an origin so Bone never drops at normal rates (see BONE_DROP_CHANCE).

  bone_dagger: {
    id: 'bone_dagger',
    baseTier: 1,
    name: 'Bone Dagger',
    type: 'weapon',
    weaponType: 'dagger',
    rarity: 'common',
    bonuses: {},
    hands: 1,
    damage: { min: 7, max: 9 },
    renownOrigin: 'bone',
    description: 'Carved from something that did not want to die. A dull but quick blade ideal for close jabs.'
  },

  bone_sword_1h: {
    id: 'bone_sword_1h',
    baseTier: 1,
    name: 'Bone Sword',
    type: 'weapon',
    weaponType: 'sword_1h',
    rarity: 'common',
    bonuses: {},
    hands: 1,
    damage: { min: 6, max: 10 },
    renownOrigin: 'bone',
    description: 'Carved from something that did not want to die. A rusted short sword with chipped edges.'
  },

  bone_sword_2h: {
    id: 'bone_sword_2h',
    baseTier: 1,
    name: 'Bone Greatsword',
    type: 'weapon',
    weaponType: 'sword_2h',
    rarity: 'common',
    bonuses: {},
    hands: 2,
    damage: { min: 8, max: 15 },
    renownOrigin: 'bone',
    description: 'Carved from something that did not want to die. A heavy, unwieldy blade that deals brutal strikes.'
  },

  bone_spear_1h: {
    id: 'bone_spear_1h',
    baseTier: 1,
    name: 'Bone Spear',
    type: 'weapon',
    weaponType: 'spear_1h',
    rarity: 'common',
    bonuses: {},
    hands: 1,
    damage: { min: 6, max: 10 },
    renownOrigin: 'bone',
    description: 'Carved from something that did not want to die. A splintered spear good for keeping distance.'
  },

  bone_whip: {
    id: 'bone_whip',
    baseTier: 1,
    name: 'Bone Whip',
    type: 'weapon',
    weaponType: 'whip',
    rarity: 'common',
    bonuses: {},
    hands: 1,
    damage: { min: 4, max: 8 },
    renownOrigin: 'bone',
    description: 'Carved from something that did not want to die. A worn leather whip with faded stitching.'
  },

  bone_shield: {
    id: 'bone_shield',
    baseTier: 1,
    name: 'Bone Shield',
    type: 'weapon',
    weaponType: 'shield',
    rarity: 'common',
    bonuses: {},
    hands: 1,
    renownOrigin: 'bone',
    description: 'Carved from something that did not want to die. A battered wooden shield with faded paint.'
  },

  bone_sling: {
    id: 'bone_sling',
    baseTier: 1,
    name: 'Bone Sling',
    type: 'weapon',
    weaponType: 'sling',
    rarity: 'common',
    bonuses: {},
    hands: 1,
    damage: { min: 5, max: 8 },
    renownOrigin: 'bone',
    description: 'Carved from something that did not want to die. A frayed sling made from scrap cord.'
  },

  bone_bow: {
    id: 'bone_bow',
    baseTier: 1,
    name: 'Bone Bow',
    type: 'weapon',
    weaponType: 'bow',
    rarity: 'common',
    bonuses: {},
    hands: 2,
    damage: { min: 7, max: 16 },
    renownOrigin: 'bone',
    description: 'Carved from something that did not want to die. A creaky bow that fires arrows unevenly.'
  },

  bone_gun: {
    id: 'bone_gun',
    baseTier: 1,
    name: 'Bone Gun',
    type: 'weapon',
    weaponType: 'gun',
    rarity: 'common',
    bonuses: {},
    hands: 2,
    damage: { min: 8, max: 14 },
    renownOrigin: 'bone',
    description: 'Carved from something that did not want to die. An unreliable firearm prone to misfires.'
  },

  bone_staff: {
    id: 'bone_staff',
    baseTier: 1,
    name: 'Bone Staff',
    type: 'weapon',
    weaponType: 'staff',
    rarity: 'common',
    bonuses: {},
    hands: 2,
    damage: { min: 9, max: 14 },
    renownOrigin: 'bone',
    description: 'Carved from something that did not want to die. A warped staff with faint magical traces.'
  },

  bone_wand: {
    id: 'bone_wand',
    baseTier: 1,
    name: 'Bone Wand',
    type: 'weapon',
    weaponType: 'wand',
    rarity: 'common',
    bonuses: {},
    hands: 1,
    damage: { min: 5, max: 8 },
    renownOrigin: 'bone',
    description: 'Carved from something that did not want to die. A brittle wand that sputters sparks.'
  },

  bone_mace_2h: {
    id: 'bone_mace_2h',
    baseTier: 1,
    name: 'Bone War Mace',
    type: 'weapon',
    weaponType: 'mace_2h',
    rarity: 'common',
    bonuses: {},
    hands: 2,
    damage: { min: 10, max: 13 },
    renownOrigin: 'bone',
    description: 'Carved from something that did not want to die. A massive iron mace with crushing force.'
  },

  bone_axe_2h: {
    id: 'bone_axe_2h',
    baseTier: 1,
    name: 'Bone Battle Axe',
    type: 'weapon',
    weaponType: 'axe_2h',
    rarity: 'common',
    bonuses: {},
    hands: 2,
    damage: { min: 8, max: 15 },
    renownOrigin: 'bone',
    description: 'Carved from something that did not want to die. A brutal axe with a chipped but deadly edge.'
  },


  // === Common Armor (Watershade) ===
  simple_helm_str: {
    id: 'simple_helm_str',
    baseTier: 1,
    name: 'Simple Helm',
    type: 'armor',
    slot: 'head',
    rarity: 'common',
    bonuses: { STR: 1 },
    description: 'A basic iron helm that strengthens the neck.'
  },
  simple_helm_dex: {
    id: 'simple_helm_dex',
    baseTier: 1,
    name: 'Light Cap',
    type: 'armor',
    slot: 'head',
    rarity: 'common',
    bonuses: { DEX: 1 },
    description: 'A soft leather cap, suited for nimble movement.'
  },
  simple_helm_int: {
    id: 'simple_helm_int',
    baseTier: 1,
    name: 'Mystic Hood',
    type: 'armor',
    slot: 'head',
    rarity: 'common',
    bonuses: { INT: 1 },
    description: 'A hood embroidered with faint glyphs.'
  },

  simple_chest_con_str: {
    id: 'simple_chest_con_str',
    baseTier: 1,
    name: 'Tough Vest',
    type: 'armor',
    slot: 'chest',
    rarity: 'common',
    bonuses: { CON: 1, STR: 1 },
    description: 'Worn hide layered for protection and power.'
  },
  simple_chest_dex_int: {
    id: 'simple_chest_dex_int',
    baseTier: 1,
    name: 'Balanced Robe',
    type: 'armor',
    slot: 'chest',
    rarity: 'common',
    bonuses: { DEX: 1, INT: 1 },
    description: 'Flexible fabric robe with slight arcane traces.'
  },
  simple_chest_wis_con: {
    id: 'simple_chest_wis_con',
    baseTier: 1,
    name: 'Padded Tunic',
    type: 'armor',
    slot: 'chest',
    rarity: 'common',
    bonuses: { WIS: 1, CON: 1 },
    description: 'Stuffed layers grant warmth and fortitude.'
  },

  simple_legs_con: {
    id: 'simple_legs_con',
    baseTier: 1,
    name: "Traveler's Pants",
    type: 'armor',
    slot: 'legs',
    rarity: 'common',
    bonuses: { CON: 1 },
    description: 'Rugged trousers built for long marches.'
  },
  simple_legs_dex: {
    id: 'simple_legs_dex',
    baseTier: 1,
    name: 'Tight Slacks',
    type: 'armor',
    slot: 'legs',
    rarity: 'common',
    bonuses: { DEX: 1 },
    description: 'Close-fitted pants for agile movement.'
  },
  simple_legs_wis: {
    id: 'simple_legs_wis',
    baseTier: 1,
    name: "Seer's Wraps",
    type: 'armor',
    slot: 'legs',
    rarity: 'common',
    bonuses: { WIS: 1 },
    description: 'Flowing wraps said to aid focus.'
  },

  simple_gloves_dex: {
    id: 'simple_gloves_dex',
    baseTier: 1,
    name: 'Leather Gloves',
    type: 'armor',
    slot: 'gloves',
    rarity: 'common',
    bonuses: { DEX: 1 },
    description: 'Supple gloves ideal for quick hands.'
  },
  simple_gloves_str: {
    id: 'simple_gloves_str',
    baseTier: 1,
    name: 'Thick Gloves',
    type: 'armor',
    slot: 'gloves',
    rarity: 'common',
    bonuses: { STR: 1 },
    description: 'Padded palms for heavy lifting.'
  },
  simple_gloves_int: {
    id: 'simple_gloves_int',
    baseTier: 1,
    name: 'Mage Mitts',
    type: 'armor',
    slot: 'gloves',
    rarity: 'common',
    bonuses: { INT: 1 },
    description: 'Faintly warm to the touch with energy.'
  },

  simple_boots_con: {
    id: 'simple_boots_con',
    baseTier: 1,
    name: 'Sturdy Boots',
    type: 'armor',
    slot: 'boots',
    rarity: 'common',
    bonuses: { CON: 1 },
    description: "Heavy soles protect against the path's abuse."
  },
  simple_boots_dex: {
    id: 'simple_boots_dex',
    baseTier: 1,
    name: 'Silent Footwraps',
    type: 'armor',
    slot: 'boots',
    rarity: 'common',
    bonuses: { DEX: 1 },
    description: 'Designed to minimize noise while moving.'
  },
  simple_boots_wis: {
    id: 'simple_boots_wis',
    baseTier: 1,
    name: 'Pilgrim Sandals',
    type: 'armor',
    slot: 'boots',
    rarity: 'common',
    bonuses: { WIS: 1 },
    description: 'Open-toed sandals used in meditation rituals.'
  },

  // === Fitted Armor (base tier 2) ============================================
  // Tier 2 of the armour ladder: the same slots, each carrying ONE more stat
  // than its Simple counterpart (three on chest, two everywhere else).
  // `bonuses` is already summed generically, so this needs no new mechanic.
  fitted_head_str_con: {
    id: 'fitted_head_str_con',
    baseTier: 2,
    name: "Ridged Helm",
    type: 'armor',
    slot: 'head',
    rarity: 'common',
    bonuses: { STR: 1, CON: 1 },
    description: 'A helm with a raised spine, beaten thick over the crown.'
  },
  fitted_head_dex_wis: {
    id: 'fitted_head_dex_wis',
    baseTier: 2,
    name: "Hunter's Cowl",
    type: 'armor',
    slot: 'head',
    rarity: 'common',
    bonuses: { DEX: 1, WIS: 1 },
    description: 'Cut close to the ears so nothing in the brush goes unheard.'
  },
  fitted_head_int_wis: {
    id: 'fitted_head_int_wis',
    baseTier: 2,
    name: "Augur's Circlet",
    type: 'armor',
    slot: 'head',
    rarity: 'common',
    bonuses: { INT: 1, WIS: 1 },
    description: 'A thin band that sits where the sight is said to gather.'
  },
  fitted_chest_con_str_dex: {
    id: 'fitted_chest_con_str_dex',
    baseTier: 2,
    name: "Banded Hauberk",
    type: 'armor',
    slot: 'chest',
    rarity: 'common',
    bonuses: { CON: 1, STR: 1, DEX: 1 },
    description: 'Overlapping bands that carry weight without locking the shoulder.'
  },
  fitted_chest_dex_int_wis: {
    id: 'fitted_chest_dex_int_wis',
    baseTier: 2,
    name: "Woven Mantle",
    type: 'armor',
    slot: 'chest',
    rarity: 'common',
    bonuses: { DEX: 1, INT: 1, WIS: 1 },
    description: 'Layered weave, light enough to forget and dense enough to matter.'
  },
  fitted_chest_wis_con_int: {
    id: 'fitted_chest_wis_con_int',
    baseTier: 2,
    name: "Ritual Vestment",
    type: 'armor',
    slot: 'chest',
    rarity: 'common',
    bonuses: { WIS: 1, CON: 1, INT: 1 },
    description: 'Marked at the seams in a hand no living seer writes in.'
  },
  fitted_legs_con_str: {
    id: 'fitted_legs_con_str',
    baseTier: 2,
    name: "Marching Greaves",
    type: 'armor',
    slot: 'legs',
    rarity: 'common',
    bonuses: { CON: 1, STR: 1 },
    description: 'Built for long ground, and for standing at the end of it.'
  },
  fitted_legs_dex_con: {
    id: 'fitted_legs_dex_con',
    baseTier: 2,
    name: "Stalker's Leggings",
    type: 'armor',
    slot: 'legs',
    rarity: 'common',
    bonuses: { DEX: 1, CON: 1 },
    description: 'Soft at the seam so the step lands quiet and still stays under you.'
  },
  fitted_legs_wis_int: {
    id: 'fitted_legs_wis_int',
    baseTier: 2,
    name: "Oracle Drapes",
    type: 'armor',
    slot: 'legs',
    rarity: 'common',
    bonuses: { WIS: 1, INT: 1 },
    description: 'Loose enough to sit in for a very long time without moving.'
  },
  fitted_gloves_dex_str: {
    id: 'fitted_gloves_dex_str',
    baseTier: 2,
    name: "Gripped Handguards",
    type: 'armor',
    slot: 'gloves',
    rarity: 'common',
    bonuses: { DEX: 1, STR: 1 },
    description: 'Cross-stitched palms that hold a wet haft.'
  },
  fitted_gloves_str_con: {
    id: 'fitted_gloves_str_con',
    baseTier: 2,
    name: "Ironbound Gauntlets",
    type: 'armor',
    slot: 'gloves',
    rarity: 'common',
    bonuses: { STR: 1, CON: 1 },
    description: 'Plated across the knuckle, laced tight at the wrist.'
  },
  fitted_gloves_int_dex: {
    id: 'fitted_gloves_int_dex',
    baseTier: 2,
    name: "Channeler's Vambraces",
    type: 'armor',
    slot: 'gloves',
    rarity: 'common',
    bonuses: { INT: 1, DEX: 1 },
    description: 'Bound forearm to fingertip so nothing leaks at the wrist.'
  },
  fitted_boots_con_str: {
    id: 'fitted_boots_con_str',
    baseTier: 2,
    name: "Anchored Boots",
    type: 'armor',
    slot: 'boots',
    rarity: 'common',
    bonuses: { CON: 1, STR: 1 },
    description: 'Heavy at the heel. Hard to move, and harder to move off.'
  },
  fitted_boots_dex_wis: {
    id: 'fitted_boots_dex_wis',
    baseTier: 2,
    name: "Trailrunner Boots",
    type: 'armor',
    slot: 'boots',
    rarity: 'common',
    bonuses: { DEX: 1, WIS: 1 },
    description: 'Broken in over more country than most people ever see.'
  },
  fitted_boots_wis_con: {
    id: 'fitted_boots_wis_con',
    baseTier: 2,
    name: "Warden's Treads",
    type: 'armor',
    slot: 'boots',
    rarity: 'common',
    bonuses: { WIS: 1, CON: 1 },
    description: 'Made for the watch: for staying awake, and for staying put.'
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
    name: 'Elseth Pendant',
    type: 'armor', slot: 'amulet', rarity: 'uncommon', unique: true, tribe: 'elseth', bonuses: {},
    fixedAffix: { key: 'of Conversion', family: 'physToElemPercent', range: [25, 35] },
  },

  elseth_amulet_phys_to_necro: {
    id: 'elseth_amulet_phys_to_necro',
    name: 'Elseth Pendant',
    type: 'armor', slot: 'amulet', rarity: 'uncommon', unique: true, tribe: 'elseth', bonuses: {},
    fixedAffix: { key: 'of Corruption', family: 'physToNecroPercent', range: [25, 35] },
  },

  elseth_amulet_elem_to_necro: {
    id: 'elseth_amulet_elem_to_necro',
    name: 'Elseth Pendant',
    type: 'armor', slot: 'amulet', rarity: 'uncommon', unique: true, tribe: 'elseth', bonuses: {},
    fixedAffix: { key: 'of the Void', family: 'elemToNecroPercent', range: [25, 35] },
  },

  // ── STYX AMULETS ─────────────────────────────────────────────────────────

  styx_amulet_initiative: {
    id: 'styx_amulet_initiative',
    name: 'Styx Pendant',
    type: 'armor', slot: 'amulet', rarity: 'uncommon', unique: true, tribe: 'styx', bonuses: {},
    fixedAffix: { key: 'of the First Strike', family: 'initBonusOnBattleStart', range: [15, 25] },
  },

  styx_amulet_cooldown: {
    id: 'styx_amulet_cooldown',
    name: 'Styx Pendant',
    type: 'armor', slot: 'amulet', rarity: 'uncommon', unique: true, tribe: 'styx', bonuses: {},
    fixedAffix: { key: 'of Haste' },   // naming-only: no range/family
    grantsSkills: ['hasten'],
  },

  styx_amulet_shield: {
    id: 'styx_amulet_shield',
    name: 'Styx Pendant',
    type: 'armor', slot: 'amulet', rarity: 'uncommon', unique: true, tribe: 'styx', bonuses: {},
    fixedAffix: { key: 'of the Ward', family: 'shieldPctOnBattleStart', range: [15, 25] },
  },

  // ── ZAFAAR AMULETS ────────────────────────────────────────────────────────

  zafaar_amulet_disorient: {
    id: 'zafaar_amulet_disorient',
    name: 'Zafaar Pendant',
    type: 'armor', slot: 'amulet', rarity: 'uncommon', unique: true, tribe: 'zafaar', bonuses: {},
    fixedAffix: { key: 'of Disorientation', family: 'physBuildupOnPhysDmg', buildupTarget: 'disorient', range: [160, 210] },
  },

  zafaar_amulet_lacerate: {
    id: 'zafaar_amulet_lacerate',
    name: 'Zafaar Pendant',
    type: 'armor', slot: 'amulet', rarity: 'uncommon', unique: true, tribe: 'zafaar', bonuses: {},
    fixedAffix: { key: 'of Lacerations', family: 'physBuildupOnPhysDmg', buildupTarget: 'lacerate', range: [160, 210] },
  },

  zafaar_amulet_expose: {
    id: 'zafaar_amulet_expose',
    name: 'Zafaar Pendant',
    type: 'armor', slot: 'amulet', rarity: 'uncommon', unique: true, tribe: 'zafaar', bonuses: {},
    fixedAffix: { key: 'of Exposure', family: 'physBuildupOnPhysDmg', buildupTarget: 'expose', range: [160, 210] },
  },

  // ── LE'SSE AMULETS ────────────────────────────────────────────────────────

  lesse_amulet_cold: {
    id: 'lesse_amulet_cold',
    name: "Le'sse Pendant",
    type: 'armor', slot: 'amulet', rarity: 'uncommon', unique: true, tribe: 'lesse', bonuses: {},
    fixedAffix: { key: 'of Frost', family: 'elemBuildupOnElemDmg', buildupTarget: 'cold', range: [160, 210] },
  },

  lesse_amulet_fire: {
    id: 'lesse_amulet_fire',
    name: "Le'sse Pendant",
    type: 'armor', slot: 'amulet', rarity: 'uncommon', unique: true, tribe: 'lesse', bonuses: {},
    fixedAffix: { key: 'of Embers', family: 'elemBuildupOnElemDmg', buildupTarget: 'fire', range: [160, 210] },
  },

  lesse_amulet_lightning: {
    id: 'lesse_amulet_lightning',
    name: "Le'sse Pendant",
    type: 'armor', slot: 'amulet', rarity: 'uncommon', unique: true, tribe: 'lesse', bonuses: {},
    fixedAffix: { key: 'of Storms', family: 'elemBuildupOnElemDmg', buildupTarget: 'lightning', range: [160, 210] },
  },

  // ── ZAFAAR RINGS ──────────────────────────────────────────────────────────

  zafaar_ring_double_damage: {
    id: 'zafaar_ring_double_damage',
    name: 'Zafaar Band',
    type: 'armor', slot: 'ring', rarity: 'uncommon', unique: true, tribe: 'zafaar', bonuses: {},
    fixedAffix: { key: 'of Doubling', family: 'procDoubleDamage', range: [3, 5] },
  },

  zafaar_ring_half_damage: {
    id: 'zafaar_ring_half_damage',
    name: 'Zafaar Band',
    type: 'armor', slot: 'ring', rarity: 'uncommon', unique: true, tribe: 'zafaar', bonuses: {},
    fixedAffix: { key: 'of Warding', family: 'procHalfDamageTaken', range: [3, 5] },
  },

  zafaar_ring_heal_proc: {
    id: 'zafaar_ring_heal_proc',
    name: 'Zafaar Band',
    type: 'armor', slot: 'ring', rarity: 'uncommon', unique: true, tribe: 'zafaar', bonuses: {},
    fixedAffix: { key: 'of Mending', family: 'procHealOnHeal', range: [3, 5] },
  },

  // ── ELSETH RINGS ──────────────────────────────────────────────────────────

  elseth_ring_elem_proc: {
    id: 'elseth_ring_elem_proc',
    name: 'Elseth Band',
    type: 'armor', slot: 'ring', rarity: 'uncommon', unique: true, tribe: 'elseth', bonuses: {},
    fixedAffix: { key: 'of Elemental Burst', family: 'procElemFlat', range: [3, 5] },
  },

  elseth_ring_necro_proc: {
    id: 'elseth_ring_necro_proc',
    name: 'Elseth Band',
    type: 'armor', slot: 'ring', rarity: 'uncommon', unique: true, tribe: 'elseth', bonuses: {},
    fixedAffix: { key: 'of Necrotic Burst', family: 'procNecroFlat', range: [3, 5] },
  },

  elseth_ring_phys_proc: {
    id: 'elseth_ring_phys_proc',
    name: 'Elseth Band',
    type: 'armor', slot: 'ring', rarity: 'uncommon', unique: true, tribe: 'elseth', bonuses: {},
    fixedAffix: { key: 'of Force Burst', family: 'procPhysFlat', range: [3, 5] },
  },

  // ── STYX RINGS ────────────────────────────────────────────────────────────

  styx_ring_triage: {
    id: 'styx_ring_triage',
    name: 'Styx Band',
    type: 'armor', slot: 'ring', rarity: 'uncommon', unique: true, tribe: 'styx', bonuses: {},
    fixedAffix: { key: 'of Triage' },   // naming-only
    grantsSkills: ['triage'],
  },

  styx_ring_remedy: {
    id: 'styx_ring_remedy',
    name: 'Styx Band',
    type: 'armor', slot: 'ring', rarity: 'uncommon', unique: true, tribe: 'styx', bonuses: {},
    fixedAffix: { key: 'of Remedy' },   // naming-only
    grantsSkills: ['remedy'],
  },

  styx_ring_weather: {
    id: 'styx_ring_weather',
    name: 'Styx Band',
    type: 'armor', slot: 'ring', rarity: 'uncommon', unique: true, tribe: 'styx', bonuses: {},
    fixedAffix: { key: 'of Weathering' },   // naming-only
    grantsSkills: ['weather'],
  },

  // ── LE'SSE RINGS ──────────────────────────────────────────────────────────

  lesse_ring_elemental_overload: {
    id: 'lesse_ring_elemental_overload',
    name: "Le'sse Band",
    type: 'armor', slot: 'ring', rarity: 'uncommon', unique: true, tribe: 'lesse', bonuses: {},
    fixedAffix: { key: 'of Overload' },   // naming-only
    grantsSkills: ['elemental_overload'],
  },

  lesse_ring_raw_force: {
    id: 'lesse_ring_raw_force',
    name: "Le'sse Band",
    type: 'armor', slot: 'ring', rarity: 'uncommon', unique: true, tribe: 'lesse', bonuses: {},
    fixedAffix: { key: 'of Raw Force' },   // naming-only
    grantsSkills: ['raw_force'],
  },

  lesse_ring_sever_spirit: {
    id: 'lesse_ring_sever_spirit',
    name: "Le'sse Band",
    type: 'armor', slot: 'ring', rarity: 'uncommon', unique: true, tribe: 'lesse', bonuses: {},
    fixedAffix: { key: 'of Spirit Severing' },   // naming-only
    grantsSkills: ['sever_spirit'],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // === Historic Weapons ===
  // ═══════════════════════════════════════════════════════════════════════════

  bloodthirster: {
    id: 'bloodthirster',
    name: 'Bloodthirster',
    type: 'weapon',
    weaponType: 'sword_2h',
    // rarity is the display/color tier — see RARITY_COLORS in styles.js
    // (the single shared source; other files import it, don't redefine it).
    // Rarity tiers, low to high: common < uncommon < rare < epic < legendary
    // < historic. 'historic' is the top tier for one-of-a-kind quest/story
    // items like this one — gold, same visual weight a "unique" tier would
    // have had, we just don't keep a separately-named tier for it.
    //
    // NOTE: the `historic: true` boolean right below is a DIFFERENT, older
    // system (drives renown/history-tracking — kills, damage dealt, battles
    // carried, see item.history) that predates the rarity tier being named
    // the same thing. They now share a name but aren't the same field.
    rarity: 'historic',
    historic: true,
    unique: true,  // soulbound is earned — granted on quest completion, not by default
    hands: 2,
    // -30% from the original 20-32 (14-22.4, rounded) — a quick, un-tuned
    // trim while the Berserker gets a real base-stat block on top of this;
    // no real balance pass on the weapon itself yet, just a blunt reduction.
    damage: { min: 14, max: 22 },
    bonuses: { STR: 5, CON: 4 },
    lifeStealPct: 0.10,  // heals wielder for 10% of damage dealt
    locked: true,
    description: 'A two-handed blade of impossible sharpness. It drinks deep of whatever it cuts. The edge never dulls.\n\n[10% Lifesteal]  [Soulbound]',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // === Hunt Plans ===
  // Generic loadout items chosen before departing on a Hunt (see HuntHubOverlay).
  // Static modifiers, no affix rolling — same pattern as consumables/relics above.
  // ═══════════════════════════════════════════════════════════════════════════

  hunt_plan: {
    id: 'hunt_plan',
    name: 'Hunt Plan',
    type: 'huntPlan',
    rarity: 'common',
    description: 'A loadout plan chosen before departing on a Hunt. Its modifiers come from rolled affixes — higher rarity means more of them.',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // === Combat Utility Consumables (Identify / Sever) ===
  // Usable ONLY in combat (bonus action, no MP, any enemy is a valid target —
  // see CombatScene._useCombatItem, the dispatch point for `combatUse`).
  // `combatUse.maxRarity` is a hard gate against RARITY_ORDER: fizzles (no
  // action or item spent) if the targeted slot's item is above that tier —
  // these are free-for-testing utility items, not meant to touch Legendary/
  // Historic gear. Free (cost: 0) at the Whispering Cloth vendor.
  // ═══════════════════════════════════════════════════════════════════════════

  identify_weapon_tonic: {
    id: 'identify_weapon_tonic',
    name: 'Weapon-Reading Tonic',
    type: 'consumable',
    rarity: 'common',
    combatUse: { kind: 'identify', category: 'weapon', maxRarity: 'epic' },
    description: 'Combat only, bonus action, no target restriction. Reveals the true identity of an enemy\'s weapon (up to Epic) for the rest of the fight. Does not unbind it.',
  },
  identify_armor_tonic: {
    id: 'identify_armor_tonic',
    name: 'Armor-Reading Tonic',
    type: 'consumable',
    rarity: 'common',
    combatUse: { kind: 'identify', category: 'armor', maxRarity: 'epic' },
    description: 'Combat only, bonus action, no target restriction. Reveals the true identity of an enemy\'s armor pieces (up to Epic) for the rest of the fight. Does not unbind them.',
  },
  identify_jewelry_tonic: {
    id: 'identify_jewelry_tonic',
    name: 'Jewelry-Reading Tonic',
    type: 'consumable',
    rarity: 'common',
    combatUse: { kind: 'identify', category: 'jewelry', maxRarity: 'epic' },
    description: 'Combat only, bonus action, no target restriction. Reveals the true identity of an enemy\'s ring and amulet (up to Epic) for the rest of the fight. Does not unbind them.',
  },

  sever_weaponMain: {
    id: 'sever_weaponMain',
    name: 'Severing Chant: Main Hand',
    type: 'consumable',
    rarity: 'common',
    combatUse: { kind: 'sever', slot: 'weaponMain', maxRarity: 'epic' },
    description: 'Combat only, bonus action, no target restriction. Severs the soul-bond on an enemy\'s main-hand weapon (up to Epic), turning it into normal loot.',
  },
  sever_weaponOff: {
    id: 'sever_weaponOff',
    name: 'Severing Chant: Off Hand',
    type: 'consumable',
    rarity: 'common',
    combatUse: { kind: 'sever', slot: 'weaponOff', maxRarity: 'epic' },
    description: 'Combat only, bonus action, no target restriction. Severs the soul-bond on an enemy\'s off-hand item (up to Epic), turning it into normal loot.',
  },
  sever_head: {
    id: 'sever_head',
    name: 'Severing Chant: Head',
    type: 'consumable',
    rarity: 'common',
    combatUse: { kind: 'sever', slot: 'head', maxRarity: 'epic' },
    description: 'Combat only, bonus action, no target restriction. Severs the soul-bond on an enemy\'s head slot (up to Epic), turning it into normal loot.',
  },
  sever_chest: {
    id: 'sever_chest',
    name: 'Severing Chant: Chest',
    type: 'consumable',
    rarity: 'common',
    combatUse: { kind: 'sever', slot: 'chest', maxRarity: 'epic' },
    description: 'Combat only, bonus action, no target restriction. Severs the soul-bond on an enemy\'s chest slot (up to Epic), turning it into normal loot.',
  },
  sever_legs: {
    id: 'sever_legs',
    name: 'Severing Chant: Legs',
    type: 'consumable',
    rarity: 'common',
    combatUse: { kind: 'sever', slot: 'legs', maxRarity: 'epic' },
    description: 'Combat only, bonus action, no target restriction. Severs the soul-bond on an enemy\'s leg slot (up to Epic), turning it into normal loot.',
  },
  sever_gloves: {
    id: 'sever_gloves',
    name: 'Severing Chant: Gloves',
    type: 'consumable',
    rarity: 'common',
    combatUse: { kind: 'sever', slot: 'gloves', maxRarity: 'epic' },
    description: 'Combat only, bonus action, no target restriction. Severs the soul-bond on an enemy\'s glove slot (up to Epic), turning it into normal loot.',
  },
  sever_boots: {
    id: 'sever_boots',
    name: 'Severing Chant: Boots',
    type: 'consumable',
    rarity: 'common',
    combatUse: { kind: 'sever', slot: 'boots', maxRarity: 'epic' },
    description: 'Combat only, bonus action, no target restriction. Severs the soul-bond on an enemy\'s boot slot (up to Epic), turning it into normal loot.',
  },
  sever_ring: {
    id: 'sever_ring',
    name: 'Severing Chant: Ring',
    type: 'consumable',
    rarity: 'common',
    combatUse: { kind: 'sever', slot: 'ring', maxRarity: 'epic' },
    description: 'Combat only, bonus action, no target restriction. Severs the soul-bond on an enemy\'s ring slot (up to Epic), turning it into normal loot.',
  },
  sever_amulet: {
    id: 'sever_amulet',
    name: 'Severing Chant: Amulet',
    type: 'consumable',
    rarity: 'common',
    combatUse: { kind: 'sever', slot: 'amulet', maxRarity: 'epic' },
    description: 'Combat only, bonus action, no target restriction. Severs the soul-bond on an enemy\'s amulet slot (up to Epic), turning it into normal loot.',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // NOT IMPLEMENTED — placeholder so the item exists and can be handled.
  //
  // Renown itself is barely built: an item carries `renownState`
  // ('gaining' | 'historic'), a `renown`/`renownMax` pair that only drives a
  // progress bar in InventoryOverlay, and a `history` block (kills,
  // damageDealt, battlesCarried). Nothing consumes any of it yet.
  //
  // Tabula Rasa is the eventual counterpart: wipe an item's accumulated
  // renown and history back to nothing. It deliberately carries NO
  // combatUse (it is not a combat item) and no onUse handler, so it can be
  // bought, carried and inspected but does nothing when used — exactly like
  // the mechanic it is waiting on.
  // ═══════════════════════════════════════════════════════════════════════════
  // TESTING ITEM. Resets a character's level-up stat allocation back to what
  // they were created with and refunds every earned point. Deliberately
  // minimal: the only support it needs anywhere else is `creationStats` on the
  // character (set once in CharacterBuilder) and one branch in the inventory's
  // [Use] button. Delete this entry and that branch and nothing else notices.
  tonic_of_reflection: {
    id: 'tonic_of_reflection',
    name: 'Tonic of Reflection',
    type: 'consumable',
    rarity: 'common',
    onUse: 'respec_stats',
    description: 'Drink to unmake every choice since your first breath. Refunds all level-up stat points and returns your attributes to what they were at creation. (Testing item.)',
  },
  tabula_rasa: {
    id: 'tabula_rasa',
    name: 'Tabula Rasa',
    type: 'consumable',
    rarity: 'rare',
    notImplemented: true,
    description: 'A blank slate, bound in unmarked vellum. Strips an item of all renown it has gathered — every kill, every battle carried, every story told about it — and returns it to an ordinary thing. [Not yet functional: the Renown system is unimplemented.]',
  },

};
