// tools/headless/beastparts.mjs
//
// Hunt beasts and their parts (Exploration System v2, chunk 9a). Everything is
// checked through the game's own exports and, where a part meets combat,
// through the REAL CombatScene._spawnEnemy / _equipEnemyItem in the headless
// combat host. No formula is re-derived here.
//
// What it proves:
//   - content: every family the generator can place has a HUNT_BEASTS entry, a
//     real enemy type, real skills and a real AI profile; both cultist types too
//   - part bases: one per family x anatomy slot, `natural`, the weaponMain one a
//     natural weapon with dice, the rest dice-less `part`s; none of them in the
//     gear drop pool
//   - part pools: every affix a part can roll comes from the existing gear
//     pools, none is Max HP / Max MP (dead on enemies, see below), peripheral
//     ranges are PERIPHERAL_SCALE of the core ones, and each family's
//     signature buildup rolls where it should
//   - enemy armour's Max HP affix reaches the enemy's HP (the bug 9a found, fixed)
//   - NO DEAD AFFIX: parts rolled at every rarity are spawned onto a real enemy
//     by CombatScene._spawnEnemy, and every affix they carry must move the
//     field its consumer reads (derived stat, HP, gearEffects, weapon damage,
//     weapon buildup%)
//   - the part rarity curve: every grade x Item Rarity sums to 100, Item Rarity
//     0 is the grade's own table, epic never falls as Item Rarity rises, and
//     20,000 real draws land on the odds
//   - loadouts: one per member, the family's slots, deterministic per seed,
//     drawn from the occupant's own stream (the hunt's and the world's streams
//     are untouched), kept across a save and never re-rolled
//   - initiative: HuntBeasts.memberInitiative equals the real spawned enemy's
//     computeEffectiveInitiative, loadout included
//   - scout: shows the loadout's rarities and nothing more; the fight meets what
//     was scouted; Keen Tracker's exact roster alone shows no loadout
//   - the golden: the rarity tables, the per-grade loadout statistics, and a
//     real-engine power read per family and grade
//
// USAGE
//   node tools/headless/beastparts.mjs                  run the checks
//   node tools/headless/beastparts.mjs --json out.json  also write the golden
//   node tools/headless/beastparts.mjs --diff old.json  also compare against one

import fs from 'node:fs';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const r2 = (x) => +(+x).toFixed(2);
const noIds = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === 'instanceId' ? undefined : x)));

const store = new Map();
globalThis.localStorage = {
  get length() { return store.size; },
  key: (i) => [...store.keys()][i] ?? null,
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => store.clear(),
};

const { installPhaserStub } = await import('./phaserStub.js');
installPhaserStub(9);

const { makeParty, slotMapFor } = await import('./fixtures.js');
const { createCombatHost } = await import('./combatHost.js');
const CombatSceneMod = await import('../../src/scenes/CombatScene.js');
const CombatScene = CombatSceneMod.default || Object.values(CombatSceneMod).find(v => typeof v === 'function');
const { computeEffectiveInitiative } = await import('../../src/systems/CombatLogic.js');
const BP = await import('../../data/beastParts.js');
const { Items } = await import('../../data/items.js');
const { ENEMY_TYPES } = await import('../../data/enemyTypes.js');
const { SKILLS } = await import('../../data/skills.js');
const { AI_PROFILES } = await import('../../src/systems/AIProfiles.js');
const Z = await import('../../data/zones.js');
const IF = await import('../../src/systems/ItemFactory.js');
const PS = await import('../../src/systems/PartyStats.js');
const HB = await import('../../src/systems/HuntBeasts.js');
const { DROP_POOL } = await import('../../src/systems/PartyGearManager.js');
const { createMapHunt, restoreMapHunt } = await import('../../src/systems/HuntEngine.js');
const { makeRng } = await import('../../src/systems/seededRng.js');
const { mapNeighbors } = await import('../../src/systems/HuntMapGen.js');
const { huntItemLevel } = await import('../../src/systems/HuntScaling.js');

const golden = {};
const { calculateDerivedStats } = await import('../../src/systems/CharacterBuilder.js');
/** What CON alone adds to an enemy's HP, through the game's own function. */
const calcConHP = (con, baseCON = 0) => calculateDerivedStats({ CON: baseCON + con }).maxHP - calculateDerivedStats({ CON: baseCON }).maxHP;
const GRADES = ['yearling', 'grown', 'prime', 'great'];
const RARITIES = ['common', 'uncommon', 'rare', 'epic'];
const FAMILIES = Object.keys(BP.HUNT_BEASTS);
const HUNT_ZONES = ['reeds_of_gethsemane', 'bay_of_solace'];

// =============================================================================
console.log('=== content: families, types, skills, AI ===');
{
  const placed = new Set();
  for (const id of HUNT_ZONES) {
    const z = Z.getZone(id);
    Object.keys(z.natives || {}).forEach(f => placed.add(f));
    if (z.apex?.family) placed.add(z.apex.family);
  }
  check('every family a starter zone can place has a HUNT_BEASTS entry', [...placed].every(f => BP.HUNT_BEASTS[f]),
    [...placed].filter(f => !BP.HUNT_BEASTS[f]).join(', '));
  check('every HUNT_BEASTS family is placed somewhere (no dead family)', FAMILIES.every(f => placed.has(f)));
  const aiNames = new Set(Object.keys(AI_PROFILES));
  const types = [...FAMILIES.map(f => BP.HUNT_BEASTS[f].type), ...BP.HUNT_CULTIST_TYPES];
  const bad = [];
  for (const t of types) {
    const T = ENEMY_TYPES[t];
    if (!T) { bad.push(`${t}: no type`); continue; }
    for (const s of T.skills) if (!SKILLS[s]) bad.push(`${t}: skill ${s}`);
    if (!aiNames.has(T.aiProfile)) bad.push(`${t}: ai ${T.aiProfile}`);
  }
  check('every beast and cultist type exists, with real skills and AI profiles', bad.length === 0, bad.join('; ') || `${types.length} types`);
  golden.types = Object.fromEntries(types.map(t => {
    const T = ENEMY_TYPES[t];
    return [t, { maxHP: T.maxHP, maxMP: T.maxMP, baseStats: T.baseStats, derivedBonus: T.derivedBonus || null, skills: T.skills, aiProfile: T.aiProfile, initiative: HB.memberInitiative(t) }];
  }));
  golden.GRADE_HP_SCALE = BP.GRADE_HP_SCALE;
}

// =============================================================================
console.log('=== part bases ===');
{
  const bad = [];
  let n = 0;
  for (const [family, fam] of Object.entries(BP.HUNT_BEASTS)) {
    for (const slot of Object.keys(fam.parts)) {
      n++;
      const b = Items[BP.partBaseId(family, slot)];
      if (!b) { bad.push(`${family}/${slot}: missing`); continue; }
      if (!b.natural) bad.push(`${b.id}: not natural`);
      if (!b.stackable) bad.push(`${b.id}: not stackable`);
      if (b.part?.family !== family || b.part?.slot !== slot) bad.push(`${b.id}: part tag`);
      if (b.part.core !== BP.CORE_SLOTS.includes(slot)) bad.push(`${b.id}: core flag`);
      if (slot === 'weaponMain' && !(b.type === 'weapon' && b.weaponType === 'natural' && b.damage?.max > 0)) bad.push(`${b.id}: weaponMain is not a natural weapon with dice`);
      if (slot !== 'weaponMain' && (b.type !== 'part' || b.damage)) bad.push(`${b.id}: should be a dice-less part`);
    }
  }
  const extra = Object.keys(Items).filter(id => Items[id].part && !BP.HUNT_BEASTS[Items[id].part.family]?.parts[Items[id].part.slot]);
  check('one base per family x anatomy slot, natural, stackable, tagged', bad.length === 0 && extra.length === 0, bad.concat(extra).join('; ') || `${n} bases`);
  check('every family has a weaponMain part (calculateDamage reads the beast\'s weaponMain)', FAMILIES.every(f => BP.HUNT_BEASTS[f].parts.weaponMain));
  check('no part is in the gear drop pool (PartyGearManager.DROP_POOL)', !DROP_POOL.some(i => i.part));
  golden.partBases = Object.fromEntries(FAMILIES.map(f => [f, Object.entries(BP.HUNT_BEASTS[f].parts).map(([slot, w]) => `${slot}:${w}`)]));
}

// =============================================================================
console.log('=== part pools ===');
{
  const bad = [];
  const summary = {};
  for (const family of FAMILIES) {
    for (const slot of Object.keys(BP.HUNT_BEASTS[family].parts)) {
      const pools = IF.getPartPools(family, slot);
      const all = [...pools.prefixes, ...pools.suffixes];
      const fams = [...new Set(all.map(d => d.family))];
      if (fams.some(f => f === 'maxHP' || f === 'maxMP')) bad.push(`${family}/${slot}: rolls Max HP/MP`);
      const wantSig = BP.SIGNATURE_SLOTS.includes(slot);
      const hasSig = fams.includes(BP.HUNT_BEASTS[family].signature);
      if (wantSig !== hasSig) bad.push(`${family}/${slot}: signature ${hasSig ? 'present' : 'missing'}`);
      if (new Set(pools.prefixes.map(d => d.family)).size < 2 || new Set(pools.suffixes.map(d => d.family)).size < 2) {
        bad.push(`${family}/${slot}: an epic (2+2) needs two families on each side`);
      }
      if (family === 'marsh_stalker') summary[slot] = { prefixes: [...new Set(pools.prefixes.map(d => d.family))], suffixes: [...new Set(pools.suffixes.map(d => d.family))] };
    }
  }
  check('every part pool: no Max HP/MP, signature where it belongs, two families per side', bad.length === 0, bad.join('; '));

  // Peripheral = PERIPHERAL_SCALE of the core ranges: compare the same key in
  // a core pool of the same theme (legs vs chest share PhysicalResist).
  const core = new Map(IF.getPartPools('marsh_stalker', 'chest').prefixes.map(d => [d.key, d.range]));
  const periph = IF.getPartPools('marsh_stalker', 'legs').prefixes.filter(d => core.has(d.key));
  const scaledOk = periph.length > 0 && periph.every(d => {
    const [a, b] = core.get(d.key);
    const min = Math.max(1, Math.round(a * BP.PERIPHERAL_SCALE));
    return d.range[0] === min && d.range[1] === Math.max(min, Math.round(b * BP.PERIPHERAL_SCALE));
  });
  check(`peripheral ranges are ${BP.PERIPHERAL_SCALE} of the core ones (${periph.length} shared keys)`, scaledOk);
  check('and genuinely smaller wherever the core range reaches 2 or more',
    periph.filter(d => core.get(d.key)[1] >= 2).every(d => d.range[1] < core.get(d.key)[1]));
  golden.stalkerRanges = { chest: Object.fromEntries(core), legs: Object.fromEntries(periph.map(d => [d.key, d.range])) };
  golden.stalkerPools = summary;
}

// =============================================================================
console.log('=== no dead affix: parts on a real enemy ===');
const host = createCombatHost(CombatScene);
{
  const party = makeParty();
  host.__begin({ party, partySlots: slotMapFor(party), scenarioId: 'training_encounter_1' });
}
/** A real enemy from CombatScene._spawnEnemy, on a freed slot. */
function spawn(type, drops = [], seed = 1) {
  const slot = host.enemySlots.find(s => s.slotId === 8);
  slot.occupied = false; slot.char = null;
  host._gearRng = makeRng(seed);
  const e = host._spawnEnemy({ type, slotId: 8, drops });
  host.enemies = host.enemies.filter(x => x !== e);
  return e;
}
{
  const bad = [];
  let affixes = 0;
  for (const family of FAMILIES) {
    const type = BP.HUNT_BEASTS[family].type;
    const bare = spawn(type);
    for (const slot of Object.keys(BP.HUNT_BEASTS[family].parts)) {
      for (let k = 0; k < 12; k++) {
        const e = spawn(type, [{ equip: slot, itemId: BP.partBaseId(family, slot), rarity: 'epic' }], 1000 + k);
        const inst = e.equipment[slot];
        if (!inst) { bad.push(`${family}/${slot}: not equipped`); break; }
        const m = inst.instanceMods;
        const view = IF.getItemComputedData(inst);
        for (const [k2, v] of Object.entries(m.derived || {})) {
          affixes++;
          if (!(e.derived[k2] > bare.derived[k2])) bad.push(`${inst.id}: derived ${k2} +${v} did not reach enemy.derived`);
        }
        for (const [st, v] of Object.entries(m.stats || {})) {
          affixes++;
          const moved = { CON: e.maxHP > bare.maxHP, DEX: e.derived.Accuracy > bare.derived.Accuracy,
            CHA: e.derived.Initiative > bare.derived.Initiative, WIS: e.gearEffects.resilience > bare.gearEffects.resilience,
            STR: (e.totalStats.STR || 0) > (bare.totalStats.STR || 0) }[st];
          if (!moved) bad.push(`${inst.id}: stat ${st} +${v} moved nothing`);
        }
        if (m.misc?.resilience) { affixes++; if (!(e.gearEffects.resilience > bare.gearEffects.resilience)) bad.push(`${inst.id}: resilience`); }
        for (const [fam, v] of Object.entries(m.misc?.buildupPercent || {})) {
          affixes++;
          if (!((e.gearEffects.weaponBuildupPercent?.[fam] || 0) >= v)) bad.push(`${inst.id}: buildup ${fam} did not reach weaponBuildupPercent`);
        }
        const flat = (m.damageFlat?.min || 0) + (m.damageFlat?.max || 0) + (m.damagePercent?.weapon || 0);
        if (flat) {
          affixes++;
          const base = Items[inst.id].damage;
          if (!(view.damage.min + view.damage.max > base.min + base.max)) bad.push(`${inst.id}: weapon damage affix did not change the dice`);
        }
      }
    }
  }
  check('every affix on an epic part moves the field its combat consumer reads', bad.length === 0,
    bad.slice(0, 4).join('; ') || `${affixes} affixes on ${FAMILIES.length} families`);

  // The bug 9a found, FIXED after chunk 9: an armour Max HP affix on an enemy
  // used to land in enemy.derived.maxHP, which nothing reads. It must now raise
  // the enemy's maxHP by exactly its value, on top of what the chest's CON adds.
  let armorId = Object.keys(Items).find(id => Items[id].type === 'armor' && Items[id].slot === 'chest');
  let hp = null;
  for (let k = 0; k < 400 && hp === null; k++) {
    const e = spawn('hunt_cult_zealot', [{ equip: 'chest', itemId: armorId, rarity: 'epic' }], 5000 + k);
    const affix = e.equipment.chest?.instanceMods?.derived?.maxHP;
    if (affix) {
      // Whatever else the chest carries (CON is +2 HP a point) is taken out by
      // comparing with what its CON alone adds.
      const con = IF.getItemComputedData(e.equipment.chest).bonuses?.CON || 0;
      hp = { affix, rise: e.maxHP - spawn('hunt_cult_zealot').maxHP, conOnly: calcConHP(con, ENEMY_TYPES.hunt_cult_zealot.baseStats.CON), stranded: e.derived.maxHP || 0, full: e.currentHP === e.maxHP };
    }
  }
  const applied = !!hp && hp.rise === hp.conOnly + hp.affix && hp.stranded === 0 && hp.full;
  check('an armour Max HP affix raises an enemy\'s maxHP by exactly its value (fixed after chunk 9)', applied,
    hp ? `+${hp.affix} Max HP rolled; maxHP rose ${hp.rise} = CON's ${hp.conOnly} + ${hp.affix}; nothing left in derived.maxHP` : 'no roll found');
  golden.enemyMaxHpAffixApplied = applied;
  // The same for Max MP: its rise is what the chest's stats add to MP (through
  // the game's own calculateDerivedStats) plus the affix.
  let mp = null;
  const Z = ENEMY_TYPES.hunt_cult_zealot.baseStats;
  for (let k = 0; k < 600 && mp === null; k++) {
    const e = spawn('hunt_cult_zealot', [{ equip: 'chest', itemId: armorId, rarity: 'epic' }], 9000 + k);
    const affix = e.equipment.chest?.instanceMods?.derived?.maxMP;
    if (affix) {
      const bonus = IF.getItemComputedData(e.equipment.chest).bonuses || {};
      const withStats = { ...Z }; for (const [s2, v] of Object.entries(bonus)) withStats[s2] = (withStats[s2] || 0) + v;
      const fromStats = calculateDerivedStats(withStats).maxMP - calculateDerivedStats(Z).maxMP;
      mp = { affix, rise: e.maxMP - spawn('hunt_cult_zealot').maxMP, fromStats, stranded: e.derived.maxMP || 0 };
    }
  }
  const mpApplied = !!mp && mp.rise === mp.fromStats + mp.affix && mp.stranded === 0;
  check('an armour Max MP affix raises an enemy\'s maxMP by exactly its value', mpApplied,
    mp ? `+${mp.affix} Max MP rolled; maxMP rose ${mp.rise} = stats' ${mp.fromStats} + ${mp.affix}` : 'no roll found');
  golden.enemyMaxMpAffixApplied = mpApplied;
}

// =============================================================================
console.log('=== part rarity ===');
{
  const IRS = [0, 10, 25, 50, 100, 200];
  const table = {};
  let sums = true, zero = true, mono = true;
  for (const g of GRADES) {
    table[g] = {};
    let lastEpic = -1;
    for (const ir of IRS) {
      const o = PS.partRarityOdds(g, ir);
      table[g][ir] = Object.fromEntries(RARITIES.map(r => [r, r2(o[r])]));
      if (Math.abs(RARITIES.reduce((a, r) => a + o[r], 0) - 100) > 1e-9 || RARITIES.some(r => o[r] < -1e-9)) sums = false;
      if (ir === 0 && !same(o, BP.PART_RARITY_BY_GRADE[g])) zero = false;
      if (o.epic < lastEpic - 1e-9) mono = false;
      lastEpic = o.epic;
    }
  }
  check('every grade x Item Rarity sums to 100, none negative', sums);
  check('Item Rarity 0 is the grade\'s own table', zero);
  check('epic never falls as Item Rarity rises', mono);
  const rng = makeRng(424242);
  let worst = 0;
  for (const g of GRADES) {
    for (const ir of [0, 50]) {
      const n = 20000, c = { common: 0, uncommon: 0, rare: 0, epic: 0 };
      for (let i = 0; i < n; i++) c[PS.rollPartRarity(g, ir, rng)]++;
      const o = PS.partRarityOdds(g, ir);
      for (const r of RARITIES) worst = Math.max(worst, Math.abs(100 * c[r] / n - o[r]));
    }
  }
  check('20,000 real draws per grade land on the odds (within 1.2 points)', worst < 1.2, `worst ${r2(worst)}`);
  golden.partRarityOdds = table;
}

// =============================================================================
console.log('=== loadouts ===');
const occOf = (family, grades, id = 'o7') => ({ id, kind: 'beast', family, roster: grades.map(g => ({ type: family, grade: g })) });
{
  const occ = occOf('marsh_stalker', ['great', 'grown', 'yearling']);
  const a = HB.rollLoadout(occ, { itemLevel: 3, itemRarity: 0, seed: 77 });
  const b = HB.rollLoadout(occ, { itemLevel: 3, itemRarity: 0, seed: 77 });
  const c = HB.rollLoadout(occ, { itemLevel: 3, itemRarity: 0, seed: 78 });
  const slots = Object.keys(BP.HUNT_BEASTS.marsh_stalker.parts).sort();
  check('one gear set per member, each with the family\'s slots', a.length === 3 && a.every(g => same(Object.keys(g).sort(), slots)));
  check('deterministic for a seed; another seed differs', same(noIds(a), noIds(b)) && !same(noIds(a), noIds(c)));
  check('every part records its member\'s grade and the region item level',
    a.every((g, i) => Object.values(g).every(p => p.grade === occ.roster[i].grade && p.itemLevel === 3)));
  check('a common part rolls no affixes', a.flat().flatMap(Object.values).filter(p => p.rarity === 'common').every(p => !p.prefixes.length && !p.suffixes.length));
  const cult = { id: 'o3', kind: 'cultist', roster: [{ type: 'cultist', grade: null }, { type: 'cultist', grade: null }, { type: 'cultist', grade: null }] };
  const cl = HB.rollLoadout(cult, { itemLevel: 1, itemRarity: 0, seed: 5 });
  check(`a cultist wears one ${BP.CULTIST_GEAR_SLOT} piece, uncommon or better, and members alternate types`,
    cl.every(g => same(Object.keys(g), [BP.CULTIST_GEAR_SLOT]) && Items[g[BP.CULTIST_GEAR_SLOT].id].type === 'armor' && g[BP.CULTIST_GEAR_SLOT].rarity !== 'common')
    && same([0, 1, 2].map(i => HB.memberType(cult, i)), ['hunt_cult_zealot', 'hunt_cult_adept', 'hunt_cult_zealot']));

  // Statistics per grade (2000 single-member loadouts each, IR 0 and 50).
  const stats = {};
  for (const g of GRADES) {
    for (const ir of [0, 50]) {
      const c = { common: 0, uncommon: 0, rare: 0, epic: 0 };
      let parts = 0, affixes = 0;
      for (let k = 0; k < 2000; k++) {
        const [gear] = HB.rollLoadout(occOf('marsh_stalker', [g], `o${k}`), { itemLevel: 1, itemRarity: ir, seed: 90000 + k });
        for (const p of Object.values(gear)) { parts++; c[p.rarity]++; affixes += p.prefixes.length + p.suffixes.length; }
      }
      stats[`${g}@${ir}`] = { ...Object.fromEntries(RARITIES.map(r => [r, r2(100 * c[r] / parts)])), affixesPerBeast: r2(affixes / 2000) };
    }
  }
  golden.stalkerLoadouts = stats;
  check('a Great stalker carries more affixes than a Yearling one', stats['great@0'].affixesPerBeast > stats['yearling@0'].affixesPerBeast,
    `${stats['yearling@0'].affixesPerBeast} -> ${stats['great@0'].affixesPerBeast} per beast`);
}

// =============================================================================
console.log('=== initiative against the real enemy ===');
{
  let n = 0, bad = [];
  for (const family of FAMILIES) {
    const type = BP.HUNT_BEASTS[family].type;
    for (const g of GRADES) {
      for (let k = 0; k < 6; k++) {
        // The real enemy rolls its own parts at these rarities; memberInitiative
        // is handed exactly what it ended up wearing.
        const rng = makeRng(3000 + k);
        const drops = Object.keys(BP.HUNT_BEASTS[family].parts).map(slot => ({ equip: slot, itemId: BP.partBaseId(family, slot), rarity: PS.rollPartRarity(g, 50, rng) }));
        const e = spawn(type, drops, 7000 + k);
        n++;
        const want = computeEffectiveInitiative(e);
        const got = HB.memberInitiative(type, e.equipment);
        if (want !== got) bad.push(`${type} ${g} #${k}: engine ${want}, HuntBeasts ${got}`);
      }
    }
    for (const t of BP.HUNT_CULTIST_TYPES) {
      const e = spawn(t, [{ equip: 'chest', itemId: 'simple_chest_con_str', rarity: 'epic' }], 11);
      n++;
      if (computeEffectiveInitiative(e) !== HB.memberInitiative(t, e.equipment)) bad.push(`${t}: differs`);
    }
  }
  check('memberInitiative equals the spawned enemy\'s computeEffectiveInitiative, parts included', bad.length === 0, bad.slice(0, 3).join('; ') || `${n} enemies`);
}

// =============================================================================
console.log('=== power per family and grade (real _spawnEnemy) ===');
{
  const power = {};
  for (const family of FAMILIES) {
    const type = BP.HUNT_BEASTS[family].type;
    power[family] = {};
    for (const g of GRADES) {
      const agg = { maxHP: 0, PDR: 0, Evasion: 0, Accuracy: 0, Initiative: 0, dice: 0, buildupPct: 0 };
      const N = 60;
      for (let k = 0; k < N; k++) {
        const rng = makeRng(12000 + k);
        const drops = Object.keys(BP.HUNT_BEASTS[family].parts).map(slot => ({ equip: slot, itemId: BP.partBaseId(family, slot), rarity: PS.rollPartRarity(g, 0, rng) }));
        const e = spawn(type, drops, 13000 + k);
        const w = IF.getItemComputedData(e.equipment.weaponMain).damage;
        agg.maxHP += Math.round(e.maxHP * BP.GRADE_HP_SCALE[g]);
        agg.PDR += e.derived.PhysicalResist; agg.Evasion += e.derived.Evasion; agg.Accuracy += e.derived.Accuracy;
        agg.Initiative += computeEffectiveInitiative(e); agg.dice += (w.min + w.max) / 2;
        agg.buildupPct += Object.values(e.gearEffects.weaponBuildupPercent || {}).reduce((a, b) => a + b, 0);
      }
      power[family][g] = Object.fromEntries(Object.entries(agg).map(([k, v]) => [k, r2(v / N)]));
    }
  }
  golden.powerAtItemLevel1 = power;
  const st = power.marsh_stalker;
  check('grade makes a beast harder: HP and damage rise Yearling -> Great', st.great.maxHP > st.yearling.maxHP && st.great.dice >= st.yearling.dice,
    `HP ${st.yearling.maxHP} -> ${st.great.maxHP}, dice ${st.yearling.dice} -> ${st.great.dice}`);
}

// =============================================================================
console.log('=== the hunt: scout, contact, save ===');
function recordingWorld(party) {
  return { party: () => party, nightFalls() {}, dayBreaks() {}, awardHuntPoints() {}, bankItems() {} };
}
/** A hunt with a hostile occupant in sight at the start (scoutable). */
function huntWithSighted(from = 500) {
  for (let seed = from; seed < from + 400; seed++) {
    for (const zoneId of HUNT_ZONES) {
      const party = makeParty();
      const h = createMapHunt(zoneId, { plan: { objective: 'scout', size: 'medium' }, supplies: 60, seed }, recordingWorld(party));
      const v = h.view();
      const o = v.occupants.find(x => (x.kind === 'beast' || x.kind === 'cultist') && !x.stale);
      if (o) return { h, party, seed, zoneId, occId: o.id };
    }
  }
  return null;
}
{
  const f = huntWithSighted();
  check('found a hunt with a hostile occupant in sight at departure', !!f);
  if (f) {
    const { h, occId } = f;
    const before = h.serialize();
    check('before a scout, nothing shows a loadout', !h.view().occupants.some(o => o.loadout) && !before.map.occupants.find(o => o.id === occId).loadout);
    const r = h.scout(occId);
    const s = h.getState();
    const occ = s.map.occupants.find(o => o.id === occId);
    check('a scout rolls the loadout and keeps it on the occupant', r.ok && Array.isArray(occ.loadout) && occ.loadout.length === occ.roster.length);
    const ov = h.view().occupants.find(o => o.id === occId);
    const shown = ov?.loadout;
    check('the scouted view shows each member\'s slots and rarities, and nothing else',
      same(shown, occ.loadout.map(g => Object.fromEntries(Object.entries(g).map(([sl, p]) => [sl, p.rarity]))))
      && shown.every(g => Object.values(g).every(x => RARITIES.includes(x))));
    const vText = JSON.stringify(h.view());
    // Quoted, so an affix called "Level" does not match "itemLevel".
    const leak = occ.loadout.flatMap(Object.values).some(p => vText.includes(p.instanceId) || vText.includes(JSON.stringify(p.displayName))
      || [...p.prefixes, ...p.suffixes].some(k => vText.includes(JSON.stringify(k))));
    check('no part id or affix name appears anywhere in view()', !leak);
    // The loadout drew from its own stream: the hunt's action stream after a
    // scout is the same as a twin hunt's that never scouted.
    const twin = createMapHunt(f.zoneId, { plan: { objective: 'scout', size: 'medium' }, supplies: 60, seed: f.seed }, recordingWorld(f.party));
    const tS = twin.serialize(), sS = h.serialize();
    check('rolling a loadout leaves the hunt\'s own stream untouched', tS.rngState === sS.rngState || same(tS.rngState, sS.rngState));
    // Save and restore: the loadout comes back exactly, and is not re-rolled.
    const back = restoreMapHunt(JSON.parse(JSON.stringify(h.serialize())), recordingWorld(f.party));
    check('the loadout survives a save and reload unchanged', same(back.getState().map.occupants.find(o => o.id === occId).loadout, occ.loadout));
  }

  // Naturalist's exact roster is not a scout: with the loadout already rolled
  // (as a contact that was fled would leave it), it still shows no loadout.
  {
    const nat = makeParty();
    nat.find(c => c.baseClass === 'Scholar').exploration = { picks: { 2: { passive: 'naturalist' } } };
    let res = null;
    for (let k = 0; k < 200 && !res; k++) {
      const h = createMapHunt('reeds_of_gethsemane', { plan: { objective: 'cull', size: 'medium' }, supplies: 60, seed: 7500 + k }, recordingWorld(nat));
      const b = h.view().occupants.find(o => o.kind === 'beast' && o.band === 'identified' && o.exact);
      if (!b) continue;
      // The save as it stands after that beast was met and fled: its loadout
      // rolled, never scouted.
      const data = h.serialize();
      const occ = data.map.occupants.find(o => o.id === b.id);
      occ.loadout = HB.rollLoadout(occ, { itemLevel: 1, itemRarity: 0, seed: HB.loadoutSeed(data.seed, occ) });
      const back = restoreMapHunt(data, recordingWorld(nat));
      res = { v: back.occupantViewOf(b.id), rolled: !!back.getState().map.occupants.find(o => o.id === b.id).loadout };
    }
    check('Naturalist alone shows the exact roster but never the loadout', !!res && res.rolled && res.v.exact && !res.v.loadout);
  }

  // Contact: walking into an occupant rolls its loadout first, and the
  // encounter's enemy initiative is that loadout's.
  let contacts = 0, badContact = [], kept = 0;
  const firsts = { party: 0, enemy: 0, ambush: 0 };
  for (let seed = 700; seed < 760; seed++) {
    for (const zoneId of HUNT_ZONES) {
      const party = makeParty();
      const h = createMapHunt(zoneId, { plan: { objective: 'cull', size: 'medium' }, supplies: 200, seed }, recordingWorld(party));
      const pick = makeRng(seed);
      const scoutedAs = {};
      for (let i = 0; i < 80 && !h.encounter(); i++) {
        const v = h.view();
        const sighted = v.occupants.find(o => (o.kind === 'beast' || o.kind === 'cultist') && !o.stale && o.band === 'identified');
        if (sighted && pick() < 0.5 && !h.getState().scouted.includes(sighted.id) && h.scout(sighted.id).ok) {
          scoutedAs[sighted.id] = noIds(h.getState().map.occupants.find(o => o.id === sighted.id).loadout);
          // The party's Item Rarity then rises, so a loadout re-rolled at the
          // fight would come out different: the fight must meet the scouted one.
          party[0].gearEffects = { ...(party[0].gearEffects || {}), itemRarityPercent: ((party[0].gearEffects || {}).itemRarityPercent || 0) + 300 };
        }
        const opts = v.moves.map(m => m.tile);
        if (!opts.length) break;
        h.move(opts[Math.floor(pick() * opts.length)]);
      }
      const e = h.encounter();
      if (!e) continue;
      contacts++;
      const s = h.getState();
      const occ = s.map.occupants.find(o => o.id === e.occId);
      if (!occ.loadout) badContact.push(`${zoneId} ${seed}: no loadout at contact`);
      else if (e.enemyInitiative !== HB.occupantInitiative(occ)) badContact.push(`${zoneId} ${seed}: initiative`);
      if (s.scouted.includes(e.occId)) {
        kept++;
        if (!same(scoutedAs[e.occId], noIds(occ.loadout))) badContact.push(`${zoneId} ${seed}: fought a different loadout from the one scouted`);
      }
      if (e.ambush) firsts.ambush++; else firsts[e.first]++;
    }
  }
  check('every contact rolls its loadout first, and its initiative is that loadout\'s', contacts > 20 && badContact.length === 0,
    badContact.slice(0, 3).join('; ') || `${contacts} contacts (${kept} of them scouted first)`);
  golden.contactFirsts = firsts;
  console.log(`  (contacts: ${firsts.party} party first, ${firsts.enemy} enemy first on initiative, ${firsts.ambush} ambushes)`);
}

// =============================================================================
const args = process.argv.slice(2);
const jsonAt = args.indexOf('--json');
const diffAt = args.indexOf('--diff');
if (jsonAt >= 0) {
  fs.writeFileSync(args[jsonAt + 1], JSON.stringify(golden, null, 1) + '\n');
  console.log(`golden written -> ${args[jsonAt + 1]}`);
}
if (diffAt >= 0) {
  console.log('=== golden diff ===');
  const old = JSON.parse(fs.readFileSync(args[diffAt + 1], 'utf8'));
  const keys = new Set([...Object.keys(old), ...Object.keys(golden)]);
  const changed = [...keys].filter(k => !same(old[k], golden[k]));
  check('beast parts identical to the golden', changed.length === 0, changed.length ? `changed: ${changed.join(', ')}` : `${keys.size} tables`);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
