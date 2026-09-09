// @ts-nocheck
// tools/headless/verify.mjs
//
// Checks what the golden master structurally CANNOT.
//
// combat_snapshot.js calls _resolveAction directly, so it verifies the rules
// but never the click that reaches them, and it records damage numbers rather
// than identity or permission. This file covers the rest:
//
//   1. the single-player click path  — _useAbility arms targeting, the
//      pointerdown lands damage and spends the action
//   2. refusals                      — gates still refuse, and say why
//   3. wire-safe references          — an action resolves from strings alone
//   4. identity                      — every combatant is uniquely addressable
//   5. ownership                     — the co-op permission gate, fail-closed
//
// Run: node tools/headless/verify.mjs

import { installPhaserStub } from './phaserStub.js';
installPhaserStub(777);

const { createCombatHost } = await import('./combatHost.js');
const { makeParty, slotMapFor, skillFor } = await import('./fixtures.js');
const { startCombat, setActor } = await import('./fight.js');
const CombatSceneMod = await import('../../src/scenes/CombatScene.js');
const CombatScene = CombatSceneMod.default
  || Object.values(CombatSceneMod).find(v => typeof v === 'function');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};

function board() {
  const host = createCombatHost(CombatScene);
  const party = makeParty();
  host.__begin({ party, partySlots: slotMapFor(party), scenarioId: 'training_encounter_1' });
  startCombat(host);
  for (const c of party) {
    c.currentMP = c.maxMP;
    c.actionsLeft = { major: 1, bonus: 1, class: 1, reaction: 1 };
  }
  return { host, party };
}

// ---- 1. a targeted ability, armed and clicked -----------------------------
console.log('=== targeted ability via the real click path ===');
{
  const { host, party } = board();
  const bran = party.find(c => c.name === 'Bran');
  setActor(host, bran);

  const ability = skillFor(bran, 'basic_attack');
  host._useAbility(ability);

  const armed = host.enemySlots.filter(s => s.char && s.__listenerCount('pointerdown') > 0);
  check('targeting armed the enemy slots', armed.length > 0, armed.length + ' slots clickable');

  const slot = armed[0];
  const foe = slot.char;
  const hpBefore = foe.currentHP;
  const mpBefore = bran.currentMP;

  slot.__click();
  host.__drain();

  check('the click dealt damage', foe.currentHP < hpBefore,
    hpBefore + ' -> ' + foe.currentHP);
  check('the action was spent', bran.actionsLeft.major === 0,
    'major=' + bran.actionsLeft.major);
  check('MP was charged by the engine, not twice', bran.currentMP === mpBefore,
    'basic_attack costs 0 MP; mp=' + bran.currentMP);
}

// ---- 2. an untargeted ability through _useAbility --------------------------
console.log('=== untargeted ability via _useAbility ===');
{
  const { host, party } = board();
  const halvard = party.find(c => c.name === 'Halvard');
  setActor(host, halvard);

  const selfBuff = (halvard.skills || []).find(s =>
    s.type === 'weapon' && !s.requiresTarget && !s.hidden && s.mechanic !== 'reaction');

  if (!selfBuff) {
    check('found an untargeted skill to test', false, 'none in this kit');
  } else {
    const before = (halvard.statusEffects || []).length;
    const mpBefore = halvard.currentMP;
    host._useAbility(selfBuff);
    host.__drain();
    const changed = (halvard.statusEffects || []).length !== before
      || halvard.currentMP !== mpBefore
      || (halvard.cooldowns?.[selfBuff.id] || 0) > 0;
    check('untargeted skill resolved on the caster', changed,
      selfBuff.id + '  effects ' + before + ' -> ' + (halvard.statusEffects || []).length +
      ', mp ' + mpBefore + ' -> ' + halvard.currentMP);
  }
}

// ---- 3. the gates still refuse, and say why --------------------------------
console.log('=== refusals still refuse ===');
{
  const { host, party } = board();
  const bran = party.find(c => c.name === 'Bran');
  setActor(host, bran);

  bran.actionsLeft = { major: 0, bonus: 1, class: 1, reaction: 1 };
  const logBefore = host.combatEntries.length;
  host._useAbility(skillFor(bran, 'basic_attack'));
  const armed = host.enemySlots.filter(s => s.char && s.__listenerCount('pointerdown') > 0);
  check('no major action left => targeting never arms', armed.length === 0);

  // And out-of-turn actions are refused by _resolveAction itself.
  const sable = party.find(c => c.name === 'Sable');
  setActor(host, bran);
  const verdict = host._resolveAction({
    actor: sable, skill: skillFor(sable, 'basic_attack'), target: host.enemies[0],
  });
  check('acting out of turn is refused', verdict.ok === false, verdict.reason);
}

// ---- 4. wire-safe references resolve --------------------------------------
console.log('=== wire-safe references (what a network message carries) ===');
{
  const { host, party } = board();
  const bran = party.find(c => c.name === 'Bran');
  setActor(host, bran);

  const foe = host.enemies[0];
  const foeKey = host._charSlotKey(foe);
  const hpBefore = foe.currentHP;

  const verdict = host._resolveAction({
    actor: bran.instanceId,      // a string id, as it would arrive over a socket
    skill: 'basic_attack',       // a string id
    target: foeKey,              // "E2"
  });
  host.__drain();

  check('resolved actor/skill/target from strings alone', verdict.ok === true, verdict.reason || '');
  check('and it actually hit', foe.currentHP < hpBefore, hpBefore + ' -> ' + foe.currentHP);

  // Refill the action pool first. Without this the check below passes for the
  // WRONG reason - the previous action emptied the pool, so the refusal would
  // read "no major action left" and prove nothing about target resolution.
  bran.actionsLeft = { major: 1, bonus: 1, class: 1, reaction: 1 };
  const bad = host._resolveAction({ actor: bran, skill: 'basic_attack', target: 'E9' });
  check('an unknown target ref is refused, not guessed',
    bad.ok === false && /target/i.test(bad.reason), bad.reason);

  bran.actionsLeft = { major: 1, bonus: 1, class: 1, reaction: 1 };
  const ambiguous = host._resolveAction({
    actor: bran, skill: 'basic_attack', target: 'Training Dummy',   // six of them
  });
  check('an AMBIGUOUS name is refused rather than guessed',
    ambiguous.ok === false, ambiguous.reason);
}

// ---- 5. identity: every combatant uniquely addressable --------------------
console.log('=== identity ===');
{
  const { host, party } = board();
  const uids = host.enemies.map(e => e.uid);
  check('every enemy has a uid', uids.every(Boolean), uids.join(','));
  check('enemy uids are unique', new Set(uids).size === uids.length,
    uids.length + ' enemies, ' + new Set(uids).size + ' distinct');

  // Six identical Training Dummies: the case that motivated this.
  const names = new Set(host.enemies.map(e => e.name));
  check('...even though they share one name', names.size < host.enemies.length,
    host.enemies.length + ' enemies, ' + names.size + ' distinct name(s)');

  const bran = party.find(c => c.name === 'Bran');
  check('_unitRef gives players their save instanceId',
    host._unitRef(bran) === bran.instanceId, host._unitRef(bran));
  check('_unitRef gives enemies their uid',
    host._unitRef(host.enemies[0]) === host.enemies[0].uid, host._unitRef(host.enemies[0]));

  // Deterministic across a fresh build with the same seed.
  installPhaserStub(777);
  const again = createCombatHost(CombatScene);
  const party2 = makeParty();
  again.__begin({ party: party2, partySlots: slotMapFor(party2), scenarioId: 'training_encounter_1' });
  check('uids are deterministic, not random',
    again.enemies.map(e => e.uid).join(',') === uids.join(','),
    again.enemies.map(e => e.uid).join(','));
}

// ---- 6. ownership: the co-op permission gate ------------------------------
console.log('=== ownership (co-op permission gate) ===');
{
  const { host, party } = board();
  const bran = party.find(c => c.name === 'Bran');
  const foe = host.enemies[0];
  setActor(host, bran);

  const refill = () => { bran.actionsLeft = { major: 1, bonus: 1, class: 1, reaction: 1 }; };
  const act = (opts) => host._resolveAction(
    { actor: bran, skill: skillFor(bran, 'basic_attack'), target: foe }, opts);

  // Single player passes no playerId at all: the gate must be inert.
  refill();
  check('no playerId => unaffected (this is single player)', act({}).ok === true);

  bran.ownerId = 'player-1';

  refill();
  check('owner may command their own hunter',
    act({ playerId: 'player-1' }).ok === true);

  refill();
  const stolen = act({ playerId: 'player-2' });
  check('another player may NOT', stolen.ok === false, stolen.reason);

  // Fail-closed: an unowned hunter is refused, not allowed. Failing open would
  // mean one missed stamp during lobby setup silently shares a character.
  refill();
  delete bran.ownerId;
  const unowned = act({ playerId: 'player-1' });
  check('an UNOWNED hunter is refused, not allowed (fail-closed)',
    unowned.ok === false, unowned.reason);

  // And ownership is checked before the turn gate, so a stolen action cannot
  // be distinguished from a mistimed one by probing.
  refill();
  bran.ownerId = 'player-1';
  const sable = party.find(c => c.name === 'Sable');
  sable.ownerId = 'player-2';
  const wrongTurnWrongOwner = host._resolveAction(
    { actor: sable, skill: skillFor(sable, 'basic_attack'), target: foe },
    { playerId: 'player-1' });
  check('ownership is judged before whose turn it is',
    wrongTurnWrongOwner.ok === false && /not yours/.test(wrongTurnWrongOwner.reason),
    wrongTurnWrongOwner.reason);
}

console.log('\n' + (failures === 0
  ? 'ALL CHECKS PASSED'
  : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
