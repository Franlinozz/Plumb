#!/usr/bin/env node
/**
 * Fetch LIVE public market data once and print a snapshot per instrument.
 *
 * This is the eyeball check the phase asks for: is the price roughly the market, is RSI inside
 * 0-100, is ATR positive and proportionate. A green test suite over recorded fixtures proves the
 * maths is self-consistent; only a live run proves it is pointed at reality.
 *
 * No credentials — every endpoint here is public.
 *
 *   node scripts/live-snapshot.mjs
 */

import {
  OkxPublicClient,
  buildSnapshot,
  isTradeable,
  tradableUniverse,
} from '@plumb/market';

const TIMEFRAMES = ['15m', '1H', '4H'];
const client = new OkxPublicClient();

const fmt = (v, dp = 2) =>
  v === undefined ? '     —' : v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });

for (const instId of tradableUniverse()) {
  const candles = [];
  for (const tf of TIMEFRAMES) {
    candles.push({ tf, ohlcv: await client.candles(instId, tf, { limit: 300 }) });
  }

  const snapshot = buildSnapshot({
    now: Date.now(),
    instId,
    ticker: await client.ticker(instId),
    markPrice: await client.markPrice(instId),
    funding: await client.fundingRate(instId),
    fundingHistory: await client.fundingRateHistory(instId, { limit: 20 }),
    openInterest: await client.openInterest(instId),
    openInterestHistory: await client.openInterestHistory(instId, '1H', { limit: 24 }),
    candles,
  });

  console.log(`\n${'='.repeat(78)}\n${instId}   ${new Date(snapshot.ts).toISOString()}`);
  console.log('='.repeat(78));
  console.log(`  last ${fmt(snapshot.last)}   mark ${fmt(snapshot.mark)}   ` +
    `basis ${fmt(((snapshot.mark - snapshot.last) / snapshot.last) * 100, 4)}%`);
  console.log(
    `  funding ${(snapshot.funding.current * 100).toFixed(4)}%  ` +
      `next settlement ${new Date(snapshot.funding.nextTime).toISOString()}  ` +
      `(${snapshot.funding.history.length} historical)`,
  );
  console.log(
    `  open interest ${fmt(snapshot.openInterest.value, 0)} contracts / ` +
      `$${fmt(snapshot.openInterest.valueUsd / 1e6, 1)}M  (${snapshot.openInterest.history.length} historical)`,
  );

  console.log(`\n  ${'tf'.padEnd(5)}${'bars'.padStart(6)}${'RSI14'.padStart(9)}${'ATR14'.padStart(11)}` +
    `${'ATR%'.padStart(8)}${'EMA20'.padStart(12)}${'EMA50'.padStart(12)}${'ADX14'.padStart(8)}${'+DI'.padStart(7)}${'-DI'.padStart(7)}`);
  for (const { tf, ohlcv } of snapshot.candles) {
    const i = snapshot.indicators[tf];
    const atrPct = i.atr === undefined ? undefined : (i.atr / snapshot.last) * 100;
    console.log(
      `  ${tf.padEnd(5)}${String(ohlcv.length).padStart(6)}${fmt(i.rsi).padStart(9)}` +
        `${fmt(i.atr).padStart(11)}${fmt(atrPct).padStart(8)}${fmt(i.emaFast).padStart(12)}` +
        `${fmt(i.emaSlow).padStart(12)}${fmt(i.adx).padStart(8)}${fmt(i.plusDi).padStart(7)}${fmt(i.minusDi).padStart(7)}`,
    );
  }

  const bb = snapshot.indicators['1H'];
  console.log(
    `\n  1H bollinger  lower ${fmt(bb.bbLower)}  mid ${fmt(bb.bbMiddle)}  upper ${fmt(bb.bbUpper)}  ` +
      `bandwidth ${fmt(bb.bbBandwidth, 4)}`,
  );
  console.log(`  1H macd ${fmt(bb.macd, 3)}  signal ${fmt(bb.macdSignal, 3)}  hist ${fmt(bb.macdHistogram, 3)}` +
    `   realised vol ${fmt(bb.realisedVol, 5)}`);

  const ages = Object.entries(snapshot.dataAge)
    .map(([field, a]) => `${field} ${(a.ageMs / 1000).toFixed(1)}s/${(a.budgetMs / 1000).toFixed(0)}s`)
    .join('  ');
  console.log(`\n  data age: ${ages}`);
  console.log(
    `  degraded: ${snapshot.degraded}` +
      (snapshot.degraded ? ` (${snapshot.degradedFields.join(', ')})` : '') +
      `   TRADEABLE: ${isTradeable(snapshot)}`,
  );
}

console.log(`\nrequests: ${client.stats.requests}  attempts: ${client.stats.attempts}  retries: ${client.stats.retries}`);
