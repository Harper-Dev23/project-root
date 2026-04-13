// ProgressionManager.js
// Tracks demo progression: completed scenarios, Hunt Tickets, Tribe Tickets,
// active quest flags, and the save-slot-wide tribe allegiance choice.
//
// Serialized INTO the save slot by GameState — every save slot has its own
// independent progression (tickets, tribe choice, etc.).
//
// The DEV BYPASS toggle is stored separately in localStorage so it never
// touches save data and persists between page reloads.

import { DEFAULT_TRIBE_REP, clampRepScore } from './TribeRelations.js';

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
};

// Quest flags that must ALL be cleared before the next scenario unlocks.
// Scenarios not listed here have no flag gate (e.g. S1 is always available).
const SCENARIO_GATE_FLAGS = {
  'training_encounter_2': ['tribe_choice'],
  // Challenge flag is cleared on first hut entry; handin flag must also be cleared
  // (by clicking "Complete Quest") before the next scenario unlocks.
  'training_encounter_3': ['elder_bonepile', 'elseth_leader_challenge', 'elseth_leader_handin'],
  'training_encounter_4': ['elder_leveling', 'styx_leader_challenge', 'styx_leader_handin'],
  'training_encounter_5': ['samuel_mourne', 'lesse_leader_challenge', 'lesse_leader_handin'],
  'training_encounter_6': ['zafaar_leader_challenge', 'zafaar_leader_handin'],
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
// Scenario 6 gives a unique item instead, so it earns 0 tickets here.
const TICKET_REWARDS = {
  'training_encounter_1': 12,
  'training_encounter_2': 12,
  'training_encounter_3': 12,
  'training_encounter_4': 18,
  'training_encounter_5': 24,
  'training_encounter_6': 0,
};

// Quest flags auto-set on first clear of each scenario.
// Values can be a string (single flag) or an array (multiple flags).
const SCENARIO_FLAGS = {
  'training_encounter_1': 'tribe_choice',
  'training_encounter_2': ['elder_bonepile', 'elseth_leader_challenge'],
  'training_encounter_3': ['elder_leveling', 'styx_leader_challenge'],
  'training_encounter_4': ['samuel_mourne', 'lesse_leader_challenge'],
  'training_encounter_5': 'zafaar_leader_challenge',
};

// Feature gates: which scenario must be completed to unlock a feature.
const FEATURE_UNLOCKS = {
  bonepile: 'training_encounter_2',
};

// localStorage key for the dev bypass — outside any save slot.
const DEV_BYPASS_KEY = 'dev_progressionBypass';

// ---------------------------------------------------------------------------
// ProgressionManager
// ---------------------------------------------------------------------------
const ProgressionManager = {

  // ----- Runtime state (saved per slot via serialize/deserialize) -----------
  completedScenarios: [],   // e.g. ['training_encounter_1', 'training_encounter_2']
  huntTickets:  0,
  tribeTickets: 0,
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
      questFlags:          [...this.questFlags],
      tribe:               this.tribe,
      tribeVendorStock:    { ...this.tribeVendorStock },
      completedQuestSteps: [...this.completedQuestSteps],
      tribeRep:            { ...this.tribeRep },
    };
  },

  deserialize(data) {
    if (!data) return;
    this.completedScenarios  = Array.isArray(data.completedScenarios)  ? [...data.completedScenarios]  : [];
    this.huntTickets         = typeof data.huntTickets  === 'number'    ? data.huntTickets              : 0;
    this.tribeTickets        = typeof data.tribeTickets === 'number'    ? data.tribeTickets             : 0;
    this.questFlags          = Array.isArray(data.questFlags)           ? [...data.questFlags]          : [];
    this.tribe               = data.tribe || null;
    this.tribeVendorStock    = (data.tribeVendorStock && typeof data.tribeVendorStock === 'object')
      ? { ...data.tribeVendorStock } : {};
    this.completedQuestSteps = Array.isArray(data.completedQuestSteps) ? [...data.completedQuestSteps] : [];
    this.tribeRep            = (data.tribeRep && typeof data.tribeRep === 'object')
      ? { ...DEFAULT_TRIBE_REP, ...data.tribeRep } : { ...DEFAULT_TRIBE_REP };
  },

  reset() {
    this.completedScenarios  = [];
    this.huntTickets         = 0;
    this.tribeTickets        = 0;
    this.questFlags          = [];
    this.tribe               = null;
    this.tribeVendorStock    = {};
    this.completedQuestSteps = [];
    this.tribeRep            = { ...DEFAULT_TRIBE_REP };
  },
};

export default ProgressionManager;
