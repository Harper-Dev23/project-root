// src/scenes/overlays/LodgeShrineOverlay.js
//
// The lodge shrine (Exploration System v2, chunk 10c; STANDING, DEATH_AND_REVIVAL).
// Opened from the tribe lodge (TribeHQOverlay's Shrine button), which it
// replaces while open and brings back on close.
//
// Left: the four houses this season. For each: your devotion against the
// claim threshold, who holds it, your Bond standing and legacy, and where its
// lands are. A house you are eligible for can be ACCEPTED here, and accepting
// another switches (owner idea A): the rules are Standing.canAccept /
// acceptHouse. Holdings are public (decision 3).
//
// Right: the Slain, each with where they fell and the ways back
// (Revival.revivalOptions): intercession at the lodge, the lesser rite, or the
// days a rite has left.
//
// Every choice that spends something takes two clicks (the button turns to
// "Confirm"), and every accepted action autosaves.

import { createOverlayFrame } from '../../ui/OverlayFrame.js';
import { setupSceneCursor } from '../../ui/cursor.js';
import { createButton } from '../../ui/Button.js';
import { MENU_THEME } from '../../ui/styles.js';
import { SoundManager } from '../../systems/SoundManager.js';
import { TRIBE_DISPLAY } from '../../systems/TribeRelations.js';
import ProgressionManager from '../../systems/ProgressionManager.js';
import GameState from '../../systems/GameState.js';
import * as Standing from '../../systems/Standing.js';
import * as Revival from '../../systems/Revival.js';
import { HOUSES, CLAIM_THRESHOLD, RIVAL_GRACE_DAYS, SEASON_DAYS } from '../../../data/standing.js';
import { ZONES } from '../../../data/zones.js';

const FONT = 'Georgia';
const cap = (h) => (h ? h.charAt(0).toUpperCase() + h.slice(1) : '');
const num = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const HOUSE_ROW_H = 118;
const FALLEN_ROW_H = 92;   // name, where they fell, then the ways back on their own line
const FALLEN_SHOWN = 5;

/** The hunting grounds in a house's lands (a minor's region counts). */
function landsOf(house) {
  return Object.values(ZONES).filter(z => Standing.houseOf(z.divineAlignment) === house).map(z => z.name);
}

export default class LodgeShrineOverlay extends Phaser.Scene {
  constructor() {
    super({ key: 'LodgeShrineOverlay' });
  }

  create() {
    setupSceneCursor(this);
    this._tribe = ProgressionManager.getTribe();
    const frame = createOverlayFrame(this, {
      title: `${TRIBE_DISPLAY[this._tribe] || 'The'} Lodge Shrine`,
      fullscreen: true,
      onClose: () => this._close(),
    });
    this._depth = frame.depth;
    this._b = frame.bounds;
    this._armed = null;   // the key of a button waiting for its second click
    this._msg = '';
    this._layer = null;
    this._render();
  }

  _close() {
    this.scene.stop();
    // Back to the lodge it was opened from.
    this.scene.launch('TribeHQOverlay');
    this.scene.bringToTop('TribeHQOverlay');
  }

  _render() {
    if (this._layer) this._layer.destroy(true);
    this._layer = this.add.container(0, 0).setDepth(this._depth + 1);
    const b = this._b;
    const st = ProgressionManager.getStanding();
    const day = ProgressionManager.getDaysElapsed();
    const followed = Standing.followedHouse(st, this._tribe);

    const seasonDay = day - st.season.startDay + 1;
    const rivals = seasonDay <= RIVAL_GRACE_DAYS ? `rival tribes start courting on day ${RIVAL_GRACE_DAYS + 1}` : 'rival tribes are courting';
    this._text(b.x + 40, b.y + 62, `Season ${st.season.n} · day ${seasonDay} of ${SEASON_DAYS} · ${rivals}`, 14, '#9aa4b4');
    this._text(b.x + 40, b.y + 84, followed ? `Your lodge's interpreters follow ${cap(followed)}.` : 'Your lodge follows no house yet.', 17,
      followed ? '#ffdd88' : '#cccccc', 'bold');

    this._drawHouses(b.x + 40, b.y + 118, st, followed);
    this._drawFallen(b.x + 680, b.y + 118);

    this._text(b.x + 40, b.bottom - 34, this._msg || `Hunt Tickets: ${ProgressionManager.huntTickets}`, 14, this._msg ? '#ffe9a8' : '#9aa4b4');
  }

  // ── The houses ─────────────────────────────────────────────────────────────

  _drawHouses(x, y, st, followed) {
    this._text(x, y, 'The Houses', 16, MENU_THEME.accentHover, 'bold');
    HOUSES.forEach((h, i) => {
      const ry = y + 28 + i * HOUSE_ROW_H;
      const mine = Standing.devotionOf(st, this._tribe, h);
      const holder = Standing.holderOf(st, h);
      const heldBy = holder === this._tribe ? 'your house' : holder ? `held by ${TRIBE_DISPLAY[holder]}` : 'open';
      const g = this.add.graphics();
      this._layer.add(g);
      g.fillStyle(0x000000, holder === this._tribe ? 0.4 : 0.25).fillRect(x, ry, 600, HOUSE_ROW_H - 10);
      g.lineStyle(1, holder === this._tribe ? 0xffdd88 : 0x444444, 0.8).strokeRect(x, ry, 600, HOUSE_ROW_H - 10);

      this._text(x + 12, ry + 8, `${cap(h)} — ${heldBy}`, 17, holder === this._tribe ? '#ffdd88' : '#eeeeee', 'bold');
      // Devotion against the claim threshold.
      const pct = Math.max(0, Math.min(1, mine / CLAIM_THRESHOLD));
      g.fillStyle(0x30343d, 1).fillRect(x + 12, ry + 36, 260, 10);
      g.fillStyle(0xe8c66a, 1).fillRect(x + 12, ry + 36, 260 * pct, 10);
      const theirs = holder && holder !== this._tribe ? ` · ${TRIBE_DISPLAY[holder]} ${num(Standing.devotionOf(st, holder, h))}` : '';
      this._text(x + 282, ry + 32, `Devotion ${num(mine)} / ${CLAIM_THRESHOLD}${theirs}`, 13, '#dddddd');
      this._text(x + 12, ry + 54, `Bond standing ${num(st.bond[h] || 0)} · Legacy ${num(st.legacy[h] || 0)}`, 13, '#a8b0bc');
      const lands = landsOf(h);
      this._text(x + 12, ry + 74, lands.length ? `Its lands: ${lands.join(', ')}` : 'No hunting grounds in its lands yet.', 12, '#8d96a4');

      const can = Standing.canAccept(st, this._tribe, h);
      if (can.ok) {
        const key = `accept:${h}`;
        const label = this._armed === key ? 'Confirm' : (followed ? `Switch to ${cap(h)}` : `Accept ${cap(h)}`);
        this._button(x + 520, ry + 30, label, () => this._arm(key, () => this._accept(h)), this._armed === key ? 'danger' : 'primary');
      } else if (can.reason === 'not enough devotion') {
        this._text(x + 588, ry + 72, `${num(can.need)} more devotion to claim`, 12, '#8d96a4', 'normal', 1);
      } else if (can.reason === 'held') {
        this._text(x + 588, ry + 72, `Lead ${TRIBE_DISPLAY[can.holder]} by ${num(can.need)} more to take it`, 12, '#8d96a4', 'normal', 1);
      }
    });
  }

  _accept(house) {
    const r = Standing.acceptHouse(ProgressionManager.getStanding(), this._tribe, house);
    if (!r.ok) { this._msg = `Cannot: ${r.reason}.`; SoundManager.play('handsClick'); return; }
    SoundManager.play('reward');
    this._msg = r.released
      ? `Your interpreters turn from ${cap(r.released)} to ${cap(house)}.`
      : `Your lodge now follows ${cap(house)}${r.took ? `, taken from ${TRIBE_DISPLAY[r.took]}` : ''}.`;
    GameState.save('autosave');
  }

  // ── The fallen ─────────────────────────────────────────────────────────────

  _drawFallen(x, y) {
    this._text(x, y, 'The Fallen', 16, MENU_THEME.accentHover, 'bold');
    const slain = GameState.slain || [];
    if (!slain.length) { this._text(x, y + 30, 'No hunter lies among the Slain.', 14, '#888888'); return; }
    slain.slice(0, FALLEN_SHOWN).forEach((c, i) => {
      const ry = y + 28 + i * FALLEN_ROW_H;
      const o = Revival.revivalOptions(c);
      const g = this.add.graphics();
      this._layer.add(g);
      g.fillStyle(0x000000, 0.25).fillRect(x, ry, 520, FALLEN_ROW_H - 8);
      g.lineStyle(1, 0x444444, 0.8).strokeRect(x, ry, 520, FALLEN_ROW_H - 8);
      this._text(x + 10, ry + 6, `${c.name}  (Lv ${c.level} ${c.baseClass || ''})`, 15, '#eeeeee', 'bold');
      this._text(x + 10, ry + 28, this._whereFell(c.fell), 12, '#a8b0bc');

      const bx = x + 510;
      if (o.rite.active) {
        this._text(bx, ry + 56, `The rite: ${o.rite.active.daysLeft} day${o.rite.active.daysLeft === 1 ? '' : 's'} left`, 13, '#e8c66a', 'normal', 1);
        return;
      }
      // A Forsaken death (11c-2): only the region's false god can give them
      // back, at a price; or they are let go, for good.
      if (o.falseGod.lost) {
        this._text(bx, ry + 56, 'Let go. They are lost for good.', 12, '#c07070', 'normal', 1);
        return;
      }
      if (o.falseGod.open) {
        const key = `god:${c.id}`, goKey = `letgo:${c.id}`;
        const price = `${o.falseGod.name}'s price${o.falseGod.bond ? `: -${o.falseGod.bond} standing` : ''}`;
        const b1 = this._button(0, ry + 64, this._armed === key ? 'Confirm' : price, () => this._arm(key, () => this._acceptGod(c)), this._armed === key ? 'danger' : 'primary', 12);
        b1.x = bx - b1.width / 2;
        const b2 = this._button(0, ry + 64, this._armed === goKey ? 'Confirm' : 'Let go', () => this._arm(goKey, () => this._letGo(c)), 'danger', 12);
        b2.x = bx - b1.width - 8 - b2.width / 2;
        return;
      }
      if (!o.intercession.open && !o.rite.open) {
        this._text(bx, ry + 56, 'No way back is open to them.', 12, '#c07070', 'normal', 1);
        return;
      }
      let right = bx;
      if (o.rite.open) {
        const key = `rite:${c.id}`;
        const label = this._armed === key ? 'Confirm' : `Rite: ${o.rite.days} days, ${o.rite.tickets} tickets`;
        const btn = this._button(0, ry + 64, label, () => o.rite.canPay ? this._arm(key, () => this._rite(c)) : this._say(`The rite needs ${o.rite.tickets} Hunt Tickets.`),
          this._armed === key ? 'danger' : 'primary', 12);
        btn.x = right - btn.width / 2; right -= btn.width + 8;
      }
      if (o.intercession.open) {
        const key = `intercede:${c.id}`;
        const label = this._armed === key ? 'Confirm' : `Intercede: ${o.intercession.cost} standing`;
        const btn = this._button(0, ry + 64, label, () => o.intercession.canPay ? this._arm(key, () => this._intercede(c))
          : this._say(`${cap(o.intercession.house)} needs ${o.intercession.cost} Bond standing; you have ${num(o.intercession.have)}.`),
        this._armed === key ? 'danger' : 'primary', 12);
        btn.x = right - btn.width / 2;
      }
    });
    if (slain.length > FALLEN_SHOWN) this._text(x, y + 28 + FALLEN_SHOWN * FALLEN_ROW_H, `…and ${slain.length - FALLEN_SHOWN} more.`, 13, '#888888');
  }

  _whereFell(f) {
    if (!f || f.legacy) return 'Fell before the lodge kept records: a Watched death.';
    const zone = ZONES[f.zoneId]?.name || 'an unknown region';
    const rule = f.rule === 'forsaken' ? 'Forsaken' : f.rule === 'watched' ? 'Watched' : f.rule;
    return `Fell in ${zone}${f.house ? ` (${cap(f.house)}'s lands)` : ''}, day ${(f.day ?? 0) + 1} · ${rule}`;
  }

  _intercede(c) {
    const r = Revival.intercede(c);
    if (!r.ok) { this._msg = `Cannot: ${r.reason}.`; SoundManager.play('handsClick'); return; }
    SoundManager.play('reward');
    this._msg = `${cap(r.house)} speaks for ${c.name}, who returns to camp (-${r.cost} standing).`;
    GameState.save('autosave');
  }

  _acceptGod(c) {
    const r = Revival.acceptFalseGod(c);
    if (!r.ok) { this._msg = `Cannot: ${r.reason}.`; SoundManager.play('handsClick'); return; }
    SoundManager.play('reward');
    this._msg = `${r.name} gives ${c.name} back. It will remember${r.bond ? `, and ${cap(r.house)} knows (-${r.bond} standing)` : ''}.`;
    GameState.save('autosave');
  }

  _letGo(c) {
    const r = Revival.letGo(c);
    if (!r.ok) { this._msg = `Cannot: ${r.reason}.`; SoundManager.play('handsClick'); return; }
    SoundManager.play('handsClick');
    this._msg = `You let ${c.name} go. The lodge keeps their name.`;
    GameState.save('autosave');
  }

  _rite(c) {
    const r = Revival.beginRite(c);
    if (!r.ok) { this._msg = `Cannot: ${r.reason}.`; SoundManager.play('handsClick'); return; }
    SoundManager.play('select');
    this._msg = `The rite for ${c.name} begins: ${r.days} days (-${r.tickets} Hunt Tickets). The days pass while you hunt.`;
    GameState.save('autosave');
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** First click arms a button; the second runs it. Any other click disarms. */
  _arm(key, run) {
    if (this._armed === key) { this._armed = null; run(); }
    else { this._armed = key; this._msg = ''; SoundManager.play('select'); }
    this._render();
  }

  _say(text) {
    this._armed = null;
    this._msg = text;
    SoundManager.play('handsClick');
    this._render();
  }

  _text(x, y, s, size, color, style = 'normal', originX = 0) {
    const t = this.add.text(x, y, s, { fontFamily: FONT, fontSize: `${size}px`, color, fontStyle: style }).setOrigin(originX, 0);
    this._layer.add(t);
    return t;
  }

  _button(cx, cy, label, cb, style = 'primary', size = 14) {
    const btn = createButton(this, cx, cy, label, cb, style, { fontSize: `${size}px` });
    this._layer.add(btn);
    return btn;
  }
}

