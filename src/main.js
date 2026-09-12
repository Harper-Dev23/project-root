import GameState from './systems/GameState.js';
import SceneManager from './systems/SceneManager.js';
import ProgressionManager from './systems/ProgressionManager.js';
import Diagnostics from './systems/Diagnostics.js';
import LoadingScene from './scenes/LoadingScene.js';
import MainMenuScene from './scenes/MainMenuScene.js';
import TownScene from './scenes/TownScene.js';
import UIScene from './scenes/UIScene.js';
import CharacterCreationScene from './scenes/CharacterCreationScene.js';
import PartyManagementScene from './scenes/PartyManagementScene.js';
import CharacterListOverlay from './scenes/overlays/CharacterListOverlay.js';
import CombatScene from './scenes/CombatScene.js';
import CoopLobbyScene from './scenes/CoopLobbyScene.js';
import InventoryOverlay from './scenes/overlays/InventoryOverlay.js';
import SkillsOverlay from './scenes/overlays/SkillsOverlay.js';
import MapOverlay from './scenes/overlays/MapOverlay.js';
import OptionsOverlay from './scenes/overlays/OptionsOverlay.js';
import JournalOverlay from './scenes/overlays/JournalOverlay.js';
import QuestOverlay from './scenes/overlays/QuestOverlay.js';
import StashOverlay from './scenes/overlays/StashOverlay.js';
import LevelUpOverlay from './scenes/overlays/LevelUpOverlay.js';
import TribeRelationsOverlay from './scenes/overlays/TribeRelationsOverlay.js';
import WaystoneShardOverlay from './scenes/overlays/WaystoneShardOverlay.js';
import CampRosterOverlay from './scenes/overlays/CampRosterOverlay.js';
import HuntMapOverlay from './scenes/overlays/HuntMapOverlay.js';
import HuntHubOverlay from './scenes/overlays/HuntHubOverlay.js';
import RenownTreeOverlay from './scenes/overlays/RenownTreeOverlay.js';
import HuntEncounterOverlay from './scenes/overlays/HuntEncounterOverlay.js';
import HuntEventOverlay from './scenes/overlays/HuntEventOverlay.js';
import TribeHQOverlay from './scenes/overlays/TribeHQOverlay.js';
import HuntPlanPickerOverlay from './scenes/overlays/HuntPlanPickerOverlay.js';

const config = {
  type: Phaser.AUTO,
  width: 1280,
  height: 720,
  parent: 'game',
  scene: [
    MainMenuScene,
    LoadingScene,
    TownScene,
    UIScene,
    CharacterCreationScene,
    PartyManagementScene,
    CharacterListOverlay,
    CombatScene,
    CoopLobbyScene,
    InventoryOverlay,
    SkillsOverlay,
    MapOverlay,
    OptionsOverlay,
    JournalOverlay,
    QuestOverlay,
    StashOverlay,
    LevelUpOverlay,
    TribeRelationsOverlay,
    WaystoneShardOverlay,
    CampRosterOverlay,
    HuntMapOverlay,
    HuntHubOverlay,
    RenownTreeOverlay,
    HuntEncounterOverlay,
    HuntEventOverlay,
    TribeHQOverlay,
    HuntPlanPickerOverlay,
  ],
  physics: {
    default: 'arcade',
    arcade: { debug: false }
  },
  dom: {
    createContainer: true
  },
  // Keep running when the window is not focused.
  //
  // Phaser defaults this to true, which stops the whole scene clock the moment
  // the tab loses focus. That is harmless in single player — a turn-based game
  // does nothing without input — but in co-op the fight carries on without you:
  // broadcasts keep arriving while every timer that would animate them is
  // frozen, so the board silently falls behind and only "catches up" when the
  // window is clicked back into. It also freezes the timer that hands your
  // controls back after an animation.
  pauseOnBlur: false,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH
  }
};
//BRIEF TEST UPLOAD TO GIT
// Boot the game and store the instance
// Phaser draws text into a canvas, and canvas rendering does NOT trigger
// webfont loading the way DOM text does. Booting before the faces are ready
// silently bakes the fallback font into every Text object created on the first
// screens. So: ask for the faces we actually use, wait for them, then boot.
//
// Never blocks forever - a failed/blocked font rejects or times out and we boot
// anyway with whatever the browser has. A missing font is a cosmetic problem;
// a game that never starts is not.
const FONTS_TO_WARM = [
  '400 16px Gelasio',
  '700 16px Gelasio',
  'italic 400 16px Gelasio',
  '400 16px Cinzel',
  '400 16px "Cormorant Garamond"',
  '400 16px Lato',
  '700 16px Lato',
];

async function warmFonts() {
  if (!document.fonts?.load) return;
  const timeout = new Promise(res => setTimeout(res, 3000));
  const loads = Promise.all(
    FONTS_TO_WARM.map(spec => document.fonts.load(spec).catch(() => {}))
  ).then(() => document.fonts.ready).catch(() => {});
  await Promise.race([loads, timeout]);
}

function boot() {
  // BEFORE Phaser starts, so an error thrown while scenes are constructed is
  // captured too. Installs the window.bmDiag() console report.
  Diagnostics.install();

  // Lets the report show in-memory quest state next to what is actually on
  // disk. That GAP is the bug being hunted: when a save silently fails, the
  // two disagree and quest markers appear to walk backwards after a reload.
  Diagnostics.setLiveStateProvider(() => ({
    scene:      GameState.currentScene || '(none)',
    characters: (GameState.characters || []).length,
    party:      (GameState.party || []).length,
    questFlags: [...(ProgressionManager.questFlags || [])],
    scenarios:  [...(ProgressionManager.completedScenarios || [])],
    // The three currencies vendors and gambles charge, since "I could not buy
    // it" and "the ticket vanished" are reported against these.
    tickets:    `hunt=${ProgressionManager.huntTickets ?? '?'} `
              + `reckoning=${ProgressionManager.reckoningMarks ?? '?'} `
              + `tribe=${ProgressionManager.tribeTickets ?? '?'}`,
    lastSaveError: GameState.lastSaveError || '(none)'
  }));

  const game = new Phaser.Game(config);

  // Create and attach the SceneManager to GameState so it can be accessed globally
  GameState.sceneManager = new SceneManager(game);
  window.sceneManager = GameState.sceneManager;
  // Optionally, launch the main menu using the manager
  GameState.sceneManager.startMainMenu();

}

warmFonts().then(boot);