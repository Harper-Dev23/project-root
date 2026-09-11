// tools/headless/sound.mjs
//
// The same sound fired several times in one instant must play once.
//
// An AoE skill runs the whole ability once per target, all in the same frame,
// and each run plays its own hit sound -- so five targets meant five copies of
// one sample summed on top of each other. That is what made AoE hits so loud.
// Different sounds in the same instant must still each play, and the same
// sound a moment later must play again, or separate strikes would go silent.
//
// Counts real calls to the engine's sound.play through a fake scene.
//
// Run: node tools/headless/sound.mjs

import { installPhaserStub } from './phaserStub.js';
installPhaserStub(3);
const { SoundManager } = await import('../../src/systems/SoundManager.js');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};

const played = [];
SoundManager.init({
  sound: { play: (key) => { played.push(key); } },
  cache: { audio: { has: () => true } },
});

console.log('=== stacked sounds ===');
for (let i = 0; i < 5; i++) SoundManager.play('hitHurt');
check('five identical hits in one instant play once', played.length === 1, played.length + ' plays');

played.length = 0;
SoundManager.play('critHurt');
SoundManager.play('bumpHurt');
check('different sounds in the same instant each still play', played.length === 2, played.length + ' plays');

played.length = 0;
await new Promise(r => setTimeout(r, 150));
SoundManager.play('hitHurt');
check('the same sound a moment later plays again', played.length === 1, played.length + ' plays');

console.log('');
console.log(failures ? `${failures} CHECK(S) FAILED` : 'ALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
