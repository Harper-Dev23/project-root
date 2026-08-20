import { AUDIO_MANIFEST, MUSIC_MANIFEST } from '../systems/SoundManager.js';
import { HuntManager } from '../systems/HuntManager.js';

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
    this.load.image('dummy_portrait_equipped_fighter', 'assets/sprites/portraits/dummy_portrait_equipped_fighter.png');
    this.load.image('dummy_portrait_equipped_healer', 'assets/sprites/portraits/dummy_portrait_equipped_healer.png');
    this.load.image('dummy_portrait_equipped_ranger', 'assets/sprites/portraits/dummy_portrait_equipped_ranger.png');
    this.load.image('dummy_portrait_equipped_rogue', 'assets/sprites/portraits/dummy_portrait_equipped_rogue.png');
    this.load.image('dummy_portrait_equipped_warlock', 'assets/sprites/portraits/dummy_portrait_equipped_warlock.png');
    this.load.image('dummy_portrait_equipped_wizard', 'assets/sprites/portraits/dummy_portrait_equipped_wizard.png');
    this.load.image('portrait_kiro', 'assets/sprites/portraits/portrait_kiro.png');
    this.load.image('portrait_oskar', 'assets/sprites/portraits/portrait_oskar.png');
    this.load.image('portrait_styx_commander', 'assets/sprites/portraits/portrait_styx_commander.png');
    this.load.image('portrait_lesse_duelist_fire', 'assets/sprites/portraits/portrait_lesse_duelist_fire.png');
    this.load.image('portrait_lesse_duelist_ice', 'assets/sprites/portraits/portrait_lesse_duelist_ice.png');
    //Load UI frame
    this.load.image('ui_frame', 'assets/UIinterface/ui_frame.png');

    // Load sidebar art (global UI)
    this.load.image('sidebar_left', 'assets/UIinterface/sidebar_left.png');

    // Map (WebP) assets
    this.load.image('campMap', 'assets/maps/Camp_Nehemiah_NIGHTSCENE.webp');
    this.load.image('map_behelith_island', 'assets/maps/Behelith_Island_Map.webp');

    // Main menu background
    this.load.image('main_menu_bg', 'assets/MainMenu_Background.png');

    // Sound effects — driven by SoundManager manifest so this list never drifts
    AUDIO_MANIFEST.forEach(s => {
      this.load.audio(`sfx_${s.id}`, `assets/audio/${s.file}`);
    });

    // Background music tracks — ogg first, mp3 fallback
    MUSIC_MANIFEST.forEach(m => {
      this.load.audio(`music_${m.id}`, [
        `assets/audio/music/${m.file}.ogg`,
        `assets/audio/music/${m.file}.mp3`,
      ]);
    });

    // Combat pit background
    this.load.image('combat_pit_bg', 'assets/Combat_Pit.png');

    // Combat VFX sprites (ground effects, status indicators)
    this.load.image('fx_crack', 'assets/sprites/fx_crack.png');
    this.load.image('fx_lodge_arrow', 'assets/sprites/fx_lodge_arrow.png');
    this.load.image('fx_runic_zone', 'assets/sprites/fx_runic_zone.png');
    this.load.image('fx_runic_zone_addition_1', 'assets/sprites/fx_runic_zone_addition_1.png');
    this.load.image('fx_runic_zone_addition_2', 'assets/sprites/fx_runic_zone_addition_2.png');
    this.load.image('fx_runic_zone_addition_3', 'assets/sprites/fx_runic_zone_addition_3.png');

    // Generic tintable attack VFX (see project_weapon_vfx_systematic_plan
    // memory) — projectiles fly attacker->target (_playProjectileVFX),
    // hits pop at the target (_playMeleeImpactVFX), inflict is reserved for
    // pure status-application skills, not yet wired to any weapon pass.
    this.load.image('fx_proj_ball', 'assets/sprites/fx_proj_ball_generic.png');
    this.load.image('fx_proj_bolt', 'assets/sprites/fx_proj_bolt_generic.png');
    this.load.image('fx_proj_lance', 'assets/sprites/fx_proj_lance_generic.png');
    this.load.image('fx_proj_star', 'assets/sprites/fx_proj_star_generic.png');
    this.load.image('fx_hit_slash', 'assets/sprites/fx_hit_slash_generic.png');
    this.load.image('fx_hit_blunt', 'assets/sprites/fx_hit_blunt_generic.png');
    this.load.image('fx_hit_blunt_alt', 'assets/sprites/fx_hit_blunt_alt_generic.png');
    this.load.image('fx_hit_puncture', 'assets/sprites/fx_hit_puncture_generic.png');
    this.load.image('fx_hit_claw', 'assets/sprites/fx_hit_claw_generic.png');
    this.load.image('fx_hit_bite', 'assets/sprites/fx_hit_bite_generic.png');
    this.load.image('fx_hit_cloud', 'assets/sprites/fx_hit_cloud_generic.png');
    this.load.image('fx_hit_engulf', 'assets/sprites/fx_hit_engulf_generic.png');
    this.load.image('fx_hit_explosion', 'assets/sprites/fx_hit_explosion_generic.png');
    this.load.image('fx_inflict_confuse', 'assets/sprites/fx_inflict_confuse_generic.png');
    this.load.image('fx_inflict_leer', 'assets/sprites/fx_inflict_leer_generic.png');
    this.load.image('fx_inflict_weak', 'assets/sprites/fx_inflict_weak_generic.png');

    // Generic tintable buff/heal/debuff VFX (companion to the attack VFX
    // block above — same "generic" grayscale-tinted-at-runtime convention).
    this.load.image('fx_buff_harden', 'assets/sprites/fx_buff_harden_generic.png');
    this.load.image('fx_buff_health', 'assets/sprites/fx_buff_health_generic.png');
    this.load.image('fx_buff_increase', 'assets/sprites/fx_buff_increase_generic.png');
    this.load.image('fx_buff_magic', 'assets/sprites/fx_buff_magic_generic.png');
    this.load.image('fx_buff_power', 'assets/sprites/fx_buff_power_generic.png');
    this.load.image('fx_heal', 'assets/sprites/fx_heal_generic.png');
    this.load.image('fx_inflict_burn', 'assets/sprites/fx_inflict_burn_generic.png');
    this.load.image('fx_inflict_decrease', 'assets/sprites/fx_inflict_decrease_generic.png');
    this.load.image('fx_inflict_shock', 'assets/sprites/fx_inflict_shock_generic.png');
    this.load.image('fx_inflict_sick', 'assets/sprites/fx_inflict_sick_generic.png');
    this.load.image('fx_warcry', 'assets/sprites/fx_warcry_generic.png');

    // Interior backgrounds
    this.load.image('zafaar_interior', 'assets/interiors/zafaar_interior.png');
    this.load.image('styx_interior',   'assets/interiors/styx_interior.png');
    this.load.image('elseth_interior', 'assets/interiors/elseth_interior.png');
    this.load.image('lesse_interior',  "assets/interiors/le'sse_interior.png");

    // Overlay menu backgrounds
    this.load.image('menu_parchment_background', 'assets/UIinterface/menu_parchment_background.png');
    this.load.image('menu_stony_background',     'assets/UIinterface/menu_stony_background.png');

    // Character creation — static backdrop + animated smoke overlay
    this.load.image('char_creation_backscene', 'assets/sprites/char_creation_backscene.png');
    this.load.atlas(
      'char_creation_bg',
      'assets/sprites/char_creation_bg.png',
      'assets/sprites/char_creation_bg.json'
    );


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

    if (this.targetScene === 'TownScene') {
      // Discard any in-progress hunt — entering Town fresh (new game, load
      // game) should never carry over stale session-only hunt state.
      HuntManager.end();

      // Stop any overlay/parallel scenes that may be lingering from a previous
      // session before we (re)start TownScene + UIScene from scratch.
      const CLEANUP = [
        'UIScene', 'CombatScene', 'CharacterCreationScene', 'PartyManagementScene',
        'CharacterListOverlay', 'InventoryOverlay', 'SkillsOverlay',
        'MapOverlay', 'OptionsOverlay', 'JournalOverlay', 'QuestOverlay',
        'HuntHubOverlay', 'HuntMapOverlay', 'HuntEncounterOverlay', 'HuntEventOverlay', 'TribeHQOverlay', 'HuntPlanPickerOverlay',
      ];
      CLEANUP.forEach(key => {
        if (this.scene.isActive(key) || this.scene.isPaused(key)) {
          this.scene.stop(key);
        }
      });
    }

    this.scene.start(this.targetScene, this.targetSceneData);

    if (this.targetScene === 'TownScene') {
      this.scene.launch('UIScene', { rightPanelVisible: false });
    }
  }
}
