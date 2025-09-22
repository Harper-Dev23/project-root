// data/skills.js
import { calculateDamage, calculateDualWieldDamage } from '../src/systems/CombatLogic.js';
import { calculateFireballDamage } from '../src/systems/CombatLogic.js';
import { Items } from './items.js';
import { applyDamageModifiers } from '../src/systems/CombatLogic.js';


export const SkillTypes = ['weapon', 'class', 'reaction', 'special'];
export const ActionTypes = ['major', 'bonus', 'class', 'reaction'];



export function getWeaponSkillsFor(char) {
  const unlocked = [];

  for (const [id, skill] of Object.entries(SKILLS)) {
    if (skill.type !== 'weapon') continue;

    // ✅ Unify stat key case
    const statKey = skill.requiredStat?.toUpperCase();
    const statVal = statKey ? (char.totalStats?.[statKey] || 0) : null;

    if (skill.requiredStat && statVal < skill.requiredValue) continue;

    // ✅ Normalize weapon type check
    const mainType = char.equipment?.weaponMain ? Items[char.equipment.weaponMain]?.weaponType : null;
    const offType = char.equipment?.weaponOff ? Items[char.equipment.weaponOff]?.weaponType : null;

    // Preserve existing char.weaponType behavior
    const equippedType = char.weaponType || mainType;

    // ✅ Pass if required weapon matches mainType, offType, or equippedType
    if (skill.requiredWeapon?.length > 0) {
      if (!(
        (equippedType && skill.requiredWeapon.includes(equippedType)) ||
        (mainType && skill.requiredWeapon.includes(mainType)) ||
        (offType && skill.requiredWeapon.includes(offType))
      )) {
        continue;
      }
    }

    unlocked.push({ id, ...skill });
  }

  return unlocked;
}

export function getClassSkillsFor(char) {
  const out = [];
  const base = (char.baseClass || char.class || '').toLowerCase();

  // map base class -> allowed class skills
  const allowed = {
    beggar: ['hide'],
    acolyte: ['blessing'],
    shepherd: ['watch_over'],
    grunt: ['blockade'],
    performer: ['musical_memory'],
    scholar: ['meditate']
  }[base] || [];

  for (const id of allowed) {
    const skill = SKILLS[id];
    if (!skill) continue;
    out.push({ id, ...skill });
  }
  return out;
}

export function getReactionSkillsFor(char) {
  const out = [];
  if (!char) return out;

  const mainType = char.equipment?.weaponMain ? Items[char.equipment.weaponMain]?.weaponType : null;
  const offType = char.equipment?.weaponOff ? Items[char.equipment.weaponOff]?.weaponType : null;
  const equipped = char.weaponType || mainType;

  for (const [id, s] of Object.entries(SKILLS)) {
    if (!s || s.mechanic !== 'reaction') continue;

    // stat gate
    if (s.requiredStat) {
      const statKey = s.requiredStat.toUpperCase();
      const statVal = char.totalStats?.[statKey] || 0;
      if (statVal < (s.requiredValue || 0)) continue;
    }

    // weapon gate
    if (Array.isArray(s.requiredWeapon) && s.requiredWeapon.length) {
      const ok =
        (equipped && s.requiredWeapon.includes(equipped)) ||
        (mainType && s.requiredWeapon.includes(mainType)) ||
        (offType && s.requiredWeapon.includes(offType));
      if (!ok) continue;
    }

    // position gate (use your same column strings)
    if (Array.isArray(s.positionRequirement) && s.positionRequirement.length) {
      const col = char.position || char._slot?.slotId; // you typically store column on char; slot is fallback
      if (!s.positionRequirement.includes(char.position || 'front')) {
        // If you rely on scene column helper at trigger-time, allow prep anyway.
        // Keep conservative: require listed positions for visibility.
        continue;
      }
    }

    out.push({ id, ...s });
  }

  return out;
}

export const SKILLS = {
  // --- Core Skills ---
  'basic_attack': {
    id: 'basic_attack',
    name: 'Basic Attack',
    type: 'weapon',
    actionCost: 'major',
    mpCost: 0,
    hpCost: 0,
    range: 1,
    positionRequirement: ['front', 'mid', 'back'],
    requiresTarget: true,
    targetRequirement: 'enemy',
    targetColumns: ['front', 'mid', 'back'],
    cooldown: 0,
    apply: (attacker, target) => {
      const mainWeapon = attacker.equipment?.weaponMain ? Items[attacker.equipment.weaponMain] : null;
      const offWeapon = attacker.equipment?.weaponOff ? Items[attacker.equipment.weaponOff] : null;
      const mainIsTwoHand = mainWeapon?.hands === 2;

      // Only dual wield if offhand is a weapon (not shield) and main is not 2H
      if (offWeapon && offWeapon.weaponType !== 'shield' && !mainIsTwoHand) {
        return calculateDualWieldDamage(attacker, target);
      } else {
        return calculateDamage(attacker, target);
      }
    },
    description: 'A quick physical strike.',
  },

  // --- Class Skills ---------------------------------------------------------
  'meditate': {
    id: 'meditate', // avoid collision with 'meditate' if you already used it anywhere
    name: 'Meditate',
    type: 'class',
    actionCost: 'class',
    mpCost: 0,
    hpCost: 0,
    requiresTarget: false,
    cooldown: 2,
    description: 'Regain a chunk of MP and clear minor mind effects.',
    apply: (user) => {
      // Simple, safe baseline: restore 20% MP (min 1 if you have MP at all)
      const maxMP = user.maxMP || user.derivedStats?.maxMP || 0;
      if (maxMP > 0) {
        const gain = Math.max(1, Math.floor(maxMP * 0.2));
        user.currentMP = Math.min(maxMP, (user.currentMP || 0) + gain);
      }
      // If you track status flags, clear some here (example only):
      if (user.statuses) {
        delete user.statuses['dazed'];
        delete user.statuses['silenced'];
      }
      return { log: `${user.name} meditates and regains focus.` };
    }
  },

  'hide': {
    id: 'hide',
    name: 'Hide',
    type: 'class',
    actionCost: 'class',
    mpCost: 0,
    hpCost: 0,
    requiresTarget: false,
    cooldown: 3,
    description: 'Beggar: become harder to hit for a short time.',
    apply: (user) => {
      // Keep it minimal: mark a simple flag you can key off in your hit calc.
      user.hidden = { turns: 2 }; // your combat loop should decrement this each round
      return { log: `${user.name} melts into the shadows.` };
    }
  },

  'blessing': {
    id: 'blessing',
    name: 'Blessing',
    type: 'class',
    actionCost: 'class',
    mpCost: 0,
    hpCost: 0,
    requiresTarget: true,
    targetRequirement: 'ally',
    cooldown: 3,
    description: 'Acolyte: buff a single ally with modest accuracy/damage.',
    apply: (user, target) => {
      if (!target) return { log: `${user.name} tries to bless, but finds no target.` };
      target.blessing = { turns: 3, acc: 0.1, dmg: 0.1 };
      return { log: `${user.name} blesses ${target.name}.` };
    }
  },

  'watch_over': {
    id: 'watch_over',
    name: 'Watch Over',
    type: 'class',
    actionCost: 'class',
    mpCost: 0,
    hpCost: 0,
    requiresTarget: true,
    targetRequirement: 'ally',
    cooldown: 3,
    description: 'Shepherd: guard an ally, redirecting some damage for a turn.',
    apply: (user, ally) => {
      if (!ally) return { log: `${user.name} looks for someone to guard.` };
      ally.guardedBy = { id: user.id, turns: 1, reduction: 0.3 }; // you redirect/mitigate in your damage resolver
      return { log: `${user.name} watches over ${ally.name}.` };
    }
  },

  'blockade': {
    id: 'blockade',
    name: 'Blockade',
    type: 'class',
    actionCost: 'class',
    mpCost: 0,
    hpCost: 0,
    requiresTarget: false,
    cooldown: 3,
    description: 'Grunt: hunker down; raise physical resistance for a turn.',
    apply: (user) => {
      user.blockade = { turns: 1, physRes: 0.25 };
      return { log: `${user.name} forms a blockade.` };
    }
  },

  'musical_memory': {
    id: 'musical_memory',
    name: 'Musical Memory',
    type: 'class',
    actionCost: 'class',
    mpCost: 0,
    hpCost: 0,
    requiresTarget: false,
    cooldown: 3,
    description: 'Performer: rally the party; small crit buff for 2 turns.',
    apply: (user) => {
      (user.team || []).forEach(ally => {
        if (!ally) return;
        ally.musicalMemory = { turns: 2, crit: 0.05 };
      });
      return { log: `${user.name} plays a stirring motif.` };
    }
  },




  // --- Weapon Skills ---

  'fireball': {           //TESTINGTESTING BUILDUP and cost
    id: 'fireball',
    name: 'Fireball',
    type: 'weapon',
    mechanic: 'active',
    requiredWeapon: ['staff'],
    requiredValue: 18,
    requiredStat: 'INT',
    actionCost: 'major',
    mpCost: 5, // AoE tax
    hpCost: 0,
    positionRequirement: ['mid', 'back'],
    requiresTarget: true,
    targetRequirement: 'enemy',
    targetColumns: ['front', 'mid', 'back'],
    cooldown: 3, // AoE tax
    tags: ['fire', 'magic', 'projectile', 'aoe', 'attack'],

    // optional static hints for tooltip (no runtime effect)
    aoe: { shape: 'column', scale: 0.5 },
    buildupHint: { fire: 700 },

    apply: (attacker, target, scene) => {
      // Primary hit
      const r = calculateFireballDamage(attacker, target);
      const amount = applyDamageModifiers(r.amount, attacker, target, { element: 'fire' });

      // Column of the clicked target
      const col = scene._getUnitColumn?.(target);

      // Use slots from the target’s side, then pull out characters in the same column
      const sideSlots = target.isEnemy ? scene.enemySlots : scene.allySlots;
      const sameColChars = sideSlots
        .filter(s => scene._getColumnBySlotId?.(s.slotId) === col && s.char && s.char !== target && s.char.status !== 'incapacitated')
        .map(s => s.char);

      const splashScale = 0.5;
      const splash = sameColChars.map(u => ({
        target: u,
        amount: Math.max(1, Math.floor(amount * splashScale)),
        isMagic: true,
        buildup: { fire: 40 },
        tags: ['fire', 'magic', 'aoe', 'splash'],
      }));

      return {
        ...r,
        amount,
        isMagic: true,
        buildup: { fire: 700 },
        splash,
      };
    },

    description:
      'Hurl a burning fireball that explodes in a column, dealing high damage and scorching nearby foes.'
  },





  'feinting_jab': {                 // almost v3
    id: 'feinting_jab',
    name: 'Feinting Jab',
    type: 'weapon',
    mechanic: 'active',  // Same mechanic type as Fireball
    requiredWeapon: ['dagger'],  // Adjust weapon type as needed
    requiredValue: 10,  // Adjust required value based on your system
    requiredStat: 'DEX',  // Using Dexterity for Feinting Jab
    actionCost: 'bonus',  // Action cost for Feinting Jab (adjust as needed)
    mpCost: 3,  // Feinting Jab might not cost MP, adjust if necessary
    hpCost: 0,  // Feinting Jab might not cost HP, adjust if necessary
    cooldown: 1,  // Example cooldown for Feinting Jab
    positionRequirement: ['front', 'mid'],  // Added position requirement (same as Fireball)
    tags: ['attack', 'melee'],  // Tags based on the nature of the attack (adjust as needed)

    apply: (attacker, target, scene) => {
      // Damage calculation for Feinting Jab (based on the original Fireball structure)
      const r = calculateDamage(attacker, target);  // Replace with your damage calculation logic
      const amount = applyDamageModifiers(r.amount, attacker, target);  // Apply any damage modifiers

      return {
        ...r,
        amount,  // Return the modified damage
      };
    },

    description:
      'A deceptive jab that catches the opponent off guard, dealing damage and confusing them.'
  },


  'barbed_arrow': {            //TESTINGTESTING
    id: 'barbed_arrow',
    name: 'Barbed Arrow',
    type: 'weapon',
    mechanic: 'active',
    actionCost: 'major',
    requiredStat: 'DEX',
    requiredValue: 15,
    requiredWeapon: ['bow'],
    mpCost: 0,
    hpCost: 0,
    positionRequirement: ['back'],
    requiresTarget: true,
    targetRequirement: 'enemy',
    targetColumns: ['front', 'mid', 'back'], // shoot any enemy row
    cooldown: 2,
    tags: ['physical', 'projectile', 'piercing', 'attack'],
    // optional static hints for tooltip
    buildupHint: { lacerate: 600 },
    apply: (attacker, target) => {
      const r = calculateDamage(attacker, target);
      const amount = applyDamageModifiers(r.amount, attacker, target);
      return {
        ...r,
        amount,
        buildup: { lacerate: 600 }, // feeds the Physical: Bleed meter
      };
    },
    description: 'Fires a barbed arrow that causes bleeding.'
  },


  'bonecrusher': {            //TESTINGTESTING
    id: 'bonecrusher',
    name: 'Bonecrusher',
    type: 'weapon',
    mechanic: 'active',
    actionCost: 'major',
    requiredStat: 'STR',
    requiredValue: 10,
    requiredWeapon: ['mace_2h'],
    mpCost: 0,
    hpCost: 0,
    positionRequirement: ['front'],
    requiresTarget: true,
    targetRequirement: 'enemy',
    targetColumns: ['front'], // adjacent melee smash
    cooldown: 2,
    tags: ['physical', 'melee', 'blunt', 'stun', 'attack'],
    // optional static hints for tooltip
    buildupHint: { disorient: 310 },
    apply: (attacker, target) => {
      const r = calculateDamage(attacker, target);
      const amount = applyDamageModifiers(r.amount, attacker, target);
      return {
        ...r,
        amount,
        buildup: { disorient: 310 }, // feeds the Physical: Stun meter
      };
    },
    description: 'A crushing mace strike that dazes; repeated hits can Stun.'
  },


  'scorching_ray': {
    id: 'scorching_ray',
    name: 'Scorching Ray',
    type: 'weapon',
    actionCost: 'major',
    requiredStat: 'INT',
    requiredValue: 10,
    requiredWeapon: ['wand'],
    mpCost: 5,
    hpCost: 0,
    range: 2,
    positionRequirement: ['mid', 'back'],
    requiresTarget: true,
    targetRequirement: 'enemy',
    cooldown: 1,
    apply: (attacker, target) => {
      const result = calculateDamage(attacker, target);
      result.isMagic = true;
      return result;
    },
    description: 'A focused beam of flame fired from a wand.',
  },

  // === New Weapon/Class Skills ===

  'restoration_light': {            //v3 updated
    id: 'restoration_light',
    name: 'Restoration Light',
    type: 'weapon',
    mechanic: 'active',
    actionCost: 'major',
    requiredStat: 'WIS',
    requiredValue: 15,
    requiredWeapon: ['staff'],
    mpCost: 5,
    hpCost: 0,
    positionRequirement: ['back'],
    requiresTarget: true,
    targetRequirement: 'ally',
    targetColumns: ['front', 'mid', 'back'], // can heal any ally row
    cooldown: 3,
    tags: ['holy', 'heal', 'regen', 'magic'],
    apply: (attacker, target) => {
      const healAmount = 10 + Math.floor((attacker.totalStats?.WIS || 0) / 2);
      return {
        amount: healAmount,
        isHeal: true,
        statusEffects: [{ id: 'regen', turns: 2, tickHeal: 3 }],
      };
    },
    description: 'Restore moderate HP and grant regen for 2 turns.'
  },

  'overhead_hew': {
    id: 'overhead_hew',
    name: 'Overhead Hew',
    type: 'weapon',
    actionCost: 'major',
    requiredStat: 'STR',
    requiredValue: 15,
    requiredWeapon: ['axe_2h'],
    mpCost: 5,
    hpCost: 0,
    range: 1,
    positionRequirement: ['front'],
    requiresTarget: true,
    targetRequirement: 'enemy',
    cooldown: 4,
    apply: (attacker, target) => {
      const result = calculateDamage(attacker, target);
      result.armorDebuff = 0.10;
      return result;
    },
    description: 'A cleaving blow that reduces armor for the next round.'
  },

  'shield_ram': {
    id: 'shield_ram',
    name: 'Shield Ram',
    type: 'weapon',
    actionCost: 'major',
    requiredStat: 'STR',
    requiredValue: 18,
    requiredWeapon: ['shield'],
    mpCost: 4,
    hpCost: 0,
    range: 1,
    positionRequirement: ['front'],
    requiresTarget: true,
    targetRequirement: 'enemy',
    cooldown: 3,
    apply: (attacker, target) => {
      const result = calculateDamage(attacker, target);
      result.knockback = 1;
      result.disorientOnCollision = true;
      return result;
    },
    description: 'Bash the enemy back; if they collide, they are disoriented.'
  },

  'frostlash': {
    id: 'frostlash',
    name: 'Frostlash',
    type: 'weapon',
    actionCost: 'major',
    requiredStat: 'INT',
    requiredValue: 15,
    requiredWeapon: ['staff'],
    mpCost: 6,
    hpCost: 0,
    range: 3,
    positionRequirement: ['back'],
    requiresTarget: true,
    targetRequirement: 'enemy',
    cooldown: 4,
    apply: (attacker, target) => {
      const r = calculateDamage(attacker, target); // your physical calc
      const amount = applyDamageModifiers(r.amount, attacker, target, {
        element: 'cold',   // tagging the element for future use (no bonus unless enabled)
      });
      return { ...r, amount, isMagic: true, buildup: { cold: 60 } };
    },
    description: 'A chilling strike that builds Cold on the enemy.'
  },

  ///////////REACTIONS///////////////
  'cover_strike': {                  //v3 pending
    id: 'cover_strike',
    name: 'Cover Strike',
    type: 'weapon',
    mechanic: 'reaction',
    actionCost: 'reaction',
    requiredStat: 'DEX',
    requiredValue: 16,
    requiredWeapon: ['sword_1h'],
    mpCost: 0,
    cooldown: 0,
    requiresTarget: false,
    positionRequirement: ['front', 'mid'],
    apply: (attacker) => {
      return { armReaction: true, consumeOn: 'trigger', log: `${attacker.name} watches over their column.` };
    },
    reaction: {
      trigger: 'ally_hit',
      priority: 1,
      canTrigger: ({ owner, target, scene }) => {
        // Owner must be in same column as target (ally)
        const colA = scene._getUnitColumn?.(owner);
        const colB = scene._getUnitColumn?.(target);
        return colA && colB && colA === colB;
      },
      exec: ({ owner, attacker, scene }) => {
        scene._log?.(`${owner.name} strikes back to protect their ally!`);
        const basic = SKILLS['basic_attack'];
        if (basic) {
          scene.time.delayedCall(50, () => {
            scene._applyAbilityToTarget(owner, attacker, basic, { isReaction: true, tags: basic.tags || [] });
          });
        }
      }
    },
    description: 'Arm yourself to strike back when an ally in your column is attacked.'
  },

  'riposte': {                   //v3  pending
    id: 'riposte',
    name: 'Riposte',
    type: 'weapon',
    mechanic: 'reaction',        // shows up in Reactions menu
    actionCost: 'reaction',      // you spend this on YOUR turn to arm it
    requiredStat: 'DEX',
    requiredValue: 15,
    requiredWeapon: ['sword_1h'],
    mpCost: 0,
    cooldown: 1,                 // starts when it TRIGGERS (not on prep)
    requiresTarget: false,
    positionRequirement: ['front', 'mid'],
    // Prep phase: arm the reaction; engine defers cooldown to trigger-time
    apply: (attacker) => {
      return { armReaction: true, consumeOn: 'trigger', log: `${attacker.name} prepares a riposte.` };
    },
    // Reaction descriptor: when/how it triggers and what it does
    reaction: {
      trigger: 'self_hit',       // fires in the defender window
      canTrigger: ({ owner }) => {
        const w = owner.weaponType;
        return w === 'sword_1h'; // honor weapon gating at trigger-time
      },
      exec: ({ owner, attacker, scene, incoming }) => {
        // DR before damage lands
        incoming.damageReduction = Math.max(incoming.damageReduction || 0, 0.5);
        scene._log?.(`${owner.name} parries!`);

        // Counterattack (reuse basic_attack if available)
        const basic = SKILLS['basic_attack'];
        if (basic) {
          scene.time.delayedCall(50, () => {
            scene._applyAbilityToTarget(owner, attacker, basic, { isReaction: true, tags: basic.tags || [] });
          });
        }
      }
    },
    description: 'Arm a parry stance; the first hit until your next turn is reduced and countered.'
  },




  'rebounding_shot': {
    id: 'rebounding_shot',
    name: 'Rebounding Shot',
    type: 'weapon',
    actionCost: 'major',
    requiredStat: 'DEX',
    requiredValue: 20,
    requiredWeapon: ['sling'],
    mpCost: 5,
    hpCost: 0,
    range: 3,
    positionRequirement: ['mid', 'back'],
    requiresTarget: true,
    targetRequirement: 'enemy',
    cooldown: 4,
    apply: (attacker, target) => {
      const result = calculateDamage(attacker, target);
      result.bounce = true;
      return result;
    },
    description: 'Hits one enemy, then bounces to another.'
  },

  'brace_up': {
    id: 'brace_up',
    name: 'Brace Up',
    type: 'weapon',
    actionCost: 'bonus',
    requiredStat: 'CON',
    requiredValue: 10,
    requiredWeapon: ['shield'],
    mpCost: 3,
    hpCost: 0,
    range: 0,
    positionRequirement: ['front', 'mid', 'back'],
    requiresTarget: false,
    targetRequirement: 'self',
    cooldown: 3,
    apply: (attacker) => {
      return { selfBuff: { damageReduction: 0.15, duration: 1 } };
    },
    description: 'Brace for impact, reducing damage taken until your next turn.'
  },

  'guard': {
    id: 'guard',
    name: 'Guard',
    type: 'class',
    actionCost: 'class',
    mpCost: 0,
    hpCost: 0,
    range: 0,
    positionRequirement: ['front', 'mid', 'back'],
    requiresTarget: false,
    targetRequirement: 'self',
    cooldown: 2,
    apply: (attacker) => {
      // Returns a self-buff payload; you can wire an actual buff system later.
      return { selfBuff: { damageReduction: 0.25, duration: 1 } };
    },
    description: 'Raise guard to reduce incoming damage until next turn.'
  },



  //////////////NEW ELEMENTAL TEST SKILLS////////////////
  // === 1H SWORD ===
  'chilling_slice': {             //TESTINGTESTING
    id: 'chilling_slice',
    name: 'Chilling Slice',
    type: 'weapon',
    actionCost: 'major',
    requiredStat: 'DEX',
    requiredValue: 12,
    requiredWeapon: ['sword_1h'],
    mpCost: 0,
    hpCost: 0,
    range: 1,
    positionRequirement: ['front', 'mid'],
    requiresTarget: true,
    targetRequirement: 'enemy',
    cooldown: 2,
    apply: (attacker, target) => {
      const r = calculateDamage(attacker, target);
      let amount = applyDamageModifiers(r.amount, attacker, target, { element: 'cold' });
      const tFire = target?.weakness?.tiers?.fire || 0;
      if (tFire >= 1) {                     // 🔸 Steam-ish synergy (easy version)
        amount = Math.floor(amount * 1.15); // +15% if already Singed/Ablaze
      }
      return { ...r, amount, isMagic: true, buildup: { cold: 600 }, synergy: { hint: 'steam_scald' } };
    },
    description: 'Quick cut that chills the target; extra bite vs burning targets.'
  },


  'runic_spark': {
    id: 'runic_spark',
    name: 'Runic Spark',
    type: 'weapon',
    actionCost: 'bonus',
    requiredStat: 'INT',
    requiredValue: 10,
    requiredWeapon: ['sword_1h'],
    mpCost: 4,
    hpCost: 0,
    range: 1,
    positionRequirement: ['front', 'mid'],
    requiresTarget: true,
    targetRequirement: 'enemy',
    cooldown: 1,
    apply: (attacker, target) => {
      const r = calculateDamage(attacker, target);
      let amount = applyDamageModifiers(r.amount, attacker, target, { element: 'lightning' });
      const tCold = target?.weakness?.tiers?.cold || 0;
      if (tCold === 2) {                    // 🔹 Thermal Shock (easy version)
        amount = Math.floor(amount * 1.30); // +30% if Frozen
        return { ...r, amount, isMagic: true, buildup: { lightning: 60 }, synergy: { thermal_shock: true, consumeWeakness: ['cold'] } };
      }
      return { ...r, amount, isMagic: true, buildup: { lightning: 60 } };
    },
    description: 'Arc-charged slash that builds Lightning; heavily punishes Frozen foes.'
  },

  'goading_pommel': {
    id: 'goading_pommel',
    name: 'Goading Pommel',
    type: 'weapon',
    actionCost: 'major',
    requiredStat: 'CHA',
    requiredValue: 12,
    requiredWeapon: ['sword_1h'],
    mpCost: 0,
    hpCost: 0,
    range: 1,
    positionRequirement: ['front', 'mid'],
    requiresTarget: true,
    targetRequirement: 'enemy',
    cooldown: 2,
    apply: (attacker, target) => {
      const r = calculateDamage(attacker, target);
      return { ...r, daze: 1 }; // simple control; no element (easy test filler)
    },
    description: 'Blunt strike to rattle the foe.'
  },

  // === SLING ===
  'searing_pitch': {
    id: 'searing_pitch',
    name: 'Searing Pitch',
    type: 'weapon',
    actionCost: 'major',
    requiredStat: 'INT',
    requiredValue: 12,
    requiredWeapon: ['sling'],
    mpCost: 0,
    hpCost: 0,
    range: 3,
    positionRequirement: ['mid', 'back'],
    requiresTarget: true,
    targetRequirement: 'enemy',
    cooldown: 2,
    apply: (attacker, target) => {
      const r = calculateDamage(attacker, target);
      let amount = applyDamageModifiers(r.amount, attacker, target, { element: 'fire' });
      const tCold = target?.weakness?.tiers?.cold || 0;
      let buildup = 60;
      if (tCold >= 1) {                      // 🔸 Steam Scald (easy): more burn if chilled/frozen
        amount = Math.floor(amount * 1.20);
        buildup += 20;
      }
      return { ...r, amount, isMagic: true, buildup: { fire: buildup }, synergy: { steam_scald: tCold >= 1 } };
    },
    description: 'Sticky, burning shot. Extra scorch on chilled foes.'
  },

  'frost_pebble': {
    id: 'frost_pebble',
    name: 'Frost Pebble',
    type: 'weapon',
    actionCost: 'bonus',
    requiredStat: 'WIS',
    requiredValue: 12,
    requiredWeapon: ['sling'],
    mpCost: 0,
    hpCost: 0,
    range: 3,
    positionRequirement: ['mid', 'back'],
    requiresTarget: true,
    targetRequirement: 'enemy',
    cooldown: 1,
    apply: (attacker, target) => {
      const r = calculateDamage(attacker, target);
      const amount = applyDamageModifiers(r.amount, attacker, target, { element: 'cold' });
      return { ...r, amount, isMagic: true, buildup: { cold: 50 } };
    },
    description: 'A chilling lob that builds Cold.'
  },

  'thunder_skip': {
    id: 'thunder_skip',
    name: 'Thunder Skip',
    type: 'weapon',
    actionCost: 'major',
    requiredStat: 'DEX',
    requiredValue: 14,
    requiredWeapon: ['sling'],
    mpCost: 0,
    hpCost: 0,
    range: 3,
    positionRequirement: ['mid', 'back'],
    requiresTarget: true,
    targetRequirement: 'enemy',
    cooldown: 2,
    apply: (attacker, target) => {
      const r = calculateDamage(attacker, target);
      let amount = applyDamageModifiers(r.amount, attacker, target, { element: 'lightning' });
      const tFire = target?.weakness?.tiers?.fire || 0;
      if (tFire === 2) {                      // 🔹 Third-Degree Burn (easy): surge damage on Ablaze
        amount = Math.floor(amount * 1.20);
      }
      return { ...r, amount, isMagic: true, buildup: { lightning: 60 }, bounce: true, synergy: { third_degree_burn: tFire === 2 } };
    },
    description: 'Charged shot that arcs to a second target; bites harder on Ablaze foes.'
  },

  // === 2H AXE ===
  'ember_cleave': {
    id: 'ember_cleave',
    name: 'Ember Cleave',
    type: 'weapon',
    actionCost: 'major',
    requiredStat: 'STR',
    requiredValue: 12,
    requiredWeapon: ['axe_2h'],
    mpCost: 3,
    hpCost: 0,
    range: 1,
    positionRequirement: ['front'],
    requiresTarget: true,
    targetRequirement: 'enemy',
    cooldown: 2,
    apply: (attacker, target) => {
      const r = calculateDamage(attacker, target);
      let amount = applyDamageModifiers(r.amount, attacker, target, { element: 'fire' });
      const tCold = target?.weakness?.tiers?.cold || 0;
      let buildup = 60;
      if (tCold >= 1) {                       // 🔸 Steam Scald (easy)
        amount = Math.floor(amount * 1.15);
        buildup += 20;
      }
      return { ...r, amount, isMagic: true, buildup: { fire: buildup }, cleave: { adjacentFactor: 0.5 }, synergy: { steam_scald: tCold >= 1 } };
    },
    description: 'Fiery chop that singes a neighbor; stronger vs Chilled/Frozen.'
  },

  'rime_chop': {
    id: 'rime_chop',
    name: 'Rime Chop',
    type: 'weapon',
    actionCost: 'major',
    requiredStat: 'CON',
    requiredValue: 12,
    requiredWeapon: ['axe_2h'],
    mpCost: 0,
    hpCost: 0,
    range: 1,
    positionRequirement: ['front'],
    requiresTarget: true,
    targetRequirement: 'enemy',
    cooldown: 3,
    apply: (attacker, target) => {
      const r = calculateDamage(attacker, target);
      let amount = applyDamageModifiers(r.amount, attacker, target, { element: 'cold' });
      const tCold = target?.weakness?.tiers?.cold || 0;
      if (tCold === 2) amount = Math.floor(amount * 1.50); // brittle shatter (easy version)
      return { ...r, amount, isMagic: true, buildup: { cold: 60 }, synergy: { brittle: tCold === 2 } };
    },
    description: 'Cold-laden chop; devastates Frozen foes.'
  },

  'storm_splitter': {
    id: 'storm_splitter',
    name: 'Storm Splitter',
    type: 'weapon',
    actionCost: 'major',
    requiredStat: 'CHA',
    requiredValue: 12,
    requiredWeapon: ['axe_2h'],
    mpCost: 0,
    hpCost: 0,
    range: 1,
    positionRequirement: ['front'],
    requiresTarget: true,
    targetRequirement: 'enemy',
    cooldown: 3,
    apply: (attacker, target) => {
      const r = calculateDamage(attacker, target);
      let amount = applyDamageModifiers(r.amount, attacker, target, { element: 'lightning' });
      const tCold = target?.weakness?.tiers?.cold || 0;
      if (tCold >= 1) amount = Math.floor(amount * 1.25); // thermal shock flavor (easy)
      return { ...r, amount, isMagic: true, buildup: { lightning: 70 } };
    },
    description: 'Thunderous cleave that builds Lightning; bonus vs Chilled/Frozen.'
  },


  'searing_brand': {
    id: 'searing_brand',
    name: 'Searing Brand',
    type: 'weapon',
    actionCost: 'major',
    requiredStat: 'INT',
    requiredValue: 12,
    requiredWeapon: ['sword_2h'],
    mpCost: 3,
    hpCost: 0,
    range: 1,
    positionRequirement: ['front'],
    requiresTarget: true,
    targetRequirement: 'enemy',
    cooldown: 2,
    apply: (attacker, target) => {
      const r = calculateDamage(attacker, target);
      let amount = applyDamageModifiers(r.amount, attacker, target, { element: 'fire' });
      const tCold = target?.weakness?.tiers?.cold || 0;
      if (tCold >= 1) amount = Math.floor(amount * 1.20);
      return {
        ...r, amount,
        buildup: { fire: 60 },
        // turns freeze → steam path later if you want to consume
        consumeWeakness: (tCold === 2) ? ['cold'] : undefined,
        rewardIfTierCross: [{ family: 'fire', tier: 2, healMP: 3 }]
      };
    },
    description: 'Engraves a burning sigil; stronger on chilled targets.'
  },

  'column_rally': {
    id: 'column_rally',
    name: 'Column Rally',
    type: 'weapon',
    actionCost: 'bonus',
    requiredStat: 'CHA',
    requiredValue: 12,
    requiredWeapon: ['sword_2h'],
    mpCost: 0,
    hpCost: 0,
    range: 0,
    positionRequirement: ['front', 'mid'],
    requiresTarget: false,
    targetRequirement: null,
    cooldown: 3,
    apply: (attacker) => {
      return {
        teamBuff: {
          scope: 'column',
          effect: { id: 'rally', turns: 2, atkMul: 1.10, accBonus: 5 }
        }
      };
    },
    description: 'Bolster allies in your column, raising attack and accuracy.'
  },

  'flaying_strike': {
    id: 'flaying_strike',
    name: 'Flaying Strike',
    type: 'weapon',
    mechanic: 'active',
    actionCost: 'major',
    requiredStat: 'STR',
    requiredValue: 12,
    requiredWeapon: ['sword_1h'],   // safe existing type in your data
    mpCost: 0,
    hpCost: 0,
    positionRequirement: ['front'],
    requiresTarget: true,
    targetRequirement: 'enemy',
    targetColumns: ['front'],
    cooldown: 1,
    tags: ['attack', 'melee', 'physical'],
    apply: (attacker, target) => {
      const r = calculateDamage(attacker, target);
      const amount = applyDamageModifiers(r.amount, attacker, target);
      return { ...r, amount, isMagic: false, buildup: { expose: 600 } };
    },
    description: 'Hard strip-and-slash that exposes defenses. (Overtuned test: big EXPOSE buildup)'
  },

  'venom_shot': {
    id: 'venom_shot',
    name: 'Venom Shot',
    type: 'weapon',
    mechanic: 'active',
    actionCost: 'major',
    requiredStat: 'DEX',
    requiredValue: 12,
    requiredWeapon: ['bow'],
    mpCost: 0,
    hpCost: 0,
    positionRequirement: ['mid', 'back'],
    requiresTarget: true,
    targetRequirement: 'enemy',
    targetColumns: ['front', 'mid', 'back'],
    cooldown: 1,
    tags: ['attack', 'ranged', 'physical'],
    apply: (attacker, target) => {
      const r = calculateDamage(attacker, target);
      const amount = applyDamageModifiers(r.amount, attacker, target);
      // IMPORTANT: canonical key is 'toxic' (alias 'poison' maps to 'toxic' too, but use 'toxic' here)
      return { ...r, amount, isMagic: false, buildup: { toxic: 600 } };
    },
    description: 'Poisoned arrow for testing TOXIC buildup (overtuned).'
  },

  'plague_slam': {
    id: 'plague_slam',
    name: 'Plague Slam',
    type: 'weapon',
    mechanic: 'active',
    actionCost: 'major',
    requiredStat: 'STR',
    requiredValue: 10,
    requiredWeapon: ['mace_2h'],
    mpCost: 0,
    hpCost: 0,
    positionRequirement: ['front'],
    requiresTarget: true,
    targetRequirement: 'enemy',
    targetColumns: ['front'],
    cooldown: 2,
    tags: ['attack', 'melee', 'physical'],
    apply: (attacker, target) => {
      const r = calculateDamage(attacker, target);
      const amount = applyDamageModifiers(r.amount, attacker, target);
      return { ...r, amount, isMagic: false, buildup: { disease: 600 } };
    },
    description: 'Filthy overhead slam to test DISEASE buildup (overtuned).'
  },

  'hex_bolt': {
    id: 'hex_bolt',
    name: 'Hex Bolt',
    type: 'weapon',
    mechanic: 'active',
    actionCost: 'bonus',
    requiredStat: 'INT',
    requiredValue: 14,
    requiredWeapon: ['wand'],
    mpCost: 6,
    hpCost: 0,
    positionRequirement: ['mid', 'back'],
    requiresTarget: true,
    targetRequirement: 'enemy',
    targetColumns: ['mid', 'back'],
    cooldown: 1,
    tags: ['magic', 'single'],
    apply: (attacker, target) => {
      const r = calculateDamage(attacker, target);
      let amount = applyDamageModifiers(r.amount, attacker, target);
      return { ...r, amount, isMagic: true, buildup: { curse: 600 } };
    },
    description: 'Quick malediction for CURSE buildup testing (overtuned).'
  },

  curse_surge: {          //TESTINGTESTING COST BUILDUP
    id: 'curse_surge',
    name: 'Curse Surge',
    type: 'weapon',
    mechanic: 'active',
    actionCost: 'major',
    requiredStat: 'INT',
    requiredValue: 12,
    requiredWeapon: ['staff'],
    mpCost: 1,
    requiresTarget: true,
    targetRequirement: 'enemy',
    targetColumns: ['front', 'mid', 'back'],
    cooldown: 1,
    tags: ['magic', 'single', 'curse', 'necrotic'],
    apply: (attacker, target, scene) => {
      const base = 8 + ((attacker.INT | 0) >> 1);
      const amount = applyDamageModifiers(base, attacker, target, { isMagic: true, element: 'necrotic' });
      return { amount, isMagic: true, element: 'necrotic', dealsDamage: true, buildup: { curse: 700 } };
    },
    description: 'A heavy malediction that surges the CURSE meter.'
  },


  curse_cinders: {            //TESTINGTESTING COST BUILDUP
    id: 'curse_cinders',
    name: 'Curse of Cinders',
    type: 'weapon',
    mechanic: 'active',
    actionCost: 'major',
    requiredStat: 'INT',
    requiredValue: 14,
    requiredWeapon: ['staff'],
    mpCost: 1,
    requiresTarget: true,
    targetRequirement: 'enemy',
    targetColumns: ['front', 'mid', 'back'],
    cooldown: 2,
    tags: ['magic', 'single', 'curse', 'necrotic'],
    minCurseTier: 1, // ← gate: Hexed (T1)+
    apply: (attacker, target, scene) => {
      // Gate: must be Hexed/Afflicted NOW
      const mCur = target?.weakness?.meters?.curse | 0;
      if (mCur < 100) {
        scene?._log?.(`${target.name} is not Hexed; Curse of Cinders fails.`);
        return { amount: 0, dealsDamage: false };
      }

      // Tiny poke so it feels like a spell, but not a nuke
      const base = 6 + ((attacker.INT | 0) >> 3);
      let amount = applyDamageModifiers(base, attacker, target, { isMagic: true, element: 'necrotic', tags: ['curse'] });

      // Apply status for fixed duration (3). Store source in case you later want caster-based crit params.
      target.statuses = target.statuses || {};
      target.statuses.curse_cinders = { id: 'curse_cinders', turns: 3, sourceId: attacker.id ?? null };
      scene?._log?.(`${target.name} is wreathed in Cinders (3 turns).`);

      // Light self-synergy: small CURSE bump so overflow slowly grows; avoid force-setting Ablaze here
      const addCurse = 60; // modest +60 (tune as you like)

      return {
        amount,
        isMagic: true,
        element: 'necrotic',
        dealsDamage: true,
        buildup: { curse: addCurse }
      };
    },

    description: 'Afflicts the target with Cinders; adds CURSE and FIRE buildup that scales with CURSE intensity.'
  },



  'earthshatter': {
    id: 'earthshatter',
    name: 'Earthshatter',
    type: 'weapon',
    actionCost: 'major',
    requiredStat: 'STR',
    requiredValue: 16,
    requiredWeapon: ['mace_2h'],
    mpCost: 0,
    hpCost: 0,
    range: 1,
    positionRequirement: ['front'],
    requiresTarget: true,
    targetRequirement: 'enemy',
    cooldown: 3,
    apply: (attacker, target) => {
      const r = calculateDamage(attacker, target);
      // pure physical, but rewards when you push any element to T2
      return {
        ...r,
        rewardIfTierCross: [{ family: 'any', tier: 2, healHPpct: 0.05 }]
      };
    },
    description: 'Crushing blow; if this push hits an elemental threshold, you siphon life.'
  },

  'sanctified_slam': {
    id: 'sanctified_slam',
    name: 'Sanctified Slam',
    type: 'weapon',
    actionCost: 'major',
    requiredStat: 'WIS',
    requiredValue: 12,
    requiredWeapon: ['mace_2h'],
    mpCost: 2,
    hpCost: 0,
    range: 1,
    positionRequirement: ['front'],
    requiresTarget: true,
    targetRequirement: 'enemy',
    cooldown: 2,
    apply: (attacker, target) => {
      const r = calculateDamage(attacker, target);
      let amount = r.amount;
      const tLightning = target?.weakness?.tiers?.lightning || 0;
      if (tLightning >= 1) amount = Math.floor(amount * 1.15);
      return {
        ...r, amount,
        buildup: { lightning: 40 },
        rewardIfWeak: { family: 'lightning', tierAtLeast: 1, healMP: 3 }
      };
    },
    description: 'Blessed impact that restores MP when striking a charged foe.'
  },
  'hailspike_stab': {
    id: 'hailspike_stab',
    name: 'Hailspike Stab',
    type: 'weapon',
    actionCost: 'major',
    requiredStat: 'DEX',
    requiredValue: 12,
    requiredWeapon: ['dagger'],
    mpCost: 0,
    hpCost: 0,
    range: 1,
    positionRequirement: ['front', 'mid'],
    requiresTarget: true,
    targetRequirement: 'enemy',
    cooldown: 1,
    apply: (attacker, target) => {
      const r = calculateDamage(attacker, target);
      const amount = applyDamageModifiers(r.amount, attacker, target, { element: 'cold' });
      return { ...r, amount, buildup: { cold: 50 } };
    },
    description: 'Quick cold-infused puncture.'
  },

  'arterial_feint': {
    id: 'arterial_feint',
    name: 'Arterial Feint',
    type: 'weapon',
    actionCost: 'bonus',
    requiredStat: 'CHA',
    requiredValue: 12,
    requiredWeapon: ['dagger'],
    mpCost: 0,
    hpCost: 0,
    range: 1,
    positionRequirement: ['front', 'mid'],
    requiresTarget: true,
    targetRequirement: 'enemy',
    cooldown: 2,
    apply: (attacker, target) => {
      const r = calculateDamage(attacker, target);
      // light hit but good payoff if target is Ablaze (pressure burst theme)
      return {
        ...r,
        rewardIfWeak: { family: 'fire', tierAtLeast: 1, healHPpct: 0.03 }
      };
    },
    description: 'Deceptive cut; siphons HP from burning foes.'
  },

  'gust_lash': {
    id: 'gust_lash',
    name: 'Gust Lash',
    type: 'weapon',
    actionCost: 'major',
    requiredStat: 'DEX',
    requiredValue: 12,
    requiredWeapon: ['whip'],
    mpCost: 0,
    hpCost: 0,
    range: 2,
    positionRequirement: ['front', 'mid'],
    requiresTarget: true,
    targetRequirement: 'enemy',
    cooldown: 2,
    apply: (attacker, target) => {
      const r = calculateDamage(attacker, target);
      // Apply a “wind-exposed” debuff; amplifies fire/lightning buildup from any source
      target.statusEffects = target.statusEffects || [];
      target.statusEffects.push({ id: 'wind_exposed', turns: 2, fireBuildupMul: 1.25, lightningBuildupMul: 1.25 });
      return { ...r };
    },
    description: 'A cutting snap that leaves the foe vulnerable to fire and lightning.'
  },

  'scorch_crack': {
    id: 'scorch_crack',
    name: 'Scorch Crack',
    type: 'weapon',
    actionCost: 'major',
    requiredStat: 'INT',
    requiredValue: 12,
    requiredWeapon: ['whip'],
    mpCost: 2,
    hpCost: 0,
    range: 2,
    positionRequirement: ['front', 'mid'],
    requiresTarget: true,
    targetRequirement: 'enemy',
    cooldown: 2,
    apply: (attacker, target) => {
      const r = calculateDamage(attacker, target);
      let amount = applyDamageModifiers(r.amount, attacker, target, { element: 'fire' });
      const tCold = target?.weakness?.tiers?.cold || 0;
      if (tCold >= 1) amount = Math.floor(amount * 1.20);
      return { ...r, amount, buildup: { fire: 60 } };
    },
    description: 'A fiery lash that sears worse on chilled foes.'
  },

  'soothing_arrow': {
    id: 'soothing_arrow',
    name: 'Soothing Arrow',
    type: 'weapon',
    actionCost: 'major',
    requiredStat: 'DEX',
    requiredValue: 16,
    requiredWeapon: ['bow'],
    mpCost: 0,
    hpCost: 0,
    range: 3,
    positionRequirement: ['mid', 'back'],
    requiresTarget: true,
    targetRequirement: 'enemy',
    cooldown: 2,
    apply: (attacker, target) => {
      const r = calculateDamage(attacker, target);
      return {
        ...r,
        rewardIfWeak: { family: 'cold', tierAtLeast: 1, healHPpct: 0.04 }, // off-meta dex heal
        buildup: { cold: 40 }
      };
    },
    description: 'A calming shot; heals you when striking a chilled foe.'
  },

  'hail_volley': {
    id: 'hail_volley',
    name: 'Hail Volley',
    type: 'weapon',
    actionCost: 'major',
    requiredStat: 'WIS',
    requiredValue: 12,
    requiredWeapon: ['bow'],
    mpCost: 2,
    hpCost: 0,
    range: 3,
    positionRequirement: ['mid', 'back'],
    requiresTarget: true,
    targetRequirement: 'enemy',
    cooldown: 3,
    apply: (attacker, target) => {
      const r = calculateDamage(attacker, target);
      const amount = applyDamageModifiers(r.amount, attacker, target, { element: 'cold' });
      return { ...r, amount, buildup: { cold: 60 }, splashTargets: 1 };
    },
    description: 'Cold-tipped volley that can catch a nearby foe.'
  },

  'capacitor_round': {
    id: 'capacitor_round',
    name: 'Capacitor Round',
    type: 'weapon',
    actionCost: 'major',
    requiredStat: 'INT',
    requiredValue: 12,
    requiredWeapon: ['gun'],
    mpCost: 0,
    hpCost: 0,
    range: 3,
    positionRequirement: ['mid', 'back'],
    requiresTarget: true,
    targetRequirement: 'enemy',
    cooldown: 2,
    apply: (attacker, target) => {
      const r = calculateDamage(attacker, target);
      let amount = applyDamageModifiers(r.amount, attacker, target, { element: 'lightning' });
      const t = target?.weakness?.tiers?.lightning || 0;
      if (t === 2) {
        // cash out the battery
        return {
          ...r, amount,
          consumeWeakness: ['lightning'],
          statusEffects: [{ id: 'stunned', turns: 1 }],
          rewardIfTierCross: [{ family: 'lightning', tier: 2, healMP: 4 }]
        };
      }
      return { ...r, amount, buildup: { lightning: 60 } };
    },
    description: 'Charges the target; if fully charged, discharges to stun and restore MP.'
  },

  'incendiary_shot': {
    id: 'incendiary_shot',
    name: 'Incendiary Shot',
    type: 'weapon',
    actionCost: 'major',
    requiredStat: 'STR',
    requiredValue: 12,
    requiredWeapon: ['gun'],
    mpCost: 0,
    hpCost: 0,
    range: 3,
    positionRequirement: ['mid', 'back'],
    requiresTarget: true,
    targetRequirement: 'enemy',
    cooldown: 3,
    apply: (attacker, target) => {
      const r = calculateDamage(attacker, target);
      const amount = applyDamageModifiers(r.amount, attacker, target, { element: 'fire' });
      return {
        ...r, amount, buildup: { fire: 50 },
        slotEffect: { id: 'burning_ground', element: 'fire', buildup: 20, tickPctMaxHP: 0.02, turns: 2 }
      };
    },
    description: 'Ignites the target’s tile with burning ground.'
  },


  'conduction_bolt': {                //TESTINGTESING
    id: 'conduction_bolt',
    name: 'Conduction Bolt',
    type: 'weapon',
    actionCost: 'bonus',
    requiredStat: 'INT',
    requiredValue: 10,
    requiredWeapon: ['wand'],
    mpCost: 3,
    hpCost: 0,
    range: 3,
    positionRequirement: ['mid', 'back'],
    requiresTarget: true,
    targetRequirement: 'enemy',
    cooldown: 1,
    apply: (attacker, target) => {
      const r = calculateDamage(attacker, target);
      const amount = applyDamageModifiers(r.amount, attacker, target, { element: 'lightning' });
      return { ...r, amount, buildup: { lightning: 500 } };
    },
    description: 'A precise arc that builds Lightning.'
  },

  'warmth': {
    id: 'warmth',
    name: 'Warmth',
    type: 'weapon',
    actionCost: 'major',
    requiredStat: 'WIS',
    requiredValue: 14,
    requiredWeapon: ['wand'],
    mpCost: 4,
    hpCost: 0,
    range: 3,
    positionRequirement: ['mid', 'back'],
    requiresTarget: true,
    targetRequirement: 'ally',
    cooldown: 2,
    apply: (attacker, ally) => {
      const maxHP = Math.max(1, ally.maxHP || 1);
      const heal = Math.floor(maxHP * 0.18);
      ally.currentHP = Math.min(ally.maxHP || heal, (ally.currentHP || 0) + heal);
      return { heal: heal };
    },
    description: 'Restore a moderate amount of HP to an ally.'
  },
  'ember_ward': {
    id: 'ember_ward',
    name: 'Ember Ward',
    type: 'weapon',
    actionCost: 'bonus',
    requiredStat: 'WIS',
    requiredValue: 12,
    requiredWeapon: ['staff'],
    mpCost: 2,
    hpCost: 0,
    range: 0,
    positionRequirement: ['mid', 'back', 'front'],
    requiresTarget: false,
    targetRequirement: null,
    cooldown: 3,
    apply: (attacker) => {
      return {
        teamBuff: {
          scope: 'column',
          effect: { id: 'ember_ward', turns: 2, fireResBonus: 0.2 }
        }
      };
    },
    description: 'Protect your column with resistance to fire.'
  },

  'glacier_wall': {
    id: 'glacier_wall',
    name: 'Glacier Wall',
    type: 'weapon',
    actionCost: 'major',
    requiredStat: 'INT',
    requiredValue: 14,
    requiredWeapon: ['staff'],
    mpCost: 3,
    hpCost: 0,
    range: 3,
    positionRequirement: ['mid', 'back'],
    requiresTarget: true,
    targetRequirement: 'enemy',
    cooldown: 3,
    apply: (attacker, target) => {
      const r = calculateDamage(attacker, target);
      const amount = applyDamageModifiers(r.amount, attacker, target, { element: 'cold' });
      return {
        ...r, amount, buildup: { cold: 60 },
        slotEffect: { id: 'ice_slick', element: 'cold', buildup: 15, tickPctMaxHP: 0.0, turns: 2 }
      };
    },
    description: 'Erects frigid terrain on the target’s tile; stacks Cold.'
  },

  'shield_bash': {
    id: 'shield_bash',
    name: 'Shield Bash',
    type: 'weapon',
    actionCost: 'major',
    requiredStat: 'STR',
    requiredValue: 10,
    requiredWeapon: ['shield'],
    mpCost: 0,
    hpCost: 0,
    range: 1,
    positionRequirement: ['front'],
    requiresTarget: true,
    targetRequirement: 'enemy',
    cooldown: 2,
    apply: (attacker, target) => {
      const r = calculateDamage(attacker, target);
      const t = target?.weakness?.tiers?.lightning || 0;
      const statusEffects = (t >= 1) ? [{ id: 'stunned', turns: 1 }] : undefined;
      return { ...r, statusEffects };
    },
    description: 'A concussive slam; charged foes may be stunned.'
  },

  'bulwark_column': {
    id: 'bulwark_column',
    name: 'Bulwark Column',
    type: 'weapon',
    actionCost: 'bonus',
    requiredStat: 'CON',
    requiredValue: 12,
    requiredWeapon: ['shield'],
    mpCost: 0,
    hpCost: 0,
    range: 0,
    positionRequirement: ['front'],
    requiresTarget: false,
    targetRequirement: null,
    cooldown: 3,
    apply: (attacker) => {
      return {
        teamBuff: {
          scope: 'column',
          effect: { id: 'bulwark', turns: 2, physResBonus: 0.2 }
        }
      };
    },
    description: 'Brace your column, raising physical resistance.'
  },


  'grounding_pierce': {
    id: 'grounding_pierce',
    name: 'Grounding Pierce',
    type: 'weapon',
    actionCost: 'major',
    requiredStat: 'WIS',
    requiredValue: 12,
    requiredWeapon: ['spear_1h'],
    mpCost: 0,
    hpCost: 0,
    range: 1,
    positionRequirement: ['front', 'mid'],
    requiresTarget: true,
    targetRequirement: 'enemy',
    cooldown: 2,
    apply: (attacker, target) => {
      const r = calculateDamage(attacker, target);
      let amount = r.amount;
      const t = target?.weakness?.tiers?.lightning || 0;
      if (t === 2) return { ...r, amount, consumeWeakness: ['lightning'], statusEffects: [{ id: 'stunned', turns: 1 }] };
      return { ...r, amount, buildup: { lightning: 40 } };
    },
    description: 'Pins current through the foe; fully charged targets are stunned and discharged.'
  },

  'glacial_thrust': {
    id: 'glacial_thrust',
    name: 'Glacial Thrust',
    type: 'weapon',
    actionCost: 'major',
    requiredStat: 'DEX',
    requiredValue: 12,
    requiredWeapon: ['spear_1h'],
    mpCost: 0,
    hpCost: 0,
    range: 1,
    positionRequirement: ['front', 'mid'],
    requiresTarget: true,
    targetRequirement: 'enemy',
    cooldown: 1,
    apply: (attacker, target) => {
      const r = calculateDamage(attacker, target);
      const amount = applyDamageModifiers(r.amount, attacker, target, { element: 'cold' });
      return {
        ...r, amount, buildup: { cold: 50 },
        rewardIfTierCross: [{ family: 'cold', tier: 2, healHPpct: 0.03 }]
      };
    },
    description: 'Cold-driven thrust that rewards you for freezing the enemy.'
  },

  //////////////////////////////////////

  // --- Movement (unified) ---
  'move_step': {
    id: 'move_step',
    name: 'Step',
    type: 'special',
    actionCost: 'bonus',
    cooldown: 2,              // H/D/E racial movement
    requiresTarget: true,         // <-- select a destination
    targetRequirement: 'position',       // <-- custom: we’ll handle in CombatScene
    isMovement: true,             // <-- flag to skip damage pipeline
    moveRange: 1,  // Chebyshev distance budget
    apply(user, destSlot, scene) {
      // Safety: ignore bad/occupied slots
      if (!destSlot || destSlot.occupied) return {};
      scene.moveToPosition(user, destSlot);
      scene._log?.(`${user.name} repositions.`);
      return {};
    }
  },

  'move_dash': {
    id: 'move_dash',
    name: 'Dash',
    type: 'special',
    actionCost: 'bonus',
    cooldown: 3,              // Ferrow/Wylett/Skith
    requiresTarget: true,
    targetRequirement: 'position',
    isMovement: true,
    moveRange: 2,
    apply(user, destSlot, scene) {
      if (!destSlot || destSlot.occupied) return {};
      scene.moveToPosition(user, destSlot);
      scene._log?.(`${user.name} rushes to a new position.`);
      return {};
    }
  },



  //////Training Enemies

  'dummy_shuffle': {
    id: 'dummy_shuffle',
    name: 'Shuffle',
    type: 'special',
    actionCost: 'bonus',
    mpCost: 0,
    hpCost: 0,
    range: 0,
    positionRequirement: ['front', 'mid', 'back'],
    requiresTarget: false,          // ← movement shouldn’t force a target
    targetRequirement: 'position',
    isMovement: true,
    cooldown: 0,                    // ← no cooldown
    apply: (attacker, _target, scene) => {
      const moved = scene._enemyTryShuffleOneColumn(attacker);
      if (moved) scene._log?.(`${attacker.name} shuffles position.`);
      return { amount: 0, moved };
    },
  },

  'dummy_sway': {
    id: 'dummy_sway',
    name: 'Sway',
    type: 'class',
    actionCost: 'major',            // consumes the turn
    mpCost: 0, hpCost: 0, range: 0,
    positionRequirement: ['front', 'mid', 'back'],
    requiresTarget: false,
    targetRequirement: 'none',
    cooldown: 0,
    apply: (attacker, _target, scene) => {
      scene._log?.(`${attacker.name} sways. A slight breeze blows...`);
      return { amount: 0 };
    },
    description: 'Idles theatrically, consuming time.'
  },


  'step_forward': {
    id: 'step_forward',
    name: 'Step Forward',
    type: 'special',
    actionCost: 'bonus',
    mpCost: 0, hpCost: 0, range: 0,
    positionRequirement: ['mid', 'back', 'front'],
    requiresTarget: false,
    targetRequirement: 'position',
    isMovement: true,
    cooldown: 2,
    apply: (attacker, _target, scene) => {
      const moved = scene._enemyTryStepTowardFront?.(attacker);
      if (moved) scene._log?.(`${attacker.name} steps forward.`);
      return { moved, amount: 0 };
    },
    description: 'Advance one column toward the front if space exists.'
  },
};

// ===============================
// v3.2 — Dagger skills (13) — injected directly; no wrapper const
// Notes: no `range`; tooltip helpers via `buildupHint`/`aoe`; event scaffolding inert.
// ===============================
Object.assign(SKILLS, {

  // -------- Generation (7) --------
  'needle_feint': {
    id: "needle_feint",
    name: "Needle Feint",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["dagger"],
    requiredStat: "DEX",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "expose"],
    emitTagsOnUse: ["feint"],
    // tooltip
    buildupHint: { expose: 60 },
    // reward on tier cross
    rewardIfTierCross: [{ family: "expose", tier: 1, buff: { critChanceBonusPct: 10, turns: 1 } }],
    description: "Quick stab that exposes a weakness; crossing T1 grants brief crit."
  },

  'needle_venom': {
    id: "needle_venom",
    name: "Needle Venom",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["dagger"],
    requiredStat: "DEX",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "toxic"],
    buildupHint: { toxic: 70 },
    rewardIfWeak: { family: "expose", tierAtLeast: 1, buff: { addBuildup: { toxic: 30 } } },
    description: "Reliable poison builder; stronger if the target is Exposed."
  },

  'pressure_point': {
    id: "pressure_point",
    name: "Pressure Point",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["dagger"],
    requiredStat: "DEX",
    requiredValue: 16,
    actionCost: "bonus",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "expose"],
    buildupHint: { expose: 80 },
    rewardIfTierCross: [{ family: "expose", tier: 2, buff: { nextSkillDamagePct: 20, turns: 1 } }],
    description: "Precise strike that ramps Expose; hitting T2 buffs your next skill this turn."
  },

  'ghoststep': {
    id: "ghoststep",
    name: "Ghoststep",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["dagger"],
    requiredStat: "CHA",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 4,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["stealth", "support"],
    statusEffects: [{ id: "stealth", turns: 1 }],
    rewardIfWeak: { family: "expose", tierAtLeast: 1, buff: { evasionPct: 10, turns: 1, scope: "selfNearExposed" } },
    description: "Slip into stealth; standing near Exposed foes grants extra evasion."
  },

  'hex_stitch': {
    id: "hex_stitch",
    name: "Hex Stitch",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["dagger"],
    requiredStat: "INT",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["curse", "magic", "attack"],
    buildupHint: { curse: 60 },
    aoe: { shape: "circle", scale: 1 }, // “adjacent” in your tooltip
    proliferateWeakness: { families: ["curse"], to: "adjacent", ratio: 0.5, maxTargets: 2 },
    description: "Applies lingering Curse; spreads half the current Curse to nearby enemies."
  },

  'static_prick': {
    id: "static_prick",
    name: "Static Prick",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["dagger"],
    requiredStat: "DEX",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lightning"],
    buildupHint: { lightning: 60 },
    rewardIfWeak: { family: "lightning", tierAtLeast: 1, buff: { chanceExtraHitPct: 25 } },
    description: "Seeds Shock; against Shocked foes, chance to add a bonus light hit."
  },

  'street_panacea': {
    id: "street_panacea",
    name: "Street Panacea",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["dagger"],
    requiredStat: "CHA",
    requiredValue: 15,
    actionCost: "bonus",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "ally",
    tags: ["support", "mp", "cleanse"],
    description: "Restore small MP to self/ally; a bit more if any nearby enemy is Diseased."
  },

  // -------- Payoff (6) --------
  'heartpiercer': {
    id: "heartpiercer",
    name: "Heartpiercer",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["dagger"],
    requiredStat: "DEX",
    requiredValue: 18,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "execute"],
    requiresWeakness: { family: "expose", tierAtLeast: 1 },
    rewardIfWeak: { family: "expose", tierAtLeast: 2, buff: { critMultBonus: 0.5 } },
    description: "Heavy finisher usable only on Exposed targets; bigger crits at T2. Does not consume."
  },

  'venom_bloom': {
    id: "venom_bloom",
    name: "Venom Bloom",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["dagger"],
    requiredStat: "DEX",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "toxic", "consume"],
    requiresWeakness: { family: "toxic", tierAtLeast: 1 },
    consumeWeakness: ["toxic"],
    buildupHint: { toxic: 100 }, // for tooltip: intended consumption cap
    rewardIfWeak: { family: "toxic", tierAtLeast: 2, buff: { extraRapidTicks: 1 } },
    description: "Consume Toxic to trigger rapid DOT ticks (snapshot). Adds a 4th tick at T2."
  },

  'silent_order': {
    id: "silent_order",
    name: "Silent Order",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["dagger"],
    requiredStat: "CHA",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "stealth"],
    rewardIfWeak: { family: "expose", tierAtLeast: 1, buff: { damagePct: 15 } },
    description: "Stealth-friendly strike that hits harder when the target is Exposed. Does not consume Expose."
  },

  'curse_snap': {
    id: "curse_snap",
    name: "Curse Snap",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["dagger"],
    requiredStat: "INT",
    requiredValue: 18,
    actionCost: "major",
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["curse", "amplify", "magic"],
    requiresWeakness: { family: "curse", tierAtLeast: 1 },
    description: "For one turn, all Curse effects on the target tick twice (amplify only; no consume)."
  },

  'flash_overload': {
    id: "flash_overload",
    name: "Flash Overload",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["dagger"],
    requiredStat: "DEX",
    requiredValue: 17,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lightning", "amplify"],
    requiresWeakness: { family: "lightning", tierAtLeast: 1 },
    rewardIfWeak: { family: "lightning", tierAtLeast: 2, buff: { repeatStrikeOnce: true, repeatPowerPct: 60 } },
    description: "Requires Shocked target; at T2 repeats the strike once at reduced power."
  },

  'vein_tap': {
    id: "vein_tap",
    name: "Vein Tap",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["dagger"],
    requiredStat: "INT",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 8,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "transform"],
    requiresWeakness: { family: "lacerate", tierAtLeast: 1 },
    transformWeakness: { from: "lacerate", to: "toxic", ratio: 0.75 },
    buildupHint: { lacerate: 100 }, // tooltip: transform cap
    rewardIfWeak: { family: "expose", tierAtLeast: 1, buff: { addBuildup: { toxic: 30 } } },
    description: "Transforms Bleed into Poison and strikes; adds bonus Poison if the target is also Exposed."
  },

  //v3.2 1h sword skills - reactions pending 


  'marked_cut': {
    id: "marked_cut",
    name: "Marked Cut",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["sword_1h"],
    requiredStat: "DEX",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "expose"],
    emitTagsOnUse: ["slash"],
    buildupHint: { expose: 60 },
    description: "A quick slice that exposes a weakness for later exploitation."
  },

  'guarded_slash': {
    id: "guarded_slash",
    name: "Guarded Slash",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["sword_1h"],
    requiredStat: "STR",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "cold"],
    buildupHint: { cold: 60 },
    rewardIfTier: { family: "cold", tierAtLeast: 1, buff: { guardPct: 10, turns: 1 } },
    description: "A guarded swing that chills the foe while raising your guard."
  },

  'rhythm_blow': {
    id: "rhythm_blow",
    name: "Rhythm Blow",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["sword_1h"],
    requiredStat: "CHA",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack"],
    // inert chain metadata for later: restores MP when chained with a 1h sword skill last turn
    comboHint: { lastTurnWeapon: "sword_1h" },
    mpRestoreOnChain: 2,
    description: "A tempo-setter; keep the beat with a follow-up strike that restores MP when chained."
  },

  'soft_spot_exposed': {
    id: "soft_spot_exposed",
    name: "Soft Spot Exposed",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["sword_1h"],
    requiredStat: "STR",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "expose"],
    buildupHint: { expose: 60 },
    // If this hit increases Expose tier, make target more vulnerable to physical for a bit
    rewardIfTierCross: [{ family: "expose", tier: 2, debuff: { physicalVulnPct: 10, turns: 2 } }],
    description: "A strike that makes the target more vulnerable to physical damage."
  },

  'sword_flourish': {
    id: "sword_flourish",
    name: "Sword Flourish",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["sword_1h"],
    requiredStat: "DEX",
    requiredValue: 13,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "expose"],
    // tooltip shape for “two adjacent foes”
    aoe: { shape: "cone", scale: 1 },
    // Spread any Expose from primary to one adjacent target (full value)
    proliferateWeakness: { families: ["expose"], to: "adjacent", ratio: 1.0, maxTargets: 1 },
    description: "A sweeping flourish that hits two adjacent foes."
  },

  'read_and_react': {
    id: "read_and_react",
    name: "Read and React",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["sword_1h"],
    requiredStat: "WIS",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 2,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["stance", "support"],
    // your engine can honor this later: next hit vs Exposed targets deals extra
    statusEffects: [{ id: "read_and_react", turns: 1, nextVsExposeDamagePct: 20 }],
    description: "Study an opponent’s movements and prepare; later attacks against exposed enemies are empowered."
  },

  'power_riposte': {
    id: "power_riposte",
    name: "Power Riposte",
    type: "weapon",
    mechanic: "active", // not a true reaction in this pass
    versionTag: "v3.2",
    requiredWeapon: ["sword_1h"],
    requiredStat: "DEX",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "finisher"],
    requiresWeakness: { family: "expose", tierAtLeast: 1 },
    // inert scaler for later damage calc
    scaleWithTier: { family: "expose", perTierDamagePct: 15 },
    description: "A heavy counter that punishes exposed foes; scales with Expose tier."
  },

  'glacial_parry': {
    id: "glacial_parry",
    name: "Glacial Parry",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["sword_1h"],
    requiredStat: "WIS",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "cold", "consume"],
    requiresWeakness: { family: "cold", tierAtLeast: 2 },
    consumeWeakness: ["cold"],
    statusEffects: [{ id: "immobilized", turns: 1 }],
    description: "Convert Cold stacks into a freezing slash, immobilizing the target."
  },

  'taunting_slash': {
    id: "taunting_slash",
    name: "Taunting Slash",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["sword_1h"],
    requiredStat: "CHA",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "taunt"],
    requiresWeakness: { family: "expose", tierAtLeast: 2 },
    statusEffects: [{ id: "taunted", turns: 1 }],
    description: "A provoking blow that draws aggro from exposed enemies."
  },

  'crescent_cleave': {
    id: "crescent_cleave",
    name: "Crescent Cleave",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["sword_1h"],
    requiredStat: "STR",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "expose", "aoe"],
    aoe: { shape: "column", scale: 1 },
    rewardIfWeak: { family: "expose", tierAtLeast: 1, buff: { damagePct: 15 } },
    description: "A broad arc that cleaves through multiple foes; deals bonus to enemies with Expose."
  },

  'momentum_strike': {
    id: "momentum_strike",
    name: "Momentum Strike",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["sword_1h"],
    requiredStat: "DEX",
    requiredValue: 15,
    actionCost: "bonus",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "multi"],
    // inert condition: extra hit if target was hit by a 1h sword skill last turn
    conditionHint: { targetWasHitBy: "sword_1h", withinTurns: 1 },
    onTrigger: { grantExtraHitPct: 100 },
    description: "A quick follow-up that flows from a recent set-up."
  },

  'balancing_blow': {
    id: "balancing_blow",
    name: "Balancing Blow",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["sword_1h"],
    requiredStat: "CON",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "leech"],
    requiresWeakness: { family: "expose", tierAtLeast: 1 },
    // heal based on missing HP per Expose tier (engine can read this hint later)
    healSelfPctMissingHpPerTier: 6,
    description: "A measured strike that siphons life from the exposed."
  },

  'shattering_cut': {
    id: "shattering_cut",
    name: "Shattering Cut",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["sword_1h"],
    requiredStat: "STR",
    requiredValue: 18,
    actionCost: "major",
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "execute", "consume"],
    // assumes Expose max tier is 3; adjust if different in your Weakness config
    requiresWeakness: { family: "expose", tierAtLeast: 3 },
    consumeWeakness: ["expose"],
    debuffOnHit: { armorDownPct: 20, turns: 2 },
    description: "A finishing blow that wrecks defenses; clears all Expose and reduces armor briefly."
  },

  // ===============================
  // v3.2 — 2h Sword (13)
  // ===============================
  'hewing_mark': {
    id: "hewing_mark",
    name: "Hewing Mark",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["sword_2h"],
    requiredStat: "STR",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "expose"],
    emitTagsOnUse: ["slash", "heavy"],
    buildupHint: { expose: 75 },
    description: "A deep opening cut that rapidly raises Expose."
  },

  'broad_arc': {
    id: "broad_arc",
    name: "Broad Arc",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["sword_2h"],
    requiredStat: "STR",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "expose", "aoe"],
    emitTagsOnUse: ["cleave"],
    aoe: { shape: "column", scale: 1 },
    buildupHint: { expose: 40 },
    description: "Sweeping arc that lightly exposes multiple foes in the column."
  },

  'tendon_hewer': {
    id: "tendon_hewer",
    name: "Tendon Hewer",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["sword_2h"],
    requiredStat: "STR",
    requiredValue: 17,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lacerate"],
    emitTagsOnUse: ["bleed"],
    buildupHint: { lacerate: 80 },
    rewardIfWeak: { family: "expose", tierAtLeast: 1, buff: { addBuildup: { lacerate: 30 } } },
    description: "Heavy chop that piles on Bleed; more if the target is Exposed."
  },

  'helm_splitter': {
    id: "helm_splitter",
    name: "Helm Splitter",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["sword_2h"],
    requiredStat: "STR",
    requiredValue: 16,
    actionCost: "bonus",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "disorient"],
    buildupHint: { disorient: 70 },
    rewardIfWeak: { family: "expose", tierAtLeast: 2, buff: { addBuildup: { disorient: 30 } } },
    description: "A jolting blow that rattles defenses, stronger versus higher Expose."
  },

  'winter_edge': {
    id: "winter_edge",
    name: "Winter Edge",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["sword_2h"],
    requiredStat: "INT",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "cold"],
    buildupHint: { cold: 70 },
    rewardIfWeak: { family: "expose", tierAtLeast: 1, buff: { addBuildup: { cold: 25 } } },
    description: "A frosted cut that builds Cold; Exposed targets chill faster."
  },

  'discipline': {
    id: "discipline",
    name: "Discipline",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["sword_2h"],
    requiredStat: "WIS",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 2,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["stance", "support"],
    statusEffects: [{ id: "discipline", turns: 1, guardPct: 10 }],
    rewardIfTierCross: [{ family: "expose", tier: 1, buff: { accPct: 10, turns: 1 } }],
    description: "Center yourself; on raising Expose this turn, gain brief accuracy."
  },

  'carry_through': {
    id: "carry_through",
    name: "Carry Through",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["sword_2h"],
    requiredStat: "STR",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "expose", "proliferate"],
    aoe: { shape: "column", scale: 1 },
    proliferateWeakness: { families: ["expose"], to: "column", ratio: 0.5, maxTargets: 1 },
    description: "Drive the blade through ranks, carrying Expose down the line."
  },

  'great_cleave': {
    id: "great_cleave",
    name: "Great Cleave",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["sword_2h"],
    requiredStat: "STR",
    requiredValue: 18,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "aoe", "finisher"],
    aoe: { shape: "column", scale: 1 },
    requiresWeakness: { family: "expose", tierAtLeast: 1 },
    rewardIfWeak: { family: "expose", tierAtLeast: 2, buff: { damagePct: 20 } },
    description: "A decisive sweep that excels against Exposed lines."
  },

  'sever_finish': {
    id: "sever_finish",
    name: "Sever Finish",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["sword_2h"],
    requiredStat: "STR",
    requiredValue: 17,
    actionCost: "major",
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lacerate", "consume"],
    requiresWeakness: { family: "lacerate", tierAtLeast: 1 },
    consumeWeakness: ["lacerate"],
    description: "Convert Bleed into brutal burst damage with a finishing chop."
  },

  'ice_shatter': {
    id: "ice_shatter",
    name: "Ice Shatter",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["sword_2h"],
    requiredStat: "INT",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "cold", "amplify"],
    requiresWeakness: { family: "cold", tierAtLeast: 1 },
    rewardIfWeak: { family: "cold", tierAtLeast: 2, buff: { armorDownPct: 15, turns: 2 } },
    description: "Strike a frozen weakpoint; at Cold T2, crack their armor."
  },

  'executioner_swing': {
    id: "executioner_swing",
    name: "Executioner Swing",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["sword_2h"],
    requiredStat: "STR",
    requiredValue: 19,
    actionCost: "major",
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "execute"],
    requiresWeakness: { family: "expose", tierAtLeast: 2 },
    rewardIfWeak: { family: "expose", tierAtLeast: 3, buff: { critMultBonus: 0.5 } },
    description: "A beheading stroke that thrives on deep Expose."
  },

  'disorient_crush': {
    id: "disorient_crush",
    name: "Disorient Crush",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["sword_2h"],
    requiredStat: "STR",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "disorient", "amplify"],
    requiresWeakness: { family: "disorient", tierAtLeast: 1 },
    rewardIfWeak: { family: "disorient", tierAtLeast: 2, buff: { damagePct: 20 } },
    description: "Punish a rattled foe; heavier impact at higher Disorient."
  },

  'storm_cleave': {
    id: "storm_cleave",
    name: "Storm Cleave",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["sword_2h"],
    requiredStat: "DEX",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lightning", "aoe"],
    aoe: { shape: "column", scale: 1 },
    requiresWeakness: { family: "lightning", tierAtLeast: 1 },
    rewardIfWeak: { family: "lightning", tierAtLeast: 2, buff: { repeatStrikeOnce: true, repeatPowerPct: 50 } },
    description: "An electrified cleave; on Shock T2, echoes once at reduced power."
  },

  // ===============================
  // v3.2 — 2h Axe (13)
  // ===============================

  // -------- Generation (7) --------
  'reckoning_heave': {
    id: "reckoning_heave",
    name: "Reckoning Heave",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["axe_2h"],
    requiredStat: "STR",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "expose"],
    emitTagsOnUse: ["arc", "heavy"],
    buildupHint: { expose: 75 },
    description: "A brutal overhead that tears an opening and spikes Expose."
  },

  'sunder_line': {
    id: "sunder_line",
    name: "Sunder Line",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["axe_2h"],
    requiredStat: "STR",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "expose", "aoe"],
    emitTagsOnUse: ["cleave", "arc"],
    aoe: { shape: "column", scale: 1 },
    buildupHint: { expose: 40 },
    description: "A sweeping sunder that lightly Exposes every foe in the column."
  },

  'artery_opener': {
    id: "artery_opener",
    name: "Artery Opener",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["axe_2h"],
    requiredStat: "STR",
    requiredValue: 17,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lacerate"],
    emitTagsOnUse: ["bleed"],
    buildupHint: { lacerate: 85 },
    rewardIfWeak: { family: "expose", tierAtLeast: 1, buff: { addBuildup: { lacerate: 30 } } },
    description: "Hooking chop that seeds heavy Bleed; even more if the target is Exposed."
  },

  'skull_rattle': {
    id: "skull_rattle",
    name: "Skull Rattle",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["axe_2h"],
    requiredStat: "STR",
    requiredValue: 16,
    actionCost: "bonus",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "disorient"],
    buildupHint: { disorient: 70 },
    rewardIfWeak: { family: "expose", tierAtLeast: 2, buff: { addBuildup: { disorient: 30 } } },
    description: "A stunning haft blow that rattles the brain; nastier at higher Expose."
  },

  'splinter_shards': {
    id: "splinter_shards",
    name: "Splinter Shards",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["axe_2h"],
    requiredStat: "STR",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lacerate", "proliferate", "aoe"],
    emitTagsOnUse: ["arc"],
    aoe: { shape: "cone", scale: 1 },
    // Splash a portion of Bleed to one adjacent target
    proliferateWeakness: { families: ["lacerate"], to: "adjacent", ratio: 0.5, maxTargets: 1 },
    description: "Chop that throws splinters—Bleed spills to a nearby foe."
  },

  'glacial_heft': {
    id: "glacial_heft",
    name: "Glacial Heft",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["axe_2h"],
    requiredStat: "INT",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "cold"],
    buildupHint: { cold: 70 },
    rewardIfWeak: { family: "expose", tierAtLeast: 1, buff: { addBuildup: { cold: 25 } } },
    description: "A frost-laden swing that chills the target; faster on Exposed foes."
  },

  'battle_roar': {
    id: "battle_roar",
    name: "Battle Roar",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["axe_2h"],
    requiredStat: "CHA",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 2,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["stance", "support", "expose"],
    // Light Expose ping (for tooltip) + team buff hook
    buildupHint: { expose: 30 },
    statusEffects: [{ id: "roaring_focus", turns: 1, teamDamagePct: 5 }],
    description: "A rallying bellow that pressures the foe and bolsters allies."
  },

  // -------- Payoff (6) --------
  'cleave': {
    id: "cleave",
    name: "Cleave",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["axe_2h"],
    requiredStat: "STR",
    requiredValue: 18,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "aoe", "finisher"],
    emitTagsOnUse: ["cleave", "arc"],
    aoe: { shape: "column", scale: 1 },
    requiresWeakness: { family: "expose", tierAtLeast: 1 },
    rewardIfWeak: { family: "expose", tierAtLeast: 2, buff: { damagePct: 20 } },
    description: "A devastating arc through the ranks; excels against Exposed lines."
  },

  'sever_artery': {
    id: "sever_artery",
    name: "Sever Artery",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["axe_2h"],
    requiredStat: "STR",
    requiredValue: 17,
    actionCost: "major",
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lacerate", "consume"],
    requiresWeakness: { family: "lacerate", tierAtLeast: 1 },
    consumeWeakness: ["lacerate"],
    description: "Rip open wounds to convert Bleed into immediate, brutal damage."
  },

  'skull_sunder': {
    id: "skull_sunder",
    name: "Skull Sunder",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["axe_2h"],
    requiredStat: "STR",
    requiredValue: 18,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "disorient", "amplify"],
    requiresWeakness: { family: "disorient", tierAtLeast: 1 },
    rewardIfWeak: { family: "disorient", tierAtLeast: 2, buff: { damagePct: 20 } },
    description: "Crushing head-splitter that hits harder against a rattled target."
  },

  'ice_fracture': {
    id: "ice_fracture",
    name: "Ice Fracture",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["axe_2h"],
    requiredStat: "INT",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "cold", "amplify"],
    requiresWeakness: { family: "cold", tierAtLeast: 1 },
    rewardIfWeak: { family: "cold", tierAtLeast: 2, buff: { armorDownPct: 15, turns: 2 } },
    description: "Smash frozen weak points; at higher Cold tiers, crack armor."
  },

  'executioner_hew': {
    id: "executioner_hew",
    name: "Executioner Hew",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["axe_2h"],
    requiredStat: "STR",
    requiredValue: 19,
    actionCost: "major",
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "execute"],
    requiresWeakness: { family: "expose", tierAtLeast: 2 },
    rewardIfWeak: { family: "expose", tierAtLeast: 3, buff: { critMultBonus: 0.5 } },
    description: "Headsman’s stroke meant to end the fight once the opening is deep."
  },

  'hemorrhage_cloud': {
    id: "hemorrhage_cloud",
    name: "Hemorrhage Cloud",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["axe_2h"],
    requiredStat: "INT",
    requiredValue: 13,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "transform", "aoe"],
    aoe: { shape: "circle", scale: 1 },
    requiresWeakness: { family: "lacerate", tierAtLeast: 1 },
    // Convert a portion of Bleed into Disease and waft it to nearby targets
    transformWeakness: { from: "lacerate", to: "disease", ratio: 0.5 },
    proliferateWeakness: { families: ["disease"], to: "adjacent", ratio: 0.5, maxTargets: 2 },
    description: "Tear wounds wide to cast a diseased spray, infecting nearby foes."
  },

  // ===============================
  // v3.2 — 2h Mace (13)
  // ===============================

  // -------- Generation (7) --------
  'guard_smasher': {
    id: "guard_smasher",
    name: "Guard Smasher",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["mace_2h"],
    requiredStat: "STR",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "expose"],
    emitTagsOnUse: ["impact", "heavy"],
    buildupHint: { expose: 70 },
    description: "A crushing swing that cracks defenses and spikes Expose."
  },

  'ringing_blow': {
    id: "ringing_blow",
    name: "Ringing Blow",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["mace_2h"],
    requiredStat: "STR",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "disorient"],
    buildupHint: { disorient: 70 },
    rewardIfWeak: { family: "expose", tierAtLeast: 1, buff: { addBuildup: { disorient: 25 } } },
    description: "A bell-ringer to the helm; builds Disorient, worse if they’re already Exposed."
  },

  'weighty_slam': {
    id: "weighty_slam",
    name: "Weighty Slam",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["mace_2h"],
    requiredStat: "STR",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "expose", "aoe"],
    emitTagsOnUse: ["impact", "arc"],
    aoe: { shape: "column", scale: 1 },
    buildupHint: { expose: 40 },
    description: "A heavy arc that lightly Exposes everyone in the column."
  },

  'sanctified_hammer': {
    id: "sanctified_hammer",
    name: "Sanctified Hammer",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["mace_2h"],
    requiredStat: "INT",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "curse"],
    buildupHint: { curse: 60 },
    rewardIfWeak: { family: "expose", tierAtLeast: 1, buff: { addBuildup: { curse: 20 } } },
    description: "Channel a rite through the head of the mace to lay a lingering Curse."
  },

  'bone_jolt': {
    id: "bone_jolt",
    name: "Bone Jolt",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["mace_2h"],
    requiredStat: "STR",
    requiredValue: 14,
    actionCost: "bonus",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "disorient"],
    buildupHint: { disorient: 55 },
    rewardIfTierCross: [{ family: "disorient", tier: 1, debuff: { accDownPct: 10, turns: 1 } }],
    description: "A short, shocking jab—crossing Disorient T1 briefly rattles accuracy."
  },

  'iron_rebuke': {
    id: "iron_rebuke",
    name: "Iron Rebuke",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["mace_2h"],
    requiredStat: "WIS",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 2,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["stance", "support", "expose"],
    buildupHint: { expose: 30 },
    rewardIfTierCross: [{ family: "expose", tier: 1, buff: { guardPct: 12, turns: 1 } }],
    description: "Brace behind the haft; if you open a guard this turn, gain brief guard."
  },

  'ground_tremor': {
    id: "ground_tremor",
    name: "Ground Tremor",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["mace_2h"],
    requiredStat: "STR",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "disorient", "aoe"],
    emitTagsOnUse: ["impact"],
    aoe: { shape: "column", scale: 1 },
    buildupHint: { disorient: 40 },
    description: "Smash the ground and shake the rank; light Disorient across a column."
  },

  // -------- Payoff (6) --------
  'hammerfall': {
    id: "hammerfall",
    name: "Hammerfall",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["mace_2h"],
    requiredStat: "STR",
    requiredValue: 18,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "execute"],
    requiresWeakness: { family: "expose", tierAtLeast: 2 },
    rewardIfWeak: { family: "expose", tierAtLeast: 3, buff: { critMultBonus: 0.5 } },
    description: "A finishing crush that thrives on a deep opening."
  },

  'concuss': {
    id: "concuss",
    name: "Concuss",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["mace_2h"],
    requiredStat: "STR",
    requiredValue: 17,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "disorient", "consume"],
    requiresWeakness: { family: "disorient", tierAtLeast: 1 },
    consumeWeakness: ["disorient"],
    description: "Convert Disorient into immediate, dazing impact; clears the rattled state."
  },

  'shatter_guard': {
    id: "shatter_guard",
    name: "Shatter Guard",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["mace_2h"],
    requiredStat: "STR",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "amplify"],
    requiresWeakness: { family: "expose", tierAtLeast: 1 },
    rewardIfWeak: { family: "expose", tierAtLeast: 2, buff: { armorDownPct: 20, turns: 2 } },
    description: "Pulverize an opening, reducing armor; worse for foes with deeper Expose."
  },

  'judgment': {
    id: "judgment",
    name: "Judgment",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["mace_2h"],
    requiredStat: "INT",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "curse", "consume"],
    requiresWeakness: { family: "curse", tierAtLeast: 1 },
    consumeWeakness: ["curse"],
    description: "Bring the hammer down with a rite—consume Curse to smite the target."
  },

  'smite_line': {
    id: "smite_line",
    name: "Smite Line",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["mace_2h"],
    requiredStat: "STR",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "aoe", "finisher"],
    aoe: { shape: "column", scale: 1 },
    requiresWeakness: { family: "expose", tierAtLeast: 1 },
    rewardIfWeak: { family: "expose", tierAtLeast: 2, buff: { damagePct: 18 } },
    description: "A punishing line-smite that excels against Exposed formations."
  },

  'aftershock': {
    id: "aftershock",
    name: "Aftershock",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["mace_2h"],
    requiredStat: "DEX",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lightning", "amplify"],
    requiresWeakness: { family: "lightning", tierAtLeast: 1 },
    rewardIfWeak: { family: "lightning", tierAtLeast: 2, buff: { repeatStrikeOnce: true, repeatPowerPct: 50 } },
    description: "A charged impact that echoes once when Shock is high enough."
  },


  // ===============================
  // v3.2 — Whip (1h) (13)
  // ===============================

  // -------- Generation (7) --------
  'snap_mark': {
    id: "snap_mark",
    name: "Snap Mark",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["whip"],
    requiredStat: "DEX",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "expose"],
    emitTagsOnUse: ["lash"],
    buildupHint: { expose: 60 },
    description: "A precise lash that opens guard and builds Expose."
  },

  'tongue_cut': {
    id: "tongue_cut",
    name: "Tongue Cut",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["whip"],
    requiredStat: "DEX",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lacerate"],
    emitTagsOnUse: ["lash"],
    buildupHint: { lacerate: 65 },
    rewardIfWeak: { family: "expose", tierAtLeast: 1, buff: { addBuildup: { lacerate: 25 } } },
    description: "The whip’s tip opens skin, seeding Bleed—faster on an Exposed foe."
  },

  'taunting_crack': {
    id: "taunting_crack",
    name: "Taunting Crack",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["whip"],
    requiredStat: "CHA",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "disorient", "taunt"],
    buildupHint: { disorient: 50 },
    rewardIfTierCross: [{ family: "disorient", tier: 1, debuff: { accDownPct: 10, turns: 1 } }],
    description: "A sharp snap that rattles and provokes; crossing Disorient T1 jolts accuracy."
  },

  'ensnaring_flick': {
    id: "ensnaring_flick",
    name: "Ensnaring Flick",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["whip"],
    requiredStat: "DEX",
    requiredValue: 13,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "expose", "proliferate"],
    // Spread a portion of Expose to one adjacent target
    proliferateWeakness: { families: ["expose"], to: "adjacent", ratio: 0.5, maxTargets: 1 },
    description: "A hooking lash that pulls open guards and spreads the opening nearby."
  },

  'venom_lash': {
    id: "venom_lash",
    name: "Venom Lash",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["whip"],
    requiredStat: "DEX",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "toxic"],
    buildupHint: { toxic: 60 },
    rewardIfWeak: { family: "expose", tierAtLeast: 1, buff: { addBuildup: { toxic: 20 } } },
    description: "The barbs carry toxin; Exposed targets take more."
  },

  'rhythm_control': {
    id: "rhythm_control",
    name: "Rhythm Control",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["whip"],
    requiredStat: "WIS",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 2,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["stance", "support", "expose"],
    buildupHint: { expose: 30 },
    statusEffects: [{ id: "whip_rhythm", turns: 1, nextVsExposeDamagePct: 15 }],
    description: "Set the tempo; your next strike against an Exposed target hits harder."
  },

  'crowd_teaser': {
    id: "crowd_teaser",
    name: "Crowd Teaser",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["whip"],
    requiredStat: "CHA",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "disorient", "aoe"],
    aoe: { shape: "cone", scale: 1 },
    buildupHint: { disorient: 40 },
    description: "A flashy sweep that lightly Disorients multiple nearby foes."
  },

  // -------- Payoff (6) --------
  'drag_down': {
    id: "drag_down",
    name: "Drag Down",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["whip"],
    requiredStat: "DEX",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "consume", "expose"],
    requiresWeakness: { family: "expose", tierAtLeast: 1 },
    consumeWeakness: ["expose"],
    statusEffects: [{ id: "immobilized", turns: 1 }],
    description: "Yank them off balance—consume Expose and briefly immobilize."
  },

  'stranglehold': {
    id: "stranglehold",
    name: "Stranglehold",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["whip"],
    requiredStat: "STR",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "disorient", "amplify"],
    requiresWeakness: { family: "disorient", tierAtLeast: 1 },
    rewardIfWeak: { family: "disorient", tierAtLeast: 2, buff: { damagePct: 20 } },
    description: "Tighten control; Disoriented foes suffer heavier damage."
  },

  'barbed_bloom': {
    id: "barbed_bloom",
    name: "Barbed Bloom",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["whip"],
    requiredStat: "DEX",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lacerate", "consume"],
    requiresWeakness: { family: "lacerate", tierAtLeast: 1 },
    consumeWeakness: ["lacerate"],
    description: "Rip open existing wounds for a savage burst, consuming Bleed."
  },

  'toxin_whipover': {
    id: "toxin_whipover",
    name: "Toxin Whipover",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["whip"],
    requiredStat: "INT",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "transform", "aoe"],
    aoe: { shape: "circle", scale: 1 },
    requiresWeakness: { family: "toxic", tierAtLeast: 1 },
    transformWeakness: { from: "toxic", to: "disease", ratio: 0.6 },
    proliferateWeakness: { families: ["disease"], to: "adjacent", ratio: 0.5, maxTargets: 2 },
    description: "Concentrate toxins into a miasma; convert some Poison to Disease and spread it."
  },

  'snapback': {
    id: "snapback",
    name: "Snapback",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["whip"],
    requiredStat: "DEX",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "finisher"],
    requiresWeakness: { family: "expose", tierAtLeast: 2 },
    rewardIfWeak: { family: "expose", tierAtLeast: 3, buff: { critMultBonus: 0.45 } },
    description: "A punishing snap that shines when the opening is deep."
  },

  'entangle_whip': {
    id: "entangle_whip",
    name: "Entangle",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["whip"],
    requiredStat: "WIS",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "restrict", "amplify"],
    requiresWeakness: { family: "expose", tierAtLeast: 1 },
    // “Restrict” is a future global tag; here we just add a slow/immobilize flavor
    statusEffects: [{ id: "slowed", turns: 2, speedDownPct: 25 }],
    description: "Bind their limbs and limit motion—especially effective once an opening is found."
  },


  // ===============================
  // v3.2 — Sling (1h) (13)
  // ===============================

  // -------- Generation (7) --------
  'pouch_probe': {
    id: "pouch_probe",
    name: "Pouch Probe",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["sling"],
    requiredStat: "DEX",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "expose"],
    emitTagsOnUse: ["projectile"],
    buildupHint: { expose: 55 },
    description: "A testing shot that opens guard and builds Expose."
  },

  'concussive_pellet': {
    id: "concussive_pellet",
    name: "Concussive Pellet",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["sling"],
    requiredStat: "STR",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "disorient"],
    emitTagsOnUse: ["projectile"],
    buildupHint: { disorient: 65 },
    rewardIfWeak: { family: "expose", tierAtLeast: 1, buff: { addBuildup: { disorient: 25 } } },
    description: "A weighted strike that rattles the target; worse if they’re already Exposed."
  },

  'seeding_shot': {
    id: "seeding_shot",
    name: "Seeding Shot",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["sling"],
    requiredStat: "DEX",
    requiredValue: 13,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "toxic"],
    emitTagsOnUse: ["projectile"],
    buildupHint: { toxic: 60 },
    rewardIfWeak: { family: "expose", tierAtLeast: 1, buff: { addBuildup: { toxic: 20 } } },
    description: "A resin-tipped stone that seeds Poison; Exposed foes take more buildup."
  },

  'frost_pebble': {
    id: "frost_pebble",
    name: "Frost Pebble",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["sling"],
    requiredStat: "INT",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "cold"],
    emitTagsOnUse: ["projectile"],
    buildupHint: { cold: 60 },
    rewardIfTierCross: [{ family: "cold", tier: 1, debuff: { speedDownPct: 10, turns: 1 } }],
    description: "A chilled shot; crossing Cold T1 briefly slows the target."
  },

  'ricochet_mark': {
    id: "ricochet_mark",
    name: "Ricochet Mark",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["sling"],
    requiredStat: "DEX",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "expose", "proliferate"],
    emitTagsOnUse: ["projectile"],
    // Spread Expose from primary to one adjacent enemy (50%)
    proliferateWeakness: { families: ["expose"], to: "adjacent", ratio: 0.5, maxTargets: 1 },
    description: "Bank the shot—your opening pressure transfers to a nearby foe."
  },

  'lodging_stone': {
    id: "lodging_stone",
    name: "Lodging Stone",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["sling"],
    requiredStat: "DEX",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "lodge"],
    emitTagsOnUse: ["projectile", "lodge"],
    // Inert hint: mark as lodged (you’ll implement the effect later)
    statusEffects: [{ id: "lodged", turns: 2, stacks: 1 }],
    description: "A flat, sharp stone that tends to lodge in the wound."
  },

  'steady_breath': {
    id: "steady_breath",
    name: "Steady Breath",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["sling"],
    requiredStat: "WIS",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 0,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["support", "mp", "stance"],
    // Inert hint: small MP restore and accuracy buff for next projectile this turn
    statusEffects: [{ id: "steady_breath", turns: 1, mpRestoreFlat: 2, nextProjectileAccPct: 10 }],
    description: "Focus and breathe—restore a little MP and line up your next shot."
  },

  // -------- Payoff (6) --------
  'shatter_lodge': {
    id: "shatter_lodge",
    name: "Shatter Lodge",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["sling"],
    requiredStat: "DEX",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "consume"],
    requiresWeakness: { family: "lodged", tierAtLeast: 1 },   // treat 'lodged' as a pseudo-family
    consumeWeakness: ["lodged"],
    description: "Strike the lodged stone to shatter it inside the wound for burst damage."
  },

  'skull_crack': {
    id: "skull_crack",
    name: "Skull Crack",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["sling"],
    requiredStat: "STR",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "disorient", "finisher"],
    requiresWeakness: { family: "disorient", tierAtLeast: 1 },
    rewardIfWeak: { family: "disorient", tierAtLeast: 2, buff: { damagePct: 18 } },
    description: "A brutal, temple-seeking shot that thrives on a rattled foe."
  },

  'ice_breaker': {
    id: "ice_breaker",
    name: "Ice Breaker",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["sling"],
    requiredStat: "INT",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "cold", "amplify"],
    requiresWeakness: { family: "cold", tierAtLeast: 1 },
    rewardIfWeak: { family: "cold", tierAtLeast: 2, buff: { armorDownPct: 12, turns: 2 } },
    description: "A cracking shot that exploits frost—at higher Cold tiers, it fractures armor."
  },

  'toxin_bloom': {
    id: "toxin_bloom",
    name: "Toxin Bloom",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["sling"],
    requiredStat: "DEX",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "toxic", "consume"],
    requiresWeakness: { family: "toxic", tierAtLeast: 1 },
    consumeWeakness: ["toxic"],
    rewardIfWeak: { family: "toxic", tierAtLeast: 2, buff: { extraRapidTicks: 1 } },
    description: "Detonate built-up Poison into rapid ticks; adds an extra tick at higher tiers."
  },

  'thread_the_gap': {
    id: "thread_the_gap",
    name: "Thread the Gap",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["sling"],
    requiredStat: "DEX",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "finisher"],
    requiresWeakness: { family: "expose", tierAtLeast: 1 },
    rewardIfWeak: { family: "expose", tierAtLeast: 2, buff: { critMultBonus: 0.4 } },
    description: "A pinpoint strike that sails through a small opening; deadlier at deeper Expose."
  },

  'ricochet_spread': {
    id: "ricochet_spread",
    name: "Ricochet Spread",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["sling"],
    requiredStat: "DEX",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "proliferate", "aoe"],
    emitTagsOnUse: ["projectile"],
    aoe: { shape: "column", scale: 1 },
    // Copy a portion of the primary target’s highest-tier weakness down the column
    proliferateWeakness: { families: ["expose", "disorient", "cold", "toxic", "lacerate"], to: "column", ratio: 0.4, maxTargets: 2 },
    description: "A trick shot that skips down the line, spreading the primary target’s condition."
  },


  // ===============================
  // v3.2 — Bow (2h) (13)
  // ===============================

  // -------- Generation (7) --------
  'pinning_shot': {
    id: "pinning_shot",
    name: "Pinning Shot",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["bow"],
    requiredStat: "DEX",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "expose"],
    emitTagsOnUse: ["projectile"],
    buildupHint: { expose: 60 },
    description: "A precise shaft that opens the target’s guard and builds Expose."
  },

  'barbed_arrow': {
    id: "barbed_arrow",
    name: "Barbed Arrow",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["bow"],
    requiredStat: "DEX",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "lacerate"],
    emitTagsOnUse: ["projectile"],
    buildupHint: { lacerate: 70 },
    rewardIfWeak: { family: "expose", tierAtLeast: 1, buff: { addBuildup: { lacerate: 25 } } },
    description: "Barbed head tears flesh, seeding Bleed—worse on an Exposed foe."
  },

  'tainted_arrow': {
    id: "tainted_arrow",
    name: "Tainted Arrow",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["bow"],
    requiredStat: "DEX",
    requiredValue: 13,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "toxic"],
    emitTagsOnUse: ["projectile"],
    buildupHint: { toxic: 60 },
    rewardIfWeak: { family: "expose", tierAtLeast: 1, buff: { addBuildup: { toxic: 20 } } },
    description: "A resin-coated tip that poisons the wound; Exposed targets take more buildup."
  },

  'frosthead_arrow': {
    id: "frosthead_arrow",
    name: "Frosthead Arrow",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["bow"],
    requiredStat: "INT",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "cold"],
    emitTagsOnUse: ["projectile"],
    buildupHint: { cold: 60 },
    rewardIfTierCross: [{ family: "cold", tier: 1, debuff: { speedDownPct: 10, turns: 1 } }],
    description: "A chilled arrow; crossing Cold T1 briefly slows the target."
  },

  'marking_volley': {
    id: "marking_volley",
    name: "Marking Volley",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["bow"],
    requiredStat: "DEX",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "expose", "aoe"],
    emitTagsOnUse: ["projectile"],
    aoe: { shape: "column", scale: 1 },
    buildupHint: { expose: 40 },
    description: "Loose several shafts to lightly Expose every foe down the line."
  },

  'lodging_arrow': {
    id: "lodging_arrow",
    name: "Lodging Arrow",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["bow"],
    requiredStat: "DEX",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "lodge"],
    emitTagsOnUse: ["projectile", "lodge"],
    statusEffects: [{ id: "lodged", turns: 2, stacks: 1 }],
    description: "A broadhead designed to stick; leaves an arrow lodged in the target."
  },

  'eagle_focus': {
    id: "eagle_focus",
    name: "Eagle Focus",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["bow"],
    requiredStat: "WIS",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 0,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["support", "mp", "stance"],
    statusEffects: [{ id: "eagle_focus", turns: 1, mpRestoreFlat: 2, nextProjectileAccPct: 10 }],
    description: "Steady your aim—restore a little MP and line up your next shot."
  },

  // -------- Payoff (6) --------
  'shaft_splinter': {
    id: "shaft_splinter",
    name: "Shaft Splinter",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["bow"],
    requiredStat: "DEX",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "consume"],
    requiresWeakness: { family: "lodged", tierAtLeast: 1 },
    consumeWeakness: ["lodged"],
    description: "Strike the embedded arrow to splinter it internally for burst damage."
  },

  'ice_lance': {
    id: "ice_lance",
    name: "Ice Lance",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["bow"],
    requiredStat: "INT",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "cold", "amplify"],
    requiresWeakness: { family: "cold", tierAtLeast: 1 },
    rewardIfWeak: { family: "cold", tierAtLeast: 2, buff: { armorDownPct: 12, turns: 2 } },
    description: "A condensed shard of frost; at higher Cold tiers, it fractures armor."
  },

  'skull_pierce': {
    id: "skull_pierce",
    name: "Skull Pierce",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["bow"],
    requiredStat: "STR",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "disorient", "finisher"],
    requiresWeakness: { family: "disorient", tierAtLeast: 1 },
    rewardIfWeak: { family: "disorient", tierAtLeast: 2, buff: { damagePct: 18 } },
    description: "A temple-seeking shot that thrives on a rattled foe."
  },

  'toxin_burst': {
    id: "toxin_burst",
    name: "Toxin Burst",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["bow"],
    requiredStat: "DEX",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "toxic", "consume"],
    requiresWeakness: { family: "toxic", tierAtLeast: 1 },
    consumeWeakness: ["toxic"],
    rewardIfWeak: { family: "toxic", tierAtLeast: 2, buff: { extraRapidTicks: 1 } },
    description: "Rupture the poisoned wound to force rapid ticks; adds an extra tick at higher tiers."
  },

  'perfect_release': {
    id: "perfect_release",
    name: "Perfect Release",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["bow"],
    requiredStat: "DEX",
    requiredValue: 17,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "finisher"],
    requiresWeakness: { family: "expose", tierAtLeast: 1 },
    rewardIfWeak: { family: "expose", tierAtLeast: 2, buff: { critMultBonus: 0.4 } },
    description: "A perfect draw and loose through a narrow opening; deadlier at deeper Expose."
  },

  'weakpoint_cascade': {
    id: "weakpoint_cascade",
    name: "Weakpoint Cascade",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["bow"],
    requiredStat: "DEX",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "proliferate", "aoe"],
    emitTagsOnUse: ["projectile"],
    aoe: { shape: "column", scale: 1 },
    // Copy a portion of the primary target’s highest-tier weakness down the column
    proliferateWeakness: { families: ["expose", "disorient", "cold", "toxic", "lacerate", "lodged"], to: "column", ratio: 0.4, maxTargets: 2 },
    description: "A trick sequence that threads multiple foes, spreading the primary target’s condition."
  },

  // ===============================
  // v3.2 — Gun (2h) (13)
  // ===============================

  // -------- Generation (7) --------
  'sighting_shot': {
    id: "sighting_shot",
    name: "Sighting Shot",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["gun"],
    requiredStat: "DEX",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "expose"],
    emitTagsOnUse: ["projectile"],
    buildupHint: { expose: 55 },
    description: "A careful opening shot that pressures guard and builds Expose."
  },

  'stagger_round': {
    id: "stagger_round",
    name: "Stagger Round",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["gun"],
    requiredStat: "STR",
    requiredValue: 13,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "disorient"],
    emitTagsOnUse: ["projectile"],
    buildupHint: { disorient: 65 },
    rewardIfWeak: { family: "expose", tierAtLeast: 1, buff: { addBuildup: { disorient: 25 } } },
    description: "A heavy slug that rattles the target; worse if they’re already Exposed."
  },

  'alchemical_slug': {
    id: "alchemical_slug",
    name: "Alchemical Slug",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["gun"],
    requiredStat: "DEX",
    requiredValue: 13,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "toxic"],
    emitTagsOnUse: ["projectile"],
    buildupHint: { toxic: 60 },
    rewardIfWeak: { family: "expose", tierAtLeast: 1, buff: { addBuildup: { toxic: 20 } } },
    description: "A resin-laced shot that poisons the wound; Exposed targets accrue more toxin."
  },

  'cryo_round': {
    id: "cryo_round",
    name: "Cryo Round",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["gun"],
    requiredStat: "INT",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "cold"],
    emitTagsOnUse: ["projectile"],
    buildupHint: { cold: 60 },
    rewardIfTierCross: [{ family: "cold", tier: 1, debuff: { speedDownPct: 10, turns: 1 } }],
    description: "A chilled cartridge; crossing Cold T1 briefly slows the target."
  },

  'ricochet_lane': {
    id: "ricochet_lane",
    name: "Ricochet Lane",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["gun"],
    requiredStat: "DEX",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "expose", "proliferate", "aoe"],
    emitTagsOnUse: ["projectile"],
    aoe: { shape: "column", scale: 1 },
    // Spread Expose from primary to one other in the column (50%)
    proliferateWeakness: { families: ["expose"], to: "column", ratio: 0.5, maxTargets: 1 },
    description: "Skip a shot down the lane, passing the opening pressure along the column."
  },

  'lodging_slug': {
    id: "lodging_slug",
    name: "Lodging Slug",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["gun"],
    requiredStat: "DEX",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "lodge"],
    emitTagsOnUse: ["projectile", "lodge"],
    statusEffects: [{ id: "lodged", turns: 2, stacks: 1 }],
    description: "A soft-nosed round likely to lodge in the wound."
  },

  'steady_aim': {
    id: "steady_aim",
    name: "Steady Aim",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["gun"],
    requiredStat: "WIS",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 0,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["support", "mp", "stance"],
    statusEffects: [{ id: "steady_aim", turns: 1, mpRestoreFlat: 2, nextProjectileAccPct: 10 }],
    description: "Control breath and trigger—restore a little MP and line up your next shot."
  },

  // -------- Payoff (6) --------
  'implode_lodge': {
    id: "implode_lodge",
    name: "Implode Lodge",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["gun"],
    requiredStat: "DEX",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "consume"],
    requiresWeakness: { family: "lodged", tierAtLeast: 1 },
    consumeWeakness: ["lodged"],
    description: "A precise follow-up that collapses a lodged slug inside the wound for burst damage."
  },

  'temple_shot': {
    id: "temple_shot",
    name: "Temple Shot",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["gun"],
    requiredStat: "STR",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "disorient", "finisher"],
    requiresWeakness: { family: "disorient", tierAtLeast: 1 },
    rewardIfWeak: { family: "disorient", tierAtLeast: 2, buff: { damagePct: 18 } },
    description: "A brutal headshot that thrives on a rattled foe."
  },

  'glacial_core': {
    id: "glacial_core",
    name: "Glacial Core",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["gun"],
    requiredStat: "INT",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "cold", "amplify"],
    requiresWeakness: { family: "cold", tierAtLeast: 1 },
    rewardIfWeak: { family: "cold", tierAtLeast: 2, buff: { armorDownPct: 12, turns: 2 } },
    description: "A core-chilled round that fractures armor when Cold is already high."
  },

  'toxin_rupture': {
    id: "toxin_rupture",
    name: "Toxin Rupture",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["gun"],
    requiredStat: "DEX",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "toxic", "consume"],
    requiresWeakness: { family: "toxic", tierAtLeast: 1 },
    consumeWeakness: ["toxic"],
    rewardIfWeak: { family: "toxic", tierAtLeast: 2, buff: { extraRapidTicks: 1 } },
    description: "Burst the poisoned wound to force rapid ticks; adds an extra tick at higher tiers."
  },

  'weakpoint_drill': {
    id: "weakpoint_drill",
    name: "Weakpoint Drill",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["gun"],
    requiredStat: "DEX",
    requiredValue: 17,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "finisher"],
    requiresWeakness: { family: "expose", tierAtLeast: 1 },
    rewardIfWeak: { family: "expose", tierAtLeast: 2, buff: { critMultBonus: 0.4 } },
    description: "A tight grouping through a small opening; deadlier at deeper Expose."
  },

  'shrapnel_spray': {
    id: "shrapnel_spray",
    name: "Shrapnel Spray",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["gun"],
    requiredStat: "DEX",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["projectile", "attack", "proliferate", "aoe"],
    emitTagsOnUse: ["projectile"],
    aoe: { shape: "column", scale: 1 },
    // Copy a portion of the primary target’s highest-tier weakness down the column
    proliferateWeakness: { families: ["expose", "disorient", "cold", "toxic", "lacerate", "lodged"], to: "column", ratio: 0.4, maxTargets: 2 },
    description: "Scatter shrapnel through the rank, spreading the primary condition to others."
  },

  // ===============================
  // v3.2 — Wand (1h) (13)
  // ===============================

  // -------- Generation (7) --------
  'spark_mark': {
    id: "spark_mark",
    name: "Spark Mark",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["wand"],
    requiredStat: "INT",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "lightning", "expose"],
    emitTagsOnUse: ["spell", "lightning"],
    buildupHint: { expose: 40, lightning: 40 },
    description: "A pricking spark that opens guard and seeds a little Shock."
  },

  'hex_pin': {
    id: "hex_pin",
    name: "Hex Pin",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["wand"],
    requiredStat: "INT",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "curse"],
    buildupHint: { curse: 60 },
    description: "Affix a minor curse that lingers and prepares targets for curse synergies."
  },

  'chill_thread': {
    id: "chill_thread",
    name: "Chill Thread",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["wand"],
    requiredStat: "INT",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "cold"],
    buildupHint: { cold: 60 },
    rewardIfTierCross: [{ family: "cold", tier: 1, debuff: { speedDownPct: 10, turns: 1 } }],
    description: "A thread of frost; crossing Cold T1 briefly slows the target."
  },

  'venom_sigil': {
    id: "venom_sigil",
    name: "Venom Sigil",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["wand"],
    requiredStat: "INT",
    requiredValue: 13,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "toxic"],
    buildupHint: { toxic: 60 },
    rewardIfWeak: { family: "expose", tierAtLeast: 1, buff: { addBuildup: { toxic: 20 } } },
    description: "Inscribe venomous runes; Exposed foes accrue more Poison."
  },

  'fracture_rune': {
    id: "fracture_rune",
    name: "Fracture Rune",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["wand"],
    requiredStat: "INT",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "expose", "proliferate"],
    // Spread Expose to one adjacent (50%)
    proliferateWeakness: { families: ["expose"], to: "adjacent", ratio: 0.5, maxTargets: 1 },
    description: "A shattering glyph that transfers opening pressure to a nearby foe."
  },

  'focus_meditation': {
    id: "focus_meditation",
    name: "Focus Meditation",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["wand"],
    requiredStat: "WIS",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 0,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["support", "mp", "stance"],
    statusEffects: [{ id: "focus_meditation", turns: 1, mpRestoreFlat: 3, nextSpellAccPct: 10 }],
    description: "Steady mind and channel—restore MP and steady your next spell."
  },

  'conductive_touch': {
    id: "conductive_touch",
    name: "Conductive Touch",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["wand"],
    requiredStat: "CHA",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "lightning"],
    buildupHint: { lightning: 50 },
    rewardIfWeak: { family: "lightning", tierAtLeast: 1, buff: { chanceExtraHitPct: 25 } },
    description: "A palm-channelled jolt; Shocked foes may suffer an extra zap."
  },

  // -------- Payoff (6) --------
  'curse_snap_wand': {
    id: "curse_snap_wand",
    name: "Curse Snap",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["wand"],
    requiredStat: "INT",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "curse", "amplify"],
    requiresWeakness: { family: "curse", tierAtLeast: 1 },
    description: "For one turn, all Curse effects on the target tick twice (amplify only; no consume)."
  },

  'ice_shatter_wand': {
    id: "ice_shatter_wand",
    name: "Ice Shatter",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["wand"],
    requiredStat: "INT",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "cold", "amplify"],
    requiresWeakness: { family: "cold", tierAtLeast: 1 },
    rewardIfWeak: { family: "cold", tierAtLeast: 2, buff: { armorDownPct: 12, turns: 2 } },
    description: "Exploit brittle frost; at higher Cold tiers, fracture armor."
  },

  'venom_bloom_wand': {
    id: "venom_bloom_wand",
    name: "Venom Bloom",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["wand"],
    requiredStat: "INT",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "toxic", "consume"],
    requiresWeakness: { family: "toxic", tierAtLeast: 1 },
    consumeWeakness: ["toxic"],
    rewardIfWeak: { family: "toxic", tierAtLeast: 2, buff: { extraRapidTicks: 1 } },
    description: "Consume Poison to trigger rapid ticks; adds an extra tick at higher tiers."
  },

  'arc_resonance': {
    id: "arc_resonance",
    name: "Arc Resonance",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["wand"],
    requiredStat: "INT",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "lightning", "amplify"],
    requiresWeakness: { family: "lightning", tierAtLeast: 1 },
    rewardIfWeak: { family: "lightning", tierAtLeast: 2, buff: { repeatStrikeOnce: true, repeatPowerPct: 55 } },
    description: "Tune to the target’s Shock and echo the discharge once at reduced power."
  },

  'rune_conversion': {
    id: "rune_conversion",
    name: "Rune Conversion",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["wand"],
    requiredStat: "INT",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "transform"],
    requiresWeakness: { family: "lacerate", tierAtLeast: 1 },
    transformWeakness: { from: "lacerate", to: "curse", ratio: 0.7 },
    buildupHint: { lacerate: 100 },
    description: "Convert physical Bleed into a binding Curse to shift the weakness profile."
  },

  'weakpoint_lance': {
    id: "weakpoint_lance",
    name: "Weakpoint Lance",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["wand"],
    requiredStat: "INT",
    requiredValue: 17,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "finisher"],
    requiresWeakness: { family: "expose", tierAtLeast: 1 },
    rewardIfWeak: { family: "expose", tierAtLeast: 2, buff: { critMultBonus: 0.4 } },
    description: "Condense mana into a piercing ray that drills through a narrow opening."
  },


  // ===============================
  // v3.2 — Shield (13)
  // ===============================

  // -------- Generation (7) --------
  'edge_probe': {
    id: "edge_probe",
    name: "Edge Probe",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["shield"],
    requiredStat: "DEX",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 1,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "expose"],
    emitTagsOnUse: ["bash"],
    buildupHint: { expose: 55 },
    description: "Test the foe with the shield’s rim, prying open a small guard gap."
  },

  'stagger_bash': {
    id: "stagger_bash",
    name: "Stagger Bash",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["shield"],
    requiredStat: "STR",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "disorient"],
    buildupHint: { disorient: 65 },
    rewardIfWeak: { family: "expose", tierAtLeast: 1, buff: { addBuildup: { disorient: 25 } } },
    description: "A jarring slam that rattles the head; worse if the foe is already Exposed."
  },

  'brace_and_press': {
    id: "brace_and_press",
    name: "Brace and Press",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["shield"],
    requiredStat: "CON",
    requiredValue: 14,
    actionCost: "bonus",
    mpCost: 0,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["stance", "support", "expose"],
    buildupHint: { expose: 30 },
    statusEffects: [{ id: "braced", turns: 1, guardPct: 15 }],
    rewardIfTierCross: [{ family: "expose", tier: 1, buff: { accPct: 10, turns: 1 } }],
    description: "Raise the shield and pressure forward—gain guard; if you open a guard this turn, gain accuracy."
  },

  'line_bulldoze': {
    id: "line_bulldoze",
    name: "Line Bulldoze",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["shield"],
    requiredStat: "STR",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "expose", "aoe"],
    emitTagsOnUse: ["bash", "push"],
    aoe: { shape: "column", scale: 1 },
    buildupHint: { expose: 40 },
    description: "Drive the formation back with a wall of iron; lightly Exposes every foe in the column."
  },

  'ringing_rim': {
    id: "ringing_rim",
    name: "Ringing Rim",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["shield"],
    requiredStat: "STR",
    requiredValue: 13,
    actionCost: "bonus",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "disorient"],
    buildupHint: { disorient: 55 },
    rewardIfTierCross: [{ family: "disorient", tier: 1, debuff: { accDownPct: 10, turns: 1 } }],
    description: "Clip the ear with the rim; crossing Disorient T1 rattles aim."
  },

  'frost_ward': {
    id: "frost_ward",
    name: "Frost Ward",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["shield"],
    requiredStat: "INT",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "cold"],
    buildupHint: { cold: 60 },
    rewardIfWeak: { family: "expose", tierAtLeast: 1, buff: { addBuildup: { cold: 20 } } },
    description: "Channel cold across the bossing and strike; Exposed foes chill faster."
  },

  'lockstep': {
    id: "lockstep",
    name: "Lockstep",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["shield"],
    requiredStat: "WIS",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 1,
    requiresTarget: false,
    targetRequirement: "ally",
    tags: ["support", "mp", "stance"],
    statusEffects: [{ id: "lockstep", turns: 1, teamGuardPct: 5, nextBlockBonusPct: 15 }],
    description: "Set the cadence for the line; minor team guard and a boosted first block."
  },

  // -------- Payoff (6) --------
  'shield_hook': {
    id: "shield_hook",
    name: "Shield Hook",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["shield"],
    requiredStat: "STR",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "consume", "expose"],
    requiresWeakness: { family: "expose", tierAtLeast: 1 },
    consumeWeakness: ["expose"],
    statusEffects: [{ id: "immobilized", turns: 1 }],
    description: "Hook and yank—consume Expose and briefly immobilize the target."
  },

  'body_check': {
    id: "body_check",
    name: "Body Check",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["shield"],
    requiredStat: "CON",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "finisher"],
    requiresWeakness: { family: "disorient", tierAtLeast: 1 },
    rewardIfWeak: { family: "disorient", tierAtLeast: 2, buff: { damagePct: 18 } },
    description: "Lead with the shoulder; excels when the enemy is rattled."
  },

  'shield_crush': {
    id: "shield_crush",
    name: "Shield Crush",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["shield"],
    requiredStat: "STR",
    requiredValue: 17,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "amplify"],
    requiresWeakness: { family: "expose", tierAtLeast: 1 },
    rewardIfWeak: { family: "expose", tierAtLeast: 2, buff: { armorDownPct: 18, turns: 2 } },
    description: "Pulverize an opening to crack armor; nastier at deeper Expose."
  },

  'cold_pin': {
    id: "cold_pin",
    name: "Cold Pin",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["shield"],
    requiredStat: "INT",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "cold", "consume"],
    requiresWeakness: { family: "cold", tierAtLeast: 2 },
    consumeWeakness: ["cold"],
    statusEffects: [{ id: "immobilized", turns: 1 }],
    description: "Drive the frozen edge in and pin—consumes Cold and roots the target briefly."
  },

  'bulwark_slam': {
    id: "bulwark_slam",
    name: "Bulwark Slam",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["shield"],
    requiredStat: "STR",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "aoe", "finisher"],
    aoe: { shape: "column", scale: 1 },
    requiresWeakness: { family: "expose", tierAtLeast: 1 },
    rewardIfWeak: { family: "expose", tierAtLeast: 2, buff: { damagePct: 16 } },
    description: "A driving wall-of-iron impact that excels against Exposed ranks."
  },

  'standfast_rebuke': {
    id: "standfast_rebuke",
    name: "Standfast Rebuke",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["shield"],
    requiredStat: "WIS",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "amplify", "disorient"],
    requiresWeakness: { family: "disorient", tierAtLeast: 1 },
    rewardIfWeak: { family: "disorient", tierAtLeast: 2, buff: { guardBreakPct: 20, turns: 1 } },
    description: "A disciplined rebuke that capitalizes on rattled minds, briefly worsening guard break."
  },

  // ===============================
  // v3.2 — Staff (2h) (13)
  // ===============================

  // -------- Generation (7) --------
  'sigil_mark': {
    id: "sigil_mark",
    name: "Sigil Mark",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["staff"],
    requiredStat: "INT",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "expose"],
    emitTagsOnUse: ["spell"],
    buildupHint: { expose: 50 },
    description: "Etch a binding sigil that pries at defenses and builds Expose."
  },

  'hex_bind': {
    id: "hex_bind",
    name: "Hex Bind",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["staff"],
    requiredStat: "INT",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "curse"],
    buildupHint: { curse: 70 },
    rewardIfWeak: { family: "expose", tierAtLeast: 1, buff: { addBuildup: { curse: 25 } } },
    description: "A constricting hex that lingers; Exposed targets suffer stronger binding."
  },

  'frost_swell': {
    id: "frost_swell",
    name: "Frost Swell",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["staff"],
    requiredStat: "INT",
    requiredValue: 13,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "cold"],
    buildupHint: { cold: 65 },
    rewardIfTierCross: [{ family: "cold", tier: 1, debuff: { speedDownPct: 10, turns: 1 } }],
    description: "A wave of chill; crossing Cold T1 briefly slows the target."
  },

  'galvanic_touch': {
    id: "galvanic_touch",
    name: "Galvanic Touch",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["staff"],
    requiredStat: "INT",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "lightning"],
    buildupHint: { lightning: 55 },
    rewardIfWeak: { family: "lightning", tierAtLeast: 1, buff: { chanceExtraHitPct: 25 } },
    description: "Channel an arc through the focus; Shocked targets may suffer an extra jolt."
  },

  'miasma_trace': {
    id: "miasma_trace",
    name: "Miasma Trace",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["staff"],
    requiredStat: "INT",
    requiredValue: 13,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "toxic"],
    buildupHint: { toxic: 60 },
    rewardIfWeak: { family: "expose", tierAtLeast: 1, buff: { addBuildup: { toxic: 20 } } },
    description: "Lace the air with poison threads; Exposed foes accumulate toxin faster."
  },

  'rune_diffusion': {
    id: "rune_diffusion",
    name: "Rune Diffusion",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["staff"],
    requiredStat: "INT",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "expose", "proliferate", "aoe"],
    aoe: { shape: "column", scale: 1 },
    proliferateWeakness: { families: ["expose"], to: "column", ratio: 0.5, maxTargets: 1 },
    description: "Unravel a glyph to carry Expose down the rank."
  },

  'ward_focus': {
    id: "ward_focus",
    name: "Ward Focus",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["staff"],
    requiredStat: "WIS",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 0,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["support", "mp", "stance"],
    statusEffects: [{ id: "ward_focus", turns: 1, mpRestoreFlat: 3, nextSpellAccPct: 10 }],
    description: "Reinforce the flow—restore MP and steady your next spell."
  },

  // -------- Payoff (6) --------
  'curse_snap_staff': {
    id: "curse_snap_staff",
    name: "Curse Snap",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["staff"],
    requiredStat: "INT",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "curse", "amplify"],
    requiresWeakness: { family: "curse", tierAtLeast: 1 },
    description: "For one turn, all Curse effects on the target tick twice (amplify only; no consume)."
  },

  'ice_fracture_staff': {
    id: "ice_fracture_staff",
    name: "Ice Fracture",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["staff"],
    requiredStat: "INT",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "cold", "amplify"],
    requiresWeakness: { family: "cold", tierAtLeast: 1 },
    rewardIfWeak: { family: "cold", tierAtLeast: 2, buff: { armorDownPct: 14, turns: 2 } },
    description: "Shatter brittle frost—higher Cold tiers crack armor more."
  },

  'venom_bloom_staff': {
    id: "venom_bloom_staff",
    name: "Venom Bloom",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["staff"],
    requiredStat: "INT",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "toxic", "consume"],
    requiresWeakness: { family: "toxic", tierAtLeast: 1 },
    consumeWeakness: ["toxic"],
    rewardIfWeak: { family: "toxic", tierAtLeast: 2, buff: { extraRapidTicks: 1 } },
    description: "Consume Poison to force rapid ticks; adds a bonus tick at higher tiers."
  },

  'arc_echo': {
    id: "arc_echo",
    name: "Arc Echo",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["staff"],
    requiredStat: "INT",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "lightning", "amplify"],
    requiresWeakness: { family: "lightning", tierAtLeast: 1 },
    rewardIfWeak: { family: "lightning", tierAtLeast: 2, buff: { repeatStrikeOnce: true, repeatPowerPct: 55 } },
    description: "Synchronize with Shock to echo the discharge once at reduced power."
  },

  'hemorrhage_rite': {
    id: "hemorrhage_rite",
    name: "Hemorrhage Rite",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["staff"],
    requiredStat: "INT",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "transform", "aoe"],
    aoe: { shape: "circle", scale: 1 },
    requiresWeakness: { family: "lacerate", tierAtLeast: 1 },
    transformWeakness: { from: "lacerate", to: "curse", ratio: 0.6 },
    proliferateWeakness: { families: ["curse"], to: "adjacent", ratio: 0.5, maxTargets: 2 },
    description: "Subvert bleeding into binding hexes and spread the malediction nearby."
  },

  'weakpoint_lattice': {
    id: "weakpoint_lattice",
    name: "Weakpoint Lattice",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["staff"],
    requiredStat: "INT",
    requiredValue: 17,
    actionCost: "major",
    mpCost: 5,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["magic", "spell", "finisher"],
    requiresWeakness: { family: "expose", tierAtLeast: 1 },
    rewardIfWeak: { family: "expose", tierAtLeast: 2, buff: { critMultBonus: 0.4 } },
    description: "Weave mana along stress lines and lance through the opening."
  },

  // ===============================
  // v3.2 — 1h Spear (13)
  // ===============================

  // -------- Generation (7) --------
  'reach_test': {
    id: "reach_test",
    name: "Reach Test",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["spear_1h"],
    requiredStat: "DEX",
    requiredValue: 13,
    actionCost: "major",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "expose"],
    emitTagsOnUse: ["thrust"],
    buildupHint: { expose: 55 },
    description: "Probe from a safe distance to pry an opening."
  },

  'tendon_pick': {
    id: "tendon_pick",
    name: "Tendon Pick",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["spear_1h"],
    requiredStat: "DEX",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lacerate"],
    emitTagsOnUse: ["thrust"],
    buildupHint: { lacerate: 70 },
    rewardIfWeak: { family: "expose", tierAtLeast: 1, buff: { addBuildup: { lacerate: 25 } } },
    description: "A gouging thrust that seeds Bleed; worse on Exposed foes."
  },

  'stagger_set': {
    id: "stagger_set",
    name: "Stagger Set",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["spear_1h"],
    requiredStat: "STR",
    requiredValue: 14,
    actionCost: "bonus",
    mpCost: 2,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "disorient"],
    buildupHint: { disorient: 55 },
    rewardIfTierCross: [{ family: "disorient", tier: 1, debuff: { accDownPct: 10, turns: 1 } }],
    description: "Butt-end jab that rattles; crossing Disorient T1 jolts aim."
  },

  'frost_tip': {
    id: "frost_tip",
    name: "Frost Tip",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["spear_1h"],
    requiredStat: "INT",
    requiredValue: 12,
    actionCost: "major",
    mpCost: 4,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "cold"],
    buildupHint: { cold: 60 },
    rewardIfTierCross: [{ family: "cold", tier: 1, debuff: { speedDownPct: 10, turns: 1 } }],
    description: "A chilled point; crossing Cold T1 briefly slows the target."
  },

  'line_probe': {
    id: "line_probe",
    name: "Line Probe",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["spear_1h"],
    requiredStat: "STR",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "expose", "aoe"],
    emitTagsOnUse: ["thrust"],
    aoe: { shape: "column", scale: 1 },
    buildupHint: { expose: 40 },
    description: "A driving thrust through the rank that lightly Exposes a column."
  },

  'anchor_stance': {
    id: "anchor_stance",
    name: "Anchor Stance",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["spear_1h"],
    requiredStat: "CON",
    requiredValue: 12,
    actionCost: "bonus",
    mpCost: 0,
    requiresTarget: false,
    targetRequirement: "self",
    tags: ["stance", "support", "expose"],
    buildupHint: { expose: 30 },
    statusEffects: [{ id: "anchor_stance", turns: 1, guardPct: 12 }],
    rewardIfTierCross: [{ family: "expose", tier: 1, buff: { accPct: 10, turns: 1 } }],
    description: "Set the haft and pressure forward—gain guard; opening a guard sharpens accuracy."
  },

  'barbed_set': {
    id: "barbed_set",
    name: "Barbed Set",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["spear_1h"],
    requiredStat: "DEX",
    requiredValue: 13,
    actionCost: "major",
    mpCost: 3,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lacerate", "proliferate"],
    // Splash a portion of Bleed to one adjacent enemy
    proliferateWeakness: { families: ["lacerate"], to: "adjacent", ratio: 0.5, maxTargets: 1 },
    description: "Set the barbs and twist, letting the wound bleed into a nearby foe."
  },

  // -------- Payoff (6) --------
  'impale': {
    id: "impale",
    name: "Impale",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["spear_1h"],
    requiredStat: "DEX",
    requiredValue: 17,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "finisher"],
    requiresWeakness: { family: "expose", tierAtLeast: 1 },
    rewardIfWeak: { family: "expose", tierAtLeast: 2, buff: { critMultBonus: 0.45 } },
    description: "Drive through a narrow opening; devastating at deeper Expose."
  },

  'arterial_burst': {
    id: "arterial_burst",
    name: "Arterial Burst",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["spear_1h"],
    requiredStat: "DEX",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "lacerate", "consume"],
    requiresWeakness: { family: "lacerate", tierAtLeast: 1 },
    consumeWeakness: ["lacerate"],
    description: "Tear the wound open for immediate burst damage, consuming Bleed."
  },

  'brain_stem': {
    id: "brain_stem",
    name: "Brain Stem",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["spear_1h"],
    requiredStat: "STR",
    requiredValue: 15,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "disorient", "finisher"],
    requiresWeakness: { family: "disorient", tierAtLeast: 1 },
    rewardIfWeak: { family: "disorient", tierAtLeast: 2, buff: { damagePct: 18 } },
    description: "A brutal cranial pick that thrives on a rattled foe."
  },

  'ice_wedge': {
    id: "ice_wedge",
    name: "Ice Wedge",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["spear_1h"],
    requiredStat: "INT",
    requiredValue: 14,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "cold", "amplify"],
    requiresWeakness: { family: "cold", tierAtLeast: 1 },
    rewardIfWeak: { family: "cold", tierAtLeast: 2, buff: { armorDownPct: 12, turns: 2 } },
    description: "Hammer a wedge of ice into brittle seams to fracture armor."
  },

  'line_skewer': {
    id: "line_skewer",
    name: "Line Skewer",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["spear_1h"],
    requiredStat: "STR",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 6,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "aoe", "finisher"],
    aoe: { shape: "column", scale: 1 },
    requiresWeakness: { family: "expose", tierAtLeast: 1 },
    rewardIfWeak: { family: "expose", tierAtLeast: 2, buff: { damagePct: 18 } },
    description: "Run them through and catch the rank behind—excels against Exposed formations."
  },

  'sever_sinew': {
    id: "sever_sinew",
    name: "Sever Sinew",
    type: "weapon",
    mechanic: "active",
    versionTag: "v3.2",
    requiredWeapon: ["spear_1h"],
    requiredStat: "DEX",
    requiredValue: 16,
    actionCost: "major",
    mpCost: 7,
    requiresTarget: true,
    targetRequirement: "enemy",
    tags: ["melee", "attack", "transform"],
    requiresWeakness: { family: "lacerate", tierAtLeast: 1 },
    transformWeakness: { from: "lacerate", to: "toxic", ratio: 0.6 },
    buildupHint: { lacerate: 100 },
    description: "Twist the blade and infuse the wound—convert Bleed into Poison."
  },





});


// ======== Global Skill Test Mode (opt-in) — works on SKILLS object ========
const DEV_SKILL_TEST = {
  ENABLE: false,              // flip true for dev sessions
  zeroMpCost: true,
  zeroCooldown: true,
  ignoreStatReqs: true,       // sets requiredValue to 0
  ignoreWeaknessGates: false, // if true, bypass requiresWeakness checks in your gate
  // amplifyDamagePct: 0,     // optional future knob
};

function applyTestOverridesToAll(skillsObj, cfg = DEV_SKILL_TEST) {
  if (!cfg.ENABLE || !skillsObj) return;
  for (const s of Object.values(skillsObj)) {
    if (!s || s.type !== "weapon") continue;   // only weapon skills
    s._testOverrides = true;
    if (cfg.zeroMpCost && typeof s.mpCost === "number") s.mpCost = 0;
    if (cfg.zeroCooldown && typeof s.cooldown === "number") s.cooldown = 0;
    if (cfg.ignoreStatReqs && typeof s.requiredValue === "number") s.requiredValue = 0;
    if (cfg.ignoreWeaknessGates) s._skipWeaknessGates = true; // honor in your canUseSkill gate
    // if (cfg.amplifyDamagePct) s._tempDamageAmpPct = cfg.amplifyDamagePct;
  }
}

// Call once after all skills (old + new) are in SKILLS:
applyTestOverridesToAll(SKILLS);
