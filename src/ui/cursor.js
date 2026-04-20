const CURSOR_DEFAULT = "url('assets/UIinterface/cursor_default.png') 0 0, auto";
const CURSOR_HOVER   = "url('assets/UIinterface/cursor_hover.png') 16 0, auto";

/**
 * Call once in a scene's create() to wire hover cursor swaps for that scene.
 * Any setInteractive() object in the scene will trigger the pointer-finger cursor.
 */
export function setupSceneCursor(scene) {
  const canvas = scene.sys.game.canvas;
  scene.input.on('gameobjectover', () => { canvas.style.cursor = CURSOR_HOVER;   });
  scene.input.on('gameobjectout',  () => { canvas.style.cursor = CURSOR_DEFAULT; });
}

/** Manually force a specific cursor state — use for targeting mode etc. */
export function setCursor(scene, type = 'default') {
  const canvas = scene.sys.game.canvas;
  canvas.style.cursor = type === 'hover' ? CURSOR_HOVER : CURSOR_DEFAULT;
}
