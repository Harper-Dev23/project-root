// src/systems/HuntEngine.js
//
// A hunt on the hex map (Exploration System v2, chunk 7). Chunk 7 builds it in
// four steps, all built:
//   7a  moving and seeing: moves (supplies + time), the clock and day/night,
//       Sight, fog, Detection, the scout action
//   7b  food: hunger, forage and fish, eating, camp and cooking
//   7c  the world tick (HuntWorld.js), the encounter trigger with ambush and
//       party initiative, flee, the found-in-camp check, cleansing blight
//   7d  leaving: objective progress (HuntObjectives.js), exit from an
//       exit-capable tile with the completion reward, and the wipe
//
// It sits BESIDE the old Advance loop in HuntManager.js, which the game still
// runs until chunk 8 draws the map. Nothing in the game creates a map hunt yet,
// and the save does not hold one yet (chunk 8 wires it in); the harness proves
// serialize/restore now so that wiring is only plumbing.
//
// Same seams as createHunt (HuntManager.js):
//   - an instance per hunt, with its own seeded streams, saved as their state
//     so a reload does not re-roll anything. Two streams: the hunt's (weather,
//     the map seed, what a forage finds) and the world's (pack movement,
//     Restless), so a pack wandering never shifts what a forage finds;
//   - side effects go through the injected `world` (GAME_WORLD in the game):
//     nightFalls / dayBreaks for the save-wide clock (dayBreaks also advances
//     the rival tribes), party() for the hunters;
//   - the modifier bundle is built ONCE at departure and kept on the hunt.
//
// Party stats are NOT stored. partyStats(world.party(), mods) is called when a
// rule needs it, so a hunter who dies stops counting at once (partyStats leaves
// the dead out). What it is handed is the departure bundle plus this moment's
// hunger and food buff (HuntRules.momentMods).
//
// ── Time ────────────────────────────────────────────────────────────────────
// Everything that spends time (move, scout, forage, fish, camp, cleanse, flee)
// goes through _spendTime: the world catches up first (HuntWorld.worldTick),
// then the clock advances. The party stands on its destination while a move's
// time passes, so a Hunting pack can catch it there.
//
// ── Encounters (ENCOUNTERS) ─────────────────────────────────────────────────
// An encounter starts when the party walks onto a hostile occupant, or a
// Hunting pack reaches the party. It records what the party knew (the
// Detection band), whether it is an ambush (knew nothing, or a camp was
// found), both initiatives, and who acts first. While one is pending the hunt
// is frozen: every action is refused until it is won (winEncounter, the seam
// the combat hookup calls in chunk 9) or fled. A reload with one pending
// resolves it as a flee (SAVE_COMPATIBILITY rec. 4).
//
// ── Food (7b) ───────────────────────────────────────────────────────────────
// Food IS supplies (PARTY_STATS Part B): one pool, and hunger is read off it.
//   zeroSince   when supplies last reached 0 (null above 0): Hungry, then
//               Starving after STARVING_AFTER. A Starving move costs HP, never
//               below 1 (HuntRules.starvedHP).
//   satedUntil  a Hearty or Fine meal keeps the party Sated until then.
//   foodBuff    one at a time: { field, amount, until, source }.
//   gathered    tile id -> 'forage' | 'fish': each tile gives food once.
// Gathered food goes into the pack's found list, so it is at risk like any
// find and counts for Provisioner at the exit. Eating is an explicit action;
// fish must be cooked, which only happens at camp.
//
// ── What the party knows ────────────────────────────────────────────────────
//   fog         tile id -> 'visible' | 'remembered'; a tile missing is unseen.
//               A tile never goes back to unseen (harness invariant).
//   seenGround  the ground a tile had when last seen: a remembered tile shows
//               it as it was, even if blight has taken it since.
//   sightings   occupant id -> what was last detected, where, and when. Tiles
//               in sight show what Detection reads NOW; a remembered tile keeps
//               its last reading, stale once packs move.
//   scouted     occupants the scout action has resolved: identified, exact.
//
// ── Leaving (7d) ────────────────────────────────────────────────────────────
// A hunt ends two ways only (HUNT_STRUCTURE): exit() from an exit-capable tile
// (the entry, a Waystone), or wipe() when the party falls (the combat hookup
// calls it, chunk 9). The pack settles through the same settlePack the old
// hunt uses. A clean exit pays the completion reward if the primary objective
// is done, and each done bonus objective on top; leaving early keeps
// everything earned and forfeits only the completion reward. A wipe pays none
// of it. After either, every action is refused.
//   retrieved   the Retrieve item has been taken (by standing on its site)
//   communed    the shrine has been reached (Commune, until Events v2)
//   unmasked    occupants identified while their concealment was above 100

import { rollWeather } from '../../data/weather.js';
import { getZone } from '../../data/zones.js';
import { isPassable, GROUNDS } from '../../data/grounds.js';
import { Items } from '../../data/items.js';
import { addToList, makeStack, takeFromList, countInList } from './ItemStacks.js';
import { makeRng, rngFromState, randomSeed, isSeed } from './seededRng.js';
import { generateHuntMap, mapNeighbors, occupantConcealment, HUNT_MAP_VERSION } from './HuntMapGen.js';
import { partyStats } from './PartyStats.js';
import { GAME_WORLD, packAtDeparture, zoneDeathRule, DEATH_RULES, settlePack } from './HuntManager.js';
import { objectiveProgress, exitReward, completionRewardPercent } from './HuntObjectives.js';
import { isItemInstance } from './ItemFactory.js';
import {
  huntMods, moveCost, clockAt, sightRange, visibleTiles, occupantBand,
  occupantView, SCOUT_TIME, BANDS,
  hungerStage, momentMods, starvedHP, forageCandidates, gatherQty, FORAGE_TIME, FISH_TIME,
  FORAGE_YIELD, FISH_YIELD, FISH_ITEM, CAMP_TIME, CAMP_SUPPLY, SATED_TIME, campRecoveryPercent,
  recovered, cookDish,
} from './HuntRules.js';
import { initWorld, worldTick, alert, makeEncounter, trailView, CLEANSE_TIME } from './HuntWorld.js';

/** Shape version of a serialized map hunt. Not yet in any save (chunk 8). */
export const MAP_HUNT_STATE_VERSION = 1;

const LOG_LIMIT = 50;
const HOSTILE = new Set(['beast', 'cultist']);
/** Mixed into the hunt seed for the world's own stream. */
const WORLD_STREAM_SALT = 0x9E3779B9;

/** The ground a cleansed tile returns to when the generator painted it as
 *  blight: the region's main land ground, the same rule the generator uses to
 *  make land (HuntMapGen, `landGround`). */
function mainLandGround(zone) {
  return Object.entries(zone.palette || {})
    .filter(([g]) => g !== 'blight' && GROUNDS[g]?.passable)
    .sort((a, b) => b[1] - a[1])[0]?.[0] || 'grass';
}

/**
 * Start a hunt on a freshly generated map.
 *
 * @param {string} zoneId
 * @param {object} opts
 * @param {{objective: string, size: string, bonusObjectives?: string[], mods?: object, itemLevel?: number}} opts.plan
 *        planMapInputs(huntPlanView(inst)) gives all but itemLevel, which is
 *        the view's own (it sets the tier implicit and the bonus rewards)
 * @param {number} opts.supplies  starting supplies, already including packed Rations
 * @param {object[]} [opts.bring] item instances packed at departure
 * @param {number} [opts.seed]
 * @param {object} world  see GAME_WORLD (HuntManager.js)
 */
export function createMapHunt(zoneId, { plan, supplies = 100, bring = [], seed = randomSeed() } = {}, world = GAME_WORLD) {
  const zone = getZone(zoneId);
  if (!zone) throw new Error(`unknown zone '${zoneId}'`);
  if (!plan?.objective || !plan?.size) throw new Error('a map hunt needs a plan with an objective and a size');
  const planMods = plan.mods || {};
  const rng = makeRng(seed);
  const worldRng = makeRng((seed ^ WORLD_STREAM_SALT) >>> 0);
  // First draw: the weather, as createHunt rolls it. Second: the map's seed.
  const weather = rollWeather(rng, planMods.foulWeatherPercent || 0);
  const mapSeed = Math.floor(rng() * 0x100000000) >>> 0;
  const map = generateHuntMap({
    zoneId, objective: plan.objective, size: plan.size, seed: mapSeed,
    bonusObjectives: plan.bonusObjectives || [], mods: planMods,
  });
  const { pack, extraSupplies } = packAtDeparture(bring, planMods);
  const start = supplies + extraSupplies;
  const s = {
    v: MAP_HUNT_STATE_VERSION,
    seed,
    zoneId,
    plan: {
      objective: plan.objective, size: plan.size, bonusObjectives: [...(plan.bonusObjectives || [])],
      itemLevel: Number.isFinite(plan.itemLevel) ? plan.itemLevel : 1,
      completionRewardPercent: completionRewardPercent(planMods, Number.isFinite(plan.itemLevel) ? plan.itemLevel : 1),
    },
    weather,
    mods: huntMods(zone.modifiers, weather.modifiers, planMods),
    deathRule: zoneDeathRule(zone),
    landGround: mainLandGround(zone),
    map,
    pos: map.entry,
    from: null,
    time: 0,
    supplies: start,
    maxSupplies: start,
    fog: {},
    seenGround: {},
    sightings: {},
    scouted: [],
    zeroSince: start > 0 ? null : 0,
    satedUntil: 0,
    foodBuff: null,
    gathered: {},
    // Restless (a plan prefix) is read here, once: WORLD_SIM's pack states.
    world: initWorld(map, { restlessPercent: planMods.restlessPercent || 0, rng: worldRng }),
    trails: {},
    encounter: null,
    kills: [],
    flees: 0,
    cleansed: [],
    retrieved: false,
    communed: false,
    unmasked: [],
    finished: null,
    reward: null,
    pack,
    log: [],
  };
  const hunt = makeMapHunt(s, rng, worldRng, world);
  hunt._reveal();
  return hunt;
}

/**
 * Rebuild a map hunt from serialize() output. Throws on anything it does not
 * recognise rather than half-restoring it. A fight in progress is not saved,
 * so a restored hunt with an encounter pending resolves it as a flee.
 */
export function restoreMapHunt(data, world = GAME_WORLD) {
  if (!data || typeof data !== 'object') throw new Error('no map hunt data');
  if (data.v !== MAP_HUNT_STATE_VERSION) throw new Error(`unknown map hunt version ${data.v} (this build reads ${MAP_HUNT_STATE_VERSION})`);
  if (!getZone(data.zoneId)) throw new Error(`unknown hunt zone '${data.zoneId}'`);
  if (data.map?.v !== HUNT_MAP_VERSION || !data.map.tiles) throw new Error('map hunt has no map it can read');
  if (!data.map.tiles[data.pos]) throw new Error(`map hunt position '${data.pos}' is not on its map`);
  if (!DEATH_RULES.includes(data.deathRule)) throw new Error(`map hunt has no valid death rule ('${data.deathRule}')`);
  for (const k of ['time', 'supplies', 'maxSupplies', 'flees']) {
    if (!Number.isFinite(data[k])) throw new Error(`map hunt field '${k}' is not a number`);
  }
  for (const [id, f] of Object.entries(data.fog || {})) {
    if (!data.map.tiles[id] || (f !== 'visible' && f !== 'remembered')) throw new Error(`bad fog entry '${id}'`);
  }
  if (!data.sightings || Object.values(data.sightings).some(x => !BANDS.includes(x.band))) throw new Error('bad sightings');
  for (const k of ['scouted', 'log', 'kills', 'cleansed', 'unmasked']) {
    if (!Array.isArray(data[k])) throw new Error(`map hunt list '${k}' is missing`);
  }
  for (const k of ['gathered', 'trails', 'seenGround']) {
    if (!data[k] || typeof data[k] !== 'object') throw new Error(`map hunt has no '${k}'`);
  }
  if (!(data.zeroSince === null || Number.isFinite(data.zeroSince)) || !Number.isFinite(data.satedUntil)) throw new Error('map hunt hunger is not readable');
  if (data.foodBuff !== null && !(typeof data.foodBuff?.field === 'string' && Number.isFinite(data.foodBuff.amount) && Number.isFinite(data.foodBuff.until))) {
    throw new Error('map hunt food buff is not readable');
  }
  if (!Number.isFinite(data.world?.time) || !Number.isFinite(data.world?.day)) throw new Error('map hunt world clock is not readable');
  if (!GROUNDS[data.landGround]) throw new Error('map hunt has no land ground');
  if (data.finished !== null && data.finished !== 'exit' && data.finished !== 'wipe') throw new Error(`map hunt ending '${data.finished}' is not one this build knows`);
  if (!Number.isFinite(data.plan?.itemLevel) || !Number.isFinite(data.plan?.completionRewardPercent)) throw new Error('map hunt plan has no item level or reward');
  if (!Array.isArray(data.pack?.brought) || !Array.isArray(data.pack?.found)
      || ![...data.pack.brought, ...data.pack.found].every(isItemInstance)) {
    throw new Error('map hunt pack is not two lists of items');
  }
  if (!data.mods || !data.weather) throw new Error('map hunt is missing its weather or modifiers');
  if (!isSeed(data.rngState) || !isSeed(data.worldRngState)) throw new Error('map hunt has no random-stream state');
  const { rngState, worldRngState, ...rest } = data;
  const hunt = makeMapHunt(clone(rest), rngFromState(rngState), rngFromState(worldRngState), world);
  if (rest.encounter && !rest.finished) hunt.flee({ reason: 'reload' });
  return hunt;
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function makeMapHunt(s, rng, worldRng, world) {
  const occById = () => new Map(s.map.occupants.map(o => [o.id, o]));
  const frozen = () => (s.finished ? { ok: false, reason: 'the hunt is over' }
    : s.encounter ? { ok: false, reason: 'a fight is under way: win it or flee' } : null);

  return {
    /** The party's stats right now: live party, the hunt's bundle, this
     *  moment's hunger and food buff. */
    stats() {
      return partyStats(world.party(), momentMods(s.mods, { stage: this.hunger(), foodBuff: s.foodBuff, time: s.time }));
    },

    /** Sated / fed / hungry / starving (HuntRules.hungerStage). */
    hunger() {
      return hungerStage({ supplies: s.supplies, zeroSince: s.zeroSince, satedUntil: s.satedUntil, time: s.time });
    },

    /** Day, night and the day number at the hunt's current time. */
    clock() {
      return { time: s.time, ...clockAt(s.time) };
    },

    /** The pending encounter, or null. */
    encounter() {
      return s.encounter ? { ...s.encounter } : null;
    },

    /**
     * Move to a neighbouring tile. Spends supplies (never below 0: running
     * out never ejects the party, HUNT_STRUCTURE) and time, then looks around.
     * Refuses a tile that is not next to the party or cannot be entered.
     * Walking onto a hostile occupant starts an encounter at once; `knew` is
     * what the party had detected of it before stepping in.
     */
    move(to) {
      const no = frozen(); if (no) return no;
      if (!mapNeighbors(s.map, s.pos).includes(to)) return { ok: false, reason: `'${to}' is not next to the party` };
      const tile = s.map.tiles[to];
      if (!isPassable(tile)) return { ok: false, reason: `'${to}' cannot be entered` };
      const st = this.stats();
      const cost = moveCost(tile, st);
      const occ = s.map.occupants.find(o => o.tile === to && HOSTILE.has(o.kind)) || null;
      const knew = occ ? this._bandOf(occ) : null;
      s.supplies = Math.max(0, s.supplies - cost.supply);
      s.from = s.pos;
      s.pos = to;
      if (occ) {
        s.encounter = makeEncounter(occ, {
          cause: 'party', knew, ambush: knew === 'nothing', partyInitiative: st.partyInitiative, at: s.time, tile: to,
        });
      }
      this._arrive();
      const spent = this._spendTime(cost.time);
      this._noteSupplies();
      const starved = this.hunger() === 'starving' ? this._starve() : [];
      this._reveal();
      const contact = occ ? { id: occ.id, kind: occ.kind, knew } : null;
      return { ok: true, to, supply: cost.supply, time: cost.time, flips: spent.flips, contact, encounter: this.encounter(), starved };
    },

    /**
     * The scout action (ENCOUNTERS): costs SCOUT_TIME of in-game time and no
     * supplies, the party stays put, and it targets one occupant in sight that
     * is at least sensed. It resolves it: identified, with the exact roster.
     * Its gear and part rarity are rolled with the fight, so showing them is
     * the combat hookup's (chunk 9); `scouted` is what it will read.
     */
    scout(occId) {
      const no = frozen(); if (no) return no;
      const occ = occById().get(occId);
      if (!occ) return { ok: false, reason: `no occupant '${occId}'` };
      if (s.scouted.includes(occId)) return { ok: false, reason: 'already scouted' };
      if (s.fog[occ.tile] !== 'visible') return { ok: false, reason: 'not in sight' };
      const seen = s.sightings[occId];
      if (!seen || seen.band === 'nothing' || seen.tile !== occ.tile) return { ok: false, reason: 'nothing detected there' };
      s.scouted.push(occId);
      const spent = this._spendTime(SCOUT_TIME);
      this._reveal();
      this._log({ kind: 'scout', occupant: occId, time: s.time });
      return { ok: true, time: SCOUT_TIME, flips: spent.flips, view: this.occupantViewOf(occId), encounter: this.encounter() };
    },

    /**
     * Forage the party's tile (PARTY_STATS Part B): FORAGE_TIME of in-game
     * time, once per tile per hunt. What grows depends on the ground, how much
     * on its forage band and the party's forageYieldPercent (Foraging's curve
     * plus of the Harvest). Blight, barren tiles (Lean Country) and a tile
     * already gathered give nothing, and are refused before any time is spent.
     */
    forage() {
      const no = frozen(); if (no) return no;
      const tile = s.map.tiles[s.pos];
      if (s.gathered[s.pos]) return { ok: false, reason: 'this tile has already been gathered' };
      if (tile.barren) return { ok: false, reason: 'nothing grows here' };
      const band = GROUNDS[tile.ground]?.forage;
      const worth = FORAGE_YIELD[band] || 0;
      const kinds = forageCandidates(Items, tile.ground);
      if (!worth || !kinds.length) return { ok: false, reason: 'nothing grows here' };
      const st = this.stats();
      const id = kinds[Math.floor(rng() * kinds.length)];
      const qty = gatherQty(worth, st.forageYieldPercent, Items[id].supply);
      addToList(s.pack.found, makeStack(id, qty));
      s.gathered[s.pos] = 'forage';
      const spent = this._spendTime(FORAGE_TIME);
      this._reveal();
      this._log({ kind: 'forage', tile: s.pos, item: id, qty, time: s.time });
      return { ok: true, item: id, qty, time: FORAGE_TIME, flips: spent.flips, encounter: this.encounter() };
    },

    /** Fish from a tile beside water: FISH_TIME, once per tile (forage OR
     *  fish), raw fish scaled by fishYieldPercent. Fish must be cooked. */
    fish() {
      const no = frozen(); if (no) return no;
      const tile = s.map.tiles[s.pos];
      if (s.gathered[s.pos]) return { ok: false, reason: 'this tile has already been gathered' };
      if (!tile.fishing) return { ok: false, reason: 'there is no water to fish here' };
      if (tile.barren) return { ok: false, reason: 'the water here is empty' };
      const st = this.stats();
      const qty = gatherQty(FISH_YIELD, st.fishYieldPercent, Items[FISH_ITEM].supply);
      addToList(s.pack.found, makeStack(FISH_ITEM, qty));
      s.gathered[s.pos] = 'fish';
      const spent = this._spendTime(FISH_TIME);
      this._reveal();
      this._log({ kind: 'fish', tile: s.pos, item: FISH_ITEM, qty, time: s.time });
      return { ok: true, item: FISH_ITEM, qty, time: FISH_TIME, flips: spent.flips, encounter: this.encounter() };
    },

    /** Food in the pack a party could eat or cook with, by id (Rations are
     *  the supply pool already, not food to eat). */
    foodInPack() {
      const out = {};
      for (const it of [...s.pack.found, ...s.pack.brought]) {
        if (Items[it.id]?.type !== 'food') continue;
        out[it.id] = (out[it.id] || 0) + (it.qty || 1);
      }
      return out;
    },

    /** Eat raw food from the pack: its supply value goes into the pool. No
     *  time. Only rawEdible food; fish and meat must be cooked at camp. */
    eat(itemId, qty = 1) {
      const no = frozen(); if (no) return no;
      const food = Items[itemId];
      if (food?.type !== 'food') return { ok: false, reason: `'${itemId}' is not food` };
      if (!food.food?.rawEdible) return { ok: false, reason: `${food.name} must be cooked first` };
      if (!Number.isInteger(qty) || qty < 1) return { ok: false, reason: 'eat at least one' };
      if (!this._takeFood(itemId, qty)) return { ok: false, reason: `not enough ${food.name} in the pack` };
      const supply = qty * food.supply;
      s.supplies += supply;
      s.maxSupplies = Math.max(s.maxSupplies, s.supplies);
      this._noteSupplies();
      this._log({ kind: 'eat', item: itemId, qty, supply, time: s.time });
      return { ok: true, supply };
    },

    /**
     * Camp on the party's tile (PARTY_STATS Part B, decision 7). Cooks each
     * meal { main, addition? } first: main is fish (or, from chunk 9, meat),
     * the addition a forage food. CAMP_SUPPLY is eaten after the meals (never
     * below 0). Then CAMP_TIME passes while the world ticks: a Hunting pack
     * that reaches the camp must find it first (Detection reversed: its
     * perception against the tile's concealment plus Low Profile). A camp
     * that is found is broken off at that moment as an ambush, and recovers
     * only the share of the camp that was slept. Recovery: a share of max HP
     * and MP for every hunter not dead, more if the camp began at night, more
     * again with Field Rites. A Hearty or Fine meal leaves the party Sated for
     * SATED_TIME after the camp; the last Fine meal's buff replaces any other.
     * Refuses the whole camp, before anything happens, if a meal is not cookable.
     */
    camp({ meals = [] } = {}) {
      const no = frozen(); if (no) return no;
      const need = {};
      for (const m of meals) {
        const main = Items[m?.main], add = m?.addition ? Items[m.addition] : null;
        if (!['fish', 'meat'].includes(main?.food?.kind)) return { ok: false, reason: `'${m?.main}' is not a main (fish or meat)` };
        if (m.addition && add?.food?.kind !== 'forage') return { ok: false, reason: `'${m.addition}' is not a forage addition` };
        need[m.main] = (need[m.main] || 0) + 1;
        if (m.addition) need[m.addition] = (need[m.addition] || 0) + 1;
      }
      const have = this.foodInPack();
      for (const [id, n] of Object.entries(need)) {
        if ((have[id] || 0) < n) return { ok: false, reason: `not enough ${Items[id].name} in the pack` };
      }
      const st = this.stats();
      const night = clockAt(s.time).isNight;
      const dishes = [];
      let gained = 0;
      for (const m of meals) {
        this._takeFood(m.main, 1);
        if (m.addition) this._takeFood(m.addition, 1);
        const dish = cookDish(Items[m.main], m.addition ? Items[m.addition] : null, st.cooking);
        dishes.push({ main: m.main, addition: m.addition || null, ...dish });
        gained += dish.supply;
      }
      s.supplies = Math.max(0, s.supplies + gained - CAMP_SUPPLY);
      s.maxSupplies = Math.max(s.maxSupplies, s.supplies);
      this._noteSupplies();
      const spent = this._spendTime(CAMP_TIME, { camping: true });
      this._noteSupplies();
      const pct = campRecoveryPercent(night, st.passives.campRecoveryPercent) * spent.spent / CAMP_TIME;
      const healed = [];
      for (const c of world.party()) {
        if (!c || c.status === 'dead') continue;
        const hp = c.currentHP, mp = c.currentMP;
        c.currentHP = recovered(c.currentHP, c.maxHP, pct);
        c.currentMP = recovered(c.currentMP, c.maxMP, pct);
        healed.push({ name: c.name, hp: c.currentHP - hp, mp: c.currentMP - mp });
      }
      if (dishes.some(d => d.sated)) s.satedUntil = s.time + SATED_TIME;
      const fine = [...dishes].reverse().find(d => d.buff);
      if (fine) s.foodBuff = { ...fine.buff, until: s.time + fine.buff.duration, source: fine.addition };
      this._reveal();
      this._log({ kind: 'camp', tile: s.pos, night, pct, dishes: dishes.map(d => d.quality), found: !!spent.encounter, time: s.time });
      return {
        ok: true, night, recoveryPercent: pct, dishes, supplyGained: gained, healed, flips: spent.flips,
        time: spent.spent, found: !!spent.encounter, encounter: this.encounter(),
      };
    },

    /**
     * Cleanse the blight under the party (WORLD_SIM; decision 9): an action on
     * the tile, CLEANSE_TIME of time. The tile goes back to the ground it was.
     * Cleansing a blight source's own tile destroys the source, and its spread
     * stops. A cleansed tile within reach of a living source re-blights at the
     * next day boundary: tile by tile against a living source is a losing game.
     */
    cleanse() {
      const no = frozen(); if (no) return no;
      const tile = s.map.tiles[s.pos];
      if (tile.ground !== 'blight') return { ok: false, reason: 'there is no blight here' };
      tile.ground = tile.blightedFrom || s.landGround;
      delete tile.blightedFrom;
      s.cleansed.push(s.pos);
      const src = s.map.features.find(f => f.kind === 'blight_source' && f.tile === s.pos && !f.destroyed) || null;
      if (src) src.destroyed = true;
      const spent = this._spendTime(CLEANSE_TIME);
      this._reveal();
      this._log({ kind: 'cleanse', tile: s.pos, source: !!src, time: s.time });
      return { ok: true, ground: tile.ground, sourceDestroyed: !!src, time: CLEANSE_TIME, flips: spent.flips, encounter: this.encounter() };
    },

    /**
     * The fight was won. This is the seam the combat hookup calls (chunk 9),
     * which is also where loot, parts, Hunt Points and XP will be paid: here
     * the occupant leaves the map and the kill is recorded, nothing more. No
     * occupant ever replaces it (no mid-hunt spawns).
     */
    winEncounter() {
      if (s.finished) return { ok: false, reason: 'the hunt is over' };
      const e = s.encounter;
      if (!e) return { ok: false, reason: 'no fight to win' };
      const i = s.map.occupants.findIndex(o => o.id === e.occId);
      const [occ] = s.map.occupants.splice(i, 1);
      const kill = {
        occId: occ.id, kind: occ.kind, family: occ.family || null, mark: occ.mark || null,
        roster: occ.roster.map(m => ({ ...m })), tile: occ.tile, at: s.time,
      };
      s.kills.push(kill);
      delete s.sightings[occ.id];
      s.encounter = null;
      this._reveal();
      this._log({ kind: 'win', occupant: occ.id, time: s.time });
      return { ok: true, kill };
    },

    /**
     * Flee (ENCOUNTERS, decision 10): always possible, never free, no roll.
     *   - the enemy gets a full round as you disengage: `enemyFreeRound`, which
     *     the combat hookup applies before calling this (chunk 9);
     *   - the party retreats to the tile it came from (or, if the pack came to
     *     it, to the first open neighbour), paying that move's time;
     *   - nothing from the fight is kept: the occupant stays on the map;
     *   - the pack is alerted: it hunts the party, from the end of the retreat.
     * No smoke charge yet: nothing could read one before chunk 9.
     */
    flee({ reason = 'fled' } = {}) {
      if (s.finished) return { ok: false, reason: 'the hunt is over' };
      const e = s.encounter;
      if (!e) return { ok: false, reason: 'nothing to flee from' };
      const occ = occById().get(e.occId);
      const back = this._retreatTile(e);
      s.encounter = null;
      s.flees += 1;
      const time = back ? moveCost(s.map.tiles[back], this.stats()).time : SCOUT_TIME;
      if (back) { s.from = s.pos; s.pos = back; }
      if (occ && occ.kind === 'beast') alert(occ, s.time + time);
      const spent = this._spendTime(time);
      const starved = this.hunger() === 'starving' ? this._starve() : [];
      this._reveal();
      this._log({ kind: 'flee', occupant: e.occId, reason, to: back, time: s.time });
      return {
        ok: true, to: back, time, flips: spent.flips, enemyFreeRound: true,
        alerted: occ?.kind === 'beast' ? occ.id : null, starved, encounter: this.encounter(),
      };
    },

    /** Every objective with its progress now (HuntObjectives.objectiveProgress). */
    objectives() {
      return objectiveProgress(s);
    },

    /**
     * Leave the map from an exit-capable tile (the entry or a Waystone). The
     * clean exit: the pack comes home (settlePack), and the reward is paid
     * through the world's awardHuntPoints (HuntObjectives.exitReward). Refused
     * off an exit tile, during a fight, or once the hunt is over.
     */
    exit() {
      const no = frozen(); if (no) return no;
      if (!s.map.tiles[s.pos].exit) return { ok: false, reason: 'you can only leave from the entry or a Waystone' };
      const reward = exitReward(s);
      const pack = this._finish('exit');
      if (reward.huntPoints > 0) world.awardHuntPoints(reward.huntPoints);
      s.reward = { completion: reward.completion, bonuses: reward.bonuses, huntPoints: reward.huntPoints, primaryDone: reward.primaryDone };
      this._log({ kind: 'exit', tile: s.pos, huntPoints: reward.huntPoints, primaryDone: reward.primaryDone, time: s.time });
      return { ok: true, reward, pack };
    },

    /**
     * The party wiped (the combat hookup calls this, chunk 9). The hunt ends
     * where it stands, a fight in progress included; the pack comes home or
     * is lost by the region's death rule; nothing is paid.
     */
    wipe() {
      if (s.finished) return { ok: false, reason: 'the hunt is over' };
      s.encounter = null;
      const pack = this._finish('wipe');
      this._log({ kind: 'wipe', tile: s.pos, deathRule: s.deathRule, time: s.time });
      return { ok: true, pack };
    },

    /** What the party knows of one occupant, or null (ENCOUNTERS). `stale` is
     *  set when its tile is not in sight now. */
    occupantViewOf(occId) {
      const seen = s.sightings[occId];
      const occ = occById().get(occId);
      if (!seen || !occ) return null;
      const exact = s.scouted.includes(occId) || this.stats().passives.exactRoster > 0;
      const v = occupantView(occ, seen.band, { exact: seen.band === 'identified' && exact });
      if (!v) return null;
      return { ...v, tile: seen.tile, at: seen.at, stale: s.fog[seen.tile] !== 'visible' };
    },

    /** Everything the party knows about the map. Plain data for the map scene. */
    view() {
      const st = this.stats();
      const occupants = Object.keys(s.sightings).map(id => this.occupantViewOf(id)).filter(Boolean);
      const trails = [];
      for (const [id, t] of Object.entries(s.trails)) {
        if (s.fog[id] !== 'visible') continue;
        const v = trailView(t, s.map.tiles[id].ground, st.perception, s.time);
        if (v) trails.push({ tile: id, ...v });
      }
      const ground = {};
      for (const [id, f] of Object.entries(s.fog)) ground[id] = f === 'visible' ? s.map.tiles[id].ground : s.seenGround[id];
      return {
        pos: s.pos,
        clock: this.clock(),
        supplies: s.supplies,
        maxSupplies: s.maxSupplies,
        hunger: this.hunger(),
        satedUntil: s.satedUntil,
        foodBuff: s.foodBuff && s.time < s.foodBuff.until ? { ...s.foodBuff } : null,
        fog: { ...s.fog },
        ground,
        occupants,
        trails,
        encounter: this.encounter(),
        objectives: objectiveProgress(s),
        finished: s.finished,
      };
    },

    getState() {
      return clone(s);
    },

    /** Plain JSON for the save. restoreMapHunt(serialize()) continues identically. */
    serialize() {
      return { ...clone(s), rngState: rng.getState(), worldRngState: worldRng.getState() };
    },

    /**
     * Spend in-game time: the world catches up first, then the clock. When
     * camping, a found camp ends the time early (the rest is not slept).
     * Returns { spent, flips, encounter }.
     */
    _spendTime(units, { camping = false } = {}) {
      const start = s.time;
      const campConcealment = camping
        ? (GROUNDS[s.map.tiles[s.pos].ground]?.concealment || 0) + (this.stats().passives.campConcealmentBonus || 0)
        : 0;
      const tick = worldTick(s, start + units, {
        rng: worldRng,
        stats: () => this.stats(),
        campFrom: camping ? start : null,
        campConcealment,
        bandOf: (occ) => this._bandOf(occ),
        onEvent: () => this._reveal(),
      });
      const spent = camping && tick.encounter ? Math.max(0, Math.min(units, tick.stoppedAt - start)) : units;
      const flips = this._advanceTime(spent);
      if (tick.encounter && !s.log.some(l => l.kind === 'encounter' && l.at === tick.encounter.at && l.occId === tick.encounter.occId)) {
        this._log({ kind: 'encounter', ...tick.encounter, time: s.time });
      }
      return { spent, flips, encounter: tick.encounter };
    },

    /** Settle the pack for an ending, bank what comes home, mark the hunt over. */
    _finish(ending) {
      const out = settlePack({ pack: s.pack, supplies: s.supplies, deathRule: s.deathRule, ending });
      s.finished = ending;
      if (out.home.brought.length) world.bankItems(out.home.brought, { found: false });
      if (out.home.found.length) world.bankItems(out.home.found, { found: true });
      return out;
    },

    /** Standing on the Retrieve site takes the item; on the shrine, communes. */
    _arrive() {
      const p = s.map.objectives.primary;
      if (p.id === 'retrieve' && s.pos === p.site && !s.retrieved) { s.retrieved = true; this._log({ kind: 'retrieved', tile: s.pos, time: s.time }); }
      if (p.id === 'commune' && s.pos === p.site && !s.communed) { s.communed = true; this._log({ kind: 'communed', tile: s.pos, time: s.time }); }
    },

    /** Where a fleeing party goes: back where it came from if that is open,
     *  otherwise the first open neighbour in tile order. Only a hostile
     *  occupant closes a tile; the party can stand on an event site. */
    _retreatTile(e) {
      const open = (id) => id && id !== s.pos && isPassable(s.map.tiles[id])
        && !s.map.occupants.some(o => o.tile === id && o.id !== e.occId && HOSTILE.has(o.kind))
        && mapNeighbors(s.map, s.pos).includes(id);
      if (open(s.from)) return s.from;
      return [...mapNeighbors(s.map, s.pos)].sort().find(open) || null;
    },

    /** What the party has detected of an occupant where it stands now. */
    _bandOf(occ) {
      const sg = s.sightings[occ.id];
      return sg && sg.tile === occ.tile && s.fog[occ.tile] === 'visible' ? sg.band : 'nothing';
    },

    /** Keep zeroSince honest after any change to supplies. */
    _noteSupplies() {
      if (s.supplies <= 1e-9) {
        s.supplies = 0;
        if (s.zeroSince === null) s.zeroSince = s.time;
      } else {
        s.zeroSince = null;
      }
    },

    /** A Starving move: every hunter not dead loses HP, never below 1. */
    _starve() {
      const out = [];
      for (const c of world.party()) {
        if (!c || c.status === 'dead') continue;
        const before = c.currentHP;
        c.currentHP = starvedHP(c);
        if (c.currentHP !== before) out.push({ name: c.name, lost: before - c.currentHP });
      }
      return out;
    },

    /** Take n of a food out of the pack, found first, then brought. */
    _takeFood(id, n) {
      const inFound = countInList(s.pack.found, id);
      if (inFound + countInList(s.pack.brought, id) < n) return false;
      const a = Math.min(n, inFound);
      if (a > 0) takeFromList(s.pack.found, id, a);
      if (n - a > 0) takeFromList(s.pack.brought, id, n - a);
      return true;
    },

    /**
     * Advance the hunt's clock. Each phase boundary crossed is one flip, in
     * order: night falls, then the next day breaks. Returns the flips.
     */
    _advanceTime(units) {
      const before = clockAt(s.time);
      s.time += units;
      const after = clockAt(s.time);
      const flips = [];
      for (let p = before.phase + 1; p <= after.phase; p++) {
        if (p % 2 === 1) { world.nightFalls(); flips.push('night'); }
        else { world.dayBreaks(); flips.push('day'); }
        this._log({ kind: p % 2 === 1 ? 'night' : 'day', day: Math.floor(p / 2) + 1, time: s.time });
      }
      return flips;
    },

    /**
     * Look around from the party's tile: Sight decides which tiles are
     * visible (the rest seen before become remembered), then Detection reads
     * every occupant on a visible tile. A sighting whose tile is in sight but
     * whose occupant has left (or died) is dropped: you can see it is gone.
     */
    _reveal(st = this.stats()) {
      const now = Math.max(s.time, s.world?.time || 0);
      const range = sightRange(s.map, s.pos, st.passives.sightRangeBonus);
      const vis = new Set(visibleTiles(s.map, s.pos, { range }));
      for (const id of Object.keys(s.fog)) if (!vis.has(id)) s.fog[id] = 'remembered';
      for (const id of vis) { s.fog[id] = 'visible'; s.seenGround[id] = s.map.tiles[id].ground; }
      const byId = occById();
      for (const [id, sg] of Object.entries(s.sightings)) {
        const occ = byId.get(id);
        if (!occ || (vis.has(sg.tile) && occ.tile !== sg.tile)) delete s.sightings[id];
      }
      for (const occ of s.map.occupants) {
        if (!vis.has(occ.tile)) continue;
        const band = s.scouted.includes(occ.id) ? 'identified' : occupantBand(s.map, occ, st.perception);
        if (band === 'nothing') delete s.sightings[occ.id];
        else s.sightings[occ.id] = { tile: occ.tile, band, at: now };
        // Unmask: identified while hidden past 100 (occupant + ground).
        if (band === 'identified' && !s.unmasked.includes(occ.id) && occupantConcealment(s.map, occ) > 100) s.unmasked.push(occ.id);
      }
      return range;
    },

    _log(entry) {
      s.log.push(entry);
      if (s.log.length > LOG_LIMIT) s.log.shift();
    },
  };
}
