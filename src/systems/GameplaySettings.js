// src/systems/GameplaySettings.js
// Persisted gameplay toggles. Same convention as AudioSettings.js (flat
// localStorage, live-reactive listeners) — currently just Quick Combat, the
// on/off switch for how fast attack VFX/multi-hit pacing plays.

const STORAGE_KEY = 'gameplaySettings';

const DEFAULTS = {
  // Default OFF — attack VFX/multi-hit pacing plays at the slower, more
  // readable "cinematic" pace (see animDurationMult below) so new players
  // and testers actually see the animations land. Quick Combat opts back
  // into the snappier pace every VFX/pacing value was originally tuned at.
  quickCombat: false,
};

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return {
      quickCombat: typeof parsed.quickCombat === 'boolean' ? parsed.quickCombat : DEFAULTS.quickCombat,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

let _values = load();
const _listeners = new Set();

export const GameplaySettings = {
  get quickCombat() { return _values.quickCombat; },

  set(key, value) {
    if (!(key in DEFAULTS)) return;
    _values[key] = value;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(_values));
    _listeners.forEach(fn => fn(_values));
  },

  // Multiplier applied to attack-VFX tween durations and the multi-hit
  // stagger delays (poison ticks, Volley echo, repeat hits, rune-channel
  // recast, NPC action-loop pauses) — NOT general turn-flow delays (AI
  // "thinking" pause, skip-turn messaging), which are a separate concern
  // from "can I see this hit land." 1 = Quick Combat (every duration/delay
  // stays exactly as originally tuned this session). 4 = the slower
  // default — was 2.25, then 5 (too subtle, then whole NPC turns ran a
  // touch long once the action-loop delays got scaled too); trying 4 first
  // before selectively exempting any of the now-scaled delays.
  animDurationMult() {
    return _values.quickCombat ? 1 : 4;
  },

  /** Subscribe to any setting change. Returns an unsubscribe function. */
  onChange(fn) {
    _listeners.add(fn);
    return () => _listeners.delete(fn);
  },
};
