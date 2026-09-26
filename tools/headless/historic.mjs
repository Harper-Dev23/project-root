// tools/headless/historic.mjs
//
// Historic items (Exploration System v2, chunk 14b; vault IMPLEMENTATION_PLAN
// "Historic items and bosses" and "The Reeds' three Historic items — final
// sheet"). Everything read off the game's own code.
//
// What it proves (14b-1a):
//   - every Historic base with historicRolls rolls each line inside its range,
//     reaches both ends over many rolls, and never picks up pool affixes
//   - the rolled values reach a real hunter (rebuildCharacterStats): the
//     stats, derived stats and misc lines move by exactly what was rolled
//   - the ledger: an item is "in the wild" only while the save holds no copy
//     anywhere (camp bag, a hunter's gear or pack, the Slain, the tribe
//     stash, the hunt's pack)
//   - the lodge ritual (GameState.returnHistoric): only from the camp bag,
//     only an item with a home (never the Bloodthirster); the copy is gone,
//     the item is back in the wild, the return is recorded, and the record
//     survives a save and load
//
// USAGE
//   node tools/headless/historic.mjs

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};

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
installPhaserStub(1);
const GS = (await import('../../src/systems/GameState.js')).default;
const IF = await import('../../src/systems/ItemFactory.js');
const { Items } = await import('../../data/items.js');
const { makeRng } = await import('../../src/systems/seededRng.js');
const { makeParty } = await import('./fixtures.js');
const CB = await import('../../src/systems/CharacterBuilder.js');

const HISTORIC = Object.keys(Items).filter(id => Items[id].historicRolls);

console.log('=== rolled ranges ===');
check('the Reeds\' three Historic items exist and declare their ranges and home',
  ['burden_of_dreams', 'the_unconfessed', 'sunken_nave'].every(id => Items[id]?.historic && Items[id]?.rarity === 'historic' && Items[id]?.historicRolls && Items[id]?.home),
  HISTORIC.join(', '));
for (const id of HISTORIC) {
  const spec = Items[id].historicRolls;
  const seen = {};   // "group.key" -> Set of values
  let outside = [], affixed = 0;
  for (let k = 0; k < 2000; k++) {
    const inst = IF.createItemInstance(id, { rng: makeRng(5000 + k) });
    if ((inst.prefixes || []).length || (inst.suffixes || []).length) affixed++;
    for (const group of ['stats', 'derived', 'misc']) {
      for (const [key, [lo, hi]] of Object.entries(spec[group] || {})) {
        const v = inst.historicRolls?.[group]?.[key];
        (seen[`${group}.${key}`] = seen[`${group}.${key}`] || new Set()).add(v);
        if (!(v >= lo && v <= hi)) outside.push(`${group}.${key}=${v}`);
      }
    }
    for (const [end, [lo, hi]] of Object.entries(spec.damageFlat || {})) {
      const v = inst.historicRolls?.damageFlat?.[end];
      (seen[`damageFlat.${end}`] = seen[`damageFlat.${end}`] || new Set()).add(v);
      if (!(v >= lo && v <= hi)) outside.push(`damageFlat.${end}=${v}`);
    }
  }
  const ends = [];
  const want = (k, lo, hi) => { if (!seen[k]?.has(lo) || !seen[k]?.has(hi)) ends.push(k); };
  for (const group of ['stats', 'derived', 'misc']) for (const [key, [lo, hi]] of Object.entries(spec[group] || {})) want(`${group}.${key}`, lo, hi);
  for (const [end, [lo, hi]] of Object.entries(spec.damageFlat || {})) want(`damageFlat.${end}`, lo, hi);
  check(`${Items[id].name}: 2,000 rolls, every line inside its range, both ends reached, no pool affixes`,
    !outside.length && !ends.length && affixed === 0,
    outside.length ? `outside: ${outside.slice(0, 3)}` : ends.length ? `ends not reached: ${ends}` : '');
}

console.log('=== the rolls reach a real hunter ===');
{
  const [bran] = makeParty();
  // The fixture hunters start in a class armour set (Bran's legs give +1 CON):
  // measure against empty slots, or the swap nets the difference.
  bran.equipment.legs = null;
  bran.equipment.amulet = null;
  CB.rebuildCharacterStats(bran);
  const before = { STR: bran.totalStats.STR, CON: bran.totalStats.CON, pdr: bran.derived.PhysicalResist || 0, ev: bran.derived.Evasion || 0, res: bran.gearEffects?.resilience || 0 };
  const nave = IF.createItemInstance('sunken_nave', { rng: makeRng(77) });
  bran.equipment.legs = nave;
  CB.rebuildCharacterStats(bran);
  const r = nave.historicRolls;
  const after = { STR: bran.totalStats.STR, CON: bran.totalStats.CON, pdr: bran.derived.PhysicalResist || 0, ev: bran.derived.Evasion || 0, res: bran.gearEffects?.resilience || 0 };
  // CON also raises derived stats of its own; compare the lines the item sets.
  check('Sunken Nave worn: STR, CON, Evasion and Resilience move by exactly the copy\'s rolls; Physical Resist by at least its roll',
    after.STR - before.STR === r.stats.STR && after.CON - before.CON === r.stats.CON && after.ev - before.ev === r.derived.Evasion
    && after.res - before.res === r.misc.resilience && after.pdr - before.pdr >= r.derived.PhysicalResist,
    JSON.stringify({ before, after, rolls: r }));
  const amu = IF.createItemInstance('the_unconfessed', { rng: makeRng(78) });
  bran.equipment.amulet = amu;
  CB.rebuildCharacterStats(bran);
  check('The Unconfessed worn: its physical-to-necrotic roll reaches the hunter\'s gear effects',
    (bran.gearEffects?.physToNecroPercent || 0) === amu.historicRolls.misc.physToNecroPercent, `${bran.gearEffects?.physToNecroPercent} vs ${amu.historicRolls.misc.physToNecroPercent}`);
}

console.log('=== the ledger: in the wild only while nowhere in the save ===');
{
  const p = makeParty();
  GS.characters = p; GS.party = p; GS.slain = []; GS.inventory = []; GS.tribeStash = {}; GS.flags = {};
  GS._huntHooks = null; GS._rawHunt = null;
  const id = 'burden_of_dreams';
  const b = IF.createItemInstance(id);
  const places = {
    'the camp bag': [() => GS.inventory.push(b), () => { GS.inventory = []; }],
    "a hunter's weapon slot": [() => { p[0].equipment.weaponMain = b; }, () => { p[0].equipment.weaponMain = null; }],
    "a hunter's own inventory": [() => { p[1].inventory = [b]; }, () => { p[1].inventory = []; }],
    'one of the Slain': [() => { GS.slain = [{ ...p[2], equipment: { ...p[2].equipment, weaponMain: b } }]; }, () => { GS.slain = []; }],
    'the tribe stash': [() => { GS.tribeStash = { elseth: [b] }; }, () => { GS.tribeStash = {}; }],
    "the hunt's pack": [() => { GS._rawHunt = { pack: { brought: [], found: [b] } }; }, () => { GS._rawHunt = null; }],
  };
  const bad = [];
  if (!GS.historicInWild(id)) bad.push('not wild with no copy');
  for (const [where, [put, take]] of Object.entries(places)) {
    put();
    if (GS.historicInWild(id)) bad.push(`wild while in ${where}`);
    take();
    if (!GS.historicInWild(id)) bad.push(`not wild after leaving ${where}`);
  }
  check('held in the camp bag, a weapon slot, a hunter\'s inventory, the Slain, the tribe stash or the hunt\'s pack; wild otherwise', !bad.length, bad.join('; '));

  // The lodge ritual.
  p[0].equipment.weaponMain = b;
  const worn = GS.returnHistoric(b, 4);
  p[0].equipment.weaponMain = null;
  GS.inventory = [b];
  const done = GS.returnHistoric(b, 4);
  check('the ritual: refused while worn; from the camp bag it removes the copy and records the return',
    !worn.ok && done.ok && !GS.inventory.includes(b) && GS.historicInWild(id) && GS.flags.historicLedger?.[id]?.returned === 1 && GS.flags.historicLedger[id].lastReturnedDay === 4,
    JSON.stringify({ worn, done, led: GS.flags.historicLedger }));
  const bt = IF.createItemInstance('bloodthirster');
  GS.inventory = [bt];
  const q = GS.returnHistoric(bt, 4);
  check('the Bloodthirster (a quest item with no home) cannot be returned', !q.ok && GS.inventory.includes(bt));

  GS.inventory = [];
  GS.save('historic_test');
  GS.flags = {};
  GS.load('historic_test');
  check('the ledger survives a save and load', GS.flags.historicLedger?.[id]?.returned === 1, JSON.stringify(GS.flags.historicLedger));
}

console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
