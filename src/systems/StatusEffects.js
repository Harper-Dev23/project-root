// StatusEffects.js — Weakness System v3 (clean base)

// Keep only non-weakness status effects here.
// (Removed old poison DOT and stunned, since the new weakness system handles those fantasies.)
export const StatusEffects = {
  // Example of a generic, non-weakness status you still use:
  curse_cinders: {
    id: 'curse_cinders',
    name: 'Curse of Cinders',
    isDebuff: true,
    icon: '☠🔥'   // placeholder icon; you’ll swap to a sprite later
  },
  reward_needle_feint_crit: {
    id: 'reward_needle_feint_crit',
    name: 'Feint Advantage',
    icon: '✦'
  },
  heartpierced: {
    id: 'heartpierced',
    name: 'Heartpierced',
    isDebuff: true,
    icon: '♥'
  },
  pressure_point_ignition: {
    id: 'pressure_point_ignition',
    name: 'Ignited',
    isDebuff: true,
    permanent: true,
    description: 'The next hit taken deals bonus fire damage and inflicts fire buildup.',
    icon: '🔥'
  },
  shattering_cut_sundered: {
    id: 'shattering_cut_sundered',
    name: 'Shattered Guard',
    icon: 'S'
  },
  ice_shatter_armorbreak: {
    id: 'ice_shatter_armorbreak',
    name: 'Frost Fracture',
    icon: 'I'
  },
  roaring_focus: {
    id: 'roaring_focus',
    name: 'Roaring Focus',
    icon: 'R'
  },
  whip_rhythm: {
    id: 'whip_rhythm',
    name: 'Whip Rhythm',
    icon: 'W'
  },
  steady_breath: {
    id: 'steady_breath',
    name: 'Steady Breath',
    icon: 'B'
  },
  eagle_focus: {
    id: 'eagle_focus',
    name: 'Eagle Focus',
    icon: 'E'
  },
  steady_aim: {
    id: 'steady_aim',
    name: 'Steady Aim',
    icon: 'A'
  },
  focus_meditation: {
    id: 'focus_meditation',
    name: 'Focus Meditation',
    icon: 'M'
  },
  braced: {
    id: 'braced',
    name: 'Braced Guard',
    icon: 'G'
  },
  lockstep: {
    id: 'lockstep',
    name: 'Lockstep',
    icon: 'L'
  },
  ward_focus: {
    id: 'ward_focus',
    name: 'Ward Focus',
    icon: 'W'
  },
  anchor_stance: {
    id: 'anchor_stance',
    name: 'Anchor Stance',
    icon: 'A'
  },

  regen: { name: 'Regen', duration: 2, tickHeal: 3 },
  // Add any other *non-weakness* statuses here (e.g., shields, buffs, etc.)
};

/** Canonical weakness IDs (new system) */
export const WeaknessIDs = [
  // Elemental
  'fire', 'cold', 'lightning',
  // Physical
  'disorient', 'lacerate', 'expose',
  // Necrotic
  'toxic', 'disease', 'curse',
];

/** Global thresholds; all families share T1/T2 cutoffs */
export const WEAKNESS_T1 = 100;
export const WEAKNESS_T2 = 200;

/**
 * T1/T2 flavor names, single source of truth — CombatScene (combat log flavor
 * + weakness panel tooltips) and skillTooltip.js (skill reward lines) both
 * read from this instead of keeping their own copies, so a rename here can't
 * drift out of sync with what players see elsewhere.
 */
export const WeaknessTierNames = {
  lightning: ['Zapped', 'Shocked'],
  cold: ['Chilled', 'Frostbitten'],
  fire: ['Singed', 'Ablaze'],
  disorient: ['Dazed', 'Concussed'],
  lacerate: ['Bleeding', 'Hemorrhaging'],
  expose: ['Raw', 'Flayed'],
  disease: ['Sickened', 'Plagued'],
  curse: ['Hexed', 'Afflicted'],
  toxic: ['Poisoned', 'Envenomed'],
};

/** v3 tuning (all numbers are easy-to-tune knobs; nothing hard-locked) */
/** v3 tuning aligned to Final Draft v1 (tweak freely) */
export const WeaknessV3 = {
  globals: {
    // overflow -> intensity multiplier: 1 + (overflow / S), clamped at CAP
    INTENSITY_S: 300,
    INTENSITY_CAP: 2.5,

    // Decay curve shaping (applies to all families, scaled by each family's baseDecay)
    //  - 0-100: light chip decay, capped low so buildup can stick
    //  - 100-200: ramps toward the "12ish" band
    //  - 200+: jumps to ~28, then ramps into the 100s at extreme overflow
    // v3.3 rebalance: decay was overpowering buildup investment (weakness fell off
    // almost as fast as it was applied). All bands cut ~40-45% vs v3.2; resilience
    // (gear stat) picked up the slack as the intended counter to buildup instead.
    DECAY_BASELINE: 35,      // reference baseDecay used to derive thematic weights
    DECAY_LOW_BASE: 2,       // tuned so most land ~2-3 decay below T1
    DECAY_LOW_FLOOR: 1,
    DECAY_LOW_CAP: 3,
    DECAY_MID_START: 8,      // decay around 8 at 100 (pre-scaling)
    DECAY_MID_END: 12,       // decay approaches ~12 near T2 (pre-scaling)
    DECAY_MID_CAP: 14,
    DECAY_HIGH_BASE: 28,     // baseline decay once T2 is reached
    DECAY_HIGH_PER_100: 20,  // additional decay per 100 overflow (before scaling)
    DECAY_HIGH_CAP: 140,     // soft cap so even extreme overflow stays sane
  },

  families: {
    // === Elemental ============================================================
    lightning: {
      baseDecay: 35,
      t1: {
        // Change from flat 4 to a d4 roll
        joltDieMax: 4,     // use a 1..4 roll per jolt
        // joltFlat: 4,    // (optional) keep as fallback; unused if joltDieMax is present
      },
      t2: {
        // Bump chance so you can actually see extra procs while testing
        multiJoltChance: 0.40,             // base chance per extra jolt; scales with intensity (min(base*I, cap))
        multiJoltChanceCap: 0.95,          // never exceed 95% per extra roll
        extraJoltsMax: 4,                  // up to 4 extra jolts (so total 1..5)
      },
    },

    cold: {
      // Linear intensity ramp: ~+0.7 per 100 overflow, caps at 3.0
      intensity: { formula: 'linear', slope: 0.007, cap: 3.0 },

      t1: {
        initiativePenalty: 0.15,
        initiativePenaltyCap: 0.50,

        // NEW: reduce Initiative Gauge gain each start of turn
        // final penalty = min(gaugeRegenPenalty * I_cold, gaugeRegenPenaltyCap)
        gaugeRegenPenalty: 0.35,
        gaugeRegenPenaltyCap: 0.75
      },
      t2: {
        dmgDealtPenalty: 0.10,
        dmgDealtPenaltyCap: 0.35,
        evasionPenalty: 0.25,
        evasionPenaltyCap: 0.60,

        // NEW: flat drain from the Initiative Gauge at start of turn
        // actual drain = floor(gaugeStartDrainBase * I_cold), clamped by gaugeStartDrainCap
        gaugeStartDrainBase: 8,
        gaugeStartDrainCap: 35
      }
    },


    fire: {
      baseDecay: 40,
      // === Fire-specific intensity curve (smooth linear ramp past T2) ===
      //  - At t2 (e.g. 200) -> 1.0x intensity (no overflow yet)
      //  - +0.01 per overflow point (e.g., +2.0 at +200 overflow => 3.0 total)
      //  - Caps at 8.0 around ~700 overflow
      intensity: { formula: 'linear', slope: 0.01, cap: 8.0 },

      t1: {
        onActLoss: 10,         // was 3; stronger on-act burn loss
        // Was flat regardless of how far into Fire overflow the target was —
        // now scales with Fire's own intensity curve (up to 8.0x, so the cap
        // matters a lot more here than most families' 2.5x global cap).
        incomingFireBonus: 0.25,
        incomingFireBonusCap: 1.0,
      },
      t2: {
        // Start-of-turn base burn before multiplier (we'll multiply by the intensity curve above)
        startTickBase: 10,

        // Optional: extra meter consumption at start of turn (scales with intensity)
        // Targets: ~150 at 400, ~300-350 at 650-700; clamped by 'cap'
        startConsume: { base: 50, c1: 0.5, c2: 0.2, S2: 1000, cap: 400 },
      },
    },


    // === Physical =============================================================
    disorient: {
      // Linear intensity ramp: ~+0.7 per 100 overflow, caps at 3.0
      intensity: { formula: 'linear', slope: 0.007, cap: 3.0 },

      t1: {
        // T1: Skill cost multiplier (applies to MP now; you can extend to HP/etc later)
        // final multiplier = 1 + min(costMultiplier * I, costMultiplierCap)
        costMultiplier: 0.25,       // +25% at I=1.0
        costMultiplierCap: 0.75     // up to +75%
      },
      t2: {
        // T2: Start-of-turn MP drain (scaled, capped)
        // drain = floor(startDrainMPBase * I), clamped by startDrainMPCap
        startDrainMPBase: 6,
        startDrainMPCap: 40
      }
    },

    lacerate: {
      baseDecay: 35,
      t1: {
        // was effectively 0 (unset); set to 10 = 50% of the old 20 baseline
        onActBuildupFlat: 10,
      },
    },


    expose: {
      baseDecay: 35,
      t1: {
        physDRPen: 0.10,        // fraction of defender DR ignored (scales with intensity)
        physBuildupAmp: 0.15,   // extra physical-family buildup taken (Disorient/Lacerate)
      },
      t2: {
        critChanceBonus: 0.15,  // extra absolute crit chance (scales with intensity)
        critDamageBonus: 0.25,  // extra crit damage multiplier
      },
    },

    // === Necrotic ================================================================
    disease: {
      baseDecay: 35,
      // healRecvPenalty now scales with intensity (was a flat 25% regardless
      // of overflow) — matches maxHPDown below, which was already scaled.
      t1: { healRecvPenalty: 0.25, healRecvPenaltyCap: 0.60 }, // incoming healing reduced
      t2: { maxHPDown: 0.10 },       // temporary max HP reduction
    },

    curse: {
      name: 'Curse',
      decay: { base: 35, overflow: 0.40 },   // optional; if you keep families.*.decay elsewhere, you can remove this line
      t1: {
        name: 'Hexed',
        // Was a flat 25% regardless of overflow — now scales with intensity,
        // same pattern as curseAmpMult below.
        decayReduction: 0.25,                 // slows CURSE meter decay
        decayReductionCap: 0.60,
      },
      t2: {
        name: 'Afflicted',
        decayReduction: 0.50,                 // even slower
        decayReductionCap: 0.85,
        curseAmpMult: 1.25                    // amplifies CURSE-tagged abilities (damage/buildup hooks)
      },
      cinders: { baseCritChance: 0.10, critDamageBonus: 0.50 }
    },


    toxic: {
      baseDecay: 30,
      // decayBypassChance scales with intensity (same pattern as Disorient's
      // costMultiplier, Cold's gaugeRegenPenalty, etc. below) — a heavily
      // overflowing Toxic meter should be MORE likely to dodge its decay
      // tick, not a flat chance regardless of how far past T2 it is.
      t1: { decayBypassChance: 0.30, decayBypassChanceCap: 0.75 },
      t2: { startTickBase: 5 },        // lighter start-of-turn poison tick
    },
  },
};


/** Derived: WeaknessFamilies used by the engine (thresholds + per-family decay) */
export const WeaknessFamilies = (() => {
  const o = {};
  for (const id of WeaknessIDs) {
    const baseDecay = WeaknessV3.families[id]?.baseDecay ?? 35;
    o[id] = { t1: WEAKNESS_T1, t2: WEAKNESS_T2, decay: baseDecay, grace: 0 };
  }
  return o;
})();

/** Make a fresh weakness container for a unit */
export function makeWeaknessState() {
  const meters = {};
  const tiers = {};
  const grace = {};
  for (const id of WeaknessIDs) {
    meters[id] = 0;
    tiers[id] = 0;
    grace[id] = WeaknessFamilies[id].grace;
  }
  return { meters, tiers, grace };
}

/** Overflow -> effect intensity multiplier */
export function weaknessIntensityMult(m) {
  const S = WeaknessV3.globals.INTENSITY_S;
  const cap = WeaknessV3.globals.INTENSITY_CAP;
  const overflow = Math.max(0, m - WEAKNESS_T2);
  return Math.min(cap, 1 + (overflow / S));
}

/** Overflow-aware decay amount (piecewise curve keeping low tiers modest) */
export function weaknessDecayAmount(baseDecay, m) {
  const g = WeaknessV3.globals || {};
  const baseline = g.DECAY_BASELINE || 35;
  const weight = Math.max(0.5, (baseDecay || baseline) / baseline);

  const lowBase = (g.DECAY_LOW_BASE ?? 4) * weight;
  const lowFloor = g.DECAY_LOW_FLOOR ?? 2;
  const lowCap = g.DECAY_LOW_CAP ?? 5;

  const midStart = (g.DECAY_MID_START ?? 14) * weight;
  const midEnd = (g.DECAY_MID_END ?? 22) * weight;
  const midCap = g.DECAY_MID_CAP ?? 24;

  const highBase = (g.DECAY_HIGH_BASE ?? 50) * weight;
  const highPer100 = (g.DECAY_HIGH_PER_100 ?? 35) * weight;
  const highCap = g.DECAY_HIGH_CAP ?? 240;

  const meter = Math.max(0, m | 0);

  if (meter <= 0) return 0;

  // 0-100: keep decay tiny so buildup sticks (max 5, themed by weight)
  if (meter < WEAKNESS_T1) {
    const decay = Math.min(lowCap, Math.max(lowFloor, Math.round(lowBase)));
    return decay;
  }

  // 100-200: ease into the ~20 decay band, keeping family scaling
  if (meter < WEAKNESS_T2) {
    const t = (meter - WEAKNESS_T1) / Math.max(1, WEAKNESS_T2 - WEAKNESS_T1);
    const start = Math.min(midCap, Math.max(lowFloor, Math.round(midStart)));
    const end = Math.min(midCap, Math.max(start, Math.round(midEnd)));
    const decay = Math.min(midCap, Math.max(lowFloor, Math.round(start + (end - start) * t)));
    return decay;
  }

  // 200+: start around 50 decay, then ramp with overflow toward the 200s
  const overflow = meter - WEAKNESS_T2;
  const base = Math.min(highCap, Math.max(lowFloor, Math.round(highBase)));
  const ramp = Math.max(0, overflow / 100) * highPer100;
  const decay = Math.min(highCap, Math.max(base, Math.round(base + ramp)));
  return decay;
}

/** Meter → Tier helper */
export function weaknessTierFromMeter(m) {
  return (m >= WEAKNESS_T2) ? 2 : (m >= WEAKNESS_T1 ? 1 : 0);
}

/**
 * TEMP compatibility layer for legacy keys used elsewhere.
 * Remove once all references are migrated to canonical IDs.
 *   stun  -> disorient
 *   bleed -> lacerate
 *   flay  -> expose
 *   poison-> toxic
 */
export const WeaknessAliases = {
  stun: 'disorient',
  bleed: 'lacerate',
  flay: 'expose',
  poison: 'toxic',
};

/** Map any input key (legacy or modern) to a canonical ID */
export function getFamilyId(key) {
  if (!key) return key;
  if (WeaknessIDs.includes(key)) return key;
  return WeaknessAliases[key] || key;
}

// Family-specific intensity override (falls back to global weaknessIntensityMult)
export function familyIntensityMult(family, meters, families = WeaknessFamilies, v3 = WeaknessV3) {
  try {
    const fam = (families || WeaknessFamilies)[family];
    const cfg = (v3 || WeaknessV3)?.families?.[family]?.intensity;
    const m = (typeof meters === 'number') ? meters : (meters?.[family] | 0);
    const t2 = fam?.t2 ?? 0;
    if (!cfg || !fam) return weaknessIntensityMult(m); // fallback to global

    const overflow = Math.max(0, m - t2);
    if (cfg.formula === 'quad') {
      const S = cfg.S ?? 200;
      const a = cfg.a ?? 1;
      const b = cfg.b ?? 1;
      const cap = cfg.cap ?? (v3?.globals?.INTENSITY_CAP ?? 2.5);
      const x = overflow / Math.max(1, S);
      return Math.min(cap, 1 + a * x + b * x * x);
    }
    if (cfg.formula === 'linear') {
      const cap = cfg.cap ?? (v3?.globals?.INTENSITY_CAP ?? 2.5);
      const slope = (cfg.k ?? cfg.slope ?? (1 / Math.max(1, cfg.S ?? 200)));
      return Math.min(cap, 1 + slope * overflow);
    }
    // Future formulas here...
    return weaknessIntensityMult(m);
  } catch {
    return weaknessIntensityMult((meters?.[family] | 0) || 0);
  }
}

// Family-specific start-of-turn meter consumption (optional; returns 0 if not configured)
export function familyStartConsume(family, meters, families = WeaknessFamilies, v3 = WeaknessV3) {
  try {
    const fam = (families || WeaknessFamilies)[family];
    const cfg = (v3 || WeaknessV3)?.families?.[family]?.t2?.startConsume;
    const m = (typeof meters === 'number') ? meters : (meters?.[family] | 0);
    const t2 = fam?.t2 ?? 0;
    if (!cfg || !fam) return 0;

    const O = Math.max(0, m - t2);
    const base = cfg.base ?? 0;
    const c1 = cfg.c1 ?? 0;
    const c2 = cfg.c2 ?? 0;
    const S2 = cfg.S2 ?? 1000;
    const cap = cfg.cap ?? 9999;

    const loss = Math.floor(base + c1 * O + c2 * ((O * O) / Math.max(1, S2)));
    return Math.max(0, Math.min(cap, loss));
  } catch {
    return 0;
  }
}

// === Curse of Cinders status =========================
// Applied to a target that already has Curse T1+. Lasts fixed turns.
// While present (and the target remains Curse T1+), Fire T2's burn tick (AFLAME) can crit,
// with extra crit chance scaling by the target's Curse overflow.

export function addCurseCindersStatus(target, { sourceId, duration = 3 } = {}) {
  if (!target?.statuses) target.statuses = {};
  target.statuses.curse_cinders = {
    id: 'curse_cinders',
    turns: Math.max(1, duration),
    sourceId: sourceId ?? null, // caster (for crit stats if you want)
    appliedAtRound: (globalThis?.BattleRoundCounter ?? 0),
  };
}

export function hasCurseCinders(target) {
  return !!target?.statuses?.curse_cinders;
}

export function tickDownCurseCinders(target) {
  const st = target?.statuses?.curse_cinders;
  if (!st) return;
  st.turns -= 1;
  if (st.turns <= 0) {
    delete target.statuses.curse_cinders;
  }
}

// True if target’s Curse meter is at least T1
export function hasCurseTier1Plus(target) {
  const m = target?.weakness?.meters?.curse || 0;
  return m >= 100; // your global T1 threshold
}

// Returns a 0..1 “overflow factor” above T2 for scaling (0 if below 200).
// Example: 220 => 0.20, 350 => 1.50 (cap later where used).
export function curseOverflowFactor(target) {
  const m = target?.weakness?.meters?.curse || 0;
  if (m <= 200) return 0;
  return (m - 200) / 100; // 1.0 per +100 overflow; adjust if you prefer milder curves
}


