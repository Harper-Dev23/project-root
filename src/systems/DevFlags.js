// src/systems/DevFlags.js
// Runtime dev toggles — stored in localStorage so they survive page reloads
// but never touch save-slot data.
//
// Each flag does exactly ONE thing — none of them overlap or bundle another
// flag's effect. If you want several at once, turn on several toggles.
//
//  devBreakthrough  — zero stat requirements for player skills (nothing else)
//  devFreeMana      — zero MP costs
//  devNoCooldown    — skip cooldown gating
//  devNoRange       — bypass positionRequirement/targetColumns range restrictions
//  devBuildup       — player skills deal 5× buildup
//  devAllTribes     — bypass tribe restriction at all tribe vendors (testing)
//  devSuperSaiyan   — player units deal 10× damage

const KEY_BREAKTHROUGH  = 'dev_breakthrough';
const KEY_BUILDUP       = 'dev_buildup';
const KEY_ALL_TRIBES    = 'dev_all_tribes';
const KEY_SUPER_SAIYAN  = 'dev_super_saiyan';
const KEY_FREE_MANA     = 'dev_free_mana';
const KEY_NO_COOLDOWN   = 'dev_no_cooldown';
const KEY_NO_RANGE      = 'dev_no_range';

export const DevFlags = {
  isBreakthroughEnabled() {
    return localStorage.getItem(KEY_BREAKTHROUGH) === 'true';
  },
  toggleBreakthrough() {
    const next = !this.isBreakthroughEnabled();
    localStorage.setItem(KEY_BREAKTHROUGH, String(next));
    return next;
  },

  isBuildupEnabled() {
    return localStorage.getItem(KEY_BUILDUP) === 'true';
  },
  toggleBuildup() {
    const next = !this.isBuildupEnabled();
    localStorage.setItem(KEY_BUILDUP, String(next));
    return next;
  },

  isAllTribesEnabled() {
    return localStorage.getItem(KEY_ALL_TRIBES) === 'true';
  },
  toggleAllTribes() {
    const next = !this.isAllTribesEnabled();
    localStorage.setItem(KEY_ALL_TRIBES, String(next));
    return next;
  },

  isSuperSaiyanEnabled() {
    return localStorage.getItem(KEY_SUPER_SAIYAN) === 'true';
  },
  toggleSuperSaiyan() {
    const next = !this.isSuperSaiyanEnabled();
    localStorage.setItem(KEY_SUPER_SAIYAN, String(next));
    return next;
  },

  isFreeManaEnabled() {
    return localStorage.getItem(KEY_FREE_MANA) === 'true';
  },
  toggleFreeMana() {
    const next = !this.isFreeManaEnabled();
    localStorage.setItem(KEY_FREE_MANA, String(next));
    return next;
  },

  isNoCooldownEnabled() {
    return localStorage.getItem(KEY_NO_COOLDOWN) === 'true';
  },
  toggleNoCooldown() {
    const next = !this.isNoCooldownEnabled();
    localStorage.setItem(KEY_NO_COOLDOWN, String(next));
    return next;
  },

  isNoRangeEnabled() {
    return localStorage.getItem(KEY_NO_RANGE) === 'true';
  },
  toggleNoRange() {
    const next = !this.isNoRangeEnabled();
    localStorage.setItem(KEY_NO_RANGE, String(next));
    return next;
  },
};
