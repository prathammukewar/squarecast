// Optional test recording (off unless turned on in settings). The camera
// video is saved on this phone alongside the game, so a game can later be
// replayed through the recognition code on a computer. Nothing is sent
// anywhere; the files leave the phone only if you share them.

import { recordings } from './store.js';

function pickType() {
  for (const t of ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

export class TestRecorder {
  constructor(stream, gameId) {
    this.stream = stream;
    this.gameId = gameId;
    this.chunks = [];
    this.type = pickType();
    this.recorder = null;
  }

  static get supported() {
    return Boolean(window.MediaRecorder) && pickType() !== '';
  }

  start() {
    this.startedAt = Date.now();
    this.recorder = new MediaRecorder(this.stream, { mimeType: this.type, videoBitsPerSecond: 1_500_000 });
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) this.chunks.push(e.data);
    };
    // Save in pieces so a crash loses at most a few seconds.
    this.recorder.start(5000);
  }

  // meta: { corners (fractions, a1 h1 h8 a8), pgn, events } saved next to the video.
  async stop(meta) {
    if (!this.recorder) return;
    await new Promise((resolve) => {
      this.recorder.onstop = resolve;
      this.recorder.stop();
    });
    const blob = new Blob(this.chunks, { type: this.type.split(';')[0] });
    await recordings.put({ id: this.gameId, blob, type: blob.type, meta, startedAt: this.startedAt });
    this.chunks = [];
  }
}

// The video plus a small JSON file the evaluation harness reads.
export async function recordingFiles(gameId, baseName) {
  const rec = await recordings.get(gameId);
  if (!rec) return [];
  const ext = rec.type.includes('mp4') ? 'mp4' : 'webm';
  return [
    new File([rec.blob], `${baseName}.${ext}`, { type: rec.type }),
    new File([JSON.stringify(rec.meta, null, 2)], `${baseName}.json`, { type: 'application/json' }),
  ];
}
