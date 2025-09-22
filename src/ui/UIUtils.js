// UIUtils.js
// Utility functions for formatting UI

export function shortenNumber(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toString();
}

// src/ui/UIUtils.js

export function centerObject(scene, object, offsetX = 0, offsetY = 0) {
  const { width, height } = scene.scale;
  object.setPosition(width / 2 + offsetX, height / 2 + offsetY);
}

export function createLabel(scene, text, fontStyle) {
  return scene.add.text(0, 0, text, fontStyle).setOrigin(0.5);
}
