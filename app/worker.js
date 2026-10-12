// Runs the recognition pipeline off the main thread so the screen stays
// smooth. Frames arrive as raw RGBA buffers; game events go back.

import { Pipeline } from '../src/core/pipeline.js';

let pipe = null;

function state() {
  const c = pipe.tracker.chess;
  const history = c.history({ verbose: true });
  const last = history[history.length - 1];
  return {
    fen: c.fen(),
    sans: history.map((m) => m.san),
    lastMove: last ? { from: last.from, to: last.to } : null,
    status: pipe.tracker.state,
    turn: c.turn(),
    legal: c.moves(),
  };
}

function reply(events, extra = {}) {
  self.postMessage({ type: 'update', events, state: state(), ...extra });
}

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      pipe = new Pipeline({ corners: m.corners, width: m.width, height: m.height, fen: m.fen || undefined });
      reply([]);
      return;
    }
    if (!pipe) return;
    const t = m.t ?? performance.now();
    if (m.type === 'frame') {
      const start = performance.now();
      const frame = { width: m.width, height: m.height, data: new Uint8ClampedArray(m.buffer) };
      const events = pipe.processFrame(frame, t);
      const ms = performance.now() - start;
      // Hand the buffer back so the main thread can reuse it.
      self.postMessage({ type: 'frame-done', ms, buffer: m.buffer, moving: pipe.motion.lastInfo?.moving ?? false }, [m.buffer]);
      if (events.length) reply(events);
    } else if (m.type === 'answer') {
      reply(pipe.tracker.answer(m.id, m.index, t));
    } else if (m.type === 'undo') {
      reply(pipe.tracker.undo(t));
    } else if (m.type === 'play') {
      reply(pipe.tracker.play(m.san, t));
    } else if (m.type === 'promotion') {
      reply(pipe.tracker.setPromotion(m.piece, t));
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message ? err.message : err) });
  }
};
