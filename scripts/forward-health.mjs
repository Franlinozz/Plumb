#!/usr/bin/env node
/** Verify that every required public forward-data stream has a recent durable observation. */

import { existsSync } from 'node:fs';

import Database from 'better-sqlite3';

const dbPath = process.env.PLUMB_FORWARD_DB ??
  new URL('../data/forward-observations.db', import.meta.url).pathname;
const maxAgeMs = Number(process.env.PLUMB_FORWARD_MAX_AGE_MS ?? 150_000);
if (!Number.isFinite(maxAgeMs) || maxAgeMs < 60_000) {
  throw new Error('PLUMB_FORWARD_MAX_AGE_MS must be at least 60000');
}
if (!existsSync(dbPath)) throw new Error(`forward database is absent: ${dbPath}`);

const instruments = ['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP'];
const pointKinds = [
  'ticker',
  'order_book',
  'mark_price',
  'index_price',
  'funding',
  'open_interest',
  'instrument_metadata',
];
const expected = new Map();
for (const instrument of instruments) {
  for (const kind of pointKinds) expected.set(`${kind}:${instrument}:`, maxAgeMs);
  expected.set(`candle:${instrument}:1m`, Math.max(maxAgeMs, 2 * 60_000));
  expected.set(`candle:${instrument}:1H`, 2 * 3_600_000);
  expected.set(`candle:${instrument}:4H`, 2 * 14_400_000);
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
try {
  const rows = db.prepare(`
    SELECT kind, instrument, timeframe, max(recorded_at) AS recorded_at, count(*) AS samples
    FROM market_observations
    GROUP BY kind, instrument, timeframe
  `).all();
  const tradeRows = db.prepare(`
    SELECT instrument, max(recorded_at) AS recorded_at, count(*) AS samples
    FROM market_trades
    GROUP BY instrument
  `).all();
  const now = Date.now();
  const observed = new Map(rows.map((row) => [
    `${row.kind}:${row.instrument}:${row.timeframe}`,
    row,
  ]));
  for (const row of tradeRows) observed.set(`trade:${row.instrument}:`, row);
  for (const instrument of instruments) expected.set(`trade:${instrument}:`, maxAgeMs);
  const missing = [...expected.keys()].filter((key) => !observed.has(key));
  const stale = [...expected].flatMap(([key, budgetMs]) => {
    const row = observed.get(key);
    if (row === undefined) return [];
    const ageMs = now - Number(row.recorded_at);
    return ageMs > budgetMs ? [{ key, ageMs, budgetMs }] : [];
  });
  const minimumSamples = Math.min(...[...expected.keys()].map((key) => Number(observed.get(key)?.samples ?? 0)));
  const result = {
    ts: new Date(now).toISOString(),
    event: 'forward_market_health',
    ok: missing.length === 0 && stale.length === 0,
    streams: expected.size,
    minimumSamples,
    maxAgeMs,
    missing,
    stale,
  };
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
} finally {
  db.close();
}
