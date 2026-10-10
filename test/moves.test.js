import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from '../src/vendor/chess.js';
import { affectedSquares, singleMoves, movePairs, takeback, replacements, CHANGED, SAME, UNKNOWN } from '../src/core/moves.js';
import { squareName, piecesOf } from '../src/core/squares.js';

const names = (squares) => squares.map(squareName).sort();

function moveIn(fen, san) {
  const c = new Chess(fen);
  return c.moves({ verbose: true }).find((m) => m.san === san);
}

test('quiet move touches from and to', () => {
  assert.deepEqual(names(affectedSquares(moveIn(undefined, 'Nf3'))), ['f3', 'g1']);
});

test('capture touches from and to', () => {
  const m = moveIn('rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2', 'exd5');
  assert.deepEqual(names(affectedSquares(m)), ['d5', 'e4']);
});

test('en passant touches the captured pawn square too', () => {
  const white = moveIn('rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3', 'exf6');
  assert.deepEqual(names(affectedSquares(white)), ['e5', 'f5', 'f6']);
  const black = moveIn('rnbqkbnr/pp1ppppp/8/8/1Pp5/2P5/P2PPPPP/RNBQKBNR b KQkq b3 0 3', 'cxb3');
  assert.deepEqual(names(affectedSquares(black)), ['b3', 'b4', 'c4']);
});

test('castling touches king and rook squares on both sides', () => {
  const fen = 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1';
  assert.deepEqual(names(affectedSquares(moveIn(fen, 'O-O'))), ['e1', 'f1', 'g1', 'h1']);
  assert.deepEqual(names(affectedSquares(moveIn(fen, 'O-O-O'))), ['a1', 'c1', 'd1', 'e1']);
  const b = fen.replace(' w ', ' b ');
  assert.deepEqual(names(affectedSquares(moveIn(b, 'O-O'))), ['e8', 'f8', 'g8', 'h8']);
  assert.deepEqual(names(affectedSquares(moveIn(b, 'O-O-O'))), ['a8', 'c8', 'd8', 'e8']);
});

test('promotion touches from and to, with or without capture', () => {
  const fen = '1n2k3/P7/8/8/8/8/8/4K3 w - - 0 1';
  assert.deepEqual(names(affectedSquares(moveIn(fen, 'a8=Q'))), ['a7', 'a8']);
  assert.deepEqual(names(affectedSquares(moveIn(fen, 'axb8=N'))), ['a7', 'b8']);
});

test('affected squares match the board difference for every legal move of a busy position', () => {
  const fens = [
    'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
    'r3k2r/p1ppqpb1/bn2pnp1/3PN3/Pp2P3/2N2Q1p/1PPBBPPP/R3K2R b KQkq a3 0 1',
    'n1n5/PPPk4/8/8/8/8/4Kppp/5N1N b - - 0 1',
  ];
  for (const fen of fens) {
    const c = new Chess(fen);
    for (const m of c.moves({ verbose: true })) {
      const before = piecesOf(c);
      c.move(m);
      const after = piecesOf(c);
      c.undo();
      const diff = [];
      for (let sq = 0; sq < 64; sq++) if (before[sq] !== after[sq]) diff.push(sq);
      assert.deepEqual(names(affectedSquares(m)), names(diff), `${fen} ${m.san}`);
    }
  }
});

test('promotions to different pieces count as one candidate', () => {
  const c = new Chess('1n2k3/P7/8/8/8/8/8/4K3 w - - 0 1');
  const sans = singleMoves(c).map((x) => x.san[0].replace(/[+#]/, ''));
  assert.ok(sans.includes('a8=Q') && sans.includes('axb8=Q'));
  assert.ok(!sans.some((s) => /=[RBN]/.test(s)));
});

test('expected states: from and to change, everything else stays', () => {
  const c = new Chess();
  const e4 = singleMoves(c).find((x) => x.san[0] === 'e4');
  assert.equal(e4.states[12], CHANGED); // e2
  assert.equal(e4.states[28], CHANGED); // e4
  assert.equal(e4.states.filter((s) => s !== SAME).length, 2);
});

test('a recapture by a different piece is unknown, the same piece type is same', () => {
  const c = new Chess('rnbqkbnr/ppp1pppp/8/3p4/8/2N5/PPPPPPPP/R1BQKBNR w KQkq - 0 2');
  const pair = movePairs(c).find((x) => x.san.join(' ') === 'Nxd5 Qxd5');
  assert.equal(pair.states[35], UNKNOWN); // d5: black pawn, then a black queen
  assert.equal(pair.states[18], CHANGED); // c3 emptied
  assert.equal(pair.states[59], CHANGED); // d8 emptied
  const pawns = new Chess('rnbqkbnr/ppp2ppp/4p3/3p4/3PP3/8/PPP2PPP/RNBQKBNR w KQkq - 0 3');
  const ex = movePairs(pawns).find((x) => x.san.join(' ') === 'exd5 exd5');
  assert.equal(ex.states[35], SAME); // a black pawn again
});

test('move pairs from the start position', () => {
  assert.equal(movePairs(new Chess()).length, 400);
});

test('takeback and replacement candidates', () => {
  const c = new Chess();
  c.move('e4');
  const tb = takeback(c);
  assert.equal(tb.kind, 'takeback');
  assert.equal(tb.states[12], CHANGED);
  assert.equal(tb.states[28], CHANGED);
  const reps = replacements(c);
  assert.equal(reps.length, 19);
  assert.ok(reps.every((r) => r.kind === 'replace'));
  assert.ok(reps.some((r) => r.san[0] === 'd4'));
  assert.equal(c.history().join(' '), 'e4', 'position is restored');
});
