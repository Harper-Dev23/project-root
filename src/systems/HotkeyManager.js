/**
 * HotkeyManager — central registry for keyboard shortcuts.
 *
 * Each entry is:
 *   key      — Phaser key string (e.g. 'J', 'F5')
 *   label    — Display name shown in the Hotkeys tab  (e.g. 'Journal')
 *   category — Groups entries in the Hotkeys list
 *
 * Actions are registered separately via register() so scenes can own
 * their own callbacks while this file stays as the single source of truth
 * for what key maps to what label.
 *
 * Future configurability: replace the static HOTKEYS array with a user-
 * editable config loaded from localStorage, keyed by `id`.
 */

export const HOTKEYS = [
  // ── Menus ──────────────────────────────────────────────
  { id: 'menu_character', key: 'C', label: 'Character',  category: 'Menus' },
  { id: 'menu_party',     key: 'P', label: 'Party',      category: 'Menus' },
  { id: 'menu_inventory', key: 'I', label: 'Inventory',  category: 'Menus' },
  { id: 'menu_skills',    key: 'K', label: 'Skills',     category: 'Menus' },
  { id: 'menu_map',       key: 'M', label: 'Map',        category: 'Menus' },
  { id: 'menu_quest',     key: 'U', label: 'Quest',      category: 'Menus' },
  { id: 'menu_tribes',    key: 'T', label: 'Tribes',     category: 'Menus' },
  { id: 'menu_journal',   key: 'J', label: 'Journal',    category: 'Menus' },
  { id: 'menu_options',   key: 'O', label: 'Options',    category: 'Menus' },
];

/**
 * Returns true when a DOM text-input element currently has focus.
 * Phaser's keyboard events still fire in this state, so we guard
 * against that here to prevent hotkeys from firing while the player
 * is typing a save-slot name.
 */
export function isDOMInputFocused() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || el.isContentEditable;
}

/**
 * Registers all hotkeys onto a Phaser scene's keyboard system.
 *
 * @param {Phaser.Scene} scene
 * @param {Object} handlers  — map of hotkey id → callback function
 *
 * Returns a cleanup function that removes all listeners.
 */
export function registerHotkeys(scene, handlers) {
  const added = [];

  for (const def of HOTKEYS) {
    const cb = handlers[def.id];
    if (!cb || !scene.input.keyboard) continue;

    const wrapped = () => {
      if (isDOMInputFocused()) return;
      cb();
    };

    scene.input.keyboard.on(`keydown-${def.key}`, wrapped);
    added.push({ key: def.key, fn: wrapped });
  }

  return () => {
    for (const { key, fn } of added) {
      scene.input.keyboard?.off(`keydown-${key}`, fn);
    }
  };
}
