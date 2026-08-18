import { createHash } from 'node:crypto';

import {
  COMPETITION_V2_AMENDMENT,
  finalizeDecisionEvent,
  MIN_EXPECTED_EDGE_COST_MULTIPLE,
  type DecisionEvent,
  type Signal,
} from '@plumb/core';
import {
  verifyEdgeCalibration,
  verifyRecord,
  type EdgeCalibrationRecord,
  type EligibilityRecord,
} from '@plumb/backtest';
import { isTrendAlignedBreakout, type StrategyConfig } from '@plumb/strategy';
import type { Approval } from '@plumb/risk';

export interface CompetitionCostEstimate {
  readonly entryFeeBps: number;
  readonly exitFeeBps: number;
  readonly slippageBps: number;
  readonly spreadImpactBps: number;
  readonly expectedFundingBps: number;
}

export interface CompetitionEvidence {
  readonly config: StrategyConfig;
  readonly configHash: string;
  readonly eligibility: EligibilityRecord;
  readonly calibration: EdgeCalibrationRecord;
  readonly holdout: CompetitionHoldoutEvidence;
}

export interface CompetitionHoldoutEvidence {
  readonly generatedAt: string;
  readonly scope: 'single-use-protected-holdout';
  readonly configHash: string;
  readonly auditConfigHash: string;
  readonly fromTs: number;
  readonly toTs: number;
  readonly passed: boolean;
  readonly checks: readonly Readonly<Record<string, unknown>>[];
  readonly metrics: Readonly<Record<string, unknown>>;
  readonly outlier: Readonly<Record<string, unknown>>;
  readonly signature: string;
}

export interface CompetitionDecisionState {
  readonly now: number;
  readonly marketDataAt: number;
  readonly maxMarketAgeMs: number;
  readonly openInterestAt: number;
  readonly maxOpenInterestAgeMs: number;
  readonly openInterestChangePct24h: number;
  readonly priceChangePct24h: number;
  readonly equityUsd: number;
  readonly venueLeverage: number;
  readonly venuePositionBefore: number;
  readonly ledgerPositionBefore: number;
  readonly quantityTolerance: number;
  readonly reconciliationVersion: string;
  readonly reconciliationHealthy: boolean;
  readonly instrumentMetadataPresent: boolean;
  readonly accountCertain: boolean;
  readonly duplicateDecision: boolean;
  readonly haltFlags: Readonly<Record<string, boolean>>;
  /** Most recent fully closed 4H bar only; never an intrabar classification. */
  readonly closedFourHourEmaDirection: 'up' | 'down' | 'unclear';
  readonly closedFourHourAdx: number;
  /** Maximum drift around the signal price accepted for the executable entry range. */
  readonly entryToleranceBps: number;
}

export interface CompetitionDecisionInput {
  readonly signal: Signal;
  readonly approval: Approval;
  readonly evidence: CompetitionEvidence;
  readonly costs: CompetitionCostEstimate;
  readonly state: CompetitionDecisionState;
}

export class CompetitionDecisionRejected extends Error {
  constructor(readonly reason: string) {
    super(`competition decision rejected: ${reason}`);
    this.name = 'CompetitionDecisionRejected';
  }
}

export const competitionConfigHash = (config: StrategyConfig): string =>
  createHash('sha256').update(JSON.stringify(config)).digest('hex');

/** Predeclared before the protected holdout is opened. Changing it requires a new research cycle. */
export const FROZEN_COMPETITION_CONFIG_HASH =
  '7ceee41a072da808af0e32a05d7b0808e6bc348a7b31107b3b21cabc05318563';

export function signCompetitionHoldoutEvidence(
  evidence: Omit<CompetitionHoldoutEvidence, 'signature'>,
): string {
  return createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
}

export function verifyCompetitionHoldoutEvidence(evidence: CompetitionHoldoutEvidence): boolean {
  const { signature, ...unsigned } = evidence;
  return signature === signCompetitionHoldoutEvidence(unsigned);
}

const finiteNonnegative = (name: string, value: number): number => {
  if (!Number.isFinite(value) || value < 0) throw new CompetitionDecisionRejected(`${name} is invalid`);
  return value;
};

/**
 * The only sanctioned conversion from a strategy Signal into the immutable competition event.
 * It makes no directional or sizing choice of its own: direction/stop/target come from Signal,
 * approval comes from the governor, risk is only reduced by competition-specific safety caps.
 */
export function createCompetitionDecision(input: CompetitionDecisionInput): DecisionEvent {
  const { signal, approval, evidence, state } = input;
  if (signal.strategyId !== 'vol_expansion' || signal.version !== '1.1.0') {
    throw new CompetitionDecisionRejected('signal is not from the frozen competition strategy');
  }
  if (signal.instId !== 'ETH-USDT-SWAP') {
    throw new CompetitionDecisionRejected('only the predeclared ETH first-trade subset is eligible');
  }
  if (!isTrendAlignedBreakout(signal.side, signal.regime)) {
    throw new CompetitionDecisionRejected('signal direction is not aligned with its trend regime');
  }
  const fourHourDirectionConfirmed = signal.side === 'long'
    ? state.closedFourHourEmaDirection === 'up'
    : state.closedFourHourEmaDirection === 'down';
  if (!fourHourDirectionConfirmed ||
      !Number.isFinite(state.closedFourHourAdx) || state.closedFourHourAdx < 25) {
    throw new CompetitionDecisionRejected('closed 4H trend does not confirm the signal');
  }
  if (approval.signalId !== signal.id) throw new CompetitionDecisionRejected('governor approved a different signal');
  if (signal.ts > state.now || state.now >= signal.expiresAt) {
    throw new CompetitionDecisionRejected('signal is future-dated or stale');
  }
  if (state.marketDataAt > state.now || state.now - state.marketDataAt > state.maxMarketAgeMs) {
    throw new CompetitionDecisionRejected('market data is stale or future-dated');
  }
  if (state.openInterestAt > state.now || state.now - state.openInterestAt > state.maxOpenInterestAgeMs) {
    throw new CompetitionDecisionRejected('open-interest data is stale or future-dated');
  }
  const directionalPriceConfirmed = signal.side === 'long'
    ? state.priceChangePct24h > 0.001
    : state.priceChangePct24h < -0.001;
  if (!Number.isFinite(state.openInterestChangePct24h) || state.openInterestChangePct24h <= 0.001 ||
      !Number.isFinite(state.priceChangePct24h) || !directionalPriceConfirmed) {
    throw new CompetitionDecisionRejected('24H price/open-interest participation does not confirm the signal');
  }
  if (Object.values(state.haltFlags).some(Boolean)) throw new CompetitionDecisionRejected('a halt flag is active');
  if (!state.reconciliationHealthy) throw new CompetitionDecisionRejected('reconciliation is unhealthy');
  if (!state.instrumentMetadataPresent) throw new CompetitionDecisionRejected('instrument metadata is absent');
  if (!state.accountCertain) throw new CompetitionDecisionRejected('account state is uncertain');
  if (state.duplicateDecision) throw new CompetitionDecisionRejected('decision is a duplicate');
  if (Math.abs(state.venuePositionBefore - state.ledgerPositionBefore) > state.quantityTolerance) {
    throw new CompetitionDecisionRejected('signed venue and ledger positions disagree');
  }
  if (!Number.isFinite(state.equityUsd) || state.equityUsd <= 0) {
    throw new CompetitionDecisionRejected('equity is invalid');
  }
  if (!Number.isFinite(state.venueLeverage) || state.venueLeverage <= 0 || state.venueLeverage > 3) {
    throw new CompetitionDecisionRejected('venue leverage is invalid or above 3x');
  }
  if (!Number.isFinite(state.entryToleranceBps) || state.entryToleranceBps < 0 || state.entryToleranceBps > 10) {
    throw new CompetitionDecisionRejected('entry tolerance must be between 0 and 10 bps');
  }

  const actualHash = competitionConfigHash(evidence.config);
  if (actualHash !== evidence.configHash) throw new CompetitionDecisionRejected('strategy config hash mismatch');
  if (actualHash !== FROZEN_COMPETITION_CONFIG_HASH || evidence.eligibility.label !== 'aligned-default') {
    throw new CompetitionDecisionRejected('strategy evidence is not the frozen competition candidate');
  }
  if (!evidence.config.volExpansion.requireTrendAlignment) {
    throw new CompetitionDecisionRejected('strategy config does not require trend alignment');
  }
  if (!verifyRecord(evidence.eligibility) || !evidence.eligibility.eligible) {
    throw new CompetitionDecisionRejected('development eligibility record is invalid or not green');
  }
  if (!verifyCompetitionHoldoutEvidence(evidence.holdout) || !evidence.holdout.passed ||
      evidence.holdout.configHash !== actualHash || evidence.holdout.auditConfigHash !== actualHash.slice(0, 16) ||
      evidence.holdout.scope !== 'single-use-protected-holdout' || evidence.holdout.fromTs >= evidence.holdout.toTs ||
      evidence.holdout.checks.length === 0 || !evidence.holdout.checks.every((check) => check['passed'] === true)) {
    throw new CompetitionDecisionRejected('protected holdout evidence is invalid or not green');
  }
  const calibration = evidence.calibration;
  if (!verifyEdgeCalibration(calibration)) {
    throw new CompetitionDecisionRejected('edge calibration record is invalid');
  }
  if (calibration.configHash !== actualHash || calibration.strategyVersion !== signal.version ||
      calibration.strategyId !== signal.strategyId || calibration.instrument !== signal.instId) {
    throw new CompetitionDecisionRejected('edge calibration is for a different strategy or config');
  }
  if (calibration.sampleSize < 12 || !Number.isFinite(calibration.conservativeExpectedEdgeBps) ||
      calibration.conservativeExpectedEdgeBps <= 0) {
    throw new CompetitionDecisionRejected('edge calibration is insufficient');
  }

  const expectedCostBps = Object.entries(input.costs).reduce(
    (total, [name, value]) => total + finiteNonnegative(name, value),
    0,
  );
  if (calibration.conservativeExpectedEdgeBps < expectedCostBps * MIN_EXPECTED_EDGE_COST_MULTIPLE) {
    throw new CompetitionDecisionRejected('calibrated edge is below 3x current friction');
  }

  const entry = signal.entry.price;
  const takeProfit = signal.takeProfit?.[0]?.price;
  if (entry === undefined || takeProfit === undefined) {
    throw new CompetitionDecisionRejected('signal lacks an absolute entry or take-profit');
  }
  const stopDistancePct = Math.abs(entry - signal.stop.price) / entry;
  if (!Number.isFinite(stopDistancePct) || stopDistancePct <= 0) {
    throw new CompetitionDecisionRejected('stop distance is invalid');
  }

  // Operator-authorised first-trade amendment: a cap may only reduce the governor-approved risk;
  // it may never widen the stop or manufacture an edge. Full estimated friction is included in
  // the maximum planned loss, not hidden outside the stop-risk figure.
  const costRate = expectedCostBps / 10_000;
  const maxRiskForPlannedLoss = COMPETITION_V2_AMENDMENT.maxPlannedLossUsd /
    (1 + costRate / stopDistancePct);
  const riskUsd = Math.min(
    COMPETITION_V2_AMENDMENT.maxStopRiskUsd,
    COMPETITION_V2_AMENDMENT.maxNotionalUsd * stopDistancePct,
    state.equityUsd * (COMPETITION_V2_AMENDMENT.maxPositionPct / 100) * stopDistancePct,
    maxRiskForPlannedLoss,
    approval.sizing.actualRiskUsdt,
  );
  const notional = riskUsd / stopDistancePct;
  const positionPct = (notional / state.equityUsd) * 100;
  const plannedLossUsd = riskUsd + notional * costRate;
  if (!Number.isFinite(riskUsd) || riskUsd <= 0 ||
      notional > COMPETITION_V2_AMENDMENT.maxNotionalUsd + 1e-9 ||
      positionPct > COMPETITION_V2_AMENDMENT.maxPositionPct + 1e-9 ||
      plannedLossUsd > COMPETITION_V2_AMENDMENT.maxPlannedLossUsd + 1e-9) {
    throw new CompetitionDecisionRejected('competition sizing is invalid');
  }

  const drift = entry * state.entryToleranceBps / 10_000;
  const entryLow = entry - drift;
  const entryHigh = entry + drift;
  const decisionId = `DEC-${signal.id.slice(4)}`;

  return finalizeDecisionEvent({
    decisionId,
    strategyVersion: `${signal.strategyId}@${signal.version}:${actualHash.slice(0, 16)}`,
    createdAt: state.now,
    validUntil: signal.expiresAt,
    instrument: signal.instId,
    direction: signal.side,
    entryLow,
    entryHigh,
    stopPrice: signal.stop.price,
    takeProfit,
    positionPct,
    leverage: state.venueLeverage,
    riskUsd,
    expectedCostBps,
    expectedEdgeBps: calibration.conservativeExpectedEdgeBps,
    governorApproved: true,
    venuePositionBefore: state.venuePositionBefore,
    ledgerPositionBefore: state.ledgerPositionBefore,
    reconciliationVersion: state.reconciliationVersion,
  });
}
