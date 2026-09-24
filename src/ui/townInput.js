// src/ui/townInput.js
//
// One rule for giving TownScene its input back when a screen closes:
// NEVER wake the town while a hunt screen is still open.
//
// Found in chunk 8b (Exploration System v2): about a dozen overlays each set
// `TownScene.input.enabled = true` when they closed, whatever was still open.
// During a hunt, opening the Inventory from the sidebar and closing it woke
// the town UNDER the Hunt screen, and a click on the Hunt screen over the
// Bonfire opened character creation behind the running hunt. Every screen that
// used to wake the town calls wakeTown() instead.

/** Screens a hunt is played on. While any of them is open, the town sleeps. */
export const HUNT_SCREENS = [
  'HuntHubOverlay', 'HuntFieldOverlay', 'HuntMapOverlay', 'HuntPlanPickerOverlay',
  'HuntEncounterOverlay',
];

/**
 * Give TownScene its input back, unless a hunt screen other than `closing`
 * (the screen calling this as it closes) is still open.
 * @param {Phaser.Scene} scene  any scene; used to reach the scene manager
 * @param {string} [closing]    the key of the screen that is closing
 * @returns {boolean} whether the town was woken
 */
export function wakeTown(scene, closing = scene?.sys?.settings?.key) {
  const plugin = scene?.scene;
  const town = plugin?.get?.('TownScene');
  if (!town?.input) return false;
  const busy = HUNT_SCREENS.some(k => k !== closing && (plugin.isActive(k) || plugin.isPaused(k)));
  if (busy) return false;
  town.input.enabled = true;
  return true;
}
