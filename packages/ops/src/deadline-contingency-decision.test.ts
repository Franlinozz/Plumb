import { DEADLINE_CONTINGENCY_AMENDMENT, FINAL_WINDOW_CONTINGENCY_AMENDMENT, type Signal } from '@plumb/core';
import type { Approval } from '@plumb/risk';
import { describe, expect, it } from 'vitest';

import { createDeadlineContingencyDecision, createFinalWindowContingencyDecision } from './deadline-contingency-decision.js';

const NOW = DEADLINE_CONTINGENCY_AMENDMENT.earliestEntryAt + 3_600_000;
const signal: Signal = {
  id: 'SIG-DEADLINE001', ts: NOW, instId: 'ETH-USDT-SWAP', side: 'long', intent: 'open',
  entry: { type: 'market', price: 100 },
  stop: { price: 98, distancePct: 0.02, basis: 'structure' },
  takeProfit: [{ price: 103, rMultiple: 1.5 }],
  timeframe: '1H', strategyId: 'deadline_contingency', regime: 'trending_up',
  inputs: {
    fourHourAdx: 40, hourlyClose: 100, hourlyPreviousClose: 99, hourlyEma20: 99.5,
    hourlyRsi: 55, hourlyMacdHistogram: -0.1, hourlyMacdHistogramPrevious: -0.2,
    volumeRatio: 1,
  },
  invalidation: { maxHoldBars: 24, conditions: ['trend fails'] },
  expiresAt: NOW + 30 * 60_000, version: '1.0.0',
};
const approval: Approval = {
  approved: true,
  signalId: signal.id,
  sizing: {
    ok: true, instId: signal.instId, contracts: 2, notionalUsdt: 200, leverage: 1,
    stopDistancePct: 0.02, intendedRiskUsdt: 4, actualRiskUsdt: 4,
    clampedByLeverage: false,
  },
  drawdown: {} as Approval['drawdown'],
  state: {} as Approval['state'],
};
const input = () => ({
  signal,
  approval,
  costs: {
    entryFeeBps: 5, exitFeeBps: 5, slippageBps: 1, spreadImpactBps: 0.2,
    expectedFundingBps: 1,
  },
  metadata: { ctVal: 1, ctMult: 1, minSz: 0.01, lotSz: 0.01, state: 'live' },
  state: {
    now: NOW, livePrice: 100, marketDataAt: NOW, maxMarketAgeMs: 30_000,
    openInterestAt: NOW, maxOpenInterestAgeMs: 3_600_000,
    openInterestChangePct1h: -0.005, openInterestChangePct4h: -0.01,
    openInterestChangePct24h: -0.02, priceChangePct24h: -0.004,
    spreadBps: 0.5, fundingRate: 0.0001,
    equityUsd: 400, venueLeverage: 1,
    venuePositionBefore: 0, ledgerPositionBefore: 0, quantityTolerance: 0.005,
    reconciliationVersion: 'signed-v2', reconciliationHealthy: true,
    instrumentMetadataPresent: true, accountCertain: true, duplicateDecision: false,
    haltFlags: { killSwitch: false }, closedFourHourEmaDirection: 'up' as const,
    closedFourHourAdx: 40, entryToleranceBps: 10,
  },
});

describe('operator-authorised deadline-contingency DecisionEvent factory', () => {
  it('records zero expected edge and preserves the exact damage/payoff envelope', () => {
    const event = createDeadlineContingencyDecision(input());
    expect(event).toMatchObject({
      approvalBasis: 'operator-deadline-contingency-v1',
      strategyVersion: 'deadline_contingency@1.0.0',
      instrument: 'ETH-USDT-SWAP',
      direction: 'long',
      riskUsd: 4,
      positionPct: 50,
      referencePrice: 100,
      approvedContracts: 2,
      approvedNotionalUsd: 200,
      expectedEdgeBps: 0,
    });
    expect(event.validUntil).toBe(NOW + 30 * 60_000);
  });

  it('fails closed on a forged recovery, severe unwind, occupied instrument, or BTC substitution', () => {
    const forged = input();
    expect(() => createDeadlineContingencyDecision({
      ...forged,
      signal: { ...forged.signal, inputs: { ...forged.signal.inputs, hourlyClose: 99 } },
    })).toThrow(/recovery/u);
    const unwind = input();
    expect(() => createDeadlineContingencyDecision({
      ...unwind, state: { ...unwind.state, openInterestChangePct1h: -0.02 },
    })).toThrow(/OI unwind/u);
    const occupied = input();
    expect(() => createDeadlineContingencyDecision({
      ...occupied, state: { ...occupied.state, venuePositionBefore: 0.1, ledgerPositionBefore: 0.1 },
    })).toThrow(/flat/u);
    const btc = input();
    expect(() => createDeadlineContingencyDecision({
      ...btc, signal: { ...btc.signal, instId: 'BTC-USDT-SWAP' },
    })).toThrow(/ETH\/SOL/u);
  });

  it('does not allow the contingency to overlap v3 or the hard exit', () => {
    const candidate = input();
    expect(() => createDeadlineContingencyDecision({
      ...candidate, state: { ...candidate.state, now: DEADLINE_CONTINGENCY_AMENDMENT.earliestEntryAt - 1 },
    })).toThrow(/window/u);
    expect(() => createDeadlineContingencyDecision({
      ...candidate, state: { ...candidate.state, now: DEADLINE_CONTINGENCY_AMENDMENT.latestEntryAt },
    })).toThrow(/window/u);
  });
});

describe('operator-authorised final-window-contingency V2 DecisionEvent factory', () => {
  it('uses the distinct V2 identity without changing the damage envelope', () => {
    const candidate = input();
    const finalNow = FINAL_WINDOW_CONTINGENCY_AMENDMENT.earliestEntryAt + 60_000;
    const finalSignal = { ...candidate.signal, ts: finalNow,
      strategyId: FINAL_WINDOW_CONTINGENCY_AMENDMENT.strategyId,
      version: FINAL_WINDOW_CONTINGENCY_AMENDMENT.strategyVersion,
      expiresAt: finalNow + FINAL_WINDOW_CONTINGENCY_AMENDMENT.maxValidityMs };
    const event = createFinalWindowContingencyDecision({
      ...candidate,
      signal: finalSignal,
      approval: { ...candidate.approval, signalId: finalSignal.id },
      state: { ...candidate.state, now: finalNow, marketDataAt: finalNow, openInterestAt: finalNow },
    });
    expect(event).toMatchObject({
      approvalBasis: 'operator-final-window-contingency-v2',
      strategyVersion: 'final_window_contingency@2.0.0',
      riskUsd: 4,
      positionPct: 50,
      expectedEdgeBps: 0,
    });
    expect(event.entryLow).toBeCloseTo(99.9, 10);
    expect(event.entryHigh).toBeCloseTo(100, 8);
    expect(event.referencePrice).toBe(100);
  });

  it('accepts the favorable half of the published tolerance with frozen contracts', () => {
    const candidate = input();
    const finalNow = FINAL_WINDOW_CONTINGENCY_AMENDMENT.earliestEntryAt + 60_000;
    const finalSignal = { ...candidate.signal, ts: finalNow,
      strategyId: FINAL_WINDOW_CONTINGENCY_AMENDMENT.strategyId,
      version: FINAL_WINDOW_CONTINGENCY_AMENDMENT.strategyVersion,
      expiresAt: finalNow + FINAL_WINDOW_CONTINGENCY_AMENDMENT.maxValidityMs };
    const event = createFinalWindowContingencyDecision({
      ...candidate,
      signal: finalSignal,
      approval: { ...candidate.approval, signalId: finalSignal.id },
      state: { ...candidate.state, now: finalNow, livePrice: 99.92,
        marketDataAt: finalNow, openInterestAt: finalNow },
    });
    expect(event.approvedContracts).toBe(2);
    expect(event.entryLow).toBeCloseTo(99.9, 10);
  });

  it('rejects the adverse side when fixed-size stop risk would exceed its immutable ceiling', () => {
    const candidate = input();
    const finalNow = FINAL_WINDOW_CONTINGENCY_AMENDMENT.earliestEntryAt + 60_000;
    const finalSignal = { ...candidate.signal, ts: finalNow,
      strategyId: FINAL_WINDOW_CONTINGENCY_AMENDMENT.strategyId,
      version: FINAL_WINDOW_CONTINGENCY_AMENDMENT.strategyVersion,
      expiresAt: finalNow + FINAL_WINDOW_CONTINGENCY_AMENDMENT.maxValidityMs };
    expect(() => createFinalWindowContingencyDecision({
      ...candidate,
      signal: finalSignal,
      approval: { ...candidate.approval, signalId: finalSignal.id },
      state: { ...candidate.state, now: finalNow, livePrice: 100.08,
        marketDataAt: finalNow, openInterestAt: finalNow },
    })).toThrow(/executor-compatible entry range/u);
  });
});
