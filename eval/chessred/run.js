// Runs the move logic over ChessReD games: real phone photos taken after
// every move, with the true position of each photo. Each photo is treated
// as one moment when the board went still after a hand left it.
//
//   python3 eval/chessred/fetch.py --games 8     (once)
//   node eval/chessred/run.js [--save] [-v] [game ids]
//
// Photos in the dataset were taken one by one, so the camera can move a
// little between them. Each photo is warped with its own corners into the
// same top-down view.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Chess } from '../../src/vendor/chess.js';
import { BoardWarp } from '../../src/core/warp.js';
import { snapshot } from '../../src/core/features.js';
import { Tracker } from '../../src/core/tracker.js';
import { orderCorners, suggestOrientation } from '../../src/core/orientation.js';
import { createOperator, summarize } from '../evaluate.js';
import { saveResults, markdownTable } from '../report.js';

const ROOT = new URL('../../footage/chessred/', import.meta.url).pathname;
const SIZE = 1024; // fetch.py saves photos at this size
const STEP = 20000; // ms between photos on the simulated clock

const args = process.argv.slice(2);
const verbose = args.includes('-v');
const onlyGames = args.filter((a) => /^\d+$/.test(a)).map(Number);

if (!existsSync(join(ROOT, 'annotations.json'))) {
  console.log('No ChessReD data yet. Run: python3 eval/chessred/fetch.py --games 8');
  process.exit(1);
}
const ann = JSON.parse(readFileSync(join(ROOT, 'annotations.json'), 'utf8'));

// Piece code ("wP") from a category name such as "white-pawn".
const TYPE = { pawn: 'P', knight: 'N', bishop: 'B', rook: 'R', queen: 'Q', king: 'K' };
const categories = new Map(ann.categories.map((c) => {
  const [color, type] = String(c.name).toLowerCase().split(/[-_ ]/);
  return [c.id, TYPE[type] ? (color.startsWith('w') ? 'w' : 'b') + TYPE[type] : null];
}));

const piecesByImage = new Map();
for (const p of ann.annotations.pieces) {
  const code = categories.get(p.category_id);
  if (!code) continue;
  if (!piecesByImage.has(p.image_id)) piecesByImage.set(p.image_id, {});
  piecesByImage.get(p.image_id)[p.chessboard_position] = code;
}
const cornersByImage = new Map();
for (const c of ann.annotations.corners || []) {
  const k = c.corners;
  const pts = Array.isArray(k) ? k : [k.top_left, k.top_right, k.bottom_right, k.bottom_left];
  cornersByImage.set(c.image_id, pts);
}

// FEN board field of a { square: code } map.
function placement(map) {
  let out = '';
  for (let r = 8; r >= 1; r--) {
    let empty = 0;
    for (const f of 'abcdefgh') {
      const code = map[f + r];
      if (!code) {
        empty++;
        continue;
      }
      if (empty) out += empty;
      empty = 0;
      out += code[0] === 'w' ? code[1] : code[1].toLowerCase();
    }
    if (empty) out += empty;
    if (r > 1) out += '/';
  }
  return out;
}

// The moves between consecutive photos: one ply normally, two if a photo
// is missing. Stops at the first gap no legal move explains.
function truthFor(photos) {
  const c = new Chess();
  const first = placement(piecesByImage.get(photos[0].id) || {});
  const steps = [];
  if (first !== c.fen().split(' ')[0]) {
    const one = c.moves({ verbose: true }).find((m) => {
      c.move(m);
      const ok = c.fen().split(' ')[0] === first;
      c.undo();
      return ok;
    });
    if (!one) return { startIndex: -1, steps };
    c.move(one);
  }
  const startFen = c.fen();
  for (let i = 1; i < photos.length; i++) {
    const target = placement(piecesByImage.get(photos[i].id) || {});
    const found = search(c, target, 2);
    if (!found) break;
    for (const m of found) c.move(m);
    steps.push({ photo: i, sans: found.map((m) => m.san) });
  }
  return { startFen, steps };
}

function search(c, target, depth) {
  if (c.fen().split(' ')[0] === target) return [];
  if (depth === 0) return null;
  for (const m of c.moves({ verbose: true })) {
    c.move(m);
    const rest = search(c, target, depth - 1);
    c.undo();
    if (rest) return [m, ...rest];
  }
  return null;
}

function decode(path) {
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-vf', `scale=${SIZE}:${SIZE}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 64 << 20 });
  return { width: SIZE, height: SIZE, data: new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.length) };
}

const games = new Map();
for (const img of ann.images) {
  if (!cornersByImage.has(img.id)) continue;
  const path = join(ROOT, img.path ?? img.file_name);
  if (!existsSync(path)) continue;
  if (!games.has(img.game_id)) games.set(img.game_id, []);
  games.get(img.game_id).push(img);
}

const rows = [];
for (const [gameId, photos] of [...games].sort((a, b) => a[0] - b[0])) {
  if (onlyGames.length && !onlyGames.includes(gameId)) continue;
  photos.sort((a, b) => (a.move_id ?? a.id) - (b.move_id ?? b.id));
  const truth = truthFor(photos);
  if (!truth.startFen) {
    console.log(`game ${gameId}: first photo is not the start or one move in, skipped`);
    continue;
  }
  const scale = SIZE / (photos[0].width || 3024);
  const frames = [];
  let corners = null;
  for (const p of photos.slice(0, truth.steps.length + 1)) {
    const frame = decode(join(ROOT, p.path ?? p.file_name));
    const pts = cornersByImage.get(p.id).map(([x, y]) => [x * scale, y * scale]);
    if (!corners) {
      // The first photo shows (nearly) the starting position: use it to
      // find which corner is a1.
      corners = suggestOrientation(frame, pts)[0].corners;
    } else {
      // Keep the same corner as a1 as the camera drifts.
      const ring = orderCorners(pts);
      let best = null;
      for (let r = 0; r < 4; r++) {
        const cand = [0, 1, 2, 3].map((i) => ring[(i + r) % 4]);
        const dist = cand.reduce((a, q, i) => a + Math.hypot(q[0] - corners[i][0], q[1] - corners[i][1]), 0);
        if (!best || dist < best.dist) best = { cand, dist };
      }
      corners = best.cand;
    }
    frames.push({ frame, corners });
  }

  const warp0 = new BoardWarp({ corners: frames[0].corners, width: SIZE, height: SIZE });
  const tracker = new Tracker(warp0, { fen: truth.startFen });
  const plies = truth.steps.flatMap((s, i) => s.sans.map((san) => ({ san, done: ((i + 1) * STEP) / 1000 })));
  const op = createOperator({ tracker, truth: plies, fen: truth.startFen, verbose });
  frames.forEach(({ frame, corners: c }, i) => {
    const warp = new BoardWarp({ corners: c, width: SIZE, height: SIZE });
    const snap = snapshot(warp0, warp.apply(frame));
    const t = i * STEP;
    if (i > 0) op.handle(tracker.onMotion(t - 1000), t - 1000);
    // Several still checks, as the app makes about once a second.
    for (let k = 0; k < 14; k++) op.handle(tracker.onStill(snap, t + k * 1000, t - 600), t + k * 1000);
  });
  const m = op.finish();
  const s = summarize(m);
  const view = photos[0].camera ? `, ${photos[0].camera}` : '';
  console.log(`game ${gameId}${view}: ${m.moves} plies over ${frames.length} photos, auto ${(100 * s.autoRate).toFixed(0)}%, wrong ${m.wrong}`);
  for (const w of m.wrongDetails) console.log(`  WRONG: recorded ${w.got.join(' ')}, played ${w.want.join(' ')}`);
  rows.push({ name: `game ${gameId}`, ...s });
}

if (rows.length) {
  const total = rows.reduce((a, r) => {
    for (const k of ['moves', 'auto', 'tapped', 'manual', 'missed', 'wrong', 'prompts', 'badPrompts', 'chipTaps', 'mismatches']) a[k] = (a[k] || 0) + r[k];
    return a;
  }, { name: 'all' });
  total.autoRate = total.moves ? total.auto / total.moves : 0;
  rows.push(total);
  console.log(`\n${markdownTable(rows)}\n`);
  if (args.includes('--save')) console.log(`saved ${saveResults('chessred', rows)}`);
}
