import { COLORS, FONTS } from './styles.js';

const CONTAINER_PADDING = 24;
const CONTENT_TOP_OFFSET = CONTAINER_PADDING + 110;

function simpleMarkdownToHtml(markdown = '') {
    const lines = markdown.split(/\r?\n/);
    const html = [];
    let listBuffer = [];

    const flushList = () => {
        if (!listBuffer.length) return;
        html.push('<ul>' + listBuffer.map(item => `<li>${item}</li>`).join('') + '</ul>');
        listBuffer = [];
    };

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
            flushList();
            html.push('<p></p>');
            continue;
        }
        if (line.startsWith('### ')) {
            flushList();
            html.push(`<h3>${line.slice(4)}</h3>`);
            continue;
        }
        if (line.startsWith('## ')) {
            flushList();
            html.push(`<h2>${line.slice(3)}</h2>`);
            continue;
        }
        if (line.startsWith('# ')) {
            flushList();
            html.push(`<h1>${line.slice(2)}</h1>`);
            continue;
        }
        if (/^[-*] /.test(line)) {
            const item = line.replace(/^[-*]\s+/, '');
            listBuffer.push(item);
            continue;
        }

        const formatted = line
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/_(.+?)_/g, '<em>$1</em>');
        flushList();
        html.push(`<p>${formatted}</p>`);
    }

    flushList();
    return html.join('');
}

export default class JournalContent extends Phaser.GameObjects.Container {
    constructor(scene, x, y, width, height, { onNavigate, domDepth = 0 } = {}) {
        super(scene, x, y);
        this.setSize(width, height);
        this.onNavigate = onNavigate;

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

        this.setInteractive(new Phaser.Geom.Rectangle(0, 0, width, height), Phaser.Geom.Rectangle.Contains);
        this.on('wheel', (pointer, dx, dy) => {
            this.scrollBy(dy);
        });

        scene.add.existing(this);

        this._boundSync = () => this._syncDomPosition();
        scene.events.on('postupdate', this._boundSync);
        scene.events.once('postupdate', this._boundSync);
    }

    destroy(fromScene) {
        this.scene?.events?.off('postupdate', this._syncMaskPosition);
        this.scrollContainer?.clearMask?.();
        this.maskRect?.destroy();
        this.maskGfx?.destroy();
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
        const updated = entry.updatedAt ? new Date(entry.updatedAt).toLocaleDateString() : '';
        const tagLine = entry.tags?.length ? `Tags: ${entry.tags.join(', ')}` : '';
        const versionText = entry.version ? `v${entry.version}` : '';
        const parts = [updated && `Updated ${updated}`, versionText, tagLine].filter(Boolean);
        this.metaText.setText(parts.join(' • '));
        this._renderTags(entry.tags || []);

        const html = simpleMarkdownToHtml(entry.content || '');
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