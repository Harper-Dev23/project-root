// src/systems/QuestRewards.js
//
// Reporting to Elder Varek (owner 2026-09-29; batch 4b chunk 1). A step in
// src/data/quests.js may carry `reward: { huntTickets, text, item? }`. Once
// its condition is met in the field it waits in the 'report' state
// (getStepState) until the party visits the Elders' Tower, where
// claimQuestRewards pays it and records it in completedQuestSteps: it can
// never pay twice, whichever way it completed (a solo hunt, a co-op hunt's
// ledger, or the lodge). The rest of its questline waits on that record.
//
// `item: { base, rarity }` is an item the Elder hands over with the tickets
// (chunk 2: the Reeds' Cull and Apex plans), made at `itemLevel` and given
// through `addItem`; without an `addItem` (the harness) it is only listed.
//
// A save that finished rewarded steps before rewards existed reports them on
// its next visit to the tower.
//
// Pure apart from the ProgressionManager it is handed, so the headless harness
// can run it on a real one.

import { QUEST_LINES, getStepState } from '../data/quests.js';
import { createItemInstance } from './ItemFactory.js';
import { Items } from '../../data/items.js';

/**
 * Reports every step waiting for it, in quest order: pays and records each.
 * A step unlocked by an earlier report in the same visit (an old save that
 * finished several) is reported too, since the walk is in order.
 * Returns [{ stepId, quest, step, huntTickets, text, item }]; empty when nothing was.
 */
export function claimQuestRewards(pm, { addItem = null, itemLevel = 1 } = {}) {
  const paid = [];
  for (const quest of QUEST_LINES) {
    for (const step of quest.steps || []) {
      const reward = step.reward;
      if (!reward || getStepState(step, pm) !== 'report') continue;
      pm.markStepDone(step.id);
      const huntTickets = Math.max(0, Number(reward.huntTickets) || 0);
      pm.huntTickets = (pm.huntTickets || 0) + huntTickets;
      let item = null;
      if (reward.item && Items[reward.item.base]) {
        item = createItemInstance(reward.item.base, { rarity: reward.item.rarity, itemLevel: Math.max(1, itemLevel | 0) });
        if (item) addItem?.(item);
      }
      paid.push({ stepId: step.id, quest: quest.title, step: step.label, huntTickets, text: reward.text || '', item });
    }
  }
  return paid;
}

const cap = (w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : '');

/** What Elder Varek says for what claimQuestRewards paid: one line per step. */
export function questRewardMessage(paid) {
  const total = paid.reduce((n, p) => n + p.huntTickets, 0);
  const lines = paid.map(p => {
    const gift = p.item ? `, and a ${cap(p.item.rarity)} ${Items[p.item.id]?.name || p.item.id}` : '';
    return `${p.step}: "${p.text}"  +${p.huntTickets}${gift}`;
  });
  return `Elder Varek hears your report, and pays ${total} Hunt Ticket${total === 1 ? '' : 's'}.\n\n${lines.join('\n')}`;
}

export default { claimQuestRewards, questRewardMessage };
