export default class LoadingScene extends Phaser.Scene {
  constructor() {
    super({ key: 'LoadingScene' });
  }

  init(data) {
    this.targetScene = data?.targetScene || null;
    this.tip = data?.tip || '';
    this.targetSceneData = data?.targetSceneData || {};
  }

  preload() {
    const { width, height } = this.sys.game.canvas;

    this.add.rectangle(width / 2, height / 2, width, height, 0x000000);
    this.add.text(width / 2, height / 2, 'Loading...', {
      fontSize: '32px',
      color: '#ffffff'
    }).setOrigin(0.5);

    if (this.tip) {
      this.add.text(width / 2, height - 60, this.tip, {
        fontSize: '18px',
        color: '#aaaaaa',
        align: 'center',
        wordWrap: { width: width * 0.8 }
      }).setOrigin(0.5);
    }

    // Load portraits (shared globally)
    const races = ['human', 'dwarf', 'elf', 'ferrow', 'wylett', 'skith'];
    for (const race of races) {
      for (let i = 1; i <= 2; i++) {
        const key = `${race}_portrait_${i}`;
        const path = `assets/sprites/portraits/${key}.png`;
        this.load.image(key, path);
      }
    }
    //Enemy Portraits
    this.load.image('dummy_portrait', 'assets/sprites/portraits/dummy_portrait.png');
    //Load UI frame
    this.load.image('ui_frame', 'assets/UIinterface/ui_frame.png');

    // Load sidebar art (global UI)
    this.load.image('sidebar_left', 'assets/UIinterface/sidebar_left.png');

    // Map (WebP) — same key, new file
this.load.image('campMap', 'assets/maps/Camp_Nehemiah_NIGHTSCENE.webp');


    // 🔄 Batch load glow frame sequences
    // 🔄 Load glow atlases (PNG+JSON pairs)
    const GLOW_KEYS = [
      'glow_bonfire',
      'glow_combat_pit',
      'glow_elders_tower',
      'glow_exit_gate',
      'glow_leader_hut_elseth',
      'glow_leader_hut_lesse',
      'glow_leader_hut_styx',
      'glow_leader_hut_zafaar',
      'glow_lodge_elseth',
      'glow_lodge_lesse',
      'glow_lodge_styx',
      'glow_lodge_zafaar',
      'glow_mourne_hut',
      'glow_seers_tent',
      'glow_tribe_vendor',
      'glow_vendor_row',
      'glow_waystone'
    ];

    // Atlas files live flat under assets/sprites/glows/
    GLOW_KEYS.forEach(key => {
      this.load.atlas(key, `assets/sprites/glows/${key}.png`, `assets/sprites/glows/${key}.json`);
    });



    // 📦 You can also check for other target scenes later:
    // if (this.targetScene === 'CombatScene') { ... }
  }


  create() {
    if (!this.targetScene) return;

    // 👇 Now that assets are loaded, start the scene
    this.scene.start(this.targetScene, this.targetSceneData);

    if (this.targetScene === 'TownScene') {
      this.scene.launch('UIScene', { rightPanelVisible: false });
    }
  }
}
