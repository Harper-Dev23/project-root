// tools/headless/standing.mjs
//
// Standing, save-wide (Exploration System v2, chunk 10a): src/systems/Standing.js,
// data/standing.js, the rep rescale in TribeRelations.js, GAME_WORLD's daily
// tick and Hunt Point rep, and the v8 save migration. Everything is called
// through the real exports; nothing is re-derived.
//
// What it proves:
//   - the rep curve: rescaled x REP_SCALE, every pre-10a score keeps its rank
//     once multiplied (the old table is kept below as a FIXTURE of the old
//     code, not a formula), and how many hunts a player needs to reach each
//     rank through GAME_WORLD.awardHuntPoints
//   - the claiming rule, scripted: eligible at the threshold and not before,
//     held only once accepted, switching releases the old house, taking a
//     rival's house needs the margin, a dithering player loses the house to a
//     rival, rivals wait out the grace period, never court a held house, and
//     nobody ticks before the player has a tribe
//   - seasons: three seasons day by day through Standing.dayBreak, the claims,
//     the tallies, legacy only growing, the head start, joinSeason
//   - the real game world: GAME_WORLD.dayBreaks over a season on the real
//     ProgressionManager ends it once and resets the race
//   - the save: a REAL v7 save (tools/snapshots/save-v7-fixture.json, written
//     by the v7 build at 969967d) migrates to v8: rep x10 with every rank
//     unchanged, a standing record that is the same on every migration, old
//     Slain as Watched deaths with no house (rite open, intercession not),
//     the map hunt still live; and standing survives a save and load
//
// USAGE
//   node tools/headless/standing.mjs                 run the checks
//   node tools/headless/standing.mjs --json <path>   write the golden
//   node tools/headless/standing.mjs --diff <path>   compare against it

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
installPhaserStub(10);

const S = await import('../../src/systems/Standing.js');
const D = await import('../../data/standing.js');
const TR = await import('../../src/systems/TribeRelations.js');
const GameState = (await import('../../src/systems/GameState.js')).default;
const { SAVE_VERSION } = await import('../../src/systems/GameState.js');
const PM = (await import('../../src/systems/ProgressionManager.js')).default;
const { HuntManager, GAME_WORLD } = await import('../../src/systems/HuntManager.js');

const { HOUSES, CLAIM_THRESHOLD: CLAIM, TAKE_MARGIN: MARGIN, RIVAL_GRACE_DAYS: GRACE, SEASON_DAYS } = D;
const RIVALS_OF = (t) => TR.TRIBE_IDS.filter(x => x !== t);

// =============================================================================
console.log('=== reputation, rescaled ===');
{
  // FIXTURE: the pre-10a threshold table exactly as TribeRelations.js had it
  // at 969967d. Kept to prove the rescale moved nobody's rank, not re-derived.
  const OLD = [-50, -20, -5, 26, 66, 106];
  const oldIndex = (s) => { let i = 0; while (i < OLD.length && s >= OLD[i]) i++; return i; };
  let moved = 0;
  for (let s = -120; s <= 200; s++) if (TR.getRepIndex(s * TR.REP_SCALE) !== oldIndex(s)) moved++;
  check(`every pre-10a score from -120 to 200 keeps its rank once x${TR.REP_SCALE}`, moved === 0, `${moved} moved`);
  const bounds = [-501, -500, -201, -200, -51, -50, 259, 260, 659, 660, 1059, 1060];
  golden.repIndexAtBounds = bounds.map(b => [b, TR.getRepIndex(b)]);
  check('each threshold is where the header says', same(golden.repIndexAtBounds.map(p => p[1]), [0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6]));
  golden.defaults = { ...TR.DEFAULT_TRIBE_REP };
  check('the default scores still start every tribe Neutral / Initiate', TR.TRIBE_IDS.every(t => TR.getRepIndex(TR.DEFAULT_TRIBE_REP[t]) === 3));
  check('a rival tribe still caps at Friendly', TR.clampRepScore(99999, false) === 1050 && TR.getRepIndex(1050) === 5);

  // What it takes now, through the real game world: a hunt paying 45 Hunt
  // Points (a Small hunt's completion 20 + about three beast fights at 8).
  PM.reset();
  PM.setTribe('elseth');
  const ranks = [];
  let hunts = 0;
  while (TR.getRepIndex(PM.getTribeRep('elseth')) < 6 && hunts < 2000) {
    for (const n of [20, 8, 8, 9]) GAME_WORLD.awardHuntPoints(n);
    hunts++;
    const idx = TR.getRepIndex(PM.getTribeRep('elseth'));
    if (!ranks[idx]) ranks[idx] = hunts;
  }
  golden.huntsToRank = { member: ranks[4], trusted: ranks[5], champion: ranks[6], huntPointsPerHunt: 45 };
  console.log(`    45 Hunt Points a hunt: Member after ${ranks[4]} hunts, Trusted ${ranks[5]}, Champion ${ranks[6]}`);
  check('Champion takes several seasons of hunting (over 80 hunts; ~40 small hunts is a season)', ranks[6] > 80, `${ranks[6]} hunts`);
  check('one leader quest (+40) no longer lifts a new tribe out of Initiate', TR.getRepIndex(TR.DEFAULT_TRIBE_REP.elseth + TR.LEADER_QUEST_REP_GAIN) === 3);
  const st = S.newStanding(1);
  const got = [3, 3, 3, 1, 7, 2].map(n => S.repFromHuntPoints(st, n));
  check('Hunt Points turn into rep with the remainder carried, never lost', same(got, [0, 1, 0, 1, 1, 0]) && st.repCarry === 4, `${got} carry ${st.repCarry}`);
  PM.reset();
  GAME_WORLD.awardHuntPoints(50);
  check('no tribe pledged: Hunt Points pay no rep', TR.TRIBE_IDS.every(t => PM.getTribeRep(t) === TR.DEFAULT_TRIBE_REP[t]));
}

// =============================================================================
console.log('=== the claiming rule ===');
{
  const me = 'styx';
  const at = (st) => ({ holds: { ...st.holds }, mine: { ...st.devotion[me] } });
  const scen = {};

  // Eligible at the threshold, held only once accepted.
  let st = S.newStanding(101);
  S.earnFavor(st, me, 'jeremiah', CLAIM - 1);
  const below = S.canAccept(st, me, 'jeremiah');
  S.earnFavor(st, me, 'jeremiah', 1);
  const atT = S.canAccept(st, me, 'jeremiah');
  check(`not eligible at ${CLAIM - 1} devotion, eligible at ${CLAIM}`, !below.ok && below.need === 1 && atT.ok);
  check('eligible is not held: nobody follows a house until it is accepted', S.followedHouse(st, me) === null && S.holderOf(st, 'jeremiah') === null);
  const acc = S.acceptHouse(st, me, 'jeremiah');
  check('accepting holds it, and your lodge follows it', acc.ok && S.followedHouse(st, me) === 'jeremiah');
  check('accepting it again is refused', S.acceptHouse(st, me, 'jeremiah').reason === 'already followed');
  check('the Bond rose with the devotion, one for one', st.bond.jeremiah === CLAIM);
  scen.accept = at(st);

  // Switching releases the old house and keeps its devotion.
  S.earnFavor(st, me, 'ezekiel', CLAIM);
  const sw = S.acceptHouse(st, me, 'ezekiel');
  check('switching: the new house held, the old one released, its devotion kept',
    sw.ok && sw.released === 'jeremiah' && S.holderOf(st, 'jeremiah') === null && S.followedHouse(st, me) === 'ezekiel' && st.devotion[me].jeremiah === CLAIM);
  scen.switch = at(st);

  // Spending Bond standing never touches devotion (decision 1).
  const spent = S.spendBond(st, 'ezekiel', 60);
  const over = S.spendBond(st, 'ezekiel', 41);
  check('spending the Bond leaves devotion and the hold alone; overspending is refused and spends nothing',
    spent.ok && st.bond.ezekiel === 40 && st.devotion[me].ezekiel === CLAIM && S.followedHouse(st, me) === 'ezekiel' && !over.ok && st.bond.ezekiel === 40);

  // Taking a rival's house needs the margin.
  st = S.newStanding(102);
  st.holds.isaiah = 'lesse'; st.devotion.lesse.isaiah = 130;
  S.earnFavor(st, me, 'isaiah', 130 + MARGIN - 1);
  const short = S.canAccept(st, me, 'isaiah');
  S.earnFavor(st, me, 'isaiah', 1);
  const take = S.acceptHouse(st, me, 'isaiah');
  check(`a held house: refused at a lead of ${MARGIN - 1}, taken at ${MARGIN}`, short.reason === 'held' && short.need === 1 && take.ok && take.took === 'lesse' && S.holderOf(st, 'isaiah') === me);
  check('the rival that lost it holds nothing', S.followedHouse(st, 'lesse') === null);
  scen.take = at(st);

  // Grace, then the rivals court; a dithering player loses the house.
  st = S.newStanding(103);
  const ev = [];
  let day = 0;
  for (; day < GRACE; day++) ev.push(...S.rivalDay(st, day, me));
  check(`nothing ticks during the ${GRACE}-day grace period`, ev.length === 0 && RIVALS_OF(me).every(t => HOUSES.every(h => st.devotion[t][h] === 0)));
  const target = st.rivals[RIVALS_OF(me)[0]].prefs[0];
  S.earnFavor(st, me, target, CLAIM);          // eligible, never accepts
  const claims = [];
  for (; day < GRACE + 40; day++) claims.push(...S.rivalDay(st, day, me).map(e => ({ ...e, day })));
  const lost = claims.some(c => c.house === target);
  check('an eligible player who never accepts can lose the house to a rival', lost && S.holderOf(st, target) !== me && !S.canAccept(st, me, target).ok,
    JSON.stringify(claims));
  scen.dither = { target, claims };
  check('rivals never hold all four houses', HOUSES.filter(h => S.holderOf(st, h)).length <= 3);
  check('no two tribes hold the same house, and no tribe holds two', new Set(HOUSES.map(h => S.holderOf(st, h)).filter(Boolean)).size === HOUSES.filter(h => S.holderOf(st, h)).length);

  // A held house is never courted.
  st = S.newStanding(104);
  S.earnFavor(st, me, 'daniel', CLAIM); S.acceptHouse(st, me, 'daniel');
  for (let d = 0; d < 200; d++) S.rivalDay(st, d, me);
  check('a house you hold is never courted by a rival all season', RIVALS_OF(me).every(t => st.devotion[t].daniel === 0) && S.holderOf(st, 'daniel') === me);
  scen.heldSafe = { holds: { ...st.holds } };

  // No tribe yet: nobody ticks, so a save in the tutorial blocks nobody and loses nothing.
  st = S.newStanding(105);
  for (let d = 0; d < 100; d++) S.rivalDay(st, d, null);
  check('before the player has a tribe, the rivals do not tick', TR.TRIBE_IDS.every(t => HOUSES.every(h => st.devotion[t][h] === 0)));
  check('...and favor earned then still reaches the Bond', S.earnFavor(st, null, 'jeremiah', 5) && st.bond.jeremiah === 5);

  // Houses of minors.
  check('a minor prophet\'s region is its major\'s house', S.houseOf('habakkuk') === 'jeremiah' && S.houseOf('obadiah') === 'ezekiel'
    && S.houseOf('amos') === 'isaiah' && S.houseOf('haggai') === 'daniel' && S.houseOf('jeremiah') === 'jeremiah' && S.houseOf('baal') === null && S.houseOf(null) === null);
  golden.claiming = scen;

  // Rolled per season from the seed alone.
  const a = S.newStanding(777), b = S.newStanding(777), c = S.newStanding(778);
  check('the rivals\' house orders and paces come from the seed alone', same(a.rivals, b.rivals) && !same(a.rivals, c.rivals));
  check(`every pace is within ${D.RIVAL_PACE.min}-${D.RIVAL_PACE.max}, every order a shuffle of the four houses`,
    Object.values(a.rivals).every(r => r.pace >= D.RIVAL_PACE.min && r.pace <= D.RIVAL_PACE.max && same([...r.prefs].sort(), [...HOUSES].sort())));
}

// =============================================================================
console.log('=== seasons ===');
{
  const me = 'zafaar';
  const st = S.newStanding(2026);
  S.joinSeason(st, me);
  const trace = [];
  const points = Object.fromEntries(TR.TRIBE_IDS.map(t => [t, 0]));
  let legacySeen = { ...st.legacy };
  let legacyShrank = false;
  let followedAt = null;
  const days = SEASON_DAYS * 3;
  for (let day = 1; day <= days; day++) {
    // The player hunts Jeremiah's reeds a little every day; every tribe scores.
    S.earnFavor(st, me, 'jeremiah', 3);
    if (S.canAccept(st, me, 'jeremiah').ok) { S.acceptHouse(st, me, 'jeremiah'); followedAt ??= day; trace.push({ day, kind: 'accept', house: 'jeremiah' }); }
    TR.TRIBE_IDS.forEach((t, i) => { points[t] += (t === me ? 30 : 20 + i); });
    const r = S.dayBreak(st, day, me, { ...points });
    for (const e of r.events) trace.push({ day, ...e });
    if (r.season) {
      trace.push({ day, kind: 'season', ...r.season, points: undefined });
      for (const t of TR.TRIBE_IDS) points[t] = 0;
    }
    for (const h of HOUSES) if (st.legacy[h] < legacySeen[h]) legacyShrank = true;
    legacySeen = { ...st.legacy };
  }
  const seasons = trace.filter(t => t.kind === 'season');
  check(`${days} days make exactly 3 seasons, each ${SEASON_DAYS} days`, seasons.length === 3 && seasons.every((s, i) => s.endedDay === SEASON_DAYS * (i + 1)), seasons.map(s => s.endedDay).join(','));
  check('each season, your tribe won and held Jeremiah, and was paid legacy plus the win bonus',
    seasons.every(s => s.winner === me && s.held === 'jeremiah' && s.legacyGain === D.LEGACY_SEASON_GAIN + D.LEGACY_WIN_BONUS));
  check('legacy only ever grew', !legacyShrank && st.legacy.jeremiah === 3 * (D.LEGACY_SEASON_GAIN + D.LEGACY_WIN_BONUS));
  check(`the season after, your tribe started with a head start (legacy x${D.LEGACY_HEAD_START}, capped at ${D.HEAD_START_CAP})`,
    st.season.n === 4 && st.devotion[me].jeremiah === Math.min(D.HEAD_START_CAP, st.legacy.jeremiah * D.LEGACY_HEAD_START), `${st.devotion[me].jeremiah}`);
  check('a new season clears every hold and every rival\'s devotion', HOUSES.every(h => st.holds[h] === null) && RIVALS_OF(me).every(t => HOUSES.every(h => st.devotion[t][h] === 0)));
  const accepts = trace.filter(t => t.kind === 'accept').map(t => t.day);
  check('the head start made each later season\'s claim sooner', accepts.length === 3 && accepts[1] - SEASON_DAYS < accepts[0] && accepts[2] - 2 * SEASON_DAYS <= accepts[1] - SEASON_DAYS, accepts.join(','));
  golden.seasonTrace = trace;
  golden.seasonEnd = { legacy: { ...st.legacy }, devotion: st.devotion[me], season: st.season };

  // A tribe that wins nothing and holds nothing gets no legacy; ties go by TRIBE_IDS.
  const st2 = S.newStanding(9);
  const r = S.endSeason(st2, SEASON_DAYS, 'elseth', { elseth: 10, styx: 10, lesse: 3, zafaar: 0 });
  check('holding nothing pays no legacy; a tie goes to the earlier tribe in TRIBE_IDS', r.legacyGain === 0 && r.winner === 'elseth' && r.won);
  const r2 = S.endSeason(st2, 2 * SEASON_DAYS, 'elseth', {});
  check('a season nobody scored has no winner', r2.winner === null && !r2.won);

  // Pledging late still gives a head start, once.
  const st3 = S.newStanding(11);
  st3.legacy.daniel = 20;
  S.joinSeason(st3, 'lesse'); S.joinSeason(st3, 'lesse');
  check('a tribe pledged mid-season starts from its legacy, once', st3.devotion.lesse.daniel === 40);
}

// =============================================================================
console.log('=== the real game world ===');
{
  PM.reset();
  PM.setTribe('styx');
  PM.standing = S.newStanding(55, 0);          // a known rival roll
  S.joinSeason(PM.standing, 'styx');
  seed(1234);                                  // TribeHuntSimulator rolls Math.random
  const claims = [];
  let ended = null;
  for (let i = 0; i < SEASON_DAYS + 5; i++) {
    const before = { ...PM.tribeHuntPoints };
    const r = GAME_WORLD.dayBreaks();
    claims.push(...r.events.map(e => ({ day: PM.getDaysElapsed(), ...e })));
    if (r.season) ended = { day: PM.getDaysElapsed(), result: r.season, before };
  }
  check('GAME_WORLD.dayBreaks advances the save clock and the rivals', PM.getDaysElapsed() === SEASON_DAYS + 5 && claims.length > 0);
  check(`it ended the season on day ${SEASON_DAYS}, and read the winner off the race before resetting it`,
    ended?.day === SEASON_DAYS && ended.result.winner === Object.entries(ended.before).sort((a, b) => b[1] - a[1])[0][0]);
  check('the race restarted: only the days since the season end are on the tallies',
    Object.values(PM.tribeHuntPoints).reduce((a, b) => a + b, 0) < Object.values(ended?.before || {}).reduce((a, b) => a + b, 0) / 10);
  check('rivals\' claims all fell after the grace period', claims.every(c => c.day >= GRACE));
  golden.gameWorldClaims = claims;
}

// =============================================================================
console.log('=== the save: a real v7 save migrates to v8 ===');
{
  check('SAVE_VERSION is 8', SAVE_VERSION === 8);
  const raw = fs.readFileSync(new URL('../snapshots/save-v7-fixture.json', import.meta.url), 'utf8');
  const v7 = JSON.parse(raw);
  store.set('bmSave_v7a', raw);
  store.set('bmSave_v7b', raw);
  const ok = GameState.load('v7a');
  check('the v7 fixture loads', ok, GameState.lastLoadError || '');
  const rep7 = v7.progression.tribeRep;
  check('every tribe\'s rep is x10', TR.TRIBE_IDS.every(t => PM.getTribeRep(t) === rep7[t] * TR.REP_SCALE), JSON.stringify(PM.tribeRep));
  check('...and its rank on the new table is its rank on the old one',
    same(TR.TRIBE_IDS.map(t => TR.getTribeRepLevel(t, PM).name), ['Neutral', 'Member', 'Neutral', 'Neutral']), TR.TRIBE_IDS.map(t => TR.getTribeRepLevel(t, PM).name).join(','));
  const stA = JSON.parse(JSON.stringify(PM.standing));
  check('a standing record was made, season 1 starting on the save\'s own day', stA.v === S.STANDING_VERSION && stA.season.n === 1 && stA.season.startDay === v7.progression.daysElapsed);
  check('the pledged tribe joined the season', stA.joined === v7.progression.tribe);
  check('old Slain are Watched deaths with no house', GameState.slain.length === v7.slain.length && GameState.slain.every(c => c.fell?.rule === 'watched' && c.fell.house === null && c.fell.legacy));
  check('...so the lesser rite is open to them and intercession is not',
    GameState.slain.every(c => { const r = S.routesBack(PM.standing, PM.tribe, c.fell); return r.rite && !r.intercession; }));
  check('the map hunt in the save is still live', HuntManager.mode() === 'map' && !HuntManager.current().view().finished);
  GameState.load('v7b');
  check('migrating the same save twice gives the same standing record', same(PM.standing, stA));
  // Save at v8 and load again.
  S.earnFavor(PM.standing, PM.tribe, 'ezekiel', 120);
  S.acceptHouse(PM.standing, PM.tribe, 'ezekiel');
  const before = JSON.parse(JSON.stringify(PM.standing));
  GameState.save('v8');
  const saved = JSON.parse(store.get('bmSave_v8'));
  GameState.load('v8');
  check('standing survives a v8 save and load', saved.version === 8 && same(PM.standing, before) && S.followedHouse(PM.standing, PM.tribe) === 'ezekiel');
  check('...and a v8 load migrates nothing again (rep not multiplied twice)', TR.TRIBE_IDS.every(t => PM.getTribeRep(t) === rep7[t] * TR.REP_SCALE));
  golden.migration = { rep: { ...PM.tribeRep }, standingSeason: stA.season, fell: GameState.slain.map(c => c.fell) };

  const routes = S.routesBack(PM.standing, PM.tribe, S.fellRecord({ zoneId: 'bay_of_solace', prophet: 'ezekiel', rule: 'watched', day: 3 }));
  const abroad = S.routesBack(PM.standing, PM.tribe, S.fellRecord({ zoneId: 'reeds_of_gethsemane', prophet: 'jeremiah', rule: 'watched', day: 3 }));
  const forsaken = S.routesBack(PM.standing, PM.tribe, S.fellRecord({ zoneId: 'x', prophet: 'ezekiel', rule: 'forsaken', day: 3 }));
  check('a Watched death in your followed house\'s lands: both ways back; abroad: the rite only; Forsaken: neither (chunk 11)',
    routes.rite && routes.intercession && abroad.rite && !abroad.intercession && !forsaken.rite && !forsaken.intercession);
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
  check('standing tables identical to the golden', changed.length === 0,
    changed.length ? `changed: ${changed.join(', ')}` : `${keys.size} tables`);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
