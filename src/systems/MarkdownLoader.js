const EXCLUDE_PATTERNS = ['non-canonical', 'game notes'];
const SUPPORTED_EXTENSIONS = new Set(['.md', '.markdown']);

const CATEGORY_KEYWORDS = {
    systems: ['weakness', 'mechanic', 'systems', 'stat', 'weapon'],
    lore: ['tribe', 'island', 'lore', 'world', 'building', 'camp', 'character', 'prophet', 'false-god', 'history', 'handbook'],
    hunt: ['hunt', 'synopsis', 'state-of-the-world', 'personal-log', 'teaser']
};

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
    if (provided) return provided;
    const lower = relativePath.toLowerCase();
    const entries = Object.entries(CATEGORY_KEYWORDS);
    for (const [category, keywords] of entries) {
        if (category === 'lore') continue;
        if (keywords.some(keyword => lower.includes(keyword))) {
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
    return `${text.slice(0, limit - 1).trimEnd()}…`;
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
    const id = meta.id || inferredId;
    const filenameTitle = slugToTitle(relativePath);
    const category = inferCategory(relativePath, meta.category);
    const tags = parseListValue(meta.tags || []);
    const requires = normaliseRequires(meta.requires || []);
    const sort = parseNumber(meta.sort, 999);
    const version = parseNumber(meta.version, 1);
    const updatedAt = meta.updatedAt || (stats?.mtime ? new Date(stats.mtime).toISOString() : new Date().toISOString());
    const content = body.trim();
    const icon = typeof meta.icon === 'string' && meta.icon.trim() ? meta.icon.trim() : undefined;

    const { title, excerpt } = deriveTitleAndExcerpt(content, meta.title, filenameTitle, meta.excerpt);

    const entry = {
        id,
        category,
        tags,
        title,
        excerpt,
        content,
        links: { related: [] },
        requires,
        sort,
        version,
        updatedAt
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
            entries.push(buildEntry({ meta, body, relativePath: posixRelative, stats: fileStat }));
        }
    }

    try {
        await walk(resolvedBase);
    } catch (err) {
        console.warn('[MarkdownLoader] Failed to read markdown files:', err);
    }

    return entries;
}

export async function readAllMarkdown(basePath = '/data/journal/md') {
    if (hasNodeFs()) {
        return readMarkdownFilesNode(basePath);
    }
    console.warn('[MarkdownLoader] Browser environment detected; provide preloaded markdown assets.');
    return [];
}

export default { readAllMarkdown };