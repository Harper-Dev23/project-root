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
import { CULT_MARKETS } from '../../data/cultMarkets.js';
import { getZone } from '../../data/zones.js';

/** The title of the quest line a step belongs to, or null (a quest site's panel names it). */
export function questTitleForStep(stepId) {
  for (const quest of QUEST_LINES) if ((quest.steps || []).some(st => st.id === stepId)) return quest.title;
  return null;
}

/** The flag the engine sets for `kind` ('hunted' | 'apex_slain') in a region. */
export function regionFlag(kind, zoneId) {
  return `${kind}:${zoneId}`;
}

/**
 * The sites the active quest steps need in `zoneId`, for the map generator:
 * [{ step, eventId or beast, far, pct? }]. `pm` is the save's ProgressionManager (anything
 * with hasQuestFlag and the fields quest steps read).
 */
export function questSitesFor(zoneId, pm) {
  const out = [];
  for (const quest of QUEST_LINES) {
    for (const step of quest.steps || []) {
      const site = step.huntSite;
      if (!site || site.zone !== zoneId) continue;
      if (getStepState(step, pm) !== 'active') continue;
      // A site is an event, or a quest beast (`beast`: HuntMapGen places it).
      out.push(site.beast ? { step: step.id, beast: site.beast, far: !!site.far } : { step: step.id, eventId: site.eventId, far: !!site.far });
    }
  }
  // A cult's black market, once its questline opens it: on `pct` of the
  // region's hunts (rolled per map by the generator), anywhere on the map.
  for (const [cult, m] of Object.entries(CULT_MARKETS)) {
    if (!m.zones.includes(zoneId) || !pm?.hasQuestFlag?.(m.unlockFlag)) continue;
    out.push({ step: `market:${cult}`, eventId: m.eventId, far: false, pct: m.pct });
  }
  // A rare beast (zones rareBeasts, owner 2026-09-27), once its flag is set:
  // on `pct` of hunts, not marked as a quest ("rare:<id>" sites are not).
  for (const r of getZone(zoneId)?.rareBeasts || []) {
    if (r.afterFlag && !pm?.hasQuestFlag?.(r.afterFlag)) continue;
    out.push({ step: `rare:${r.id}`, beast: r.beast, far: true, pct: r.pct });
  }
  return out;
}
