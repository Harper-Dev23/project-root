/**
 * Regenerates the mechanical half of the Journal's item/affix reference pages
 * from the live ItemFactory tables, so the numbers cannot drift from the game.
 *
 * Run:  node tools/gen_item_journal.js
 *
 * Same contract as tools/gen_encounter_journal.js: everything between the
 * <!-- GEN:START --> / <!-- GEN:END --> markers is rewritten wholesale, and
 * everything outside them is hand-authored prose this script never touches.
 *
 * Writes:
 *   systems/affix_reference.md  - every affix ladder, tier by tier
 *   systems/item_levels.md      - item level, base tiers, and what gates what
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MD_DIR = join(ROOT, 'data/journal/md');
const INDEX = join(MD_DIR, 'index.json');
const NL = '\n';

const IF = await import('../src/systems/ItemFactory.js');
const { Items: ITEMS } = await import('../data/items.js');
const { COMBAT_SCENARIOS } = await import('../data/combatScenarios.js');
const { getXPNeededForLevel, LEVEL_CAP } = await import('../data/xpTable.js');
const PM = (await import('../src/systems/ProgressionManager.js')).default;

const { AFFIX_TIER_RULES, BASE_TIER_RULES, getAffixIndex } = IF;

// ---------------------------------------------------------------- labels
// Player-facing names for the internal family keys. Anything unmapped falls
// back to the key itself, so a new family shows up (ugly but present) rather
// than silently vanishing from the reference.
const FAMILY_LABEL = {
  maxHP: 'Maximum Health', maxMP: 'Maximum Mana',
  PhysicalResist: 'Physical Resist', ElementalResist: 'Elemental Resist',
  NecroticResist: 'Necrotic Resist', Accuracy: 'Accuracy', Evasion: 'Evasion',
  CritChance: 'Critical Chance', resilience: 'Resilience',
  mpPerTurn: 'Mana per Turn', skillCostReductionPct: 'Skill Cost Reduction',
  globalDamagePercent: 'All Damage', healingPercent: 'Healing Done',
  physicalBuildupPercent: 'Physical Buildup', elementalBuildupPercent: 'Elemental Buildup',
  necroticBuildupPercent: 'Necrotic Buildup',
  weaponPercent: 'Weapon Damage', min: 'Minimum Damage', max: 'Maximum Damage',
  elementalDamagePercent: 'Elemental Damage', necroticDamagePercent: 'Necrotic Damage',
  fireFlat: 'Flat Fire', coldFlat: 'Flat Cold', lightningFlat: 'Flat Lightning',
  necroticFlat: 'Flat Necrotic',
  fire: 'Fire Buildup', cold: 'Cold Buildup', lightning: 'Lightning Buildup',
  toxic: 'Toxic Buildup', disease: 'Disease Buildup', curse: 'Curse Buildup',
  lacerate: 'Lacerate Buildup', expose: 'Expose Buildup', disorient: 'Disorient Buildup',
  stat_STR: 'Strength', stat_DEX: 'Dexterity', stat_CON: 'Constitution',
  stat_INT: 'Intelligence', stat_WIS: 'Wisdom', stat_CHA: 'Charisma',
  huntPointsPercent: 'Hunt Points', lootQualityPercent: 'Loot Quality',
  xpPercent: 'Experience', supplyEfficiencyPercent: 'Supply Efficiency',
  beastChanceWeight: 'Beast Encounter Weight', encounterChancePercent: 'Encounter Chance',
};
const label = (fam) => FAMILY_LABEL[fam] || fam;

const isHybrid = (fam) => String(fam).includes('+');
const prettyHybrid = (fam) => String(fam).split('+').map(label).join(' + ');

/** Group an affix index into { family: [{key,tier,range}] }, strongest first. */
function ladders(idx, filter = () => true) {
  const by = {};
  for (const [key, v] of Object.entries(idx)) {
    if (v.tier == null || !filter(key, v)) continue;
    // Stat suffixes carry an internal key per tier ("of the Bear [T2]") but a
    // shared display label — show the label, since that is what the item says.
    (by[v.family] = by[v.family] || []).push({ key: v.label || key, tier: v.tier, range: v.range });
  }
  for (const rows of Object.values(by)) rows.sort((a, b) => a.tier - b.tier);
  return by;
}

function ladderTable(by, { hybrid = false } = {}) {
  const names = Object.keys(by).sort((a, b) =>
    (hybrid ? prettyHybrid(a) : label(a)).localeCompare(hybrid ? prettyHybrid(b) : label(b)));
  const rows = ['| Modifier | T1 (best) | T2 | T3 | T4 | T5 |', '|---|---|---|---|---|---|'];
  for (const fam of names) {
    const cells = [1, 2, 3, 4, 5].map(t => {
      const e = by[fam].find(r => r.tier === t);
      return e ? `${e.key}<br>${e.range[0]}–${e.range[1]}` : '—';
    });
    rows.push('| **' + (hybrid ? prettyHybrid(fam) : label(fam)) + '** | ' + cells.join(' | ') + ' |');
  }
  return rows.join(NL) + NL;
}

// ---------------------------------------------------------------- affixes
function affixBody() {
  const armour = getAffixIndex(null);
  const w2 = getAffixIndex(2);
  const out = [];

  out.push('## How many roll' + NL);
  out.push(['| Rarity | Affixes |', '|---|---|',
    '| Common | none |', '| Uncommon | 1–2 |', '| Rare | exactly 3 |',
    '| Epic | 4 — always 2 prefixes + 2 suffixes |'].join(NL) + NL);
  out.push('Prefixes and suffixes are drawn from separate pools. Two modifiers from the '
    + 'same family can never appear on one item, so you will not see two Strength '
    + 'suffixes or two tiers of the same buildup. **Unique** items ignore all of '
    + 'this and carry one fixed bonus instead.' + NL);

  out.push('## Tiers' + NL);
  out.push('Every family runs **five tiers**. **T5** is the common, weakest band; '
    + '**T1** is the best. The tier is baked into the name, so the name tells you '
    + 'the band before you read the number. Which tiers an item can roll is decided '
    + 'by its **item level** — see [[Item Level & Base Types]].' + NL);

  out.push('## Handedness' + NL);
  out.push('Two-handed weapons roll the ranges below. One-handers are reduced, because they can be paired:' + NL);
  out.push('- **Per-swing** modifiers (flat and % weapon damage, flat elemental) roll at **two thirds**.' + NL);
  out.push('- **Globally additive** modifiers (buildup %, elemental/necrotic %, healing %) roll at **half**.' + NL);
  out.push('Shields are exempt — they carry no damage budget to balance against.' + NL);

  out.push('---' + NL);
  out.push('## Weapon modifiers' + NL);
  out.push('*Two-handed ranges.*' + NL);
  out.push('### Prefixes' + NL);
  out.push(ladderTable(ladders(w2, (k, v) => !isHybrid(v.family) && !armour[k] &&
    !['fire', 'cold', 'lightning', 'toxic', 'disease', 'curse', 'lacerate', 'expose', 'disorient'].includes(v.family))));
  out.push('### Suffixes — single family' + NL);
  out.push(ladderTable(ladders(w2, (k, v) =>
    ['fire', 'cold', 'lightning', 'toxic', 'disease', 'curse', 'lacerate', 'expose', 'disorient'].includes(v.family))));
  out.push('### Suffixes — hybrid' + NL);
  out.push('A hybrid builds **two** weakness families at once, for roughly 62% of what a '
    + 'single-family modifier of the same tier would give to one. Breadth costs magnitude, '
    + 'so it is never a straight upgrade. Pairs only ever form inside one category. '
    + 'A hybrid and a matching single-family modifier can both appear on the same item.' + NL);
  out.push(ladderTable(ladders(w2, (k, v) => isHybrid(v.family)), { hybrid: true }));

  out.push('---' + NL);
  out.push('## Armour modifiers' + NL);
  out.push('### Prefixes' + NL);
  out.push(ladderTable(ladders(armour, (k, v) => !String(k).startsWith('of ') &&
    !['huntPointsPercent', 'lootQualityPercent', 'xpPercent', 'supplyEfficiencyPercent',
      'beastChanceWeight', 'encounterChancePercent'].includes(v.family))));
  out.push('### Suffixes' + NL);
  out.push('Every tier of a stat suffix shows the **same name** — "of the Bear" is always '
    + 'Strength. The number is what tells you the tier.' + NL);
  out.push(ladderTable(ladders(armour, (k, v) => String(v.family).startsWith('stat_'))));

  const hunt = ladders(armour, (k, v) => ['huntPointsPercent', 'lootQualityPercent', 'xpPercent',
    'supplyEfficiencyPercent', 'beastChanceWeight', 'encounterChancePercent'].includes(v.family));
  if (Object.keys(hunt).length) {
    out.push('---' + NL);
    out.push('## Hunt plan modifiers' + NL);
    out.push(ladderTable(hunt));
  }
  return out.join(NL);
}

// ------------------------------------------------------------ item levels
function itemLevelBody() {
  const out = [];
  const w = (t, l) => {
    const r = AFFIX_TIER_RULES[t];
    return l < r.minItemLevel ? 0 : r.weight + (r.perLevel || 0) * Math.max(0, l - r.minItemLevel);
  };

  out.push('## What item level decides' + NL);
  out.push('Item level never changes a number directly. It decides two things: which '
    + '**modifier tiers** were allowed to roll, and which **base types** were in the pool. '
    + 'Rarity is a separate axis entirely — it sets how *many* modifiers roll, not how good they are.' + NL);
  out.push('Gating is a floor and never a ceiling: a high item level does not stop the '
    + 'weak bands rolling, it only adds better ones on top and makes them steadily more '
    + 'likely. The weakest tier remains the single most common outcome at every level.' + NL);

  out.push('## Modifier tiers by item level' + NL);
  const rows = ['| Item level | T1 | T2 | T3 | T4 | T5 |', '|---|---|---|---|---|---|'];
  for (const l of [1, 2, 3, 4, 5, 6, 8, 10]) {
    const ws = [1, 2, 3, 4, 5].map(t => w(t, l));
    const tot = ws.reduce((a, b) => a + b, 0);
    rows.push('| ' + l + ' | ' + ws.map(x => x === 0 ? '—' : (100 * x / tot).toFixed(1) + '%').join(' | ') + ' |');
  }
  out.push(rows.join(NL) + NL);
  out.push('Unlock points: ' + [1, 2, 3, 4, 5]
    .map(t => `**T${t}** at item level ${AFFIX_TIER_RULES[t].minItemLevel}`).join(', ') + '.' + NL);

  out.push('## Base types' + NL);
  out.push('Weapons run **Crude → Hardened → Ancestral**, armour runs **Simple → Fitted**. '
    + 'A higher base carries more raw damage (or, on armour, one more stat) before any '
    + 'modifier is applied, so every percentage on the item multiplies a bigger number.' + NL);
  const brows = ['| Base tier | Weapons | Armour | Available from item level |', '|---|---|---|---|'];
  const BASE_NAMES = { 1: ['Crude', 'Simple'], 2: ['Hardened', 'Fitted'], 3: ['Ancestral', '—'] };
  for (const t of [1, 2, 3]) {
    brows.push('| ' + t + ' | ' + BASE_NAMES[t][0] + ' | ' + BASE_NAMES[t][1]
      + ' | ' + BASE_TIER_RULES[t].minItemLevel + ' |');
  }
  out.push(brows.join(NL) + NL);

  out.push('## Where item levels come from' + NL);
  out.push(['| Source | Item level | Base types |', '|---|---|---|',
    '| Encounters I–III | 1 | tier 1 only |',
    '| Encounters IV–V | 2 | tier 1 only |',
    '| Encounter VI | 3 | tier 1 only |',
    '| Any Reckoning tier | 3 | up to tier 2 |',
    '| Bone pile — Hunt Ticket | your party\'s level | tier 1 only |',
    '| Bone pile — Reckoning Mark | your party\'s level (min 3) | always tier 2 |',
  ].join(NL) + NL);
  out.push('The two bone-pile buttons are deliberately fixed: a Hunt Ticket always buys a '
    + 'tier-1 base and a Reckoning Mark always buys a tier-2 one. A shop should say what it sells.' + NL);

  out.push('## Bone' + NL);
  const boneMult = ((IF.RENOWN_ORIGINS?.bone?.baseDamageMult || 1.2) - 1) * 100;
  out.push('Bone is not a base type of its own. It is an **overlay** on whatever base was '
    + 'already going to drop, adding **+' + Math.round(boneMult) + '% damage** before any '
    + 'other modifier — which means every percentage on the weapon multiplies the bone '
    + 'bonus too. Because it sits on top of a normal base, Bone can appear on any base tier.' + NL);
  out.push('Every tier reads simply *Bone Dagger*, *Bone War Mace*. The Base Tier line on '
    + 'the item is what tells the three apart.' + NL);
  return out.join(NL);
}

// ------------------------------------------------------------ progression
function progressionBody() {
  const out = [];
  out.push('## The level cap' + NL);
  out.push('A Hunter can reach **level ' + LEVEL_CAP + '**. Beyond that, experience stops '
    + 'accruing entirely — the bar sits full rather than filling a counter that can '
    + 'never be spent. The cap exists because the Reckoning tiers pay out on **every** '
    + 'clear, not just the first, so without one the ladder could be run indefinitely.' + NL);

  const rows = ['| Level | XP to reach it | Cumulative |', '|---|---|---|'];
  let cum = 0;
  for (let l = 1; l < LEVEL_CAP; l++) {
    const n = getXPNeededForLevel(l);
    cum += n;
    rows.push('| ' + (l + 1) + ' | ' + n + ' | ' + cum + ' |');
  }
  out.push(rows.join(NL) + NL);

  out.push('## Where experience comes from' + NL);
  out.push('Every fight in the pit is worth a fixed amount, awarded each time it is '
    + 'cleared. The base six are a curriculum and pay accordingly; the Reckoning tiers '
    + 'are where the real experience is.' + NL);
  const base = [1, 2, 3, 4, 5, 6].map(i => 'training_encounter_' + i);
  const xrows = ['| Fight | XP | Marks |', '|---|---|---|'];
  const line = (id, label) => {
    const sc = COMBAT_SCENARIOS[id];
    if (!sc) return;
    const m = PM.getMarkReward ? PM.getMarkReward(id) : 0;
    xrows.push('| ' + label + ' | ' + (sc.xpReward || 0) + ' | ' + (m || '—') + ' |');
  };
  base.forEach((id, i) => line(id, COMBAT_SCENARIOS[id] ? COMBAT_SCENARIOS[id].name : id));
  [2, 3, 4, 5, 6].forEach(enc => {
    const n = enc === 6 ? 5 : 3;
    for (let i = 1; i <= n; i++) {
      const id = `training_encounter_${enc}_reckoning_${i}`;
      if (COMBAT_SCENARIOS[id]) line(id, COMBAT_SCENARIOS[id].name);
    }
  });
  out.push(xrows.join(NL) + NL);

  // Which routes actually reach the cap — computed, not asserted.
  const total = ids => ids.reduce((t, id) => t + ((COMBAT_SCENARIOS[id] || {}).xpReward || 0), 0);
  const levelFor = xp => { let l = 1, r = xp; while (l < LEVEL_CAP && r >= getXPNeededForLevel(l)) { r -= getXPNeededForLevel(l); l++; } return l; };
  const tiersOf = (enc, n) => Array.from({ length: n }, (_, i) => `training_encounter_${enc}_reckoning_${i + 1}`);
  const routes = [
    ['The base six alone', base],
    ['Base six + all of Gorrek’s Reckoning', [...base, ...tiersOf(6, 5)]],
    ['Base six + all of IV and V’s Reckoning', [...base, ...tiersOf(4, 3), ...tiersOf(5, 3)]],
    ['Base six + only II and III’s Reckoning', [...base, ...tiersOf(2, 3), ...tiersOf(3, 3)]],
  ];
  out.push('### Routes to the cap' + NL);
  out.push('Clearing everything once is not the only way there. Each of these is a full '
    + 'first clear of the listed fights:' + NL);
  const rrows = ['| Route | XP | Reaches |', '|---|---|---|'];
  routes.forEach(([lbl, ids]) => {
    const t = total(ids);
    rrows.push('| ' + lbl + ' | ' + t + ' | level ' + levelFor(t) + ' |');
  });
  out.push(rrows.join(NL) + NL);
  out.push('Anything short of the cap can be closed by repeating a tier — they pay every time.' + NL);

  out.push('## Currencies' + NL);
  out.push('**Hunt Tickets** are earned on the *first* clear of a fight and spent at the '
    + 'bone pile. **Reckoning Marks** are earned from Reckoning tiers on *every* clear, '
    + 'and buy from the bone pile’s Marked buttons. A Ticket always buys a tier-1 base; '
    + 'a Mark always buys a tier-2 one — see [[Item Level & Base Types]].' + NL);
  return out.join(NL);
}

// ---------------------------------------------------------------- writing
function writePage({ rel, frontmatter, intro, body }) {
  const path = join(MD_DIR, rel);
  const START = '<!-- GEN:START - regenerated by tools/gen_item_journal.js, do not hand-edit below -->';
  const END = '<!-- GEN:END -->';
  let head;
  if (existsSync(path)) {
    const cur = readFileSync(path, 'utf8');
    const i = cur.indexOf(START);
    head = i === -1 ? cur.trimEnd() + NL + NL : cur.slice(0, i).trimEnd() + NL + NL;
  } else {
    head = frontmatter + NL + intro + NL + NL;
  }
  writeFileSync(path, head + START + NL + NL + body + NL + END + NL, 'utf8');
  return rel;
}

const written = [];
written.push(writePage({
  rel: 'systems/affix_reference.md',
  body: affixBody(),
}));
written.push(writePage({
  rel: 'systems/progression.md',
  body: progressionBody(),
}));
written.push(writePage({
  rel: 'systems/item_levels.md',
  frontmatter: ['---', 'id: systems/item_levels', 'title: "Item Level & Base Types"',
    'slug: "item-levels"', 'category: "systems"', 'subtab: "In Depth"', 'order: 28',
    'tags: ["systems", "items", "affixes", "reference", "in-depth"]', 'status: "approved"',
    'teaser: false', 'requires: []', 'sort: 28', 'version: 1',
    'updatedAt: ' + new Date().toISOString().slice(0, 10), '---'].join(NL),
  intro: ['# Item Level & Base Types', '',
    'Two hidden numbers decide what a piece of gear *could* have been: its **item '
    + 'level** and its **base type**. Neither is a stat. Both are stamped when the item '
    + 'is made and never change afterwards.', '',
    'For the modifiers themselves, see [[Affix Reference (In Depth)]].'].join(NL),
  body: itemLevelBody(),
}));

const idx = JSON.parse(readFileSync(INDEX, 'utf8'));
let added = 0;
written.forEach(rel => { if (!idx.includes(rel)) { idx.push(rel); added++; } });
writeFileSync(INDEX, JSON.stringify(idx, null, 2) + NL, 'utf8');
console.log('wrote ' + written.length + ' pages (' + added + ' new in index.json)');
written.forEach(r => console.log('   ' + r));
