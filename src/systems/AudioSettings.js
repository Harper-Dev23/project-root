// src/systems/AudioSettings.js
// Persisted master/music/effects volume sliders, used by SoundManager.
// Values are 0..1. Stored flat in localStorage (same convention as
// ProgressionManager's dev bypass flag) so they survive page reloads.

const STORAGE_KEY = 'audioSettings';

const DEFAULTS = {
  master: 1,
  music: 0.6,
  sfx: 1,
};

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return {
      master: clamp(parsed.master, DEFAULTS.master),
      music: clamp(parsed.music, DEFAULTS.music),
      sfx: clamp(parsed.sfx, DEFAULTS.sfx),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function clamp(v, fallback) {
  return typeof v === 'number' && v >= 0 && v <= 1 ? v : fallback;
}

let _values = load();
const _listeners = new Set();

export const AudioSettings = {
  get master() { return _values.master; },
  get music() { return _values.music; },
  get sfx() { return _values.sfx; },

  set(key, value) {
    if (!(key in DEFAULTS)) return;
    _values[key] = clamp(value, DEFAULTS[key]);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(_values));
    _listeners.forEach(fn => fn(_values));
  },

  // Final volume to hand to a Phaser sound, given that effect/track's base volume.
  sfxVolume(base) {
    return base * _values.sfx * _values.master;
  },

  musicVolume(base) {
    return base * _values.music * _values.master;
  },

  /** Subscribe to any volume change. Returns an unsubscribe function. */
  onChange(fn) {
    _listeners.add(fn);
    return () => _listeners.delete(fn);
  },
};
