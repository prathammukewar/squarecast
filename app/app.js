// The app: setup wizard, live recording, prompts, export and the game
// library. Recognition itself runs in app/worker.js.

import { Chess } from '../src/vendor/chess.js';
import { BoardWarp } from '../src/core/warp.js';
import { suggestOrientation, rotations } from '../src/core/orientation.js';
import { formatPgn, pgnDate } from '../src/core/pgn.js';
import { openCamera, FrameSource, FramePump, ScreenKeeper } from './camera.js';
import { CornerEditor, drawGrid } from './corners.js';
import { MiniBoard } from './board.js';
import { games, settings, persist } from './store.js';
import { analyzeOnLichess } from './lichess.js';
import { TestRecorder, recordingFiles } from './recorder.js';

const $ = (id) => document.getElementById(id);
const finished = (game) => /^(1-0|0-1|1\/2-1\/2)$/.test(game?.result || '');
const START_FEN = new Chess().fen();

const S = {
  stream: null,
  demo: null,
  source: null,
  worker: null,
  pump: null,
  editor: null,
  corners: null, // a1, h1, h8, a8 in frame pixels
  orientations: null,
  orientIndex: 0,
  game: null,
  state: null,
  pending: null,
  recorder: null,
  settings: { recording: false, lock: false, fps: 10 },
  hintTimer: null,
  chipTimer: null,
};
const screen = new ScreenKeeper();
let board = null;

// Screens ------------------------------------------------------------------

function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id;
  window.scrollTo(0, 0);
}

function step(id) {
  for (const s of document.querySelectorAll('.step')) s.hidden = s.id !== id;
}

function toast(text, ms = 2200) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}

// Camera and setup ---------------------------------------------------------

async function startSetup(useDemo) {
  $('home-error').hidden = true;
  try {
    if (useDemo) {
      const { DemoCamera } = await import('./demo-camera.js');
      S.demo = new DemoCamera({ fps: 10 });
      S.stream = S.demo.start();
    } else {
      S.demo = null;
      S.stream = await openCamera();
    }
  } catch (err) {
    const e = $('home-error');
    e.textContent = err && err.name === 'NotAllowedError'
      ? 'Squarecast needs the camera. Allow it in your browser settings, then try again.'
      : `The camera did not start (${err && err.message ? err.message : err}).`;
    e.hidden = false;
    return;
  }
  const video = $('video');
  video.srcObject = S.stream;
  await video.play().catch(() => {});
  await new Promise((r) => (video.readyState >= 2 ? r() : video.addEventListener('loadeddata', r, { once: true })));
  S.source = new FrameSource(video);
  const overlay = $('overlay');
  overlay.setAttribute('viewBox', `0 0 ${S.source.width} ${S.source.height}`);
  overlay.replaceChildren();
  watchTrack();
  show('stage');
  step('step-camera');
  screen.on();
  setupZoom();
  clearInterval(S.hintTimer);
  S.hintTimer = setInterval(lightHint, 1000);
  lightHint();
}

function watchTrack() {
  const track = S.stream.getVideoTracks()[0];
  if (!track) return;
  track.addEventListener('ended', () => {
    const b = $('camera-banner');
    b.textContent = 'The camera stopped. Tap here to start it again.';
    b.hidden = false;
    b.onclick = restartCamera;
  });
}

async function restartCamera() {
  $('camera-banner').hidden = true;
  if (S.demo) return;
  try {
    S.stream = await openCamera();
    $('video').srcObject = S.stream;
    await $('video').play().catch(() => {});
    watchTrack();
  } catch {
    toast('Could not restart the camera');
  }
}

function setupZoom() {
  const track = S.stream.getVideoTracks()[0];
  const caps = track && track.getCapabilities ? track.getCapabilities() : {};
  const row = $('zoom-row');
  if (!caps.zoom) {
    row.hidden = true;
    return;
  }
  const input = $('zoom');
  input.min = caps.zoom.min;
  input.max = caps.zoom.max;
  input.step = caps.zoom.step || 0.1;
  input.value = track.getSettings().zoom || caps.zoom.min;
  input.oninput = () => track.applyConstraints({ advanced: [{ zoom: Number(input.value) }] }).catch(() => {});
  row.hidden = false;
}

function lightHint() {
  if (!S.source || $('step-camera').hidden) return;
  const b = S.source.brightness();
  $('light-hint').textContent = b < 45 ? 'It is quite dark. Turn on a light if you can.' : '';
}

function toCorners() {
  clearInterval(S.hintTimer);
  step('step-corners');
  const overlay = $('overlay');
  S.editor?.destroy();
  S.editor = new CornerEditor(overlay, $('video'), { onChange: cornerHints });
  if (S.demo) {
    S.editor.set(S.demo.cornerFractions().map(([x, y]) => [x * S.source.width, y * S.source.height]));
    cornerHints(S.editor.points);
  } else if (S.corners) {
    S.editor.set(S.corners);
    cornerHints(S.editor.points);
  }
}

function cornerHints(points) {
  $('to-orient').disabled = points.length !== 4;
  if (points.length !== 4) {
    $('corner-hint').textContent = `${points.length} of 4 corners marked.`;
    return;
  }
  const W = S.source.width;
  const H = S.source.height;
  const area = Math.abs(points.reduce((a, p, i) => {
    const q = points[(i + 1) % 4];
    return a + p[0] * q[1] - q[0] * p[1];
  }, 0) / 2);
  const ring = rotations(points)[0];
  let tilt = 1;
  try {
    tilt = new BoardWarp({ corners: ring, width: W, height: H }).tilt;
  } catch {
    // Corners in a line; the hint below covers it.
  }
  const nearEdge = points.some(([x, y]) => x < W * 0.02 || y < H * 0.02 || x > W * 0.98 || y > H * 0.98);
  let hint = '';
  if (area < W * H * 0.12) hint = 'The board is small in the picture. Move the phone closer or zoom in.';
  else if (nearEdge) hint = 'Leave a little space between the board and the edge of the picture.';
  else if (tilt > 2.2) hint = 'The camera is low. Raise it, or point it more steeply down.';
  $('corner-hint').textContent = hint;
}

function toOrient() {
  const points = S.editor.points;
  S.editor.destroy();
  S.editor = null;
  const frame = S.source.grab();
  const ranked = suggestOrientation(frame, points);
  // The four ways round, in order, so Turn moves a1 to the next corner.
  S.ring = rotations(points);
  const same = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;
  S.orientIndex = Math.max(0, S.ring.findIndex((c) => same(c[0], ranked[0].corners[0])));
  const margin = ranked[0].score - ranked[1].score;
  $('orient-text').textContent = margin > 5
    ? 'Guessed from the starting position. The bar marks the side White sits on.'
    : 'Tap Turn until the bar is on the side White sits on.';
  step('step-orient');
  drawOrientation();
}

function drawOrientation() {
  const overlay = $('overlay');
  overlay.replaceChildren();
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  overlay.appendChild(g);
  S.corners = S.ring[S.orientIndex];
  drawGrid(g, S.corners, { labels: true });
}

function rotate() {
  S.orientIndex = (S.orientIndex + 1) % 4;
  drawOrientation();
}

// Recognition worker -------------------------------------------------------

function startWorker(fen = START_FEN) {
  S.pump?.stop();
  S.worker?.terminate();
  S.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  S.worker.onmessage = onWorker;
  S.worker.onerror = (e) => toast(`Recognition stopped: ${e.message || 'error'}`, 5000);
  S.worker.postMessage({ type: 'init', corners: S.corners, width: S.source.width, height: S.source.height, fen });
  S.pump = new FramePump(S.source, S.worker, { fps: S.settings.fps });
  S.pump.start();
}

function toCheck() {
  step('step-check');
  $('to-details').disabled = true;
  $('check-text').textContent = 'Set up the pieces and keep hands off the board for a moment.';
  const overlay = $('overlay');
  overlay.replaceChildren();
  S.checkGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  overlay.appendChild(S.checkGroup);
  drawGrid(S.checkGroup, S.corners);
  lockCamera();
  startWorker();
  startTestRecording();
}

function onCalibrated(mismatched) {
  const tint = new Array(64).fill('#2fbf71');
  for (const sq of mismatched) tint[sq] = '#e5484d';
  drawGrid(S.checkGroup, S.corners, { tint });
  $('check-text').textContent = mismatched.length === 0
    ? 'All 64 squares look right.'
    : `${mismatched.length} square${mismatched.length > 1 ? 's' : ''} in red don't look right. Check the light, the corners, and that the pieces are in place, then check again. You can also go on.`;
  $('to-details').disabled = false;
}

async function lockCamera() {
  if (!S.settings.lock || S.demo) return;
  const track = S.stream.getVideoTracks()[0];
  const caps = track.getCapabilities ? track.getCapabilities() : {};
  const lock = {};
  if (caps.whiteBalanceMode?.includes('manual')) lock.whiteBalanceMode = 'manual';
  if (caps.exposureMode?.includes('manual')) lock.exposureMode = 'manual';
  if (Object.keys(lock).length) await track.applyConstraints({ advanced: [lock] }).catch(() => {});
}

function toDetails() {
  step('step-details');
  const form = $('details');
  if (!form.Date.value) form.Date.value = new Date().toISOString().slice(0, 10);
}

function startLive() {
  const form = new FormData($('details'));
  const headers = {};
  for (const [k, v] of form.entries()) if (String(v).trim()) headers[k] = String(v).trim();
  if (headers.Date) headers.Date = headers.Date.replace(/-/g, '.');
  else headers.Date = pgnDate();
  // Keep the id a test recording may already have started under.
  const id = S.game && !finished(S.game) ? S.game.id : Date.now();
  S.game = { id, startedAt: S.game?.startedAt || Date.now(), headers, sans: S.state?.sans || [], result: '*' };
  saveGame();
  const overlay = $('overlay');
  overlay.replaceChildren();
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.setAttribute('class', 'live-grid');
  overlay.appendChild(g);
  drawGrid(g, S.corners);
  step('step-live');
  if (!board) board = new MiniBoard($('board-box'));
  renderGame();
  setStatus(S.state?.status || 'watching');
  $('rec-badge').hidden = !S.recorder;
  showBattery();
  S.demo?.play();
}

function onWorker(e) {
  const m = e.data;
  if (m.type === 'error') {
    toast(`Recognition error: ${m.message}`, 5000);
    return;
  }
  if (m.type !== 'update') return;
  S.state = m.state;
  for (const ev of m.events) handleEvent(ev);
  if (S.game && !finished(S.game)) {
    S.game.sans = m.state.sans;
    saveGame();
  }
  renderGame();
}

function handleEvent(ev) {
  S.recorder?.log(ev);
  switch (ev.type) {
    case 'calibrated':
      onCalibrated(ev.mismatched);
      break;
    case 'status':
      setStatus(ev.state);
      // A mismatch alert goes away by itself once the board matches again.
      if (ev.state === 'watching' && S.alertKind === 'mismatch') hideAlert();
      break;
    case 'commit':
      if (ev.how !== 'manual') flash(`Recorded ${ev.san.join(' ')}`);
      closeSheet();
      hideAlert();
      break;
    case 'promotion':
      showChip(ev.san);
      break;
    case 'ask':
      showAsk(ev);
      break;
    case 'mismatch':
      showAlert('The board doesn\'t match the record.', [['Fix the record', openFix], ['Dismiss', hideAlert]], 'mismatch');
      break;
    case 'gameover':
      S.autoResult = ev;
      showAlert(ev.reason === 'checkmate' ? 'Checkmate.' : `Draw by ${ev.reason}.`, [['End game', () => endGame(ev.result)]], 'gameover');
      break;
    default:
      break;
  }
}

// Live screen --------------------------------------------------------------

const STATUS = {
  calibrating: ['Checking the board', 'busy'],
  watching: ['Watching', 'ok'],
  busy: ['Hand over the board', 'busy'],
  waiting: ['Waiting for the move to finish', 'busy'],
  asking: ['Needs you', 'ask'],
};

function setStatus(state) {
  const [text, kind] = STATUS[state] || [state, 'ok'];
  $('status-text').textContent = text;
  for (const d of [$('status-dot'), $('dim-dot')]) d.dataset.kind = kind;
}

function flash(text) {
  $('status-text').textContent = text;
  $('status-dot').dataset.kind = 'done';
  $('dim-dot').dataset.kind = 'done';
}

function renderGame() {
  if (!board || !S.state) return;
  const c = new Chess(S.state.fen);
  board.render(c.board(), S.state.lastMove);
  const list = $('moves');
  list.replaceChildren();
  const sans = S.state.sans;
  for (let i = 0; i < sans.length; i += 2) {
    const li = document.createElement('li');
    li.textContent = `${sans[i]}${sans[i + 1] ? '  ' + sans[i + 1] : ''}`;
    list.appendChild(li);
  }
  list.scrollTop = list.scrollHeight;
}

function showChip(san) {
  const chip = $('chip');
  chip.replaceChildren();
  const label = document.createElement('span');
  label.textContent = `${san}: queen?`;
  chip.appendChild(label);
  for (const [piece, name] of [['r', 'Rook'], ['b', 'Bishop'], ['n', 'Knight']]) {
    const b = document.createElement('button');
    b.textContent = name;
    b.onclick = () => {
      S.worker.postMessage({ type: 'promotion', piece });
      chip.hidden = true;
    };
    chip.appendChild(b);
  }
  chip.hidden = false;
  clearTimeout(S.chipTimer);
  S.chipTimer = setTimeout(() => (chip.hidden = true), 8000);
}

function showAlert(text, actions, kind = null) {
  S.alertKind = kind;
  const a = $('alert');
  a.replaceChildren();
  const p = document.createElement('span');
  p.textContent = text;
  a.appendChild(p);
  for (const [label, fn] of actions) {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = fn;
    a.appendChild(b);
  }
  a.hidden = false;
}

function hideAlert() {
  S.alertKind = null;
  $('alert').hidden = true;
}

function showAsk(ev) {
  S.pending = ev;
  const options = ev.options;
  const arrows = options.flatMap((o) => o.uci.map((u) => ({ from: u.slice(0, 2), to: u.slice(2, 4) })).slice(0, 1));
  board?.showArrows(arrows);
  let title = 'Which move was played?';
  let text = 'Tap the move. The arrows on the board match the buttons.';
  let cancel = 'None of these';
  if (ev.reason === 'takeback') {
    title = `Take back ${S.state.sans[S.state.sans.length - 1]}?`;
    text = 'The board looks like it did before the last move.';
    cancel = 'No';
  } else if (ev.reason === 'replace') {
    title = 'Change the last move?';
    text = 'The same side seems to have moved again. Usually that corrects the last move.';
  }
  $('sheet-title').textContent = title;
  $('sheet-text').textContent = text;
  const box = $('sheet-options');
  box.replaceChildren();
  options.forEach((o, i) => {
    const b = document.createElement('button');
    b.className = 'option';
    b.style.setProperty('--swatch', ['#2f7d55', '#2d6fb5', '#b5652d'][i % 3]);
    b.textContent = o.kind === 'takeback' ? 'Yes, take it back' : o.kind === 'replace' ? `Make it ${o.san.join(' ')}` : o.san.join(' then ');
    b.onclick = () => answer(i);
    box.appendChild(b);
  });
  $('sheet-cancel').textContent = cancel;
  $('sheet-cancel').onclick = () => answer(null);
  $('sheet').hidden = false;
}

function answer(index) {
  if (!S.pending) return;
  S.worker.postMessage({ type: 'answer', id: S.pending.id, index });
  closeSheet();
}

function closeSheet() {
  S.pending = null;
  $('sheet').hidden = true;
  board?.showArrows([]);
}

// The fix-move picker: undo, or enter the move that was played.
function openFix() {
  hideAlert();
  closeSheet();
  if (!S.state) return;
  $('sheet-title').textContent = 'Fix the record';
  $('sheet-text').textContent = 'Undo the last move, or tap the move that was played.';
  const box = $('sheet-options');
  box.replaceChildren();
  if (S.state.sans.length) {
    const u = document.createElement('button');
    u.className = 'option wide';
    u.textContent = `Undo ${S.state.sans[S.state.sans.length - 1]}`;
    u.onclick = () => {
      S.worker.postMessage({ type: 'undo' });
      $('sheet').hidden = true;
    };
    box.appendChild(u);
  }
  for (const san of [...S.state.legal].sort()) {
    const b = document.createElement('button');
    b.className = 'option small';
    b.textContent = san;
    b.onclick = () => {
      S.worker.postMessage({ type: 'play', san });
      $('sheet').hidden = true;
    };
    box.appendChild(b);
  }
  $('sheet-cancel').textContent = 'Close';
  $('sheet-cancel').onclick = () => ($('sheet').hidden = true);
  $('sheet').hidden = false;
}

async function showBattery() {
  if (!navigator.getBattery) return;
  try {
    const b = await navigator.getBattery();
    const upd = () => ($('battery').textContent = `${Math.round(b.level * 100)}%${b.charging ? ' charging' : ''}`);
    upd();
    b.onlevelchange = upd;
    b.onchargingchange = upd;
  } catch {
    // Not available.
  }
}

// Ending, export, library --------------------------------------------------

function pgnOf(game) {
  return formatPgn({ headers: game.headers, moves: game.sans, result: game.result || '*' });
}

async function saveGame() {
  if (!S.game) return;
  S.game.pgn = pgnOf(S.game);
  S.game.updatedAt = Date.now();
  try {
    await games.put({ ...S.game });
  } catch {
    // Storage full or blocked; the game is still on screen.
  }
}

async function endGame(result) {
  if (S.game) {
    S.game.sans = S.state ? S.state.sans : S.game.sans;
    if (result) S.game.result = result;
    await saveGame();
  }
  hideAlert();
  closeSheet();
  await stopTestRecording();
  S.pump?.stop();
  screen.off();
  showGameOver();
}

function showGameOver() {
  show('gameover');
  const g = S.game;
  const decided = finished(g);
  $('gameover-text').textContent = decided ? `Result ${g.result}.` : 'Choose the result.';
  for (const b of document.querySelectorAll('[data-result]')) b.classList.toggle('chosen', b.dataset.result === g.result);
  $('pgn').textContent = pgnOf(g);
  recordingFiles(g.id, 'x').then((files) => ($('export-recording').hidden = files.length === 0)).catch(() => {});
}

async function setResult(result) {
  S.game.result = result;
  await saveGame();
  showGameOver();
}

function fileName(game) {
  const h = game.headers;
  const who = [h.White, h.Black].filter(Boolean).join('-vs-') || 'game';
  return `${(h.Date || pgnDate()).replace(/\./g, '-')}-${who}`.replace(/[^\w.-]+/g, '_');
}

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/x-chess-pgn' }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('PGN copied');
  } catch {
    toast('Copy did not work here. Use Download instead.');
  }
}

async function share(game) {
  const text = pgnOf(game);
  // Share as text: Chrome on Android refuses .pgn files.
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Chess game', text });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
  }
  copy(text);
}

async function shareRecording(game) {
  const files = await recordingFiles(game.id, fileName(game));
  if (!files.length) return;
  if (navigator.canShare && navigator.canShare({ files })) {
    try {
      await navigator.share({ files, title: 'Squarecast test recording' });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
  }
  for (const f of files) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f);
    a.download = f.name;
    a.click();
  }
}

async function startTestRecording() {
  await stopTestRecording(false);
  S.recorder = null;
  if (!S.settings.recording || !TestRecorder.supported) return;
  const id = S.game && !finished(S.game) ? S.game.id : Date.now();
  S.game = S.game && S.game.id === id ? S.game : { id, startedAt: Date.now(), headers: {}, sans: [], result: '*' };
  const rec = new TestRecorder(S.stream, id);
  const log = [];
  rec.log = (ev) => log.push({ ms: Date.now() - rec.startedAt, ...ev });
  rec.events = log;
  rec.start();
  S.recorder = rec;
}

async function stopTestRecording(save = true) {
  const rec = S.recorder;
  if (!rec) return;
  S.recorder = null;
  if (!save) return;
  const W = S.source.width;
  const H = S.source.height;
  await rec.stop({
    corners: S.corners.map(([x, y]) => [x / W, y / H]),
    pgn: S.game ? pgnOf(S.game) : '',
    events: rec.events,
  });
}

async function newGameSameSetup() {
  S.game = { id: Date.now(), startedAt: Date.now(), headers: { ...S.game.headers, Date: pgnDate() }, sans: [], result: '*' };
  S.state = null;
  show('stage');
  screen.on();
  toCheck();
}

function leaveStage() {
  S.pump?.stop();
  S.worker?.terminate();
  S.worker = null;
  S.editor?.destroy();
  S.editor = null;
  clearInterval(S.hintTimer);
  screen.off();
  stopTestRecording(false);
  S.demo?.stop();
  S.stream?.getTracks().forEach((t) => t.stop());
  S.stream = null;
  S.game = null;
  S.state = null;
  S.corners = null;
  show('home');
}

async function openLibrary() {
  show('library');
  await renderLibrary();
}

async function renderLibrary() {
  const all = (await games.all()).sort((a, b) => (b.updatedAt || b.startedAt) - (a.updatedAt || a.startedAt));
  const q = $('search').value.trim().toLowerCase();
  const list = $('game-list');
  list.replaceChildren();
  const shown = all.filter((g) => !q || Object.values(g.headers || {}).join(' ').toLowerCase().includes(q));
  for (const g of shown) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    const h = g.headers || {};
    b.innerHTML = '';
    const title = document.createElement('strong');
    title.textContent = `${h.White || 'White'} vs ${h.Black || 'Black'}`;
    const meta = document.createElement('span');
    meta.className = 'muted';
    meta.textContent = `${h.Date || ''} · ${Math.ceil((g.sans || []).length / 2)} moves · ${g.result || '*'}${h.Event ? ' · ' + h.Event : ''}`;
    b.append(title, meta);
    b.onclick = () => openGame(g.id);
    li.appendChild(b);
    list.appendChild(li);
  }
  $('library-empty').hidden = shown.length > 0;
  $('export-all').hidden = all.length === 0;
}

async function openGame(id) {
  const g = await games.get(id);
  if (!g) return;
  S.viewing = g;
  show('game-view');
  $('game-title').textContent = `${g.headers.White || 'White'} vs ${g.headers.Black || 'Black'}`;
  $('game-pgn').textContent = pgnOf(g);
  recordingFiles(g.id, 'x').then((f) => ($('game-recording').hidden = f.length === 0)).catch(() => {});
}

async function openSettings() {
  show('settings');
  $('set-recording').checked = S.settings.recording;
  $('set-recording').disabled = !TestRecorder.supported;
  $('set-lock').checked = S.settings.lock;
  $('set-fps').value = String(S.settings.fps);
}

async function loadSettings() {
  try {
    S.settings.recording = await settings.get('recording', false);
    S.settings.lock = await settings.get('lock', false);
    S.settings.fps = await settings.get('fps', 10);
  } catch {
    // Private mode or blocked storage: defaults.
  }
}

// Wiring -------------------------------------------------------------------

function wire() {
  $('start-camera').onclick = () => startSetup(false);
  $('start-demo').onclick = () => startSetup(true);
  $('open-library').onclick = openLibrary;
  $('open-settings').onclick = openSettings;
  $('cancel-setup').onclick = leaveStage;
  $('to-corners').onclick = toCorners;
  $('clear-corners').onclick = () => {
    S.editor.set([]);
    cornerHints([]);
  };
  $('to-orient').onclick = toOrient;
  $('rotate').onclick = rotate;
  $('to-check').onclick = toCheck;
  $('recheck').onclick = toCheck;
  $('to-details').onclick = toDetails;
  $('to-live').onclick = startLive;
  $('undo').onclick = () => S.worker?.postMessage({ type: 'undo' });
  $('fix').onclick = openFix;
  $('dim-on').onclick = () => ($('dim').hidden = false);
  $('dim').onclick = () => ($('dim').hidden = true);
  $('end-game').onclick = () => endGame(S.autoResult ? S.autoResult.result : null);
  for (const b of document.querySelectorAll('[data-result]')) b.onclick = () => setResult(b.dataset.result);
  $('analyze').onclick = () => analyzeOnLichess(pgnOf(S.game), S.game.sans);
  $('copy').onclick = () => copy(pgnOf(S.game));
  $('download').onclick = () => download(`${fileName(S.game)}.pgn`, pgnOf(S.game));
  $('share').onclick = () => share(S.game);
  $('export-recording').onclick = () => shareRecording(S.game);
  $('new-game').onclick = newGameSameSetup;
  $('done').onclick = leaveStage;
  $('library-back').onclick = () => show('home');
  $('search').oninput = renderLibrary;
  $('export-all').onclick = async () => {
    const all = await games.all();
    download('squarecast-games.pgn', all.map(pgnOf).join('\n'));
  };
  $('game-back').onclick = openLibrary;
  $('game-analyze').onclick = () => analyzeOnLichess(pgnOf(S.viewing), S.viewing.sans);
  $('game-copy').onclick = () => copy(pgnOf(S.viewing));
  $('game-download').onclick = () => download(`${fileName(S.viewing)}.pgn`, pgnOf(S.viewing));
  $('game-share').onclick = () => share(S.viewing);
  $('game-recording').onclick = () => shareRecording(S.viewing);
  $('game-delete').onclick = async () => {
    if (!confirm('Delete this game from this phone?')) return;
    await games.remove(S.viewing.id);
    openLibrary();
  };
  $('settings-back').onclick = () => show('home');
  $('set-recording').onchange = (e) => {
    S.settings.recording = e.target.checked;
    settings.set('recording', S.settings.recording);
  };
  $('set-lock').onchange = (e) => {
    S.settings.lock = e.target.checked;
    settings.set('lock', S.settings.lock);
  };
  $('set-fps').onchange = (e) => {
    S.settings.fps = Number(e.target.value);
    settings.set('fps', S.settings.fps);
  };
}

wire();
loadSettings();
persist();
if ('serviceWorker' in navigator && (location.hostname !== 'localhost' || location.search.includes('sw'))) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
// For tests: lets the page report what the recognizer is doing.
window.squarecast = S;
