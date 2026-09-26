// src/systems/HuntQuests.js
//
// Where quests meet hunts (chunk 14b-2; vault IMPLEMENTATION_PLAN, "Bosses,
// omens and boss hunts"). One source of truth: a quest step in
// src/data/quests.js may carry `huntSite: { zone, eventId, far }`. While that
// step is active, every hunt in `zone` holds the site, placed for certain
// (HuntMapGen quest sites), so a guided step can never be missed.
//
// The other direction is region flags the hunt engine sets on the save
// (through world.questFlag, so a co-op hunt's ledger carries them to every
// player's own save):
//   hunted:<zone>      a clean exit with the primary objective done
//   apex_slain:<zone>  the region's apex killed
// Quests read them like any other flag.

import { QUEST_LINES, getStepState } from '../data/quests.js';

/** The flag the engine sets for `kind` ('hunted' | 'apex_slain') in a region. */
export function regionFlag(kind, zoneId) {
  return `${kind}:${zoneId}`;
}

/**
 * The sites the active quest steps need in `zoneId`, for the map generator:
 * [{ step, eventId, far }]. `pm` is the save's ProgressionManager (anything
 * with hasQuestFlag and the fields quest steps read).
 */
export function questSitesFor(zoneId, pm) {
  const out = [];
  for (const quest of QUEST_LINES) {
    for (const step of quest.steps || []) {
      const site = step.huntSite;
      if (!site || site.zone !== zoneId) continue;
      if (getStepState(step, pm) !== 'active') continue;
      out.push({ step: step.id, eventId: site.eventId, far: !!site.far });
    }
  }
  return out;
}
