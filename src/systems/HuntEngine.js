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
//   scouted     occupants the scout action has resolved: identified, exact,
//               and their loadout's rarities shown (chunk 9a).
//   occ.loadout on a hostile occupant (chunk 9a, HuntBeasts.js): its parts or
//               gear, rolled once on the first scout or contact from its own
//               stream, kept in the save, and what sets its initiative.
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
//   communed    the shrine's event has been resolved (Commune; chunk 11b)
//   unmasked    occupants identified while their concealment was above 100
//
// ── What the map scene reads (chunk 8a) ─────────────────────────────────────
// The scene (chunk 8) reads view() and acts only through the methods here, so
// view() carries everything it draws and nothing the party has not seen:
//   layout          the current section's shape, known from the start (drawn
//                   as fog hexes: owner decision 4, chunk 8)
//   tiles           seen tiles only: ground as last seen, relief, ford, exit,
//                   gathered
//   passages,       only where their tile has been seen
//   features
//   objectiveSites  Scout / Retrieve / Commune sites, marked from departure
//                   (decision 5); never Apex or Cull targets, never a bonus
//                   objective's route (it can point at a hidden ambusher)
//   moves           the enterable neighbours and what each costs now
// The harness (huntrules.mjs, 8a) checks all of this at every step, including
// that no undetected occupant's id ever appears in the view.

import { rollWeather } from '../../data/weather.js';
import { getZone } from '../../data/zones.js';
import { isPassable, GROUNDS } from '../../data/grounds.js';
import { Items } from '../../data/items.js';
import { addToList, makeStack, takeFromList, countInList, partMaterial } from './ItemStacks.js';
import { HARVEST_TIME, MEAT_TIME_PER_BODY, MEAT_BY_GRADE, SPECIMEN_RARITIES } from '../../data/beastParts.js';
import { makeRng, rngFromState, randomSeed, isSeed } from './seededRng.js';
import { parseTileId, distance } from './HexGrid.js';
import { EVENT_TEMPLATES } from '../../data/events.js';
import { applyEffects, fillText, dynamicBlock, evalNumber, rollD20, statModifier, ratingModifier,
  CORE_STATS } from './EventEffects.js';
import { generateHuntMap, mapNeighbors, occupantConcealment, HUNT_MAP_VERSION } from './HuntMapGen.js';
import { partyStats } from './PartyStats.js';
import { GAME_WORLD, packAtDeparture, zoneDeathRule, DEATH_RULES, settlePack } from './HuntManager.js';
import { objectiveProgress, exitReward, completionRewardPercent } from './HuntObjectives.js';
import { isItemInstance, createItemInstance } from './ItemFactory.js';
import { houseOf } from './Standing.js';
import { VIGIL_KILL_COST, UNMARKED_KILL_FALSE_GOD } from '../../data/standing.js';
import * as Boons from './Boons.js';
import { FALSE_GODS, PACT_START, PACT_MAX, PACT_PRICE } from '../../data/falseGods.js';
import {
  huntMods, moveCost, clockAt, sightRange, visibleTiles, occupantBand,
  occupantView, SCOUT_TIME, BANDS,
  hungerStage, momentMods, starvedHP, forageCandidates, gatherQty, FORAGE_TIME, FISH_TIME,
  FORAGE_YIELD, FISH_YIELD, FISH_ITEM, CAMP_TIME, CAMP_SUPPLY, SATED_TIME, campRecoveryPercent,
  recovered, cookDish,
} from './HuntRules.js';
import { initWorld, worldTick, alert, loseTrail, makeEncounter, trailView, CLEANSE_TIME } from './HuntWorld.js';
import { rollLoadout, loadoutSeed, loadoutView, fightScenario } from './HuntBeasts.js';
import { huntItemLevel } from './HuntScaling.js';

/** Shape version of a serialized map hunt. Not yet in any save (chunk 8). */
export const MAP_HUNT_STATE_VERSION = 1;

/** A won fight's XP pool, split over the party (GameState.awardXPPool), before
 *  the plan's xpPercent. Was the Advance loop's 20 (chunk 9 decision 9);
 *  60 in chunk 13c-4, then 32 in 13c-5 once hunts held 3-4x the fights
 *  (32, not 30: a party of 4-6 takes 25% of the pool, a whole 8 each),
 *  beside the completion pool paid at the exit
 *  (HuntObjectives.COMPLETION_XP_POOL), tuned with huntsim. */
export const FIGHT_XP_POOL = 32;
/** Hunt Points for a won beast fight, before the plan's huntPointsPercent.
 *  The Advance loop's number; cultists pay none (their reward is gear). */
export const BEAST_FIGHT_HUNT_POINTS = 8;
/** In-game time a wipe the prophet spoke for costs the party (owner idea B,
 *  chunk 10c-2): half a day, carried back to a way out. Tuning is chunk 13. */
export const RESCUE_TIME = 6;

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
  const boon0 = newBoon(zone, world);
  const map = generateHuntMap({
    zoneId, objective: plan.objective, size: plan.size, seed: mapSeed,
    bonusObjectives: plan.bonusObjectives || [], mods: planMods, followed: boon0.followed,
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
    // Hunters knocked out in fights this hunt (won or fled), for the Unbroken
    // bonus objective (chunk 9c). Optional in a save: missing reads as 0.
    knockouts: 0,
    // What a won beast fight left on the ground (chunk 9d): its parts and its
    // bodies' meat, until the party harvests or walks away. Saved, so a
    // reload keeps it. Null otherwise.
    spoils: null,
    cleansed: [],
    retrieved: false,
    communed: false,
    unmasked: [],
    finished: null,
    reward: null,
    pack,
    // The prophet boon (chunk 10b): the region's house, whether your tribe
    // follows it (read once, at departure, like the modifier bundle), and the
    // favor and level this hunt has earned. Ends with the hunt.
    boon: boon0,
    // The event site the party stands on, open until it is resolved or walked
    // away from (chunk 11a): { templateId, site: { occId?, tile }, roles,
    // houseId, rivalId }. Null otherwise; optional in a save.
    event: null,
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
 *
 * `{ view: true }` is a co-op guest's copy (chunk 12c): the host's snapshot
 * rebuilt only to be drawn. It keeps a pending encounter as it is, because
 * the host is about to fight it; nothing but view() is ever called on it.
 */
export function restoreMapHunt(data, world = GAME_WORLD, { view = false } = {}) {
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
  if (data.foodBuff !== null && !(typeof data.foodBuff?.field === 'string' && Number.isFinite(data.foodBuff.amount)
      && (Number.isFinite(data.foodBuff.until) || data.foodBuff.fight === true))) {
    throw new Error('map hunt food buff is not readable');
  }
  if (!Number.isFinite(data.world?.time) || !Number.isFinite(data.world?.day)) throw new Error('map hunt world clock is not readable');
  if (data.knockouts !== undefined && !Number.isFinite(data.knockouts)) throw new Error('map hunt knock-outs are not readable');
  if (data.spoils != null && !(Array.isArray(data.spoils.parts) && data.spoils.parts.every(isItemInstance) && Array.isArray(data.spoils.bodies))) {
    throw new Error('map hunt spoils are not readable');
  }
  if (!GROUNDS[data.landGround]) throw new Error('map hunt has no land ground');
  if (data.finished !== null && data.finished !== 'exit' && data.finished !== 'wipe') throw new Error(`map hunt ending '${data.finished}' is not one this build knows`);
  if (!Number.isFinite(data.plan?.itemLevel) || !Number.isFinite(data.plan?.completionRewardPercent)) throw new Error('map hunt plan has no item level or reward');
  if (!Array.isArray(data.pack?.brought) || !Array.isArray(data.pack?.found)
      || ![...data.pack.brought, ...data.pack.found].every(isItemInstance)) {
    throw new Error('map hunt pack is not two lists of items');
  }
  if (!data.mods || !data.weather) throw new Error('map hunt is missing its weather or modifiers');
  if (!isSeed(data.rngState) || !isSeed(data.worldRngState)) throw new Error('map hunt has no random-stream state');
  // Optional in a save: a hunt saved before 10b has no boon and starts one at
  // nothing, with the house its region names and not followed.
  if (data.boon !== undefined && !(data.boon && (data.boon.house === null || typeof data.boon.house === 'string')
      && typeof data.boon.followed === 'boolean' && Number.isFinite(data.boon.favor) && Number.isFinite(data.boon.level))) {
    throw new Error('map hunt boon is not readable');
  }
  if (data.event != null && !(EVENT_TEMPLATES[data.event.templateId] && typeof data.event.site?.tile === 'string'
      && data.map.tiles[data.event.site.tile] && data.event.roles && typeof data.event.roles === 'object')) {
    throw new Error('map hunt pending event is not readable');
  }
  const { rngState, worldRngState, ...rest } = data;
  if (rest.event === undefined) rest.event = null;
  if (rest.boon === undefined) rest.boon = { house: houseOf(getZone(rest.zoneId)?.divineAlignment), followed: false, favor: 0, level: 0 };
  if (rest.vigil != null && typeof rest.vigil !== 'string') throw new Error('map hunt vigil is not readable');
  if (rest.boon.pact != null && !(FALSE_GODS[rest.boon.pact.god] && Number.isInteger(rest.boon.pact.level))) throw new Error('map hunt pact is not readable');
  const hunt = makeMapHunt(clone(rest), rngFromState(rngState), rngFromState(worldRngState), world);
  if (rest.encounter && !rest.finished && !view) hunt.flee({ reason: 'reload' });
  return hunt;
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

/** A hunt's boon at departure: the region's house, and whether your tribe follows it. */
function newBoon(zone, world) {
  const house = houseOf(zone?.divineAlignment);
  return { house, followed: !!house && world.followedHouse?.() === house, favor: 0, level: 0 };
}

function makeMapHunt(s, rng, worldRng, world) {
  const occById = () => new Map(s.map.occupants.map(o => [o.id, o]));
  // Doing anything else walks away from a won fight's spoils (decision 13:
  // "spoils left behind are gone"); they are never a lock on the hunt.
  const leaveSpoils = () => {
    if (!s.spoils) return;
    s.log.push({ kind: 'spoils_left', parts: s.spoils.parts.length, time: s.time });
    if (s.log.length > LOG_LIMIT) s.log.shift();
    s.spoils = null;
  };
  const frozen = () => {
    if (s.finished) return { ok: false, reason: 'the hunt is over' };
    if (s.encounter) return { ok: false, reason: 'a fight is under way: win it or flee' };
    if (s.event) return { ok: false, reason: 'an event is waiting: see it through or walk away' };
    leaveSpoils();
    return null;
  };

  return {
    /** The party's stats right now: live party, the hunt's bundle, this
     *  moment's hunger and food buff. */
    stats() {
      return partyStats(world.party(), momentMods(s.mods, {
        stage: this.hunger(), foodBuff: s.foodBuff, time: s.time,
        boon: this._boonNow().explore,
      }));
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
        this._ensureLoadout(occ);
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
      // An event site opens when the party arrives, unless a fight came first.
      const event = s.encounter ? null : this._openEventAt(s.pos);
      return { ok: true, to, supply: cost.supply, time: cost.time, flips: spent.flips, contact, encounter: this.encounter(), starved,
        event: event?.quiet ? null : event, quiet: event?.quiet || null };
    },

    /**
     * The scout action (ENCOUNTERS): costs SCOUT_TIME of in-game time and no
     * supplies, the party stays put, and it targets one occupant in sight that
     * is at least sensed. It resolves it: identified, with the exact roster,
     * and its loadout's rarities (chunk 9a): the loadout is rolled here if it
     * has not been yet, and kept, so the fight meets what was scouted.
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
      this._ensureLoadout(occ);
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
      // A buff lasts in-game time, or "the next fight" (PARTY_STATS Part B):
      // a fight buff has no clock; beginFight() hands it to combat and uses it.
      if (fine) {
        s.foodBuff = fine.buff.duration === 'fight'
          ? { field: fine.buff.field, amount: fine.buff.amount, fight: true, source: fine.addition }
          : { ...fine.buff, until: s.time + fine.buff.duration, source: fine.addition };
      }
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
     * What CombatScene needs to fight the pending encounter (chunk 9b): the
     * occupant as a combat scenario (HuntBeasts.fightScenario: its roster, grades
     * and kept loadout), which side acts first, the region's item level, the
     * death rule a wipe follows, and the fight's XP pool (FIGHT_XP_POOL scaled
     * by the plan's xpPercent). Reading it changes nothing.
     */
    fightSpec() {
      if (s.finished) return { ok: false, reason: 'the hunt is over' };
      const e = s.encounter;
      if (!e) return { ok: false, reason: 'no fight to start' };
      const occ = occById().get(e.occId);
      this._ensureLoadout(occ);
      const zone = getZone(s.zoneId);
      const itemLevel = huntItemLevel(zone?.danger);
      return {
        ok: true, occId: e.occId, kind: e.kind, first: e.first, ambush: e.ambush, knew: e.knew,
        partyInitiative: e.partyInitiative, enemyInitiative: e.enemyInitiative,
        itemLevel, deathRule: s.deathRule,
        xpPool: Math.round(FIGHT_XP_POOL * (1 + (s.mods.xpPercent || 0) / 100)),
        scenario: this._weakened(occ, fightScenario(occ, { itemLevel, zoneName: zone?.name })),
        boon: this._boonForFight(),
      };
    },

    /**
     * Start the pending encounter's fight (the map scene's Fight button, chunk
     * 9c): fightSpec() plus the party's "next fight" food buff, which is USED
     * UP here (PARTY_STATS: "the next fight"). CombatScene puts it on every
     * standing hunter as a status. A reload mid-fight is still a flee, and the
     * buff stays spent: it was eaten.
     */
    beginFight() {
      const spec = this.fightSpec();
      if (!spec.ok) return spec;
      let foodBuff = null;
      if (s.foodBuff?.fight) {
        foodBuff = { field: s.foodBuff.field, amount: s.foodBuff.amount, source: s.foodBuff.source,
          name: Items[s.foodBuff.source]?.name || 'a meal' };
        s.foodBuff = null;
      }
      this._log({ kind: 'fight', occupant: spec.occId, food: foodBuff?.source || null, time: s.time });
      return { ...spec, foodBuff };
    },

    /**
     * Harvest a won beast fight (BEAST_PARTS; chunk 9 decisions 12-14). `take`
     * lists the spoils' part ids (view().spoils.parts[].id) to carry; `meat`
     * butchers every body. It costs in-game time, HARVEST_TIME per part (core
     * or peripheral) and MEAT_TIME_PER_BODY, cut by Foraging's harvest-time
     * curve; the world ticks for it, so a Hunting pack can arrive. It never
     * fails and never lowers a rarity:
     *   - common and uncommon parts go in the pack as plain material
     *     (partMaterial: no affixes, stacked by family + slot + rarity + grade);
     *   - rare and epic parts keep their affixes, each its own specimen;
     *   - meat per body by grade (MEAT_BY_GRADE), scaled by Foraging's yield
     *     curve and of the Harvest (forageYieldPercent).
     * What is not taken is gone. harvest({ take: [], meat: false }) just walks
     * away, costing nothing.
     */
    harvest({ take = [], meat = true } = {}) {
      if (s.finished) return { ok: false, reason: 'the hunt is over' };
      if (s.encounter) return { ok: false, reason: 'a fight is under way: win it or flee' };
      const sp = s.spoils;
      if (!sp) return { ok: false, reason: 'nothing to harvest' };
      const byId = new Map(sp.parts.map(p => [p.instanceId, p]));
      const want = [...new Set(take)];
      const bad = want.find(id => !byId.has(id));
      if (bad) return { ok: false, reason: `'${bad}' is not among the spoils` };
      const st = this.stats();
      const parts = want.map(id => byId.get(id));
      const baseTime = parts.reduce((t, p) => t + (Items[p.id]?.part?.core ? HARVEST_TIME.core : HARVEST_TIME.peripheral), 0)
        + (meat ? sp.bodies.length * MEAT_TIME_PER_BODY : 0);
      const time = baseTime * (1 - (st.harvestTimePercent || 0) / 100);
      let specimens = 0, materials = 0;
      for (const p of parts) {
        if (SPECIMEN_RARITIES.includes(p.rarity)) { addToList(s.pack.found, clone(p)); specimens++; }
        else { const m = partMaterial(p, 1); if (m) { addToList(s.pack.found, m); materials++; } }
      }
      const meatGot = {};
      if (meat) {
        for (const g of sp.bodies) {
          const m = MEAT_BY_GRADE[g];
          if (!m) continue;
          meatGot[m.id] = (meatGot[m.id] || 0) + Math.round(m.qty * (1 + (st.forageYieldPercent || 0) / 100));
        }
        for (const [id, qty] of Object.entries(meatGot)) if (qty > 0) addToList(s.pack.found, makeStack(id, qty));
      }
      s.spoils = null;
      const spent = time > 0 ? this._spendTime(time) : { flips: [], encounter: null };
      this._reveal();
      this._log({ kind: 'harvest', specimens, materials, meat: meatGot, time: s.time });
      return { ok: true, specimens, materials, meat: meatGot, time, flips: spent.flips, encounter: this.encounter(), event: this._openEventHere() };
    },

    /**
     * The fight was won (CombatScene calls this, chunk 9b). The occupant leaves
     * the map and the kill is recorded; no occupant ever replaces it (no
     * mid-hunt spawns). What the fight pays, as the Advance loop paid it
     * (chunk 9 decision 9):
     *   - `loot`: the item instances that dropped go into the pack's found
     *     list, at risk until the exit (HUNT_STRUCTURE's pack);
     *   - Hunt Points: BEAST_FIGHT_HUNT_POINTS for a beast fight, scaled by the
     *     plan's huntPointsPercent, none for cultists (their reward is gear);
     *   - XP is the fight's pool (fightSpec().xpPool), paid by CombatScene,
     *     which shows who levelled.
     */
    winEncounter({ loot = [], knockedOut = 0 } = {}) {
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
      s.knockouts = (s.knockouts || 0) + (Number(knockedOut) || 0);
      const found = loot.filter(isItemInstance);
      for (const inst of found) addToList(s.pack.found, inst);
      const huntPoints = occ.kind === 'beast'
        ? Math.round(BEAST_FIGHT_HUNT_POINTS * (1 + (s.mods.huntPointsPercent || 0) / 100)) : 0;
      // A beast fight leaves its bodies (chunk 9d): every part it wore, as
      // rolled and kept since the scout or contact, and the meat, for harvest().
      // Cultists leave only the armour that already dropped.
      s.spoils = occ.kind === 'beast' ? {
        family: occ.family || null,
        parts: (occ.loadout || []).flatMap(g => Object.values(g)).map(p => clone(p)),
        bodies: occ.roster.map(m => m.grade),
        at: s.time,
      } : null;
      if (huntPoints > 0) world.awardHuntPoints(huntPoints);
      const favor = this._earnFavor(Boons.killFavor(occ), 'kill');
      const unmarked = this._unmarkedKill(occ);
      this._reveal();
      this._log({ kind: 'win', occupant: occ.id, huntPoints, loot: found.length, time: s.time });
      return { ok: true, kill, huntPoints, loot: found.length, spoils: !!s.spoils, favor, unmarked, event: this._openEventHere() };
    },

    /**
     * An unmarked beast was killed (chunk 11d; ENCOUNTERS, EVENTS). The
     * region's false god always notices (hidden standing +
     * UNMARKED_KILL_FALSE_GOD, blight or not). Under a vigil, a kill off
     * blight also costs VIGIL_KILL_COST Bond and devotion with the vigil's
     * house; on blight it is forgiven (blight-mercy). Returns what it cost,
     * or null for any other kill.
     */
    _unmarkedKill(occ) {
      if (occ.kind !== 'beast' || occ.mark !== 'unmarked') return null;
      const god = getZone(s.zoneId)?.falseGod || null;
      if (god) world.falseGod?.(god, UNMARKED_KILL_FALSE_GOD);
      const mercy = s.map.tiles[occ.tile]?.ground === 'blight';
      const cost = s.vigil && !mercy ? VIGIL_KILL_COST : 0;
      if (cost) world.favor?.(s.vigil, -cost);
      this._log({ kind: 'unmarked_kill', occupant: occ.id, vigil: s.vigil || null, mercy, cost, time: s.time });
      return { god, vigil: s.vigil || null, mercy, cost };
    },

    /** An event's `vigil` verb (11d): the region's house keeps a vigil for the rest of the hunt. */
    _setVigil(house) {
      if (!house) return false;
      s.vigil = house;
      this._log({ kind: 'vigil', house, time: s.time });
      return true;
    },

    /** Is a beast of this mark within 2 steps (the `fight` verb's reach)? For `appears.nearby`. */
    _nearbyMark(mark) {
      const here = parseTileId(s.pos);
      return s.map.occupants.some(o => {
        if (o.kind !== 'beast' || o.mark !== mark) return false;
        const p = parseTileId(o.tile);
        return p.section === here.section && distance(here, p) <= 2;
      });
    },

    /**
     * Flee (ENCOUNTERS, decision 10): always possible, never free, no roll.
     *   - the enemy gets a full round as you disengage: CombatScene plays it
     *     (_startFlee, chunk 9c) and then calls this, with how many hunters it
     *     knocked out (for Unbroken). A reload mid-fight also calls it
     *     (reason 'reload'), with no free round;
     *   - the party retreats to the tile it came from (or, if the pack came to
     *     it, to the first open neighbour), paying that move's time;
     *   - nothing from the fight is kept: the occupant stays on the map;
     *   - the pack is alerted: it hunts the party, from the end of the retreat.
     * No smoke charge yet: nothing could read one before chunk 9.
     */
    flee({ reason = 'fled', knockedOut = 0 } = {}) {
      if (s.finished) return { ok: false, reason: 'the hunt is over' };
      const e = s.encounter;
      if (!e) return { ok: false, reason: 'nothing to flee from' };
      const occ = occById().get(e.occId);
      const back = this._retreatTile(e);
      s.encounter = null;
      s.flees += 1;
      s.knockouts = (s.knockouts || 0) + (Number(knockedOut) || 0);
      const time = back ? moveCost(s.map.tiles[back], this.stats()).time : SCOUT_TIME;
      if (back) { s.from = s.pos; s.pos = back; }
      if (occ && occ.kind === 'beast') alert(occ, s.time + time);
      const spent = this._spendTime(time);
      const starved = this.hunger() === 'starving' ? this._starve() : [];
      this._reveal();
      this._log({ kind: 'flee', occupant: e.occId, reason, to: back, time: s.time });
      return {
        ok: true, to: back, time, flips: spent.flips, enemyFreeRound: reason !== 'reload',
        alerted: occ?.kind === 'beast' ? occ.id : null, starved, encounter: this.encounter(),
      };
    },

    /**
     * The party wiped, and the prophet spoke for some of it (owner idea B,
     * chunk 10c-2; CombatScene has already decided who fell). The hunt goes
     * on instead of ending:
     *   - the party stands on the nearest way out it knows (the entry or a
     *     Waystone it has seen), by steps across the map;
     *   - the fight is over and its occupant stays where it was, not alerted;
     *   - every pack hunting the party loses the trail;
     *   - RESCUE_TIME passes (the world ticks), and the knock-outs count
     *     against Unbroken.
     * The pack is kept. Refused with no fight pending, or once the hunt is over.
     */
    survive({ knockedOut = 0 } = {}) {
      if (s.finished) return { ok: false, reason: 'the hunt is over' };
      const e = s.encounter;
      if (!e) return { ok: false, reason: 'no fight to survive' };
      const to = this._nearestExit();
      s.encounter = null;
      s.knockouts = (s.knockouts || 0) + (Number(knockedOut) || 0);
      if (to) { s.from = null; s.pos = to; }
      for (const o of s.map.occupants) if (o.state === 'hunting') loseTrail(o, s.time);
      const spent = this._spendTime(RESCUE_TIME);
      const starved = this.hunger() === 'starving' ? this._starve() : [];
      this._reveal();
      this._log({ kind: 'rescued', occupant: e.occId, to, time: s.time });
      return { ok: true, to, time: RESCUE_TIME, flips: spent.flips, starved, encounter: this.encounter() };
    },

    /** The nearest exit tile the party has seen, by steps (passages count as one). */
    _nearestExit() {
      const seen = new Set([s.pos]);
      let frontier = [s.pos];
      while (frontier.length) {
        const hit = frontier.filter(id => s.map.tiles[id]?.exit && (id === s.map.entry || s.fog[id])).sort()[0];
        if (hit) return hit;
        const next = [];
        for (const id of frontier) {
          for (const n of mapNeighbors(s.map, id)) {
            if (seen.has(n) || !isPassable(s.map.tiles[n])) continue;
            seen.add(n); next.push(n);
          }
        }
        frontier = next;
      }
      return s.map.entry;
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
      // Completion XP (chunk 13c): the world splits it over the party.
      if (reward.xpPool > 0) world.awardXP?.(reward.xpPool);
      s.reward = { completion: reward.completion, bonuses: reward.bonuses, huntPoints: reward.huntPoints, primaryDone: reward.primaryDone, xpPool: reward.xpPool };
      this._log({ kind: 'exit', tile: s.pos, huntPoints: reward.huntPoints, xpPool: reward.xpPool, primaryDone: reward.primaryDone, time: s.time });
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
      // Only a scout shows the loadout (ENCOUNTERS: "a scout action shows actual
      // gear"); Keen Tracker's exact roster does not.
      if (v.exact && s.scouted.includes(occId) && occ.loadout) v.loadout = loadoutView(occ);
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
      // Chunk 8a: what the map scene needs to draw, and only what the party
      // has seen (owner decisions 4 and 5, 2026-09-19). The section's SHAPE is
      // known from the start; ground, relief, fords, exits, passages and
      // features only once seen. Nothing here reads an occupant.
      const known = (id) => !!s.fog[id];
      const section = parseTileId(s.pos).section;
      const tiles = {};
      for (const id of Object.keys(s.fog)) {
        const t = s.map.tiles[id];
        tiles[id] = { ground: ground[id], relief: t.relief || 'flat' };
        if (t.ford) tiles[id].ford = true;
        if (t.exit) tiles[id].exit = true;
        if (s.gathered[id]) tiles[id].gathered = s.gathered[id];
      }
      const moves = [];
      for (const to of mapNeighbors(s.map, s.pos)) {
        const c = moveCost(s.map.tiles[to], st);
        if (c) moves.push({ tile: to, supply: c.supply, time: c.time });
      }
      return {
        section,
        layout: Object.keys(s.map.tiles).filter(id => parseTileId(id).section === section),
        sections: s.map.sections.length,
        tiles,
        passages: s.map.passages.flatMap(({ a, b }) => [{ tile: a, to: b }, { tile: b, to: a }]).filter(p => known(p.tile)),
        features: s.map.features.filter(f => known(f.tile))
          .map(f => (f.destroyed ? { kind: f.kind, tile: f.tile, destroyed: true } : { kind: f.kind, tile: f.tile })),
        objectiveSites: this._objectiveSites(),
        moves,
        zoneId: s.zoneId,
        plan: { ...s.plan, bonusObjectives: [...s.plan.bonusObjectives] },
        weather: { id: s.weather.id, name: s.weather.name },
        log: clone(s.log),
        pos: s.pos,
        clock: this.clock(),
        supplies: s.supplies,
        maxSupplies: s.maxSupplies,
        hunger: this.hunger(),
        satedUntil: s.satedUntil,
        foodBuff: s.foodBuff && (s.foodBuff.fight || s.time < s.foodBuff.until) ? { ...s.foodBuff } : null,
        fog: { ...s.fog },
        ground,
        occupants,
        trails,
        encounter: this.encounter(),
        // After a clean exit, judged as the exit judged them: a carried-home
        // objective (Retrieve, Provisioner, Trophy) is done only at the exit,
        // so the end panel said "Retrieve not done" on a hunt that paid for it.
        objectives: objectiveProgress(s, { atExit: s.finished === 'exit' }),
        spoils: this._spoilsView(),
        boon: this.boon(),
        event: this.event(),
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
      const noticedBefore = new Set(s.map.occupants.filter(o => o.noticed).map(o => o.id));
      const campConcealment = camping
        ? (GROUNDS[s.map.tiles[s.pos].ground]?.concealment || 0) + (this.stats().passives.campConcealmentBonus || 0)
        : 0;
      const tick = worldTick(s, start + units, {
        rng: worldRng,
        stats: () => this.stats(),
        campFrom: camping ? start : null,
        campConcealment,
        bandOf: (occ) => this._bandOf(occ),
        ensureLoadout: (occ) => this._ensureLoadout(occ),
        onEvent: () => this._reveal(),
      });
      const spent = camping && tick.encounter ? Math.max(0, Math.min(units, tick.stoppedAt - start)) : units;
      const flips = this._advanceTime(spent);
      // A predator took up the chase (chunk 13c, HuntWorld.predatorNotices).
      // The party learns of it only if it has detected that pack: then the
      // log says so and the action's flips carry 'scent' for the dialogue bar.
      for (const o of s.map.occupants) {
        if (!o.noticed || noticedBefore.has(o.id)) continue;
        const band = this._bandOf(o);
        if (band === 'nothing') continue;
        this._log({ kind: 'scent', occupant: o.id, family: band === 'identified' ? o.family : null, time: s.time });
        if (!flips.includes('scent')) flips.push('scent');
      }
      if (tick.encounter && !s.log.some(l => l.kind === 'encounter' && l.at === tick.encounter.at && l.occId === tick.encounter.occId)) {
        this._log({ kind: 'encounter', ...tick.encounter, time: s.time });
      }
      return { spent, flips, encounter: tick.encounter };
    },

    /**
     * Roll a hostile occupant's loadout the first time it is needed, and keep
     * it on the occupant (HuntBeasts.js): parts for a beast, armour for a
     * cultist. From its own stream, at the region's item level and the party's
     * Item Rarity now. Never re-rolled.
     */
    _ensureLoadout(occ) {
      if (!occ || occ.loadout || !HOSTILE.has(occ.kind)) return;
      occ.loadout = rollLoadout(occ, {
        itemLevel: huntItemLevel(getZone(s.zoneId)?.danger),
        itemRarity: this.stats().itemRarity,
        seed: loadoutSeed(s.seed, occ),
      });
    },

    /**
     * What the harvest panel shows of a won fight's spoils (chunk 9d), or null.
     * The fight is over, so a part's full identity is shown (BEAST_PARTS: parts
     * are revealed at harvest): each part's name, slot, rarity, grade and the
     * time it takes, and the meat the bodies would give. The factor is
     * Foraging's harvest-time cut, already applied to every time here.
     */
    _spoilsView() {
      const sp = s.spoils;
      if (!sp) return null;
      const st = this.stats();
      const factor = 1 - (st.harvestTimePercent || 0) / 100;
      const meat = {};
      for (const g of sp.bodies) {
        const m = MEAT_BY_GRADE[g];
        if (m) meat[m.id] = (meat[m.id] || 0) + Math.round(m.qty * (1 + (st.forageYieldPercent || 0) / 100));
      }
      return {
        family: sp.family,
        parts: sp.parts.map(p => {
          const part = Items[p.id]?.part || {};
          return {
            id: p.instanceId, base: p.id, name: p.displayName || Items[p.id]?.name || p.id,
            slot: part.slot || null, core: !!part.core, rarity: p.rarity, grade: p.grade || null,
            specimen: SPECIMEN_RARITIES.includes(p.rarity),
            time: (part.core ? HARVEST_TIME.core : HARVEST_TIME.peripheral) * factor,
          };
        }),
        bodies: sp.bodies.length,
        meat,
        meatTime: sp.bodies.length * MEAT_TIME_PER_BODY * factor,
      };
    },

    /** Settle the pack for an ending, bank what comes home, mark the hunt over. */
    _finish(ending) {
      const out = settlePack({ pack: s.pack, supplies: s.supplies, deathRule: s.deathRule, ending });
      s.finished = ending;
      if (out.home.brought.length) world.bankItems(out.home.brought, { found: false });
      if (out.home.found.length) world.bankItems(out.home.found, { found: true });
      return out;
    },

    /**
     * The primary objective's sites, marked from departure: the plan is a
     * chart (owner decision 5, chunk 8). Only Scout, Retrieve and Commune have
     * sites; Apex and Cull targets are hunted and never marked. Bonus
     * objectives are never marked (their generator `route` can point at a
     * hidden ambusher).
     */
    _objectiveSites() {
      const p = s.map.objectives.primary;
      if (p.id === 'scout') return p.sites.map(tile => ({ objective: 'scout', tile, done: !!s.fog[tile] }));
      if (p.id === 'retrieve') return [{ objective: 'retrieve', tile: p.site, done: !!s.retrieved }];
      if (p.id === 'commune') return [{ objective: 'commune', tile: p.site, done: !!s.communed }];
      return [];
    },

    /** Standing on the Retrieve site takes the item; on the shrine, communes. */
    _arrive() {
      const p = s.map.objectives.primary;
      if (p.id === 'retrieve' && s.pos === p.site && !s.retrieved) { s.retrieved = true; this._log({ kind: 'retrieved', tile: s.pos, time: s.time }); }
      // Commune completes when the shrine's event is resolved (chunk 11b),
      // not on arrival: see resolveEvent.
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
        // The apex is identified by rule, not by Perception (occupantBand), so it never counts.
        if (band === 'identified' && !occ.apex && !s.unmasked.includes(occ.id) && occupantConcealment(s.map, occ) > 100) s.unmasked.push(occ.id);
      }
      return range;
    },

    // ── Events (chunk 11a; EVENTS, data/events.js, EventEffects.js) ──────────

    /** The event site on a tile: an event occupant, or a shrine set piece. */
    _eventSiteAt(tile) {
      const occ = s.map.occupants.find(o => o.kind === 'event' && o.tile === tile);
      if (occ) return { occId: occ.id, tile, templateId: occ.eventId };
      const f = s.map.features.find(x => x.kind === 'shrine' && x.tile === tile && x.eventId && !x.resolved);
      return f ? { tile, templateId: f.eventId, feature: 'shrine' } : null;
    },

    /** The roles a template's text and numbers are filled from, here and now. */
    _eventRoles(tile) {
      const zone = getZone(s.zoneId);
      const houseId = s.boon?.house || null;
      const cap = (w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : null);
      const holder = houseId ? (world.houseHolder?.(houseId) ?? null) : null;
      const rivalId = holder && holder !== world.ownTribe?.() ? holder : null;
      const here = parseTileId(tile);
      let beast = null, best = Infinity;
      for (const o of s.map.occupants) {
        if (o.kind !== 'beast') continue;
        const p = parseTileId(o.tile);
        if (p.section !== here.section) continue;
        const d = distance(here, p);
        if (d <= 3 && d < best) { best = d; beast = zone?.natives?.[o.family]?.name || o.family; }
      }
      return {
        roles: {
          danger: zone?.danger || 1,
          region: zone?.name || s.zoneId,
          house: cap(houseId),
          prophet: cap(zone?.divineAlignment || null),
          followed: !!s.boon?.followed,
          ground: GROUNDS[s.map.tiles[tile]?.ground]?.name || s.map.tiles[tile]?.ground || null,
          rival: rivalId ? (world.tribeName?.(rivalId) || cap(rivalId)) : null,
          beast,
          falsegod: FALSE_GODS[zone?.falseGod]?.name || null,
        },
        houseId, rivalId, godId: FALSE_GODS[zone?.falseGod] ? zone.falseGod : null,
      };
    },

    /**
     * The party has arrived on `tile`: open its event site, if it has one and
     * its moment is right (decision 2). A site whose moment is not right stays
     * quiet and unspent. Returns the event view, { quiet: reason }, or null.
     */
    /**
     * A site under the party opens once nothing else is pending (chunk 13c).
     * An event opens on arrival by a move, unless a fight came first; before
     * this, a party that won a fight on a site (a pack reaching it on the
     * shrine, which predators made common) stood on it and nothing opened
     * until it stepped off and back. Called after a win with no spoils, and
     * after the spoils are harvested or walked away from. Null otherwise, and
     * for a quiet site.
     */
    _openEventHere() {
      if (s.finished || s.encounter || s.spoils || s.event) return null;
      const ev = this._openEventAt(s.pos);
      return ev?.quiet ? null : ev;
    },

    _openEventAt(tile) {
      const site = this._eventSiteAt(tile);
      if (!site) return null;
      const tpl = EVENT_TEMPLATES[site.templateId];
      if (!tpl) return null;
      const { roles, houseId, rivalId, godId } = this._eventRoles(tile);
      const quiet = dynamicBlock(tpl, {
        isNight: this.clock().isNight, hunger: this.hunger(), roles, pact: !!s.boon?.pact,
        hasQuestFlag: (f) => !!world.hasQuestFlag?.(f),
        nearby: (mark) => this._nearbyMark(mark),
      });
      if (quiet) {
        this._log({ kind: 'event_quiet', event: site.templateId, tile, time: s.time });
        return { quiet };
      }
      s.event = { templateId: site.templateId, site: { occId: site.occId || null, tile, feature: site.feature || null }, roles, houseId, rivalId, godId };
      this._log({ kind: 'event_open', event: site.templateId, tile, time: s.time });
      return this.event();
    },

    /** The stat a check reads, and its modifier: the best living hunter's, or a party stat. */
    _checkStat(stat) {
      if (CORE_STATS.includes(stat)) {
        const living = world.party().filter(c => c && c.status !== 'dead' && c.status !== 'incapacitated');
        let who = null, value = 10;
        for (const c of living) { const v = c.totalStats?.[stat] ?? c.stats?.[stat] ?? 10; if (!who || v > value) { who = c; value = v; } }
        return { stat, value, modifier: statModifier(value), who: who?.name || null };
      }
      const value = this.stats()[stat] ?? 50;
      return { stat, value, modifier: ratingModifier(value), who: 'the party' };
    },

    /** Supplies an outcome would take, so an Offer can say whether it can be paid. */
    _supplyCost(list, roles) {
      return (list || []).reduce((t, e) => (e.supplies != null ? t - Math.min(0, evalNumber(e.supplies, roles)) : t), 0);
    },

    _packCount(id) {
      return countInList(s.pack.found, id) + countInList(s.pack.brought, id);
    },

    /** What the event panel shows for the open event (null when none is open). */
    event() {
      const ev = s.event;
      if (!ev) return null;
      const tpl = EVENT_TEMPLATES[ev.templateId];
      const r = ev.roles;
      const out = { templateId: ev.templateId, name: fillText(tpl.name, r), shape: tpl.shape, text: fillText(tpl.text, r), tile: ev.site.tile };
      if (tpl.shape === 'choice') out.options = tpl.options.map((o, i) => ({ index: i, label: fillText(o.label, r) }));
      if (tpl.shape === 'check') out.check = { ...this._checkStat(tpl.check.stat), dc: Math.round(evalNumber(tpl.check.dc, r)) };
      if (tpl.shape === 'puzzle') { out.prompt = fillText(tpl.prompt, r); out.answers = tpl.answers.map(a => fillText(a, r)); }
      if (tpl.shape === 'offer') {
        const need = this._supplyCost(tpl.price, r);
        out.offer = { label: fillText(tpl.offer, r), supplyCost: need, canAccept: s.supplies >= need };
        if ((tpl.reward || []).some(e => e.falseGod?.pact)) {
          const god = FALSE_GODS[getZone(s.zoneId)?.falseGod];
          const next = s.boon?.pact ? Math.min(PACT_MAX, s.boon.pact.level + 1) : PACT_START;
          out.offer.pact = { god: god?.name, level: next, bondCost: PACT_PRICE.bondPerLevel * next, house: r.house,
            gift: god?.levels[next]?.text || null, curse: god?.curse.text, endsProphet: !s.boon?.pact };
        }
      }
      if (tpl.shape === 'trade') {
        const give = tpl.give.map(g => ({ id: g.id, name: Items[g.id]?.name || g.id, qty: g.qty, have: this._packCount(g.id) }));
        out.trade = { give, canAccept: give.every(g => g.have >= g.qty) };
      }
      return out;
    },

    /** What the outcome verbs are handed (EventEffects.VERBS). */
    _eventApi(ev) {
      const hunt = this;
      return {
        s, world, rng, roles: ev.roles, houseId: ev.houseId, rivalId: ev.rivalId, godId: ev.godId || null, SATED_TIME,
        pactStep: () => hunt._pactStep(),
        setVigil: () => hunt._setVigil(ev.houseId),
        party: () => world.party(),
        noteSupplies: () => hunt._noteSupplies(),
        earnFavor: (n, src) => hunt._earnFavor(n, src),
        spendTime: (n) => hunt._spendTime(n),
        addItem(id, qty) {
          if (Items[id]?.stackable) addToList(s.pack.found, makeStack(id, qty));
          else for (let i = 0; i < qty; i++) { const inst = createItemInstance(id); if (inst) addToList(s.pack.found, inst); }
        },
        revealAround(radius) {
          const here = parseTileId(s.pos);
          let n = 0;
          for (const [id, t] of Object.entries(s.map.tiles)) {
            const p = parseTileId(id);
            if (p.section !== here.section || s.fog[id] || distance(here, p) > radius) continue;
            s.fog[id] = 'remembered';
            s.seenGround[id] = t.ground;
            n++;
          }
          return n;
        },
        startFight(weaken) {
          const here = parseTileId(s.pos);
          const near = s.map.occupants.filter(o => HOSTILE.has(o.kind)).map(o => ({ o, p: parseTileId(o.tile) }))
            .filter(x => x.p.section === here.section && distance(here, x.p) <= 2)
            .sort((a, b) => distance(here, a.p) - distance(here, b.p) || (a.o.id < b.o.id ? -1 : 1));
          const occ = near[0]?.o;
          if (!occ) return null;
          if (weaken > 0) occ.weakened = Math.max(occ.weakened || 0, Math.min(90, weaken));
          hunt._ensureLoadout(occ);
          s.encounter = makeEncounter(occ, {
            cause: 'event', knew: 'identified', ambush: false, partyInitiative: hunt.stats().partyInitiative, at: s.time, tile: occ.tile,
          });
          return occ;
        },
        cleanseNear(n) {
          const here = parseTileId(s.pos);
          const blighted = Object.entries(s.map.tiles).filter(([, t]) => t.ground === 'blight')
            .map(([id]) => ({ id, p: parseTileId(id) })).filter(x => x.p.section === here.section)
            .sort((a, b) => distance(here, a.p) - distance(here, b.p) || (a.id < b.id ? -1 : 1)).slice(0, n);
          for (const { id } of blighted) {
            const t = s.map.tiles[id];
            t.ground = t.blightedFrom || s.landGround;
            delete t.blightedFrom;
            s.cleansed.push(id);
          }
          return blighted.length;
        },
        spreadNear(n) {
          const here = parseTileId(s.pos);
          const clean = Object.entries(s.map.tiles).filter(([id, t]) => t.ground !== 'blight' && isPassable(t) && !t.exit && id !== s.pos)
            .map(([id]) => ({ id, p: parseTileId(id) })).filter(x => x.p.section === here.section)
            .sort((a, b) => distance(here, a.p) - distance(here, b.p) || (a.id < b.id ? -1 : 1)).slice(0, n);
          for (const { id } of clean) {
            const t = s.map.tiles[id];
            t.blightedFrom = t.ground;
            t.ground = 'blight';
          }
          return clean.length;
        },
      };
    },

    /** A weakened occupant's fight: each member's HP cut by its `weakened` percent. */
    _weakened(occ, scenario) {
      const w = occ?.weakened || 0;
      if (!(w > 0)) return scenario;
      for (const e of scenario.enemies || []) e.hpMult = (e.hpMult ?? 1) * (1 - w / 100);
      return scenario;
    },

    /**
     * Resolve the open event (decision 3). `pick` by shape:
     *   choice { option }, check { roll? } (the dice token's face, or the hunt
     *   rolls), puzzle { answer }, offer { accept }, trade { accept }.
     * The outcome's effects are applied in order; the site is spent. Returns
     * { ok, branch, lines, roll?, encounter }.
     */
    resolveEvent(pick = {}) {
      if (s.finished) return { ok: false, reason: 'the hunt is over' };
      const ev = s.event;
      if (!ev) return { ok: false, reason: 'no event is open' };
      const tpl = EVENT_TEMPLATES[ev.templateId];
      const r = ev.roles;
      let effects, branch, roll = null;
      if (tpl.shape === 'choice') {
        const o = tpl.options[pick.option];
        if (!o) return { ok: false, reason: 'no such option' };
        effects = o.effects; branch = `option:${pick.option}`;
      } else if (tpl.shape === 'check') {
        const c = this._checkStat(tpl.check.stat);
        roll = rollD20(rng, pick.roll);
        const dc = Math.round(evalNumber(tpl.check.dc, r));
        const ok = roll + c.modifier >= dc;
        effects = ok ? tpl.success : tpl.failure; branch = ok ? 'success' : 'failure';
        roll = { die: roll, modifier: c.modifier, total: roll + c.modifier, dc, who: c.who };
      } else if (tpl.shape === 'puzzle') {
        if (!Number.isInteger(pick.answer) || !tpl.answers[pick.answer]) return { ok: false, reason: 'no such answer' };
        const ok = pick.answer === tpl.correct;
        effects = ok ? tpl.success : tpl.failure; branch = ok ? 'success' : 'failure';
      } else if (tpl.shape === 'offer') {
        if (pick.accept) {
          if (s.supplies < this._supplyCost(tpl.price, r)) return { ok: false, reason: 'you cannot pay the price' };
          effects = [...(tpl.price || []), ...(tpl.reward || [])]; branch = 'accept';
        } else { effects = tpl.refuse || []; branch = 'refuse'; }
      } else if (tpl.shape === 'trade') {
        if (pick.accept) {
          if (!tpl.give.every(g => this._packCount(g.id) >= g.qty)) return { ok: false, reason: 'you do not carry what they ask' };
          for (const g of tpl.give) {
            let need = g.qty;
            for (const list of [s.pack.found, s.pack.brought]) {
              const take = Math.min(need, countInList(list, g.id));
              if (take > 0) { takeFromList(list, g.id, take); need -= take; }
            }
          }
          effects = tpl.receive || []; branch = 'accept';
        } else { effects = tpl.refuse || []; branch = 'refuse'; }
      } else {
        return { ok: false, reason: `unknown shape '${tpl.shape}'` };
      }
      // The site is spent before its effects run, so a fight it starts or a
      // world tick it causes sees the map as it now is.
      s.event = null;
      if (ev.site.occId) {
        const i = s.map.occupants.findIndex(o => o.id === ev.site.occId);
        if (i >= 0) s.map.occupants.splice(i, 1);
      } else if (ev.site.feature === 'shrine') {
        const f = s.map.features.find(x => x.kind === 'shrine' && x.tile === ev.site.tile);
        if (f) f.resolved = true;
        // The region's shrine, resolved (any branch): Commune is done, and the
        // prophet notices (chunk 11b; the favor was paid on arrival before).
        if (!s.communed) {
          s.communed = true;
          this._log({ kind: 'communed', tile: ev.site.tile, time: s.time });
          this._earnFavor(Boons.SHRINE_FAVOR, 'shrine');
        }
      }
      const lines = applyEffects(effects, this._eventApi(ev));
      this._reveal();
      this._log({ kind: 'event', event: ev.templateId, branch, time: s.time });
      return { ok: true, branch, lines, roll, encounter: this.encounter() };
    },

    /** Walk away from the open event (decision 3): nothing is lost, the site stays. */
    leaveEvent() {
      if (!s.event) return { ok: false, reason: 'no event is open' };
      const id = s.event.templateId;
      s.event = null;
      this._log({ kind: 'event_left', event: id, time: s.time });
      return { ok: true };
    },

    /**
     * Favor earned with the region's house (chunk 10b): booked on the hunt's
     * boon (faster in your followed house's lands), raising its level, and
     * written to the save's standing through the world as it happens
     * (decision 9): the Bond and your tribe's devotion. Returns what was booked.
     */
    _earnFavor(raw, source) {
      const b = s.boon;
      if (!b?.house || !(raw > 0)) return 0;
      if (b.pact) return 0;   // a pact ends the prophet's track for this hunt (11c)
      const booked = Boons.gain(raw, b.followed);
      b.favor += booked;
      world.favor?.(b.house, booked);
      const level = Boons.levelFor(b.favor, b.followed);
      if (level > b.level) {
        b.level = level;
        this._log({ kind: 'boon', house: b.house, level, name: Boons.levelDef(b.house, level)?.name || null, source, time: s.time });
      }
      return booked;
    },

    /** The boon as the HUD shows it. */
    boon() {
      const b = s.boon || { house: null, followed: false, favor: 0, level: 0 };
      const pact = b.pact ? {
        god: b.pact.god, name: FALSE_GODS[b.pact.god].name, title: FALSE_GODS[b.pact.god].title, level: b.pact.level,
        names: Boons.pactEffects(b.pact.god, b.pact.level).names, curse: FALSE_GODS[b.pact.god].curse,
      } : null;
      return {
        house: b.house, followed: b.followed, favor: b.favor, level: b.level,
        written: Boons.hasBoons(b.house), title: Boons.houseTitle(b.house),
        toNext: Boons.toNext(b.favor, b.followed),
        names: Boons.boonEffects(b.house, b.level).names,
        pact,
        vigil: s.vigil || null, vigilCost: VIGIL_KILL_COST,
      };
    },

    /** The boon in force now: a false god's pact if one is on (11c), otherwise the prophet's. */
    _boonNow() {
      const b = s.boon;
      if (b?.pact) return Boons.pactEffects(b.pact.god, b.pact.level);
      return Boons.boonEffects(b?.house, b?.level || 0);
    },

    /**
     * A false god's pact takes a step (chunk 11c; the `falseGod` verb with
     * { pact: true }): the first starts it at PACT_START and ends the prophet's
     * track; each later one raises it by one, to PACT_MAX. Each step pays its
     * price through the world: hidden standing with the god, and Bond standing
     * with the region's house, both scaled by the level reached. The curse is
     * part of pactEffects. Returns the line for the player.
     */
    _pactStep() {
      const god = getZone(s.zoneId)?.falseGod;
      const def = FALSE_GODS[god];
      if (!def) return null;
      const b = s.boon;
      if (b.pact && b.pact.god !== god) return null;
      if (b.pact && b.pact.level >= PACT_MAX) return `${def.name} has nothing more to give.`;
      b.pact = b.pact ? { god, level: b.pact.level + 1 } : { god, level: PACT_START };
      const level = b.pact.level;
      world.falseGod?.(god, PACT_PRICE.hiddenPerLevel * level);
      if (b.house) world.bond?.(b.house, -PACT_PRICE.bondPerLevel * level);
      this._log({ kind: 'pact', god, level, time: s.time });
      const L = def.levels[level];
      return `A pact with ${def.name}, level ${level}: ${L?.name || ''}. ${def.curse.name} grows.`;
    },

    /** What CombatScene applies for the boon (fightSpec.boon), or null at level 0. */
    _boonForFight() {
      const b = s.boon;
      if (b?.pact) {
        const fx = Boons.pactEffects(b.pact.god, b.pact.level);
        return { house: null, god: b.pact.god, name: FALSE_GODS[b.pact.god].name, level: b.pact.level,
          party: fx.party, enemies: fx.enemies, capstone: fx.capstone };
      }
      if (!b?.house || !(b.level > 0) || !Boons.hasBoons(b.house)) return null;
      const fx = Boons.boonEffects(b.house, b.level);
      return { house: b.house, level: b.level, party: fx.party, enemies: fx.enemies, capstone: fx.capstone };
    },

    _log(entry) {
      s.log.push(entry);
      if (s.log.length > LOG_LIMIT) s.log.shift();
    },
  };
}
