#!/usr/bin/env node
/** Read-only public-data monitor for the frozen v3 research candidate. */

import { createSeededIdFactory } from '@plumb/core';
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
  aggregateClosedFourHour,
  classifyFourHourTrend,
  COMPETITION_TREND_PULLBACK_ID,
  DEFAULT_STRATEGY_CONFIG,
  STRATEGY_IDS,
  competitionTrendPullback,
  runCycle,
} from '@plumb/strategy';

const allowedInstruments = new Set(['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP']);
const instrument = process.argv[2] ?? 'ETH-USDT-SWAP';
if (!allowedInstruments.has(instrument)) {
  throw new Error(`unsupported competition monitor instrument: ${instrument}`);
}
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

const changeFrom = (hours) => openInterestChangeOverWindow(
  openInterest, oiHistory, hours * 3_600_000,
);
const priceChangePct24h = ticker.open24h === 0 ? Number.NaN : ticker.last / ticker.open24h - 1;
const oiChangePct1h = changeFrom(1);
const oiChangePct4h = changeFrom(4);
const oiChangePct24h = changeFrom(24);
const signal = cycle.signals[0];
const participationConfirmed = signal === undefined ? false :
  oiChangePct1h > 0.001 && oiChangePct4h > 0.001 && oiChangePct24h > 0.001 &&
  (signal.side === 'long' ? priceChangePct24h > 0.001 : priceChangePct24h < -0.001);
const publicPreparationReady = signal !== undefined && participationConfirmed;

// Explain the frozen strategy's exact closed-bar gates. This is diagnostic only: these values
// cannot create, approve, publish or execute a signal.
const hourly = seriesFor(snapshot, '1H') ?? [];
const price = closes(hourly);
const hourlyEma = ema(price, 20);
const hourlyRsi = rsi(price, 14);
const histogram = macd(price, 12, 26, 9).histogram;
const i = hourly.length - 1;
const current = hourly[i];
const previous = hourly[i - 1];
const priorVolume = hourly.slice(Math.max(0, i - 20), i).map((bar) => bar.volume);
const priorVolumeMean = priorVolume.length === 0
  ? undefined
  : priorVolume.reduce((sum, value) => sum + value, 0) / priorVolume.length;
const trend = classifyFourHourTrend(aggregateClosedFourHour(hourly));
const emaNow = hourlyEma[i];
const emaPrevious = hourlyEma[i - 1];
const rsiNow = hourlyRsi[i];
const histogramNow = histogram[i];
const histogramPrevious = histogram[i - 1];
const volumeRatio = current === undefined || priorVolumeMean === undefined || priorVolumeMean === 0
  ? undefined
  : current.volume / priorVolumeMean;
const longGates = {
  fourHourTrendUp: trend.direction === 'up',
  priorCloseAtOrBelowEma20: previous !== undefined && emaPrevious !== undefined && previous.close <= emaPrevious,
  currentCloseAboveEma20: current !== undefined && emaNow !== undefined && current.close > emaNow,
  continuationAbovePriorHigh: current !== undefined && previous !== undefined && current.close > previous.high,
  rsiInBand50To68: rsiNow !== undefined && rsiNow >= 50 && rsiNow <= 68,
  macdPositiveAndImproving: histogramNow !== undefined && histogramPrevious !== undefined &&
    histogramNow > 0 && histogramNow > histogramPrevious,
  volumeAtLeast80PctMean: volumeRatio !== undefined && volumeRatio >= 0.8,
  oiOneHourPositive: oiChangePct1h > 0.001,
  oiFourHourPositive: oiChangePct4h > 0.001,
  oiTwentyFourHourPositive: oiChangePct24h > 0.001,
};
const shortGates = {
  fourHourTrendDown: trend.direction === 'down',
  priorCloseAtOrAboveEma20: previous !== undefined && emaPrevious !== undefined && previous.close >= emaPrevious,
  currentCloseBelowEma20: current !== undefined && emaNow !== undefined && current.close < emaNow,
  continuationBelowPriorLow: current !== undefined && previous !== undefined && current.close < previous.low,
  rsiInBand32To50: rsiNow !== undefined && rsiNow >= 32 && rsiNow <= 50,
  macdNegativeAndWorsening: histogramNow !== undefined && histogramPrevious !== undefined &&
    histogramNow < 0 && histogramNow < histogramPrevious,
  volumeAtLeast80PctMean: volumeRatio !== undefined && volumeRatio >= 0.8,
  oiOneHourPositive: oiChangePct1h > 0.001,
  oiFourHourPositive: oiChangePct4h > 0.001,
  oiTwentyFourHourPositive: oiChangePct24h > 0.001,
};

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
  triggerDiagnostics: {
    values: {
      fourHourTrend: trend.direction,
      oneHourClose: current?.close ?? null,
      oneHourEma20: emaNow ?? null,
      oneHourRsi: rsiNow ?? null,
      oneHourMacdHistogram: histogramNow ?? null,
      oneHourMacdHistogramPrevious: histogramPrevious ?? null,
      oneHourVolumeRatio: volumeRatio ?? null,
    },
    longGates,
    shortGates,
  },
  amendmentAuthorised: true,
  publicPreparationReady,
  executionEligible: false,
  blocker: publicPreparationReady
    ? 'public setup ready; private account reconciliation, DecisionEvent, A2A delivery and exact live confirmation remain required'
    : 'frozen closed-bar strategy or multi-horizon participation confirmation is absent',
  requests: client.stats.requests,
}));
