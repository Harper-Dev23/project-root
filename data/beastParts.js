// data/beastParts.js
//
// Hunt beasts and the parts they wear (Exploration System v2, chunk 9a).
// Design: the vault's BEAST_PARTS (slots, core/peripheral, part pools, the
// family signature, parts are materials) and ENCOUNTERS (grade, rosters).
// Owner signed off the shape 2026-09-21 (chunk 9 decisions 1-7); every number
// is a placeholder until chunk 13.
//
// A family is what the generator places (zones' `natives`, occupants'
// `family`). Each one names its combat type (data/enemyTypes.js), which slots
// its anatomy has, and its signature weakness family.
//
// Parts are ordinary item instances in the character slots the game already has
// (BEAST_PARTS red flag 3), so their bonuses reach the beast through the
// existing enemy pipeline (_equipEnemyItem). They keep `natural: true`: never in
// a pool, a gamble or a vendor, never severed, never identified, never worn by a
// hunter (decision 6). Harvest (9d) is the only way out of a beast.
//
// Readers:
//   HUNT_BEASTS[f].type          HuntBeasts.memberType -> the fight's enemy type (9b)
//   HUNT_BEASTS[f].parts         HuntBeasts.rollLoadout (which slots roll); the
//                                part bases below (data/items.js)
//   HUNT_BEASTS[f].signature     ItemFactory part pools: the family's buildup affix
//   HUNT_BEASTS[f].weaponDamage  the weaponMain part's dice (calculateDamage)
//   HUNT_CULTIST_TYPES           HuntBeasts.memberType for cultist bands
//   GRADE_HP_SCALE               HuntBeasts.gradeHpScale -> fightScenario hpMult ->
//                                CombatScene._spawnEnemy (9b)
//   PART_RARITY_BY_GRADE         PartyStats.partRarityOdds / rollPartRarity
//   CORE_SLOTS, PERIPHERAL_SCALE ItemFactory part pools (full vs reduced ranges);
//                                Trophy (9d) reads CORE_SLOTS
//   PART_SLOT_THEMES             ItemFactory part pools: which affix families
//                                each slot can roll
//   HARVEST_TIME,                HuntEngine.harvest and its spoils view (9d):
//   MEAT_TIME_PER_BODY,          what taking parts and meat costs and gives,
//   MEAT_BY_GRADE,               which parts stay specimens, and what counts
//   SPECIMEN_RARITIES,           for Trophy (HuntObjectives)
//   TROPHY_GRADES

/** The nine character slots, in the order a harvest screen lists them. */
export const PART_SLOTS = ['weaponMain', 'weaponOff', 'head', 'chest', 'legs', 'gloves', 'boots', 'ring', 'amulet'];

/** Core slots carry full affix ranges; the rest are anatomy-dependent and
 *  reduced (BEAST_PARTS, owner 2026-09-18). */
export const CORE_SLOTS = ['weaponMain', 'head', 'chest', 'ring', 'amulet'];

/** A peripheral part's affix ranges, through ItemFactory's scaleRange. */
export const PERIPHERAL_SCALE = 0.5;

/**
 * What each slot's pool leans toward (BEAST_PARTS, "How parts affect
 * combat"). Every entry is an affix family ItemFactory already rolls, and every
 * one reaches an enemy through _equipEnemyItem:
 *   derived:X   armour prefixes landing in enemy.derived (resists, Accuracy,
 *               Evasion, CritChance)
 *   misc:X      armour prefixes landing in enemy.gearEffects (resilience)
 *   stat:X      stat suffixes landing in enemy.totalStats, then derived by
 *               calculateDerivedStats (CON -> HP, DEX -> Accuracy, CHA ->
 *               Initiative)
 *   weapon:X    weapon prefixes read by calculateDamage off the weaponMain part
 * Max HP and Max MP are deliberately absent: an armour maxHP/maxMP affix on an
 * enemy lands in enemy.derived.maxHP, which nothing reads (found in 9a, left
 * for the owner). CON carries a part's HP instead.
 * The family's signature buildup suffix is added to weaponMain and amulet.
 */
export const PART_SLOT_THEMES = {
  weaponMain: { prefixes: ['weapon:min', 'weapon:max', 'weapon:weaponPercent'], suffixes: ['stat:STR'] },
  weaponOff:  { prefixes: ['derived:CritChance', 'derived:Accuracy'], suffixes: ['stat:STR', 'stat:DEX'] },
  head:       { prefixes: ['derived:Accuracy', 'derived:CritChance'], suffixes: ['stat:CHA', 'stat:STR'] },
  chest:      { prefixes: ['derived:PhysicalResist', 'derived:ElementalResist', 'derived:NecroticResist', 'misc:resilience'], suffixes: ['stat:CON', 'stat:WIS'] },
  legs:       { prefixes: ['derived:Evasion', 'derived:PhysicalResist'], suffixes: ['stat:CON', 'stat:CHA'] },
  gloves:     { prefixes: ['derived:Evasion', 'derived:Accuracy'], suffixes: ['stat:DEX', 'stat:STR'] },
  boots:      { prefixes: ['derived:Evasion', 'derived:PhysicalResist'], suffixes: ['stat:CHA', 'stat:DEX'] },
  ring:       { prefixes: ['derived:Accuracy', 'derived:Evasion'], suffixes: ['stat:DEX', 'stat:CHA'] },
  amulet:     { prefixes: ['misc:resilience', 'derived:NecroticResist'], suffixes: ['stat:CON', 'stat:WIS'] },
};

/** Slots whose pool also offers the family's signature buildup suffix. */
export const SIGNATURE_SLOTS = ['weaponMain', 'amulet'];

/**
 * The four placed families (placeholders, like their names: decision 1). Each
 * borrows skills and an AI profile from the encounter-4 beasts; `parts` maps a
 * slot to the anatomy word its part is named for.
 */
export const HUNT_BEASTS = {
  marsh_stalker: {
    name: 'Marsh Stalker', type: 'hunt_marsh_stalker', signature: 'lacerate',
    weaponDamage: { min: 6, max: 8 },
    parts: { weaponMain: 'Fangs', weaponOff: 'Claws', head: 'Skull', chest: 'Hide', legs: 'Haunches',
             gloves: 'Forepaws', boots: 'Hind Paws', ring: 'Eyes', amulet: 'Heart' },
  },
  wading_heron: {
    name: 'Wading Heron', type: 'hunt_wading_heron', signature: 'disorient',
    weaponDamage: { min: 5, max: 7 },
    parts: { weaponMain: 'Beak', head: 'Crest', chest: 'Plumage', legs: 'Shanks',
             gloves: 'Wings', boots: 'Feet', ring: 'Eyes', amulet: 'Heart' },
  },
  tide_crab: {
    name: 'Tide Crab', type: 'hunt_tide_crab', signature: 'expose',
    weaponDamage: { min: 6, max: 7 },
    parts: { weaponMain: 'Great Pincer', weaponOff: 'Lesser Pincer', head: 'Eyestalk Crest', chest: 'Carapace',
             legs: 'Walking Legs', ring: 'Eyes', amulet: 'Gland' },
  },
  shore_gull: {
    name: 'Shore Gull', type: 'hunt_shore_gull', signature: 'toxic',
    weaponDamage: { min: 4, max: 6 },
    parts: { weaponMain: 'Beak', head: 'Skull', chest: 'Plumage', gloves: 'Wings', boots: 'Feet',
             ring: 'Eyes', amulet: 'Craw' },
  },
};

/** A cultist band's members alternate between these types, by roster index. */
export const HUNT_CULTIST_TYPES = ['hunt_cult_zealot', 'hunt_cult_adept'];

/** The armour slot a cultist wears (and drops): the Advance loop's chest drop. */
export const CULTIST_GEAR_SLOT = 'chest';

/** Grade scales a beast's base HP (decision 2). */
export const GRADE_HP_SCALE = { yearling: 0.75, grown: 1, prime: 1.3, great: 1.7 };

/**
 * A part's rarity weights by grade, common included (decision 3), in percent.
 * Item Rarity then shifts weight upward (PartyStats.partRarityOdds).
 */
export const PART_RARITY_BY_GRADE = {
  yearling: { common: 55, uncommon: 33, rare: 10, epic: 2 },
  grown:    { common: 30, uncommon: 45, rare: 20, epic: 5 },
  prime:    { common: 10, uncommon: 40, rare: 38, epic: 12 },
  great:    { common: 0,  uncommon: 25, rare: 50, epic: 25 },
};

// ── Harvest (chunk 9d; decisions 12-14) ─────────────────────────────────────
// Reader: HuntEngine.harvest. Placeholders until chunk 13.

/** In-game time units to take one part: core parts are the careful work,
 *  peripheral ones quicker. Foraging's harvest-time curve cuts it
 *  (partyStats().harvestTimePercent). */
export const HARVEST_TIME = { core: 1, peripheral: 0.5 };

/** Butchering for meat: time per body, before the same curve. */
export const MEAT_TIME_PER_BODY = 0.25;

/** Meat per body by grade, before Foraging's yield curve and "of the Harvest"
 *  (partyStats().forageYieldPercent). Cultists give none. */
export const MEAT_BY_GRADE = {
  yearling: { id: 'lean_game',  qty: 1 },
  grown:    { id: 'lean_game',  qty: 2 },
  prime:    { id: 'prime_game', qty: 2 },
  great:    { id: 'great_game', qty: 3 },
};

/** Common and uncommon parts lose their affixes when harvested and stack as
 *  plain material; rare and better keep them as specimens (decision 14). */
export const SPECIMEN_RARITIES = ['rare', 'epic'];

/** Grades whose core parts make a Trophy (the Trophy bonus objective). */
export const TROPHY_GRADES = ['prime', 'great'];

/** The part base id for a family and slot: family + slot in the id, so stacks
 *  never merge two families' hides (ItemStacks keys by id + rarity). */
export function partBaseId(family, slot) {
  return `part_${family}_${slot}`;
}

/**
 * Every part base, for data/items.js. The weaponMain part is a natural weapon
 * with dice, exactly like natural_fangs, because calculateDamage reads the
 * beast's weaponMain. Every other part has no dice (`type: 'part'`), so a
 * weaponOff part never makes a beast dual-wield.
 */
export function buildPartBases() {
  const out = {};
  for (const [family, fam] of Object.entries(HUNT_BEASTS)) {
    for (const [slot, word] of Object.entries(fam.parts)) {
      const id = partBaseId(family, slot);
      const core = CORE_SLOTS.includes(slot);
      const base = {
        id, name: `${fam.name} ${word}`, baseTier: 1, rarity: 'common',
        natural: true, stackable: true, slot, bonuses: {},
        part: { family, slot, core },
        description: `${core ? 'A prized' : 'A'} part taken from a ${fam.name.toLowerCase()}.`,
      };
      if (slot === 'weaponMain') {
        Object.assign(base, { type: 'weapon', weaponType: 'natural', hands: 1, damage: { ...fam.weaponDamage } });
      } else {
        base.type = 'part';
      }
      out[id] = base;
    }
  }
  return out;
}
