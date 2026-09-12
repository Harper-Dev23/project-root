// tools/headless/savetransfer.mjs
//
// A save must survive leaving the browser and coming back, and a hostile file
// must not get in.
//
// Export/import exists because some browsers erase saved data by design
// (LibreWolf on close, Chrome Incognito), and because a player should be able to
// move to another computer. The test that matters is the round trip through the
// REAL GameState: save, export, wipe storage as a new computer would have it,
// import, load — and get the same game back.
//
// Run: node tools/headless/savetransfer.mjs

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};

// ---- a controllable localStorage, installed before GameState loads ----------
function makeStore() {
  const map = new Map();
  return {
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => map.clear(),
    __map: map,
  };
}
const setStore = (s) => Object.defineProperty(globalThis, 'localStorage', { value: s, configurable: true, writable: true });
setStore(makeStore());

const { installPhaserStub } = await import('./phaserStub.js');
installPhaserStub(9);

const ST = await import('../../src/systems/SaveTransfer.js');
const GameState = (await import('../../src/systems/GameState.js')).default;
const { SAVE_VERSION } = await import('../../src/systems/GameState.js');
const ProgressionManager = (await import('../../src/systems/ProgressionManager.js')).default;
const Diagnostics = (await import('../../src/systems/Diagnostics.js')).default;
const { makeParty } = await import('./fixtures.js');
const { createItemInstance } = await import('../../src/systems/ItemFactory.js');

const NOW = new Date('2026-09-12T10:00:00Z');

/* ---------------- 1. what counts as a save ---------------- */
console.log('=== parseImport: refusing things that are not saves ===');
{
  const bad = [
    ['an empty file', ''],
    ['whitespace', '   \n  '],
    ['text that is not JSON', 'hello there'],
    ['a JSON array', '[1,2,3]'],
    ['a JSON number', '42'],
    ['an unrelated JSON object', '{"name":"not a save"}'],
    ['our wrapper with no save inside', JSON.stringify({ format: 'behelith-save', formatVersion: 1 })],
    ['a wrapper from a NEWER game', JSON.stringify({ format: 'behelith-save', formatVersion: 99, save: { characters: [] } })],
    ['a wrapper whose version is not a number', JSON.stringify({ format: 'behelith-save', formatVersion: 'one', save: { characters: [] } })],
  ];
  for (const [label, text] of bad) {
    const r = ST.parseImport(text);
    check(`refuses ${label}`, r.ok === false && typeof r.reason === 'string' && r.reason.length > 5, r.reason);
  }
  // The reason is shown to the player, so it has to describe what actually
  // happened. A version that is not a number is a damaged file, not a newer game.
  const damaged = ST.parseImport(JSON.stringify({ format: 'behelith-save', formatVersion: 'one', save: { characters: [] } }));
  check('a non-numeric version is called damaged, not "newer"',
    /damaged/.test(damaged.reason) && !/newer/.test(damaged.reason), damaged.reason);
  const huge = ST.parseImport('{"characters":[],"pad":"' + 'x'.repeat(ST.MAX_IMPORT_BYTES) + '"}');
  check('refuses a file over the size limit', huge.ok === false && /too large/.test(huge.reason), huge.reason);
}

console.log('=== parseImport: accepting real saves ===');
{
  const save = { version: SAVE_VERSION, characters: [{ id: 'a', name: 'Bran' }] };
  const wrapped = ST.parseImport(JSON.stringify(ST.buildExport('autosave', save, NOW)));
  check('accepts an exported file', wrapped.ok === true, wrapped.reason || '');
  check('...returning the save inside it', wrapped.save?.characters?.[0]?.name === 'Bran');
  check('...and the slot it came from', wrapped.slot === 'autosave');

  const bare = ST.parseImport(JSON.stringify(save));
  check('accepts a bare save copied straight from storage', bare.ok === true && bare.slot === null);
}

/* ---------------- 2. a hostile file ---------------- */
console.log('=== a crafted file cannot reach object prototypes ===');
{
  const hostile = `{"format":"behelith-save","formatVersion":1,"save":{
    "characters":[{"id":"x","name":"<img src=x onerror=alert(1)>","__proto__":{"isAdmin":true}}],
    "__proto__":{"polluted":true},
    "constructor":{"prototype":{"polluted2":true}}
  }}`;
  const r = ST.parseImport(hostile);
  check('the file is still read as a save', r.ok === true, r.reason || '');
  // Verified by removing the reviver: the three own-key checks below FAIL. Two
  // earlier checks ("Object.prototype was not polluted", "still has the normal
  // prototype") were removed because they PASSED without the protection —
  // JSON.parse never pollutes on its own; the danger is these keys surviving as
  // own properties for load code to copy later, which is what is checked.
  check('no "__proto__" key survives on the save',
    !Object.prototype.hasOwnProperty.call(r.save, '__proto__'));
  check('no "constructor" key survives on the save',
    !Object.prototype.hasOwnProperty.call(r.save, 'constructor'));
  check('...or on a nested character',
    !Object.prototype.hasOwnProperty.call(r.save.characters[0], '__proto__'));
  check('a hostile NAME is kept as plain text, never interpreted',
    r.save.characters[0].name === '<img src=x onerror=alert(1)>',
    'the UI shows names as Phaser text, never HTML');
}

/* ---------------- 3. file names ---------------- */
console.log('=== export file names ===');
{
  check('a normal slot', ST.exportFileName('autosave', NOW) === 'behelith-autosave-2026-09-12.json', ST.exportFileName('autosave', NOW));
  const evil = ST.exportFileName('../../Windows/System32\\evil name', NOW);
  check('a slot name cannot introduce a path', !/[\\/]|\.\./.test(evil.replace(/\.json$/, '')), evil);
  check('an empty slot name still gives a file name', ST.exportFileName('', NOW) === 'behelith-save-2026-09-12.json', ST.exportFileName('', NOW));
}

/* ---------------- 4. slot names ---------------- */
console.log('=== an import never takes an existing slot ===');
{
  check('first import of the day', ST.importSlotName([], NOW) === 'imported-2026-09-12');
  check('a second one the same day',
    ST.importSlotName(['imported-2026-09-12'], NOW) === 'imported-2026-09-12-2');
  check('skips every name already taken',
    ST.importSlotName(['imported-2026-09-12', 'imported-2026-09-12-2', 'imported-2026-09-12-3'], NOW) === 'imported-2026-09-12-4');
}

/* ---------------- 5. the round trip through the real GameState ---------------- */
console.log('=== round trip: save, export, new computer, import, load ===');
{
  setStore(makeStore());
  GameState.reset?.();
  const party = makeParty();
  GameState.characters = party;
  GameState.party = party.slice(0, 3);
  GameState.inventory = [createItemInstance('sever_head'), createItemInstance('sever_chest')];
  ProgressionManager.questFlags = ['elseth_leader_handin', 'combat_pit'];
  ProgressionManager.huntTickets = 7;
  ProgressionManager.completedScenarios = ['training_encounter_1', 'training_encounter_2'];

  const before = {
    names: GameState.characters.map(c => c.name).join(','),
    levels: GameState.characters.map(c => c.level).join(','),
    party: GameState.party.map(c => c.name).join(','),
    items: GameState.inventory.map(i => i.id).join(','),
    flags: [...ProgressionManager.questFlags].join(','),
    tickets: ProgressionManager.huntTickets,
    scenarios: [...ProgressionManager.completedScenarios].join(','),
  };

  check('the original save writes', GameState.save('slotA') === true);
  const exported = JSON.stringify(ST.buildExport('slotA', GameState.readSlot('slotA'), NOW));
  check('the export is a reasonable size', exported.length > 1000 && exported.length < 500000,
    (exported.length / 1024).toFixed(1) + ' KB');

  // A different computer: nothing in storage, nothing in memory.
  setStore(makeStore());
  GameState.characters = [];
  GameState.party = [];
  GameState.inventory = [];
  ProgressionManager.questFlags = [];
  ProgressionManager.huntTickets = 0;
  ProgressionManager.completedScenarios = [];
  check('the new computer really starts empty', GameState.listSaveSlots().length === 0);

  const parsed = ST.parseImport(exported);
  check('the exported file parses', parsed.ok === true, parsed.reason || '');
  const slot = ST.importSlotName(GameState.listSaveSlots(), NOW);
  const imported = GameState.importSave(slot, parsed.save);
  check('it imports into a new slot', imported.ok === true, imported.reason || slot);
  check('...which now appears in the Load list', GameState.listSaveSlots().includes(slot));

  check('the imported save LOADS', GameState.load(slot) !== false, GameState.lastLoadError || '');
  const after = {
    names: GameState.characters.map(c => c.name).join(','),
    levels: GameState.characters.map(c => c.level).join(','),
    party: GameState.party.map(c => c.name).join(','),
    items: GameState.inventory.map(i => i.id).join(','),
    flags: [...ProgressionManager.questFlags].join(','),
    tickets: ProgressionManager.huntTickets,
    scenarios: [...ProgressionManager.completedScenarios].join(','),
  };
  for (const k of Object.keys(before)) {
    check(`${k} came back identical`, before[k] === after[k], `${before[k]}  ->  ${after[k]}`);
  }
}

/* ---------------- 6. import refuses what would not load ---------------- */
console.log('=== import refuses saves that would break the Load menu ===');
{
  setStore(makeStore());
  const refuse = [
    ['a save from a NEWER game version', { version: SAVE_VERSION + 1, characters: [] }],
    ['characters that are not a list', { version: SAVE_VERSION, characters: 'nope' }],
    ['a character that is null', { version: SAVE_VERSION, characters: [null] }],
    ['a character that is a number', { version: SAVE_VERSION, characters: [5] }],
  ];
  for (const [label, save] of refuse) {
    const r = GameState.importSave('should-not-exist', save);
    check(`refuses ${label}`, r.ok === false, r.reason);
  }
  check('...and none of them wrote a slot', GameState.listSaveSlots().length === 0,
    GameState.listSaveSlots().join(', ') || 'no slots');

  // Checking a save must not disturb the game already loaded.
  GameState.characters = [{ id: 'live', name: 'Still Here' }];
  GameState.checkSave({ version: SAVE_VERSION, characters: [{ id: 'other', name: 'Someone Else' }] });
  check('checking a save leaves the live game untouched',
    GameState.characters.length === 1 && GameState.characters[0].name === 'Still Here');
}

/* ---------------- 7. never overwrite ---------------- */
console.log('=== an import cannot replace an existing save ===');
{
  setStore(makeStore());
  GameState.characters = makeParty();
  GameState.save('precious');
  const original = globalThis.localStorage.getItem('bmSave_precious');
  const r = GameState.importSave('precious', { version: SAVE_VERSION, characters: [] });
  check('importing onto an existing slot name is refused', r.ok === false, r.reason);
  check('...and the existing save is byte-for-byte untouched',
    globalThis.localStorage.getItem('bmSave_precious') === original);
}

/* ---------------- 8. storage that refuses the write ---------------- */
console.log('=== a full browser storage is reported, not hidden ===');
{
  const full = makeStore();
  full.setItem = () => { throw Object.assign(new Error('exceeded the quota'), { name: 'QuotaExceededError' }); };
  setStore(full);
  const heard = [];
  const off = Diagnostics.onSaveError((e) => heard.push(e));
  const r = GameState.importSave('imported-full', { version: SAVE_VERSION, characters: [] });
  off();
  check('the import reports failure', r.ok === false, r.reason);
  check('...with the same storage message a failed save gives', /storage is full/.test(r.reason || ''));
  check('...and it reaches the save-failure listener like a failed save does', heard.length === 1,
    JSON.stringify(heard[0] || null));
}

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
