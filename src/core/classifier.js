// Says whether each square holds nothing, a light piece or a dark piece.
//
// There is no training data. The starting position teaches us what this
// particular board looks like: ranks 3 to 6 are empty light and dark
// squares, ranks 1 and 2 hold light pieces, ranks 7 and 8 dark ones. That
// gives live examples of all six classes (empty, light piece, dark piece,
// each on a light or a dark square), and a nearest-centroid model on a
// few simple features is enough.
//
// Features are measured relative to what the same square looks like
// empty, under the current lighting, so a light gradient across the
// board or a lamp switched on doesn't move them much.

import { EMPTY, WHITE, BLACK, isLight } from './squares.js';
import { median } from './features.js';

const DIMS = 5;
// Smallest spread we allow per feature, so a class seen only a few times
// at calibration doesn't become overconfident.
const SPREAD_FLOOR = [7, 4, 4, 3, 3];
const LL_FLOOR = -12;

export class OccupancyModel {
  constructor() {
    this.empty = null; // per-square empty appearance [Y, U, V, sd, E]
    this.classes = null; // [lightSquare][occupancy] -> { mean, spread }
  }

  get ready() {
    return this.classes !== null;
  }

  // snap: snapshot of the board in a known position; occ: its occupancy.
  calibrate(snap, occ) {
    this.empty = new Array(64);
    for (let sq = 0; sq < 64; sq++) {
      if (occ[sq] === EMPTY) this.empty[sq] = raw(snap, sq);
    }
    for (let sq = 0; sq < 64; sq++) {
      if (!this.empty[sq]) this.empty[sq] = this.#borrowEmpty(sq);
    }
    const samples = [[[], [], []], [[], [], []]];
    const gains = this.#gains(snap, occ);
    for (let sq = 0; sq < 64; sq++) {
      samples[isLight(sq) ? 1 : 0][occ[sq]].push(this.#features(snap, sq, gains[sq]));
    }
    this.classes = samples.map((byOcc) => byOcc.map(fitClass));
  }

  // Empty appearance for a square that wasn't empty at calibration: the
  // nearest square of the same color in the same file that was.
  #borrowEmpty(sq) {
    const f = sq & 7;
    const r = sq >> 3;
    for (const dr of [2, -2, 4, -4, 6, -6]) {
      const rr = r + dr;
      if (rr < 0 || rr > 7) continue;
      const e = this.empty[rr * 8 + f];
      if (e && e.borrowed !== true) return Object.assign([...e], { borrowed: true });
    }
    for (let other = 0; other < 64; other++) {
      if (isLight(other) === isLight(sq) && this.empty[other] && !this.empty[other].borrowed) {
        return Object.assign([...this.empty[other]], { borrowed: true });
      }
    }
    return Object.assign([128, 0, 0, 4, 4], { borrowed: true });
  }

  // Lighting relative to calibration, estimated from squares we believe
  // are empty, smoothed over each square's neighborhood.
  #gains(snap, occ, trusted) {
    const ratio = new Float32Array(64).fill(NaN);
    for (let sq = 0; sq < 64; sq++) {
      if (occ[sq] !== EMPTY || (trusted && !trusted[sq])) continue;
      ratio[sq] = (snap.stats.Y[sq] + 4) / (this.empty[sq][0] + 4);
    }
    const all = Array.from(ratio).filter((x) => !Number.isNaN(x));
    const global = all.length ? median(all) : 1;
    const gains = new Float32Array(64);
    for (let sq = 0; sq < 64; sq++) {
      const vals = [];
      const f = sq & 7;
      const r = sq >> 3;
      for (let dr = -2; dr <= 2; dr++) {
        for (let df = -2; df <= 2; df++) {
          const ff = f + df;
          const rr = r + dr;
          if (ff < 0 || ff > 7 || rr < 0 || rr > 7) continue;
          const x = ratio[rr * 8 + ff];
          if (!Number.isNaN(x)) vals.push(x);
        }
      }
      gains[sq] = vals.length >= 3 ? median(vals) : global;
    }
    return gains;
  }

  #features(snap, sq, g) {
    const e = this.empty[sq];
    const s = snap.stats;
    return [
      (100 * (s.Y[sq] - g * e[0])) / (g * e[0] + 8),
      s.U[sq] - g * e[1],
      s.V[sq] - g * e[2],
      s.sd[sq] - g * e[3],
      s.E[sq] - g * e[4],
    ];
  }

  // Log-probabilities of [empty, light piece, dark piece] for every square
  // (flat array, 3 per square). occ is the position we believe is on the
  // board, used only to find empty squares for the lighting estimate.
  classify(snap, occ, trusted) {
    const gains = this.#gains(snap, occ, trusted);
    const out = new Float32Array(192);
    for (let sq = 0; sq < 64; sq++) {
      const f = this.#features(snap, sq, gains[sq]);
      const models = this.classes[isLight(sq) ? 1 : 0];
      const ll = models.map((m) => (m ? logLikelihood(f, m) : -Infinity));
      const top = Math.max(...ll);
      const z = top + Math.log(ll.reduce((a, x) => a + Math.exp(x - top), 0));
      for (let c = 0; c < 3; c++) out[sq * 3 + c] = Math.max(LL_FLOOR, ll[c] - z);
    }
    return out;
  }

  // After a confident commit: squares that are empty now and plainly
  // visible become the new empty reference, and class centers drift a
  // little toward what confident squares look like now.
  refresh(snap, occ, trusted) {
    const gains = this.#gains(snap, occ, trusted);
    // Class centers first, while the empty references still match the
    // lighting the gains were measured against.
    const rate = 0.05;
    for (let sq = 0; sq < 64; sq++) {
      if (!trusted[sq]) continue;
      const m = this.classes[isLight(sq) ? 1 : 0][occ[sq]];
      if (!m) continue;
      const f = this.#features(snap, sq, gains[sq]);
      for (let i = 0; i < DIMS; i++) m.mean[i] += rate * (f[i] - m.mean[i]);
    }
    // Stored in calibration lighting, so divide out the current gain.
    for (let sq = 0; sq < 64; sq++) {
      if (trusted[sq] && occ[sq] === EMPTY) this.empty[sq] = raw(snap, sq).map((x) => x / gains[sq]);
    }
  }
}

export function bestClass(ll, sq) {
  let best = EMPTY;
  for (const c of [WHITE, BLACK]) if (ll[sq * 3 + c] > ll[sq * 3 + best]) best = c;
  return best;
}

function raw(snap, sq) {
  const s = snap.stats;
  return [s.Y[sq], s.U[sq], s.V[sq], s.sd[sq], s.E[sq]];
}

function fitClass(samples) {
  if (!samples.length) return null;
  const mean = new Array(DIMS).fill(0);
  for (const f of samples) for (let i = 0; i < DIMS; i++) mean[i] += f[i] / samples.length;
  const spread = new Array(DIMS).fill(0);
  for (const f of samples) for (let i = 0; i < DIMS; i++) spread[i] += (f[i] - mean[i]) ** 2 / samples.length;
  for (let i = 0; i < DIMS; i++) spread[i] = Math.max(SPREAD_FLOOR[i], Math.sqrt(spread[i]) * 1.5);
  return { mean, spread };
}

function logLikelihood(f, m) {
  let ll = 0;
  for (let i = 0; i < DIMS; i++) {
    const z = (f[i] - m.mean[i]) / m.spread[i];
    ll -= 0.5 * z * z + Math.log(m.spread[i]);
  }
  return ll;
}
