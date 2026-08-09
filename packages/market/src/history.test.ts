import { describe, expect, it } from 'vitest';

import { CandleStore } from './cache.js';
import { OkxPublicClient, type FetchLike } from './client.js';
import { fixtureCandles, fixtureFetch } from './fixtures.js';
import { backfillCandles, daysAgo, findDuplicates, findGaps } from './history.js';
import { TIMEFRAME_MS, type Candle } from './types.js';

function client(calls?: string[]): OkxPublicClient {
  return new OkxPublicClient({
    fetch: fixtureFetch(calls === undefined ? {} : { calls }),
    minIntervalMs: 0,
    sleep: async () => undefined,
    now: () => 0,
  });
}

function candle(ts: number, close = 1, closed = true): Candle {
  return Object.freeze({
    ts,
    open: close,
    high: close,
    low: close,
    close,
    volume: 0,
    volumeCcy: 0,
    volumeQuote: 0,
    closed,
  });
}

describe('findGaps / findDuplicates', () => {
  it('finds no gap in a contiguous series', () => {
    const step = TIMEFRAME_MS['15m'];
    const series = [candle(0), candle(step), candle(step * 2)];
    expect(findGaps(series, '15m')).toEqual([]);
    expect(findDuplicates(series)).toEqual([]);
  });

  it('reports a hole with the bars on either side and how many are missing', () => {
    const step = TIMEFRAME_MS['15m'];
    const series = [candle(0), candle(step), candle(step * 5)];
    expect(findGaps(series, '15m')).toEqual([{ afterTs: step, beforeTs: step * 5, missing: 3 }]);
  });

  it('finds duplicate timestamps', () => {
    expect(findDuplicates([candle(1), candle(2), candle(1), candle(2)])).toEqual([1, 2]);
  });

  it('sees the recorded series as contiguous, at every timeframe', () => {
    for (const inst of ['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP']) {
      for (const tf of ['15m', '1H', '4H'] as const) {
        const series = fixtureCandles(inst, tf);
        expect(findGaps(series, tf)).toEqual([]);
        expect(findDuplicates(series)).toEqual([]);
      }
    }
  });
});

describe('backfillCandles', () => {
  it('pages backwards and assembles a contiguous series with no duplicates', async () => {
    const store = new CandleStore();
    const result = await backfillCandles(client(), store, {
      instId: 'BTC-USDT-SWAP',
      tf: '15m',
      fromTs: 0, // exhaust the recorded fixture
      pageLimit: 100,
    });

    const recorded = fixtureCandles('BTC-USDT-SWAP', '15m');
    expect(result.rows).toBe(recorded.length);
    expect(result.pages).toBe(4); // 3 full pages of 100 + one empty page that terminates it
    expect(result.gaps).toEqual([]);

    const stored = store.getCandles('BTC-USDT-SWAP', '15m');
    expect(findDuplicates(stored)).toEqual([]);
    expect(stored.map((c) => c.ts)).toEqual(recorded.map((c) => c.ts));
    expect(result.oldestTs).toBe(recorded[0]?.ts);
    expect(result.newestTs).toBe(recorded.at(-1)?.ts);
    store.close();
  });

  it('paginates with `after` meaning OLDER, page after page', async () => {
    const calls: string[] = [];
    const store = new CandleStore();
    await backfillCandles(client(calls), store, {
      instId: 'ETH-USDT-SWAP',
      tf: '1H',
      fromTs: 0,
      pageLimit: 100,
    });

    // First page has no cursor; every later page carries an `after` older than the last.
    expect(calls[0]).not.toContain('after=');
    const cursors = calls
      .map((url) => new URL(url).searchParams.get('after'))
      .filter((v): v is string => v !== null)
      .map(Number);
    expect(cursors.length).toBeGreaterThan(1);
    for (let i = 1; i < cursors.length; i += 1) {
      expect(cursors[i] as number).toBeLessThan(cursors[i - 1] as number);
    }
    store.close();
  });

  it('stops once it has reached far enough back, without draining the whole history', async () => {
    const store = new CandleStore();
    const recorded = fixtureCandles('BTC-USDT-SWAP', '15m');
    const newest = recorded.at(-1)?.ts ?? 0;
    const target = newest - 100 * TIMEFRAME_MS['15m'];

    const result = await backfillCandles(client(), store, {
      instId: 'BTC-USDT-SWAP',
      tf: '15m',
      fromTs: target,
      pageLimit: 100,
    });
    expect(result.pages).toBe(2);
    expect(result.rows).toBeLessThan(recorded.length);
    expect(result.rows).toBeGreaterThanOrEqual(100);
    store.close();
  });

  it('never refetches a closed candle — a resumed backfill skips pages entirely', async () => {
    const store = new CandleStore();
    const first = await backfillCandles(client(), store, {
      instId: 'SOL-USDT-SWAP',
      tf: '15m',
      fromTs: 0,
      pageLimit: 100,
    });
    expect(first.pagesSkipped).toBe(0);
    expect(first.inserted).toBeGreaterThan(0);

    const calls: string[] = [];
    const second = await backfillCandles(client(calls), store, {
      instId: 'SOL-USDT-SWAP',
      tf: '15m',
      fromTs: 0,
      pageLimit: 100,
      startTs: store.newestTs('SOL-USDT-SWAP', '15m') ?? 0,
    });

    // Windows already full of finalised bars are jumped over without a request.
    expect(second.pagesSkipped).toBeGreaterThan(0);
    expect(second.inserted).toBe(0);
    expect(calls.length).toBeLessThan(first.pages);
    store.close();
  });

  it('re-storing the same page is a no-op, not a rewrite', async () => {
    const store = new CandleStore();
    await backfillCandles(client(), store, {
      instId: 'BTC-USDT-SWAP',
      tf: '4H',
      fromTs: 0,
      pageLimit: 300,
    });
    const rows = store.count('BTC-USDT-SWAP', '4H');

    const again = await backfillCandles(client(), store, {
      instId: 'BTC-USDT-SWAP',
      tf: '4H',
      fromTs: 0,
      pageLimit: 300,
    });
    expect(store.count('BTC-USDT-SWAP', '4H')).toBe(rows);
    // Everything it did fetch was already sealed, so nothing was overwritten.
    expect(again.inserted).toBe(0);
    expect(again.skippedImmutable + again.pagesSkipped).toBeGreaterThan(0);
    store.close();
  });

  it('gives up rather than looping when pagination stops making progress', async () => {
    // Always answers with the same page, ignoring `after` — the classic cursor bug.
    const frozenPage: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          code: '0',
          msg: '',
          data: [['5000', '1', '1', '1', '1', '0', '0', '0', '1']],
        }),
    });
    const stuck = new OkxPublicClient({
      fetch: frozenPage,
      minIntervalMs: 0,
      sleep: async () => undefined,
    });
    const store = new CandleStore();
    const result = await backfillCandles(stuck, store, {
      instId: 'BTC-USDT-SWAP',
      tf: '15m',
      fromTs: 0,
      pageLimit: 100,
      maxPages: 50,
    });
    expect(result.pages).toBeLessThanOrEqual(2);
    store.close();
  });

  it('daysAgo computes the window bound', () => {
    const now = Date.parse('2026-08-09T00:00:00Z');
    expect(daysAgo(now, 180)).toBe(now - 180 * 86_400_000);
  });
});
