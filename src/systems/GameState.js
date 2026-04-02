import { SKILLS } from '../../data/skills.js'; // adjust path if needed
import { createItemInstance, isItemInstance } from './ItemFactory.js';
import { rebuildCharacterStats } from './CharacterBuilder.js'; // ← make sure this exists
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
  // If an object with id/instanceId came from the save, keep it verbatim.
  if (isItemInstance(entry)) return { ...entry };
  // If somehow a plain object slipped in with an id, normalize it.
  if (entry.id) {
    return {
      instanceId: entry.instanceId || 'itm_' + Math.random().toString(36).slice(2, 10),
      ...entry
    };
  }
  // If it’s a string ID, DO NOT roll affixes here.
  // Make a minimal, “blank” instance with no random mods.
  if (typeof entry === 'string') {
    return { id: entry, instanceId: 'itm_' + Math.random().toString(36).slice(2, 10) };
  }
  return null;
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

  // Skills (functions don’t survive JSON)
  c.skills = restoreSkills(c.skills);
  c.classSkills = restoreSkills(c.classSkills);
  c.reactions = restoreSkills(c.reactions);
  c.racialMovement = c.racialMovement ? (SKILLS[c.racialMovement] || c.racialMovement) : null;

  return c;
}


const GameState = {
  characters: [],
  party: [],
  inventory: [], // GLOBAL inventory shared between characters

  currentScene: 'MainMenu',
  quests: [],
  flags: {},

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


  /* --------------------- Save / Load ---------------------- */
  save(slot) {
    if (!slot) return console.warn('Save slot required');

    const payload = {
      version: 3,
      characters: (this.characters || []).map(serializeCharacter),
      partyIds: (this.party || []).map(p => p.id),
      inventory: serializeInventory(this.inventory), // global bag

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
    localStorage.setItem(`bmSave_${slot}`, JSON.stringify(payload));
    console.log(`Saved → ${slot}`);
  },

  load(slot) {
    if (!slot) return console.warn('Load slot required');
    const raw = localStorage.getItem(`bmSave_${slot}`);
    if (!raw) { console.warn(`No save in slot ${slot}`); return false; }

    let data;
    try { data = JSON.parse(raw); } catch (e) { console.error('Corrupt save:', e); return false; }

    // Characters
    this.characters = (data.characters || [])
      .map(c => normalizeAfterLoad(deserializeCharacter(c)));

    // Party: re-link by id
    const idToChar = new Map(this.characters.map(ch => [ch.id, ch]));
    this.party = (data.partyIds || []).map(id => idToChar.get(id)).filter(Boolean);

    // Global bag / passthrough
    this.inventory = deserializeInventory(data.inventory);
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
    this.inventory = [];
    this.quests = [];
    this.flags = {};
    this.currentScene = 'MainMenu';
  },

  /* -------------------- Scene Hooks ----------------------- */
  setCurrentScene(key) { this.currentScene = key; },
  getCurrentScene() { return this.currentScene; }
};

export default GameState;
