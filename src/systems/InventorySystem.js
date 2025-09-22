// src/systems/InventorySystem.js
import { Items } from '../../data/items.js';
import GameState from './GameState.js';
import { equipItem } from './CharacterBuilder.js';
import { isItemInstance, createItemInstance } from './ItemFactory.js';
import { rebuildCharacterStats } from './CharacterBuilder.js';
import { getItemComputedData } from './ItemFactory.js';

export const InventorySystem = {
  // ===== Global inventory methods =====
  addGlobalItem(item) {
    if (typeof item === 'string') {
      const base = Items[item];
      if (!base) {
        console.warn(`Item '${item}' not found.`);
        return;
      }
      GameState.inventory = [...(GameState.inventory || []), createItemInstance(item)];
    } else if (isItemInstance(item)) {
      GameState.inventory = [...(GameState.inventory || []), item];
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
