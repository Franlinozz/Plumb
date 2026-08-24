import {
  DEADLINE_CONTINGENCY_AMENDMENT,
  FINAL_WINDOW_CONTINGENCY_AMENDMENT,
  finalizeDecisionEvent,
  type DecisionEvent,
  type Signal,
} from '@plumb/core';
import type { Approval } from '@plumb/risk';

import {
  CompetitionDecisionRejected,
  type CompetitionCostEstimate,
  type CompetitionDecisionState,
} from './competition-decision.js';

export interface DeadlineContingencyMetadata {
  readonly ctVal: number;
  readonly ctMult: number;
  readonly minSz: number;
  readonly lotSz: number;
  readonly state: string;
}

export interface DeadlineContingencyInput {
  readonly signal: Signal;
  readonly approval: Approval;
  readonly costs: CompetitionCostEstimate;
  readonly state: CompetitionDecisionState & {
    readonly livePrice: number;
    readonly openInterestChangePct1h: number;
    readonly openInterestChangePct4h: number;
    readonly spreadBps: number;
    readonly fundingRate: number;
  };
  readonly metadata: DeadlineContingencyMetadata;
}

const finiteNonnegative = (name: string, value: number): number => {
  if (!Number.isFinite(value) || value < 0) throw new CompetitionDecisionRejected(`${name} is invalid`);
  return value;
};

const inputNumber = (signal: Signal, name: string): number => {
  const value = signal.inputs[name];
  if (!Number.isFinite(value)) throw new CompetitionDecisionRejected(`signal ${name} is missing or invalid`);
  return value as number;
};

const floorToStep = (value: number, step: number): number => {
  const decimals = Math.max(0, (step.toString().split('.')[1] ?? '').length);
  return Number((Math.floor(value / step) * step).toFixed(decimals));
};

const liveExecutionChecksPass = (input: {
  readonly price: number;
  readonly stopPrice: number;
  readonly takeProfit: number;
  readonly riskUsd: number;
  readonly expectedCostBps: number;
  readonly equityUsd: number;
  readonly approvedPositionPct: number;
  readonly maxNotionalUsd: number;
  readonly maxPlannedLossUsd: number;
  readonly minProjectedNetTargetUsd: number;
}): boolean => {
  const stopDistancePct = Math.abs(input.price - input.stopPrice) / input.price;
  const notional = input.riskUsd / stopDistancePct;
  const positionPct = notional / input.equityUsd * 100;
  const plannedLossUsd = input.riskUsd + notional * input.expectedCostBps / 10_000;
  const targetDistancePct = Math.abs(input.takeProfit - input.price) / input.price;
  const projectedNetTargetUsd = notional * targetDistancePct -
    notional * input.expectedCostBps / 10_000;
  return Number.isFinite(notional) && notional > 0 &&
    notional <= input.maxNotionalUsd + 1e-9 &&
    plannedLossUsd <= input.maxPlannedLossUsd + 1e-9 &&
    projectedNetTargetUsd + 1e-9 >= input.minProjectedNetTargetUsd &&
    Math.abs(positionPct - input.approvedPositionPct) <= 0.25 + 1e-9;
};

const executableSymmetricDrift = (
  entry: number,
  requestedDrift: number,
  checks: (price: number) => boolean,
): number => {
  if (!checks(entry)) {
    throw new CompetitionDecisionRejected('reference price cannot pass the executor live-risk gates');
  }
  let low = 0;
  let high = requestedDrift;
  for (let iteration = 0; iteration < 64; iteration += 1) {
    const candidate = (low + high) / 2;
    if (checks(entry - candidate) && checks(entry + candidate)) low = candidate;
    else high = candidate;
  }
  return low;
};

/**
 * Convert one operator-authorised deadline-contingency signal into the immutable shared event.
 * The factory independently rechecks the easier closed-bar rule, venue state and damage envelope;
 * expected edge remains zero because the strategy has no independent validation.
 */
function createContingencyDecision(
  input: DeadlineContingencyInput,
  amendment: typeof DEADLINE_CONTINGENCY_AMENDMENT | typeof FINAL_WINDOW_CONTINGENCY_AMENDMENT,
): DecisionEvent {
  const { signal, approval, state, metadata } = input;
  if (state.now < amendment.earliestEntryAt || state.now >= amendment.latestEntryAt) {
    throw new CompetitionDecisionRejected('outside the deadline-contingency window');
  }
  if (signal.strategyId !== amendment.strategyId || signal.version !== amendment.strategyVersion ||
      !amendment.instruments.includes(signal.instId as (typeof amendment.instruments)[number]) ||
      signal.intent !== 'open') {
    throw new CompetitionDecisionRejected('signal is not the authorised ETH/SOL deadline contingency');
  }
  if (!approval.approved || approval.signalId !== signal.id) {
    throw new CompetitionDecisionRejected('governor did not approve this exact contingency signal');
  }
  if (signal.ts > state.now || state.now >= signal.expiresAt) {
    throw new CompetitionDecisionRejected('contingency signal is future-dated or stale');
  }
  if (state.marketDataAt > state.now || state.now - state.marketDataAt > state.maxMarketAgeMs ||
      state.openInterestAt > state.now || state.now - state.openInterestAt > state.maxOpenInterestAgeMs) {
    throw new CompetitionDecisionRejected('market or open-interest data is stale or future-dated');
  }

  const close = inputNumber(signal, 'hourlyClose');
  const previousClose = inputNumber(signal, 'hourlyPreviousClose');
  const ema20 = inputNumber(signal, 'hourlyEma20');
  const rsi = inputNumber(signal, 'hourlyRsi');
  const histogram = inputNumber(signal, 'hourlyMacdHistogram');
  const priorHistogram = inputNumber(signal, 'hourlyMacdHistogramPrevious');
  const volumeRatio = inputNumber(signal, 'volumeRatio');
  const direction = signal.side === 'long' ? 'up' : 'down';
  const recoveryConfirmed = signal.side === 'long'
    ? close > ema20 && close > previousClose && rsi >= amendment.longRsiMin &&
      rsi <= amendment.longRsiMax && histogram > priorHistogram
    : close < ema20 && close < previousClose && rsi >= amendment.shortRsiMin &&
      rsi <= amendment.shortRsiMax && histogram < priorHistogram;
  const priceNotOpposed = signal.side === 'long'
    ? state.priceChangePct24h >= -amendment.maxOpposingPriceChangePct24h
    : state.priceChangePct24h <= amendment.maxOpposingPriceChangePct24h;
  if (state.closedFourHourEmaDirection !== direction ||
      !Number.isFinite(state.closedFourHourAdx) ||
      state.closedFourHourAdx < amendment.minClosedFourHourAdx || !recoveryConfirmed ||
      volumeRatio < amendment.minVolumeRatio || !priceNotOpposed) {
    throw new CompetitionDecisionRejected('closed trend, recovery, volume, or price-alignment gate failed');
  }
  if (!Number.isFinite(state.openInterestChangePct1h) ||
      state.openInterestChangePct1h < amendment.minOneHourOiChangePct ||
      !Number.isFinite(state.openInterestChangePct4h) ||
      state.openInterestChangePct4h < amendment.minFourHourOiChangePct ||
      !Number.isFinite(state.openInterestChangePct24h) ||
      state.openInterestChangePct24h < amendment.minTwentyFourHourOiChangePct ||
      !Number.isFinite(state.spreadBps) || state.spreadBps > amendment.maxSpreadBps ||
      !Number.isFinite(state.fundingRate) || Math.abs(state.fundingRate) > amendment.maxAbsFundingRate) {
    throw new CompetitionDecisionRejected('OI unwind, spread, or funding veto failed');
  }
  if (Object.values(state.haltFlags).some(Boolean) || !state.reconciliationHealthy ||
      !state.instrumentMetadataPresent || !state.accountCertain || state.duplicateDecision) {
    throw new CompetitionDecisionRejected('a safety, reconciliation, metadata, account, or duplicate gate failed');
  }
  if (Math.abs(state.venuePositionBefore - state.ledgerPositionBefore) > state.quantityTolerance) {
    throw new CompetitionDecisionRejected('signed venue and ledger positions disagree');
  }
  if (Math.abs(state.venuePositionBefore) > state.quantityTolerance ||
      Math.abs(state.ledgerPositionBefore) > state.quantityTolerance) {
    throw new CompetitionDecisionRejected('contingency instrument must be flat; reversal or increase is forbidden');
  }
  if (!Number.isFinite(state.equityUsd) || state.equityUsd <= 0 ||
      !Number.isFinite(state.venueLeverage) || state.venueLeverage < 1 || state.venueLeverage > 3) {
    throw new CompetitionDecisionRejected('equity or leverage is invalid');
  }
  if (metadata.state !== 'live' || metadata.ctVal <= 0 || metadata.ctMult <= 0 ||
      metadata.minSz <= 0 || metadata.lotSz <= 0) {
    throw new CompetitionDecisionRejected('instrument metadata is invalid');
  }

  const entry = signal.entry.price;
  const takeProfit = signal.takeProfit?.[0]?.price;
  if (entry === undefined || takeProfit === undefined || Math.abs(entry - close) > 1e-9) {
    throw new CompetitionDecisionRejected('signal lacks its exact closed-bar entry or take-profit');
  }
  const stopDistancePct = Math.abs(entry - signal.stop.price) / entry;
  const targetDistancePct = Math.abs(takeProfit - entry) / entry;
  if (Math.abs(stopDistancePct - amendment.stopDistancePct) > 1e-9 ||
      Math.abs(targetDistancePct / stopDistancePct - amendment.takeProfitR) > 1e-9) {
    throw new CompetitionDecisionRejected('contingency stop or target geometry changed');
  }
  const expectedCostBps = Object.entries(input.costs).reduce(
    (total, [name, value]) => total + finiteNonnegative(name, value),
    0,
  );
  const costRate = expectedCostBps / 10_000;
  const maxRiskForPlannedLoss = amendment.maxPlannedLossUsd /
    (1 + costRate / stopDistancePct);
  const cappedRisk = Math.min(
    amendment.maxStopRiskUsd,
    amendment.maxNotionalUsd * stopDistancePct,
    state.equityUsd * amendment.maxPositionPct / 100 * stopDistancePct,
    maxRiskForPlannedLoss,
    approval.sizing.actualRiskUsdt,
  );
  const candidateNotional = cappedRisk / stopDistancePct;
  const contracts = floorToStep(
    candidateNotional / (entry * metadata.ctVal * metadata.ctMult), metadata.lotSz,
  );
  if (!Number.isFinite(contracts) || contracts < metadata.minSz) {
    throw new CompetitionDecisionRejected('risk-capped contingency size is below the venue minimum');
  }
  const notional = contracts * entry * metadata.ctVal * metadata.ctMult;
  const riskUsd = notional * stopDistancePct;
  const positionPct = notional / state.equityUsd * 100;
  const plannedLossUsd = riskUsd + notional * costRate;
  const projectedNetTargetUsd = notional * targetDistancePct - notional * costRate;
  if (!Number.isFinite(notional) || notional <= 0 || riskUsd <= 0 ||
      riskUsd > amendment.maxStopRiskUsd + 1e-9 ||
      plannedLossUsd > amendment.maxPlannedLossUsd + 1e-9 ||
      notional > amendment.maxNotionalUsd + 1e-9 ||
      positionPct > amendment.maxPositionPct + 1e-9 ||
      approval.sizing.actualRiskUsdt + 1e-9 < riskUsd) {
    throw new CompetitionDecisionRejected('rounded size exceeds the contingency damage envelope');
  }
  if (projectedNetTargetUsd + 1e-9 < amendment.minProjectedNetTargetUsd) {
    throw new CompetitionDecisionRejected('projected net target is below the authorised minimum');
  }
  if (!Number.isFinite(state.entryToleranceBps) || state.entryToleranceBps < 0 ||
      state.entryToleranceBps > amendment.maxEntryToleranceBps) {
    throw new CompetitionDecisionRejected('entry tolerance is outside the authorised range');
  }
  if (!Number.isFinite(state.livePrice) || state.livePrice <= 0) {
    throw new CompetitionDecisionRejected('live execution price is invalid');
  }
  const requestedDrift = entry * state.entryToleranceBps / 10_000;
  const drift = executableSymmetricDrift(entry, requestedDrift, (price) =>
    liveExecutionChecksPass({
      price,
      stopPrice: signal.stop.price,
      takeProfit,
      riskUsd,
      expectedCostBps,
      equityUsd: state.equityUsd,
      approvedPositionPct: positionPct,
      maxNotionalUsd: amendment.maxNotionalUsd,
      maxPlannedLossUsd: amendment.maxPlannedLossUsd,
      minProjectedNetTargetUsd: amendment.minProjectedNetTargetUsd,
    }));
  if (state.livePrice < entry - drift || state.livePrice > entry + drift) {
    throw new CompetitionDecisionRejected('live price is outside the executor-compatible entry range');
  }
  const validUntil = Math.min(signal.expiresAt, state.now + amendment.maxValidityMs, amendment.latestEntryAt);
  if (validUntil <= state.now) throw new CompetitionDecisionRejected('contingency event has no valid execution window');

  return finalizeDecisionEvent({
    decisionId: `DEC-${signal.id.slice(4)}`,
    strategyVersion: `${amendment.strategyId}@${amendment.strategyVersion}`,
    createdAt: state.now,
    validUntil,
    instrument: signal.instId,
    direction: signal.side,
    entryLow: entry - drift,
    entryHigh: entry + drift,
    stopPrice: signal.stop.price,
    takeProfit,
    positionPct,
    leverage: state.venueLeverage,
    riskUsd,
    expectedCostBps,
    expectedEdgeBps: 0,
    approvalBasis: amendment.approvalBasis,
    governorApproved: true,
    venuePositionBefore: state.venuePositionBefore,
    ledgerPositionBefore: state.ledgerPositionBefore,
    reconciliationVersion: state.reconciliationVersion,
  });
}

export function createDeadlineContingencyDecision(input: DeadlineContingencyInput): DecisionEvent {
  return createContingencyDecision(input, DEADLINE_CONTINGENCY_AMENDMENT);
}

export function createFinalWindowContingencyDecision(input: DeadlineContingencyInput): DecisionEvent {
  return createContingencyDecision(input, FINAL_WINDOW_CONTINGENCY_AMENDMENT);
}
