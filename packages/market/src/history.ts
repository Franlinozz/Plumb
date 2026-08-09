/**
 * Bulk historical candle download, for the backtest harness in P4.
 *
 * Pages backwards through `/api/v5/market/history-candles` and writes into the `CandleStore`.
 * Two properties matter more than speed:
 *
 *  - **Never refetch a closed candle.** Before each page, the store is asked whether it already
 *    holds a full window of finalised bars there; if so the page is skipped without a request.
 *    A resumed backfill costs almost nothing.
 *  - **Contiguity is checked, not assumed.** `findGaps` reports every missing bar, because a
 *    backtest over a series with a silent hole produces confident, wrong results.
 */

import type { Instrument } from '@plumb/core';

import type { OkxPublicClient } from './client.js';
import { MAX_CANDLE_PAGE } from './client.js';
import type { CandleStore } from './cache.js';
import { TIMEFRAME_MS, type Candle, type Timeframe } from './types.js';

export interface Gap {
  /** Timestamp of the last present bar before the hole. */
  readonly afterTs: number;
  /** Timestamp of the first present bar after the hole. */
  readonly beforeTs: number;
  /** How many bars are missing between them. */
  readonly missing: number;
}

/**
 * Missing bars in a chronologically-ordered series.
 *
 * Exchanges do legitimately skip bars when there were no trades, so a gap is reported, not
 * thrown — the caller decides whether a given hole is tolerable.
 */
export function findGaps(candles: readonly Candle[], tf: Timeframe): readonly Gap[] {
  const step = TIMEFRAME_MS[tf];
  const gaps: Gap[] = [];
  for (let i = 1; i < candles.length; i += 1) {
    const prev = candles[i - 1] as Candle;
    const curr = candles[i] as Candle;
    const delta = curr.ts - prev.ts;
    if (delta > step) {
      gaps.push({ afterTs: prev.ts, beforeTs: curr.ts, missing: Math.round(delta / step) - 1 });
    }
  }
  return Object.freeze(gaps);
}

/** Duplicate timestamps. Should always be empty — the store's primary key forbids them. */
export function findDuplicates(candles: readonly Candle[]): readonly number[] {
  const seen = new Set<number>();
  const dupes = new Set<number>();
  for (const c of candles) {
    if (seen.has(c.ts)) dupes.add(c.ts);
    seen.add(c.ts);
  }
  return Object.freeze([...dupes].sort((a, b) => a - b));
}

export interface BackfillOptions {
  readonly instId: Instrument;
  readonly tf: Timeframe;
  /** Stop once the download has reached this far back, in UTC ms. */
  readonly fromTs: number;
  /** Where to start paging backwards from. Defaults to "the most recent bar". */
  readonly startTs?: number;
  readonly pageLimit?: number;
  /** Safety stop, so a pagination bug cannot loop forever. */
  readonly maxPages?: number;
  readonly onPage?: (progress: BackfillProgress) => void;
}

export interface BackfillProgress {
  readonly page: number;
  readonly fetched: number;
  readonly oldestTs: number;
  readonly skipped: boolean;
}

export interface BackfillResult {
  readonly instId: Instrument;
  readonly tf: Timeframe;
  readonly pages: number;
  readonly pagesSkipped: number;
  readonly fetched: number;
  readonly inserted: number;
  readonly updated: number;
  readonly skippedImmutable: number;
  readonly oldestTs: number | undefined;
  readonly newestTs: number | undefined;
  readonly rows: number;
  readonly gaps: readonly Gap[];
}

export async function backfillCandles(
  client: OkxPublicClient,
  store: CandleStore,
  options: BackfillOptions,
): Promise<BackfillResult> {
  const { instId, tf, fromTs } = options;
  const pageLimit = Math.min(options.pageLimit ?? MAX_CANDLE_PAGE, MAX_CANDLE_PAGE);
  const maxPages = options.maxPages ?? 5_000;
  const step = TIMEFRAME_MS[tf];

  let after = options.startTs;
  let pages = 0;
  let pagesSkipped = 0;
  let fetched = 0;
  let inserted = 0;
  let updated = 0;
  let skippedImmutable = 0;

  while (pages + pagesSkipped < maxPages) {
    // If the store already holds a full window of finalised bars where this page would land,
    // there is nothing to download — jump past it without touching the network.
    if (after !== undefined) {
      const windowEnd = after - step;
      const windowStart = after - step * pageLimit;
      if (
        windowStart >= fromTs &&
        store.countClosedBetween(instId, tf, windowStart, windowEnd) === pageLimit
      ) {
        pagesSkipped += 1;
        options.onPage?.({ page: pages + pagesSkipped, fetched: 0, oldestTs: windowStart, skipped: true });
        after = windowStart;
        if (windowStart <= fromTs) break;
        continue;
      }
    }

    const page = await client.historyCandles(instId, tf, {
      limit: pageLimit,
      ...(after === undefined ? {} : { after }),
    });
    pages += 1;
    if (page.length === 0) break;

    const result = store.putCandles(instId, tf, page);
    fetched += page.length;
    inserted += result.inserted;
    updated += result.updated;
    skippedImmutable += result.skippedImmutable;

    // OKX returns newest-first, so the last row is the oldest in the page.
    const oldest = page.reduce((min, c) => (c.ts < min ? c.ts : min), Number.POSITIVE_INFINITY);
    options.onPage?.({ page: pages + pagesSkipped, fetched: page.length, oldestTs: oldest, skipped: false });

    if (oldest <= fromTs) break;
    if (after !== undefined && oldest >= after) break; // pagination made no progress — bail out
    after = oldest;
  }

  const stored = store.getCandles(instId, tf, { fromTs });
  return {
    instId,
    tf,
    pages,
    pagesSkipped,
    fetched,
    inserted,
    updated,
    skippedImmutable,
    oldestTs: store.oldestTs(instId, tf),
    newestTs: store.newestTs(instId, tf),
    rows: store.count(instId, tf),
    gaps: findGaps(stored, tf),
  };
}

/** Milliseconds in `days` days — the usual way a backfill window is expressed. */
export function daysAgo(now: number, days: number): number {
  return now - days * 86_400_000;
}
