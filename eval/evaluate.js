// Runs the real pipeline over a stream of frames and compares what it
// records with the true game. It plays the part of the person holding
// the phone: answers questions with the right move when it's offered,
// taps the promotion chip when the piece was not a queen, and fixes the
// record by hand when the app gets stuck or wrong.

import { Pipeline } from '../src/core/pipeline.js';
import { Chess } from '../src/vendor/chess.js';

export async function evaluate({ frames, corners, width, height, truth, fen, options = {}, verbose = false }) {
  const pipe = new Pipeline({ corners, width, height, fen, ...options });
  const op = createOperator({ tracker: pipe.tracker, truth, fen, verbose });
  let frameCount = 0;
  const started = Date.now();
  for await (const { frame, t } of frames) {
    op.handle(pipe.processFrame(frame, t), t);
    frameCount++;
  }
  const m = op.finish();
  m.frames = frameCount;
  m.seconds = (Date.now() - started) / 1000;
  return m;
}

// The person holding the phone, played from the true game record. Feed it
// every event the tracker emits.
export function createOperator({ tracker, truth, fen, verbose = false }) {
  const truthMoves = movesOf(truth.map((x) => x.san ?? x), fen);
  const doneTimes = truth.every((x) => x.done != null) ? truth.map((x) => x.done) : null;
  const m = {
    moves: truthMoves.length,
    auto: 0, // recorded with no help
    tapped: 0, // recorded after one tap on a question
    manual: 0, // the operator had to enter the move
    wrong: 0, // recorded a move that wasn't played: must stay 0
    chipTaps: 0, // promotion piece changed from the default queen
    prompts: 0,
    badPrompts: 0, // questions that didn't offer the right move
    mismatches: 0,
    latencies: [],
    calibrationMisses: null,
    wrongDetails: [],
    log: [],
  };
  let ply = 0;

  const note = (t, text) => {
    m.log.push(`${(t / 1000).toFixed(1)}s ${text}`);
    if (verbose) console.log(`  ${(t / 1000).toFixed(1)}s ${text}`);
  };

  // The operator looks at the board and enters every move that has been
  // played but not recorded. When we know when each move was finished we
  // enter all of them; otherwise one at a time, and the app checks the
  // board again.
  const fixByHand = (t) => {
    if (ply >= truthMoves.length) return;
    let upTo = ply + 1;
    if (doneTimes) {
      while (upTo < truthMoves.length && doneTimes[upTo] != null && doneTimes[upTo] * 1000 <= t) upTo++;
      if (doneTimes[ply] * 1000 > t) return;
    }
    for (; ply < upTo; ply++) {
      tracker.play(truthMoves[ply].san, t);
      note(t, `operator enters ${truthMoves[ply].san}`);
      m.manual++;
    }
  };

  const handle = (events, t) => {
    for (const e of events) {
      if (e.type === 'calibrated') {
        m.calibrationMisses = e.mismatched.length;
        note(t, `calibrated, ${e.mismatched.length} squares disagree`);
      } else if (e.type === 'commit' && e.how !== 'manual') {
        const got = e.uci;
        const want = truthMoves.slice(ply, ply + got.length);
        const sameSquares = got.every((u, i) => want[i] && u.slice(0, 4) === want[i].uci.slice(0, 4));
        if (!sameSquares) {
          m.wrong++;
          m.wrongDetails.push({ t, got: e.san, want: want.map((w) => w.san) });
          note(t, `WRONG: recorded ${e.san.join(' ')}, played ${want.map((w) => w.san).join(' ')}`);
          for (let i = 0; i < got.length; i++) tracker.undo(t);
          for (const w of want) tracker.play(w.san, t);
          ply += want.length;
          continue;
        }
        for (let i = 0; i < got.length; i++) {
          if (got[i] !== want[i].uci) {
            // Promotion to something other than a queen: tap the chip.
            handle(tracker.setPromotion(want[i].uci[4], t), t);
            m.chipTaps++;
            note(t, `chip: ${want[i].san}`);
          }
        }
        ply += got.length;
        if (e.how === 'auto') {
          m.auto += got.length;
          if (e.latency != null) m.latencies.push(e.latency);
        } else {
          m.tapped += got.length;
        }
        note(t, `${e.how} ${e.san.join(' ')}${e.latency != null ? ` (${Math.round(e.latency)} ms)` : ''}`);
      } else if (e.type === 'ask') {
        m.prompts++;
        const want = truthMoves.slice(ply, ply + 2);
        const index = e.options.findIndex((o) =>
          (o.kind === 'move' && want[0] && sameMove(o.san[0], want[0])) ||
          (o.kind === 'pair' && want.length === 2 && sameMove(o.san[0], want[0]) && sameMove(o.san[1], want[1])));
        note(t, `ask (${e.reason}): ${e.options.map((o) => o.kind + ' ' + o.san.join(' ')).join(' | ')}`);
        if (index >= 0) {
          handle(tracker.answer(e.id, index, t), t);
        } else {
          m.badPrompts++;
          handle(tracker.answer(e.id, null, t), t);
          fixByHand(t);
        }
      } else if (e.type === 'mismatch') {
        m.mismatches++;
        note(t, `board doesn't match the record (${e.squares.length} squares)`);
        fixByHand(t);
      } else if (e.type === 'gameover') {
        note(t, `game over: ${e.result} (${e.reason})`);
      }
    }
  };

  const finish = () => {
    m.missed = truthMoves.length - ply;
    m.pgn = tracker.chess.pgn();
    return m;
  };

  return { handle, finish, metrics: m, get ply() { return ply; } };
}

export function summarize(m) {
  const lat = [...m.latencies].sort((a, b) => a - b);
  const q = (p) => (lat.length ? Math.round(lat[Math.min(lat.length - 1, Math.floor(p * lat.length))]) : null);
  return {
    moves: m.moves,
    autoRate: m.moves ? m.auto / m.moves : 0,
    auto: m.auto,
    tapped: m.tapped,
    manual: m.manual,
    missed: m.missed,
    wrong: m.wrong,
    prompts: m.prompts,
    badPrompts: m.badPrompts,
    chipTaps: m.chipTaps,
    mismatches: m.mismatches,
    latencyMedian: q(0.5),
    latencyP95: q(0.95),
    calibrationMisses: m.calibrationMisses,
  };
}

function movesOf(sans, fen) {
  const c = fen ? new Chess(fen) : new Chess();
  return sans.map((s) => {
    const mv = c.move(s);
    return { san: mv.san, uci: mv.from + mv.to + (mv.promotion || '') };
  });
}

// Same move apart from the promotion piece, which the camera can't see.
function sameMove(san, want) {
  const strip = (s) => s.replace(/=[QRBN]/, '').replace(/[+#]/g, '');
  return strip(san) === strip(want.san);
}
