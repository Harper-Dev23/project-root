// tools/headless/eventvotes.mjs
//
// Co-op event votes (chunk 15d; src/systems/EventVotes.js): the rules the
// owner agreed, one check each.
//
// Run: node tools/headless/eventvotes.mjs

const V = await import('../../src/systems/EventVotes.js');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};

const players = ['p1', 'p2', 'p3'];
const choices = ['option:0', 'option:1', 'leave'];
const t = (votes, extra = {}) => V.tally({ rule: V.VOTE, votes, players, leadId: 'p1', choices, ...extra });

console.log('=== a vote ===');
check('nothing is decided until everyone has voted (no time limit)', t({ p1: 'option:0', p2: 'option:0' }).decided === null);
check('...and it says who is still to vote', t({ p1: 'option:0', p2: 'option:1' }).waitingOn.join() === 'p3');
check('everyone in: the most votes win', t({ p1: 'option:0', p2: 'option:1', p3: 'option:1' }).decided === 'option:1');
check('walking away is a choice like any other', t({ p1: 'leave', p2: 'leave', p3: 'option:0' }).decided === 'leave');
check('a tie goes to the lead\'s vote', V.tally({ rule: V.VOTE, votes: { p1: 'option:1', p2: 'option:0' }, players: ['p1', 'p2'], leadId: 'p1', choices }).decided === 'option:1');
check('...whoever the lead is', V.tally({ rule: V.VOTE, votes: { p1: 'option:1', p2: 'option:0' }, players: ['p1', 'p2'], leadId: 'p2', choices }).decided === 'option:0');
check('a three-way tie: the lead\'s', t({ p1: 'leave', p2: 'option:0', p3: 'option:1' }).decided === 'leave');
check('a vote for a choice that is not on offer is not counted', t({ p1: 'option:7', p2: 'option:0', p3: 'option:0' }).decided === null);

console.log('=== calling it ===');
const two = t({ p1: 'option:0', p2: 'option:1' });
check('with all but one in, the lead may call it', two.canCall && two.decided === null);
check('...and calling decides on the votes cast (a tie to the lead)', t({ p1: 'option:0', p2: 'option:1' }, { call: true }).decided === 'option:0');
check('with two still to vote, it cannot be called', !t({ p1: 'option:0' }).canCall && t({ p1: 'option:0' }, { call: true }).decided === null);
check('a solo player decides at once', V.tally({ rule: V.VOTE, votes: { p1: 'leave' }, players: ['p1'], leadId: 'p1', choices }).decided === 'leave');

console.log('=== a beat about one hunter ===');
const party = [{ instanceId: 'a', ownerId: 'p1' }, { instanceId: 'b', ownerId: 'p2' }];
const check2 = { shape: 'check', check: { whoRef: 'b', stat: 'DEX' }, templateId: 't', tile: 'x' };
const r = V.ruleFor(check2, party);
check('a check is the rolling hunter\'s player\'s call', r.rule === V.PERSONAL && r.ownerId === 'p2');
const pv = (votes) => V.tally({ ...r, votes, players: ['p1', 'p2'], leadId: 'p1', choices: ['roll', 'leave'] });
check('...everyone else\'s pick is a suggestion: it decides nothing', pv({ p1: 'leave' }).decided === null && pv({ p1: 'leave' }).waitingOn.join() === 'p2');
check('...theirs decides at once, whatever the others say', pv({ p1: 'leave', p2: 'roll' }).decided === 'roll');
check('a party check (no one hunter) is a vote', V.ruleFor({ shape: 'check', check: { stat: 'perception', whoRef: null } }, party).rule === V.VOTE);

console.log('=== a pact ===');
const pact = { shape: 'offer', offer: { pact: { god: 'Dagon' } } };
check('a pact needs everyone', V.ruleFor(pact, party).rule === V.UNANIMOUS);
const u = (votes) => V.tally({ rule: V.UNANIMOUS, votes, players, leadId: 'p1', choices: ['accept', 'refuse', 'leave'] });
check('...everyone\'s yes accepts it', u({ p1: 'accept', p2: 'accept', p3: 'accept' }).decided === 'accept');
check('...one no refuses it, even against two yeses', u({ p1: 'accept', p2: 'accept', p3: 'refuse' }).decided === 'refuse');
check('...and it waits for everyone', u({ p1: 'accept', p2: 'accept' }).decided === null);

console.log('=== choices and keys ===');
check('a choice beat offers its options and Walk away', V.choicesFor({ shape: 'choice', options: [{ index: 0 }, { index: 1 }] }).join() === 'option:0,option:1,leave');
check('a committed beat offers no Walk away; the rope only if carried', V.choicesFor({ shape: 'check', beat: { id: 'b', ropes: 1 } }).join() === 'roll,escape'
  && V.choicesFor({ shape: 'check', beat: { id: 'b', ropes: 0 } }).join() === 'roll');
check('votes belong to one beat: the key changes with it', V.eventKey({ templateId: 't', tile: 'x' }) !== V.eventKey({ templateId: 't', tile: 'x', beat: { id: 'b' } }));
const calls = [];
const fake = { resolveEvent: (p) => (calls.push(p), { ok: true }), leaveEvent: () => (calls.push('leave'), { ok: true }), escapeEvent: () => (calls.push('escape'), { ok: true }) };
for (const c of ['option:1', 'answer:2', 'roll', 'accept', 'refuse', 'leave', 'escape']) V.runChoice(fake, c);
check('each choice runs the engine call it names', JSON.stringify(calls) === JSON.stringify([{ option: 1 }, { answer: 2 }, {}, { accept: true }, { accept: false }, 'leave', 'escape']), JSON.stringify(calls));

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
