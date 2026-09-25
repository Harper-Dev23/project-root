// tools/headless/walkAway.js
//
// For harness walkers that are not about events (chunk 11a). An event site
// opens when the party steps onto it and freezes the hunt until it is resolved
// or walked away from (EVENTS decision 3). A walker written before events
// would stall there. `walkAway(hunt)` makes a hunt walk away from any event
// its move() opens, as a player who ignores events would: the site stays, and
// nothing else changes. tools/headless/events.mjs does NOT use it; it tests
// events for real.

/** The same hunt, whose move() walks away from any event it opens. */
export function walkAway(hunt) {
  if (!hunt || hunt.__walksAway) return hunt;
  const move = hunt.move.bind(hunt);
  hunt.__rawMove = move;   // for a test that wants an event to open after all
  hunt.move = (to) => {
    // Since 13c a won fight or a harvest can open the site the party stands
    // on (HuntEngine._openEventHere); walk away from that one first too.
    if (hunt.view().event) hunt.leaveEvent();
    const r = move(to);
    if (hunt.view().event) hunt.leaveEvent();
    return r;
  };
  hunt.__walksAway = true;
  return hunt;
}

/** createMapHunt / restoreMapHunt wrapped with walkAway. */
export function walkingAway({ createMapHunt, restoreMapHunt }) {
  return {
    createMapHunt: (...a) => walkAway(createMapHunt(...a)),
    restoreMapHunt: (...a) => walkAway(restoreMapHunt(...a)),
  };
}
