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
//   - chunk 9c, flee inside the fight: on a hunter's turn, every living enemy
//     takes exactly one turn and no hunter does, then the hunt takes the flee
//     (retreat, the pack hunting, nothing kept); knock-outs in that round are
//     counted and stand up at 1 HP; the last hunter falling in it is a wipe
//   - Unbroken: not done before a fight is won, done after a clean win,
//     broken by a win with a knock-out
//   - food for the fight: a Fine camp meal with Ember Pepper leaves a clockless
//     fight buff that survives a reload; beginFight hands it over and uses it
//     up; every standing hunter starts the fight with it; and the same seeded
//     Basic Attack hits harder with it (the consumer, measured)
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
function meet({ kind, zones = ZONES, from = 100, tries = 120, planMods = {}, party = () => makeParty(), size = 'medium', bonus = [] }) {
  for (let seedN = from; seedN < from + tries; seedN++) {
    for (const zoneId of zones) {
      const p = party();
      const world = recordingWorld(p);
      const h = createMapHunt(zoneId, { plan: { objective: 'cull', size, mods: planMods, bonusObjectives: bonus }, supplies: 300, seed: seedN }, world);
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

// =============================================================================
// Chunk 9c: flee inside the fight, knock-outs for Unbroken, food for the fight
// =============================================================================
const { startCombat, setActor, cast } = await import('./fight.js');
const { hunterExploration, partyStats } = await import('../../src/systems/PartyStats.js');
const { cookDish } = await import('../../src/systems/HuntRules.js');
const { SKILLS } = await import('../../data/skills.js');

const alive = (u) => u && u.status !== 'incapacitated' && (u.currentHP ?? 1) > 0;

/** Drive enemy turns until a hunter's turn comes up (or the fight ends). */
function toPartyTurn(host) {
  for (let i = 0; i < 60 && !host.combatEnded; i++) {
    const c = host._currentChar();
    if (c && !c.isEnemy) return c;
    const before = host.currentTurnIndex;
    host.__drain();
    if (host.currentTurnIndex === before && !host.combatEnded && host._currentChar()?.isEnemy) {
      host._takeEnemyTurn_viaLogic(host._currentChar());
      host.__drain();
    }
  }
  return host.combatEnded ? null : host._currentChar();
}

/** After _startFlee: let the free round play out, the way runFight drives enemies. */
function playFreeRound(host) {
  for (let i = 0; i < 60 && !host.combatEnded; i++) {
    const before = host.currentTurnIndex;
    host.__drain();
    const c = host._currentChar();
    if (!host.combatEnded && host.currentTurnIndex === before && c?.isEnemy) {
      host._takeEnemyTurn_viaLogic(c);
      host.__drain();
    }
  }
}

/** A fresh host on the hunt's pending fight, started the way the map scene now
 *  starts one (beginFight: the spec plus the "next fight" food buff). */
function hostBegun(m) {
  const spec = m.h.beginFight();
  const host = createCombatHost(CombatScene);
  host.__begin({ party: m.party, partySlots: slotMapFor(m.party), huntFight: { ...spec, hunt: m.h } });
  return { host, spec };
}

console.log('=== flee inside the fight: the free round ===');
{
  const m = meet({ kind: 'beast', from: 1500 });
  check('found a beast fight to flee from', !!m);
  const { host } = hostBegun(m);
  for (const u of m.party) { u.maxHP = 9999; u.currentHP = 9999; }
  seed(41);
  startCombat(host);
  const actor = toPartyTurn(host);
  const living = host.enemies.filter(alive).map(e => e.uid).sort();
  const s0 = m.h.getState();
  const started = [];
  const origStart = host._startTurnStatusEffects;
  host._startTurnStatusEffects = function (c) { started.push(c); return origStart.call(this, c); };
  host._startFlee();
  playFreeRound(host);
  const s1 = m.h.getState();
  const occ = s1.map.occupants.find(o => o.id === s0.encounter.occId);
  check('on a hunter\'s turn, Flee starts the free round', !!actor && !actor.isEnemy);
  check('every living enemy takes exactly one turn, and no hunter does',
    same(started.filter(c => c.isEnemy).map(c => c.uid).sort(), living) && !started.some(c => !c.isEnemy),
    `${started.length} turns for ${living.length} enemies`);
  check('then the fight ends as a flee: the hunt retreats, the pack stays and hunts the party',
    host.combatEnded && !s1.encounter && s1.flees === s0.flees + 1 && !!occ && occ.state === 'hunting'
    && s1.log.some(l => l.kind === 'flee' && l.reason === 'fled') && s1.pos !== s0.pos,
    `flees ${s0.flees} -> ${s1.flees}, pack ${occ?.state}`);
  check('nothing from a fled fight is kept: no kill, no Hunt Points', s1.kills.length === s0.kills.length && m.world.paid.length === 0);
}
{
  // Knock-outs during the free round stand back up at 1 HP, and are counted.
  const m = meet({ kind: 'beast', from: 1600 });
  const { host } = hostBegun(m);
  seed(43);
  startCombat(host);
  const actor = toPartyTurn(host);
  for (const u of m.party) { if (u !== actor) { u.currentHP = 1; } else { u.maxHP = 9999; u.currentHP = 9999; } }
  let koAtEnd = -1;
  const origFled = host._onCombatFled;
  host._onCombatFled = function () { koAtEnd = GameState.party.filter(c => c.status === 'incapacitated').length; return origFled.call(this); };
  host._startFlee();
  playFreeRound(host);
  const s1 = m.h.getState();
  check('hunters knocked out in the free round are counted for Unbroken, then stand at 1 HP',
    koAtEnd > 0 && s1.knockouts === koAtEnd && m.party.every(c => c.status !== 'incapacitated' && c.status !== 'dead' && c.currentHP >= 1),
    `${koAtEnd} knocked out, hunt counts ${s1.knockouts}; party ${m.party.map(c => c.status + "/" + c.currentHP).join(" ")}`);
}
{
  // A wipe during the free round is a wipe, not a flee.
  const m = meet({ kind: 'beast', from: 1700 });
  const { host } = hostBegun(m);
  seed(47);
  startCombat(host);
  const actor = toPartyTurn(host);
  for (const u of m.party) if (u !== actor) host._onUnitKnockedOut(u);
  actor.currentHP = 1;
  for (const e of host.enemies) { e.derived.Accuracy = 500; }
  host._startFlee();
  playFreeRound(host);
  const s1 = m.h.getState();
  check('if the last hunter falls in the free round, it is a wipe (Sheltered), not a flee',
    s1.finished === 'wipe' && !s1.log.some(l => l.kind === 'flee' && l.reason === 'fled'), `finished ${s1.finished}`);
}

console.log('=== Unbroken: knock-outs in won fights ===');
{
  const m = meet({ kind: 'beast', from: 1800, bonus: ['unbroken'] });
  check('found a hunt with Unbroken and a fight', !!m && m.h.objectives().some(o => o.id === 'unbroken'));
  const ub = () => m.h.objectives().find(o => o.id === 'unbroken');
  check('before any fight is won, Unbroken is not done (a hunt that fought nothing is untested)', ub().done === false && !ub().pending);
  const { host } = hostBegun(m);
  for (const u of m.party) { u.maxHP = 9999; u.currentHP = 9999; }
  seed(53);
  runFight(host, basicAttack, { maxTurns: 800 });
  check('a clean win: Unbroken is done', m.h.getState().knockouts === 0 && ub().done === true);
  // A second fight, won with one hunter knocked out, breaks it for the hunt.
  let e = m.h.encounter();
  for (let i = 0; i < 120 && !e; i++) {
    const v = m.h.view();
    const target = m.h.getState().map.occupants.find(o => (o.kind === 'beast' || o.kind === 'cultist') && v.moves.some(mv => mv.tile === o.tile));
    if (!v.moves.length) break;
    m.h.move(target ? target.tile : v.moves[i % v.moves.length].tile);
    e = m.h.encounter();
  }
  if (e) {
    const { host: h2 } = hostBegun(m);
    startCombat(h2);
    h2._onUnitKnockedOut(m.party[0]);
    seed(59);
    runFight(h2, basicAttack, { maxTurns: 800 });
    check('a win with a hunter knocked out: counted, and Unbroken is broken for the hunt', m.h.getState().knockouts >= 1 && ub().done === false,
      `knockouts ${m.h.getState().knockouts}`);
  } else {
    check('found a second fight for Unbroken', false);
  }
}

console.log('=== food for the fight: from a camp meal to the damage ===');
{
  // The best cook takes two Cooking picks (levels 2 and 4): 45 + 20 = 65, what
  // a Fine fish-and-pepper dish needs (30 + 15 + FINE_MARGIN 20).
  const cookParty = () => {
    const p = makeParty();
    const best = [...p].sort((a, b) => hunterExploration(b).ratings.cooking - hunterExploration(a).ratings.cooking)[0];
    best.exploration = { picks: { 2: { rating: 'cooking' }, 4: { rating: 'cooking' } } };
    return p;
  };
  const m = meet({ kind: 'beast', from: 1900, party: cookParty });
  const data = m.h.serialize();
  data.pack.found.push(makeStack('raw_fish', 1), makeStack('ember_pepper', 1));
  const world = recordingWorld(m.party);
  const h = restoreMapHunt(data, world);   // the pending fight resolves as a flee
  const cooking = partyStats(m.party, {}).cooking;
  const dish = cookDish(Items.raw_fish, Items.ember_pepper, cooking);
  check('the party can cook it Fine, and the dish carries a "next fight" buff', dish.quality === 'fine' && dish.buff?.duration === 'fight', `Cooking ${cooking}, ${dish.quality}`);
  const c = h.camp({ meals: [{ main: 'raw_fish', addition: 'ember_pepper' }] });
  const fb = h.view().foodBuff;
  check('camp: the Fine meal leaves the fight buff on the hunt, with no clock', c.ok && fb?.fight === true && fb.field === 'AttackPower' && fb.until === undefined && fb.source === 'ember_pepper', JSON.stringify(fb));
  // Survives a reload.
  const back = restoreMapHunt(JSON.parse(JSON.stringify(h.serialize())), world);
  check('the fight buff survives a save and reload', back.view().foodBuff?.fight === true);
  // Walk into a fight and begin it.
  let e = h.encounter();
  for (let i = 0; i < 150 && !e; i++) {
    const v = h.view();
    const target = h.getState().map.occupants.find(o => (o.kind === 'beast' || o.kind === 'cultist') && v.moves.some(mv => mv.tile === o.tile));
    if (!v.moves.length) break;
    h.move(target ? target.tile : v.moves[i % v.moves.length].tile);
    e = h.encounter();
  }
  check('walked into a fight with the buff held', !!e && h.view().foodBuff?.fight === true);
  if (e) {
    const spec = h.beginFight();
    check('beginFight hands the buff to the fight and uses it up (logged)', spec.ok && spec.foodBuff?.field === 'AttackPower' && spec.foodBuff.amount === 10
      && h.view().foodBuff === null && h.getState().log.some(l => l.kind === 'fight' && l.food === 'ember_pepper'));
    const host = createCombatHost(CombatScene);
    host.__begin({ party: m.party, partySlots: slotMapFor(m.party), huntFight: { ...spec, hunt: h } });
    const standing = m.party.filter(alive);
    check('every standing hunter starts the fight with the food status', standing.length > 0
      && standing.every(u => u.statusEffects.some(se => se.id === 'hunt_food_buff' && se.mods?.AttackPower === 10)));
    // The consumer: the same Basic Attack, same seed, with and without the
    // status, lands harder with it.
    let measured = null;
    for (let k = 0; k < 20 && !measured; k++) {
      const hit = (withBuff) => {
        const p = makeParty();
        const hh = createCombatHost(CombatScene);
        hh.__begin({ party: p, partySlots: slotMapFor(p), huntFight: { ...spec, foodBuff: withBuff ? spec.foodBuff : null, hunt: { winEncounter: () => ({}), wipe: () => ({}), flee: () => ({}) } } });
        const me = p[0], foe = hh.enemies[0];
        foe.maxHP = 99999; foe.currentHP = 99999;
        me.actionsLeft = { major: 1, bonus: 1, class: 1, reaction: 1 };
        setActor(hh, me);
        seed(700 + k);
        cast(hh, me, me.skills.find(s => s.id === 'basic_attack'), foe);
        return 99999 - foe.currentHP;
      };
      const a = hit(true), b = hit(false);
      if (b > 0) measured = { a, b };
    }
    check('the consumer: the same seeded Basic Attack hits harder with the buff', !!measured && measured.a > measured.b,
      measured ? `${measured.b} -> ${measured.a} damage` : 'no hit landed');
  }
}

// =============================================================================
// Chunk 9d: harvest, meat, stacking, Trophy, and a whole small hunt
// =============================================================================
let golden9d = null;
const O = await import('../../src/systems/HuntObjectives.js');
const { equipItem } = await import('../../src/systems/CharacterBuilder.js');
const { canStack, partMaterial } = await import('../../src/systems/ItemStacks.js');

/** Win the pending fight for real (a strong party), through the host. */
function winPending(m, s = 61) {
  const { host } = hostBegun(m);
  for (const u of m.party) { u.maxHP = 9999; u.currentHP = 9999; }
  seed(s);
  runFight(host, basicAttack, { maxTurns: 800 });
  return host;
}
/** Walk (by true positions: test code) to the next hostile and into it. */
function walkToFight(h, pred = (o) => o.kind === 'beast' || o.kind === 'cultist') {
  for (let i = 0; i < 400 && !h.encounter(); i++) {
    const st = h.getState();
    if (st.finished) return false;
    const targets = new Set(st.map.occupants.filter(pred).map(o => o.tile));
    if (!targets.size) return false;
    const prev = new Map([[st.pos, null]]); const q = [st.pos]; let goal = null;
    for (let k = 0; k < q.length && !goal; k++) for (const n of mapNeighbors(st.map, q[k])) {
      if (prev.has(n) || !isPassable(st.map.tiles[n])) continue;
      prev.set(n, q[k]); q.push(n); if (targets.has(n)) { goal = n; break; }
    }
    if (!goal) return false;
    let t = goal; while (prev.get(t) !== st.pos) t = prev.get(t);
    h.move(t);
  }
  return !!h.encounter();
}
const { mapNeighbors } = await import('../../src/systems/HuntMapGen.js');
const { isPassable } = await import('../../data/grounds.js');

console.log('=== harvest: the spoils of a won beast fight ===');
{
  const m = meet({ kind: 'beast', from: 2100 });
  const occId = m.h.encounter().occId;
  const occ0 = m.h.getState().map.occupants.find(o => o.id === occId);
  winPending(m);
  const v = m.h.view();
  const sp = v.spoils;
  const partsWorn = occ0.loadout.flatMap(g => Object.values(g));
  check('a won beast fight leaves spoils: every part its members wore, one body each', !!sp && sp.parts.length === partsWorn.length && sp.bodies === occ0.roster.length,
    sp ? `${sp.parts.length} parts, ${sp.bodies} bodies` : 'none');
  check('...showing each part\'s name, rarity and grade, but no occupant id', sp.parts.every(p => p.name && p.rarity && p.grade) && !JSON.stringify(sp).includes(`"${occId}"`));
  const st = m.h.stats();
  const meatIds = new Set(occ0.roster.map(r => BP.MEAT_BY_GRADE[r.grade].id));
  check('...and the meat its bodies give, the kinds their grades name', same([...new Set(Object.keys(sp.meat))].sort(), [...meatIds].sort()) && Object.values(sp.meat).every(q => q > 0), JSON.stringify(sp.meat));
  // The yield, through the engine only: the same saved spoils, harvested with
  // and without "of the Harvest" in the hunt's bundle.
  const meatWith = (pct) => {
    const d = JSON.parse(JSON.stringify(m.h.serialize()));
    d.mods.harvestYieldPercent = pct;
    const hh = restoreMapHunt(d, m.world);
    const r0 = hh.harvest({ take: [], meat: true });
    return Object.values(r0.meat || {}).reduce((a, b) => a + b, 0);
  };
  const plain = meatWith(0), rich = meatWith(100);
  check('Foraging\'s yield and of the Harvest raise the meat taken', rich > plain && plain > 0, `${plain} -> ${rich} with harvestYieldPercent 100`);
  // A reload keeps the spoils.
  const back = restoreMapHunt(JSON.parse(JSON.stringify(m.h.serialize())), m.world);
  check('the spoils survive a save and reload', same(back.view().spoils, sp));
  // Harvest: two specimens (if any), every material, and the meat.
  const specimenIds = sp.parts.filter(p => p.specimen).map(p => p.id);
  const materialIds = sp.parts.filter(p => !p.specimen).map(p => p.id);
  const take = [...specimenIds, ...materialIds];
  const t0 = m.h.getState().time;
  const found0 = m.h.getState().pack.found.length;
  const r = m.h.harvest({ take, meat: true });
  const s1 = m.h.getState();
  const factor = 1 - st.harvestTimePercent / 100;
  const want = (sp.parts.reduce((a, p) => a + (p.core ? BP.HARVEST_TIME.core : BP.HARVEST_TIME.peripheral), 0) + sp.bodies * BP.MEAT_TIME_PER_BODY) * factor;
  check('harvest never fails, and costs HARVEST_TIME per part plus the meat, cut by Foraging', r.ok && Math.abs((s1.time - t0) - want) < 1e-9 && Math.abs(r.time - want) < 1e-9,
    `${r.time?.toFixed?.(3)} units (factor ${factor.toFixed(3)})`);
  const specimens = s1.pack.found.filter(it => Items[it.id]?.part && ['rare', 'epic'].includes(it.rarity));
  const byId = new Map(occ0.loadout.flatMap(g => Object.values(g)).map(p => [p.instanceId, p]));
  check('rare and epic parts keep their affixes, each its own specimen (never a lower rarity)',
    specimens.length === specimenIds.length && specimenIds.every(id => { const o = byId.get(id); return specimens.some(sx => sx.instanceId === id && same(sx.instanceMods, o.instanceMods) && sx.rarity === o.rarity); }));
  const mats = s1.pack.found.filter(it => Items[it.id]?.part && !['rare', 'epic'].includes(it.rarity));
  check('common and uncommon parts become plain material: no affixes, grade kept, stacked',
    mats.every(x => !x.prefixes.length && !x.suffixes.length && x.grade) && mats.reduce((a, x) => a + (x.qty || 1), 0) === materialIds.length);
  check('the harvest delivers exactly the meat the spoils showed', same(r.meat, sp.meat)
    && Object.entries(sp.meat).every(([id, q]) => s1.pack.found.filter(it => it.id === id).reduce((a, it) => a + (it.qty || 1), 0) >= q));
  check('the spoils are gone once harvested', m.h.view().spoils === null && s1.pack.found.length > found0);
  check('the log records the harvest', s1.log.some(l => l.kind === 'harvest'));
}
{
  // Walking away leaves them.
  const m = meet({ kind: 'beast', from: 2200 });
  winPending(m);
  const had = !!m.h.view().spoils;
  const mv = m.h.view().moves[0];
  m.h.move(mv.tile);
  check('walking away leaves the spoils: gone, logged, nothing taken', had && m.h.view().spoils === null
    && m.h.getState().log.some(l => l.kind === 'spoils_left') && !m.h.getState().pack.found.some(it => Items[it.id]?.part));
  // A cultist fight leaves no spoils (its armour already dropped into the pack).
  const c = meet({ kind: 'cultist', from: 2300 });
  winPending(c);
  check('a cultist fight leaves no spoils', c.h.view().spoils === null);
}
{
  // Stacking keeps grades apart; a part is never worn.
  const mk = (grade, rarity = 'uncommon') => partMaterial({ id: 'part_marsh_stalker_chest', rarity, grade, itemLevel: 1 }, 1);
  check('material of the same grade and rarity stacks; another grade or rarity does not',
    canStack(mk('grown'), mk('grown')) && !canStack(mk('grown'), mk('prime')) && !canStack(mk('grown'), mk('grown', 'common')));
  check('an item with no grade stacks exactly as before', canStack(makeStack('rations', 1), makeStack('rations', 2)));
  const hunter = makeParty()[0];
  const fang = partMaterial({ id: 'part_marsh_stalker_weaponMain', rarity: 'common', grade: 'grown', itemLevel: 1 }, 1);
  const hide = partMaterial({ id: 'part_marsh_stalker_chest', rarity: 'common', grade: 'grown', itemLevel: 1 }, 1);
  const before = JSON.stringify(hunter.equipment);
  check('a hunter cannot wear a part (not the natural-weapon fangs, not a hide)',
    JSON.stringify(equipItem(hunter, fang, 'weaponMain').equipment) === before && JSON.stringify(equipItem(hunter, hide, 'chest').equipment) === before);
}

console.log('=== Trophy ===');
{
  const m = meet({ kind: 'beast', from: 2400, bonus: ['trophy'] });
  const tr = () => m.h.objectives().find(o => o.id === 'trophy');
  check('a hunt with Trophy: not pending any more, not done at the start', !!tr() && !tr().pending && tr().have === 0);
  // Fight until a Prime-or-better beast has fallen, and take its core parts.
  let got = false;
  for (let k = 0; k < 12 && !got; k++) {
    if (!m.h.encounter() && !walkToFight(m.h, o => o.kind === 'beast' && o.roster.some(x => x.grade === 'prime' || x.grade === 'great'))) break;
    winPending(m, 70 + k);
    const sp = m.h.view().spoils;
    if (!sp) continue;
    const core = sp.parts.filter(p => p.core && (p.grade === 'prime' || p.grade === 'great'));
    m.h.harvest({ take: core.map(p => p.id), meat: false });
    got = core.length > 0;
  }
  check('carrying a core part of a Prime-or-better beast counts for Trophy', got && tr().have >= 1, `have ${tr()?.have}`);
  check('Trophy is only done when carried home (at the exit)', tr().done === false && O.objectiveProgress(m.h.getState(), { atExit: true }).find(o => o.id === 'trophy')?.done === true);
}

console.log('=== a whole small hunt: move, fight, harvest, cook, exit ===');
{
  // The best cook takes two Cooking picks so lean game cooks Fine (20 + 20 margin).
  const party = makeParty();
  const world = recordingWorld(party);
  let h = null, zoneId = null;
  for (let seedN = 3000; seedN < 3060 && !h; seedN++) {
    const cand = createMapHunt('reeds_of_gethsemane', { plan: { objective: 'cull', size: 'small', itemLevel: 1 }, supplies: 120, seed: seedN }, world);
    if (cand.getState().map.objectives.primary.id === 'cull') { h = cand; zoneId = 'reeds_of_gethsemane'; }
  }
  const tally = { fights: 0, harvested: 0, meals: 0, flees: 0 };
  for (let step = 0; step < 40; step++) {
    const prog = h.objectives().find(o => o.kind === 'primary');
    if (prog.done) break;
    const fam = h.getState().map.objectives.primary.family;
    if (!walkToFight(h, o => o.kind === 'beast' && o.family === fam) && !h.encounter()) break;
    const e = h.encounter();
    if (!e) break;
    if (e.kind !== 'beast') { h.flee(); tally.flees++; continue; }
    winPending({ h, party, world }, 90 + step);
    tally.fights++;
    const sp = h.view().spoils;
    if (sp) {
      const r = h.harvest({ take: sp.parts.filter(p => p.rarity !== 'common').map(p => p.id), meat: true });
      if (r.ok) tally.harvested += r.specimens + r.materials;
    }
    // Cook what was butchered.
    const food = h.foodInPack();
    const meatId = Object.keys(food).find(id => Items[id]?.food?.kind === 'meat');
    if (meatId && !h.encounter()) { const c = h.camp({ meals: [{ main: meatId }] }); if (c.ok) tally.meals += c.dishes.length; }
    if (h.encounter()) { const x = h.encounter(); if (x.kind === 'beast' || x.kind === 'cultist') { winPending({ h, party, world }, 150 + step); tally.fights++; h.view().spoils && h.harvest({ take: [], meat: false }); } }
  }
  const primary = h.objectives().find(o => o.kind === 'primary');
  check('the cull is completed by real fights', primary.done, `${primary.have}/${primary.need} after ${tally.fights} fights`);
  check('parts were harvested and meat was cooked on the way', tally.harvested > 0 && tally.meals > 0, JSON.stringify(tally));
  // Walk out.
  const exits = new Set(Object.entries(h.getState().map.tiles).filter(([, t]) => t.exit).map(([id]) => id));
  for (let i = 0; i < 300 && !exits.has(h.getState().pos); i++) {
    const st = h.getState();
    if (h.encounter()) { winPending({ h, party, world }, 200 + i); h.view().spoils && h.harvest({ take: [], meat: false }); continue; }
    const prev = new Map([[st.pos, null]]); const q = [st.pos]; let goal = null;
    for (let k = 0; k < q.length && !goal; k++) for (const n of mapNeighbors(st.map, q[k])) {
      if (prev.has(n) || !isPassable(st.map.tiles[n])) continue;
      prev.set(n, q[k]); q.push(n); if (exits.has(n)) { goal = n; break; }
    }
    if (!goal) break;
    let t = goal; while (prev.get(t) !== st.pos) t = prev.get(t);
    h.move(t);
  }
  const foundBefore = h.getState().pack.found.length;
  const paidBefore = world.paid.reduce((a, b) => a + b, 0);
  const x = h.exit();
  const paidAtExit = world.paid.reduce((a, b) => a + b, 0) - paidBefore;
  check('the party leaves through an exit and the completion reward is paid', x.ok && x.reward.primaryDone && x.reward.completion > 0 && paidAtExit === x.reward.huntPoints,
    x.ok ? `${x.reward.huntPoints} Hunt Points at the exit; ${world.paid.length - 1} fights paid before` : x.reason);
  check('the pack comes home: the harvested parts and what is left of the food are banked',
    world.banked.some(b => b.found && b.n === foundBefore) && foundBefore > 0, `${foundBefore} found entries banked`);
  golden9d = { tally, days: Math.ceil(h.clock().time / 12), exitPoints: x.reward?.huntPoints };
}
console.log(`  (the small hunt: ${JSON.stringify(golden9d)})`);

console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
