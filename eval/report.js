// Saves evaluation results per commit, so a regression shows up as a
// changed row next to the commit that caused it.

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';

const DIR = new URL('./results/', import.meta.url);

export function commitId() {
  try {
    const sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const dirty = execSync('git status --porcelain -- src eval', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return 'uncommitted';
  }
}

const COLUMNS = [
  ['recording', (r) => r.name],
  ['moves', (r) => r.moves],
  ['auto', (r) => `${(100 * r.autoRate).toFixed(1)}%`],
  ['tapped', (r) => r.tapped],
  ['manual', (r) => r.manual],
  ['missed', (r) => r.missed],
  ['wrong', (r) => r.wrong],
  ['prompts', (r) => r.prompts],
  ['bad prompts', (r) => r.badPrompts],
  ['chip taps', (r) => r.chipTaps],
  ['alerts', (r) => r.mismatches],
  ['p50 ms', (r) => r.latencyMedian ?? ''],
  ['p95 ms', (r) => r.latencyP95 ?? ''],
];

export function markdownTable(rows) {
  const head = `| ${COLUMNS.map(([h]) => h).join(' | ')} |`;
  const rule = `| ${COLUMNS.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${COLUMNS.map(([, f]) => f(r)).join(' | ')} |`);
  return [head, rule, ...body].join('\n');
}

export function saveResults(kind, rows) {
  mkdirSync(DIR, { recursive: true });
  const id = commitId();
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const file = new URL(`${kind}-${id}.md`, DIR);
  writeFileSync(file, `# ${kind} results, ${id}\n\nRun ${stamp}.\n\n${markdownTable(rows)}\n`);
  const csv = new URL('history.csv', DIR);
  if (!existsSync(csv)) appendFileSync(csv, `time,commit,kind,${COLUMNS.map(([h]) => h).join(',')}\n`);
  for (const r of rows) appendFileSync(csv, `${stamp},${id},${kind},${COLUMNS.map(([, f]) => f(r)).join(',')}\n`);
  return file.pathname;
}
