// src/systems/Diagnostics.js
//
// What to ask a player for when the game misbehaves for THEM and nobody else.
//
// This exists because of a real support case: one player hit save failures,
// purchases that did not stick, gambles that ate a ticket, and quest markers
// that walked backwards, while every other player was fine. Every one of those
// symptoms shares a possible root cause -- localStorage writes not landing --
// and the game could not tell anyone, because GameState.save() catches the
// throw, sets `lastSaveError`, and returns false. Nothing ever read that field.
//
// Two jobs:
//   1. Record what a player cannot see: storage failures and thrown errors.
//   2. Print it as one block of text they can paste into a chat.
//
// DESIGN RULES, both load-bearing:
//
// - ZERO project imports. GameState imports THIS file, so importing GameState
//   (or anything that reaches it) back would be a cycle. Everything here is
//   read straight from the platform. Same reasoning as boardGeometry.js.
//
// - NOTHING HERE MAY THROW. This is diagnostic code running in the boot path
//   and inside an existing catch block. A diagnostic that takes the game down
//   is worse than no diagnostic, so every function is wrapped and every
//   platform access is optional-chained. Read that as deliberate, not timid.
//
// The report deliberately describes what is *persisted*, not what is in memory.
// The bug being hunted IS the gap between the two.

const MAX_ERRORS        = 25;   // ring buffer; a boot loop must not eat memory
const MAX_SAVE_FAILURES = 25;
const MAX_KEYS_LISTED   = 40;

const BEACON_KEY = 'bm_diag_beacon';

// Storage keys whose VALUES never appear in a report. See describeKeys.
const REDACTED_KEYS = new Set(['coop_last_code']);
const PROBE_KEY  = 'bm_diag_probe';

let _installed    = false;
let _errors       = [];
let _saveFailures = [];
let _storage      = null;   // cached result of the boot-time probe
let _beacon       = null;   // cached beacon state read at boot
let _quota        = null;   // cached navigator.storage.estimate()
let _persisted    = null;   // cached navigator.storage.persisted()
let _liveState    = null;   // optional provider, registered by main.js

const _saveErrorSubs = new Set();

// Everything platform-side is reached through globalThis, never as a bare
// identifier. `screen?.width` looks safe but throws ReferenceError when the
// global is absent entirely, and optional chaining does NOT catch that -- which
// would sink the whole report in exactly the unusual environment worth a report.
const G = () => globalThis;

/* ------------------------------------------------------------------ */
/* Storage probe                                                       */
/* ------------------------------------------------------------------ */

/**
 * Can this browser actually keep a value? Writes, reads it back, removes it.
 *
 * A read-back check rather than just "setItem did not throw", because a
 * quota-exhausted or shimmed store can accept a write and hand back nothing.
 */
function probeStorage() {
  const out = { available: false, reason: '' };
  try {
    if (typeof localStorage === 'undefined' || !localStorage) {
      out.reason = 'localStorage is not available in this context';
      return out;
    }
    localStorage.setItem(PROBE_KEY, '1');
    const back = localStorage.getItem(PROBE_KEY);
    localStorage.removeItem(PROBE_KEY);
    if (back !== '1') {
      out.reason = 'a write succeeded but read back the wrong value';
      return out;
    }
    out.available = true;
  } catch (e) {
    // The interesting case. Blocked site data and a zero quota both land here.
    out.reason = `${e?.name || 'Error'}: ${e?.message || e}`;
  }
  return out;
}

/**
 * Boot counter that survives only if storage really persists.
 *
 * This is how the *ephemeral* case gets caught. A private window, and a browser
 * set to clear site data on exit, both let every write succeed -- so no probe
 * can see them -- but neither can carry a counter from one launch to the next.
 * A report showing launches=1 from someone who has played for days is the tell.
 *
 * Deliberately does NOT drive any in-game warning: a missing beacon is also
 * what a genuine first run looks like, and a false "your saves are broken"
 * toast aimed at new players would be worse than the bug it warns about.
 */
function readBeacon(available) {
  const out = { survived: null, boots: null, firstSeen: null };
  if (!available) return out;
  try {
    const raw = localStorage.getItem(BEACON_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) || {};
      out.survived  = true;
      out.boots     = (parsed.boots | 0) + 1;
      out.firstSeen = parsed.firstSeen || null;
    } else {
      // Either a first run or storage was wiped. The report says which is
      // likely by printing whether save slots exist alongside this.
      out.survived  = false;
      out.boots     = 1;
      out.firstSeen = new Date().toISOString();
    }
    localStorage.setItem(BEACON_KEY, JSON.stringify({
      boots: out.boots, firstSeen: out.firstSeen
    }));
  } catch { /* diagnostics must never be the thing that breaks */ }
  return out;
}

/* ------------------------------------------------------------------ */
/* Recording                                                           */
/* ------------------------------------------------------------------ */

function pushCapped(arr, entry, cap) {
  arr.push(entry);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
}

/** A thrown error the player would only have seen by opening the console. */
export function noteError(kind, message, extra = {}) {
  try {
    pushCapped(_errors, {
      at: new Date().toISOString(),
      kind,
      message: String(message ?? '').slice(0, 400),
      where: extra.where || '',
      stack: (extra.stack || '').split('\n').slice(0, 3).join(' | ')
    }, MAX_ERRORS);
  } catch { /* ignore */ }
}

/**
 * Called from GameState.save()'s existing catch block.
 *
 * Also notifies subscribers, which is what finally puts a failed save in front
 * of the player instead of only in the console.
 */
export function noteSaveFailure(slot, why) {
  try {
    pushCapped(_saveFailures, {
      at: new Date().toISOString(),
      slot: String(slot ?? '?'),
      why: String(why ?? '')
    }, MAX_SAVE_FAILURES);
  } catch { /* ignore */ }
  for (const fn of [..._saveErrorSubs]) {
    try { fn({ slot, why }); }
    catch (e) { console.error('Diagnostics save-error listener threw', e); }
  }
}

/**
 * Subscribe to save failures. Returns an unsubscribe function, matching
 * JournalState.on() -- UIScene stores the handle and calls it on shutdown,
 * because scenes are reused and a leaked listener would fire on a dead scene.
 */
export function onSaveError(fn) {
  if (typeof fn !== 'function') return () => {};
  _saveErrorSubs.add(fn);
  return () => _saveErrorSubs.delete(fn);
}

/** Lets main.js expose live in-memory state without this module importing it. */
export function setLiveStateProvider(fn) {
  if (typeof fn === 'function') _liveState = fn;
}

/** Storage status for callers that want to warn. Probed once at install. */
export function storageStatus() {
  if (!_storage) _storage = probeStorage();
  return _storage;
}

/**
 * The one-time "your browser will not keep this" warning, or null.
 *
 * Lives here rather than in the UI because UIScene is created and destroyed
 * repeatedly as scenes change, so a flag held there would re-warn on every
 * town visit. This returns a message at most once per page load.
 *
 * Only fires when a write genuinely FAILS. It stays silent for private windows
 * and clear-on-exit profiles, where writes succeed and only vanish later --
 * those are undetectable without guessing, and guessing would mean warning
 * innocent players. The `launches` counter in report() is how those get caught.
 */
let _warned = false;
export function consumeStorageWarning() {
  if (_warned) return null;
  const st = storageStatus();
  if (st.available) return null;
  _warned = true;
  return 'Your browser is blocking saved data - progress will NOT be saved.';
}

/* ------------------------------------------------------------------ */
/* Install                                                             */
/* ------------------------------------------------------------------ */

/**
 * Called from boot BEFORE Phaser starts, so an error thrown during scene
 * construction is captured too.
 */
export function install() {
  if (_installed) return;
  _installed = true;
  try {
    _storage = probeStorage();
    _beacon  = readBeacon(_storage.available);

    // Quota is a promise, and report() must stay synchronous so it can be
    // called from a console one-liner. Resolve it now, print whatever arrived.
    try {
      G().navigator?.storage?.estimate?.().then(est => { _quota = est; }).catch(() => {});
    } catch { /* not supported */ }
    try {
      G().navigator?.storage?.persisted?.().then(p => { _persisted = p; }).catch(() => {});
    } catch { /* not supported */ }

    G().window?.addEventListener?.('error', (ev) => {
      noteError('error', ev?.message || ev?.error?.message || 'unknown', {
        where: `${ev?.filename || '?'}:${ev?.lineno ?? '?'}`,
        stack: ev?.error?.stack || ''
      });
    });
    G().window?.addEventListener?.('unhandledrejection', (ev) => {
      const r = ev?.reason;
      noteError('promise', r?.message || r || 'unknown', { stack: r?.stack || '' });
    });

    if (!_storage.available) {
      console.warn(`[Diagnostics] Browser storage is NOT writable - ${_storage.reason}. `
        + 'Saving will fail. Run bmDiag() for a full report.');
    }

    // The whole point: one thing to type, one block to paste back.
    if (G().window) {
      G().window.bmDiag = () => {
        const text = report();
        console.log(text);
        // writeText returns a PROMISE, and a rejected promise is not caught by
        // try/catch -- the first real report from a player arrived with an
        // "Uncaught (in promise) DOMException" beside it. Firefox refuses a
        // clipboard write from the console outright, since typing a command is
        // not a user gesture, so this fails on every Firefox-based browser. It
        // was also recorded by this module's own unhandledrejection listener,
        // which would have listed the diagnostic's failure as the player's.
        try {
          G().navigator?.clipboard?.writeText?.(text)?.catch?.(() => {});
        } catch { /* the printed report is enough */ }
        return text;
      };
    }
  } catch (e) {
    console.warn('[Diagnostics] install failed (non-fatal):', e);
  }
}

/* ------------------------------------------------------------------ */
/* Report                                                             */
/* ------------------------------------------------------------------ */

function bytes(n) {
  if (!Number.isFinite(n)) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** Save slots as they exist ON DISK, with just enough shape to spot a bad one. */
function describeSlots() {
  const rows = [];
  let total = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const raw = localStorage.getItem(key) || '';
      total += key.length + raw.length;
      if (!key.startsWith('bmSave_')) continue;
      let shape = 'UNPARSEABLE (corrupt)';
      try {
        const d = JSON.parse(raw);
        shape = `version=${d?.version ?? 'absent'} chars=${d?.characters?.length ?? '?'} `
              + `party=${d?.partyIds?.length ?? '?'} `
              + `quests=${d?.progression?.questFlags?.length ?? '?'} `
              + `scenarios=${d?.progression?.completedScenarios?.length ?? '?'}`;
      } catch { /* leave as corrupt */ }
      rows.push(`  ${key}  ${bytes(raw.length)}  ${shape}`);
    }
  } catch (e) {
    rows.push(`  (could not enumerate: ${e?.message || e})`);
  }
  return { rows, total };
}

function describeKeys() {
  const rows = [];
  try {
    const names = [];
    for (let i = 0; i < localStorage.length; i++) names.push(localStorage.key(i));
    names.sort();
    let shown = 0;
    for (const k of names) {
      if (k.startsWith('bmSave_')) continue;   // already detailed above
      if (shown >= MAX_KEYS_LISTED) { rows.push('  ...more keys not listed'); break; }
      const v = localStorage.getItem(k) || '';
      // Reports get pasted into chats. A lobby code there lets anyone who reads
      // it join that lobby while it is still open, so it is shown as present but
      // never printed. Its presence is the useful fact; the code itself is not.
      if (REDACTED_KEYS.has(k)) {
        rows.push(`  ${k} = (hidden)`);
        continue;
      }
      // Dev flags change real game behaviour, so show short values in full.
      rows.push(`  ${k} = ${v.length <= 32 ? v : `${bytes(v.length)} of data`}`);
      shown++;
    }
  } catch (e) {
    rows.push(`  (could not enumerate: ${e?.message || e})`);
  }
  return rows;
}

/**
 * Browser behaviour that changes what the game can do, and that a player
 * cannot be expected to know about their own setup.
 *
 * Written after a LibreWolf report. LibreWolf clears site data when it closes,
 * enables resistFingerprinting, and hosts extensions that intercept browser
 * APIs -- that report's stack ran through injected functions named
 * installTraps and reflect at lines of index.html that do not exist.
 *
 * TEXT MEASUREMENT is the check that matters for gameplay. Phaser sizes every
 * Text object from measureText's bounding box; a tooltip's background is drawn
 * to that size. An anti-fingerprinting extension that adds noise to
 * measureText would make the same string measure differently each time, which
 * is how a description box could come out mis-sized or invisible. So the same
 * string is measured repeatedly: identical results mean nothing is interfering.
 *
 * Deliberately NO pixel readback (getImageData) here. In LibreWolf that raises
 * the canvas permission prompt, and this game never reads pixels back --
 * nothing here needs an answer to it. Asking a player to approve a prompt in
 * order to diagnose them would change the very thing being diagnosed.
 */
function browserSection() {
  const L = [];

  // Which of Phaser's two renderers the game is running on. This was the missing
  // fact behind a LibreWolf player's blank Skills, vendor and Stash lists: the
  // browser withheld WebGL, Phaser fell back to Canvas, and Canvas draws nothing
  // for a mask built from a Rectangle (see src/ui/masks.js). Every report from
  // that player looked healthy, because nothing here said which renderer was in
  // use. Read through the global sceneManager so this file still imports nothing.
  try {
    const type = G().sceneManager?.game?.renderer?.type;
    const P = G().Phaser;
    const name = type == null ? null
      : type === (P?.CANVAS ?? 1) ? 'CANVAS'
        : type === (P?.WEBGL ?? 2) ? 'WEBGL'
          : `type ${type}`;
    L.push(`renderer               : ${name === 'CANVAS'
      ? 'CANVAS (the browser did not provide WebGL; some visuals differ)'
      : name || 'unknown (the game has not started)'}`);
  } catch { L.push('renderer               : unknown'); }

  // resistFingerprinting reports the WINDOW as the screen. A real display is
  // essentially never exactly the size of the browser's content area.
  try {
    const w = G().window, s = G().screen;
    if (w && s && Number.isFinite(s.width) && s.width > 0) {
      const same = s.width === w.innerWidth && s.height === w.innerHeight;
      L.push(`fingerprint protection: ${same
        ? 'LIKELY ON (screen reports the window size)'
        : 'not detected'}`);
    } else {
      L.push('fingerprint protection: unknown');
    }
  } catch { L.push('fingerprint protection: unknown'); }

  L.push(`persistent storage     : ${_persisted === true ? 'granted'
    : _persisted === false ? 'not granted (the browser may clear it)' : 'unknown'}`);

  try {
    const doc = G().document;
    const canvas = doc?.createElement?.('canvas');
    const ctx = canvas?.getContext?.('2d');
    if (!ctx || typeof ctx.measureText !== 'function') {
      L.push('text measurement       : unavailable');
    } else {
      ctx.font = '20px Georgia, serif';
      const runs = [];
      for (let i = 0; i < 4; i++) runs.push(ctx.measureText('Hg Description'));
      const first = runs[0];
      if (!('actualBoundingBoxAscent' in first)) {
        L.push(`text measurement       : no bounding box (width ${first.width?.toFixed?.(2)})`);
      } else {
        const sig = (m) => [m.width, m.actualBoundingBoxAscent, m.actualBoundingBoxDescent]
          .map(v => (+v).toFixed(3)).join('/');
        const sigs = runs.map(sig);
        const stable = sigs.every(x => x === sigs[0]);
        const ascent = +first.actualBoundingBoxAscent;
        const sane = ascent > 0 && ascent < 100;
        L.push(`text measurement       : ${stable && sane ? 'OK' : stable ? 'IMPLAUSIBLE' : 'UNSTABLE'}`
          + `  (w ${(+first.width).toFixed(2)}, ascent ${ascent.toFixed(2)})`);
        if (!stable) {
          L.push('    the same text measured differently each time -- something is altering');
          L.push('    measureText, which would mis-size tooltips and description boxes');
          L.push('    samples: ' + sigs.join('  '));
        }
      }
    }
  } catch (e) {
    L.push(`text measurement       : error (${e?.message || e})`);
  }
  return L;
}

/**
 * One pasteable block of text. Synchronous and never throws, so it works from
 * a console one-liner even when the game itself is broken.
 */
export function report() {
  const L = [];
  try {
    const st = storageStatus();
    L.push("===== Behel'ith diagnostic report =====");
    L.push(`when    : ${new Date().toISOString()}`);
    L.push(`url     : ${G().location?.href || '?'}`);
    L.push(`agent   : ${G().navigator?.userAgent || '?'}`);
    L.push(`window  : ${G().window?.innerWidth}x${G().window?.innerHeight}`
         + `  dpr=${G().window?.devicePixelRatio}`
         + `  screen=${G().screen?.width}x${G().screen?.height}`);
    L.push('');

    L.push('--- storage ---');
    L.push(`writable   : ${st.available ? 'YES' : `NO  (${st.reason})`}`);
    if (_beacon) {
      L.push(`launches   : ${_beacon.boots ?? '?'}   first seen: ${_beacon.firstSeen || '?'}`);
      L.push(`beacon kept: ${_beacon.survived === null ? '?'
        : _beacon.survived ? 'yes' : 'NO (first run, or site data was cleared)'}`);
    }
    if (_quota) L.push(`quota      : ${bytes(_quota.usage)} used of ${bytes(_quota.quota)}`);

    const { rows, total } = describeSlots();
    L.push(`total size : ${bytes(total)}  (the limit is about 5 MB per site)`);
    L.push('save slots :');
    L.push(rows.length ? rows.join('\n') : '  (none - no saves on this machine)');
    L.push('other keys :');
    L.push(describeKeys().join('\n') || '  (none)');
    L.push('');

    L.push('--- browser ---');
    L.push(browserSection().join('\n'));
    L.push('');

    if (_liveState) {
      L.push('--- live state (in memory, may be ahead of what is saved) ---');
      try {
        const s = _liveState() || {};
        for (const [k, v] of Object.entries(s)) {
          L.push(`${String(k).padEnd(11)}: ${Array.isArray(v) ? (v.join(', ') || '(none)') : String(v)}`);
        }
      } catch (e) {
        L.push(`  (provider threw: ${e?.message || e})`);
      }
      L.push('');
    }

    L.push(`--- save failures this session (${_saveFailures.length}) ---`);
    L.push(_saveFailures.length
      ? _saveFailures.map(f => `  ${f.at}  slot=${f.slot}  ${f.why}`).join('\n')
      : '  none');
    L.push('');

    L.push(`--- errors this session (${_errors.length}${_errors.length === MAX_ERRORS ? ', capped' : ''}) ---`);
    L.push(_errors.length
      ? _errors.map(e => `  ${e.at}  [${e.kind}] ${e.message}`
          + `\n      at ${e.where}${e.stack ? `\n      ${e.stack}` : ''}`).join('\n')
      : '  none');
    L.push('');
    L.push('===== end of report =====');
  } catch (e) {
    L.push(`(report generation failed: ${e?.message || e})`);
  }
  return L.join('\n');
}

// Every consumer imports the DEFAULT (`import Diagnostics from ...`), so a
// function missing from this object does not exist as far as the game is
// concerned -- however correct its named export is. consumeStorageWarning was
// left out of exactly this list and crashed UIScene.create on boot, while the
// tests kept passing because they called it off the module namespace instead.
// tools/headless/diagnostics.mjs now asserts this object matches the named
// exports, so the next one cannot slip through the same gap.
export default {
  install, report, noteError, noteSaveFailure, onSaveError,
  setLiveStateProvider, storageStatus, consumeStorageWarning
};
