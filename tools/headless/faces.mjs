// tools/headless/faces.mjs
//
// Player faces (chunk 15a): which hunter stands for each player, in which
// colour, and who leads. Checked on the real fixture party and the real
// Perception ratings (PartyStats), not on stand-ins.
//
// Run: node tools/headless/faces.mjs

import { installPhaserStub } from './phaserStub.js';
installPhaserStub(1515);

const { makeParty } = await import('./fixtures.js');
const { facesOf, soloFace, defaultFace, perceptionOf, PLAYER_COLOURS, colourOf } = await import('../../src/systems/PlayerFaces.js');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};
const refOf = (c) => c.instanceId || c.id;

console.log('=== player faces (chunk 15a) ===');
const party = makeParty();
const ps = party.map(perceptionOf);
check('the fixture hunters have real Perception ratings', ps.every(p => Number.isFinite(p)) && ps.some(p => p > 0),
  party.map((c, i) => `${c.name} ${ps[i]}`).join(', '));

const best = defaultFace(party);
check('the default face is the highest Perception', perceptionOf(best) === Math.max(...ps), `${best.name} ${perceptionOf(best)}`);
const firstBest = party.find(c => perceptionOf(c) === Math.max(...ps));
check('...the first listed on a tie', best === firstBest);
check('no hunters, no face', defaultFace([]) === null);

// Two players: p1 owns the first three, p2 the last three.
const merged = party.map((c, i) => Object.assign(c, { ownerId: i < 3 ? 'p1' : 'p2' }));
const players = [{ id: 'p1', name: 'A', colour: 0, face: null }, { id: 'p2', name: 'B', colour: 3, face: refOf(merged[5]) }];
const faces = facesOf({ players, party: merged, leadId: 'p1' });
check('one face a player, in seat order', faces.length === 2 && faces[0].playerId === 'p1' && faces[1].playerId === 'p2');
check('a player with no choice shows their own highest Perception',
  faces[0].ref === refOf(defaultFace(merged.slice(0, 3))), faces[0].hunterName);
check('a chosen face is used', faces[1].ref === refOf(merged[5]), faces[1].hunterName);
check('the face carries the hunter\'s portrait', faces.every(f => typeof f.skin === 'string' && f.skin.length > 0),
  faces.map(f => f.skin).join(', '));
check('each player in their own colour', faces[0].colour === PLAYER_COLOURS[0] && faces[1].colour === PLAYER_COLOURS[3]);
check('the lead is marked, and only the lead', faces[0].isLead && !faces[1].isLead);

// A stale choice (someone else's hunter) never shows another player's hunter.
const stale = facesOf({ players: [{ id: 'p2', name: 'B', colour: 1, face: refOf(merged[0]) }], party: merged });
check('a face that is not yours falls back to your own default',
  merged.slice(3).some(c => refOf(c) === stale[0].ref), stale[0].hunterName);

const solo = soloFace(party);
check('solo: one face, leading, in the first colour', solo.isLead && solo.colour === PLAYER_COLOURS[0] && solo.ref === refOf(defaultFace(party)));
check('six colours, all different', new Set(PLAYER_COLOURS.map(c => c.int)).size === 6);
check('colours wrap instead of failing', colourOf(7) === PLAYER_COLOURS[1] && colourOf(-1) === PLAYER_COLOURS[5]);

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
