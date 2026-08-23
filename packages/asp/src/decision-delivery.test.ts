import { finalizeDecisionEvent } from '@plumb/core';
import { describe, expect, it } from 'vitest';

import {
  ExecutableSignalRejected,
  formatDecisionEventForDelivery,
  validateV12PerpetualSignal,
} from './decision-delivery.js';

const NOW = 1_000_000;
const event = () =>
  finalizeDecisionEvent({
    decisionId: 'DEC-abcdefghij',
    strategyVersion: 'momentum-v1',
    createdAt: NOW - 1_000,
    validUntil: NOW + 3_600_000,
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

const gate = (overrides = {}) => ({
  now: NOW,
  marketDataAt: NOW - 1_000,
  maxMarketAgeMs: 60_000,
  haltFlags: {},
  reconciliationHealthy: true,
  instrumentMetadataPresent: true,
  sizingValid: true,
  accountCertain: true,
  duplicateDecision: false,
  ...overrides,
});

describe('DecisionEvent A2A delivery gate', () => {
  it('formats one deterministic v1.2 market signal with one specific reference price', () => {
    const text = formatDecisionEventForDelivery(event(), gate());
    expect(text).toBe(
      '【Futures】BTC-USDT-PERP | LONG 2x | Market | Reference Price 64050 | Stop Loss 63000 | ' +
      'Take Profit 66000 | Position 2% | Valid for 1h',
    );
    expect(text).not.toContain('64000-64100');
    expect(text.length).toBeLessThanOrEqual(200);
  });

  it('never overstates sub-hour validity', () => {
    const expiring = finalizeDecisionEvent({ ...event(), validUntil: NOW + 5 * 60_000 });
    expect(formatDecisionEventForDelivery(expiring, gate())).toMatch(/Valid for 5min$/u);
  });

  it('formats an explicitly labelled emergency event while preserving a zero edge claim', () => {
    const emergency = finalizeDecisionEvent({
      ...event(), strategyVersion: 'emergency_participation@1.0.0', expectedEdgeBps: 0,
      approvalBasis: 'operator-emergency-participation',
    });
    expect(formatDecisionEventForDelivery(emergency, gate())).toMatch(/^【Futures】/u);
    expect(emergency.expectedEdgeBps).toBe(0);
  });

  it('formats both explicitly authorised zero-edge additional-entry bases', () => {
    const v3 = finalizeDecisionEvent({
      ...event(), strategyVersion: 'competition_trend_pullback@3.0.0', expectedEdgeBps: 0,
      approvalBasis: 'operator-evidence-limited-v3',
    });
    const contingency = finalizeDecisionEvent({
      ...event(), strategyVersion: 'deadline_contingency@1.0.0', expectedEdgeBps: 0,
      approvalBasis: 'operator-deadline-contingency-v1',
    });
    expect(formatDecisionEventForDelivery(v3, gate())).toMatch(/^【Futures】/u);
    expect(formatDecisionEventForDelivery(contingency, gate())).toMatch(/^【Futures】/u);
  });

  it.each([
    ['halt', { haltFlags: { manual: true } }],
    ['stale market', { marketDataAt: NOW - 60_001 }],
    ['bad reconciliation', { reconciliationHealthy: false }],
    ['missing metadata', { instrumentMetadataPresent: false }],
    ['invalid sizing', { sizingValid: false }],
    ['duplicate', { duplicateDecision: true }],
    ['uncertain account', { accountCertain: false }],
  ])('fails closed for %s', (_name, overrides) => {
    expect(() => formatDecisionEventForDelivery(event(), gate(overrides))).toThrow(ExecutableSignalRejected);
  });

  it('rejects an expired event and a signed wrong-direction position', () => {
    expect(() => formatDecisionEventForDelivery(event(), gate({ now: NOW + 3_600_000 }))).toThrow(/stale/);
    const reversed = { ...event(), venuePositionBefore: 0.01, ledgerPositionBefore: -0.01 };
    expect(() => formatDecisionEventForDelivery(reversed, gate())).toThrow(/signed reconciliation/);
  });

  it('rejects a future-dated DecisionEvent', () => {
    expect(() => formatDecisionEventForDelivery({ ...event(), createdAt: NOW + 1 }, gate()))
      .toThrow(/future-dated/u);
  });

  it('rejects malformed and over-200-character signals instead of rewriting them', () => {
    expect(() => validateV12PerpetualSignal('BUY BTC now')).toThrow(/v1.2/);
    expect(() => validateV12PerpetualSignal(
      '【Futures】BTC-USDT-PERP | LONG 2x | Limit | Reference Price 64050 | Stop Loss 63000 | ' +
      'Take Profit 66000 | Position 2% | Valid for 1h',
    )).toThrow(/v1.2/);
    expect(() => validateV12PerpetualSignal('x'.repeat(201))).toThrow(/200/);
  });
});
