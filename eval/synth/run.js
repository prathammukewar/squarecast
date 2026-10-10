// Runs the pipeline over synthetic recordings and prints the numbers.
//   node eval/synth/run.js                 all scenarios
//   node eval/synth/run.js torture -v      one scenario, with the event log
//   node eval/synth/run.js torture --video out.mp4   also write the video
//   node eval/synth/run.js --save          also write eval/results/

import { spawn } from 'node:child_process';
import { Scene, mulberry32 } from './scene.js';
import { buildTimeline } from './script.js';
import { SCENARIOS } from './scenarios.js';
import { evaluate, summarize } from '../evaluate.js';
import { saveResults } from '../report.js';

export async function runScenario(name, { fps = 10, verbose = false, video = null } = {}) {
  const sc = SCENARIOS[name];
  const moves = typeof sc.moves === 'function' ? sc.moves() : sc.moves;
  const tl = buildTimeline(moves, sc.script || {});
  const scene = new Scene(sc.scene);
  const ff = video
    ? spawn('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${scene.W}x${scene.H}`, '-r', String(fps), '-i', '-', '-pix_fmt', 'yuv420p', video], { stdio: ['pipe', 'inherit', 'inherit'] })
    : null;
  const jr = mulberry32(42);
  async function* frames() {
    const n = Math.ceil(tl.duration * fps);
    for (let i = 0; i < n; i++) {
      const t = i / fps;
      const state = tl.stateAt(t);
      if (sc.shadows) addLighting(state, t);
      // A phone on a stand shakes a little; a bump moves it for good.
      const shake = sc.jitter ? [(jr() - 0.5) * 2 * sc.jitter, (jr() - 0.5) * 2 * sc.jitter] : [0, 0];
      const bump = sc.bumpAt && t > sc.bumpAt ? [7, 5] : [0, 0];
      state.shift = [shake[0] + bump[0], shake[1] + bump[1]];
      const frame = scene.render(state);
      if (ff && !ff.stdin.write(Buffer.from(frame.data.buffer))) await new Promise((r) => ff.stdin.once('drain', r));
      yield { frame, t: t * 1000 };
    }
  }
  const m = await evaluate({ frames: frames(), corners: scene.corners(), width: scene.W, height: scene.H, truth: tl.truth, verbose });
  if (ff) {
    ff.stdin.end();
    await new Promise((r) => ff.on('close', r));
  }
  return m;
}

// Someone leans over the board for a while, then the room lights come on:
// a bit brighter, a flatter falloff and a cooler color. (A phone's auto
// exposure takes back most of the brightness jump.)
export function addLighting(state, t) {
  const lean = Math.max(0, Math.min(1, t - 8)) * Math.max(0, Math.min(1, 17 - t));
  if (lean > 0) state.shadows = [{ x: 0.35, y: 0.55, radius: 0.28, depth: 0.4 * lean }];
  if (t > 24) state.light = { gain: 0.92, gradient: 0.25, warmth: -0.02 };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const verbose = args.includes('-v');
  const vi = args.indexOf('--video');
  const video = vi >= 0 ? args[vi + 1] : null;
  const names = args.filter((a, i) => !a.startsWith('-') && args[i - 1] !== '--video');
  const rows = [];
  for (const name of names.length ? names : Object.keys(SCENARIOS)) {
    const m = await runScenario(name, { verbose, video });
    const s = summarize(m);
    rows.push({ name, ...s, secs: m.seconds.toFixed(1) });
    if (verbose) console.log(m.pgn);
  }
  if (args.includes('--save')) console.log(`saved ${saveResults('synthetic', rows)}`);
  console.table(rows.map((r) => ({
    scenario: r.name, moves: r.moves, auto: `${(100 * r.autoRate).toFixed(0)}%`, tapped: r.tapped, manual: r.manual,
    missed: r.missed, wrong: r.wrong, prompts: r.prompts, bad: r.badPrompts, chip: r.chipTaps, alerts: r.mismatches,
    'p50 ms': r.latencyMedian, 'p95 ms': r.latencyP95, calib: r.calibrationMisses, secs: r.secs,
  })));
}
