// tools/headless/scaling.mjs
//
// Level 10 + hunt scaling (Exploration System v2, chunk 2). Every number here
// comes from calling the REAL exported function; no formula is re-derived to
// check it.
//
// What it proves:
//   - huntItemLevel(danger) for danger 1-10 (the golden records the table)
//   - the hunt XP split for party sizes 1-6, as a table AND as XP that really
//     lands on real characters through GameState.awardXPPool
//   - the hunt world's awardXP and a hunt fight both go through that split
//   - a hunt fight's gear really rolls at the item level it was handed
//   - every zone has a danger level in 1-10
//   - the level cap is 10, the XP curve covers 1-10, and training stops at 5
//
// USAGE
//   node tools/headless/scaling.mjs                  run the checks
//   node tools/headless/scaling.mjs --json out.json  also write the golden
//   node tools/headless/scaling.mjs --diff old.json  also compare against one

import fs from 'node:fs';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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
installPhaserStub(12);

const GameState = (await import('../../src/systems/GameState.js')).default;
const { GAME_WORLD } = await import('../../src/systems/HuntManager.js');
const { huntItemLevel, DANGER_MIN, DANGER_MAX } = await import('../../src/systems/HuntScaling.js');
const { LEVEL_CAP, TRAINING_LEVEL_CAP, getXPNeededForLevel, xpShare, XP_SHARE_FLOOR_PCT } = await import('../../data/xpTable.js');
const { ZONES } = await import('../../data/zones.js');
const { makeParty } = await import('./fixtures.js');
const { createCombatHost } = await import('./combatHost.js');
const CS = await import('../../src/scenes/CombatScene.js');
const CombatScene = CS.default || Object.values(CS).find(v => typeof v === 'function');

const golden = {};
const SIZES = [1, 2, 3, 4, 5, 6];
// 20 is a hunt fight's base XP today (CombatScene._calculateXPReward); 100 reads as a percent.
const POOLS = [20, 100];

// =============================================================================
console.log('=== huntItemLevel ===');
{
  const table = {};
  for (let d = 1; d <= 10; d++) table[d] = huntItemLevel(d);
  golden.huntItemLevel = table;
  console.log('    danger    ' + Object.keys(table).map(d => String(d).padStart(3)).join(''));
  console.log('    itemLevel ' + Object.values(table).map(v => String(v).padStart(3)).join(''));
  check('danger level = item level, 1-10', Object.entries(table).every(([d, il]) => il === +d));

  const edges = { 0: huntItemLevel(0), 11: huntItemLevel(11), '2.4': huntItemLevel(2.4),
    undefined: huntItemLevel(undefined), NaN: huntItemLevel(NaN) };
  golden.huntItemLevelEdges = edges;
  check('out-of-range and missing danger stay inside 1-10',
    Object.values(edges).every(v => v >= DANGER_MIN && v <= DANGER_MAX), JSON.stringify(edges));
}

// =============================================================================
console.log('=== zones carry a danger level ===');
{
  const dangers = Object.fromEntries(Object.entries(ZONES).map(([id, z]) => [id, z.danger]));
  golden.zoneDanger = dangers;
  console.log('    ' + JSON.stringify(dangers));
  check('every zone has an integer danger in 1-10',
    Object.values(dangers).every(d => Number.isInteger(d) && d >= 1 && d <= 10));
  check('no zone still uses the old dangerTier field',
    Object.values(ZONES).every(z => !('dangerTier' in z)));
}

// =============================================================================
console.log('=== XP split (xpShare) ===');
{
  golden.xpShareFloorPct = XP_SHARE_FLOOR_PCT;
  golden.xpShare = {};
  for (const pool of POOLS) {
    const row = {};
    for (const n of SIZES) row[n] = xpShare(pool, n);
    golden.xpShare[pool] = row;
    console.log(`    pool ${String(pool).padStart(3)}:  ` +
      SIZES.map(n => `${n}p=${row[n]}`).join('  ') +
      `   (party total ${SIZES.map(n => row[n] * n).join('/')})`);
  }
  const r = golden.xpShare[100];
  check('a solo hunter gets the whole pool', r[1] === 100);
  check('fewer hunters never get less each', SIZES.slice(1).every(n => r[n] <= r[n - 1]));
  check(`no share falls below the ${XP_SHARE_FLOOR_PCT}% floor`, SIZES.every(n => r[n] >= XP_SHARE_FLOOR_PCT));
  check('an empty pool pays nothing', xpShare(0, 3) === 0 && xpShare(-5, 3) === 0);
}

// =============================================================================
console.log('=== the split lands on real characters (GameState.awardXPPool) ===');
{
  const landed = {};
  for (const n of SIZES) {
    const party = makeParty().slice(0, n);
    // makeParty has five hunters; a sixth is a copy so size 6 is measured too.
    while (party.length < n) party.push(makeParty()[0]);
    party.forEach(c => { c.level = 1; c.experience = 0; });
    GameState.party = party;
    GameState.awardXPPool(20);
    landed[n] = party.map(c => c.experience);
  }
  golden.xpLanded20 = landed;
  const ok = SIZES.every(n => landed[n].length === n && landed[n].every(x => x === xpShare(20, n)));
  check('each hunter received exactly xpShare(20, partySize)', ok, JSON.stringify(landed));

  const party = makeParty().slice(0, 3);
  party.forEach(c => { c.level = 1; c.experience = 0; });
  party[2].status = 'dead';
  GameState.party = party;
  GameState.awardXPPool(20);
  check('the split counts the whole party; a dead hunter is not paid',
    party[0].experience === xpShare(20, 3) && party[2].experience === 0,
    party.map(c => c.experience).join('/'));
}

// =============================================================================
console.log('=== hunt XP routes through the split ===');
{
  const party = makeParty().slice(0, 4);
  party.forEach(c => { c.level = 1; c.experience = 0; });
  GameState.party = party;
  GAME_WORLD.awardXP(20);
  check('the hunt world (event XP) pays the split share',
    party.every(c => c.experience === xpShare(20, 4)), party.map(c => c.experience).join('/'));
}
{
  // A won hunt fight, through the real victory path.
  const host = createCombatHost(CombatScene);
  const party = makeParty().slice(0, 4);
  party.forEach(c => { c.level = 1; c.experience = 0; });
  host.isHunt = true;
  host.__begin({ party, scenarioId: 'hunt_beast_solo' });
  const xp = host._calculateXPReward();
  for (const e of host.enemies) { e.currentHP = 0; e.status = 'incapacitated'; }
  try { host._onCombatVictory(); } catch { /* post-victory UI is not in the stub; XP is paid before it */ }
  golden.huntFight = { pool: xp, partySize: 4, each: party.map(c => c.experience) };
  check('a won hunt fight pays each hunter the split share of its XP',
    party.every(c => c.experience === xpShare(xp, 4)), `pool ${xp} -> ${party.map(c => c.experience).join('/')}`);
}

// =============================================================================
console.log('=== hunt fight gear rolls at the item level it is handed ===');
{
  const levels = {};
  for (const il of [undefined, 1, 7, 10]) {
    const host = createCombatHost(CombatScene);
    host.isHunt = true;
    host.huntContext = il === undefined ? null : { type: 'cultist', itemLevel: il };
    host.__begin({ party: makeParty(), scenarioId: 'hunt_cultist_solo' });
    const chest = host.enemies.find(e => e.equipment?.chest)?.equipment.chest;
    levels[String(il)] = chest?.itemLevel ?? null;
  }
  golden.huntGearItemLevel = levels;
  check('handed 1 / 7 / 10, the cultist\'s chest rolls at 1 / 7 / 10',
    levels['1'] === 1 && levels['7'] === 7 && levels['10'] === 10, JSON.stringify(levels));
  check('with no hunt context it falls back to the scenario\'s own item level (1)', levels['undefined'] === 1);
}

// =============================================================================
console.log('=== level cap and curve ===');
{
  const curve = {};
  let cum = 0;
  for (let l = 1; l <= LEVEL_CAP; l++) { curve[l] = getXPNeededForLevel(l); if (l < LEVEL_CAP) cum += curve[l]; }
  golden.levelCap = LEVEL_CAP;
  golden.xpToNext = curve;
  golden.xpTotalTo10 = cum;
  console.log('    to next: ' + JSON.stringify(curve) + `   total 1->${LEVEL_CAP}: ${cum}`);
  check('LEVEL_CAP is 10', LEVEL_CAP === 10);
  check('levels 1-5 cost what they did in the demo (100/150/200/250)',
    [1, 2, 3, 4].every(l => curve[l] === 100 + (l - 1) * 50));

  const [c] = makeParty();
  c.level = 1; c.experience = 0;
  GameState.awardXPTo([c], 100000);
  check('enough XP takes a level-1 hunter to 10 and no further', c.level === 10, `level ${c.level}`);
  GameState.awardXPTo([c], 50);
  check('at the cap, the next award pins the bar full and no level is gained',
    c.level === 10 && c.experience === getXPNeededForLevel(10), `${c.experience}/${getXPNeededForLevel(10)}`);

  // Training stops at TRAINING_LEVEL_CAP; hunts carry on past it.
  const t = {};
  const [a] = makeParty(); a.level = 1; a.experience = 0;
  GameState.awardTrainingXPTo([a], 100000);
  t.fromLevel1 = { level: a.level, experience: a.experience };
  const [b] = makeParty(); b.level = 4; b.experience = 200;
  GameState.awardTrainingXPTo([b], 100);
  t.level4Plus100 = { level: b.level, experience: b.experience };
  const [h] = makeParty(); h.level = 5; h.experience = 120;
  GameState.awardTrainingXPTo([h], 95);
  t.level5WithHuntXP = { level: h.level, experience: h.experience };
  GameState.awardXPPool(200, [h]);
  t.thenHuntPool200 = { level: h.level, experience: h.experience };
  golden.trainingCap = { cap: TRAINING_LEVEL_CAP, ...t };
  console.log('    training cap ' + JSON.stringify(golden.trainingCap));
  check('TRAINING_LEVEL_CAP is 5', TRAINING_LEVEL_CAP === 5);
  check('any amount of training XP stops at level 5 with no overflow banked',
    a.level === 5 && a.experience === 0);
  check('the level-4 -> 5 award is trimmed to what reaches 5', b.level === 5 && b.experience === 0);
  check('a level-5 hunter earns nothing from training, and keeps their hunt XP',
    t.level5WithHuntXP.level === 5 && t.level5WithHuntXP.experience === 120);
  check('...and hunt XP still takes them past 5', t.thenHuntPool200.level === 6);

  // A real pit victory, through CombatScene's own training branch.
  const host = createCombatHost(CombatScene);
  const party = makeParty().slice(0, 2);
  party[0].level = 4; party[0].experience = 240;   // 10 short of level 5
  party[1].level = 5; party[1].experience = 0;
  host.isTraining = true;
  host.__begin({ party, scenarioId: 'training_encounter_6_reckoning_3' });
  for (const e of host.enemies) { e.currentHP = 0; e.status = 'incapacitated'; }
  try { host._onCombatVictory(); } catch { /* post-victory UI is not in the stub */ }
  golden.trainingVictory = party.map(c => ({ level: c.level, experience: c.experience }));
  check('a won Reckoning tier stops a hunter at 5 and pays a level-5 hunter nothing',
    party[0].level === 5 && party[0].experience === 0 && party[1].level === 5 && party[1].experience === 0,
    JSON.stringify(golden.trainingVictory));

  // A save from the level-5 build pins a capped hunter at getXPNeededForLevel(5).
  // Measured, not assumed: what that hunter does on the next XP they earn.
  const [p] = makeParty();
  p.level = 5; p.experience = getXPNeededForLevel(5);
  GameState.awardXPTo([p], 5);
  golden.pinnedLevel5After5xp = { level: p.level, experience: p.experience };
  console.log(`    a hunter pinned at the old cap (5, ${getXPNeededForLevel(5)} XP) given 5 XP -> level ${p.level}, ${p.experience} XP`);
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
  check('scaling tables identical to the golden', changed.length === 0,
    changed.length ? `changed: ${changed.join(', ')}` : `${keys.size} tables`);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
