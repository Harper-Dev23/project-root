// src/ui/FaceToken.js
//
// A player's face as a round portrait in their colour (chunk 15a): the party
// token on the hunt map, and later votes and pings.
//
// The round crop is drawn once into a canvas texture per portrait and size,
// instead of using a mask: ENGINE_HAZARDS, masks render nothing in Canvas
// mode, and a canvas texture looks the same in WebGL and Canvas.

const portraitKeyOf = (face) => face?.skin || null;

/** The key of a round crop of this portrait at this diameter, made once. */
export function roundPortraitKey(scene, skin, diameter) {
  if (!skin || !scene.textures.exists(skin)) return null;
  const key = `face_round_${skin}_${diameter}`;
  if (scene.textures.exists(key)) return key;
  const src = scene.textures.get(skin).getSourceImage();
  const tex = scene.textures.createCanvas(key, diameter, diameter);
  if (!tex) return null;
  const ctx = tex.getContext();
  ctx.save();
  ctx.beginPath();
  ctx.arc(diameter / 2, diameter / 2, diameter / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  // Portraits are square; a non-square one is cropped from its top centre,
  // where a face is.
  const side = Math.min(src.width, src.height);
  ctx.drawImage(src, (src.width - side) / 2, 0, side, side, 0, 0, diameter, diameter);
  ctx.restore();
  tex.refresh();
  return key;
}

/**
 * Draw a face token centred at (x, y): the round portrait inside a ring of
 * the player's colour, on a dark disc so it reads on any ground. With no
 * portrait (none loaded) it is a disc in the player's colour, as the old
 * party dot was. Returns the objects drawn, so the caller can add them to its
 * container. `lead` adds a small notch above it.
 */
export function drawFaceToken(scene, x, y, face, { diameter = 30, ring = 3, lead = false } = {}) {
  const colour = face?.colour?.int ?? 0xf5f1e6;
  const objs = [];
  const g = scene.add.graphics();
  g.fillStyle(0x111214, 1).fillCircle(x, y, diameter / 2 + ring);
  g.fillStyle(colour, 1).fillCircle(x, y, diameter / 2 + ring - 0.5);
  objs.push(g);
  const key = roundPortraitKey(scene, portraitKeyOf(face), diameter);
  if (key) objs.push(scene.add.image(x, y, key));
  else {
    const dot = scene.add.graphics();
    dot.fillStyle(0x1a1a1a, 1).fillCircle(x, y, diameter / 2 - 1);
    dot.fillStyle(colour, 1).fillCircle(x, y, diameter / 2 - 4);
    objs.push(dot);
  }
  if (lead) {
    const n = scene.add.graphics();
    const top = y - diameter / 2 - ring;
    n.fillStyle(0x111214, 1).fillTriangle(x - 7, top - 1, x + 7, top - 1, x, top + 7);
    n.fillStyle(colour, 1).fillTriangle(x - 5, top, x + 5, top, x, top + 5);
    objs.push(n);
  }
  return objs;
}
