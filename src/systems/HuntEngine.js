// src/systems/HuntEngine.js
//
// A hunt on the hex map (Exploration System v2, chunk 7). Chunk 7 builds it in
// four steps; 7a and 7b are built:
//   7a  moving and seeing: moves (supplies + time), the clock and day/night,
//       Sight, fog, Detection, the scout action            <- built
//   7b  food: hunger, forage and fish, eating, camp and cooking  <- built
//   7c  the world tick, the encounter trigger, flee
//   7d  leaving: exit, objectives, the completion reward
//
// It sits BESIDE the old Advance loop in HuntManager.js, which the game still
// runs until chunk 8 draws the map. Nothing in the game creates a map hunt yet,
// and the save does not hold one yet (chunk 8 wires it in); the harness proves
// serialize/restore now so that wiring is only plumbing.
//
// Same seams as createHunt (HuntManager.js):
//   - an instance per hunt, with its own seeded stream, saved as its state so a
//     reload does not re-roll anything;
//   - side effects go through the injected `world` (GAME_WORLD in the game):
//     nightFalls / dayBreaks for the save-wide clock, party() for the hunters.
//   - the modifier bundle is built ONCE at departure and kept on the hunt.
//
// Party stats are NOT stored. partyStats(world.party(), mods) is called when a
// rule needs it, so a hunter who dies stops counting at once (partyStats leaves
// the dead out) and 7b's hunger can feed partyInitiativeBonus without a copy
// going stale. It is pure and cheap. What it is handed is the departure
// bundle plus this moment's hunger and food buff (HuntRules.momentMods).
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
//   fog        tile id -> 'visible' | 'remembered'; a tile missing is unseen.
//              A tile never goes back to unseen (harness invariant).
//   sightings  occupant id -> what was last detected there, and when. Tiles in
//              sight show what Detection reads NOW (it is a continuous state,
//              TERRAIN_TYPES); a remembered tile keeps its last reading, which
//              goes stale once packs move (7c).
//   scouted    occupants the scout action has resolved: identified, exact.

import { rollWeather } from '../../data/weather.js';
import { getZone } from '../../data/zones.js';
import { isPassable, GROUNDS } from '../../data/grounds.js';
import { Items } from '../../data/items.js';
import { addToList, makeStack, takeFromList, countInList } from './ItemStacks.js';
import { makeRng, rngFromState, randomSeed, isSeed } from './seededRng.js';
import { generateHuntMap, mapNeighbors, HUNT_MAP_VERSION } from './HuntMapGen.js';
import { partyStats } from './PartyStats.js';
import { GAME_WORLD, packAtDeparture, zoneDeathRule, DEATH_RULES } from './HuntManager.js';
import { isItemInstance } from './ItemFactory.js';
import {
  huntMods, moveCost, clockAt, sightRange, visibleTiles, occupantBand,
  occupantView, SCOUT_TIME, BANDS,
  hungerStage, momentMods, starvedHP, forageCandidates, gatherQty, FORAGE_TIME, FISH_TIME,
  FORAGE_YIELD, FISH_YIELD, FISH_ITEM, CAMP_TIME, CAMP_SUPPLY, SATED_TIME, campRecoveryPercent,
  recovered, cookDish,
} from './HuntRules.js';

/** Shape version of a serialized map hunt. Not yet in any save (chunk 8). */
export const MAP_HUNT_STATE_VERSION = 1;

const LOG_LIMIT = 50;
const HOSTILE = new Set(['beast', 'cultist']);

/**
 * Start a hunt on a freshly generated map.
 *
 * @param {string} zoneId
 * @param {object} opts
 * @param {{objective: string, size: string, bonusObjectives?: string[], mods?: object}} opts.plan
 *        planMapInputs(huntPlanView(inst)) gives exactly this (HuntMapGen.js)
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
    plan: { objective: plan.objective, size: plan.size, bonusObjectives: [...(plan.bonusObjectives || [])] },
    weather,
    mods: huntMods(zone.modifiers, weather.modifiers, planMods),
    deathRule: zoneDeathRule(zone),
    map,
    pos: map.entry,
    from: null,
    time: 0,
    supplies: start,
    maxSupplies: start,
    fog: {},
    sightings: {},
    scouted: [],
    zeroSince: start > 0 ? null : 0,
    satedUntil: 0,
    foodBuff: null,
    gathered: {},
    pack,
    log: [],
  };
  const hunt = makeMapHunt(s, rng, world);
  hunt._reveal();
  return hunt;
}

/**
 * Rebuild a map hunt from serialize() output. Throws on anything it does not
 * recognise rather than half-restoring it.
 */
export function restoreMapHunt(data, world = GAME_WORLD) {
  if (!data || typeof data !== 'object') throw new Error('no map hunt data');
  if (data.v !== MAP_HUNT_STATE_VERSION) throw new Error(`unknown map hunt version ${data.v} (this build reads ${MAP_HUNT_STATE_VERSION})`);
  if (!getZone(data.zoneId)) throw new Error(`unknown hunt zone '${data.zoneId}'`);
  if (data.map?.v !== HUNT_MAP_VERSION || !data.map.tiles) throw new Error('map hunt has no map it can read');
  if (!data.map.tiles[data.pos]) throw new Error(`map hunt position '${data.pos}' is not on its map`);
  if (!DEATH_RULES.includes(data.deathRule)) throw new Error(`map hunt has no valid death rule ('${data.deathRule}')`);
  for (const k of ['time', 'supplies', 'maxSupplies']) {
    if (!Number.isFinite(data[k])) throw new Error(`map hunt field '${k}' is not a number`);
  }
  for (const [id, f] of Object.entries(data.fog || {})) {
    if (!data.map.tiles[id] || (f !== 'visible' && f !== 'remembered')) throw new Error(`bad fog entry '${id}'`);
  }
  if (!data.sightings || Object.values(data.sightings).some(x => !BANDS.includes(x.band))) throw new Error('bad sightings');
  if (!Array.isArray(data.scouted) || !Array.isArray(data.log)) throw new Error('map hunt lists are missing');
  if (!(data.zeroSince === null || Number.isFinite(data.zeroSince)) || !Number.isFinite(data.satedUntil)) throw new Error('map hunt hunger is not readable');
  if (!data.gathered || typeof data.gathered !== 'object') throw new Error('map hunt has no gathered list');
  if (data.foodBuff !== null && !(typeof data.foodBuff?.field === 'string' && Number.isFinite(data.foodBuff.amount) && Number.isFinite(data.foodBuff.until))) {
    throw new Error('map hunt food buff is not readable');
  }
  if (!Array.isArray(data.pack?.brought) || !Array.isArray(data.pack?.found)
      || ![...data.pack.brought, ...data.pack.found].every(isItemInstance)) {
    throw new Error('map hunt pack is not two lists of items');
  }
  if (!data.mods || !data.weather) throw new Error('map hunt is missing its weather or modifiers');
  if (!isSeed(data.rngState)) throw new Error('map hunt has no random-stream state');
  const { rngState, ...rest } = data;
  return makeMapHunt(clone(rest), rngFromState(rngState), world);
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function makeMapHunt(s, rng, world) {
  const occById = () => new Map(s.map.occupants.map(o => [o.id, o]));

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

    /**
     * Move to a neighbouring tile. Spends supplies (never below 0: running
     * out never ejects the party, HUNT_STRUCTURE) and time, then looks around.
     * Refuses a tile that is not next to the party or cannot be entered.
     * `contact` names a hostile occupant on the tile entered, with what the
     * party knew of it BEFORE stepping in; the encounter it starts is 7c.
     */
    move(to) {
      if (!mapNeighbors(s.map, s.pos).includes(to)) return { ok: false, reason: `'${to}' is not next to the party` };
      const tile = s.map.tiles[to];
      if (!isPassable(tile)) return { ok: false, reason: `'${to}' cannot be entered` };
      const st = this.stats();
      const cost = moveCost(tile, st);
      const knew = this._knownAt(to);
      s.supplies = Math.max(0, s.supplies - cost.supply);
      s.from = s.pos;
      s.pos = to;
      const flips = this._advanceTime(cost.time);
      this._noteSupplies();
      const starved = this.hunger() === 'starving' ? this._starve() : [];
      this._reveal(st);
      const occ = s.map.occupants.find(o => o.tile === to && HOSTILE.has(o.kind)) || null;
      const contact = occ ? { id: occ.id, kind: occ.kind, knew: knew?.band || 'nothing' } : null;
      if (contact) this._log({ kind: 'contact', tile: to, occupant: occ.id, knew: contact.knew, time: s.time });
      return { ok: true, to, supply: cost.supply, time: cost.time, flips, contact, starved };
    },

    /**
     * The scout action (ENCOUNTERS): costs SCOUT_TIME of in-game time and no
     * supplies, the party stays put, and it targets one occupant in sight that
     * is at least sensed. It resolves it: identified, with the exact roster.
     * Its gear and part rarity are rolled with the fight, so showing them is
     * the combat hookup's (chunk 9); `scouted` is what it will read.
     */
    scout(occId) {
      const occ = occById().get(occId);
      if (!occ) return { ok: false, reason: `no occupant '${occId}'` };
      if (s.scouted.includes(occId)) return { ok: false, reason: 'already scouted' };
      if (s.fog[occ.tile] !== 'visible') return { ok: false, reason: 'not in sight' };
      const seen = s.sightings[occId];
      if (!seen || seen.band === 'nothing') return { ok: false, reason: 'nothing detected there' };
      const flips = this._advanceTime(SCOUT_TIME);
      s.scouted.push(occId);
      this._reveal();
      this._log({ kind: 'scout', occupant: occId, time: s.time });
      return { ok: true, time: SCOUT_TIME, flips, view: this.occupantViewOf(occId) };
    },

    /**
     * Forage the party's tile (PARTY_STATS Part B): FORAGE_TIME of in-game
     * time, once per tile per hunt. What grows depends on the ground, how much
     * on its forage band and the party's forageYieldPercent (Foraging's curve
     * plus of the Harvest). Blight, barren tiles (Lean Country) and a tile
     * already gathered give nothing, and are refused before any time is spent.
     */
    forage() {
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
      const flips = this._advanceTime(FORAGE_TIME);
      this._reveal();
      this._log({ kind: 'forage', tile: s.pos, item: id, qty, time: s.time });
      return { ok: true, item: id, qty, time: FORAGE_TIME, flips };
    },

    /** Fish from a tile beside water: FISH_TIME, once per tile (forage OR
     *  fish), raw fish scaled by fishYieldPercent. Fish must be cooked. */
    fish() {
      const tile = s.map.tiles[s.pos];
      if (s.gathered[s.pos]) return { ok: false, reason: 'this tile has already been gathered' };
      if (!tile.fishing) return { ok: false, reason: 'there is no water to fish here' };
      if (tile.barren) return { ok: false, reason: 'the water here is empty' };
      const st = this.stats();
      const qty = gatherQty(FISH_YIELD, st.fishYieldPercent, Items[FISH_ITEM].supply);
      addToList(s.pack.found, makeStack(FISH_ITEM, qty));
      s.gathered[s.pos] = 'fish';
      const flips = this._advanceTime(FISH_TIME);
      this._reveal();
      this._log({ kind: 'fish', tile: s.pos, item: FISH_ITEM, qty, time: s.time });
      return { ok: true, item: FISH_ITEM, qty, time: FISH_TIME, flips };
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
     * Camp on the party's tile (PARTY_STATS Part B, decision 7). Takes
     * CAMP_TIME and CAMP_SUPPLY (eaten after the meals are cooked, never below
     * 0). Cooks each meal { main, addition? }: main is fish (or, from chunk 9,
     * meat), the addition a forage food. Then every hunter who is not dead
     * recovers a share of max HP and MP: more if the camp began at night,
     * more again with Field Rites. A Hearty or Fine meal leaves the party
     * Sated for SATED_TIME after the camp; the last Fine meal's buff replaces
     * any other. The world tick and the found-in-camp check are 7c's.
     * Refuses the whole camp, before anything happens, if a meal is not cookable.
     */
    camp({ meals = [] } = {}) {
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
      const flips = this._advanceTime(CAMP_TIME);
      this._noteSupplies();
      const pct = campRecoveryPercent(night, st.passives.campRecoveryPercent);
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
      this._log({ kind: 'camp', tile: s.pos, night, pct, dishes: dishes.map(d => d.quality), time: s.time });
      return { ok: true, night, recoveryPercent: pct, dishes, supplyGained: gained, healed, flips, time: CAMP_TIME };
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
      const occupants = Object.keys(s.sightings).map(id => this.occupantViewOf(id)).filter(Boolean);
      return {
        pos: s.pos,
        clock: this.clock(),
        supplies: s.supplies,
        maxSupplies: s.maxSupplies,
        hunger: this.hunger(),
        satedUntil: s.satedUntil,
        foodBuff: s.foodBuff && s.time < s.foodBuff.until ? { ...s.foodBuff } : null,
        fog: { ...s.fog },
        occupants,
      };
    },

    getState() {
      return clone(s);
    },

    /** Plain JSON for the save. restoreMapHunt(serialize()) continues identically. */
    serialize() {
      return { ...clone(s), rngState: rng.getState() };
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

    _knownAt(tile) {
      return Object.values(s.sightings).find(x => x.tile === tile) || null;
    },

    /**
     * Spend in-game time. Each phase boundary crossed is one flip, in order:
     * night falls, then the next day breaks. Returns the flips.
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
     * every occupant on a visible tile.
     */
    _reveal(st = this.stats()) {
      const range = sightRange(s.map, s.pos, st.passives.sightRangeBonus);
      const vis = new Set(visibleTiles(s.map, s.pos, { range }));
      for (const id of Object.keys(s.fog)) if (!vis.has(id)) s.fog[id] = 'remembered';
      for (const id of vis) s.fog[id] = 'visible';
      for (const occ of s.map.occupants) {
        if (!vis.has(occ.tile)) continue;
        const band = s.scouted.includes(occ.id) ? 'identified' : occupantBand(s.map, occ, st.perception);
        if (band === 'nothing') delete s.sightings[occ.id];
        else s.sightings[occ.id] = { tile: occ.tile, band, at: s.time };
      }
      return range;
    },

    _log(entry) {
      s.log.push(entry);
      if (s.log.length > LOG_LIMIT) s.log.shift();
    },
  };
}
