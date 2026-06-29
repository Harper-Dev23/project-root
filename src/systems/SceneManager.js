import { HuntManager } from './HuntManager.js';

export default class SceneManager {
  constructor(game) {
    this.game = game;
    this.scene = game.scene;
  }

  // 🌟 Universal loading transition
  loadScene(targetScene, tip = '', targetSceneData = {}) {
    this.scene.start('LoadingScene', { targetScene, tip, targetSceneData });
  }


  // 🏠 Main Menu
  startMainMenu() {
    this.scene.start('MainMenuScene');
  }

  // 🌆 Enter Town via loading screen
  enterTown() {
    this.loadScene('TownScene', 'Tip: You can talk to Samuel in the hut overlooking the sea.');
  }

  // 🧍 Character Creation
  enterCharacterCreation() {
    this.loadScene('CharacterCreationScene', 'Tip: Your character stats shape your survival!');
  }

  // ↩️ Return to Town from Character Creation
  returnToTown() {
    this.scene.stop('CharacterCreationScene');
    this.enterTown();
  }

  // ⛔ Return to Main Menu — stop every scene that could be active
  returnToMainMenu() {
    HuntManager.end();

    const ALL_SCENES = [
      'TownScene', 'UIScene', 'CombatScene',
      'CharacterCreationScene', 'PartyManagementScene',
      'CharacterListOverlay', 'InventoryOverlay', 'SkillsOverlay',
      'MapOverlay', 'OptionsOverlay', 'JournalOverlay', 'QuestOverlay',
      'HuntHubOverlay', 'HuntMapOverlay', 'HuntEncounterOverlay', 'TribeHQOverlay', 'HuntPlanPickerOverlay',
    ];
    ALL_SCENES.forEach(key => {
      if (this.scene.isActive(key) || this.scene.isPaused(key)) {
        this.scene.stop(key);
      }
    });
    this.startMainMenu();
  }
}
