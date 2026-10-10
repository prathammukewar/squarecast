import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from '../src/vendor/chess.js';
import { suggestOrientation, orderCorners } from '../src/core/orientation.js';
import { Scene } from '../eval/synth/scene.js';
import { piecesFromFen } from '../eval/synth/script.js';

const START = new Chess().fen();
const close = (a, b) => a.every((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1]) < 1e-6);

test('corners in any order come back around the board the same way', () => {
  const pts = [[100, 400], [400, 400], [380, 60], [120, 60]];
  const shuffled = [pts[2], pts[0], pts[3], pts[1]];
  const ring = orderCorners(shuffled);
  const start = ring.findIndex((p) => p === pts[0]);
  assert.ok(close([0, 1, 2, 3].map((i) => ring[(start + i) % 4]), pts));
});

for (const [name, opts] of [
  ['overhead, White at the bottom', { tilt: 0 }],
  ['45 degrees from White\'s side', { tilt: 45, distance: 11 }],
  ['from the h-file side', { tilt: 35, azimuth: 90, distance: 11 }],
  ['from Black\'s side, dim wood', { tilt: 30, azimuth: 180, board: 'wood', pieces: 'wood', light: { gain: 0.7 } }],
]) {
  test(`finds a1 on the starting position: ${name}`, () => {
    const scene = new Scene({ seed: 3, ...opts });
    const truth = scene.corners();
    const frame = scene.render({ pieces: piecesFromFen(START), hands: [] });
    const shuffled = [truth[3], truth[1], truth[0], truth[2]];
    const [best, second] = suggestOrientation(frame, shuffled);
    assert.ok(close(best.corners, truth), JSON.stringify(best.corners));
    assert.ok(best.score - second.score > 5, `margin ${best.score - second.score}`);
  });
}
