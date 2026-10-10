// Named synthetic recordings. Each is a game plus a camera and the
// awkward things that happen during it, so the eval reports read like the
// real footage list.

import { readFileSync } from 'node:fs';
import { Chess } from '../../src/vendor/chess.js';

const pgnMoves = (path) => {
  const c = new Chess();
  c.loadPgn(readFileSync(new URL(path, import.meta.url), 'utf8'));
  return c.history();
};

const SHORT = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7', 'Re1', 'b5', 'Bb3', 'd6', 'c3', 'O-O'];

export const SCENARIOS = {
  'ruy-overhead': {
    moves: SHORT,
    scene: { tilt: 0, board: 'vinyl-green', seed: 1 },
  },
  'ruy-side-45': {
    moves: SHORT,
    scene: { tilt: 45, distance: 11, board: 'vinyl-brown', seed: 2 },
  },
  'ruy-wood-dim': {
    moves: SHORT,
    scene: { tilt: 20, board: 'wood', pieces: 'wood', light: { gain: 0.65, gradient: 0.35 }, noise: 5, seed: 3 },
  },
  torture: {
    moves: () => pgnMoves('../../footage/torture-game.pgn'),
    scene: { tilt: 0, board: 'vinyl-green', seed: 4 },
    script: {
      plies: {
        17: { lateEnPassant: 3 }, // 9...cxb3 e.p., pawn taken off late
        21: { removeFirst: 3 }, // 11...Qxb3, captured queen lifted first
        23: { kingFirst: 3 }, // 12...O-O-O king first, pause, then rook
        28: { lateEnPassant: 3 }, // 15. exf6 e.p.
        32: { offCenter: [0.22, 0.16] }, // 17. Bxg6 left off center
      },
      idle: [{ afterPly: 35, kind: 'adjust', square: 'b3' }, { afterPly: 35, kind: 'hover', square: 'e4', duration: 3 }],
    },
  },
  'checkmate': {
    moves: () => pgnMoves('../../footage/checkmate-game.pgn'),
    scene: { tilt: 10, board: 'vinyl-brown', seed: 5 },
  },
  'blitz-bursts': {
    moves: SHORT,
    scene: { tilt: 0, board: 'vinyl-green', seed: 6 },
    script: { think: [0.7, 1.2], speed: 1.6, plies: { 2: { burst: 0.5 }, 6: { burst: 0.4 }, 10: { burst: 0.5 } } },
  },
  'hands-no-moves': {
    moves: [],
    scene: { tilt: 0, board: 'vinyl-green', seed: 7 },
    script: {
      idle: [
        { afterPly: -1, kind: 'hover', square: 'd4', duration: 4 },
        { afterPly: -1, kind: 'adjust', square: 'e2' },
        { afterPly: -1, kind: 'adjust', square: 'g8', side: 'b', dx: -0.05, dy: 0.06 },
        { afterPly: -1, kind: 'arm', square: 'a3', duration: 20 },
      ],
    },
  },
  'lamp-shadows': {
    moves: SHORT,
    scene: { tilt: 15, board: 'vinyl-brown', light: { gain: 0.8, gradient: 0.4, warmth: 0.08 }, noise: 4, seed: 8 },
    shadows: true,
  },
};
