#!/usr/bin/env node
/** Read-only public-data monitor for the operator-authorised post-cutoff contingency. */

import { createSeededIdFactory, FINAL_WINDOW_CONTINGENCY_AMENDMENT } from '@plumb/core';
import {
  buildSnapshot,
  closes,
  ema,
  macd,
  OkxPublicClient,
  openInterestChangeOverWindow,
  rsi,
  seriesFor,
} from '@plumb/market';
import {
  DEFAULT_STRATEGY_CONFIG,
  STRATEGY_IDS,
  aggregateClosedFourHour,
  classifyFourHourTrend,
  finalWindowContingency,
  FINAL_WINDOW_CONTINGENCY_ID,
  runCycle,
} from '@plumb/strategy';

const instrument = process.argv[2];
if (!FINAL_WINDOW_CONTINGENCY_AMENDMENT.instruments.includes(instrument)) {
  throw new Error('usage: competition-deadline-contingency-monitor.mjs <ETH-USDT-SWAP|SOL-USDT-SWAP>');
}
const now = Date.now();
const client = new OkxPublicClient();
const closed = (rows) => rows.filter((row) => row.closed);

const [oneHour, ticker, markPrice, funding, fundingHistory, openInterest, rawOiHistory] =
  await Promise.all([
    client.candles(instrument, '1H', { limit: 300 }),
    client.ticker(instrument),
    client.markPrice(instrument),
    client.fundingRate(instrument),
    client.fundingRateHistory(instrument, { limit: 100 }),
    client.openInterest(instrument),
    client.openInterestHistory(instrument, '1H', { limit: 25 }),
  ]);
const closedHourly = closed(oneHour);
const aggregatedFourHour = aggregateClosedFourHour(closedHourly);
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
    { tf: '1H', ohlcv: closedHourly },
    { tf: '4H', ohlcv: aggregatedFourHour },
  ],
});
const enabled = Object.fromEntries([
  ...STRATEGY_IDS.map((id) => [id, false]),
  [FINAL_WINDOW_CONTINGENCY_ID, true],
]);
const config = {
  ...DEFAULT_STRATEGY_CONFIG,
  enabled,
  gate: { ...DEFAULT_STRATEGY_CONFIG.gate, minRegimeConfidence: 0 },
};
const cycle = runCycle(snapshot, {
  now,
  newId: createSeededIdFactory(Math.floor(now / 3_600_000)),
  config,
  modules: [finalWindowContingency],
  regimeTimeframe: '4H',
});

const changeFrom = (hours) => openInterestChangeOverWindow(
  openInterest, oiHistory, hours * 3_600_000,
);
const oi1h = changeFrom(1);
const oi4h = changeFrom(4);
const oi24h = changeFrom(24);
const price24h = ticker.open24h === 0 ? Number.NaN : ticker.last / ticker.open24h - 1;
const spreadBps = (ticker.askPx - ticker.bidPx) / ticker.last * 10_000;
const signal = cycle.signals[0];
const entryTolerance = signal === undefined ? 0 :
  signal.entry.price * FINAL_WINDOW_CONTINGENCY_AMENDMENT.maxEntryToleranceBps / 10_000;
const liveEntryInRange = signal !== undefined &&
  ticker.last >= signal.entry.price - entryTolerance &&
  ticker.last <= signal.entry.price + entryTolerance;
const priceNotOpposed = signal === undefined ? false : signal.side === 'long'
  ? price24h >= -FINAL_WINDOW_CONTINGENCY_AMENDMENT.maxOpposingPriceChangePct24h
  : price24h <= FINAL_WINDOW_CONTINGENCY_AMENDMENT.maxOpposingPriceChangePct24h;
const liveVetoesClear = signal !== undefined &&
  oi1h >= FINAL_WINDOW_CONTINGENCY_AMENDMENT.minOneHourOiChangePct &&
  oi4h >= FINAL_WINDOW_CONTINGENCY_AMENDMENT.minFourHourOiChangePct &&
  oi24h >= FINAL_WINDOW_CONTINGENCY_AMENDMENT.minTwentyFourHourOiChangePct &&
  spreadBps <= FINAL_WINDOW_CONTINGENCY_AMENDMENT.maxSpreadBps &&
  Math.abs(funding.fundingRate) <= FINAL_WINDOW_CONTINGENCY_AMENDMENT.maxAbsFundingRate &&
  priceNotOpposed && liveEntryInRange;
const publicPreparationReady = signal !== undefined && liveVetoesClear;

const hourly = seriesFor(snapshot, '1H') ?? [];
const price = closes(hourly);
const ema20 = ema(price, 20);
const rsi14 = rsi(price, 14);
const histogram = macd(price, 12, 26, 9).histogram;
const i = hourly.length - 1;
const current = hourly[i];
const previous = hourly[i - 1];
const priorVolume = hourly.slice(Math.max(0, i - 20), i).map((bar) => bar.volume);
const priorVolumeMean = priorVolume.length === 0
  ? undefined
  : priorVolume.reduce((sum, value) => sum + value, 0) / priorVolume.length;
const volumeRatio = current === undefined || priorVolumeMean === undefined || priorVolumeMean === 0
  ? undefined
  : current.volume / priorVolumeMean;
const trend = classifyFourHourTrend(aggregatedFourHour);
const values = {
  fourHourTrend: trend.direction,
  fourHourAdx: trend.adx ?? null,
  oneHourClose: current?.close ?? null,
  oneHourPreviousClose: previous?.close ?? null,
  oneHourEma20: ema20[i] ?? null,
  oneHourRsi: rsi14[i] ?? null,
  oneHourMacdHistogram: histogram[i] ?? null,
  oneHourMacdHistogramPrevious: histogram[i - 1] ?? null,
  oneHourVolumeRatio: volumeRatio ?? null,
};

console.log(JSON.stringify({
  ts: new Date(now).toISOString(),
  event: 'deadline_contingency_read_only_monitor',
  instrument,
  window: {
    open: now >= FINAL_WINDOW_CONTINGENCY_AMENDMENT.earliestEntryAt &&
      now < FINAL_WINDOW_CONTINGENCY_AMENDMENT.latestEntryAt,
    opensAt: new Date(FINAL_WINDOW_CONTINGENCY_AMENDMENT.earliestEntryAt).toISOString(),
    closesAt: new Date(FINAL_WINDOW_CONTINGENCY_AMENDMENT.latestEntryAt).toISOString(),
  },
  market: {
    last: ticker.last,
    priceChangePct24h: price24h,
    openInterestChangePct1h: oi1h,
    openInterestChangePct4h: oi4h,
    openInterestChangePct24h: oi24h,
    fundingRate: funding.fundingRate,
    spreadBps,
  },
  closedBars: {
    oneHourAt: new Date(closedHourly.at(-1)?.ts ?? 0).toISOString(),
    fourHourAt: new Date(aggregatedFourHour.at(-1)?.ts ?? 0).toISOString(),
  },
  strategyProbe: {
    draftCount: cycle.draftCount,
    approvedSignalCount: cycle.signals.length,
    rejectionCodes: cycle.rejected.map((item) => item.code),
    side: signal?.side ?? null,
    entry: signal?.entry.price ?? null,
    stop: signal?.stop.price ?? null,
    takeProfit: signal?.takeProfit?.[0]?.price ?? null,
    liveEntryInRange,
    liveVetoesClear,
  },
  triggerDiagnostics: { values },
  publicPreparationReady,
  executionEligible: false,
  blocker: publicPreparationReady
    ? 'public setup ready; private account, governor, publication and venue checks remain required'
    : 'closed-bar contingency rule or live unwind/cost veto is not clear',
  requests: client.stats.requests,
}));
