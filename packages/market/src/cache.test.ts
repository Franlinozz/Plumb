import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { CandleStore } from './cache.js';
import { fixtureCandles } from './fixtures.js';
import type { Candle } from './types.js';

function candle(ts: number, close: number, closed = true): Candle {
  return Object.freeze({
    ts,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 10,
    volumeCcy: 1,
    volumeQuote: close * 10,
    closed,
  });
}

const tempDirs: string[] = [];
function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'plumb-cache-'));
  tempDirs.push(dir);
  return join(dir, 'plumb.db');
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('CandleStore', () => {
  it('round-trips candles in chronological order', () => {
    const store = new CandleStore();
    store.putCandles('BTC-USDT-SWAP', '15m', [candle(3_000, 3), candle(1_000, 1), candle(2_000, 2)]);
    expect(store.getCandles('BTC-USDT-SWAP', '15m').map((c) => c.ts)).toEqual([1_000, 2_000, 3_000]);
    expect(store.count('BTC-USDT-SWAP', '15m')).toBe(3);
    expect(store.oldestTs('BTC-USDT-SWAP', '15m')).toBe(1_000);
    expect(store.newestTs('BTC-USDT-SWAP', '15m')).toBe(3_000);
    store.close();
  });

  it('NEVER overwrites a closed candle — closed bars are immutable', () => {
    const store = new CandleStore();
    store.putCandles('BTC-USDT-SWAP', '15m', [candle(1_000, 100)]);

    const rewrite = store.putCandles('BTC-USDT-SWAP', '15m', [candle(1_000, 999)]);
    expect(rewrite).toEqual({ inserted: 0, updated: 0, skippedImmutable: 1 });
    expect(store.getCandles('BTC-USDT-SWAP', '15m')[0]?.close).toBe(100);
    store.close();
  });

  it('DOES replace a bar that was still forming, once it closes', () => {
    const store = new CandleStore();
    store.putCandles('ETH-USDT-SWAP', '1H', [candle(1_000, 50, false)]);
    expect(store.hasClosed('ETH-USDT-SWAP', '1H', 1_000)).toBe(false);

    const sealed = store.putCandles('ETH-USDT-SWAP', '1H', [candle(1_000, 55, true)]);
    expect(sealed).toEqual({ inserted: 0, updated: 1, skippedImmutable: 0 });
    expect(store.getCandles('ETH-USDT-SWAP', '1H')[0]?.close).toBe(55);
    expect(store.hasClosed('ETH-USDT-SWAP', '1H', 1_000)).toBe(true);

    // ...and now it is sealed for good.
    expect(store.putCandles('ETH-USDT-SWAP', '1H', [candle(1_000, 77)]).skippedImmutable).toBe(1);
    expect(store.getCandles('ETH-USDT-SWAP', '1H')[0]?.close).toBe(55);
    store.close();
  });

  it('keeps instruments and timeframes in separate namespaces', () => {
    const store = new CandleStore();
    store.putCandles('BTC-USDT-SWAP', '15m', [candle(1_000, 1)]);
    store.putCandles('BTC-USDT-SWAP', '1H', [candle(1_000, 2)]);
    store.putCandles('ETH-USDT-SWAP', '15m', [candle(1_000, 3)]);

    expect(store.getCandles('BTC-USDT-SWAP', '15m')[0]?.close).toBe(1);
    expect(store.getCandles('BTC-USDT-SWAP', '1H')[0]?.close).toBe(2);
    expect(store.getCandles('ETH-USDT-SWAP', '15m')[0]?.close).toBe(3);
    expect(store.inventory()).toHaveLength(3);
    store.close();
  });

  it('survives a restart — history is persisted, never re-downloaded', () => {
    const path = tempDbPath();
    const recorded = fixtureCandles('BTC-USDT-SWAP', '15m');

    const first = new CandleStore(path);
    first.putCandles('BTC-USDT-SWAP', '15m', recorded);
    const before = first.getCandles('BTC-USDT-SWAP', '15m');
    first.close();

    // Simulated restart: brand-new process-level object over the same file.
    const second = new CandleStore(path);
    const after = second.getCandles('BTC-USDT-SWAP', '15m');
    expect(after).toHaveLength(recorded.length);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    const expectedNewestClosed = recorded.filter((c) => c.closed).at(-1)?.ts;
    expect(second.newestClosedTs('BTC-USDT-SWAP', '15m')).toBe(expectedNewestClosed);
    second.close();
  });

  it('filters by window, closed-only, and limit', () => {
    const store = new CandleStore();
    store.putCandles('SOL-USDT-SWAP', '15m', [
      candle(1_000, 1),
      candle(2_000, 2),
      candle(3_000, 3),
      candle(4_000, 4, false),
    ]);

    expect(store.getCandles('SOL-USDT-SWAP', '15m', { fromTs: 2_000 }).map((c) => c.ts)).toEqual([
      2_000, 3_000, 4_000,
    ]);
    expect(
      store.getCandles('SOL-USDT-SWAP', '15m', { fromTs: 2_000, toTs: 3_000 }).map((c) => c.ts),
    ).toEqual([2_000, 3_000]);
    expect(store.getCandles('SOL-USDT-SWAP', '15m', { closedOnly: true })).toHaveLength(3);
    // limit takes the NEWEST n, still returned oldest-first.
    expect(store.getCandles('SOL-USDT-SWAP', '15m', { limit: 2 }).map((c) => c.ts)).toEqual([
      3_000, 4_000,
    ]);
    expect(store.newestClosedTs('SOL-USDT-SWAP', '15m')).toBe(3_000);
    expect(store.countClosedBetween('SOL-USDT-SWAP', '15m', 1_000, 3_000)).toBe(3);
    store.close();
  });

  it('serves the hot tail from memory and invalidates it on write', () => {
    const store = new CandleStore();
    store.putCandles('BTC-USDT-SWAP', '15m', [candle(1_000, 1), candle(2_000, 2)]);

    expect(store.recent('BTC-USDT-SWAP', '15m', 2).map((c) => c.ts)).toEqual([1_000, 2_000]);
    expect(store.recent('BTC-USDT-SWAP', '15m', 1).map((c) => c.ts)).toEqual([2_000]);

    // A write must invalidate the memo, or the next cycle reads a stale tape.
    store.putCandles('BTC-USDT-SWAP', '15m', [candle(3_000, 3)]);
    expect(store.recent('BTC-USDT-SWAP', '15m', 3).map((c) => c.ts)).toEqual([1_000, 2_000, 3_000]);
    store.close();
  });

  it('reports an empty store honestly rather than with zeros', () => {
    const store = new CandleStore();
    expect(store.newestTs('BTC-USDT-SWAP', '15m')).toBeUndefined();
    expect(store.oldestTs('BTC-USDT-SWAP', '15m')).toBeUndefined();
    expect(store.count('BTC-USDT-SWAP', '15m')).toBe(0);
    expect(store.getCandles('BTC-USDT-SWAP', '15m')).toEqual([]);
    expect(store.inventory()).toEqual([]);
    store.close();
  });

  it('stores a full recorded series and reports its inventory', () => {
    const store = new CandleStore();
    for (const tf of ['15m', '1H', '4H'] as const) {
      store.putCandles('BTC-USDT-SWAP', tf, fixtureCandles('BTC-USDT-SWAP', tf));
    }
    const inventory = store.inventory();
    expect(inventory).toHaveLength(3);
    for (const row of inventory) {
      expect(row.rows).toBe(300);
      expect(row.newestTs).toBeGreaterThan(row.oldestTs);
    }
    store.close();
  });
});
