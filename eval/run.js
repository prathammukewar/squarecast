// Runs the pipeline over recorded videos and compares the result with
// each game's real PGN.
//
//   node eval/run.js footage/01-overhead-daylight.mp4 [more videos]
//   node eval/run.js footage/*.mp4 --save      also write eval/results/
//   options: --fps 10 --width 960 -v
//
// Each video needs its game and board corners: either the .json file the
// app exports with a test recording (same name as the video), or a PGN
// next to the video plus eval/corners/<name>.json (eval/corners.html).

import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { basename, dirname, join, extname } from 'node:path';
import { Chess } from '../src/vendor/chess.js';
import { evaluate, summarize } from './evaluate.js';
import { saveResults, markdownTable } from './report.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const fps = Number(flag('--fps', 10));
const width = Number(flag('--width', 960));
const verbose = args.includes('-v');
const videos = args.filter((a, i) => !a.startsWith('-') && !['--fps', '--width'].includes(args[i - 1]));

if (!videos.length) {
  console.log('usage: node eval/run.js <video> [more videos] [--save] [--fps 10] [--width 960] [-v]');
  process.exit(1);
}

// Size of the picture as ffmpeg will hand it to us (after rotation).
function probe(video) {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height:stream_side_data=rotation',
    '-of', 'json', video,
  ]).toString();
  const s = JSON.parse(out).streams[0];
  const rotation = Math.abs(Number(s.side_data_list?.find((d) => d.rotation !== undefined)?.rotation || 0));
  return rotation === 90 || rotation === 270 ? { w: s.height, h: s.width } : { w: s.width, h: s.height };
}

async function* decode(video, w, h) {
  const ff = spawn('ffmpeg', ['-v', 'error', '-i', video, '-vf', `fps=${fps},scale=${w}:${h}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1']);
  const size = w * h * 4;
  let buf = Buffer.alloc(0);
  let index = 0;
  for await (const chunk of ff.stdout) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= size) {
      const data = new Uint8ClampedArray(buf.buffer.slice(buf.byteOffset, buf.byteOffset + size));
      buf = buf.subarray(size);
      yield { frame: { width: w, height: h, data }, t: (index++ * 1000) / fps };
    }
  }
}

function truthOf(pgnPath, pgnText) {
  const c = new Chess();
  const text = pgnText ?? readFileSync(pgnPath, 'utf8');
  c.loadPgn(text);
  const headers = c.getHeaders();
  return { sans: c.history(), fen: headers.FEN || null };
}

const rows = [];
for (const video of videos) {
  const name = basename(video, extname(video));
  const exported = join(dirname(video), `${name}.json`);
  const pgn = join(dirname(video), `${name}.pgn`);
  const cornersFile = new URL(`./corners/${name}.json`, import.meta.url);
  let corners;
  let truth;
  if (existsSync(exported)) {
    // A test recording from the app: corners and PGN in one file.
    const meta = JSON.parse(readFileSync(exported, 'utf8'));
    corners = meta.corners;
    truth = truthOf(null, meta.pgn);
  } else if (existsSync(pgn) && existsSync(cornersFile)) {
    // Corners are stored as fractions of the picture size, a1, h1, h8, a8.
    corners = JSON.parse(readFileSync(cornersFile, 'utf8')).corners;
    truth = truthOf(pgn);
  } else {
    console.log(`${name}: needs ${name}.json from the app, or ${name}.pgn plus eval/corners/${name}.json; skipped`);
    continue;
  }
  const src = probe(video);
  const w = Math.min(width, src.w);
  const h = Math.round((src.h * w) / src.w / 2) * 2;
  console.log(`${name}: ${src.w}x${src.h} -> ${w}x${h}, ${truth.sans.length} plies`);
  const m = await evaluate({
    frames: decode(video, w, h),
    corners: corners.map(([x, y]) => [x * w, y * h]),
    width: w,
    height: h,
    truth: truth.sans,
    fen: truth.fen,
    verbose,
  });
  const s = summarize(m);
  rows.push({ name, ...s });
  console.log(`  ${m.frames} frames in ${m.seconds.toFixed(1)} s, wrong ${m.wrong}, auto ${(100 * s.autoRate).toFixed(1)}%`);
  for (const w2 of m.wrongDetails) console.log(`  WRONG at ${(w2.t / 1000).toFixed(1)} s: recorded ${w2.got.join(' ')}, played ${w2.want.join(' ')}`);
}

if (rows.length) {
  console.log(`\n${markdownTable(rows)}\n`);
  if (args.includes('--save')) console.log(`saved ${saveResults('footage', rows)}`);
}
