import { createOverlayFrame } from '../../ui/OverlayFrame.js';

export default class QuestOverlay extends Phaser.Scene {
  constructor() {
    super({ key: 'QuestOverlay' });
  }

  create() {
    const frame = createOverlayFrame(this, {
      title: 'Quest Log',
      onClose: () => this._close(),
      bgImage: 'menu_parchment_background'
    });

    const depth = frame.depth;
    const bounds = frame.bounds;
    const left = bounds.x + 40;
    let cursorY = bounds.y + 90;

    const sectionStyle = { fontSize: '20px', color: '#ffddaa', fontStyle: 'bold' };
    const questTitleStyle = { fontSize: '18px', color: '#ffffcc' };
    const questBodyStyle = { fontSize: '16px', color: '#e0e0e0', wordWrap: { width: bounds.width - 80 } };

    this.add.text(left, cursorY, 'Active Quests', sectionStyle).setDepth(depth);
    cursorY += 34;

    const activeQuests = [
      {
        name: 'The Missing Envoy',
        summary: 'Locate the diplomat last seen traveling toward the storm-scarred ridge and ensure their safe return.'
      },
      {
        name: 'Supply Lines',
        summary: 'Gather three crates of provisions from the outskirts to keep camp morale from faltering.'
      }
    ];

    activeQuests.forEach(quest => {
      this.add.text(left + 10, cursorY, quest.name, questTitleStyle).setDepth(depth);
      cursorY += 24;
      this.add.text(left + 20, cursorY, quest.summary, questBodyStyle).setDepth(depth);
      cursorY += 48;
    });

    cursorY += 10;
    this.add.text(left, cursorY, 'Completed', sectionStyle).setDepth(depth);
    cursorY += 34;

    this.add.text(left + 10, cursorY, '• Shadows Over the Docks (complete)', questBodyStyle).setDepth(depth);
    cursorY += 28;
    this.add.text(left + 10, cursorY, '• Rite of the Emberwatch (complete)', questBodyStyle).setDepth(depth);

    const footer = 'Quest tracking is not yet interactive. This layout previews how missions will be organized.';
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