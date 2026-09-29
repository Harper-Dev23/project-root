// src/systems/QuestRewards.js
//
// One-time rewards on quest steps (owner 2026-09-29): a step in
// src/data/quests.js may carry `reward: { huntTickets, text }`. The first time
// the town sees that step complete, the reward is paid and the step recorded in
// completedQuestSteps, so it can never pay twice, whichever way it completed
// (a solo hunt, a co-op hunt's ledger, or the lodge).
//
// A save that finished rewarded steps before rewards existed is paid for them
// on its next visit to town.
//
// Pure apart from the ProgressionManager it is handed, so the headless harness
// can run it on a real one.

import { QUEST_LINES } from '../data/quests.js';

/**
 * Pays every rewarded step that is complete and not yet paid.
 * Returns [{ stepId, quest, step, huntTickets, text }] for what was paid, in
 * quest order; empty when nothing was.
 */
export function claimQuestRewards(pm) {
  const paid = [];
  for (const quest of QUEST_LINES) {
    for (const step of quest.steps || []) {
      const reward = step.reward;
      if (!reward || pm.isStepDone(step.id) || !step.isComplete(pm)) continue;
      pm.markStepDone(step.id);
      const huntTickets = Math.max(0, Number(reward.huntTickets) || 0);
      pm.huntTickets = (pm.huntTickets || 0) + huntTickets;
      paid.push({ stepId: step.id, quest: quest.title, step: step.label, huntTickets, text: reward.text || '' });
    }
  }
  return paid;
}

/** The dialogue shown for what claimQuestRewards paid: Elder Varek's word, one line per step. */
export function questRewardMessage(paid) {
  const total = paid.reduce((n, p) => n + p.huntTickets, 0);
  const lines = paid.map(p => `${p.step}: "${p.text}"  +${p.huntTickets}`);
  return `Elder Varek sends word, and ${total} Hunt Ticket${total === 1 ? '' : 's'}.\n\n${lines.join('\n')}`;
}

export default { claimQuestRewards, questRewardMessage };
