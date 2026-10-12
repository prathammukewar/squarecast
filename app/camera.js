// The camera, and the loop that hands frames to the recognition worker.
//
// Frames are read on the main thread (draw the video into a small canvas,
// getImageData) and the pixel buffer is transferred to the worker. That
// works the same in every browser and avoids OffscreenCanvas, which
// leaked memory with camera frames on iOS 16.4 to 16.6.

export const FRAME_WIDTH = 640;

export async function openCamera(deviceId) {
  const video = {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1280 },
    height: { ideal: 720 },
  };
  if (deviceId) video.deviceId = { exact: deviceId };
  return navigator.mediaDevices.getUserMedia({ video, audio: false });
}

export class FrameSource {
  // video: a playing <video> element showing the camera (or demo) stream.
  constructor(video) {
    this.video = video;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.sizeFromVideo();
  }

  sizeFromVideo() {
    const vw = this.video.videoWidth || 1280;
    const vh = this.video.videoHeight || 720;
    this.width = FRAME_WIDTH;
    this.height = Math.round((FRAME_WIDTH * vh) / vw / 2) * 2;
    this.canvas.width = this.width;
    this.canvas.height = this.height;
  }

  // The current picture as { width, height, data } (RGBA).
  grab() {
    if (this.video.videoWidth && Math.abs(this.video.videoWidth / this.video.videoHeight - this.width / this.height) > 0.01) {
      this.sizeFromVideo();
    }
    this.ctx.drawImage(this.video, 0, 0, this.width, this.height);
    const img = this.ctx.getImageData(0, 0, this.width, this.height);
    return { width: img.width, height: img.height, data: img.data };
  }

  // Average brightness, for the "too dark" hint.
  brightness() {
    const { data } = this.grab();
    let s = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += 4 * 97) {
      s += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      n++;
    }
    return s / n;
  }
}

// Sends frames to the worker at up to `fps`, never more than one in
// flight, so a slow phone drops frames instead of falling behind.
export class FramePump {
  constructor(source, worker, { fps = 10 } = {}) {
    this.source = source;
    this.worker = worker;
    this.interval = 1000 / fps;
    this.busy = false;
    this.running = false;
    this.last = 0;
    this.times = [];
    this.onFrameDone = null;
    worker.addEventListener('message', (e) => {
      if (e.data.type !== 'frame-done') return;
      this.busy = false;
      this.times.push(e.data.ms);
      if (this.times.length > 50) this.times.shift();
      if (this.onFrameDone) this.onFrameDone(e.data);
    });
  }

  start() {
    if (this.running) return;
    this.running = true;
    const tick = () => {
      if (!this.running) return;
      const now = performance.now();
      if (!this.busy && now - this.last >= this.interval && this.source.video.readyState >= 2) {
        this.last = now;
        this.busy = true;
        const f = this.source.grab();
        const buffer = f.data.buffer;
        this.worker.postMessage({ type: 'frame', t: now, width: f.width, height: f.height, buffer }, [buffer]);
      }
      setTimeout(tick, this.interval / 2);
    };
    tick();
  }

  stop() {
    this.running = false;
  }

  // Median milliseconds the worker spends per frame.
  get workerMs() {
    const a = [...this.times].sort((x, y) => x - y);
    return a.length ? a[a.length >> 1] : 0;
  }
}

// Keep the screen on while recording. The lock is dropped whenever the
// page is hidden, so it is asked for again when the page comes back.
export class ScreenKeeper {
  constructor() {
    this.lock = null;
    this.wanted = false;
    document.addEventListener('visibilitychange', () => {
      if (this.wanted && document.visibilityState === 'visible') this.#request();
    });
  }

  async on() {
    this.wanted = true;
    await this.#request();
  }

  async off() {
    this.wanted = false;
    try {
      await this.lock?.release();
    } catch {
      // Already released.
    }
    this.lock = null;
  }

  async #request() {
    if (!('wakeLock' in navigator)) return;
    try {
      this.lock = await navigator.wakeLock.request('screen');
    } catch {
      // Refused (low battery, or not allowed here). The app still works.
    }
  }

  get supported() {
    return 'wakeLock' in navigator;
  }
}
