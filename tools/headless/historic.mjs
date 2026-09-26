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

// =============================================================================
// 14b-1b: the items' mechanics, in real fights (the real CombatScene in the
// headless host, real hunters and training dummies, seeded per comparison).
// =============================================================================
const { seed } = await import('./phaserStub.js');
const { createCombatHost } = await import('./combatHost.js');
const { startCombat, setActor, cast, endTurn } = await import('./fight.js');
const { slotMapFor, skillFor } = await import('./fixtures.js');
const CombatSceneMod = await import('../../src/scenes/CombatScene.js');
const CombatScene = CombatSceneMod.default || Object.values(CombatSceneMod).find(v => typeof v === 'function');
const { GRIEF, SORROWFALL, ROOTED, UNSHRIVEN, griefStacks, rootedStacks } = await import('../../data/historicEffects.js');
const { getWeaponSkillsFor, SKILLS } = await import('../../data/skills.js');
const { unshrivenPct, getEffectiveDerived } = await import('../../src/systems/CombatLogic.js');

/** A fresh fight against the first training dummies; `dress(party)` equips first. */
function board(dress = () => {}) {
  const party = makeParty();
  dress(party);
  for (const c of party) { CB.rebuildCharacterStats(c); c.currentHP = c.maxHP; c.currentMP = c.maxMP; }
  const host = createCombatHost(CombatScene);
  host.__begin({ party, partySlots: slotMapFor(party), scenarioId: 'training_encounter_1' });
  startCombat(host);
  for (const c of party) { c.currentMP = c.maxMP; c.actionsLeft = { major: 1, bonus: 1, class: 1, reaction: 1 }; }
  const foe = host.enemies.find(e => e.currentHP > 0);
  return { host, party, foe, by: (n) => party.find(c => c.name === n) };
}
/** Damage one cast deals, from a fresh board, seeded. */
function hitFor({ dress, who, skill, prep = () => {}, s = 9 }) {
  const b = board(dress);
  const actor = b.by(who);
  // Deep HP: a training dummy's small pool caps a hit at what is left,
  // which flattens every comparison (measured: 20 -> 20 either way).
  b.foe.maxHP = b.foe.currentHP = 99999;
  prep(b);
  const hp = b.foe.currentHP;
  seed(s);
  setActor(b.host, actor);
  actor.actionsLeft = { major: 1, bonus: 1, class: 1, reaction: 1 };
  // An item-granted skill is a stub on the character; the game's Special
  // tab resolves it through SKILLS (CombatScene, the 'special' menu). Same here.
  const own = skillFor(actor, skill);
  const ability = typeof own?.apply === 'function' ? own : { ...SKILLS[skill], id: skill };
  const r = cast(b.host, actor, ability, b.foe);
  return { dmg: hp - b.foe.currentHP, b, r };
}
/** Total damage of the same cast over many seeds (small hits round; totals do not). */
function sumFor(opts, n = 30) {
  let t = 0;
  for (let k = 0; k < n; k++) t += hitFor({ ...opts, s: 100 + k }).dmg;
  return t;
}
const bod = () => IF.createItemInstance('burden_of_dreams', { rng: makeRng(11) });
const withBurden = (party) => { party.find(c => c.name === 'Halvard').equipment.weaponMain = bod(); };

console.log('=== Burden of Dreams: Sorrowfall, Flashing Grief, Heavy Heart ===');
{
  const b = board(withBurden);
  const hal = b.by('Halvard');
  const plain = makeParty().find(c => c.name === 'Halvard');
  check('Burden of Dreams grants Sorrowfall to its wielder only (never through the mace kit)',
    hal.skills.some(s => (s?.id || s) === 'sorrowfall') && !getWeaponSkillsFor(plain).some(s => s.id === 'sorrowfall')
    && !(plain.skills || []).some(s => (s?.id || s) === 'sorrowfall'));

  const none = hitFor({ dress: withBurden, who: 'Halvard', skill: 'sorrowfall' });
  const two = hitFor({ dress: withBurden, who: 'Halvard', skill: 'sorrowfall', prep: ({ host, foe }) => host._applyGrief(foe, 2) });
  const want = (SORROWFALL.basePct + 2 * SORROWFALL.perGriefPct) / SORROWFALL.basePct;
  check(`Sorrowfall: +${SORROWFALL.perGriefPct}% per Grief stack on the target (2 stacks: x${want.toFixed(3)}, same seed)`,
    none.dmg > 0 && Math.abs(two.dmg / none.dmg - want) < 0.03, `${none.dmg} -> ${two.dmg} (x${(two.dmg / none.dmg).toFixed(3)})`);

  // Proficiency also scales damage, so both sides of this comparison carry
  // STR 20: the baseline just has the Flashing threshold out of reach.
  const strong = (p) => { withBurden(p); p.find(c => c.name === 'Halvard').proficiencyBonus = { STR: 20 }; };
  const keep = SORROWFALL.flashing.value;
  SORROWFALL.flashing.value = 999;
  const base20 = hitFor({ dress: strong, who: 'Halvard', skill: 'sorrowfall' });
  SORROWFALL.flashing.value = keep;
  const flash = hitFor({ dress: strong, who: 'Halvard', skill: 'sorrowfall' });
  const wantF = (SORROWFALL.basePct + GRIEF.maxStacks * SORROWFALL.perGriefPct) / SORROWFALL.basePct;
  check(`with STR Proficiency ${SORROWFALL.flashing.value} it is Flashing Grief: ${GRIEF.maxStacks} Grief first, the blow at x${wantF.toFixed(3)} (same Proficiency, same seed)`,
    griefStacks(flash.b.foe) === GRIEF.maxStacks && griefStacks(base20.b.foe) === 1 && Math.abs(flash.dmg / base20.dmg - wantF) < 0.03
    && flash.r.log.some(l => /Flashing Grief/.test(l)), `${base20.dmg} -> ${flash.dmg} (x${(flash.dmg / base20.dmg).toFixed(3)}), Grief ${griefStacks(flash.b.foe)}`);

  const hh = hitFor({ dress: withBurden, who: 'Halvard', skill: 'basic_attack' });
  check('Heavy Heart: a hit with Burden of Dreams lays 1 Grief', hh.dmg > 0 && griefStacks(hh.b.foe) === 1, `Grief ${griefStacks(hh.b.foe)}`);
  const capped = board(withBurden);
  capped.host._applyGrief(capped.foe, 5);
  check(`Grief stacks cap at ${GRIEF.maxStacks} and last ${GRIEF.turns} turns`,
    griefStacks(capped.foe) === GRIEF.maxStacks && capped.foe.statusEffects.find(s => s.id === 'grief').turns === GRIEF.turns);

  // Grief cuts the griever's own damage: -8% per stack.
  const clean = sumFor({ dress: () => {}, who: 'Torg', skill: 'basic_attack' });
  const grieved = sumFor({ dress: () => {}, who: 'Torg', skill: 'basic_attack', prep: ({ host, by }) => host._applyGrief(by('Torg'), 3) });
  const wantG = 1 + 3 * GRIEF.perStackPct / 100;
  const gb = board(() => {}); gb.host._applyGrief(gb.by('Torg'), 3);
  const { _sumStatusEffectMods } = await import('../../src/systems/CombatLogic.js');
  check(`Grief on a unit cuts its damage by ${-GRIEF.perStackPct}% a stack: 3 stacks are AttackPower ${3 * GRIEF.perStackPct}, and 30 seeded hits land near x${wantG.toFixed(2)}`,
    _sumStatusEffectMods(gb.by('Torg')).AttackPower === 3 * GRIEF.perStackPct && clean > 0 && grieved / clean > wantG - 0.07 && grieved / clean < wantG + 0.02,
    `${clean} -> ${grieved} (x${(grieved / clean).toFixed(3)}; whole-number floors on ~15-damage hits skew it low)`);
}

console.log('=== The Unconfessed: curse on hit, Curse of the Unshriven ===');
{
  const amu = () => IF.createItemInstance('the_unconfessed', { rng: makeRng(12) });
  const withAmu = (p) => { p.find(c => c.name === 'Bran').equipment.amulet = amu(); };
  // A bigger hitter for the Unshriven comparisons: +15% of Bran's usual
  // ~3 necrotic slice floors straight back to 3 (measured, 2026-09-26).
  const heavy = (p) => { withAmu(p); p.find(c => c.name === 'Bran').equipment.weaponMain = bod(); };
  const a = hitFor({ dress: withAmu, who: 'Bran', skill: 'basic_attack' });
  const bran = a.b.by('Bran');
  check('a hit curses the target and its wearer (curse buildup on both)',
    a.dmg > 0 && (a.b.foe.weakness?.meters?.curse || 0) > 0 && (bran.weakness?.meters?.curse || 0) > 0,
    `target ${a.b.foe.weakness?.meters?.curse}, wearer ${bran.weakness?.meters?.curse}`);

  // The bonus: 0 uncursed; the base from tier 1; scaled by the meter; capped.
  const u = { gearEffects: { historic: { unshrivenPct: 15 } }, weakness: { tiers: { curse: 0 }, meters: { curse: 0 } } };
  const at = (tier, meter) => unshrivenPct({ ...u, weakness: { tiers: { curse: tier }, meters: { curse: meter } } });
  check(`Curse of the Unshriven: 0 uncursed, 15% at Curse tier 1, rising with the meter, capped at ${UNSHRIVEN.cap}%`,
    at(0, 0) === 0 && Math.abs(at(1, 150) - 15) < 1e-9 && at(2, 600) > 15 && at(2, 1e6) === UNSHRIVEN.cap && unshrivenPct({}) === 0,
    `t1 ${at(1, 150)}, t2@600 ${at(2, 600).toFixed(1)}, huge ${at(2, 1e6)}`);

  // Dealt: the same seeded hit, the wearer cursed or not.
  const curse = (unit, meter) => { unit.weakness = unit.weakness || {}; unit.weakness.meters = { ...(unit.weakness.meters || {}), curse: meter }; unit.weakness.tiers = { ...(unit.weakness.tiers || {}), curse: meter >= 200 ? 2 : meter >= 100 ? 1 : 0 }; };
  const off = sumFor({ dress: heavy, who: 'Bran', skill: 'basic_attack' });
  const on = sumFor({ dress: heavy, who: 'Bran', skill: 'basic_attack', prep: ({ by }) => curse(by('Bran'), 150) });
  // The multiplier itself, from the hit's own damage breakdown (the totals
  // move less: only the necrotic slice grows, and each hit floors).
  const { getLastDamageBreakdown } = await import('../../src/systems/CombatLogic.js');
  const unshrivenLine = () => (getLastDamageBreakdown() || []).find(e => /Unshriven/.test(e.label || ''));
  hitFor({ dress: heavy, who: 'Bran', skill: 'basic_attack', prep: ({ by }) => curse(by('Bran'), 150) });
  const dl = unshrivenLine();
  check('a cursed wearer deals more: its necrotic x1.15 in its hit breakdown, and more over 30 seeded hits',
    !!dl && Math.abs(dl.mult - 1.15) < 1e-9 && on > off, `${dl ? `${dl.label} ${dl.from} -> ${dl.to}` : 'no breakdown line'}; totals ${off} -> ${on}`);

  // Taken, and on an enemy: a dummy wearing it (the Ghost Captain's case).
  const wearFoe = ({ host, foe }) => { host._equipEnemyItem(foe, { equip: 'amulet', instance: amu(), droppable: true }); };
  const probe = hitFor({ dress: withAmu, who: 'Bran', skill: 'basic_attack', prep: (b) => wearFoe(b) });
  const t0 = sumFor({ dress: heavy, who: 'Bran', skill: 'basic_attack', prep: (b) => wearFoe(b) });
  const t1 = sumFor({ dress: heavy, who: 'Bran', skill: 'basic_attack', prep: (b) => { wearFoe(b); curse(b.foe, 150); } });
  hitFor({ dress: heavy, who: 'Bran', skill: 'basic_attack', prep: (b) => { wearFoe(b); curse(b.foe, 150); } });
  const tl = unshrivenLine();
  check('on an ENEMY it works too: its gear effects hold it, and cursed it takes +15% necrotic (breakdown, and 30 seeded hits)',
    !!probe.b.foe.gearEffects?.historic?.unshrivenPct && !!tl && /taken/.test(tl.label) && Math.abs(tl.mult - 1.15) < 1e-9 && t1 > t0,
    `${tl ? `${tl.label} ${tl.from} -> ${tl.to}` : 'no breakdown line'}; totals ${t0} -> ${t1}`);
}

console.log('=== Sunken Nave: Rooted ===');
{
  const withNave = (p) => { p.find(c => c.name === 'Bran').equipment.legs = IF.createItemInstance('sunken_nave', { rng: makeRng(13) }); };
  const b = board(withNave);
  const bran = b.by('Bran');
  const pdr0 = getEffectiveDerived(bran).PhysicalResist;
  setActor(b.host, bran);
  endTurn(b.host);
  check('a turn ended without moving: Rooted 1, +5 Physical Resist', rootedStacks(bran) === 1 && getEffectiveDerived(bran).PhysicalResist - pdr0 === ROOTED.perStack.PhysicalResist,
    `stacks ${rootedStacks(bran)}, PDR ${pdr0} -> ${getEffectiveDerived(bran).PhysicalResist}`);
  b.host._rootedTurnEnd(bran); b.host._rootedTurnEnd(bran); b.host._rootedTurnEnd(bran);
  const { _sumStatusEffectMods: mods } = await import('../../src/systems/CombatLogic.js');
  const rm = mods(bran);
  check(`Rooted caps at ${ROOTED.maxStacks}: +${ROOTED.maxStacks * ROOTED.perStack.PhysicalResist} Physical Resist, +${ROOTED.maxStacks * ROOTED.perStack.Resilience} Resilience from its status`,
    rootedStacks(bran) === ROOTED.maxStacks && rm.PhysicalResist === ROOTED.maxStacks * ROOTED.perStack.PhysicalResist && rm.Resilience === ROOTED.maxStacks * ROOTED.perStack.Resilience,
    `stacks ${rootedStacks(bran)}, mods PDR ${rm.PhysicalResist}, Resilience ${rm.Resilience}`);
  b.host._addStatusEffects(bran, [{ id: 'immobilized', turns: 2 }]);
  check('while Rooted, Immobilize does not take', !bran.statusEffects.some(s => s.id === 'immobilized'));
  const empty = b.host.allySlots.find(sl => !sl.char && sl.slotId !== bran._slot?.slotId);
  const moved = b.host._moveUnitToSlot(bran, empty);
  check('moving (or being moved) uproots it', moved !== false && rootedStacks(bran) === 0, `moved ${moved}`);
  bran._movedThisTurn = true;
  b.host._rootedTurnEnd(bran);
  check('...and a turn it moved in adds no stack', rootedStacks(bran) === 0);
  const plain = board(() => {});
  const p0 = plain.by('Bran');
  plain.host._rootedTurnEnd(p0);
  check('without Sunken Nave nobody takes root', rootedStacks(p0) === 0);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
