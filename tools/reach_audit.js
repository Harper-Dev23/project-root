// tools/reach_audit.js
//
// Who can still touch your back rank when melee reach is switched on.
//
// Re-runnable on purpose rather than a chart pasted into a document: it reads
// the live skill tags and enemy rosters, so it stays true as the data is
// edited.
//
// It models CombatScene._reachBlocked rather than calling it, so it can be
// wrong in exactly the ways a model can. The FIRST version was: it counted
// skills rather than reach, and so reported that one front-liner walls Gorrek
// off from the party entirely. He is not walled off at all -- see the four
// categories below for why. The authority is still _reachBlocked, exercised by
// tools/headless/reach.mjs.
//
// Run: node tools/reach_audit.js

import { installPhaserStub } from './headless/phaserStub.js';
installPhaserStub(1);

const { SKILLS } = await import('../data/skills.js');
const { COMBAT_SCENARIOS } = await import('../data/combatScenarios.js');
const { ENEMY_TYPES } = await import('../data/enemyTypes.js');

const FREE_TAGS = ['ranged', 'projectile', 'spell'];

/**
 * How an ability relates to your back rank under reach.
 *
 *   confined  melee, single target: can only be aimed at your front rank
 *   free      ranged / projectile / spell, or reach:'any'
 *   splash    melee, but a party-wide AoE: the PRIMARY must be a front-liner,
 *             and then the splash lands on everyone anyway. Reach gates the
 *             primary only, by design, so these still reach your back rank.
 *   reaction  fired by ReactionSystem straight into _applyAbilityToTarget,
 *             which never passes either reach gate -- so these ignore reach
 *             entirely today. That is a decision nobody has made yet, not a
 *             rule; see the note at the end.
 *   tactical  targeted but not an attack (a mark, a glare): not melee, so
 *             never restricted, and often the scariest thing in the kit.
 */
function classify(id) {
  const s = SKILLS[id];
  if (!s) return 'missing';
  const tags = s.tags || [];
  const acrossField = s.requiresTarget && s.targetRequirement !== 'ally' && !tags.includes('self');

  if (s.actionCost === 'reaction') return 'reaction';

  const isAttack = ['attack', 'weapon', 'melee', ...FREE_TAGS].some(t => tags.includes(t));
  if (!isAttack) return acrossField ? 'tactical' : 'nonattack';

  if (s.reach === 'any') return 'free';
  if (FREE_TAGS.some(t => tags.includes(t))) return 'free';
  if (tags.includes('melee')) {
    if (s.aoe?.shape === 'party' || s.aoe?.shape === 'all') return 'splash';
    return 'confined';
  }
  return 'untagged';
}

const bar = (pct, width = 20) => {
  const n = Math.round((pct / 100) * width);
  return '#'.repeat(n) + '.'.repeat(width - n);
};

console.log('WHO CAN STILL TOUCH YOUR BACK RANK WHEN MELEE REACH IS ON\n');
console.log('  confined  melee single-target: front rank only');
console.log('  free      ranged / projectile / spell / reach:"any"');
console.log('  splash    melee party-AoE: needs a front-liner to START on, then hits everyone');
console.log('  reaction  ignores reach entirely today (see note at end)');
console.log('  tactical  targeted non-attack - never restricted\n');

const seen = new Set();
const rows = [];
for (const [sid, sc] of Object.entries(COMBAT_SCENARIOS)) {
  if (!Array.isArray(sc.enemies) || !sc.enemies.length) continue;
  const tally = { confined: 0, free: 0, splash: 0, reaction: 0, tactical: 0, untagged: 0 };
  const perEnemy = [];
  for (const slot of sc.enemies) {
    const type = ENEMY_TYPES[slot.type];
    if (!type) continue;
    const mine = { confined: [], free: [], splash: [], reaction: [], tactical: [], untagged: [] };
    for (const id of (type.skills || [])) {
      const k = classify(id);
      if (mine[k]) { mine[k].push(SKILLS[id]?.name || id); tally[k]++; }
    }
    perEnemy.push({ name: slot.name || slot.type, mine });
  }
  const reaching = tally.free + tally.splash + tally.reaction + tally.tactical;
  const total = reaching + tally.confined + tally.untagged;
  if (!total) continue;
  // Reckoning tiers repeat their base fight's roster; show each distinct
  // roster once so the list is readable.
  const sig = perEnemy.map(e => e.name + ':' + JSON.stringify(e.mine)).join('|');
  if (seen.has(sig)) continue;
  seen.add(sig);
  rows.push({ sid, name: sc.name || sid, tally, reaching, total, perEnemy,
    reachPct: (reaching / total) * 100 });
}

rows.sort((a, b) => a.reachPct - b.reachPct);

for (const row of rows) {
  console.log(`${row.name}  (${row.sid})`);
  console.log(`  ${bar(row.reachPct)}  ${row.reaching} of ${row.total} abilities can touch your back rank`);
  for (const e of row.perEnemy) {
    const parts = [];
    for (const k of ['confined', 'splash', 'free', 'tactical', 'reaction', 'untagged']) {
      if (e.mine[k].length) parts.push(`${k}: ${e.mine[k].join(', ')}`);
    }
    const onlyConfined = e.mine.confined.length
      && !e.mine.free.length && !e.mine.splash.length
      && !e.mine.tactical.length && !e.mine.reaction.length;
    console.log(`      ${e.name}${onlyConfined ? '   <-- walled off by one front-liner' : ''}`);
    for (const p of parts) console.log(`          ${p}`);
  }
  console.log('');
}

// --- the party's own side --------------------------------------------------
const WEAPONS = ['sword_1h', 'dagger', 'staff', 'mace_2h', 'bow', 'axe_2h'];
console.log('\nAND WHAT IT COSTS YOU\n');
for (const w of WEAPONS) {
  const t = { confined: 0, free: 0, splash: 0, other: 0 };
  for (const s of Object.values(SKILLS)) {
    const req = Array.isArray(s.requiredWeapon) ? s.requiredWeapon
      : s.requiredWeapon ? [s.requiredWeapon] : [];
    if (!req.includes(w) || s.hidden || s.type === 'enemy') continue;
    const k = classify(s.id);
    if (k === 'confined') t.confined++;
    else if (k === 'free') t.free++;
    else if (k === 'splash') t.splash++;
  }
  const total = t.confined + t.free + t.splash;
  if (!total) { console.log(`  ${w.padEnd(10)} no attack skills found`); continue; }
  const pct = (t.confined / total) * 100;
  console.log(`  ${w.padEnd(10)} ${bar(pct)}  ${pct.toFixed(0)}% front-rank-only` +
    `   [${t.confined} confined, ${t.splash} splash, ${t.free} free]`);
}

console.log('\nNOTE ON REACTIONS: ReactionSystem fires counters straight into');
console.log('_applyAbilityToTarget, which passes neither reach gate. So a melee');
console.log('counter (Blood Fury, Reflex Bite) lands on a back-rank archer who');
console.log('shot the owner, reach or no reach. Consistent with the rule, or a');
console.log('deliberate exception? Undecided -- this line exists so it stays visible.');
