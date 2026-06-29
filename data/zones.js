// data/zones.js
// Static hunt zone data. Two starting zones only — the rest of the island's
// ~30 zones (Zones_Regions/ in the design vault) come online in a later pass.
//
// Both zones run through the same HuntManager loop; only flavor, terrain, and
// encounter-table contents differ. Encounter tables are stubbed (2-3 entries)
// per ENCOUNTER_SYSTEM.md's MVP scope — real per-zone content is a later pass.
//
// 'beasts'/'cultists' entries are flavor labels for fights (see EncounterRoller.js).
// 'environmental'/'microZone'/'flexible' entries are full Event definitions —
// adapted from Behel'ith Vault/Converted notes/{Encounters,Zechariah's_Trials}.md,
// reworked for a single-player party (see EventResolver.js / HuntEncounterOverlay.js):
//   kind: 'check'   — stat vs DC, resolved via a physically-thrown dice token
//   kind: 'choice'  — pick one of several options, each with its own outcome
//   kind: 'puzzle'  — a riddle/pattern with a few multiple-choice answers
// `nightOnly`/`dayOnly` (optional) restrict an entry to that half of the
// day/night cycle — filtered in EncounterRoller.js using HuntManager's state.

export const ZONES = {
  reeds_of_gethsemane: {
    id: 'reeds_of_gethsemane',
    name: 'The Reeds of Gethsemane',
    dangerTier: 1,
    terrain: 'wetland',
    divineAlignment: 'jeremiah',
    flavor: 'Chilling wetlands wreathed in sorrowful mist, where grief seems to seep up from the mud itself.',
    // Thick reeds and standing water make for slow, beast-rich going.
    modifiers: { encounterChancePercent: 6, supplyEfficiencyPercent: -5 },
    encounterTable: {
      beasts: [
        { id: 'reeds_marsh_stalker',   label: 'A marsh stalker slips through the reeds.' },
        { id: 'reeds_wading_heron',    label: 'A wading heron watches you pass, unbothered.' },
      ],
      cultists: [
        { id: 'reeds_hooded_figures',  label: 'Hooded figures murmur over something half-buried in the mud.' },
        { id: 'reeds_cult_scouts',     label: 'A pair of scouts in ash-grey robes freeze at the sight of you.' },
      ],
      environmental: [
        {
          id: 'reeds_sinking_mud',
          label: 'The ground gives way to sucking mud underfoot.',
          kind: 'check',
          stat: 'DEX',
          dc: 12,
          success: { text: 'You catch yourself on a reed clump and pull free.', huntPoints: 2 },
          failure: { text: 'You sink to the waist before hauling free, soaked and shaken.', huntPoints: 0, hpDelta: -4 },
        },
      ],
      microZone: [
        {
          id: 'reeds_sunken_shrine',
          label: 'A half-sunken shrine pokes above the waterline.',
          kind: 'choice',
          options: [
            { text: 'Pray quietly at the shrine', outcome: { text: 'The grief in the air eases, if only for a moment.', huntPoints: 3, xp: 5 } },
            { text: 'Search it for anything useful', outcome: { text: 'You find nothing but old wax and waterlogged cloth.', huntPoints: 1 } },
            { text: 'Leave it undisturbed', outcome: { text: 'Some things are better left to the dead.', huntPoints: 0 } },
          ],
        },
      ],
      flexible: [
        {
          id: 'reeds_distant_weeping',
          label: 'A faint, distant weeping carries over the water.',
          kind: 'puzzle',
          prompt: 'A voice rises from the mist: "I am taken without being touched, and given without being held. What am I?"',
          answers: ['Breath', 'A name', 'Time', 'Grief'],
          correctIndex: 1,
          success: { text: 'The weeping pauses, as if heard. You feel strangely lighter.', huntPoints: 4, xp: 8 },
          failure: { text: 'The weeping only deepens, swallowed by the reeds.', huntPoints: 0 },
        },
        {
          id: 'reeds_stranger_at_camp',
          label: 'A silent figure sits at the edge of your firelight, unmoving.',
          kind: 'choice',
          nightOnly: true,
          options: [
            { text: 'Speak to them', outcome: { text: 'They offer no name, only a riddle about sorrow — then are gone by morning.', huntPoints: 3, xp: 5 } },
            { text: 'Keep your distance', outcome: { text: 'By dawn, they are simply gone, as if they were never there.', huntPoints: 0 } },
          ],
        },
      ],
    },
  },

  bay_of_solace: {
    id: 'bay_of_solace',
    name: 'Bay of Solace',
    dangerTier: 1,
    terrain: 'coastal',
    divineAlignment: null,
    flavor: 'Calm tidal shallows and wind-worn dunes, quiet enough that danger here always feels like a surprise.',
    // Open, flat coastline — easy travel, but little cover means fewer encounters too.
    modifiers: { encounterChancePercent: -4, supplyEfficiencyPercent: 8 },
    encounterTable: {
      beasts: [
        { id: 'bay_tide_crab',       label: 'An oversized tide crab scuttles out of a rockpool.' },
        { id: 'bay_gull_flock',      label: 'A flock of gulls scatters noisily ahead of you.' },
      ],
      cultists: [
        { id: 'bay_beach_cultists',  label: 'A small camp of robed figures has staked out the dunes ahead.' },
        { id: 'bay_tide_watchers',   label: 'Figures stand motionless at the waterline, watching the horizon.' },
      ],
      environmental: [
        {
          id: 'bay_rising_tide',
          label: 'The tide rises faster than expected, cutting off a path.',
          kind: 'check',
          stat: 'CON',
          dc: 11,
          success: { text: 'You push through the surf before it deepens further.', huntPoints: 2 },
          failure: { text: 'The cold water saps your strength before you reach dry sand.', huntPoints: 0, hpDelta: -3 },
        },
      ],
      microZone: [
        {
          id: 'bay_wrecked_hull',
          label: 'The ribs of a wrecked hull jut from the sand.',
          kind: 'choice',
          options: [
            { text: 'Search the wreck', outcome: { text: 'Among the rotted planks you find something salvageable.', huntPoints: 3, xp: 5 } },
            { text: 'Pay your respects and move on', outcome: { text: 'Whatever crew once sailed her, they are long past needing the wreck.', huntPoints: 1 } },
          ],
        },
      ],
      flexible: [
        {
          id: 'bay_driftwood_idol',
          label: 'Someone has stacked driftwood into a crude idol shape.',
          kind: 'puzzle',
          prompt: 'Carved into the driftwood: "I have a bed but never sleep, a mouth but never speak. What am I?"',
          answers: ['A river', 'A shadow', 'A wave', 'A shell'],
          correctIndex: 0,
          success: { text: 'The idol seems to settle, as if satisfied.', huntPoints: 4, xp: 8 },
          failure: { text: 'The driftwood idol topples in the wind, unanswered.', huntPoints: 0 },
        },
        {
          id: 'bay_lantern_glow',
          label: 'A faint lantern glow bobs far out on the water, going nowhere.',
          kind: 'choice',
          nightOnly: true,
          options: [
            { text: 'Watch for a while', outcome: { text: 'The light drifts closer, then winks out entirely.', huntPoints: 2, xp: 4 } },
            { text: 'Look away and tend the fire', outcome: { text: "You don't look back. Some things are better not seen clearly.", huntPoints: 0 } },
          ],
        },
      ],
    },
  },
};

export function getZone(zoneId) {
  return ZONES[zoneId] || null;
}

export function listZones() {
  return Object.values(ZONES);
}
