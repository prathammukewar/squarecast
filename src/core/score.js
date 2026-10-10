// Scores candidate explanations against what the camera saw.
//
// Two signals per square:
//   change: did the square change since the last recorded position?
//   occupancy: does it now look empty, light-occupied or dark-occupied?
// A candidate says which squares should have changed and what should be
// on them now. Its score is a log-likelihood ratio against "nothing
// happened", so it's comparable across candidates of any kind.

import { SAME, CHANGED, UNKNOWN } from './moves.js';

export const DEFAULTS = {
  changeMidpoint: 3.2, // normalized change where "changed" and "same" are equally likely
  changeSlope: 1.6,
  changeMin: -5,
  changeMax: 7,
  occupancyWeight: 0.6,
  seenChange: 0.5, // evidence a changed square needs to count as seen
  strayChange: 1.5, // evidence that marks an unexplained change
};

// Turn raw per-square change into evidence. d is divided by the typical
// change of the board (most squares don't change between two still
// frames), then mapped to a log-likelihood ratio and clipped so that one
// square can't outvote the rest.
export function changeEvidence(d, occluded, params = DEFAULTS) {
  const visible = [];
  for (let sq = 0; sq < 64; sq++) if (!occluded[sq]) visible.push(d[sq]);
  visible.sort((a, b) => a - b);
  const typical = visible.length ? visible[Math.floor(visible.length / 2)] : 1;
  const noise = Math.max(typical, 2.5);
  const llr = new Float32Array(64);
  for (let sq = 0; sq < 64; sq++) {
    if (occluded[sq]) continue;
    const x = params.changeSlope * (d[sq] / noise - params.changeMidpoint);
    llr[sq] = Math.min(params.changeMax, Math.max(params.changeMin, x));
  }
  return { llr, noise };
}

// obs: { llr, occluded, occ (log-probs, 3 per square), beforeOcc, spill }
export function scoreCandidate(cand, obs, params = DEFAULTS) {
  const { llr, occluded, occ, beforeOcc, spill } = obs;
  // Squares an angled camera sees partly through the pieces that moved.
  const maybe = new Uint8Array(64);
  if (spill) {
    for (let sq = 0; sq < 64; sq++) {
      if (cand.states[sq] !== SAME) for (const s of spill[sq]) maybe[s] = 1;
    }
  }
  let score = 0;
  let optimisticExtra = 0;
  const missing = [];
  const hidden = [];
  for (let sq = 0; sq < 64; sq++) {
    let state = cand.states[sq];
    if (state === SAME && maybe[sq]) state = UNKNOWN;
    if (state === SAME) continue;
    if (occluded[sq]) {
      hidden.push(sq);
      if (state === CHANGED) optimisticExtra += params.changeMax;
      continue;
    }
    const after = cand.afterOcc[sq];
    const occScore = occ ? occ[sq * 3 + after] - occ[sq * 3 + beforeOcc[sq]] : 0;
    if (state === CHANGED) {
      // Occupancy only adds or subtracts evidence. It never vetoes a
      // change we saw: with an angled camera, a tall piece in front can
      // make an empty square look occupied.
      score += llr[sq] + params.occupancyWeight * occScore;
      if (llr[sq] < params.seenChange) missing.push(sq);
    } else if (state === UNKNOWN) {
      score += Math.log(0.5 + 0.5 * Math.exp(llr[sq]));
    }
  }
  const stray = [];
  for (let sq = 0; sq < 64; sq++) {
    if (cand.states[sq] === SAME && !maybe[sq] && !occluded[sq] && llr[sq] > params.strayChange) stray.push(sq);
  }
  return {
    cand,
    score,
    optimistic: score + optimisticExtra,
    missing,
    stray,
    hidden,
    fits: missing.length === 0 && stray.length === 0 && hidden.length === 0,
  };
}

// Squares that changed but no candidate accounts for, assuming nothing
// moved. Used to tell "nothing happened" from "something we can't explain".
export function strayChanges(obs, params = DEFAULTS) {
  const out = [];
  for (let sq = 0; sq < 64; sq++) {
    if (!obs.occluded[sq] && obs.llr[sq] > params.strayChange) out.push(sq);
  }
  return out;
}

export function rank(cands, obs, params = DEFAULTS) {
  return cands.map((c) => scoreCandidate(c, obs, params)).sort((a, b) => b.score - a.score);
}
