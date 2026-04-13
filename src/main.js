import GameState from './systems/GameState.js';
import SceneManager from './systems/SceneManager.js';
import LoadingScene from './scenes/LoadingScene.js';
import MainMenuScene from './scenes/MainMenuScene.js';
import TownScene from './scenes/TownScene.js';
import UIScene from './scenes/UIScene.js';
import CharacterCreationScene from './scenes/CharacterCreationScene.js';
import PartyManagementScene from './scenes/PartyManagementScene.js';
import CharacterListOverlay from './scenes/overlays/CharacterListOverlay.js';
import CombatScene from './scenes/CombatScene.js';
import InventoryOverlay from './scenes/overlays/InventoryOverlay.js';
import SkillsOverlay from './scenes/overlays/SkillsOverlay.js';
import MapOverlay from './scenes/overlays/MapOverlay.js';
import OptionsOverlay from './scenes/overlays/OptionsOverlay.js';
import JournalOverlay from './scenes/overlays/JournalOverlay.js';
import QuestOverlay from './scenes/overlays/QuestOverlay.js';
import StashOverlay from './scenes/overlays/StashOverlay.js';
import LevelUpOverlay from './scenes/overlays/LevelUpOverlay.js';

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
    InventoryOverlay,
    SkillsOverlay,
    MapOverlay,
    OptionsOverlay,
    JournalOverlay,
    QuestOverlay,
    StashOverlay,
    LevelUpOverlay,
  ],
  physics: {
    default: 'arcade',
    arcade: { debug: false }
  },
  dom: {
    createContainer: true
  },
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH
  }
};
//BRIEF TEST UPLOAD TO GIT
// Boot the game and store the instance
const game = new Phaser.Game(config);

// Create and attach the SceneManager to GameState so it can be accessed globally
GameState.sceneManager = new SceneManager(game);
window.sceneManager = GameState.sceneManager;
// Optionally, launch the main menu using the manager
GameState.sceneManager.startMainMenu();
