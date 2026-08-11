import { finalizeDecisionEvent } from '@plumb/core';
import { describe, expect, it } from 'vitest';

import {
  ExecutableSignalRejected,
  formatDecisionEventForDelivery,
  validateV11PerpetualSignal,
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
  it('formats one deterministic V1.1 signal under 200 characters', () => {
    const text = formatDecisionEventForDelivery(event(), gate());
    expect(text).toContain('Decision DEC-abcdefghij');
    expect(text.length).toBeLessThanOrEqual(200);
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

  it('rejects malformed and over-200-character signals instead of rewriting them', () => {
    expect(() => validateV11PerpetualSignal('BUY BTC now')).toThrow(/V1.1/);
    expect(() => validateV11PerpetualSignal('x'.repeat(201))).toThrow(/200/);
  });
});
