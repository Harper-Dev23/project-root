// src/systems/CoopWire.js
//
// Turning characters into something safe to send, and back again.
//
// Lives in src/ rather than server/ because BOTH sides need it and there must
// only be one implementation. The browser packs its hunters with
// toWireCharacter before sending them to a lobby; the server unpacks them with
// fromWireCharacter. If those two ever disagreed about what a character is,
// the disagreement would surface as skills silently doing nothing.
//
// No dependencies beyond the game's own data. Nothing here touches Phaser, so
// it is equally usable from a headless Node process.

import { SKILLS } from '../../data/skills.js';
import { rebuildCharacterStats } from './CharacterBuilder.js';

/**
 * A character reduced to what is safe to send.
 *
 * The trap this exists for: a character JSON round-trips WITHOUT ERROR and
 * silently loses every skill's apply() function -- 15 of 19 on a level-5
 * hunter. Sending a character straight down a socket and using what comes out
 * the other end leaves every skill fizzling, and CombatScene's try/catch
 * swallows the TypeError and logs "fizzled" rather than anything diagnosable.
 *
 * So skills travel as IDS. Both sides already have data/skills.js.
 */
export function toWireCharacter(char) {
  const wire = {};
  const SKIP = new Set(['skills', '_slot', 'icon', 'hpBar', 'mpBar', 'initBar', '_netUnits']);
  for (const [k, v] of Object.entries(char || {})) {
    if (typeof v === 'function' || SKIP.has(k)) continue;
    try { JSON.stringify(v); } catch { continue; }   // drop anything circular
    wire[k] = v;
  }
  wire.skillIds = (char?.skills || []).map(s => s?.id).filter(Boolean);
  return wire;
}

/**
 * Rebuild a usable character from wire data.
 *
 * Throws on an unknown skill id rather than dropping it. A hunter quietly
 * missing one skill is the kind of desync that surfaces ten minutes later as
 * "why did nothing happen", and it means the two sides disagree about what the
 * game contains -- worth failing loudly at the door.
 */
export function fromWireCharacter(wire) {
  const char = { ...wire };
  delete char.skillIds;

  char.skills = (wire?.skillIds || []).map(id => {
    const skill = SKILLS[id];
    if (!skill) throw new Error(`unknown skill id from the wire: ${id}`);
    return { ...skill, id };
  });

  // Derived stats and gearEffects are recomputed rather than trusted. They are
  // a pure function of stats and equipment, so recomputing costs nothing and
  // removes a whole class of "the client said its Accuracy was 400".
  rebuildCharacterStats(char);
  return char;
}
