// src/systems/DevFlags.js
// Runtime dev toggles — stored in localStorage so they survive page reloads
// but never touch save-slot data.
//
//  devBreakthrough  — zero MP costs, zero stat requirements for player skills
//                     (bundles the same effect as devFreeMana, plus stat reqs)
//  devBuildup       — player skills deal 5× buildup
//  devAllTribes     — bypass tribe restriction at all tribe vendors (testing)
//  devSuperSaiyan   — player units deal 10× damage
//  devFreeMana      — zero MP costs on their own, independent of devBreakthrough
//  devNoCooldown    — skip cooldown gating on their own, independent of devBreakthrough
//  devNoRange       — bypass positionRequirement/targetColumns range restrictions

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

  // Combinators — devBreakthrough already implies these individually, so call
  // sites should check the combinator rather than either flag on its own.
  isManaCostBypassed() {
    return this.isBreakthroughEnabled() || this.isFreeManaEnabled();
  },
  isCooldownBypassed() {
    return this.isBreakthroughEnabled() || this.isNoCooldownEnabled();
  },
};
