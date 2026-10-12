// A pretend camera for trying the app without a board: the synthetic
// renderer draws a game into a canvas, and the canvas is streamed like a
// camera. The board sits in the starting position until play() is called.

import { Scene } from '../src/demo/scene.js';
import { buildTimeline } from '../src/demo/script.js';

const DEMO_GAME = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7', 'Re1', 'b5', 'Bb3', 'd6', 'c3', 'O-O', 'h3', 'Nb8', 'd4', 'Nbd7'];

export class DemoCamera {
  constructor({ fps = 10, tilt = 25, moves = DEMO_GAME } = {}) {
    this.scene = new Scene({ width: 960, height: 720, tilt, board: 'vinyl-green', noise: 3, blur: 1, seed: 5 });
    this.timeline = buildTimeline(moves, { start: 0, think: [2, 3] });
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.scene.W;
    this.canvas.height = this.scene.H;
    this.ctx = this.canvas.getContext('2d');
    this.fps = fps;
    this.playFrom = null;
    this.timer = null;
  }

  // Board corners in the demo picture (a1, h1, h8, a8), as fractions.
  cornerFractions() {
    return this.scene.corners().map(([x, y]) => [x / this.scene.W, y / this.scene.H]);
  }

  start() {
    const draw = () => {
      const t = this.playFrom === null ? 0 : (performance.now() - this.playFrom) / 1000;
      const state = this.timeline.stateAt(Math.min(t, this.timeline.duration));
      const frame = this.scene.render(state);
      this.ctx.putImageData(new ImageData(frame.data, frame.width, frame.height), 0, 0);
    };
    draw();
    this.timer = setInterval(draw, 1000 / this.fps);
    this.stream = this.canvas.captureStream(this.fps);
    return this.stream;
  }

  play() {
    if (this.playFrom === null) this.playFrom = performance.now();
  }

  stop() {
    clearInterval(this.timer);
    this.stream?.getTracks().forEach((t) => t.stop());
  }
}
