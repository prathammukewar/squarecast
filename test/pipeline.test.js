// The whole pipeline on rendered frames: calibration, commits, and the
// questions it should ask instead of guessing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from '../src/vendor/chess.js';
import { Pipeline } from '../src/core/pipeline.js';
import { Scene } from '../src/demo/scene.js';
import { piecesFromFen } from '../src/demo/script.js';
import { runScenario } from '../eval/synth/run.js';
import { SCENARIOS } from '../eval/synth/scenarios.js';

const START = new Chess().fen();
const after = (...sans) => {
  const c = new Chess();
  for (const s of sans) c.move(s);
  return c.fen();
};

// Plays a list of [what, seconds] steps at 10 fps. `what` is a FEN (the
// board sits still in that position) or a hand ({ x, y } over the board).
function play(scene, steps, pipe) {
  const events = [];
  let t = pipe.clock || 0;
  let pieces = pipe.lastPieces || piecesFromFen(START);
  for (const [what, seconds] of steps) {
    const hands = [];
    if (typeof what === 'string') pieces = piecesFromFen(what);
    else hands.push({ x: what.x, y: what.y, z: 0.9, side: 'w' });
    for (let i = 0; i < seconds * 10; i++) {
      const frame = scene.render({ pieces, hands });
      events.push(...pipe.processFrame(frame, t));
      t += 100;
    }
  }
  pipe.clock = t;
  pipe.lastPieces = pieces;
  return events;
}

const hand = { x: 4.5, y: 3.5 };

function setup(sceneOptions = {}) {
  const scene = new Scene({ seed: 11, ...sceneOptions });
  const pipe = new Pipeline({ corners: scene.corners(), width: scene.W, height: scene.H });
  return { scene, pipe };
}

test('calibrates on the starting position and records a move', () => {
  const { scene, pipe } = setup();
  const ev = play(scene, [[START, 1.5], [hand, 0.5], [after('e4'), 1.5]], pipe);
  const cal = ev.find((e) => e.type === 'calibrated');
  assert.deepEqual(cal.mismatched, []);
  const commits = ev.filter((e) => e.type === 'commit');
  assert.deepEqual(commits.map((e) => e.san.join(' ')), ['e4']);
});

test('a hand that comes and goes without moving anything records nothing', () => {
  const { scene, pipe } = setup();
  const ev = play(scene, [[START, 1.5], [hand, 1], [START, 3]], pipe);
  assert.equal(ev.filter((e) => e.type === 'commit' || e.type === 'ask').length, 0);
});

test('the board going back to the previous position offers a takeback', () => {
  const { scene, pipe } = setup();
  const ev = play(scene, [[START, 1.5], [hand, 0.5], [after('e4'), 1.5], [hand, 0.5], [START, 2]], pipe);
  const ask = ev.find((e) => e.type === 'ask');
  assert.equal(ask.reason, 'takeback');
  assert.equal(ask.options[0].kind, 'takeback');
  pipe.tracker.answer(ask.id, 0, 99999);
  assert.equal(pipe.chess.history().length, 0);
});

test('the same side moving again offers to replace the last move', () => {
  const { scene, pipe } = setup();
  const ev = play(scene, [[START, 1.5], [hand, 0.5], [after('e4'), 1.5], [hand, 0.5], [after('d4'), 2]], pipe);
  const ask = ev.find((e) => e.type === 'ask');
  assert.equal(ask.reason, 'replace');
  assert.deepEqual(ask.options[0].san, ['d4']);
  pipe.tracker.answer(ask.id, 0, 99999);
  assert.equal(pipe.chess.history().join(' '), 'd4');
});

test('two moves made before the board is still are recorded as a pair', () => {
  const { scene, pipe } = setup();
  const ev = play(scene, [[START, 1.5], [hand, 0.5], [after('Nf3', 'd5'), 2]], pipe);
  const commit = ev.find((e) => e.type === 'commit');
  assert.deepEqual(commit.san, ['Nf3', 'd5']);
});

test('a board that matches no legal continuation is never recorded', () => {
  const { scene, pipe } = setup();
  // White's knight jumps to a square it can't reach.
  const bad = 'rnbqkbnr/pppppppp/8/8/4N3/8/PPPPPPPP/R1BQKBNR b KQkq - 0 1';
  const ev = play(scene, [[START, 1.5], [hand, 0.5], [bad, 8]], pipe);
  assert.equal(ev.filter((e) => e.type === 'commit').length, 0);
  // It asks (none of the offered moves is right), then, once the question
  // is waved off, says the board doesn't match the record.
  const ask = ev.find((e) => e.type === 'ask');
  assert.ok(ask);
  pipe.tracker.answer(ask.id, null, ask.t);
  const more = play(scene, [[bad, 12]], pipe);
  assert.equal(more.filter((e) => e.type === 'commit').length, 0);
  assert.ok(more.some((e) => e.type === 'mismatch'));
});

test('promotion defaults to a queen and the piece can be changed', () => {
  const fen = '4k3/P7/8/8/8/8/8/4K3 w - - 0 1';
  const scene = new Scene({ seed: 12 });
  const pipe = new Pipeline({ corners: scene.corners(), width: scene.W, height: scene.H, fen });
  const ev = [];
  let t = 0;
  for (const [f, secs] of [[fen, 1.5], [null, 0.5], ['N3k3/8/8/8/8/8/8/4K3 b - - 0 1', 1.5]]) {
    for (let i = 0; i < secs * 10; i++) {
      const state = f ? { pieces: piecesFromFen(f), hands: [] } : { pieces: piecesFromFen(fen), hands: [{ x: 0.5, y: 7.5, z: 0.9, side: 'w' }] };
      ev.push(...pipe.processFrame(scene.render(state), t));
      t += 100;
    }
  }
  assert.ok(ev.some((e) => e.type === 'promotion'));
  assert.equal(pipe.chess.history()[0], 'a8=Q+');
  pipe.tracker.setPromotion('n', t);
  assert.equal(pipe.chess.history()[0], 'a8=N');
});

for (const name of ['ruy-overhead', 'ruy-side-45']) {
  test(`synthetic game "${name}": every move recorded, none wrong`, async () => {
    const sc = SCENARIOS[name];
    const m = await runScenario(name, { fps: 8 });
    assert.equal(m.wrong, 0);
    assert.equal(m.missed, 0);
    assert.equal(m.auto, sc.moves.length);
  });
}
