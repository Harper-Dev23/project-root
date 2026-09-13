// tools/headless/logkinds.mjs
//
// The combat log filters may hide buildup and initiative/MP lines, and nothing
// else. The classifier works from each line's text (src/systems/logKinds.js), so
// the risk is a line that reports damage or healing in words the rules did not
// anticipate — "hemorrhages 12", "Envenomed: tick ... necrotic" — being hidden
// along with the noise. This runs real fights, collects every line they log, and
// checks what each filter would hide.
//
// It then drives the real _renderCombatLog with the filters on and off, so the
// wiring (and the separator collapsing) is tested, not just the classifier.
//
// Run: node tools/headless/logkinds.mjs

import { installPhaserStub, seed } from './phaserStub.js';
installPhaserStub(1);

const { createCombatHost } = await import('./combatHost.js');
const { makeParty, slotMapFor } = await import('./fixtures.js');
const { runFight } = await import('./fight.js');
const M = await import('../../src/scenes/CombatScene.js');
const CombatScene = M.default || Object.values(M).find(v => typeof v === 'function');
const { LOG_KIND, logKindOf, entryText, isEntryShown } = await import('../../src/systems/logKinds.js');
const { GameplaySettings } = await import('../../src/systems/GameplaySettings.js');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};

/* ---------------- 1. real fight logs ---------------- */
console.log('=== what the filters hide in real fights ===');
const SCENARIOS = ['training_encounter_3', 'training_encounter_4', 'training_encounter_4_reckoning_3', 'training_encounter_5', 'training_encounter_6'];
const lines = [];
let sampleLog = null;
for (const sc of SCENARIOS) {
  seed(20260913);
  const host = createCombatHost(CombatScene);
  const party = makeParty();
  host.__begin({ party, partySlots: slotMapFor(party), scenarioId: sc });
  runFight(host, (h, actor) => {
    const atk = (actor.skills || []).find(s => s.id === 'basic_attack');
    const foe = h.enemies.find(e => e.status !== 'incapacitated' && e.currentHP > 0);
    return (atk && foe) ? [{ ability: atk, target: foe }] : [];
  }, { maxTurns: 600 });
  for (const e of host.combatEntries) if (!e?.separator) lines.push(entryText(e));
  if (!sampleLog) sampleLog = host.combatEntries.slice();
}
const kinds = lines.map(logKindOf);
const count = (k) => kinds.filter(x => x === k).length;
console.log(`  ${lines.length} lines: keep ${count(LOG_KIND.KEEP)}, buildup ${count(LOG_KIND.BUILDUP)}, resource ${count(LOG_KIND.RESOURCE)}, other ${count(LOG_KIND.OTHER)}`);

check('the fights produced a real log to test against', lines.length > 1000, `${lines.length} lines`);

// Independent of the classifier's own rules: words that mean HP moved, someone
// acted, or something failed. None of these lines may ever be hideable.
const MUST_SHOW = /\bdamage\b|\bheals?\b|\bHP\b|\bhemorrhages\b|\btick\b|\bnecrotic\.|\bburn \(magic\)|\buses\b|\bspends\b|\bknocked out\b|\bdefeated\b|\bmiss(es|ed)?\b|\bdodge|\bevade|\blacks\b|\bcannot\b|\bfizzle/i;
const wronglyHideable = lines.filter((t, i) => MUST_SHOW.test(t) && (kinds[i] === LOG_KIND.BUILDUP || kinds[i] === LOG_KIND.RESOURCE));
check('no line about damage, healing, HP, a skill used, a miss or a death can be hidden',
  wronglyHideable.length === 0, wronglyHideable.slice(0, 3).join(' | '));

const hasDotTicks = lines.some(t => /\bhemorrhages\b|\btick\b/.test(t));
check('...and the corpus really contains damage-over-time lines that never say "damage"', hasDotTicks);

const shape = (re) => lines.filter(t => re.test(t));
const allKind = (re, kind) => { const hit = shape(re); return { ok: hit.length > 0 && hit.every(t => logKindOf(t) === kind), n: hit.length, bad: hit.find(t => logKindOf(t) !== kind) }; };
for (const [label, re, kind] of [
  ['resilience reductions are buildup', /resilience reduces \w+ buildup/, LOG_KIND.BUILDUP],
  ['meter readouts ("fire 40→80  T0→T1") are buildup', /^\S.* (fire|cold|toxic|lacerate|expose|disease|disorient) \d+→\d+/, LOG_KIND.BUILDUP],
  ['Expose armour readouts are buildup', /Expose: PDR/, LOG_KIND.BUILDUP],
  ['initiative gauge lines are resource', /Initiative Gauge: \+/, LOG_KIND.RESOURCE],
  ['MP regeneration from gear is resource', /regenerates \d+ MP from gear/, LOG_KIND.RESOURCE],
  ['plain hits are kept', / hits .+ for \d+ damage/, LOG_KIND.KEEP],
]) {
  const r = allKind(re, kind);
  check(label, r.ok, r.ok ? `${r.n} lines` : (r.n ? `e.g. "${r.bad}" is ${logKindOf(r.bad)}` : 'no such lines in the corpus'));
}

const hiddenBoth = lines.filter(t => !isEntryShown({ segments: [{ text: t }] }, { buildup: true, resource: true })).length;
check('with both filters on, the log is substantially shorter', hiddenBoth / lines.length > 0.4,
  `${hiddenBoth}/${lines.length} hidden (${Math.round(100 * hiddenBoth / lines.length)}%)`);
const hiddenNone = lines.filter(t => !isEntryShown({ segments: [{ text: t }] }, {})).length;
check('with both filters off, nothing is hidden', hiddenNone === 0, `${hiddenNone} hidden`);

/* ---------------- 2. the real renderer ---------------- */
console.log('=== _renderCombatLog honours the filters ===');
{
  const drawn = [];
  const stubGfx = () => { const g = { __sep: true }; for (const m of ['lineStyle', 'beginPath', 'moveTo', 'lineTo', 'strokePath', 'setPosition']) g[m] = () => g; return g; };
  const fake = {
    combatLogContainer: { removeAll() { drawn.length = 0; }, add(o) { drawn.push(o); } },
    add: { graphics: stubGfx },
    tooltip: null,
    activeCombatLogTab: 'combat',
    logEntries: [
      { separator: true },
      { segments: [{ text: 'Bran hits Oskar for 12 damage.' }] },
      { segments: [{ text: "Oskar's resilience reduces fire buildup: 40 → 30." }] },
      { separator: true },
      { segments: [{ text: 'Bran Initiative Gauge: +20 = 60/100' }] },
      { separator: true },
      { segments: [{ text: 'Oskar fire 30→60  T0→T0 (I=1.00)' }] },
      { separator: true },
      { segments: [{ text: 'Oskar hemorrhages 9 (5% of Max HP).' }] },
    ],
    _getCombatLogWrapWidth: () => 400,
    _applyCombatLogScroll: () => {},
    _createLogEntryDisplay: (entry) => ({ container: { __text: entryText(entry), setPosition() {} }, height: 10 }),
    _combatLogHide: CombatScene.prototype._combatLogHide,
  };
  const render = () => { CombatScene.prototype._renderCombatLog.call(fake); return drawn.map(o => o.__sep ? '---' : o.__text); };
  const set = (b, r) => { GameplaySettings.set('logHideBuildup', b); GameplaySettings.set('logHideResources', r); };

  set(false, false);
  const all = render();
  check('filters off: every entry and separator is drawn, exactly as before', all.length === fake.logEntries.length, all.join(' / '));

  set(true, false);
  const noBuild = render();
  check('Buildup off: buildup lines are gone', !noBuild.some(t => /buildup|fire 30→60/.test(t)), noBuild.join(' / '));
  check('...damage, the DOT tick and initiative remain', ['12 damage', 'hemorrhages', 'Initiative'].every(w => noBuild.some(t => t.includes(w))));

  set(true, true);
  const quiet = render();
  check('both off: only the damage lines are left', quiet.filter(t => t !== '---').length === 2, quiet.join(' / '));
  check('...with no two separators stacked together', !quiet.some((t, i) => t === '---' && quiet[i + 1] === '---'), quiet.join(' / '));

  fake.activeCombatLogTab = 'local';
  const local = render();
  check('the Local tab is never filtered', local.length === fake.logEntries.length, `${local.length}/${fake.logEntries.length}`);

  set(false, false);
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
