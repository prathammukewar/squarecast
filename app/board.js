// A small SVG chessboard for the live screen: the recorded position, the
// last move, and arrows for the moves the app wants a person to choose
// between.

const NS = 'http://www.w3.org/2000/svg';
// Solid glyphs for both colors (the outline ones are hard to read small);
// the trailing U+FE0E asks for text, not emoji, presentation.
const GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
export const ARROW_COLORS = ['#2f7d55', '#2d6fb5', '#b5652d'];

function el(name, attrs = {}, parent) {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

export class MiniBoard {
  constructor(container, { flipped = false } = {}) {
    this.flipped = flipped;
    this.svg = el('svg', { viewBox: '0 0 8 8', class: 'mini-board', role: 'img', 'aria-label': 'Recorded position' });
    container.appendChild(this.svg);
    this.squares = el('g', {}, this.svg);
    this.highlights = el('g', {}, this.svg);
    this.pieces = el('g', {}, this.svg);
    this.arrows = el('g', {}, this.svg);
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        el('rect', { x: f, y: r, width: 1, height: 1, class: (f + r) % 2 ? 'sq-dark' : 'sq-light' }, this.squares);
      }
    }
    const defs = el('defs', {}, this.svg);
    ARROW_COLORS.forEach((c, i) => {
      const m = el('marker', { id: `arrowhead-${i}`, viewBox: '0 0 10 10', refX: 5, refY: 5, markerWidth: 3, markerHeight: 3, orient: 'auto-start-reverse' }, defs);
      el('path', { d: 'M0,0 L10,5 L0,10 z', fill: c }, m);
    });
  }

  // Board coordinates of a square's center ("e4" -> [4.5, 4.5] from top-left).
  center(square) {
    const f = square.charCodeAt(0) - 97;
    const r = square.charCodeAt(1) - 49;
    return this.flipped ? [7 - f + 0.5, r + 0.5] : [f + 0.5, 7 - r + 0.5];
  }

  // board: chess.js board() array; lastMove: { from, to } or null.
  render(board, lastMove = null) {
    this.pieces.replaceChildren();
    this.highlights.replaceChildren();
    if (lastMove) {
      for (const s of [lastMove.from, lastMove.to]) {
        const [x, y] = this.center(s);
        el('rect', { x: x - 0.5, y: y - 0.5, width: 1, height: 1, class: 'sq-last' }, this.highlights);
      }
    }
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const p = board[r][f];
        if (!p) continue;
        const square = 'abcdefgh'[f] + (8 - r);
        const [x, y] = this.center(square);
        const t = el('text', { x, y: y + 0.32, class: `piece piece-${p.color}`, 'text-anchor': 'middle' }, this.pieces);
        t.textContent = GLYPH[p.type] + '︎';
      }
    }
  }

  // moves: [{ from, to }] drawn as arrows in ARROW_COLORS order.
  showArrows(moves) {
    this.arrows.replaceChildren();
    moves.forEach((m, i) => {
      const [x1, y1] = this.center(m.from);
      const [x2, y2] = this.center(m.to);
      const len = Math.hypot(x2 - x1, y2 - y1) || 1;
      const ex = x2 - ((x2 - x1) / len) * 0.25;
      const ey = y2 - ((y2 - y1) / len) * 0.25;
      el('line', {
        x1, y1, x2: ex, y2: ey,
        stroke: ARROW_COLORS[i % ARROW_COLORS.length],
        'stroke-width': 0.16,
        'stroke-linecap': 'round',
        opacity: 0.85,
        'marker-end': `url(#arrowhead-${i % ARROW_COLORS.length})`,
      }, this.arrows);
    });
  }
}
