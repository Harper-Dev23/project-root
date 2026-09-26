import { SKILLS } from '../../data/skills.js'; // adjust path if needed
import { getXPNeededForLevel, LEVEL_CAP, TRAINING_LEVEL_CAP, xpShare } from '../../data/xpTable.js';
import { createItemInstance, isItemInstance } from './ItemFactory.js';
import { addToList } from './ItemStacks.js';
import { legacyItemId } from '../../data/beastParts.js';
import { Items } from '../../data/items.js';
import { rebuildCharacterStats, applyLevelUp } from './CharacterBuilder.js'; // ← make sure this exists
import ProgressionManager from './ProgressionManager.js';
import { newStanding, LEGACY_FELL } from './Standing.js';
import { REP_SCALE } from './TribeRelations.js';
// Diagnostics imports nothing from the project, so this direction is safe and
// can never become a cycle. See the header of that file.
import Diagnostics from './Diagnostics.js';

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
  // Re-keyed beast families (chunk 14a): parts harvested under an old id.
  out.id = legacyItemId(out.id);
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
/**
 * Constructor names that are never save data. Matching on the name rather than
 * `instanceof` keeps this file free of a Phaser import, and covers subclasses
 * (every StatusBar is a Container, every emitter a ParticleEmitter).
 */
const RUNTIME_CTORS = new Set([
  'Scene', 'Systems', 'Tween', 'TweenManager', 'Timeline',
  'Container', 'Sprite', 'Image', 'Text', 'Graphics', 'Rectangle', 'Arc',
  'ParticleEmitter', 'ParticleEmitterManager', 'Camera', 'TimerEvent',
  'EventEmitter', 'Group', 'Zone', 'RenderTexture', 'BitmapText',
]);

/** Is this a live engine object rather than plain save data? */
function isRuntimeObject(v) {
  if (!v || typeof v !== 'object') return false;
  const ctor = v.constructor && v.constructor.name;
  if (ctor && RUNTIME_CTORS.has(ctor)) return true;
  // Duck-typing for anything the list misses: a scene back-reference, a game
  // reference, or the shape of a tween.
  if (v.scene && v.scene.sys) return true;
  if (v.sys && v.sys.game) return true;
  if (v.callbackScope !== undefined && Array.isArray(v.targets)) return true;
  return false;
}

/**
 * JSON.stringify that cannot throw on a cycle and never writes engine objects.
 *
 * Cycles are detected by tracking ANCESTORS rather than every object seen, so
 * an object legitimately referenced twice in different branches still
 * serialises — only a true loop is cut. Returns the JSON plus the list of
 * paths that were dropped, so silent data loss is impossible to miss.
 */
function safeStringify(value) {
  const dropped = [];
  const ancestors = [];
  const paths = [];
  const json = JSON.stringify(value, function (key, val) {
    // `this` is the object currently being serialised; unwind both stacks to
    // it so `paths` always describes where we actually are.
    while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) {
      ancestors.pop(); paths.pop();
    }
    const base = paths.length ? paths[paths.length - 1] : '';
    const here = key === '' ? '(root)' : (base ? base + '.' + key : key);

    if (typeof val === 'function') return undefined;
    if (!val || typeof val !== 'object') return val;
    // Reported with the full path, because the useful question when a field
    // disappears from a save is WHERE it was, not what it was called.
    if (isRuntimeObject(val)) {
      const ctor = (val.constructor && val.constructor.name) || 'object';
      dropped.push(here + ' <' + ctor + '>');
      return undefined;
    }
    if (ancestors.indexOf(val) !== -1) { dropped.push(here + ' [cycle]'); return undefined; }
    ancestors.push(val); paths.push(here);
    return val;
  });
  return { json, dropped };
}

// Live Phaser display objects that combat hangs directly on a character.
// None of them is save data, and every one holds a `.scene` back-reference, so
// leaving even one in place makes the whole payload un-stringifiable.
const RUNTIME_CHAR_KEYS = [
  'hpBar', 'mpBar', 'initBar',      // the three portrait status bars
  'icon', '_slot',                  // portrait sprite and its slot container
  'weaknessEmitters',               // particle emitters, one per weakness family
  // Weakness portrait-overlay bookkeeping: { ghosts, tweens, gfx, timer } per
  // family. Pure VFX state, rebuilt from the meters whenever combat starts, so
  // it is never save data. Listed explicitly rather than left to the generic
  // sweep so the "dropped fields" warning stays quiet for the expected case —
  // a warning that fires on every single save would mask a real one.
  '_wkProc',
];

/**
 * Does this value look like a Phaser object (or a container of them)?
 *
 * A belt-and-braces sweep alongside the explicit list above: combat attaches
 * display objects to characters from several places, and a future one would
 * otherwise reintroduce this crash silently — the failure mode is a thrown
 * save, not a warning. Cheap, since it only inspects one level.
 */
function looksLikePhaserObject(v, depth = 0) {
  if (!v || typeof v !== 'object' || depth > 1) return false;
  if (Array.isArray(v)) return v.some(x => looksLikePhaserObject(x, depth + 1));
  return !!(v.scene && v.scene.sys) || !!(v.sys && v.sys.game);
}

function serializeCharacter(c) {
  // shallow clone to avoid mutating in-place
  const out = { ...c };

  // Drop anything that cannot survive JSON. Deliberately done BEFORE the
  // equipment/inventory rebuild below so the sweep never has to look inside
  // item instances, which are plain data.
  for (const k of RUNTIME_CHAR_KEYS) delete out[k];
  for (const k of Object.keys(out)) {
    if (looksLikePhaserObject(out[k])) delete out[k];
  }

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
/**
 * What to tell the player when a storage write throws.
 *
 * One definition for saving AND importing, which both write to localStorage and
 * fail the same ways. localStorage.setItem throws when storage is full or the
 * browser forbids it; a QuotaExceededError is by far the common case.
 */
function describeWriteError(e) {
  return e && e.name === 'QuotaExceededError'
    ? 'Browser storage is full or unavailable (private browsing blocks saving).'
    : `Could not write the save: ${e && e.message ? e.message : e}`;
}

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
//
// Once a version has been pushed, players hold saves at that version, and a
// migration that already ran will never run again for them. So a later change
// to the payload gets its OWN step (5, 6, ...) rather than an edit to an old one.
export const SAVE_VERSION = 8;

// key n = 'upgrade a save at version n-1 so it is valid at version n'
const MIGRATIONS = {
  // v4: a hunt in progress is saved, as one `hunt` field (null when there is
  // none). Before v4 hunts were never saved, so every v3 save has none.
  4: (data) => {
    if (!('hunt' in data)) data.hunt = null;
    return data;
  },
  // v5: items can stack (ItemStacks.js) — an entry may carry `qty`, and the
  // bag can hold Rations. Nothing to convert: no save before v5 holds a stack,
  // and a missing qty reads as 1. The step exists for the version number,
  // which is what makes a build from before stacking REFUSE a v5 save instead
  // of loading "Rations x40" as one ration and autosaving the other 39 away.
  // A saved hunt's own shape is versioned separately (HUNT_STATE_VERSION);
  // restoreHunt upgrades a v1 hunt to carry a pack.
  5: (data) => data,
  // v6: Hunt Plans have an item level (Hunt Plans v2). A plan saved before
  // v6 has none, and becomes item level 1 -- base tier I, no implicit -- with
  // no bonus objectives (SAVE_COMPATIBILITY). Its rolled affixes are kept as
  // they are. Only one plan base existed before v6, `hunt_plan`, so matching
  // that id is exact and stays true however the item data changes later.
  // Walks the whole payload: plans can sit in the bag, a tribe stash, or a
  // character's own inventory.
  6: (data) => {
    const visit = (v) => {
      if (Array.isArray(v)) { v.forEach(visit); return; }
      if (!v || typeof v !== 'object') return;
      if (v.id === 'hunt_plan' && typeof v.instanceId === 'string') {
        if (!Number.isFinite(v.itemLevel)) v.itemLevel = 1;
        if (!Array.isArray(v.bonusObjectives)) v.bonusObjectives = [];
      }
      for (const k of Object.keys(v)) visit(v[k]);
    };
    visit(data);
    return data;
  },
  // v7: the saved hunt can be a hunt on the hex map (chunk 8c): `hunt` then
  // carries `mode: 'map'` and HuntEngine's own shape (MAP_HUNT_STATE_VERSION).
  // A hunt with no mode is the old Advance hunt, unchanged. Nothing to
  // convert. The step exists for the version number: a build from before 8c
  // would fail to restore a map hunt and drop it WITH ITS PACK, so it must
  // refuse the save instead. Old saves' plan-vendor stock has no base per
  // slot; HuntPlans.currentPlanStock rolls it again once, at runtime.
  7: (data) => data,
  // v8: standing (Exploration System v2, chunk 10a).
  //   - progression.standing, the save-wide record (Standing.js): the Bond,
  //     legacy, the season's devotion table. Season 1 begins on the save's
  //     current day, so an old save never opens straight into a season end.
  //     Its seed is a hash of the save itself, so migrating the same save
  //     twice gives the same record.
  //   - tribe reputation rescaled x REP_SCALE (decision 10): every stored
  //     score is multiplied by the same factor as the thresholds, so no save
  //     changes rank.
  //   - every Slain hunter gets a `fell` record. Before v8 nobody recorded
  //     where they fell; they are all Watched deaths with no house (owner,
  //     2026-09-18), so the lesser rite is open to them and intercession not.
  8: (data) => {
    const pr = data.progression || (data.progression = {});
    if (pr.tribeRep && typeof pr.tribeRep === 'object') {
      for (const k of Object.keys(pr.tribeRep)) if (Number.isFinite(pr.tribeRep[k])) pr.tribeRep[k] *= REP_SCALE;
    }
    if (!pr.standing) {
      const day = Number.isFinite(pr.daysElapsed) ? pr.daysElapsed : 0;
      const ids = (data.characters || []).concat(data.slain || []).map(c => c?.id ?? '').join('|');
      let h = 0x811C9DC5;
      for (const ch of `${ids}#${day}#${pr.tribe || ''}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
      pr.standing = newStanding(h, day);
    }
    for (const c of data.slain || []) if (c && !c.fell) c.fell = { ...LEGACY_FELL };
    return data;
  },
};

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

  // The hunt in progress. GameState cannot import HuntManager (HuntManager
  // imports GameState), so HuntManager attaches itself through attachHunt().
  // `_rawHunt` is the hunt exactly as last loaded; it is written back unchanged
  // when nothing is attached (a tool that never imports HuntManager), so a
  // save/load round trip can never drop a hunt it did not understand.
  _huntHooks: null,
  _rawHunt: null,
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
      if (instance) addToList(this.tribeStash[tribeId], instance);
    } else if (isItemInstance(item)) {
      addToList(this.tribeStash[tribeId], item);
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
    // A stackable item merges into a matching stack (ItemStacks.js).
    if (typeof item === 'string') {
      const instance = createItemInstance(item);
      if (instance) addToList(this.inventory, instance);
    } else if (isItemInstance(item)) {
      addToList(this.inventory, item);
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

      // At the cap XP stops accruing entirely rather than piling up invisibly:
      // Reckoning tiers pay out every clear, so an uncapped counter would grow
      // forever behind a bar that never moves. Experience is pinned to the
      // requirement so the bar reads full.
      if (char.level >= LEVEL_CAP) {
        char.experience = getXPNeededForLevel(char.level);
        summaries.push(`${char.name} is at the level cap (Lv ${LEVEL_CAP}).`);
        return;
      }

      char.experience = (char.experience || 0) + amount;
      let summary = `${char.name} gains ${amount} XP`;

      while (char.level < LEVEL_CAP && char.experience >= getXPNeededForLevel(char.level)) {
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

  /**
   * Training (pit) XP: awardXPTo, but it stops at TRAINING_LEVEL_CAP. Levels
   * past it come from hunts (SCALING: levelling is counted in hunts), so the
   * repeatable Reckoning tiers can no longer be ground to the real cap.
   *
   * Nothing past the training cap is kept: a hunter at or above it earns
   * nothing here, and one who reaches it here keeps none of the overflow —
   * otherwise pit XP would bank toward the next level and a hunt would cash
   * it in. XP a hunter already has from hunts is left alone.
   */
  awardTrainingXPTo(chars, amount) {
    const leveledUpNames = [];
    const summaries = [];
    if (amount <= 0 || !Array.isArray(chars)) return { leveledUpNames, summaries };

    const below = [];
    chars.forEach(char => {
      if (!char || char.status === 'dead') return;
      if (char.level >= TRAINING_LEVEL_CAP) {
        summaries.push(`${char.name} has outgrown training (Lv ${TRAINING_LEVEL_CAP}+) - hunt to grow further.`);
      } else {
        below.push(char);
      }
    });
    // Each hunter's award is clamped to exactly what reaches the training cap,
    // so one who gets there lands on 0 XP into the next level.
    below.forEach(char => {
      let room = -(char.experience || 0);
      for (let l = char.level; l < TRAINING_LEVEL_CAP; l++) room += getXPNeededForLevel(l);
      const r = this.awardXPTo([char], Math.min(amount, room));
      leveledUpNames.push(...r.leveledUpNames);
      summaries.push(...r.summaries);
    });
    return { leveledUpNames, summaries };
  },

  /**
   * Hunt XP: ONE pool, split between the hunters with a floor (xpShare,
   * data/xpTable.js), so a small party levels faster than a full one. The
   * split is over the whole party; the living members are paid, through
   * awardXPTo so levelling still lives in one place.
   */
  awardXPPool(pool, party = this.party) {
    const members = Array.isArray(party) ? party : [];
    return this.awardXPTo(members, xpShare(pool, members.length));
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

  awardPartyXP(amount, party = this.party) {
    const leveledUpNames = [];
    const summaries = [];
    if (amount <= 0) return { leveledUpNames, summaries };

    (party || []).forEach(char => {
      if (char.status === 'dead') return;

      // At the cap XP stops accruing entirely rather than piling up invisibly:
      // Reckoning tiers pay out every clear, so an uncapped counter would grow
      // forever behind a bar that never moves. Experience is pinned to the
      // requirement so the bar reads full.
      if (char.level >= LEVEL_CAP) {
        char.experience = getXPNeededForLevel(char.level);
        summaries.push(`${char.name} is at the level cap (Lv ${LEVEL_CAP}).`);
        return;
      }

      char.experience += amount;
      let summary = `${char.name} gains ${amount} XP`;

      while (char.level < LEVEL_CAP && char.experience >= getXPNeededForLevel(char.level)) {
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

  // ── The Historic ledger (chunk 14b; vault IMPLEMENTATION_PLAN, "Historic
  // items and bosses") ──────────────────────────────────────────────────────
  // One of each Historic item exists in the realm. "Held" is DERIVED from the
  // save, never stored, so it cannot drift: any copy on a hunter (equipped or
  // carried, the Slain included), in the camp bag, the tribe stash or the
  // hunt's pack. What is recorded is only what cannot be derived: returns to
  // the world (flags.historicLedger), and later a rival tribe's claim.

  /** Every item instance this save holds anywhere. */
  _allHeldItems() {
    const out = [];
    const take = (x) => { if (x && typeof x === 'object' && x.id) out.push(x); };
    for (const c of [...(this.characters || []), ...(this.slain || [])]) {
      Object.values(c.equipment || {}).forEach(take);
      (c.inventory || []).forEach(take);
    }
    (this.inventory || []).forEach(take);
    Object.values(this.tribeStash || {}).forEach(list => (list || []).forEach(take));
    const hunt = this._huntHooks ? this._huntHooks.serialize() : this._rawHunt;
    for (const list of [hunt?.pack?.brought, hunt?.pack?.found]) (list || []).forEach(take);
    return out;
  },

  /** Does this save hold a copy of the item anywhere? */
  ownsItem(itemId) {
    return this._allHeldItems().some(i => i.id === itemId);
  },

  /**
   * Is a Historic item still out in the world? Its sources (a boss's lair
   * chest, the Ghost Captain, a chance find) give it only then; while the
   * player holds it they give something else. (Rival claims come later.)
   */
  historicInWild(itemId) {
    return !this.ownsItem(itemId);
  },

  /**
   * The lodge ritual (LodgeShrineOverlay): return a Historic item from the
   * camp bag to its natural place. The copy is gone, with its history and
   * renown; the item is back in the wild, so its source can give it again,
   * rolled anew. Only an item whose base names a `home` can be returned.
   */
  returnHistoric(instance, day = null) {
    const i = (this.inventory || []).indexOf(instance);
    if (i < 0) return { ok: false, reason: 'it must be in the camp bag' };
    const home = Items[instance.id]?.home;
    if (!Items[instance.id]?.historic || !home) return { ok: false, reason: 'it has no place to return to' };
    this.inventory.splice(i, 1);
    const led = (this.flags.historicLedger = this.flags.historicLedger || {});
    const e = (led[instance.id] = led[instance.id] || { returned: 0 });
    e.returned += 1;
    e.lastReturnedDay = day;
    return { ok: true, home };
  },

  /**
   * Moves a character (already status === 'dead') out of characters/party and
   * into Slain. `fell` is where they fell (Standing.fellRecord): the region,
   * its house and death rule, the day. The ways back read it; a hunter with
   * none is treated as an old Watched death.
   */
  moveToSlain(charObj, fell = null) {
    charObj.fell = fell ? { ...fell } : { ...LEGACY_FELL };
    this.characters = this.characters.filter(c => c !== charObj);
    this.party = this.party.filter(c => c !== charObj);
    if (!this.slain.includes(charObj)) this.slain.push(charObj);
  },


  /**
   * A Slain hunter comes back (Revival.js: intercession or the lesser rite,
   * chunk 10c): off the Slain roster, alive at full HP and MP, into camp (not
   * the party). The record of where they fell goes with them.
   */
  reviveFromSlain(charObj) {
    if (!this.slain.includes(charObj)) return false;
    this.slain = this.slain.filter(c => c !== charObj);
    delete charObj.fell;
    delete charObj.rite;
    charObj.status = 'alive';
    charObj.currentHP = charObj.maxHP;
    charObj.currentMP = charObj.maxMP ?? charObj.currentMP;
    if (!this.characters.includes(charObj)) this.characters.push(charObj);
    return true;
  },

  /**
   * Called once, by HuntManager, with { serialize(), restore(data) }. Restores
   * whatever hunt is already loaded, so attach order never matters.
   */
  attachHunt(hooks) {
    this._huntHooks = hooks;
    hooks.restore(this._rawHunt);
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
      partySlots: this.partySlots ? { ...this.partySlots } : {},

      hunt: this._huntHooks ? this._huntHooks.serialize() : this._rawHunt,
    };
    // NOTE: no unguarded JSON.stringify above the try/catch below. A debug
    // snapshot line used to live here and was what actually took the game
    // down on a circular payload — the guarded write below would merely have
    // logged and continued.
    // localStorage.setItem THROWS when storage is unavailable or full - most
    // commonly iOS Safari private browsing, where the quota is effectively
    // zero. Unguarded, that took down whatever triggered the save (autosave
    // fires from several places, including mid-scene transitions).
    try {
      const { json, dropped } = safeStringify(payload);
      if (dropped.length) {
        // Not fatal — these are engine objects that were never save data — but
        // surfaced so an unexpected field going missing is caught early.
        console.warn('[GameState] save dropped non-serialisable fields:',
          Array.from(new Set(dropped)).join(', '));
      }
      localStorage.setItem(`bmSave_${slot}`, json);
    } catch (e) {
      const why = describeWriteError(e);
      console.error(`[GameState] Save to '${slot}' failed - ${why}`);
      this.lastSaveError = why;
      // `lastSaveError` was set here and read NOWHERE for as long as it existed,
      // so a player whose browser refuses to persist anything saw no sign of it:
      // purchases, gambles and quest-flag transitions all appeared to work and
      // then reverted on reload. This hands the failure to whoever is listening
      // (UIScene raises a toast) and records it for bmDiag().
      Diagnostics.noteSaveFailure(slot, why);
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

    // Last, so the party a restored hunt reads is this save's party.
    this._rawHunt = data.hunt ?? null;
    this._huntHooks?.restore(this._rawHunt);

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

  /** A slot's stored payload, parsed. Null if the slot is missing or unreadable. For export. */
  readSlot(slot) {
    try {
      const raw = localStorage.getItem(`bmSave_${slot}`);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },

  /**
   * Would this payload load? Checked the way load() reads it, WITHOUT touching
   * live state.
   *
   * Exists for imported saves, which can come from another computer, another
   * version of the game, or someone else entirely. It runs the same version gate
   * as load() and then the same per-character deserialize load() runs — on a
   * COPY, since those transforms are pure but the payload must not be mutated.
   * A file that would break the Load menu is refused here instead of being
   * written into a slot the player then cannot open.
   *
   * Returns { ok: true, data } with the migrated payload, or { ok: false, reason }.
   */
  checkSave(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, reason: 'That file does not contain a save.' };
    }
    if (!Array.isArray(data.characters)) {
      return { ok: false, reason: 'That save has no characters in it.' };
    }
    let copy;
    try {
      copy = JSON.parse(JSON.stringify(data));
    } catch {
      return { ok: false, reason: 'That save could not be read.' };
    }
    const migrated = migrateSave(copy);
    if (!migrated.ok) return { ok: false, reason: migrated.reason };
    try {
      for (const c of migrated.data.characters) {
        if (!c || typeof c !== 'object' || Array.isArray(c)) {
          throw new Error('a character entry is not valid');
        }
        normalizeAfterLoad(deserializeCharacter(c));
      }
    } catch (e) {
      return { ok: false, reason: `That save could not be loaded: ${e?.message || e}` };
    }
    return { ok: true, data: migrated.data };
  },

  /**
   * Writes an imported save into `slot`, after checkSave passes.
   *
   * Never overwrites: callers pick a slot name that does not exist yet (see
   * importSlotName in SaveTransfer.js), so importing a file can never replace a
   * save the player already has. A storage failure is reported through the same
   * channel as a failed save, so the player is told rather than left guessing.
   */
  importSave(slot, data) {
    if (!slot) return { ok: false, reason: 'No slot name was given.' };
    if (localStorage.getItem(`bmSave_${slot}`) != null) {
      return { ok: false, reason: `A save named "${slot}" already exists.` };
    }
    const checked = this.checkSave(data);
    if (!checked.ok) return checked;
    try {
      localStorage.setItem(`bmSave_${slot}`, JSON.stringify(checked.data));
    } catch (e) {
      const why = describeWriteError(e);
      Diagnostics.noteSaveFailure(slot, why);
      return { ok: false, reason: why };
    }
    return { ok: true, slot };
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
    this._rawHunt = null;
    this._huntHooks?.restore(null);
  },

  /* -------------------- Scene Hooks ----------------------- */
  setCurrentScene(key) { this.currentScene = key; },
  getCurrentScene() { return this.currentScene; }
};

export default GameState;
