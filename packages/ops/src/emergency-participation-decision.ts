import {
  EMERGENCY_PARTICIPATION_AMENDMENT,
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

export interface EmergencyParticipationMetadata {
  readonly ctVal: number;
  readonly ctMult: number;
  readonly minSz: number;
  readonly lotSz: number;
  readonly state: string;
}

export interface EmergencyParticipationInput {
  readonly signal: Signal;
  readonly approval: Approval;
  readonly costs: CompetitionCostEstimate;
  readonly state: CompetitionDecisionState & { readonly oneHourRsi: number };
  readonly metadata: EmergencyParticipationMetadata;
}

const finiteNonnegative = (name: string, value: number): number => {
  if (!Number.isFinite(value) || value < 0) throw new CompetitionDecisionRejected(`${name} is invalid`);
  return value;
};

/**
 * Transparently convert the operator-authorised evidence-limited signal into one immutable event.
 * Expected edge is zero: this path never converts a target, trend, or hope into a fake forecast.
 */
export function createEmergencyParticipationDecision(input: EmergencyParticipationInput): DecisionEvent {
  const { signal, approval, state, metadata } = input;
  const amendment = EMERGENCY_PARTICIPATION_AMENDMENT;
  if (state.now < amendment.authorisedAt || state.now >= amendment.latestEntryAt) {
    throw new CompetitionDecisionRejected('outside the emergency participation window');
  }
  if (signal.strategyId !== amendment.strategyId || signal.version !== amendment.strategyVersion ||
      signal.instId !== amendment.instrument || signal.intent !== 'open') {
    throw new CompetitionDecisionRejected('signal is not the authorised emergency participation strategy');
  }
  if (!approval.approved || approval.signalId !== signal.id) {
    throw new CompetitionDecisionRejected('governor did not approve this exact signal');
  }
  if (signal.ts > state.now || state.now >= signal.expiresAt ||
      signal.expiresAt - signal.ts > amendment.maxValidityMs) {
    throw new CompetitionDecisionRejected('signal is future-dated, stale, or valid for too long');
  }
  if (state.marketDataAt > state.now || state.now - state.marketDataAt > state.maxMarketAgeMs ||
      state.openInterestAt > state.now || state.now - state.openInterestAt > state.maxOpenInterestAgeMs) {
    throw new CompetitionDecisionRejected('market or open-interest data is stale or future-dated');
  }
  const direction = signal.side === 'long' ? 'up' : 'down';
  const priceConfirmed = signal.side === 'long'
    ? state.priceChangePct24h >= amendment.minAbsPriceChangePct24h
    : state.priceChangePct24h <= -amendment.minAbsPriceChangePct24h;
  if (state.closedFourHourEmaDirection !== direction ||
      !Number.isFinite(state.closedFourHourAdx) || state.closedFourHourAdx < amendment.minClosedFourHourAdx ||
      !priceConfirmed || !Number.isFinite(state.openInterestChangePct24h) ||
      state.openInterestChangePct24h < amendment.minOpenInterestChangePct24h ||
      !Number.isFinite(state.oneHourRsi) || state.oneHourRsi < amendment.minOneHourRsi ||
      state.oneHourRsi > amendment.maxOneHourRsi) {
    throw new CompetitionDecisionRejected('trend, participation, or non-extreme RSI confirmation failed');
  }
  if (Object.values(state.haltFlags).some(Boolean) || !state.reconciliationHealthy ||
      !state.instrumentMetadataPresent || !state.accountCertain || state.duplicateDecision) {
    throw new CompetitionDecisionRejected('a safety, reconciliation, metadata, account, or duplicate gate failed');
  }
  if (Math.abs(state.venuePositionBefore - state.ledgerPositionBefore) > state.quantityTolerance) {
    throw new CompetitionDecisionRejected('signed venue and ledger positions disagree');
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
  const expectedCostBps = Object.entries(input.costs).reduce(
    (total, [name, value]) => total + finiteNonnegative(name, value),
    0,
  );
  const notional = metadata.minSz * metadata.ctVal * metadata.ctMult * entry;
  const stopDistancePct = Math.abs(entry - signal.stop.price) / entry;
  const riskUsd = notional * stopDistancePct;
  const positionPct = notional / state.equityUsd * 100;
  const plannedLossUsd = riskUsd + notional * expectedCostBps / 10_000;
  if (!Number.isFinite(notional) || notional <= 0 || !Number.isFinite(riskUsd) || riskUsd <= 0 ||
      riskUsd > amendment.maxStopRiskUsd || plannedLossUsd > amendment.maxPlannedLossUsd ||
      approval.sizing.actualRiskUsdt + 1e-9 < riskUsd) {
    throw new CompetitionDecisionRejected('minimum-lot sizing exceeds the amendment or governor approval');
  }
  if (!Number.isFinite(state.entryToleranceBps) || state.entryToleranceBps < 0 || state.entryToleranceBps > 10) {
    throw new CompetitionDecisionRejected('entry tolerance must be between 0 and 10 bps');
  }
  const drift = entry * state.entryToleranceBps / 10_000;

  return finalizeDecisionEvent({
    decisionId: `DEC-${signal.id.slice(4)}`,
    strategyVersion: `${amendment.strategyId}@${amendment.strategyVersion}`,
    createdAt: state.now,
    validUntil: signal.expiresAt,
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
