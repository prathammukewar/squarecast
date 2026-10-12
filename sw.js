// Keeps the app working offline: everything it needs is cached when it is
// first opened, and served from the cache after that. Bump VERSION when
// any file changes so phones pick up the new files.

const VERSION = 'squarecast-1';
const FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'app/styles.css',
  'app/app.js',
  'app/board.js',
  'app/camera.js',
  'app/corners.js',
  'app/demo-camera.js',
  'app/lichess.js',
  'app/recorder.js',
  'app/store.js',
  'app/worker.js',
  'src/core/classifier.js',
  'src/core/features.js',
  'src/core/homography.js',
  'src/core/motion.js',
  'src/core/moves.js',
  'src/core/orientation.js',
  'src/core/pgn.js',
  'src/core/pipeline.js',
  'src/core/score.js',
  'src/core/squares.js',
  'src/core/tracker.js',
  'src/core/warp.js',
  'src/demo/scene.js',
  'src/demo/script.js',
  'src/vendor/chess.js',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});
