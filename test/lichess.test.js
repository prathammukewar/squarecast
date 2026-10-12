import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importGame, analysisUrl } from '../app/lichess.js';

test('import posts the PGN and asks for JSON', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ id: 'abcd1234', url: 'https://lichess.org/abcd1234' }) };
  };
  const url = await importGame('1. e4 e5 *');
  assert.equal(url, 'https://lichess.org/abcd1234');
  assert.equal(calls[0].url, 'https://lichess.org/api/import');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Accept, 'application/json');
  assert.equal(calls[0].init.body.get('pgn'), '1. e4 e5 *');
});

test('import reports a refused request', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
  await assert.rejects(importGame('1. e4 *'), /429/);
});

test('analysis link carries the moves', () => {
  assert.equal(analysisUrl(['e4', 'e5', 'Nf3']), 'https://lichess.org/analysis/pgn/e4_e5_Nf3');
  assert.ok(analysisUrl(['e4', 'Qh4#']).includes('Qh4%23'));
});
