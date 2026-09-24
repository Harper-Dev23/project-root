// tools/headless/boons.mjs
//
// Prophet boons during a hunt (Exploration System v2, chunk 10b): data/boons.js,
// src/systems/Boons.js, the boon on the hunt (HuntEngine), its combat half in
// CombatScene (_applyHuntFightStart, _checkFinalMercy, the echo roll) and the
// standing writes through GAME_WORLD. Everything is read off the game's own
// objects and functions; nothing is re-derived.
//
// What it proves:
//   - the content: two houses, five levels each, every status key one that
//     _sumStatusEffectMods sums, every explore field one the hunt reads, the
//     thresholds rising, level 5 only where your tribe's house watches
//   - favor: a marked kill pays its members by grade, an unmarked or corrupted
//     kill and a cultist band pay nothing, your own house's lands pay +25%,
//     the shrine pays once; each is booked on the hunt, raises the level, is
//     logged, and reaches the save's standing (the Bond and devotion) through
//     the real GAME_WORLD; a reload keeps it; a hunt saved before 10b has none
//   - every effect moves its consumer's number: supply and time per move,
//     Sight (the tiles seen), party initiative; Accuracy through
//     computeHitChance, the resists through getDamageReductionFraction, crit
//     through getEffectiveDerived (what the crit roll reads), and the enemies'
//     -10% AttackPower through a real seeded enemy turn
//   - the capstones in the real fight host: Final Mercy heals every standing
//     hunter once, on the first knock-out; The Loop echoes a hunter's damaging
//     hit and nothing else
//
// USAGE
//   node tools/headless/boons.mjs                 run the checks
//   node tools/headless/boons.mjs --json <path>   write the golden
//   node tools/headless/boons.mjs --diff <path>   compare against it

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
installPhaserStub(12);

const { makeParty, slotMapFor } = await import('./fixtures.js');
const { createCombatHost } = await import('./combatHost.js');
const CombatSceneMod = await import('../../src/scenes/CombatScene.js');
const CombatScene = CombatSceneMod.default || Object.values(CombatSceneMod).find(v => typeof v === 'function');
const CL = await import('../../src/systems/CombatLogic.js');
const GameState = (await import('../../src/systems/GameState.js')).default;
const PM = (await import('../../src/systems/ProgressionManager.js')).default;
const { createMapHunt: rawCreateMapHunt, restoreMapHunt: rawRestoreMapHunt } = await import('../../src/systems/HuntEngine.js');
// Walkers here are not about events: a hunt walks away from any it opens (chunk 11a).
const { createMapHunt, restoreMapHunt } = (await import('./walkAway.js')).walkingAway({ createMapHunt: rawCreateMapHunt, restoreMapHunt: rawRestoreMapHunt });
const { GAME_WORLD } = await import('../../src/systems/HuntManager.js');
const { sightRange, visibleTiles } = await import('../../src/systems/HuntRules.js');
const { mapNeighbors } = await import('../../src/systems/HuntMapGen.js');
const B = await import('../../src/systems/Boons.js');
const BD = await import('../../data/boons.js');
const S = await import('../../src/systems/Standing.js');
const { makeRng } = await import('../../src/systems/seededRng.js');

const ZONES = ['reeds_of_gethsemane', 'bay_of_solace'];
const HOUSE_OF_ZONE = { reeds_of_gethsemane: 'jeremiah', bay_of_solace: 'ezekiel' };

/** A world that records what the hunt asked of the game. */
function recordingWorld(party, followed = null) {
  const w = { paid: [], favor: [] };
  w.party = () => party;
  w.nightFalls = () => {}; w.dayBreaks = () => {};
  w.awardHuntPoints = (n) => w.paid.push(n);
  w.bankItems = () => {};
  w.favor = (house, amount) => w.favor.push([house, amount]);
  w.followedHouse = () => followed;
  return w;
}
// The recorder's list and its method share a name on purpose above; keep them apart.
function world(party, followed = null) {
  const w = recordingWorld(party, followed);
  const log = [];
  w.favor = (house, amount) => log.push([house, amount]);
  w.favorLog = log;
  return w;
}

/** Walk a real hunt until it meets an occupant matching `want`, or give up. */
function meet(want, { from = 100, tries = 150, followed = false, objective = 'cull', boon = null, zones = ZONES } = {}) {
  for (let seedN = from; seedN < from + tries; seedN++) {
    for (const zoneId of zones) {
      const party = makeParty();
      const w = world(party, followed ? HOUSE_OF_ZONE[zoneId] : null);
      let h = createMapHunt(zoneId, { plan: { objective, size: 'medium' }, supplies: 400, seed: seedN }, w);
      if (boon) h = withBoon(h, w, boon);
      const pick = makeRng(seedN);
      for (let i = 0; i < 150; i++) {
        const e = h.encounter();
        if (e) {
          const occ = h.getState().map.occupants.find(o => o.id === e.occId);
          if (want(occ)) return { h, party, w, zoneId, occ };
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
/**
 * The same hunt with its boon set, through serialize/restore (the save's own
 * path). Only on a hunt with no fight pending: a reload resolves one as a flee.
 */
function withBoon(h, w, boon) {
  const d = h.serialize();
  if (d.encounter) throw new Error('withBoon: a fight is pending');
  d.boon = { ...d.boon, ...boon };
  return restoreMapHunt(d, w);
}

// =============================================================================
console.log('=== the content ===');
{
  const statusKeys = Object.keys(CL._sumStatusEffectMods({}));
  const exploreKeys = ['supplyEfficiencyPercent', 'travelTimePercent', 'partyInitiativeBonus', 'sightRangeBonus'];
  const bad = [];
  for (const [house, def] of Object.entries(BD.BOONS)) {
    if (def.levels.length !== 5) bad.push(`${house}: ${def.levels.length} levels`);
    def.levels.forEach((L, i) => {
      for (const k of Object.keys({ ...L.party, ...L.enemies })) if (!statusKeys.includes(k)) bad.push(`${house} ${i + 1}: status key ${k}`);
      for (const k of Object.keys(L.explore || {})) if (!exploreKeys.includes(k)) bad.push(`${house} ${i + 1}: explore field ${k}`);
      if (L.capstone && i !== 4) bad.push(`${house} ${i + 1}: capstone before level 5`);
      if (!L.name || !L.text) bad.push(`${house} ${i + 1}: no name or text`);
    });
    if (!def.levels[4]?.capstone) bad.push(`${house}: no capstone`);
  }
  check('both houses have five levels; every status key is summed by the engine, every explore field read by the hunt', bad.length === 0, bad.join('; '));
  check('Jeremiah and Ezekiel have boons; Isaiah and Daniel wait for their coasts', B.hasBoons('jeremiah') && B.hasBoons('ezekiel') && !B.hasBoons('isaiah') && !B.hasBoons('daniel'));
  check('the thresholds rise', BD.BOON_THRESHOLDS.every((t, i, a) => i === 0 || t > a[i - 1]));
  const levels = [0, 4, 5, 9, 10, 19, 20, 29, 30, 39, 40, 999].map(f => [f, B.levelFor(f, false), B.levelFor(f, true)]);
  golden.levels = levels;
  check('level 5 only in the lands of the house your tribe follows', B.levelFor(999, false) === 4 && B.levelFor(40, true) === 5 && B.levelFor(39, true) === 4);
  check('the next-level hint: favor still needed, none at the top', B.toNext(7, false) === 3 && B.toNext(30, false) === null && B.toNext(30, true) === 10 && B.toNext(40, true) === null);
  golden.effects = Object.fromEntries(['jeremiah', 'ezekiel'].map(h => [h, [0, 1, 2, 3, 4, 5].map(l => B.boonEffects(h, l))]));
  check('a later level replaces a key\'s value (Jeremiah\'s resists 10 -> 15, Ezekiel\'s Accuracy 10 -> 15)',
    B.boonEffects('jeremiah', 3).party.PhysicalResist === 15 && B.boonEffects('jeremiah', 2).party.PhysicalResist === 10
    && B.boonEffects('ezekiel', 3).party.Accuracy === 15 && B.boonEffects('ezekiel', 1).party.Accuracy === 10);
  check('levels are cumulative: level 4 keeps both explore fields, the capstone only at 5',
    same(B.boonEffects('jeremiah', 4).explore, { supplyEfficiencyPercent: 15, sightRangeBonus: 1 }) && !B.boonEffects('jeremiah', 4).capstone
    && B.boonEffects('jeremiah', 5).capstone?.id === 'final_mercy' && B.boonEffects('ezekiel', 5).capstone?.id === 'the_loop');
  check('no boon raises Perception (the Unmask cap stays put, decision 8)',
    Object.values(BD.BOONS).every(d => d.levels.every(L => !('perceptionBonus' in (L.explore || {})))));
}

// =============================================================================
console.log('=== favor ===');
{
  const marked = meet(o => o.kind === 'beast' && o.mark === 'marked');
  const unmarked = meet(o => o.kind === 'beast' && o.mark !== 'marked', { from: 400 });
  const cult = meet(o => o.kind === 'cultist', { from: 300 });
  check('found a marked beast, an unmarked one and a cultist band on real hunts', !!marked && !!unmarked && !!cult);
  const raw = B.killFavor(marked.occ);
  const want = marked.occ.roster.reduce((t, m) => t + BD.FAVOR_BY_GRADE[m.grade], 0);
  check('a marked kill pays every member by grade', raw === want && raw > 0, `${marked.occ.roster.map(m => m.grade).join(',')} -> ${raw}`);
  const r = marked.h.winEncounter({});
  const b = marked.h.getState().boon;
  check('the win books it on the hunt, and the hunt says so', r.favor === raw && b.favor === raw && b.house === HOUSE_OF_ZONE[marked.zoneId]);
  check('...and hands it to the world for the Bond and devotion', same(marked.w.favorLog, [[b.house, raw]]));
  check('...raising the level, logged once', b.level === B.levelFor(raw, false)
    && marked.h.view().log.filter(e => e.kind === 'boon').length === b.level, `favor ${raw} -> level ${b.level}`);
  const ru = unmarked.h.winEncounter({});
  check('an unmarked (or corrupted) kill pays nothing and costs nothing', ru.favor === 0 && unmarked.h.getState().boon.favor === 0 && unmarked.w.favorLog.length === 0);
  const rc = cult.h.winEncounter({});
  check('a cultist band pays nothing', rc.favor === 0 && cult.w.favorLog.length === 0);

  const fol = meet(o => o.kind === 'beast' && o.mark === 'marked', { followed: true });
  check('a hunt in your followed house\'s lands knows it from departure', fol.h.getState().boon.followed === true);
  const rf = fol.h.winEncounter({});
  check(`...and books +${BD.FOLLOWED_FAVOR_PERCENT}% favor`, rf.favor === B.killFavor(fol.occ) * 1.25, `${B.killFavor(fol.occ)} -> ${rf.favor}`);

  // Level 5 only there: a hunt nearly full, one more marked kill.
  const again = (followed) => {
    const m = meet(o => o.kind === 'beast' && o.mark === 'marked', { followed, from: 700, boon: { favor: 39.5, level: 4 } });
    m.h.winEncounter({});
    return m.h.getState().boon;
  };
  const top = again(true), capped = again(false);
  check('past 40 favor: level 5 at home, held at 4 abroad', top.level === 5 && capped.level === 4 && capped.favor >= 40, `home ${top.level}, abroad ${capped.level} at ${capped.favor}`);

  // Reload keeps it; a hunt saved before 10b has none.
  const again2 = restoreMapHunt(marked.h.serialize(), marked.w);
  check('a reload keeps the boon', same(again2.getState().boon, marked.h.getState().boon));
  const old = marked.h.serialize(); delete old.boon;
  const oldH = restoreMapHunt(old, marked.w);
  check('a hunt saved before 10b restores with no favor, its region\'s house, not followed',
    same(oldH.getState().boon, { house: HOUSE_OF_ZONE[marked.zoneId], followed: false, favor: 0, level: 0 }));
  golden.favor = { marked: { grades: marked.occ.roster.map(m => m.grade), favor: raw, level: b.level }, followed: rf.favor };

  // The shrine: a Commune hunt, the party one step from the site.
  let shrine = null;
  for (let sd = 1; sd < 60 && !shrine; sd++) {
    const party = makeParty();
    const w = world(party);
    const h = createMapHunt('reeds_of_gethsemane', { plan: { objective: 'commune', size: 'small' }, supplies: 200, seed: sd }, w);
    const d = h.serialize();
    const site = d.map.objectives.primary.site;
    const nb = [...mapNeighbors(d.map, site)].find(id => d.map.tiles[id] && !d.map.occupants.some(o => o.tile === id) && id !== d.map.entry);
    if (!nb) continue;
    d.pos = nb;
    const h2 = restoreMapHunt(d, w);
    const mv = h2.move(site);
    if (mv.ok && h2.getState().communed) shrine = { h: h2, w };
  }
  check('reaching the shrine pays SHRINE_FAVOR once', !!shrine && shrine.h.getState().boon.favor === BD.SHRINE_FAVOR && same(shrine.w.favorLog, [['jeremiah', BD.SHRINE_FAVOR]])
    && shrine.h.getState().boon.level === 1);

  // The real game world: favor reaches the save's standing.
  PM.reset();
  PM.setTribe('styx');
  GAME_WORLD.favor('jeremiah', 12.5);
  const st = PM.getStanding();
  check('GAME_WORLD.favor raises the Bond and your tribe\'s devotion with that house', st.bond.jeremiah === 12.5 && st.devotion.styx.jeremiah === 12.5);
  S.earnFavor(st, 'styx', 'jeremiah', 100);
  S.acceptHouse(st, 'styx', 'jeremiah');
  GameState.party = makeParty();
  const hg = createMapHunt('reeds_of_gethsemane', { plan: { objective: 'scout', size: 'small' }, supplies: 60, seed: 3 }, GAME_WORLD);
  const hb = createMapHunt('bay_of_solace', { plan: { objective: 'scout', size: 'small' }, supplies: 60, seed: 3 }, GAME_WORLD);
  check('GAME_WORLD.followedHouse: a hunt in the accepted house\'s lands is followed, abroad it is not',
    hg.getState().boon.followed === true && hb.getState().boon.followed === false);
}

// =============================================================================
console.log('=== every effect moves its number ===');
{
  const party0 = makeParty();
  const w0 = world(party0);
  const fresh = createMapHunt('reeds_of_gethsemane', { plan: { objective: 'scout', size: 'medium' }, supplies: 200, seed: 21 }, w0);
  const m = { h: fresh, w: w0, party: party0 };
  const at = (house, level) => withBoon(m.h, m.w, { house, level, favor: BD.BOON_THRESHOLDS[level - 1] || 0 });
  const J0 = at('jeremiah', 0), J2 = at('jeremiah', 2), J4 = at('jeremiah', 4), E2 = at('ezekiel', 2), E4 = at('ezekiel', 4), E0 = at('ezekiel', 0);
  const s0 = J0.stats(), sJ2 = J2.stats(), sE2 = E2.stats(), sE4 = E4.stats(), sE0 = E0.stats(), sJ4 = J4.stats();
  check('Never Halts: supplyEfficiencyPercent +15, and a move costs fewer supplies', sJ2.supplyEfficiencyPercent - s0.supplyEfficiencyPercent === 15
    && J2.view().moves.every((mv, i) => mv.supply < J0.view().moves[i].supply));
  check('Tilting Thresholds: travelTimePercent +15, and a move takes less time', sE2.travelTimePercent - sE0.travelTimePercent === 15
    && E2.view().moves.every((mv, i) => mv.time < E0.view().moves[i].time));
  check('Déjà Vu: party initiative +10', Math.abs(sE4.partyInitiative - sE0.partyInitiative - 10) < 1e-9, `${sE0.partyInitiative} -> ${sE4.partyInitiative}`);
  const map = m.h.getState().map, pos = m.h.getState().pos;
  const r0 = sightRange(map, pos, s0.passives.sightRangeBonus), r4 = sightRange(map, pos, sJ4.passives.sightRangeBonus);
  check('The Mourning Flight: Sight +1, and more tiles in sight', r4 === r0 + 1 && visibleTiles(map, pos, { range: r4 }).length > visibleTiles(map, pos, { range: r0 }).length, `${r0} -> ${r4}`);
  golden.explore = { supply: [s0.supplyEfficiencyPercent, sJ2.supplyEfficiencyPercent], time: [sE0.travelTimePercent, sE2.travelTimePercent], sight: [r0, r4] };

  // The combat half, on a real board from a real hunt's own fight spec, met
  // with the boon already at that level.
  const board = (house, level, extra = {}) => {
    const zone = Object.keys(HOUSE_OF_ZONE).find(z => HOUSE_OF_ZONE[z] === house);
    const f = meet(o => o.kind === 'beast', { from: 900, zones: [zone], boon: { level, favor: BD.BOON_THRESHOLDS[level - 1] || 0 } });
    const spec = f.h.fightSpec();
    const host = createCombatHost(CombatScene);
    GameState.party = f.party;
    host.__begin({ party: f.party, partySlots: slotMapFor(f.party), huntFight: { ...spec, hunt: f.h, ...extra } });
    return { host, party: f.party, spec };
  };
  const base = board('jeremiah', 0), j3 = board('jeremiah', 3), e3 = board('ezekiel', 3);
  check('level 0 hands combat no boon; level 3 hands it the level\'s effects', base.spec.boon === null && same(j3.spec.boon.party, B.boonEffects('jeremiah', 3).party));
  const hunter = (b) => b.party.find(c => c.status !== 'incapacitated');
  const foe = (b) => b.host.enemies[0];
  const dr = (b, t) => CL.getDamageReductionFraction(hunter(b), { damageType: t });
  check('Shell of Sorrow / Rust: every hunter wears it, and damage reduction rises for all three types',
    j3.party.every(c => c.statusEffects.some(s => s.id === 'hunt_boon')) && ['physical', 'elemental', 'necrotic'].every(t => dr(j3, t) > dr(base, t)),
    ['physical', 'elemental', 'necrotic'].map(t => `${dr(base, t).toFixed(3)}->${dr(j3, t).toFixed(3)}`).join(' '));
  check('Rust in Their Hands: every enemy carries -10 AttackPower', j3.host.enemies.every(e => e.statusEffects.some(s => s.id === 'hunt_boon_judgment' && s.mods.AttackPower === -10)));
  // Accuracy against a hard-to-hit foe, so the hit chance is not already capped.
  const hardFoe = (b) => { const f = foe(b); f.derived = { ...f.derived, Evasion: 60 }; return f; };
  const hc0 = CL.computeHitChance(hunter(base), hardFoe(base)), hc3 = CL.computeHitChance(hunter(e3), hardFoe(e3));
  check('Sacred Geometry: Accuracy +15 at level 3 lifts the real hit chance by 15', hc3 - hc0 === 15, `${hc0} -> ${hc3}`);
  const d0 = CL.getEffectiveDerived(hunter(base)), d3 = CL.getEffectiveDerived(hunter(e3));
  check('The Pattern Repeats: the crit roll reads +10 Crit Chance and +0.25 Crit Multiplier', d3.CritChance - d0.CritChance === 10 && Math.abs(d3.CritMult - d0.CritMult - 0.25) < 1e-9);

  // The enemies' -10% AttackPower through a real seeded enemy turn.
  const enemyHit = (enemies) => {
    const b = board('jeremiah', 0, enemies ? { boon: { house: 'jeremiah', level: 3, party: {}, enemies, capstone: null } } : {});
    const e = b.host.enemies[0];
    const before = b.party.map(c => c.currentHP);
    seed(4242);
    b.host._takeEnemyTurn_viaLogic(e);
    b.host.__drain();
    return b.party.reduce((t, c, i) => t + (before[i] - c.currentHP), 0);
  };
  const plain = enemyHit(null), rusted = enemyHit({ AttackPower: -10 });
  check('...and the same seeded enemy turn deals less damage', plain > 0 && rusted < plain, `${plain} -> ${rusted}`);
  golden.combat = { dr: ['physical', 'elemental', 'necrotic'].map(t => [dr(base, t), dr(j3, t)]), hit: [hc0, hc3], enemyTurn: [plain, rusted] };
}

// =============================================================================
console.log('=== the capstones ===');
{
  const host5 = (house) => {
    const zone = Object.keys(HOUSE_OF_ZONE).find(z => HOUSE_OF_ZONE[z] === house);
    const f = meet(o => o.kind === 'beast', { from: 1100, zones: [zone], followed: true, boon: { level: 5, favor: 40 } });
    const host = createCombatHost(CombatScene);
    GameState.party = f.party;
    host.__begin({ party: f.party, partySlots: slotMapFor(f.party), huntFight: { ...f.h.fightSpec(), hunt: f.h } });
    return { host, party: f.party };
  };
  // Final Mercy
  const { host, party } = host5('jeremiah');
  for (const c of party) c.currentHP = Math.floor(c.maxHP / 2);
  host._updateHealthBars();
  check('Final Mercy: nothing happens while nobody is down', !host._finalMercyUsed && party.every(c => c.currentHP === Math.floor(c.maxHP / 2)));
  party[0].currentHP = 0; party[0].status = 'incapacitated';
  host._updateHealthBars();
  const want = party.slice(1).map(c => Math.min(c.maxHP, Math.floor(c.maxHP / 2) + Math.floor(c.maxHP * 0.2)));
  check('...the first knock-out heals every standing hunter 20% of max HP', host._finalMercyUsed && same(party.slice(1).map(c => c.currentHP), want) && party[0].currentHP === 0);
  party[1].currentHP = 0; party[1].status = 'incapacitated';
  const hp = party.map(c => c.currentHP);
  host._updateHealthBars();
  check('...once per fight', same(party.map(c => c.currentHP), hp));
  const other = host5('ezekiel');
  other.party[0].currentHP = 0; other.party[0].status = 'incapacitated';
  const hp2 = other.party.map(c => c.currentHP);
  other.host._updateHealthBars();
  check('...and only under Jeremiah\'s capstone', !other.host._finalMercyUsed && same(other.party.map(c => c.currentHP), hp2));

  // The Loop
  const lp = host5('ezekiel');
  const hunterL = lp.party[0], foeL = lp.host.enemies[0];
  const dmg = { _coreBreakdown: { physical: 5, elemental: 0, necrotic: 0 }, amount: 5 };
  check('The Loop: a hunter\'s damaging hit may echo at 20%', lp.host._boonEchoChance(hunterL, dmg) === 0.2);
  check('...a heal never echoes, nor an enemy\'s hit', lp.host._boonEchoChance(hunterL, { amount: 5, isHeal: true }) === 0 && lp.host._boonEchoChance(foeL, dmg) === 0);
  check('...and without the capstone nothing echoes', host5('jeremiah').host._boonEchoChance(hunterL, dmg) === 0);
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
  check('boon tables identical to the golden', changed.length === 0,
    changed.length ? `changed: ${changed.join(', ')}` : `${keys.size} tables`);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
