// Which corner is a1? Given the four board corners in any order, put them
// in a consistent order around the board and pick the rotation where the
// starting position makes sense: light pieces on the two ranks nearest
// one side, dark pieces on the two ranks nearest the other.

import { BoardWarp } from './warp.js';
import { snapshot } from './features.js';

// Order four points around their center so that, seen in the image, they
// run the same way a1, h1, h8, a8 do when the camera is above the board.
export function orderCorners(points) {
  const cx = points.reduce((a, p) => a + p[0], 0) / 4;
  const cy = points.reduce((a, p) => a + p[1], 0) / 4;
  // Image y points down, so increasing atan2 runs clockwise on screen;
  // a1, h1, h8, a8 run counterclockwise on screen.
  return [...points].sort((p, q) => Math.atan2(q[1] - cy, q[0] - cx) - Math.atan2(p[1] - cy, p[0] - cx));
}

// The four candidate corner lists (a1 first) for a board seen from above.
export function rotations(points) {
  const ring = orderCorners(points);
  return [0, 1, 2, 3].map((r) => [0, 1, 2, 3].map((i) => ring[(i + r) % 4]));
}

// Score each rotation on a frame of the starting position and return them
// best first. The score compares how bright the pieces on ranks 1-2 are
// with those on ranks 7-8, each against empty squares of the same color
// on ranks 3-6, so the board's own colors cancel out.
export function suggestOrientation(frame, points) {
  const results = rotations(points).map((corners) => {
    const warp = new BoardWarp({ corners, width: frame.width, height: frame.height });
    const { stats } = snapshot(warp, warp.apply(frame));
    const empty = [0, 0];
    const count = [0, 0];
    for (let sq = 16; sq < 48; sq++) {
      const light = ((sq & 7) + (sq >> 3)) % 2;
      empty[light] += stats.Y[sq];
      count[light]++;
    }
    const base = [empty[0] / count[0], empty[1] / count[1]];
    const lift = (ranks) => {
      let acc = 0;
      for (const r of ranks) {
        for (let f = 0; f < 8; f++) {
          const sq = r * 8 + f;
          acc += stats.Y[sq] - base[(f + r) % 2];
        }
      }
      return acc / (ranks.length * 8);
    };
    // Also require ranks 3-6 to look alike from file to file, which is
    // false when the pieces sit on files a-b and g-h instead.
    const spread = (() => {
      const vals = [];
      for (let sq = 16; sq < 48; sq++) vals.push(stats.Y[sq] - base[((sq & 7) + (sq >> 3)) % 2]);
      const m = vals.reduce((a, b) => a + b, 0) / vals.length;
      return Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length);
    })();
    return { corners, score: lift([0, 1]) - lift([6, 7]) - spread };
  });
  return results.sort((a, b) => b.score - a.score);
}
