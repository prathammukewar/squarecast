// Per-square measurements on the top-down view, and the change between
// two views of the board.

import { boxBlur, gradient } from './warp.js';

// Per-pixel arrays of a snapshot (blurred color channels and edges).
export const PIXEL_KEYS = ['Rb', 'Gb', 'Bb', 'E'];
const COLOR_KEYS = ['Rb', 'Gb', 'Bb'];

// Everything we need from one (averaged) view of a still board.
export function snapshot(warp, view) {
  const { N, S } = warp;
  const r = Math.max(1, Math.round(S / 10));
  const Rb = boxBlur(view.R, N, r);
  const Gb = boxBlur(view.G, N, r);
  const Bb = boxBlur(view.B, N, r);
  const E = boxBlur(gradient(boxBlur(view.Y, N, 1), N), N, 1);
  const stats = {
    Y: new Float32Array(64),
    U: new Float32Array(64),
    V: new Float32Array(64),
    sd: new Float32Array(64),
    E: new Float32Array(64),
  };
  for (let sq = 0; sq < 64; sq++) {
    const region = warp.regions[sq];
    let sy = 0, syy = 0, sr = 0, sb = 0, se = 0;
    for (const k of region) {
      const y = view.Y[k];
      sy += y;
      syy += y * y;
      sr += Rb[k];
      sb += Bb[k];
      se += E[k];
    }
    const n = region.length || 1;
    const mean = sy / n;
    stats.Y[sq] = mean;
    stats.U[sq] = sb / n - mean;
    stats.V[sq] = sr / n - mean;
    stats.sd[sq] = Math.sqrt(Math.max(0, syy / n - mean * mean));
    stats.E[sq] = se / n;
  }
  return { Rb, Gb, Bb, E, stats };
}

// Mean of each color channel over a square's sample region.
function channelMeans(warp, snap, sq) {
  const region = warp.regions[sq];
  const out = [0, 0, 0];
  for (const k of region) {
    out[0] += snap.Rb[k];
    out[1] += snap.Gb[k];
    out[2] += snap.Bb[k];
  }
  const n = region.length || 1;
  return out.map((x) => x / n + 4);
}

// How much a square's pattern changed, ignoring its brightness and color
// balance. Each channel of the region is divided by its own mean first,
// so a shadow, a lamp or a white balance shift (which scale the channels)
// leaves this near zero, while a piece arriving or leaving changes it.
export function patternChange(warp, cur, ref, sq, curMeans, refMeans) {
  const region = warp.regions[sq];
  const cm = curMeans || channelMeans(warp, cur, sq);
  const rm = refMeans || channelMeans(warp, ref, sq);
  let acc = 0;
  for (let c = 0; c < 3; c++) {
    const a = cur[COLOR_KEYS[c]];
    const b = ref[COLOR_KEYS[c]];
    const ia = 1 / cm[c];
    const ib = 1 / rm[c];
    for (const k of region) acc += Math.abs(a[k] * ia - b[k] * ib);
  }
  return acc / (3 * (region.length || 1));
}

// Lighting change between two snapshots: a gain per square for each color
// channel. Where a square's pattern is unchanged, its own ratios are pure
// lighting and we use them as they are. Where the pattern changed (a piece
// moved) we borrow the median ratios of nearby unchanged squares.
export function gainField(warp, cur, ref) {
  const ratio = [new Float32Array(64), new Float32Array(64), new Float32Array(64)];
  const steady = new Uint8Array(64);
  for (let sq = 0; sq < 64; sq++) {
    const cm = channelMeans(warp, cur, sq);
    const rm = channelMeans(warp, ref, sq);
    for (let c = 0; c < 3; c++) ratio[c][sq] = cm[c] / rm[c];
    steady[sq] = patternChange(warp, cur, ref, sq, cm, rm) < 0.08 ? 1 : 0;
  }
  const gains = [new Float32Array(64), new Float32Array(64), new Float32Array(64)];
  for (let sq = 0; sq < 64; sq++) {
    if (steady[sq]) {
      for (let c = 0; c < 3; c++) gains[c][sq] = ratio[c][sq];
      continue;
    }
    const nearby = steadyNeighbors(sq, steady);
    for (let c = 0; c < 3; c++) {
      const vals = nearby.map((o) => ratio[c][o]);
      gains[c][sq] = vals.length ? median(vals) : 1;
    }
  }
  return { gains, steady };
}

function steadyNeighbors(sq, steady) {
  const f = sq & 7;
  const r = sq >> 3;
  let found = [];
  for (const radius of [1, 2, 3, 8]) {
    found = [];
    for (let dr = -radius; dr <= radius; dr++) {
      for (let df = -radius; df <= radius; df++) {
        const ff = f + df;
        const rr = r + dr;
        if (ff < 0 || ff > 7 || rr < 0 || rr > 7) continue;
        if (steady[rr * 8 + ff]) found.push(rr * 8 + ff);
      }
    }
    if (found.length >= 3) break;
  }
  return found;
}

// How much each square changed between the reference snapshot and the
// current one, after removing smooth lighting changes. Also flags squares
// covered by something that reaches in from outside the board (an arm or
// a sleeve), which we treat as unseen rather than changed.
export function compare(warp, cur, ref) {
  const { N, S } = warp;
  const { gains } = gainField(warp, cur, ref);
  // Per-pixel gains, interpolated between square centers, so a soft
  // shadow edge running through a square is followed inside it too.
  const gp = gains.map((g) => warp.spread(g));
  const gy = warp.spread(gains[0].map((r, i) => 0.3 * r + 0.59 * gains[1][i] + 0.11 * gains[2][i]));
  const change = (k) => {
    let x = 0;
    for (let c = 0; c < 3; c++) x += Math.abs(cur[COLOR_KEYS[c]][k] / gp[c][k] - ref[COLOR_KEYS[c]][k]);
    return 0.6 * x + 0.5 * Math.abs(cur.E[k] / gy[k] - ref.E[k]);
  };
  const d = new Float32Array(64);
  for (let sq = 0; sq < 64; sq++) {
    let acc = 0;
    for (const k of warp.regions[sq]) acc += change(k);
    d[sq] = acc / (warp.regions[sq].length || 1);
  }

  // Coarse change map over the whole view, including the margin.
  const cell = Math.max(2, Math.round(S / 4));
  const C = Math.floor(N / cell);
  const changed = new Uint8Array(C * C);
  const outsideCell = new Uint8Array(C * C);
  const inFrame = new Uint8Array(C * C);
  for (let cj = 0; cj < C; cj++) {
    for (let ci = 0; ci < C; ci++) {
      let acc = 0, n = 0, out = 0;
      for (let j = cj * cell; j < (cj + 1) * cell; j++) {
        for (let i = ci * cell; i < (ci + 1) * cell; i++) {
          const k = j * N + i;
          if (warp.src[k] < 0) continue;
          acc += change(k);
          out += warp.outside[k];
          n++;
        }
      }
      const c = cj * C + ci;
      inFrame[c] = n > 0 ? 1 : 0;
      changed[c] = n > 0 && acc / n > 28 ? 1 : 0;
      outsideCell[c] = out * 2 > n ? 1 : 0;
    }
  }

  // Cells where something can enter the picture: the edge of the view, or
  // the edge of the camera frame when the board fills it.
  const entry = (x) => {
    const xi = x % C;
    const xj = (x / C) | 0;
    if (xi === 0 || xj === 0 || xi === C - 1 || xj === C - 1) return true;
    return !inFrame[x - 1] || !inFrame[x + 1] || !inFrame[x - C] || !inFrame[x + C];
  };

  // Flood fill changed cells from the entry edge. A blob that comes in
  // from outside and covers a fair area of the margin is a body part, not
  // a chess piece.
  const seen = new Uint8Array(C * C);
  const occluded = new Uint8Array(64);
  const queue = [];
  for (let c = 0; c < C * C; c++) {
    if (!changed[c] || seen[c] || !entry(c)) continue;
    const members = [];
    queue.length = 0;
    queue.push(c);
    seen[c] = 1;
    while (queue.length) {
      const x = queue.pop();
      members.push(x);
      const xi = x % C;
      const xj = (x / C) | 0;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = xi + di;
        const nj = xj + dj;
        if (ni < 0 || nj < 0 || ni >= C || nj >= C) continue;
        const y = nj * C + ni;
        if (changed[y] && !seen[y]) {
          seen[y] = 1;
          queue.push(y);
        }
      }
    }
    // An arm is wide where it crosses into the picture. The top of a tall
    // piece leaning past the board edge (angled camera) is narrow.
    const outsideArea = members.filter((x) => outsideCell[x]).length * cell * cell;
    const edgeCells = members.filter(entry).length;
    if (outsideArea < 0.6 * S * S || edgeCells * cell < 0.75 * S) continue;
    const perSquare = new Map();
    for (const x of members) {
      const k = (((x / C) | 0) * cell + (cell >> 1)) * N + (x % C) * cell + (cell >> 1);
      const sq = warp.squareOf[k];
      if (sq >= 0) perSquare.set(sq, (perSquare.get(sq) || 0) + 1);
    }
    const cellsPerSquare = (S / cell) ** 2;
    for (const [sq, n] of perSquare) if (n >= 0.25 * cellsPerSquare) occluded[sq] = 1;
  }

  return { d, gains, occluded };
}

export function median(values) {
  const a = Float64Array.from(values).sort();
  const n = a.length;
  if (!n) return 0;
  return n % 2 ? a[(n - 1) / 2] : 0.5 * (a[n / 2 - 1] + a[n / 2]);
}
