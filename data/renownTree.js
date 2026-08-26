// data/renownTree.js
//
// The renown web: ONE shared tree with several entry points, transcribed from
// the design drawing (Behel'ith Vault / Excalidraw, 2026-07-27).
//
// ORIGINS (own one-way arm):  bone, severed, prophet, falsegod
// NOTABLES (shared, reachable from any origin):  Soulbound, Undetermined, and
// the crafting nodes gated behind slaying a prophet / a false god - that gate
// is a REQUIREMENT to take the node, not ownership of it by those origins.
//
// Per the drawing's annotations: an item enters at its own origin's node and
// nowhere else; arms are "locked behind the drop so it's not allocatable from
// reverse when coming from another starting place"; and "purposefully the
// center is harder to access - and also the edges are harder to access, they
// will be more powerful".
//
// Renown is the travel currency (from items applied to the equipment, or from
// experience using it). Some nodes additionally require an OBJECTIVE -
// completable while unconnected, activated on arrival.
//
// The prophet and false-god arms are SYNTHESIZED here - the drawing notes they
// "would all have their own trees like bonepile, and sever do" but never drew
// them. Mostly placeholders.
//
// NOTHING HERE IS WIRED TO COMBAT. Display-only; `arm` drives which branches
// light up for a given item's origin. Positions are normalized 0..1.

/** Which tree node an item's renownOrigin enters at. */
export const ORIGIN_START = {
  "bone": "n0",
  "severed": "n26",
  "prophet": "n50",
  "falsegod": "n51"
};

export const RENOWN_TREE = {
  nodes: [
    {
      "id": "n0",
      "label": "Bone",
      "x": 0.3272,
      "y": 0.261,
      "arm": "bone",
      "start": "bone",
      "flavour": "From death anew…"
    },
    {
      "id": "n1",
      "label": "",
      "x": 0.2383,
      "y": 0.2323,
      "arm": "bone",
      "placeholder": true
    },
    {
      "id": "n2",
      "label": "Unique bone modifier slot",
      "x": 0.2795,
      "y": 0.1866,
      "arm": "bone"
    },
    {
      "id": "n3",
      "label": "",
      "x": 0.1738,
      "y": 0.1888,
      "arm": "bone",
      "placeholder": true
    },
    {
      "id": "n4",
      "label": "",
      "x": 0.2305,
      "y": 0.1317,
      "arm": "bone",
      "placeholder": true
    },
    {
      "id": "n5",
      "label": "",
      "x": 0.1162,
      "y": 0.1037,
      "arm": "bone",
      "placeholder": true
    },
    {
      "id": "n6",
      "label": "",
      "x": 0.277,
      "y": 0.087,
      "arm": "bone",
      "placeholder": true
    },
    {
      "id": "n7",
      "label": "",
      "x": 0.3208,
      "y": 0.1494,
      "arm": "shared",
      "placeholder": true
    },
    {
      "id": "n8",
      "label": "",
      "x": 0.3927,
      "y": 0.3362,
      "arm": "shared",
      "placeholder": true
    },
    {
      "id": "n9",
      "label": "Soulb ound",
      "x": 0.3456,
      "y": 0.3713,
      "arm": "shared",
      "note": "Notable — reachable from any origin."
    },
    {
      "id": "n10",
      "label": "",
      "x": 0.338,
      "y": 0.4324,
      "arm": "shared",
      "placeholder": true
    },
    {
      "id": "n11",
      "label": "Reroll previx modifier values",
      "x": 0.4002,
      "y": 0.4772,
      "arm": "shared"
    },
    {
      "id": "n12",
      "label": "",
      "x": 0.4599,
      "y": 0.5231,
      "arm": "shared",
      "placeholder": true
    },
    {
      "id": "n13",
      "label": "raise a mod tier",
      "x": 0.4805,
      "y": 0.3315,
      "arm": "shared"
    },
    {
      "id": "n14",
      "label": "",
      "x": 0.5527,
      "y": 0.3379,
      "arm": "shared",
      "placeholder": true
    },
    {
      "id": "n15",
      "label": "",
      "x": 0.6877,
      "y": 0.4347,
      "arm": "shared",
      "placeholder": true
    },
    {
      "id": "n16",
      "label": "Rename item",
      "x": 0.6296,
      "y": 0.372,
      "arm": "shared"
    },
    {
      "id": "n17",
      "label": "",
      "x": 0.6469,
      "y": 0.4989,
      "arm": "shared",
      "placeholder": true
    },
    {
      "id": "n18",
      "label": "",
      "x": 0.5733,
      "y": 0.479,
      "arm": "shared",
      "placeholder": true
    },
    {
      "id": "n19",
      "label": "",
      "x": 0.5333,
      "y": 0.5295,
      "arm": "shared",
      "placeholder": true
    },
    {
      "id": "n20",
      "label": "Add and remove a prefix",
      "x": 0.4646,
      "y": 0.4644,
      "arm": "shared"
    },
    {
      "id": "n21",
      "label": "Transform a prefix",
      "x": 0.4113,
      "y": 0.4214,
      "arm": "shared"
    },
    {
      "id": "n22",
      "label": "Reroll suffix modifier values",
      "x": 0.5782,
      "y": 0.4071,
      "arm": "shared"
    },
    {
      "id": "n23",
      "label": "Add and remove a suffix",
      "x": 0.5154,
      "y": 0.4229,
      "arm": "shared"
    },
    {
      "id": "n24",
      "label": "Remove a modifier and incraese value of other",
      "x": 0.4637,
      "y": 0.4205,
      "arm": "shared"
    },
    {
      "id": "n25",
      "label": "",
      "x": 0.364,
      "y": 0.1802,
      "arm": "shared",
      "placeholder": true
    },
    {
      "id": "n26",
      "label": "Severed",
      "x": 0.7614,
      "y": 0.6176,
      "arm": "severed",
      "start": "severed",
      "flavour": "Seeking to be whole again…"
    },
    {
      "id": "n27",
      "label": "Converts mana costs to hp costs",
      "x": 0.8603,
      "y": 0.7567,
      "arm": "severed"
    },
    {
      "id": "n28",
      "label": "",
      "x": 0.7844,
      "y": 0.8221,
      "arm": "severed",
      "placeholder": true
    },
    {
      "id": "n29",
      "label": "Allows a unique sever modifier slot",
      "x": 0.8861,
      "y": 0.8409,
      "arm": "severed"
    },
    {
      "id": "n30",
      "label": "lifesteal",
      "x": 1,
      "y": 0.8271,
      "arm": "severed"
    },
    {
      "id": "n31",
      "label": "",
      "x": 0.7236,
      "y": 0.8729,
      "arm": "severed",
      "placeholder": true
    },
    {
      "id": "n32",
      "label": "",
      "x": 0.7986,
      "y": 0.9383,
      "arm": "severed",
      "placeholder": true
    },
    {
      "id": "n33",
      "label": "",
      "x": 0.8786,
      "y": 1,
      "arm": "severed",
      "placeholder": true
    },
    {
      "id": "n34",
      "label": "",
      "x": 0.9339,
      "y": 0.9333,
      "arm": "severed",
      "placeholder": true
    },
    {
      "id": "n35",
      "label": "mana burn",
      "x": 0.9686,
      "y": 0.8787,
      "arm": "severed"
    },
    {
      "id": "n36",
      "label": "Undetermined",
      "x": 0.6121,
      "y": 0.2745,
      "arm": "shared",
      "note": "Notable — reachable from any origin."
    },
    {
      "id": "n37",
      "label": "",
      "x": 0.6273,
      "y": 0.2051,
      "arm": "shared",
      "placeholder": true
    },
    {
      "id": "n38",
      "label": "",
      "x": 0.6859,
      "y": 0.2505,
      "arm": "shared",
      "placeholder": true
    },
    {
      "id": "n39",
      "label": "",
      "x": 0.7197,
      "y": 0.2262,
      "arm": "shared",
      "placeholder": true
    },
    {
      "id": "n40",
      "label": "",
      "x": 0.6652,
      "y": 0.1834,
      "arm": "shared",
      "placeholder": true
    },
    {
      "id": "n41",
      "label": "",
      "x": 0.7232,
      "y": 0.1752,
      "arm": "shared",
      "placeholder": true
    },
    {
      "id": "n42",
      "label": "",
      "x": 0.7777,
      "y": 0.1834,
      "arm": "shared",
      "placeholder": true
    },
    {
      "id": "n43",
      "label": "",
      "x": 0.8191,
      "y": 0.2365,
      "arm": "shared",
      "placeholder": true
    },
    {
      "id": "n44",
      "label": "Started from random, or from an item",
      "x": 0.2172,
      "y": 0.3781,
      "arm": "bone"
    },
    {
      "id": "n45",
      "label": "Transfor m a suffix",
      "x": 0.5119,
      "y": 0.3719,
      "arm": "shared"
    },
    {
      "id": "n46",
      "label": "add a modifier",
      "x": 0.6242,
      "y": 0.4231,
      "arm": "shared"
    },
    {
      "id": "n47",
      "label": "Allows 5 modifier slots, item can become legendary",
      "x": 0.5536,
      "y": 0.4409,
      "arm": "shared"
    },
    {
      "id": "n48",
      "label": "raise a mod tier",
      "x": 0.4551,
      "y": 0.372,
      "arm": "shared"
    },
    {
      "id": "n49",
      "label": "raise a mod tier",
      "x": 0.3969,
      "y": 0.3882,
      "arm": "shared"
    },
    {
      "id": "n50",
      "label": "Gift from a Prophet",
      "x": 0.2961,
      "y": 0.4954,
      "arm": "prophet",
      "start": "prophet"
    },
    {
      "id": "n51",
      "label": "Gift from a False God",
      "x": 0.383,
      "y": 0.5578,
      "arm": "falsegod",
      "start": "falsegod"
    },
    {
      "id": "n52",
      "label": "",
      "x": 0.4631,
      "y": 0,
      "arm": "shared",
      "placeholder": true
    },
    {
      "id": "n53",
      "label": "",
      "x": 0.44,
      "y": 0.0893,
      "arm": "shared",
      "placeholder": true
    },
    {
      "id": "n54",
      "label": "",
      "x": 0.4959,
      "y": 0.004,
      "arm": "shared",
      "placeholder": true
    },
    {
      "id": "n55",
      "label": "",
      "x": 0.5048,
      "y": 0.0981,
      "arm": "shared",
      "placeholder": true
    },
    {
      "id": "n56",
      "label": "Add a modifier",
      "x": 0.5117,
      "y": 0.462,
      "arm": "shared"
    },
    {
      "id": "n58",
      "label": "",
      "x": 0.1555,
      "y": 0.2437,
      "arm": "bone",
      "placeholder": true
    },
    {
      "id": "n59",
      "label": "",
      "x": 0.1418,
      "y": 0.2712,
      "arm": "bone",
      "placeholder": true
    },
    {
      "id": "n60",
      "label": "",
      "x": 0.0882,
      "y": 0.2601,
      "arm": "bone",
      "placeholder": true
    },
    {
      "id": "n61",
      "label": "",
      "x": 0.0352,
      "y": 0.2562,
      "arm": "bone",
      "placeholder": true
    },
    {
      "id": "n62",
      "label": "physical as extra buildup (move from amulets or additional)",
      "x": 0.0057,
      "y": 0.2055,
      "arm": "bone"
    },
    {
      "id": "n63",
      "label": "additional base damage",
      "x": 0.1009,
      "y": 0.2139,
      "arm": "bone"
    },
    {
      "id": "n64",
      "label": "",
      "x": 0.0594,
      "y": 0.1999,
      "arm": "bone",
      "placeholder": true
    },
    {
      "id": "n65",
      "label": "conver 50% weap physical to necrotic",
      "x": 0.0814,
      "y": 0.1728,
      "arm": "bone"
    },
    {
      "id": "n66",
      "label": "Convert 50% weap phys to necrotic",
      "x": 0.0209,
      "y": 0.1586,
      "arm": "bone"
    },
    {
      "id": "n67",
      "label": "Convert weapon elemental to necrotic",
      "x": 0,
      "y": 0.1238,
      "arm": "bone"
    },
    {
      "id": "prophet_b0",
      "label": "",
      "x": 0.2245,
      "y": 0.5515,
      "arm": "prophet",
      "placeholder": true
    },
    {
      "id": "prophet_b1",
      "label": "Marked by the Prophet",
      "x": 0.1478,
      "y": 0.5863,
      "arm": "prophet"
    },
    {
      "id": "prophet_b2",
      "label": "",
      "x": 0.2345,
      "y": 0.627,
      "arm": "prophet",
      "placeholder": true
    },
    {
      "id": "prophet_b3",
      "label": "",
      "x": 0.0811,
      "y": 0.6386,
      "arm": "prophet",
      "placeholder": true
    },
    {
      "id": "prophet_b4",
      "label": "",
      "x": 0.1611,
      "y": 0.6735,
      "arm": "prophet",
      "placeholder": true
    },
    {
      "id": "prophet_b5",
      "label": "",
      "x": 0.0411,
      "y": 0.7084,
      "arm": "prophet",
      "placeholder": true
    },
    {
      "id": "prophet_b6",
      "label": "Rebirth in Lake Genesis",
      "x": 0.1178,
      "y": 0.7461,
      "arm": "prophet"
    },
    {
      "id": "prophet_b7",
      "label": "",
      "x": 0.2011,
      "y": 0.7171,
      "arm": "prophet",
      "placeholder": true
    },
    {
      "id": "falsegod_b0",
      "label": "",
      "x": 0.4145,
      "y": 0.6154,
      "arm": "falsegod",
      "placeholder": true
    },
    {
      "id": "falsegod_b1",
      "label": "Power Without Cost",
      "x": 0.3545,
      "y": 0.659,
      "arm": "falsegod"
    },
    {
      "id": "falsegod_b2",
      "label": "",
      "x": 0.4779,
      "y": 0.659,
      "arm": "falsegod",
      "placeholder": true
    },
    {
      "id": "falsegod_b3",
      "label": "",
      "x": 0.4012,
      "y": 0.7113,
      "arm": "falsegod",
      "placeholder": true
    },
    {
      "id": "falsegod_b4",
      "label": "",
      "x": 0.5212,
      "y": 0.72,
      "arm": "falsegod",
      "placeholder": true
    },
    {
      "id": "falsegod_b5",
      "label": "",
      "x": 0.3445,
      "y": 0.7461,
      "arm": "falsegod",
      "placeholder": true
    },
    {
      "id": "falsegod_b6",
      "label": "Unwritten",
      "x": 0.4612,
      "y": 0.7665,
      "arm": "falsegod"
    },
    {
      "id": "falsegod_b7",
      "label": "",
      "x": 0.5413,
      "y": 0.8042,
      "arm": "falsegod",
      "placeholder": true
    }
  ],
  edges: [[0,1], [1,3], [1,2], [2,6], [3,5], [1,4], [2,7], [0,8], [2,25], [17,26], [26,27], [27,29], [29,30], [29,35], [29,34], [27,28], [28,31], [31,32], [32,33], [14,36], [36,37], [37,39], [36,38], [38,40], [40,41], [41,43], [39,42], [9,44], [20,21], [21,24], [8,9], [9,10], [10,12], [12,18], [18,19], [11,12], [17,18], [15,17], [11,20], [8,14], [14,15], [14,22], [22,23], [23,45], [13,49], [8,13], [48,49], [10,50], [12,51], [18,47], [46,47], [16,46], [24,45], [24,56], [1,57], [1,58], [57,62], [62,63], [61,63], [59,60], [58,59], [57,64], [64,65], [65,66], [50,67], [67,68], [67,69], [68,70], [68,71], [69,71], [70,72], [71,73], [71,74], [72,73], [51,75], [75,76], [75,77], [76,78], [77,79], [78,80], [78,81], [79,81], [81,82]],
};

export default RENOWN_TREE;
