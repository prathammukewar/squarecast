# Squarecast

Squarecast turns a phone on a stand into an electronic chessboard. It watches an ordinary board, records each move, and (soon) sends the game live to a Lichess broadcast, so small club and scholastic events can be followed online without buying electronic boards.

It runs in the browser. Video never leaves the phone.

This is early work. The move recognition and its test harness are here; the app itself comes next.

## How it recognizes moves

It never tries to tell a knight from a bishop. The game starts from a known position and every later position follows from a legal move, so the only question is which legal move explains what changed on the board.

1. **Calibrate from the starting position.** Ranks 3 to 6 are empty squares, ranks 1 and 2 hold light pieces, ranks 7 and 8 dark ones. That gives live examples of empty, light and dark squares on this particular board, under this particular light, so it works with any set.
2. **Wait for stillness.** While a hand is over the board nothing is decided. When the board has been still for 0.6 s, the still frames are averaged into one picture.
3. **Score every legal move.** Compare that picture with the one taken when the last move was recorded, square by square, after removing lighting changes. Each legal move predicts which squares changed (two for most moves, three for en passant, four for castling) and what is on them now. The best explanation wins.
4. **Record, ask or wait.** If one move clearly beats the rest, it is recorded. If two or three are close, the app shows them and a person taps one. If the board is part way through something (a captured piece lifted before the capturing piece lands, a king moved before its rook), it waits. It never guesses.

The same scoring handles two moves made before the board was still (blitz), takebacks, and a player correcting their own move.

## Code

- `src/core/` the recognition pipeline, plain ES modules with no DOM, so it runs in a browser worker and in Node.
- `src/vendor/chess.js` chess rules ([chess.js](https://github.com/jhlywa/chess.js), BSD-2-Clause).
- `eval/` the evaluation harness: runs the pipeline over recorded video and compares the result with the real game.
- `eval/synth/` a small renderer for synthetic board footage (angled cameras, hands, shadows, noise), used for regression tests.
- `test/` unit tests.

## Running the tests

Node 20 or later, no dependencies:

```
npm test
node eval/synth/run.js            # synthetic games, with a results table
node eval/run.js footage/*.mp4    # recorded games (needs ffmpeg)
```

## License

MIT
