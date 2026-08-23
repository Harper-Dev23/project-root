const EXCLUDE_PATTERNS = ['non-canonical', 'game notes'];
const SUPPORTED_EXTENSIONS = new Set(['.md', '.markdown']);
// MUST stay in sync with JOURNAL_CATEGORIES in data/journal/manifest.js.
// 'divinity' was missing here while 27 entries declared `category: divinity`
// in their frontmatter — inferCategory rejects anything not in this set and
// falls through to keyword matching, where CATEGORY_KEYWORDS.lore contains
// 'prophet'/'false-god', so the whole Divinity section silently emptied into
// Lore. Same for 'index' and the 'world/' folder.
const VALID_CATEGORIES = new Set([
    'lore', 'systems', 'hunt', 'people', 'places',
    'factions', 'buildings', 'personal', 'divinity', 'items', 'index',
]);

const CATEGORY_KEYWORDS = {
    systems: ['weakness', 'mechanic', 'systems', 'stat', 'weapon'],
    lore: ['tribe', 'island', 'lore', 'world', 'building', 'camp', 'character', 'prophet', 'false-god', 'history', 'handbook'],
    hunt: ['hunt', 'synopsis', 'state-of-the-world', 'personal-log', 'teaser'],
    people: ['elder', 'vendor', 'people', 'seers', 'mourne'],
    places: ['place', 'camp', 'forest', 'shoals', 'shroud'],
    factions: ['faction', 'tribe', 'renown', 'favor'],
    buildings: ['building', 'waystone', 'shrine', 'vendor'],
    personal: ['personal', 'log']
};

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normaliseBasePath(basePath = '') {
    if (!basePath) return '';
    return basePath.replace(/\/+$/, '');
}

function normaliseIndexEntry(entry) {
    if (!entry) return null;
    if (typeof entry === 'string') {
        return { path: entry };
    }
    if (!isPlainObject(entry)) return null;
    const path = typeof entry.path === 'string'
        ? entry.path
        : (typeof entry.file === 'string' ? entry.file : null);
    if (!path) return null;
    const meta = isPlainObject(entry.meta) ? entry.meta : undefined;
    const updatedAt = entry.updatedAt;
    return { path, meta, updatedAt };
}


function hasNodeFs() {
    return typeof process !== 'undefined' && !!process.versions?.node;
}

function toPosixPath(pathModule, value) {
    if (!value) return '';
    return value.split(pathModule.sep).join('/');
}

function resolveBasePath(pathModule, basePath) {
    if (!basePath) return process.cwd?.() || '.';
    if (basePath.startsWith('/')) {
        const cwd = process.cwd?.() || '';
        return pathModule.join(cwd, basePath.replace(/^\//, ''));
    }
    return pathModule.isAbsolute(basePath)
        ? basePath
        : pathModule.join(process.cwd?.() || '', basePath);
}

function cleanQuoted(value) {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}

function parseListValue(raw) {
    if (Array.isArray(raw)) {
        return raw.map(item => cleanQuoted(String(item))).map(item => item.trim()).filter(Boolean);
    }
    if (typeof raw !== 'string') return [];
    const trimmed = raw.trim();
    if (!trimmed) return [];
    if (trimmed === '[]') return [];
    if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('(') && trimmed.endsWith(')'))) {
        const inner = trimmed.slice(1, -1);
        return inner.split(',').map(token => cleanQuoted(token).trim()).filter(Boolean);
    }
    return trimmed.split(',').map(token => cleanQuoted(token).trim()).filter(Boolean);
}

function parseNumber(raw, fallback) {
    const num = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(num) ? num : fallback;
}

function normaliseString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function slugify(value) {
    if (!value) return '';
    return String(value)
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+/, '')
        .replace(/-+$/, '');
}

function slugFromRelativePath(relativePath) {
    if (!relativePath) return '';
    const withoutExt = relativePath.replace(/\.[^.]+$/, '');
    const parts = withoutExt.split(/[\\/]/);
    return slugify(parts.pop());
}

function parseBoolean(raw, fallback = false) {
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'string') {
        const lowered = raw.trim().toLowerCase();
        if (['true', 'yes', '1', 'on'].includes(lowered)) return true;
        if (['false', 'no', '0', 'off'].includes(lowered)) return false;
    }
    return fallback;
}

function normaliseStatus(raw) {
    const value = normaliseString(raw).toLowerCase();
    if (value === 'draft') return 'draft';
    if (value === 'approved') return 'approved';
    return 'approved';
}

function parseFrontMatter(content) {
    const lines = content.split(/\r?\n/);
    if (lines[0]?.trim() !== '---') {
        return { meta: {}, body: content };
    }

    const meta = {};
    let i = 1;
    for (; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === '---') {
            i += 1;
            break;
        }
        if (!line.trim() || line.trim().startsWith('#')) continue;
        const match = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
        if (!match) continue;
        const key = match[1];
        let value = match[2] ?? '';
        if (typeof value === 'string') value = value.trim();

        if (!value) {
            const collected = [];
            let j = i + 1;
            for (; j < lines.length; j++) {
                const nextLine = lines[j];
                if (!nextLine.trim()) {
                    break;
                }
                const itemMatch = nextLine.match(/^\s*-\s+(.*)$/);
                if (!itemMatch) break;
                collected.push(cleanQuoted(itemMatch[1]).trim());
            }
            if (collected.length) {
                meta[key] = collected;
                i = j - 1;
                continue;
            }
            meta[key] = '';
            continue;
        }

        meta[key] = cleanQuoted(value);
    }

    const body = lines.slice(i).join('\n');
    return { meta, body };
}

function inferCategory(relativePath, provided) {
    const providedLower = normaliseString(provided).toLowerCase();
    if (VALID_CATEGORIES.has(providedLower)) return providedLower;
    const folder = (relativePath.split(/[\\/]/)[0] || '').toLowerCase();
    if (VALID_CATEGORIES.has(folder)) return folder;
    const lower = relativePath.toLowerCase();
    const entries = Object.entries(CATEGORY_KEYWORDS);
    for (const [category, keywords] of entries) {
        if (category === 'lore') continue;
        if (VALID_CATEGORIES.has(category) && keywords.some(keyword => lower.includes(keyword))) {
            return category;
        }
    }
    return 'lore';
}

function deriveTitleAndExcerpt(body, fallbackTitle, fallbackName, excerptOverride) {
    const lines = body.split(/\r?\n/);
    let headingTitle = null;
    let collecting = false;
    const paragraphLines = [];

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!collecting) {
            const headingMatch = rawLine.match(/^#\s+(.*)$/);
            if (headingMatch) {
                headingTitle = headingMatch[1].trim();
                collecting = true;
            }
            continue;
        }

        if (!line) {
            if (paragraphLines.length) break;
            continue;
        }
        if (line.startsWith('#')) break;
        paragraphLines.push(line);
    }

    let excerpt = paragraphLines.join(' ').trim();
    if (!excerpt) {
        const paragraphs = body
            .split(/\r?\n{2,}/)
            .map(block => block.replace(/\r?\n/g, ' ').trim())
            .filter(Boolean);
        excerpt = paragraphs.find(text => !text.startsWith('#')) || '';
    }

    const title = fallbackTitle || headingTitle || fallbackName;
    const excerptSource = excerptOverride || excerpt;
    const truncated = truncateExcerpt(excerptSource || '');
    return { title, excerpt: truncated };
}

function truncateExcerpt(text, limit = 160) {
    if (!text) return '';
    if (text.length <= limit) return text;
    const safeCut = Math.max(0, limit - 3);
    return `${text.slice(0, safeCut).trimEnd()}...`;
}

function slugToTitle(slug) {
    if (!slug) return '';
    const base = slug.replace(/\.[^.]+$/, '');
    const cleaned = base.split(/[\/]/).pop() || base;
    return cleaned
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, char => char.toUpperCase());
}

function shouldExclude(relativePath) {
    const lower = relativePath.toLowerCase();
    return EXCLUDE_PATTERNS.some(pattern => lower.includes(pattern));
}

function normaliseRequires(value) {
    const list = parseListValue(value);
    return list;
}

function buildEntry({ meta, body, relativePath, stats }) {
    const inferredId = relativePath.replace(/\.[^.]+$/, '');
    const filenameTitle = slugToTitle(relativePath);
    const category = inferCategory(relativePath, meta.category);
    const slugSource = normaliseString(meta.slug)
        || (typeof meta.id === 'string' ? meta.id.split(/[\\\/]/).pop() : '')
        || filenameTitle;
    const slug = slugify(slugSource || filenameTitle);
    if (!slug) {
        console.warn(`[MarkdownLoader] Skipping ${relativePath}: missing slug`);
        return null;
    }

    const tags = parseListValue(meta.tags || []);
    const requires = normaliseRequires(meta.requires || []);
    const explicitOrder = parseNumber(meta.order, null);
    const sort = parseNumber(meta.sort, explicitOrder ?? 999);
    const version = parseNumber(meta.version, 1);
    const updatedAt = meta.updatedAt || (stats?.mtime ? new Date(stats.mtime).toISOString() : new Date().toISOString());
    const rawBody = body.trim();
    // Strip the leading "# Title" for DISPLAY only. The title is already
    // shown in the reader's own header (JournalContent.titleText), so
    // leaving it in the markdown rendered it a second time as an <h1> —
    // the doubled header. Title/excerpt derivation below still reads
    // rawBody, so headings remain the title source for files whose
    // frontmatter omits `title:`.
    const content = rawBody.replace(/^#\s+.*(?:\r?\n)+/, '');
    const icon = typeof meta.icon === 'string' && meta.icon.trim() ? meta.icon.trim() : undefined;
    const subtabValue = normaliseString(meta.subtab);
    const subtab = subtabValue || null;
    const status = normaliseStatus(meta.status);
    const teaser = parseBoolean(meta.teaser, false);
    const titleOverride = normaliseString(meta.title) || undefined;

    const { title, excerpt } = deriveTitleAndExcerpt(rawBody, titleOverride, filenameTitle, meta.excerpt);
    if (!title) {
        console.warn(`[MarkdownLoader] Skipping ${relativePath}: missing title`);
        return null;
    }

    const id = meta.id || (category ? `${category}/${slug}` : inferredId) || inferredId;

    const entry = {
        id,
        category,
        slug,
        subtab,
        order: explicitOrder ?? sort,
        tags,
        title,
        excerpt,
        content,
        links: { related: [] },
        requires,
        sort,
        version,
        updatedAt,
        status,
        teaser
    };

    if (icon) {
        entry.icon = icon;
    }

    return entry;
}

async function readMarkdownFilesNode(basePath) {
    const pathModule = await import('path');
    const { default: pathDefault } = pathModule;
    const path = pathDefault || pathModule;
    const fsModule = await import('fs/promises');
    const { readdir, readFile, stat } = fsModule;
    const resolvedBase = resolveBasePath(path, basePath);
    const entries = [];

    async function walk(currentDir, relativeDir = '') {
        const dirEntries = await readdir(currentDir, { withFileTypes: true });
        for (const dirent of dirEntries) {
            const nextRelative = relativeDir ? path.join(relativeDir, dirent.name) : dirent.name;
            const posixRelative = toPosixPath(path, nextRelative);
            if (shouldExclude(posixRelative)) continue;
            const fullPath = path.join(currentDir, dirent.name);
            if (dirent.isDirectory()) {
                await walk(fullPath, nextRelative);
                continue;
            }
            const ext = path.extname(dirent.name).toLowerCase();
            if (!SUPPORTED_EXTENSIONS.has(ext)) continue;
            const fileStat = await stat(fullPath);
            const raw = await readFile(fullPath, 'utf8');
            const { meta, body } = parseFrontMatter(raw);
            const entry = buildEntry({ meta, body, relativePath: posixRelative, stats: fileStat });
            if (entry) entries.push(entry);
        }
    }

    try {
        await walk(resolvedBase);
    } catch (err) {
        console.warn('[MarkdownLoader] Failed to read markdown files:', err);
    }

    return entries;
}

async function readMarkdownFilesBrowser(basePath) {
    const entries = [];
    const base = normaliseBasePath(basePath);
    if (!base) return entries;
    if (typeof fetch !== 'function') {
        console.warn('[MarkdownLoader] fetch API unavailable; cannot load markdown in browser.');
        return entries;
    }

    const indexUrl = `${base}/index.json`;
    let listing;
    try {
        const response = await fetch(indexUrl, { cache: 'no-cache' });
        if (!response.ok) {
            console.warn(`[MarkdownLoader] Failed to fetch index at ${indexUrl}:`, response.status, response.statusText);
            return entries;
        }
        listing = await response.json();
    } catch (err) {
        console.warn('[MarkdownLoader] Error loading markdown index:', err);
        return entries;
    }

    if (!Array.isArray(listing)) {
        console.warn('[MarkdownLoader] Markdown index is not an array; skipping.');
        return entries;
    }

    const tasks = listing
        .map(normaliseIndexEntry)
        .filter(Boolean)
        .map(async (descriptor) => {
            const relative = descriptor.path.replace(/^[./]+/, '').replace(/\\/g, '/');
            if (shouldExclude(relative)) return null;
            const url = `${base}/${relative}`;
            try {
                const res = await fetch(url, { cache: 'no-cache' });
                if (!res.ok) {
                    console.warn(`[MarkdownLoader] Failed to fetch ${url}:`, res.status, res.statusText);
                    return null;
                }
                const text = await res.text();
                const { meta, body } = parseFrontMatter(text);
                const mergedMeta = descriptor.meta ? { ...descriptor.meta, ...meta } : meta;
                let stats;
                if (descriptor.updatedAt) {
                    const time = new Date(descriptor.updatedAt).getTime();
                    if (Number.isFinite(time)) {
                        stats = { mtime: time };
                    }
                }
                return buildEntry({ meta: mergedMeta, body, relativePath: relative, stats });
            } catch (err) {
                console.warn(`[MarkdownLoader] Error processing ${url}:`, err);
                return null;
            }
        });

    const resolved = await Promise.all(tasks);
    for (const entry of resolved) {
        if (entry) entries.push(entry);
    }

    return entries;
}

export async function readAllMarkdown(basePath = '/data/journal/md') {
    if (hasNodeFs()) {
        return readMarkdownFilesNode(basePath);
    }
    return readMarkdownFilesBrowser(basePath);
}

export default { readAllMarkdown };

