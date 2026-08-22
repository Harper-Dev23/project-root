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

const DEFAULT_TRIBE_HUNT_POINTS = Object.fromEntries(TRIBE_IDS.map(id => [id, 0]));

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
  'training_encounter_6_reckoning_1': 'training_encounter_6',
  'training_encounter_6_reckoning_2': 'training_encounter_6_reckoning_1',
  'training_encounter_6_reckoning_3': 'training_encounter_6_reckoning_2',
  'training_encounter_6_reckoning_4': 'training_encounter_6_reckoning_3',
  'training_encounter_6_reckoning_5': 'training_encounter_6_reckoning_4',
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
const TICKET_REWARDS = {
  'training_encounter_1': 12,
  'training_encounter_2': 12,
  'training_encounter_3': 12,
  'training_encounter_4': 18,
  'training_encounter_5': 24,
  'training_encounter_6': 30,
  // Reckoning I-V — increasing per tier, per request.
  'training_encounter_6_reckoning_1': 35,
  'training_encounter_6_reckoning_2': 40,
  'training_encounter_6_reckoning_3': 50,
  'training_encounter_6_reckoning_4': 60,
  'training_encounter_6_reckoning_5': 75,
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

// Feature gates: which scenario must be completed to unlock a feature.
const FEATURE_UNLOCKS = {
  bonepile: 'training_encounter_2',
};

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
  tribeTickets: 0,
  huntPoints:   0,          // player-wide score from the Hunt loop — tracked via the Waystone
  tribeVendorStock: {},     // itemId → remaining stock (default 3 each)

  // Quest flags: IDs of events that are currently "pending" (show a ! marker).
  // e.g. ['tribe_choice'] means the Elder's Tower has something for the player.
  questFlags: [],

  // Permanently completed quest step IDs.
  // Most current steps derive completion from existing data (completedScenarios,
  // tribe, flags), but this array is the scalable hook for future quests whose
  // completion can't be inferred without explicit bookkeeping.
  completedQuestSteps: [],

  // Tribe allegiance — SAVE-SLOT WIDE.
  // One tribe per save file; all characters in that slot belong to the same tribe.
  // Valid values: 'styx' | 'zafaar' | 'elseth' | 'lesse' | null (not yet chosen)
  tribe: null,

  // Tribe reputation scores — one number per tribe.
  // Derives to a level via TribeRelations.getRepIndex(score).
  tribeRep: { ...DEFAULT_TRIBE_REP },

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

  // ----- Tribe-wide Hunt Points (all four tribes, player + NPC parties) ----

  getTribeHuntPoints(tribeId) {
    return this.tribeHuntPoints?.[tribeId] ?? 0;
  },

  addTribeHuntPoints(tribeId, amount) {
    if (!tribeId) return;
    const current = this.getTribeHuntPoints(tribeId);
    this.tribeHuntPoints[tribeId] = Math.max(0, current + amount);
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

  /**
   * Pledges allegiance to a tribe for this entire save slot.
   * Can only be done once per slot — subsequent calls return false.
   * On success: sets tribe, grants 1 Tribe Ticket, clears the 'tribe_choice' flag.
   */
  setTribe(tribeId) {
    if (this.tribe) return false;   // already chosen — no take-backs
    this.tribe = tribeId;
    this.tribeTickets += 1;         // the Tribe Ticket mentioned in the demo doc
    this.clearQuestFlag('tribe_choice');
    return true;
  },

  // ----- Feature unlock queries --------------------------------------------

  /** Returns true if the named feature (e.g. 'bonepile') has been unlocked. */
  isFeatureUnlocked(featureId) {
    if (this.isBypassEnabled()) return true;
    const req = FEATURE_UNLOCKS[featureId];
    if (!req) return false;
    return this.completedScenarios.includes(req);
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
  onScenarioComplete(scenarioId) {
    const alreadyDone = this.completedScenarios.includes(scenarioId);

    if (!alreadyDone) {
      this.completedScenarios.push(scenarioId);

      // Auto-set any quest flag(s) tied to this scenario's first completion.
      const flagDef = SCENARIO_FLAGS[scenarioId];
      if (Array.isArray(flagDef)) {
        flagDef.forEach(f => this.setQuestFlag(f));
      } else if (flagDef) {
        this.setQuestFlag(flagDef);
      }
    }

    const ticketsEarned = alreadyDone ? 0 : (TICKET_REWARDS[scenarioId] ?? 0);
    this.huntTickets += ticketsEarned;

    return {
      firstCompletion: !alreadyDone,
      huntTicketsEarned: ticketsEarned,
      huntTicketsTotal: this.huntTickets,
    };
  },

  // ----- Serialization (called by GameState.save / GameState.load) ---------

  serialize() {
    return {
      completedScenarios:  [...this.completedScenarios],
      huntTickets:         this.huntTickets,
      tribeTickets:        this.tribeTickets,
      huntPoints:          this.huntPoints,
      questFlags:          [...this.questFlags],
      tribe:               this.tribe,
      tribeVendorStock:    { ...this.tribeVendorStock },
      completedQuestSteps: [...this.completedQuestSteps],
      tribeRep:            { ...this.tribeRep },
      tribeHuntPoints:     { ...this.tribeHuntPoints },
      tribeHuntingParties: Object.fromEntries(
        Object.entries(this.tribeHuntingParties).map(([k, v]) => [k, { ...v }])
      ),
      partyGear: _deepClonePartyGear(this.partyGear),
    };
  },

  deserialize(data) {
    if (!data) return;
    this.completedScenarios  = Array.isArray(data.completedScenarios)  ? [...data.completedScenarios]  : [];
    this.huntTickets         = typeof data.huntTickets  === 'number'    ? data.huntTickets              : 0;
    this.tribeTickets        = typeof data.tribeTickets === 'number'    ? data.tribeTickets             : 0;
    this.huntPoints          = typeof data.huntPoints   === 'number'    ? data.huntPoints               : 0;
    this.questFlags          = Array.isArray(data.questFlags)           ? [...data.questFlags]          : [];
    this.tribe               = data.tribe || null;
    this.tribeVendorStock    = (data.tribeVendorStock && typeof data.tribeVendorStock === 'object')
      ? { ...data.tribeVendorStock } : {};
    this.completedQuestSteps = Array.isArray(data.completedQuestSteps) ? [...data.completedQuestSteps] : [];
    this.tribeRep            = (data.tribeRep && typeof data.tribeRep === 'object')
      ? { ...DEFAULT_TRIBE_REP, ...data.tribeRep } : { ...DEFAULT_TRIBE_REP };
    this.tribeHuntPoints     = (data.tribeHuntPoints && typeof data.tribeHuntPoints === 'object')
      ? { ...DEFAULT_TRIBE_HUNT_POINTS, ...data.tribeHuntPoints } : { ...DEFAULT_TRIBE_HUNT_POINTS };
    this.tribeHuntingParties = { styx: {}, zafaar: {}, elseth: {}, lesse: {} };
    if (data.tribeHuntingParties && typeof data.tribeHuntingParties === 'object') {
      for (const tribeId of TRIBE_IDS) {
        if (data.tribeHuntingParties[tribeId]) this.tribeHuntingParties[tribeId] = { ...data.tribeHuntingParties[tribeId] };
      }
    }
    this.partyGear = _deepClonePartyGear(data.partyGear);
  },

  reset() {
    this.completedScenarios  = [];
    this.huntTickets         = 0;
    this.tribeTickets        = 0;
    this.huntPoints          = 0;
    this.questFlags          = [];
    this.tribe               = null;
    this.tribeVendorStock    = {};
    this.completedQuestSteps = [];
    this.tribeRep            = { ...DEFAULT_TRIBE_REP };
    this.tribeHuntPoints     = { ...DEFAULT_TRIBE_HUNT_POINTS };
    this.tribeHuntingParties = { styx: {}, zafaar: {}, elseth: {}, lesse: {} };
    this.partyGear           = {};
  },
};

export default ProgressionManager;
