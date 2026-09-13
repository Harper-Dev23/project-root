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

/* ---------------- 9. a reveal reaches EVERY player ---------------- */
//
// An Armor-Reading Tonic reveals an enemy's armor for the rest of the fight. In
// single player the flag sits on the enemy's item, so the whole party sees it. In
// co-op the flag lived only on the server and on the screen of the player who
// drank the tonic: equipment state was never broadcast, so every teammate kept
// seeing [Uncommon] on armor that had been read. Same for a Severing Chant's
// lock. This drives the real hub, takes the broadcast the OTHER player receives,
// and applies it to a board built the way that player's client builds it.
console.log('=== a tonic or chant used by one player shows for every player ===');
{
  const { createHub } = await import('../../server/protocol.js');
  const { toWireCharacter } = await import('../../src/systems/CoopWire.js');
  const ARMOR = ['head', 'chest', 'legs', 'gloves', 'boots'];

  const conn = (label) => ({
    label, inbox: [],
    send(msg) { this.inbox.push(msg); },
    last(t) { return [...this.inbox].reverse().find(m => m.t === t) || null; },
  });

  /** A two-player hunt on Gorrek, started. Returns who acts first and who watches. */
  const hunt = (code) => {
    const wire = makeParty().map(toWireCharacter);
    const cut = (n, from) => JSON.parse(JSON.stringify(wire.slice(from, from + n)));
    const hub = createHub({ CombatScene, codeFactory: () => code });
    const a = conn('a'), b = conn('b');
    hub.handle(a, { t: 'create', name: 'A', scenarioId: SCENARIO, hunters: cut(3, 0) });
    hub.handle(b, { t: 'join', code, name: 'B', hunters: cut(3, 3) });
    hub.handle(a, { t: 'ready', ready: true });
    hub.handle(b, { t: 'ready', ready: true });
    hub.handle(a, { t: 'start' });
    const started = a.last('started');
    const ids = { a: a.last('joined')?.playerId, b: b.last('joined')?.playerId };
    const current = started.state.current;
    const ownerOfCurrent = started.roster.find(h => (h.instanceId || h.id) === current?.ref)?.ownerId;
    const actor = ownerOfCurrent === ids.a ? a : b;
    const watcher = actor === a ? b : a;
    const watcherId = actor === a ? ids.b : ids.a;
    const gorrek = started.state.units.find(u => u.side === 'enemy');
    return { hub, started, current, actor, watcher, watcherId, gorrek };
  };

  /** The watcher's board, built the way CombatScene builds a co-op client board. */
  const watcherBoard = (h) => {
    const scene = createCombatHost(CombatScene);
    scene.isCoop = true;
    scene.coopClient = { roster: h.started.roster, playerId: h.watcherId, gearSeed: h.started.gearSeed, on: () => () => {} };
    scene.coopParty = [];
    scene._coopUnsubs = [];
    scene.gearSeed = h.started.gearSeed;
    scene.scenarioId = SCENARIO;
    scene._placeCoopParty();
    scene._placeEnemies(SCENARIO);
    scene.turnOrder = [...scene.coopParty, ...scene.enemies];
    return scene;
  };

  // ---- Identify ----
  {
    const h = hunt('RVL1');
    check('the hunt started with a hunter to act and a teammate watching', !!h.current && !!h.gorrek && h.actor !== h.watcher);

    const board = watcherBoard(h);
    const enemy = board.enemies[0];
    const armorSlots = ARMOR.filter(s => isItemInstance(enemy.equipment?.[s]));
    check('Gorrek wears armor to reveal', armorSlots.length > 0, armorSlots.join(', '));
    check('before the tonic, the teammate sees none of it revealed',
      armorSlots.every(s => !enemy.equipment[s]._identified));

    h.hub.handle(h.actor, { t: 'act', actor: h.current.ref, skill: 'identify_armor_tonic', target: h.gorrek.ref });
    const refused = h.actor.last('error');
    check('the server accepts the tonic', !refused, refused?.reason || 'accepted');

    const seen = h.watcher.last('state')?.state;
    const gUnit = seen?.units?.find(u => u.ref === h.gorrek.ref);
    check('the TEAMMATE\'s broadcast carries the reveal for every armor slot',
      armorSlots.every(s => (gUnit?.gear?.[s] || '').includes('I')), JSON.stringify(gUnit?.gear || null));

    const report = board._applyNetState(seen);
    check('the teammate\'s board applies that broadcast cleanly', report?.ok !== false,
      report?.unknown?.length ? 'unknown: ' + report.unknown.join(',') : 'ok');
    check('the TEAMMATE now sees every armor piece revealed',
      armorSlots.every(s => enemy.equipment[s]._identified === true),
      armorSlots.map(s => `${s}=${enemy.equipment[s]._identified}`).join(' '));
    const weapon = enemy.equipment.weaponMain;
    check('an Armor tonic leaves the weapon hidden', !weapon || weapon._identified !== true,
      weapon ? `weaponMain=${weapon._identified}` : 'no weapon');

    // The flags are set, not merged: an old board with no reveal must hide it again.
    board._applyNetState(h.started.state);
    check('flags follow the server exactly (an earlier board hides them again)',
      armorSlots.every(s => enemy.equipment[s]._identified === false));
  }

  // ---- Sever ----
  {
    const h = hunt('RVL2');
    const board = watcherBoard(h);
    const enemy = board.enemies[0];
    const slot = severableSlot(enemy);
    check('Gorrek has a soul-bound item a chant can cut', !!slot && enemy.equipment[slot]._droppable === false, String(slot));

    h.hub.handle(h.actor, { t: 'act', actor: h.current.ref, skill: `sever_${slot}`, target: h.gorrek.ref });
    check('the server accepts the chant', !h.actor.last('error'), h.actor.last('error')?.reason || 'accepted');

    const seen = h.watcher.last('state')?.state;
    const gUnit = seen?.units?.find(u => u.ref === h.gorrek.ref);
    check('the teammate\'s broadcast marks the slot droppable', (gUnit?.gear?.[slot] || '').includes('D'),
      JSON.stringify(gUnit?.gear || null));
    board._applyNetState(seen);
    check('the TEAMMATE no longer sees a lock on the severed item', enemy.equipment[slot]._droppable === true);
    const stillBound = Object.entries(enemy.equipment).filter(([s, i]) => s !== slot && isItemInstance(i) && i._droppable === false);
    check('...while gear nobody severed stays locked', stillBound.length > 0, stillBound.map(([s]) => s).join(', '));
  }
}


/* ---------------- 10. a move is seen by every player ---------------- */
//
// Moving used to call _executeSkill straight from the click, which moved the
// hunter on the mover's screen only. The server never heard about it, so
// teammates never saw it, and the next board from the server snapped the mover
// back. Co-op boards also blinked units between slots instead of playing the
// hop single player uses. This checks the whole chain: click -> send -> server
// validates and moves -> the teammate's board shows the new slot with a hop.
console.log('=== movement in co-op ===');
{
  const { createHub } = await import('../../server/protocol.js');
  const { toWireCharacter } = await import('../../src/systems/CoopWire.js');
  const { SKILLS } = await import('../../data/skills.js');
  const DASH = SKILLS.move_dash;

  const conn = (label) => ({
    label, inbox: [],
    send(msg) { this.inbox.push(msg); },
    last(t) { return [...this.inbox].reverse().find(m => m.t === t) || null; },
  });

  const wire = makeParty().map(toWireCharacter);
  const cut = (n, from) => JSON.parse(JSON.stringify(wire.slice(from, from + n)));
  const hub = createHub({ CombatScene, codeFactory: () => 'MOVE' });
  const a = conn('a'), b = conn('b');
  hub.handle(a, { t: 'create', name: 'A', scenarioId: SCENARIO, hunters: cut(3, 0) });
  hub.handle(b, { t: 'join', code: 'MOVE', name: 'B', hunters: cut(3, 3) });
  hub.handle(a, { t: 'ready', ready: true });
  hub.handle(b, { t: 'ready', ready: true });
  hub.handle(a, { t: 'start' });
  const started = a.last('started');
  const ids = { a: a.last('joined')?.playerId, b: b.last('joined')?.playerId };
  const current = started.state.current;
  const ownerOfCurrent = started.roster.find(h => (h.instanceId || h.id) === current?.ref)?.ownerId;
  const actor = ownerOfCurrent === ids.a ? a : b;
  const watcher = actor === a ? b : a;
  const watcherId = actor === a ? ids.b : ids.a;

  // A board built the way a co-op client builds one, with a spy on the hop.
  const buildBoard = (playerId) => {
    const scene = createCombatHost(CombatScene);
    scene.isCoop = true;
    const sent = [];
    scene.coopClient = { roster: started.roster, playerId, gearSeed: started.gearSeed, on: () => () => {}, act: (m) => { sent.push(m); } };
    scene.coopParty = [];
    scene._coopUnsubs = [];
    scene.gearSeed = started.gearSeed;
    scene.scenarioId = SCENARIO;
    scene._placeCoopParty();
    scene._placeEnemies(SCENARIO);
    scene.turnOrder = [...scene.coopParty, ...scene.enemies];
    scene.__hops = [];
    scene._playMoveHopVFX = (slot, dx, dy) => { scene.__hops.push({ slotId: slot?.slotId, dx, dy }); };
    // A real client applies the opening board as soon as the hunt starts, which
    // is what puts every hunter where the SERVER placed them. Skipping it left
    // this board with its own formation, so "reachable" was worked out from the
    // wrong square.
    scene._applyNetState(started.state);
    scene.__hops = [];
    return { scene, sent };
  };
  // The headless host replaces _enterPositionTargeting with a no-op (it is on
  // its VISUAL_METHODS list), so the click-to-move flow is driven through the
  // real prototype method.
  const enterPositionTargeting = (scene, unit, ability) =>
    CombatScene.prototype._enterPositionTargeting.call(scene, unit, ability);

  const watch = buildBoard(watcherId);
  const moverRef = current.ref;
  const moverOnWatch = watch.scene.coopParty.find(c => (c.instanceId || c.id) === moverRef);
  const fromSlot = moverOnWatch?._slot?.slotId;
  const reachable = watch.scene._reachablePositions(moverOnWatch, DASH).map(s => s.slotId);
  check('the mover has somewhere to Dash to', reachable.length > 0, `from ${fromSlot} to [${reachable.join(', ')}]`);
  const dest = reachable[0];

  // ---- the mover's own client sends, and does not move locally ----
  {
    const mine = buildBoard(ownerOfCurrent);
    const me = mine.scene.coopParty.find(c => (c.instanceId || c.id) === moverRef);
    mine.scene._currentChar = () => me;
    enterPositionTargeting(mine.scene, me, DASH);
    const slot = mine.scene.allySlots.find(s => s.slotId === dest);
    if (typeof slot.__click === 'function') slot.__click(); else slot.emit('pointerdown');
    check('clicking a destination in co-op SENDS the move', mine.sent.length === 1 && mine.sent[0].skill === 'move_dash',
      JSON.stringify(mine.sent[0] || null));
    check('...naming the destination slot', mine.sent[0]?.targetSlot === dest, `targetSlot ${mine.sent[0]?.targetSlot}`);
    check('...and does NOT move the hunter locally', me._slot?.slotId === fromSlot,
      `still at ${me._slot?.slotId}`);
  }

  // ---- an unreachable square is refused and moves nothing ----
  {
    const far = watch.scene.allySlots.map(s => s.slotId).find(id => id !== fromSlot && !reachable.includes(id));
    const beforeState = actor.last('state') || started;
    hub.handle(actor, { t: 'act', actor: moverRef, skill: 'move_dash', targetSlot: far });
    const err = actor.last('error');
    check('the server refuses an unreachable destination', /not reachable/.test(err?.reason || ''),
      `slot ${far}: ${err?.reason}`);
  }

  // ---- another player cannot move this hunter ----
  {
    hub.handle(watcher, { t: 'act', actor: moverRef, skill: 'move_dash', targetSlot: dest });
    const err = watcher.last('error');
    check('a teammate cannot move a hunter that is not theirs', !!err && !/reachable/.test(err.reason || ''),
      err?.reason || 'NOT refused');
  }

  // ---- the real move ----
  {
    const vBefore = watcher.last('state')?.state?.version ?? -1;
    hub.handle(actor, { t: 'act', actor: moverRef, skill: 'move_dash', targetSlot: dest });
    check('the server accepts a reachable move', !actor.inbox.slice(-1).some(m => m.t === 'error'),
      actor.inbox.slice(-1)[0]?.reason || 'accepted');
    const seen = watcher.last('state')?.state;
    const unit = seen?.units?.find(u => u.ref === moverRef);
    check('the TEAMMATE\'s broadcast has the hunter at the new slot', unit?.slot === dest,
      `server says ${unit?.slot}, wanted ${dest}`);

    watch.scene._applyNetState(seen);
    check('the TEAMMATE\'s board moves the hunter there', moverOnWatch._slot?.slotId === dest,
      `${fromSlot} -> ${moverOnWatch._slot?.slotId}`);
    const hop = watch.scene.__hops.find(h => h.slotId === dest);
    check('...with the same hop animation single player plays', !!hop && (hop.dx !== 0 || hop.dy !== 0),
      JSON.stringify(hop || null));
    const occupant = watch.scene.allySlots.find(s => s.slotId === fromSlot)?.char;
    check('...and the slot it left is empty on that board', !occupant || (occupant.instanceId || occupant.id) !== moverRef);

    // A board that changes nothing plays no hop.
    const hopsNow = watch.scene.__hops.length;
    watch.scene._applyNetState(seen);
    check('re-applying the same board does not hop again', watch.scene.__hops.length === hopsNow);
  }

  // ---- single player is untouched: the click still moves directly ----
  {
    const sp = createCombatHost(CombatScene);
    const party = makeParty();
    sp.__begin({ party, partySlots: slotMapFor(party), scenarioId: SCENARIO });
    startCombat(sp);
    const hero = party[0];
    setActor(sp, hero);
    hero.actionsLeft = { major: 1, bonus: 1, class: 1, reaction: 1 };
    const spFrom = hero._slot?.slotId;
    const spDest = sp._reachablePositions(hero, DASH)[0]?.slotId;
    enterPositionTargeting(sp, hero, DASH);
    const slot = sp.allySlots.find(s => s.slotId === spDest);
    if (typeof slot?.__click === 'function') slot.__click(); else slot?.emit?.('pointerdown');
    sp.__drain?.();
    check('single player: clicking a destination still moves the hunter', hero._slot?.slotId === spDest,
      `${spFrom} -> ${hero._slot?.slotId} (wanted ${spDest})`);
  }
}


console.log('\n' + (failures === 0
  ? 'ALL CHECKS PASSED'
  : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
