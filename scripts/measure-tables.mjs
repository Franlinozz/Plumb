#!/usr/bin/env node
/**
 * MEASURE FIRST.
 *
 * Two tables the phase requires BEFORE any rule is trusted:
 *
 *   1. the four OI states, their frequency and their forward-return distribution
 *   2. return and volatility by hour-of-day, per instrument
 *
 * Both are computed on the DEVELOPMENT SET ONLY. The holdout is not read.
 *
 *   node scripts/measure-tables.mjs [--tf 1H]
 */

import { CandleStore, tradableUniverse } from '@plumb/market';
import { classifyOiState } from '@plumb/strategy';
import { classifyHistory, partition, regimeAt, regimeShares } from '@plumb/backtest';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};
const tf = arg('tf', '1H');
const store = new CandleStore(process.env.PLUMB_DB_PATH ?? './data/plumb.db');

const all = {};
for (const instId of tradableUniverse()) all[instId] = store.getCandles(instId, tf);
const dataFrom = Math.min(...Object.values(all).map((c) => c[0].ts));
const dataTo = Math.max(...Object.values(all).map((c) => c.at(-1).ts));
const split = partition(dataFrom, dataTo);

console.log(`\ndevelopment set only: ${new Date(split.developmentFrom).toISOString().slice(0, 10)} → ` +
  `${new Date(split.developmentTo).toISOString().slice(0, 10)}  (holdout ${new Date(split.holdoutFrom).toISOString().slice(0, 10)} → ` +
  `${new Date(split.holdoutTo).toISOString().slice(0, 10)} NOT READ)\n`);

const dev = {};
for (const instId of tradableUniverse()) {
  dev[instId] = all[instId].filter((c) => c.ts <= split.developmentTo);
}

// ── Regime shares over the development set, for context. ──────────────────────────────────
console.log('REGIME SHARES (development set, trailing 90d classification)');
const classified = {};
for (const instId of tradableUniverse()) {
  classified[instId] = classifyHistory(dev[instId]);
  const s = regimeShares(classified[instId]);
  console.log(`  ${instId.padEnd(16)} bull ${(s.bull * 100).toFixed(1)}%  bear ${(s.bear * 100).toFixed(1)}%  chop ${(s.chop * 100).toFixed(1)}%`);
}

// ── TABLE 1 — the four OI states. ─────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(96));
console.log('TABLE 1 — OPEN-INTEREST STATES: frequency and forward returns');
console.log('='.repeat(96));

const oiAvailable = tradableUniverse().every((i) => store.getFundingRates(i).length > 0);
console.log(
  '\nNOTE: the candle store holds no historical OPEN-INTEREST series — P1 fetched OI live but\n' +
    'never persisted it, and OKX\'s rubik OI-history endpoint is capped at ~1,440 recent points.\n' +
    'The four-state table below therefore uses VOLUME as the order-flow proxy, which is NOT the\n' +
    'same measurement: volume says how much traded, open interest says whether positions were\n' +
    'opened or closed. Treat this table as indicative only, and read the oi_divergence result in\n' +
    'that light.\n',
);

const FORWARD = [1, 4, 12];
for (const instId of tradableUniverse()) {
  const candles = dev[instId];
  const buckets = new Map();
  const lookback = 6;

  for (let i = lookback; i < candles.length - Math.max(...FORWARD); i += 1) {
    const now = candles[i];
    const then = candles[i - lookback];
    const priceChange = (now.close - then.close) / then.close;
    // Volume proxy: rising participation stands in for rising open interest.
    const volNow = candles.slice(i - lookback + 1, i + 1).reduce((s, c) => s + c.volume, 0);
    const volThen = candles.slice(i - 2 * lookback + 1, i - lookback + 1).reduce((s, c) => s + c.volume, 0);
    if (volThen === 0) continue;
    const flowChange = (volNow - volThen) / volThen;

    const state = classifyOiState(priceChange, flowChange, 0.001);
    if (!buckets.has(state)) buckets.set(state, { n: 0, fwd: FORWARD.map(() => []) });
    const b = buckets.get(state);
    b.n += 1;
    FORWARD.forEach((h, k) => {
      const future = candles[i + h];
      if (future !== undefined) b.fwd[k].push((future.close - now.close) / now.close);
    });
  }

  const total = [...buckets.values()].reduce((s, b) => s + b.n, 0);
  console.log(`\n${instId}  (${total} classified bars)`);
  console.log(`  ${'state'.padEnd(18)}${'freq'.padStart(8)}${'  +1b mean'.padStart(12)}${'+4b mean'.padStart(11)}${'+12b mean'.padStart(12)}${'+12b win%'.padStart(11)}`);
  for (const state of ['new_longs', 'short_covering', 'new_shorts', 'long_liquidation', 'flat']) {
    const b = buckets.get(state);
    if (b === undefined) continue;
    const means = b.fwd.map((xs) => (xs.length === 0 ? 0 : (xs.reduce((a, c) => a + c, 0) / xs.length) * 100));
    const wins = b.fwd[2].filter((x) => x > 0).length;
    const winPct = b.fwd[2].length === 0 ? 0 : (wins / b.fwd[2].length) * 100;
    console.log(
      `  ${state.padEnd(18)}${((b.n / total) * 100).toFixed(1).padStart(7)}%` +
        `${means[0].toFixed(4).padStart(12)}${means[1].toFixed(4).padStart(11)}${means[2].toFixed(4).padStart(12)}` +
        `${winPct.toFixed(1).padStart(10)}%`,
    );
  }
}

// ── TABLE 2 — hour of day. ────────────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(96));
console.log('TABLE 2 — RETURN AND VOLATILITY BY HOUR OF DAY (UTC)');
console.log('  funding settles at 00:00 / 08:00 / 16:00 UTC — marked *');
console.log('='.repeat(96));

const hourStats = {};
for (const instId of tradableUniverse()) {
  const candles = dev[instId];
  const byHour = Array.from({ length: 24 }, () => ({ rets: [], byRegime: { bull: [], bear: [], chop: [] } }));
  for (let i = 1; i < candles.length; i += 1) {
    const c = candles[i];
    const prev = candles[i - 1];
    if (prev.close <= 0) continue;
    const ret = (c.close - prev.close) / prev.close;
    const hour = new Date(c.ts).getUTCHours();
    byHour[hour].rets.push(ret);
    const regime = regimeAt(classified[instId], c.ts);
    if (regime !== undefined) byHour[hour].byRegime[regime].push(ret);
  }
  hourStats[instId] = byHour;
}

const mean = (xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const sd = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length);
};

console.log(`\n  ${'hr'.padStart(3)}  ${tradableUniverse().map((i) => `${i.split('-')[0]} mean bp / vol bp`.padEnd(26)).join('')}`);
const survivors = [];
for (let h = 0; h < 24; h += 1) {
  const marks = [0, 8, 16].includes(h) ? '*' : ' ';
  const cells = [];
  for (const instId of tradableUniverse()) {
    const s = hourStats[instId][h];
    cells.push(`${(mean(s.rets) * 10_000).toFixed(2).padStart(8)} / ${(sd(s.rets) * 10_000).toFixed(1).padStart(7)}   `.padEnd(26));
  }
  console.log(`  ${String(h).padStart(2)}${marks} ${cells.join('')}`);

  // Does this hour survive regime segmentation on ALL instruments, same sign?
  const signs = [];
  for (const instId of tradableUniverse()) {
    const s = hourStats[instId][h];
    const pooled = mean(s.rets);
    const bull = mean(s.byRegime.bull);
    const bear = mean(s.byRegime.bear);
    const chop = mean(s.byRegime.chop);
    const consistent =
      Math.sign(pooled) !== 0 &&
      Math.sign(bull) === Math.sign(pooled) &&
      Math.sign(bear) === Math.sign(pooled) &&
      Math.sign(chop) === Math.sign(pooled) &&
      Math.abs(pooled) > 0.0002; // 2bp — below this it is noise at any sample size
    signs.push(consistent ? Math.sign(pooled) : 0);
  }
  if (signs.every((x) => x === 1) || signs.every((x) => x === -1)) survivors.push({ hour: h, sign: signs[0] });
}

console.log('\nHOURS SURVIVING REGIME SEGMENTATION (same sign in bull, bear AND chop, on all three, >2bp):');
if (survivors.length === 0) {
  console.log('  NONE.');
  console.log('  → NULL RESULT. There is no hour-of-day effect in this data that survives regime');
  console.log('    segmentation on all three instruments. session_bias is RETIRED, not built.');
} else {
  for (const s of survivors) console.log(`  hour ${String(s.hour).padStart(2)} UTC  sign ${s.sign > 0 ? '+' : '-'}`);
}

store.close();
