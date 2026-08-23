// awakenings.js
// Teaser/placeholder data for the Awakening system — 18 awakenings, 3 per
// base class. Names and constellation motifs only; NO effects or balance
// exist yet, and nothing here is spendable. Consumed purely as read-only
// display data by LevelUpOverlay's Talents tab.
//
// Every tree has the same 12-node split for visual consistency:
//   3 tier-1 (entry) → 4 tier-2 → 4 tier-3 → 1 capstone
//
// Node coordinates are NORMALIZED (0..1 in both axes, y growing downward)
// so the renderer can scale each constellation into whatever box it has
// without every tree needing pixel coords baked in. `edges` are index
// pairs into that same `nodes` array.
//
// edge kind:
//   undefined / 'path'  — a real prerequisite link
//   'link'              — visually connected but NOT a prerequisite (the
//                         "shared bonus" connection type from the design
//                         doc, e.g. the Gem's crossing facet and the
//                         Jester's Triple Cascade). Drawn dashed/dimmer.
//
// Design intent worth preserving if this ever becomes real: only 8 points
// are spendable across 12 nodes (one per level, levels 3-10), so every
// tree must offer multiple viable routes from entry to capstone rather
// than one continuous line.

export const AWAKENING_TIERS = ['Entry', 'Adept', 'Master', 'Capstone'];

// Per-tier node styling, shared by every tree so tier reads consistently
// across all 18 (and so tier is conveyed by SIZE + shape, not color alone).
export const TIER_STYLE = {
  1: { radius: 9,  color: 0x4a6fa5, label: 'Entry' },
  2: { radius: 11, color: 0x5a7fb5, label: 'Adept' },
  3: { radius: 13, color: 0x7a6fb5, label: 'Master' },
  4: { radius: 18, color: 0xb59a4a, label: 'Capstone' },
};

export const AWAKENINGS = {
  // ── Shepherd ───────────────────────────────────────────────────────────
  shepherd: [
    {
      id: 'bonded',
      name: 'Bonded',
      motif: 'Binary Star',
      motifDesc: 'Two orbiting points feeding a shared central spine.',
      nodes: [
        { n: 'First Whistle',      t: 1, x: 0.20, y: 0.16 },
        { n: 'Calloused Hands',    t: 1, x: 0.50, y: 0.10 },
        { n: 'Steady Grip',        t: 1, x: 0.80, y: 0.16 },
        { n: 'Shared Wound',       t: 2, x: 0.14, y: 0.40 },
        { n: 'Second Set of Eyes', t: 2, x: 0.38, y: 0.36 },
        { n: 'Loyal Stride',       t: 2, x: 0.62, y: 0.36 },
        { n: 'Matched Pace',       t: 2, x: 0.86, y: 0.40 },
        { n: 'Pack Leader',        t: 3, x: 0.18, y: 0.66 },
        { n: 'Guard the Flank',    t: 3, x: 0.40, y: 0.62 },
        { n: 'Read the Wind',      t: 3, x: 0.60, y: 0.62 },
        { n: 'Old Scar',           t: 3, x: 0.82, y: 0.66 },
        { n: 'Twin Hearts',        t: 4, x: 0.50, y: 0.90 },
      ],
      edges: [[0,3],[0,4],[1,4],[1,5],[2,5],[2,6],[3,7],[4,8],[5,9],[6,10],[7,11],[8,11],[9,11],[10,11],[4,5,'link']],
    },
    {
      id: 'warden',
      name: 'Warden',
      motif: 'The Shield',
      motifDesc: 'A ring with radiating spokes, like a shield boss.',
      nodes: [
        { n: 'Raise the Crook',  t: 1, x: 0.50, y: 0.08 },
        { n: 'Steady Stance',    t: 1, x: 0.16, y: 0.28 },
        { n: 'Watch the Gate',   t: 1, x: 0.84, y: 0.28 },
        { n: 'Circle the Flock', t: 2, x: 0.50, y: 0.30 },
        { n: 'Turned Blade',     t: 2, x: 0.22, y: 0.52 },
        { n: 'Brace and Hold',   t: 2, x: 0.78, y: 0.52 },
        { n: 'Line Unbroken',    t: 2, x: 0.50, y: 0.52 },
        { n: "Shepherd's Wall",  t: 3, x: 0.30, y: 0.72 },
        { n: 'Hold the Line',    t: 3, x: 0.70, y: 0.72 },
        { n: 'Iron Resolve',     t: 3, x: 0.14, y: 0.68 },
        { n: 'Last Stand',       t: 3, x: 0.86, y: 0.68 },
        { n: 'Nothing Gets Through', t: 4, x: 0.50, y: 0.92 },
      ],
      edges: [[0,3],[1,4],[2,5],[3,6],[3,4],[3,5],[4,7],[5,8],[4,9],[5,10],[6,7],[6,8],[7,11],[8,11],[9,7,'link'],[10,8,'link']],
    },
    {
      id: 'primalist',
      name: 'Primalist',
      motif: 'Claw Marks',
      motifDesc: 'Three jagged diagonal slashes converging downward.',
      nodes: [
        { n: 'Bare the Fangs',      t: 1, x: 0.14, y: 0.10 },
        { n: 'First Growl',         t: 1, x: 0.45, y: 0.08 },
        { n: 'Hackles Raised',      t: 1, x: 0.76, y: 0.12 },
        { n: 'Between Them and You', t: 2, x: 0.24, y: 0.34 },
        { n: 'Blood for Blood',     t: 2, x: 0.54, y: 0.32 },
        { n: 'Snapping Jaw',        t: 2, x: 0.84, y: 0.36 },
        { n: 'Guard Dog',           t: 2, x: 0.10, y: 0.40 },
        { n: 'The Old Hunger',      t: 3, x: 0.34, y: 0.60 },
        { n: 'Broken Leash',        t: 3, x: 0.62, y: 0.58 },
        { n: 'Feral Guard',         t: 3, x: 0.20, y: 0.64 },
        { n: 'No Mercy',            t: 3, x: 0.88, y: 0.62 },
        { n: 'The Wolf Remembers',  t: 4, x: 0.52, y: 0.90 },
      ],
      edges: [[0,3],[1,4],[2,5],[0,6],[3,7],[4,8],[6,9],[5,10],[7,11],[8,11],[9,11],[10,11],[3,4,'link']],
    },
  ],

  // ── Scholar ────────────────────────────────────────────────────────────
  scholar: [
    {
      id: 'ritualist',
      name: 'Ritualist',
      motif: 'Concentric Circles',
      motifDesc: 'Nested rings, unlocked outward-in.',
      nodes: [
        { n: 'First Sigil',   t: 1, x: 0.50, y: 0.06 },
        { n: 'Chalk Line',    t: 1, x: 0.12, y: 0.44 },
        { n: 'Steady Hand',   t: 1, x: 0.88, y: 0.44 },
        { n: 'Bind the Circle',   t: 2, x: 0.50, y: 0.24 },
        { n: 'Echoing Rite',      t: 2, x: 0.26, y: 0.36 },
        { n: 'Widen the Ring',    t: 2, x: 0.74, y: 0.36 },
        { n: 'Second Casting',    t: 2, x: 0.50, y: 0.78 },
        { n: 'Layered Rite',       t: 3, x: 0.30, y: 0.62 },
        { n: 'Borrowed Time',      t: 3, x: 0.70, y: 0.62 },
        { n: 'Circle Within Circle', t: 3, x: 0.16, y: 0.68 },
        { n: 'Deepened Working',   t: 3, x: 0.84, y: 0.68 },
        { n: 'The Final Working',  t: 4, x: 0.50, y: 0.50 },
      ],
      edges: [[0,3],[1,4],[2,5],[3,4],[3,5],[4,7],[5,8],[1,9],[2,10],[9,7],[10,8],[6,7],[6,8],[7,11],[8,11],[3,11,'link']],
    },
    {
      id: 'elementalist',
      name: 'Elementalist',
      motif: 'The Compass',
      motifDesc: 'A four-pointed cross radiating from a center hub.',
      nodes: [
        { n: 'First Spark',    t: 1, x: 0.50, y: 0.06 },
        { n: "Tempered Ice",   t: 1, x: 0.08, y: 0.50 },
        { n: "Storm's Breath", t: 1, x: 0.92, y: 0.50 },
        { n: 'Stone Skin',     t: 2, x: 0.50, y: 0.26 },
        { n: 'Wildfire',       t: 2, x: 0.28, y: 0.50 },
        { n: 'Rolling Thunder', t: 2, x: 0.72, y: 0.50 },
        { n: 'Undertow',       t: 2, x: 0.50, y: 0.74 },
        { n: 'Elemental Balance', t: 3, x: 0.34, y: 0.34 },
        { n: 'Elemental Shift',   t: 3, x: 0.66, y: 0.34 },
        { n: 'Twin Elements',     t: 3, x: 0.34, y: 0.66 },
        { n: 'Eye of the Storm',  t: 3, x: 0.66, y: 0.66 },
        { n: 'Convergence',    t: 4, x: 0.50, y: 0.50 },
      ],
      edges: [[0,3],[1,4],[2,5],[3,7],[3,8],[4,7],[4,9],[5,8],[5,10],[6,9],[6,10],[7,11],[8,11],[9,11],[10,11],[3,6,'link']],
    },
    {
      id: 'alchemist',
      name: 'Alchemist',
      motif: 'The Flask',
      motifDesc: 'Fills bottom-up like liquid, capstone at the bottle neck.',
      nodes: [
        { n: 'First Formula',   t: 1, x: 0.22, y: 0.88 },
        { n: 'Steady Hands',    t: 1, x: 0.50, y: 0.94 },
        { n: 'Measured Dose',   t: 1, x: 0.78, y: 0.88 },
        { n: 'Volatile Compound', t: 2, x: 0.16, y: 0.68 },
        { n: 'Refined Reagent',   t: 2, x: 0.40, y: 0.70 },
        { n: 'Catalyst',          t: 2, x: 0.60, y: 0.70 },
        { n: 'Distillation',      t: 2, x: 0.84, y: 0.68 },
        { n: 'The Long Boil',     t: 3, x: 0.26, y: 0.48 },
        { n: 'Balanced Ratio',    t: 3, x: 0.44, y: 0.44 },
        { n: 'Reactive Mix',      t: 3, x: 0.56, y: 0.44 },
        { n: 'Saturation Point',  t: 3, x: 0.74, y: 0.48 },
        { n: 'The Perfect Formula', t: 4, x: 0.50, y: 0.14 },
      ],
      edges: [[0,3],[0,4],[1,4],[1,5],[2,5],[2,6],[3,7],[4,8],[5,9],[6,10],[7,11],[8,11],[9,11],[10,11],[8,9,'link']],
    },
  ],

  // ── Grunt ──────────────────────────────────────────────────────────────
  grunt: [
    {
      id: 'brute',
      name: 'Brute',
      motif: 'The Fist',
      motifDesc: 'A dense, compact cluster rather than a long branching path.',
      nodes: [
        { n: 'Heavy Hands', t: 1, x: 0.26, y: 0.16 },
        { n: 'Thick Skin',  t: 1, x: 0.50, y: 0.10 },
        { n: 'Iron Grip',   t: 1, x: 0.74, y: 0.16 },
        { n: 'Unstoppable',      t: 2, x: 0.20, y: 0.40 },
        { n: 'Crush',            t: 2, x: 0.42, y: 0.36 },
        { n: 'Bull Rush',        t: 2, x: 0.58, y: 0.36 },
        { n: 'Brace for Impact', t: 2, x: 0.80, y: 0.40 },
        { n: 'Immovable',        t: 3, x: 0.24, y: 0.62 },
        { n: 'Break the Guard',  t: 3, x: 0.42, y: 0.60 },
        { n: 'Last One Standing', t: 3, x: 0.58, y: 0.60 },
        { n: 'Bone Breaker',     t: 3, x: 0.76, y: 0.62 },
        { n: "Mountain's Fury",  t: 4, x: 0.50, y: 0.88 },
      ],
      edges: [[0,3],[0,4],[1,4],[1,5],[2,5],[2,6],[3,7],[4,8],[5,9],[6,10],[7,11],[8,11],[9,11],[10,11],[4,5,'link'],[8,9,'link']],
    },
    {
      id: 'berserker',
      name: 'Berserker',
      motif: 'The Forked Bolt',
      motifDesc: 'A lightning bolt that forks partway up into two jagged branches, reconverging at one strike point.',
      nodes: [
        { n: 'First Blood',     t: 1, x: 0.50, y: 0.06 },
        { n: 'Red Vision',      t: 1, x: 0.34, y: 0.16 },
        { n: 'Quickened Pulse', t: 1, x: 0.66, y: 0.16 },
        { n: 'No Retreat',       t: 2, x: 0.50, y: 0.28 },
        { n: 'Reckless Swing',   t: 2, x: 0.22, y: 0.40 },
        { n: 'Adrenaline',       t: 2, x: 0.50, y: 0.46 },
        { n: 'Ignore the Wound', t: 2, x: 0.78, y: 0.40 },
        { n: 'Blind Fury',   t: 3, x: 0.14, y: 0.60 },
        { n: 'Second Wind',  t: 3, x: 0.30, y: 0.72 },
        { n: 'Unchecked',    t: 3, x: 0.86, y: 0.60 },
        { n: 'Blood Frenzy', t: 3, x: 0.70, y: 0.72 },
        { n: 'The Endless Rage', t: 4, x: 0.50, y: 0.92 },
      ],
      edges: [[0,3],[1,3],[2,3],[3,4],[3,5],[3,6],[4,7],[7,8],[6,9],[9,10],[8,11],[10,11],[5,11],[5,4,'link'],[5,6,'link']],
    },
    {
      id: 'adorned',
      name: 'Adorned',
      motif: 'The Gem',
      motifDesc: 'A faceted diamond outline; branches trace the facet lines.',
      nodes: [
        { n: 'First Facet',   t: 1, x: 0.50, y: 0.06 },
        { n: 'Rough Cut',     t: 1, x: 0.28, y: 0.22 },
        { n: 'Polished Edge', t: 1, x: 0.72, y: 0.22 },
        { n: 'Runic Inlay',            t: 2, x: 0.10, y: 0.44 },
        { n: 'Sympathetic Resonance',  t: 2, x: 0.38, y: 0.42 },
        { n: 'Set Stone',              t: 2, x: 0.62, y: 0.42 },
        { n: 'Refracted Light',        t: 2, x: 0.90, y: 0.44 },
        { n: 'Layered Facets',   t: 3, x: 0.20, y: 0.66 },
        { n: 'Resonant Chain',   t: 3, x: 0.42, y: 0.68 },
        { n: 'Hardened Setting', t: 3, x: 0.58, y: 0.68 },
        { n: 'Prism Guard',      t: 3, x: 0.80, y: 0.66 },
        { n: 'The Flawless Cut', t: 4, x: 0.50, y: 0.92 },
      ],
      edges: [[0,1],[0,2],[1,3],[1,4],[2,5],[2,6],[3,7],[4,8],[5,9],[6,10],[7,11],[8,11],[9,11],[10,11],[4,5,'link'],[8,9,'link']],
    },
  ],

  // ── Beggar ─────────────────────────────────────────────────────────────
  beggar: [
    {
      id: 'brigand',
      name: 'Brigand',
      motif: 'The Broken Chain',
      motifDesc: 'A chain of linked nodes routing around one snapped link.',
      nodes: [
        { n: 'Quick Fingers', t: 1, x: 0.16, y: 0.14 },
        { n: 'Light Step',    t: 1, x: 0.50, y: 0.08 },
        { n: 'Loose Lips',    t: 1, x: 0.84, y: 0.14 },
        { n: 'Back Alley',    t: 2, x: 0.14, y: 0.38 },
        { n: 'Cut and Run',   t: 2, x: 0.40, y: 0.34 },
        { n: 'Slip the Knot', t: 2, x: 0.62, y: 0.34 },
        { n: 'Second Pocket', t: 2, x: 0.86, y: 0.38 },
        { n: 'Vanishing Act', t: 3, x: 0.18, y: 0.62 },
        { n: 'Marked Target', t: 3, x: 0.42, y: 0.64 },
        { n: 'Silent Take',   t: 3, x: 0.62, y: 0.64 },
        { n: 'Broken Lock',   t: 3, x: 0.84, y: 0.62 },
        { n: 'King of Thieves', t: 4, x: 0.50, y: 0.90 },
      ],
      edges: [[0,3],[1,4],[1,5],[2,6],[3,7],[4,8],[5,9],[6,10],[7,11],[8,11],[9,11],[10,11],[4,5,'link']],
    },
    {
      id: 'harbinger',
      name: 'Harbinger',
      motif: "The Comet's Eye",
      motifDesc: 'A comet breaking apart with a watching eye at its core.',
      nodes: [
        { n: 'The Sky Is Falling', t: 1, x: 0.10, y: 0.12 },
        { n: 'First Warning',      t: 1, x: 0.30, y: 0.08 },
        { n: 'Cracked Omen',       t: 1, x: 0.52, y: 0.10 },
        { n: 'Cold Reading',        t: 2, x: 0.22, y: 0.34 },
        { n: 'It Was Foretold',     t: 2, x: 0.44, y: 0.32 },
        { n: 'Panic in the Streets', t: 2, x: 0.68, y: 0.30 },
        { n: 'Whispered Doom',      t: 2, x: 0.88, y: 0.26 },
        { n: 'Prophet of Ruin',  t: 3, x: 0.26, y: 0.60 },
        { n: 'Written in Ash',   t: 3, x: 0.50, y: 0.58 },
        { n: 'The Watching Eye', t: 3, x: 0.74, y: 0.56 },
        { n: 'Fate Sealed',      t: 3, x: 0.90, y: 0.52 },
        { n: 'The End Is Written', t: 4, x: 0.50, y: 0.88 },
      ],
      edges: [[0,3],[1,4],[2,5],[2,6],[3,7],[4,8],[5,9],[6,10],[7,11],[8,11],[9,11],[10,11],[8,9,'link']],
    },
    {
      id: 'rogue',
      name: 'Rogue',
      motif: 'The Junk Heap',
      motifDesc: 'An irregular, deliberately asymmetric scrappy cluster.',
      nodes: [
        { n: 'Make Do',                t: 1, x: 0.20, y: 0.12 },
        { n: 'Rig the Trap',           t: 1, x: 0.48, y: 0.16 },
        { n: 'Pocket Full of Nothing', t: 1, x: 0.78, y: 0.10 },
        { n: "One Man's Trash",  t: 2, x: 0.12, y: 0.38 },
        { n: 'Scrap Blade',      t: 2, x: 0.36, y: 0.42 },
        { n: 'Jury-Rig',         t: 2, x: 0.64, y: 0.36 },
        { n: 'Improvised Guard', t: 2, x: 0.88, y: 0.42 },
        { n: 'Salvage Run',       t: 3, x: 0.18, y: 0.64 },
        { n: 'Booby Trap',        t: 3, x: 0.44, y: 0.68 },
        { n: 'Second-Hand Steel', t: 3, x: 0.68, y: 0.62 },
        { n: 'Patchwork Guard',   t: 3, x: 0.90, y: 0.66 },
        { n: 'Waste Not', t: 4, x: 0.50, y: 0.90 },
      ],
      edges: [[0,3],[0,4],[1,4],[1,5],[2,5],[2,6],[3,7],[4,8],[5,9],[6,10],[7,11],[8,11],[9,11],[10,11],[4,5,'link']],
    },
  ],

  // ── Acolyte ────────────────────────────────────────────────────────────
  acolyte: [
    {
      id: 'empath',
      name: 'Empath',
      motif: 'Linked Rings',
      motifDesc: 'Two overlapping circles; shared nodes sit in the overlap.',
      nodes: [
        { n: 'Shared Pain',  t: 1, x: 0.26, y: 0.12 },
        { n: 'Open Wound',   t: 1, x: 0.50, y: 0.08 },
        { n: 'Gentle Touch', t: 1, x: 0.74, y: 0.12 },
        { n: 'Borrowed Strength', t: 2, x: 0.14, y: 0.38 },
        { n: 'Mirrored Wound',    t: 2, x: 0.40, y: 0.34 },
        { n: 'Echo of Others',    t: 2, x: 0.60, y: 0.34 },
        { n: 'Steady Presence',   t: 2, x: 0.86, y: 0.38 },
        { n: 'Carry Their Weight', t: 3, x: 0.18, y: 0.64 },
        { n: 'Bear the Burden',    t: 3, x: 0.40, y: 0.66 },
        { n: 'Radiating Calm',     t: 3, x: 0.60, y: 0.66 },
        { n: 'Bound Suffering',    t: 3, x: 0.82, y: 0.64 },
        { n: 'One and All', t: 4, x: 0.50, y: 0.90 },
      ],
      edges: [[0,3],[0,4],[1,4],[1,5],[2,5],[2,6],[3,7],[4,8],[5,9],[6,10],[7,11],[8,11],[9,11],[10,11],[4,5,'link'],[8,9,'link']],
    },
    {
      id: 'wiccan',
      name: 'Wiccan',
      motif: 'Crescent & Sprig',
      motifDesc: 'A curved crescent path branching into small leaf nodes.',
      nodes: [
        { n: 'Hex Mark',      t: 1, x: 0.62, y: 0.08 },
        { n: 'First Bramble', t: 1, x: 0.36, y: 0.12 },
        { n: 'Moonlit Step',  t: 1, x: 0.16, y: 0.28 },
        { n: 'Bramble Ward',    t: 2, x: 0.10, y: 0.50 },
        { n: 'Moonlit Brew',    t: 2, x: 0.34, y: 0.38 },
        { n: 'Withering Touch', t: 2, x: 0.62, y: 0.32 },
        { n: 'Charmed Herb',    t: 2, x: 0.84, y: 0.30 },
        { n: 'Coven Bond',   t: 3, x: 0.16, y: 0.72 },
        { n: 'Blood Moon',   t: 3, x: 0.40, y: 0.62 },
        { n: 'Bitter Root',  t: 3, x: 0.66, y: 0.58 },
        { n: 'Curse Weaver', t: 3, x: 0.88, y: 0.54 },
        { n: 'The Old Ways', t: 4, x: 0.50, y: 0.90 },
      ],
      edges: [[0,5],[0,6],[1,4],[2,3],[3,7],[4,8],[5,9],[6,10],[7,11],[8,11],[9,11],[10,11],[4,5,'link']],
    },
    {
      id: 'sage',
      name: 'Sage',
      motif: 'Standard Tree',
      motifDesc: 'No strong constellation motif — a plain branching tree: three roots up into a trunk, out to branches, capstone at the top.',
      nodes: [
        { n: 'First Verse',  t: 1, x: 0.22, y: 0.90 },
        { n: 'Steady Study', t: 1, x: 0.50, y: 0.94 },
        { n: 'Quiet Vigil',  t: 1, x: 0.78, y: 0.90 },
        { n: 'Recite the Rite',   t: 2, x: 0.34, y: 0.68 },
        { n: 'Living Scripture',  t: 2, x: 0.50, y: 0.72 },
        { n: 'Second Reading',    t: 2, x: 0.66, y: 0.68 },
        { n: 'Marginal Note',     t: 2, x: 0.86, y: 0.62 },
        { n: 'Hidden Verse',   t: 3, x: 0.16, y: 0.44 },
        { n: 'Deep Study',     t: 3, x: 0.40, y: 0.40 },
        { n: 'Old Testament',  t: 3, x: 0.62, y: 0.40 },
        { n: 'Annotated Page', t: 3, x: 0.86, y: 0.42 },
        { n: 'The Final Chapter', t: 4, x: 0.50, y: 0.12 },
      ],
      edges: [[0,3],[1,4],[2,5],[2,6],[3,7],[3,8],[4,8],[5,9],[6,10],[7,11],[8,11],[9,11],[10,11],[8,9,'link']],
    },
  ],

  // ── Performer ──────────────────────────────────────────────────────────
  performer: [
    {
      id: 'virtuoso',
      name: 'Virtuoso',
      motif: 'The Lyre',
      motifDesc: 'Vertical strings plucked in sequence, building to a chord at the top.',
      nodes: [
        { n: 'Perfect Pitch',  t: 1, x: 0.24, y: 0.90 },
        { n: 'First Chord',    t: 1, x: 0.50, y: 0.92 },
        { n: 'Steady Rhythm',  t: 1, x: 0.76, y: 0.90 },
        { n: 'Crescendo',            t: 2, x: 0.18, y: 0.66 },
        { n: 'The Standing Ovation', t: 2, x: 0.40, y: 0.68 },
        { n: 'Harmonic Resonance',   t: 2, x: 0.60, y: 0.68 },
        { n: 'Encore',               t: 2, x: 0.82, y: 0.66 },
        { n: 'Final Crescendo', t: 3, x: 0.22, y: 0.42 },
        { n: 'Perfect Harmony', t: 3, x: 0.42, y: 0.40 },
        { n: 'Rising Tempo',    t: 3, x: 0.58, y: 0.40 },
        { n: 'Final Movement',  t: 3, x: 0.78, y: 0.42 },
        { n: 'Symphony of War', t: 4, x: 0.50, y: 0.12 },
      ],
      edges: [[0,3],[0,4],[1,4],[1,5],[2,5],[2,6],[3,7],[4,8],[5,9],[6,10],[7,11],[8,11],[9,11],[10,11],[8,9,'link']],
    },
    {
      id: 'jester',
      name: 'Jester',
      motif: 'The Hat',
      motifDesc: "Three points rising off a shared brim — the side points are cheap, self-contained specializations; the center is the longer route to the capstone bell.",
      nodes: [
        // Brim (entry row)
        { n: "Keep 'Em Up",  t: 1, x: 0.16, y: 0.72 },
        { n: 'Steady Hands', t: 1, x: 0.50, y: 0.78 },
        { n: 'First Toss',   t: 1, x: 0.84, y: 0.72 },
        // Left point
        { n: 'Quick Catch',   t: 2, x: 0.14, y: 0.50 },
        { n: 'Crowd Pleaser', t: 3, x: 0.16, y: 0.28 },
        // Right point
        { n: 'Double Toss', t: 2, x: 0.86, y: 0.50 },
        { n: 'Blind Throw', t: 3, x: 0.84, y: 0.28 },
        // Center point (route to capstone)
        { n: 'Sleight of Blade', t: 2, x: 0.50, y: 0.58 },
        { n: 'The Big Finish',   t: 2, x: 0.50, y: 0.42 },
        { n: 'Perfect Timing',   t: 3, x: 0.50, y: 0.26 },
        // Shared bonus — linked to both side tips, NOT a prerequisite
        { n: 'Triple Cascade', t: 3, x: 0.50, y: 0.90 },
        { n: 'Never Drop the Act', t: 4, x: 0.50, y: 0.08 },
      ],
      edges: [
        [0,3],[3,4],[2,5],[5,6],[1,7],[7,8],[8,9],[9,11],
        [4,10,'link'],[6,10,'link'],
      ],
    },
    {
      id: 'animancer',
      name: 'Animancer',
      motif: 'The Marionette',
      motifDesc: 'A central puppet node with strings running up to controller nodes.',
      nodes: [
        { n: 'Cut the Strings', t: 1, x: 0.24, y: 0.10 },
        { n: 'First Puppet',    t: 1, x: 0.50, y: 0.06 },
        { n: 'Loose Joint',     t: 1, x: 0.76, y: 0.10 },
        { n: 'The Show Must Go On', t: 2, x: 0.16, y: 0.36 },
        { n: 'Double Act',          t: 2, x: 0.40, y: 0.32 },
        { n: 'Tangled Strings',     t: 2, x: 0.60, y: 0.32 },
        { n: 'Second Puppet',       t: 2, x: 0.84, y: 0.36 },
        { n: 'Final Bow',    t: 3, x: 0.20, y: 0.62 },
        { n: 'Full Cast',    t: 3, x: 0.42, y: 0.64 },
        { n: 'Puppet Swarm', t: 3, x: 0.58, y: 0.64 },
        { n: 'Tangled Fate', t: 3, x: 0.80, y: 0.62 },
        { n: 'Master of the Stage', t: 4, x: 0.50, y: 0.90 },
      ],
      edges: [[0,3],[0,4],[1,4],[1,5],[2,5],[2,6],[3,7],[4,8],[5,9],[6,10],[7,11],[8,11],[9,11],[10,11],[4,5,'link']],
    },
  ],
};

/** All three awakenings for a base class (case-insensitive). */
export function getAwakeningsFor(baseClass) {
  return AWAKENINGS[String(baseClass || '').toLowerCase()] || [];
}
