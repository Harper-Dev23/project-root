// tools/headless/coopgear.mjs
//
// Two things co-op got wrong about enemies, both verified against the real
// engine rather than argued about.
//
//   1. SHARED GEAR. Enemy equipment is ROLLED, and every client runs placement
//      locally to draw the board, so each player rolled a different Gorrek --
//      different armour, different derived stats. The server's copy is the one
//      that governs combat, so players were shown numbers that were not real.
//      A per-fight seed must make every board identical.
//
//   2. COMBAT ITEMS. A Severing Chant crosses the wire as `skill: 'sever_head'`,
//      and that id is an ITEM id, not a key in SKILLS -- so the server refused
//      every chant in co-op with "no such skill". It must resolve and apply,
//      even though the server holds nobody's inventory.
//
// Run: node tools/headless/coopgear.mjs

import { installPhaserStub } from './phaserStub.js';
installPhaserStub(4242);

const { createCombatHost } = await import('./combatHost.js');
const { makeParty, slotMapFor } = await import('./fixtures.js');
const { startCombat, setActor } = await import('./fight.js');
const CombatSceneMod = await import('../../src/scenes/CombatScene.js');
const CombatScene = CombatSceneMod.default
  || Object.values(CombatSceneMod).find(v => typeof v === 'function');
const GameState = (await import('../../src/systems/GameState.js')).default;
const { createItemInstance, isItemInstance } = await import('../../src/systems/ItemFactory.js');
const { makeRng } = await import('../../src/systems/seededRng.js');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};

// A fight with an enemy that actually wears rolled gear.
const SCENARIO = 'training_encounter_6';   // Gorrek, the case reported

function board({ gearSeed = null, scenarioId = SCENARIO } = {}) {
  const host = createCombatHost(CombatScene);
  host.gearSeed = gearSeed;              // set BEFORE placement, as the server does
  const party = makeParty();
  host.__begin({ party, partySlots: slotMapFor(party), scenarioId });
  return { host, party };
}


/**
 * A slot holding an item a chant may actually cut free.
 *
 * Gorrek's main hand is the Bloodthirster, rarity `historic`, which sits ABOVE
 * the chants' maxRarity of epic on purpose -- scripted quest gear is not
 * severable. Picking blindly found that slot and read as a code failure when it
 * was correct behaviour, so eligibility is mirrored here.
 */
const SEVERABLE = ['common', 'uncommon', 'rare', 'epic'];
function severableSlot(unit) {
  return Object.entries(unit.equipment || {})
    .find(([, i]) => isItemInstance(i) && !i._droppable && SEVERABLE.includes(i.rarity))?.[0] || null;
}

/** What a player would SEE: every enemy's gear, by slot, with rarity + affixes. */
function gearFingerprint(host) {
  return (host.enemies || []).map(e => {
    const slots = Object.entries(e.equipment || {})
      .filter(([, inst]) => isItemInstance(inst))
      .map(([slot, inst]) => `${slot}=${inst.id}:${inst.rarity}:${(inst.affixes || []).map(a => a.key || a).join('+')}`)
      .sort();
    return `${e.name}[${slots.join(',')}]`;
  }).join(' | ');
}

/* ---------------- 1. the bug: unseeded boards diverge ---------------- */
console.log('=== unseeded placement (what single player does) ===');
{
  const a = gearFingerprint(board().host);
  const b = gearFingerprint(board().host);
  check('two unseeded boards roll DIFFERENT enemy gear', a !== b,
    'this is the co-op bug, and correct behaviour for single player');
  check('...and both actually rolled something', a.length > 20 && b.length > 20,
    a.slice(0, 70) + '...');
}

/* ---------------- 2. the fix: one seed, identical boards ---------------- */
console.log('=== seeded placement (what co-op now does) ===');
{
  const seed = 123456;
  const server = board({ gearSeed: seed }).host;
  const client1 = board({ gearSeed: seed }).host;
  const client2 = board({ gearSeed: seed }).host;

  const s = gearFingerprint(server);
  check('a client reproduces the server board exactly', gearFingerprint(client1) === s,
    s.slice(0, 80) + '...');
  check('and so does a second client', gearFingerprint(client2) === s);

  const other = gearFingerprint(board({ gearSeed: seed + 1 }).host);
  check('a DIFFERENT seed gives a different board', other !== s,
    'proves the match above is the seed, not a fixed scenario');

  // Derived stats are the thing the player actually reads off the screen.
  const statsOf = (h) => (h.enemies || [])
    .map(e => `${e.name}:${JSON.stringify(e.totalStats || {})}:hp${e.maxHP}`).join('|');
  check('derived stats and maxHP match too', statsOf(client1) === statsOf(server),
    'the reported symptom was different stat values per player');
}

/* ---------------- 3. the seed stream itself ---------------- */
console.log('=== the generator ===');
{
  const a = makeRng(99), b = makeRng(99), c = makeRng(100);
  const seqA = [a(), a(), a(), a()];
  const seqB = [b(), b(), b(), b()];
  const seqC = [c(), c(), c(), c()];
  check('same seed gives the same sequence', seqA.join() === seqB.join(),
    seqA.map(n => n.toFixed(4)).join(' '));
  check('a different seed gives a different one', seqA.join() !== seqC.join());
  check('values stay in [0,1)', seqA.every(n => n >= 0 && n < 1));
  check('a zero seed still works', typeof makeRng(0)() === 'number',
    'a degenerate seed must not produce NaN');
}

/* ---------------- 4. combat items resolve from a bare id ---------------- */
console.log('=== a Severing Chant sent as a wire id ===');
{
  const { host, party } = board({ gearSeed: 777 });
  startCombat(host);
  const me = party[0];
  setActor(host, me);
  me.actionsLeft = { major: 1, bonus: 1, class: 1, reaction: 1 };

  const foe = host.enemies[0];
  const slot = severableSlot(foe);
  check('the target has a soul-bound item to cut free', !!slot,
    slot + ' = ' + foe.equipment[slot]?.id + ':' + foe.equipment[slot]?.rarity);

  const itemId = `sever_${slot}`;
  GameState.inventory = [createItemInstance(itemId)];

  // Exactly what the server receives: strings, no objects.
  const verdict = host._resolveAction({ actor: me.instanceId, skill: itemId, target: foe.uid });
  host.__drain();

  check('the server resolves the item id instead of refusing it',
    verdict.ok === true, verdict.reason || '');
  check('...and it is no longer "no such skill"',
    !/no such skill/.test(verdict.reason || ''), verdict.reason || 'accepted');
  check('the soul-bond was actually cut', foe.equipment[slot]._droppable === true,
    'droppable=' + foe.equipment[slot]._droppable);
  check('a bonus action was spent', me.actionsLeft.bonus === 0,
    'bonus=' + me.actionsLeft.bonus);
}

/* ---------------- 5. the server needs no copy of the item ---------------- */
console.log('=== the server holds nobody\'s inventory ===');
{
  const { host, party } = board({ gearSeed: 777 });
  host.isAuthoritativeHost = true;          // as server/session.js sets it
  startCombat(host);
  const me = party[0];
  setActor(host, me);
  me.actionsLeft = { major: 1, bonus: 1, class: 1, reaction: 1 };

  const foe = host.enemies[0];
  const slot = severableSlot(foe);

  GameState.inventory = [];                 // the server's bag is empty

  const verdict = host._resolveAction({ actor: me.instanceId, skill: `sever_${slot}`, target: foe.uid });
  host.__drain();

  check('an authoritative host applies a chant it does not hold',
    verdict.ok === true && foe.equipment[slot]._droppable === true,
    'this is what made every co-op chant fizzle');
  check('...and still spends the action it owns', me.actionsLeft.bonus === 0,
    'bonus=' + me.actionsLeft.bonus);
}

/* ---------------- 6. a normal client still needs the item ---------------- */
console.log('=== a client without the item is still refused ===');
{
  const { host, party } = board({ gearSeed: 777 });
  startCombat(host);
  const me = party[0];
  setActor(host, me);
  me.actionsLeft = { major: 1, bonus: 1, class: 1, reaction: 1 };
  const foe = host.enemies[0];
  const slot = severableSlot(foe);

  GameState.inventory = [];                 // we own no chant
  host._resolveAction({ actor: me.instanceId, skill: `sever_${slot}`, target: foe.uid });
  host.__drain();

  check('nothing was severed without owning the item',
    foe.equipment[slot]._droppable !== true,
    'the inventory requirement must only be relaxed for the server');
  check('and no action was spent', me.actionsLeft.bonus === 1,
    'bonus=' + me.actionsLeft.bonus);
}

/* ---------------- 7. a real skill id still wins ---------------- */
console.log('=== resolution order ===');
{
  const { host, party } = board({ gearSeed: 777 });
  startCombat(host);
  const me = party[0];
  setActor(host, me);
  const basic = host._findSkillFor(me, 'basic_attack');
  check('a genuine skill id resolves to the skill, not an item',
    basic?.id === 'basic_attack' && !basic.itemUse, String(basic?.id));
  check('an unknown id is still refused',
    host._findSkillFor(me, 'not_a_real_thing_at_all') === null);
  const item = host._findSkillFor(me, 'sever_head');
  check('an item id resolves to an item ability',
    item?.id === 'sever_head' && !!item.itemUse, JSON.stringify(item?.itemUse || null));
}

/* ---------------- 8. the seed actually crosses the wire ---------------- */
//
// The sections above prove the pieces. This proves the WIRING, which is where
// this project's co-op bugs actually live: a value the server holds but never
// sends, or sends but the client never applies, looks exactly like one that
// works. Uses the real hub and the real 'started' message.
console.log('=== the seed over the real protocol ===');
{
  const { createHub } = await import('../../server/protocol.js');
  const { toWireCharacter } = await import('../../src/systems/CoopWire.js');

  const conn = (label) => ({
    label, inbox: [],
    send(msg) { this.inbox.push(msg); },
    last(t) { return [...this.inbox].reverse().find(m => m.t === t) || null; },
  });

  const wire = makeParty().map(toWireCharacter);
  const cut = (n, from) => JSON.parse(JSON.stringify(wire.slice(from, from + n)));

  const hub = createHub({ CombatScene, codeFactory: () => 'GEAR' });
  const hostConn = conn('host');
  const guestConn = conn('guest');
  hub.handle(hostConn, { t: 'create', name: 'Host', scenarioId: SCENARIO, hunters: cut(2, 0) });
  hub.handle(guestConn, { t: 'join', code: 'GEAR', name: 'Guest', hunters: cut(2, 2) });
  hub.handle(hostConn, { t: 'ready', ready: true });
  hub.handle(guestConn, { t: 'ready', ready: true });
  hub.handle(hostConn, { t: 'start' });

  const a = hostConn.last('started');
  const b = guestConn.last('started');
  check('the hunt started for both players', !!a && !!b);
  check('the started message carries a gear seed', Number.isFinite(a && a.gearSeed),
    'gearSeed=' + (a && a.gearSeed));
  check('both players receive the SAME seed', a && b && a.gearSeed === b.gearSeed,
    (a && a.gearSeed) + ' vs ' + (b && b.gearSeed));

  // A board built from the wire seed is reproducible, which is the property the
  // clients rely on to draw the server's enemies.
  const one = board({ gearSeed: a.gearSeed });
  const two = board({ gearSeed: a.gearSeed });
  check('a board built from the wire seed is reproducible',
    gearFingerprint(one.host) === gearFingerprint(two.host),
    gearFingerprint(one.host).slice(0, 70) + '...');

  // Two separate hunts must NOT share gear, or the seed is a constant.
  const hub2 = createHub({ CombatScene, codeFactory: () => 'GER2' });
  const solo = conn('solo');
  hub2.handle(solo, { t: 'create', name: 'Solo', scenarioId: SCENARIO, hunters: cut(2, 0) });
  hub2.handle(solo, { t: 'ready', ready: true });
  hub2.handle(solo, { t: 'start' });
  const second = solo.last('started');
  check('a different hunt gets a different seed',
    second && second.gearSeed !== a.gearSeed,
    (a && a.gearSeed) + ' vs ' + (second && second.gearSeed));
}

console.log('\n' + (failures === 0
  ? 'ALL CHECKS PASSED'
  : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
