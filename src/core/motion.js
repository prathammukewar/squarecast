// Watches for hands over the board. While anything moves the board is
// "busy". Once it has been still for a while we hand the averaged still
// view to the move logic.

import { boxBlur } from './warp.js';
import { median } from './features.js';

const CHANNELS = ['Y', 'R', 'G', 'B'];

export class MotionDetector {
  constructor(warp, { stillMs = 600, threshold = 14, minFraction = 0.004, window = 5 } = {}) {
    this.warp = warp;
    this.stillMs = stillMs;
    this.threshold = threshold;
    this.minFraction = minFraction;
    this.window = window; // still frames averaged into one picture
    this.prev = null;
    this.lastMotion = null;
    this.frames = [];
    const idx = [];
    for (let k = 0; k < warp.N * warp.N; k++) if (warp.motionMask[k]) idx.push(k);
    this.maskIdx = Int32Array.from(idx);
  }

  push(view, t) {
    const { N } = this.warp;
    const Yb = boxBlur(view.Y, N, 1);
    let fraction = 0;
    let shift = [0, 0];
    if (this.prev) {
      // A brightness change (auto exposure, a lamp) and a small shift of
      // the whole picture (the stand shaking) are measured and undone
      // first. What still differs after that is something moving.
      const g = this.#gain(Yb);
      shift = this.#globalShift(Yb, g);
      const [dx, dy] = shift;
      const P = this.prev;
      let moving = 0;
      for (const k of this.maskIdx) {
        const i = (k % N) - dx;
        const j = ((k / N) | 0) - dy;
        const i0 = Math.floor(i);
        const j0 = Math.floor(j);
        const fx = i - i0;
        const fy = j - j0;
        const o = j0 * N + i0;
        const p = (P[o] * (1 - fx) + P[o + 1] * fx) * (1 - fy) + (P[o + N] * (1 - fx) + P[o + N + 1] * fx) * fy;
        // At a sharp edge a fraction of a pixel of leftover misalignment
        // makes a big difference, so allow more there.
        const edge = Math.abs(P[k + 1] - P[k - 1]) + Math.abs(P[k + N] - P[k - N]);
        if (Math.abs(Yb[k] - g * p) > this.threshold + 0.2 * edge) moving++;
      }
      fraction = moving / this.maskIdx.length;
    }
    this.prev = Yb;
    const moving = fraction > this.minFraction;
    if (this.lastMotion === null || moving) {
      this.lastMotion = t;
      this.frames = [];
    }
    if (!moving) {
      this.frames.push(view);
      if (this.frames.length > this.window) this.frames.shift();
    }
    this.lastInfo = { moving, fraction: +fraction.toFixed(4), shift: shift.map((v) => +v.toFixed(2)) };
    return { moving, fraction, stillFor: t - this.lastMotion, lastMotion: this.lastMotion };
  }

  #gain(Yb) {
    const ratios = [];
    for (let i = 0; i < this.maskIdx.length; i += 37) {
      const k = this.maskIdx[i];
      ratios.push((Yb[k] + 4) / (this.prev[k] + 4));
    }
    return median(ratios);
  }

  // Translation of the whole picture since the previous frame, by
  // iterated least squares on the image gradients (Lucas-Kanade). After
  // the first pass, pixels that still differ a lot are left out: they are
  // probably a hand rather than the shake.
  #globalShift(Yb, g) {
    const { N } = this.warp;
    const P = this.prev;
    const sample = (k, dx, dy) => {
      const i = (k % N) - dx;
      const j = ((k / N) | 0) - dy;
      const i0 = Math.floor(i);
      const j0 = Math.floor(j);
      const fx = i - i0;
      const fy = j - j0;
      const o = j0 * N + i0;
      return (P[o] * (1 - fx) + P[o + 1] * fx) * (1 - fy) + (P[o + N] * (1 - fx) + P[o + N + 1] * fx) * fy;
    };
    let dx = 0;
    let dy = 0;
    for (let pass = 0; pass < 4; pass++) {
      let a = 0, b = 0, c = 0, ex = 0, ey = 0;
      for (const k of this.maskIdx) {
        const gx = (P[k + 1] - P[k - 1]) / 2;
        const gy = (P[k + N] - P[k - N]) / 2;
        const it = Yb[k] - g * sample(k, dx, dy);
        if (pass > 0 && Math.abs(it) > 2 * this.threshold) continue;
        a += gx * gx;
        b += gx * gy;
        c += gy * gy;
        ex += gx * it;
        ey += gy * it;
      }
      const det = a * c - b * b;
      if (det < 1e-6) return [0, 0];
      // cur(x) = prev(x - d)  =>  residual = -g * (grad . step)
      const sx = -(c * ex - b * ey) / (det * g);
      const sy = -(a * ey - b * ex) / (det * g);
      dx = Math.max(-2, Math.min(2, dx + sx));
      dy = Math.max(-2, Math.min(2, dy + sy));
      if (Math.abs(sx) + Math.abs(sy) < 0.02) break;
    }
    return [dx, dy];
  }

  // Mean of the last few still frames, which cuts camera noise.
  average() {
    const n = this.frames.length;
    if (!n) return null;
    const out = { N: this.warp.N };
    for (const c of CHANNELS) {
      const acc = new Float32Array(this.frames[0][c].length);
      for (const f of this.frames) {
        const src = f[c];
        for (let k = 0; k < acc.length; k++) acc[k] += src[k];
      }
      for (let k = 0; k < acc.length; k++) acc[k] /= n;
      out[c] = acc;
    }
    return out;
  }
}
