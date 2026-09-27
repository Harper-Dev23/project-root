// tools/headless/huntboss.mjs
//
// Boss hunts (chunk 14b-4a; data/bosses.js): the boss objective and its lair,
// the warning before it, the boss plan's life (kept at departure, used up once
// the boss is fought), and the boss's fight in the real CombatScene.
//   node tools/headless/huntboss.mjs

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
const { installPhaserStub, seed } = await import('./phaserStub.js');
installPhaserStub(41);

const { BOSSES } = await import('../../data/bosses.js');
const { PRIMARY_OBJECTIVES, LAUNCH_OBJECTIVES } = await import('../../data/huntMapGen.js');
const { generateHuntMap, reachableFrom, mapNeighbors, planMapInputs } = await import('../../src/systems/HuntMapGen.js');
const { occupantBand } = await import('../../src/systems/HuntRules.js');
const { createMapHunt, restoreMapHunt } = await import('../../src/systems/HuntEngine.js');
const { createItemInstance, huntPlanView } = await import('../../src/systems/ItemFactory.js');
const { takeDeparture } = await import('../../src/scenes/overlays/HuntHubOverlay.js');
const { planFitsZone } = await import('../../src/scenes/overlays/HuntPlanPickerOverlay.js');
const { isPassable } = await import('../../data/grounds.js');
const { parseTileId } = await import('../../src/systems/HexGrid.js');
const GameState = (await import('../../src/systems/GameState.js')).default;
const { makeParty, slotMapFor } = await import('./fixtures.js');
const { createCombatHost } = await import('./combatHost.js');
const { runFight, startCombat, setActor, cast } = await import('./fight.js');
const CombatSceneMod = await import('../../src/scenes/CombatScene.js');
const CombatScene = CombatSceneMod.default || Object.values(CombatSceneMod).find(v => typeof v === 'function');

const REEDS = 'reeds_of_gethsemane';
const MB = BOSSES.mourning_beast;

function world(party) {
  const w = { spent: [], flags: [] };
  Object.assign(w, {
    party: () => party, nightFalls() {}, dayBreaks() {}, bankItems() {},
    awardHuntPoints() {}, awardXP() {}, favor() {}, rivalDevotion() {}, tribeRep() {}, lore() {}, omens() {},
    questFlag: (f, on) => { if (on) w.flags.push(f); },
    hasQuestFlag: () => false, followedHouse: () => null, houseHolder: () => null, ownTribe: () => 'styx', tribeName: (t) => t,
    spendBossPlan: (id) => w.spent.push(id),
  });
  return w;
}

// =============================================================================
console.log('=== the objective and the lair ===');
{
  check('Boss is an objective no plan can be rolled, sold or simulated with', PRIMARY_OBJECTIVES.boss?.bossOnly && !LAUNCH_OBJECTIVES.includes('boss') && LAUNCH_OBJECTIVES.length === 5);
  let placed = 0, deep = 0, farSection = 0, twoSection = 0, seen = 0, n = 0;
  for (const size of ['small', 'medium', 'large']) {
    for (let k = 0; k < 20; k++) {
      const m = generateHuntMap({ zoneId: REEDS, objective: 'boss', size, seed: 7000 + k, boss: 'mourning_beast' });
      n++;
      const p = m.objectives.primary;
      const occ = m.occupants.find(o => o.id === p.occupant);
      const reach = reachableFrom(m);
      if (occ?.kind === 'boss' && occ.boss === 'mourning_beast' && occ.lair && reach.has(occ.tile) && occ.roster.length === 4) placed++;
      const max = Math.max(...reach.values());
      if (occ && reach.get(occ.tile) >= Math.max(2, Math.ceil(max * 0.5))) deep++;
      if (m.sections.length > 1) { twoSection++; if (parseTileId(occ.tile).section === Math.max(...m.sections.map(s => s.index))) farSection++; }
      if (occ && occupantBand(m, occ, 0) === 'identified') seen++;
    }
  }
  check(`every boss map has the boss in its lair, reachable, four parts (${n} maps, 3 sizes)`, placed === n, `${placed}/${n}`);
  check('...deep in: at least half the longest walk from the entry', deep === n, `${deep}/${n}`);
  check('...in the far section of a two-section map', farSection === twoSection, `${farSection}/${twoSection}`);
  check('...and its lair gives it away (identified, even to a party with no Perception)', seen === n);
  const again = (s) => generateHuntMap({ zoneId: REEDS, objective: 'boss', size: 'large', seed: s, boss: 'mourning_beast' });
  check('...deterministic from the seed', JSON.stringify(again(7003)) === JSON.stringify(again(7003)));
  const refuse = (inp) => { try { generateHuntMap({ zoneId: REEDS, size: 'large', seed: 1, ...inp }); return ''; } catch (e) { return e.message; } };
  check('a boss hunt needs its boss; no other hunt may name one', /needs its boss/.test(refuse({ objective: 'boss' })) && /only a boss hunt/.test(refuse({ objective: 'scout', boss: 'mourning_beast' })));
  check('a boss only in its own region', /does not live/.test((() => { try { generateHuntMap({ zoneId: 'bay_of_solace', objective: 'boss', size: 'large', seed: 1, boss: 'mourning_beast' }); return ''; } catch (e) { return e.message; } })()));
}

// =============================================================================
console.log('=== the boss plan: kept at departure ===');
{
  const inst = createItemInstance(MB.plan, { itemLevel: 1 });
  const view = huntPlanView(inst);
  check("the Mourner's Offering names its boss, a Boss objective, a large map", view.boss === 'mourning_beast' && view.objective === 'boss' && view.size === 'large');
  check('...and the map inputs carry the boss', planMapInputs(view).boss === 'mourning_beast');
  check('it can now be picked for the Reeds, with a note on when it is used up', planFitsZone(inst, REEDS).show && !planFitsZone(inst, REEDS).why && /used up once the boss is fought/.test(planFitsZone(inst, REEDS).note || ''));
  GameState.inventory = [inst];
  const dep = takeDeparture({ plan: inst, rationsToPack: 0 });
  check('departing keeps it in the bag and hands the hunt its id', GameState.inventory.some(i => i.instanceId === inst.instanceId)
    && dep.plan.boss === 'mourning_beast' && dep.plan.bossPlanId === inst.instanceId);
  const plain = createItemInstance('plan_scout_small', { itemLevel: 1 });
  GameState.inventory = [plain];
  takeDeparture({ plan: plain, rationsToPack: 0 });
  check('an ordinary plan is still used up at departure', GameState.inventory.length === 0);
}

// =============================================================================
console.log('=== the lair: its warning, then the fight ===');
function atLair(s = 515) {
  const party = makeParty();
  const w = world(party);
  const inst = createItemInstance(MB.plan, { itemLevel: 1 });
  const h0 = createMapHunt(REEDS, { plan: { ...planMapInputs(huntPlanView(inst)), itemLevel: 1, bossPlanId: inst.instanceId }, supplies: 300, seed: s }, w);
  const d = h0.serialize();
  const lair = d.map.occupants.find(o => o.kind === 'boss');
  // Stand beside it: clear one passable neighbour of whatever else is there.
  const next = mapNeighbors(d.map, lair.tile).find(id => isPassable(d.map.tiles[id]));
  d.map.occupants = d.map.occupants.filter(o => o.tile !== next);
  for (const o of d.map.occupants) o.noticed = true;
  d.pos = next; d.fog[next] = 'visible';
  return { h: restoreMapHunt(d, w), w, party, lair, inst, h0 };
}
{
  const { h, w, lair, inst, h0 } = atLair();
  const mark = h0.view().objectiveSites.find(x => x.objective === 'boss');
  check('the lair is marked from departure', mark?.tile === lair.tile && !mark.done);
  const st0 = h.getState(); const t0 = st0.time, sup0 = st0.supplies, pos0 = st0.pos;
  const r = h.move(lair.tile);
  const st1 = h.getState();
  check('a plain move onto the lair is refused with its warning, and costs nothing', !r.ok && r.lair?.name === MB.lair.name && r.lair.tile === lair.tile
    && st1.time === t0 && st1.supplies === sup0 && st1.pos === pos0 && !h.encounter(), r.reason);
  check('enterLair on a tile with no lair is refused', !h.enterLair(pos0).ok);
  const e = h.enterLair(lair.tile);
  check('confirming (enterLair) steps in and the boss fight is on', e.ok && h.encounter()?.kind === 'boss' && h.encounter().occId === lair.id);
  const spec = h.fightSpec();
  check('the fight: its four parts, in their own slots and names', spec.ok && spec.scenario.boss === 'mourning_beast'
    && JSON.stringify(spec.scenario.enemies.map(x => [x.type, x.slotId])) === JSON.stringify(MB.fight.members.map(m => [m.type, m.slotId]))
    && spec.scenario.enemies.every((x, i) => x.name === MB.fight.members[i].name), JSON.stringify(spec.scenario.enemies.map(x => x.name)));
  check('reading the fight does not use the plan up', w.spent.length === 0);
  h.beginFight();
  check('beginning the fight uses the boss plan up, by its id', JSON.stringify(w.spent) === JSON.stringify([inst.instanceId]));
  h.flee();
  const back = restoreMapHunt(JSON.parse(JSON.stringify(h.serialize())), w);
  back.enterLair(lair.tile);
  back.beginFight();
  check('...once only: fleeing, reloading and going back in spends nothing more', w.spent.length === 1);
}

// =============================================================================
console.log('=== the fight in the real CombatScene ===');
{
  const { h, w, party, lair } = atLair(516);
  h.enterLair(lair.tile);
  const spec = h.beginFight();
  const host = createCombatHost(CombatScene);
  host.__begin({ party, partySlots: slotMapFor(party), huntFight: { ...spec, hunt: h } });
  const foes = host.enemies.map(e => ({ name: e.name, slot: e._slot?.slotId ?? e.slotId, hp: e.maxHP }));
  check('the board holds the four parts where the boss data puts them', foes.length === 4
    && MB.fight.members.every(m => foes.some(f => f.name === m.name && f.slot === m.slotId)), JSON.stringify(foes));
  // Strong hunters, so the checks are about the hand-back, not the balance.
  for (const u of party) { u.maxHP = 99999; u.currentHP = 99999; }
  seed(88);
  const basicAttack = (hh, actor) => {
    const atk = (actor.skills || []).find(s => s.id === 'basic_attack');
    const target = hh.enemies.find(e => e.currentHP > 0);
    return atk && target ? [{ ability: atk, target }] : [];
  };
  runFight(host, basicAttack, { maxTurns: 2000 });
  const st = h.getState();
  check('won through the real victory path: the boss leaves the map, the kill is recorded as the boss', host.combatEnded
    && !st.map.occupants.some(o => o.id === lair.id) && st.kills.some(k => k.occId === lair.id && k.boss === 'mourning_beast'));
  check('the Boss objective is done', h.objectives()[0].done === true);
  check('the save learns the boss was slain (boss_slain:mourning_beast)', w.flags.includes('boss_slain:mourning_beast'));
  check('a boss leaves no beast spoils to harvest', !st.spoils);
}

// =============================================================================
console.log('=== 14b-4b: the Head and Body share one pool; its end is the whole boss ===');
function bossBoard(s = 517) {
  const { h, w, party, lair } = atLair(s);
  h.enterLair(lair.tile);
  const spec = h.beginFight();
  const host = createCombatHost(CombatScene);
  host.__begin({ party, partySlots: slotMapFor(party), huntFight: { ...spec, hunt: h } });
  startCombat(host);
  const by = (n) => host.enemies.find(e => e.name.includes(n));
  return { host, h, w, party, by, head: by('Head'), body: by('Body'), left: by('Left'), right: by('Right') };
}
const hit = (b, target) => {
  const hunter = b.party.find(c => c.status !== 'incapacitated');
  setActor(b.host, hunter);
  hunter.actionsLeft = { major: 1, bonus: 1, class: 1, reaction: 1 };
  const atk = hunter.skills.find(x => x.id === 'basic_attack');
  return cast(b.host, hunter, atk, target);
};
{
  const b = bossBoard();
  const max0 = b.head.maxHP;
  check('Head and Body show one pool: the same HP and max, the two parts combined', b.head.currentHP === b.body.currentHP && b.head.maxHP === b.body.maxHP
    && b.head._pool === b.body._pool && max0 > 800, `pool ${b.head.currentHP}/${max0}`);
  check('...the Limbs keep their own', !b.left._pool && !b.right._pool && b.left.maxHP < 300);
  seed(5); b.head._pool.hp = max0;
  let r = null;
  for (let i = 0; i < 5 && b.head.currentHP === max0; i++) r = hit(b, b.head);
  const afterHead = b.body.currentHP;
  check('a real hit on the Head lowers the Body too (the same pool)', afterHead < max0 && b.head.currentHP === afterHead, `${max0} -> ${afterHead}`);
  for (let i = 0; i < 5 && b.body.currentHP === afterHead; i++) hit(b, b.body);
  check('...and a hit on the Body lowers the Head', b.head.currentHP < afterHead && b.head.currentHP === b.body.currentHP, `${afterHead} -> ${b.head.currentHP}`);
  check('a plain copy of a part (what the co-op server reads, u.currentHP) carries the pool', ({ ...b.head }).currentHP === b.head.currentHP && ({ ...b.body }).maxHP === b.head.maxHP);

  // A Limb falls on its own; the fight goes on.
  b.left.currentHP = 1;
  for (let i = 0; i < 10 && b.left.status !== 'incapacitated'; i++) hit(b, b.left);
  check('a Limb can fall alone, and the fight goes on', b.left.status === 'incapacitated' && !b.host.combatEnded && b.head.status !== 'incapacitated' && b.right.status !== 'incapacitated');

  // The pool's last point: the whole boss collapses, and the hunt is won.
  b.head._pool.hp = 1;
  for (let i = 0; i < 10 && !b.host.combatEnded; i++) hit(b, b.body);
  check('emptying the pool (a hit on the Body) brings down every part, the Head and the other Limb too',
    [b.head, b.body, b.left, b.right].every(e => e.status === 'incapacitated'), JSON.stringify([b.head, b.body, b.left, b.right].map(e => e.status)));
  check('...and the fight is won through the real victory path, once', b.host.combatEnded && b.h.objectives()[0].done && b.w.flags.filter(f => f === 'boss_slain:mourning_beast').length === 1);
}
{
  const b = bossBoard(518);
  b.head._pool.hp = 1;
  for (let i = 0; i < 10 && !b.host.combatEnded; i++) hit(b, b.head);
  check('the same through the Head', b.host.combatEnded && [b.body, b.left, b.right].every(e => e.status === 'incapacitated'));
}

// =============================================================================
console.log("=== 14b-4c: the kit, the lair's chest ===");
{
  const { griefStacks, GRIEF } = await import('../../data/historicEffects.js');
  const { SKILLS } = await import('../../data/skills.js');
  const { BOSS_HUNT_POINTS, BOSS_XP_MULT } = await import('../../data/bosses.js');
  const { FIGHT_XP_POOL } = await import('../../src/systems/HuntEngine.js');
  const kits = ['hunt_mourning_head', 'hunt_mourning_body', 'hunt_mourning_limb'];
  const { ENEMY_TYPES } = await import('../../data/enemyTypes.js');
  check('every skill in the three kits exists (no silent fizzle from a missing id)', kits.every(k => ENEMY_TYPES[k].skills.every(id => SKILLS[id])));

  const b = bossBoard(520);
  const alive = () => b.party.filter(c => c.status !== 'incapacitated');
  setActor(b.host, b.head); b.head.actionsLeft = { major: 1, bonus: 1, class: 1, reaction: 1 }; b.head.currentMP = b.head.maxMP;
  // The board may open on the boss's turn (it can keen first): start from no Grief.
  for (const c of b.party) c.statusEffects = (c.statusEffects || []).filter(se => se?.id !== 'grief');
  check('Heart of Grief cannot be cast while no one grieves', !!b.host._abilityActorGateReason(b.body, SKILLS.mourning_heart_of_grief), String(b.host._abilityActorGateReason(b.body, SKILLS.mourning_heart_of_grief)));
  b.head.cooldowns = {};   // it may have keened on its opening turn
  const lamentAt = b.host._validTargetsFor(b.head, SKILLS.mourning_lament).map(sl => sl.char)[0];
  cast(b.host, b.head, SKILLS.mourning_lament, lamentAt);
  check('Lament: every hunter it reaches grieves (1 Grief each)', alive().every(c => griefStacks(c) === 1), alive().map(c => griefStacks(c)).join(','));
  const stacks = alive().reduce((t, c) => t + griefStacks(c), 0);
  b.head._pool.hp = Math.floor(b.head._pool.max / 2);
  const before = b.body.currentHP;
  setActor(b.host, b.body); b.body.actionsLeft = { major: 1, bonus: 1, class: 1, reaction: 1 }; b.body.currentMP = b.body.maxMP;
  check('...then Heart of Grief can be', !b.host._abilityActorGateReason(b.body, SKILLS.mourning_heart_of_grief));
  cast(b.host, b.body, SKILLS.mourning_heart_of_grief, b.body);
  const want = Math.floor(b.body.maxHP * Math.min(25, 3 * stacks) / 100);
  check(`Heart of Grief heals the shared pool 3% a Grief stack (${stacks} stacks: +${want})`, b.body.currentHP - before === want && b.head.currentHP === b.body.currentHP, `+${b.body.currentHP - before}`);

  // The chest: the Historic item while it is in the wild, nothing while held.
  const win = (inWild, s0) => {
    const { h, w, party, lair } = atLair(s0);
    w.historicInWild = () => inWild;
    const paid = []; w.awardHuntPoints = (n) => paid.push(n);
    h.enterLair(lair.tile);
    const spec = h.beginFight();
    const r = (h.getState().encounter && h.winEncounter({})) || null;
    return { h, r, spec, paid };
  };
  const wild = win(true, 530);
  const burden = wild.h.getState().pack.found.find(i => i.id === MB.historic);
  check("the lair's chest: Burden of Dreams while it is in the wild, into the pack (at risk until the exit)", !!burden && wild.r.chest === MB.historic);
  check('...rolled within its ranges (a Historic copy, not a plain base)', !!burden?.historicRolls);
  const held = win(false, 530);
  check('...and nothing while it is held', !held.h.getState().pack.found.some(i => i.id === MB.historic) && !held.r.chest);
  check(`a boss kill pays ${BOSS_HUNT_POINTS} Hunt Points and a fight XP pool x${BOSS_XP_MULT}`, JSON.stringify(held.paid) === JSON.stringify([BOSS_HUNT_POINTS]) && held.spec.xpPool === FIGHT_XP_POOL * BOSS_XP_MULT);
  const again = win(true, 530);
  check('the chest is rolled from the hunt seed: the same hunt, the same copy', JSON.stringify(again.h.getState().pack.found.find(i => i.id === MB.historic)?.historicRolls) === JSON.stringify(burden?.historicRolls));

  // A realm holds one: a co-op guest's take-home never banks a second copy.
  const { GAME_WORLD } = await import('../../src/systems/HuntManager.js');
  GameState.inventory = [];
  GAME_WORLD.bankItems([createItemInstance(MB.historic, {})], { found: true });
  GAME_WORLD.bankItems([createItemInstance(MB.historic, {})], { found: true });
  check('banking: the first copy lands, a second is refused (one of each in the realm)', GameState.inventory.filter(i => i.id === MB.historic).length === 1);
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
