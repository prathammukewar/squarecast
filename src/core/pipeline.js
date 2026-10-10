// Frame in, game events out. The same code runs in a browser worker and
// in Node (for the evaluation harness), so nothing here touches the DOM.

import { BoardWarp } from './warp.js';
import { MotionDetector } from './motion.js';
import { snapshot } from './features.js';
import { Tracker } from './tracker.js';

export class Pipeline {
  // corners: outer corners of the playing area in frame pixels, in the
  // order a1, h1, h8, a8.
  constructor({ corners, width, height, fen, pxPerSquare = 20, motion = {}, tracker = {}, recheckMs = 1000 }) {
    this.warp = new BoardWarp({ corners, width, height, pxPerSquare });
    this.motion = new MotionDetector(this.warp, motion);
    this.tracker = new Tracker(this.warp, { fen, params: tracker });
    this.recheckMs = recheckMs;
    this.lastCheck = -Infinity;
    this.wasMoving = false;
    this.view = null;
  }

  processFrame(frame, t) {
    // A fresh view each frame: the motion detector keeps the last few.
    this.view = this.warp.apply(frame);
    const m = this.motion.push(this.view, t);
    if (m.moving) {
      this.lastCheck = -Infinity;
      if (this.wasMoving) return [];
      this.wasMoving = true;
      return this.tracker.onMotion(t);
    }
    this.wasMoving = false;
    if (m.stillFor < this.motion.stillMs || t - this.lastCheck < this.recheckMs) return [];
    this.lastCheck = t;
    const snap = snapshot(this.warp, this.motion.average());
    return this.tracker.onStill(snap, t, m.lastMotion);
  }

  get chess() {
    return this.tracker.chess;
  }
}
