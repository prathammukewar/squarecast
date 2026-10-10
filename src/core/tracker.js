// Keeps the game record in step with the board.
//
// Each time the board goes still we compare it with the picture taken
// when the last move was recorded, and score every candidate
// explanation. Then one of three things happens:
//   commit: one candidate clearly beats the rest, so record it;
//   ask: a few candidates are close, so show them and let a person tap;
//   wait: the board is part way through something (a captured piece
//         lifted before the capturing piece lands, a king moved before
//         its rook), so do nothing yet.
// Recording a wrong move is the one thing we must never do. Asking is
// always better than guessing.

import { newGame, singleMoves, movePairs, takeback, replacements } from './moves.js';
import { compare, PIXEL_KEYS } from './features.js';
import { OccupancyModel, bestClass } from './classifier.js';
import { changeEvidence, rank, strayChanges, DEFAULTS } from './score.js';
import { occupancyOf } from './squares.js';
import { SAME, CHANGED } from './moves.js';

export const TRACKER_DEFAULTS = {
  commitMargin: 6, // log-likelihood lead needed to record a move unasked
  pairMargin: 10, // stricter lead for two moves at once
  askWindow: 6, // candidates this close to the best are offered
  maxOptions: 3,
  absorbAfterMs: 1000, // changes that keep every square's occupancy are accepted as adjustments
  nudgeAskAfterMs: 1000, // a move that fits apart from nudged pieces becomes a question
  askAfterMs: 6000, // a board that stays part way through something becomes a question
  mismatchAfterMs: 12000, // total time the board has disagreed with the record
  pairs: true,
};

export class Tracker {
  constructor(warp, { fen, params } = {}) {
    this.warp = warp;
    this.chess = newGame(fen);
    this.params = { ...DEFAULTS, ...TRACKER_DEFAULTS, ...params };
    this.model = new OccupancyModel();
    this.ref = null; // snapshot of the board when the last move was recorded
    this.lastSnap = null;
    this.state = 'calibrating';
    this.pending = null; // the open question, if any
    this.dismissed = null;
    this.waitingSince = null;
    this.unexplainedSince = null;
    this.mismatchShown = false;
    this.nextAskId = 1;
  }

  get calibrated() {
    return this.ref !== null;
  }

  onMotion(t) {
    const events = [];
    this.waitingSince = null;
    this.dismissed = null;
    if (this.calibrated && !this.pending) this.#setState('busy', t, events);
    return events;
  }

  onStill(snap, t, lastMotion) {
    const events = [];
    this.lastSnap = snap;
    if (!this.calibrated) {
      this.#calibrate(snap, t, events);
      return events;
    }
    if (this.pending) return events;
    const obs = this.#observe(snap);
    const stray = strayChanges(obs, this.params);
    if (!stray.length) {
      // Nothing moved. Follow slow lighting changes on the visible squares.
      this.ref = mergeSnapshot(this.warp, snap, this.ref, obs.occluded);
      this.waitingSince = null;
      this.unexplainedSince = null;
      this.mismatchShown = false;
      this.#setState('watching', t, events);
      return events;
    }
    this.#decide(snap, obs, stray, t, lastMotion, events);
    return events;
  }

  #calibrate(snap, t, events) {
    const occ = occupancyOf(this.chess);
    this.model.calibrate(snap, occ);
    this.ref = snap;
    const ll = this.model.classify(snap, occ);
    const mismatched = [];
    for (let sq = 0; sq < 64; sq++) if (bestClass(ll, sq) !== occ[sq]) mismatched.push(sq);
    events.push({ type: 'calibrated', t, mismatched });
    this.#setState('watching', t, events);
  }

  #observe(snap) {
    const cmp = compare(this.warp, snap, this.ref);
    const { llr, noise } = changeEvidence(cmp.d, cmp.occluded, this.params);
    const beforeOcc = occupancyOf(this.chess);
    const trusted = new Uint8Array(64);
    for (let sq = 0; sq < 64; sq++) trusted[sq] = !cmp.occluded[sq] && llr[sq] < 0 ? 1 : 0;
    const occ = this.model.classify(snap, beforeOcc, trusted);
    return { llr, noise, occluded: cmp.occluded, occ, beforeOcc, d: cmp.d, spill: this.warp.spill };
  }

  #decide(snap, obs, stray, t, lastMotion, events) {
    const p = this.params;
    const singles = rank(singleMoves(this.chess), obs, p);
    const extras = rank([takeback(this.chess), ...replacements(this.chess)].filter(Boolean), obs, p);
    const best = singles[0];
    const rivalLead = (winner, pools) => {
      let top = -Infinity;
      for (const pool of pools) {
        for (const r of pool) if (r !== winner) top = Math.max(top, r.score, r.optimistic);
      }
      return winner.score - top;
    };

    if (best && best.fits) {
      if (rivalLead(best, [singles, extras]) >= p.commitMargin) {
        this.#commit(best, snap, obs, t, lastMotion, events);
        return;
      }
      if (this.#ask('close', pickOptions([...singles, ...extras], best, p), snap, obs, t, events)) return;
    }

    const bestExtra = extras[0];
    if (bestExtra && bestExtra.fits) {
      const options = [bestExtra, ...singles.filter((s) => s.fits)].slice(0, p.maxOptions);
      if (this.#ask(bestExtra.cand.kind, options, snap, obs, t, events)) return;
    }

    if (p.pairs) {
      const pairs = rank(movePairs(this.chess), obs, p);
      const bp = pairs[0];
      if (bp && bp.fits) {
        if (rivalLead(bp, [pairs, singles, extras]) >= p.pairMargin) {
          this.#commit(bp, snap, obs, t, lastMotion, events);
          return;
        }
        if (this.#ask('close', pickOptions([...pairs, ...singles], bp, p), snap, obs, t, events)) return;
      }
    }

    // Part way through something. Wait, but not forever.
    if (this.waitingSince === null) this.waitingSince = t;
    if (this.unexplainedSince === null) this.unexplainedSince = t;
    const waited = t - this.waitingSince;
    this.#setState('waiting', t, events);

    // A piece nudged or straightened in place: every changed square still
    // looks like what the record says is there.
    const keepsOccupancy = stray.every((sq) => bestClass(obs.occ, sq) === obs.beforeOcc[sq]);
    if (keepsOccupancy && waited >= p.absorbAfterMs) {
      this.ref = mergeSnapshot(this.warp, snap, this.ref, obs.occluded);
      this.waitingSince = null;
      this.unexplainedSince = null;
      this.#setState('watching', t, events);
      return;
    }
    // A move that explains everything except squares whose pieces only
    // look nudged. Probably right, but ask rather than assume.
    const nudged = (s) => s.missing.length === 0 && s.hidden.length === 0 && s.stray.length > 0 &&
      s.stray.every((sq) => bestClass(obs.occ, sq) === s.cand.afterOcc[sq]);
    if (waited >= p.nudgeAskAfterMs && best && nudged(best)) {
      if (this.#ask('close', pickOptions([...singles, ...extras], best, p), snap, obs, t, events)) return;
    }
    if (waited >= p.askAfterMs) {
      const near = singles.filter((s) => s.missing.length <= 2 && s.stray.length <= 1 && s.score > 0);
      if (near.length && this.#ask('partial', near.slice(0, p.maxOptions), snap, obs, t, events)) return;
    }
    if (t - this.unexplainedSince >= p.mismatchAfterMs && !this.mismatchShown) {
      this.mismatchShown = true;
      events.push({ type: 'mismatch', t, squares: stray });
    }
  }

  #commit(scored, snap, obs, t, lastMotion, events, how = 'auto') {
    for (const m of scored.cand.moves) this.chess.move({ from: m.from, to: m.to, promotion: m.promotion });
    this.#afterRecord(snap, obs, scored.cand.states);
    events.push({
      type: 'commit',
      t,
      how,
      kind: scored.cand.kind,
      san: scored.cand.san,
      uci: scored.cand.moves.map(uci),
      latency: lastMotion == null ? null : t - lastMotion,
    });
    for (const m of scored.cand.moves) {
      if (m.promotion) events.push({ type: 'promotion', t, san: m.san });
    }
    this.#checkGameOver(t, events);
    this.#setState('watching', t, events);
  }

  #afterRecord(snap, obs, states) {
    const trusted = new Uint8Array(64);
    for (let sq = 0; sq < 64; sq++) {
      if (obs.occluded[sq]) continue;
      const s = states ? states[sq] : SAME;
      trusted[sq] = (s === SAME && obs.llr[sq] < 0) || s === CHANGED ? 1 : 0;
    }
    this.ref = mergeSnapshot(this.warp, snap, this.ref, obs.occluded);
    this.model.refresh(snap, occupancyOf(this.chess), trusted);
    this.waitingSince = null;
    this.unexplainedSince = null;
    this.mismatchShown = false;
    this.pending = null;
  }

  // Returns false when there was nothing new to ask.
  #ask(reason, options, snap, obs, t, events) {
    if (!options.length) return false;
    const sig = reason + ':' + options.map((o) => o.cand.kind + ' ' + o.cand.san.join(' ')).join('|');
    if (this.dismissed === sig) return false;
    this.pending = { id: this.nextAskId++, reason, options, sig, snap, obs, t };
    events.push({
      type: 'ask',
      t,
      id: this.pending.id,
      reason,
      options: options.map((o) => ({ kind: o.cand.kind, san: o.cand.san })),
    });
    this.#setState('asking', t, events);
    return true;
  }

  // The user picked option `index` of question `id`, or none (null).
  answer(id, index, t) {
    const events = [];
    const q = this.pending;
    if (!q || q.id !== id) return events;
    this.pending = null;
    if (index === null || index === undefined) {
      this.dismissed = q.sig;
      this.#setState('waiting', t, events);
      return events;
    }
    const chosen = q.options[index];
    const { cand } = chosen;
    if (cand.kind === 'takeback') {
      this.chess.undo();
      this.#afterRecord(q.snap, q.obs, cand.states);
      events.push({ type: 'undo', t, how: 'tap' });
    } else {
      if (cand.kind === 'replace') {
        this.chess.undo();
        events.push({ type: 'undo', t, how: 'tap' });
      }
      this.#commit(chosen, q.snap, q.obs, t, null, events, 'tap');
      return events;
    }
    this.#setState('watching', t, events);
    return events;
  }

  // Manual corrections from the "fix move" picker.
  undo(t) {
    const m = this.chess.undo();
    return m ? [{ type: 'undo', t, how: 'manual', san: m.san }] : [];
  }

  play(san, t) {
    const events = [];
    const m = this.chess.move(san);
    this.pending = null;
    if (this.lastSnap) this.ref = this.lastSnap;
    this.waitingSince = null;
    this.unexplainedSince = null;
    this.mismatchShown = false;
    events.push({ type: 'commit', t, how: 'manual', kind: 'move', san: [m.san], uci: [uci(m)], latency: null });
    this.#checkGameOver(t, events);
    return events;
  }

  // Change the piece of the last move's promotion (the camera can't tell).
  setPromotion(piece, t) {
    const last = this.chess.undo();
    if (!last || !last.promotion) {
      if (last) this.chess.move(last);
      return [];
    }
    const m = this.chess.move({ from: last.from, to: last.to, promotion: piece });
    return [{ type: 'promotion-changed', t, san: m.san }];
  }

  #checkGameOver(t, events) {
    const c = this.chess;
    if (c.isCheckmate()) events.push({ type: 'gameover', t, result: c.turn() === 'w' ? '0-1' : '1-0', reason: 'checkmate' });
    else if (c.isStalemate()) events.push({ type: 'gameover', t, result: '1/2-1/2', reason: 'stalemate' });
    else if (c.isInsufficientMaterial()) events.push({ type: 'gameover', t, result: '1/2-1/2', reason: 'insufficient material' });
  }

  #setState(state, t, events) {
    if (this.state === state) return;
    this.state = state;
    events.push({ type: 'status', t, state });
  }
}

const uci = (m) => m.from + m.to + (m.promotion || '');

function pickOptions(pool, best, p) {
  const out = [best];
  for (const s of pool) {
    if (out.length >= p.maxOptions) break;
    if (s === best || s.score < best.score - p.askWindow) continue;
    if (s.fits || s.missing.length <= 1) out.push(s);
  }
  return out;
}

// A new reference picture, keeping the old pixels for squares that are
// covered right now (so an arm resting on the board doesn't get baked in).
export function mergeSnapshot(warp, snap, ref, occluded) {
  if (!ref || !occluded.some((x) => x)) return snap;
  const out = { ...snap, stats: Object.fromEntries(Object.entries(snap.stats).map(([k, v]) => [k, v.slice()])) };
  for (const key of PIXEL_KEYS) out[key] = snap[key].slice();
  for (let k = 0; k < out.E.length; k++) {
    const sq = warp.squareOf[k];
    if (sq >= 0 && occluded[sq]) for (const key of PIXEL_KEYS) out[key][k] = ref[key][k];
  }
  for (let sq = 0; sq < 64; sq++) {
    if (!occluded[sq]) continue;
    for (const key of Object.keys(out.stats)) out.stats[key][sq] = ref.stats[key][sq];
  }
  return out;
}
