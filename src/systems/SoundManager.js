// src/systems/SoundManager.js
// Central audio manager.
// Call SoundManager.init(scene) in each scene's create().
// Call SoundManager.play('select') etc. anywhere after that.

export const AUDIO_MANIFEST = [
  { id: 'select',    file: 'select.wav',    volume: 0.5 },
  { id: 'dullClick', file: 'dullClick.wav', volume: 0.3 },
  { id: 'dirtClick', file: 'dirtClick.wav', volume: 0.35 },
  { id: 'reward',    file: 'reward.wav',    volume: 0.6 },
  { id: 'hitHurt',   file: 'hitHurt.wav',   volume: 0.5 },
  { id: 'critHurt',  file: 'critHurt.wav',  volume: 0.55 },
  { id: 'hugeHit',   file: 'hugeHit.wav',   volume: 0.6 },
  { id: 'bumpHurt',  file: 'bumpHurt.wav',  volume: 0.45 },
  { id: 'burnHurt',  file: 'burnHurt.wav',  volume: 0.5 },
  { id: 'snekHurt',  file: 'snekHurt.wav',  volume: 0.5 },
  { id: 'hiss',      file: 'hiss.wav',      volume: 0.45 },
  { id: 'screech',   file: 'screech.wav',   volume: 0.5 },
  { id: 'explosion', file: 'explosion.wav', volume: 0.6 },
  { id: 'projFire',  file: 'projFire.wav',  volume: 0.5 },
  { id: 'gamble',    file: 'gamble.wav',    volume: 0.5 },
  { id: 'huh',        file: 'huh.wav',        volume: 0.4 },
  { id: 'handsClick', file: 'handsClick.wav', volume: 0.45 },
];

// Map id → { key, volume } for fast lookup
const SOUNDS = Object.fromEntries(
  AUDIO_MANIFEST.map(s => [s.id, { key: `sfx_${s.id}`, volume: s.volume }])
);

let _scene = null;

export const SoundManager = {
  init(scene) {
    _scene = scene;
  },

  play(id) {
    const cfg = SOUNDS[id];
    if (!cfg || !_scene?.sound) return;
    if (!_scene.cache.audio.has(cfg.key)) return;
    _scene.sound.play(cfg.key, { volume: cfg.volume });
  },

  /**
   * Wire an "empty area" click sound onto a scene.
   * Plays `soundId` whenever the player clicks somewhere with no interactive
   * object underneath — i.e. any dead-zone / background click.
   *
   * Call once in the scene's create():
   *   SoundManager.wireEmptyClick(this, 'dullClick');
   */
  wireEmptyClick(scene, soundId) {
    scene.input.on('pointerdown', (pointer) => {
      const hits = scene.input.hitTestPointer(pointer);
      if (!hits || hits.length === 0) {
        SoundManager.play(soundId);
      }
    });
  },
};
