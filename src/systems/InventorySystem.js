// src/systems/InventorySystem.js
import { Items } from '../../data/items.js';
import GameState from './GameState.js';
import { equipItem } from './CharacterBuilder.js';
import { isItemInstance, createItemInstance } from './ItemFactory.js';
import { rebuildCharacterStats } from './CharacterBuilder.js';
import { getItemComputedData } from './ItemFactory.js';
import { addToList, stackQty } from './ItemStacks.js';

/**
 * Flags an instance as not-yet-seen so the inventory can mark it.
 *
 * A plain boolean on the instance, so it survives a save/load — an item that
 * arrived from a bone-pile roll should still read as new after a reload, and
 * it is cleared the moment the player actually looks at it.
 */
function markNew(inst) {
  if (inst && typeof inst === 'object') inst._isNew = true;
  return inst;
}

export const InventorySystem = {
  // ===== Global inventory methods =====
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.isNew=true]  Flag it as an unseen ACQUISITION.
   *   Pass false when the item is merely MOVING between inventories — a
   *   transfer off a character is not a new find, and marking it made the
   *   green dot meaningless on any pack that had been reorganised.
   */
  addGlobalItem(item, opts = {}) {
    const flagNew = opts.isNew !== false;
    if (typeof item === 'string') {
      const base = Items[item];
      if (!base) {
        console.warn(`Item '${item}' not found.`);
        return;
      }
      const inst = createItemInstance(item);
      GameState.inventory = addToList([...(GameState.inventory || [])], flagNew ? markNew(inst) : inst);
    } else if (isItemInstance(item)) {
      // A stackable item merges into a matching stack (ItemStacks.js).
      GameState.inventory = addToList([...(GameState.inventory || [])], flagNew ? markNew(item) : item);
    } else {
      console.warn('Invalid item passed to addGlobalItem:', item);
    }
  },

  removeGlobalItem(item) {
    if (isItemInstance(item)) {
      GameState.inventory = (GameState.inventory || []).filter(it => it.instanceId !== item.instanceId);
    } else if (typeof item === 'string') {
      GameState.inventory = (GameState.inventory || []).filter(k => k !== item);
    }
  },

  /**
   * Spend one unit of an entry in the global inventory: a stack loses one
   * (the last one removes it), anything else is removed. For what is used up
   * one at a time (a combat item: CombatScene._spendBonusActionAndItem).
   */
  spendOneGlobal(item) {
    if (!isItemInstance(item)) { this.removeGlobalItem(item); return; }
    const inList = (GameState.inventory || []).find(it => isItemInstance(it) && it.instanceId === item.instanceId);
    if (inList && stackQty(inList) > 1) { inList.qty = stackQty(inList) - 1; return; }
    this.removeGlobalItem(item);
  },

  // ===== The active bag (owner 2026-09-29, batch 4b chunk 7) =====
  // What the party can reach now: the hunt pack while a map hunt is on (the
  // camp bag stays in camp), the camp bag otherwise. The inventory screen,
  // equipping and combat items all go through these.

  /** True while the active bag is a hunt pack. */
  isHuntingBag() {
    return !!GameState.packHunt();
  },

  /** The active bag's entries (a new array of the live instances). */
  bagItems() {
    const h = GameState.packHunt();
    return h ? h.packItems() : [...(GameState.inventory || [])];
  },

  /** Take an entry out of the active bag. Returns it, or null. */
  takeFromBag(item) {
    const h = GameState.packHunt();
    if (h) return h.takeFromPack(item?.instanceId);
    if (!this.hasGlobalItem(item)) return null;
    this.removeGlobalItem(item);
    return item;
  },

  /** Put an entry in the active bag (merging stacks). Not a new find. */
  putInBag(item) {
    const h = GameState.packHunt();
    if (h) return h.putInPack(item);
    this.addGlobalItem(item, { isNew: false });
    return true;
  },

  /** Use up one unit of an entry in the active bag (a combat item). */
  spendOneFromBag(item) {
    const h = GameState.packHunt();
    if (h) return h.spendOneFromPack(item?.instanceId);
    this.spendOneGlobal(item);
    return true;
  },

  /**
   * Equip an entry of the active bag on a hunter (no personal inventory in
   * between, batch 4b chunk 7). Whatever it displaces goes back into the
   * active bag. A refused equip (a two-hander in the off hand) leaves the
   * entry in the bag. Returns the rebuilt character.
   */
  equipFromBag(character, item, slot) {
    if (!character || !item) return character;
    const inst = this.takeFromBag(item);
    if (!inst) return character;
    const updated = equipItem({ ...character, inventory: [] }, inst, slot);
    const landed = Object.values(updated?.equipment || {}).some(e => e?.instanceId === inst.instanceId);
    if (!landed) { this.putInBag(inst); return character; }
    for (const displaced of updated.inventory || []) this.putInBag(displaced);
    updated.inventory = [];
    return rebuildCharacterStats(updated) || updated;
  },

  /** Take a hunter's gear off, into the active bag. Returns the rebuilt character. */
  unequipToBag(character, slot) {
    const item = character?.equipment?.[slot];
    if (!item) return character;
    const updated = { ...character, equipment: { ...(character.equipment || {}), [slot]: null } };
    this.putInBag(item);
    return rebuildCharacterStats(updated) || updated;
  },

  hasGlobalItem(item) {
    if (isItemInstance(item)) {
      return (GameState.inventory || []).some(it => it.instanceId === item.instanceId);
    } else if (typeof item === 'string') {
      return (GameState.inventory || []).includes(item);
    }
    return false;
  },

  getGlobalInventory() {
    return (GameState.inventory || []).map(it => {
      const id = isItemInstance(it) ? it.id : it;
      return Items[id];
    });
  },

  getGlobalInventoryViews() {
    return (GameState.inventory || []).map(inst => ({
      instance: inst,
      view: getItemComputedData(inst) // base merged with affixes
    }));
  },


  // ===== Character-specific inventory methods =====
  addItemToCharacter(character, item) {
    if (typeof item === 'string') {
      const base = Items[item];
      if (!base) {
        console.warn(`Item '${item}' not found.`);
        return character;
      }
      return {
        ...character,
        inventory: [...(character.inventory || []), createItemInstance(item)]
      };
    } else if (isItemInstance(item)) {
      return {
        ...character,
        inventory: [...(character.inventory || []), item]
      };
    }
    console.warn('Invalid item passed to addItemToCharacter:', item);
    return character;
  },

  removeItemFromCharacter(character, item) {
    if (isItemInstance(item)) {
      return {
        ...character,
        inventory: (character.inventory || []).filter(it => it.instanceId !== item.instanceId)
      };
    } else if (typeof item === 'string') {
      return {
        ...character,
        inventory: (character.inventory || []).filter(k => k !== item)
      };
    }
    return character;
  },

  equipItemFromInventory(character, item, slot = 'weaponMain') {
    if (!character || !item) return character;

    // Equip item and rebuild stats (logic lives in CharacterBuilder)
    const updatedChar = equipItem(character, item, slot);
    const rebuilt = rebuildCharacterStats(updatedChar);
    return rebuilt || updatedChar;
  },

  unequipItemFromSlot(character, slot) {
    const item = character?.equipment?.[slot];
    if (!item) return character;

    const updated = {
      ...character,
      equipment: { ...(character.equipment || {}), [slot]: null },
      inventory: [...(character.inventory || []), item]
    };

    const rebuilt = rebuildCharacterStats(updated);
    return rebuilt || updated;
  }



};

export default InventorySystem;
