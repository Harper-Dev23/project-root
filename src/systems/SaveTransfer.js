// src/systems/SaveTransfer.js
//
// Moving a save out of the browser and back in, as a file.
//
// Saving writes to the browser's own storage, which lives in that one browser on
// that one computer. Some browsers erase it by design — LibreWolf clears site
// data when it closes, and Chrome's Incognito does the same — and the first real
// diagnostic report came from a player losing every save that way. A file on the
// player's disk is the one copy no browser setting can take away, and it is also
// how a save moves to another computer or another browser.
//
// SECURITY. Importing means reading a file someone else may have made, so:
//   - The file is parsed as JSON and never executed.
//   - `__proto__`, `constructor` and `prototype` keys are dropped while parsing,
//     so a crafted file cannot reach object prototypes through the load code.
//   - Size is capped before the file is even read.
//   - The save inside is then checked by GameState.checkSave, which runs the
//     real load path on a copy, before anything is written.
//   - An import never overwrites an existing save; it always gets a new slot.
// Player-entered text from a save (character names) is shown in Phaser text,
// never as HTML, which is what keeps a hostile name inert.
//
// The pure functions import nothing and touch no browser API, so the headless
// harness tests them directly. Only downloadTextFile and pickTextFile need a page.

/** Marks a file as ours, so a random JSON file is not mistaken for a save. */
export const EXPORT_FORMAT = 'behelith-save';

/**
 * The version of the FILE wrapper, not the save inside it (that carries its own
 * `version`, checked by GameState). Bump only when the wrapper's shape changes.
 * Kept to exactly what import needs today; new fields can be added later without
 * breaking older files, since readers ignore keys they do not know.
 */
export const EXPORT_FORMAT_VERSION = 1;

/**
 * Refuse anything larger. A real save is tens of KB; a whole browser's
 * localStorage is only about 5 MB, so a bigger file could not be stored anyway.
 */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Wraps a save payload for export. */
export function buildExport(slot, save, now = new Date()) {
  return {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt: now.toISOString(),
    slot: String(slot ?? ''),
    save,
  };
}

/**
 * A file name that is safe on every operating system: letters, digits, dashes
 * and underscores only, so a slot name can never introduce a path separator.
 */
export function exportFileName(slot, now = new Date()) {
  const safe = String(slot ?? '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'save';
  return `behelith-${safe}-${now.toISOString().slice(0, 10)}.json`;
}

/**
 * Reads the text of an imported file into a save payload.
 *
 * Accepts an exported file, or a bare save (the raw contents of a slot, which
 * is what someone copying from their browser's storage would have).
 * Returns { ok: true, save, slot } or { ok: false, reason } — reason is written
 * for the player, since it is shown on screen.
 *
 * This checks only that the file IS a save. Whether that save would load is
 * GameState.checkSave's job, so the two concerns cannot drift into one another.
 */
export function parseImport(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, reason: 'That file is empty.' };
  }
  if (text.length > MAX_IMPORT_BYTES) {
    return { ok: false, reason: 'That file is too large to be a save.' };
  }

  let data;
  try {
    // Returning undefined from a reviver deletes the key, so these never exist
    // as own properties on anything the load code later walks or copies.
    data = JSON.parse(text, (key, value) => (UNSAFE_KEYS.has(key) ? undefined : value));
  } catch {
    return { ok: false, reason: 'That file is not a save (it could not be read).' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reason: 'That file is not a save.' };
  }

  if (data.format === EXPORT_FORMAT) {
    if (!Number.isFinite(data.formatVersion)) {
      return { ok: false, reason: 'That save file is damaged (its format could not be read).' };
    }
    if (data.formatVersion > EXPORT_FORMAT_VERSION) {
      return { ok: false, reason: 'That save was exported by a newer version of the game.' };
    }
    if (!data.save || typeof data.save !== 'object' || Array.isArray(data.save)) {
      return { ok: false, reason: 'That file has no save inside it.' };
    }
    return { ok: true, save: data.save, slot: typeof data.slot === 'string' ? data.slot : null };
  }

  if (Array.isArray(data.characters)) {
    return { ok: true, save: data, slot: null };
  }
  return { ok: false, reason: 'That file is not a save.' };
}

/**
 * A slot name for an import that is guaranteed not to exist yet, so importing
 * can never overwrite a save the player already has.
 */
export function importSlotName(existingSlots = [], now = new Date()) {
  const taken = new Set(existingSlots);
  const base = `imported-${now.toISOString().slice(0, 10)}`;
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const name = `${base}-${i}`;
    if (!taken.has(name)) return name;
  }
}

/* ------------------------------------------------------------------ */
/* Browser-only helpers                                                */
/* ------------------------------------------------------------------ */

/** Offers `text` to the player as a downloaded file. Returns false without a page. */
export function downloadTextFile(fileName, text) {
  const doc = globalThis.document;
  if (!doc?.createElement || typeof Blob === 'undefined' || !globalThis.URL?.createObjectURL) return false;
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = doc.createElement('a');
  a.href = url;
  a.download = fileName;
  a.style.display = 'none';
  doc.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked after a delay rather than at once: Firefox needs the URL alive for a
  // moment after the click or the download silently fails.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return true;
}

/**
 * Opens the browser's file picker and resolves with { text, name }, or null if
 * the player cancels. Must be called from inside a click handler: browsers only
 * open a file picker in direct response to a user action. Phaser dispatches
 * pointer events synchronously from the DOM event, so a button callback counts.
 */
export function pickTextFile(accept = '.json,application/json') {
  return new Promise((resolve) => {
    const doc = globalThis.document;
    if (!doc?.createElement) return resolve(null);

    const input = doc.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    // Attached rather than clicked detached: some browsers ignore a click on a
    // file input that is not in the document.
    doc.body.appendChild(input);

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };

    input.addEventListener('cancel', () => finish(null), { once: true });
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return finish(null);
      if (file.size > MAX_IMPORT_BYTES) return finish({ tooLarge: true, name: file.name });
      try {
        finish({ text: await file.text(), name: file.name });
      } catch {
        finish({ unreadable: true, name: file.name });
      }
    }, { once: true });

    input.click();
  });
}

export default {
  EXPORT_FORMAT, EXPORT_FORMAT_VERSION, MAX_IMPORT_BYTES,
  buildExport, exportFileName, parseImport, importSlotName,
  downloadTextFile, pickTextFile,
};
