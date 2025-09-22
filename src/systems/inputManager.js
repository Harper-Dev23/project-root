// inputManager.js
// Centralized input routing system

export default class InputManager {
  constructor(scene) {
    this.scene = scene;
  }

  initialize() {
    console.log("InputManager initialized for", this.scene.scene.key);
  }
}
