// Square indexing shared by every module.
// Index 0 is a1, 7 is h1, 56 is a8, 63 is h8: index = rank * 8 + file.

export const FILES = 'abcdefgh';

export function squareName(i) {
  return FILES[i & 7] + ((i >> 3) + 1);
}

export function squareIndex(name) {
  return (name.charCodeAt(1) - 49) * 8 + (name.charCodeAt(0) - 97);
}

export function fileOf(i) { return i & 7; }
export function rankOf(i) { return i >> 3; }

// a1 is a dark square.
export function isLight(i) {
  return ((i & 7) + (i >> 3)) % 2 === 1;
}

export const ALL_SQUARES = Array.from({ length: 64 }, (_, i) => i);

// Occupancy codes used by the classifier and the move scorer.
export const EMPTY = 0;
export const WHITE = 1;
export const BLACK = 2;

// Occupancy of every square for a chess.js position.
export function occupancyOf(chess) {
  const occ = new Uint8Array(64);
  const board = chess.board(); // board[0] is rank 8
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const p = board[r][f];
      if (p) occ[(7 - r) * 8 + f] = p.color === 'w' ? WHITE : BLACK;
    }
  }
  return occ;
}

// Piece code ("wP", "bN", ...) of every square, or "" when empty.
export function piecesOf(chess) {
  const out = new Array(64).fill('');
  const board = chess.board();
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const p = board[r][f];
      if (p) out[(7 - r) * 8 + f] = p.color + p.type.toUpperCase();
    }
  }
  return out;
}
