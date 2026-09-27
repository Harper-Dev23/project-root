// tools/headless/cultmarket.mjs
//
// The cult economy (vault CONTENT_INBOX "The cult economy", owner-approved
// 2026-09-27): Sin Tickets, the Corrupted renown origin, potions, the black
// markets, parley. Grows with each step.
//   node tools/headless/cultmarket.mjs

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};

const store = new Map();
globalThis.localStorage = {
  get length() { return store.size; }, key: (i) => [...store.keys()][i] ?? null,
  getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); }, clear: () => store.clear(),
};
const { installPhaserStub } = await import('./phaserStub.js');
installPhaserStub(7);

const F = await import('../../src/systems/ItemFactory.js');
const { Items } = await import('../../data/items.js');
const { makeRng } = await import('../../src/systems/seededRng.js');
const ProgressionManager = (await import('../../src/systems/ProgressionManager.js')).default;
const GameState = (await import('../../src/systems/GameState.js')).default;

const CORE = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'];

// =============================================================================
console.log('=== Corrupted: armour only, a gain budget and a malus by base tier ===');
{
  const C = F.RENOWN_ORIGINS.corrupted;
  const bases = Object.values(Items).filter(i => i.type === 'armor' && !['ring', 'amulet'].includes(i.slot) && !i.unique && !i.historic && !i.natural && !i.locked);
  const bad = [];
  const malusSeen = new Set();
  for (const b of bases) {
    for (let k = 0; k < 40; k++) {
      const inst = F.createItemInstance(b.id, { rarity: 'common', itemLevel: 3, rng: makeRng(1000 + k), renownOrigin: 'corrupted' });
      const c = inst.corruption;
      const budget = C.budget[b.baseTier];
      const own = Object.keys(b.bonuses);
      const gains = Object.values(c.gain);
      const [mStat, mVal] = Object.entries(c.malus)[0];
      malusSeen.add(mStat);
      if (gains.reduce((t, x) => t + x, 0) !== budget.gain) bad.push(`${b.id}: gain ${gains}`);
      if (Math.max(...gains) - Math.min(...gains) > 1) bad.push(`${b.id}: uneven split ${gains}`);
      if (!own.every(s => s in c.gain) || Object.keys(c.gain).length !== own.length) bad.push(`${b.id}: gain off its own stats`);
      if (own.includes(mStat) || mVal !== -budget.malus || !CORE.includes(mStat)) bad.push(`${b.id}: malus ${mStat} ${mVal}`);
      const v = F.getItemComputedData(inst).bonuses;
      for (const s of own) if (v[s] !== b.bonuses[s] + c.gain[s]) bad.push(`${b.id}: ${s} shows ${v[s]}`);
      if (v[mStat] !== mVal) bad.push(`${b.id}: ${mStat} shows ${v[mStat]}`);
    }
  }
  check(`every armour base (${bases.length}), 40 rolls each: the tier's gain split evenly over its own stats, the malus on one it lacks, and the item shows both`,
    bad.length === 0 && bases.length === 30, bad.slice(0, 4).join(' | '));
  check('the malus can land on any core stat a base lacks, CHA included', CORE.every(s => malusSeen.has(s)), [...malusSeen].join(','));
  const net = (tier) => C.budget[tier].gain - C.budget[tier].malus;
  check('always a net gain, skewed to the positive (tier 1 +4/-2, tier 2 +6/-3)', net(1) === 2 && net(2) === 3 && C.budget[1].gain === 4 && C.budget[2].malus === 3);
  const a = F.createItemInstance('fitted_boots_dex_wis', { rarity: 'rare', itemLevel: 3, rng: makeRng(5), renownOrigin: 'corrupted' });
  const b = F.createItemInstance('fitted_boots_dex_wis', { rarity: 'rare', itemLevel: 3, rng: makeRng(5), renownOrigin: 'corrupted' });
  check('the same seed rolls the same corruption', JSON.stringify(a.corruption) === JSON.stringify(b.corruption) && JSON.stringify(a.instanceMods.stats) === JSON.stringify(b.instanceMods.stats));
  check('named "Corrupted <noun>", its rolled affixes kept', /Corrupted Boots/.test(a.displayName), a.displayName);
  const w = F.createItemInstance('crude_dagger', { rarity: 'rare', itemLevel: 3, rng: makeRng(5), renownOrigin: 'corrupted' });
  check('never a weapon (armour only)', !w.renownOrigin && !w.corruption && !/Corrupted/.test(w.displayName || ''));
  // Through the game's own save and load (its item serializer and migrations).
  GameState.inventory = [a];
  GameState.save('__cultmarket');
  GameState.inventory = [];
  GameState.load('__cultmarket');
  const back = (GameState.inventory || []).find(i => i.instanceId === a.instanceId) || null;
  check('it survives a real save and load: the corruption and its stats are on the loaded item', !!back && JSON.stringify(back.corruption) === JSON.stringify(a.corruption)
    && JSON.stringify(F.getItemComputedData(back).bonuses) === JSON.stringify(F.getItemComputedData(a).bonuses));
}

// =============================================================================
console.log('=== Sin Tickets ===');
{
  ProgressionManager.reset();
  check('a new save starts with none', ProgressionManager.sinTickets === 0);
  ProgressionManager.sinTickets = 7;
  const blob = JSON.parse(JSON.stringify(ProgressionManager.serialize()));
  ProgressionManager.reset();
  ProgressionManager.deserialize(blob);
  check('they survive a save and reload', ProgressionManager.sinTickets === 7);
  const old = { ...blob }; delete old.sinTickets;
  ProgressionManager.deserialize(old);
  check('a save from before them loads with none', ProgressionManager.sinTickets === 0);
  ProgressionManager.reset();
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
