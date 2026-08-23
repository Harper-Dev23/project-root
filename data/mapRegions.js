// data/mapRegions.js
// Clickable/hoverable region hotspots for the Behel'ith island map
// (assets/maps/Behelith_Island_Map.webp, 922x692).
//
// Only LARGE regions are defined here — individual sacred mountains, caves,
// and sub-locations (Mount Sinai, Cave of Adullam, Stones of Levithica, …)
// are deliberately left out even though the journal has entries for them.
//
// ── Where these coordinates came from ────────────────────────────────────
// Each polygon was placed by cross-referencing two sources:
//   1. The map art itself — distinct terrain paint (snowfield, red pines,
//      golden grassland, the dark mire, the pale-tree marsh, etc).
//   2. The journal gazetteer's opening line, which gives a real bearing for
//      every place — e.g. Reeds of Gethsemane "on the south-central shore,
//      west of the Bay of Solace"; Ecclesian Forest "north-central, between
//      the Numerian Plains to the east and the Mountains of Psalms to the
//      west". See data/journal/md/places/*.md.
//
// They are a careful first pass, NOT surveyed truth. MapOverlay ships a
// calibration mode (the ⟐ button) that lets you click a new outline and
// prints a ready-to-paste polygon to the console — use it to correct any
// region that sits wrong.
//
// `poly` is a list of [x, y] pairs NORMALIZED 0..1 against the map image,
// so it scales with any zoom/fit factor without re-authoring.
//
// `huntZoneId` links a region to data/zones.js — only regions carrying one
// are selectable in the Hunt "choose location" screen. Everything else
// renders as known-but-unreachable, which is what makes the map read as a
// real world with two open doors rather than a two-item list.

export const MAP_IMAGE_KEY = 'map_behelith_island';
export const MAP_NATIVE_SIZE = { width: 922, height: 692 };

// Terrain families → highlight tint. Kept coarse on purpose: the tint is a
// readability aid, never the only signal (every region also has a label).
export const TERRAIN_TINT = {
  tundra:     0xbfe6f2,
  coastal:    0x7fc8d8,
  mountain:   0xc9b79a,
  valley:     0xa8c07a,
  forest:     0x6fae5a,
  plains:     0xd8c26a,
  lake:       0x6fa8d8,
  ruins:      0xb0aab8,
  camp:       0xffd27f,
  swamp:      0x7f9a6a,
  jungle:     0x5f9a6f,
  wilderness: 0x6fae7a,
  desert:     0xd9a066,
  wetland:    0x8fbfa8,
  island:     0x9a8fa8,
};

export const MAP_REGIONS = [
  // ── North ──────────────────────────────────────────────────────────────
  {
    id: 'aurora_shores',
    name: 'Aurora Shores',
    terrain: 'coastal',
    journal: 'places/aurora_shores',
    blurb: 'A pristine snow beach on the northern coast, beneath an ever-present aurora.',
    poly: [[0.360,0.092],[0.395,0.052],[0.455,0.034],[0.525,0.052],[0.552,0.088],[0.500,0.100],[0.430,0.090]],
  },
  {
    id: 'frozen_steppes',
    name: 'The Frozen Steppes',
    terrain: 'tundra',
    journal: 'places/frozen_steppes',
    blurb: 'Endless pale tundra under razor-cold winds, far beyond the mountain arms.',
    poly: [[0.300,0.165],[0.330,0.100],[0.400,0.082],[0.480,0.090],[0.516,0.122],[0.512,0.186],[0.462,0.222],[0.386,0.226],[0.330,0.210]],
  },
  {
    id: 'abyssal_shores',
    name: 'The Abyssal Shores',
    terrain: 'coastal',
    journal: 'places/abyssal_shores',
    blurb: 'A frozen seascape on the north-northwest coast, where gentle waves hide glass-clear death.',
    poly: [[0.205,0.150],[0.232,0.104],[0.285,0.106],[0.315,0.145],[0.298,0.192],[0.240,0.196]],
  },
  {
    id: 'cradle_coast',
    name: 'Cradle Coast',
    terrain: 'coastal',
    journal: 'places/cradle_coast',
    blurb: 'Quiet northeastern dunes where the reeds seem to sing lullabies.',
    poly: [[0.610,0.192],[0.632,0.152],[0.688,0.140],[0.738,0.158],[0.742,0.198],[0.690,0.216],[0.638,0.214]],
  },

  // ── Western spine ──────────────────────────────────────────────────────
  {
    id: 'mountains_of_proverbs',
    name: 'The Mountains of Proverbs',
    terrain: 'mountain',
    journal: 'places/mountains_of_proverbs',
    blurb: 'The bleached western spine, curling north toward the Frozen Steppes.',
    poly: [[0.185,0.305],[0.212,0.238],[0.272,0.216],[0.325,0.252],[0.348,0.330],[0.336,0.420],[0.298,0.478],[0.242,0.474],[0.192,0.408]],
  },
  {
    id: 'wicked_coast',
    name: 'The Wicked Coast',
    terrain: 'coastal',
    journal: 'places/wicked_coast',
    blurb: 'Jagged west-northwest cliffs scourged by constant gales.',
    poly: [[0.150,0.400],[0.163,0.315],[0.196,0.302],[0.214,0.378],[0.206,0.470],[0.172,0.508]],
  },

  // ── North-central ──────────────────────────────────────────────────────
  {
    id: 'mountains_of_psalms',
    name: 'The Mountains of Psalms',
    terrain: 'mountain',
    journal: 'places/mountains_of_psalms',
    blurb: 'Mist-veiled peaks north of Lake Genesis, forking into two arms.',
    poly: [[0.348,0.262],[0.378,0.192],[0.442,0.166],[0.496,0.202],[0.506,0.282],[0.470,0.342],[0.400,0.346],[0.356,0.320]],
  },
  {
    id: 'valley_of_joshua',
    name: 'The Valley of Joshua',
    terrain: 'valley',
    journal: 'places/valley_of_joshua',
    blurb: 'Scorched plains bounded by Psalms to the northeast and Proverbs to the southwest.',
    poly: [[0.292,0.342],[0.326,0.278],[0.400,0.268],[0.455,0.302],[0.460,0.382],[0.420,0.436],[0.346,0.442],[0.296,0.402]],
  },
  {
    id: 'ecclesian_forest',
    name: 'The Ecclesian Forest',
    terrain: 'forest',
    journal: 'places/ecclesian_forest',
    blurb: 'North-central woodland between the Numerian Plains and the Mountains of Psalms.',
    poly: [[0.490,0.202],[0.506,0.136],[0.550,0.126],[0.586,0.172],[0.588,0.292],[0.566,0.366],[0.520,0.380],[0.490,0.320]],
  },
  {
    id: 'numerian_plains',
    name: 'The Numerian Plains',
    terrain: 'plains',
    journal: 'places/numerian_plains',
    blurb: 'Golden grasslands northeast of Lake Genesis, under fast-moving storms.',
    poly: [[0.596,0.246],[0.640,0.212],[0.720,0.196],[0.782,0.232],[0.800,0.290],[0.788,0.366],[0.738,0.424],[0.660,0.422],[0.602,0.352]],
  },

  // ── Central ────────────────────────────────────────────────────────────
  {
    id: 'lake_genesis',
    name: 'Lake Genesis',
    terrain: 'lake',
    journal: 'places/lake_genesis',
    blurb: 'Vast and impossibly deep, high on the plateau above Eden — it ripples always clockwise.',
    poly: [[0.455,0.425],[0.476,0.394],[0.526,0.386],[0.566,0.404],[0.566,0.450],[0.524,0.476],[0.474,0.468]],
  },
  {
    id: 'ruins_of_exodus',
    name: 'The Ruins of Exodus',
    terrain: 'ruins',
    journal: 'places/ruins_of_exodus',
    blurb: 'A vast half-sunken ruin straddling the River Wormwood, directly east of Lake Genesis.',
    poly: [[0.580,0.376],[0.600,0.334],[0.660,0.326],[0.716,0.344],[0.722,0.390],[0.680,0.416],[0.612,0.412]],
  },
  {
    id: 'camp_nehemiah',
    name: 'Camp Nehemiah',
    terrain: 'camp',
    journal: 'places/camp_nehemiah',
    blurb: 'Neutral ground raised by all four tribes — the only fire rival Hunters share.',
    isCamp: true,
    poly: [[0.735,0.446],[0.756,0.410],[0.802,0.406],[0.826,0.440],[0.816,0.480],[0.770,0.490],[0.740,0.474]],
  },
  {
    id: 'forest_of_eden',
    name: 'Forest of Eden',
    terrain: 'forest',
    journal: 'places/forest_of_eden',
    blurb: "The island's heart — ancient trunks surrounding the still waters of Lake Ezra.",
    poly: [[0.420,0.546],[0.440,0.486],[0.500,0.474],[0.566,0.490],[0.586,0.546],[0.566,0.602],[0.490,0.624],[0.436,0.600]],
  },

  // ── West / southwest ───────────────────────────────────────────────────
  {
    id: 'mire_of_plagues',
    name: 'The Mire of Plagues',
    terrain: 'swamp',
    journal: 'places/mire_of_plagues',
    blurb: 'A stagnant rot-swamp of divine infection below the cliffs of Proverbs.',
    poly: [[0.172,0.552],[0.190,0.466],[0.262,0.440],[0.350,0.456],[0.408,0.516],[0.406,0.622],[0.372,0.706],[0.312,0.762],[0.238,0.760],[0.186,0.694]],
  },
  {
    id: 'grasping_wild',
    name: 'The Grasping Wild',
    terrain: 'jungle',
    journal: 'places/grasping_wild',
    blurb: 'A jungle of living vines southwest of Eden — paths twist closed behind you.',
    poly: [[0.382,0.656],[0.402,0.596],[0.456,0.586],[0.500,0.616],[0.506,0.700],[0.476,0.766],[0.416,0.770],[0.384,0.720]],
  },

  // ── South / southeast ──────────────────────────────────────────────────
  {
    id: 'verdant_shroud',
    name: 'Verdant Shroud',
    terrain: 'wilderness',
    journal: 'places/verdant_shroud',
    blurb: 'An overgrown rainforest southeast of Eden, shaped by deliberate geometry.',
    poly: [[0.506,0.656],[0.526,0.592],[0.576,0.586],[0.606,0.632],[0.606,0.716],[0.576,0.770],[0.526,0.766],[0.503,0.710]],
  },
  {
    id: 'writhing_hills',
    name: 'The Writhing Hills',
    terrain: 'desert',
    journal: 'places/writhing_hills',
    blurb: 'Violet sands under a constant heat-haze, rolling like sleeping serpents.',
    poly: [[0.592,0.532],[0.622,0.468],[0.686,0.460],[0.746,0.500],[0.776,0.576],[0.766,0.646],[0.710,0.686],[0.640,0.666],[0.596,0.602]],
  },
  {
    id: 'dunes_of_zin',
    name: 'Dunes of Zin',
    terrain: 'desert',
    journal: 'places/dunes_of_zin',
    blurb: 'Salt-laced sands torn by cyclonic winds, running down to the southeastern coast.',
    poly: [[0.592,0.716],[0.616,0.674],[0.682,0.664],[0.750,0.686],[0.780,0.732],[0.754,0.786],[0.680,0.800],[0.616,0.776]],
  },
  {
    id: 'reeds_of_gethsemane',
    name: 'The Reeds of Gethsemane',
    terrain: 'wetland',
    journal: 'places/reeds_of_gethsemane',
    blurb: 'Chilling wetlands wreathed in sorrowful mist, on the south-central shore.',
    huntZoneId: 'reeds_of_gethsemane',
    poly: [[0.336,0.816],[0.366,0.774],[0.440,0.757],[0.520,0.762],[0.578,0.790],[0.583,0.842],[0.540,0.876],[0.440,0.884],[0.366,0.862]],
  },
  {
    id: 'bay_of_solace',
    name: 'Bay of Solace',
    terrain: 'coastal',
    journal: 'places/bay_of_solace',
    blurb: 'Glass-calm tidal shallows and wind-worn dunes along the southeastern coast.',
    huntZoneId: 'bay_of_solace',
    poly: [[0.582,0.796],[0.600,0.748],[0.646,0.738],[0.674,0.776],[0.666,0.820],[0.620,0.836],[0.588,0.826]],
  },
  {
    id: 'islet_of_job',
    name: 'Islet of Job',
    terrain: 'island',
    journal: 'places/islet_of_job',
    blurb: 'A small weathered scrap of land in the southeast, ringed by shifting shallows and mist.',
    poly: [[0.686,0.846],[0.706,0.788],[0.756,0.778],[0.790,0.816],[0.796,0.876],[0.756,0.918],[0.706,0.906]],
  },
];

export function getMapRegion(id) {
  return MAP_REGIONS.find(r => r.id === id) || null;
}

/** Regions that are playable hunt destinations (linked to data/zones.js). */
export function listHuntableRegions() {
  return MAP_REGIONS.filter(r => !!r.huntZoneId);
}

/**
 * Even-odd point-in-polygon test against a NORMALIZED polygon.
 * px/py must already be normalized to the same 0..1 image space.
 */
export function pointInPoly(poly, px, py) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const intersects = (yi > py) !== (yj > py)
      && px < ((xj - xi) * (py - yi)) / ((yj - yi) || 1e-12) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Centroid of a normalized polygon — used to anchor labels. */
export function polyCentroid(poly) {
  let x = 0, y = 0;
  for (const [px, py] of poly) { x += px; y += py; }
  return [x / poly.length, y / poly.length];
}
