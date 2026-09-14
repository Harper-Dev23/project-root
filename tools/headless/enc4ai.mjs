// tools/headless/enc4ai.mjs
//
// Encounter 4's pack targeting and Cade's gated mark (owner, 2026-09-14).
//
// Measured before the change: every beast and Cade's mark all picked targets
// with the same rule, so the mark landed on whoever the beasts already favoured
// and 45% of all enemy damage in Reckoning III hit the one marked hunter. The
// mark was also up from round 1 and reapplied the moment it expired.
//
// This drives the REAL AI_PROFILES decide() functions and the REAL huntsman_mark
// apply() on stub boards. Rank shares are counted over many picks, so the checks
// assert a clear lean rather than an exact number.
//
// Run: node tools/headless/enc4ai.mjs

import { installPhaserStub } from './phaserStub.js';
installPhaserStub(7);

const { AI_PROFILES } = await import('../../src/systems/AIProfiles.js');
const { SKILLS } = await import('../../data/skills.js');
const { frontness } = await import('../../src/systems/boardGeometry.js');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};

// Two hunters in each rank (front column: slots 1-3, back column: 6-8), all at
// full HP with no weaknesses, so rank and the mark are the only differences.
const SLOTS = [1, 2, 3, 6, 7, 8];
const board = () => SLOTS.map(slotId => ({
  name: `H${slotId}`, isEnemy: false, status: 'ok', currentHP: 100, maxHP: 100,
  statusEffects: [], weakness: { tiers: {}, meters: {} }, _slot: { slotId },
}));
const npcNamed = (name, extra = {}) => ({
  name, isEnemy: true, status: 'ok', currentHP: 100, maxHP: 100, currentMP: 999, maxMP: 999,
  actionsLeft: { major: 1, bonus: 1, class: 1, reaction: 1 }, cooldowns: {}, statusEffects: [],
  initiativeGauge: 0, tags: ['beast'], skills: [], ...extra,
});
const scene = { enemies: [] };

/** Rank shares of `profile`'s hostile picks over `n` fresh decisions. */
function shares(profile, n, { npcExtra = {}, mutate = null } = {}) {
  let front = 0, back = 0, marked = 0, picks = 0;
  for (let i = 0; i < n; i++) {
    const foes = board();
    if (mutate) mutate(foes);
    const npc = npcNamed(profile, npcExtra);
    const action = AI_PROFILES[profile].decide(npc, scene, foes);
    const t = action?.target;
    if (!t || !foes.includes(t)) continue;
    picks++;
    if (frontness(t) === 1) front++;
    if (frontness(t) === 0) back++;
    if (t.statusEffects.some(se => se.id === 'huntsman_marked')) marked++;
  }
  return { front: front / picks, back: back / picks, marked: marked / picks, picks };
}
const pc = (x) => `${Math.round(100 * x)}%`;
const N = 3000;

/* ---------------- lanes ---------------- */
console.log('=== each beast keeps to its lane ===');
for (const profile of ['oskar_beast', 'kiro_beast']) {
  const s = shares(profile, N);
  check(`${profile} leans on the front rank`, s.front > 0.65 && s.back > 0.05,
    `front ${pc(s.front)}, back ${pc(s.back)} of ${s.picks} picks (even is 50/50)`);
}
{
  const s = shares('laki_beast', N);
  check('laki_beast leans on the back rank', s.back > 0.65 && s.front > 0.05,
    `front ${pc(s.front)}, back ${pc(s.back)} of ${s.picks} picks`);
}
{
  const s = shares('huntsman', N, { npcExtra: { tags: [], skills: ['huntsman_trap_shot'], cooldowns: { huntsman_command: 9 } } });
  check('Cade has no rank preference', Math.abs(s.front - s.back) < 0.08,
    `front ${pc(s.front)}, back ${pc(s.back)} of ${s.picks} picks`);
}

/* ---------------- the mark ---------------- */
console.log("=== Cade's mark is gated on 30 Initiative ===");
{
  const pickWith = (gauge) => AI_PROFILES.huntsman.decide(npcNamed('Cade', { tags: [], initiativeGauge: gauge }), scene, board());
  check('below 30 Initiative Cade does not try to mark', pickWith(29)?.skill !== 'huntsman_mark', `chose ${pickWith(29)?.skill}`);
  check('at 30 Initiative with no mark up, Cade marks', pickWith(30)?.skill === 'huntsman_mark', `chose ${pickWith(30)?.skill}`);
  check('the skill declares the same gate the engine enforces', SKILLS.huntsman_mark.requiresInitiativeGauge === 30,
    `requiresInitiativeGauge ${SKILLS.huntsman_mark.requiresInitiativeGauge}`);

  const cade = npcNamed('Cade', { tags: [], initiativeGauge: 44, stats: { STR: 5, DEX: 5 }, derived: {} });
  const target = board()[0];
  let result = null, threw = null;
  try { result = SKILLS.huntsman_mark.apply(cade, target, scene); } catch (e) { threw = e; }
  check('apply() runs', !threw, threw ? String(threw.message).slice(0, 120) : '');
  check('marking spends exactly 30 Initiative', cade.initiativeGauge === 14, `44 -> ${cade.initiativeGauge}`);
  check('the mark applies 75 Expose', result?.buildup?.expose === 75, JSON.stringify(result?.buildup));
  check('...and still marks the target', (result?.statusEffects || []).some(se => se.id === 'huntsman_marked'));
}

/* ---------------- commanded beasts hunt the mark ---------------- */
console.log('=== a commanded beast goes for the mark ===');
{
  // Mark a BACK-rank hunter, so Oskar's front lean and the command pull apart.
  const markBack = (foes) => { foes.find(f => f._slot.slotId === 8).statusEffects.push({ id: 'huntsman_marked', turns: 3 }); };
  const free = shares('oskar_beast', N, { mutate: markBack });
  const told = shares('oskar_beast', N, { mutate: markBack, npcExtra: { statusEffects: [{ id: 'commanded', turns: 1 }] } });
  check('uncommanded Oskar mostly ignores a back-rank mark', free.marked < 0.12, `hits it ${pc(free.marked)}`);
  check('commanded Oskar goes for it', told.marked > 0.4 && told.marked > free.marked * 4,
    `hits it ${pc(told.marked)} (was ${pc(free.marked)}; even is 17%)`);
  const lakiTold = shares('laki_beast', N, { npcExtra: { statusEffects: [{ id: 'commanded', turns: 1 }] },
    mutate: (foes) => { foes.find(f => f._slot.slotId === 1).statusEffects.push({ id: 'huntsman_marked', turns: 3 }); } });
  check('commanded Laki crosses to a front-rank mark too', lakiTold.marked > 0.4, `hits it ${pc(lakiTold.marked)}`);
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
