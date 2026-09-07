// LocalChatScripts.js
//
// Per-encounter content for the combat log's "Local" tab — mirrors
// AIProfiles.js's own shape on purpose: a plain object registry keyed by
// scenario id (the same id combatScenarios.js uses), each entry a set of
// hook functions, looked up generically by the engine instead of hardcoded
// per-encounter branching in CombatScene.js. Adding a new encounter's chat
// behavior means adding a new entry here, same as adding a new AI_PROFILES
// entry for its NPCs. New trigger types (e.g. "an ally got hit") are just a
// new hook name + a new call site in CombatScene.js wherever that event
// already happens — nothing about this registry's shape needs to change.
//
// Hooks (all optional — an encounter with no entry, or an entry missing a
// hook, just gets silence for that trigger):
//
//   onCombatStart(ctx) -> string | string[] | null
//     Called once, right as the combat log is created (before the first
//     turn). Good for an opening flavor line.
//
//   onPlayerInput(text, ctx) -> string | string[] | null
//     Called when the player submits text into the Local tab. Return a line
//     (or several, posted in order) to reply with, or null/undefined to stay
//     silent. `ctx.scene` is the live CombatScene — later encounters that
//     want to "talk to" a specific enemy can read scene.enemies (status,
//     weakness tiers, name, etc.) from here to build a contextual reply
//     rather than a flat keyword table.
//
//   onEnemyDefeated(ctx) -> string | string[] | null
//     Called every time an enemy belonging to this encounter is knocked out.
//     ctx.defeatedCount is a running 1-indexed count for this combat;
//     ctx.totalEnemies is the encounter's starting enemy count; ctx.enemy is
//     the unit that just went down.
//
//   onInitiativeAbilityUsed(ctx) -> string | string[] | null
//     Called whenever ANY unit (either side) successfully uses an ability
//     gated by requiresInitiativeGauge (i.e. it had enough gauge and is
//     actually executing, not fizzling) — CombatScene.js's generic Initiative
//     Gauge gate in _applyAbilityToTarget. ctx.user is the caster, ctx.ability
//     is the skill definition (check ctx.ability.id to react to a specific
//     one). Filter on ctx.user yourself (e.g. ctx.user.isEnemy, or a specific
//     type/name) — this fires for players too if nothing filters it out.
//
//   onCrit(ctx) -> string | string[] | null
//     Called whenever a hit in the primary single-target damage path lands a
//     critical. ctx.user/ctx.target/ctx.ability as above. Splash/DOT/repeat
//     hits don't go through this specific path — primary hits only.
//
//   onRoundStart(ctx) -> string | string[] | null
//     Called once at the top of each new round (when the turn order wraps
//     back to the first actor), INCLUDING round 1. On a scenario that
//     declares a turnLimit it is deliberately NOT called for the round the
//     clock runs out on — that combat ends on _onTurnLimitReached's own
//     message instead. ctx.turnLimit is the scenario's limit (0 if untimed)
//     and ctx.roundsRemaining counts the current round as remaining, so it
//     reads 1 on the final round and is null when untimed.
//
//   onAbilityUsed(ctx) -> string | string[] | null
//     Called whenever ANY unit (either side) successfully uses ANY ability —
//     broader than onInitiativeAbilityUsed (not limited to
//     requiresInitiativeGauge skills). ctx.user/ctx.target/ctx.ability as
//     above; check ctx.ability.id to react to a specific skill. There's no
//     dedicated "HP threshold crossed" hook — just read
//     ctx.user.currentHP/ctx.user.maxHP yourself from inside this (or
//     onCrit) and throttle via ctx.state so it only fires once per combat.
//
// ctx shape (all hooks): { scene, scenarioId, round, state, ...hook-specific }
//   scene/scenarioId — as above.
//   round            — 1-indexed, bumped whenever turn order wraps back to
//                       the first actor (i.e. once per full "everyone acted"
//                       cycle). Measured relative to the combat's own start,
//                       so it matches the "Round N" counter the player sees
//                       and IS safe to surface directly. (The engine's raw
//                       combatRound is 2 during the first turn because the
//                       bootstrap _advanceTurn wraps the index to 0 — that
//                       offset is corrected in _buildLocalChatCtx.)
//   turnLimit / roundsRemaining — only set for onRoundStart.
//   state            — a plain object, fresh each combat, yours to stash
//                       whatever this script needs to remember between
//                       calls (last-triggered round, a line index, etc.).
//   defeatedCount/totalEnemies/enemy — only set for onEnemyDefeated.
//   user/target/ability — only set for onInitiativeAbilityUsed/onCrit/onAbilityUsed.

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/**
 * Builds the three training_encounter_2_reckoning_* entries.
 *
 * `heat` is how invested the crowd is (1 = idle betting, 3 = a proper mob).
 * Every tier gets the same countdown structure; only the wording escalates.
 */
function reckoningChat() {
  const OPENING = {
    1: ['Odds go up around the pit. Someone starts a count.'],
    2: ['The pit is fuller than last time. Coin changes hands before you have swung once.'],
    3: ['The whole pit has turned out for this one. A bookmaker climbs onto a barrel to see over the crowd.'],
  };
  // Indexed by roundsRemaining (5 down to 1), per tier.
  const COUNTDOWN = {
    1: {
      5: ['"Five rounds!" someone calls. "Five, and not one more!"'],
      4: ['A hunter near the rail counts down four on his fingers.'],
      3: ['"Halfway," someone says, unimpressed.'],
      2: ['The counting picks up. Two rounds left.'],
      1: ['"Last round!" The crowd leans in.'],
    },
    2: {
      5: ['"Five rounds on the reinforced stock!" The betting turns loud.'],
      4: ['Four. The bookmaker shortens the odds against you.'],
      3: ['Three rounds. Someone asks, loudly, whether you have brought enough.'],
      2: ['Two rounds. Half the pit is counting out loud now.'],
      1: ['"LAST ROUND!" The counting becomes a chant.'],
    },
    3: {
      5: ['"Five rounds against the heaviest stock in the pit!" The crowd howls.'],
      4: ['Four rounds. The chant has already started, and it is not for you.'],
      3: ['Three. The bookmaker stops taking bets on you finishing.'],
      2: ['Two rounds left. The noise is genuinely difficult to think through.'],
      1: ['"LAST ROUND!" The whole pit is on its feet, counting every swing.'],
    },
  };
  const DEFEATED = {
    1: ['A cheer, and the sound of coin moving.', 'Someone marks a tally on the rail.'],
    2: ['The crowd roars. Odds shift mid-count.', 'A bookmaker swears and re-chalks his board.'],
    3: ['The pit erupts.', 'Someone tears up a betting slip.', 'The chant stumbles, then comes back louder.'],
  };
  const CONFUSED = {
    1: '??', 2: '?!', 3: '???',
  };

  const entries = {};
  for (const heat of [1, 2, 3]) {
    entries[`training_encounter_2_reckoning_${heat}`] = {
      onCombatStart: () => OPENING[heat],
      onRoundStart: (ctx) => COUNTDOWN[heat][ctx.roundsRemaining] || null,
      onEnemyDefeated: () => pick(DEFEATED[heat]),
      // Same throttle the base encounter uses — the constructs still have no
      // idea what you are saying, they are just under more pressure about it.
      onPlayerInput: (_text, ctx) => {
        if (ctx.state.confusedRound === ctx.round) return null;
        ctx.state.confusedRound = ctx.round;
        const dummy = pick(['Lenny', 'Gary', 'Stan', 'Doug', 'Mo', 'Chad']);
        return `Dummy ${dummy}: ${CONFUSED[heat]}`;
      },
    };
  }
  return entries;
}

export const LOCAL_CHAT_SCRIPTS = {
  training_encounter_1: {
    // Any input at all gets a reply, but only once per round — spamming the
    // chat mid-round doesn't spam the response back.
    onPlayerInput(_text, ctx) {
      if (ctx.state.birdsRound === ctx.round) return null;
      ctx.state.birdsRound = ctx.round;
      return 'Birds are chirping.';
    },
    onEnemyDefeated(ctx) {
      const lines = ['The wood splinters.'];
      if (ctx.defeatedCount === 4) lines.push('A few hunters gather near the edge of the pit.');
      if (ctx.defeatedCount === 5) lines.push('You feel the gaze of some onlookers.');
      if (ctx.defeatedCount === 6) lines.push('Murmurs from the crowd.');
      return lines;
    },
  },

  // The crowd is only half-paying-attention here — these dummies are still
  // just training constructs to them. Deliberately understated; encounter 3
  // (same six dummies, now geared up and with names/personalities) is where
  // the crowd is meant to start actually caring.
  training_encounter_2: {
    onCombatStart() {
      return 'A few from the crowd turn to watch you.';
    },
    // Anonymous constructs with no reason to understand chat — a random one
    // just echoes back confusion. Throttled once per round, matching
    // training_encounter_1's onPlayerInput, so spamming the tab doesn't spam
    // the reply back.
    onPlayerInput(_text, ctx) {
      if (ctx.state.confusedRound === ctx.round) return null;
      ctx.state.confusedRound = ctx.round;
      const dummy = pick(['Lenny', 'Gary', 'Stan', 'Doug', 'Mo', 'Chad']);
      return `Dummy ${dummy}: ??`;
    },
    onEnemyDefeated() {
      return pick([
        'The crowd cheers half-heartedly.',
        'A few onlookers seem uninterested.',
        'Someone in the crowd gasps.',
        'A scattered jeer comes from the crowd.',
      ]);
    },
  },

  // Encounter 2's Reckoning tiers — the timed DPS races. Unlike the base
  // fight (where the crowd is barely paying attention), here they have money
  // on the clock, so the countdown itself is the flavour: onRoundStart calls
  // the remaining rounds like a bookmaker calling odds.
  //
  // All three tiers share one factory rather than triplicating the hooks —
  // only the crowd's INTENSITY changes per tier, so that is the only
  // parameter. If a tier ever needs genuinely different content, give it its
  // own object; this is a convenience, not a constraint.
  //
  // Keyed on roundsRemaining (which counts the current round, so it reads 1
  // on the final round) rather than on the round number, so these lines stay
  // correct if a tier's turnLimit is ever retuned away from 5.
  ...reckoningChat(),

  // Same crowd, now actually invested — plus the Elseth Animancer herself is
  // watching (revealed to the player in her pre-encounter briefing: "I
  // animate those constructs in the pit... Next time I send them out,
  // they'll fight back properly"). Her reactions are deliberately muted —
  // quiet disapproval, not outright anger — every time one of her
  // constructs goes down. Crowd-cheers-for-named-dummies and ability-
  // triggered reactions are a planned follow-up, not built yet — this
  // encounter's dummies still need their own stat/skill pass first.
  training_encounter_3: {
    onCombatStart() {
      return ['The crowd watches eagerly.', 'Wren is watching from the edge of the pit.'];
    },
    // Same six constructs as encounter 2, but geared up and named now — a
    // random one replies in-character instead of the flat "??" gag, since
    // they're meant to read as actual personalities by this point.
    onPlayerInput(_text, ctx) {
      if (ctx.state.replyRound === ctx.round) return null;
      ctx.state.replyRound = ctx.round;
      return pick([
        'Chad the Unbreakable grunts, unimpressed.',
        "Stan, of the Light offers a small, knowing smile.",
        'Gary the Grim mutters something about doom.',
        "Doug Longshot doesn't even glance up from aiming.",
        "Shifty-Eyed Mo's eyes dart toward you, then away.",
        'Lenny the Magnificent strikes a dramatic pose.',
      ]);
    },
    onEnemyDefeated() {
      return pick([
        "Wren's eyes narrow, just slightly.",
        'She frowns, watching in silence.',
        'The Animancer shakes her head.',
        'Her arms cross. She says nothing.',
        'She looks away for a moment, jaw tight.',
      ]);
    },
  },

  // Unlike Wren, Cade isn't an observer here — she's the huntsman_commander
  // enemy herself, leading Oskar and Kiro directly (see her lodge briefing,
  // TownScene.js BRIEF_TEXT.styx: "My hunters will test you").
  training_encounter_4: {
    onCombatStart() {
      return 'Cade signals Oskar and Kiro forward, calm and unhurried.';
    },
    // Cade comments on losing a beast while she's still standing; if she's
    // already down herself, the surviving beast reacts on its own instead.
    onEnemyDefeated(ctx) {
      const enemy = ctx.enemy;
      if (enemy?.type === 'huntsman_commander') return null; // Cade herself falls — no self-commentary
      if (!enemy?.tags?.includes('beast')) return null;

      const enemies = ctx.scene?.enemies || [];
      const cade = enemies.find(e => e?.type === 'huntsman_commander');
      if (cade && cade.status !== 'incapacitated') {
        return pick([
          `${enemy.name} falls. Cade's jaw tightens, but she doesn't stop moving.`,
          `Cade barely glances at ${enemy.name}'s fall — already recalculating.`,
          `"Predictable," Cade mutters, watching ${enemy.name} go down.`,
        ]);
      }

      const survivor = enemies.find(e => e?.tags?.includes('beast') && e !== enemy && e.status !== 'incapacitated');
      if (survivor) {
        return pick([
          `${survivor.name} roars, baring its teeth.`,
          `${survivor.name} hisses, hackles raised.`,
        ]);
      }
      return null;
    },
    // Cade reacting to her own or the beasts' initiative-gauge spenders.
    onInitiativeAbilityUsed(ctx) {
      if (!ctx.user?.isEnemy) return null;
      const enemies = ctx.scene?.enemies || [];
      const cade = enemies.find(e => e?.type === 'huntsman_commander');
      if (!cade || cade.status === 'incapacitated') return null;

      if (ctx.ability?.id === 'huntsman_coordinated_volley') {
        return 'Cade whistles sharply — a coordinated strike, timed perfectly.';
      }
      if (ctx.ability?.id === 'kiro_molt') {
        return `Cade nods as ${ctx.user?.name || 'Kiro'} sheds his skin. "Good. Keep moving."`;
      }
      return null;
    },
    // Cade reacting to a beast landing a crit.
    onCrit(ctx) {
      if (!ctx.user?.tags?.includes('beast')) return null;
      const enemies = ctx.scene?.enemies || [];
      const cade = enemies.find(e => e?.type === 'huntsman_commander');
      if (!cade || cade.status === 'incapacitated') return null;

      return pick([
        'Cade allows herself a small, satisfied nod.',
        '"That\'s the one," Cade murmurs.',
      ]);
    },
  },

  training_encounter_5: {
    onCombatStart() {
      return 'Ember and Rime take their positions, moving as one.';
    },
    // Whichever twin dies, the survivor's reaction ties directly into the
    // enrage mechanic itself (enrageOnAllyDeath, enemyTypes.js) — this is
    // narration for a real mechanical state change, not just flavor.
    onEnemyDefeated(ctx) {
      if (ctx.enemy?.type === 'fire_duelist') {
        return 'Rime\'s eyes go cold with fury at Ember\'s fall.';
      }
      if (ctx.enemy?.type === 'ice_duelist') {
        return 'Ember roars, grief turning instantly to rage at Rime\'s fall.';
      }
      return null;
    },
  },

  // The Berserker himself, reacting to his own crits/signature abilities and
  // to actually being hurt — see project_encounter6_new_skills_planned
  // memory for the design behind Reckless Harvest/Bloodrite/Unstoppable
  // Rush's glare. No dedicated "HP threshold" hook exists — the <50% line is
  // just checked from inside onCrit/onAbilityUsed and throttled via
  // ctx.state so it only ever fires once per combat.
  training_encounter_6: {
    onCombatStart() {
      return 'The Berserker rolls his shoulders, Bloodthirster dragging a groove in the dirt.';
    },
    onCrit(ctx) {
      if (ctx.user?.type !== 'berserker_boss') return null;
      return pick([
        'The Berserker laughs — a wet, ugly sound.',
        '"THERE it is," the Berserker roars.',
        'The crowd flinches at the impact.',
      ]);
    },
    onAbilityUsed(ctx) {
      if (ctx.user?.type !== 'berserker_boss') return null;
      const lines = [];
      if (ctx.ability?.id === 'berserker_death_spiral') {
        lines.push('The Berserker spins into the finishing blow, blood already running down his own arm.');
      } else if (ctx.ability?.id === 'berserker_reckless_harvest') {
        lines.push('The Berserker tears at his own wound, grinning through the pain.');
      } else if (ctx.ability?.id === 'berserker_bloodrite') {
        lines.push('The Berserker howls something old and wordless — his wounds start to close.');
      } else if (ctx.ability?.id === 'berserker_unstoppable_rush') {
        lines.push(`The Berserker fixes his glare on ${ctx.target?.name || 'his prey'}. "Don’t. Move."`);
      }
      // Once-per-combat low-HP line, checked opportunistically off whatever
      // ability just fired rather than a dedicated threshold-crossed event.
      const ratio = (ctx.user.maxHP | 0) > 0 ? (ctx.user.currentHP | 0) / ctx.user.maxHP : 1;
      if (!ctx.state.berserkerLowHPSaid && ratio < 0.5) {
        ctx.state.berserkerLowHPSaid = true;
        lines.push('The Berserker staggers, blood-slick and snarling — and keeps coming anyway.');
      }
      return lines.length ? lines : null;
    },
  },
};

export function getLocalChatScript(scenarioId) {
  return LOCAL_CHAT_SCRIPTS[scenarioId] || null;
}
