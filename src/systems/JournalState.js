import { JOURNAL_ENTRIES } from '../../data/journal/entries.seed.js';

const STORAGE_KEY = 'game.journalState';

function loadState() {
    try {
        if (typeof localStorage === 'undefined') return { unlocks: [], seenEntries: [] };
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return { unlocks: [], seenEntries: [] };
        const parsed = JSON.parse(raw);
        return {
            unlocks: Array.isArray(parsed.unlocks) ? parsed.unlocks : [],
            seenEntries: Array.isArray(parsed.seenEntries) ? parsed.seenEntries : []
        };
    } catch (err) {
        console.warn('Failed to load journal state:', err);
        return { unlocks: [], seenEntries: [] };
    }
}

function persist(unlocks, seenEntries) {
    try {
        if (typeof localStorage === 'undefined') return;
        const payload = JSON.stringify({ unlocks: [...unlocks], seenEntries: [...seenEntries] });
        localStorage.setItem(STORAGE_KEY, payload);
    } catch (err) {
        console.warn('Failed to persist journal state:', err);
    }
}

function computeUnlockedEntries(unlockSet) {
    const unlocked = new Set();
    for (const entry of JOURNAL_ENTRIES) {
        if (entry.requires && entry.requires.length) {
            const meets = entry.requires.every(flag => unlockSet.has(flag));
            if (!meets) continue;
        }
        unlocked.add(entry.id);
    }
    return unlocked;
}

const listeners = new Map();

function emit(event, payload) {
    const subs = listeners.get(event);
    if (!subs) return;
    for (const cb of [...subs]) {
        try {
            cb(payload);
        } catch (err) {
            console.error('JournalState listener error', err);
        }
    }
}

function on(event, handler) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(handler);
    return () => listeners.get(event)?.delete(handler);
}

const initial = loadState();

export const JournalState = {
    unlocks: new Set(initial.unlocks),
    seenEntries: new Set(initial.seenEntries),
    on,
    addUnlock(flag) {
        if (!flag) return [];
        const before = computeUnlockedEntries(this.unlocks);
        const sizeBefore = this.unlocks.size;
        this.unlocks.add(flag);
        if (this.unlocks.size !== sizeBefore) {
            persist(this.unlocks, this.seenEntries);
        }
        const after = computeUnlockedEntries(this.unlocks);
        const newlyUnlocked = [...after].filter(id => !before.has(id));
        if (newlyUnlocked.length) {
            emit('journal:new-unlocks', { entryIds: newlyUnlocked });
            emit('journal:toast', { message: 'New Journal entry', entryIds: newlyUnlocked });
        }
        return newlyUnlocked;
    },
    isUnlockedEntry(entry) {
        if (!entry) return false;
        if (!entry.requires || entry.requires.length === 0) return true;
        return entry.requires.every(flag => this.unlocks.has(flag));
    },
    markSeen(entryId) {
        if (!entryId) return;
        const sizeBefore = this.seenEntries.size;
        this.seenEntries.add(entryId);
        if (this.seenEntries.size !== sizeBefore) {
            persist(this.unlocks, this.seenEntries);
            emit('journal:seen', { entryId });
        }
    },
    clearSeen(entryIds = []) {
        let changed = false;
        for (const id of entryIds) {
            if (this.seenEntries.delete(id)) {
                changed = true;
            }
        }
        if (changed) {
            persist(this.unlocks, this.seenEntries);
            emit('journal:seen-reset', { entryIds });
        }
    },
    reset() {
        this.unlocks.clear();
        this.seenEntries.clear();
        persist(this.unlocks, this.seenEntries);
        emit('journal:reset');
    }
};

export default JournalState;