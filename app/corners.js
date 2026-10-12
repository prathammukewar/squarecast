// Marking the board: tap the four corners of the 64 squares in any order,
// then drag them to fine-tune. A magnifier shows the area under your
// finger while dragging, and the grid follows the corners.

import { solveHomography, applyHomography } from '../src/core/homography.js';

const NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, parent) {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

// Draws the board grid for corners in a1, h1, h8, a8 order.
export function drawGrid(group, corners, { labels = false, tint = null } = {}) {
  group.replaceChildren();
  if (!corners || corners.length !== 4) return;
  const H = solveHomography([[0, 0], [8, 0], [8, 8], [0, 8]], corners);
  const P = (u, v) => applyHomography(H, u, v);
  if (tint) {
    // tint: array of 64 colors (or null) for squares a1..h8.
    for (let sq = 0; sq < 64; sq++) {
      if (!tint[sq]) continue;
      const u = sq & 7;
      const v = sq >> 3;
      const pts = [P(u, v), P(u + 1, v), P(u + 1, v + 1), P(u, v + 1)].map((p) => p.join(',')).join(' ');
      el('polygon', { points: pts, fill: tint[sq], 'fill-opacity': 0.45 }, group);
    }
  }
  for (let i = 0; i <= 8; i++) {
    const [a, b] = [P(i, 0), P(i, 8)];
    const [c, d] = [P(0, i), P(8, i)];
    el('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], class: 'grid-line' }, group);
    el('line', { x1: c[0], y1: c[1], x2: d[0], y2: d[1], class: 'grid-line' }, group);
  }
  if (labels) {
    // Mark White's side (the a1-h1 edge) and the a1 corner.
    const [x1, y1] = P(0, -0.35);
    const [x2, y2] = P(8, -0.35);
    el('line', { x1, y1, x2, y2, class: 'white-side' }, group);
    const [lx, ly] = P(0.5, 0.5);
    const t = el('text', { x: lx, y: ly, class: 'corner-label', 'text-anchor': 'middle', 'dominant-baseline': 'middle' }, group);
    t.textContent = 'a1';
  }
}

export class CornerEditor {
  // svg: overlay <svg> whose viewBox is the frame size; video: the camera
  // <video> under it (for the magnifier).
  constructor(svg, video, { onChange } = {}) {
    this.svg = svg;
    this.video = video;
    this.onChange = onChange;
    this.points = [];
    this.grid = el('g', {}, svg);
    this.handles = el('g', {}, svg);
    this.drag = null;
    this.loupe = document.createElement('canvas');
    this.loupe.className = 'loupe';
    this.loupe.width = 160;
    this.loupe.height = 160;
    this.loupe.hidden = true;
    svg.parentElement.appendChild(this.loupe);
    this.handlers = {
      down: (e) => this.#down(e),
      move: (e) => this.#move(e),
      up: () => this.#up(),
    };
    svg.addEventListener('pointerdown', this.handlers.down);
    window.addEventListener('pointermove', this.handlers.move);
    window.addEventListener('pointerup', this.handlers.up);
    window.addEventListener('pointercancel', this.handlers.up);
  }

  destroy() {
    this.svg.removeEventListener('pointerdown', this.handlers.down);
    window.removeEventListener('pointermove', this.handlers.move);
    window.removeEventListener('pointerup', this.handlers.up);
    window.removeEventListener('pointercancel', this.handlers.up);
    this.grid.remove();
    this.handles.remove();
    this.loupe.remove();
  }

  set(points) {
    this.points = points.map((p) => [...p]);
    this.#render();
  }

  get complete() {
    return this.points.length === 4;
  }

  #toFrame(e) {
    const pt = this.svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(this.svg.getScreenCTM().inverse());
    return [p.x, p.y];
  }

  #down(e) {
    e.preventDefault();
    const p = this.#toFrame(e);
    const vb = this.svg.viewBox.baseVal;
    const reach = Math.max(vb.width, vb.height) * 0.06;
    let nearest = -1;
    let best = Infinity;
    this.points.forEach((q, i) => {
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < best) {
        best = d;
        nearest = i;
      }
    });
    if (nearest >= 0 && best < reach) {
      this.drag = { index: nearest, offset: [this.points[nearest][0] - p[0], this.points[nearest][1] - p[1]] };
    } else if (this.points.length < 4) {
      this.points.push(p);
      this.drag = { index: this.points.length - 1, offset: [0, 0] };
    } else {
      return;
    }
    this.#render();
    this.#showLoupe(e);
  }

  #move(e) {
    if (!this.drag) return;
    const p = this.#toFrame(e);
    const vb = this.svg.viewBox.baseVal;
    this.points[this.drag.index] = [
      Math.min(vb.width, Math.max(0, p[0] + this.drag.offset[0])),
      Math.min(vb.height, Math.max(0, p[1] + this.drag.offset[1])),
    ];
    this.#render();
    this.#showLoupe(e);
  }

  #up() {
    if (!this.drag) return;
    this.drag = null;
    this.loupe.hidden = true;
    if (this.onChange) this.onChange(this.points);
  }

  // Magnified view of the camera around the corner being moved, shown
  // above the finger so the finger doesn't cover it.
  #showLoupe(e) {
    const [x, y] = this.points[this.drag.index];
    const vb = this.svg.viewBox.baseVal;
    const sx = this.video.videoWidth / vb.width;
    const sy = this.video.videoHeight / vb.height;
    const half = 22;
    const ctx = this.loupe.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, 160, 160);
    try {
      ctx.drawImage(this.video, (x - half) * sx, (y - half) * sy, 2 * half * sx, 2 * half * sy, 0, 0, 160, 160);
    } catch {
      // Video not ready yet.
    }
    ctx.strokeStyle = '#ff4d4d';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(80, 60);
    ctx.lineTo(80, 100);
    ctx.moveTo(60, 80);
    ctx.lineTo(100, 80);
    ctx.stroke();
    const host = this.svg.parentElement.getBoundingClientRect();
    this.loupe.style.left = `${Math.min(host.width - 170, Math.max(10, e.clientX - host.left - 80))}px`;
    this.loupe.style.top = `${Math.max(10, e.clientY - host.top - 200)}px`;
    this.loupe.hidden = false;
  }

  #render() {
    this.handles.replaceChildren();
    const vb = this.svg.viewBox.baseVal;
    const r = Math.max(vb.width, vb.height) * 0.018;
    for (const [x, y] of this.points) {
      el('circle', { cx: x, cy: y, r: r * 1.8, class: 'handle-ring' }, this.handles);
      el('circle', { cx: x, cy: y, r: r * 0.35, class: 'handle-dot' }, this.handles);
    }
    if (this.points.length === 4) {
      // Any order works for the grid preview: sort around the center.
      const cx = this.points.reduce((a, p) => a + p[0], 0) / 4;
      const cy = this.points.reduce((a, p) => a + p[1], 0) / 4;
      const ring = [...this.points].sort((p, q) => Math.atan2(q[1] - cy, q[0] - cx) - Math.atan2(p[1] - cy, p[0] - cx));
      drawGrid(this.grid, ring);
    } else {
      this.grid.replaceChildren();
    }
  }
}
