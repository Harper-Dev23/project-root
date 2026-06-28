// data/zones.js
// Static hunt zone data. Two starting zones only — the rest of the island's
// ~30 zones (Zones_Regions/ in the design vault) come online in a later pass.
//
// Both zones run through the same HuntManager loop; only flavor, terrain, and
// encounter-table contents differ. Encounter tables are stubbed (2-3 entries)
// per ENCOUNTER_SYSTEM.md's MVP scope — real per-zone content is a later pass.

export const ZONES = {
  reeds_of_gethsemane: {
    id: 'reeds_of_gethsemane',
    name: 'The Reeds of Gethsemane',
    dangerTier: 1,
    terrain: 'wetland',
    divineAlignment: 'jeremiah',
    flavor: 'Chilling wetlands wreathed in sorrowful mist, where grief seems to seep up from the mud itself.',
    encounterTable: {
      beasts: [
        { id: 'reeds_marsh_stalker',   label: 'A marsh stalker slips through the reeds.' },
        { id: 'reeds_wading_heron',    label: 'A wading heron watches you pass, unbothered.' },
      ],
      environmental: [
        { id: 'reeds_sinking_mud',     label: 'The ground gives way to sucking mud underfoot.' },
      ],
      microZone: [
        { id: 'reeds_sunken_shrine',   label: 'A half-sunken shrine pokes above the waterline.' },
      ],
      flexible: [
        { id: 'reeds_distant_weeping', label: 'A faint, distant weeping carries over the water.' },
      ],
    },
    lootTable: [
      { id: 'reeds_reed_bundle', label: 'Reed Bundle' },
      { id: 'reeds_marsh_root',  label: 'Marsh Root' },
    ],
  },

  bay_of_solace: {
    id: 'bay_of_solace',
    name: 'Bay of Solace',
    dangerTier: 1,
    terrain: 'coastal',
    divineAlignment: null,
    flavor: 'Calm tidal shallows and wind-worn dunes, quiet enough that danger here always feels like a surprise.',
    encounterTable: {
      beasts: [
        { id: 'bay_tide_crab',       label: 'An oversized tide crab scuttles out of a rockpool.' },
        { id: 'bay_gull_flock',      label: 'A flock of gulls scatters noisily ahead of you.' },
      ],
      environmental: [
        { id: 'bay_rising_tide',     label: 'The tide rises faster than expected, cutting off a path.' },
      ],
      microZone: [
        { id: 'bay_wrecked_hull',    label: 'The ribs of a wrecked hull jut from the sand.' },
      ],
      flexible: [
        { id: 'bay_driftwood_idol',  label: 'Someone has stacked driftwood into a crude idol shape.' },
      ],
    },
    lootTable: [
      { id: 'bay_sea_glass',  label: 'Sea Glass' },
      { id: 'bay_dried_kelp', label: 'Dried Kelp' },
    ],
  },
};

export function getZone(zoneId) {
  return ZONES[zoneId] || null;
}

export function listZones() {
  return Object.values(ZONES);
}
