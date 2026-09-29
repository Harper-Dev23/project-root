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
PM.setQuestFlag('vowback_slain');
PM.setQuestFlag('choir_heard');
paid = claimQuestRewards(PM);
check('two steps finished on one hunt: both paid, in quest order',
  paid.map(p => p.stepId).join() === 'wr_apex,hb_singing'
    && PM.huntTickets === before + step('wr_apex').reward.huntTickets + step('hb_singing').reward.huntTickets,
  paid.map(p => p.stepId).join());
check('the Combat Pit still pays its own tickets', PM.onScenarioComplete('training_encounter_1').huntTicketsEarned === 12);

console.log('');
if (failures) { console.log(`huntstart: ${failures} FAILED`); process.exit(1); }
console.log('huntstart: all passed');
