// tools/headless/scrollbar.mjs
//
// A scrollbar whose scene has shut down must not crash when refreshed.
//
// Reproduces a real crash from play: open the Skills overlay, close it, open it
// again. Phaser REUSES a scene instance across restarts, so fields set on `this`
// survive a close -- but everything on its display list is destroyed. The old
// scrollbar object was still referenced, its Zone was dead, and refreshing it
// called setInteractive on a destroyed object:
//
//   Uncaught TypeError: Cannot read properties of undefined (reading 'sys')
//     at Zone.setInteractive
//
// The fake Zone below behaves the way Phaser's does in the one respect that
// matters: setInteractive reads `this.scene.sys`, and destroy() clears `scene`.
//
// Run: node tools/headless/scrollbar.mjs

import { installPhaserStub } from './phaserStub.js';
installPhaserStub(1);
const { createScrollbar } = await import('../../src/ui/Scrollbar.js');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};

function fakeScene() {
  const scene = { sys: { input: { enable: (go) => { go.input = { enabled: true }; } } } };
  const made = { zones: [] };
  const graphics = () => ({
    alive: true,
    clear() { if (!this.alive) throw new Error('clear() on a destroyed Graphics'); return this; },
    fillStyle() { return this; }, fillRoundedRect() { return this; },
    setDepth() { return this; }, destroy() { this.alive = false; },
  });
  scene.add = {
    graphics,
    zone() {
      const z = {
        scene, input: null, handlers: {},
        setOrigin() { return this; }, setDepth() { return this; },
        // Exactly Phaser's line: this.scene.sys.input.enable(this, ...)
        setInteractive() { this.scene.sys.input.enable(this); return this; },
        disableInteractive() { if (this.input) this.input.enabled = false; return this; },
        on(ev, fn) { this.handlers[ev] = fn; return this; },
        destroy() { this.scene = undefined; this.input = null; },
      };
      made.zones.push(z);
      return z;
    },
  };
  return { scene, made };
}

console.log('=== a scrollbar outliving its scene ===');
const { scene, made } = fakeScene();
let scroll = 0;
const bar = createScrollbar(scene, {
  x: 0, y: 0, height: 200,
  getScroll: () => scroll, getMax: () => 500,   // a long list: there IS something to scroll
  setScroll: (v) => { scroll = v; },
});
check('it builds and draws while the scene is alive', made.zones.length === 1);

// What Phaser's shutdown does to the display list when the overlay closes.
made.zones[0].destroy();

let thrown = null;
try { bar.refresh(); } catch (e) { thrown = e; }
check('refreshing it after the scene shut down does not throw',
  thrown === null, thrown ? thrown.message : 'no error');

console.log('');
console.log(failures ? `${failures} CHECK(S) FAILED` : 'ALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
