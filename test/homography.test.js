import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveHomography, applyHomography, invertHomography } from '../src/core/homography.js';
import { BoardWarp } from '../src/core/warp.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test('maps the four corners exactly and round-trips through the inverse', () => {
  const src = [[0, 0], [8, 0], [8, 8], [0, 8]];
  const dst = [[100, 900], [1700, 880], [1400, 200], [380, 230]];
  const H = solveHomography(src, dst);
  src.forEach(([x, y], i) => {
    const [u, v] = applyHomography(H, x, y);
    close(u, dst[i][0]);
    close(v, dst[i][1]);
  });
  const Hi = invertHomography(H);
  for (const [x, y] of [[1.5, 2.25], [4, 4], [7.9, 0.1]]) {
    const [u, v] = applyHomography(H, x, y);
    const [x2, y2] = applyHomography(Hi, u, v);
    close(x, x2);
    close(y, y2);
  }
});

test('degenerate corners are rejected', () => {
  assert.throws(() => solveHomography([[0, 0], [8, 0], [8, 8], [0, 8]], [[0, 0], [10, 0], [20, 0], [30, 0]]));
});

test('an overhead view has no tilt; an angled one leans away from the camera', () => {
  const flat = new BoardWarp({ corners: [[100, 500], [500, 500], [500, 100], [100, 100]], width: 640, height: 640 });
  close(flat.tilt, 1, 1e-3);
  assert.equal(flat.bias, 0);
  assert.ok(flat.spill.every((s) => s.length === 0));
  // Far side (rank 8) narrower than the near side: camera on White's side.
  const angled = new BoardWarp({ corners: [[40, 600], [600, 600], [480, 150], [160, 150]], width: 640, height: 640 });
  assert.ok(angled.tilt > 1.3);
  close(angled.towardCamera[0], 0, 0.05);
  assert.ok(angled.towardCamera[1] < -0.9);
  // e4 (index 28) spills onto e5 (36), the square behind it.
  assert.ok(angled.spill[28].includes(36));
});

test('warping a frame samples the right pixels', () => {
  // A frame whose red channel encodes x and green encodes y.
  const W = 200;
  const H = 200;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const k = (y * W + x) * 4;
      data[k] = x;
      data[k + 1] = y;
      data[k + 3] = 255;
    }
  }
  const warp = new BoardWarp({ corners: [[20, 180], [180, 180], [180, 20], [20, 20]], width: W, height: H });
  const view = warp.apply({ width: W, height: H, data });
  // Center of a1 is board (0.5, 0.5): image (30, 170).
  const [i, j] = warp.boardToView(0.5, 0.5);
  const k = Math.round(j) * warp.N + Math.round(i);
  close(view.R[k], 30, 1);
  close(view.G[k], 170, 1);
});
