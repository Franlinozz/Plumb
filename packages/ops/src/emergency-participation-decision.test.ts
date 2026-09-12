import type { Signal } from '@plumb/core';
import type { Approval } from '@plumb/risk';
import { describe, expect, it } from 'vitest';

import { createEmergencyParticipationDecision } from './emergency-participation-decision.js';

const NOW = Date.parse('2026-08-21T00:00:00Z');
const signal: Signal = {
  id: 'SIG-EMERGENCY1', ts: NOW, instId: 'ETH-USDT-SWAP', side: 'long', intent: 'open',
  entry: { type: 'market', price: 2_000 },
  stop: { price: 1_980, distancePct: 0.01, basis: 'structure' },
  takeProfit: [{ price: 2_030, rMultiple: 1.5 }], timeframe: '1H',
  strategyId: 'emergency_participation', regime: 'trending_up',
  inputs: { fourHourAdx: 30, hourlyRsi: 60 },
  invalidation: { maxHoldBars: 6, conditions: ['trend fails'] },
  expiresAt: NOW + 30 * 60_000, version: '1.0.0',
};
const approval: Approval = {
  approved: true, signalId: signal.id,
  sizing: { ok: true, instId: signal.instId, contracts: 2, notionalUsdt: 400, leverage: 1,
    stopDistancePct: 0.01, intendedRiskUsdt: 4, actualRiskUsdt: 4, clampedByLeverage: false },
  drawdown: {} as Approval['drawdown'], state: {} as Approval['state'],
};
const input = () => ({
  signal, approval,
  costs: { entryFeeBps: 5, exitFeeBps: 5, slippageBps: 1, spreadImpactBps: 0.2,
    expectedFundingBps: 1 },
  metadata: { ctVal: 0.1, ctMult: 1, minSz: 0.01, lotSz: 0.01, state: 'live' },
  state: {
    now: NOW, marketDataAt: NOW, maxMarketAgeMs: 30_000, openInterestAt: NOW,
    maxOpenInterestAgeMs: 3_600_000, openInterestChangePct24h: 0.01,
    priceChangePct24h: 0.02, equityUsd: 400, venueLeverage: 1,
    venuePositionBefore: 0, ledgerPositionBefore: 0, quantityTolerance: 0.005,
    reconciliationVersion: 'signed-v2', reconciliationHealthy: true,
    instrumentMetadataPresent: true, accountCertain: true, duplicateDecision: false,
    haltFlags: { killSwitch: false }, closedFourHourEmaDirection: 'up' as const,
    closedFourHourAdx: 30, oneHourRsi: 60, entryToleranceBps: 10,
  },
});

describe('emergency participation DecisionEvent factory', () => {
  it('uses exactly the venue minimum and claims zero calibrated edge', () => {
    const event = createEmergencyParticipationDecision(input());
    expect(event.approvalBasis).toBe('operator-emergency-participation');
    expect(event.expectedEdgeBps).toBe(0);
    expect(event.riskUsd).toBeCloseTo(0.02);
    expect(event.positionPct).toBeCloseTo(0.5);
  });

  it('fails closed on missing participation confirmation or an oversized minimum lot', () => {
    const absentOi = input();
    expect(() => createEmergencyParticipationDecision({
      ...absentOi, state: { ...absentOi.state, openInterestChangePct24h: 0 },
    })).toThrow(/confirmation/u);
    const oversized = input();
    expect(() => createEmergencyParticipationDecision({
      ...oversized, metadata: { ...oversized.metadata, minSz: 0.1 },
    })).toThrow(/minimum-lot sizing/u);
  });
});
