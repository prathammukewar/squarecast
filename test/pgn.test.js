import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatPgn, pgnDate } from '../src/core/pgn.js';
import { Chess } from '../src/vendor/chess.js';

test('headers come in roster order, then extras, then the moves and result', () => {
  const pgn = formatPgn({
    headers: { White: 'Ana Ruiz', Black: 'Sam Lee', Event: 'Club Night', Round: '3', Board: '7', TimeControl: '1800+30', WhiteElo: '1450' },
    moves: ['e4', 'e5', 'Nf3'],
    result: '1-0',
  });
  const lines = pgn.split('\n');
  assert.deepEqual(lines.slice(0, 7), [
    '[Event "Club Night"]',
    '[Site "?"]',
    '[Date "????.??.??"]',
    '[Round "3"]',
    '[White "Ana Ruiz"]',
    '[Black "Sam Lee"]',
    '[Result "1-0"]',
  ]);
  assert.ok(pgn.includes('[Board "7"]'));
  assert.ok(pgn.trimEnd().endsWith('1. e4 e5 2. Nf3 1-0'));
});

test('quotes and backslashes in names are escaped', () => {
  const pgn = formatPgn({ headers: { White: 'O"Neil \\ Jr' } });
  assert.ok(pgn.includes('[White "O\\"Neil \\\\ Jr"]'));
});

test('long games wrap without gluing tokens together', () => {
  const c = new Chess();
  c.loadPgn(readFileSync(new URL('../footage/torture-game.pgn', import.meta.url), 'utf8'));
  const pgn = formatPgn({ moves: c.history(), result: '0-1' });
  for (const line of pgn.split('\n')) assert.ok(line.length <= 80, line);
  const back = new Chess();
  back.loadPgn(pgn);
  assert.equal(back.history().length, 84);
});

test('a game from a FEN with Black to move starts with "1..."', () => {
  const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
  const pgn = formatPgn({ moves: ['e5', 'Nf3'], startPly: 1, fen });
  assert.ok(pgn.includes('[SetUp "1"]'));
  assert.ok(pgn.includes(`[FEN "${fen}"]`));
  assert.ok(pgn.includes('1... e5 2. Nf3 *'));
});

test('unknown results are rejected', () => {
  assert.throws(() => formatPgn({ result: '2-0' }));
});

test('date format', () => {
  assert.equal(pgnDate(new Date(2026, 9, 9)), '2026.10.09');
});
