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

  // ⛔ Return to Main Menu
  returnToMainMenu() {
    this.scene.stop('TownScene');
    this.scene.stop('UIScene');
    this.startMainMenu();
  }
}
