// src/systems/CombatStats.js
//
// A fight's battle report (owner 2026-09-29, playtest batch 4b chunk 8): per
// hunter, damage dealt, the biggest single hit and its skill, healing done,
// damage taken and kills. Read by the victory and defeat screens, and by the
// Historic and renown item record (kills, damage, battles carried).
//
// Measured by turn, not by hooking every damage path (there are many): when a
// unit's turn starts, every unit's HP is noted; when it ends, the change is
// credited. HP the enemy side loses on a hunter's turn is that hunter's
// damage (the biggest single loss is the biggest hit), HP the party gains on
// it is that hunter's healing, and an enemy going down is that hunter's kill.
// What the enemy side loses on its own turns (damage over time, reactions,
// hazards) is the party's "effects". Every HP a hunter loses, on any turn, is
// damage taken.
//
// Pure: no Phaser, no scene. CombatScene calls begin / noteSkill / end.

const isDown = (u) => !u || u.status === 'dead' || u.status === 'incapacitated' || (u.currentHP ?? 0) <= 0;
const keyOf = (u) => u?.instanceId || u?.id || u?.name;

/** `isEnemyOf(unit)`: which side a unit is on, read when a turn starts (the
 *  scene knows; a unit's own isEnemy flag is set late). */
export function createCombatStats(party = [], { isEnemyOf = (u) => !!u?.isEnemy } = {}) {
  const rows = new Map();
  const row = (u) => {
    const k = keyOf(u);
    if (!rows.has(k)) rows.set(k, { key: k, name: u?.name || '?', unit: u, damage: 0, biggest: 0, biggestSkill: null, healing: 0, taken: 0, kills: 0 });
    return rows.get(k);
  };
  for (const u of party) row(u);
  let effects = 0;
  let open = null;   // { actor, before: Map(unit -> { hp, down }), skills: [] }

  return {
    /** A unit's turn starts: note every unit's HP. `units` is everyone on the board. */
    begin(actor, units) {
      if (open) this.end();
      open = { actor, hunter: actor && !isEnemyOf(actor) ? actor : null, skills: [],
        before: new Map((units || []).filter(Boolean).map(u => [u, { hp: u.currentHP ?? 0, down: isDown(u), enemy: isEnemyOf(u) }])) };
    },

    /** The actor used a skill this turn (its name labels the biggest hit). */
    noteSkill(actor, name) {
      if (open && actor === open.actor && name) open.skills.push(name);
    },

    /** The turn ends (or the fight does): credit what changed since begin. */
    end() {
      if (!open) return;
      const { hunter, before, skills } = open;
      open = null;
      for (const [u, b] of before) {
        const delta = (u.currentHP ?? 0) - b.hp;
        if (b.enemy) {
          if (delta < 0) {
            if (hunter) {
              const r = row(hunter);
              r.damage += -delta;
              if (-delta > r.biggest) { r.biggest = -delta; r.biggestSkill = skills[skills.length - 1] || null; }
            } else effects += -delta;
          }
          if (!b.down && isDown(u) && hunter) row(hunter).kills++;
        } else {
          // The party's own hunters only: a summoned ally gets no row.
          if (delta < 0 && rows.has(keyOf(u))) rows.get(keyOf(u)).taken += -delta;
          else if (delta > 0 && hunter) row(hunter).healing += delta;
        }
      }
    },

    /** The report: one row per hunter (party order), the party total and the fight's biggest hit. */
    report() {
      const list = [...rows.values()];
      const total = list.reduce((t, r) => ({
        damage: t.damage + r.damage, healing: t.healing + r.healing, taken: t.taken + r.taken, kills: t.kills + r.kills,
      }), { damage: effects, healing: 0, taken: 0, kills: 0 });
      const top = list.reduce((best, r) => (r.biggest > (best?.biggest || 0) ? r : best), null);
      return {
        rows: list.map(({ unit, ...r }) => r),
        effects,
        total,
        highlight: top && top.biggest > 0 ? { name: top.name, skill: top.biggestSkill, amount: top.biggest } : null,
      };
    },

    /** Each hunter's row by unit, for the item record. */
    rowFor(u) { return rows.get(keyOf(u)) || null; },
  };
}
