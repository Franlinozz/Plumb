import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MarketObservationStore } from './observation-store.js';

const observation = {
  kind: 'open_interest' as const,
  instrument: 'BTC-USDT-SWAP' as const,
  sourceTs: 1_786_400_000_000,
  recordedAt: 1_786_400_001_000,
  payload: { oi: 123, oiUsd: 456 },
};

describe('MarketObservationStore', () => {
  it('persists observations through restart and deduplicates source samples', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'plumb-observations-')), 'market.db');
    const first = new MarketObservationStore(path);
    expect(first.put(observation)).toBe(true);
    expect(first.put({ ...observation, recordedAt: observation.recordedAt + 1 })).toBe(false);
    first.close();

    const reopened = new MarketObservationStore(path);
    expect(reopened.count()).toBe(1);
    reopened.close();
  });

  it('keeps candle timeframes distinct', () => {
    const store = new MarketObservationStore();
    expect(store.put({ ...observation, kind: 'candle', timeframe: '1H' })).toBe(true);
    expect(store.put({ ...observation, kind: 'candle', timeframe: '4H' })).toBe(true);
    expect(store.count()).toBe(2);
    store.close();
  });
});
