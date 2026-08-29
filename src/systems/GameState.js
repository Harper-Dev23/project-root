import { SKILLS } from '../../data/skills.js'; // adjust path if needed
import { getXPNeededForLevel } from '../../data/xpTable.js';
import { createItemInstance, isItemInstance } from './ItemFactory.js';
import { rebuildCharacterStats, applyLevelUp } from './CharacterBuilder.js'; // ← make sure this exists
import ProgressionManager from './ProgressionManager.js';

const defaultEquipment = {
  weaponMain: null,
  weaponOff: null,
  head: null,
  chest: null,
  legs: null,
  gloves: null,
  boots: null,
  ring: null,
  amulet: null
};


// ---------- ITEMS ----------
function serializeItem(entry) {
  if (!entry) return null;
  if (typeof entry === 'string') {
    return { id: entry, instanceId: 'itm_' + Math.random().toString(36).slice(2, 10) };
  }
  if (isItemInstance(entry)) return { ...entry };            // keep all fields
  if (entry.id) return { instanceId: entry.instanceId || 'itm_' + Math.random().toString(36).slice(2, 10), ...entry };
  return null;
}
function deserializeItem(entry) {
  if (!entry) return null;
  let out = null;
  // If an object with id/instanceId came from the save, keep it verbatim.
  if (isItemInstance(entry)) {
    out = { ...entry };
  } else if (entry.id) {
    // If somehow a plain object slipped in with an id, normalize it.
    out = { instanceId: entry.instanceId || 'itm_' + Math.random().toString(36).slice(2, 10), ...entry };
  } else if (typeof entry === 'string') {
    // If it's a string ID, DO NOT roll affixes here.
    return { id: entry, instanceId: 'itm_' + Math.random().toString(36).slice(2, 10) };
  }
  if (!out) return null;
  // Migrate old saves: quality field was renamed to rarity
  if (out.quality !== undefined && out.rarity === undefined) {
    out.rarity = out.quality;
    delete out.quality;
  }
  return out;
}
function serializeInventory(arr) { return Array.isArray(arr) ? arr.map(serializeItem).filter(Boolean) : []; }
function deserializeInventory(arr) { return Array.isArray(arr) ? arr.map(deserializeItem).filter(Boolean) : []; }

function serializeEquipment(eq) {
  const out = { ...defaultEquipment }, src = eq || {};
  for (const k in out) out[k] = serializeItem(src[k]);
  return out;
}
function deserializeEquipment(eq) {
  const out = { ...defaultEquipment }, src = eq || {};
  for (const k in out) out[k] = deserializeItem(src[k]);
  return out;
}

// ---------- CHAR WRAPPERS ----------
function serializeCharacter(c) {
  // shallow clone to avoid mutating in-place
  const out = { ...c };

  // persist items as instances-with-metadata
  out.equipment = serializeEquipment(c.equipment);
  out.inventory = serializeInventory(c.inventory);

  // skills by id (functions don't survive JSON)
  out.skills = (c.skills || []).map(s => typeof s === 'string' ? s : s.id);
  out.classSkills = (c.classSkills || []).map(s => typeof s === 'string' ? s : s.id);
  out.reactions = (c.reactions || []).map(s => typeof s === 'string' ? s : s.id);
  out.racialMovement = c.racialMovement ? (typeof c.racialMovement === 'string' ? c.racialMovement : c.racialMovement.id) : null;

  return out;
}

function restoreSkills(list) {
  if (!Array.isArray(list)) return [];
  return list.map(s => {
    const id = typeof s === 'string' ? s : s?.id;
    const live = id ? SKILLS[id] : null;
    return live ? { id, ...live } : null;
  }).filter(Boolean);
}

function deserializeCharacter(c) {
  const out = { ...c };

  // bring back item instances with metadata
  out.equipment = deserializeEquipment(c.equipment);
  out.inventory = deserializeInventory(c.inventory);

  // rebind skills to live data
  out.skills = restoreSkills(c.skills);
  out.classSkills = restoreSkills(c.classSkills);
  out.reactions = restoreSkills(c.reactions);
  out.racialMovement = c.racialMovement ? (SKILLS[c.racialMovement] || out.racialMovement) : null;

  // (IMPORTANT) DO NOT blow away existing shapes.
  // Only rebuild if totals are missing to avoid nuking your Stats/Favor/etc.
  if (!out.totalStats || !out.derivedStats) {
    try { rebuildCharacterStats(out); } catch (e) { console.warn('rebuildCharacterStats failed:', e); }
  }

  // Clamp pools only if max known; don't invent new schema
  const maxHP = out.maxHP ?? out.derivedStats?.maxHP;
  const maxMP = out.maxMP ?? out.derivedStats?.maxMP;
  if (typeof maxHP === 'number') {
    out.maxHP = maxHP;
    if (typeof out.currentHP === 'number') out.currentHP = Math.max(0, Math.min(out.currentHP, maxHP));
  }
  if (typeof maxMP === 'number') {
    out.maxMP = maxMP;
    if (typeof out.currentMP === 'number') out.currentMP = Math.max(0, Math.min(out.currentMP, maxMP));
  }

  return out;
}

// --- Post-load normalization --------------------------------
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

// --- Post-load normalization --------------------------------
function normalizeAfterLoad(c) {
  // ensure containers
  c.equipment = deserializeEquipment(c.equipment);
  c.inventory = deserializeInventory(c.inventory);
  c.cooldowns = c.cooldowns || {};
  c.instanceId = c.instanceId || c.id || ('char_' + Math.random().toString(36).slice(2, 10));

  // rebuild totals from base + equipment  ⬅️ CAPTURE THE RETURN
  try {
    const rebuilt = rebuildCharacterStats(c);
    if (rebuilt && rebuilt !== c) Object.assign(c, rebuilt);
  } catch (e) {
    console.warn('rebuildCharacterStats failed:', e);
  }

  // unify hp/mp fields
  const maxHP = c.maxHP ?? c.derivedStats?.maxHP ?? 1;
  const maxMP = c.maxMP ?? c.derivedStats?.maxMP ?? 0;
  c.maxHP = maxHP; c.maxMP = maxMP;
  c.currentHP = Math.max(0, Math.min(c.currentHP ?? maxHP, maxHP));
  c.currentMP = Math.max(0, Math.min(c.currentMP ?? maxMP, maxMP));

  // Skills (functions don't survive JSON)
  c.skills = restoreSkills(c.skills);
  c.classSkills = restoreSkills(c.classSkills);
  c.reactions = restoreSkills(c.reactions);
  c.racialMovement = c.racialMovement ? (SKILLS[c.racialMovement] || c.racialMovement) : null;

  return c;
}


// ---------------------------------------------------------------------------
// Save schema version
// ---------------------------------------------------------------------------
// Saves have carried `version: 3` for a long time, but nothing ever READ it -
// load() went straight to the fields. That meant a save written by a different
// build of the game would half-load instead of failing cleanly: missing fields
// silently became defaults, and the player got a subtly broken character with
// no indication anything had gone wrong.
//
// Bump SAVE_VERSION whenever the shape of the payload changes, and add an entry
// to MIGRATIONS that upgrades a save from (n-1) to n. Migrations run in order,
// so a very old save walks forward one step at a time.
export const SAVE_VERSION = 3;

// key n = 'upgrade a save at version n-1 so it is valid at version n'
// e.g. 4: (data) => { data.newField = []; return data; }
const MIGRATIONS = {};

/**
 * Brings a parsed save payload up to SAVE_VERSION.
 * Returns { ok, data, reason } - never throws, never partially applies.
 */
function migrateSave(data) {
  // Saves written before the version stamp existed. Treat as the oldest known
  // schema rather than rejecting - these are real saves that still load fine.
  let v = Number.isFinite(data.version) ? data.version : 1;

  if (v > SAVE_VERSION) {
    return {
      ok: false,
      reason: `This save was made by a newer version of the game (save v${v}, ` +
              `this build reads up to v${SAVE_VERSION}). Refusing to load it so ` +
              `it isn't overwritten with incomplete data.`,
    };
  }

  while (v < SAVE_VERSION) {
    const step = MIGRATIONS[v + 1];
    if (!step) {
      // No migration defined for this hop. Load anyway - historically every
      // save has been forward-compatible - but say so, so a real breakage
      // shows up in the console instead of as mystery behaviour.
      console.warn(`[GameState] No migration from save v${v} to v${v + 1}; ` +
                   `loading as-is. Fields added since v${v} will use defaults.`);
      break;
    }
    try {
      data = step(data) || data;
    } catch (e) {
      return { ok: false, reason: `Migration to v${v + 1} failed: ${e.message}` };
    }
    v += 1;
  }

  data.version = SAVE_VERSION;
  return { ok: true, data };
}


const GameState = {
  characters: [],
  party: [],
  slain: [], // characters lost to a full party wipe — shown in CampRosterOverlay's Slain tab
  inventory: [], // GLOBAL inventory shared between characters
  tribeStash: {}, // keyed by tribe id → ItemInstance[]

  currentScene: 'MainMenu',
  quests: [],
  flags: {},

  // ---------- Tribe Stash ----------
  getStash(tribeId) {
    if (!this.tribeStash[tribeId]) this.tribeStash[tribeId] = [];
    return this.tribeStash[tribeId];
  },

  addToStash(tribeId, item) {
    if (!this.tribeStash[tribeId]) this.tribeStash[tribeId] = [];
    if (typeof item === 'string') {
      const instance = createItemInstance(item);
      if (instance) this.tribeStash[tribeId].push(instance);
    } else if (isItemInstance(item)) {
      this.tribeStash[tribeId].push(item);
    }
  },

  removeFromStash(tribeId, instanceId) {
    if (!this.tribeStash[tribeId]) return;
    this.tribeStash[tribeId] = this.tribeStash[tribeId].filter(it =>
      isItemInstance(it) ? it.instanceId !== instanceId : true
    );
  },

  // inventory management------////
  addToInventory(item) {
    // Allow either a string ID or an instance object
    if (typeof item === 'string') {
      const instance = createItemInstance(item);
      if (instance) this.inventory.push(instance);
    } else if (isItemInstance(item)) {
      this.inventory.push(item);
    } else {
      console.warn('Invalid item type passed to addToInventory:', item);
    }
  },

  removeFromInventory(instanceId) {
    this.inventory = this.inventory.filter(it =>
      isItemInstance(it) ? it.instanceId !== instanceId : true
    );
  },

  ///////////////////////

  /* ----------------- Character Management ------------------ */
  addCharacter(charObj) {
    this.characters.push(charObj);
  },




  getCharacters() {
    return this.characters;
  },

  addToParty(charObj) {
    if (this.party.length < 6 && !this.party.includes(charObj)) {
      this.party.push(charObj);
    }
  },

  removeFromParty(charObj) {
    this.party = this.party.filter(c => c !== charObj);
  },

  /**
   * Awards XP to every living party member and processes any resulting
   * level-ups — the shared path for both combat victories and Hunt events,
   * so leveling logic only lives in one place.
   * Returns { leveledUpNames, summaries } for callers that want to display it.
   */
  /**
   * Award XP to a SPECIFIC set of characters. Training encounters pay out per
   * character rather than per party, so a level-1 recruit joining a veteran
   * party still earns their first clear of an old fight.
   *
   * awardPartyXP delegates here so levelling logic stays in one place.
   */
  awardXPTo(chars, amount) {
    const leveledUpNames = [];
    const summaries = [];
    if (amount <= 0 || !Array.isArray(chars)) return { leveledUpNames, summaries };

    chars.forEach(char => {
      if (!char || char.status === 'dead') return;

      char.experience = (char.experience || 0) + amount;
      let summary = `${char.name} gains ${amount} XP`;

      while (char.experience >= getXPNeededForLevel(char.level)) {
        char.experience -= getXPNeededForLevel(char.level);
        char.level++;
        applyLevelUp(char);
        summary += ` — Level Up! (Lv ${char.level})`;
        leveledUpNames.push(char.name);
      }
      summaries.push(summary);
    });
    return { leveledUpNames, summaries };
  },

  /** Has THIS character personally cleared this scenario before? */
  hasCharacterCleared(char, scenarioId) {
    return !!(char && scenarioId && char.clearedScenarios && char.clearedScenarios[scenarioId]);
  },

  /** Record a personal clear. Separate from ProgressionManager's account-wide
   *  completedScenarios, which still gates what the party can attempt next. */
  markCharacterCleared(char, scenarioId) {
    if (!char || !scenarioId) return;
    char.clearedScenarios = char.clearedScenarios || {};
    char.clearedScenarios[scenarioId] = true;
  },

  awardPartyXP(amount) {
    const leveledUpNames = [];
    const summaries = [];
    if (amount <= 0) return { leveledUpNames, summaries };

    this.party.forEach(char => {
      if (char.status === 'dead') return;

      char.experience += amount;
      let summary = `${char.name} gains ${amount} XP`;

      while (char.experience >= getXPNeededForLevel(char.level)) {
        char.experience -= getXPNeededForLevel(char.level);
        char.level++;
        applyLevelUp(char);
        summary += ` — Level Up! (Lv ${char.level})`;
        leveledUpNames.push(char.name);
      }

      summaries.push(summary);
    });

    return { leveledUpNames, summaries };
  },

  /** Full HP/MP restore for the whole party — used when returning to Camp Nehemiah from a Hunt. */
  restorePartyToFull() {
    this.party.forEach(char => {
      if (char.status === 'dead') return;
      char.status = 'alive';
      char.currentHP = char.maxHP;
      char.currentMP = char.maxMP ?? char.currentMP;
    });
  },

  /** Moves a character (already status === 'dead') out of characters/party and into Slain. */
  moveToSlain(charObj) {
    this.characters = this.characters.filter(c => c !== charObj);
    this.party = this.party.filter(c => c !== charObj);
    if (!this.slain.includes(charObj)) this.slain.push(charObj);
  },


  /* --------------------- Save / Load ---------------------- */
  save(slot) {
    if (!slot) return console.warn('Save slot required');

    const payload = {
      version: SAVE_VERSION,
      characters: (this.characters || []).map(serializeCharacter),
      slain: (this.slain || []).map(serializeCharacter),
      partyIds: (this.party || []).map(p => p.id),
      inventory: serializeInventory(this.inventory), // global bag
      tribeStash: Object.fromEntries(
        Object.entries(this.tribeStash || {}).map(([k, v]) => [k, serializeInventory(v)])
      ),

      currentScene: this.currentScene,
      quests: this.quests,
      flags: this.flags,
      progression: ProgressionManager.serialize(),

      partyOrder: Array.isArray(this.partyOrder) ? this.partyOrder.slice() : [],
      partySlots: this.partySlots ? { ...this.partySlots } : {}
    };
    console.log('[SAVE] partyIds=', payload.partyIds);////for testing
    (payload.characters || []).forEach((ch, i) => {
      console.log(`[SAVE] char#${i} id=${ch.id} inv=${(ch.inventory || []).length}`, ch.inventory);
      console.log(`[SAVE] char#${i} equip keys=`, Object.keys(ch.equipment || {}));
      console.log(`[SAVE] char#${i} equip snapshot=`, ch.equipment);
    });
    console.log('>>> DEBUG SAVE snapshot:', JSON.stringify(payload.characters, null, 2));
    // localStorage.setItem THROWS when storage is unavailable or full - most
    // commonly iOS Safari private browsing, where the quota is effectively
    // zero. Unguarded, that took down whatever triggered the save (autosave
    // fires from several places, including mid-scene transitions).
    try {
      localStorage.setItem(`bmSave_${slot}`, JSON.stringify(payload));
    } catch (e) {
      const why = e && e.name === 'QuotaExceededError'
        ? 'Browser storage is full or unavailable (private browsing blocks saving).'
        : `Could not write the save: ${e && e.message ? e.message : e}`;
      console.error(`[GameState] Save to '${slot}' failed - ${why}`);
      this.lastSaveError = why;
      return false;
    }
    this.lastSaveError = null;
    console.log(`Saved → ${slot}`);
    return true;
  },

  load(slot) {
    if (!slot) return console.warn('Load slot required');
    const raw = localStorage.getItem(`bmSave_${slot}`);
    if (!raw) { console.warn(`No save in slot ${slot}`); return false; }

    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      // Set lastLoadError here too - otherwise it keeps whatever the
      // PREVIOUS failed load put there and reports the wrong reason.
      console.error('Corrupt save:', e);
      this.lastLoadError = `Save slot '${slot}' is corrupt and could not be read.`;
      return false;
    }

    // Version gate. Runs before ANY field is read so a mismatched save fails
    // cleanly instead of half-loading into the live game state.
    const migrated = migrateSave(data);
    if (!migrated.ok) {
      console.error(`[GameState] Cannot load slot '${slot}': ${migrated.reason}`);
      this.lastLoadError = migrated.reason;
      return false;
    }
    data = migrated.data;
    this.lastLoadError = null;

    // Characters
    this.characters = (data.characters || [])
      .map(c => normalizeAfterLoad(deserializeCharacter(c)));

    // Slain — same deserialization as living characters, just a separate roster
    this.slain = (data.slain || [])
      .map(c => normalizeAfterLoad(deserializeCharacter(c)));

    // Party: re-link by id
    const idToChar = new Map(this.characters.map(ch => [ch.id, ch]));
    this.party = (data.partyIds || []).map(id => idToChar.get(id)).filter(Boolean);

    // Global bag / passthrough
    this.inventory = deserializeInventory(data.inventory);

    // Tribe stash
    this.tribeStash = {};
    if (data.tribeStash && typeof data.tribeStash === 'object') {
      for (const [k, v] of Object.entries(data.tribeStash)) {
        this.tribeStash[k] = deserializeInventory(v);
      }
    }
    this.currentScene = data.currentScene || this.currentScene;
    this.quests = data.quests || this.quests || [];
    this.flags = data.flags || this.flags || {};
    ProgressionManager.deserialize(data.progression);

    // NEW: restore slot/order metadata (both optional)
    this.partyOrder = Array.isArray(data.partyOrder) ? data.partyOrder.slice() : [];
    this.partySlots = (data.partySlots && typeof data.partySlots === 'object') ? { ...data.partySlots } : {};

    console.log(`Loaded ← ${slot}`);
    return true;

  },


  listSaveSlots() {
    const slots = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('bmSave_')) {
        slots.push(key.replace('bmSave_', ''));
      }
    }
    return slots;
  },

  deleteSlot(slot) {
    if (!slot) {
      console.warn('No slot specified for deletion');
      return;
    }
    localStorage.removeItem(`bmSave_${slot}`);
    console.log(`Deleted save slot: ${slot}`);
  },

  /* -------------------- New Game Reset -------------------- */
  /** Wipes all in-memory state for a fresh new game (does not touch localStorage). */
  reset() {
    this.characters = [];
    this.party = [];
    this.slain = [];
    this.inventory = [];
    this.tribeStash = {};
    this.quests = [];
    this.flags = {};
    this.currentScene = 'MainMenu';
  },

  /* -------------------- Scene Hooks ----------------------- */
  setCurrentScene(key) { this.currentScene = key; },
  getCurrentScene() { return this.currentScene; }
};

export default GameState;
