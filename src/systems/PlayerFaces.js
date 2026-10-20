// src/systems/PlayerFaces.js
//
// Player faces (Exploration System v2, chunk 15a). In co-op every player has
// a face: one of their own hunters, shown in that player's colour. Votes,
// map pings and the party token use it, so you can tell at a glance who
// chose what and who is leading.
//
// The server keeps each player's colour (kept for the whole lobby) and the
// face they chose (null: none chosen). This file turns that into what the
// screens draw. It is free of Phaser so it can be checked headlessly.
//
// The default face is the player's highest-Perception hunter (owner,
// 2026-10-04): the one who "sees" for them. A tie goes to the first listed.

import { hunterExploration } from './PartyStats.js';

/** One colour a seat, in seat order. Chosen to stay clear of the map's own
 *  colours (quest sites are violet, danger is red) and to read on its dark
 *  ground. `int` is for Phaser graphics, `css` for text. */
export const PLAYER_COLOURS = [
  { name: 'gold', int: 0xe8c66a, css: '#e8c66a' },
  { name: 'teal', int: 0x5dcaa5, css: '#5dcaa5' },
  { name: 'coral', int: 0xf0997b, css: '#f0997b' },
  { name: 'sky', int: 0x85b7eb, css: '#85b7eb' },
  { name: 'green', int: 0x97c459, css: '#97c459' },
  { name: 'rose', int: 0xed93b1, css: '#ed93b1' },
];

export const colourOf = (index) => PLAYER_COLOURS[((index | 0) % PLAYER_COLOURS.length + PLAYER_COLOURS.length) % PLAYER_COLOURS.length];

const refOf = (c) => c?.instanceId || c?.id || c?.ref || null;

/** A hunter's Perception rating (race + class + picks), 0 if unknown. */
export function perceptionOf(char) {
  try { return hunterExploration(char).ratings.perception || 0; } catch { return 0; }
}

/** The default face among these hunters: the highest Perception, the first on a tie. */
export function defaultFace(hunters) {
  let best = null, bestP = -Infinity;
  for (const h of hunters || []) {
    const p = perceptionOf(h);
    if (p > bestP) { best = h; bestP = p; }
  }
  return best;
}

/**
 * Every player's face, in seat order.
 *   players  the lobby's players ({ id, name, colour, face })
 *   party    the merged party: full characters, each with its ownerId
 *   leadId   the player who leads (chunk 15a: the host; 15e makes it pass)
 * A chosen face that is not one of that player's hunters in the party falls
 * back to the default, so a stale choice never shows someone else's hunter.
 * Returns [{ playerId, name, colour, ref, hunterName, skin, isLead }].
 */
export function facesOf({ players = [], party = [], leadId = null } = {}) {
  return players.map((p, i) => {
    const own = party.filter(c => c.ownerId === p.id);
    const hunter = (p.face != null && own.find(c => refOf(c) === p.face)) || defaultFace(own);
    return {
      playerId: p.id,
      name: p.name || p.id,
      colour: colourOf(p.colour ?? i),
      ref: refOf(hunter),
      hunterName: hunter?.name || null,
      skin: hunter?.skin || null,
      isLead: leadId != null && p.id === leadId,
    };
  });
}

/** Solo: the one player's face (the first colour), always the lead. */
export function soloFace(party) {
  const hunter = defaultFace((party || []).filter(c => c && c.status !== 'dead' && c.status !== 'slain')) || defaultFace(party);
  return { playerId: null, name: null, colour: PLAYER_COLOURS[0], ref: refOf(hunter),
    hunterName: hunter?.name || null, skin: hunter?.skin || null, isLead: true };
}
