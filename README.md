# Squarecast

Squarecast turns a phone on a stand into an electronic chessboard. It watches an ordinary board, records each move, and (soon) sends the game live to a Lichess broadcast, so small club and scholastic events can be followed online without buying electronic boards.

It runs in the browser. Video never leaves the phone.

Open it at **https://prathammukewar.github.io/squarecast/** on a phone. There is a demo board if you want to see it work without a chessboard. This is early work: recording, corrections and export work; Lichess broadcasting comes next.

## Using it

1. Put the phone on a stand above the board, or above White's side looking down, and plug it in for long games.
2. Tap **Record a game**, then mark the four corners of the squares. It guesses which side White sits on from the starting position, and checks all 64 squares before you start.
3. Play. The status line says when it is watching, when a hand is over the board, and when it needs you. If two moves look alike it shows both and you tap one. A promotion is recorded as a queen with a button to change it.
4. At the end, pick the result and copy, download or share the PGN, or open it on Lichess for analysis. Every game is kept in **Games** on the phone.

**Test recording** (in Settings, off by default) also saves the camera video on the phone with each game. Share the video and its .json file to a computer and `node eval/run.js game.mp4` replays it through the recognition code and scores it against the recorded game.

## How it recognizes moves

It never tries to tell a knight from a bishop. The game starts from a known position and every later position follows from a legal move, so the only question is which legal move explains what changed on the board.

1. **Calibrate from the starting position.** Ranks 3 to 6 are empty squares, ranks 1 and 2 hold light pieces, ranks 7 and 8 dark ones. That gives live examples of empty, light and dark squares on this particular board, under this particular light, so it works with any set.
2. **Wait for stillness.** While a hand is over the board nothing is decided. When the board has been still for 0.6 s, the still frames are averaged into one picture.
3. **Score every legal move.** Compare that picture with the one taken when the last move was recorded, square by square, after removing lighting changes. Each legal move predicts which squares changed (two for most moves, three for en passant, four for castling) and what is on them now. The best explanation wins.
4. **Record, ask or wait.** If one move clearly beats the rest, it is recorded. If two or three are close, the app shows them and a person taps one. If the board is part way through something (a captured piece lifted before the capturing piece lands, a king moved before its rook), it waits. It never guesses.

The same scoring handles two moves made before the board was still (blitz), takebacks, and a player correcting their own move.

## Code

- `index.html`, `app/` the app: setup, live recording, corrections, export and the game library. Recognition runs in a Web Worker (`app/worker.js`). No build step.
- `src/core/` the recognition pipeline, plain ES modules with no DOM, so it runs in the worker and in Node.
- `src/demo/` a small renderer for synthetic board footage (angled cameras, hands, shadows, noise). The app's demo board uses it, and so do the tests.
- `src/vendor/chess.js` chess rules ([chess.js](https://github.com/jhlywa/chess.js), BSD-2-Clause).
- `eval/` the evaluation harness: runs the pipeline over recorded video, or over synthetic games, and compares the result with the real game.
- `test/` unit tests.

## Running the tests

Node 20 or later, no dependencies. To try the app locally, serve the folder (for example `python3 -m http.server`) and open it in a browser.

```
npm test
node eval/synth/run.js            # synthetic games, with a results table
node eval/run.js footage/*.mp4    # recorded games (needs ffmpeg)
```

## License

MIT
