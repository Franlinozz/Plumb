#!/usr/bin/env node
/**
 * Compare Plumb's local indicators against the OKX Agent Trade Kit's server-side ones.
 *
 * AGENTS.md gotcha 10: every external reference is verified live, not assumed. We compute
 * indicators locally so `strategy` is replayable in backtest — but "replayable" is worthless if
 * our numbers disagree with the venue's. This script measures the disagreement instead of
 * assuming there is none, and the findings go in the phase CHECKPOINT and the Deviations log.
 *
 * The Trade Kit's market module needs NO API key, so this respects guardrail 10.
 *
 * Requires the CLI at $PLUMB_ATK_BIN (default /root/.plumb/atk/node_modules/.bin/okx).
 *
 *   node scripts/indicator-divergence.mjs [INST] [BAR]
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { OkxPublicClient, adx, atr, bollinger, closes, ema, macd, rsi, sma } from '@plumb/market';

const run = promisify(execFile);
const ATK = process.env.PLUMB_ATK_BIN ?? '/root/.plumb/atk/node_modules/.bin/okx';

const instId = process.argv[2] ?? 'BTC-USDT-SWAP';
const bar = process.argv[3] ?? '1H';
const LIMIT = 20;

async function tradeKit(indicator, params) {
  const args = ['market', 'indicator', indicator, instId, '--bar', bar, '--list', '--limit', String(LIMIT), '--json'];
  if (params !== undefined) args.push('--params', params);
  const { stdout } = await run(ATK, args, { maxBuffer: 8 * 1024 * 1024 });
  const parsed = JSON.parse(stdout);
  const byName = parsed[0].data[0].timeframes[bar].indicators;
  const key = Object.keys(byName)[0];
  const rows = new Map();
  for (const row of byName[key]) rows.set(Number(row.ts), row.values);
  return rows;
}

const client = new OkxPublicClient();
const candles = await client.candles(instId, bar, { limit: 300 });
const price = closes(candles);
const tsIndex = new Map(candles.map((c, i) => [c.ts, i]));
// The newest bar is still forming; both sides may have sampled it a second apart.
const newestTs = candles.at(-1).ts;

const bands = bollinger(price, 20, 2);
const macdResult = macd(price, 12, 26, 9);
const directional = adx(candles, 14);

/** name -> { theirs(values), ours(index) } */
const COMPARISONS = [
  ['MA(14)', () => tradeKit('ma', '14'), (v) => Number(v['14']), sma(price, 14)],
  ['EMA(14)', () => tradeKit('ema', '14'), (v) => Number(v['14']), ema(price, 14)],
  ['RSI(14)', () => tradeKit('rsi', '14'), (v) => Number(v['14']), rsi(price, 14)],
  ['ATR(14)', () => tradeKit('atr', '14'), (v) => Number(v['14']), atr(candles, 14)],
  ['BB upper', () => tradeKit('boll', '20,2'), (v) => Number(v.upper), bands.upper],
  ['BB middle', () => tradeKit('boll', '20,2'), (v) => Number(v.middle), bands.middle],
  ['BB lower', () => tradeKit('boll', '20,2'), (v) => Number(v.lower), bands.lower],
  ['MACD dif', () => tradeKit('macd', '12,26,9'), (v) => Number(v.dif), macdResult.macd],
  ['MACD dea', () => tradeKit('macd', '12,26,9'), (v) => Number(v.dea), macdResult.signal],
  // OKX publishes the histogram doubled — the standard MACD-bar convention.
  ['MACD hist', () => tradeKit('macd', '12,26,9'), (v) => Number(v.macd) / 2, macdResult.histogram],
  ['ADX(14)', () => tradeKit('adx', '14'), (v) => Number(v.adx), directional.adx],
  ['+DI(14)', () => tradeKit('adx', '14'), (v) => Number(v.diPlus), directional.plusDi],
  ['-DI(14)', () => tradeKit('adx', '14'), (v) => Number(v.diMinus), directional.minusDi],
];

const cache = new Map();
async function fetchOnce(fn, key) {
  if (!cache.has(key)) cache.set(key, await fn());
  return cache.get(key);
}

console.log(`\nindicator divergence — ${instId} ${bar}, ${LIMIT} bars, local vs OKX Agent Trade Kit`);
console.log(`(their values are rounded for display, so a small relative gap is expected)\n`);
console.log(
  `  ${'indicator'.padEnd(11)}${'n'.padStart(4)}${'max abs'.padStart(12)}${'max rel'.padStart(11)}` +
    `${'their sample'.padStart(14)}${'ours'.padStart(14)}  verdict`,
);

let worst = 0;
for (const [name, fetcher, pick, ours] of COMPARISONS) {
  const key = fetcher.toString();
  let theirs;
  try {
    theirs = await fetchOnce(fetcher, key);
  } catch (error) {
    console.log(`  ${name.padEnd(11)}  UNAVAILABLE: ${error.message.split('\n')[0]}`);
    continue;
  }

  let n = 0;
  let maxAbs = 0;
  let maxRel = 0;
  let sampleTheirs;
  let sampleOurs;
  for (const [ts, values] of theirs) {
    if (ts === newestTs) continue; // still forming on both sides
    const i = tsIndex.get(ts);
    if (i === undefined) continue;
    const mine = ours[i];
    const yours = pick(values);
    if (mine === undefined || !Number.isFinite(yours)) continue;
    n += 1;
    const abs = Math.abs(mine - yours);
    const rel = Math.abs(yours) > 1e-9 ? abs / Math.abs(yours) : abs;
    if (rel > maxRel) {
      maxRel = rel;
      maxAbs = abs;
      sampleTheirs = yours;
      sampleOurs = mine;
    }
  }

  if (n === 0) {
    console.log(`  ${name.padEnd(11)}   0   no overlapping bars`);
    continue;
  }
  worst = Math.max(worst, maxRel);
  // Their display rounding alone can move a value by ~0.05 in the last printed digit.
  const verdict = maxRel < 0.001 ? 'MATCH' : maxRel < 0.01 ? 'match (rounding)' : 'DIVERGENT';
  console.log(
    `  ${name.padEnd(11)}${String(n).padStart(4)}${maxAbs.toFixed(4).padStart(12)}` +
      `${(maxRel * 100).toFixed(4).padStart(10)}%${String(sampleTheirs).padStart(14)}` +
      `${sampleOurs.toFixed(4).padStart(14)}  ${verdict}`,
  );
}

console.log(`\n  worst relative divergence across all indicators: ${(worst * 100).toFixed(4)}%`);
