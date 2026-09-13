// tools/headless/diagnostics.mjs
//
// The diagnostics module must work in the environment it was written FOR.
//
// It exists because one player's browser would not persist anything, and the
// game could not tell anyone. So the case that matters most here is a
// localStorage that THROWS on every single access: the report has to come back
// anyway, because that is precisely when someone is being asked to run it. A
// diagnostic that dies in the broken environment is worse than none.
//
// Also guards the promise that keeps it safe to load at boot: nothing it does
// may throw, including with no window, no navigator and no storage at all.
//
// Run: node tools/headless/diagnostics.mjs

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};

/* ---------------- fake platform ---------------- */

function makeStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    __map: map,
  };
}

/** Storage that refuses everything — blocked site data, or a zero quota. */
function makeThrowingStore(name = 'SecurityError', msg = 'access denied') {
  const boom = () => { throw Object.assign(new Error(msg), { name }); };
  return {
    get length() { boom(); },
    key: boom, getItem: boom, setItem: boom, removeItem: boom,
  };
}

/** Quota-exhausted: writes are rejected but reads work. */
function makeFullStore(initial = {}) {
  const s = makeStore(initial);
  s.setItem = () => {
    throw Object.assign(new Error('exceeded the quota'), { name: 'QuotaExceededError' });
  };
  return s;
}

function installPlatform(store, { withWindow = true, withNavigator = true } = {}) {
  const def = (name, value) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

  def('localStorage', store);
  def('screen', { width: 1920, height: 1080 });
  def('location', { href: 'https://example.github.io/game/' });
  def('window', withWindow ? {
    innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1,
    addEventListener: (type, fn) => { (handlers[type] ||= []).push(fn); },
  } : undefined);
  def('navigator', withNavigator ? {
    userAgent: 'FakeBrowser/1.0', language: 'en-US',
    storage: { estimate: () => Promise.resolve({ usage: 1024, quota: 5 * 1024 * 1024 }) },
  } : undefined);
}

let handlers = {};

/**
 * A fresh copy of the module. ESM caches by URL, and the module holds state
 * (the probe result, the warned-once flag), so each scenario needs its own
 * instance -- exactly as a page reload would give.
 */
let gen = 0;
const freshModule = () => import(`../../src/systems/Diagnostics.js?v=${++gen}`);

/* ---------------- 1. healthy storage ---------------- */
console.log('=== healthy storage ===');
{
  handlers = {};
  installPlatform(makeStore());
  const D = await freshModule();
  D.install();

  check('probe reports storage writable', D.storageStatus().available === true,
    D.storageStatus().reason || 'no reason given, as expected');
  check('no warning is raised for a healthy browser',
    D.consumeStorageWarning() === null);
  check('bmDiag() was installed on window', typeof globalThis.window.bmDiag === 'function');
  check('an error listener was registered', (handlers.error || []).length === 1);
  check('a rejection listener was registered', (handlers.unhandledrejection || []).length === 1);

  const text = D.report();
  check('report says storage is writable', /writable\s*:\s*YES/.test(text));
  check('report is substantial, not a stub', text.length > 300, text.length + ' chars');
}

/* ---------------- 2. storage that throws on everything ---------------- */
console.log('=== blocked storage (the case this exists for) ===');
{
  handlers = {};
  installPlatform(makeThrowingStore());
  const D = await freshModule();

  let threw = null;
  try { D.install(); } catch (e) { threw = e; }
  check('install() does not throw when storage is blocked', threw === null,
    threw ? String(threw.message) : '');

  check('probe reports NOT writable', D.storageStatus().available === false);
  check('...and carries the browser reason', /SecurityError/.test(D.storageStatus().reason),
    D.storageStatus().reason);

  let text = null, reportThrew = null;
  try { text = D.report(); } catch (e) { reportThrew = e; }
  check('report() does NOT throw with storage blocked', reportThrew === null,
    reportThrew ? String(reportThrew.message) : '');
  check('report still produced real content', !!text && text.length > 200,
    (text ? text.length : 0) + ' chars');
  check('report generation did not bail out entirely',
    !!text && !/report generation failed/.test(text));
  check('report names storage as the problem', /writable\s*:\s*NO/.test(text || ''));

  // The one-time warning: fires once, then stays quiet forever.
  const first = D.consumeStorageWarning();
  const second = D.consumeStorageWarning();
  check('a warning IS raised when writes fail', typeof first === 'string' && first.length > 10,
    String(first));
  check('...and only once per page load', second === null);
}

/* ---------------- 3. quota exhausted ---------------- */
console.log('=== quota exhausted (reads fine, writes rejected) ===');
{
  handlers = {};
  installPlatform(makeFullStore({ bmSave_autosave: '{"version":3,"characters":[]}' }));
  const D = await freshModule();
  D.install();

  check('a full store is reported as NOT writable', D.storageStatus().available === false,
    D.storageStatus().reason);
  check('...naming the quota specifically', /QuotaExceeded/.test(D.storageStatus().reason));
  const text = D.report();
  check('the existing save is still listed despite the full store',
    /bmSave_autosave/.test(text));
}

/* ---------------- 4. save failures reach a listener ---------------- */
console.log('=== save failure notification ===');
{
  handlers = {};
  installPlatform(makeStore());
  const D = await freshModule();
  D.install();

  const seen = [];
  const off = D.onSaveError((e) => seen.push(e));
  D.noteSaveFailure('autosave', 'storage is full');
  check('a subscriber is notified of a failed save', seen.length === 1,
    JSON.stringify(seen[0] || null));
  check('...with the slot and the reason',
    seen[0]?.slot === 'autosave' && /full/.test(seen[0]?.why || ''));

  off();
  D.noteSaveFailure('autosave', 'again');
  check('unsubscribing actually stops delivery', seen.length === 1,
    seen.length + ' deliveries');

  // A throwing listener must not break the save path that called it.
  const offBad = D.onSaveError(() => { throw new Error('listener is broken'); });
  let threw = null;
  try { D.noteSaveFailure('slot1', 'why'); } catch (e) { threw = e; }
  check('a broken listener cannot break the caller', threw === null,
    threw ? String(threw.message) : '');
  offBad();

  const text = D.report();
  check('failures appear in the report', /save failures this session \(3\)/.test(text));
  check('...with their reasons', /storage is full/.test(text));
}

/* ---------------- 5. errors are captured for the report ---------------- */
console.log('=== error capture ===');
{
  handlers = {};
  installPlatform(makeStore());
  const D = await freshModule();
  D.install();

  // Fire through the real registered listener, not the recording function.
  handlers.error[0]({ message: 'Cannot read properties of undefined', filename: 'x.js', lineno: 42 });
  handlers.unhandledrejection[0]({ reason: new Error('a promise broke') });

  const text = D.report();
  check('a window error reaches the report', /Cannot read properties of undefined/.test(text));
  check('...with its location', /x\.js:42/.test(text));
  check('an unhandled rejection reaches the report', /a promise broke/.test(text));
  check('the error count is stated', /errors this session \(2\)/.test(text));
}

/* ---------------- 6. corrupt and healthy saves are told apart ---------------- */
console.log('=== save slot shapes ===');
{
  handlers = {};
  installPlatform(makeStore({
    bmSave_autosave: JSON.stringify({
      version: 3, characters: [{}, {}], partyIds: ['a'],
      progression: { questFlags: ['elseth_leader_handin'], completedScenarios: ['s1'] },
    }),
    bmSave_slot1: '{this is not json',
    dev_breakthrough: 'true',
    audioSettings: '{"master":0.5}',
    coop_last_code: 'ZQ7K',
  }));
  const D = await freshModule();
  D.install();
  const text = D.report();

  check('a healthy slot reports its version', /bmSave_autosave.*version=3/.test(text));
  check('...and its character count', /bmSave_autosave.*chars=2/.test(text));
  check('...and its quest flag count', /bmSave_autosave.*quests=1/.test(text));
  check('a corrupt slot is called corrupt', /bmSave_slot1.*UNPARSEABLE/.test(text));
  check('an active dev flag is visible', /dev_breakthrough = true/.test(text),
    'dev flags change real behaviour, so they belong in the report');
  check('save slots are not repeated in the other-keys list',
    (text.match(/bmSave_autosave/g) || []).length === 1);
  // Reports are pasted into chats; a live lobby code there lets a stranger join.
  check('a stored lobby code is listed as present', /coop_last_code = \(hidden\)/.test(text));
  check('...but the code itself appears nowhere in the report', !/ZQ7K/.test(text));
}

/* ---------------- 7. the persistence beacon ---------------- */
console.log('=== launch counter (catches private windows) ===');
{
  handlers = {};
  const store = makeStore();
  installPlatform(store);

  const D1 = await freshModule();
  D1.install();
  check('first launch is counted as 1', /launches\s*:\s*1/.test(D1.report()));
  check('...and reported as not yet kept', /beacon kept:\s*NO/.test(D1.report()));

  // Same store, fresh module = the same browser opened again.
  const D2 = await freshModule();
  D2.install();
  check('a second launch on persistent storage counts 2', /launches\s*:\s*2/.test(D2.report()));
  check('...and reports the beacon survived', /beacon kept:\s*yes/.test(D2.report()));

  // A private window or clear-on-exit profile: writes work, nothing survives.
  installPlatform(makeStore());
  const D3 = await freshModule();
  D3.install();
  check('a wiped store falls back to 1, which is the tell',
    /launches\s*:\s*1/.test(D3.report()));
  check('...and no warning is raised, since that is also a first run',
    D3.consumeStorageWarning() === null,
    'warning on a real first run would scare new players');
}

/* ---------------- 8. a hostile environment ---------------- */
console.log('=== no window, no navigator, no storage ===');
{
  handlers = {};
  installPlatform(undefined, { withWindow: false, withNavigator: false });
  const D = await freshModule();

  let threw = null;
  try { D.install(); } catch (e) { threw = e; }
  check('install() survives having no platform at all', threw === null,
    threw ? String(threw.message) : '');

  let text = null;
  try { text = D.report(); } catch (e) { threw = e; }
  check('report() survives it too', threw === null && typeof text === 'string',
    threw ? String(threw.message) : '');
  check('and still reports the storage verdict', /writable\s*:\s*NO/.test(text || ''));
}

/* ---------------- 9. live state provider ---------------- */
console.log('=== live state provider ===');
{
  handlers = {};
  installPlatform(makeStore());
  const D = await freshModule();
  D.install();

  D.setLiveStateProvider(() => ({ scene: 'TownScene', questFlags: ['a', 'b'] }));
  let text = D.report();
  check('live in-memory state is included', /scene\s*:\s*TownScene/.test(text));
  check('...and array values are readable', /questFlags\s*:\s*a, b/.test(text));

  // A provider that throws must not cost us the rest of the report.
  D.setLiveStateProvider(() => { throw new Error('provider exploded'); });
  text = D.report();
  check('a throwing provider does not sink the report',
    /provider exploded/.test(text) && /end of report/.test(text));
}

/* ---------------- 10. the real GameState.save() wiring ---------------- */
//
// Everything above tests the module in isolation. This tests the thing that
// actually broke: a save failing for real, and a listener hearing about it.
// Uses the CANONICAL module instance (no cache-buster), because that is the one
// GameState imports -- a `?v=N` copy would pass while the shipped wiring was
// dead, which is the exact class of mistake this project keeps hitting.
console.log('=== end to end through the real GameState.save() ===');
{
  handlers = {};
  installPlatform(makeThrowingStore('SecurityError', 'site data is blocked'));

  const { installPhaserStub } = await import('./phaserStub.js');
  installPhaserStub(11);

  const Diagnostics = (await import('../../src/systems/Diagnostics.js')).default;
  const GameState = (await import('../../src/systems/GameState.js')).default;

  const heard = [];
  const off = Diagnostics.onSaveError((e) => heard.push(e));

  let threw = null, result;
  try { result = GameState.save('autosave'); } catch (e) { threw = e; }

  check('save() does not throw when storage is blocked', threw === null,
    threw ? String(threw.message) : '');
  check('save() reports failure to its caller', result === false, 'returned ' + result);
  check('lastSaveError is set', typeof GameState.lastSaveError === 'string'
    && GameState.lastSaveError.length > 0, String(GameState.lastSaveError));
  check('the failure REACHED a listener (this is the actual fix)', heard.length === 1,
    JSON.stringify(heard[0] || null));
  check('...naming the slot that failed', heard[0]?.slot === 'autosave');
  check('...and it appears in the report', /slot=autosave/.test(Diagnostics.report()));
  off();

  // And a healthy store must still save, or the guard above would be hiding
  // a real regression in the normal path.
  installPlatform(makeStore());
  const ok = GameState.save('autosave');
  check('a healthy store still saves normally', ok === true, 'returned ' + ok);
  check('...and clears the previous error', GameState.lastSaveError === null,
    String(GameState.lastSaveError));
  check('...and the payload really landed in storage',
    typeof globalThis.localStorage.getItem('bmSave_autosave') === 'string',
    (globalThis.localStorage.getItem('bmSave_autosave') || '').slice(0, 40) + '...');
}

/* ---------------- 11. the default export is the real surface ---------------- */
//
// Every consumer does `import Diagnostics from ...`, so a function that exists
// as a named export but is missing from the default object does not exist to the
// game. That is not hypothetical: consumeStorageWarning was left out of it and
// crashed UIScene.create on boot, while every check above passed because they
// used the module NAMESPACE, where the named export was present and fine.
//
// So this compares the two surfaces directly, and calls each function the way
// the shipped code calls it.
console.log('=== default export matches the named exports ===');
{
  const ns = await import('../../src/systems/Diagnostics.js');
  const def = ns.default;

  const named = Object.keys(ns).filter(k => k !== 'default' && typeof ns[k] === 'function');
  const missing = named.filter(k => typeof def[k] !== 'function');
  check('every named function is on the default export', missing.length === 0,
    missing.length ? 'MISSING: ' + missing.join(', ') : named.length + ' functions');

  // The exact call sites that ship, through the default export only.
  const calls = {
    'UIScene.create': () => def.consumeStorageWarning(),
    'UIScene.create (onSaveError)': () => def.onSaveError(() => {})(),
    'GameState.save': () => def.noteSaveFailure('slot1', 'why'),
    'main.js boot': () => def.install(),
    'main.js provider': () => def.setLiveStateProvider(() => ({})),
    'bmDiag': () => def.report(),
    'storageStatus': () => def.storageStatus(),
    'noteError': () => def.noteError('error', 'x'),
  };
  for (const [where, fn] of Object.entries(calls)) {
    let threw = null;
    try { fn(); } catch (e) { threw = e; }
    check(`${where} works through the default export`, threw === null,
      threw ? String(threw.message) : 'ok');
  }
}

/* ---------------- 12. browser checks ---------------- */
//
// From the first real report: a LibreWolf player whose saves vanished on closing
// the browser. These checks describe the player's browser, so each must degrade
// to "unavailable" rather than throw where the platform lacks a feature.
console.log('=== browser checks ===');
{
  const fakeDocument = (measure) => ({
    createElement: () => ({ getContext: () => ({ font: '', measureText: measure }) }),
  });
  const stableMetrics = () => ({ width: 120.5, actualBoundingBoxAscent: 15.2, actualBoundingBoxDescent: 4.1 });
  let calls = 0;
  const noisyMetrics = () => ({ width: 120.5 + (calls++ * 0.37), actualBoundingBoxAscent: 15.2, actualBoundingBoxDescent: 4.1 });

  // No document at all (this is Node, and a stripped-down webview).
  handlers = {};
  installPlatform(makeStore());
  delete globalThis.document;
  {
    const D = await freshModule();
    D.install();
    let threw = null, text = '';
    try { text = D.report(); } catch (e) { threw = e; }
    check('the browser section never throws without a document', threw === null,
      threw ? String(threw.message) : '');
    check('...and says text measurement is unavailable', /text measurement\s*:\s*unavailable/.test(text));
    check('a real screen larger than the window is not flagged',
      /fingerprint protection:\s*not detected/.test(text), 'screen 1920x1080 vs window 1280x720');
  }

  // Stable measurement: nothing is interfering.
  Object.defineProperty(globalThis, 'document', { value: fakeDocument(stableMetrics), configurable: true, writable: true });
  {
    const D = await freshModule();
    D.install();
    const text = D.report();
    check('identical measurements read as OK', /text measurement\s*:\s*OK/.test(text),
      (text.match(/text measurement.*$/m) || [''])[0].trim());
  }

  // Noisy measurement: what a fingerprint-noise extension does to measureText.
  calls = 0;
  Object.defineProperty(globalThis, 'document', { value: fakeDocument(noisyMetrics), configurable: true, writable: true });
  {
    const D = await freshModule();
    D.install();
    const text = D.report();
    check('measurements that differ each call read as UNSTABLE', /text measurement\s*:\s*UNSTABLE/.test(text),
      (text.match(/text measurement.*$/m) || [''])[0].trim());
    check('...and the report explains what that breaks', /mis-size tooltips/.test(text));
  }

  // resistFingerprinting reports the window as the screen.
  Object.defineProperty(globalThis, 'document', { value: fakeDocument(stableMetrics), configurable: true, writable: true });
  {
    Object.defineProperty(globalThis, 'screen', { value: { width: 1920, height: 153 }, configurable: true, writable: true });
    globalThis.window.innerWidth = 1920;
    globalThis.window.innerHeight = 153;
    const D = await freshModule();
    D.install();
    const text = D.report();
    check('a screen exactly the size of the window is flagged',
      /fingerprint protection:\s*LIKELY ON/.test(text), 'the real LibreWolf report had screen=1920x153, window=1920x153');
  }

  // Which renderer the game runs on. A LibreWolf player's blank lists came from
  // the Canvas fallback, and nothing in the report said so.
  {
    const D = await freshModule();
    D.install();
    delete globalThis.sceneManager;
    check('no running game reports the renderer as unknown', /renderer\s*:\s*unknown/.test(D.report()));
    globalThis.sceneManager = { game: { renderer: { type: 1 } } };
    check('a Canvas game is reported as CANVAS, with the reason',
      /renderer\s*:\s*CANVAS \(the browser did not provide WebGL/.test(D.report()));
    globalThis.sceneManager = { game: { renderer: { type: 2 } } };
    check('a WebGL game is reported as WEBGL', /renderer\s*:\s*WEBGL/.test(D.report()));
    delete globalThis.sceneManager;
  }

  // Persistent storage state.
  {
    installPlatform(makeStore());
    globalThis.navigator.storage.persisted = () => Promise.resolve(false);
    const D = await freshModule();
    D.install();
    await new Promise(r => setTimeout(r, 5));   // persisted() resolves asynchronously
    check('an unpersisted store is reported as clearable',
      /persistent storage\s*:\s*not granted/.test(D.report()));
  }
  delete globalThis.document;
}

/* ---------------- 13. a refused clipboard write is not an error ---------------- */
//
// The real report arrived beside "Uncaught (in promise) DOMException: Clipboard
// write was blocked due to lack of user activation." writeText returns a
// promise, and try/catch does not catch a rejection. Firefox refuses clipboard
// writes from the console, so this happened on every Firefox-based browser.
console.log('=== refused clipboard write ===');
{
  handlers = {};
  installPlatform(makeStore());
  globalThis.navigator.clipboard = {
    writeText: () => Promise.reject(Object.assign(new Error('Clipboard write was blocked'), { name: 'NotAllowedError' })),
  };
  const D = await freshModule();
  D.install();

  let unhandled = 0;
  const onUnhandled = () => { unhandled++; };
  process.on('unhandledRejection', onUnhandled);

  let text = null, threw = null;
  try { text = globalThis.window.bmDiag(); } catch (e) { threw = e; }
  await new Promise(r => setTimeout(r, 20));   // let the rejection surface if it is going to
  process.off('unhandledRejection', onUnhandled);

  check('bmDiag() does not throw when the clipboard refuses', threw === null,
    threw ? String(threw.message) : '');
  check('...still returns the full report', typeof text === 'string' && /end of report/.test(text));
  check('...and the refusal is NOT an unhandled rejection', unhandled === 0,
    unhandled + ' unhandled rejection(s)');
  // Verified by reintroducing the bug: this check fails with 1 unhandled
  // rejection. A sibling check asserting the report showed zero errors was
  // removed because it passed WITH the bug present -- Node never dispatches the
  // fake window's unhandledrejection listener, so it could not fail.
}


console.log('\n' + (failures === 0
  ? 'ALL CHECKS PASSED'
  : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
