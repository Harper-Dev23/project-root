// tools/headless/huntstart.mjs
//
// A run led by hunts after Trial 1 (owner 2026-09-29):
//   - the Bone Pile opens after Trial 2 OR the first hunt;
//   - Samuel Mourne comes after Trial 4 OR the first hunt, once only, and his
//     marker is not claimed by The Long Road before Trial 4;
//   - region quest steps pay Hunt Tickets once (src/systems/QuestRewards.js),
//     through a save round trip.
// "The first hunt" is the engine's `hunted:<zone>` flag: a clean exit with the
// main objective done.
//
// Run: node tools/headless/huntstart.mjs

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

const PM = (await import('../../src/systems/ProgressionManager.js')).default;
const { QUEST_LINES, getStepState, getStepForFlag } = await import('../../src/data/quests.js');
const { claimQuestRewards, questRewardMessage } = await import('../../src/systems/QuestRewards.js');

const REEDS_DONE = 'hunted:reeds_of_gethsemane';
const clear = (ids) => ids.forEach(id => PM.onScenarioComplete(id));
const step = (id) => QUEST_LINES.flatMap(q => q.steps).find(s => s.id === id);

console.log('=== the Bone Pile: Trial 2 or the first hunt ===');
PM.reset();
check('a new save: locked', !PM.isFeatureUnlocked('bonepile'));
clear(['training_encounter_1']);
check('Trial 1 alone: still locked', !PM.isFeatureUnlocked('bonepile'));
PM.setQuestFlag('apex_slain:reeds_of_gethsemane');
check('an apex kill is not a finished hunt: still locked', !PM.isFeatureUnlocked('bonepile'));
PM.setQuestFlag(REEDS_DONE);
check('the first hunt: open', PM.isFeatureUnlocked('bonepile'));
PM.reset();
clear(['training_encounter_1', 'training_encounter_2']);
check('Trial 2, no hunt: open', PM.isFeatureUnlocked('bonepile'));

console.log('');
console.log('=== Samuel Mourne by the hunt ===');
PM.reset();
clear(['training_encounter_1']);
PM.tribe = 'styx';
check('no hunt yet: not offered', PM.offerSamuelAfterHunt() === false && !PM.hasQuestFlag('samuel_mourne'));
PM.setQuestFlag(REEDS_DONE);
check('the first hunt: offered', PM.offerSamuelAfterHunt() === true && PM.hasQuestFlag('samuel_mourne'));
check('...once', PM.offerSamuelAfterHunt() === false);
check("his marker is The Prophet's Fragment's, not The Long Road's",
  getStepForFlag('samuel_mourne', PM)?.step.id === 'meet_samuel_mourne',
  getStepForFlag('samuel_mourne', PM)?.step.id);
check("The Long Road's Samuel step waits for Trial 4", getStepState(step('lr_samuel'), PM) === 'upcoming');
// Meeting him, as the tent does: the intro flag gives way to the waystone.
PM.clearQuestFlag('samuel_mourne');
PM.setQuestFlag('waystone_visit');
check('after meeting him: not offered again', PM.offerSamuelAfterHunt() === false);
clear(['training_encounter_2', 'training_encounter_3', 'training_encounter_4']);
check('Trial 4 after meeting him: no second introduction', !PM.hasQuestFlag('samuel_mourne'));
check('...but the rest of Trial 4 still lands', PM.hasQuestFlag('styx_leader_challenge') && PM.hasQuestFlag('lesse_leader_brief'));
check("The Long Road's Samuel step reads done", getStepState(step('lr_samuel'), PM) === 'completed');
// A finished chain leaves only waystone_attuned and the shard behind.
PM.reset();
PM.questFlags = [REEDS_DONE, 'waystone_attuned', 'waystone_shard_collected'];
check('a finished waystone chain: not offered', PM.offerSamuelAfterHunt() === false);

console.log('');
console.log('=== Samuel Mourne by the pit (unchanged) ===');
PM.reset();
clear(['training_encounter_1', 'training_encounter_2', 'training_encounter_3', 'training_encounter_4']);
check('Trial 4 with no hunt: Samuel is waiting', PM.hasQuestFlag('samuel_mourne'));
check("...and The Long Road's step is active", getStepState(step('lr_samuel'), PM) === 'active');
PM.setQuestFlag(REEDS_DONE);
check('a hunt afterwards does not offer him twice', PM.offerSamuelAfterHunt() === false);

console.log('');
console.log('=== when the cults are introduced (batch 4b chunk 3) ===');
{
  const { getQuestState } = await import('../../src/data/quests.js');
  const choir = QUEST_LINES.find(q => q.id === 'hymn_beneath_the_water');
  const temple = QUEST_LINES.find(q => q.id === 'offered_breath');
  PM.reset();
  PM.tribe = 'styx';
  PM.setQuestFlag(REEDS_DONE);
  check('a first hunt: neither cult line', getQuestState(choir, PM) === 'locked' && getQuestState(temple, PM) === 'locked');
  PM.setQuestFlag('cult_slain:yargaleth');
  check('a Drowned Choir band fought: the Choir line alone opens', getStepState(step('hb_singing'), PM) === 'active'
    && getQuestState(temple, PM) === 'locked');
  // The Vowback now follows the Pools and the Signs (owner 2026-10-03).
  ['mb_weeping_heard', 'mb_signs_found', 'vowback_slain'].forEach(f => PM.setQuestFlag(f));
  PM.completedQuestSteps = ['wr_hunt', 'wr_cull', 'wr_apexpool', 'wr_pools', 'wr_signs'];
  check('the Vowback slain but not reported: the Temple still waits', getQuestState(temple, PM) === 'locked');
  claimQuestRewards(PM);
  check('the Vowback reported: both lines, side by side', getStepState(step('ob_offerings'), PM) === 'active'
    && getStepState(step('hb_singing'), PM) === 'active');
  PM.reset();
  PM.tribe = 'styx';
  PM.questFlags = [REEDS_DONE, 'gill_offerings_read'];
  check('a save already in a line keeps it', getQuestState(temple, PM) !== 'locked' && getStepState(step('ob_offerings'), PM) === 'report');
}

console.log('');
console.log("=== the Elder's Bone Pile talk: Trial 2 or the first hunt ===");
PM.reset();
clear(['training_encounter_1']);
PM.tribe = 'styx';
check('no hunt yet: not raised', PM.offerBonepileAfterHunt() === false && !PM.hasQuestFlag('elder_bonepile'));
PM.setQuestFlag(REEDS_DONE);
check('the first hunt: raised', PM.offerBonepileAfterHunt() === true && PM.hasQuestFlag('elder_bonepile'));
check('...its marker is The Long Road\'s step', getStepForFlag('elder_bonepile', PM)?.step.id === 'lr_elder_bonepile');
check('...once', PM.offerBonepileAfterHunt() === false);
// The tower, as TownScene does it.
PM.clearQuestFlag('elder_bonepile');
PM.setQuestFlag('bonepile_explained');
check('after he speaks: not raised again', PM.offerBonepileAfterHunt() === false);
check('...and the step reads done', getStepState(step('lr_elder_bonepile'), PM) === 'completed');
clear(['training_encounter_2']);
check('Trial 2 afterwards: no second talk', !PM.hasQuestFlag('elder_bonepile'));
check('...but the rest of Trial 2 still lands', PM.hasQuestFlag('elseth_leader_brief'));
PM.reset();
clear(['training_encounter_1', 'training_encounter_2']);
PM.tribe = 'styx';
check('by the pit (unchanged): Trial 2 raises it', PM.hasQuestFlag('elder_bonepile'));
PM.setQuestFlag(REEDS_DONE);
PM.clearQuestFlag('elder_bonepile');
check('a hunt after Trial 2 does not raise it', PM.offerBonepileAfterHunt() === false);

console.log('');
console.log('=== The Unconfessed Dead opens on the Vowback ===');
{
  const { getQuestState } = await import('../../src/data/quests.js');
  const ud = QUEST_LINES.find(q => q.id === 'unconfessed_dead');
  PM.reset();
  PM.tribe = 'styx';
  PM.setQuestFlag(REEDS_DONE);
  check('scout hunts alone: not open', getQuestState(ud, PM) === 'locked', getQuestState(ud, PM));
  PM.setQuestFlag('vowback_slain');
  check('the Vowback slain, no apex kill: open, the Drowned Camp to find',
    getQuestState(ud, PM) !== 'locked' && getStepState(step('ud_camp'), PM) === 'active');
  PM.reset();
  PM.tribe = 'styx';
  PM.setQuestFlag('apex_slain:reeds_of_gethsemane');
  // Since the split (owner 2026-10-03) the Reeds' apex comes early, in The
  // Hunter's Trade, so it no longer opens the line; a save already on it stays.
  check('the Reeds\' apex alone does not open it', getQuestState(ud, PM) === 'locked', getQuestState(ud, PM));
  PM.setQuestFlag('gp_soul_found');
  check('a save already on it stays open', getQuestState(ud, PM) !== 'locked');
}

console.log('');
console.log("=== the Elder's Historic talk is about the first one found ===");
{
  const { getQuestState } = await import('../../src/data/quests.js');
  const quest = (id) => QUEST_LINES.find(q => q.id === id);
  PM.reset();
  check('a first inspect of Burden of Dreams asks for the talk', PM.requestHistoricTalk('burden_of_dreams') === true
    && PM.historicTalkPending() && PM.firstHistoricId() === 'burden_of_dreams');
  check("...its marker is the Historic Items line's, not the Bloodthirster's",
    getStepForFlag('historic_elder_visit', PM)?.step.id === 'hi_elder' && !quest('bloodthirster_intro').isAvailable(PM),
    getStepForFlag('historic_elder_visit', PM)?.step.id);
  check('...asked once', PM.requestHistoricTalk('the_unconfessed') === false && PM.firstHistoricId() === 'burden_of_dreams');
  PM.giveHistoricTalk();
  check('the talk given: explained, and the next inspect is the step', PM.historicExplained() && !PM.historicTalkPending()
    && getStepState(step('hi_reinspect'), PM) === 'active');
  check('...no second talk for the next item', PM.requestHistoricTalk('bloodthirster') === false);
  PM.setQuestFlag('bloodthirster_quest');
  check('the Bloodthirster later: its introduction starts at the re-inspect',
    getStepState(step('bt_intro_elder'), PM) === 'completed' && getStepState(step('bt_intro_reinspect'), PM) === 'active');

  PM.reset();
  PM.questFlags = ['bloodthirster_quest', 'bloodthirster_elder_visit'];
  check('a save from before: its Bloodthirster talk is still waiting', PM.historicTalkPending()
    && PM.firstHistoricId() === 'bloodthirster' && getStepForFlag('bloodthirster_elder_visit', PM)?.step.id === 'bt_intro_elder');
  PM.giveHistoricTalk();
  check('...and given, it reads explained', PM.historicExplained() && !PM.hasQuestFlag('bloodthirster_elder_visit'));
  PM.reset();
  PM.questFlags = ['bloodthirster_quest', 'bloodthirster_elder_explained'];
  check('a save that heard it before: explained, nothing pending', PM.historicExplained() && !PM.historicTalkPending()
    && PM.requestHistoricTalk('burden_of_dreams') === false);

  const { Items } = await import('../../data/items.js');
  const { historicMechanicLines } = await import('../../data/historicEffects.js');
  for (const id of ['burden_of_dreams', 'the_unconfessed', 'sunken_nave']) {
    const lines = historicMechanicLines(Items[id].effects, Items[id].grantsSkills);
    check(`${Items[id].name}'s Inspect says what it does, in lines that fit`,
      lines.length > 0 && lines.every(l => l.length <= 56), lines.join(' | '));
  }
}

console.log('');
console.log('=== home is a full heal ===');
{
  const GameState = (await import('../../src/systems/GameState.js')).default;
  const { applyTakeHome } = await import('../../src/systems/CoopRewards.js');
  const hurt = { id: 'a', name: 'A', status: 'alive', currentHP: 5, maxHP: 100, currentMP: 0, maxMP: 40 };
  const down = { id: 'b', name: 'B', status: 'incapacitated', currentHP: 0, maxHP: 80, currentMP: 3, maxMP: 20 };
  const slain = { id: 'c', name: 'C', status: 'dead', currentHP: 0, maxHP: 90, currentMP: 0, maxMP: 20 };
  const oldParty = GameState.party;
  GameState.party = [hurt, down, slain];
  GameState.restorePartyToFull();
  check('solo: the living come home full', hurt.currentHP === 100 && hurt.currentMP === 40 && down.status === 'alive' && down.currentHP === 80);
  check('...the Slain do not', slain.status === 'dead' && slain.currentHP === 0);
  GameState.party = oldParty;
  const h2 = { id: 'd', status: 'alive', currentHP: 7, maxHP: 60, currentMP: 1, maxMP: 30 };
  const world = { nightFalls() {}, dayBreaks() {} };
  applyTakeHome([], { me: 'p', hostId: 'p', myRefs: ['d'], vitals: { d: { hp: 7, mp: 1, status: 'alive' } } },
    { world, hunter: (r) => (r === 'd' ? h2 : null), awardXPTo() {}, moveToSlain() {}, day: () => 1 });
  check('co-op: the take-home heals too', h2.currentHP === 60 && h2.currentMP === 30);
}

console.log('');
console.log('=== the Hunt Gate marker ===');
PM.reset();
clear(['training_encounter_1']);
check('before the tribe choice: no marker', getStepForFlag('hunt_gate', PM) === null);
PM.tribe = 'styx';
check('after it: the marker stands for Hunt the Reeds', getStepForFlag('hunt_gate', PM)?.step.id === 'wr_hunt');
PM.setQuestFlag(REEDS_DONE);
check('the first hunt done: gone', getStepForFlag('hunt_gate', PM) === null);

console.log('');
console.log('=== region quest rewards ===');
const rewarded = QUEST_LINES.flatMap(q => q.steps).filter(s => s.reward);
check('every reward pays tickets and says something',
  rewarded.length > 0 && rewarded.every(s => s.reward.huntTickets > 0 && typeof s.reward.text === 'string' && s.reward.text.length > 0),
  `${rewarded.length} steps, ${rewarded.reduce((n, s) => n + s.reward.huntTickets, 0)} tickets in all`);
PM.reset();
PM.tribe = 'styx';
check('nothing done: nothing paid', claimQuestRewards(PM).length === 0 && PM.huntTickets === 0);
PM.setQuestFlag(REEDS_DONE);
let paid = claimQuestRewards(PM);
// A finished Reeds hunt also opens the Choir and Temple lines, whose first steps are not done yet.
check('Hunt the Reeds pays', paid.length === 1 && paid[0].stepId === 'wr_hunt' && PM.huntTickets === step('wr_hunt').reward.huntTickets,
  JSON.stringify(paid.map(p => [p.stepId, p.huntTickets])));
check('...and the message names it', questRewardMessage(paid).includes(step('wr_hunt').label));
check('...once', claimQuestRewards(PM).length === 0);
const before = PM.huntTickets;
const saved = JSON.parse(JSON.stringify(PM.serialize()));
PM.reset();
PM.deserialize(saved);
check('a save round trip does not pay it again', claimQuestRewards(PM).length === 0 && PM.huntTickets === before);
['hunted_cull:reeds_of_gethsemane', 'hunted_apex:reeds_of_gethsemane', 'mb_weeping_heard', 'choir_heard'].forEach(f => PM.setQuestFlag(f));
paid = claimQuestRewards(PM);
// Both lines move in one visit: The Hunter's Trade, then the Reeds' own line.
const chain = ['wr_cull', 'wr_apexpool', 'wr_pools', 'hb_singing'];
check('steps finished on one hunt: all paid, in quest order',
  paid.map(p => p.stepId).join() === chain.join()
    && PM.huntTickets === before + chain.reduce((n, id) => n + step(id).reward.huntTickets, 0),
  paid.map(p => p.stepId).join());
check('the Combat Pit still pays its own tickets', PM.onScenarioComplete('training_encounter_1').huntTicketsEarned === 12);

console.log('');
console.log('=== reporting to Elder Varek (batch 4b chunk 1) ===');
{
  const { pendingReports, getQuestState } = await import('../../src/data/quests.js');
  const { questSitesFor } = await import('../../src/systems/HuntQuests.js');
  const { offersReady } = await import('../../src/systems/Omens.js');
  const REEDS = 'reeds_of_gethsemane';
  PM.reset();
  PM.tribe = 'styx';
  PM.setQuestFlag(REEDS_DONE);
  check('done in the field: Hunt the Reeds waits to be reported, not paid', getStepState(step('wr_hunt'), PM) === 'report'
    && pendingReports(PM).some(h => h.step.id === 'wr_hunt') && PM.huntTickets === 0);
  check('...and the rest of its line waits on the report', getStepState(step('wr_apex'), PM) === 'upcoming');
  check("...so the next hunt holds no Vowback site yet", !questSitesFor(REEDS, PM).some(s => s.step === 'wr_apex'));
  check('the cult lines are not open after a first hunt (chunk 3)', getStepState(step('hb_singing'), PM) === 'upcoming'
    && getStepState(step('ob_offerings'), PM) === 'upcoming');
  const bag = [];
  const firstPaid = claimQuestRewards(PM, { addItem: (i) => bag.push(i), itemLevel: 2 });
  check('reported: paid, done, and Thin the Reeds is the step', getStepState(step('wr_hunt'), PM) === 'completed'
    && PM.huntTickets === step('wr_hunt').reward.huntTickets && getStepState(step('wr_cull'), PM) === 'active'
    && getStepState(step('wr_apex'), PM) === 'upcoming');
  check('...the Elder hands over a Common Small Cull plan, and says so', bag.length === 1 && bag[0].id === 'plan_cull_small'
    && bag[0].rarity === 'common' && bag[0].itemLevel === 2 && questRewardMessage(firstPaid).includes('Small Cull Warrant'),
    JSON.stringify(bag.map(i => [i.id, i.rarity, i.itemLevel])));
  PM.setQuestFlag('hunted_cull:reeds_of_gethsemane');
  claimQuestRewards(PM, { addItem: (i) => bag.push(i) });
  check("a Cull hunt reported: an Uncommon Small Apex plan, and The Reeds' Apex is the step",
    bag[1]?.id === 'plan_apex_small' && bag[1]?.rarity === 'uncommon' && getStepState(step('wr_apexpool'), PM) === 'active'
    && !questSitesFor(REEDS, PM).some(s => s.step === 'wr_apex'));
  PM.setQuestFlag('apex_slain:reeds_of_gethsemane');
  check('an apex killed on another plan does not count: it takes an Apex plan', getStepState(step('wr_apexpool'), PM) === 'active');
  PM.setQuestFlag('hunted_apex:reeds_of_gethsemane');
  claimQuestRewards(PM);
  check("an Apex hunt reported: The Hunter's Trade is done, and the Reeds' own line is on the Lament Pools",
    getQuestState(QUEST_LINES.find(q => q.id === 'hunters_trade'), PM) === 'completed'
    && getStepState(step('wr_pools'), PM) === 'active' && questSitesFor(REEDS, PM).some(s => s.step === 'wr_pools')
    && !questSitesFor(REEDS, PM).some(s => s.step === 'wr_apex'));
  // Several done before a visit (a save from before reports): all in one visit, in order.
  PM.reset();
  PM.tribe = 'styx';
  ['hunted:reeds_of_gethsemane', 'hunted_cull:reeds_of_gethsemane', 'hunted_apex:reeds_of_gethsemane',
    'mb_weeping_heard', 'mb_signs_found', 'vowback_slain'].forEach(f => PM.setQuestFlag(f));
  const all = claimQuestRewards(PM).map(p => p.stepId).join();
  check('steps done before the visit are reported together, in order', all === 'wr_hunt,wr_cull,wr_apexpool,wr_pools,wr_signs,wr_apex', all);
  // The lodge's first offer waits on the Vowback's report (owner 2026-10-03).
  PM.reset();
  PM.tribe = 'styx';
  ['hunted:reeds_of_gethsemane', 'mb_weeping_heard', 'mb_signs_found', 'vowback_slain'].forEach(f => PM.setQuestFlag(f));
  PM.completedQuestSteps = ['wr_hunt', 'wr_cull', 'wr_apexpool', 'wr_pools', 'wr_signs'];
  check("the Vowback not reported: the tribe's offer waits", !offersReady(PM, REEDS).some(b => b.offerAfterStep === 'wr_apex'));
  claimQuestRewards(PM);
  check('...reported: it is ready', offersReady(PM, REEDS).some(b => b.offerAfterStep === 'wr_apex')
    && getStepState(step('wr_offer'), PM) === 'active');
}

console.log('');
if (failures) { console.log(`huntstart: ${failures} FAILED`); process.exit(1); }
console.log('huntstart: all passed');
