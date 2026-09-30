// ProgressionManager.js
// Tracks demo progression: completed scenarios, Hunt Tickets, Tribe Tickets,
// active quest flags, and the save-slot-wide tribe allegiance choice.
//
// Serialized INTO the save slot by GameState — every save slot has its own
// independent progression (tickets, tribe choice, etc.).
//
// The DEV BYPASS toggle is stored separately in localStorage so it never
// touches save data and persists between page reloads.

import { DEFAULT_TRIBE_REP, clampRepScore, TRIBE_IDS } from './TribeRelations.js';
import { newStanding, joinSeason, STANDING_VERSION } from './Standing.js';

// A standing record's seed (it orders the rivals' houses each season). Taken
// from the clock, NOT Math.random: the harness seeds Math.random for its
// goldens, and a draw here on reset or load would shift every one of them.
let _seedCounter = 0;
const freshStandingSeed = () => ((Date.now() >>> 0) ^ Math.imul(++_seedCounter, 0x9E3779B1)) >>> 0;

const DEFAULT_TRIBE_HUNT_POINTS = Object.fromEntries(TRIBE_IDS.map(id => [id, 0]));

// Per-tribe intel level (0..TRIBE_INTEL_MAX). See getTribeIntel below —
// separate track from rep, nothing raises it yet.
const TRIBE_INTEL_MAX = 4;
const DEFAULT_TRIBE_INTEL = Object.fromEntries(TRIBE_IDS.map(id => [id, 0]));

// ---------------------------------------------------------------------------
// Config: which scenario must be completed before the next one opens up.
// null  →  always available (no prerequisite)
// ---------------------------------------------------------------------------
const UNLOCK_REQUIRES = {
  'training_encounter_1': null,
  'training_encounter_2': 'training_encounter_1',
  'training_encounter_3': 'training_encounter_2',
  'training_encounter_4': 'training_encounter_3',
  'training_encounter_5': 'training_encounter_4',
  'training_encounter_6': 'training_encounter_5',
  // Gorrek's Reckoning I-V rematch tiers — chained sequentially behind each
  // other and the base fight, same isScenarioUnlocked()/dev-bypass path
  // every other scenario already uses. Deliberately NOT added to
  // SCENARIO_ORDER below — that array only drives refreshCombatPitFlag's
  // main-story "!" marker chain, which these are unrelated to.
  // Every Reckoning tier hangs off its BASE fight, not off the tier below it.
  // Beating the base fight opens all of them at once and the player may jump
  // straight to the hardest — these are optional rematches, and chaining them
  // turned an opt-in challenge into a grind. Ticket rewards are likewise
  // per-tier and independent (see TICKET_REWARDS), so skipping ahead does not
  // forfeit anything.
  'training_encounter_6_reckoning_1': 'training_encounter_6',
  'training_encounter_6_reckoning_2': 'training_encounter_6',
  'training_encounter_6_reckoning_3': 'training_encounter_6',
  'training_encounter_6_reckoning_4': 'training_encounter_6',
  'training_encounter_6_reckoning_5': 'training_encounter_6',
  'training_encounter_2_reckoning_1': 'training_encounter_2',
  'training_encounter_2_reckoning_2': 'training_encounter_2',
  'training_encounter_2_reckoning_3': 'training_encounter_2',
  'training_encounter_3_reckoning_1': 'training_encounter_3',
  'training_encounter_3_reckoning_2': 'training_encounter_3',
  'training_encounter_3_reckoning_3': 'training_encounter_3',
  'training_encounter_4_reckoning_1': 'training_encounter_4',
  'training_encounter_4_reckoning_2': 'training_encounter_4',
  'training_encounter_4_reckoning_3': 'training_encounter_4',
  'training_encounter_5_reckoning_1': 'training_encounter_5',
  'training_encounter_5_reckoning_2': 'training_encounter_5',
  'training_encounter_5_reckoning_3': 'training_encounter_5',
};

// Quest flags that must ALL be cleared before the next scenario unlocks.
// Scenarios not listed here have no flag gate (e.g. S1 is always available).
const SCENARIO_GATE_FLAGS = {
  // Must choose tribe before S2
  'training_encounter_2': ['tribe_choice'],
  // Must visit elder (bonepile talk) AND get Elseth briefing before S3
  'training_encounter_3': ['elder_bonepile', 'elseth_leader_brief'],
  // Must visit elder (leveling talk), complete Elseth hand-in, AND get Styx briefing before S4
  'training_encounter_4': ['elder_leveling', 'elseth_leader_challenge', 'elseth_leader_handin', 'styx_leader_brief'],
  // Must meet Samuel, complete waystone chain, complete Styx hand-in, AND get Le'sse briefing before S5
  'training_encounter_5': ['samuel_mourne', 'waystone_visit', 'samuel_waystone_return', 'styx_leader_challenge', 'styx_leader_handin', 'lesse_leader_brief'],
  // Must complete Le'sse hand-in AND get Zafaar briefing before S6
  'training_encounter_6': ['lesse_leader_challenge', 'lesse_leader_handin', 'zafaar_leader_brief'],
};

// Ordered list used by refreshCombatPitFlag
const SCENARIO_ORDER = [
  'training_encounter_1',
  'training_encounter_2',
  'training_encounter_3',
  'training_encounter_4',
  'training_encounter_5',
  'training_encounter_6',
];

// Hunt Tickets awarded on FIRST completion of each scenario.
/**
 * Reckoning Tickets — earned ONLY from Reckoning tiers, spent only at the bone
 * pile's Marked buttons.
 *
 * Unlike Hunt Tickets these are **repeatable**: they are awarded on every
 * clear, not just the first. Reckoning tiers are the endgame grind and are
 * meant to be re-run, so a first-clear-only reward would cap tier-2 gear at a
 * fixed lifetime budget of 17 rolls and then leave the tiers with no payout
 * at all.
 *
 * Scaled by BOTH the encounter and the tier, not the tier alone: an
 * encounter-2 Reckoning and a Gorek Reckoning are not the same fight, and
 * paying them identically for tier 1 made the easy one strictly the better
 * farm. Encounter 2 is deliberately stingy.
 *
 * Encounters III, IV and V share one ramp (6/9/12) on purpose: playtesting
 * could not separate them on difficulty, so inventing a difference would be
 * guessing. Split them once there is evidence to split them on.
 *
 * Judge these PER FIGHT, not per full clear: Gorek's 25-mark total looks
 * like an outlier against encounter 5's 11 only because he has five tiers
 * to their three. Per fight it is 5.0 against 3.7, which is the gap the
 * final boss should have.
 */
const MARK_REWARDS = {
  'training_encounter_2_reckoning_1': 2,
  'training_encounter_2_reckoning_2': 2,
  'training_encounter_2_reckoning_3': 4,
  'training_encounter_3_reckoning_1': 6,
  'training_encounter_3_reckoning_2': 9,
  'training_encounter_3_reckoning_3': 12,
  'training_encounter_4_reckoning_1': 6,
  'training_encounter_4_reckoning_2': 9,
  'training_encounter_4_reckoning_3': 12,
  'training_encounter_5_reckoning_1': 6,
  'training_encounter_5_reckoning_2': 9,
  'training_encounter_5_reckoning_3': 12,
  'training_encounter_6_reckoning_1': 8,
  'training_encounter_6_reckoning_2': 10,
  'training_encounter_6_reckoning_3': 12,
  'training_encounter_6_reckoning_4': 14,
  'training_encounter_6_reckoning_5': 18,
};

// Hunt Tickets come from the BASE encounters only. Reckoning tiers
// deliberately pay nothing here — they pay Reckoning Tickets instead (see
// MARK_REWARDS), which is what makes the two currencies mean different
// things: Tickets are the one-off reward for progressing, Marks are the
// repeatable reward for grinding.
const TICKET_REWARDS = {
  'training_encounter_1': 12,
  'training_encounter_2': 12,
  'training_encounter_3': 12,
  'training_encounter_4': 18,
  'training_encounter_5': 24,
  'training_encounter_6': 30,
  // Reckoning I-V — increasing per tier, per request.
  // Encounter 2's Reckoning tiers — the timed DPS race.
  // Encounter 3's Reckoning tiers — pure toughness, no clock.
  // Encounters 4 and 5 — both gain a mechanic on top of the stat scaling
  // (an extra beast / summoned adds), so they pay a little more per tier.
};

// Quest flags auto-set on first clear of each scenario.
// Values can be a string (single flag) or an array (multiple flags).
const SCENARIO_FLAGS = {
  // S1 → tribe choice prompt
  'training_encounter_1': 'tribe_choice',
  // S2 → elder bonepile talk + Elseth leader brief (animated dummies are S3)
  'training_encounter_2': ['elder_bonepile', 'elseth_leader_brief'],
  // S3 (animated dummies) → elder leveling + Elseth hand-in + Styx leader brief
  'training_encounter_3': ['elder_leveling', 'elseth_leader_challenge', 'styx_leader_brief'],
  // S4 → Samuel Mourne + Styx hand-in + Le'sse leader brief
  'training_encounter_4': ['samuel_mourne', 'styx_leader_challenge', 'lesse_leader_brief'],
  // S5 → Le'sse hand-in + Zafaar leader brief
  'training_encounter_5': ['lesse_leader_challenge', 'zafaar_leader_brief'],
  // S6 → Zafaar hand-in (end of demo — no next scenario to gate)
  'training_encounter_6': 'zafaar_leader_challenge',
};

// Feature gates: a feature opens by its Combat Pit trial OR, with
// `orFirstHunt`, by the first hunt (owner 2026-09-29: a run led by hunts
// after Trial 1 must not wait on the pit for these).
const FEATURE_UNLOCKS = {
  bonepile: { scenario: 'training_encounter_2', orFirstHunt: true },
};

// Samuel Mourne's introduction and the waystone chain it starts. Any of these
// on the save means the player has already been sent to him (waystone_attuned
// and waystone_shard_collected are never cleared, so a finished chain still
// counts). Samuel comes after Trial 4 or the first hunt, whichever is first.
const SAMUEL_CHAIN_FLAGS = ['samuel_mourne', 'waystone_visit', 'waystone_attuned', 'samuel_waystone_return', 'waystone_shard_collected'];

// localStorage key for the dev bypass — outside any save slot.
const DEV_BYPASS_KEY = 'dev_progressionBypass';

// Deep-clone the partyGear nested structure for serialize/deserialize.
// Kept here (not in PartyGearManager) to avoid a circular import.
function _deepClonePartyGear(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [tribeId, parties] of Object.entries(raw)) {
    out[tribeId] = {};
    for (const [partyId, data] of Object.entries(parties)) {
      out[tribeId][partyId] = {
        equipment: (data.equipment && typeof data.equipment === 'object') ? { ...data.equipment } : {},
        stash:     Array.isArray(data.stash) ? [...data.stash] : [],
      };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// ProgressionManager
// ---------------------------------------------------------------------------
const ProgressionManager = {

  // ----- Runtime state (saved per slot via serialize/deserialize) -----------
  completedScenarios: [],   // e.g. ['training_encounter_1', 'training_encounter_2']
  huntTickets:  0,
  // Reckoning-tier currency. See MARK_REWARDS above.
  reckoningMarks: 0,
  tribeTickets: 0,
  // The cults' black-market currency (chunk 14c+, owner 2026-09-27).
  sinTickets: 0,
  // The prophets' currency (owner 2026-09-30, notes D3): prophet shrines pay
  // it now, prophet quests later. Nothing spends it yet (parked).
  divinityTickets: 0,
  huntPoints:   0,          // player-wide score from the Hunt loop — tracked via the Waystone
  tribeVendorStock: {},     // itemId → remaining stock (default 3 each)
  // The camp plan vendor's stock: { day, slots: [{ rarity, itemLevel, cost, sold }] }.
  // Rolled once per in-game day (HuntPlans.currentPlanStock), so re-opening the
  // vendor or reloading cannot re-roll it. null = not rolled yet.
  planVendorStock: null,

  // Quest flags: IDs of events that are currently "pending" (show a ! marker).
  // e.g. ['tribe_choice'] means the Elder's Tower has something for the player.
  questFlags: [],

  // Permanently completed quest step IDs.
  // Most current steps derive completion from existing data (completedScenarios,
  // tribe, flags), but this array is the scalable hook for future quests whose
  // completion can't be inferred without explicit bookkeeping.
  completedQuestSteps: [],

  // The Omen meter per region (chunk 14b-3; src/systems/Omens.js): { zoneId: n }.
  omens: {},

  // Tribe allegiance — SAVE-SLOT WIDE.
  // One tribe per save file; all characters in that slot belong to the same tribe.
  // Valid values: 'styx' | 'zafaar' | 'elseth' | 'lesse' | null (not yet chosen)
  tribe: null,

  // Tribe reputation scores — one number per tribe.
  // Derives to a level via TribeRelations.getRepIndex(score).
  tribeRep: { ...DEFAULT_TRIBE_REP },

  // Per-tribe intel level (0..TRIBE_INTEL_MAX) — see getTribeIntel.
  tribeIntel: { ...DEFAULT_TRIBE_INTEL },

  // Total in-world time elapsed across every hunt on this save. Advanced by
  // HuntManager on each day/night flip and never reset by a hunt ending, so
  // it accumulates for the life of the save. Groundwork for a future
  // hunt-season limit ("a season lasts N nights"); nothing consumes it yet.
  nightsElapsed: 0,
  daysElapsed: 0,

  // Tribe-wide Hunt Point grand totals — one number per tribe, all four
  // tracked regardless of player allegiance so a future cross-tribe
  // leaderboard needs no data migration.
  tribeHuntPoints: { ...DEFAULT_TRIBE_HUNT_POINTS },

  // Per-tribe NPC hunting party progress: tribeId → { partyId: points }.
  // Roster (name/tier) lives in data/tribeHuntingParties.js — only the
  // mutable point totals are persisted here.
  tribeHuntingParties: { styx: {}, zafaar: {}, elseth: {}, lesse: {} },

  // Per-party gear + stash: tribeId → { partyId → { equipment: {slot: ItemInstance}, stash: ItemInstance[] } }
  // Managed entirely via PartyGearManager helpers.
  partyGear: {},

  // Standing, save-wide (Exploration System v2, chunk 10a): the Bond, legacy,
  // the season's devotion table and who holds each house. One plain record;
  // its rules are in Standing.js. Created fresh on reset(), and by the v8
  // save migration for older saves.
  standing: null,

  /** The standing record, created on first use (a boot that neither reset nor loaded). */
  getStanding() {
    if (!this.standing) {
      this.standing = newStanding(freshStandingSeed(), this.daysElapsed || 0);
      joinSeason(this.standing, this.tribe);
    }
    return this.standing;
  },

  // ----- Dev bypass --------------------------------------------------------

  isBypassEnabled() {
    return localStorage.getItem(DEV_BYPASS_KEY) === 'true';
  },

  toggleBypass() {
    const next = !this.isBypassEnabled();
    localStorage.setItem(DEV_BYPASS_KEY, next ? 'true' : 'false');
    return next;
  },

  // ----- Quest flags -------------------------------------------------------

  hasQuestFlag(id) {
    return this.questFlags.includes(id);
  },

  setQuestFlag(id) {
    if (!this.questFlags.includes(id)) this.questFlags.push(id);
  },

  clearQuestFlag(id) {
    this.questFlags = this.questFlags.filter(f => f !== id);
  },

  // ----- Quest step completion (explicit, persisted) -----------------------

  markStepDone(id) {
    if (!this.completedQuestSteps.includes(id)) this.completedQuestSteps.push(id);
  },

  isStepDone(id) {
    return this.completedQuestSteps.includes(id);
  },

  // ----- Tribe vendor stock ------------------------------------------------

  getTribeVendorStock(itemId) {
    return (itemId in this.tribeVendorStock) ? this.tribeVendorStock[itemId] : 3;
  },
  decrementTribeVendorStock(itemId) {
    this.tribeVendorStock[itemId] = Math.max(0, this.getTribeVendorStock(itemId) - 1);
  },

  // ----- Hunt Points (player-wide, earned during Hunts) --------------------

  addHuntPoints(amount) {
    this.huntPoints = Math.max(0, this.huntPoints + amount);
    return this.huntPoints;
  },

  // ----- Elapsed world time --------------------------------------------

  getNightsElapsed() { return this.nightsElapsed || 0; },
  getDaysElapsed() { return this.daysElapsed || 0; },

  /** Called by HuntManager when the world flips into night. */
  advanceNight() {
    this.nightsElapsed = (this.nightsElapsed || 0) + 1;
    return this.nightsElapsed;
  },

  /** Called by HuntManager when the world flips into a new day. */
  advanceDay() {
    this.daysElapsed = (this.daysElapsed || 0) + 1;
    return this.daysElapsed;
  },

  /**
   * Human-readable elapsed time, for UI that wants to show a "date".
   * Day 1 is the day a Hunter arrives, so the count is 1-based.
   */
  getWorldDate() {
    const nights = this.getNightsElapsed();
    const days = this.getDaysElapsed();
    return {
      nights,
      days,
      dayNumber: days + 1,
      label: `Day ${days + 1}`,
      detail: nights === 1 ? '1 night on the island' : `${nights} nights on the island`,
    };
  },

  // ----- Tribe-wide Hunt Points (all four tribes, player + NPC parties) ----

  getTribeHuntPoints(tribeId) {
    return this.tribeHuntPoints?.[tribeId] ?? 0;
  },

  addTribeHuntPoints(tribeId, amount) {
    if (!tribeId) return;
    const current = this.getTribeHuntPoints(tribeId);
    this.tribeHuntPoints[tribeId] = Math.max(0, current + amount);
  },

  /**
   * A season ended (Standing.dayBreak, from GAME_WORLD.dayBreaks): the four
   * tribes' Hunt Point race starts over, NPC parties' tallies with it. The
   * player's own lifetime huntPoints score is untouched.
   */
  resetSeasonRace() {
    this.tribeHuntPoints = { ...DEFAULT_TRIBE_HUNT_POINTS };
    this.tribeHuntingParties = { styx: {}, zafaar: {}, elseth: {}, lesse: {} };
  },

  getPartyPoints(tribeId, partyId) {
    return this.tribeHuntingParties?.[tribeId]?.[partyId] ?? 0;
  },

  /** Adds points to one NPC hunting party AND folds the same amount into that tribe's grand total. */
  addPartyPoints(tribeId, partyId, amount) {
    if (!this.tribeHuntingParties[tribeId]) this.tribeHuntingParties[tribeId] = {};
    const current = this.getPartyPoints(tribeId, partyId);
    this.tribeHuntingParties[tribeId][partyId] = Math.max(0, current + amount);
    this.addTribeHuntPoints(tribeId, amount);
  },

  // ----- Tribe allegiance (save-slot wide) ---------------------------------

  getTribe() { return this.tribe; },

  // ----- Tribe reputation --------------------------------------------------

  getTribeRep(tribeId) {
    return this.tribeRep?.[tribeId] ?? DEFAULT_TRIBE_REP[tribeId] ?? 0;
  },

  addTribeRep(tribeId, amount) {
    const isOwn  = this.tribe === tribeId;
    const current = this.getTribeRep(tribeId);
    this.tribeRep[tribeId] = clampRepScore(current + amount, isOwn);
  },

  // ----- Tribe intel (0..INTEL_MAX) ---------------------------------------
  // Deliberately SEPARATE from rep: rep is how a tribe treats you, intel is
  // what you know about them (their parties, their stash, the sites they've
  // charted). Nothing raises this yet — the systems that will are teased in
  // data/tribeSystems.js. Stored and serialized now so the Tribe Relations
  // screen reads live state instead of a hardcoded zero, and so any future
  // intel source has somewhere real to write.

  getTribeIntel(tribeId) {
    return this.tribeIntel?.[tribeId] ?? 0;
  },

  addTribeIntel(tribeId, amount) {
    if (!tribeId) return;
    if (!this.tribeIntel) this.tribeIntel = { ...DEFAULT_TRIBE_INTEL };
    const next = this.getTribeIntel(tribeId) + amount;
    this.tribeIntel[tribeId] = Math.max(0, Math.min(TRIBE_INTEL_MAX, next));
  },

  /**
   * Pledges allegiance to a tribe for this entire save slot.
   * Can only be done once per slot — subsequent calls return false.
   * On success: sets tribe, grants 1 Tribe Ticket, clears the 'tribe_choice' flag.
   */
  setTribe(tribeId) {
    if (this.tribe) return false;   // already chosen — no take-backs
    this.tribe = tribeId;
    this.tribeTickets += 1;         // the Tribe Ticket mentioned in the demo doc
    joinSeason(this.getStanding(), tribeId);   // the season's devotion race, from legacy
    this.clearQuestFlag('tribe_choice');
    return true;
  },

  // ----- Feature unlock queries --------------------------------------------

  /** Returns true if the named feature (e.g. 'bonepile') has been unlocked. */
  isFeatureUnlocked(featureId) {
    if (this.isBypassEnabled()) return true;
    const req = FEATURE_UNLOCKS[featureId];
    if (!req) return false;
    return this.completedScenarios.includes(req.scenario) || (!!req.orFirstHunt && this.hasCompletedHunt());
  },

  /**
   * True once any hunt has ended in a clean exit with its main objective done:
   * the engine's `hunted:<zone>` flag (src/systems/HuntQuests.js), which is
   * never cleared.
   */
  hasCompletedHunt() {
    return this.questFlags.some(f => f.startsWith('hunted:'));
  },

  /** True once Samuel has been introduced, by either route. See SAMUEL_CHAIN_FLAGS. */
  hasSamuelBeenIntroduced() {
    return SAMUEL_CHAIN_FLAGS.some(f => this.hasQuestFlag(f));
  },

  /**
   * The hunt route to Samuel: after the first hunt, raise his marker if
   * neither route has yet. Returns true if it did (the caller saves).
   * Trial 4 raises the same flag through SCENARIO_FLAGS.
   */
  offerSamuelAfterHunt() {
    if (!this.hasCompletedHunt() || this.hasSamuelBeenIntroduced()) return false;
    this.setQuestFlag('samuel_mourne');
    return true;
  },

  // ----- The Elder's talk about Historic items (owner's playtest
  // 2026-09-29: it was written for the Bloodthirster alone, and fired, as
  // the Bloodthirster, for Burden of Dreams). It is about whichever Historic
  // item the party inspects first. A save from before keeps its
  // bloodthirster_elder_* flags, and they count the same.

  /** True once the Elder has explained Historic items. */
  historicExplained() {
    return this.hasQuestFlag('historic_elder_explained') || this.hasQuestFlag('bloodthirster_elder_explained');
  },

  /** True while the Elder's talk is waiting at the tower. */
  historicTalkPending() {
    return !this.historicExplained()
      && (this.hasQuestFlag('historic_elder_visit') || this.hasQuestFlag('bloodthirster_elder_visit'));
  },

  /** The item id the talk is about (the first one inspected), or null. */
  firstHistoricId() {
    const f = this.questFlags.find(q => q.startsWith('historic_first:'));
    if (f) return f.slice('historic_first:'.length);
    return this.hasQuestFlag('bloodthirster_elder_visit') || this.hasQuestFlag('bloodthirster_elder_explained') ? 'bloodthirster' : null;
  },

  /** The first inspect of a Historic item before the talk: send the party to the Elder. Returns true if it did. */
  requestHistoricTalk(itemId) {
    if (this.historicExplained() || this.historicTalkPending()) return false;
    this.setQuestFlag('historic_elder_visit');
    this.setQuestFlag(`historic_first:${itemId}`);
    return true;
  },

  /** The Elder gives the talk. */
  giveHistoricTalk() {
    this.clearQuestFlag('historic_elder_visit');
    this.clearQuestFlag('bloodthirster_elder_visit');
    this.setQuestFlag('historic_elder_explained');
  },

  /**
   * The hunt route to the Elder's Bone Pile talk (owner's playtest
   * 2026-09-29: it came only by Trial 2, though a hunt opens the Bone Pile
   * too). After the first hunt and before Trial 2, raise `elder_bonepile`
   * once; the tower sets `bonepile_explained` when he gives it, and Trial 2
   * then does not raise it again. Returns true if it raised it (the caller saves).
   */
  offerBonepileAfterHunt() {
    if (!this.hasCompletedHunt() || this.tribe === null) return false;
    if (this.completedScenarios.includes('training_encounter_2')) return false;
    if (this.hasQuestFlag('elder_bonepile') || this.hasQuestFlag('bonepile_explained')) return false;
    this.setQuestFlag('elder_bonepile');
    return true;
  },

  // ----- Scenario unlock queries -------------------------------------------

  isScenarioUnlocked(scenarioId) {
    if (this.isBypassEnabled()) return true;
    const req = UNLOCK_REQUIRES[scenarioId];
    if (req === null) return true;
    if (req === undefined) return false;
    if (!this.completedScenarios.includes(req)) return false;
    // All gate flags for this scenario must be cleared before it unlocks
    const gates = SCENARIO_GATE_FLAGS[scenarioId] || [];
    return gates.every(f => !this.hasQuestFlag(f));
  },

  /**
   * Sets the combat_pit quest flag when the next uncompleted scenario's
   * gate flags are all cleared. Called from TownScene._buildQuestFlags()
   * every time the flag UI rebuilds so the marker stays in sync.
   *
   * Only acts for scenarios that have defined gate flags — S1 (no gates)
   * is naturally always available and handled by the orientation flow.
   */
  refreshCombatPitFlag() {
    for (const id of SCENARIO_ORDER) {
      if (this.completedScenarios.includes(id)) continue; // already done

      const req = UNLOCK_REQUIRES[id];
      if (req && !this.completedScenarios.includes(req)) break; // prereq not done yet

      const gates = SCENARIO_GATE_FLAGS[id] || [];
      if (gates.length === 0) break; // no gate flags for this scenario — skip

      const allClear = gates.every(f => !this.hasQuestFlag(f));
      if (allClear && !this.hasQuestFlag('combat_pit')) {
        this.setQuestFlag('combat_pit');
      }
      break; // only ever check the first pending scenario
    }
  },

  isScenarioCompleted(scenarioId) {
    return this.completedScenarios.includes(scenarioId);
  },

  // ----- Called when the player wins a scenario ----------------------------

  /**
   * Records the completion, grants tickets on first clear, and auto-sets any
   * quest flags triggered by this scenario.
   *
   * Returns { firstCompletion, huntTicketsEarned, huntTicketsTotal }
   */
  /** Marks a scenario pays per clear. Exposed so the journal generator can
   *  print the reward table without duplicating the numbers. */
  getMarkReward(scenarioId) {
    return MARK_REWARDS[scenarioId] ?? 0;
  },

  onScenarioComplete(scenarioId) {
    const alreadyDone = this.completedScenarios.includes(scenarioId);

    if (!alreadyDone) {
      this.completedScenarios.push(scenarioId);

      // Auto-set any quest flag(s) tied to this scenario's first completion.
      // Samuel is skipped if a hunt already introduced him, or clearing Trial 4
      // would send the player to meet him a second time; the Bone Pile talk
      // likewise if a hunt already brought it (offerBonepileAfterHunt).
      const samuelMet = this.hasSamuelBeenIntroduced();
      const bonepileTold = this.hasQuestFlag('bonepile_explained');
      [].concat(SCENARIO_FLAGS[scenarioId] || [])
        .filter(f => !(f === 'samuel_mourne' && samuelMet))
        .filter(f => !(f === 'elder_bonepile' && bonepileTold))
        .forEach(f => this.setQuestFlag(f));
    }

    const ticketsEarned = alreadyDone ? 0 : (TICKET_REWARDS[scenarioId] ?? 0);
    this.huntTickets += ticketsEarned;

    // Deliberately NOT gated on `alreadyDone` — Marks are a repeatable payout
    // for re-running Reckoning tiers, which is the whole point of them.
    const marksEarned = MARK_REWARDS[scenarioId] ?? 0;
    this.reckoningMarks += marksEarned;

    return {
      firstCompletion: !alreadyDone,
      huntTicketsEarned: ticketsEarned,
      huntTicketsTotal: this.huntTickets,
      marksEarned,
      marksTotal: this.reckoningMarks,
    };
  },

  // ----- Serialization (called by GameState.save / GameState.load) ---------

  serialize() {
    return {
      completedScenarios:  [...this.completedScenarios],
      huntTickets:         this.huntTickets,
      reckoningMarks:      this.reckoningMarks,
      tribeTickets:        this.tribeTickets,
      sinTickets:          this.sinTickets,
      divinityTickets:     this.divinityTickets,
      huntPoints:          this.huntPoints,
      questFlags:          [...this.questFlags],
      tribe:               this.tribe,
      tribeVendorStock:    { ...this.tribeVendorStock },
      planVendorStock:     this.planVendorStock ? JSON.parse(JSON.stringify(this.planVendorStock)) : null,
      completedQuestSteps: [...this.completedQuestSteps],
      omens:               { ...this.omens },
      tribeRep:            { ...this.tribeRep },
      tribeIntel:          { ...this.tribeIntel },
      nightsElapsed:       this.nightsElapsed,
      daysElapsed:         this.daysElapsed,
      tribeHuntPoints:     { ...this.tribeHuntPoints },
      tribeHuntingParties: Object.fromEntries(
        Object.entries(this.tribeHuntingParties).map(([k, v]) => [k, { ...v }])
      ),
      partyGear: _deepClonePartyGear(this.partyGear),
      standing: this.standing ? JSON.parse(JSON.stringify(this.standing)) : null,
    };
  },

  deserialize(data) {
    if (!data) return;
    this.completedScenarios  = Array.isArray(data.completedScenarios)  ? [...data.completedScenarios]  : [];
    this.huntTickets         = typeof data.huntTickets  === 'number'    ? data.huntTickets              : 0;
    this.reckoningMarks      = typeof data.reckoningMarks === 'number'  ? data.reckoningMarks           : 0;
    this.tribeTickets        = typeof data.tribeTickets === 'number'    ? data.tribeTickets             : 0;
    this.sinTickets          = typeof data.sinTickets === 'number'      ? data.sinTickets               : 0;
    this.divinityTickets     = typeof data.divinityTickets === 'number' ? data.divinityTickets          : 0;
    this.huntPoints          = typeof data.huntPoints   === 'number'    ? data.huntPoints               : 0;
    this.questFlags          = Array.isArray(data.questFlags)           ? [...data.questFlags]          : [];
    this.tribe               = data.tribe || null;
    this.tribeVendorStock    = (data.tribeVendorStock && typeof data.tribeVendorStock === 'object')
      ? { ...data.tribeVendorStock } : {};
    // Optional: a save without it (every save before chunk 4) rolls a fresh stock.
    this.planVendorStock     = (data.planVendorStock && Array.isArray(data.planVendorStock.slots))
      ? JSON.parse(JSON.stringify(data.planVendorStock)) : null;
    this.completedQuestSteps = Array.isArray(data.completedQuestSteps) ? [...data.completedQuestSteps] : [];
    // Optional: every save before chunk 14b-3 starts every meter empty.
    this.omens               = (data.omens && typeof data.omens === 'object') ? { ...data.omens } : {};
    this.tribeRep            = (data.tribeRep && typeof data.tribeRep === 'object')
      ? { ...DEFAULT_TRIBE_REP, ...data.tribeRep } : { ...DEFAULT_TRIBE_REP };
    this.tribeIntel          = (data.tribeIntel && typeof data.tribeIntel === 'object')
      ? { ...DEFAULT_TRIBE_INTEL, ...data.tribeIntel } : { ...DEFAULT_TRIBE_INTEL };
    this.nightsElapsed       = Number.isFinite(data.nightsElapsed) ? data.nightsElapsed : 0;
    this.daysElapsed         = Number.isFinite(data.daysElapsed) ? data.daysElapsed : 0;
    this.tribeHuntPoints     = (data.tribeHuntPoints && typeof data.tribeHuntPoints === 'object')
      ? { ...DEFAULT_TRIBE_HUNT_POINTS, ...data.tribeHuntPoints } : { ...DEFAULT_TRIBE_HUNT_POINTS };
    this.tribeHuntingParties = { styx: {}, zafaar: {}, elseth: {}, lesse: {} };
    if (data.tribeHuntingParties && typeof data.tribeHuntingParties === 'object') {
      for (const tribeId of TRIBE_IDS) {
        if (data.tribeHuntingParties[tribeId]) this.tribeHuntingParties[tribeId] = { ...data.tribeHuntingParties[tribeId] };
      }
    }
    this.partyGear = _deepClonePartyGear(data.partyGear);
    // Every save from v8 carries it (the migration creates it for older ones).
    // A missing or unknown shape starts fresh rather than half-loading.
    this.standing = (data.standing && data.standing.v === STANDING_VERSION)
      ? JSON.parse(JSON.stringify(data.standing)) : newStanding(freshStandingSeed(), this.daysElapsed);
    joinSeason(this.standing, this.tribe);
  },

  reset() {
    this.completedScenarios  = [];
    this.huntTickets         = 0;
    this.reckoningMarks      = 0;
    this.tribeTickets        = 0;
    this.sinTickets          = 0;
    this.divinityTickets     = 0;
    this.huntPoints          = 0;
    this.questFlags          = [];
    this.tribe               = null;
    this.tribeVendorStock    = {};
    this.planVendorStock     = null;
    this.completedQuestSteps = [];
    this.omens               = {};
    this.tribeRep            = { ...DEFAULT_TRIBE_REP };
    this.tribeIntel          = { ...DEFAULT_TRIBE_INTEL };
    this.nightsElapsed       = 0;
    this.daysElapsed         = 0;
    this.tribeHuntPoints     = { ...DEFAULT_TRIBE_HUNT_POINTS };
    this.tribeHuntingParties = { styx: {}, zafaar: {}, elseth: {}, lesse: {} };
    this.partyGear           = {};
    this.standing            = newStanding(freshStandingSeed(), 0);
  },
};

export default ProgressionManager;
