#!/usr/bin/env node
/**
 * Download and store historical candles for the backtest harness (P4).
 *
 * Writes to `PLUMB_DB_PATH` (default `./data/plumb.db`, gitignored). Closed candles are
 * immutable, so re-running this is cheap: already-downloaded windows are skipped without a
 * request, and nothing already sealed is overwritten.
 *
 * No credentials — `/api/v5/market/history-candles` is public.
 *
 *   node scripts/backfill.mjs [--days 180] [--tf 15m,1H]
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  CandleStore,
  OkxPublicClient,
  backfillCandles,
  backfillFundingRates,
  daysAgo,
  findDuplicates,
  findGaps,
  tradableUniverse,
} from '@plumb/market';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};

const days = Number(arg('days', '180'));
const timeframes = String(arg('tf', '15m,1H')).split(',');
const dbPath = process.env.PLUMB_DB_PATH ?? './data/plumb.db';

mkdirSync(dirname(dbPath), { recursive: true });
const store = new CandleStore(dbPath);
const client = new OkxPublicClient();

const now = Date.now();
const fromTs = daysAgo(now, days);
console.log(
  `backfilling ${days} days (from ${new Date(fromTs).toISOString()}) ` +
    `for ${timeframes.join(', ')} into ${dbPath}\n`,
);

const started = Date.now();
for (const instId of tradableUniverse()) {
  for (const tf of timeframes) {
    process.stdout.write(`  ${instId} ${tf} `);
    const result = await backfillCandles(client, store, {
      instId,
      tf,
      fromTs,
      onPage: (p) => process.stdout.write(p.skipped ? '·' : '.'),
    });
    const stored = store.getCandles(instId, tf, { fromTs });
    const gaps = findGaps(stored, tf);
    const dupes = findDuplicates(stored);
    console.log(
      `\n     pages ${result.pages} (+${result.pagesSkipped} skipped)  fetched ${result.fetched}  ` +
        `inserted ${result.inserted}  sealed-skip ${result.skippedImmutable}`,
    );
    console.log(
      `     rows ${result.rows}  window ${new Date(result.oldestTs).toISOString().slice(0, 16)} → ` +
        `${new Date(result.newestTs).toISOString().slice(0, 16)}  gaps ${gaps.length}  dupes ${dupes.length}`,
    );
    if (gaps.length > 0) {
      const missing = gaps.reduce((n, g) => n + g.missing, 0);
      console.log(`     ⚠ ${missing} missing bars across ${gaps.length} gaps (first: ` +
        `${new Date(gaps[0].afterTs).toISOString()} → ${new Date(gaps[0].beforeTs).toISOString()})`);
    }
  }
}

// Funding rates — settled every 8h. P4's backtest cannot price a held position without them,
// and P2's replay could not evaluate funding_skew at all for want of them.
console.log('\nfunding rates:');
for (const instId of tradableUniverse()) {
  const r = await backfillFundingRates(client, store, { instId, fromTs });
  const span = r.oldestTs === undefined ? 0 : (r.newestTs - r.oldestTs) / 86_400_000;
  console.log(
    `  ${instId.padEnd(16)} ${String(r.rows).padStart(5)} rows  ${span.toFixed(1)} days  ` +
      `(${r.pages} pages, ${r.inserted} new)`,
  );
}

console.log(`\ninventory (${dbPath}):`);
let total = 0;
for (const row of store.inventory()) {
  total += row.rows;
  const span = (row.newestTs - row.oldestTs) / 86_400_000;
  console.log(
    `  ${row.instId.padEnd(16)} ${row.tf.padEnd(4)} ${String(row.rows).padStart(7)} rows  ` +
      `${span.toFixed(1)} days  ${new Date(row.oldestTs).toISOString().slice(0, 10)} → ` +
      `${new Date(row.newestTs).toISOString().slice(0, 10)}`,
  );
}
console.log(
  `\n  TOTAL ${total} rows in ${((Date.now() - started) / 1000).toFixed(1)}s  ` +
    `(${client.stats.requests} requests, ${client.stats.retries} retries)`,
);
store.close();
