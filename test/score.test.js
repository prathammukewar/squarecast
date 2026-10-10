// Move scoring with made-up change and occupancy evidence, no pixels.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from '../src/vendor/chess.js';
import { singleMoves, movePairs, takeback } from '../src/core/moves.js';
import { rank } from '../src/core/score.js';
import { squareIndex, occupancyOf, EMPTY, WHITE, BLACK } from '../src/core/squares.js';

// Evidence where `changed` squares changed strongly, `occluded` are
// hidden, everything else is still. Occupancy follows `board` (a FEN) if
// given, otherwise it carries no information.
function evidence(chess, changed, { occluded = [], board = null } = {}) {
  const llr = new Float32Array(64).fill(-5);
  for (const s of changed) llr[squareIndex(s)] = 7;
  const occ = new Float32Array(192);
  if (board) {
    const o = occupancyOf(new Chess(board));
    for (let sq = 0; sq < 64; sq++) {
      for (let c = 0; c < 3; c++) occ[sq * 3 + c] = c === o[sq] ? 0 : -6;
    }
  }
  const hidden = new Uint8Array(64);
  for (const s of occluded) {
    hidden[squareIndex(s)] = 1;
    llr[squareIndex(s)] = 0;
  }
  return { llr, occluded: hidden, occ, beforeOcc: occupancyOf(chess) };
}

test('a clean move wins by a wide margin and fits', () => {
  const c = new Chess();
  const r = rank(singleMoves(c), evidence(c, ['e2', 'e4']));
  assert.equal(r[0].cand.san[0], 'e4');
  assert.ok(r[0].fits);
  assert.ok(r[0].score - r[1].score > 10);
});

test('two knights that can reach the same square are told apart by the empty square', () => {
  const c = new Chess('4k3/8/8/8/8/2N3N1/8/4K3 w - - 0 1');
  const r = rank(singleMoves(c), evidence(c, ['g3', 'e4']));
  assert.equal(r[0].cand.san[0], 'Nge4');
  assert.ok(r[0].fits);
  assert.ok(r[1].missing.length > 0);
});

test('a captured piece lifted before the capturing piece lands fits nothing', () => {
  const c = new Chess('rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2');
  const r = rank(singleMoves(c), evidence(c, ['d5']));
  assert.ok(r.every((x) => !x.fits));
});

test('castling with only the king moved is incomplete', () => {
  const c = new Chess('r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1');
  const r = rank(singleMoves(c), evidence(c, ['e1', 'g1']));
  const castle = r.find((x) => x.cand.san[0] === 'O-O');
  assert.ok(!castle.fits);
  assert.deepEqual(castle.missing.sort(), [squareIndex('f1'), squareIndex('h1')].sort());
  assert.ok(r.every((x) => !x.fits));
});

test('en passant needs the captured pawn gone', () => {
  const c = new Chess('rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3');
  const late = rank(singleMoves(c), evidence(c, ['e5', 'f6']));
  assert.ok(late.every((x) => !x.fits));
  const done = rank(singleMoves(c), evidence(c, ['e5', 'f6', 'f5']));
  assert.equal(done[0].cand.san[0], 'exf6');
  assert.ok(done[0].fits);
});

test('a move whose square is covered by an arm is never a clean fit', () => {
  const c = new Chess();
  const r = rank(singleMoves(c), evidence(c, ['g1'], { occluded: ['f3'] }));
  const nf3 = r.find((x) => x.cand.san[0] === 'Nf3');
  assert.ok(!nf3.fits);
  assert.ok(nf3.optimistic > nf3.score);
});

test('an arm away from the move does not block it', () => {
  const c = new Chess();
  const r = rank(singleMoves(c), evidence(c, ['e2', 'e4'], { occluded: ['a2', 'a3', 'b2'] }));
  assert.equal(r[0].cand.san[0], 'e4');
  assert.ok(r[0].fits);
});

test('occupancy breaks a tie that change alone cannot', () => {
  // White rooks on b3 and f1, both can go to b1. Changes on b1, b3 and f1:
  // one rook moved and the other was nudged. Occupancy says b3 still holds
  // a piece, so the f1 rook moved.
  const c = new Chess('4k3/8/8/8/8/1R6/7K/5R2 w - - 0 1');
  const after = '4k3/8/8/8/8/1R6/7K/1R6 b - - 0 1';
  const r = rank(singleMoves(c), evidence(c, ['b1', 'b3', 'f1'], { board: after }));
  assert.equal(r[0].cand.san[0], 'Rfb1');
});

test('two quick moves are found as a pair', () => {
  const c = new Chess();
  const ev = evidence(c, ['g1', 'f3', 'b8', 'c6']);
  assert.ok(rank(singleMoves(c), ev).every((x) => !x.fits));
  const pairs = rank(movePairs(c), ev);
  assert.deepEqual(pairs[0].cand.san, ['Nf3', 'Nc6']);
  assert.ok(pairs[0].fits);
});

test('a takeback is recognized', () => {
  const c = new Chess();
  c.move('e4');
  const r = rank([takeback(c), ...singleMoves(c)], evidence(c, ['e2', 'e4']));
  assert.equal(r[0].cand.kind, 'takeback');
  assert.ok(r[0].fits);
});

test('occupancy constants', () => {
  assert.deepEqual([EMPTY, WHITE, BLACK], [0, 1, 2]);
});
