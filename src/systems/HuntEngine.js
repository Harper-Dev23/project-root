// src/systems/HuntEngine.js
//
// A hunt on the hex map (Exploration System v2, chunk 7). Chunk 7 builds it in
// four steps; this file is currently step 7a:
//   7a  moving and seeing: moves (supplies + time), the clock and day/night,
//       Sight, fog, Detection, the scout action            <- built
//   7b  food: hunger, forage and fish, eating, camp and cooking
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
// going stale. It is pure and cheap.
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
import { isPassable } from '../../data/grounds.js';
import { makeRng, rngFromState, randomSeed, isSeed } from './seededRng.js';
import { generateHuntMap, mapNeighbors, HUNT_MAP_VERSION } from './HuntMapGen.js';
import { partyStats } from './PartyStats.js';
import { GAME_WORLD, packAtDeparture, zoneDeathRule, DEATH_RULES } from './HuntManager.js';
import { isItemInstance } from './ItemFactory.js';
import {
  huntMods, moveCost, clockAt, sightRange, visibleTiles, occupantBand,
  occupantView, SCOUT_TIME, BANDS,
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
    /** The party's stats right now: live party, the hunt's bundle. */
    stats() {
      return partyStats(world.party(), s.mods);
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
      this._reveal(st);
      const occ = s.map.occupants.find(o => o.tile === to && HOSTILE.has(o.kind)) || null;
      const contact = occ ? { id: occ.id, kind: occ.kind, knew: knew?.band || 'nothing' } : null;
      if (contact) this._log({ kind: 'contact', tile: to, occupant: occ.id, knew: contact.knew, time: s.time });
      return { ok: true, to, supply: cost.supply, time: cost.time, flips, contact };
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
