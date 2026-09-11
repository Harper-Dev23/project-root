// tools/headless/zones.mjs
//
// A quake-zone skill must not come off cooldown while its own zone is still on
// the ground.
//
// The owner's rule (2026-09-10): if the zone a skill laid down still has
// duration left on the caster's turn, that skill should still be cooling down,
// so the same skill cannot stack a second zone onto its first.
//
// Measured on the REAL engine rather than reasoned: a zone counts down at the
// end of its OCCUPANT's turn, a cooldown at the end of the CASTER's turn, and
// the casting turn itself counts -- three clocks whose interaction is exactly
// the kind of thing CLAUDE.md warns about (see the `turns: 1` buff trap).
// Encounter 1's training dummies never move or attack, so the zone stays put
// on its tile and the only thing that moves is the clock.
//
// Run: node tools/headless/zones.mjs

import { installPhaserStub } from './phaserStub.js';
installPhaserStub(11);

const { createCombatHost } = await import('./combatHost.js');
const { makeParty, slotMapFor, skillFor } = await import('./fixtures.js');
const { startCombat, cast, endTurn } = await import('./fight.js');
const { SKILLS } = await import('../../data/skills.js');
const CS = await import('../../src/scenes/CombatScene.js');
const CombatScene = CS.default || Object.values(CS).find(v => typeof v === 'function');

// Every current-weapon skill that LAYS a zone with a duration. The mace skills
// that merely trigger or copy existing zones (Earthshatter, Fault Line,
// Gravity Slam, Tremor Echo) are not here: they create nothing to overlap.
const ZONE_SKILLS = ['frozen_quake', 'hallowed_ground', 'plague_slam', 'quake_mark', 'sanctified_slam'];

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};

function board() {
  const host = createCombatHost(CombatScene);
  const party = makeParty();
  host.__begin({ party, partySlots: slotMapFor(party), scenarioId: 'training_encounter_1' });
  startCombat(host);
  return { host, party };
}

const zoneTurnsOnBoard = (host) => {
  let max = 0;
  for (const effs of Object.values(host.slotEffects || {})) {
    for (const e of effs || []) max = Math.max(max, e?.turns | 0);
  }
  return max;
};

for (const id of ZONE_SKILLS) {
  const sk = SKILLS[id];
  const { host, party } = board();
  const halv = party.find(c => c.name === 'Halvard');
  halv.maxMP = halv.currentMP = 999;
  halv.actionsLeft = { major: 1, bonus: 1, class: 1, reaction: 1 };

  const wantsAlly = sk?.targetRequirement === 'ally';
  const target = wantsAlly
    ? party.find(c => c !== halv && c.status !== 'incapacitated')
    : (host.enemies || []).find(e => e.status !== 'incapacitated');

  // Meet the skill's own weakness prerequisite first, using the engine's own
  // buildup path rather than writing meters by hand. Frozen Quake needs the
  // target at Cold T1 -- and Cold slows the target's turns, which slows how
  // often its zone counts down. That is precisely the case a hand trace misses.
  const pre = [];
  for (const req of [].concat(sk?.requiresWeakness || [])) {
    if (!req?.family) continue;
    const who = req.on === 'self' ? halv : target;
    const tier = req.tierAtLeast ?? req.tier ?? 1;
    // Add buildup until the tier actually LANDS, rather than trusting a fixed
    // amount: a flat 100 Cold came out as 97 on a training dummy (a little
    // resistance) and missed T1 by 3, which left the cast refused and the
    // skill unmeasured. Bounded, and loud if it can never get there.
    let tries = 0;
    while ((who.weakness?.tiers?.[req.family] | 0) < tier && tries++ < 20) {
      host._applyWeaknessBuildup(who, { [req.family]: 50 }, { user: halv });
    }
    const got = who.weakness?.tiers?.[req.family] | 0;
    pre.push(`${req.family} T${got}${got < tier ? ' (FAILED to reach T' + tier + ')' : ''}`);
  }

  const r = cast(host, halv, skillFor(halv, id), target);
  if (!r.ok) {
    check(`${id.padEnd(16)} cd ${sk?.cooldown}`, false,
      (pre.length ? `[pre: ${pre.join(', ')}] ` : '') + 'cast refused: ' + (r.reason || '?'));
    continue;
  }
  const laid = zoneTurnsOnBoard(host);
  if (!laid) {
    check(`${id.padEnd(16)} cd ${sk?.cooldown}`, false, 'cast succeeded but laid no zone');
    continue;
  }

  // Walk forward, sampling at the START of each of Halvard's turns.
  const trail = [];
  let overlap = null;
  for (let hTurn = 1; hTurn <= 8; hTurn++) {
    let guard = 0;
    do { endTurn(host); } while (host._currentChar() !== halv && ++guard < 40 && !host.combatEnded);
    if (host._currentChar() !== halv) break;
    const zone = zoneTurnsOnBoard(host);
    const cd = halv.cooldowns?.[id] | 0;
    trail.push(`t${hTurn}: zone ${zone} cd ${cd}`);
    if (cd === 0 && zone > 0 && !overlap) overlap = hTurn;
    if (cd === 0 && zone === 0) break;
  }

  check(`${id.padEnd(16)} cd ${String(sk.cooldown).padStart(1)}  zone ${laid}`,
    overlap === null,
    (pre.length ? `[pre: ${pre.join(', ')}] ` : '')
    + (overlap ? `OVERLAP on Halvard's turn ${overlap} -- ` : '') + trail.join(' | '));
}

console.log('');
console.log(failures ? `${failures} CHECK(S) FAILED` : 'ALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
