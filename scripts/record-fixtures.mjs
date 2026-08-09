#!/usr/bin/env node
/**
 * Record real OKX public market data to `packages/market/fixtures/`.
 *
 * Run ONCE per phase that needs fresh fixtures. After that, tests replay these files and never
 * touch the network again (AGENTS.md § COST DISCIPLINE — and a test suite that depends on a
 * live exchange is a test suite that fails at 3am for reasons that have nothing to do with us).
 *
 * Every file stores the RAW OKX envelope `{code, msg, data}`, unedited. That is deliberate:
 * the client's parsing tests are only worth anything if they parse what the exchange actually
 * sends, including the string-typed numbers and the positional candle arrays.
 *
 *   node scripts/record-fixtures.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const OUT = join(ROOT, 'packages', 'market', 'fixtures');
const BASE = 'https://www.okx.com';

const INSTRUMENTS = ['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP'];
const TIMEFRAMES = ['15m', '1H', '4H'];
const CANDLE_LIMIT = 300;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path, params) {
  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      const body = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = JSON.parse(body);
      if (json.code !== '0') throw new Error(`OKX code ${json.code}: ${json.msg}`);
      return json;
    } catch (error) {
      if (attempt === 4) throw error;
      await sleep(500 * attempt);
    }
  }
  throw new Error('unreachable');
}

function write(instId, name, payload) {
  const dir = join(OUT, instId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.json`);
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  const rows = Array.isArray(payload.data) ? payload.data.length : 0;
  console.log(`  ${instId}/${name}.json  (${rows} rows)`);
  return rows;
}

const inventory = [];

for (const instId of INSTRUMENTS) {
  console.log(`\n${instId}`);
  const base = instId.split('-')[0];

  const jobs = [
    ['ticker', '/api/v5/market/ticker', { instId }],
    ['mark-price', '/api/v5/public/mark-price', { instType: 'SWAP', instId }],
    ['index-ticker', '/api/v5/market/index-tickers', { instId: `${base}-USD` }],
    ['funding-rate', '/api/v5/public/funding-rate', { instId }],
    ['funding-rate-history', '/api/v5/public/funding-rate-history', { instId, limit: 100 }],
    ['open-interest', '/api/v5/public/open-interest', { instType: 'SWAP', instId }],
    [
      'open-interest-history',
      '/api/v5/rubik/stat/contracts/open-interest-history',
      { instId, period: '1H', limit: 100 },
    ],
    ['price-limit', '/api/v5/public/price-limit', { instId }],
  ];

  for (const [name, path, params] of jobs) {
    const payload = await get(path, params);
    inventory.push({ instId, name, rows: write(instId, name, payload) });
    await sleep(150);
  }

  for (const bar of TIMEFRAMES) {
    const payload = await get('/api/v5/market/history-candles', {
      instId,
      bar,
      limit: CANDLE_LIMIT,
    });
    inventory.push({ instId, name: `candles-${bar}`, rows: write(instId, `candles-${bar}`, payload) });
    await sleep(150);
  }
}

const recordedAt = Date.now();
const meta = {
  recordedAt,
  recordedAtIso: new Date(recordedAt).toISOString(),
  source: BASE,
  note:
    'Real OKX public market data, recorded once. Tests replay these and never hit the network. ' +
    'Raw {code,msg,data} envelopes, unedited.',
  instruments: INSTRUMENTS,
  timeframes: TIMEFRAMES,
  candleLimit: CANDLE_LIMIT,
  inventory,
};
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);

const total = inventory.reduce((n, r) => n + r.rows, 0);
console.log(`\nmeta.json written — ${inventory.length} files, ${total} rows total.`);
