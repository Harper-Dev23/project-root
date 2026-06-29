// src/systems/EventResolver.js
// Pure resolution logic for a Hunt 'event' (non-fight) once the player
// engages with it — parallel to EncounterRoller, which only picks which
// event triggers. This is what actually resolves choice/check/puzzle kinds
// into an outcome once the player has acted.

const D20_SIDES = 20;

/**
 * Standard D&D-style ability modifier: floor((stat-10)/2). Character stats
 * (src/systems/CharacterBuilder.js) already sit on a comparable numeric
 * scale (e.g. DEX >= 10/15 thresholds already gate skills), so this reuses
 * a well-understood conversion rather than inventing a new one.
 */
export function statModifier(statValue = 10) {
  return Math.floor((statValue - 10) / 2);
}

export const EventResolver = {
  /**
   * Rolls a d20 + the given stat's modifier against a DC.
   * `roll` is the die face — callers driving a physical dice token (see
   * DiceToken.js) should pass that token's settled value in as `roll`
   * instead of letting this randomize, so the visual and the math agree.
   */
  rollCheck(stat, dc, totalStats, roll = null) {
    const statValue = totalStats?.[stat] ?? 10;
    const modifier = statModifier(statValue);
    const dieRoll = roll ?? (Math.floor(Math.random() * D20_SIDES) + 1);
    const total = dieRoll + modifier;
    return { roll: dieRoll, modifier, total, success: total >= dc };
  },

  /** Returns the outcome for a chosen option index on a 'choice' event. */
  resolveChoice(eventDef, optionIndex) {
    const option = eventDef.options?.[optionIndex];
    return option?.outcome || null;
  },

  /** Returns the success/failure outcome for a chosen answer on a 'puzzle' event. */
  resolvePuzzle(eventDef, answerIndex) {
    const correct = answerIndex === eventDef.correctIndex;
    return correct ? eventDef.success : eventDef.failure;
  },
};
