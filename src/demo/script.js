// Turns a list of moves into a timeline of board states with hands:
// a hand comes in from the mover's side, lifts the piece, carries it,
// puts it down (a little off center), and leaves. Options add the awkward
// things real players do: removing a captured piece first, castling king
// first and pausing, taking an en passant pawn late, moving before the
// opponent's hand is gone, hovering, nudging pieces, resting an arm.

import { Chess } from '../vendor/chess.js';
import { mulberry32 } from './scene.js';

const HOVER = 1.0;
const GRAB = 0.62;
const LIFT = 0.45; // how far a carried piece hangs below the hand

export function buildTimeline(sans, {
  fen,
  seed = 7,
  think = [1.4, 2.6], // still time after each move, seconds
  speed = 1, // >1 is faster hands
  offset = 0.07, // how far off center pieces get put down
  plies = {}, // per-ply options, keyed by ply index (0 = first move)
  idle = [], // [{ afterPly, kind: 'hover'|'adjust'|'arm', duration }]
  start = 1.5, // still time before the first move (calibration)
  tail = 2.5,
} = {}) {
  const rand = mulberry32(seed);
  const chess = fen ? new Chess(fen) : new Chess();
  const initial = piecesFromChess(chess);
  const muts = []; // { t, fn(pieces) }
  const hands = { w: [], b: [] }; // keyframes { t, pos | null }
  const truth = [];
  const handFree = { w: 0, b: 0 };
  let t = start;
  const dur = (s) => s / speed;

  // The hand starts off the board on its owner's side, visits each point
  // in turn and goes back.
  const handPath = (side, t0, points) => {
    const kf = hands[side];
    let tt = Math.max(t0, handFree[side]);
    kf.push({ t: tt - 0.001, pos: null });
    kf.push({ t: tt, pos: home(side, points[0][0][0]) });
    for (const [pos, d] of points) {
      tt += d;
      kf.push({ t: tt, pos });
    }
    tt += 0.001;
    kf.push({ t: tt, pos: null });
    handFree[side] = tt + 0.05;
    return tt;
  };
  const home = (side, x) => [x, side === 'w' ? -2.2 : 10.2, 2.2];
  const sq = (name) => [name.charCodeAt(0) - 96.5, name.charCodeAt(1) - 48.5];
  const jitter = () => [(rand() - 0.5) * 2 * offset, (rand() - 0.5) * 2 * offset];
  const captureSlot = { w: 0, b: 0 };
  const parkCaptured = (pieces, id) => {
    const p = pieces.find((q) => q.id === id);
    if (!p) return;
    const side = p.code[0];
    const n = captureSlot[side]++;
    p.x = side === 'w' ? -1.15 : 9.15;
    p.y = side === 'w' ? 7.5 - (n % 8) : 0.5 + (n % 8);
    p.z = 0;
  };

  // One trip of the hand: carry the piece on `from` to `to`.
  const carry = (side, t0, from, to, { onPick, onDrop, extra = [] } = {}) => {
    const [fx, fy] = sq(from);
    const [tx, ty] = sq(to);
    const [jx, jy] = jitter();
    const pts = [
      [[fx, fy, HOVER], dur(0.45)],
      [[fx, fy, GRAB], dur(0.15)],
      [[tx, ty, HOVER], dur(0.4)],
      [[tx + jx, ty + jy, GRAB], dur(0.15)],
      ...extra,
      [home(side, tx), dur(0.45)],
    ];
    const tStart = Math.max(t0, handFree[side]);
    const tPick = tStart + dur(0.45) + dur(0.15);
    const tDrop = tPick + dur(0.4) + dur(0.15);
    muts.push({ t: tPick, fn: (ps) => { const p = at(ps, fx, fy); if (p) { p.held = side; } onPick && onPick(ps, p); } });
    muts.push({ t: tDrop, fn: (ps) => { const p = ps.find((q) => q.held === side); if (p) { p.held = null; p.x = tx + jx; p.y = ty + jy; p.z = 0; } onDrop && onDrop(ps, p); } });
    const tEnd = handPath(side, t0, pts);
    return { tStart, tDrop, tEnd };
  };

  for (const it of idle.filter((i) => i.afterPly === -1)) t = idleAction(it, t);

  sans.forEach((san, ply) => {
    const opt = plies[ply] || {};
    const side = chess.turn();
    const m = chess.move(san);
    const capturedAt = m.flags.includes('e') ? m.to[0] + m.from[1] : m.captured ? m.to : null;
    let t0 = t;
    let done;
    if (opt.removeFirst && capturedAt) {
      // Lift the captured piece off first, pause, then make the move.
      const [cx, cy] = sq(capturedAt);
      const tLift = Math.max(t0, handFree[side]) + dur(0.6);
      handPath(side, t0, [[[cx, cy, HOVER], dur(0.45)], [[cx, cy, GRAB], dur(0.15)], [home(side, cx), dur(0.45)]]);
      muts.push({ t: tLift, fn: (ps) => { const p = at(ps, cx, cy); if (p) parkCaptured(ps, p.id); } });
      t0 = handFree[side] + opt.removeFirst;
    }
    const removeCaptured = (ps) => {
      if (!capturedAt || opt.removeFirst) return;
      if (m.flags.includes('e') && opt.lateEnPassant) return;
      const [cx, cy] = sq(capturedAt);
      const victim = ps.find((p) => !p.held && Math.abs(p.x - cx) < 0.45 && Math.abs(p.y - cy) < 0.45 && p.code[0] !== side);
      if (victim) parkCaptured(ps, victim.id);
    };
    if (m.flags.includes('k') || m.flags.includes('q')) {
      const rank = m.from[1];
      const [rf, rt] = m.flags.includes('k') ? ['h', 'f'] : ['a', 'd'];
      const k = carry(side, t0, m.from, m.to);
      const t1 = opt.kingFirst ? k.tEnd + opt.kingFirst : k.tEnd - dur(0.4);
      done = carry(side, t1, rf + rank, rt + rank).tEnd;
    } else {
      const promo = m.promotion ? side + m.promotion.toUpperCase() : null;
      const r = carry(side, t0, m.from, m.to, {
        onPick: (ps) => removeCaptured(ps),
        onDrop: (ps, p) => { if (p && promo) p.code = promo; },
      });
      done = r.tEnd;
      if (m.flags.includes('e') && opt.lateEnPassant) {
        const [cx, cy] = sq(capturedAt);
        const tl = r.tEnd + opt.lateEnPassant;
        handPath(side, tl, [[[cx, cy, HOVER], dur(0.45)], [[cx, cy, GRAB], dur(0.15)], [home(side, cx), dur(0.45)]]);
        muts.push({ t: tl + dur(0.6), fn: (ps) => { const p = at(ps, cx, cy); if (p) parkCaptured(ps, p.id); } });
        done = handFree[side];
      }
    }
    if (opt.offCenter) {
      const [tx, ty] = sq(m.to);
      muts.push({ t: done - dur(0.4), fn: (ps) => { const p = at(ps, tx, ty, 0.5); if (p) { p.x = tx + opt.offCenter[0]; p.y = ty + opt.offCenter[1]; } } });
    }
    let pause = think[0] + rand() * (think[1] - think[0]);
    if (opt.burst) pause = -opt.burst; // the reply starts before this hand has left
    if (opt.pause !== undefined) pause = opt.pause;
    t = done + pause;
    truth.push({ san: m.san, done });
    for (const it of idle.filter((i) => i.afterPly === ply)) t = idleAction(it, t);
  });

  function idleAction(it, t0) {
    const side = it.side || 'w';
    const [x, y] = it.square ? sq(it.square) : [3.5, 2.5];
    if (it.kind === 'hover') {
      return handPath(side, t0, [[[x, y, HOVER + 0.2], dur(0.5)], [[x + 0.3, y + 0.2, HOVER], it.duration || 2], [home(side, x), dur(0.5)]]) + 1.5;
    }
    if (it.kind === 'adjust') {
      const tEnd = handPath(side, t0, [[[x, y, HOVER], dur(0.5)], [[x, y, GRAB], dur(0.2)], [[x, y, GRAB], 0.6], [home(side, x), dur(0.5)]]);
      muts.push({ t: t0 + dur(0.9), fn: (ps) => { const p = at(ps, x, y, 0.5); if (p) { p.x = x + (it.dx ?? 0.06); p.y = y + (it.dy ?? -0.05); } } });
      return tEnd + 1.5;
    }
    if (it.kind === 'knock') {
      // A piece gets knocked over, sits there a few seconds, is stood up.
      const t1 = handPath(side, t0, [[[x, y, HOVER], dur(0.5)], [[x + 0.2, y, GRAB], dur(0.3)], [home(side, x), dur(0.5)]]);
      muts.push({ t: t0 + dur(0.8), fn: (ps) => { const p = at(ps, x, y, 0.5); if (p) p.tipped = true; } });
      const t2 = t1 + (it.duration || 4);
      const t3 = handPath(side, t2, [[[x, y, HOVER], dur(0.5)], [[x, y, GRAB], dur(0.4)], [home(side, x), dur(0.5)]]);
      muts.push({ t: t2 + dur(0.9), fn: (ps) => { const p = ps.find((q) => q.tipped); if (p) { p.tipped = false; p.x = x; p.y = y; } } });
      return t3 + 1.5;
    }
    if (it.kind === 'arm') {
      // An arm resting on the edge of the board while play goes on.
      const kf = hands[side + 'Rest'] || (hands[side + 'Rest'] = []);
      kf.push({ t: t0, pos: null }, { t: t0 + 0.4, pos: [x, y, 0.25] }, { t: t0 + it.duration, pos: [x, y, 0.25] }, { t: t0 + it.duration + 0.4, pos: null });
      return t0 + 1.5;
    }
    return t0;
  }

  muts.sort((a, b) => a.t - b.t);
  const lastKey = Math.max(0, ...Object.values(hands).flat().map((k) => k.t));
  const duration = Math.max(t, handFree.w, handFree.b, lastKey) + tail;

  function stateAt(time) {
    const pieces = initial.map((p) => ({ ...p }));
    for (const mu of muts) {
      if (mu.t > time) break;
      mu.fn(pieces);
    }
    const handsNow = [];
    for (const [key, kf] of Object.entries(hands)) {
      const pos = handAt(kf, time);
      if (pos) handsNow.push({ x: pos[0], y: pos[1], z: pos[2], side: key[0] });
    }
    for (const p of pieces) {
      if (!p.held) continue;
      const h = handsNow.find((hh) => hh.side === p.held);
      if (h) {
        p.x = h.x;
        p.y = h.y;
        p.z = Math.max(0, h.z - LIFT);
      }
    }
    return { pieces, hands: handsNow };
  }

  return { duration, stateAt, truth, fen: chess.fen() };
}

export function piecesFromFen(fen) {
  return piecesFromChess(new Chess(fen));
}

function piecesFromChess(chess) {
  const out = [];
  const board = chess.board();
  let id = 0;
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const p = board[r][f];
      if (p) out.push({ id: id++, code: p.color + p.type.toUpperCase(), x: f + 0.5, y: 7 - r + 0.5, z: 0, held: null });
    }
  }
  return out;
}

function at(pieces, x, y, tol = 0.45) {
  return pieces.find((p) => !p.held && Math.abs(p.x - x) < tol && Math.abs(p.y - y) < tol && (p.z || 0) === 0);
}

function handAt(kf, t) {
  if (!kf.length || t < kf[0].t) return null;
  for (let i = kf.length - 1; i >= 0; i--) {
    if (kf[i].t <= t) {
      const a = kf[i];
      const b = kf[i + 1];
      if (!a.pos) return null;
      if (!b || !b.pos) return a.pos;
      const s = (t - a.t) / (b.t - a.t);
      return a.pos.map((v, j) => v + (b.pos[j] - v) * s);
    }
  }
  return null;
}
