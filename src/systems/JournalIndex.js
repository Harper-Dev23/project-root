import { JournalState } from './JournalState.js';

const TITLE_WEIGHT = 5;
const EXCERPT_WEIGHT = 3;
const CONTENT_WEIGHT = 1;

function normalise(text = '') {
    return (text || '').toLowerCase();
}

function tokenise(text = '') {
  return normalise(text)
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);
}

function buildSnippet(content, term) {
  if (!content) return '';
  const lower = normalise(content);
  const idx = lower.indexOf(term);
  if (idx === -1) {
    return content.slice(0, 140) + (content.length > 140 ? '…' : '');
  }
  const start = Math.max(0, idx - 40);
  const end = Math.min(content.length, idx + term.length + 60);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < content.length ? '…' : '';
  return prefix + content.slice(start, end) + suffix;
}

export class JournalIndex {
  constructor(entries = []) {
    this.entries = Array.isArray(entries) ? entries : [];
    this.cache = new Map();
    this.build();
  }

  setEntries(entries = []) {
    this.entries = Array.isArray(entries) ? entries : [];
    this.build();
  }

  build() {
    this.cache.clear();
    for (const entry of this.entries) {
      if (!entry || !entry.id) continue;
      this.cache.set(entry.id, {
        tokens: {
          title: tokenise(entry.title),
          excerpt: tokenise(entry.excerpt),
          content: tokenise(entry.content)
        },
        raw: entry
      });
    }
      }

  search(query) {
    const trimmed = (query || '').trim();
    if (!trimmed) return [];
    const terms = tokenise(trimmed);
    if (!terms.length) return [];

    const results = [];

    for (const [id, data] of this.cache.entries()) {
      const entry = data.raw;
      if (!JournalState.isUnlockedEntry(entry)) continue;

      let score = 0;
      let snippet = '';

      for (const term of terms) {
        const titleHits = data.tokens.title.filter(t => t.includes(term)).length;
        const excerptHits = data.tokens.excerpt.filter(t => t.includes(term)).length;
        const contentHits = data.tokens.content.filter(t => t.includes(term)).length;

        if (titleHits) {
          score += titleHits * TITLE_WEIGHT;
          snippet = snippet || entry.title;
        }
        if (excerptHits) {
          score += excerptHits * EXCERPT_WEIGHT;
          snippet = snippet || entry.excerpt;
        }
        if (contentHits) {
          score += contentHits * CONTENT_WEIGHT;
          snippet = snippet || buildSnippet(entry.content, term);
        }
    }
      if (score > 0) {
        results.push({ entryId: id, score, snippet });
      }
    }
    
    return results.sort((a, b) => b.score - a.score);
  }
}

export default JournalIndex;