// tools/headless/bosscal.mjs
//
// Boss calibration (chunk 14b-4c). The owner's target: a boss is about
// Gorrek Reckoning III for a prepared level 4-5 party. This plays the SAME
// party, with the SAME autopilot as the hunt simulator (fightPlayer.js), the
// SAME seeds, against Gorrek R3 and against a boss, and prints both side by side:
// win rate, rounds, the party's HP left, hunters down.
//
//   node tools/headless/bosscal.mjs [--levels 4,5] [--seeds 20] [--boss mourning_beast]
//   node tools/headless/bosscal.mjs --save FILE [--seeds 20]
//
// --save plays the party of an exported save (loaded through the game's own
// loader, full HP/MP), which is the owner's anchor: their level 5 party clears
// Gorrek Reckoning V. Without it, the bare fixture party at each level.
//
// Not in verify: a measuring tool whose numbers are meant to move when tuning.

const store = new Map();
globalThis.localStorage = {
  get length() { return store.size; }, key: (i) => [...store.keys()][i] ?? null,
  getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); }, clear: () => store.clear(),
};
const { installPhaserStub, seed } = await import('./phaserStub.js');
installPhaserStub(51);
const realLog = console.log.bind(console);
const quiet = () => { console.log = () => {}; console.warn = () => {}; console.info = () => {}; };
quiet();

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; };
const LEVELS = arg('--levels', '4,5').split(',').map(Number);
const SEEDS = Number(arg('--seeds', '20'));
const BOSS = arg('--boss', 'mourning_beast');
const GORREK = 'training_encounter_6_reckoning_3';

const { BOSSES } = await import('../../data/bosses.js');
const { createMapHunt, restoreMapHunt } = await import('../../src/systems/HuntEngine.js');
const { mapNeighbors } = await import('../../src/systems/HuntMapGen.js');
const { isPassable } = await import('../../data/grounds.js');
const { makeParty, slotMapFor } = await import('./fixtures.js');
const { createCombatHost } = await import('./combatHost.js');
const { runFight } = await import('./fight.js');
const { fightPlayer } = await import('./fightPlayer.js');
const { makeRng } = await import('../../src/systems/seededRng.js');
const fs = await import('node:fs');
const GameState = (await import('../../src/systems/GameState.js')).default;
const { parseImport } = await import('../../src/systems/SaveTransfer.js');
const SAVE_TEXT = arg('--save', null) ? fs.readFileSync(arg('--save', null), 'utf8') : null;
/** A fresh party each fight: the save's (at full HP/MP) or the fixtures'. */
function freshParty(level) {
  if (!SAVE_TEXT) { const party = makeParty(undefined, { level }); return { party, slots: slotMapFor(party) }; }
  const parsed = parseImport(SAVE_TEXT);
  if (!parsed.ok) throw new Error('--save: ' + parsed.reason);
  localStorage.setItem('bmSave___bosscal', JSON.stringify(parsed.save));
  if (!GameState.load('__bosscal')) throw new Error('--save: the game refused it: ' + GameState.lastLoadError);
  const party = GameState.party.slice();
  for (const c of party) { c.status = 'active'; c.currentHP = c.maxHP; c.currentMP = c.maxMP; }
  return { party, slots: { ...GameState.partySlots } };
}
const CombatSceneMod = await import('../../src/scenes/CombatScene.js');
const CombatScene = CombatSceneMod.default || Object.values(CombatSceneMod).find(v => typeof v === 'function');

const def = BOSSES[BOSS];
if (!def) throw new Error(`no boss '${BOSS}'`);

/** The boss's fight spec from a real boss hunt, the party standing at the lair. */
function bossSpec(party, s) {
  const w = { party: () => party, nightFalls() {}, dayBreaks() {}, bankItems() {}, awardHuntPoints() {}, awardXP() {}, favor() {},
    rivalDevotion() {}, tribeRep() {}, lore() {}, omens() {}, questFlag() {}, hasQuestFlag: () => false, followedHouse: () => null,
    houseHolder: () => null, ownTribe: () => null, tribeName: (t) => t, historicInWild: () => false };
  const h0 = createMapHunt(def.zone, { plan: { objective: 'boss', size: 'large', boss: BOSS, itemLevel: 1 }, supplies: 300, seed: 9100 + s }, w);
  const d = h0.serialize();
  const lair = d.map.occupants.find(o => o.kind === 'boss');
  const next = mapNeighbors(d.map, lair.tile).find(id => isPassable(d.map.tiles[id]));
  d.map.occupants = d.map.occupants.filter(o => o.tile !== next);
  for (const o of d.map.occupants) o.noticed = true;
  d.pos = next; d.fog[next] = 'visible';
  const h = restoreMapHunt(d, w);
  h.enterLair(lair.tile);
  return { ...h.beginFight(), hunt: h };
}

function play(level, s, which) {
  const { party, slots } = freshParty(level);
  const host = createCombatHost(CombatScene);
  if (which === 'boss') host.__begin({ party, partySlots: slots, huntFight: bossSpec(party, s) });
  else host.__begin({ party, partySlots: slots, scenarioId: GORREK });
  seed(1000 + s);
  const res = runFight(host, fightPlayer(makeRng((7000 + s) >>> 0)), { maxTurns: 3000 });
  const won = host.combatEnded && host.enemies.filter(e => !e.isAdd).every(e => e.status === 'incapacitated');
  const alive = party.filter(c => c.status !== 'incapacitated' && c.status !== 'dead');
  return {
    won, ended: res.ended,
    // How often each boss skill landed in the log (its name in a 'uses X' line).
    casts: which === 'boss' ? Object.fromEntries(['Lament', 'Heart of Grief', 'Mourning Grasp'].map(n => [n, host.__logLines().filter(l => l.includes('uses ' + n)).length])) : null,
    rounds: host.combatRound - (host._combatStartRound ?? 1) + 1,
    hpLeft: party.reduce((t, c) => t + Math.max(0, c.currentHP), 0) / party.reduce((t, c) => t + c.maxHP, 0),
    // From the log: a victory stands the party back up before anyone could count them.
    down: new Set(host.__logLines().filter(l => /has been knocked out!/.test(l)).map(l => l.replace(/ has been knocked out!.*/, '')).filter(n => party.some(c => c.name === n))).size,
  };
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const r1 = (x) => Math.round(x * 10) / 10;
const t0 = Date.now();
realLog(`boss calibration: ${def.fight.name} vs Gorrek R3, same party/autopilot/seeds, ${SEEDS} fights each`);
if (SAVE_TEXT) { const { party } = freshParty(0); realLog('  --save party: ' + party.map(c => `${c.name} L${c.level} ${c.maxHP} HP`).join(', ')); }
for (const level of (SAVE_TEXT ? ['save'] : LEVELS)) {
  for (const which of ['gorrek', 'boss']) {
    const rs = Array.from({ length: SEEDS }, (_, s) => play(level, s, which));
    realLog(`  L${level} ${which === 'boss' ? def.fight.name.padEnd(20) : 'Gorrek R3'.padEnd(20)} win ${r1(100 * mean(rs.map(r => (r.won ? 1 : 0))))}%  rounds ${r1(mean(rs.map(r => r.rounds)))}  party HP left ${r1(100 * mean(rs.map(r => r.hpLeft)))}%  hunters down ${r1(mean(rs.map(r => r.down)))}  unfinished ${rs.filter(r => !r.ended).length}${which === 'boss' ? '  casts/fight ' + Object.keys(rs[0].casts).map(k => k + ' ' + r1(mean(rs.map(r => r.casts[k])))).join(', ') : ''}`);
  }
}
realLog(`${Date.now() - t0} ms`);
