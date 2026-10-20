// src/systems/EventVotes.js
//
// Co-op event votes (Exploration System v2, chunk 15d; owner, 2026-10-04 and
// 2026-10-20). Free of Phaser and of the network: the rules only, so they
// are checked headlessly (tools/headless/eventvotes.mjs). CoopHunt carries
// the votes; the host's hunt resolves what they decide.
//
// The rules, as agreed:
//   - Every player votes on the party's choices with their face. Walking
//     away is a choice like any other. No time limit.
//   - It resolves when everyone has voted: the most votes win, and a tie
//     goes to the lead's vote.
//   - The lead can call it once all but one have voted (someone gone quiet
//     cannot hold the hunt up), on the votes cast.
//   - A beat about one hunter (a check: the hunter who rolls) is that
//     hunter's player's call alone. Anyone else's pick is a suggestion,
//     shown but not counted.
//   - A false god's pact needs everyone: any vote against it refuses it.
//   - Markets stay personal: each player buys from their own save; only
//     leaving is voted.
//
// A choice is a short id: 'option:<i>', 'answer:<i>', 'roll', 'accept',
// 'refuse', 'leave', 'escape'.

export const VOTE = 'vote';
export const PERSONAL = 'personal';
export const UNANIMOUS = 'unanimous';

/** The open event's key: votes belong to one beat of one event. */
export function eventKey(ev) {
  return ev ? `${ev.templateId}@${ev.tile}#${ev.beat?.id || ''}` : null;
}

/** The choices the party can make on this beat, in screen order. */
export function choicesFor(ev) {
  if (!ev) return [];
  const out = [];
  if (ev.shape === 'choice') ev.options.forEach(o => out.push(`option:${o.index}`));
  if (ev.shape === 'puzzle') ev.answers.forEach((_, k) => out.push(`answer:${k}`));
  if (ev.shape === 'check') out.push('roll');
  if (ev.shape === 'offer' || ev.shape === 'trade') out.push('accept', 'refuse');
  if (ev.beat) { if ((ev.beat.ropes || 0) > 0) out.push('escape'); }
  else out.push('leave');
  return out;
}

/**
 * How this beat is decided. `party` is the merged party (characters with
 * their ownerId). A check names the hunter who rolls: theirs to call. A
 * pact needs everyone. Everything else is a vote.
 * Returns { rule, ownerId? }.
 */
export function ruleFor(ev, party = []) {
  if (ev?.shape === 'check' && ev.check?.whoRef) {
    const c = party.find(h => (h.instanceId || h.id) === ev.check.whoRef);
    if (c?.ownerId != null) return { rule: PERSONAL, ownerId: c.ownerId };
  }
  if (ev?.shape === 'offer' && ev.offer?.pact) return { rule: UNANIMOUS };
  return { rule: VOTE };
}

/**
 * Where the vote stands.
 *   votes      { playerId: choice }
 *   players    every player's id on the hunt, in seat order
 *   leadId     the lead's id (ties, and calling it)
 *   choices    the valid choices (votes for anything else are ignored)
 *   call       true: the lead calls it now
 * Returns { decided: choice | null, waitingOn: [playerId], canCall, counts }.
 */
export function tally({ rule = VOTE, ownerId = null, votes = {}, players = [], leadId = null, choices = [], call = false } = {}) {
  const valid = Object.fromEntries(Object.entries(votes).filter(([pid, c]) => players.includes(pid) && choices.includes(c)));
  const counts = {};
  for (const c of Object.values(valid)) counts[c] = (counts[c] || 0) + 1;
  const voted = Object.keys(valid);
  const waitingOn = players.filter(pid => !(pid in valid));

  if (rule === PERSONAL) {
    const mine = valid[ownerId] || null;
    return { decided: mine, waitingOn: mine ? [] : [ownerId], canCall: false, counts };
  }
  const allIn = waitingOn.length === 0;
  const canCall = !allIn && voted.length >= players.length - 1 && voted.length > 0;
  if (!allIn && !(call && canCall)) return { decided: null, waitingOn, canCall, counts };

  if (rule === UNANIMOUS) {
    // A pact: everyone's yes, or it is refused. Leaving is honoured if the
    // most votes say so.
    if (allIn && voted.every(pid => valid[pid] === 'accept')) return { decided: 'accept', waitingOn: [], canCall: false, counts };
    const leaving = (counts.leave || 0) > (voted.length / 2);
    return { decided: leaving ? 'leave' : 'refuse', waitingOn: [], canCall: false, counts };
  }
  // The most votes; a tie goes to the lead's vote, else the first tied in
  // screen order.
  const top = Math.max(...Object.values(counts));
  const tied = choices.filter(c => counts[c] === top);
  const decided = tied.length === 1 ? tied[0] : (tied.includes(valid[leadId]) ? valid[leadId] : tied[0]);
  return { decided, waitingOn: [], canCall: false, counts };
}

/** Run a decided choice on the hunt (the host's). Returns the engine's result. */
export function runChoice(hunt, choice) {
  const [kind, n] = String(choice).split(':');
  if (kind === 'option') return hunt.resolveEvent({ option: Number(n) });
  if (kind === 'answer') return hunt.resolveEvent({ answer: Number(n) });
  if (kind === 'roll') return hunt.resolveEvent({});
  if (kind === 'accept') return hunt.resolveEvent({ accept: true });
  if (kind === 'refuse') return hunt.resolveEvent({ accept: false });
  if (kind === 'leave') return hunt.leaveEvent();
  if (kind === 'escape') return hunt.escapeEvent();
  return { ok: false, reason: `no such choice '${choice}'` };
}
