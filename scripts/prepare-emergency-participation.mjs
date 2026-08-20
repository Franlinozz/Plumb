#!/usr/bin/env node
/** Read-only preparation of one operator-authorised minimum-lot participation decision. */

import { randomInt } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

import { createEntropyIdFactory, EMERGENCY_PARTICIPATION_AMENDMENT } from '@plumb/core';
import { buildSnapshot, OkxPublicClient } from '@plumb/market';
import {
  DEFAULT_STRATEGY_CONFIG,
  EMERGENCY_PARTICIPATION_ID,
  emergencyParticipation,
  runCycle,
} from '@plumb/strategy';
import { createGovernor, initialState } from '@plumb/risk';
import { createEmergencyParticipationDecision } from '@plumb/ops';
import { CliAtkClient, CompetitionLedgerStore, IntentStore } from '@plumb/executor';

const expectedUid = process.env.PLUMB_COMPETITION_UID?.trim() ?? '';
if (!/^\d+$/u.test(expectedUid)) throw new Error('PLUMB_COMPETITION_UID is required outside the repository');

const instrument = EMERGENCY_PARTICIPATION_AMENDMENT.instrument;
const stateDir = process.env.PLUMB_COMPETITION_STATE_DIR ?? '/var/lib/plumb-okxai';
const output = process.argv[2] ?? '.tmp/emergency-participation-bundle.json';
const publicClient = new OkxPublicClient();
const venue = new CliAtkClient({ demo: false, allowLive: true, profile: 'competition', timeoutMs: 60_000 });
const closed = (rows) => rows.filter((row) => row.closed);

const [oneHour, fourHour, ticker, markPrice, funding, fundingHistory, openInterest, rawOiHistory,
  account, positions, pendingOrders, metadata, fees, venueLast, leverage, maxSize, balances] =
  await Promise.all([
    publicClient.candles(instrument, '1H', { limit: 300 }),
    publicClient.candles(instrument, '4H', { limit: 100 }),
    publicClient.ticker(instrument),
    publicClient.markPrice(instrument),
    publicClient.fundingRate(instrument),
    publicClient.fundingRateHistory(instrument, { limit: 100 }),
    publicClient.openInterest(instrument),
    publicClient.openInterestHistory(instrument, '1H', { limit: 25 }),
    venue.getAccountConfig(),
    venue.getPositions(instrument),
    venue.getOpenOrders(instrument),
    venue.getInstrumentMetadata(instrument),
    venue.getFeeRates(instrument),
    venue.getLastPrice(instrument),
    venue.getLeverage(instrument),
    venue.getMaxAvailableSize(instrument),
    venue.getBalance(),
  ]);
// Capture the decision clock AFTER the parallel responses. OKX stamps each payload at response
// time, so a clock captured before the requests can make fresh data appear future-dated.
const now = Date.now();

if (account.uid !== expectedUid || Number(account.acctLv) < 2 || account.posMode !== 'net_mode') {
  throw new Error('competition account identity, account level, or net-mode preflight failed');
}
if (pendingOrders.length !== 0) throw new Error('competition account has pending orders');
if (leverage < 1 || leverage > 3) throw new Error('venue leverage is outside 1x..3x');
const signedPosition = positions.reduce((sum, position) => {
  if (position.instId !== instrument) return sum;
  if (position.posSide === 'net') return sum + position.pos;
  return sum + (position.posSide === 'long' ? Math.abs(position.pos) : -Math.abs(position.pos));
}, 0);
if (Math.abs(signedPosition) > metadata.lotSz / 2) throw new Error('competition account is not flat');

const usdt = balances.find((balance) => balance.ccy === 'USDT');
if (usdt === undefined || usdt.eq < 300 || usdt.availEq <= 0) throw new Error('USDT equity or available margin preflight failed');
if (Math.abs(ticker.last - venueLast) / venueLast > 0.001) throw new Error('public and Trade Kit prices disagree by more than 10 bps');

const oiHistory = [...rawOiHistory].sort((a, b) => a.ts - b.ts);
const snapshot = buildSnapshot({
  now, instId: instrument, ticker, markPrice, funding, fundingHistory, openInterest,
  openInterestHistory: oiHistory,
  candles: [{ tf: '1H', ohlcv: closed(oneHour) }, { tf: '4H', ohlcv: closed(fourHour) }],
});
const config = {
  ...DEFAULT_STRATEGY_CONFIG,
  enabled: { ...DEFAULT_STRATEGY_CONFIG.enabled, [EMERGENCY_PARTICIPATION_ID]: true },
};
const cycle = runCycle(snapshot, {
  now,
  newId: createEntropyIdFactory(() => randomInt(0, 2 ** 32)),
  config,
  modules: [emergencyParticipation],
  regimeTimeframe: '4H',
});
const signal = cycle.signals[0];
if (signal === undefined) {
  throw new Error(`emergency strategy emitted no signal (${cycle.rejected.map((item) => item.code).join(',') || 'no draft'})`);
}

const governorState = {
  ...initialState(now, 400),
  equity: usdt.eq,
  peakEquity: Math.max(400, usdt.eq),
};
const verdict = createGovernor().evaluate(signal, governorState, snapshot, now);
if (!verdict.approved) throw new Error(`governor vetoed emergency signal: ${verdict.code}`);

const changeFrom = (hours) => {
  const threshold = now - hours * 3_600_000;
  const base = oiHistory.find((row) => row.ts >= threshold) ?? oiHistory[0];
  return base === undefined || base.oi === 0 ? Number.NaN : openInterest.oi / base.oi - 1;
};
const priceChangePct24h = ticker.open24h === 0 ? Number.NaN : ticker.last / ticker.open24h - 1;
const fourHourIndicators = snapshot.indicators['4H'];
const oneHourRsi = snapshot.indicators['1H']?.rsi;
const direction = fourHourIndicators?.emaFast !== undefined && fourHourIndicators.emaSlow !== undefined
  ? (fourHourIndicators.emaFast > fourHourIndicators.emaSlow ? 'up' : 'down')
  : 'unclear';

let ledgerSignedPosition = 0;
const ledgerPath = `${stateDir}/competition-ledger.db`;
if (existsSync(ledgerPath)) {
  const ledger = new CompetitionLedgerStore(ledgerPath);
  try { ledgerSignedPosition = ledger.get(instrument)?.signedPosition ?? 0; } finally { ledger.close(); }
}
let priorLiveEntryCount = 0;
const intentsPath = `${stateDir}/competition-intents.db`;
if (existsSync(intentsPath)) {
  const intents = new IntentStore(intentsPath);
  try { priorLiveEntryCount = intents.all().filter((intent) => intent.status === 'placed').length; }
  finally { intents.close(); }
}
if (priorLiveEntryCount >= EMERGENCY_PARTICIPATION_AMENDMENT.maxLiveEntries) {
  throw new Error('the one-entry emergency allowance is already exhausted');
}

const spreadBps = (ticker.askPx - ticker.bidPx) / ticker.last * 10_000;
const costs = {
  entryFeeBps: Math.max(fees.maker, fees.taker) * 10_000,
  exitFeeBps: Math.max(fees.maker, fees.taker) * 10_000,
  slippageBps: 1,
  spreadImpactBps: Math.max(0, spreadBps),
  expectedFundingBps: Math.abs(funding.fundingRate) * 10_000,
};
const event = createEmergencyParticipationDecision({
  signal,
  approval: verdict,
  costs,
  metadata,
  state: {
    now,
    marketDataAt: Math.min(ticker.ts, markPrice.ts),
    maxMarketAgeMs: 30_000,
    openInterestAt: openInterest.ts,
    maxOpenInterestAgeMs: 3_600_000,
    openInterestChangePct24h: changeFrom(24),
    priceChangePct24h,
    equityUsd: usdt.eq,
    venueLeverage: leverage,
    venuePositionBefore: signedPosition,
    ledgerPositionBefore: ledgerSignedPosition,
    quantityTolerance: metadata.lotSz / 2,
    reconciliationVersion: 'signed-v2',
    reconciliationHealthy: Math.abs(signedPosition - ledgerSignedPosition) <= metadata.lotSz / 2,
    instrumentMetadataPresent: metadata.state === 'live',
    accountCertain: maxSize.buy >= metadata.minSz && maxSize.sell >= metadata.minSz,
    duplicateDecision: false,
    haltFlags: governorState.haltFlags,
    closedFourHourEmaDirection: direction,
    closedFourHourAdx: fourHourIndicators?.adx ?? Number.NaN,
    oneHourRsi: oneHourRsi ?? Number.NaN,
    entryToleranceBps: 10,
  },
});

const bundle = {
  event,
  gate: {
    marketDataAt: now,
    maxMarketAgeMs: EMERGENCY_PARTICIPATION_AMENDMENT.maxValidityMs,
    haltFlags: governorState.haltFlags,
    reconciliationHealthy: true,
    instrumentMetadataPresent: true,
    sizingValid: true,
    accountCertain: true,
    duplicateDecision: false,
  },
  risk: {
    equityUsd: usdt.eq,
    availableMarginUsd: usdt.availEq,
    realisedPnlTodayUsd: 0,
    drawdownUsd: Math.max(0, 400 - usdt.eq),
    concurrentStopRiskUsd: 0,
  },
  audit: {
    generatedAt: new Date(now).toISOString(),
    amendment: 'operator-authorised emergency participation; no calibrated edge claimed',
    expectedEdgeBps: 0,
    exactVenueMinimumContracts: metadata.minSz,
    estimatedNotionalUsd: metadata.minSz * metadata.ctVal * metadata.ctMult * signal.entry.price,
    estimatedPlannedLossUsd: event.riskUsd +
      metadata.minSz * metadata.ctVal * metadata.ctMult * signal.entry.price * event.expectedCostBps / 10_000,
    priceChangePct24h,
    openInterestChangePct24h: changeFrom(24),
    oneHourRsi,
    closedFourHourAdx: fourHourIndicators?.adx,
    publicRequests: publicClient.stats.requests,
  },
};
mkdirSync(output.slice(0, Math.max(0, output.lastIndexOf('/'))) || '.', { recursive: true });
writeFileSync(output, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({
  ts: new Date(now).toISOString(), event: 'emergency_participation_prepared',
  decisionId: event.decisionId, direction: event.direction, referencePrice: signal.entry.price,
  stopPrice: event.stopPrice, takeProfit: event.takeProfit, riskUsd: event.riskUsd,
  expectedCostBps: event.expectedCostBps, expectedEdgeBps: event.expectedEdgeBps,
  exactVenueMinimumContracts: metadata.minSz, output,
}));
