// src/systems/PartyGearManager.js
// Equipment, gear score, and stash management for NPC hunting parties.
// Gear persists via ProgressionManager.partyGear; this module is pure logic.

import { Items } from '../../data/items.js';
import { createItemInstance } from './ItemFactory.js';
import ProgressionManager from './ProgressionManager.js';

// The eight equippable slots available to a party (weaponOff omitted for simplicity).
export const PARTY_EQUIP_SLOTS = [
  'weaponMain', 'head', 'chest', 'legs', 'gloves', 'boots', 'ring', 'amulet',
];

export const SLOT_LABELS = {
  weaponMain: 'Weapon',
  head:       'Head',
  chest:      'Chest',
  legs:       'Legs',
  gloves:     'Gloves',
  boots:      'Boots',
  ring:       'Ring',
  amulet:     'Amulet',
};

export const PARTY_STASH_CAP = 8;

const RARITY_SCORE = { common: 1, uncommon: 2, rare: 3, epic: 4, legendary: 5 };

// Items eligible for party drops: non-unique equippable gear only.
export const DROP_POOL = Object.values(Items).filter(item =>
  !item.unique && !item.locked &&
  (item.type === 'weapon' ||
   (item.type === 'armor' && PARTY_EQUIP_SLOTS.includes(item.slot)))
).map(item => item.id);

// ---------------------------------------------------------------------------

function ensureGear(tribeId, partyId) {
  if (!ProgressionManager.partyGear) ProgressionManager.partyGear = {};
  if (!ProgressionManager.partyGear[tribeId]) ProgressionManager.partyGear[tribeId] = {};
  if (!ProgressionManager.partyGear[tribeId][partyId]) {
    ProgressionManager.partyGear[tribeId][partyId] = { equipment: {}, stash: [] };
  }
  return ProgressionManager.partyGear[tribeId][partyId];
}

export function getPartyGear(tribeId, partyId) {
  return ProgressionManager.partyGear?.[tribeId]?.[partyId] ?? { equipment: {}, stash: [] };
}

export function getPartyGearScore(tribeId, partyId) {
  const { equipment } = getPartyGear(tribeId, partyId);
  return Object.values(equipment).reduce((sum, inst) =>
    sum + (inst ? (RARITY_SCORE[inst.rarity] || 1) : 0), 0);
}

/** Multiplier applied to this party's daily hunt-point tick. */
export function getHuntPointMultiplier(tribeId, partyId) {
  return 1 + getPartyGearScore(tribeId, partyId) * 0.04;
}

// ---------------------------------------------------------------------------
// Equipment mutations

/** Equip an item into a slot. Returns the previously-equipped item (or null). */
export function equipPartySlot(tribeId, partyId, slot, itemInstance) {
  const gear = ensureGear(tribeId, partyId);
  const prev = gear.equipment[slot] || null;
  gear.equipment[slot] = itemInstance;
  return prev;
}

/** Clear a slot. Returns the removed item (or null). */
export function unequipPartySlot(tribeId, partyId, slot) {
  const gear = ensureGear(tribeId, partyId);
  const item = gear.equipment[slot] || null;
  gear.equipment[slot] = null;
  return item;
}

// ---------------------------------------------------------------------------
// Stash mutations

export function addToPartyStash(tribeId, partyId, itemInstance) {
  const gear = ensureGear(tribeId, partyId);
  if (gear.stash.length >= PARTY_STASH_CAP) return false;
  gear.stash.push(itemInstance);
  return true;
}

export function removeFromPartyStash(tribeId, partyId, instanceId) {
  const gear = ensureGear(tribeId, partyId);
  const idx = gear.stash.findIndex(i => i.instanceId === instanceId);
  if (idx === -1) return null;
  return gear.stash.splice(idx, 1)[0];
}

// ---------------------------------------------------------------------------
// Item acquisition (called from TribeHuntSimulator.tick)

function rollDropRarity(gearScore) {
  const r = Math.random();
  if (gearScore >= 19) {
    if (r < 0.05) return 'common';
    if (r < 0.25) return 'uncommon';
    if (r < 0.65) return 'rare';
    return 'epic';
  }
  if (gearScore >= 9) {
    if (r < 0.30) return 'common';
    if (r < 0.65) return 'uncommon';
    if (r < 0.90) return 'rare';
    return 'epic';
  }
  // low gear score
  if (r < 0.55) return 'common';
  if (r < 0.90) return 'uncommon';
  return 'rare';
}

/**
 * Roll a chance for this party to find an item. Returns the ItemInstance if
 * one was found and added to the stash, null otherwise.
 */
export function tryPartyItemFind(tribeId, partyId) {
  if (DROP_POOL.length === 0) return null;
  const gear = ensureGear(tribeId, partyId);
  if (gear.stash.length >= PARTY_STASH_CAP) return null;
  if (Math.random() > 0.25) return null; // 25% base find chance per day
  const gearScore = getPartyGearScore(tribeId, partyId);
  const rarity = rollDropRarity(gearScore);
  const itemId = DROP_POOL[Math.floor(Math.random() * DROP_POOL.length)];
  const item = createItemInstance(itemId, { rarity });
  if (!item) return null;
  gear.stash.push(item);
  return item;
}

