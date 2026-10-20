// src/ui/PackRows.js
//
// The Pack step's rows (chunk 15f): every hunt item in the camp bag, in its
// group (PackPlan.PACK_GROUPS), with how many are in camp and − count + to
// pack them. One drawing for the solo Hunt screen and the co-op lobby, so
// packing looks and works the same in both.
//
// In co-op a row also says whose its item will be: "for the party" (the
// shared pack, which events draw on) or "yours" (your own pack, for your own
// fights). Solo there is one pack, so it says nothing.

import { PACK_GROUPS, PARTY, packRows, adjust } from '../systems/PackPlan.js';
import { SoundManager } from '../systems/SoundManager.js';

const FONT = 'Georgia, Gelasio, serif';
const ROW_H = 25;

/**
 * Draw the rows into a box. `add(obj)` takes each object drawn (a
 * container's add). `onChange(plan)` gets the new plan after a click.
 * Rows flow down a first column and on into a second. Returns { empty }:
 * true when the bag holds nothing to pack beyond the Ways out.
 */
export function drawPackRows(scene, { add, left, top, width, bottom, bag, plan, onChange, coop = false }) {
  const text = (x, y, s, style) => { const t = scene.add.text(x, y, s, { fontFamily: FONT, ...style }); add(t); return t; };
  const rows = packRows(bag, plan);
  const colW = (width - 20) / 2;
  let col = 0, ty = top;
  const place = (h) => { if (ty + h > bottom && col === 0) { col = 1; ty = top; } return left + col * (colW + 20); };
  for (const g of PACK_GROUPS) {
    const mine = rows.filter(r => r.group === g.id);
    if (!mine.length) continue;
    const gx = place(ROW_H * 2);
    text(gx, ty, g.name, { fontSize: '14px', color: '#ffdd88', fontStyle: 'bold' });
    ty += 22;
    for (const r of mine) {
      row(scene, text, place(ROW_H), ty, colW, r, { coop, onClick: (d) => { SoundManager.play('select'); onChange(adjust(plan, r, d)); } });
      ty += ROW_H;
    }
    ty += 6;
  }
  return { empty: !rows.some(r => r.have > 0) };
}

/** One row: its name (and in co-op whose it is), in camp, − count +. */
function row(scene, text, cx, cy, w, r, { coop, onClick }) {
  const dim = r.have === 0;
  text(cx, cy, r.name, { fontSize: '13px', color: dim ? '#8a8478' : r.packed ? '#f2e6c8' : '#cfcfcf' });
  if (coop) text(cx + w - 230, cy + 1, r.kind === PARTY ? 'for the party' : 'yours', { fontSize: '11px', color: r.kind === PARTY ? '#9fc0e8' : '#b8a888' });
  text(cx + w - 150, cy, r.stack ? `in camp ${r.have}` : '', { fontSize: '11px', color: '#9a9a9a' });
  // Padded, so the click target is bigger than the glyph.
  const less = text(cx + w - 76, cy - 4, '−', { fontSize: '18px', color: r.packed ? '#ffdd88' : '#6a6458', padding: { x: 6, y: 1 } });
  text(cx + w - 44, cy, r.stack ? String(r.packed) : (r.packed ? 'yes' : 'no'), { fontSize: '13px', color: r.packed ? '#9fe09f' : '#9a9a9a' }).setOrigin(0.5, 0);
  const more = text(cx + w - 26, cy - 4, '+', { fontSize: '18px', color: r.packed < r.have ? '#ffdd88' : '#6a6458', padding: { x: 6, y: 1 } });
  less.setInteractive({ useHandCursor: true }).on('pointerdown', () => onClick(-1));
  more.setInteractive({ useHandCursor: true }).on('pointerdown', () => onClick(+1));
}
