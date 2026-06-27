// src/systems/SoundManager.js
// Central audio manager.
// Call SoundManager.init(scene) in each scene's create().
// Call SoundManager.play('select') etc. anywhere after that.

import { AudioSettings } from './AudioSettings.js';

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
  { id: 'gamble',      file: 'gamble.wav',      volume: 0.5 },
  { id: 'gambleEpic',  file: 'gambleEpic.wav',  volume: 0.65 },
  { id: 'huh',        file: 'huh.wav',        volume: 0.4 },
  { id: 'handsClick',   file: 'handsClick.wav',   volume: 0.45 },
  { id: 'bonfireLoop',  file: 'bonfire_loop.mp3', volume: 0.3  },
];

// Music tracks — looping background songs, separate from one-shot SFX above.
// Loaded as [ogg, mp3] pairs so Phaser/the browser picks whichever codec it supports.
export const MUSIC_MANIFEST = [
  { id: 'behelithStartScreen', file: 'Behelith_Start_Screen', volume: 0.6 },
  { id: 'fairySong',           file: 'Fairy_Song',            volume: 0.6 },
  { id: 'mourneTheme',         file: 'Mourne_Theme',          volume: 0.6 },
];

// Map id → { key, volume } for fast lookup
const SOUNDS = Object.fromEntries(
  AUDIO_MANIFEST.map(s => [s.id, { key: `sfx_${s.id}`, volume: s.volume }])
);

const TRACKS = Object.fromEntries(
  MUSIC_MANIFEST.map(m => [m.id, { key: `music_${m.id}`, volume: m.volume }])
);

let _scene = null;
let _currentMusic = null;
let _currentMusicVolume = 0;
let _unsubscribeVolume = null;

/**
 * Ramps a WebAudio sound's gain on the AudioContext's own clock, not Phaser's
 * render-loop tween clock. This matters because the browser keeps the
 * AudioContext suspended until a user gesture unlocks it — a Phaser tween
 * (driven by requestAnimationFrame) can run to completion before the context
 * actually starts producing sound, making the fade inaudible. Scheduling the
 * ramp on the gain node itself means it simply waits for the context to
 * start ticking and then plays out correctly, every time.
 *
 * `fromValue` is the explicit ramp start (always 0 for our fade-ins) rather
 * than reading the node's current `.value` — Phaser's own applyConfig() also
 * writes to this gain via setValueAtTime right before we get here, and
 * browsers don't reliably reflect that write back through `.value` in the
 * same tick, which made the "fade" silently start from the node's stale
 * pre-config default (1) instead of 0.
 */
function _rampVolume(sound, target, ms, fromValue = 0) {
  const gain = sound?.volumeNode?.gain;
  const ctx = sound?.manager?.context;
  if (!gain || !ctx) {
    sound?.setVolume?.(target); // HTML5 Audio fallback — no gain node to ramp
    return;
  }
  const now = ctx.currentTime;
  gain.cancelScheduledValues(now);
  if (ms > 0) {
    gain.setValueAtTime(fromValue, now);
    gain.linearRampToValueAtTime(target, now + ms / 1000);
  } else {
    gain.setValueAtTime(target, now);
  }
}

export const SoundManager = {
  init(scene) {
    _scene = scene;

    // Keep currently-playing music in sync with live slider changes.
    _unsubscribeVolume?.();
    _unsubscribeVolume = AudioSettings.onChange(() => {
      if (_currentMusic) {
        // Cancels any in-flight fade ramp and jumps straight to the new value —
        // a slider drag should feel immediate, not eased.
        _rampVolume(_currentMusic, AudioSettings.musicVolume(_currentMusicVolume), 0);
      }
    });
  },

  play(id) {
    const cfg = SOUNDS[id];
    if (!cfg || !_scene?.sound) return;
    if (!_scene.cache.audio.has(cfg.key)) return;
    _scene.sound.play(cfg.key, { volume: AudioSettings.sfxVolume(cfg.volume) });
  },

  /**
   * Plays a looping background music track, stopping whatever was playing before.
   * Fades in from silence over `fadeMs` so it doesn't start abruptly.
   * Call SoundManager.playMusic('fairySong') from a scene's create().
   */
  playMusic(id, { loop = true, fadeMs = 1000 } = {}) {
    const cfg = TRACKS[id];
    if (!cfg || !_scene?.sound) return;
    if (!_scene.cache.audio.has(cfg.key)) return;

    if (_currentMusic) {
      _currentMusic.stop();
      _currentMusic.destroy();
    }

    _currentMusicVolume = cfg.volume;
    const targetVolume = AudioSettings.musicVolume(cfg.volume);

    const track = _scene.sound.add(cfg.key, { loop, volume: 0 });
    _currentMusic = track;
    track.play();
    _rampVolume(track, targetVolume, fadeMs);

    return track;
  },

  stopMusic() {
    if (_currentMusic) {
      _currentMusic.stop();
      _currentMusic.destroy();
      _currentMusic = null;
    }
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
