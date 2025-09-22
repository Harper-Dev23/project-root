// EventFlags.js
// Tracks boolean and counter-based state flags

const flags = {};

export function setFlag(key, value) {
  flags[key] = value;
}

export function getFlag(key) {
  return flags[key] || false;
}
