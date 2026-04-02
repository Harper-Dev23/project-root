// ProgressionManager.js
// Tracks demo progression: completed scenarios, Hunt Tickets, Tribe Tickets,
// active quest flags, and the save-slot-wide tribe allegiance choice.
//
// Serialized INTO the save slot by GameState — every save slot has its own
// independent progression (tickets, tribe choice, etc.).
//
// The DEV BYPASS toggle is stored separately in localStorage so it never
// touches save data and persists between page reloads.

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

// Scenario 1 first clear unlocks the tribe choice event at the Elder's Tower.
const SCENARIO_FLAGS = {
  'training_encounter_1': 'tribe_choice',
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

  // Quest flags: IDs of events that are currently "pending" (show a ! marker).
  // e.g. ['tribe_choice'] means the Elder's Tower has something for the player.
  questFlags: [],

  // Tribe allegiance — SAVE-SLOT WIDE.
  // One tribe per save file; all characters in that slot belong to the same tribe.
  // Valid values: 'styx' | 'zafaar' | 'elseth' | 'lesse' | null (not yet chosen)
  tribe: null,

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

  // ----- Tribe allegiance (save-slot wide) ---------------------------------

  getTribe() { return this.tribe; },

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

  // ----- Scenario unlock queries -------------------------------------------

  isScenarioUnlocked(scenarioId) {
    if (this.isBypassEnabled()) return true;
    const req = UNLOCK_REQUIRES[scenarioId];
    if (req === null) return true;
    if (req === undefined) return false;
    return this.completedScenarios.includes(req);
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

      // Auto-set any quest flag tied to this scenario's first completion.
      const flagId = SCENARIO_FLAGS[scenarioId];
      if (flagId) this.setQuestFlag(flagId);
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
      completedScenarios: [...this.completedScenarios],
      huntTickets:  this.huntTickets,
      tribeTickets: this.tribeTickets,
      questFlags:   [...this.questFlags],
      tribe:        this.tribe,
    };
  },

  deserialize(data) {
    if (!data) return;
    this.completedScenarios = Array.isArray(data.completedScenarios) ? [...data.completedScenarios] : [];
    this.huntTickets  = typeof data.huntTickets  === 'number' ? data.huntTickets  : 0;
    this.tribeTickets = typeof data.tribeTickets === 'number' ? data.tribeTickets : 0;
    this.questFlags   = Array.isArray(data.questFlags) ? [...data.questFlags] : [];
    this.tribe        = data.tribe || null;
  },

  reset() {
    this.completedScenarios = [];
    this.huntTickets  = 0;
    this.tribeTickets = 0;
    this.questFlags   = [];
    this.tribe        = null;
  },
};

export default ProgressionManager;
