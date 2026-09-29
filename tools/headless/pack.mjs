// tools/headless/pack.mjs
//
// Item stacking, Rations and the hunt pack (IMPLEMENTATION_PLAN, chunk 3).
// Drives the REAL ItemStacks functions, InventorySystem, GameState save/load
// and HuntManager; nothing here re-implements a rule to check it.
//
// What it proves:
//   - stacks merge only when they may (stackable base, no affixes, same id and
//     rarity), split exactly, and never create or destroy a unit — including
//     over thousands of random operations
//   - the pack's outcome for a clean exit and for a wipe under each death rule
//     (Sheltered / Watched / Forsaken), measured through finish() and, for the
//     game's own path, through the camp bag
//   - Rations left = min(packed, supplies left) at every step of real hunts
//   - a pack survives a save and reload
//
// USAGE
//   node tools/headless/pack.mjs

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- a throwaway localStorage, installed before GameState loads ------------
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

const GameState = (await import('../../src/systems/GameState.js')).default;
const ProgressionManager = (await import('../../src/systems/ProgressionManager.js')).default;
const { InventorySystem } = await import('../../src/systems/InventorySystem.js');
const { createItemInstance } = await import('../../src/systems/ItemFactory.js');
const S = await import('../../src/systems/ItemStacks.js');
const { HuntManager, createHunt, CAMP_ISSUE, DEATH_RULES, zoneDeathRule } = await import('../../src/systems/HuntManager.js');
const { makeRng } = await import('../../src/systems/seededRng.js');
const { Items } = await import('../../data/items.js');
const { ZONES } = await import('../../data/zones.js');
const { makeParty } = await import('./fixtures.js');

const ZONE = Object.keys(ZONES)[0];
const units = (list, id = 'rations') => S.countInList(list, id);
const silently = (fn) => { const w = console.log; console.log = () => {}; try { return fn(); } finally { console.log = w; } };

function recordingWorld() {
  const banked = [];
  return {
    banked,
    nightFalls() {}, dayBreaks() {}, awardHuntPoints() {}, awardXP() {},
    party: () => [],
    bankItems: (items, { found }) => items.forEach(i => banked.push({ found, id: i.id, qty: S.stackQty(i) })),
  };
}

function freshGame() {
  GameState.reset();
  ProgressionManager.reset?.();
  const party = makeParty().slice(0, 3);
  GameState.characters = party;
  GameState.party = party.slice();
}

// =============================================================================
console.log('=== Rations, the item ===');
{
  const r = Items.rations;
  check('rations is a stackable base worth 1 supply each', r?.stackable === true && r.supply === 1, `type ${r?.type}`);
  const inst = S.makeStack('rations', 10);
  check('a fresh Rations stack rolls no affixes', inst.prefixes.length === 0 && inst.suffixes.length === 0 && inst.qty === 10);
}

// =============================================================================
console.log('=== stack merge ===');
{
  const list = [];
  for (let i = 0; i < 3; i++) S.addToList(list, S.makeStack('rations', 10));
  check('three stacks of 10 become one stack of 30', list.length === 1 && list[0].qty === 30);

  const keepId = list[0].instanceId;
  S.addToList(list, S.makeStack('rations', 5));
  check('a merge keeps the existing stack\'s instanceId', list[0].instanceId === keepId && list[0].qty === 35);

  const unc = createItemInstance('rations', { rarity: 'uncommon' });
  S.addToList(list, unc);
  check('a different rarity is its own stack', list.length === 2 && unc.qty === 1);

  const pots = [];
  S.addToList(pots, createItemInstance('healing_potion'));
  S.addToList(pots, createItemInstance('healing_potion'));
  check('a non-stackable base never stacks', pots.length === 2 && pots.every(p => p.qty === undefined));

  const sword = createItemInstance('hardened_sword_1h', { rarity: 'rare' });
  const rolled = S.makeStack('rations', 1);
  rolled.prefixes = ['pretend'];
  check('an instance with affixes is never stackable, even on a stackable base',
    sword.prefixes.length + sword.suffixes.length > 0 && !S.isStackable(sword) && !S.isStackable(rolled));

  const legacy = createItemInstance('rations');
  delete legacy.qty;
  check('an entry with no qty (a save from before stacking) counts as 1', S.stackQty(legacy) === 1 && units([legacy]) === 1);
}

// =============================================================================
console.log('=== stack split and take ===');
{
  const a = S.makeStack('rations', 30);
  const b = S.splitStack(a, 12);
  check('split 30 into 12 + 18', b.qty === 12 && a.qty === 18 && b.instanceId !== a.instanceId);
  check('split refuses 0, the whole stack, more than the stack, and non-integers',
    [0, 18, 19, 2.5, -1].every(n => S.splitStack(a, n) === null) && a.qty === 18);

  // Two stacks kept apart on purpose (pushed, not merged), to take across both.
  const list = [S.makeStack('rations', 7), S.makeStack('rations', 5), createItemInstance('healing_potion')];
  const t = S.takeFromList(list, 'rations', 9);
  check('take 9 from stacks of 7 + 5: one stack of 9, 3 left, the potion untouched',
    t?.qty === 9 && units(list) === 3 && list.some(i => i.id === 'healing_potion'), `left ${list.map(i => `${i.id}x${S.stackQty(i)}`).join(', ')}`);

  const before = JSON.stringify(list);
  check('take more than there is: null, and the list is untouched', S.takeFromList(list, 'rations', 4) === null && JSON.stringify(list) === before);

  const exact = [S.makeStack('rations', 6)];
  const whole = S.takeFromList(exact, 'rations', 6);
  check('take the whole stack: moved, not split', whole?.qty === 6 && exact.length === 0);
}

// =============================================================================
console.log('=== stacks never make or lose a unit (random operations) ===');
{
  const rng = makeRng(2026);
  const lists = [[], [], []];
  let expected = 0, ops = 0, ok = true;
  for (let i = 0; i < 5000; i++) {
    const L = lists[Math.floor(rng() * 3)];
    const roll = rng();
    if (roll < 0.4) {
      const n = 1 + Math.floor(rng() * 20);
      S.addToList(L, S.makeStack('rations', n)); expected += n;
    } else if (roll < 0.7) {
      const n = 1 + Math.floor(rng() * 25);
      const t = S.takeFromList(L, 'rations', n);
      if (t) S.addToList(lists[Math.floor(rng() * 3)], t); // moved, not destroyed
    } else if (L.length) {
      const it = L[Math.floor(rng() * L.length)];
      const part = S.splitStack(it, 1 + Math.floor(rng() * Math.max(1, S.stackQty(it) - 1)));
      if (part) L.push(part);
    }
    ops++;
    const total = lists.reduce((n, l) => n + units(l), 0);
    if (total !== expected) { ok = false; break; }
    if (lists.some(l => l.some(it => !Number.isInteger(it.qty) || it.qty < 1))) { ok = false; break; }
  }
  check('5000 random merges, takes and splits across 3 lists: every unit accounted for', ok,
    `${expected} units, ${ops} ops`);
}

// =============================================================================
console.log('=== the camp bag and the stash merge on arrival ===');
{
  freshGame();
  InventorySystem.addGlobalItem(S.makeStack('rations', 10));
  InventorySystem.addGlobalItem(S.makeStack('rations', 10));
  GameState.addToInventory(S.makeStack('rations', 5));
  check('addGlobalItem and addToInventory merge Rations into one bag entry',
    GameState.inventory.length === 1 && units(GameState.inventory) === 25);
  check('...and a merged stack still shows as new', GameState.inventory[0]._isNew === true);

  GameState.addToStash('t', S.makeStack('rations', 4));
  GameState.addToStash('t', S.makeStack('rations', 6));
  check('addToStash merges too', GameState.getStash('t').length === 1 && units(GameState.getStash('t')) === 10);

  GameState.save('stk');
  GameState.inventory = [];
  GameState.load('stk');
  check('a stack survives save and load with its qty', GameState.inventory.length === 1 && units(GameState.inventory) === 25);
}

// =============================================================================
console.log('=== pack outcome: exit vs each wipe rule, measured ===');
const measured = [];
{
  check('every zone declares a valid death rule',
    Object.values(ZONES).every(z => DEATH_RULES.includes(z.deathRule)),
    Object.values(ZONES).map(z => `${z.id}=${z.deathRule}`).join(', '));

  const original = ZONES[ZONE].deathRule;
  const PACKED = 40, STEPS = 8;
  let tableOk = true;
  for (const rule of DEATH_RULES) {
    for (const ending of ['exit', 'wipe']) {
      ZONES[ZONE].deathRule = rule;
      const world = recordingWorld();
      const potion = createItemInstance('healing_potion');
      const hunt = createHunt(ZONE, { supplies: CAMP_ISSUE + PACKED, seed: 9, bring: [S.makeStack('rations', PACKED), potion] }, world);
      for (let i = 0; i < STEPS; i++) { hunt.advance(); if (hunt.hasPendingEncounter()) { hunt.engagePending(); hunt.resolveCombatEncounter({ won: true, type: 'beast' }); } }
      hunt.addFound(createItemInstance('hardened_dagger', { rarity: 'rare' }));
      hunt.addFound(S.makeStack('rations', 3));
      hunt.addFound(S.makeStack('rations', 2));
      const supplies = hunt.getState().supplies;
      const out = hunt.finish(ending);
      const again = hunt.finish(ending);

      const homeB = world.banked.filter(b => !b.found);
      const homeF = world.banked.filter(b => b.found);
      const left = Math.min(PACKED, Math.floor(supplies));
      const keeps = ending === 'exit' || rule === 'sheltered';
      const row = {
        rule, ending, supplies: Math.round(supplies * 10) / 10,
        broughtHome: homeB.map(b => `${b.id}x${b.qty}`).join(' + ') || '-',
        foundHome: homeF.map(b => `${b.id}x${b.qty}`).join(' + ') || '-',
        lost: [...out.lost.brought, ...out.lost.found].map(i => `${i.id}x${S.stackQty(i)}`).join(' + ') || '-',
      };
      measured.push(row);
      const ok = keeps
        ? same(homeB, [{ found: false, id: 'rations', qty: left }, { found: false, id: 'healing_potion', qty: 1 }])
          && same(homeF, [{ found: true, id: 'hardened_dagger', qty: 1 }, { found: true, id: 'rations', qty: 5 }])
          && out.lost.brought.length + out.lost.found.length === 0
        : world.banked.length === 0 && out.lost.brought.length === 2 && out.lost.found.length === 2;
      if (!ok || again !== null || world.banked.length !== (keeps ? 4 : 0)) tableOk = false;
    }
  }
  ZONES[ZONE].deathRule = original;
  check('exit and Sheltered wipe bring the pack home; Watched and Forsaken wipes lose all of it', tableOk, `${measured.length} cases`);
  console.log('');
  console.log('    rule       ending  supplies  brought home                 found home                  lost');
  for (const r of measured) {
    console.log(`    ${r.rule.padEnd(10)} ${r.ending.padEnd(7)} ${String(r.supplies).padEnd(9)} ${r.broughtHome.padEnd(28)} ${r.foundHome.padEnd(27)} ${r.lost}`);
  }
  console.log('');
  check('found Rations merged in the pack (3 + 2 = one stack of 5)', measured[0].foundHome.includes('rationsx5'));
  check('finish() only settles once (a second call is null, nothing banked twice)', tableOk);
}

// =============================================================================
console.log('=== Rations left = min(packed, supplies left), every step of real hunts ===');
// Bounds, not a re-derivation of the formula: a whole number of Rations, never
// more than is really left, never a full ration short, never rising. (Supplies
// drift in floating point — 90.9999999999999 is 91 — which is why a plain
// floor() here would be the wrong answer key.)
{
  let steps = 0, ok = true, sawPartial = false, sawZero = false;
  for (const zoneId of Object.keys(ZONES)) {
    for (const seed of [1, 2, 3, 4]) {
      for (const packed of [0, 10, 40, 100]) {
        const hunt = createHunt(zoneId, { supplies: CAMP_ISSUE + packed, seed, bring: packed ? [S.makeStack('rations', packed)] : [] }, recordingWorld());
        let prev = packed;
        for (let i = 0; i < 400; i++) {
          const st = hunt.getState();
          const p = st.pendingEncounter;
          if (p?.kind === 'encounter') { hunt.engagePending(); hunt.resolveCombatEncounter({ won: true, type: p.type }); }
          else if (st.supplies <= 0) break;
          else hunt.advance();
          const now = hunt.getState();
          const left = now.pack.rationsLeft;
          const real = Math.min(packed, now.supplies);
          if (!Number.isInteger(left) || left < 0 || left > real + 1e-6 || left <= real - 1 || left > prev) ok = false;
          prev = left;
          if (packed && left > 0 && left < packed) sawPartial = true;
          steps++;
        }
        const end = hunt.getState();
        if (packed && end.supplies <= 0 && end.pack.rationsLeft === 0) sawZero = true;
      }
    }
  }
  check('rationsLeft is min(packed, supplies left) to the whole ration, at every step', ok, `${steps} steps, 2 zones x 4 seeds x 4 pack sizes`);
  check('...seen partly eaten, and fully eaten when supplies ran out', sawPartial && sawZero);
}

// =============================================================================
console.log('=== the game\'s own path: bag -> pack -> bag ===');
{
  // What the Hunt screen does: take from the bag, start with them, then exit.
  freshGame();
  InventorySystem.addGlobalItem(S.makeStack('rations', 50));
  const taken = S.takeFromList(GameState.inventory, 'rations', 40);
  HuntManager.start(ZONE, { supplies: CAMP_ISSUE + 40, seed: 3, bring: [taken] });
  check('packing takes them out of the bag', units(GameState.inventory) === 10);
  for (let i = 0; i < 20 && !HuntManager.hasPendingEncounter(); i++) HuntManager.advance();
  const left = HuntManager.getState().pack.rationsLeft;

  GameState.save('pk');
  GameState.load('pk');
  check('the pack survives a save and reload', HuntManager.getState().pack.rationsLeft === left
    && HuntManager.getState().pack.brought[0]?.qty === 40, `${left} of 40 left`);

  GameState.inventory.forEach(i => { i._isNew = false; }); // the player has looked at their bag
  const out = HuntManager.exit();
  check('a clean exit banks what is left into the bag, as one stack', GameState.inventory.filter(i => i.id === 'rations').length === 1
    && units(GameState.inventory) === 10 + left && out.rationsLeft === left, `bag ${units(GameState.inventory)}`);
  check('...and the hunt is over', !HuntManager.isActive());
  check('...and Rations coming home are not flagged as a new find', GameState.inventory[0]._isNew === false);

  // A wipe in a Watched region, through the same holder the defeat path calls.
  freshGame();
  const original = ZONES[ZONE].deathRule;
  ZONES[ZONE].deathRule = 'watched';
  InventorySystem.addGlobalItem(S.makeStack('rations', 50));
  HuntManager.start(ZONE, { supplies: CAMP_ISSUE + 40, seed: 3, bring: [S.takeFromList(GameState.inventory, 'rations', 40)] });
  ZONES[ZONE].deathRule = original; // read once at departure: changing it now must not matter
  HuntManager.addFound(createItemInstance('hardened_dagger', { rarity: 'rare' }));
  const wiped = silently(() => HuntManager.wipe());
  check('a Watched wipe loses the pack; the bag keeps only what stayed home',
    units(GameState.inventory) === 10 && GameState.inventory.length === 1 && wiped.keeps === false);
  check('...the rule was read at departure, not at the wipe', wiped.deathRule === 'watched');

  freshGame();
  InventorySystem.addGlobalItem(S.makeStack('rations', 50));
  HuntManager.start(ZONE, { supplies: CAMP_ISSUE + 40, seed: 3, bring: [S.takeFromList(GameState.inventory, 'rations', 40)] });
  const sheltered = HuntManager.wipe();
  check(`a wipe in ${ZONE} (${zoneDeathRule(ZONES[ZONE])}) brings the pack home`,
    units(GameState.inventory) === 10 + sheltered.rationsLeft && sheltered.keeps === true, `${sheltered.rationsLeft} of 40`);

  // end() is for the main menu: nothing settles, the save still holds the hunt.
  freshGame();
  InventorySystem.addGlobalItem(S.makeStack('rations', 50));
  HuntManager.start(ZONE, { supplies: CAMP_ISSUE + 40, seed: 3, bring: [S.takeFromList(GameState.inventory, 'rations', 40)] });
  GameState.save('menu');
  HuntManager.end();
  check('end() settles nothing (bag still 10)', units(GameState.inventory) === 10);
  GameState.load('menu');
  check('...and a reload resumes the hunt with its pack', HuntManager.isActive() && HuntManager.getState().pack.brought[0]?.qty === 40);
}

console.log('=== consumables stack (owner\'s playtest 2026-09-29) ===');
{
  freshGame();
  const combatItems = Object.values(Items).filter(it => it.combatUse);
  check('every combat item (chants, tonics, draughts) is stackable', combatItems.length > 0 && combatItems.every(it => it.stackable),
    combatItems.filter(it => !it.stackable).map(it => it.id).join());
  for (let i = 0; i < 3; i++) InventorySystem.addGlobalItem('sever_head');
  InventorySystem.addGlobalItem('sever_chest');
  const heads = GameState.inventory.filter(it => it.id === 'sever_head');
  check('three Severing Chants: Head are one entry of 3', heads.length === 1 && S.stackQty(heads[0]) === 3);
  InventorySystem.spendOneGlobal(heads[0]);
  check('using one in combat leaves 2 in the stack', units(GameState.inventory, 'sever_head') === 2
    && GameState.inventory.filter(it => it.id === 'sever_head').length === 1);
  const chest = GameState.inventory.find(it => it.id === 'sever_chest');
  InventorySystem.spendOneGlobal(chest);
  check('using the last one removes the entry', !GameState.inventory.some(it => it.id === 'sever_chest'));

  // A save from before: one entry per chant, as the old game kept them.
  freshGame();
  for (let i = 0; i < 4; i++) { const inst = createItemInstance('sever_ring'); GameState.inventory.push(inst); }
  GameState.inventory.push(createItemInstance('healing_draught'), createItemInstance('healing_draught'));
  GameState.tribeStash = { styx: [createItemInstance('identify_armor_tonic'), createItemInstance('identify_armor_tonic')] };
  GameState.save('stacks');
  GameState.load('stacks');
  check('loading an old save folds loose chants into one stack', GameState.inventory.filter(it => it.id === 'sever_ring').length === 1
    && units(GameState.inventory, 'sever_ring') === 4 && units(GameState.inventory, 'healing_draught') === 2);
  check('...and the stash too', GameState.tribeStash.styx.length === 1 && units(GameState.tribeStash.styx, 'identify_armor_tonic') === 2);
}

console.log('=== the Bone Pile buys beast parts (batch 4b chunk 6) ===');
{
  const { partOffer, sellPart, sellAllParts } = await import('../../src/systems/PartsBuyer.js');
  const part = (id, rarity, n, grade = 'grown') => S.partMaterial({ id, rarity, grade }, n);
  const pm = { huntTickets: 0 };
  const commons = part('part_crocodile_weaponMain', 'common', 23);
  const o = partOffer(commons);
  check('23 Common parts: 20 sell for 2 tickets, in bundles of 10', o.bundle === 10 && o.sellable === 20 && o.tickets === 2, JSON.stringify(o));
  const bag = [commons];
  check('...selling pays 2 and leaves 3 in the bag', sellPart(bag, commons, pm) === 2 && pm.huntTickets === 2 && bag.length === 1 && S.stackQty(commons) === 3);
  check('...3 left are worth nothing yet, and stay', partOffer(commons).tickets === 0 && sellPart(bag, commons, pm) === 0 && bag.length === 1);
  check('5 Uncommon: 4 sell for 1 ticket', partOffer(part('part_crocodile_head', 'uncommon', 5)).tickets === 1);
  check('2 Rare: 2 tickets', partOffer(part('part_crocodile_head', 'rare', 2)).tickets === 2);
  check('1 Epic from an apex-grade beast: 6 tickets (3, doubled)', partOffer(part('part_crocodile_head', 'epic', 1, 'great')).tickets === 6);
  check("1 Rare Mourning Beast part: 3 tickets (a boss's, tripled)", partOffer(part('part_mourning_beast_head', 'rare', 1, 'great')).tickets === 3);
  const bag2 = [part('part_crocodile_head', 'rare', 2), part('part_crocodile_weaponMain', 'common', 12), createItemInstance('sever_head')];
  const pm2 = { huntTickets: 5 };
  const all = sellAllParts(bag2, pm2);
  check('Sell all: every part that pays, nothing else', all.tickets === 3 && pm2.huntTickets === 8 && bag2.length === 2
    && bag2.some(i => i.id === 'sever_head') && S.stackQty(bag2.find(i => i.id === 'part_crocodile_weaponMain')) === 2, JSON.stringify(all));
}

console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
