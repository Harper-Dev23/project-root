// src/scenes/overlays/HuntFieldOverlay.js
//
// The hunt on the hex map (Exploration System v2, chunk 8b). Draws a map hunt
// (HuntEngine.js) in the town's inner window and lets the player act on it.
// Design: the vault's GRID_FUNDAMENTALS (64 px pointy-top hexes, one section
// on screen, no pan, no zoom), MOVEMENT_VISION_FOG (fog, the 60 px HUD strip,
// the dialogue bar only when needed), ENGINE_HAZARDS.
//
// ── The one rule ────────────────────────────────────────────────────────────
// This scene READS hunt.view() and ACTS only through the engine's methods
// (move, scout, forage, fish, eat, camp, cleanse, flee, exit, fightSpec).
// It never reads getState() and never decides a rule: every cost, refusal and
// outcome comes back from the engine, and a refusal's `reason` is shown as is.
// view() holds nothing the party has not seen (the harness checks it), so the
// scene cannot leak a hidden pack.
//
// ── Layout (1280 x 720 canvas) ──────────────────────────────────────────────
//   window   x 179-1101, y 14-706: the gap between UIScene's two sidebars
//   HUD      the top 60 px of it
//   map      the 922 x 632 below; a 13 x 11 section of 64 px hexes is
//            864 x 628, so it fits with 3.8 px to spare and has no frame
// Hexes are Graphics polygons tinted by ground (data/grounds.js `tint`); fog is
// one dark hex per tile. No masks anywhere: a Rectangle mask draws nothing in
// the Canvas renderer (ENGINE_HAZARDS #2).
//
// ── Scene reuse (ENGINE_HAZARDS #1) ─────────────────────────────────────────
// Every field is set in init(). Everything drawn is rebuilt from view() on
// each refresh, so nothing from a previous visit can survive. The map's hit
// zone listeners and the dialogue timer are removed on shutdown.
//
// ── How it is opened (chunk 8c) ─────────────────────────────────────────────
// launchMapHunt() opens it on HuntManager's hunt: after Depart on the Hunt
// screen, and whenever the town finds a map hunt in the save. It passes two
// hooks, so this scene never touches the save itself:
//   onAction    after every action the engine accepted: autosave
//               (SAVE_COMPATIBILITY rec. 1, "autosave after every move")
//   onFinished  after exit or wipe: HuntManager drops the hunt, then autosave
// window.bmDevMapHunt() (installDevHook) still opens it on a hunt kept in
// memory, in a sandbox world with no hooks: nothing it does is saved.
// An encounter's Fight button starts a real fight (chunk 9b, _fight): the
// TEST "Win" button of chunk 8 is gone (owner decision 7). A fight in a
// sandboxed dev hunt still uses the REAL party (CombatScene fights
// GameState.party), so its XP and HP are real; only the hunt is sandboxed.

import { wakeTown } from '../../ui/townInput.js';
import { setupSceneCursor } from '../../ui/cursor.js';
import { createButton } from '../../ui/Button.js';
import { SoundManager } from '../../systems/SoundManager.js';
import { parseTileId, toOffset } from '../../systems/HexGrid.js';
import { GROUNDS } from '../../../data/grounds.js';
import { HUNT_BEASTS, PART_SLOTS } from '../../../data/beastParts.js';
import { Items } from '../../../data/items.js';
import { getZone } from '../../../data/zones.js';
import { PRIMARY_OBJECTIVES, MAP_SIZES } from '../../../data/huntMapGen.js';
import { BONUS_OBJECTIVES } from '../../../data/planAffixes.js';
import { CAMP_TIME, CAMP_SUPPLY, FORAGE_TIME, FISH_TIME, SCOUT_TIME } from '../../systems/HuntRules.js';
import { CLEANSE_TIME } from '../../systems/HuntWorld.js';
import { HuntManager } from '../../systems/HuntManager.js';
import GameState from '../../systems/GameState.js';
import { levelDef as boonLevelDef } from '../../systems/Boons.js';

// The boon level each hunt has already announced (chunk 10b), kept per hunt
// instance so a level earned in a fight is announced when the map reopens,
// and a reload (a new instance) never re-announces an old one.
const _boonAnnounced = new WeakMap();
const houseName = (h) => (h ? h.charAt(0).toUpperCase() + h.slice(1) : '');

// ── Geometry ─────────────────────────────────────────────────────────────────
export const FIELD_WINDOW = { x: 179, y: 14, w: 922, h: 692 };
export const HUD_HEIGHT = 60;
const MAP = { x: FIELD_WINDOW.x, y: FIELD_WINDOW.y + HUD_HEIGHT, w: FIELD_WINDOW.w, h: FIELD_WINDOW.h - HUD_HEIGHT };
export const HEX_W = 64;                       // fixed, GRID_FUNDAMENTALS
const R = HEX_W / Math.sqrt(3);                // corner radius, 36.95
const ROW = 1.5 * R;                           // row step, 55.43

// ── Look ─────────────────────────────────────────────────────────────────────
const FONT = 'Georgia, Gelasio, serif';
const BG = 0x121418;
const FOG_FILL = 0x23252d, FOG_LINE = 0x33363f;
const REMEMBERED_DIM = 0.5;                    // remembered tiles: ground at half brightness
const HUNGER_COLOR = { sated: '#9fe09f', fed: '#e0e0e0', hungry: '#f0c060', starving: '#ff6b6b' };
const GRADE_COLOR = { yearling: 0x9aa7b0, grown: 0xc9a25a, prime: 0xe07b39, great: 0xd8403a };
const MARK_RING = { marked: 0xf2d27a, corrupted: 0xa45bd6, unmarked: 0x2a2a2a };
const DIALOGUE_MS = 3200;
/** UIScene's dialogue bar covers y 570-720 and draws above this scene, so no
 *  panel may reach below this line (the sweep's screenshots caught a camp
 *  panel's buttons under the bar). */
const PANEL_BOTTOM = 564;
const LOG_SHOWN = 14;

const OBJECTIVE_NAME = (id) => PRIMARY_OBJECTIVES[id]?.name || BONUS_OBJECTIVES[id]?.name || id;

function darken(color, f) {
  const r = ((color >> 16) & 255) * f, g = ((color >> 8) & 255) * f, b = (color & 255) * f;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
}

function fmt(n) {
  return (Math.round(n * 10) / 10).toString();
}

function familyName(zoneId, family) {
  const z = getZone(zoneId);
  return z?.natives?.[family]?.name
    || (z?.apex?.family === family ? (z.apex.name || null) : null)
    || String(family || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export default class HuntFieldOverlay extends Phaser.Scene {
  constructor() {
    super({ key: 'HuntFieldOverlay' });
  }

  init(data) {
    this.hunt = data?.hunt || null;
    this.onDone = typeof data?.onDone === 'function' ? data.onDone : null;
    this.onAction = typeof data?.onAction === 'function' ? data.onAction : null;
    this.onFinished = typeof data?.onFinished === 'function' ? data.onFinished : null;
    this.v = null;              // the last view()
    this.selected = null;       // selected tile id
    this.panel = null;          // 'eat' | 'camp' | 'log' | null
    this.meals = [];            // camp meal queue: [{ main, addition }]
    // The harvest panel (chunk 9d): which part groups (by slot) the player has
    // turned OFF, whether meat is off, whether commons are shown. Reset with
    // every launch; a fight relaunches the scene, so each spoils starts fresh.
    this.harvestSkip = new Set();
    this.harvestNoMeat = false;
    this.harvestCommons = false;
    this.origin = { x: 0, y: 0 };
    this.layer = null;          // everything drawn from view(), rebuilt per refresh
    this.hoverGfx = null;
    this._dialogueTimer = null;
    this._onPointerMove = null;
    this._onPointerDown = null;
    this.mapZone = null;
  }

  create() {
    setupSceneCursor(this);
    const town = this.scene.get('TownScene');
    if (town?.input) town.input.enabled = false;

    // Opaque ground over the town window only: the sidebars stay live.
    this.add.rectangle(FIELD_WINDOW.x, FIELD_WINDOW.y, FIELD_WINDOW.w, FIELD_WINDOW.h, BG).setOrigin(0).setDepth(0);
    this.hoverGfx = this.add.graphics().setDepth(5);

    // The map CAPTURES its clicks with a real hit zone over the whole window.
    // A scene-level listener alone leaves a click "uncaptured", and Phaser
    // then hands it to the scene below: TownScene's buildings (the Bonfire
    // opens character creation). Several overlays that can be opened from the
    // sidebar mid-hunt (Inventory, Journal, ...) set TownScene's input back on
    // when they close, so "town input is off" cannot be relied on. Panels and
    // buttons sit above this zone and take their own clicks first.
    this.mapZone = this.add.zone(FIELD_WINDOW.x, FIELD_WINDOW.y, FIELD_WINDOW.w, FIELD_WINDOW.h)
      .setOrigin(0).setDepth(0).setInteractive();
    this._onPointerMove = (p) => this._hover(p);
    this._onPointerDown = (p) => this._clickMap(p);
    this.mapZone.on('pointermove', this._onPointerMove);
    this.mapZone.on('pointerdown', this._onPointerDown);
    this.mapZone.on('pointerout', () => this.hoverGfx?.clear());

    this.events.once('shutdown', () => {
      this.mapZone?.off('pointermove', this._onPointerMove);
      this.mapZone?.off('pointerdown', this._onPointerDown);
      if (this._dialogueTimer) this._dialogueTimer.remove(false);
      this._uiScene()?.resetBottomBar?.();
      wakeTown(this);
    });

    if (!this.hunt) {
      this.add.text(640, 360, 'No hunt to show.', { fontFamily: FONT, fontSize: '22px', color: '#e0e0e0' }).setOrigin(0.5);
      return;
    }
    this.selected = this.hunt.view().pos;
    this._refresh();
  }

  /** Keep the town asleep under the map: an overlay closing over the hunt
   *  (Inventory, Journal, ...) turns TownScene's input back on, and its
   *  keyboard and hover would then run under the map. */
  update() {
    const town = this.scene.get('TownScene');
    if (town?.input?.enabled) town.input.enabled = false;
  }

  // ── Drawing ────────────────────────────────────────────────────────────────

  _refresh() {
    this._panelRect = null;
    this.v = this.hunt.view();
    const v = this.v;
    if (this.selected && !v.layout.includes(this.selected)) this.selected = v.pos;
    if (this.layer) this.layer.destroy(true);
    this.layer = this.add.container(0, 0).setDepth(1);
    this.hoverGfx.clear();
    this._layoutOrigin();
    this._drawTiles();
    this._drawMarkers();
    this._drawHUD();
    this._announceBoon();
    if (v.finished) this._drawFinished();
    else if (v.encounter) this._drawEncounter();
    else if (v.event) this._drawEvent();
    else if (v.spoils) this._drawHarvest();
    else if (this.panel === 'eat') this._drawEat();
    else if (this.panel === 'camp') this._drawCamp();
    else if (this.selected) this._drawInspect(this.selected);
    if (this.panel === 'log') this._drawLog();
  }

  /** Centre the current section's shape in the map area. */
  _layoutOrigin() {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const id of this.v.layout) {
      const { x, y } = this._local(id);
      minX = Math.min(minX, x - HEX_W / 2); maxX = Math.max(maxX, x + HEX_W / 2);
      minY = Math.min(minY, y - R); maxY = Math.max(maxY, y + R);
    }
    this.origin = {
      x: Math.round(MAP.x + (MAP.w - (maxX - minX)) / 2 - minX),
      y: Math.round(MAP.y + (MAP.h - (maxY - minY)) / 2 - minY),
    };
  }

  /** A tile's centre relative to its section's box (odd-r offset). */
  _local(id) {
    const { q, r } = parseTileId(id);
    const { col, row } = toOffset(q, r);
    return { x: col * HEX_W + (row & 1) * HEX_W / 2 + HEX_W / 2, y: row * ROW + R };
  }

  center(id) {
    const l = this._local(id);
    return { x: this.origin.x + l.x, y: this.origin.y + l.y };
  }

  _corners(cx, cy, rad = R) {
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 180 * (60 * i - 30);
      pts.push({ x: cx + rad * Math.cos(a), y: cy + rad * Math.sin(a) });
    }
    return pts;
  }

  /** The tile under a screen point in the current section, or null. */
  tileAt(px, py) {
    // Inverse of _local: pixel = (W(q + r/2), ROW r) from axial (0,0)'s centre.
    const x = px - this.origin.x - HEX_W / 2, y = py - this.origin.y - R;
    const fr = y / ROW, fq = x / HEX_W - fr / 2;
    // Cube rounding: round all three, then fix the one that moved most.
    let rq = Math.round(fq), rr = Math.round(fr);
    const rs = Math.round(-fq - fr);
    const dq = Math.abs(rq - fq), dr = Math.abs(rr - fr), ds = Math.abs(rs + fq + fr);
    if (dq > dr && dq > ds) rq = -rr - rs; else if (dr > ds) rr = -rq - rs;
    const id = `${this.v.section}:${rq},${rr}`;
    return this.v.layout.includes(id) ? id : null;
  }

  _drawTiles() {
    const v = this.v;
    const g = this.add.graphics();
    this.layer.add(g);
    const moveTo = new Set(v.moves.map(m => m.tile));
    for (const id of v.layout) {
      const { x, y } = this.center(id);
      const pts = this._corners(x, y, R - 1);
      const t = v.tiles[id];
      if (!t) {
        g.fillStyle(FOG_FILL, 1).fillPoints(pts, true);
        g.lineStyle(1, FOG_LINE, 1).strokePoints(pts, true);
        continue;
      }
      const tint = GROUNDS[t.ground]?.tint ?? 0x777777;
      const visible = v.fog[id] === 'visible';
      g.fillStyle(visible ? tint : darken(tint, REMEMBERED_DIM), 1).fillPoints(pts, true);
      g.lineStyle(1, visible ? darken(tint, 0.7) : 0x1c1c1c, 1).strokePoints(pts, true);
      if (t.ford) {
        g.lineStyle(2, 0xd8d0b0, visible ? 0.8 : 0.4);
        for (const dy of [-8, 0, 8]) g.lineBetween(x - 18, y + dy, x + 18, y + dy);
      }
      if (t.relief === 'hills' || t.relief === 'highland') {
        g.lineStyle(2, 0x2b2118, visible ? 0.7 : 0.35);
        const peaks = t.relief === 'highland' ? [-14, 0, 14] : [-8, 8];
        for (const dx of peaks) { g.lineBetween(x + dx - 6, y + 20, x + dx, y + 12); g.lineBetween(x + dx, y + 12, x + dx + 6, y + 20); }
      }
      if (t.gathered) {
        g.fillStyle(0x000000, 0.25).fillPoints(this._corners(x, y, R * 0.35), true);
      }
      if (moveTo.has(id) && !v.encounter && !v.finished) {
        g.lineStyle(2, 0xffffff, 0.55).strokePoints(this._corners(x, y, R - 3), true);
      }
    }
    if (this.selected && v.layout.includes(this.selected)) {
      const { x, y } = this.center(this.selected);
      g.lineStyle(3, 0xffe28a, 1).strokePoints(this._corners(x, y, R - 2), true);
    }
  }

  _label(x, y, text, size = 12, color = '#ffffff', stroke = true) {
    const t = this.add.text(x, y, text, {
      fontFamily: FONT, fontSize: `${size}px`, color,
      ...(stroke ? { stroke: '#000000', strokeThickness: 3 } : {}),
    }).setOrigin(0.5);
    this.layer.add(t);
    return t;
  }

  _drawMarkers() {
    const v = this.v;
    const g = this.add.graphics();
    this.layer.add(g);
    const here = (id) => v.layout.includes(id);

    // Exits and features, as seen.
    for (const [id, t] of Object.entries(v.tiles)) {
      if (!t.exit || !here(id)) continue;
      const { x, y } = this.center(id);
      g.fillStyle(0x2e7d4f, 0.95).fillRoundedRect(x - 17, y - 29, 34, 13, 3);
      this._label(x, y - 23, 'EXIT', 10, '#eaffea', false);
    }
    for (const f of v.features) {
      if (!here(f.tile)) continue;
      const { x, y } = this.center(f.tile);
      if (f.kind === 'waystone') {
        g.fillStyle(0x6fa8dc, 1).fillRect(x + 14, y - 20, 7, 16);
        g.lineStyle(1, 0x0b2239, 1).strokeRect(x + 14, y - 20, 7, 16);
      } else if (f.kind === 'blight_source') {
        g.fillStyle(f.destroyed ? 0x3a3a3a : 0x7a2d8f, 1).fillCircle(x - 18, y - 14, 7);
        g.lineStyle(2, 0x1a0a20, 1).lineBetween(x - 22, y - 18, x - 14, y - 10).lineBetween(x - 14, y - 18, x - 22, y - 10);
      }
    }

    // Objective sites, marked from departure (the plan is a chart).
    for (const s of v.objectiveSites) {
      if (!here(s.tile)) continue;
      const { x, y } = this.center(s.tile);
      const col = s.done ? 0x7c7c7c : 0xf2d27a;
      g.lineStyle(3, col, 1);
      if (s.objective === 'scout') g.strokeCircle(x, y, 22);
      else if (s.objective === 'retrieve') g.strokePoints([{ x, y: y - 22 }, { x: x + 20, y }, { x, y: y + 22 }, { x: x - 20, y }], true);
      else g.strokeTriangle(x, y - 22, x + 20, y + 14, x - 20, y + 14);
    }

    // Trails in sight.
    for (const tr of v.trails) {
      if (!here(tr.tile)) continue;
      const a = this.center(tr.tile);
      if (tr.band === 'sensed' || !tr.toward || !here(tr.toward)) {
        g.fillStyle(0x3b2a1a, 0.8);
        for (const d of [-8, 0, 8]) g.fillCircle(a.x + d, a.y + 24, 2.5);
        continue;
      }
      const b = this.center(tr.toward);
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      g.lineStyle(3, 0x3b2a1a, 0.9).lineBetween(a.x - ux * 16, a.y - uy * 16, a.x + ux * 18, a.y + uy * 18);
      g.fillStyle(0x3b2a1a, 0.9).fillTriangle(
        a.x + ux * 26, a.y + uy * 26,
        a.x + ux * 14 - uy * 7, a.y + uy * 14 + ux * 7,
        a.x + ux * 14 + uy * 7, a.y + uy * 14 - ux * 7);
    }

    // Occupants the party knows of.
    for (const o of v.occupants) {
      if (!here(o.tile)) continue;
      const { x, y } = this.center(o.tile);
      const alpha = o.stale ? 0.45 : 1;
      if (o.band === 'sensed') {
        g.fillStyle(0x444444, 0.85 * alpha).fillCircle(x, y, 13);
        this._label(x, y, '?', 18, '#ffffff').setAlpha(alpha);
        continue;
      }
      if (o.kind === 'event') {
        g.fillStyle(0xe8d9a8, alpha).fillCircle(x, y, 11);
        this._label(x, y, '!', 16, '#3a2a10', false).setAlpha(alpha);
        continue;
      }
      const fill = o.kind === 'cultist' ? 0x4b2d5e : (GRADE_COLOR[o.topGrade] ?? 0xaaaaaa);
      g.fillStyle(fill, alpha).fillCircle(x, y, 14);
      g.lineStyle(3, MARK_RING[o.mark] ?? 0x2a2a2a, alpha).strokeCircle(x, y, 14);
      const n = o.exact ? String(o.count) : ({ one: '1', 'a few': '2-3', several: '4-6', many: '7+' }[o.size] || '?');
      this._label(x, y, n, n.length > 1 ? 11 : 14, '#ffffff').setAlpha(alpha);
    }

    // Passage arrows: a move that leads into another section.
    for (const m of v.moves) {
      if (here(m.tile)) continue;
      const p = v.passages.find(pp => pp.to === m.tile);
      if (!p || !here(p.tile)) continue;
      const { x, y } = this.center(p.tile);
      g.fillStyle(0xffe28a, 1).fillTriangle(x + 18, y - 10, x + 30, y, x + 18, y + 10);
    }
    for (const p of v.passages) {
      if (!here(p.tile) || v.moves.some(m => m.tile === p.to)) continue;
      const { x, y } = this.center(p.tile);
      g.fillStyle(0xbfae72, 0.6).fillTriangle(x + 18, y - 8, x + 28, y, x + 18, y + 8);
    }

    // The party.
    const me = this.center(v.pos);
    g.fillStyle(0xf5f1e6, 1).fillCircle(me.x, me.y + (v.occupants.some(o => o.tile === v.pos) ? 18 : 0), 11);
    g.lineStyle(3, 0x1a1a1a, 1).strokeCircle(me.x, me.y + (v.occupants.some(o => o.tile === v.pos) ? 18 : 0), 11);
  }

  // ── HUD strip ──────────────────────────────────────────────────────────────

  _drawHUD() {
    const v = this.v;
    const { x, y, w } = FIELD_WINDOW;
    const g = this.add.graphics();
    this.layer.add(g);
    g.fillStyle(0x1b1e24, 1).fillRect(x, y, w, HUD_HEIGHT);
    g.lineStyle(1, 0x3a3f4a, 1).lineBetween(x, y + HUD_HEIGHT - 0.5, x + w, y + HUD_HEIGHT - 0.5);
    const txt = (tx, ty, s, size = 14, color = '#e0e0e0', origin = 0) => {
      const t = this.add.text(tx, ty, s, { fontFamily: FONT, fontSize: `${size}px`, color }).setOrigin(origin, 0);
      this.layer.add(t);
      return t;
    };

    // Where and what.
    const zone = getZone(v.zoneId);
    const sizeName = MAP_SIZES[v.plan.size]?.name || v.plan.size;
    txt(x + 12, y + 5, `${zone?.name || v.zoneId}`, 15, '#f2e6c8');
    const sec = v.sections > 1 ? ` · Section ${v.section + 1} of ${v.sections}` : '';
    txt(x + 12, y + 25, `${sizeName} · ${v.weather?.name || ''}${sec}`, 12, '#a8b0bc');

    // The prophet boon (chunk 10b): level and favor; hover for what it gives.
    const b = v.boon;
    if (b?.house && b.written) {
      const next = b.toNext === null ? (b.level >= 5 ? 'max' : 'max here') : `${fmt(b.favor)} favor, ${fmt(b.toNext)} to next`;
      const bt = txt(x + 12, y + 41, `✦ ${houseName(b.house)} ${b.level ? `boon ${b.level}` : 'watches'} · ${next}`, 11, '#e8c66a');
      bt.setInteractive({ useHandCursor: true });
      let tip = null;
      bt.on('pointerover', () => {
        const lines = [`${houseName(b.house)}, ${b.title}${b.followed ? ' (your house)' : ''}`,
          ...b.names.map((n, i) => `${i + 1}. ${n}: ${boonLevelDef(b.house, i + 1)?.text || ''}`)];
        if (!b.level) lines.push('Kill marked beasts, or reach the shrine, to earn favor.');
        if (!b.followed) lines.push('Level 5 only in the lands of the house your tribe follows.');
        tip = this._box(x + 2, y + HUD_HEIGHT + 4, 420, lines, 20);
      });
      bt.on('pointerout', () => { tip?.destroy(true); tip = null; });
    }

    // Supplies and hunger.
    const sx = x + 270;
    txt(sx, y + 7, `Supplies ${fmt(v.supplies)} / ${fmt(v.maxSupplies)}`, 14);
    const pct = v.maxSupplies > 0 ? Math.max(0, Math.min(1, v.supplies / v.maxSupplies)) : 0;
    g.fillStyle(0x30343d, 1).fillRect(sx, y + 30, 150, 8);
    g.fillStyle(v.supplies > 0 ? 0x8fbf5a : 0xa83c3c, 1).fillRect(sx, y + 30, 150 * pct, 8);
    const hunger = v.hunger.charAt(0).toUpperCase() + v.hunger.slice(1);
    const buff = v.foodBuff ? ` · ${Items[v.foodBuff.source]?.name || 'meal'} buff` : '';
    txt(sx, y + 41, `${hunger}${buff}`, 12, HUNGER_COLOR[v.hunger] || '#e0e0e0');

    // Clock.
    const cx = x + 460;
    const phaseLeft = 6 - (v.clock.time % 6);
    txt(cx, y + 7, `Day ${v.clock.day} · ${v.clock.isNight ? 'Night' : 'Day'}`, 15, v.clock.isNight ? '#a9b8ff' : '#ffe9a8');
    txt(cx, y + 32, `${fmt(phaseLeft)} until ${v.clock.isNight ? 'dawn' : 'dusk'}`, 12, '#a8b0bc');

    // Objectives.
    const ox = x + 620;
    const prim = v.objectives.find(o => o.kind === 'primary');
    const bonus = v.objectives.filter(o => o.kind === 'bonus');
    if (prim) txt(ox, y + 7, `${OBJECTIVE_NAME(prim.id)} ${prim.have}/${prim.need}${prim.done ? ' ✓' : ''}`, 15, prim.done ? '#9fe09f' : '#f2e6c8');
    if (bonus.length) {
      const done = bonus.filter(b => b.done).length;
      const t = txt(ox, y + 32, `Bonus ${done}/${bonus.length} (hover)`, 12, '#a8b0bc');
      t.setInteractive({ useHandCursor: true });
      let tip = null;
      t.on('pointerover', () => {
        const lines = bonus.map(b => `${OBJECTIVE_NAME(b.id)}: ${b.pending ? 'waits for ' + b.pending : `${b.have}/${b.need}${b.done ? ' ✓' : ''}`}`);
        tip = this._box(ox - 10, y + HUD_HEIGHT + 4, 300, lines, 20);
      });
      t.on('pointerout', () => { tip?.destroy(true); tip = null; });
    }

    // Log toggle, and the party sheet one click away (PARTY_STATS, Part A:
    // the HUD carries only what changes route decisions; the full sheet is
    // PartyManagementScene, chunk 8d).
    const logBtn = createButton(this, x + w - 48, y + HUD_HEIGHT / 2, 'Log', () => {
      this.panel = this.panel === 'log' ? null : 'log';
      this._refresh();
    }, 'primary', { fontSize: '14px' });
    this.layer.add(logBtn);
    const partyBtn = createButton(this, x + w - 132, y + HUD_HEIGHT / 2, 'Party', () => {
      SoundManager.play('select');
      this.scene.launch('PartyManagementScene');
      this.scene.bringToTop('PartyManagementScene');
    }, 'primary', { fontSize: '14px' });
    this.layer.add(partyBtn);
  }

  /** A small text panel; returns its container. */
  _box(bx, by, width, lines, depth = 10, title = null, { opaque = false, block = false } = {}) {
    // Text first, so the box is sized from what the lines really take: a long
    // line wraps, and a fixed line height let wrapped lines overprint.
    const c = this.add.container(0, 0).setDepth(depth);
    const g = this.add.graphics();
    c.add(g);
    let ty = by + 8;
    if (title) {
      c.add(this.add.text(bx + 10, ty, title, { fontFamily: FONT, fontSize: '16px', color: '#f2e6c8' }));
      ty += 24;
    }
    for (const l of lines) {
      const t = this.add.text(bx + 10, ty, l, { fontFamily: FONT, fontSize: '13px', color: '#d8d8d8', wordWrap: { width: width - 20 } });
      c.add(t);
      ty += Math.max(18, t.height + 2);
    }
    const h = ty - by + 8;
    g.fillStyle(0x15171c, opaque ? 1 : 0.96).fillRoundedRect(bx, by, width, h, 6);
    g.lineStyle(1, 0x5a6070, 1).strokeRoundedRect(bx, by, width, h, 6);
    if (block) c.addAt(this.add.zone(bx, by, width, h).setOrigin(0).setInteractive(), 1);
    return c;
  }


  // ── Panels ─────────────────────────────────────────────────────────────────

  /**
   * A panel in the map corner farthest from the party and from `tileId`, so
   * it never sits on the hexes the player wants to click next (the party's
   * neighbours: the click sweep caught a panel beside the party covering
   * them). With no tile, centred.
   */
  _sidePanel(tileId, width, height) {
    let px, py;
    if (!tileId) {
      px = FIELD_WINDOW.x + (FIELD_WINDOW.w - width) / 2;
      py = MAP.y + (PANEL_BOTTOM - MAP.y - height) / 2;
    } else {
      const anchors = [this.center(this.v.pos), this.center(tileId)];
      const gap = 6;
      const corners = [
        [FIELD_WINDOW.x + gap, MAP.y + gap], [FIELD_WINDOW.x + FIELD_WINDOW.w - width - gap, MAP.y + gap],
        [FIELD_WINDOW.x + gap, PANEL_BOTTOM - height],
        [FIELD_WINDOW.x + FIELD_WINDOW.w - width - gap, PANEL_BOTTOM - height],
      ];
      // distance from a point to the panel's rectangle (0 inside it)
      const dist = ([x, y], a) => Math.hypot(Math.max(x - a.x, 0, a.x - (x + width)), Math.max(y - a.y, 0, a.y - (y + height)));
      [px, py] = corners.reduce((best, c) => (Math.min(...anchors.map(a => dist(c, a))) > Math.min(...anchors.map(a => dist(best, a))) ? c : best));
    }
    const cont = this.add.container(0, 0).setDepth(20);
    const g = this.add.graphics();
    g.fillStyle(0x15171c, 0.95).fillRoundedRect(px, py, width, height, 6);
    g.lineStyle(1, 0x5a6070, 1).strokeRoundedRect(px, py, width, height, 6);
    cont.add(g);
    // Swallow clicks on the panel so they never reach the map below.
    const blocker = this.add.zone(px, py, width, height).setOrigin(0).setInteractive();
    cont.add(blocker);
    this.layer.add(cont);
    this._panelRect = { x: px, y: py, w: width, h: height };
    return { cont, px, py, width, height };
  }

  /** How tall these lines are in a panel `width` wide, wrapping included
   *  (a fixed 18 px a line let wrapped lines overprint the next one). */
  _linesHeight(lines, width) {
    let h = 0;
    for (const l of lines) {
      const t = this.add.text(0, -9999, l, { fontFamily: FONT, fontSize: '13px', wordWrap: { width: width - 20 } });
      h += Math.max(18, t.height + 2);
      t.destroy();
    }
    return h;
  }

  /** Write lines down a panel from `ty`; returns the y below them. */
  _panelLines(p, ty, lines) {
    for (const l of lines) {
      const t = this._panelText(p, p.px + 10, ty, l);
      ty += Math.max(18, t.height + 2);
    }
    return ty;
  }

  _panelText(p, x, y, s, size = 13, color = '#d8d8d8') {
    const t = this.add.text(x, y, s, { fontFamily: FONT, fontSize: `${size}px`, color, wordWrap: { width: p.width - 20 } });
    p.cont.add(t);
    return t;
  }

  _panelButton(p, cx, cy, label, cb, style = 'primary') {
    const b = createButton(this, cx, cy, label, () => { SoundManager.play('select'); cb(); }, style, { fontSize: '13px' });
    p.cont.add(b);
    return b;
  }

  /** What is known of a tile, and what can be done there. */
  _drawInspect(id) {
    const v = this.v;
    const t = v.tiles[id];
    const lines = [];
    let title;
    if (!t) {
      title = 'Unexplored';
      lines.push('Not seen yet.');
    } else {
      const ground = GROUNDS[t.ground]?.name || t.ground;
      title = `${ground}${t.relief && t.relief !== 'flat' ? `, ${t.relief}` : ''}${t.ford ? ' (ford)' : ''}`;
      if (v.fog[id] === 'remembered') lines.push('Remembered: as it was when last seen.');
      if (t.exit) lines.push('An exit: the hunt can be left from here.');
      if (t.gathered) lines.push(`Already ${t.gathered === 'fish' ? 'fished' : 'foraged'}.`);
      for (const f of v.features.filter(ff => ff.tile === id)) {
        lines.push({ waystone: 'A Waystone: the hunt can be left from here.', blight_source: f.destroyed ? 'A destroyed blight source.' : 'A blight source: the blight spreads from here.', scout_site: 'A scouting site.', retrieve_site: 'The Retrieve site.', shrine: 'The shrine.' }[f.kind] || f.kind);
      }
      for (const s of v.objectiveSites.filter(ss => ss.tile === id)) lines.push(`Objective: ${OBJECTIVE_NAME(s.objective)} site${s.done ? ' (done)' : ''}.`);
    }
    if (!t) for (const s of v.objectiveSites.filter(ss => ss.tile === id)) lines.push(`Objective: ${OBJECTIVE_NAME(s.objective)} site${s.done ? ' (done)' : ''}.`);
    const occ = v.occupants.find(o => o.tile === id);
    if (occ) lines.push(...this._occupantLines(occ));
    for (const tr of v.trails.filter(x => x.tile === id)) {
      lines.push(tr.band === 'sensed' ? 'Signs of passage.' : `A ${familyName(v.zoneId, tr.family)} trail${tr.age != null ? `, ${fmt(tr.age)} old` : ''}.`);
    }
    const move = v.moves.find(m => m.tile === id);
    const own = id === v.pos;

    // Buttons for this tile.
    const acts = [];
    if (move) acts.push([`Move here (${fmt(move.supply)} supplies, ${fmt(move.time)} time)`, () => this._act('move', () => this.hunt.move(id))]);
    if (occ && !occ.exact && v.fog[id] === 'visible') acts.push([`Scout (${SCOUT_TIME} time)`, () => this._act('scout', () => this.hunt.scout(occ.id))]);
    if (own) {
      for (const m of v.moves) {
        if (v.layout.includes(m.tile)) continue;
        acts.push([`Cross to section ${parseTileId(m.tile).section + 1} (${fmt(m.supply)} supplies, ${fmt(m.time)} time)`, () => this._act('move', () => this.hunt.move(m.tile))]);
      }
      acts.push([`Forage (${FORAGE_TIME} time)`, () => this._act('forage', () => this.hunt.forage())]);
      acts.push([`Fish (${FISH_TIME} time)`, () => this._act('fish', () => this.hunt.fish())]);
      acts.push(['Eat…', () => { this.panel = 'eat'; this._refresh(); }]);
      acts.push([`Camp… (${CAMP_TIME} time, ${CAMP_SUPPLY} supplies)`, () => { this.panel = 'camp'; this.meals = []; this._refresh(); }]);
      if (t?.ground === 'blight') acts.push([`Cleanse (${CLEANSE_TIME} time)`, () => this._act('cleanse', () => this.hunt.cleanse())]);
      if (t?.exit) acts.push(['Leave the hunt', () => this._confirmExit(), 'danger']);
    }

    const width = 300;
    const height = 44 + this._linesHeight(lines, width) + acts.length * 36 + 6;
    const p = this._sidePanel(id, width, height);
    this._panelText(p, p.px + 10, p.py + 8, own ? `${title} (you are here)` : title, 15, '#f2e6c8');
    let ty = p.py + 34;
    ty = this._panelLines(p, ty, lines);
    ty += 8;
    for (const [label, cb, style] of acts) {
      this._panelButton(p, p.px + width / 2, ty + 12, label, cb, style || 'primary');
      ty += 36;
    }
  }

  _occupantLines(o) {
    const zoneId = this.v.zoneId;
    const stale = o.stale ? ' (last seen, may have moved)' : '';
    if (o.band === 'sensed') return [`Something is here, but you cannot make it out${stale}.`];
    if (o.kind === 'event') return ['Something worth a look.'];
    const lines = [];
    if (o.kind === 'cultist') lines.push(`Cultists, ${o.size}${stale}.`);
    else lines.push(`${familyName(zoneId, o.family)}, ${o.size}, up to ${o.topGrade}${stale}.`);
    if (o.mark && o.mark !== 'unmarked') lines.push(o.mark === 'marked' ? 'Marked by a prophet.' : 'Corrupted.');
    if (o.exact) lines.push(`Exactly: ${o.roster.map(m => m.grade || m.type).join(', ')}${o.composition ? ` (${o.composition})` : ''}.`);
    return lines;
  }

  _drawEat() {
    const food = this.hunt.foodInPack();
    const edible = Object.entries(food).filter(([id]) => Items[id]?.food?.rawEdible);
    const lines = edible.length ? [] : ['Nothing in the pack can be eaten raw. Fish and meat must be cooked at camp.'];
    const height = 50 + this._linesHeight(lines, 320) + edible.length * 36 + 44;
    const p = this._sidePanel(this.v.pos, 320, height);
    this._panelText(p, p.px + 10, p.py + 8, 'Eat from the pack (takes no time)', 15, '#f2e6c8');
    let ty = p.py + 36;
    ty = this._panelLines(p, ty, lines);
    for (const [id, qty] of edible) {
      const it = Items[id];
      this._panelButton(p, p.px + 160, ty + 12, `Eat 1 ${it.name} (+${it.supply}) · ${qty} left`, () => this._act('eat', () => this.hunt.eat(id, 1)));
      ty += 36;
    }
    this._panelButton(p, p.px + 160, ty + 16, 'Back', () => { this.panel = null; this._refresh(); });
  }

  _drawCamp() {
    const food = this.hunt.foodInPack();
    const used = {};
    for (const m of this.meals) { used[m.main] = (used[m.main] || 0) + 1; if (m.addition) used[m.addition] = (used[m.addition] || 0) + 1; }
    const left = (id) => (food[id] || 0) - (used[id] || 0);
    const mains = Object.keys(food).filter(id => ['fish', 'meat'].includes(Items[id]?.food?.kind) && left(id) > 0);
    const adds = Object.keys(food).filter(id => Items[id]?.food?.kind === 'forage' && left(id) > 0);
    const open = this.meals.find(m => !m.addition);
    const queue = this.meals.length
      ? this.meals.map((m, i) => `${i + 1}. ${Items[m.main].name}${m.addition ? ` with ${Items[m.addition].name}` : ''}`)
      : ['No meals: the camp only rests.'];
    const height = 60 + this._linesHeight(queue, 340) + (mains.length + (open ? adds.length : 0)) * 34 + 110;
    const p = this._sidePanel(this.v.pos, 340, height);
    this._panelText(p, p.px + 10, p.py + 8, `Make camp: ${CAMP_TIME} time, ${CAMP_SUPPLY} supplies`, 15, '#f2e6c8');
    this._panelText(p, p.px + 10, p.py + 30, 'Recovers HP and MP (more at night). A pack may find you.', 12, '#a8b0bc');
    let ty = p.py + 54;
    ty = this._panelLines(p, ty, queue);
    ty += 6;
    for (const id of mains) {
      this._panelButton(p, p.px + 170, ty + 12, `Cook ${Items[id].name} (${left(id)})`, () => { this.meals.push({ main: id }); this._refresh(); });
      ty += 34;
    }
    if (open) for (const id of adds) {
      this._panelButton(p, p.px + 170, ty + 12, `…with ${Items[id].name} (${left(id)})`, () => { open.addition = id; this._refresh(); });
      ty += 34;
    }
    ty += 8;
    this._panelButton(p, p.px + 110, ty + 12, 'Make camp', () => {
      const meals = this.meals.map(m => (m.addition ? { main: m.main, addition: m.addition } : { main: m.main }));
      this.panel = null;
      this._act('camp', () => this.hunt.camp({ meals }));
    }, 'confirm');
    this._panelButton(p, p.px + 250, ty + 12, 'Back', () => { this.panel = null; this.meals = []; this._refresh(); });
    ty += 36;
    if (this.meals.length) this._panelButton(p, p.px + 170, ty + 12, 'Clear meals', () => { this.meals = []; this._refresh(); });
  }

  /** The log: opaque and click-blocking, in the top corner a panel is not
   *  using (it once opened over an encounter panel, whose buttons then took
   *  clicks through it). */
  _drawLog() {
    const lines = this.v.log.slice(-LOG_SHOWN).map(e => this._logLine(e)).filter(Boolean).reverse();
    const width = 360;
    const right = FIELD_WINDOW.x + FIELD_WINDOW.w - width - 6, left = FIELD_WINDOW.x + 6;
    const pr = this._panelRect;
    const x = pr && pr.x + pr.w / 2 > FIELD_WINDOW.x + FIELD_WINDOW.w / 2 ? left : right;
    const box = this._box(x, MAP.y + 6, width, lines.length ? lines : ['Nothing yet.'], 30, 'Hunt log (newest first)', { opaque: true, block: true });
    this.layer.add(box);
  }

  /** A boon level earned since this hunt last announced one (in a fight, too). */
  _announceBoon() {
    const b = this.v.boon;
    if (!b?.house) return;
    if (!_boonAnnounced.has(this.hunt)) { _boonAnnounced.set(this.hunt, b.level); return; }
    if (b.level <= _boonAnnounced.get(this.hunt)) return;
    _boonAnnounced.set(this.hunt, b.level);
    const d = boonLevelDef(b.house, b.level);
    SoundManager.play('reward');
    this._say(`✦ ${houseName(b.house)}'s boon rises to level ${b.level}: ${d?.name || ''}. ${d?.text || ''}`);
  }

  _logLine(e) {
    const day = (t) => `D${Math.floor((t || 0) / 12) + 1}`;
    const item = (id) => Items[id]?.name || id;
    switch (e.kind) {
      case 'night': return `${day(e.time)} Night falls.`;
      case 'day': return `Day ${e.day} breaks.`;
      case 'scout': return `${day(e.time)} Scouted what was there.`;
      case 'forage': return `${day(e.time)} Foraged ${e.qty} ${item(e.item)}.`;
      case 'fish': return `${day(e.time)} Caught ${e.qty} ${item(e.item)}.`;
      case 'eat': return `${day(e.time)} Ate ${e.qty} ${item(e.item)} (+${fmt(e.supply)}).`;
      case 'camp': return `${day(e.time)} Camped${e.night ? ' at night' : ''}${e.dishes?.length ? `, cooked ${e.dishes.join(', ')}` : ''}${e.found ? '; a pack found the camp' : ''}.`;
      case 'cleanse': return `${day(e.time)} Cleansed the blight${e.source ? ' and destroyed its source' : ''}.`;
      case 'encounter': return `${day(e.time)} ${e.ambush ? 'Ambushed' : 'Contact'}${e.cause === 'pack' ? ': a pack came for you' : ''}.`;
      case 'win': return `${day(e.time)} Won the fight${e.huntPoints ? `: +${e.huntPoints} Hunt Points` : ''}${e.loot ? `, ${e.loot} item${e.loot > 1 ? 's' : ''} to the pack` : ''}.`;
      case 'flee': return `${day(e.time)} Fled${e.reason === 'reload' ? ' (reloaded mid-fight)' : ''}.`;
      case 'harvest': return `${day(e.time)} Harvested ${e.specimens + e.materials} part${e.specimens + e.materials === 1 ? '' : 's'}${Object.keys(e.meat || {}).length ? ' and meat' : ''}.`;
      case 'spoils_left': return `${day(e.time)} Left the spoils behind.`;
      case 'fight': return `${day(e.time)} The fight began${e.food ? `, well fed on ${item(e.food)}` : ''}.`;
      case 'retrieved': return `${day(e.time)} Took the item from the Retrieve site.`;
      case 'communed': return `${day(e.time)} Reached the shrine.`;
      case 'boon': return `${day(e.time)} ✦ ${houseName(e.house)}'s boon, level ${e.level}${e.name ? `: ${e.name}` : ''}.`;
      case 'exit': return `${day(e.time)} Left the hunt: ${e.huntPoints} Hunt Points.`;
      case 'wipe': return `${day(e.time)} The party fell.`;
      default: return null;
    }
  }

  _drawEncounter() {
    const v = this.v;
    const e = v.encounter;
    const occ = v.occupants.find(o => o.id === e.occId);
    const lines = [];
    lines.push(e.ambush ? (e.cause === 'camp' ? 'Your camp was found. Ambush!' : 'Ambush! You never saw them.') : (e.cause === 'pack' ? 'A pack has come for you.' : 'You close in.'));
    lines.push(`You knew: ${e.knew}.`);
    if (occ && occ.band !== 'sensed') lines.push(...this._occupantLines(occ));
    else lines.push(e.kind === 'cultist' ? 'Cultists.' : 'Beasts.');
    lines.push(`Initiative: party ${fmt(e.partyInitiative)}, them ${fmt(e.enemyInitiative)}.`);
    lines.push(e.first === 'party' ? 'Your side acts first.' : 'Their side acts first.');
    const width = 360, height = 50 + this._linesHeight(lines, 360) + 60;
    const p = this._sidePanel(e.tile && v.layout.includes(e.tile) ? e.tile : v.pos, width, height);
    this._panelText(p, p.px + 10, p.py + 8, e.ambush ? 'Ambush' : 'Encounter', 17, '#ff9a8a');
    let ty = p.py + 36;
    ty = this._panelLines(p, ty, lines);
    ty += 10;
    // Fleeing is done from inside the fight (chunk 9c, decision 8), where the
    // enemy's free round is played: the panel only starts it.
    this._panelButton(p, p.px + width / 2, ty + 12, 'Fight', () => this._fight(), 'danger');
  }

  /**
   * An event site the party stands on (chunk 11a). Until the event screen
   * arrives (11b), the panel names it and lets the party walk away, which
   * costs nothing and leaves the site: the hunt is never stuck on one.
   */
  _drawEvent() {
    const ev = this.v.event;
    const lines = [ev.text, 'Events can be played in the next update. Walking away costs nothing; the site stays.'];
    const width = 360, height = 50 + this._linesHeight(lines, 360) + 60;
    const p = this._sidePanel(ev.tile, width, height);
    this._panelText(p, p.px + 10, p.py + 8, ev.name, 17, '#e8c66a');
    let ty = p.py + 36;
    ty = this._panelLines(p, ty, lines);
    this._panelButton(p, p.px + width / 2, ty + 22, 'Walk away', () => this._act('leave', () => this.hunt.leaveEvent()));
  }

  /**
   * Start the pending encounter as a real fight (chunk 9b). The engine's
   * fightSpec() is the whole hand-over: the occupant as a scenario, who acts
   * first, the XP pool, the death rule. This scene stops (as the old Hunt
   * screen did before combat) and hands CombatScene a way back: `reopen`
   * relaunches it with the same hunt and hooks, so a sandboxed dev hunt comes
   * back sandboxed and the real one keeps autosaving. The hunt was already
   * saved with the encounter pending, so a reload mid-fight is a flee.
   */
  _fight() {
    // beginFight (chunk 9c) is fightSpec plus the party's "next fight" food
    // buff, which it uses up: so the hunt is saved before the fight starts.
    const spec = this.hunt.beginFight();
    if (!spec?.ok) { this._say(spec?.reason ? `Cannot: ${spec.reason}.` : 'Cannot fight.'); return; }
    this.onAction?.(this.hunt);
    SoundManager.play('select');
    const reopenData = { hunt: this.hunt, onDone: this.onDone, onAction: this.onAction, onFinished: this.onFinished };
    const huntFight = {
      ...spec,
      hunt: this.hunt,
      onFinished: this.onFinished,
      reopen: (scene) => {
        scene.scene.launch('HuntFieldOverlay', reopenData);
        scene.scene.bringToTop('UIScene');
      },
    };
    this.scene.stop();
    window.sceneManager.loadScene('CombatScene', spec.ambush ? 'Ambush!' : 'The hunt turns to a fight!', {
      mode: 'hunt',
      party: GameState.party,
      scenarioId: spec.scenario.id,
      huntContext: { type: spec.kind, itemLevel: spec.itemLevel },
      huntFight,
    });
  }

  /**
   * The spoils of a won beast fight (chunk 9d; BEAST_PARTS: "harvest on the
   * victory screen", grouped by part type, commons hidden by default). Every
   * group is taken unless turned off; commons only when shown. The time is
   * the engine's (view().spoils, Foraging's cut applied). Walking away leaves
   * the spoils, as does "Leave it".
   */
  _drawHarvest() {
    const sp = this.v.spoils;
    const fam = HUNT_BEASTS[sp.family];
    const shown = (p) => this.harvestCommons || p.rarity !== 'common';
    const commons = sp.parts.filter(p => p.rarity === 'common').length;
    const groups = PART_SLOTS.map(slot => ({ slot, word: fam?.parts?.[slot] || slot, parts: sp.parts.filter(p => p.slot === slot && shown(p)) }))
      .filter(g => g.parts.length);
    const order = ['epic', 'rare', 'uncommon', 'common'];
    const take = groups.filter(g => !this.harvestSkip.has(g.slot)).flatMap(g => g.parts);
    const meatOn = !this.harvestNoMeat && Object.keys(sp.meat).length > 0;
    const time = take.reduce((a, p) => a + p.time, 0) + (meatOn ? sp.meatTime : 0);
    const width = 420;
    const height = 70 + groups.length * 30 + 30 + 30 + 46 + (groups.length ? 0 : 20);
    const p = this._sidePanel(null, width, Math.min(height, PANEL_BOTTOM - MAP.y - 12));
    this._panelText(p, p.px + 10, p.py + 8, `Spoils: ${sp.bodies} ${fam?.name || 'beast'}${sp.bodies > 1 ? 's' : ''}`, 16, '#f2e6c8');
    this._panelText(p, p.px + 10, p.py + 30, 'Take what you want. It costs time; what you leave is gone.', 12, '#a8b0bc');
    let ty = p.py + 58;
    if (!groups.length) { this._panelText(p, p.px + 10, ty, 'No parts worth taking.', 13, '#a8b0bc'); ty += 20; }
    for (const g of groups) {
      const counts = order.map(r => [r, g.parts.filter(x => x.rarity === r).length]).filter(([, n]) => n).map(([r, n]) => `${n} ${r}`).join(', ');
      const on = !this.harvestSkip.has(g.slot);
      this._panelButton(p, p.px + width / 2, ty + 12, `[${on ? 'x' : ' '}] ${g.word} x${g.parts.length}: ${counts}`, () => {
        if (on) this.harvestSkip.add(g.slot); else this.harvestSkip.delete(g.slot);
        this._refresh();
      });
      ty += 30;
    }
    const meatWords = Object.entries(sp.meat).map(([id, q]) => `${q} ${Items[id]?.name || id}`).join(', ');
    if (meatWords) {
      this._panelButton(p, p.px + width / 2, ty + 12, `[${meatOn ? 'x' : ' '}] Meat: ${meatWords}`, () => { this.harvestNoMeat = !this.harvestNoMeat; this._refresh(); });
      ty += 30;
    }
    this._panelText(p, p.px + 10, ty + 4, `Time: ${fmt(time)}. ${take.length} part${take.length === 1 ? '' : 's'}${meatOn ? ' and the meat' : ''}.`, 13, '#d8d8d8');
    ty += 30;
    this._panelButton(p, p.px + 80, ty + 12, this.harvestCommons ? 'Hide commons' : `Show commons (${commons})`, () => { this.harvestCommons = !this.harvestCommons; this._refresh(); });
    this._panelButton(p, p.px + 230, ty + 12, 'Harvest', () => this._act('harvest', () => this.hunt.harvest({ take: take.map(x => x.id), meat: meatOn })), 'confirm');
    this._panelButton(p, p.px + 345, ty + 12, 'Leave it', () => this._act('leave', () => this.hunt.harvest({ take: [], meat: false })));
  }

  _confirmExit() {
    const prim = this.v.objectives.find(o => o.kind === 'primary');
    const msg = prim?.done || (prim?.id === 'retrieve' && prim.have)
      ? 'Leave the hunt? The pack comes home and the reward is paid.'
      : 'Leave now? The primary objective is not done: you keep what you found but forfeit the completion reward.';
    const ui = this._uiScene();
    if (ui?.showConfirmationDialogue) ui.showConfirmationDialogue(msg, () => { ui.resetBottomBar(); this._act('exit', () => this.hunt.exit()); });
    else this._act('exit', () => this.hunt.exit());
  }

  _drawFinished() {
    const v = this.v;
    const exitLog = [...v.log].reverse().find(l => l.kind === 'exit' || l.kind === 'wipe');
    const lines = v.finished === 'exit'
      ? [`You left the hunt on day ${v.clock.day}.`, `Hunt Points: ${exitLog?.huntPoints ?? 0}.`,
         ...v.objectives.map(o => `${o.kind === 'primary' ? 'Objective' : 'Bonus'}: ${OBJECTIVE_NAME(o.id)} ${o.done ? 'done' : 'not done'}`)]
      : ['The party fell. The hunt is over.'];
    const width = 380, height = 60 + this._linesHeight(lines, 380) + 50;
    const p = this._sidePanel(null, width, height);
    this._panelText(p, p.px + 10, p.py + 8, v.finished === 'exit' ? 'The hunt is over' : 'Wiped', 18, '#f2e6c8');
    let ty = p.py + 38;
    ty = this._panelLines(p, ty, lines);
    this._panelButton(p, p.px + width / 2, ty + 24, 'Return to camp', () => this._close(), 'confirm');
  }

  // ── Acting ─────────────────────────────────────────────────────────────────

  /** Run an engine action; show its refusal or its news; redraw. */
  _act(kind, fn) {
    const res = fn();
    if (!res?.ok) {
      SoundManager.play('handsClick');
      this._say(res?.reason ? `Cannot: ${res.reason}.` : 'Cannot do that.');
      this._refresh();
      return res;
    }
    if (kind === 'move' || kind === 'flee') this.selected = this.hunt.view().pos;
    // Save after every accepted action; a refusal changed nothing.
    if (this.hunt.view().finished) this.onFinished?.(this.hunt);
    else this.onAction?.(this.hunt);
    const news = this._news(kind, res);
    if (news) this._say(news);
    this._refresh();
    return res;
  }

  /** What is worth a line in the dialogue bar after an action. */
  _news(kind, res) {
    const out = [];
    if (res.flips?.includes('night')) out.push('Night falls.');
    if (res.flips?.includes('day')) out.push('A new day breaks.');
    if (kind === 'forage' || kind === 'fish') out.push(`${kind === 'fish' ? 'Caught' : 'Found'} ${res.qty} ${Items[res.item]?.name || res.item}.`);
    if (kind === 'eat') out.push(`+${fmt(res.supply)} supplies.`);
    if (kind === 'camp') out.push(`Camped: recovered ${Math.round(res.recoveryPercent)}% HP and MP${res.found ? ', then a pack found the camp' : ''}.`);
    if (kind === 'cleanse') out.push(res.sourceDestroyed ? 'The blight source is destroyed.' : 'The blight here is cleansed.');
    if (kind === 'flee') out.push('You fell back. They will be hunting you.');
    if (kind === 'harvest') out.push(`Harvested ${res.specimens + res.materials} part${res.specimens + res.materials === 1 ? '' : 's'}${Object.keys(res.meat || {}).length ? ' and meat' : ''} into the pack.`);
    if (res.starved?.length) out.push(`Starving: ${res.starved.map(s => s.name).join(', ')} lost HP.`);
    if (kind === 'scout' && res.view?.exact) out.push('Scouted: you know exactly what is there.');
    if (kind === 'exit') out.push(`Hunt over. ${res.reward?.huntPoints || 0} Hunt Points.`);
    return out.join(' ');
  }

  _uiScene() {
    return this.scene.get('UIScene');
  }

  /** The dialogue bar, only for a moment (MOVEMENT_VISION_FOG: transient). */
  _say(text) {
    const ui = this._uiScene();
    if (!ui?.showDialogue || !text) return;
    ui.showDialogue(text);
    if (this._dialogueTimer) this._dialogueTimer.remove(false);
    this._dialogueTimer = this.time.delayedCall(DIALOGUE_MS, () => { if (!ui.currentEnterAction) ui.resetBottomBar(); });
  }

  // ── Pointer ────────────────────────────────────────────────────────────────

  _hover(p) {
    if (!this.v || !this.hoverGfx) return;
    this.hoverGfx.clear();
    const id = this.tileAt(p.x, p.y);
    if (!id) return;
    const { x, y } = this.center(id);
    this.hoverGfx.lineStyle(2, 0xffffff, 0.9).strokePoints(this._corners(x, y, R - 2), true);
  }

  /** A click on the map selects a tile; a second click on a selected
   *  neighbour moves there. */
  _clickMap(p) {
    if (!this.v || this.v.finished || this.v.encounter) return;
    if (p.y < MAP.y) return;
    const id = this.tileAt(p.x, p.y);
    if (!id) return;
    if (this.panel === 'eat' || this.panel === 'camp') this.panel = null;
    if (id === this.selected && this.v.moves.some(m => m.tile === id)) {
      this._act('move', () => this.hunt.move(id));
      return;
    }
    SoundManager.play('select');
    this.selected = id;
    this._refresh();
  }

  _close() {
    const done = this.onDone;
    this.scene.stop();
    if (done) done(this.hunt);
  }
}

// ── Opening it on the real hunt ─────────────────────────────────────────────

/**
 * Open the map scene on HuntManager's map hunt, from any scene (the Hunt
 * screen after Depart, or the town finding a map hunt in a loaded save).
 * Returns false, doing nothing, if the holder has no map hunt. If the scene
 * is already up it is restarted on the current hunt: TownScene's
 * _syncHuntScreen queues a stop of every hunt screen just before calling
 * this, so "already open" cannot be trusted in the same frame.
 */
export function launchMapHunt(scene) {
  if (HuntManager.mode() !== 'map') return false;
  const sm = scene.scene;
  if (sm.isActive('HuntFieldOverlay') || sm.isPaused('HuntFieldOverlay')) sm.stop('HuntFieldOverlay');
  sm.launch('HuntFieldOverlay', {
    hunt: HuntManager.current(),
    onAction: () => GameState.save('autosave'),
    onFinished: () => { HuntManager.clearFinished(); GameState.save('autosave'); },
  });
  sm.bringToTop('UIScene');
  return true;
}

// ── Dev hook: a sandboxed hunt in memory (tools/browser/huntfield.mjs) ──────

/**
 * window.bmDevMapHunt({ zoneId, objective, size, seed, supplies, bonusObjectives })
 * opens the map scene on a hunt kept in memory. The world is a SANDBOX: the
 * party is a shallow copy (camp and starvation change the copies, not your
 * hunters), and day/night, Hunt Points and banked items go nowhere. Nothing
 * is saved. Returns the hunt, for poking at in the console.
 */
export function installDevHook(game) {
  window.bmDevMapHunt = async (opts = {}) => {
    const { createMapHunt } = await import('../../systems/HuntEngine.js');
    const GameState = (await import('../../systems/GameState.js')).default;
    const party = (GameState.party || []).map(c => Object.assign(Object.create(Object.getPrototypeOf(c)), c));
    const world = {
      party: () => party,
      nightFalls() {}, dayBreaks() {},
      awardHuntPoints(n) { console.log(`[bmDevMapHunt] would award ${n} Hunt Points`); },
      awardXP() {}, bankItems(items) { console.log('[bmDevMapHunt] would bank', items); },
    };
    const plan = {
      objective: opts.objective || 'scout', size: opts.size || 'medium',
      bonusObjectives: opts.bonusObjectives || [], mods: opts.mods || {}, itemLevel: opts.itemLevel || 1,
    };
    const hunt = createMapHunt(opts.zoneId || 'reeds_of_gethsemane',
      { plan, supplies: opts.supplies ?? 60, seed: opts.seed ?? 12345 }, world);
    const sm = game.scene;
    if (sm.isActive('HuntFieldOverlay') || sm.isPaused('HuntFieldOverlay')) sm.stop('HuntFieldOverlay');
    sm.start('HuntFieldOverlay', { hunt });
    sm.bringToTop('UIScene');
    return hunt;
  };
  /**
   * window.bmDevDeathRule('watched') makes every region use that death rule
   * until the page reloads (chunk 10c). No zone is Watched yet, so this is the
   * only way to reach a real Watched wipe, intercession on the spot included,
   * from the game. It only changes hunts that depart after it is called.
   * Returns the rules it set. Call with no argument to see the current ones.
   */
  window.bmDevDeathRule = async (rule) => {
    const { ZONES } = await import('../../../data/zones.js');
    if (rule) {
      if (!['sheltered', 'watched', 'forsaken'].includes(rule)) throw new Error(`unknown death rule '${rule}'`);
      for (const z of Object.values(ZONES)) z.deathRule = rule;
      console.log(`[bmDevDeathRule] every region is ${rule} until the page reloads`);
    }
    return Object.fromEntries(Object.values(ZONES).map(z => [z.id, z.deathRule]));
  };
}
