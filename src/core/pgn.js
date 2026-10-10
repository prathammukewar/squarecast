// PGN text for a recorded game. We write it ourselves rather than use
// chess.js's pgn(), whose line wrapping drops spaces next to comments.

const ROSTER = ['Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result'];
export const RESULTS = ['1-0', '0-1', '1/2-1/2', '*'];

export function formatPgn({ headers = {}, moves = [], result = '*', startPly = 0, fen = null, width = 80 }) {
  if (!RESULTS.includes(result)) throw new Error(`Unknown result ${result}`);
  const tags = { Event: '?', Site: '?', Date: '????.??.??', Round: '?', White: '?', Black: '?', ...headers, Result: result };
  if (fen) {
    tags.SetUp = '1';
    tags.FEN = fen;
  }
  const lines = [];
  for (const key of ROSTER) lines.push(tag(key, tags[key]));
  for (const [key, value] of Object.entries(tags)) {
    if (!ROSTER.includes(key) && value !== undefined && value !== null && value !== '') lines.push(tag(key, value));
  }
  const tokens = [];
  moves.forEach((san, i) => {
    const ply = startPly + i;
    const number = Math.floor(ply / 2) + 1;
    if (ply % 2 === 0) tokens.push(`${number}.`);
    else if (i === 0) tokens.push(`${number}...`);
    tokens.push(san);
  });
  tokens.push(result);
  return `${lines.join('\n')}\n\n${wrap(tokens, width)}\n`;
}

function tag(key, value) {
  return `[${key} "${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
}

function wrap(tokens, width) {
  const out = [];
  let line = '';
  for (const t of tokens) {
    if (line && line.length + 1 + t.length > width) {
      out.push(line);
      line = t;
    } else {
      line = line ? `${line} ${t}` : t;
    }
  }
  if (line) out.push(line);
  return out.join('\n');
}

// PGN date format: YYYY.MM.DD
export function pgnDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
}
