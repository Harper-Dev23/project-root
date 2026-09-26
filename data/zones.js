// data/zones.js
// Static hunt zone data. Two starting zones only — the rest of the island's
// ~30 zones (Zones_Regions/ in the design vault) come online in a later pass.
//
// Both zones run through the same HuntManager loop; only flavor, terrain, and
// encounter-table contents differ. Encounter tables are stubbed (2-3 entries)
// per ENCOUNTER_SYSTEM.md's MVP scope — real per-zone content is a later pass.
//
// 'beasts'/'cultists' entries are flavor labels for the old Advance loop's
// fights (see EncounterRoller.js). Events are no longer here: they are
// templates in data/events.js (Exploration System v2, chunk 11a), and the old
// Advance loop's events were retired with it (owner, 2026-09-24). `setPieces`
// names event templates the generator places on purpose (a Commune shrine).

export const ZONES = {
  reeds_of_gethsemane: {
    id: 'reeds_of_gethsemane',
    name: 'The Reeds of Gethsemane',
    danger: 1,          // 1-10; item level = danger (huntItemLevel, HuntScaling.js)
    deathRule: 'sheltered', // a starting coast: a wipe risks nothing in the pack (zoneDeathRule, HuntManager.js)
    terrain: 'wetland',
    divineAlignment: 'jeremiah',
    falseGod: 'dagon',  // the false god that tempts here (chunk 11c; data/falseGods.js)
    flavor: 'Chilling wetlands wreathed in sorrowful mist, where grief seems to seep up from the mud itself.',
    // Thick reeds and standing water make for slow, beast-rich going.
    modifiers: { encounterChancePercent: 6, supplyEfficiencyPercent: -5 },
    // ── Hunt map generator data (chunk 5; reader: HuntMapGen.generateHuntMap) ──
    // palette: weighted grounds (data/grounds.js); relief: flat/hills/highland
    // odds. Blight is never in a palette: it is placed around a source.
    palette: { marsh: 30, grass: 25, thicket: 15, water: 15, woodland: 15 },
    relief: { flat: 80, hills: 20, highland: 0 },
    // Native beast families. 'Kill the apex' and 'cull a native family' are
    // filled from here (HUNT_PLANS, roles). Which grounds each favours is on
    // the ground (GROUNDS[..].families). Names are placeholders until the
    // beast families land (chunk 9).
    // `predator: true`: a Roaming pack of it that notices the party hunts it
    // (WORLD_SIM "a few predator families"; HuntWorld.stepPack, chunk 13c).
    // The flagship roster (chunk 14a, owner 2026-09-25; data/beastParts.js).
    natives: {
      crocodile:       { name: 'Crocodile', predator: true },
      marsh_viper:     { name: 'Marsh Viper', predator: true },
      bog_frog:        { name: 'Bog Frog' },
      swamp_crab:      { name: 'Swamp Crab' },
      nutria:          { name: 'Nutria' },
      marsh_bat:       { name: 'Marsh Bat' },
      // Solitary: alone or a mother with young, never a pack (and never a
      // Cull quarry). HuntMapGen familyAllows.
      snapping_turtle: { name: 'Snapping Turtle', compositions: ['lone', 'matriarch'] },
      scarlet_ibis:    { name: 'Scarlet Ibis' },
    },
    // The Vowback Crocodile: an ancient crocodile grown over with prayer stones.
    // Its brood lies with it (escort, read by HuntMapGen apex_beast).
    apex: { family: 'vowback_crocodile', name: 'the Vowback Crocodile', escort: [{ family: 'crocodile', grade: 'grown', count: 3 }] },
    cultistShare: 0.25,   // share of hostile occupants that are cultist bands
    // The shrine a Commune plan sends you to: an event template (data/events.js).
    setPieces: { shrine: 'reeds_sunken_shrine' },
    encounterTable: {
      beasts: [
        { id: 'reeds_marsh_stalker',   label: 'A marsh stalker slips through the reeds.' },
        { id: 'reeds_wading_heron',    label: 'A wading heron watches you pass, unbothered.' },
      ],
      cultists: [
        { id: 'reeds_hooded_figures',  label: 'Hooded figures murmur over something half-buried in the mud.' },
        { id: 'reeds_cult_scouts',     label: 'A pair of scouts in ash-grey robes freeze at the sight of you.' },
      ],
    },
  },

  bay_of_solace: {
    id: 'bay_of_solace',
    name: 'Bay of Solace',
    danger: 1,          // 1-10; item level = danger (huntItemLevel, HuntScaling.js)
    deathRule: 'sheltered', // a starting coast: a wipe risks nothing in the pack (zoneDeathRule, HuntManager.js)
    terrain: 'coastal',
    divineAlignment: 'ezekiel', // STANDING (owner, 2026-09-18): Bay of Solace = Ezekiel
    falseGod: 'yargaleth',  // the false god that tempts here (chunk 11c; data/falseGods.js)
    flavor: 'Calm tidal shallows and wind-worn dunes, quiet enough that danger here always feels like a surprise.',
    // Open, flat coastline — easy travel, but little cover means fewer encounters too.
    modifiers: { encounterChancePercent: -4, supplyEfficiencyPercent: 8 },
    // Hunt map generator data: see the Reeds above.
    palette: { shingle: 35, grass: 20, heath: 15, water: 15, dunes: 10, marsh: 5 },
    relief: { flat: 90, hills: 10, highland: 0 },
    natives: {
      tide_crab:  { name: 'Tide Crab' },
      shore_gull: { name: 'Shore Gull', predator: true },
    },
    apex: { family: 'tide_crab' },
    cultistShare: 0.2,
    setPieces: { shrine: 'bay_driftwood_idol' },
    encounterTable: {
      beasts: [
        { id: 'bay_tide_crab',       label: 'An oversized tide crab scuttles out of a rockpool.' },
        { id: 'bay_gull_flock',      label: 'A flock of gulls scatters noisily ahead of you.' },
      ],
      cultists: [
        { id: 'bay_beach_cultists',  label: 'A small camp of robed figures has staked out the dunes ahead.' },
        { id: 'bay_tide_watchers',   label: 'Figures stand motionless at the waterline, watching the horizon.' },
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
