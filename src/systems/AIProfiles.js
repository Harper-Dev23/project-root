// src/systems/AIProfiles.js

const isAlive = u => u && u.status !== 'incapacitated';

function firstAlive(list) {
  for (const x of list) if (isAlive(x)) return x;
  return null;
}

function columnOf(slotId) {
  if ([1, 2, 3].includes(slotId)) return 'front';
  if ([4, 5].includes(slotId)) return 'mid';
  if ([6, 7, 8].includes(slotId)) return 'back';
  return null;
}

export const TargetPriority = {
  frontline(candidates) {
    const front = candidates.filter(u => columnOf(u?._slot?.slotId) === 'front' && isAlive(u));
    return firstAlive(front.length ? front : candidates.filter(isAlive));
  },
  backline(candidates) {
    const back = candidates.filter(u => columnOf(u?._slot?.slotId) === 'back' && isAlive(u));
    return firstAlive(back.length ? back : candidates.filter(isAlive));
  },
  weakestHP(candidates) {
    const alive = candidates.filter(isAlive);
    if (!alive.length) return null;
    return alive.reduce((a, b) => (a.currentHP / a.maxHP) <= (b.currentHP / b.maxHP) ? a : b);
  }
};

const has = (npc, id) => {
  const list = npc.skills || npc.classSkills || [];
  return list.some(s => s === id || s?.id === id);
};

export const AI_PROFILES = {
  // Encounter 1 — always sway if possible
  passive_sway: {
    decide(npc, scene, enemies) {
      if (has(npc, 'dummy_sway')) {
        return { type: 'class', skill: 'dummy_sway', target: null };
      }
      return null;
    }
  },

  // Encounter 2 — slippery dummy
  skirmisher: {
    decide(npc, scene, enemies) {
      const slotId = npc?._slot?.slotId;
      const col = columnOf(slotId);

      // AIProfiles.js
      if (has(npc, 'dummy_shuffle') && (col === 'front' || Math.random() < 0.4)) {
        return { type: 'bonus', skill: 'dummy_shuffle', target: null };
      }
      // otherwise do nothing special (let NPCLogic fallback choose attack if any)
      return null;
    }
  },

  // Basic soldier: step forward if mid/back, else attack front-line target
  soldier_basic: {
    decide(npc, scene, enemies) {
      const slotId = npc?._slot?.slotId;
      const col = columnOf(slotId);

      // 1) If not already in front, try to step. (No target needed.)
      if (has(npc, 'step_forward') && (col === 'mid' || col === 'back')) {
        // Only try to step if there's actually somewhere to go.
        const canAdvance = scene?._enemyHasFrontSpace?.(npc) ?? true; // treat as true if helper absent
        if (canAdvance) {
          return { type: 'bonus', skill: 'step_forward', target: null };
        }
      }

      // 2) Attack the front-line if possible (fallback)
      if (has(npc, 'basic_attack')) {
        const target = TargetPriority.frontline(enemies);
        if (target) {
          return { type: 'major', skill: 'basic_attack', target };
        }
      }

      return null;
    }
  },


  // Beast: always hit the weakest if possible
  beast_mauler: {
    decide(npc, scene, enemies) {
      const target = TargetPriority.weakestHP(enemies);
      if (!target) return null;
      if (has(npc, 'claw')) return { type: 'major', skill: 'claw', target };
      if (has(npc, 'bite')) return { type: 'major', skill: 'bite', target };
      return null;
    }
  }
};
