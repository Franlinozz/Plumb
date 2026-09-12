#!/usr/bin/env node
/**
 * Read-only monitor for the operator-authorised first-trade amendment.
 *
 * It may report a candidate setup; it cannot create a DecisionEvent, publish a signal, read account
 * credentials, or place an order. The failed protected holdout remains an unconditional blocker.
 */

import { COMPETITION_V2_AMENDMENT, createSeededIdFactory } from '@plumb/core';
import { buildSnapshot, OkxPublicClient, openInterestChangeOverWindow } from '@plumb/market';
import {
  DEFAULT_STRATEGY_CONFIG,
  EMERGENCY_PARTICIPATION_ID,
  STRATEGY_IDS,
  classifyRegime,
  emergencyParticipation,
  runCycle,
} from '@plumb/strategy';

const instrument = COMPETITION_V2_AMENDMENT.instrument;
const now = Date.now();
if (now >= COMPETITION_V2_AMENDMENT.latestEntryAt) {
  console.log(JSON.stringify({
    ts: new Date(now).toISOString(),
    event: 'competition_v2_read_only_monitor',
    instrument,
    executionEligible: false,
    blocker: 'operator-authorised entry window is closed; public-data collection stopped',
    requests: 0,
  }));
  process.exit(0);
}
const client = new OkxPublicClient();
const closed = (rows) => rows.filter((row) => row.closed);

const [oneHour, fourHour, ticker, markPrice, funding, fundingHistory, openInterest, rawOiHistory] =
  await Promise.all([
    client.candles(instrument, '1H', { limit: 300 }),
    client.candles(instrument, '4H', { limit: 300 }),
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
  [EMERGENCY_PARTICIPATION_ID, true],
]);
const config = {
  ...DEFAULT_STRATEGY_CONFIG,
  enabled,
};
const cycle = runCycle(snapshot, {
  now,
  newId: createSeededIdFactory(Math.floor(now / 3_600_000)),
  config,
  modules: [emergencyParticipation],
  regimeTimeframe: '4H',
});
const fourHourRegime = classifyRegime(snapshot, '4H', config.regime);
const fourHourIndicators = snapshot.indicators['4H'];
const emaDirection = fourHourIndicators?.emaFast === undefined || fourHourIndicators.emaSlow === undefined
  ? 'unclear'
  : fourHourIndicators.emaFast > fourHourIndicators.emaSlow ? 'up' : 'down';
const oiChangePct24h = openInterestChangeOverWindow(openInterest, oiHistory, 24 * 3_600_000);
const priceChangePct24h = ticker.open24h === 0 ? Number.NaN : ticker.last / ticker.open24h - 1;
const signal = cycle.signals[0];
const directionConfirmed = signal === undefined ? false : signal.side === 'long'
  ? emaDirection === 'up' && (fourHourIndicators?.adx ?? 0) >= 25 &&
    priceChangePct24h > 0.001 && oiChangePct24h > 0.001
  : emaDirection === 'down' && (fourHourIndicators?.adx ?? 0) >= 25 &&
    priceChangePct24h < -0.001 && oiChangePct24h > 0.001;

console.log(JSON.stringify({
  ts: new Date(now).toISOString(),
  event: 'competition_v2_read_only_monitor',
  instrument,
  authorisedWindow: {
    opensAt: new Date(COMPETITION_V2_AMENDMENT.earliestEntryAt).toISOString(),
    closesAt: new Date(COMPETITION_V2_AMENDMENT.latestEntryAt).toISOString(),
    open: now >= COMPETITION_V2_AMENDMENT.earliestEntryAt && now < COMPETITION_V2_AMENDMENT.latestEntryAt,
  },
  market: {
    last: ticker.last,
    priceChangePct24h,
    openInterestChangePct24h: oiChangePct24h,
    fundingRate: funding.fundingRate,
    spreadBps: (ticker.askPx - ticker.bidPx) / ticker.last * 10_000,
  },
  closedBars: {
    oneHourAt: new Date(closed(oneHour).at(-1)?.ts ?? 0).toISOString(),
    fourHourAt: new Date(closed(fourHour).at(-1)?.ts ?? 0).toISOString(),
    fourHourRegime: fourHourRegime.label,
    fourHourAdx: fourHourIndicators?.adx ?? null,
    fourHourEmaDirection: emaDirection,
  },
  strategyProbe: {
    draftCount: cycle.draftCount,
    approvedSignalCount: cycle.signals.length,
    rejectionCodes: cycle.rejected.map((rejection) => rejection.code),
    side: signal?.side ?? null,
    directionAndParticipationConfirmed: directionConfirmed,
  },
  publicCandidateReady: now >= COMPETITION_V2_AMENDMENT.earliestEntryAt &&
    now < COMPETITION_V2_AMENDMENT.latestEntryAt && signal !== undefined && directionConfirmed,
  executionEligible: false,
  blocker: 'read-only monitor cannot query the account, create a DecisionEvent, publish or trade',
  requests: client.stats.requests,
}));
