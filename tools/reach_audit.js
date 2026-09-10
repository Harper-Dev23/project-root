// tools/reach_audit.js
//
// Who loses what when melee reach is switched on.
//
// Re-runnable on purpose rather than a chart pasted into a document: it reads
// the live skill tags and enemy rosters, so it stays true as the data is
// edited. A static table would be wrong the first time a tag changes.
//
// The rule it models is DevFlags-gated _reachBlocked: a skill is restricted if
// it is tagged `melee`, is not also tagged ranged/projectile/spell, and does
// not declare reach:'any'. That mirrors the engine rather than guessing, but it
// is a MODEL of it -- the authority is CombatScene._reachBlocked, exercised by
// tools/headless/reach.mjs.
//
// Run: node tools/reach_audit.js

import { installPhaserStub } from './headless/phaserStub.js';
installPhaserStub(1);

const { SKILLS } = await import('../data/skills.js');
const { COMBAT_SCENARIOS } = await import('../data/combatScenarios.js');
const { ENEMY_TYPES } = await import('../data/enemyTypes.js');

const FREE_TAGS = ['ranged', 'projectile', 'spell'];

function classify(id) {
  const s = SKILLS[id];
  if (!s) return 'missing';
  const tags = s.tags || [];
  // A spell is an attack for this purpose. Testing only attack/weapon/melee
  // counted 1 of 25 staff skills and made the staff look like it had almost no
  // kit at all -- its damage is tagged `spell`/`magic`, which is exactly the
  // thing reach never restricts.
  const isAttack = ['attack', 'weapon', 'melee', ...FREE_TAGS].some(t => tags.includes(t));
  if (!isAttack) return 'nonattack';
  if (s.reach === 'any') return 'free';
  if (FREE_TAGS.some(t => tags.includes(t))) return 'free';
  if (tags.includes('melee')) return 'restricted';
  return 'untagged';
}

const bar = (pct, width = 20) => {
  const n = Math.round((pct / 100) * width);
  return '#'.repeat(n) + '.'.repeat(width - n);
};

console.log('WHO IS CONFINED TO YOUR FRONT RANK WHEN MELEE REACH IS ON\n');
console.log('  restricted = melee-only, cannot touch your mid or back rank');
console.log('  free       = ranged / projectile / spell, or reach:"any"');
console.log('  untagged   = an attack with NO reach tag at all - reads as free,');
console.log('               and is where a surprise will come from\n');

const rows = [];
for (const [sid, sc] of Object.entries(COMBAT_SCENARIOS)) {
  if (!Array.isArray(sc.enemies) || !sc.enemies.length) continue;
  let R = 0, F = 0, U = 0;
  const perEnemy = [];
  for (const slot of sc.enemies) {
    const type = ENEMY_TYPES[slot.type];
    if (!type) continue;
    let r = 0, f = 0, u = 0;
    for (const id of (type.skills || [])) {
      const k = classify(id);
      if (k === 'restricted') r++;
      else if (k === 'free') f++;
      else if (k === 'untagged') u++;
    }
    R += r; F += f; U += u;
    perEnemy.push({ name: slot.name || slot.type, r, f, u });
  }
  const total = R + F + U;
  if (!total) continue;
  rows.push({ sid, name: sc.name || sid, R, F, U, total, pct: (R / total) * 100, perEnemy });
}

rows.sort((a, b) => b.pct - a.pct);

for (const row of rows) {
  console.log(`${row.name}  (${row.sid})`);
  console.log(`  ${bar(row.pct)}  ${row.pct.toFixed(0)}% of attacks confined to your front rank` +
    `   [${row.R} restricted / ${row.F} free${row.U ? ' / ' + row.U + ' UNTAGGED' : ''}]`);
  for (const e of row.perEnemy) {
    const t = e.r + e.f + e.u;
    const note = t === 0 ? 'no attacks'
      : e.r === t ? 'ENTIRELY melee - a single front-liner walls this enemy off'
        : e.f === t ? 'entirely ranged - reach never restricts it'
          : `${e.r} melee, ${e.f} free${e.u ? ', ' + e.u + ' untagged' : ''}`;
    console.log(`      ${(e.name + ':').padEnd(22)} ${note}`);
  }
  console.log('');
}

// --- the party's own side --------------------------------------------------
const WEAPONS = ['sword_1h', 'dagger', 'staff', 'mace_2h', 'bow', 'axe_2h'];
console.log('\nAND WHAT IT COSTS YOU\n');
for (const w of WEAPONS) {
  let r = 0, f = 0, u = 0;
  for (const s of Object.values(SKILLS)) {
    // `requiredWeapon`, not `weaponType` -- the latter does not exist on a
    // skill and silently matched nothing, which is how this section first
    // reported "no attack skills found" for all six weapons.
    const req = Array.isArray(s.requiredWeapon) ? s.requiredWeapon
      : s.requiredWeapon ? [s.requiredWeapon] : [];
    if (!req.includes(w) || s.hidden || s.type === 'enemy') continue;
    const k = classify(s.id);
    if (k === 'restricted') r++; else if (k === 'free') f++; else if (k === 'untagged') u++;
  }
  const t = r + f + u;
  if (!t) { console.log(`  ${w.padEnd(10)} no attack skills found`); continue; }
  const pct = (r / t) * 100;
  console.log(`  ${w.padEnd(10)} ${bar(pct)}  ${pct.toFixed(0)}% front-rank-only   [${r}/${t}${u ? ', ' + u + ' untagged' : ''}]`);
}
