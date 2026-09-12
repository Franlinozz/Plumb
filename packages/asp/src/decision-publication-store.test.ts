import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { finalizeDecisionEvent } from '@plumb/core';

import { DecisionPublicationStore } from './decision-publication-store.js';

const event = finalizeDecisionEvent({
  decisionId: 'DEC-PUBLISH0001', strategyVersion: 'momentum-v1', createdAt: 1000, validUntil: 5000,
  instrument: 'ETH-USDT-SWAP', direction: 'long', entryLow: 3400, entryHigh: 3420,
  stopPrice: 3300, takeProfit: 3700, positionPct: 10, leverage: 2, riskUsd: 3,
  expectedCostBps: 8, expectedEdgeBps: 30, governorApproved: true,
  venuePositionBefore: 0, ledgerPositionBefore: 0, reconciliationVersion: 'signed-v1',
});

describe('DecisionPublicationStore', () => {
  it('proves the exact event reached every active subscriber', () => {
    const store = new DecisionPublicationStore();
    store.begin(event, 'signal text', 2, '2026-08-11T00:00:00Z');
    expect(store.isFullyDelivered(event)).toBe(false);
    store.finish(event.decisionId, 2, '2026-08-11T00:00:01Z');
    expect(store.isFullyDelivered(event)).toBe(true);
    expect(store.isFullyDelivered({ ...event, riskUsd: 4 })).toBe(false);
    store.close();
  });

  it('fails closed after restart before acknowledgement', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'plumb-publication-')), 'delivery.db');
    const first = new DecisionPublicationStore(path);
    first.begin(event, 'signal text', 1, '2026-08-11T00:00:00Z');
    first.close();
    const reopened = new DecisionPublicationStore(path);
    expect(reopened.get(event.decisionId)?.status).toBe('uncertain');
    expect(reopened.isFullyDelivered(event)).toBe(false);
    reopened.close();
  });

  it('rejects duplicates, collisions, and zero-subscriber publication', () => {
    const store = new DecisionPublicationStore();
    expect(() => store.begin(event, 'signal text', 0, 'now')).toThrow(/active subscriber/u);
    store.begin(event, 'signal text', 1, 'now');
    expect(() => store.begin(event, 'signal text', 1, 'now')).toThrow(/duplicate/u);
    expect(() => store.begin({ ...event, riskUsd: 4 }, 'signal text', 1, 'now')).toThrow(/collision/u);
    store.close();
  });
});
