#!/usr/bin/env node
/** Read-only public-data monitor for the frozen v3 research candidate. */

import { createSeededIdFactory } from '@plumb/core';
import { buildSnapshot, OkxPublicClient } from '@plumb/market';
import {
  COMPETITION_TREND_PULLBACK_ID,
  DEFAULT_STRATEGY_CONFIG,
  STRATEGY_IDS,
  competitionTrendPullback,
  runCycle,
} from '@plumb/strategy';

const instrument = 'ETH-USDT-SWAP';
const now = Date.now();
const client = new OkxPublicClient();
const closed = (rows) => rows.filter((row) => row.closed);

const [oneHour, fourHour, ticker, markPrice, funding, fundingHistory, openInterest, rawOiHistory] =
  await Promise.all([
    client.candles(instrument, '1H', { limit: 300 }),
    client.candles(instrument, '4H', { limit: 100 }),
    client.ticker(instrument),
    client.markPrice(instrument),
    client.fundingRate(instrument),
    client.fundingRateHistory(instrument, { limit: 100 }),
    client.openInterest(instrument),
    client.openInterestHistory(instrument, '1H', { limit: 25 }),
  ]);

const oiHistory = [...rawOiHistory].sort((a, b) => a.ts - b.ts);
const snapshot = buildSnapshot({
  now,
  instId: instrument,
  ticker,
  markPrice,
  funding,
  fundingHistory,
  openInterest,
  openInterestHistory: oiHistory,
  candles: [
    { tf: '1H', ohlcv: closed(oneHour) },
    { tf: '4H', ohlcv: closed(fourHour) },
  ],
});
const enabled = Object.fromEntries([
  ...STRATEGY_IDS.map((id) => [id, false]),
  [COMPETITION_TREND_PULLBACK_ID, true],
]);
const config = { ...DEFAULT_STRATEGY_CONFIG, enabled };
const cycle = runCycle(snapshot, {
  now,
  newId: createSeededIdFactory(Math.floor(now / 3_600_000)),
  config,
  modules: [competitionTrendPullback],
  regimeTimeframe: '4H',
});

const changeFrom = (hours) => {
  const threshold = now - hours * 3_600_000;
  const base = oiHistory.find((row) => row.ts >= threshold) ?? oiHistory[0];
  return base === undefined || base.oi === 0 ? Number.NaN : openInterest.oi / base.oi - 1;
};
const priceChangePct24h = ticker.open24h === 0 ? Number.NaN : ticker.last / ticker.open24h - 1;
const oiChangePct1h = changeFrom(1);
const oiChangePct4h = changeFrom(4);
const oiChangePct24h = changeFrom(24);
const signal = cycle.signals[0];
const participationConfirmed = signal === undefined ? false :
  oiChangePct1h > 0.001 && oiChangePct4h > 0.001 && oiChangePct24h > 0.001 &&
  (signal.side === 'long' ? priceChangePct24h > 0.001 : priceChangePct24h < -0.001);

console.log(JSON.stringify({
  ts: new Date(now).toISOString(),
  event: 'competition_v3_read_only_monitor',
  instrument,
  market: {
    last: ticker.last,
    priceChangePct24h,
    openInterestChangePct1h: oiChangePct1h,
    openInterestChangePct4h: oiChangePct4h,
    openInterestChangePct24h: oiChangePct24h,
    fundingRate: funding.fundingRate,
    spreadBps: (ticker.askPx - ticker.bidPx) / ticker.last * 10_000,
  },
  closedBars: {
    oneHourAt: new Date(closed(oneHour).at(-1)?.ts ?? 0).toISOString(),
    fourHourAt: new Date(closed(fourHour).at(-1)?.ts ?? 0).toISOString(),
    fourHourAdx: snapshot.indicators['4H']?.adx ?? null,
    fourHourRsi: snapshot.indicators['4H']?.rsi ?? null,
    oneHourRsi: snapshot.indicators['1H']?.rsi ?? null,
  },
  strategyProbe: {
    draftCount: cycle.draftCount,
    approvedSignalCount: cycle.signals.length,
    rejectionCodes: cycle.rejected.map((rejection) => rejection.code),
    side: signal?.side ?? null,
    entry: signal?.entry.price ?? null,
    stop: signal?.stop.price ?? null,
    takeProfit: signal?.takeProfit?.[0]?.price ?? null,
    participationConfirmed,
  },
  executionEligible: false,
  blocker: 'research candidate has no independent holdout and OKX attribution warning is unresolved',
  requests: client.stats.requests,
}));
