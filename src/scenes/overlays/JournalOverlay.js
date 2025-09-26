import { createOverlayFrame } from '../../ui/OverlayFrame.js';

export default class JournalOverlay extends Phaser.Scene {
    constructor() {
        super({ key: 'JournalOverlay' });
    }

    create() {
        const frame = createOverlayFrame(this, {
            title: 'Journal',
            onClose: () => this._close()
        });

        const depth = frame.depth;
        const bounds = frame.bounds;
        const left = bounds.x + 40;
        let cursorY = bounds.y + 90;

        const headerStyle = { fontSize: '20px', color: '#ffddaa', fontStyle: 'bold' };
        const entryStyle = { fontSize: '16px', color: '#e6e2d3', wordWrap: { width: bounds.width - 80 } };

        this.add.text(left, cursorY, 'Recent Entries', headerStyle).setDepth(depth);
        cursorY += 34;

        const entries = [
            {
                title: 'Day 12 – Arrival at Camp Nehemiah',
                snippet: 'We have settled within the outer ring of tents. Spirits are high, though rations run thin.'
            },
            {
                title: 'Day 13 – Whispered Warnings',
                snippet: 'A trader spoke of a hidden sanctum beneath the cliffs. The party is eager to investigate.'
            },
            {
                title: 'Day 14 – Moonlit Vigil',
                snippet: 'Sister Maris kept watch while the others rested. She swears the bonfire sparks formed symbols.'
            }
        ];

        entries.forEach(entry => {
            this.add.text(left + 10, cursorY, entry.title, { fontSize: '18px', color: '#ffffcc' }).setDepth(depth);
            cursorY += 24;
            this.add.text(left + 20, cursorY, entry.snippet, entryStyle).setDepth(depth);
            cursorY += 48;
        });

        const footer = 'Future journal updates will collect key story beats, lore discoveries, and character notes.';
        this.add.text(left, bounds.bottom - 80, footer, {
            fontSize: '14px',
            color: '#bbbbbb',
            wordWrap: { width: bounds.width - 80 }
        }).setDepth(depth);
    }

    _close() {
        this.scene.resume('UIScene');
        this.scene.stop();
    }
}