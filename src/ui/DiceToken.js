// src/ui/DiceToken.js
// A dice token for Hunt 'check' events. It starts frozen (face hidden behind
// a '?') so it never appears to "auto-roll" the moment the screen opens.
// Calling roll() (bound to a Roll button and/or the Space key by the caller)
// plays a short jump-arc tween, then reveals the face the instant it lands —
// resolution (onSettled) fires at that same moment.
//
// Earlier versions of this used real Matter.js physics (drag-and-flick,
// gravity, bounce off walls). That turned out to be more trouble than it was
// worth for a turn-based check: the body could visually vanish mid-roll, the
// reveal timing depended on physics settle-detection instead of anything
// deterministic, and a post-landing physics fall put the token behind the
// result text. None of that physics simulation was actually load-bearing —
// the roll's outcome was always just a random number — so this is now a
// plain tween-driven Phaser object with no physics engine involved at all.
// The box outline is purely decorative framing now, not a physics boundary.
//
// Usage:
//   const token = new DiceToken(this, { x, y, width: 300, height: 200, depth: 2002, onSettled: (value) => {...} });
//   ...
//   token.roll(); // call once the player presses Roll / Space — onSettled fires when the jump lands
//   ...
//   token.destroy();

const TOKEN_RADIUS = 28;
const JUMP_BASE = 30;
const JUMP_PER_VALUE = 4; // pixels of extra jump height per point rolled
const JUMP_DURATION_MS = 550;

export default class DiceToken {
  constructor(scene, { x, y, width, height, sides = 20, depth = 0, onSettled }) {
    this.scene = scene;
    this.onSettled = onSettled;
    this._rolling = false;
    this.value = Phaser.Math.Between(1, sides);

    this.boxOutline = scene.add.rectangle(x, y, width, height)
      .setStrokeStyle(2, 0x6a5a3a, 0.8)
      .setDepth(depth);

    this.circle = scene.add.circle(x, y, TOKEN_RADIUS, 0xffdd88)
      .setStrokeStyle(2, 0x886622)
      .setDepth(depth + 1);
    this.label = scene.add.text(x, y, '?', {
      fontSize: '22px', color: '#2a1800', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(depth + 2);
  }

  isArmed() {
    return this._rolling;
  }

  /** Plays the jump-arc tween, then reveals the value and resolves the instant it lands. */
  roll() {
    if (this._rolling) return;
    this._rolling = true;

    const startX = this.circle.x;
    const startY = this.circle.y;
    const jumpHeight = JUMP_BASE + this.value * JUMP_PER_VALUE;

    const progress = { t: 0 };
    this._tween = this.scene.tweens.add({
      targets: progress,
      t: 1,
      duration: JUMP_DURATION_MS,
      ease: 'Linear',
      onUpdate: () => {
        const arc = 4 * progress.t * (1 - progress.t); // 0 at start/end, 1 at midpoint
        const y = startY - arc * jumpHeight;
        this.circle.setPosition(startX, y);
        this.label.setPosition(startX, y);
      },
      onComplete: () => {
        this.circle.setPosition(startX, startY);
        this.label.setPosition(startX, startY);
        this.label.setText(String(this.value));
        this.onSettled?.(this.value);
      },
    });
  }

  destroy() {
    this._tween?.stop();
    this.boxOutline?.destroy();
    this.circle?.destroy();
    this.label?.destroy();
  }
}
