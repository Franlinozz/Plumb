import type { Signal } from '@plumb/core';
import { DEFAULT_STRATEGY_CONFIG, STRATEGY_IDS } from '@plumb/strategy';
import {
  calibrateExpectedGrossEdge,
  signRecord,
  type BacktestTrade,
  type EligibilityRecord,
} from '@plumb/backtest';
import type { Approval } from '@plumb/risk';
import { describe, expect, it } from 'vitest';

import {
  CompetitionDecisionRejected,
  competitionConfigHash,
  createCompetitionDecision,
  signCompetitionHoldoutEvidence,
  type CompetitionDecisionInput,
} from './competition-decision.js';

const NOW = Date.parse('2026-08-17T18:00:00Z');
const config = {
  ...DEFAULT_STRATEGY_CONFIG,
  enabled: Object.fromEntries(STRATEGY_IDS.map((id) => [id, id === 'vol_expansion'])),
  volExpansion: { ...DEFAULT_STRATEGY_CONFIG.volExpansion, requireTrendAlignment: true },
};
const configHash = competitionConfigHash(config);

const unsigned = {
  label: 'aligned-default',
  eligible: true,
  criteria: [
    { name: 'P(ruin)', passed: true, actual: '0.12%', required: '<= 5%', detail: 'test' },
  ],
  failedOn: [],
  outOfSampleMetrics: {
    tradeCount: 121,
    profitFactor: 1.999,
    totalReturnUsdt: 215.5,
    maxDrawdownPct: 7.29,
  },
  monteCarlo: { probabilityOfRuin: 0.0012, p5Equity: 381 },
  evaluatedAt: NOW - 1,
  criteriaUsed: { killSwitchEquity: 335, maxProbabilityOfRuin: 0.05,
    minProfitFactor: 1, minOutOfSampleTrades: 30 },
} as unknown as Omit<EligibilityRecord, 'signature'>;
const eligibility: EligibilityRecord = { ...unsigned, signature: signRecord(unsigned) };

const calibrationTrades = Array.from({ length: 40 }, (_, index): BacktestTrade => ({
  signalId: `CAL-${index}`,
  strategyId: 'vol_expansion',
  instId: 'ETH-USDT-SWAP',
  side: 'long',
  regime: 'trending_up',
  openedAt: index * 2,
  closedAt: index * 2 + 1,
  holdBars: 1,
  entryPrice: 100,
  exitPrice: 101,
  contracts: 1,
  notionalUsdt: 100,
  grossPnlUsdt: 1,
  feesUsdt: 0.1,
  fundingUsdt: 0,
  netPnlUsdt: 0.9,
  exitReason: 'timeout',
  equityAfter: 400,
  fundingFallbackSettlements: 0,
}));
const calibration = calibrateExpectedGrossEdge({
  trades: calibrationTrades,
  strategyId: 'vol_expansion',
  strategyVersion: '1.1.0',
  configHash,
  instrument: 'ETH-USDT-SWAP',
  calculatedAt: NOW - 1,
  iterations: 1_000,
});
const holdoutUnsigned = {
  generatedAt: new Date(NOW - 1).toISOString(),
  scope: 'single-use-protected-holdout' as const,
  configHash,
  auditConfigHash: configHash.slice(0, 16),
  fromTs: NOW - 90 * 86_400_000,
  toTs: NOW - 1,
  passed: true,
  checks: [{ name: 'all', passed: true }],
  metrics: { tradeCount: 20 },
  outlier: { passed: true },
};
const holdout = { ...holdoutUnsigned, signature: signCompetitionHoldoutEvidence(holdoutUnsigned) };

const signal: Signal = {
  id: 'SIG-ABCDEFGHIJ',
  ts: NOW - 60_000,
  instId: 'ETH-USDT-SWAP',
  side: 'long',
  intent: 'open',
  entry: { type: 'market', price: 100 },
  stop: { price: 98, distancePct: 0.02, basis: 'structure' },
  takeProfit: [{ price: 104, rMultiple: 2 }],
  timeframe: '1H',
  strategyId: 'vol_expansion',
  regime: 'trending_up',
  inputs: { breakStrengthAtr: 0.7 },
  invalidation: { maxHoldBars: 48, conditions: ['break failed'] },
  expiresAt: NOW + 3_600_000,
  version: '1.1.0',
};

const approval: Approval = {
  approved: true,
  signalId: signal.id,
  sizing: {
    ok: true,
    instId: signal.instId,
    contracts: 1,
    notionalUsdt: 200,
    leverage: 2,
    stopDistancePct: 0.02,
    intendedRiskUsdt: 4,
    actualRiskUsdt: 4,
    clampedByLeverage: false,
  },
  drawdown: {} as Approval['drawdown'],
  state: {} as Approval['state'],
};

const input = (): CompetitionDecisionInput => ({
  signal,
  approval,
  evidence: {
    config,
    configHash,
    eligibility,
    calibration,
    holdout,
  },
  costs: {
    entryFeeBps: 5,
    exitFeeBps: 5,
    slippageBps: 1,
    spreadImpactBps: 1,
    expectedFundingBps: 0,
  },
  state: {
    now: NOW,
    marketDataAt: NOW - 1_000,
    maxMarketAgeMs: 30_000,
    openInterestAt: NOW - 1_000,
    maxOpenInterestAgeMs: 300_000,
    openInterestChangePct24h: 0.02,
    priceChangePct24h: 0.01,
    equityUsd: 400,
    venueLeverage: 2,
    venuePositionBefore: 0,
    ledgerPositionBefore: 0,
    quantityTolerance: 0.0001,
    reconciliationVersion: 'signed-v2',
    reconciliationHealthy: true,
    instrumentMetadataPresent: true,
    accountCertain: true,
    duplicateDecision: false,
    haltFlags: { killSwitch: false, dailyLimit: false },
    closedFourHourEmaDirection: 'up',
    closedFourHourAdx: 30,
    entryToleranceBps: 5,
  },
});

describe('competition DecisionEvent factory', () => {
  it('creates the one immutable shared event and applies stricter first-trade caps', () => {
    const event = createCompetitionDecision(input());
    expect(event.decisionId).toBe('DEC-ABCDEFGHIJ');
    expect(event.direction).toBe(signal.side);
    expect(event.stopPrice).toBe(signal.stop.price);
    expect(event.takeProfit).toBe(signal.takeProfit?.[0]?.price);
    expect(event.riskUsd).toBe(0.25);
    expect(event.positionPct).toBe(3.125);
    expect(event.expectedCostBps).toBe(12);
    expect(event.expectedEdgeBps).toBe(50);
    expect(Object.isFrozen(event)).toBe(true);
  });

  it('caps stop risk, notional, position percentage, and stop-plus-friction loss', () => {
    const candidate = input();
    const event = createCompetitionDecision({
      ...candidate,
      signal: {
        ...candidate.signal,
        stop: { ...candidate.signal.stop, price: 99.9, distancePct: 0.001 },
      },
    });
    const notional = event.riskUsd / 0.001;
    const plannedLoss = event.riskUsd + notional * event.expectedCostBps / 10_000;
    expect(event.riskUsd).toBeLessThanOrEqual(0.25);
    expect(notional).toBeLessThanOrEqual(40);
    expect(event.positionPct).toBeLessThanOrEqual(10);
    expect(plannedLoss).toBeLessThanOrEqual(0.35);
  });

  it('rejects a config whose contents do not match its evidence hash', () => {
    const candidate = input();
    const changed = { ...candidate.evidence.config, maxHoldBars: 36 };
    expect(() => createCompetitionDecision({
      ...candidate,
      evidence: { ...candidate.evidence, config: changed },
    })).toThrow(/config hash mismatch/u);
  });

  it('rejects a different signed eligible label', () => {
    const candidate = input();
    const changedUnsigned = { ...unsigned, label: 'neighbour' };
    expect(() => createCompetitionDecision({
      ...candidate,
      evidence: { ...candidate.evidence,
        eligibility: { ...changedUnsigned, signature: signRecord(changedUnsigned) } },
    })).toThrow(/frozen competition candidate/u);
  });

  it('rejects an edited eligibility record', () => {
    const candidate = input();
    expect(() => createCompetitionDecision({
      ...candidate,
      evidence: { ...candidate.evidence,
        eligibility: { ...candidate.evidence.eligibility, signature: 'edited' } },
    })).toThrow(/eligibility record/u);
  });

  it('rejects absent, failed, or edited protected-holdout evidence', () => {
    const candidate = input();
    expect(() => createCompetitionDecision({ ...candidate,
      evidence: { ...candidate.evidence, holdout: { ...holdout, passed: false } } }))
      .toThrow(/holdout evidence/u);
  });

  it('rejects when the calibrated lower-bound edge is below three times friction', () => {
    const candidate = input();
    expect(() => createCompetitionDecision({
      ...candidate,
      costs: { ...candidate.costs, expectedFundingBps: 5 },
    })).toThrow(/below 3x/u);
  });

  it('rejects a stale signal, active halt, or signed position mismatch', () => {
    const stale = input();
    expect(() => createCompetitionDecision({ ...stale, state: { ...stale.state, now: signal.expiresAt } }))
      .toThrow(/stale/u);
    const halted = input();
    expect(() => createCompetitionDecision({ ...halted,
      state: { ...halted.state, haltFlags: { manual: true } } })).toThrow(/halt/u);
    const mismatch = input();
    expect(() => createCompetitionDecision({ ...mismatch,
      state: { ...mismatch.state, venuePositionBefore: -1 } })).toThrow(/positions disagree/u);
  });

  it('rejects a breakout against the classified trend', () => {
    const candidate = input();
    expect(() => createCompetitionDecision({
      ...candidate,
      signal: { ...candidate.signal, side: 'short' },
    })).toThrow(CompetitionDecisionRejected);
  });

  it('rejects BTC and SOL because only the profitable ETH 4H subset was predeclared', () => {
    const candidate = input();
    expect(() => createCompetitionDecision({
      ...candidate,
      signal: { ...candidate.signal, instId: 'BTC-USDT-SWAP' },
    })).toThrow(/ETH first-trade subset/u);
  });

  it('rejects absent or weak closed-4H confirmation', () => {
    const candidate = input();
    expect(() => createCompetitionDecision({ ...candidate,
      state: { ...candidate.state, closedFourHourEmaDirection: 'down' } }))
      .toThrow(/4H trend/u);
    expect(() => createCompetitionDecision({ ...candidate,
      state: { ...candidate.state, closedFourHourAdx: 24.99 } }))
      .toThrow(/4H trend/u);
  });

  it('rejects stale or non-confirming open interest', () => {
    const candidate = input();
    expect(() => createCompetitionDecision({ ...candidate,
      state: { ...candidate.state, openInterestAt: NOW - 300_001 } }))
      .toThrow(/open-interest data is stale/u);
    expect(() => createCompetitionDecision({ ...candidate,
      state: { ...candidate.state, openInterestChangePct24h: -0.01 } }))
      .toThrow(/participation/u);
  });
});
