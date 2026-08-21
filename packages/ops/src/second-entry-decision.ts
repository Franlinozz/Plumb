import {
  SECOND_ENTRY_AMENDMENT,
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

export interface SecondEntryMetadata {
  readonly ctVal: number;
  readonly ctMult: number;
  readonly minSz: number;
  readonly lotSz: number;
  readonly state: string;
}

export interface SecondEntryInput {
  readonly signal: Signal;
  readonly approval: Approval;
  readonly costs: CompetitionCostEstimate;
  readonly state: CompetitionDecisionState & {
    readonly openInterestChangePct1h: number;
    readonly openInterestChangePct4h: number;
  };
  readonly metadata: SecondEntryMetadata;
}

const finiteNonnegative = (name: string, value: number): number => {
  if (!Number.isFinite(value) || value < 0) throw new CompetitionDecisionRejected(`${name} is invalid`);
  return value;
};

const floorToStep = (value: number, step: number): number => {
  const decimals = Math.max(0, (step.toString().split('.')[1] ?? '').length);
  return Number((Math.floor(value / step) * step).toFixed(decimals));
};

/**
 * Convert the frozen v3 signal into the one operator-authorised evidence-limited second event.
 * Direction, entry, stop and target remain strategy-owned. This function only reduces size and
 * fails closed; it never claims a calibrated expected edge.
 */
export function createSecondEntryDecision(input: SecondEntryInput): DecisionEvent {
  const { signal, approval, state, metadata } = input;
  const amendment = SECOND_ENTRY_AMENDMENT;
  if (state.now < amendment.authorisedAt || state.now >= amendment.latestEntryAt) {
    throw new CompetitionDecisionRejected('outside the evidence-limited second-entry window');
  }
  if (signal.strategyId !== amendment.strategyId || signal.version !== amendment.strategyVersion ||
      !amendment.instruments.includes(signal.instId as (typeof amendment.instruments)[number]) ||
      signal.intent !== 'open') {
    throw new CompetitionDecisionRejected('signal is not the authorised frozen v3 BTC/SOL strategy');
  }
  if (!approval.approved || approval.signalId !== signal.id) {
    throw new CompetitionDecisionRejected('governor did not approve this exact signal');
  }
  if (signal.ts > state.now || state.now >= signal.expiresAt) {
    throw new CompetitionDecisionRejected('signal is future-dated or stale');
  }
  if (state.marketDataAt > state.now || state.now - state.marketDataAt > state.maxMarketAgeMs ||
      state.openInterestAt > state.now || state.now - state.openInterestAt > state.maxOpenInterestAgeMs) {
    throw new CompetitionDecisionRejected('market or open-interest data is stale or future-dated');
  }

  const direction = signal.side === 'long' ? 'up' : 'down';
  const priceConfirmed = signal.side === 'long'
    ? state.priceChangePct24h > amendment.minOpenInterestChangePct
    : state.priceChangePct24h < -amendment.minOpenInterestChangePct;
  if (state.closedFourHourEmaDirection !== direction ||
      !Number.isFinite(state.closedFourHourAdx) || state.closedFourHourAdx < 25 || !priceConfirmed ||
      !Number.isFinite(state.openInterestChangePct1h) ||
      state.openInterestChangePct1h <= amendment.minOpenInterestChangePct ||
      !Number.isFinite(state.openInterestChangePct4h) ||
      state.openInterestChangePct4h <= amendment.minOpenInterestChangePct ||
      !Number.isFinite(state.openInterestChangePct24h) ||
      state.openInterestChangePct24h <= amendment.minOpenInterestChangePct) {
    throw new CompetitionDecisionRejected('closed trend or multi-horizon participation confirmation failed');
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
    throw new CompetitionDecisionRejected('second-entry instrument must be flat; reversal or increase is forbidden');
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
  if (entry === undefined || takeProfit === undefined) {
    throw new CompetitionDecisionRejected('signal lacks an absolute entry or take-profit');
  }
  const stopDistancePct = Math.abs(entry - signal.stop.price) / entry;
  const targetDistancePct = Math.abs(takeProfit - entry) / entry;
  if (!Number.isFinite(stopDistancePct) || stopDistancePct <= 0 ||
      !Number.isFinite(targetDistancePct) || targetDistancePct <= 0) {
    throw new CompetitionDecisionRejected('stop or target distance is invalid');
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
    candidateNotional / (entry * metadata.ctVal * metadata.ctMult),
    metadata.lotSz,
  );
  if (!Number.isFinite(contracts) || contracts < metadata.minSz) {
    throw new CompetitionDecisionRejected('risk-capped size is below the venue minimum');
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
    throw new CompetitionDecisionRejected('rounded size exceeds the second-entry damage envelope');
  }
  if (projectedNetTargetUsd + 1e-9 < amendment.minProjectedNetTargetUsd) {
    throw new CompetitionDecisionRejected('projected net target is below the authorised minimum');
  }
  if (!Number.isFinite(state.entryToleranceBps) || state.entryToleranceBps < 0 ||
      state.entryToleranceBps > amendment.maxEntryToleranceBps) {
    throw new CompetitionDecisionRejected('entry tolerance is outside the authorised range');
  }
  const drift = entry * state.entryToleranceBps / 10_000;
  const validUntil = Math.min(signal.expiresAt, state.now + amendment.maxValidityMs, amendment.latestEntryAt);
  if (validUntil <= state.now) throw new CompetitionDecisionRejected('second-entry event has no valid execution window');

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
