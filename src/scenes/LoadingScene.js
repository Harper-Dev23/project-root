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

    // Black underneath regardless: the art is 16:9 like the canvas, but this
    // guarantees no seam if either ever changes, and it IS the background on
    // the rare first run where the art hasn't finished streaming in yet
    // (MainMenuScene starts that download once its own menu is up).
    this.add.rectangle(width / 2, height / 2, width, height, 0x000000);

    const hasArt = this.textures.exists('ruins_load_screen');
    if (hasArt) {
      this.add.image(width / 2, height / 2, 'ruins_load_screen')
        .setDisplaySize(width, height)
        .setDepth(0);
    }

    // All copy lives in a dark band along the bottom rather than floating over
    // the middle. The art is pale, high-contrast roots across the entire frame,
    // so centred white text -- even stroked -- landed on near-white pixels and
    // read badly. A band keeps every string on a known background while leaving
    // the piece itself unscrimmed and at full strength.
    const BAND_H = 132;
    const bandY = height - BAND_H / 2;
    this.add.rectangle(width / 2, bandY, width, BAND_H, 0x000000, hasArt ? 0.84 : 0)
      .setDepth(1);
    if (hasArt) {
      this.add.rectangle(width / 2, height - BAND_H, width, 2, 0xc8b48c, 0.45)
        .setDepth(2);
    }

    this.add.text(width / 2, height - 104, 'Loading...', {
      fontSize: '26px',
      color: '#ffffff'
    }).setOrigin(0.5).setDepth(3);

    // --- progress bar ---
    const BAR_W = 460;
    const BAR_H = 14;
    const barLeft = (width - BAR_W) / 2;
    const barY = height - 68;

    this.add.rectangle(width / 2, barY, BAR_W, BAR_H, 0x000000, 0.85)
      .setStrokeStyle(1, 0xc8b48c, 0.75)
      .setDepth(3);
    const barFill = this.add.rectangle(barLeft + 2, barY, 0, BAR_H - 6, 0xd8c9a3)
      .setOrigin(0, 0.5)
      .setDepth(4);

    const pctText = this.add.text(width / 2, height - 42, '0%  ·  0 / 0 assets', {
      fontSize: '14px',
      color: '#e6d9b8'
    }).setOrigin(0.5).setDepth(4);

    // Phaser keeps rendering the scene while its own loader runs, so these
    // fire and repaint live. `progress` emits once per completed file, and
    // totalToLoad is read inside the callback because the queue below this
    // point hasn't been built yet at the time these are registered.
    //
    // These MUST be removed on shutdown. This scene is reused for every load
    // (town, combat, character creation...), and LoaderPlugin does NOT clear
    // its own listeners when the scene stops. Left registered, the handlers
    // from the previous run fire again on the next one -- still closed over
    // last run's now-destroyed Text -- and setText() on a destroyed object
    // throws from inside the loader's own progress emit. That aborts the load
    // before create() runs, so the target scene never starts and the loading
    // art just sits there. The `.scene` guard is belt-and-braces: Phaser nulls
    // it in destroy(), so a stale handler no-ops instead of throwing.
    const onProgress = (value) => {
      if (!pctText.scene) return;
      barFill.width = (BAR_W - 4) * value;
      const total = this.load.totalToLoad || 0;
      const done = this.load.totalComplete || 0;
      pctText.setText(Math.round(value * 100) + '%  ·  ' + done + ' / ' + total + ' assets');
    };
    const onComplete = () => {
      if (!pctText.scene) return;
      barFill.width = BAR_W - 4;
      const total = this.load.totalToLoad || 0;
      pctText.setText('100%  ·  ' + total + ' / ' + total + ' assets');
    };
    this.load.on('progress', onProgress);
    this.load.on('complete', onComplete);
    this.events.once('shutdown', () => {
      this.load.off('progress', onProgress);
      this.load.off('complete', onComplete);
    });

    if (this.tip) {
      this.add.text(width / 2, height - 20, this.tip, {
        fontSize: '15px',
        color: '#d0d0d0',
        align: 'center',
        wordWrap: { width: width * 0.8 }
      }).setOrigin(0.5).setDepth(3);
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
    // Weakness portrait overlays — grayscale, tinted at runtime per family
    // (see CombatScene._updateWeaknessOverlays). Painted against the 128x128
    // portrait template, rendered down to the portrait's live 64x64.
    this.load.image('wk_crack',    'assets/sprites/portrait_crack_overlay.png');
    this.load.image('wk_slash',    'assets/sprites/portrait_slash_overlay.png');
    this.load.image('wk_frost',    'assets/sprites/portrait_frost_creep_overlay.png');
    this.load.image('wk_disease',  'assets/sprites/portrait_disease_patch_overlay.png');
    this.load.image('wk_curse',    'assets/sprites/portrait_curse_rune_overlay.png');
    this.load.image('wk_particle', 'assets/sprites/portrait_soft_particle_orb.png');

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
    this.load.image('portrait_gorrek', 'assets/sprites/portraits/portrait_gorrek.png');
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

    // Training scenario picker backdrop
    this.load.image('training_select_bg', 'assets/Training_Scenario_Selector_Background.png');

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
      // Was `false`, which forced the menu panel closed on every entry to town
      // and made UIScene's default unreachable. Omitting it lets UIScene decide
      // (now: open), so a new player can actually see the menu.
      this.scene.launch('UIScene');
    }
  }
}
