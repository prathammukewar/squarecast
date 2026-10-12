// A small software renderer for synthetic chessboard footage: a board on
// a table seen by a pinhole camera, pieces drawn as solids of revolution,
// hands and arms, lighting gradients, shadows, camera noise and blur.
// It is not photorealistic. It exists so the vision pipeline has
// regression tests that don't need recorded video.

export const BOARDS = {
  'vinyl-green': { light: [232, 232, 214], dark: [62, 128, 78], border: [236, 236, 226], table: [118, 104, 92] },
  'vinyl-brown': { light: [228, 212, 172], dark: [146, 98, 58], border: [232, 220, 190], table: [92, 88, 96] },
  wood: { light: [212, 170, 118], dark: [112, 70, 42], border: [96, 60, 36], table: [70, 64, 60], grain: 0.08 },
};

export const PIECE_COLORS = {
  plastic: { w: [232, 224, 202], b: [38, 34, 32] },
  wood: { w: [214, 184, 140], b: [58, 36, 24] },
};

// Radius profiles [height, radius] in square units.
const PROFILES = {
  P: [[0, 0.27], [0.07, 0.27], [0.1, 0.19], [0.32, 0.11], [0.36, 0.15], [0.4, 0.12], [0.47, 0.13], [0.54, 0.06], [0.56, 0]],
  R: [[0, 0.3], [0.07, 0.3], [0.1, 0.22], [0.48, 0.19], [0.52, 0.24], [0.64, 0.24], [0.65, 0]],
  N: [[0, 0.3], [0.07, 0.3], [0.1, 0.22], [0.3, 0.16], [0.55, 0.2], [0.72, 0.13], [0.78, 0]],
  B: [[0, 0.3], [0.07, 0.3], [0.1, 0.21], [0.5, 0.11], [0.55, 0.16], [0.6, 0.11], [0.78, 0.13], [0.88, 0.04], [0.9, 0]],
  Q: [[0, 0.32], [0.07, 0.32], [0.1, 0.23], [0.62, 0.12], [0.68, 0.18], [0.74, 0.12], [0.92, 0.2], [1.0, 0.1], [1.03, 0]],
  K: [[0, 0.32], [0.07, 0.32], [0.1, 0.23], [0.66, 0.13], [0.72, 0.19], [0.78, 0.13], [0.96, 0.18], [1.04, 0.07], [1.14, 0.05], [1.16, 0]],
};

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Scene {
  constructor({
    width = 640,
    height = 480,
    tilt = 0, // degrees from straight overhead
    azimuth = 0, // degrees; 0 means the camera leans in from White's side
    distance = 12, // in squares
    focal = 0.95, // focal length as a fraction of the image width
    board = 'vinyl-green',
    pieces = 'plastic',
    light = {},
    noise = 3,
    blur = 0,
    seed = 1,
  } = {}) {
    this.W = width;
    this.H = height;
    this.board = BOARDS[board];
    this.colors = PIECE_COLORS[pieces];
    this.noise = noise;
    this.blur = blur;
    this.rand = mulberry32(seed);
    this.light = { gain: 1, gradient: 0.15, warmth: 0, ...light };
    this.#setCamera(tilt, azimuth, distance, focal * width);
    this.#renderBackground();
    this.#makeNoise();
  }

  #setCamera(tiltDeg, azDeg, D, f) {
    const t = (tiltDeg * Math.PI) / 180;
    const a = (azDeg * Math.PI) / 180;
    // Direction from the board center toward the camera, in the board plane.
    const back = [-Math.sin(a), -Math.cos(a)];
    const C = [4 + back[0] * D * Math.sin(t), 4 + back[1] * D * Math.sin(t), D * Math.cos(t)];
    const fwd = norm([4 - C[0], 4 - C[1], -C[2]]);
    const upHint = [-back[0], -back[1], 0];
    const right = norm(cross(fwd, upHint));
    const down = cross(fwd, right);
    this.cam = { C, fwd, right, down, f, cx: this.W / 2, cy: this.H / 2 };
  }

  project([x, y, z]) {
    const { C, fwd, right, down, f, cx, cy } = this.cam;
    const v = [x - C[0], y - C[1], z - C[2]];
    const zc = dot(v, fwd);
    return [cx + (f * dot(v, right)) / zc, cy + (f * dot(v, down)) / zc];
  }

  // Outer corners of the playing area, a1, h1, h8, a8, in image pixels.
  corners() {
    return [[0, 0], [8, 0], [8, 8], [0, 8]].map(([x, y]) => this.project([x, y, 0]));
  }

  #renderBackground() {
    const { W, H } = this;
    const { C, fwd, right, down, f, cx, cy } = this.cam;
    const bg = new Float32Array(W * H * 3);
    const b = this.board;
    const grainRand = mulberry32(99);
    const grainPhase = Array.from({ length: 16 }, () => grainRand() * 6.28);
    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        let r = 0, g = 0, bl = 0;
        for (const [sx, sy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
          const u = (px + sx - cx) / f;
          const w = (py + sy - cy) / f;
          const dir = [fwd[0] + u * right[0] + w * down[0], fwd[1] + u * right[1] + w * down[1], fwd[2] + u * right[2] + w * down[2]];
          const s = -C[2] / dir[2];
          const x = C[0] + s * dir[0];
          const y = C[1] + s * dir[1];
          let col;
          if (x >= 0 && x < 8 && y >= 0 && y < 8) {
            const light = (Math.floor(x) + Math.floor(y)) % 2 === 1;
            col = light ? b.light : b.dark;
            if (b.grain) {
              const k = 1 + b.grain * Math.sin(y * 9 + grainPhase[Math.floor(x * 2) & 15] + Math.sin(y * 2.3 + x));
              col = col.map((c) => c * k);
            }
          } else if (x > -0.45 && x < 8.45 && y > -0.45 && y < 8.45) {
            col = b.border;
          } else {
            const k = 1 + 0.05 * Math.sin(x * 3.1) * Math.sin(y * 2.7);
            col = b.table.map((c) => c * k);
          }
          r += col[0] / 4;
          g += col[1] / 4;
          bl += col[2] / 4;
        }
        const k = (py * W + px) * 3;
        bg[k] = r;
        bg[k + 1] = g;
        bg[k + 2] = bl;
      }
    }
    this.bg = bg;
  }

  #makeNoise() {
    // Long enough for a whole frame from a random starting point.
    const n = Math.max(1 << 20, Math.ceil(this.W * this.H * 3 * 1.5));
    this.noiseTable = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      // Sum of uniforms, close enough to Gaussian.
      this.noiseTable[i] = (this.rand() + this.rand() + this.rand() + this.rand() - 2) * 1.73;
    }
  }

  // state: { pieces: [{ code: 'wP', x, y, z = 0, tipped }], hands: [{ x, y, z, side: 'w'|'b' }],
  //          shadows: [{ x, y, radius, depth }] (image fractions), light: {...}, shift: [dx, dy] }
  render(state) {
    const { W, H } = this;
    const img = new Float32Array(this.bg);
    // Pieces and hands, far to near.
    const items = [];
    for (const p of state.pieces) items.push({ kind: 'piece', p, depth: this.#depth(p.x, p.y, p.z || 0) });
    for (const h of state.hands || []) items.push({ kind: 'hand', h, depth: this.#depth(h.x, h.y, h.z) - 0.5 });
    items.sort((a, b) => b.depth - a.depth);
    for (const it of items) {
      if (it.kind === 'piece') this.#drawPiece(img, it.p);
      else this.#drawHand(img, it.h);
    }
    // Lighting.
    const light = { ...this.light, ...(state.light || {}) };
    const shadows = state.shadows || [];
    const out = new Uint8ClampedArray(W * H * 4);
    const shift = state.shift || [0, 0];
    let ni = Math.floor(this.rand() * (this.noiseTable.length - W * H * 3 - 1));
    const src = this.blur ? boxBlur3(img, W, H, this.blur) : img;
    for (let py = 0; py < H; py++) {
      const sy = Math.min(H - 1, Math.max(0, Math.round(py - shift[1])));
      for (let px = 0; px < W; px++) {
        const sx = Math.min(W - 1, Math.max(0, Math.round(px - shift[0])));
        let k = light.gain * (1 + light.gradient * (px / W - 0.5) - 0.5 * light.gradient * (py / H - 0.5));
        for (const s of shadows) {
          const dx = px / W - s.x;
          const dy = py / H - s.y;
          k *= 1 - s.depth * Math.exp(-(dx * dx + dy * dy) / (s.radius * s.radius));
        }
        const i = (sy * W + sx) * 3;
        const o = (py * W + px) * 4;
        out[o] = src[i] * k * (1 + light.warmth) + this.noise * this.noiseTable[ni++];
        out[o + 1] = src[i + 1] * k + this.noise * this.noiseTable[ni++];
        out[o + 2] = src[i + 2] * k * (1 - light.warmth) + this.noise * this.noiseTable[ni++];
        out[o + 3] = 255;
      }
    }
    return { width: W, height: H, data: out };
  }

  #depth(x, y, z) {
    const { C } = this.cam;
    return Math.hypot(x - C[0], y - C[1], z - C[2]);
  }

  #drawPiece(img, p) {
    const prof = PROFILES[p.code[1]];
    const base = this.colors[p.code[0]];
    const z0 = p.z || 0;
    const top = prof[prof.length - 1][0];
    const steps = Math.max(10, Math.round(top / 0.025));
    for (let s = 0; s <= steps; s++) {
      const h = (s / steps) * top;
      const r = interp(prof, h);
      if (r <= 0.005) continue;
      // Tipped pieces lie along +x.
      const cx = p.tipped ? p.x + h : p.x;
      const cz = p.tipped ? z0 + 0.25 : z0 + h;
      const pts = [];
      for (let i = 0; i < 20; i++) {
        const a = (i / 20) * Math.PI * 2;
        pts.push(this.project(p.tipped ? [cx, p.y + r * Math.cos(a), cz + r * Math.sin(a)] : [cx + r * Math.cos(a), p.y + r * Math.sin(a), cz]));
      }
      const shade = 0.72 + 0.28 * (h / top);
      const rim = base.map((c) => c * shade * 0.78);
      fillPolygon(img, this.W, this.H, pts, rim);
      const c = this.project([cx, p.y, cz]);
      const inner = pts.map(([x, y]) => [c[0] + (x - c[0]) * 0.8, c[1] + (y - c[1]) * 0.8]);
      fillPolygon(img, this.W, this.H, inner, base.map((c) => Math.min(255, c * shade * 1.04)));
    }
    // A highlight near the top.
    const hz = z0 + top * 0.85;
    const hc = this.project([p.x - 0.05, p.y - 0.05, hz]);
    const rad = Math.max(1, this.#scaleAt(p.x, p.y, hz) * 0.05);
    const hl = base.map((c) => Math.min(255, c * 1.25 + 30));
    fillPolygon(img, this.W, this.H, circle(hc, rad), hl);
  }

  #scaleAt(x, y, z) {
    const a = this.project([x, y, z]);
    const b = this.project([x + 1, y, z]);
    return Math.hypot(b[0] - a[0], b[1] - a[1]);
  }

  #drawHand(img, h) {
    const skin = h.skin || [206, 158, 128];
    const sleeve = h.sleeve || [60, 70, 110];
    // The arm comes from the player's side of the table.
    const from = h.side === 'b' ? [h.x + 0.5, 12, h.z + 3] : [h.x - 0.5, -4, h.z + 3];
    const elbow = [(from[0] + h.x) / 2, (from[1] + h.y) / 2, (from[2] + h.z) / 2 + 0.3];
    this.#drawLimb(img, from, elbow, 0.55, sleeve);
    this.#drawLimb(img, elbow, [h.x, h.y, h.z], 0.38, skin);
    const c = this.project([h.x, h.y, h.z]);
    fillPolygon(img, this.W, this.H, circle(c, this.#scaleAt(h.x, h.y, h.z) * 0.5), skin);
  }

  #drawLimb(img, a, b, width, color) {
    const pa = this.project(a);
    const pb = this.project(b);
    const wa = this.#scaleAt(...a) * width;
    const wb = this.#scaleAt(...b) * width;
    const dx = pb[0] - pa[0];
    const dy = pb[1] - pa[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    fillPolygon(img, this.W, this.H, [
      [pa[0] + nx * wa, pa[1] + ny * wa],
      [pb[0] + nx * wb, pb[1] + ny * wb],
      [pb[0] - nx * wb, pb[1] - ny * wb],
      [pa[0] - nx * wa, pa[1] - ny * wa],
    ], color);
  }
}

function interp(prof, h) {
  for (let i = 1; i < prof.length; i++) {
    if (h <= prof[i][0]) {
      const [h0, r0] = prof[i - 1];
      const [h1, r1] = prof[i];
      return r0 + ((r1 - r0) * (h - h0)) / (h1 - h0 || 1);
    }
  }
  return 0;
}

function circle([cx, cy], r) {
  const pts = [];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

// Scanline polygon fill (even-odd), sampling pixel centers.
function fillPolygon(img, W, H, pts, rgb) {
  let minY = Infinity, maxY = -Infinity;
  for (const [, y] of pts) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const y0 = Math.max(0, Math.ceil(minY - 0.5));
  const y1 = Math.min(H - 1, Math.floor(maxY - 0.5));
  const xs = [];
  for (let py = y0; py <= y1; py++) {
    const yc = py + 0.5;
    xs.length = 0;
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % pts.length];
      if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) xs.push(ax + ((yc - ay) * (bx - ax)) / (by - ay));
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const xa = Math.max(0, Math.ceil(xs[i] - 0.5));
      const xb = Math.min(W - 1, Math.floor(xs[i + 1] - 0.5));
      for (let px = xa; px <= xb; px++) {
        const k = (py * W + px) * 3;
        img[k] = rgb[0];
        img[k + 1] = rgb[1];
        img[k + 2] = rgb[2];
      }
    }
  }
}

function boxBlur3(img, W, H, r) {
  const out = new Float32Array(img.length);
  const tmp = new Float32Array(img.length);
  const n = 2 * r + 1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        for (let d = -r; d <= r; d++) acc += img[(y * W + Math.min(W - 1, Math.max(0, x + d))) * 3 + c];
        tmp[(y * W + x) * 3 + c] = acc / n;
      }
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        for (let d = -r; d <= r; d++) acc += tmp[(Math.min(H - 1, Math.max(0, y + d)) * W + x) * 3 + c];
        out[(y * W + x) * 3 + c] = acc / n;
      }
    }
  }
  return out;
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => {
  const l = Math.hypot(...a);
  return a.map((x) => x / l);
};
