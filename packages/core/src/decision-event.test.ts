import { describe, expect, it } from 'vitest';

import {
  DecisionEventRejected,
  decisionPositionsReconciled,
  finalizeDecisionEvent,
} from './decision-event.js';

const base = () => ({
  decisionId: 'DEC-abcdefghij',
  strategyVersion: 'momentum-v1',
  createdAt: 1_000,
  validUntil: 5_000,
  instrument: 'BTC-USDT-SWAP',
  direction: 'long',
  entryLow: 64_000,
  entryHigh: 64_100,
  stopPrice: 63_000,
  takeProfit: 66_000,
  positionPct: 2,
  leverage: 2,
  riskUsd: 2,
  expectedCostBps: 10,
  expectedEdgeBps: 40,
  governorApproved: true,
  venuePositionBefore: 0,
  ledgerPositionBefore: 0,
  reconciliationVersion: 'signed-v1',
});

describe('canonical DecisionEvent', () => {
  it('finalises and freezes one approved cost-aware event', () => {
    const event = finalizeDecisionEvent(base());
    expect(Object.isFrozen(event)).toBe(true);
    expect(event.decisionId).toBe('DEC-abcdefghij');
  });

  it('fails closed when the governor did not approve', () => {
    expect(() => finalizeDecisionEvent({ ...base(), governorApproved: false })).toThrow(DecisionEventRejected);
  });

  it('fails the cost gate unless edge is at least three times friction', () => {
    expect(() => finalizeDecisionEvent({ ...base(), expectedEdgeBps: 10 })).toThrow(/friction/);
    expect(() => finalizeDecisionEvent({ ...base(), expectedEdgeBps: 29.99 })).toThrow(/3x/);
    expect(() => finalizeDecisionEvent({ ...base(), expectedEdgeBps: 30 })).not.toThrow();
  });

  it('records the narrow emergency basis without fabricating expected edge', () => {
    const event = finalizeDecisionEvent({
      ...base(), strategyVersion: 'emergency_participation@1.0.0', expectedEdgeBps: 0,
      approvalBasis: 'operator-emergency-participation',
    });
    expect(event.expectedEdgeBps).toBe(0);
    expect(() => finalizeDecisionEvent({ ...base(), expectedEdgeBps: 0 })).toThrow(/friction/u);
    expect(() => finalizeDecisionEvent({
      ...base(), strategyVersion: 'momentum-v1', expectedEdgeBps: 0,
      approvalBasis: 'operator-emergency-participation',
    })).toThrow(/malformed/u);
  });

  it('records the evidence-limited v3 basis without fabricating expected edge', () => {
    const event = finalizeDecisionEvent({
      ...base(), strategyVersion: 'competition_trend_pullback@3.0.0', expectedEdgeBps: 0,
      approvalBasis: 'operator-evidence-limited-v3',
    });
    expect(event.expectedEdgeBps).toBe(0);
    expect(() => finalizeDecisionEvent({
      ...base(), strategyVersion: 'competition_trend_pullback@3.0.1', expectedEdgeBps: 0,
      approvalBasis: 'operator-evidence-limited-v3',
    })).toThrow(/malformed/u);
  });

  it('records the deadline contingency without fabricating expected edge', () => {
    const event = finalizeDecisionEvent({
      ...base(), strategyVersion: 'deadline_contingency@1.0.0', expectedEdgeBps: 0,
      approvalBasis: 'operator-deadline-contingency-v1',
    });
    expect(event.expectedEdgeBps).toBe(0);
    expect(() => finalizeDecisionEvent({
      ...base(), strategyVersion: 'deadline_contingency@1.0.1', expectedEdgeBps: 0,
      approvalBasis: 'operator-deadline-contingency-v1',
    })).toThrow(/malformed/u);
  });

  it('rejects stale-at-creation and malformed price geometry', () => {
    expect(() => finalizeDecisionEvent({ ...base(), validUntil: 1_000 })).toThrow();
    expect(() => finalizeDecisionEvent({ ...base(), stopPrice: 65_000 })).toThrow();
    expect(() => finalizeDecisionEvent({ ...base(), takeProfit: 63_000 })).toThrow();
  });

  it('rejects leverage below 1x or above 3x', () => {
    expect(() => finalizeDecisionEvent({ ...base(), leverage: 0.5 })).toThrow();
    expect(() => finalizeDecisionEvent({ ...base(), leverage: 3.01 })).toThrow();
  });

  it('compares signed positions rather than absolute size', () => {
    const event = finalizeDecisionEvent({ ...base(), venuePositionBefore: 0.01, ledgerPositionBefore: -0.01 });
    expect(decisionPositionsReconciled(event)).toBe(false);
    expect(decisionPositionsReconciled({ ...event, ledgerPositionBefore: 0.0100000001 }, 1e-8)).toBe(true);
  });
});
