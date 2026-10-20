// tools/headless/packplan.mjs
//
// The Pack step (chunk 15f; src/systems/PackPlan.js): what can be packed, in
// which group, whose it is on a co-op hunt, and that packing takes each unit
// out of the camp bag exactly once. Real items, real stacks.
//
// Run: node tools/headless/packplan.mjs

import { installPhaserStub } from './phaserStub.js';
installPhaserStub(1516);

const P = await import('../../src/systems/PackPlan.js');
const { makeStack, countInList, stackQty } = await import('../../src/systems/ItemStacks.js');
const { createItemInstance } = await import('../../src/systems/ItemFactory.js');
const { Items } = await import('../../data/items.js');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};
const units = (bag) => bag.reduce((t, it) => t + stackQty(it), 0);

console.log('=== what can be packed, and whose it is ===');
{
  const want = {
    escape_rope: ['ways', P.PARTY], smoke_pot: ['ways', P.OWN],
    healing_draught: ['potions', P.OWN], tincture_red_breath: ['potions', P.OWN],
    sever_head: ['chants', P.OWN], identify_weapon_tonic: ['chants', P.OWN],
    raw_fish: ['food', P.PARTY], bitterroot: ['food', P.PARTY],
    crude_dagger: ['gear', P.OWN],
  };
  const wrong = Object.entries(want).filter(([id, [g, k]]) => P.groupOf(id) !== g || P.kindOf(id) !== k)
    .map(([id]) => `${id}: ${P.groupOf(id)}/${P.kindOf(id)}`);
  check('each item lands in its group and kind (owner: party items shared, fight items your own)', wrong.length === 0, wrong.join(', '));
  check('Rations are a party item, counted on their own row', P.kindOf('rations') === P.PARTY && P.groupOf('rations') === null);
  const never = ['prof_token_str', 'tabula_rasa', 'tonic_of_reflection', 'hunt_plan', 'part_crocodile_head', 'part_crocodile_weaponMain', 'waystone_shard'];
  check('town-only items, plans, parts and relics are never offered', never.every(id => P.groupOf(id) === null), never.filter(id => P.groupOf(id) !== null).join(', '));
  const all = Object.keys(Items).filter(id => P.groupOf(id));
  check(`every packable item has a kind (${all.length} items)`, all.every(id => P.kindOf(id) === P.PARTY || P.kindOf(id) === P.OWN));
}

console.log('=== the rows, and the counts ===');
{
  const dagger = createItemInstance('crude_dagger');
  const bag = [makeStack('rations', 40), makeStack('healing_draught', 2), makeStack('healing_draught', 1), makeStack('raw_fish', 3),
    dagger, createItemInstance('prof_token_str'), makeStack('escape_rope', 1)];
  const rows = P.packRows(bag);
  const by = Object.fromEntries(rows.map(r => [r.key, r]));
  check('one row per stackable id, its stacks counted together', by.healing_draught?.have === 3 && rows.filter(r => r.id === 'healing_draught').length === 1);
  check('the Ways out are always listed, even with none in camp', by.smoke_pot?.have === 0 && by.escape_rope?.have === 1);
  check('gear is a row per piece', by[dagger.instanceId]?.stack === false);
  check('no row for Rations (their own counter) or a token', !by.rations && !rows.some(r => r.id === 'prof_token_str'));
  check('rows come in group order: ways, potions, chants, food, gear',
    rows.map(r => r.group).join(',') === 'ways,ways,potions,food,gear', rows.map(r => r.group).join(','));

  let plan = P.emptyPlan();
  plan = P.adjust(plan, by.healing_draught, +1);
  plan = P.adjust(plan, by.healing_draught, +5);
  check('a count never goes past what is in camp', plan.items.healing_draught === 3);
  plan = P.adjust(plan, by.healing_draught, -1);
  plan = P.adjust(plan, by[dagger.instanceId], +1);
  plan = P.adjust(plan, by.raw_fish, +2);
  plan = P.adjust(plan, by.escape_rope, +1);
  plan.rations = 30;
  check('gear toggles in', plan.gear.includes(dagger.instanceId));
  check('nothing for the Smoke Pot with none in camp', !P.adjust(plan, by.smoke_pot, +1).items.smoke_pot);

  const remind = P.reminders(bag, P.emptyPlan());
  check('reminders: an Escape Rope left in camp, no draughts, no Rations', remind.length === 3
    && remind.some(l => l.startsWith('No Escape Rope packed')) && remind.some(l => l.startsWith('No draughts')) && remind.some(l => l.startsWith('No Rations')), remind.join(' | '));
  check('...and none once they are packed', P.reminders(bag, plan).length === 0, P.reminders(bag, plan).join(' | '));
  check('the plan reads back', P.describePlan(bag, plan).join(', ') === '30 × Rations, 1 × Escape Rope, 2 × Healing Draught, 2 × Raw Fish, Crude Dagger',
    P.describePlan(bag, plan).join(', '));

  const before = units(bag);
  const took = P.takePlan(bag, plan);
  const taken = units([took.rations, ...took.party, ...took.own].filter(Boolean));
  check('taking it moves every unit out of the camp bag exactly once', units(bag) + taken === before && taken === 30 + 1 + 2 + 2 + 1, `${before} = ${units(bag)} + ${taken}`);
  const partyLine = took.party.map(i => `${i.id}x${stackQty(i)}`).sort().join(' ');
  check('...party items to the shared side: the rope and the fish', partyLine === 'escape_ropex1 raw_fishx2', partyLine);
  check('...fight items and gear to the player\'s own', took.own.map(i => i.id).sort().join(' ') === 'crude_dagger healing_draught'
    && stackQty(took.own.find(i => i.id === 'healing_draught')) === 2);
  check('...the Rations as one stack', took.rations?.id === 'rations' && stackQty(took.rations) === 30);
  check('what was not packed stays in camp', countInList(bag, 'rations') === 10 && countInList(bag, 'healing_draught') === 1
    && countInList(bag, 'raw_fish') === 1 && bag.some(i => i.id === 'prof_token_str'));
}

console.log('=== a plan from last time, against a different bag ===');
{
  const last = P.rememberPlan({ rations: 60, items: { healing_draught: 4, smoke_pot: 2, nothing_like_this: 3 }, gear: ['gone'] });
  check('only counts are remembered (gear is not)', !('gear' in last) && last.items.healing_draught === 4);
  const bag = [makeStack('rations', 25), makeStack('healing_draught', 1)];
  const p = P.clampPlan(bag, last, 60);
  check('clamped to what this bag holds: 25 Rations, 1 draught, no pots, no unknown items',
    p.rations === 25 && p.items.healing_draught === 1 && !p.items.smoke_pot && !p.items.nothing_like_this && p.gear.length === 0, JSON.stringify(p));
  check('...and by the Rations cap', P.clampPlan([makeStack('rations', 200)], last, 40).rations === 40);
}

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
