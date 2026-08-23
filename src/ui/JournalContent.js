import { COLORS, FONTS } from './styles.js';

const CONTAINER_PADDING = 24;
const CONTENT_TOP_OFFSET = CONTAINER_PADDING + 110;

// **bold**/_italic_ inline formatting — was only ever applied to plain
// paragraph lines; list items pushed their raw text into listBuffer without
// ever passing through here, so "- **Vendors** - exchange..." rendered with
// the literal asterisks still showing instead of bold text.
function escapeAttr(value) {
    return String(value).replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatInline(text) {
    // Inline code is pulled out FIRST and stashed, so its contents can't be
    // mangled by the emphasis rules below (a formula like `2 * INT` would
    // otherwise have its asterisk eaten as italics).
    const code = [];
    let out = String(text).replace(/`([^`]+)`/g, (_m, c) => {
        code.push(c);
        return `@@CODE${code.length - 1}@@`;
    });

    out = out
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        // Single-asterisk italics — the vault notes use *this* far more than
        // _this_, and without it the asterisks rendered literally (e.g. every
        // prophet entry opened with a visible "*Major Prophet of ...*").
        // Runs AFTER the ** rule so bold isn't chewed up first.
        .replace(/(^|[^*])\*(?!\s)([^*]+?)\*(?!\*)/g, '$1<em>$2</em>')
        .replace(/_(.+?)_/g, '<em>$1</em>')
        // Obsidian-style wikilinks — [[Target]] and [[Target|Shown text]].
        // These came straight over from the vault notes and used to render
        // as literal "[[Bay of Solace]]" brackets. Now they become real
        // in-journal navigation, resolved by title/slug at click time
        // (see _bindWikiLinks) rather than needing exact entry ids.
        .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target, label) => {
            const t = target.trim();
            return `<a href="#" class="journal-wikilink" data-target="${escapeAttr(t)}">${label ? label.trim() : t}</a>`;
        })
        // Standard markdown links to other entries: [text](entry:some/id)
        .replace(/\[([^\]]+)\]\(entry:([^)]+)\)/g,
            (_m, label, id) => `<a href="#" class="journal-wikilink" data-target="${escapeAttr(id.trim())}">${label}</a>`);

    // Restore the stashed code spans.
    return out.replace(/@@CODE(\d+)@@/g, (_m, i) => `<code>${escapeAttr(code[Number(i)])}</code>`);
}

function simpleMarkdownToHtml(markdown = '') {
    const lines = markdown.split(/\r?\n/);
    const html = [];
    let listBuffer = [];

    const flushList = () => {
        if (!listBuffer.length) return;
        html.push('<ul>' + listBuffer.map(item => `<li>${item}</li>`).join('') + '</ul>');
        listBuffer = [];
    };

    // Blockquote and table buffers — both are multi-line constructs, so they
    // accumulate across iterations and flush when the block ends. Neither
    // was supported before: vault notes lean on `> quotes` heavily and
    // several system pages are built around pipe tables, and both were
    // rendering as raw punctuation.
    let quoteBuffer = [];
    let tableBuffer = [];

    const flushQuote = () => {
        if (!quoteBuffer.length) return;
        html.push('<blockquote>' + quoteBuffer.map(q => `<p>${q}</p>`).join('') + '</blockquote>');
        quoteBuffer = [];
    };

    const splitRow = (row) => row
        .replace(/^\s*\|/, '')
        .replace(/\|\s*$/, '')
        .split('|')
        .map(cell => cell.trim());

    const flushTable = () => {
        if (!tableBuffer.length) return;
        // A separator row (|---|---|) marks the line above it as the header.
        const sepIdx = tableBuffer.findIndex(r => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(r) && r.includes('-'));
        let headRow = null;
        let bodyRows = tableBuffer;
        if (sepIdx > 0) {
            headRow = tableBuffer[sepIdx - 1];
            bodyRows = tableBuffer.slice(sepIdx + 1);
        }
        const head = headRow
            ? '<thead><tr>' + splitRow(headRow).map(c => `<th>${formatInline(c)}</th>`).join('') + '</tr></thead>'
            : '';
        const body = '<tbody>' + bodyRows
            .map(r => '<tr>' + splitRow(r).map(c => `<td>${formatInline(c)}</td>`).join('') + '</tr>')
            .join('') + '</tbody>';
        html.push(`<table class="journal-table">${head}${body}</table>`);
        tableBuffer = [];
    };

    const flushAll = () => { flushList(); flushQuote(); flushTable(); };

    for (const rawLine of lines) {
        const line = rawLine.trim();

        // Table rows: any line that starts and ends with a pipe.
        if (/^\|.*\|$/.test(line)) {
            flushList(); flushQuote();
            tableBuffer.push(line);
            continue;
        }
        if (tableBuffer.length) flushTable();

        // Blockquotes.
        if (line.startsWith('>')) {
            flushList();
            quoteBuffer.push(formatInline(line.replace(/^>\s?/, '')));
            continue;
        }
        if (quoteBuffer.length) flushQuote();

        if (!line) {
            flushAll();
            html.push('<p></p>');
            continue;
        }
        if (line.startsWith('### ')) {
            flushList();
            html.push(`<h3>${formatInline(line.slice(4))}</h3>`);
            continue;
        }
        if (line.startsWith('## ')) {
            flushList();
            html.push(`<h2>${formatInline(line.slice(3))}</h2>`);
            continue;
        }
        if (line.startsWith('# ')) {
            flushList();
            html.push(`<h1>${formatInline(line.slice(2))}</h1>`);
            continue;
        }
        if (/^[-*] /.test(line)) {
            const item = line.replace(/^[-*]\s+/, '');
            listBuffer.push(formatInline(item));
            continue;
        }

        flushList();
        html.push(`<p>${formatInline(line)}</p>`);
    }

    flushAll();
    return html.join('');
}

export default class JournalContent extends Phaser.GameObjects.Container {
    constructor(scene, x, y, width, height, { onNavigate, resolveEntryRef, resolveTokens, domDepth = 0 } = {}) {
        super(scene, x, y);
        this.setSize(width, height);
        this.onNavigate = onNavigate;
        this.resolveEntryRef = resolveEntryRef;
        // Optional {{token}} -> live-value resolver, so an entry can display
        // real save state (elapsed days, tickets, standing) instead of being
        // frozen prose. Entries with no tokens are unaffected.
        this.resolveTokens = resolveTokens;

        this.background = scene.add.rectangle(0, 0, width, height, COLORS.panel, 0.85)
            .setOrigin(0)
            .setStrokeStyle(1, COLORS.border);

        this.scrollContainer = scene.add.container(0, 0);
        this.maskGfx = scene.make.graphics({ x: 0, y: 0, add: false });
        this.maskGfx.fillStyle(0xffffff);
        this.maskGfx.fillRect(0, 0, width, height);
        this.maskRect = this.maskGfx.createGeometryMask();
        this.scrollContainer.setMask(this.maskRect);
        this._syncMaskPosition = () => {
            const matrix = this.getWorldTransformMatrix?.();
            if (!matrix) return;
            this.maskGfx.setPosition(matrix.tx, matrix.ty);
        };
        scene.events.on('postupdate', this._syncMaskPosition);
        this._syncMaskPosition();

        this.titleText = scene.add.text(CONTAINER_PADDING, CONTAINER_PADDING, 'Select an entry', {
            ...FONTS.heading,
            fontSize: '26px',
            color: '#ffffff'
        }).setOrigin(0, 0);

        this.metaText = scene.add.text(CONTAINER_PADDING, CONTAINER_PADDING + 42, '', {
            ...FONTS.body,
            fontSize: '14px',
            color: '#bbbbbb'
        }).setOrigin(0, 0);

        this.tagContainer = scene.add.container(CONTAINER_PADDING, CONTAINER_PADDING + 70);

        const contentWidth = width - CONTAINER_PADDING * 2;
        const viewportHeight = height - CONTENT_TOP_OFFSET;

        this.contentDom = scene.add.dom(x + CONTAINER_PADDING, y + CONTENT_TOP_OFFSET).createFromHTML(`
      <div class="journal-scroll-wrapper">
        <div class="journal-content">
          <p>Choose an entry from the list.</p>
        </div>
      </div>
    `);
        this.contentDom.setOrigin(0, 0);
        this.contentDom.setDepth(domDepth);

        const wrapperNode = this.contentDom.node;
        this._domWrapper = wrapperNode || null;
        this._contentInner = wrapperNode?.querySelector('.journal-content') ?? null;

        if (wrapperNode) {
            wrapperNode.style.position = 'absolute';
            wrapperNode.style.left = '0';
            wrapperNode.style.top = '0';
            wrapperNode.style.width = `${contentWidth}px`;
            wrapperNode.style.height = `${viewportHeight}px`;
            wrapperNode.style.overflow = 'hidden';
            wrapperNode.style.background = 'transparent';
            wrapperNode.style.pointerEvents = 'auto';
            this._domWheelHandler = (event) => {
                event.preventDefault();
                this.scrollBy(event.deltaY);
            };
            wrapperNode.addEventListener('wheel', this._domWheelHandler, { passive: false });
        }

        if (this._contentInner) {
            this._contentInner.style.minHeight = `${viewportHeight}px`;
            this._contentInner.style.width = '100%';
            this._contentInner.style.boxSizing = 'border-box';
            this._contentInner.style.color = '#e6e6e6';
            this._contentInner.style.fontFamily = `'Cormorant Garamond', serif`;
            this._contentInner.style.fontSize = '18px';
            this._contentInner.style.lineHeight = '1.5';
        }

        this.scrollContainer.add([this.titleText, this.metaText, this.tagContainer]);
        this.add([this.background, this.scrollContainer]);

        // Was this.setInteractive(new Phaser.Geom.Rectangle(...), Rectangle.Contains)
        // + this.on('wheel', ...) directly on the CONTAINER — found (via a real
        // headless-browser click sweep, not just code reading) to hit-test as
        // if it covered nearly the ENTIRE screen regardless of this container's
        // real (x, y, width, height), silently swallowing clicks meant for the
        // category tabs and anything else that happened to render earlier in
        // the display list underneath its true footprint. Same bug, same fix,
        // as JournalTree's own wheel listener: move it to the SCENE's global
        // input and bounds-check the pointer manually instead of relying on a
        // Container's own explicit-shape hit area.
        this._onWheel = (pointer, _gameObjects, _dx, dy) => {
            const matrix = this.getWorldTransformMatrix?.();
            if (!matrix) return;
            const mx = pointer.worldX;
            const my = pointer.worldY;
            if (mx >= matrix.tx && mx <= matrix.tx + width && my >= matrix.ty && my <= matrix.ty + height) {
                this.scrollBy(dy);
            }
        };
        scene.input.on('wheel', this._onWheel);

        scene.add.existing(this);

        this._boundSync = () => this._syncDomPosition();
        scene.events.on('postupdate', this._boundSync);
        scene.events.once('postupdate', this._boundSync);
    }

    destroy(fromScene) {
        this.scene?.events?.off('postupdate', this._syncMaskPosition);
        this.scene?.input?.off('wheel', this._onWheel);
        this.scrollContainer?.clearMask?.();
        this.maskRect?.destroy();
        this.maskGfx?.destroy();
        if (this._domWrapper && this._domWheelHandler) {
            this._domWrapper.removeEventListener('wheel', this._domWheelHandler);
        }
        this.contentDom?.destroy();
        this.scene?.events?.off('postupdate', this._boundSync);
        super.destroy(fromScene);
    }

    scrollBy(delta) {
        const bounds = this.scrollContainer.getBounds();
        const contentHeight = Math.max(bounds.height, this._getDomContentHeight());
        const maxScroll = Math.max(0, contentHeight - this.height + 24);
        this.scrollContainer.y = Phaser.Math.Clamp(this.scrollContainer.y - delta, -maxScroll, 0);
        this._syncDomPosition();
    }

    _renderTags(tags = []) {
        this.tagContainer.removeAll(true);
        if (!tags.length) return 0;
        let x = 0;
        const h = 22;
        for (const tag of tags) {
            const pill = this.scene.add.rectangle(x, 0, tag.length * 10 + 20, h, 0x2d2d2d, 0.9)
                .setOrigin(0, 0.5)
                .setStrokeStyle(1, COLORS.border);
            const txt = this.scene.add.text(x + 10, 0, tag, { ...FONTS.muted, color: '#ffffff' })
                .setOrigin(0, 0.5);
            this.tagContainer.add([pill, txt]);
            x += pill.width + 8;
        }
        return h;
    }

    setEntry(entry) {
        if (!entry) {
            this.titleText.setText('Select an entry');
            this.metaText.setText('');
            this._renderTags([]);
            this._setContentHtml('<p>Choose an entry from the list.</p>');
            this._resetScroll();
            return;
        }

        this.titleText.setText(entry.title);
        // Meta line deliberately minimal. It used to read
        // "Updated 8/23/2026 • v1 • Tags: places, coastal" — a file mtime
        // and a version number that mean nothing in-fiction, followed by the
        // same tags already drawn as pills right below it. Only the subtab
        // (a real navigational fact) survives.
        this.metaText.setText(entry.subtab || '');
        this._renderTags(entry.tags || []);

        // Substitute {{tokens}} before markdown conversion, so a token can
        // sit inside a heading, list item or table cell and still format.
        let raw = entry.content || '';
        if (this.resolveTokens) {
            raw = raw.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (m, key) => {
                const v = this.resolveTokens(key);
                return (v === undefined || v === null) ? m : String(v);
            });
        }
        const html = simpleMarkdownToHtml(raw);
        const relatedLinks = (entry.links?.related || [])
            .map(id => `<button data-entry="${id}" class="journal-related">${id}</button>`)
            .join('');

        const baseHtml = `
        <style>
          .journal-content h1 { font-size: 28px; margin: 12px 0; }
          .journal-content h2 { font-size: 24px; margin: 12px 0; }
          .journal-content h3 { font-size: 20px; margin: 12px 0; }
          .journal-content p { margin: 12px 0; }
          .journal-content ul { margin: 12px 18px; padding: 0 18px; }
          .journal-content table.journal-table {
            border-collapse: collapse;
            margin: 14px 0;
            width: 100%;
            font-size: 0.94em;
          }
          .journal-content table.journal-table th,
          .journal-content table.journal-table td {
            border: 1px solid #3a3a44;
            padding: 6px 10px;
            text-align: left;
            vertical-align: top;
          }
          .journal-content table.journal-table th {
            background: #23232b;
            color: #ffddaa;
            font-weight: bold;
          }
          .journal-content table.journal-table tr:nth-child(even) td { background: #1a1a20; }
          .journal-content blockquote {
            margin: 12px 0;
            padding: 2px 0 2px 14px;
            border-left: 3px solid #5a4a3a;
            color: #b9b2a4;
            font-style: italic;
          }
          .journal-content blockquote p { margin: 4px 0; }
          .journal-content code {
            background: #23232b;
            border: 1px solid #3a3a44;
            border-radius: 3px;
            padding: 1px 5px;
            font-family: monospace;
            font-size: 0.92em;
            color: #cfe0a0;
          }
          .journal-content a.journal-wikilink {
            color: #9ecbff;
            text-decoration: none;
            border-bottom: 1px dotted #4a6a8a;
            cursor: pointer;
          }
          .journal-content a.journal-wikilink:hover { color: #ffddaa; border-bottom-color: #ffddaa; }
          .journal-content a.journal-wikilink.is-missing {
            color: #8a8a96;
            border-bottom-style: none;
            cursor: default;
          }
          .journal-content button.journal-related {
            background: #1f1f1f;
            color: #ffddaa;
            border: 1px solid #444;
            padding: 6px 12px;
            margin: 6px 6px 0 0;
            border-radius: 4px;
            cursor: pointer;
          }
        </style>
        ${html || '<p>No content yet.</p>'}
        ${relatedLinks ? `<div class="journal-related-group"><strong>Related:</strong> ${relatedLinks}</div>` : ''}`;

        this._setContentHtml(baseHtml, entry.id ?? '');
        this._bindRelatedEntryButtons();
        this._bindWikiLinks();
        this._resetScroll();
    }

    forceDomSync() {
        this._syncDomPosition();
    }

    _resetScroll() {
        this.scrollContainer.y = 0;
        this._syncDomPosition();
    }
    _getDomContentHeight() {
        const baseHeight = this._contentInner?.scrollHeight || 0;
        return baseHeight + CONTENT_TOP_OFFSET;
    }

    _syncDomPosition() {
        if (!this.contentDom) return;
        const matrix = this.getWorldTransformMatrix?.();
        if (!matrix) return;
        const baseX = matrix.tx + CONTAINER_PADDING;
        const baseY = matrix.ty + CONTENT_TOP_OFFSET;
        this.contentDom.setPosition(baseX, baseY);
        if (this._contentInner) {
            this._contentInner.style.transform = `translateY(${this.scrollContainer.y}px)`;
        }
    }

    /**
     * Wires [[wikilinks]] to real journal navigation.
     *
     * Vault notes link by human title ("[[Bay of Solace]]"), not by entry id
     * ("places/bay_of_solace"), so resolution is done here against the live
     * entry list rather than expecting authors to write ids. Anything that
     * doesn't resolve is greyed out and inert instead of being a dead link
     * that looks clickable — a lot of vault notes reference pages that were
     * never brought across.
     */
    _bindWikiLinks() {
        if (!this._contentInner) return;
        this._contentInner.querySelectorAll('a.journal-wikilink').forEach(a => {
            const raw = (a.getAttribute('data-target') || '').trim();
            const resolved = this.resolveEntryRef ? this.resolveEntryRef(raw) : null;
            if (!resolved) {
                a.classList.add('is-missing');
                a.setAttribute('title', `No journal entry for "${raw}" yet`);
                a.addEventListener('click', e => e.preventDefault());
                return;
            }
            a.setAttribute('title', resolved.title || raw);
            a.addEventListener('click', (e) => {
                e.preventDefault();
                this.onNavigate?.(resolved.id);
            });
        });
    }

    _bindRelatedEntryButtons() {
        if (!this._contentInner) return;
        this._contentInner.querySelectorAll('button.journal-related').forEach(btn => {
            btn.addEventListener('click', () => {
                const target = btn.getAttribute('data-entry');
                if (target) {
                    this.onNavigate?.(target);
                }
            });
        });
    }

    _setContentHtml(html, entryId = '') {
        if (!this._contentInner) return;
        this._contentInner.innerHTML = html;
        if (entryId) {
            this._contentInner.setAttribute('data-entry-id', entryId);
        } else {
            this._contentInner.removeAttribute('data-entry-id');
        }
    }
}
