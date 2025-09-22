export function chooseNPCAction(npc, enemies) {
  // pick the first valid enemy target that isn't down
  const target = enemies?.find(e => e && e.status !== 'incapacitated');
  if (!target) return null;

  const skills = npc.skills || npc.weaponSkills || [];
  const has = id => skills.includes(id) || skills.some(s => s?.id === id);

  // Helper: current column (based on conventional slot groupings)
  const slotId = npc?._slot?.slotId;
  const col = ([1,2,3].includes(slotId) && 'front') ||
              ([4,5].includes(slotId)   && 'mid')   ||
              ([6,7,8].includes(slotId) && 'back')  || null;

  // 1) If we can shuffle and we're in a "worse" position (e.g., front for a dummy),
  //    sometimes do it for movement variety (40% chance).
  if (has('dummy_shuffle')) {
    const shouldShuffle =
      (col === 'front') ||              // get out of danger
      (Math.random() < 0.4);            // or just be annoying

    if (shouldShuffle) {
      return { type: 'class', target: null, skill: 'dummy_shuffle' };
    }
  }

  // 2) Prefer fireball if available; it will be column-gated by your scene.
  if (has('fireball')) {
    return { type: 'class', target, skill: 'fireball' };
  }

  // 3) Otherwise basic attack if available.
  if (has('basic_attack')) {
    return { type: 'major', target, skill: 'basic_attack' };
  }

  // 4) Nothing to do.
  return null;
}
