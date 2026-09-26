// tools/headless/huntsim.mjs
//
// The hunt simulator (Exploration System v2, chunk 13a): whole map hunts
// played start to finish by the REAL engine, so balance starts from measured
// numbers instead of play time. Nothing here re-derives a rule:
//   - the map, moves, food, camps, harvest, objectives and the exit are the
//     real HuntEngine (createMapHunt), on a recording world;
//   - every fight is the real CombatScene in the headless host, handed the
//     hunt's own beginFight() exactly as the map scene hands it over, so the
//     victory and defeat paths (winEncounter, the XP pool, the Sheltered wipe)
//     are the game's own;
//   - XP needed per level is the game's getXPNeededForLevel.
//
// What is the SIMULATOR's, not the game's (the owner signed these off,
// chunk 13a decisions 2-4):
//   - the map player. Fog-honest: it only knows what view() shows (tiles seen,
//     occupants sighted, objective sites the scene marks, the plan's cull
//     family). Unseen tiles are assumed passable. It eats raw food when
//     Hungry, camps (cooking what it can) when the living party is under
//     CAMP_BELOW_HP of its HP, forages when supplies are low, harvests meat
//     and rare-or-better parts, walks away from every event except the
//     Commune shrine (first choice), and never flees.
//       objective: the primary objective, then the nearest known exit;
//                  known hostiles are walked around when there is a way.
//       thorough:  the same, and every hostile it has sighted is fought
//                  before it leaves.
//     Bonus objectives are not pursued (they count only if met on the way).
//   - the fight player. Heals the lowest ally under HEAL_BELOW_HP if it can;
//     otherwise casts a random ready enemy-targeted skill (seeded) at the
//     lowest-HP legal target, repeating while the action economy allows,
//     falling back to Basic Attack.
//   - the party. The first N of the fixture hunters (fixtures.js HUNTERS),
//     their level-5 stat spreads scaled to the level's point budget, starter
//     weapons, no armour. Levels are measured one at a time: XP is recorded,
//     not applied, so a hunt at level L is played at level L throughout.
//
// Randomness: every hunt is seeded (hunt seed = --seed-base + k) and every
// fight reseeds the combat stream from (hunt seed, fight number), so a run
// repeats exactly.
//
// Not a verify golden: these numbers are meant to move when tuning. `--smoke`
// is the small run verify uses (hunts finish, invariants hold).
//
// USAGE
//   node tools/headless/huntsim.mjs [options]
//     --zones a,b          zone ids              (default: every zone with generator data)
//     --sizes s,m,l        small,medium,large    (default: all three)
//     --objectives a,b     scout,apex,cull,retrieve,commune (default: all five)
//     --levels 1,5,10      party levels          (default: 1..10)
//     --party 4            party size 1-6        (default 4); comma list allowed
//     --policy objective   objective|thorough    (default objective); comma list allowed
//     --seeds 10           hunts per cell        (default 10)
//     --seed-base 1000
//     --rations 60         Rations packed on top of the camp issue (default 60, the cap)
//     --sec-round N --sec-move N   real seconds per combat round / map action,
//                          for the real-minutes column (blank without them)
//     --save FILE          play with the party of an exported save instead of the fixtures
//     --fightlog FILE      every fight as one JSON line (outcome, who went first, roster, HP going in)
//     --json FILE          write the full report
//     --compare FILE       print each cell's change against an earlier --json report
//     --smoke              a small fixed run with invariant checks; exits 1 on a failure
//     --quiet              no per-cell progress lines
//     --camp-below 0.7     camp when the living party holds less than this share of its HP (default 0.7)
//     --trace              print every fight: both sides after it and its last log lines

const args = process.argv.slice(2);
const opt = (name, dflt = null) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : dflt; };
const flag = (name) => args.includes('--' + name);
const list = (name, dflt) => (opt(name) ? opt(name).split(',').map(x => x.trim()).filter(Boolean) : dflt);

const store = new Map();
globalThis.localStorage = {
  get length() { return store.size; },
  key: (i) => [...store.keys()][i] ?? null,
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => store.clear(),
};

const { installPhaserStub, seed: seedCombat } = await import('./phaserStub.js');
installPhaserStub(1);
// Tolerate the engine's console noise; the report is what matters.
const realLog = console.log;
const quietEngine = () => { console.log = () => {}; console.warn = () => {}; console.info = () => {}; console.debug = () => {}; };
const loud = () => { console.log = realLog; };

const fs = await import('node:fs');
const { makeParty, slotMapFor, HUNTERS } = await import('./fixtures.js');
const { createCombatHost } = await import('./combatHost.js');
const { runFight, cast } = await import('./fight.js');
const CombatSceneMod = await import('../../src/scenes/CombatScene.js');
const CombatScene = CombatSceneMod.default || Object.values(CombatSceneMod).find(v => typeof v === 'function');
const GameState = (await import('../../src/systems/GameState.js')).default;
const { createMapHunt } = await import('../../src/systems/HuntEngine.js');
const { CAMP_ISSUE } = await import('../../src/systems/HuntManager.js');
const { mapNeighbors } = await import('../../src/systems/HuntMapGen.js');
const { parseTileId } = await import('../../src/systems/HexGrid.js');
const { isPassable, GROUNDS } = await import('../../data/grounds.js');
const { Items } = await import('../../data/items.js');
const { ZONES, getZone } = await import('../../data/zones.js');
const R = await import('../../src/systems/HuntRules.js');
const { packFindsCamp } = await import('../../src/systems/HuntWorld.js');
const { getXPNeededForLevel, LEVEL_CAP } = await import('../../data/xpTable.js');
const { makeRng } = await import('../../src/systems/seededRng.js');
const { parseImport } = await import('../../src/systems/SaveTransfer.js');
const { getWeaponSkillsFor, getClassSkillsFor } = await import('../../data/skills.js');
const { pickBaseId, createItemInstance } = await import('../../src/systems/ItemFactory.js');
const { rebuildCharacterStats } = await import('../../src/systems/CharacterBuilder.js');
const { hunterExploration, owedExplorationPicks, applyExplorationPick, partyStats } = await import('../../src/systems/PartyStats.js');

/** Camp when the living party holds less than this share of its max HP. */
const CAMP_BELOW_HP = Number(process.argv.includes("--camp-below") ? process.argv[process.argv.indexOf("--camp-below") + 1] : 0.7);
/** Heal an ally below this share of its max HP. */
const HEAL_BELOW_HP = 0.5;
/** Forage when supplies fall below this. */
const FORAGE_BELOW_SUPPLIES = 15;
/** Runaway guards: a hunt that hits one is reported as stuck, a finding. */
const MAX_ACTIONS = 4000;
const MAX_FIGHT_TURNS = 800;
/** Camps in a row without a step between them before the player gives up camping. */
const MAX_CAMPS_IN_A_ROW = 4;
/** --trace: print every fight (party and enemies after it, the last log lines). */
const TRACE = args.includes('--trace');
const TRACE_LINES = process.argv.includes("--trace-lines") ? Number(process.argv[process.argv.indexOf("--trace-lines") + 1]) : 25;

// ---------------------------------------------------------------------------
// The party

/** The fixture's allocated points above the 5 base, at level 5: 10 at creation + 5 per level-up. */
const pointBudget = (level) => 10 + 5 * (level - 1);

/** A hunter's level-5 spread scaled to `level`'s budget: largest remainders keep the total exact. */
function statsAt(stats, level) {
  const keys = Object.keys(stats);
  const extra = keys.map(k => stats[k] - 5);
  const total = extra.reduce((a, b) => a + b, 0);
  const want = pointBudget(level);
  const raw = extra.map(e => e * want / total);
  const out = raw.map(Math.floor);
  let left = want - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) { if (left <= 0) break; out[i]++; left--; }
  return Object.fromEntries(keys.map((k, i) => [k, 5 + out[i]]));
}

function partyAt(level, size) {
  if (SAVE_TEXT) return partyFromSave();
  const specs = HUNTERS.slice(0, size).map(h => ({ ...h, stats: statsAt(h.stats, level) }));
  const party = makeParty(specs, { level });
  if (GEAR !== 'none') party.forEach((c, i) => gearUp(c, HUNTERS[i], level, i));
  takePicks(party);
  return { party, slots: slotMapFor(party, specs) };
}

/**
 * The exploration picks owed at levels 2/4/6/8/10, taken as the owner's own
 * party took them (chunk 13c): one scout, the hunter with the best
 * Perception, puts every pick into Perception; everyone else raises their own
 * best rating. Recorded through the game's applyExplorationPick.
 */
function takePicks(party) {
  const scout = [...party].sort((a, b) => hunterExploration(b).ratings.perception - hunterExploration(a).ratings.perception)[0];
  for (const c of party) {
    for (const level of owedExplorationPicks(c)) {
      const r = hunterExploration(c).ratings;
      const rating = c === scout ? 'perception' : Object.keys(r).sort((a, b) => r[b] - r[a] || a.localeCompare(b))[0];
      const done = applyExplorationPick(c, level, { rating });
      if (!done.ok) throw new Error(`pick for ${c.name} at ${level}: ${done.reason}`);
    }
  }
}

/**
 * --gear (default uncommon; owner, chunk 13a): one item per slot, rolled by
 * the game's own code at item level = the party's level and the given
 * rarity. Bases come from pickBaseId, the drops' base picker (tiers weighted
 * by item level); the weapon keeps the hunter's weapon type (bone bases left
 * out: they are a 1% overlay, not a tier); ring and amulet from all twelve.
 * Seeded by level, hunter and slot, so a level's party is the same in every
 * hunt and every run. --gear none is the bare fixture (starter weapon only).
 */
const GEAR = (() => { const i = process.argv.indexOf('--gear'); return i >= 0 ? process.argv[i + 1] : 'uncommon'; })();
const GEAR_SLOTS = ['weaponMain', 'head', 'chest', 'legs', 'gloves', 'boots', 'ring', 'amulet'];
function gearUp(char, spec, level, index) {
  GEAR_SLOTS.forEach((slot, j) => {
    const rng = makeRng((level * 7919 + index * 131 + j * 17 + 1) >>> 0);
    const ids = Object.keys(Items).filter(id => {
      const it = Items[id];
      if (it.natural || it.type === 'part' || it.historic || /^bone_/.test(id)) return false;
      if (slot === 'weaponMain') return it.type === 'weapon' && it.weaponType === spec.weaponType;
      return it.type === 'armor' && it.slot === slot;
    });
    const base = pickBaseId(ids, level, { rng });
    const inst = createItemInstance(base, { rarity: GEAR, itemLevel: level, rng });
    if (!inst) throw new Error(`--gear: could not roll ${base} for ${slot}`);
    char.equipment[slot] = inst;
  });
  rebuildCharacterStats(char);
  char.currentHP = char.maxHP;
  char.currentMP = char.maxMP;
}

/**
 * --save: the party of an exported save (the game's Export Save file, or a
 * bare slot), loaded fresh for every hunt through the game's own loader
 * (GameState.load, migrations included), at full HP and MP as it leaves camp.
 * Its level and size are its own; --levels and --party are ignored.
 */
const SAVE_TEXT = (() => {
  const i = process.argv.indexOf('--save');
  return i >= 0 ? fs.readFileSync(process.argv[i + 1], 'utf8') : null;
})();
function partyFromSave() {
  const parsed = parseImport(SAVE_TEXT);
  if (!parsed.ok) throw new Error('--save: ' + parsed.reason);
  localStorage.setItem('bmSave___huntsim', JSON.stringify(parsed.save));
  if (!GameState.load('__huntsim')) throw new Error('--save: the game refused it: ' + GameState.lastLoadError);
  const party = GameState.party.slice();
  if (!party.length) throw new Error('--save: the save has no party');
  for (const c of party) { c.status = 'active'; c.currentHP = c.maxHP; c.currentMP = c.maxMP; }
  return { party, slots: { ...GameState.partySlots } };
}

// ---------------------------------------------------------------------------
// XP is recorded, not applied: the party stays at the level being measured.

let xpSink = null;
GameState.awardXPTo = function (chars, amount) {
  const got = (Array.isArray(chars) ? chars : []).filter(c => c && c.status !== 'dead');
  if (xpSink && amount > 0) for (const c of got) xpSink[c.name] = (xpSink[c.name] || 0) + amount;
  return { leveledUpNames: [], summaries: [] };
};

// ---------------------------------------------------------------------------
// The world a sim hunt writes to: records what it pays, stubs the save.

function simWorld(party) {
  const w = { huntPoints: [], banked: 0 };
  w.party = () => party;
  w.nightFalls = () => {};
  w.dayBreaks = () => {};
  w.awardHuntPoints = (n) => { w.huntPoints.push(n); };
  w.bankItems = (items) => { w.banked += items.length; };
  w.awardXP = (pool) => GameState.awardXPPool(pool, party);   // as GAME_WORLD.awardXP: completion and event XP
  w.favor = () => {};
  w.falseGod = () => {};
  w.bond = () => 0;
  w.followedHouse = () => null;
  w.hasQuestFlag = () => false;
  w.questFlag = () => {};
  w.lore = () => {};
  w.houseHolder = () => null;
  w.ownTribe = () => null;
  w.rivalDevotion = () => 0;
  w.tribeName = () => 'the tribe';
  w.tribeRep = () => 0;
  return w;
}

// ---------------------------------------------------------------------------
// The fight player

function fightPlayer(rand) {
  const hpShare = (c) => (c.maxHP ? c.currentHP / c.maxHP : 1);
  const alive = (c) => c && c.status !== 'incapacitated' && c.status !== 'dead' && c.currentHP > 0;
  return (host, actor) => {
    let casts = 0;
    for (let guard = 0; guard < 4 && !host.combatEnded; guard++) {
      // A reaction to the last cast can knock the actor out mid-turn.
      if (!alive(actor) || !host.turnOrder.includes(actor)) break;
      // The action menu's kit (CombatScene: own skills, weapon, class), by id.
      const kit = new Map();
      for (const s of [...(actor.skills || []), ...getWeaponSkillsFor(actor), ...getClassSkillsFor(actor)]) if (s?.id && !kit.has(s.id)) kit.set(s.id, s);
      const ready = [...kit.values()].filter(s => !s.hidden && s.mechanic !== 'reaction' && host._skillIsUsable(actor, s));
      if (!ready.length) break;
      const hurt = host._party().filter(alive).filter(c => hpShare(c) < HEAL_BELOW_HP).sort((a, b) => hpShare(a) - hpShare(b));
      const heals = ready.filter(s => (s.tags || []).includes('heal') && s.targetRequirement === 'ally');
      let pick = null, target = null;
      if (hurt.length && heals.length) {
        pick = heals[Math.floor(rand() * heals.length)];
        const legal = host._validTargetsFor(actor, pick).map(sl => sl.char);
        target = hurt.find(c => legal.includes(c)) || null;
        if (!target) pick = null;
      }
      if (!pick) {
        const offence = ready.filter(s => s.targetRequirement === 'enemy');
        if (!offence.length) break;
        const nonBasic = offence.filter(s => s.id !== 'basic_attack');
        const pool = nonBasic.length ? nonBasic : offence;
        pick = pool[Math.floor(rand() * pool.length)];
        if (pick.requiresTarget !== false) {
          const legal = host._validTargetsFor(actor, pick).map(sl => sl.char).filter(alive);
          target = legal.sort((a, b) => a.currentHP - b.currentHP)[0] || null;
          if (!target && pick.requiresTarget) break;
        }
      }
      const r = cast(host, actor, pick, target);
      if (r.ok === false) break;
      casts++;
    }
    return [];   // everything was cast above; runFight just ends the turn
  };
}

/** Run the pending encounter as a real fight. Returns what happened. */
function fight(h, party, slots, fightSeed, rec) {
  const spec = h.beginFight();
  if (!spec.ok) throw new Error('beginFight refused: ' + spec.reason);
  const killsBefore = h.getState().kills.length;
  const hpBefore = livingHPShare(party);
  const cause = h.encounter()?.cause || null;
  seedCombat(fightSeed);
  const host = createCombatHost(CombatScene);
  let hunterTurns = 0;
  const player = fightPlayer(makeRng(fightSeed ^ 0x5bd1e995));
  const counted = (hh, actor) => { hunterTurns++; return player(hh, actor); };
  host.__begin({ party, partySlots: slots, huntFight: { ...spec, hunt: h } });
  const res = runFight(host, counted, { maxTurns: MAX_FIGHT_TURNS });
  const rounds = host.combatRound - (host._combatStartRound ?? host.combatRound) + 1;
  if (TRACE) {
    loud();
    realLog(`  FIGHT ${spec.kind} first=${spec.first} ambush=${!!spec.ambush} rounds=${rounds} hunterTurns=${hunterTurns} ${JSON.stringify(res)}`);
    realLog('    party   ' + party.map(c => `${c.name} ${c.currentHP}/${c.maxHP} ${c.status}`).join(' | '));
    realLog('    enemies ' + host.enemies.map(e => `${e.name} ${e.currentHP}/${e.maxHP}`).join(' | '));
    for (const l of host.__logLines().slice(-TRACE_LINES)) realLog('      ' + l);
    quietEngine();
  }
  const st = h.getState();
  let outcome;
  if (st.finished) outcome = 'wipe';
  else if (st.kills.length > killsBefore) outcome = 'won';
  else if (res.hitTurnCap) { h.flee({ reason: 'fled' }); outcome = 'capped'; }
  else outcome = 'other';
  const grades = spec.scenario.enemies.map(e => e.grade || '-');
  const hpIn = Math.round(100 * hpBefore);
  rec.fights.push({ outcome, cause, rounds, hunterTurns, ambush: !!spec.ambush, first: spec.first, enemies: spec.scenario.enemies.length, kind: spec.kind,
    family: h.getState().kills.at(-1)?.family ?? spec.scenario.enemies[0]?.type ?? null, grades, hpIn,
    partyInitiative: spec.partyInitiative, enemyInitiative: spec.enemyInitiative,
    hpOut: Math.round(100 * livingHPShare(party)), kos: party.filter(c => c.currentHP <= 1).length });
  return outcome;
}

// ---------------------------------------------------------------------------
// The map player

function planStep(h, v, isGoal, { avoid }) {
  const st = h.getState();
  const known = v.tiles;
  const here = v.pos;
  const hostile = new Set(v.occupants.filter(o => o.kind !== 'event').map(o => o.tile));
  const passable = (id) => (known[id] ? isPassable(st.map.tiles[id]) : true);
  const nbrs = (id) => {
    const all = mapNeighbors(st.map, id);
    if (known[id]) return all;
    const sec = parseTileId(id).section;
    return all.filter(n => parseTileId(n).section === sec);
  };
  const prev = new Map([[here, null]]);
  const queue = [here];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    if (id !== here && isGoal(id)) {
      let at = id;
      while (prev.get(at) !== here) at = prev.get(at);
      return at;
    }
    for (const n of [...nbrs(id)].sort()) {
      if (prev.has(n) || !passable(n)) continue;
      if (avoid && hostile.has(n) && !isGoal(n)) continue;
      prev.set(n, id);
      queue.push(n);
    }
  }
  return avoid ? planStep(h, v, isGoal, { avoid: false }) : null;
}

function livingHPShare(party) {
  const up = party.filter(c => c.status !== 'dead');
  const max = up.reduce((t, c) => t + c.maxHP, 0);
  return max ? up.reduce((t, c) => t + Math.max(0, c.currentHP), 0) / max : 1;
}

function mealsFrom(h) {
  const food = h.foodInPack();
  const mains = [], adds = [];
  for (const [id, n] of Object.entries(food)) {
    const k = Items[id]?.food?.kind;
    for (let i = 0; i < n; i++) (k === 'fish' || k === 'meat' ? mains : k === 'forage' ? adds : []).push(id);
  }
  return mains.map((m, i) => ({ main: m, addition: adds[i] || undefined }));
}

function playHunt({ zoneId, size, objective, level, partySize, policy, huntSeed, rations }) {
  const { party, slots } = partyAt(level, partySize);
  const world = simWorld(party);
  const plan = { objective, size, bonusObjectives: [], mods: {}, itemLevel: getZone(zoneId).danger || 1 };
  const h = createMapHunt(zoneId, { plan, supplies: CAMP_ISSUE + rations, seed: huntSeed }, world);
  const zone = getZone(zoneId);
  const rec = {
    zoneId, size, objective, level, partySize, policy, seed: huntSeed,
    fights: [], moves: 0, camps: 0, forages: 0, eats: 0, harvests: 0, harvestTime: 0,
    events: 0, supplyStart: h.view().supplies, supplyMin: h.view().supplies, zeroMoves: 0,
    hungryMoves: 0, actions: 0, perception: h.stats().perception,
  };
  xpSink = {};
  let campsInARow = 0;
  let campedHere = false;   // stepped into cover to camp: camp next, do not step again
  let stuck = null;
  const avoid = true;
  for (let a = 0; a < MAX_ACTIONS; a++) {
    rec.actions = a;
    if (h.getState().finished) break;
    if (h.encounter()) {
      fight(h, party, slots, (huntSeed * 7919 + rec.fights.length) >>> 0, rec);
      if (h.getState().finished) break;
      const sp = h.view().spoils;
      if (sp) {
        const take = sp.parts.filter(p => p.specimen).map(p => p.id);
        const r = h.harvest({ take, meat: true });
        if (r.ok) { rec.harvests++; rec.harvestTime += r.time; }
      }
      continue;
    }
    let v = h.view();
    if (v.event) {
      const prim = v.objectives[0];
      const site = v.objectiveSites.find(s => s.objective === 'commune');
      if (prim.id === 'commune' && site && site.tile === v.pos && !prim.done) {
        const ev = v.event;
        h.resolveEvent(ev.shape === 'choice' ? { option: 0 } : ev.shape === 'check' ? { option: 0 } : ev.shape === 'puzzle' ? { answer: 0 } : { accept: false });
        if (h.view().event) h.leaveEvent();
      } else h.leaveEvent();
      continue;
    }
    // Eat raw food when hungry.
    if (['hungry', 'starving'].includes(v.hunger)) {
      const raw = Object.keys(h.foodInPack()).find(id => Items[id]?.food?.rawEdible);
      if (raw && h.eat(raw, 1).ok) { rec.eats++; continue; }
    }
    // Camp when hurt, in cover: a hunting pack finds a camp only if its
    // perception beats the camp tile's concealment (HuntWorld.packFindsCamp),
    // so a player steps into the best-hidden neighbour first when it hides
    // better than here (one step, known ground, no hostile seen on it).
    if (livingHPShare(party) < CAMP_BELOW_HP && campsInARow < MAX_CAMPS_IN_A_ROW) {
      const concOf = (id) => GROUNDS[v.tiles[id]?.ground]?.concealment || 0;
      const hostileAt = new Set(v.occupants.map(o => o.tile));
      const cover = v.moves.filter(m => v.tiles[m.tile] && !hostileAt.has(m.tile))
        .sort((a, b) => concOf(b.tile) - concOf(a.tile) || a.tile.localeCompare(b.tile))[0];
      if (!campedHere && cover && concOf(cover.tile) > concOf(v.pos) && !packFindsCamp(concOf(cover.tile))) {
        const r = h.move(cover.tile);
        if (r.ok) { rec.moves++; campedHere = true; continue; }
      }
      campedHere = false;
      const r = h.camp({ meals: mealsFrom(h) });
      if (r.ok) { rec.camps++; campsInARow++; continue; }
    }
    // Forage when low.
    if (v.supplies < FORAGE_BELOW_SUPPLIES && !v.tiles[v.pos]?.gathered) {
      const t = h.getState().map.tiles[v.pos];
      const r = t.fishing ? h.fish() : h.forage();
      if (r.ok) { rec.forages++; continue; }
    }
    // Where to?
    const prim = v.objectives[0];
    const sighted = v.occupants.filter(o => o.kind === 'beast' || o.kind === 'cultist');
    let goal = null;
    if (!prim.done) {
      switch (prim.id) {
        case 'scout': case 'retrieve': case 'commune': {
          const sites = new Set(v.objectiveSites.filter(s => !s.done).map(s => s.tile));
          if (sites.size) goal = (id) => sites.has(id);
          break;
        }
        case 'apex': {
          const ap = sighted.filter(o => o.family === zone.apex.family && o.topGrade === 'great');
          if (ap.length) { const t = new Set(ap.map(o => o.tile)); goal = (id) => t.has(id); }
          break;
        }
        case 'cull': {
          const fam = sighted.filter(o => o.family === prim.family);
          if (fam.length) { const t = new Set(fam.map(o => o.tile)); goal = (id) => t.has(id); }
          break;
        }
        default: stuck = `no strategy for ${prim.id}`;
      }
      if (stuck) break;
      if (!goal) goal = (id) => !v.tiles[id];   // explore: the nearest unseen tile
    } else if (policy === 'thorough' && sighted.length) {
      const t = new Set(sighted.map(o => o.tile));
      goal = (id) => t.has(id);
    } else {
      if (v.tiles[v.pos]?.exit) {
        const r = h.exit();
        if (r.ok) break;
      }
      goal = (id) => !!v.tiles[id]?.exit;
    }
    let step = planStep(h, v, goal, { avoid: avoid && !prim.done ? true : policy !== 'thorough' });
    if (!step && !prim.done) {
      // The target is known but no known way leads to it (another section,
      // its passage unseen): explore until one does.
      step = planStep(h, v, (id) => !v.tiles[id], { avoid: true });
    }
    if (!step && !prim.done) {
      // Nothing left to explore and the target is not in sight: give up and leave.
      step = planStep(h, v, (id) => !!v.tiles[id]?.exit, { avoid: true });
      if (!step && v.tiles[v.pos]?.exit) { h.exit(); break; }
    }
    if (!step) { stuck = 'no path'; break; }
    const r = h.move(step);
    if (!r.ok) { stuck = 'move refused: ' + r.reason; break; }
    campsInARow = 0;
    rec.moves++;
    if (r.event) rec.events++;
    v = h.view();
    rec.supplyMin = Math.min(rec.supplyMin, v.supplies);
    if (v.supplies <= 0) rec.zeroMoves++;
    if (['hungry', 'starving'].includes(v.hunger)) rec.hungryMoves++;
  }
  const st = h.getState();
  const prog = h.objectives();
  rec.outcome = st.finished === 'exit' ? 'exit' : st.finished === 'wipe' ? 'wipe' : 'stuck';
  if (rec.outcome === 'stuck') rec.stuck = stuck || 'ran out of actions';
  rec.primaryDone = rec.outcome === 'exit' ? !!st.reward?.primaryDone : !!prog[0].done;
  rec.time = st.time;
  rec.day = R.clockAt(st.time).day;
  rec.supplyEnd = st.supplies;
  rec.knockouts = st.knockouts || 0;
  const xp = Object.values(xpSink);
  rec.xpPerHunter = partySize ? xp.reduce((a, b) => a + b, 0) / partySize : 0;
  xpSink = null;
  rec.huntPoints = world.huntPoints.reduce((a, b) => a + b, 0);
  rec.exitHuntPoints = st.reward?.huntPoints || 0;
  rec.fightHuntPoints = rec.huntPoints - rec.exitHuntPoints;
  return rec;
}

// ---------------------------------------------------------------------------
// Aggregation

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (xs, p) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const r1 = (x) => Math.round(x * 10) / 10;

function summarise(recs) {
  const fights = recs.flatMap(r => r.fights);
  const won = fights.filter(f => f.outcome === 'won');
  return {
    n: recs.length,
    donePct: r1(100 * mean(recs.map(r => (r.outcome === 'exit' && r.primaryDone ? 1 : 0)))),
    wipePct: r1(100 * mean(recs.map(r => (r.outcome === 'wipe' ? 1 : 0)))),
    stuck: recs.filter(r => r.outcome === 'stuck').length,
    perception: r1(mean(recs.map(r => r.perception))),
    moves: r1(mean(recs.map(r => r.moves))),
    actions: r1(mean(recs.map(r => r.actions))),
    days: r1(mean(recs.map(r => r.day))),
    fights: r1(mean(recs.map(r => r.fights.length))),
    fightsP90: pct(recs.map(r => r.fights.length), 0.9),
    roundsPerFight: r1(mean(won.map(f => f.rounds))),
    rounds: r1(mean(recs.map(r => r.fights.reduce((t, f) => t + f.rounds, 0)))),
    hunterTurns: r1(mean(recs.map(r => r.fights.reduce((t, f) => t + f.hunterTurns, 0)))),
    ambushPct: r1(100 * mean(fights.map(f => (f.ambush ? 1 : 0)))),
    enemyFirstPct: r1(100 * mean(fights.map(f => (f.first === 'enemy' ? 1 : 0)))),
    // Who started it: the party walking in, or a pack reaching the party (on the map or at camp).
    caughtPct: r1(100 * mean(fights.map(f => (f.cause && f.cause !== 'party' ? 1 : 0)))),
    fightWinPct: r1(100 * mean(fights.map(f => (f.outcome === 'won' ? 1 : 0)))),
    suppliesUsed: r1(mean(recs.map(r => r.supplyStart - r.supplyEnd))),
    ranOutPct: r1(100 * mean(recs.map(r => (r.zeroMoves > 0 ? 1 : 0)))),
    camps: r1(mean(recs.map(r => r.camps))),
    harvestTime: r1(mean(recs.map(r => r.harvestTime))),
    knockouts: r1(mean(recs.map(r => r.knockouts))),
    events: r1(mean(recs.map(r => r.events))),
    xpPerHunter: r1(mean(recs.map(r => r.xpPerHunter))),
    huntPoints: r1(mean(recs.map(r => r.huntPoints))),
    fightHuntPoints: r1(mean(recs.map(r => r.fightHuntPoints))),
    exitHuntPoints: r1(mean(recs.map(r => r.exitHuntPoints))),
  };
}

const secRound = Number(opt('sec-round', NaN));
const secMove = Number(opt('sec-move', NaN));
const realMinutes = (s) => (Number.isFinite(secRound) && Number.isFinite(secMove)
  ? r1((s.rounds * secRound + s.actions * secMove) / 60) : null);

// ---------------------------------------------------------------------------
// Run

const smoke = flag('smoke');
const zoneIds = list('zones', Object.keys(ZONES).filter(id => ZONES[id].palette && ZONES[id].apex));
const sizes = list('sizes', smoke ? ['small'] : ['small', 'medium', 'large']);
const objectives = list('objectives', ['scout', 'apex', 'cull', 'retrieve', 'commune']);
let levels = list('levels', smoke ? ['3'] : ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']).map(Number);
let partySizes = list('party', ['4']).map(Number);
if (SAVE_TEXT) {
  const { party } = partyFromSave();
  levels = [Math.max(...party.map(c => c.level || 1))];
  partySizes = [party.length];
  realLog('--save: ' + party.map(c => `${c.name} L${c.level} ${c.maxHP} HP`).join(', '));
}
const policies = list('policy', ['objective']);
const seeds = Number(opt('seeds', smoke ? 2 : 10));
const seedBase = Number(opt('seed-base', 1000));
const rations = Number(opt('rations', R.RATIONS_PACK_CAP));
const quiet = flag('quiet');

// ---------------------------------------------------------------------------
// --calibrate: the same party and the same fight player against the pit's
// fixed fights, the owner's yardsticks (chunk 13a): a level 2-3 party should
// beat encounter 3, level 4 encounters 4 and 5, and a strong level-5 party in
// good gear Gorrek Reckoning V. Win rate and rounds per scenario and level.

const CAL_SCENARIOS = list('scenarios', ['training_encounter_3', 'training_encounter_4', 'training_encounter_5',
  'training_encounter_6', 'training_encounter_6_reckoning_3', 'training_encounter_6_reckoning_5']);

function calibrationFight(level, partySize, scenarioId, fightSeed) {
  const { party, slots } = partyAt(level, partySize);
  seedCombat(fightSeed);
  const host = createCombatHost(CombatScene);
  host.__begin({ party, partySlots: slots, scenarioId });
  const res = runFight(host, fightPlayer(makeRng(fightSeed ^ 0x5bd1e995)), { maxTurns: MAX_FIGHT_TURNS });
  const won = (host.enemies || []).every(e => e.status === 'incapacitated' || e.status === 'dead' || e.currentHP <= 0);
  const rounds = host.combatRound - (host._combatStartRound ?? host.combatRound) + 1;
  return { won, rounds, capped: res.hitTurnCap };
}

if (flag('calibrate')) {
  const t = Date.now();
  const rows = [];
  for (const partySize of partySizes) for (const level of levels) {
    const row = { key: SAVE_TEXT ? `save L${level} p${partySize}` : `gear ${GEAR} L${String(level).padStart(2)} p${partySize}` };
    for (const sc of CAL_SCENARIOS) {
      const out = [];
      quietEngine();
      try { for (let k = 0; k < seeds; k++) out.push(calibrationFight(level, partySize, sc, (seedBase + k) * 2654435761 >>> 0)); }
      finally { loud(); }
      const wins = out.filter(o => o.won);
      row[sc] = `${Math.round(100 * wins.length / out.length)}% ${wins.length ? r1(mean(wins.map(o => o.rounds))) + 'r' : ''}${out.some(o => o.capped) ? ' CAP' : ''}`;
    }
    rows.push(row);
    if (!quiet) realLog(row.key + '  ' + CAL_SCENARIOS.map(sc => row[sc]).join(' | '));
  }
  const short = (sc) => sc.replace('training_encounter_', 'enc').replace('_reckoning_', ' R');
  const head = ['', ...CAL_SCENARIOS.map(short)];
  const body = rows.map(r => [r.key, ...CAL_SCENARIOS.map(sc => r[sc])]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map(b => b[i].length)));
  realLog('\nCALIBRATION: win rate and mean rounds of the wins, ' + seeds + ' fights each');
  realLog(head.map((h, i) => (i ? h.padStart(w[i]) : h.padEnd(w[i]))).join('  '));
  for (const b of body) realLog(b.map((x, i) => (i ? x.padStart(w[i]) : x.padEnd(w[i]))).join('  '));
  realLog(`\n${((Date.now() - t) / 1000).toFixed(1)} s; heap ${Math.round(process.memoryUsage().heapUsed / 1048576)} MB`);
  process.exit(0);
}

const t0 = Date.now();
const cells = [];
const all = [];
for (const policy of policies) for (const partySize of partySizes) for (const level of levels) for (const zoneId of zoneIds) for (const size of sizes) for (const objective of objectives) {
  const recs = [];
  const c0 = Date.now();
  for (let k = 0; k < seeds; k++) {
    quietEngine();
    let rec;
    try { rec = playHunt({ zoneId, size, objective, level, partySize, policy, huntSeed: seedBase + k, rations }); }
    finally { loud(); }
    recs.push(rec);
  }
  all.push(...recs);
  const key = `${policy}|p${partySize}|L${level}|${zoneId}|${size}|${objective}`;
  const s = summarise(recs);
  cells.push({ key, policy, partySize, level, zoneId, size, objective, ...s, ms: Date.now() - c0 });
  if (!quiet) realLog(`${key.padEnd(52)} n${s.n} done ${s.donePct}% wipe ${s.wipePct}% moves ${s.moves} fights ${s.fights} rounds ${s.rounds} xp ${s.xpPerHunter} hp ${s.huntPoints}  ${Date.now() - c0} ms`);
}
const elapsed = Date.now() - t0;

// Tables: by size and level (the pacing question), averaged over zones and objectives.
function rollup(by) {
  const groups = new Map();
  for (const r of all) {
    const k = by(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return [...groups.entries()].map(([k, recs]) => ({ key: k, ...summarise(recs) }));
}

const COLS = [
  ['n', 'n'], ['done%', 'donePct'], ['wipe%', 'wipePct'], ['stuck', 'stuck'], ['perc', 'perception'], ['moves', 'moves'], ['acts', 'actions'], ['days', 'days'],
  ['fights', 'fights'], ['rd/fight', 'roundsPerFight'], ['rounds', 'rounds'], ['ambush%', 'ambushPct'], ['caught%', 'caughtPct'], ['fightWin%', 'fightWinPct'], ['enemy1st%', 'enemyFirstPct'],
  ['supUsed', 'suppliesUsed'], ['ranOut%', 'ranOutPct'], ['camps', 'camps'], ['harvT', 'harvestTime'], ['KOs', 'knockouts'], ['events', 'events'],
  ['XP/hunter', 'xpPerHunter'], ['HuntPts', 'huntPoints'], ['fightHP', 'fightHuntPoints'], ['exitHP', 'exitHuntPoints'],
];
function table(title, rows) {
  realLog('\n' + title);
  const head = ['', ...COLS.map(c => c[0]), 'realMin'];
  const body = rows.map(r => [r.key, ...COLS.map(c => String(r[c[1]])), String(realMinutes(r) ?? '-')]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map(b => b[i].length)));
  realLog(head.map((h, i) => (i ? h.padStart(w[i]) : h.padEnd(w[i]))).join('  '));
  for (const b of body) realLog(b.map((x, i) => (i ? x.padStart(w[i]) : x.padEnd(w[i]))).join('  '));
}

const bySizeLevel = rollup(r => `${r.policy} p${r.partySize} ${r.size.padEnd(6)} L${String(r.level).padStart(2)}`);
const bySizeObjective = rollup(r => `${r.policy} p${r.partySize} ${r.size.padEnd(6)} ${r.objective}`);
const byZone = rollup(r => `${r.policy} p${r.partySize} ${r.zoneId}`);
table('BY SIZE AND LEVEL (mean over zones and objectives)', bySizeLevel);
table('BY SIZE AND OBJECTIVE (mean over zones and levels)', bySizeObjective);
table('BY ZONE', byZone);

// Pace to level 10: hunts = sum over L of XP needed at L / measured XP per hunter per hunt at L.
const pace = [];
for (const policy of policies) for (const partySize of partySizes) for (const size of sizes) {
  const perLevel = {};
  for (const level of levels) {
    const recs = all.filter(r => r.policy === policy && r.partySize === partySize && r.size === size && r.level === level);
    if (recs.length) perLevel[level] = summarise(recs);
  }
  const need = [];
  for (let L = 1; L < LEVEL_CAP; L++) need.push(L);
  const missing = need.filter(L => !perLevel[L]);
  let hunts = null, rounds = null, actions = null;
  if (!missing.length && need.every(L => perLevel[L].xpPerHunter > 0)) {
    hunts = 0; rounds = 0; actions = 0;
    for (const L of need) {
      const hL = getXPNeededForLevel(L) / perLevel[L].xpPerHunter;
      hunts += hL; rounds += hL * perLevel[L].rounds; actions += hL * perLevel[L].actions;
    }
  }
  pace.push({ policy, partySize, size, hunts: hunts == null ? null : r1(hunts), rounds: rounds == null ? null : Math.round(rounds),
    actions: actions == null ? null : Math.round(actions),
    hours: hunts != null && Number.isFinite(secRound) && Number.isFinite(secMove) ? r1((rounds * secRound + actions * secMove) / 3600) : null,
    missingLevels: missing });
}
realLog('\nPACE TO LEVEL ' + LEVEL_CAP + ' (every hunt this size; XP needed from getXPNeededForLevel, XP per hunt measured at each level)');
for (const p of pace) {
  realLog(`  ${p.policy} p${p.partySize} ${p.size.padEnd(6)}  ` + (p.hunts == null
    ? `needs levels ${p.missingLevels.join(',') || '(xp 0 somewhere)'}`
    : `${p.hunts} hunts, ${p.rounds} combat rounds, ${p.actions} map actions` + (p.hours != null ? `, ~${p.hours} real hours` : '  (real hours need --sec-round and --sec-move)')));
}
realLog(`\n${all.length} hunts, ${all.reduce((t, r) => t + r.fights.length, 0)} fights in ${(elapsed / 1000).toFixed(1)} s; heap ${Math.round(process.memoryUsage().heapUsed / 1048576)} MB`);

if (opt('fightlog')) {
  fs.writeFileSync(opt('fightlog'), all.flatMap(r => r.fights.map(f => JSON.stringify({ zone: r.zoneId, size: r.size, level: r.level, party: r.partySize, seed: r.seed, ...f }))).join('\n') + '\n');
  realLog('fight log written to ' + opt('fightlog'));
}

const report = {
  meta: { at: new Date().toISOString(), args, seeds, seedBase, rations, zones: zoneIds, sizes, objectives, levels, partySizes, policies, ms: elapsed },
  cells, bySizeLevel, bySizeObjective, byZone, pace,
};
// One line per row, so a committed report stays small and a before/after diff reads row by row.
const compactJSON = (obj) => '{\n' + Object.entries(obj).map(([k, v]) => JSON.stringify(k) + ': '
  + (Array.isArray(v) ? '[\n' + v.map(x => '  ' + JSON.stringify(x)).join(',\n') + '\n]' : JSON.stringify(v))).join(',\n') + '\n}\n';
if (opt('json')) { fs.writeFileSync(opt('json'), compactJSON(report)); realLog('report written to ' + opt('json')); }

if (opt('compare')) {
  const before = JSON.parse(fs.readFileSync(opt('compare'), 'utf8'));
  const old = new Map(before.cells.map(c => [c.key, c]));
  realLog('\nCOMPARE against ' + opt('compare'));
  const keys = ['donePct', 'wipePct', 'moves', 'days', 'fights', 'rounds', 'suppliesUsed', 'camps', 'xpPerHunter', 'huntPoints'];
  for (const c of cells) {
    const o = old.get(c.key);
    if (!o) { realLog('  ' + c.key + '  (new cell)'); continue; }
    const diffs = keys.filter(k => o[k] !== c[k]).map(k => `${k} ${o[k]} -> ${c[k]}`);
    if (diffs.length) realLog('  ' + c.key + '  ' + diffs.join(', '));
  }
  for (const p of pace) {
    const o = (before.pace || []).find(x => x.policy === p.policy && x.partySize === p.partySize && x.size === p.size);
    if (o && o.hunts !== p.hunts) realLog(`  pace ${p.policy} p${p.partySize} ${p.size}: ${o.hunts} -> ${p.hunts} hunts`);
  }
}

if (smoke) {
  let failures = 0;
  const check = (label, ok, detail = '') => { realLog('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : '')); if (!ok) failures++; };
  realLog('\n=== huntsim smoke ===');
  check('every hunt ends at an exit or a wipe (none stuck)', all.every(r => r.outcome !== 'stuck'), all.filter(r => r.outcome === 'stuck').map(r => `${r.zoneId}/${r.objective}/${r.seed}: ${r.stuck}`).join('; '));
  check('every fight ends (no fight hits the turn cap)', all.every(r => r.fights.every(f => f.outcome !== 'capped' && f.outcome !== 'other')));
  check('supplies never negative', all.every(r => r.supplyMin >= 0 && r.supplyEnd >= 0));
  check('a won beast fight pays XP to the party', all.every(r => !r.fights.some(f => f.outcome === 'won') || r.xpPerHunter > 0));
  check('every clean exit with the primary done paid Hunt Points', all.filter(r => r.outcome === 'exit' && r.primaryDone).every(r => r.exitHuntPoints > 0));
  check('fights happened', all.reduce((t, r) => t + r.fights.length, 0) > 0);
  realLog(failures ? `\n${failures} FAILED` : '\nhuntsim smoke: all passed');
  process.exit(failures ? 1 : 0);
}
