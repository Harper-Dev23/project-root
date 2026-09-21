// tools/headless/huntfight.mjs
//
// The combat hookup (Exploration System v2, chunk 9b): a map hunt's encounter
// becomes a REAL fight, run start to finish by the real CombatScene in the
// headless host, and hands its result back to the real hunt. Everything is
// read off the game's own objects; nothing is re-derived.
//
// What it proves:
//   - fightSpec: refused with no encounter; otherwise one enemy per roster
//     member in its real type, on distinct board slots, strongest at the front
//     centre, grade HP scale, a COPY of the kept loadout, cultist armour
//     droppable and beast parts not
//   - on the board: every enemy wears exactly its loadout, its HP is its
//     type's with the loadout's CON times its grade scale, and the hunt's
//     enemy initiative equals the average computeEffectiveInitiative of the
//     enemies actually spawned
//   - party initiative decides the blocks: the side the hunt said acts first
//     opens the fight; each block is sorted by initiative; a non-hunt fight
//     is untouched (party first)
//   - a won fight, through the real victory path: the occupant leaves the map,
//     the kill is recorded, a cultist's armour goes into the PACK (not the camp
//     bag), a beast fight pays BEAST_FIGHT_HUNT_POINTS scaled by the plan's
//     huntPointsPercent, and the XP pool (scaled by xpPercent) reaches the
//     hunters; the three plan fields each move their number
//   - a wipe, through the real defeat path: Sheltered kills nobody, the party
//     is back on its feet at 1 HP+, the hunt is over and the pack came home;
//     Watched sends the fallen to the Slain and loses the pack; an old save's
//     Advance hunt follows its own death rule the same way
//
// USAGE
//   node tools/headless/huntfight.mjs        run the checks (no golden: the
//                                            fights themselves are in the
//                                            combat golden's huntFights section)

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const noIds = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === 'instanceId' || k === '_droppable' ? undefined : x)));

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
installPhaserStub(31);

const { makeParty, slotMapFor } = await import('./fixtures.js');
const { createCombatHost } = await import('./combatHost.js');
const { runFight } = await import('./fight.js');
const CombatSceneMod = await import('../../src/scenes/CombatScene.js');
const CombatScene = CombatSceneMod.default || Object.values(CombatSceneMod).find(v => typeof v === 'function');
const { computeEffectiveInitiative } = await import('../../src/systems/CombatLogic.js');
const GameState = (await import('../../src/systems/GameState.js')).default;
const { createMapHunt, restoreMapHunt, FIGHT_XP_POOL, BEAST_FIGHT_HUNT_POINTS } = await import('../../src/systems/HuntEngine.js');
const { HuntManager } = await import('../../src/systems/HuntManager.js');
const HB = await import('../../src/systems/HuntBeasts.js');
const BP = await import('../../data/beastParts.js');
const { ENEMY_TYPES } = await import('../../data/enemyTypes.js');
const { Items } = await import('../../data/items.js');
const { getItemComputedData } = await import('../../src/systems/ItemFactory.js');
const { calculateDerivedStats } = await import('../../src/systems/CharacterBuilder.js');
const { makeRng } = await import('../../src/systems/seededRng.js');
const { makeStack } = await import('../../src/systems/ItemStacks.js');

const ZONES = ['reeds_of_gethsemane', 'bay_of_solace'];

/** A world that records what the hunt pays and banks. */
function recordingWorld(party) {
  const w = { paid: [], banked: [] };
  w.party = () => party;
  w.nightFalls = () => {}; w.dayBreaks = () => {};
  w.awardHuntPoints = (n) => w.paid.push(n);
  w.bankItems = (items, { found }) => w.banked.push({ found, n: items.length });
  return w;
}

/** Walk a hunt until it meets an encounter of the wanted kind, or give up. */
function meet({ kind, zones = ZONES, from = 100, tries = 120, planMods = {}, party = () => makeParty(), size = 'medium' }) {
  for (let seedN = from; seedN < from + tries; seedN++) {
    for (const zoneId of zones) {
      const p = party();
      const world = recordingWorld(p);
      const h = createMapHunt(zoneId, { plan: { objective: 'cull', size, mods: planMods }, supplies: 300, seed: seedN }, world);
      const pick = makeRng(seedN);
      for (let i = 0; i < 120; i++) {
        const e = h.encounter();
        if (e) {
          if (e.kind === kind) return { h, party: p, world, zoneId, seed: seedN };
          h.flee();
          continue;
        }
        const moves = h.view().moves;
        if (!moves.length) break;
        h.move(moves[Math.floor(pick() * moves.length)].tile);
      }
    }
  }
  return null;
}

/** A fresh host on the hunt's pending fight, exactly as the map scene hands it over. */
function hostFor(found, extra = {}) {
  const spec = found.h.fightSpec();
  const host = createCombatHost(CombatScene);
  const huntFight = { ...spec, hunt: found.h, ...extra };
  host.__begin({ party: found.party, partySlots: slotMapFor(found.party), huntFight });
  return { host, spec, huntFight };
}

const basicAttack = (h, actor) => {
  const atk = (actor.skills || []).find(s => s.id === 'basic_attack');
  const foe = h.enemies.find(e => e.status !== 'incapacitated' && e.currentHP > 0);
  return (atk && foe) ? [{ ability: atk, target: foe }] : [];
};
const doNothing = () => [];

// =============================================================================
console.log('=== fightSpec: the occupant as a scenario ===');
const beastMeet = meet({ kind: 'beast' });
const cultMeet = meet({ kind: 'cultist', from: 300 });
check('found a beast encounter and a cultist encounter on real map hunts', !!beastMeet && !!cultMeet);
{
  const quiet = createMapHunt(ZONES[0], { plan: { objective: 'scout', size: 'small' }, supplies: 60, seed: 5 }, recordingWorld(makeParty()));
  check('fightSpec is refused with no encounter pending', quiet.fightSpec().ok === false);
  for (const [label, m] of [['beast', beastMeet], ['cultist', cultMeet]]) {
    const spec = m.h.fightSpec();
    const s = m.h.getState();
    const occ = s.map.occupants.find(o => o.id === spec.occId);
    const en = spec.scenario.enemies;
    const slots = en.map(e => e.slotId);
    const typesOk = en.every(e => ENEMY_TYPES[e.type]) && en.length === occ.roster.length;
    const rank = { great: 3, prime: 2, grown: 1, yearling: 0 };
    const sorted = en.every((e, i) => i === 0 || (rank[en[i - 1].grade] ?? -1) >= (rank[e.grade] ?? -1));
    check(`${label}: one enemy per member, real types, distinct slots, strongest first at slot 2`,
      typesOk && new Set(slots).size === slots.length && slots[0] === 2 && sorted, `${en.length} enemies, slots ${slots.join(',')}`);
    const copies = en.every(e => Object.values(e.gear).every(g => !occ.loadout.flatMap(Object.values).includes(g)));
    const matches = same(noIds(en.map(e => e.gear).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
      noIds(occ.loadout.map(g => g).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)));
    check(`${label}: each enemy wears a COPY of its member's kept loadout`, copies && matches);
    check(`${label}: grade HP scale on beasts, none on cultists`,
      en.every(e => e.hpMult === (e.grade ? BP.GRADE_HP_SCALE[e.grade] : 1)));
    check(`${label}: ${label === 'cultist' ? 'the armour drops' : 'no part drops (they are harvested, 9d)'}`,
      en.every(e => Object.keys(e.gear).every(sl => !!e.gearDroppable[sl] === (label === 'cultist'))));
    check(`${label}: the XP pool is FIGHT_XP_POOL with no xpPercent`, spec.xpPool === FIGHT_XP_POOL);
  }
}

// =============================================================================
console.log('=== on the board ===');
{
  const { host, spec } = hostFor(beastMeet);
  const bad = [];
  for (const cfg of spec.scenario.enemies) {
    const e = host.enemies.find(x => x._slot?.slotId === cfg.slotId);
    if (!e) { bad.push(`slot ${cfg.slotId}: no enemy`); continue; }
    if (!same(noIds(e.equipment), noIds(cfg.gear))) bad.push(`${e.name}: equipment differs from its loadout`);
    const T = ENEMY_TYPES[cfg.type];
    const stats = { ...(T.baseStats || {}) };
    for (const inst of Object.values(cfg.gear)) for (const [k, v] of Object.entries(getItemComputedData(inst).bonuses || {})) stats[k] = (stats[k] || 0) + v;
    const want = Math.max(1, Math.round((T.maxHP + calculateDerivedStats(stats).maxHP) * cfg.hpMult));
    if (e.maxHP !== want) bad.push(`${e.name}: maxHP ${e.maxHP}, want ${want}`);
  }
  check('every enemy wears exactly its loadout, with its grade-scaled HP', bad.length === 0, bad.slice(0, 3).join('; ') || `${host.enemies.length} enemies`);
  const avg = host.enemies.reduce((a, e) => a + computeEffectiveInitiative(e), 0) / host.enemies.length;
  check('the hunt\'s enemy initiative is the spawned enemies\' average computeEffectiveInitiative',
    Math.abs(avg - spec.enemyInitiative) < 1e-9, `${avg} vs ${spec.enemyInitiative}`);
}

// =============================================================================
console.log('=== who acts first ===');
{
  for (const first of ['party', 'enemy']) {
    const { host } = hostFor(beastMeet, { first });
    const t = host.turnOrder;
    const split = t.findIndex(u => u.isEnemy !== t[0].isEnemy);
    const blocks = [t.slice(0, split), t.slice(split)];
    const sortedIn = blocks.every(b => b.every((u, i) => i === 0 || computeEffectiveInitiative(b[i - 1]) >= computeEffectiveInitiative(u)));
    const clean = blocks.every(b => b.every(u => u.isEnemy === b[0].isEnemy));
    check(`first = ${first}: that block opens, each block sorted by initiative, no interleaving`,
      (first === 'enemy') === !!t[0].isEnemy && sortedIn && clean);
  }
  const plain = createCombatHost(CombatScene);
  const p = makeParty();
  plain.__begin({ party: p, partySlots: slotMapFor(p), scenarioId: 'training_encounter_4' });
  check('a fight that is not a map-hunt fight still opens with the party', !plain.turnOrder[0].isEnemy && !plain.huntFight);
  // A real ambush: an undetected contact hands over first = 'enemy'.
  let ambush = null;
  for (let k = 0; k < 200 && !ambush; k++) {
    const m = meet({ kind: 'beast', from: 900 + k * 3, tries: 3 });
    if (m && m.h.encounter().ambush) ambush = m;
  }
  check('a real ambush hands the enemy the first turn', !!ambush && (() => { const { host } = hostFor(ambush); return host.turnOrder[0].isEnemy; })());
}

// =============================================================================
console.log('=== a won fight ===');
function winIt(m, planLabel) {
  const bagBefore = GameState.inventory.length;
  const s0 = m.h.getState();
  const occId = s0.encounter.occId;
  const xp0 = m.party.map(c => c.experience || 0);
  const { host, spec } = hostFor(m);
  // The party is made strong so the fight is won and the checks are about
  // the hand-back, not the balance.
  for (const u of m.party) { u.maxHP = 9999; u.currentHP = 9999; }
  seed(77);
  runFight(host, basicAttack, { maxTurns: 800 });
  const s1 = m.h.getState();
  return { host, spec, occId, s0, s1, bagBefore, xpGain: m.party.reduce((a, c, i) => a + (c.experience || 0) - xp0[i], 0) };
}
{
  const r = winIt(beastMeet);
  check('beast: the fight is won through the real victory path', r.host.combatEnded && r.host.enemies.every(e => e.currentHP <= 0 || e.status === 'incapacitated'));
  check('beast: the occupant leaves the map and the kill is recorded', !r.s1.map.occupants.some(o => o.id === r.occId) && r.s1.kills.some(k => k.occId === r.occId) && !r.s1.encounter);
  check(`beast: Hunt Points ${BEAST_FIGHT_HUNT_POINTS} paid through the world`, same(beastMeet.world.paid, [BEAST_FIGHT_HUNT_POINTS]), JSON.stringify(beastMeet.world.paid));
  check('beast: no part reached the camp bag or the pack (harvest is 9d)', GameState.inventory.length === r.bagBefore && r.s1.pack.found.length === r.s0.pack.found.length);
  check(`beast: the XP pool (${FIGHT_XP_POOL}) reached the hunters`, r.xpGain > 0, `+${r.xpGain} XP across the party`);

  const c = winIt(cultMeet);
  const armour = c.spec.scenario.enemies.flatMap(e => Object.values(e.gear));
  const packIds = c.s1.pack.found.map(i => i.id + '/' + i.rarity);
  check('cultist: every piece of its armour went into the PACK', armour.every(a => packIds.includes(a.id + '/' + a.rarity)) && armour.length === c.s1.pack.found.length - c.s0.pack.found.length,
    `${armour.length} pieces`);
  check('cultist: none of it reached the camp bag', GameState.inventory.length === c.bagBefore);
  check('cultist: no Hunt Points (its reward is the gear)', cultMeet.world.paid.length === 0);

  // The three plan fields, each moving its number.
  const bonus = meet({ kind: 'beast', planMods: { huntPointsPercent: 50, xpPercent: 100, lootQualityPercent: 100 } });
  const spec = bonus.h.fightSpec();
  check('of Learning: xpPercent 100 doubles the fight\'s XP pool', spec.xpPool === FIGHT_XP_POOL * 2);
  const rb = winIt(bonus);
  check('...and that doubled pool is what the hunters are paid (twice the plain fight\'s XP)', rb.xpGain === 2 * r.xpGain, `+${rb.xpGain} vs +${r.xpGain}`);
  check('of the Hunt: huntPointsPercent 50 pays 1.5x the beast fight\'s Hunt Points', same(bonus.world.paid, [Math.round(BEAST_FIGHT_HUNT_POINTS * 1.5)]), JSON.stringify(bonus.world.paid));
  check('of Plenty: lootQualityPercent reaches the loadout roll through Item Rarity', bonus.h.stats().itemRarity > beastMeet.h.stats().itemRarity);
}

// =============================================================================
console.log('=== a wipe, by the region\'s death rule ===');
function loseIt(m, extra = {}) {
  const { host } = hostFor(m, extra);
  for (const u of m.party) { u.currentHP = 1; }
  for (const e of host.enemies) { e.maxHP = 99999; e.currentHP = 99999; }
  seed(99);
  runFight(host, doNothing, { maxTurns: 800 });
  return host;
}
/**
 * A beast fight pending in a hunt as a save would hold it: the given death
 * rule, and something in the pack's found list so "comes home" and "is lost"
 * have something to move. Restoring resolves the pending fight as a flee
 * (SAVE_COMPATIBILITY rec. 4), so the party walks into the pack again.
 */
function pendingFight(rule, from) {
  const m = meet({ kind: 'beast', from });
  const data = m.h.serialize();
  data.deathRule = rule;
  data.pack.found.push(makeStack('rations', 5));
  const world = recordingWorld(m.party);
  const h = restoreMapHunt(data, world);
  for (let i = 0; i < 80 && !h.encounter(); i++) {
    const v = h.view();
    const target = h.getState().map.occupants.find(o => o.kind === 'beast' && v.moves.some(mv => mv.tile === o.tile));
    if (!v.moves.length) break;
    h.move(target ? target.tile : v.moves[i % v.moves.length].tile);
  }
  return h.encounter() ? { h, party: m.party, world } : null;
}
{
  const sh = pendingFight('sheltered', 500);
  check('found a Sheltered fight to lose', !!sh);
  if (sh) {
    const slain0 = GameState.slain.length;
    let finished = 0;
    const host = loseIt(sh, { onFinished: () => { finished++; } });
    const s = sh.h.getState();
    check('Sheltered: the fight is lost through the real defeat path', host.combatEnded);
    check('Sheltered: nobody dies; every hunter stands at 1 HP or more', GameState.slain.length === slain0 && sh.party.every(c => c.status === 'alive' && c.currentHP >= 1));
    check('Sheltered: the hunt is over as a wipe, the pack came home, nothing paid, the finish hook ran once',
      s.finished === 'wipe' && sh.world.banked.some(b => b.found && b.n > 0) && sh.world.paid.length === 0 && finished === 1);
  }

  const wa = pendingFight('watched', 600);
  check('found a Watched fight to lose', !!wa);
  if (wa) {
    const before = GameState.slain.length;
    const names = wa.party.map(c => c.name);
    loseIt(wa);
    const sw = wa.h.getState();
    check('Watched: every fallen hunter joins the Slain', GameState.slain.length === before + names.length && names.every(n => GameState.slain.some(c => c.name === n)));
    check('Watched: the hunt is over as a wipe and the pack is lost', sw.finished === 'wipe' && wa.world.banked.length === 0);
  }

  // An old save's Advance hunt (both starter zones are Sheltered): the same
  // defeat path, reading the Advance hunt's own death rule. Before 9b this
  // wipe sent the whole party to the Slain.
  {
    const p = makeParty();
    GameState.party = p;
    HuntManager.start('reeds_of_gethsemane', { supplies: 60, seed: 11 });
    const rule = HuntManager.getState().deathRule;
    const slainBefore = GameState.slain.length;
    const host = createCombatHost(CombatScene);
    host.__begin({ party: p, partySlots: slotMapFor(p), scenarioId: 'hunt_beast_solo' });
    host.combatType = 'hunt'; host.isHunt = true;
    for (const u of p) u.currentHP = 1;
    for (const en of host.enemies) { en.maxHP = 99999; en.currentHP = 99999; }
    seed(5);
    runFight(host, doNothing, { maxTurns: 800 });
    const died = GameState.slain.length - slainBefore;
    check(`Advance hunt, ${rule}: a wipe kills nobody (it used to send the party to the Slain)`,
      rule === 'sheltered' && host.combatEnded && died === 0 && p.every(c => c.status === 'alive'), `${died} slain`);
    check('Advance hunt: the wipe ends it', HuntManager.mode() === null);
  }
}

console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
