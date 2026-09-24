// tools/headless/falsegods.mjs
//
// False gods' pacts (Exploration System v2, chunk 11c-1): data/falseGods.js,
// Boons.pactEffects, the temptation events in data/events.js, the pact step
// and its price in HuntEngine, hidden standing through GAME_WORLD, and both
// capstones in the real fight host. Everything is read off the game's own
// objects; nothing is re-derived.
//
// What it proves:
//   - the content: two gods, levels 3-5, every key one the engine reads, a
//     curse each; the Reeds tempt with Dagon, the Bay with Yar'galeth
//   - a pact on a real hunt: accepting the first temptation starts it at 3
//     and ends the prophet's favor; each step pays hidden standing and Bond
//     standing scaled by its level; deeper temptations raise it to 5 and no
//     further; refusing the first earns +1 standing; the first temptation is
//     quiet during a pact and the deeper ones outside one
//   - the pact's effects move their readers (forage yield, supplies per move
//     with its curse, sight, party initiative) and reach the fight (statuses
//     on hunters and enemies); a reload keeps the pact
//   - GAME_WORLD: hidden standing and the Bond price land on the save's
//     standing, devotion untouched, and hidden standing is nowhere in the view
//   - What Waits Below heals a hunter who lands a killing blow; The Word That
//     Is Always True makes each hunter's first attack hit and crit, once
//
// USAGE
//   node tools/headless/falsegods.mjs                 run the checks
//   node tools/headless/falsegods.mjs --json <path>   write the golden
//   node tools/headless/falsegods.mjs --diff <path>   compare against it

import fs from 'node:fs';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const golden = {};

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
installPhaserStub(14);

const { makeParty, slotMapFor } = await import('./fixtures.js');
const { createCombatHost } = await import('./combatHost.js');
const CombatSceneMod = await import('../../src/scenes/CombatScene.js');
const CombatScene = CombatSceneMod.default || Object.values(CombatSceneMod).find(v => typeof v === 'function');
const CL = await import('../../src/systems/CombatLogic.js');
const GameState = (await import('../../src/systems/GameState.js')).default;
const PM = (await import('../../src/systems/ProgressionManager.js')).default;
const { createMapHunt, restoreMapHunt } = await import('../../src/systems/HuntEngine.js');
const { GAME_WORLD } = await import('../../src/systems/HuntManager.js');
const { clockAt } = await import('../../src/systems/HuntRules.js');
const B = await import('../../src/systems/Boons.js');
const FG = await import('../../data/falseGods.js');
const { ZONES } = await import('../../data/zones.js');
const { EVENT_TEMPLATES } = await import('../../data/events.js');
const S = await import('../../src/systems/Standing.js');

const REEDS = 'reeds_of_gethsemane', BAY = 'bay_of_solace';

/** A world that records what the hunt asked of the game. */
function recordingWorld(party) {
  const w = { calls: [] };
  const rec = (k) => (...a) => { w.calls.push([k, ...a]); };
  Object.assign(w, {
    party: () => party, nightFalls() {}, dayBreaks() {}, bankItems() {},
    awardHuntPoints: rec('huntPoints'), awardXP: rec('xp'), favor: rec('favor'), falseGod: rec('falseGod'), bond: rec('bond'),
    followedHouse: () => null, houseHolder: () => null, ownTribe: () => 'styx', tribeName: (t) => t,
  });
  return w;
}

/**
 * A real hunt with `templateId` placed beside the party through the save's
 * own path, at night, and (`pact`) a pact already on. Steps onto it.
 */
function atTemptation(templateId, { zoneId = REEDS, pact = null, seed: sd = 81 } = {}) {
  const party = makeParty();
  const w = recordingWorld(party);
  const h0 = createMapHunt(zoneId, { plan: { objective: 'scout', size: 'medium' }, supplies: 300, seed: sd }, w);
  const d = h0.serialize();
  const tile = h0.view().moves[0].tile;
  d.map.occupants = d.map.occupants.filter(o => o.tile !== tile);
  d.map.occupants.push({ id: 'otempt', kind: 'event', tile, eventId: templateId, concealment: 0 });
  let t = d.time; while (!clockAt(t).isNight) t += 1; d.time = t; d.world.time = t;
  if (pact) d.boon.pact = pact;
  const h = restoreMapHunt(d, w);
  const r = h.move(tile);
  return { h, w, r, party };
}

// =============================================================================
console.log('=== the content ===');
{
  const statusKeys = Object.keys(CL._sumStatusEffectMods({}));
  const exploreKeys = ['supplyEfficiencyPercent', 'travelTimePercent', 'partyInitiativeBonus', 'sightRangeBonus', 'harvestYieldPercent'];
  const bad = [];
  for (const [god, def] of Object.entries(FG.FALSE_GODS)) {
    for (let l = FG.PACT_START; l <= FG.PACT_MAX; l++) {
      const L = def.levels[l];
      if (!L?.name || !L.text) { bad.push(`${god} ${l}: no level`); continue; }
      for (const k of Object.keys({ ...L.party, ...L.enemies })) if (!statusKeys.includes(k)) bad.push(`${god} ${l}: status ${k}`);
      for (const k of Object.keys(L.explore || {})) if (!exploreKeys.includes(k)) bad.push(`${god} ${l}: explore ${k}`);
    }
    if (!def.levels[FG.PACT_MAX].capstone) bad.push(`${god}: no capstone`);
    if (!def.curse?.name) bad.push(`${god}: no curse`);
    for (const k of Object.keys({ ...def.curse.party, ...def.curse.enemies })) if (!statusKeys.includes(k)) bad.push(`${god} curse: status ${k}`);
    for (const k of Object.keys(def.curse.explore || {})) if (!exploreKeys.includes(k)) bad.push(`${god} curse: explore ${k}`);
  }
  check('two gods, levels 3-5 and a curse each, every key one the engine reads', bad.length === 0, bad.join('; '));
  check('the Reeds tempt with Dagon, the Bay with Yar\'galeth', ZONES[REEDS].falseGod === 'dagon' && ZONES[BAY].falseGod === 'yargaleth');
  check('no pact raises Perception (the Unmask cap stays put)', Object.values(FG.FALSE_GODS).every(d => Object.values(d.levels).every(L => !('perceptionBonus' in (L.explore || {})))));
  golden.effects = Object.fromEntries(Object.keys(FG.FALSE_GODS).map(g => [g, [3, 4, 5].map(l => B.pactEffects(g, l))]));
  check('effects add up across levels, and the curse grows with the level (Dagon 4: supplies +20 -40)',
    B.pactEffects('dagon', 4).explore.supplyEfficiencyPercent === 20 - 40 && B.pactEffects('dagon', 3).explore.supplyEfficiencyPercent === -30
    && B.pactEffects('yargaleth', 5).party.Accuracy === -25 && B.pactEffects('yargaleth', 5).capstone?.id === 'the_true_word');
}

// =============================================================================
console.log('=== a pact on a real hunt ===');
{
  const first = atTemptation('dagon_whisper');
  check('the first temptation opens at night in the Reeds, and says what it will cost', first.r.event?.templateId === 'dagon_whisper'
    && first.h.view().event.offer.pact?.level === 3 && first.h.view().event.offer.pact.bondCost === 15 && first.h.view().event.offer.pact.endsProphet);
  const ra = first.h.resolveEvent({ accept: true });
  const b = first.h.getState().boon;
  check('accepting starts a pact with Dagon at level 3', ra.ok && same(b.pact, { god: 'dagon', level: 3 }) && first.h.view().boon.pact?.name === 'Dagon');
  check('...and pays its price: hidden standing +3, Bond standing with Jeremiah -15',
    same(first.w.calls.filter(c => c[0] === 'falseGod' || c[0] === 'bond'), [['falseGod', 'dagon', 3], ['bond', 'jeremiah', -15]]));
  const kill = { kind: 'beast', mark: 'marked', roster: [{ grade: 'great' }] };
  check('...and the prophet turns away: favor earns nothing now', first.h._earnFavor(B.killFavor(kill), 'kill') === 0 && first.h.getState().boon.favor === 0);

  // Deeper, to 5 and no further.
  let pact = { god: 'dagon', level: 3 };
  const steps = [];
  for (let i = 0; i < 3; i++) {
    const deeper = atTemptation('dagon_hunger', { pact });
    if (!deeper.r.event) { steps.push('did not open'); break; }
    deeper.h.resolveEvent({ accept: true });
    pact = deeper.h.getState().boon.pact;
    steps.push([pact.level, deeper.w.calls.filter(c => c[0] === 'falseGod' || c[0] === 'bond').map(c => c[2])]);
  }
  check('each deeper temptation raises it one level, paying more each time, and stops at 5',
    same(steps, [[4, [4, -20]], [5, [5, -25]], [5, []]]), JSON.stringify(steps));
  golden.steps = steps;

  const refuse = atTemptation('dagon_whisper');
  const rr = refuse.h.resolveEvent({ accept: false });
  check('refusing the first: no pact, and the prophet notices (+1 standing)', rr.ok && !refuse.h.getState().boon.pact && same(refuse.w.calls, [['favor', 'jeremiah', 1]]));
  const quietFirst = atTemptation('dagon_whisper', { pact: { god: 'dagon', level: 3 } });
  const quietDeep = atTemptation('dagon_hunger');
  check('the first temptation is quiet during a pact, the deeper one outside one', !quietFirst.r.event && !!quietFirst.r.quiet && !quietDeep.r.event && !!quietDeep.r.quiet);
  const bay = atTemptation('yargaleth_bubbles', { zoneId: BAY });
  bay.h.resolveEvent({ accept: true });
  check('in the Bay the pact is Yar\'galeth\'s, and the Bond price is Ezekiel\'s', same(bay.h.getState().boon.pact, { god: 'yargaleth', level: 3 })
    && same(bay.w.calls.filter(c => c[0] === 'bond'), [['bond', 'ezekiel', -15]]));
  const again = restoreMapHunt(first.h.serialize(), first.w);
  check('a reload keeps the pact', same(again.getState().boon.pact, { god: 'dagon', level: 3 }));
}

// =============================================================================
console.log('=== the pact\'s effects move their readers ===');
{
  const plain = atTemptation('dagon_whisper');
  plain.h.leaveEvent();
  const base = plain.h.stats();
  const dag3 = atTemptation('dagon_whisper'); dag3.h.resolveEvent({ accept: true });
  const d3 = dag3.h.stats();
  check('Dagon 3: forage and harvest yield +30, supplies per move -30% (the curse at 3)',
    Math.abs(d3.forageYieldPercent - base.forageYieldPercent - 30) < 1e-9 && Math.abs(d3.supplyEfficiencyPercent - base.supplyEfficiencyPercent + 30) < 1e-9,
    `yield ${base.forageYieldPercent} -> ${d3.forageYieldPercent}, supplies ${base.supplyEfficiencyPercent} -> ${d3.supplyEfficiencyPercent}`);
  check('...and a move costs more supplies than before', dag3.h.view().moves.every((m, i) => m.supply > plain.h.view().moves[i].supply));
  const bayPlain = atTemptation('yargaleth_bubbles', { zoneId: BAY }); bayPlain.h.leaveEvent();
  const y4 = atTemptation('yargaleth_undertow', { zoneId: BAY, pact: { god: 'yargaleth', level: 3 } }); y4.h.resolveEvent({ accept: true });
  const sb = bayPlain.h.stats(), s4 = y4.h.stats();
  check("Yar'galeth 4: +2 sight and +10 party initiative", s4.passives.sightRangeBonus - sb.passives.sightRangeBonus === 2
    && Math.abs(s4.partyInitiative - sb.partyInitiative - 10) < 1e-9);
  golden.stats = { dagon3: [base.forageYieldPercent, d3.forageYieldPercent, base.supplyEfficiencyPercent, d3.supplyEfficiencyPercent],
    yargaleth4: [sb.passives.sightRangeBonus, s4.passives.sightRangeBonus, sb.partyInitiative, s4.partyInitiative] };
}

// =============================================================================
console.log('=== the real game world ===');
{
  PM.reset();
  PM.setTribe('styx');
  const st = PM.getStanding();
  S.earnFavor(st, 'styx', 'jeremiah', 40);
  GAME_WORLD.falseGod('dagon', 3);
  GAME_WORLD.bond('jeremiah', -15);
  check('GAME_WORLD: hidden standing with Dagon +3, Bond -15, devotion untouched',
    st.falseGods?.dagon === 3 && st.bond.jeremiah === 25 && st.devotion.styx.jeremiah === 40);
  GAME_WORLD.bond('jeremiah', -100);
  check('...the Bond may go below 0', st.bond.jeremiah === -75);
  const h = atTemptation('dagon_whisper');
  h.h.resolveEvent({ accept: true });
  const text = JSON.stringify(h.h.view());
  check('hidden standing is nowhere in the view', !/falseGods|hidden/.test(text));
}

// =============================================================================
console.log('=== the capstones, in the real fight host ===');
{
  /** A board met with a level-5 pact, from the hunt's own fight spec. */
  const board = (zoneId, god) => {
    for (let sd = 300; sd < 500; sd++) {
      const party = makeParty();
      const w = recordingWorld(party);
      const h0 = createMapHunt(zoneId, { plan: { objective: 'cull', size: 'medium' }, supplies: 400, seed: sd }, w);
      const d = h0.serialize();
      d.boon.pact = { god, level: 5 };
      const h = restoreMapHunt(d, w);
      for (let i = 0; i < 150 && !h.encounter(); i++) {
        if (h.view().event) h.leaveEvent();
        const m = h.view().moves; if (!m.length) break; h.move(m[i % m.length].tile);
      }
      if (h.encounter()?.kind !== 'beast') continue;
      const host = createCombatHost(CombatScene);
      GameState.party = party;
      host.__begin({ party, partySlots: slotMapFor(party), huntFight: { ...h.fightSpec(), hunt: h } });
      return { host, party };
    }
    return null;
  };
  const basic = (u) => (u.skills || []).find(s => s.id === 'basic_attack');

  // What Waits Below
  const dg = board(REEDS, 'dagon');
  check('found a beast fight under a Dagon pact', !!dg);
  if (dg) {
    const hunter = dg.party[0];
    const foe = dg.host.enemies[0];
    // Dagon 3's life steal would heal on the hit too: off, so only the capstone is measured.
    for (const c of dg.party) c.statusEffects = c.statusEffects.filter(se => se.id !== 'hunt_boon');
    hunter.currentHP = 10;
    foe.currentHP = 1;
    foe.derived = { ...foe.derived, Evasion: -1000 };
    const want = Math.min(hunter.maxHP, 10 + Math.floor(hunter.maxHP * 0.15));
    seed(9);
    dg.host._applyAbilityToTarget(hunter, foe, basic(hunter));
    dg.host.__drain();
    check('What Waits Below: a killing blow heals the hunter 15% of max HP', foe.status === 'incapacitated' && hunter.currentHP === want, `${hunter.currentHP} vs ${want}`);
    const other = dg.party[1], foe2 = dg.host.enemies.find(e => e !== foe && e.status !== 'incapacitated');
    other.currentHP = 10;
    foe2.currentHP = 9999; foe2.maxHP = 9999;
    foe2.derived = { ...foe2.derived, Evasion: -1000 };
    dg.host._applyAbilityToTarget(other, foe2, basic(other));
    dg.host.__drain();
    check('...a blow that does not kill heals nothing', other.currentHP <= 10);
  }

  // The Word That Is Always True
  const yg = board(BAY, 'yargaleth');
  check("found a beast fight under a Yar'galeth pact", !!yg);
  if (yg) {
    const hunter = yg.party[0];
    const foe = yg.host.enemies[0];
    check('every standing hunter starts the fight with the True Word', yg.party.every(c => c.statusEffects.some(s => s.id === 'hunt_true_word')));
    foe.maxHP = 99999; foe.currentHP = 99999;
    foe.derived = { ...foe.derived, Evasion: 1000 };   // nobody hits this without the Word
    const logBefore = yg.host.combatEntries.length;
    seed(10);
    yg.host._applyAbilityToTarget(hunter, foe, basic(hunter));
    yg.host.__drain();
    const firstHit = foe.currentHP < 99999;
    const crit = yg.host.combatEntries.slice(logBefore).some(e => (e.segments || []).some(sg => String(sg.text).includes('CRIT')));
    check('the first attack hits a foe it could never hit, and crits', firstHit && crit, `hp ${foe.currentHP}`);
    check('...and the Word is spent', !hunter.statusEffects.some(s => s.id === 'hunt_true_word'));
    const hpAfter = foe.currentHP;
    yg.host._applyAbilityToTarget(hunter, foe, basic(hunter));
    yg.host.__drain();
    check('...the second attack does not have it (it misses that foe)', foe.currentHP === hpAfter);
  }
}

// =============================================================================
const args = process.argv.slice(2);
const jsonAt = args.indexOf('--json');
const diffAt = args.indexOf('--diff');
if (jsonAt >= 0) {
  fs.writeFileSync(args[jsonAt + 1], JSON.stringify(golden, null, 1) + '\n');
  console.log(`golden written -> ${args[jsonAt + 1]}`);
}
if (diffAt >= 0) {
  console.log('=== golden diff ===');
  const old = JSON.parse(fs.readFileSync(args[diffAt + 1], 'utf8'));
  const keys = new Set([...Object.keys(old), ...Object.keys(golden)]);
  const changed = [...keys].filter(k => !same(old[k], golden[k]));
  check('false-god tables identical to the golden', changed.length === 0, changed.length ? `changed: ${changed.join(', ')}` : `${keys.size} tables`);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
