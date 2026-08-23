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
  river:      0x5f9fd0,
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
    poly: [[0.390,0.102],[0.437,0.119],[0.486,0.123],[0.519,0.129],[0.564,0.107],[0.571,0.099],[0.540,0.067],[0.498,0.050],[0.453,0.049],[0.407,0.058],[0.383,0.079]],
  },
  {
    id: 'frozen_steppes',
    name: 'The Frozen Steppes',
    terrain: 'tundra',
    journal: 'places/frozen_steppes',
    blurb: 'Endless pale tundra under razor-cold winds, far beyond the mountain arms.',
    poly: [[0.281,0.267],[0.351,0.254],[0.366,0.234],[0.381,0.213],[0.394,0.220],[0.413,0.194],[0.429,0.211],[0.445,0.186],[0.457,0.191],[0.482,0.156],[0.431,0.136],[0.379,0.130],[0.334,0.146],[0.301,0.176],[0.276,0.195],[0.258,0.219],[0.271,0.243]],
  },
  {
    id: 'abyssal_shores',
    name: 'The Abyssal Shores',
    terrain: 'coastal',
    journal: 'places/abyssal_shores',
    blurb: 'A frozen seascape on the north-northwest coast, where gentle waves hide glass-clear death.',
    poly: [[0.331,0.137],[0.285,0.173],[0.241,0.220],[0.216,0.209],[0.228,0.174],[0.251,0.150],[0.267,0.133],[0.297,0.117],[0.322,0.127]],
  },
  {
    id: 'cradle_coast',
    name: 'Cradle Coast',
    terrain: 'coastal',
    journal: 'places/cradle_coast',
    blurb: 'Quiet northeastern dunes where the reeds seem to sing lullabies.',
    poly: [[0.609,0.124],[0.606,0.153],[0.652,0.185],[0.690,0.215],[0.706,0.251],[0.724,0.273],[0.746,0.276],[0.744,0.243],[0.725,0.196],[0.698,0.173],[0.653,0.150],[0.630,0.140]],
  },

  // ── Western spine ──────────────────────────────────────────────────────
  {
    id: 'mountains_of_proverbs',
    name: 'The Mountains of Proverbs',
    terrain: 'mountain',
    journal: 'places/mountains_of_proverbs',
    blurb: 'The bleached western spine, curling north toward the Frozen Steppes.',
    poly: [[0.212,0.256],[0.189,0.301],[0.213,0.342],[0.195,0.380],[0.232,0.431],[0.264,0.455],[0.316,0.464],[0.365,0.459],[0.422,0.444],[0.405,0.421],[0.342,0.417],[0.296,0.393],[0.268,0.356],[0.258,0.318],[0.275,0.298],[0.253,0.274],[0.229,0.230]],
  },
  {
    id: 'wicked_coast',
    name: 'The Wicked Coast',
    terrain: 'coastal',
    journal: 'places/wicked_coast',
    blurb: 'Jagged west-northwest cliffs scourged by constant gales.',
    poly: [[0.174,0.309],[0.192,0.359],[0.184,0.403],[0.196,0.454],[0.177,0.515],[0.146,0.539],[0.145,0.495],[0.173,0.430],[0.163,0.393],[0.163,0.322]],
  },

  // ── North-central ──────────────────────────────────────────────────────
  {
    id: 'mountains_of_psalms',
    name: 'The Mountains of Psalms',
    terrain: 'mountain',
    journal: 'places/mountains_of_psalms',
    blurb: 'Mist-veiled peaks north of Lake Genesis, forking into two arms.',
    poly: [[0.371,0.264],[0.431,0.270],[0.442,0.309],[0.436,0.343],[0.453,0.372],[0.490,0.358],[0.477,0.325],[0.477,0.285],[0.475,0.250],[0.481,0.220],[0.502,0.198],[0.516,0.189],[0.495,0.149],[0.459,0.202],[0.445,0.192],[0.432,0.215],[0.414,0.198],[0.394,0.226],[0.381,0.222],[0.354,0.251]],
  },
  {
    id: 'valley_of_joshua',
    name: 'The Valley of Joshua',
    terrain: 'valley',
    journal: 'places/valley_of_joshua',
    blurb: 'Scorched plains bounded by Psalms to the northeast and Proverbs to the southwest.',
    poly: [[0.292,0.297],[0.282,0.343],[0.316,0.377],[0.355,0.403],[0.389,0.391],[0.415,0.369],[0.421,0.328],[0.419,0.292],[0.379,0.284],[0.349,0.270],[0.313,0.280]],
  },
  {
    id: 'ecclesian_forest',
    name: 'The Ecclesian Forest',
    terrain: 'forest',
    journal: 'places/ecclesian_forest',
    blurb: 'North-central woodland between the Numerian Plains and the Mountains of Psalms.',
    poly: [[0.544,0.152],[0.564,0.205],[0.560,0.270],[0.548,0.308],[0.547,0.352],[0.508,0.360],[0.489,0.307],[0.494,0.263],[0.496,0.223],[0.521,0.199],[0.531,0.172]],
  },
  {
    id: 'numerian_plains',
    name: 'The Numerian Plains',
    terrain: 'plains',
    journal: 'places/numerian_plains',
    blurb: 'Golden grasslands northeast of Lake Genesis, under fast-moving storms.',
    poly: [[0.597,0.338],[0.639,0.349],[0.696,0.359],[0.753,0.360],[0.740,0.305],[0.701,0.280],[0.676,0.230],[0.633,0.198],[0.625,0.216],[0.631,0.257],[0.628,0.284],[0.608,0.290],[0.591,0.321]],
  },

  // ── Central ────────────────────────────────────────────────────────────
  {
    id: 'lake_genesis',
    name: 'Lake Genesis',
    terrain: 'lake',
    journal: 'places/lake_genesis',
    blurb: 'Vast and impossibly deep, high on the plateau above Eden — it ripples always clockwise.',
    poly: [[0.565,0.438],[0.525,0.459],[0.484,0.459],[0.465,0.451],[0.458,0.438],[0.460,0.410],[0.483,0.399],[0.511,0.390],[0.532,0.393],[0.560,0.406],[0.568,0.423]],
  },
  {
    id: 'ruins_of_exodus',
    name: 'The Ruins of Exodus',
    terrain: 'ruins',
    journal: 'places/ruins_of_exodus',
    blurb: 'A vast half-sunken ruin straddling the River Wormwood, directly east of Lake Genesis.',
    poly: [[0.586,0.379],[0.625,0.355],[0.667,0.349],[0.703,0.370],[0.711,0.394],[0.667,0.416],[0.636,0.418],[0.609,0.401]],
  },
  {
    id: 'camp_nehemiah',
    name: 'Camp Nehemiah',
    terrain: 'camp',
    journal: 'places/camp_nehemiah',
    blurb: 'Neutral ground raised by all four tribes — the only fire rival Hunters share.',
    isCamp: true,
    poly: [[0.763,0.428],[0.714,0.469],[0.737,0.505],[0.775,0.515],[0.801,0.491],[0.814,0.455],[0.798,0.428],[0.780,0.424]],
  },
  {
    id: 'forest_of_eden',
    name: 'Forest of Eden',
    terrain: 'forest',
    journal: 'places/forest_of_eden',
    blurb: "The island's heart — ancient trunks surrounding the still waters of Lake Ezra.",
    poly: [[0.589,0.492],[0.591,0.561],[0.587,0.594],[0.554,0.611],[0.511,0.614],[0.480,0.607],[0.450,0.594],[0.431,0.566],[0.428,0.540],[0.446,0.520],[0.470,0.510],[0.502,0.505],[0.534,0.505],[0.553,0.498],[0.577,0.489]],
  },

  // ── West / southwest ───────────────────────────────────────────────────
  {
    id: 'mire_of_plagues',
    name: 'The Mire of Plagues',
    terrain: 'swamp',
    journal: 'places/mire_of_plagues',
    blurb: 'A stagnant rot-swamp of divine infection below the cliffs of Proverbs.',
    poly: [[0.385,0.509],[0.377,0.626],[0.377,0.689],[0.332,0.738],[0.238,0.741],[0.195,0.711],[0.184,0.622],[0.184,0.573],[0.229,0.534],[0.288,0.512],[0.341,0.508]],
  },
  {
    id: 'grasping_wild',
    name: 'The Grasping Wild',
    terrain: 'jungle',
    journal: 'places/grasping_wild',
    blurb: 'A jungle of living vines southwest of Eden — paths twist closed behind you.',
    poly: [[0.499,0.643],[0.499,0.704],[0.498,0.762],[0.458,0.762],[0.410,0.757],[0.394,0.754],[0.398,0.709],[0.402,0.655],[0.415,0.622],[0.436,0.611],[0.475,0.619],[0.490,0.629]],
  },

  // ── South / southeast ──────────────────────────────────────────────────
  {
    id: 'verdant_shroud',
    name: 'Verdant Shroud',
    terrain: 'wilderness',
    journal: 'places/verdant_shroud',
    blurb: 'An overgrown rainforest southeast of Eden, shaped by deliberate geometry.',
    poly: [[0.592,0.609],[0.603,0.658],[0.601,0.692],[0.575,0.728],[0.563,0.764],[0.551,0.777],[0.528,0.764],[0.503,0.769],[0.506,0.717],[0.506,0.677],[0.507,0.632],[0.535,0.632],[0.561,0.625],[0.577,0.608]],
  },
  {
    id: 'writhing_hills',
    name: 'The Writhing Hills',
    terrain: 'desert',
    journal: 'places/writhing_hills',
    blurb: 'Violet sands under a constant heat-haze, rolling like sleeping serpents.',
    poly: [[0.595,0.476],[0.645,0.485],[0.689,0.520],[0.704,0.547],[0.683,0.567],[0.669,0.601],[0.628,0.612],[0.599,0.632],[0.594,0.590],[0.601,0.540]],
  },
  {
    id: 'dunes_of_zin',
    name: 'Dunes of Zin',
    terrain: 'desert',
    journal: 'places/dunes_of_zin',
    blurb: 'Salt-laced sands torn by cyclonic winds, running down to the southeastern coast.',
    poly: [[0.703,0.549],[0.723,0.568],[0.720,0.607],[0.749,0.717],[0.729,0.734],[0.706,0.724],[0.669,0.679],[0.639,0.669],[0.615,0.673],[0.606,0.631],[0.631,0.617],[0.660,0.619],[0.679,0.594],[0.687,0.570]],
  },
  {
    id: 'reeds_of_gethsemane',
    name: 'The Reeds of Gethsemane',
    terrain: 'wetland',
    journal: 'places/reeds_of_gethsemane',
    blurb: 'Chilling wetlands wreathed in sorrowful mist, on the south-central shore.',
    huntZoneId: 'reeds_of_gethsemane',
    poly: [[0.594,0.811],[0.582,0.840],[0.558,0.860],[0.530,0.864],[0.490,0.847],[0.434,0.842],[0.390,0.843],[0.329,0.857],[0.340,0.806],[0.366,0.781],[0.406,0.768],[0.442,0.771],[0.470,0.777],[0.507,0.774],[0.532,0.771],[0.563,0.784],[0.582,0.802]],
  },
  {
    id: 'bay_of_solace',
    name: 'Bay of Solace',
    terrain: 'coastal',
    journal: 'places/bay_of_solace',
    blurb: 'Glass-calm tidal shallows and wind-worn dunes along the southeastern coast.',
    huntZoneId: 'bay_of_solace',
    poly: [[0.723,0.734],[0.727,0.771],[0.683,0.764],[0.643,0.714],[0.618,0.728],[0.601,0.794],[0.588,0.735],[0.616,0.685],[0.642,0.677],[0.667,0.690],[0.685,0.719],[0.701,0.734]],
  },
  {
    id: 'whispering_shoals',
    name: 'Whispering Shoals',
    terrain: 'coastal',
    journal: 'places/whispering_shoals',
    blurb: 'Black, sticky sands beneath the Writhing Hills, swept by warm crimson-tinted waves.',
    poly: [[0.729,0.573],[0.740,0.580],[0.781,0.734],[0.775,0.760],[0.766,0.767],[0.733,0.768],[0.730,0.733],[0.750,0.721],[0.739,0.666],[0.730,0.628],[0.719,0.597],[0.722,0.581]],
  },
  {
    id: 'islet_of_job',
    name: 'Islet of Job',
    terrain: 'island',
    journal: 'places/islet_of_job',
    blurb: 'A small weathered scrap of land in the southeast, ringed by shifting shallows and mist.',
    poly: [[0.700,0.798],[0.742,0.786],[0.774,0.791],[0.778,0.853],[0.755,0.888],[0.750,0.912],[0.732,0.929],[0.712,0.917],[0.705,0.890],[0.693,0.863],[0.691,0.836],[0.693,0.815]],
  },

  // ── Water features ─────────────────────────────────────────────────────
  // Deliberately LAST in the array. regionAt() walks this list in reverse so
  // later entries win where outlines overlap — these two are small/thin
  // features lying on top of much larger regions (the Eyes sit inside the
  // Numerian Plains near camp; the Wormwood cuts across several), and
  // without that ordering the big region underneath would always swallow
  // the hover.
  {
    id: 'the_eyes',
    name: 'The Eyes',
    terrain: 'lake',
    journal: 'places/camp_nehemiah',
    blurb: 'Three crescent lakes near camp, each said to reflect truth, memory, or desire — though no two accounts agree on which is which.',
    poly: [[0.725,0.379],[0.756,0.384],[0.756,0.420],[0.735,0.436],[0.716,0.456],[0.694,0.446],[0.718,0.415],[0.729,0.401]],
  },
  {
    id: 'river_wormwood',
    name: 'The River Wormwood',
    terrain: 'river',
    journal: 'places/river_wormwood',
    blurb: 'Flowing east out of Lake Genesis before splitting — one branch south through the Ruins of Exodus toward Camp Nehemiah.',
    poly: [[0.563,0.397],[0.564,0.375],[0.579,0.354],[0.591,0.355],[0.595,0.363],[0.598,0.361],[0.595,0.352],[0.589,0.348],[0.576,0.348],[0.566,0.352],[0.573,0.341],[0.572,0.330],[0.582,0.321],[0.587,0.298],[0.595,0.286],[0.593,0.273],[0.584,0.288],[0.580,0.298],[0.570,0.294],[0.580,0.275],[0.570,0.257],[0.573,0.232],[0.582,0.224],[0.594,0.222],[0.600,0.232],[0.602,0.243],[0.611,0.259],[0.619,0.260],[0.611,0.254],[0.603,0.226],[0.596,0.215],[0.585,0.212],[0.599,0.205],[0.598,0.190],[0.609,0.177],[0.624,0.170],[0.606,0.173],[0.596,0.155],[0.591,0.141],[0.586,0.148],[0.597,0.162],[0.599,0.170],[0.594,0.177],[0.595,0.192],[0.592,0.199],[0.581,0.204],[0.572,0.217],[0.566,0.229],[0.561,0.249],[0.565,0.267],[0.571,0.272],[0.571,0.282],[0.563,0.285],[0.560,0.296],[0.568,0.301],[0.576,0.304],[0.578,0.313],[0.571,0.317],[0.565,0.323],[0.568,0.336],[0.561,0.340],[0.560,0.355],[0.557,0.370],[0.549,0.380],[0.545,0.383]],
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

/** Plain vertex-average centroid. May fall OUTSIDE a concave polygon. */
export function polyCentroid(poly) {
  let x = 0, y = 0;
  for (const [px, py] of poly) { x += px; y += py; }
  return [x / poly.length, y / poly.length];
}

/**
 * A point guaranteed to sit INSIDE the polygon, for anchoring labels.
 *
 * The plain centroid is wrong for concave shapes — the Mountains of
 * Proverbs are a crescent wrapped around the Valley of Joshua, so their
 * vertex-average lands in the hollow (i.e. on a different region), which
 * put the hover label outside the thing it was naming.
 *
 * Falls back to a coarse grid sample of the bounding box, keeping the
 * interior point furthest from any edge — a cheap stand-in for the
 * "pole of inaccessibility" that's plenty for label placement. Result is
 * memoised on the polygon array since region shapes never change at runtime.
 */
export function polyLabelPoint(poly) {
  if (poly.__labelPt) return poly.__labelPt;

  const c = polyCentroid(poly);
  let best = pointInPoly(poly, c[0], c[1]) ? c : null;

  if (!best) {
    let minX = 1, maxX = 0, minY = 1, maxY = 0;
    for (const [x, y] of poly) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const STEPS = 24;
    let bestScore = -1;
    for (let i = 1; i < STEPS; i++) {
      for (let j = 1; j < STEPS; j++) {
        const x = minX + (maxX - minX) * (i / STEPS);
        const y = minY + (maxY - minY) * (j / STEPS);
        if (!pointInPoly(poly, x, y)) continue;
        // Distance to the nearest vertex is a good-enough proxy for
        // "how deep inside am I" at this resolution.
        let d = Infinity;
        for (const [vx, vy] of poly) {
          const dd = (vx - x) * (vx - x) + (vy - y) * (vy - y);
          if (dd < d) d = dd;
        }
        if (d > bestScore) { bestScore = d; best = [x, y]; }
      }
    }
  }

  Object.defineProperty(poly, '__labelPt', {
    value: best || c, enumerable: false, writable: false,
  });
  return poly.__labelPt;
}
