// src/systems/DevFlags.js
// Runtime dev toggles — stored in localStorage so they survive page reloads
// but never touch save-slot data.
//
//  devBreakthrough  — zero MP costs, zero stat requirements for player skills
//  devBuildup       — player skills deal 5× buildup
//  devAllTribes     — bypass tribe restriction at all tribe vendors (testing)
//  devSuperSaiyan   — player units deal 10× damage

const KEY_BREAKTHROUGH  = 'dev_breakthrough';
const KEY_BUILDUP       = 'dev_buildup';
const KEY_ALL_TRIBES    = 'dev_all_tribes';
const KEY_SUPER_SAIYAN  = 'dev_super_saiyan';

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
};
