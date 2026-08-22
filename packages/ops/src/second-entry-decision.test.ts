import type { Signal } from '@plumb/core';
import type { Approval } from '@plumb/risk';
import { describe, expect, it } from 'vitest';

import { createSecondEntryDecision } from './second-entry-decision.js';

const NOW = Date.parse('2026-08-21T16:00:00Z');
const signal: Signal = {
  id: 'SIG-SECONDENTRY1', ts: NOW, instId: 'BTC-USDT-SWAP', side: 'long', intent: 'open',
  entry: { type: 'market', price: 76_000 },
  stop: { price: 74_500, distancePct: 1_500 / 76_000, basis: 'structure' },
  takeProfit: [{ price: 78_250, rMultiple: 1.5 }], timeframe: '1H',
  strategyId: 'competition_trend_pullback', regime: 'trending_up',
  inputs: { fourHourAdx: 40, hourlyRsi: 60 },
  invalidation: { maxHoldBars: 36, conditions: ['trend fails'] },
  expiresAt: NOW + 2 * 3_600_000, version: '3.0.0',
};
const approval: Approval = {
  approved: true, signalId: signal.id,
  sizing: { ok: true, instId: signal.instId, contracts: 0.26, notionalUsdt: 200,
    leverage: 0.5, stopDistancePct: 1_500 / 76_000, intendedRiskUsdt: 4,
    actualRiskUsdt: 4, clampedByLeverage: false },
  drawdown: {} as Approval['drawdown'], state: {} as Approval['state'],
};
const input = () => ({
  signal, approval,
  costs: { entryFeeBps: 5, exitFeeBps: 5, slippageBps: 1, spreadImpactBps: 0.2,
    expectedFundingBps: 1 },
  metadata: { ctVal: 0.01, ctMult: 1, minSz: 0.01, lotSz: 0.01, state: 'live' },
  state: {
    now: NOW, marketDataAt: NOW, maxMarketAgeMs: 30_000, openInterestAt: NOW,
    maxOpenInterestAgeMs: 3_600_000, openInterestChangePct1h: 0.002,
    openInterestChangePct4h: 0.003, openInterestChangePct24h: 0.01,
    priceChangePct24h: 0.02, equityUsd: 400, venueLeverage: 3,
    venuePositionBefore: 0, ledgerPositionBefore: 0, quantityTolerance: 0.005,
    reconciliationVersion: 'signed-v2', reconciliationHealthy: true,
    instrumentMetadataPresent: true, accountCertain: true, duplicateDecision: false,
    haltFlags: { killSwitch: false }, closedFourHourEmaDirection: 'up' as const,
    closedFourHourAdx: 40, entryToleranceBps: 10,
  },
});

describe('evidence-limited second-entry DecisionEvent factory', () => {
  it('rounds to the venue grid and retains at least 5.5 USDT projected net target', () => {
    const event = createSecondEntryDecision(input());
    expect(event.approvalBasis).toBe('operator-evidence-limited-v3');
    expect(event.expectedEdgeBps).toBe(0);
    expect(event.strategyVersion).toBe('competition_trend_pullback@3.0.0');
    expect(event.instrument).toBe('BTC-USDT-SWAP');
    expect(event.riskUsd).toBeCloseTo(3.9);
    expect(event.positionPct).toBeCloseTo(49.4);
    expect(event.validUntil).toBe(NOW + 30 * 60_000);
  });

  it('fails closed on missing OI confirmation, occupied instrument, or insufficient target', () => {
    const noOi = input();
    expect(() => createSecondEntryDecision({
      ...noOi, state: { ...noOi.state, openInterestChangePct1h: 0 },
    })).toThrow(/participation/u);
    const occupied = input();
    expect(() => createSecondEntryDecision({
      ...occupied, state: { ...occupied.state, venuePositionBefore: 0.01, ledgerPositionBefore: 0.01 },
    })).toThrow(/flat/u);
    const weak = input();
    expect(() => createSecondEntryDecision({
      ...weak, signal: { ...weak.signal, takeProfit: [{ price: 76_500, rMultiple: 1 / 3 }] },
    })).toThrow(/projected net target/u);
  });

  it('accepts ETH under the expanded universe and rejects any strategy/version substitution', () => {
    const candidate = input();
    expect(createSecondEntryDecision({
      ...candidate, signal: { ...candidate.signal, instId: 'ETH-USDT-SWAP' },
    })).toMatchObject({ instrument: 'ETH-USDT-SWAP' });
    expect(() => createSecondEntryDecision({
      ...candidate, signal: { ...candidate.signal, version: '3.0.1' },
    })).toThrow(/authorised frozen v3/u);
  });
});
