// Turns a camera frame into a small top-down picture of the board.
//
// The four corners the user marks give a homography from board
// coordinates to image pixels. We precompute, for every pixel of the
// top-down view, where it comes from in the camera frame, so warping a
// frame is a table lookup plus bilinear interpolation. No OpenCV needed.
//
// Board coordinates: u runs along the files (a = 0..1, h = 7..8) and v
// along the ranks (rank 1 = 0..1, rank 8 = 7..8). The view always shows
// White's side at the bottom, with a margin around the board so we can
// see hands and arms coming in from outside.

import { solveHomography, applyHomography, invertHomography } from './homography.js';

export class BoardWarp {
  // corners: image points of the outer corners of the 8x8 grid, in the
  // order a1, h1, h8, a8.
  constructor({ corners, width, height, pxPerSquare = 20, margin = 2, sampleFraction = 0.6 }) {
    this.corners = corners;
    this.width = width;
    this.height = height;
    this.S = pxPerSquare;
    this.margin = margin;
    this.N = Math.round((8 + 2 * margin) * pxPerSquare);
    this.H = solveHomography([[0, 0], [8, 0], [8, 8], [0, 8]], corners);
    this.Hinv = invertHomography(this.H);
    this.#buildLookup();
    this.#measureTilt();
    this.regions = [];
    this.setSampleFraction(sampleFraction);
    this.#buildMasks();
  }

  // Board coordinates of the center of view pixel (i, j).
  viewToBoard(i, j) {
    return [(i + 0.5) / this.S - this.margin, 8 + this.margin - (j + 0.5) / this.S];
  }

  boardToView(u, v) {
    return [(u + this.margin) * this.S - 0.5, (8 + this.margin - v) * this.S - 0.5];
  }

  #buildLookup() {
    const { N, width, height } = this;
    this.src = new Int32Array(N * N).fill(-1); // top-left source pixel, -1 if outside
    this.wx = new Float32Array(N * N);
    this.wy = new Float32Array(N * N);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const [u, v] = this.viewToBoard(i, j);
        const [x, y] = applyHomography(this.H, u, v);
        const k = j * N + i;
        if (x < 0 || y < 0 || x >= width - 1 || y >= height - 1) continue;
        const x0 = Math.floor(x);
        const y0 = Math.floor(y);
        this.src[k] = y0 * width + x0;
        this.wx[k] = x - x0;
        this.wy[k] = y - y0;
      }
    }
  }

  // How much closer one side of the board is to the camera than the
  // other: 1 means straight overhead. Also works out which way "toward
  // the camera" points on the board, which is where piece bases sit.
  #measureTilt() {
    const side = (u, v) => {
      const p = applyHomography(this.H, u, v);
      const q = applyHomography(this.H, u + 1, v);
      const r = applyHomography(this.H, u, v + 1);
      return Math.sqrt(Math.abs((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])));
    };
    const center = applyHomography(this.H, 4, 4);
    const below = applyHomography(this.Hinv, center[0], center[1] + 1);
    let du = below[0] - 4;
    let dv = below[1] - 4;
    const len = Math.hypot(du, dv) || 1;
    du /= len;
    dv /= len;
    this.towardCamera = [du, dv];
    const near = side(4 - 0.5 + 3 * du, 4 - 0.5 + 3 * dv);
    const far = side(4 - 0.5 - 3 * du, 4 - 0.5 - 3 * dv);
    this.tilt = far > 0 ? near / far : 1;
  }

  // Sample region of each square: its inner part. With an angled camera a
  // piece's body projects onto the board behind it (away from the
  // camera), into the near half of the next square. So we shift each
  // region toward its far side, which only the square's own piece covers.
  setSampleFraction(fraction) {
    const { S } = this;
    const bias = Math.min(0.2, Math.max(0, 0.35 * (this.tilt - 1)));
    const [du, dv] = this.towardCamera;
    const half = fraction / 2;
    this.sampleFraction = fraction;
    this.bias = bias;
    for (let sq = 0; sq < 64; sq++) {
      const cu = (sq & 7) + 0.5 - bias * du;
      const cv = (sq >> 3) + 0.5 - bias * dv;
      const [i0, j1] = this.boardToView(cu - half, cv - half);
      const [i1, j0] = this.boardToView(cu + half, cv + half);
      const list = [];
      for (let j = Math.ceil(j0); j <= Math.floor(j1); j++) {
        for (let i = Math.ceil(i0); i <= Math.floor(i1); i++) list.push(j * this.N + i);
      }
      this.regions[sq] = Int32Array.from(list);
    }
    this.#buildSpill();
  }

  // Squares behind each square, as seen from the camera, that a piece on
  // it can partly cover. When that piece moves, they may look different
  // too, so a candidate move is not penalized for changes there.
  #buildSpill() {
    const reach = Math.min(2, Math.max(0, 2 * (this.tilt - 1)));
    const [du, dv] = this.towardCamera;
    this.spill = [];
    for (let sq = 0; sq < 64; sq++) {
      const set = new Set();
      for (let t = 0.6; t <= reach + 0.5; t += 0.4) {
        const u = Math.floor((sq & 7) + 0.5 - t * du);
        const v = Math.floor((sq >> 3) + 0.5 - t * dv);
        if (u < 0 || u > 7 || v < 0 || v > 7) continue;
        const other = v * 8 + u;
        if (other !== sq) set.add(other);
      }
      this.spill[sq] = [...set];
    }
  }

  #buildMasks() {
    const { N } = this;
    // Pixels used for motion: the board plus a quarter square around it.
    this.motionMask = new Uint8Array(N * N);
    // Pixels outside the board, where arms and sleeves first show up.
    this.outside = new Uint8Array(N * N);
    // Which square each view pixel belongs to, or -1 off the board.
    this.squareOf = new Int8Array(N * N).fill(-1);
    // For spreading per-square values smoothly over pixels: the four
    // nearest square centers of each pixel and their bilinear weights.
    this.near4 = new Uint8Array(N * N * 4);
    this.near4w = new Float32Array(N * N * 4);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const [u, v] = this.viewToBoard(i, j);
        const k = j * N + i;
        const onBoard = u >= 0 && u < 8 && v >= 0 && v < 8;
        if (onBoard) this.squareOf[k] = Math.floor(v) * 8 + Math.floor(u);
        else this.outside[k] = 1;
        if (u > -0.25 && u < 8.25 && v > -0.25 && v < 8.25 && this.src[k] >= 0) this.motionMask[k] = 1;
        const x = Math.min(7, Math.max(0, u - 0.5));
        const y = Math.min(7, Math.max(0, v - 0.5));
        const x0 = Math.min(6, Math.floor(x));
        const y0 = Math.min(6, Math.floor(y));
        const fx = x - x0;
        const fy = y - y0;
        const o = k * 4;
        this.near4[o] = y0 * 8 + x0;
        this.near4[o + 1] = y0 * 8 + x0 + 1;
        this.near4[o + 2] = (y0 + 1) * 8 + x0;
        this.near4[o + 3] = (y0 + 1) * 8 + x0 + 1;
        this.near4w[o] = (1 - fx) * (1 - fy);
        this.near4w[o + 1] = fx * (1 - fy);
        this.near4w[o + 2] = (1 - fx) * fy;
        this.near4w[o + 3] = fx * fy;
      }
    }
  }

  // Spread one value per square over every view pixel, smoothly.
  spread(perSquare, out) {
    const n = this.N * this.N;
    const dst = out || new Float32Array(n);
    const idx = this.near4;
    const w = this.near4w;
    for (let k = 0; k < n; k++) {
      const o = k * 4;
      dst[k] = perSquare[idx[o]] * w[o] + perSquare[idx[o + 1]] * w[o + 1] + perSquare[idx[o + 2]] * w[o + 2] + perSquare[idx[o + 3]] * w[o + 3];
    }
    return dst;
  }

  // Warp an RGBA frame ({width, height, data}) into the view. Returns the
  // R, G and B channels plus luma Y.
  apply(frame, out) {
    const { N, src, wx, wy } = this;
    const d = frame.data;
    const W = frame.width;
    if (W !== this.width || frame.height !== this.height) {
      throw new Error(`Frame is ${W}x${frame.height}, warp expects ${this.width}x${this.height}`);
    }
    const n = N * N;
    const view = out || { N, Y: new Float32Array(n), R: new Float32Array(n), G: new Float32Array(n), B: new Float32Array(n) };
    const { Y, R, G, B } = view;
    const row = W * 4;
    for (let k = 0; k < N * N; k++) {
      const s = src[k];
      if (s < 0) {
        Y[k] = 0; R[k] = 0; G[k] = 0; B[k] = 0;
        continue;
      }
      const a = s * 4;
      const fx = wx[k];
      const fy = wy[k];
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;
      const r = d[a] * w00 + d[a + 4] * w10 + d[a + row] * w01 + d[a + row + 4] * w11;
      const g = d[a + 1] * w00 + d[a + 5] * w10 + d[a + row + 1] * w01 + d[a + row + 5] * w11;
      const b = d[a + 2] * w00 + d[a + 6] * w10 + d[a + row + 2] * w01 + d[a + row + 6] * w11;
      Y[k] = 0.299 * r + 0.587 * g + 0.114 * b;
      R[k] = r;
      G[k] = g;
      B[k] = b;
    }
    return view;
  }
}

// Separable box blur on an N x N float image.
export function boxBlur(src, N, radius, out) {
  const tmp = new Float32Array(N * N);
  const dst = out || new Float32Array(N * N);
  const w = 2 * radius + 1;
  for (let j = 0; j < N; j++) {
    const o = j * N;
    let acc = 0;
    for (let i = -radius; i <= radius; i++) acc += src[o + clamp(i, 0, N - 1)];
    for (let i = 0; i < N; i++) {
      tmp[o + i] = acc / w;
      acc += src[o + clamp(i + radius + 1, 0, N - 1)] - src[o + clamp(i - radius, 0, N - 1)];
    }
  }
  for (let i = 0; i < N; i++) {
    let acc = 0;
    for (let j = -radius; j <= radius; j++) acc += tmp[clamp(j, 0, N - 1) * N + i];
    for (let j = 0; j < N; j++) {
      dst[j * N + i] = acc / w;
      acc += tmp[clamp(j + radius + 1, 0, N - 1) * N + i] - tmp[clamp(j - radius, 0, N - 1) * N + i];
    }
  }
  return dst;
}

// Gradient magnitude (sum of absolute central differences).
export function gradient(src, N, out) {
  const dst = out || new Float32Array(N * N);
  for (let j = 1; j < N - 1; j++) {
    for (let i = 1; i < N - 1; i++) {
      const k = j * N + i;
      dst[k] = Math.abs(src[k + 1] - src[k - 1]) + Math.abs(src[k + N] - src[k - N]);
    }
  }
  return dst;
}

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}
