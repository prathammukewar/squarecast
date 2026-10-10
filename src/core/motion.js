// Watches for hands over the board. While anything moves the board is
// "busy". Once it has been still for a while we hand the averaged still
// view to the move logic.

import { boxBlur } from './warp.js';
import { median } from './features.js';

const CHANNELS = ['Y', 'R', 'G', 'B'];

export class MotionDetector {
  constructor(warp, { stillMs = 600, threshold = 14, minFraction = 0.004 } = {}) {
    this.warp = warp;
    this.stillMs = stillMs;
    this.threshold = threshold;
    this.minFraction = minFraction;
    this.prev = null;
    this.lastMotion = null;
    this.sum = null;
    this.count = 0;
    const idx = [];
    for (let k = 0; k < warp.N * warp.N; k++) if (warp.motionMask[k]) idx.push(k);
    this.maskIdx = Int32Array.from(idx);
  }

  push(view, t) {
    const { N } = this.warp;
    const Yb = boxBlur(view.Y, N, 1);
    let fraction = 0;
    if (this.prev) {
      // Divide out a global brightness change (auto exposure, a light
      // switched on) so it doesn't count as motion for long.
      const ratios = [];
      for (let i = 0; i < this.maskIdx.length; i += 37) {
        const k = this.maskIdx[i];
        ratios.push((Yb[k] + 4) / (this.prev[k] + 4));
      }
      const g = median(ratios);
      let moving = 0;
      for (const k of this.maskIdx) if (Math.abs(Yb[k] - g * this.prev[k]) > this.threshold) moving++;
      fraction = moving / this.maskIdx.length;
    }
    this.prev = Yb;
    const moving = fraction > this.minFraction;
    if (this.lastMotion === null || moving) {
      this.lastMotion = t;
      this.sum = null;
      this.count = 0;
    }
    if (!moving) this.#accumulate(view);
    return { moving, fraction, stillFor: t - this.lastMotion, lastMotion: this.lastMotion };
  }

  #accumulate(view) {
    const n = view.Y.length;
    if (!this.sum) this.sum = Object.fromEntries(CHANNELS.map((c) => [c, new Float32Array(n)]));
    for (const c of CHANNELS) {
      const acc = this.sum[c];
      const src = view[c];
      for (let k = 0; k < n; k++) acc[k] += src[k];
    }
    this.count++;
  }

  // Mean of the frames since the board went still, which cuts camera noise.
  average() {
    if (!this.count) return null;
    const s = 1 / this.count;
    const out = { N: this.warp.N };
    for (const c of CHANNELS) out[c] = this.sum[c].map((x) => x * s);
    return out;
  }
}
