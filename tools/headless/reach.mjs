// tools/headless/reach.mjs
//
// Melee reach: a melee attack can only touch the enemy FRONT rank, unless that
// rank is empty. Runs the real CombatScene gate, not a copy of the rule.
//
// The flag is opt-in and ships OFF, so this file is also the only place the
// rule is exercised at all until it is turned on in a real game.
//
// Run: node tools/headless/reach.mjs

import { installPhaserStub } from './phaserStub.js';
installPhaserStub(4242);

const { createCombatHost } = await import('./combatHost.js');
const { makeParty, slotMapFor } = await import('./fixtures.js');
const { DevFlags } = await import('../../src/systems/DevFlags.js');
const { SKILLS } = await import('../../data/skills.js');
const CombatSceneMod = await import('../../src/scenes/CombatScene.js');
const CombatScene = CombatSceneMod.default
  || Object.values(CombatSceneMod).find(v => typeof v === 'function');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};

const host = createCombatHost(CombatScene);
const party = makeParty();
host.__begin({ party, partySlots: slotMapFor(party), scenarioId: 'training_encounter_1' });

const col = (u) => host._getColumnBySlotId(u?._slot?.slotId);
const foes = () => (host.enemies || []).filter(e => e.status !== 'incapacitated');
const attacker = host.turnOrder.find(u => !u.isEnemy);

// A real melee skill and a real ranged one, taken from the data rather than
// invented, so the tag check is exercised against what the game actually ships.
const melee = SKILLS.basic_attack;
const ranged = Object.values(SKILLS).find(s =>
  (s.tags || []).includes('projectile') && (s.tags || []).includes('attack'));

console.log('=== the rule is dormant until switched on ===');
DevFlags.toggleMeleeReach();                       // -> off (starts unset)
if (DevFlags.isMeleeReachEnabled()) DevFlags.toggleMeleeReach();
const back = foes().find(e => col(e) === 'back') || foes().find(e => col(e) !== 'front');
check('a back-rank foe exists to aim at', !!back, back?.name + ' in ' + col(back));
check('with the flag OFF, melee reaches the back rank',
  host._reachBlocked(attacker, back, melee) === null);

console.log('');
console.log('=== switched on ===');
DevFlags.toggleMeleeReach();
check('the flag is on', DevFlags.isMeleeReachEnabled());

const front = foes().find(e => col(e) === 'front');
check('a front-rank foe is holding the line', !!front, front?.name);
check('melee is refused past the front line',
  !!host._reachBlocked(attacker, back, melee),
  host._reachBlocked(attacker, back, melee) || 'NOT REFUSED');
check('melee still reaches the front line itself',
  host._reachBlocked(attacker, front, melee) === null);
check('a projectile ignores reach entirely',
  host._reachBlocked(attacker, back, ranged) === null, ranged?.name);
check('reach: "any" ignores it too -- how a diving owl earns its identity',
  host._reachBlocked(attacker, back, { ...melee, reach: 'any' }) === null);

console.log('');
console.log('=== broken ranks ===');
// Drop everyone holding the front. Nothing is protected any more.
for (const e of foes()) if (col(e) === 'front') e.status = 'incapacitated';
check('with the front rank gone, melee reaches anyone',
  host._reachBlocked(attacker, back, melee) === null,
  'front holders left: ' + foes().filter(e => col(e) === 'front').length);
check('so a melee attacker can NEVER be left with no legal target',
  foes().length > 0 && host._reachBlocked(attacker, foes()[0], melee) === null);

console.log('');
console.log('=== symmetry and the cheat ===');
// Restore, then have an ENEMY swing at a back-rank hunter.
for (const e of host.enemies) e.status = 'active';
const foe = foes().find(e => col(e) === 'front') || foes()[0];
const hunterBack = host.turnOrder.find(u => !u.isEnemy && col(u) !== 'front');
const hunterFront = host.turnOrder.find(u => !u.isEnemy && col(u) === 'front');
check('a hunter is holding YOUR front rank', !!hunterFront, hunterFront?.name);
check('the same rule binds enemies attacking you',
  !!host._reachBlocked(foe, hunterBack, melee),
  host._reachBlocked(foe, hunterBack, melee) || 'NOT REFUSED');

DevFlags.toggleNoRange?.();
check('the existing no-range cheat overrides it',
  host._reachBlocked(attacker, back, melee) === null,
  DevFlags.isNoRangeEnabled() ? 'cheat on' : 'CHEAT DID NOT ENGAGE');

console.log('');
console.log(failures ? `${failures} CHECK(S) FAILED` : 'ALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
