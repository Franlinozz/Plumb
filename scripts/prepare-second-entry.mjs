#!/usr/bin/env node
/** Prepare, but never publish or execute, one authorised BTC/ETH/SOL second-entry DecisionEvent. */

import { randomInt } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

import { createEntropyIdFactory, SECOND_ENTRY_AMENDMENT } from '@plumb/core';
import { buildSnapshot, OkxPublicClient, openInterestChangeOverWindow } from '@plumb/market';
import {
  COMPETITION_TREND_PULLBACK_ID,
  DEFAULT_STRATEGY_CONFIG,
  STRATEGY_IDS,
  aggregateClosedFourHour,
  classifyFourHourTrend,
  competitionTrendPullback,
  runCycle,
} from '@plumb/strategy';
import { createGovernor, initialState } from '@plumb/risk';
import { createSecondEntryDecision } from '@plumb/ops';
import { CliAtkClient, CompetitionLedgerStore, IntentStore } from '@plumb/executor';

const expectedUid = process.env.PLUMB_COMPETITION_UID?.trim() ?? '';
if (!/^\d+$/u.test(expectedUid)) throw new Error('PLUMB_COMPETITION_UID is required outside the repository');

const instrument = process.argv[2];
if (!SECOND_ENTRY_AMENDMENT.instruments.includes(instrument)) {
  throw new Error('usage: prepare-second-entry.mjs <BTC-USDT-SWAP|ETH-USDT-SWAP|SOL-USDT-SWAP> [output.json]');
}
const output = process.argv[3] ?? `.tmp/second-entry-${instrument}.json`;
const stateDir = process.env.PLUMB_COMPETITION_STATE_DIR ?? '/var/lib/plumb-okxai';
const publicClient = new OkxPublicClient();
const venue = new CliAtkClient({ demo: false, allowLive: true, profile: 'competition', timeoutMs: 60_000 });
const closed = (rows) => rows.filter((row) => row.closed);

const [oneHour, fourHour, ticker, markPrice, funding, fundingHistory, openInterest, rawOiHistory,
  account, allPositions, pendingOrders, metadata, fees, venueLast, leverage, maxSize, balances] =
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
    venue.getPositions(),
    venue.getOpenOrders(),
    venue.getInstrumentMetadata(instrument),
    venue.getFeeRates(instrument),
    venue.getLastPrice(instrument),
    venue.getLeverage(instrument),
    venue.getMaxAvailableSize(instrument),
    venue.getBalance(),
  ]);
const now = Date.now();

if (now < SECOND_ENTRY_AMENDMENT.authorisedAt || now >= SECOND_ENTRY_AMENDMENT.latestEntryAt) {
  throw new Error('outside the authorised evidence-limited second-entry window');
}
if (account.uid !== expectedUid || Number(account.acctLv) < 2 || account.posMode !== 'net_mode') {
  throw new Error('competition account identity, account level, or net-mode preflight failed');
}
if (pendingOrders.length !== 0) throw new Error('competition account has pending regular orders');
if (leverage < 1 || leverage > 3) throw new Error('venue leverage is outside 1x..3x');
if (Math.abs(ticker.last - venueLast) / venueLast > 0.001) {
  throw new Error('public and Agent Trade Kit prices disagree by more than 10 bps');
}
const usdt = balances.find((balance) => balance.ccy === 'USDT');
if (usdt === undefined || usdt.eq < 300 || usdt.availEq <= 0) {
  throw new Error('USDT equity or available margin preflight failed');
}

const intentsPath = `${stateDir}/competition-intents.db`;
const ledgerPath = `${stateDir}/competition-ledger.db`;
if (!existsSync(intentsPath) || !existsSync(ledgerPath)) {
  throw new Error('competition intent or signed-position ledger is absent');
}
const intents = new IntentStore(intentsPath);
const ledger = new CompetitionLedgerStore(ledgerPath);
let placedIntents;
let ledgerSignedPosition = 0;
let governorOpenPositions = [];
let concurrentStopRiskUsd = 0;
try {
  placedIntents = intents.all().filter((intent) => intent.status === 'placed');
  if (placedIntents.length !== SECOND_ENTRY_AMENDMENT.priorLiveEntryCount) {
    throw new Error('the first entry is not durably recorded exactly once');
  }

  const signedVenuePosition = (instId) => allPositions
    .filter((position) => position.instId === instId)
    .reduce((sum, position) => sum + (position.posSide === 'net'
      ? position.pos
      : position.posSide === 'long' ? Math.abs(position.pos) : -Math.abs(position.pos)), 0);
  for (const lockedInstrument of ['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP']) {
    const venueSigned = signedVenuePosition(lockedInstrument);
    const recordedSigned = ledger.get(lockedInstrument)?.signedPosition ?? 0;
    if (Math.abs(venueSigned - recordedSigned) > 1e-9) {
      throw new Error(`signed venue/ledger mismatch on ${lockedInstrument}`);
    }
  }
  ledgerSignedPosition = ledger.get(instrument)?.signedPosition ?? 0;

  const openVenuePositions = allPositions.filter((position) => Math.abs(position.pos) > 0);
  const metadataByInstrument = new Map();
  for (const position of openVenuePositions) {
    const recorded = ledger.get(position.instId);
    if (recorded === undefined || Math.abs(recorded.signedPosition - position.pos) > 1e-9) {
      throw new Error(`signed venue/ledger mismatch on ${position.instId}`);
    }
    const intent = [...placedIntents].reverse().find((candidate) => candidate.instId === position.instId);
    if (intent === undefined) throw new Error(`open venue position lacks a placed intent on ${position.instId}`);
    if (intent.ordId === undefined) throw new Error(`open venue position lacks a recorded order ID on ${position.instId}`);
    const instrumentMetadata = position.instId === instrument
      ? metadata
      : await venue.getInstrumentMetadata(position.instId);
    const entryOrder = await venue.getOrder(position.instId, { ordId: intent.ordId });
    if (entryOrder === undefined ||
        (entryOrder.slTriggerPx === undefined && entryOrder.attachAlgoId === undefined) ||
        entryOrder.tpTriggerPx === undefined) {
      throw new Error(`open venue position lacks a verifiable attached stop/take-profit on ${position.instId}`);
    }
    if (entryOrder.slTriggerPx !== undefined &&
        Math.abs(entryOrder.slTriggerPx - intent.stopPrice) > instrumentMetadata.tickSz / 2 + 1e-9) {
      throw new Error(`venue stop and durable intent disagree on ${position.instId}`);
    }
    metadataByInstrument.set(position.instId, instrumentMetadata);
    const notionalUsdt = Math.abs(position.pos) * instrumentMetadata.ctVal *
      instrumentMetadata.ctMult * position.avgPx;
    const stopRiskUsd = Math.abs(position.avgPx - intent.stopPrice) * Math.abs(position.pos) *
      instrumentMetadata.ctVal * instrumentMetadata.ctMult;
    concurrentStopRiskUsd += stopRiskUsd;
    governorOpenPositions.push({
      instId: position.instId,
      side: position.pos > 0 ? 'long' : 'short',
      contracts: Math.abs(position.pos),
      notionalUsdt,
      entryPrice: position.avgPx,
      stopPrice: intent.stopPrice,
      openedAt: intent.createdAt,
      signalId: intent.signalId,
    });
  }
} finally {
  intents.close();
  ledger.close();
}

const targetVenuePosition = allPositions
  .filter((position) => position.instId === instrument)
  .reduce((sum, position) => sum + (position.posSide === 'net'
    ? position.pos
    : position.posSide === 'long' ? Math.abs(position.pos) : -Math.abs(position.pos)), 0);
if (Math.abs(targetVenuePosition) > metadata.lotSz / 2 ||
    Math.abs(ledgerSignedPosition) > metadata.lotSz / 2) {
  throw new Error('second-entry instrument is occupied; increase or reversal is forbidden');
}

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
  candles: [{ tf: '1H', ohlcv: closed(oneHour) }, { tf: '4H', ohlcv: closed(fourHour) }],
});
const enabled = Object.fromEntries([
  ...STRATEGY_IDS.map((id) => [id, false]),
  [COMPETITION_TREND_PULLBACK_ID, true],
]);
const config = { ...DEFAULT_STRATEGY_CONFIG, enabled };
const cycle = runCycle(snapshot, {
  now,
  newId: createEntropyIdFactory(() => randomInt(0, 2 ** 32)),
  config,
  modules: [competitionTrendPullback],
  regimeTimeframe: '4H',
});
const signal = cycle.signals[0];
if (signal === undefined) {
  throw new Error(`frozen v3 strategy emitted no signal (${cycle.rejected.map((item) => item.code).join(',') || 'closed-bar trigger absent'})`);
}

const baseState = initialState(now, 400);
const governorState = {
  ...baseState,
  equity: usdt.eq,
  peakEquity: Math.max(400, usdt.eq),
  openPositions: governorOpenPositions,
  totalNotional: governorOpenPositions.reduce((sum, position) => sum + position.notionalUsdt, 0),
};
const verdict = createGovernor().evaluate(signal, governorState, snapshot, now);
if (!verdict.approved) throw new Error(`governor vetoed second-entry signal: ${verdict.code}`);

const changeFrom = (hours) => openInterestChangeOverWindow(
  openInterest, oiHistory, hours * 3_600_000,
);
const spreadBps = (ticker.askPx - ticker.bidPx) / ticker.last * 10_000;
const costs = {
  entryFeeBps: Math.max(fees.maker, fees.taker) * 10_000,
  exitFeeBps: Math.max(fees.maker, fees.taker) * 10_000,
  slippageBps: 1,
  spreadImpactBps: Math.max(0, spreadBps),
  expectedFundingBps: Math.abs(funding.fundingRate) * 10_000,
};
// Use the exact same closed-1H aggregation as the frozen v3 strategy, not an independently
// fetched 4H series whose exchange candle boundaries could diverge.
const fourHourTrend = classifyFourHourTrend(aggregateClosedFourHour(closed(oneHour)));
const event = createSecondEntryDecision({
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
    openInterestChangePct1h: changeFrom(1),
    openInterestChangePct4h: changeFrom(4),
    openInterestChangePct24h: changeFrom(24),
    priceChangePct24h: ticker.open24h === 0 ? Number.NaN : ticker.last / ticker.open24h - 1,
    equityUsd: usdt.eq,
    venueLeverage: leverage,
    venuePositionBefore: targetVenuePosition,
    ledgerPositionBefore: ledgerSignedPosition,
    quantityTolerance: metadata.lotSz / 2,
    reconciliationVersion: 'signed-v2',
    reconciliationHealthy: Math.abs(targetVenuePosition - ledgerSignedPosition) <= metadata.lotSz / 2,
    instrumentMetadataPresent: metadata.state === 'live',
    accountCertain: (signal.side === 'long' ? maxSize.buy : maxSize.sell) >= metadata.minSz,
    duplicateDecision: false,
    haltFlags: governorState.haltFlags,
    closedFourHourEmaDirection: fourHourTrend.direction === 'none' ? 'unclear' : fourHourTrend.direction,
    closedFourHourAdx: fourHourTrend.adx ?? Number.NaN,
    entryToleranceBps: 10,
  },
});

const entry = (event.entryLow + event.entryHigh) / 2;
const notionalUsd = event.riskUsd / (Math.abs(entry - event.stopPrice) / entry);
const projectedNetTargetUsd = notionalUsd * Math.abs(event.takeProfit - entry) / entry -
  notionalUsd * event.expectedCostBps / 10_000;
const bundle = {
  event,
  gate: {
    marketDataAt: now,
    maxMarketAgeMs: SECOND_ENTRY_AMENDMENT.maxValidityMs,
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
    concurrentStopRiskUsd,
  },
  audit: {
    generatedAt: new Date(now).toISOString(),
    amendment: 'operator-authorised evidence-limited v3 second entry; no independent holdout',
    priorLiveEntryCount: placedIntents.length,
    existingOpenInstruments: governorOpenPositions.map((position) => position.instId),
    expectedCostBps: event.expectedCostBps,
    expectedEdgeBps: 0,
    estimatedNotionalUsd: notionalUsd,
    estimatedPlannedLossUsd: event.riskUsd + notionalUsd * event.expectedCostBps / 10_000,
    projectedNetTargetUsd,
    openInterestChangePct1h: changeFrom(1),
    openInterestChangePct4h: changeFrom(4),
    openInterestChangePct24h: changeFrom(24),
    hardExitAt: new Date(SECOND_ENTRY_AMENDMENT.hardExitAt).toISOString(),
    publicRequests: publicClient.stats.requests,
  },
};
mkdirSync(output.slice(0, Math.max(0, output.lastIndexOf('/'))) || '.', { recursive: true });
writeFileSync(output, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({
  ts: new Date(now).toISOString(),
  event: 'second_entry_prepared',
  decisionId: event.decisionId,
  instrument: event.instrument,
  direction: event.direction,
  referencePrice: entry,
  stopPrice: event.stopPrice,
  takeProfit: event.takeProfit,
  riskUsd: event.riskUsd,
  plannedLossUsd: bundle.audit.estimatedPlannedLossUsd,
  projectedNetTargetUsd,
  output,
}));
