import { StatusEffects } from '../systems/StatusEffects.js';

const STATUS_ICON_LIBRARY = {
  taunted: { glyph: 'T!', name: 'Taunted', fg: '#ffd166', bg: '#3a2a0b', border: '#c08c2a', description: 'Forced to focus the provocateur.' },
  slowed: { glyph: 'SL', name: 'Slowed', fg: '#b3d9ff', bg: '#0d2236', border: '#3c6289', description: 'Reduced initiative and speed.' },
  frozen: { glyph: 'FR', name: 'Frozen', fg: '#d5f1ff', bg: '#17344b', border: '#5fa0c8', description: 'Encased in ice and likely to skip actions.' },
  snared: { glyph: 'SN', name: 'Snared', fg: '#f5d7a1', bg: '#2f2415', border: '#a0783d', description: 'Movement is heavily hindered.' },
  rooted: { glyph: 'RT', name: 'Rooted', fg: '#c7f0c2', bg: '#233122', border: '#649c5a', description: 'Locked in place.' },
  immobilized: { glyph: 'IM', name: 'Immobilized', fg: '#d6cff6', bg: '#2d2744', border: '#6d5fa3', description: 'Unable to reposition.' },
  stunned: { glyph: 'ST', name: 'Stunned', fg: '#ffe0e0', bg: '#3d1f1f', border: '#b25d5d', description: 'Skips actions while stunned.' },
  stealth: { glyph: 'SH', name: 'Stealth', fg: '#d7f0ff', bg: '#14202b', border: '#5f90b3', description: 'Harder to target while hidden.' },
  rogue_evasion: { glyph: 'EV', name: 'Evasion', fg: '#d6ffe0', bg: '#10241a', border: '#4c9a63', description: 'Greatly improved dodge chance.' },
  healer_blessing: { glyph: 'BL', name: 'Blessing', fg: '#f4e6ff', bg: '#2e1a3a', border: '#a36fd6', description: 'Sacred boon improving accuracy and mana.' },
  commanded: { glyph: 'CM', name: 'Commanded', fg: '#ffeab3', bg: '#2c2314', border: '#b58a33', description: 'Acting under an ally command.' },
  battle_frenzy: { glyph: 'BF', name: 'Battle Frenzy', fg: '#ffd6a3', bg: '#3a2411', border: '#c77232', description: 'Heightened speed and ferocity.' },
  huntsman_marked: { glyph: 'MK', name: 'Marked', fg: '#ffe28a', bg: '#31220d', border: '#b9912f', description: 'Easier target for ranged focus.' },
  empowered_pack: { glyph: 'PK', name: 'Pack Bond', fg: '#e1ffd6', bg: '#1b2916', border: '#6aa85c', description: 'Bolstered by nearby allies.' },
  defender_guard: { glyph: 'DG', name: 'Defender Guard', fg: '#d9f2ff', bg: '#142631', border: '#6fa8d2', description: 'Physical guard and protection.' },
  fighter_guard: { glyph: 'FG', name: 'Fighter Guard', fg: '#ffe0ba', bg: '#2f2315', border: '#c08c49', description: 'Bracing against incoming blows.' },
  heated_guard: { glyph: 'HG', name: 'Heated Guard', fg: '#ffcba4', bg: '#3a2316', border: '#c77232', description: 'Guard that retaliates with heat.' },
  icy_guard: { glyph: 'IG', name: 'Icy Guard', fg: '#c3eaff', bg: '#172a38', border: '#5fa0c8', description: 'Guard that retaliates with cold.' },
  berserker_guard: { glyph: 'BG', name: 'Berserker Guard', fg: '#ffb3b3', bg: '#3a1a1a', border: '#c44545', description: 'Guard while enraged.' },
  anchor_stance: { glyph: 'AN', name: 'Anchor Stance', fg: '#f0e0c0', bg: '#2f2817', border: '#b28f4c', description: 'Rooted posture, harder to move.' },
  braced: { glyph: 'BR', name: 'Braced', fg: '#e6f1ff', bg: '#1e2533', border: '#6a88b8', description: 'Guarding against the next strike.' },
  lockstep: { glyph: 'LS', name: 'Lockstep', fg: '#eaf0ff', bg: '#1e2231', border: '#6d87c2', description: 'Synchronized defense with allies.' },
  ward_focus: { glyph: 'WD', name: 'Ward Focus', fg: '#f1e4ff', bg: '#281c34', border: '#8d6bc3', description: 'Sharpened magical wards.' },
  steady_breath: { glyph: 'SB', name: 'Steady Breath', fg: '#e6f3ff', bg: '#202e38', border: '#6aa8d2', description: 'Controlled breathing for focus.' },
  steady_aim: { glyph: 'SA', name: 'Steady Aim', fg: '#fce6c9', bg: '#2f2618', border: '#c08c49', description: 'Lined up for a precise shot.' },
  eagle_focus: { glyph: 'EF', name: 'Eagle Focus', fg: '#d9f2ff', bg: '#142631', border: '#6fa8d2', description: 'Eyes locked onto a target.' },
  focus_meditation: { glyph: 'FM', name: 'Focus Meditation', fg: '#e9e1ff', bg: '#241d35', border: '#8a6dc0', description: 'Calming mind and restoring mana.' },
  roaring_focus: { glyph: 'RF', name: 'Roaring Focus', fg: '#ffe6c9', bg: '#352218', border: '#c27a46', description: 'Ferocity channeled into focus.' },
  whip_rhythm: { glyph: 'WR', name: 'Whip Rhythm', fg: '#f7e4ff', bg: '#2a1b33', border: '#a16cc9', description: 'Combo rhythm building power.' },
  shattering_cut_sundered: { glyph: 'SU', name: 'Sundered', fg: '#ffd1d1', bg: '#3b1d1d', border: '#b24a4a', description: 'Armor is fractured.' },
  ice_shatter_armorbreak: { glyph: 'IB', name: 'Armorbreak', fg: '#d5f1ff', bg: '#17344b', border: '#5fa0c8', description: 'Armor shattered by ice.' },
  tainted: { glyph: 'TN', name: 'Tainted', fg: '#ffd6f2', bg: '#30192b', border: '#b25d9c', description: 'Afflicted by foul magic.' },
  regen: { glyph: 'RG', name: 'Regeneration', fg: '#9fe6a0', bg: '#16311f', border: '#2a7b3c', description: 'Restoring health over time.' },
  curse_cinders: { glyph: 'CC', name: 'Curse of Cinders', fg: '#ffd4a3', bg: '#362017', border: '#b36c36', description: 'Curse turns flames volatile.' },
  lodged: { glyph: 'LD', name: 'Lodged', fg: '#ffd2a3', bg: '#2f1f14', border: '#a06c36', description: 'A projectile remains embedded.' },
};

const COLOR_PALETTE = [
  { bg: '#1d2a44', fg: '#b6d8ff', border: '#7aa0d8' },
  { bg: '#2f1f2c', fg: '#f4a9c8', border: '#a06482' },
  { bg: '#1f3524', fg: '#9de7b6', border: '#4c8f6a' },
  { bg: '#342612', fg: '#f7d48b', border: '#b18a3a' },
  { bg: '#2b1f38', fg: '#c9b2ff', border: '#7c68b3' },
  { bg: '#303030', fg: '#e6e6e6', border: '#8a8a8a' },
  { bg: '#3a1d1d', fg: '#ffc1b3', border: '#b35c4c' },
  { bg: '#102f35', fg: '#7ed5e3', border: '#3f9ca8' },
];

const buildHexPoints = (size = 9) => {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const angle = Phaser.Math.DegToRad(60 * i - 30);
    pts.push(Math.cos(angle) * size, Math.sin(angle) * size);
  }
  return pts;
};

const toTitle = (id) => {
  if (!id) return 'Status';
  return id.replace(/[_-]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
};

const pickPalette = (id) => {
  const text = id || 'status';
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  const idx = hash % COLOR_PALETTE.length;
  return COLOR_PALETTE[idx];
};

const parseColor = (value, fallback) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const hex = value.startsWith('#') ? value.slice(1) : value;
    const num = parseInt(hex, 16);
    if (!Number.isNaN(num)) return num;
  }
  return fallback;
};

export const combineStatusEffects = (unit) => {
  const out = [];
  if (Array.isArray(unit?.statusEffects)) out.push(...unit.statusEffects);
  if (unit?.statuses && typeof unit.statuses === 'object') {
    Object.keys(unit.statuses).forEach((key) => {
      const st = unit.statuses[key];
      if (!st) return;
      out.push({ ...st, id: st.id || key });
    });
  }
  return out;
};

export const getStatusEffectDisplay = (effectInput) => {
  const eff = typeof effectInput === 'string' ? { id: effectInput } : (effectInput || {});
  const id = eff.id || eff.name || 'status';
  const base = StatusEffects?.[id] || {};
  const lib = STATUS_ICON_LIBRARY[id] || {};
  const palette = pickPalette(id);

  const name = lib.name || base.name || toTitle(id);
  const glyphSource = lib.glyph || base.icon || name || '?';
  const glyph = glyphSource.toString().toUpperCase().slice(0, 2);

  return {
    id,
    name,
    glyph,
    description: lib.description || base.description || eff.description || '',
    fg: lib.fg || base.iconColor || palette.fg,
    bg: lib.bg || base.iconBg || palette.bg,
    border: lib.border || base.iconBorder || palette.border,
    turns: typeof eff.turns === 'number' ? eff.turns : (typeof base.duration === 'number' ? base.duration : null),
    stacks: eff.stacks != null ? eff.stacks : null,
    tags: lib.tags || base.tags || [],
  };
};

export const createStatusIcon = (scene, effectInput, options = {}) => {
  const info = getStatusEffectDisplay(effectInput);
  const size = options.size ?? 9;
  const depth = options.depth ?? 0;
  const container = scene.add.container(0, 0).setDepth(depth);

  const bgColor = parseColor(info.bg, 0x333333);
  const borderColor = parseColor(info.border, 0x888888);

  const hex = scene.add.polygon(0, 0, buildHexPoints(size), bgColor, 0.9)
    .setStrokeStyle(1, borderColor, 0.9)
    .setDepth(depth);

  const text = scene.add.text(0, 0, info.glyph, {
    fontSize: `${Math.max(10, size + 2)}px`,
    color: info.fg || '#ffffff',
    fontStyle: 'bold',
    align: 'center',
  }).setOrigin(0.5).setDepth(depth + 1);

  container.add([hex, text]);
  container.setSize(size * 2, size * 2);

  const tooltip = options.tooltip;
  if (tooltip?.show && tooltip?.hide) {
    container.setInteractive(new Phaser.Geom.Rectangle(-size, -size, size * 2, size * 2), Phaser.Geom.Rectangle.Contains);
    const lines = [];
    if (info.description) lines.push(info.description);
    if (info.turns != null) lines.push(`Duration: ${info.turns} turn${info.turns === 1 ? '' : 's'}`);
    if (info.stacks != null) lines.push(`Stacks: ${info.stacks}`);

    const show = (pointer) => tooltip.show(pointer.worldX, pointer.worldY, { title: info.name, lines });
    const move = (pointer) => tooltip.reposition?.(pointer.worldX, pointer.worldY);
    const hide = () => tooltip.hide();

    container.on('pointerover', show);
    container.on('pointermove', move);
    container.on('pointerout', hide);
  }

  return { container, info };
};
