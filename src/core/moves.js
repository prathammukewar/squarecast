// Candidate explanations for what happened on the board.
//
// We never recognize piece types. The game starts from a known position
// and every later position follows from legal moves, so the only question
// is which legal move (or, rarely, which pair of moves, or a takeback)
// turns the recorded position into what the camera sees.

import { Chess } from '../vendor/chess.js';
import { squareIndex, occupancyOf, piecesOf } from './squares.js';

// Squares a move touches, by move type.
//   quiet move or capture: from, to
//   en passant: from, to, and the square of the captured pawn
//   castling: king from, king to, rook from, rook to
//   promotion: from, to (the new piece type is invisible to us)
export function affectedSquares(move) {
  const from = squareIndex(move.from);
  const to = squareIndex(move.to);
  if (move.flags.includes('e')) {
    // The captured pawn sits beside the moving pawn: same rank as "from",
    // same file as "to".
    return [from, to, (from & ~7) | (to & 7)];
  }
  if (move.flags.includes('k') || move.flags.includes('q')) {
    const rank = from & ~7;
    const kingside = move.flags.includes('k');
    return [from, to, rank + (kingside ? 7 : 0), rank + (kingside ? 5 : 3)];
  }
  return [from, to];
}

// What we expect each square to do if a candidate is right:
export const SAME = 0; // still holds the same piece (or nothing)
export const CHANGED = 1; // went from empty/light/dark to something else
export const UNKNOWN = 2; // same color, different piece: may or may not look different

export function expectedStates(beforeOcc, beforePieces, afterOcc, afterPieces) {
  const states = new Uint8Array(64);
  for (let sq = 0; sq < 64; sq++) {
    if (beforeOcc[sq] !== afterOcc[sq]) states[sq] = CHANGED;
    else if (beforePieces[sq] !== afterPieces[sq]) states[sq] = UNKNOWN;
  }
  return states;
}

// Piece codes after a move, worked out directly from the move rather
// than by playing it in chess.js (which regenerates every legal move on
// each call and makes the two-move search slow).
export function applyMove(pieces, move) {
  const out = pieces.slice();
  const from = squareIndex(move.from);
  const to = squareIndex(move.to);
  const piece = out[from];
  out[from] = '';
  if (move.flags.includes('e')) out[(from & ~7) | (to & 7)] = '';
  if (move.flags.includes('k') || move.flags.includes('q')) {
    const rank = from & ~7;
    const kingside = move.flags.includes('k');
    out[rank + (kingside ? 7 : 0)] = '';
    out[rank + (kingside ? 5 : 3)] = piece[0] + 'R';
  }
  out[to] = move.promotion ? piece[0] + move.promotion.toUpperCase() : piece;
  return out;
}

function occupancyFromPieces(pieces) {
  const occ = new Uint8Array(64);
  for (let sq = 0; sq < 64; sq++) if (pieces[sq]) occ[sq] = pieces[sq][0] === 'w' ? 1 : 2;
  return occ;
}

function candidate(kind, moves, afterPieces, before) {
  const afterOcc = occupancyFromPieces(afterPieces);
  return {
    kind,
    moves, // verbose chess.js moves, in order
    san: moves.map((m) => m.san),
    afterOcc,
    states: expectedStates(before.occ, before.pieces, afterOcc, afterPieces),
  };
}

function snapshotPosition(chess) {
  return { occ: occupancyOf(chess), pieces: piecesOf(chess) };
}

// Promotions to different pieces look the same to the camera. Keep only
// the queen promotion; the user can change it afterward.
function distinctMoves(chess) {
  return chess.moves({ verbose: true }).filter((m) => !m.promotion || m.promotion === 'q');
}

// Every legal move from the current position.
export function singleMoves(chess) {
  const before = snapshotPosition(chess);
  return distinctMoves(chess).map((m) => candidate('move', [m], applyMove(before.pieces, m), before));
}

// Every legal move followed by every legal reply. Used when both players
// moved before the board was still (blitz). About a thousand pairs.
export function movePairs(chess) {
  const before = snapshotPosition(chess);
  const out = [];
  for (const m1 of distinctMoves(chess)) {
    const mid = applyMove(before.pieces, m1);
    chess.move(m1);
    for (const m2 of distinctMoves(chess)) out.push(candidate('pair', [m1, m2], applyMove(mid, m2), before));
    chess.undo();
  }
  return out;
}

// The board went back to the position before the last move.
export function takeback(chess) {
  const history = chess.history({ verbose: true });
  if (!history.length) return null;
  const before = snapshotPosition(chess);
  const last = chess.undo();
  const c = candidate('takeback', [last], piecesOf(chess), before);
  chess.move(last);
  return c;
}

// The side that just moved seems to have moved again: usually a
// correction of the last move rather than a new one.
export function replacements(chess) {
  const history = chess.history({ verbose: true });
  if (!history.length) return [];
  const before = snapshotPosition(chess);
  const last = chess.undo();
  const prev = piecesOf(chess);
  const out = [];
  for (const m of distinctMoves(chess)) {
    if (m.from === last.from && m.to === last.to) continue;
    out.push(candidate('replace', [m], applyMove(prev, m), before));
  }
  chess.move(last);
  return out;
}

export function newGame(fen) {
  return fen ? new Chess(fen) : new Chess();
}
