#!/usr/bin/env node
/**
 * THE DAILY REVIEW JOB.
 *
 * Runs once a day and writes one plain-prose page about the previous UTC day. Every number in the
 * ledger is DERIVED here — from the runner's structured log, the published feed and the governor
 * state — never passed in by hand. If a number cannot be derived it stays at its zero value and the
 * review says so, because a review that quietly invents its inputs is worse than no review.
 *
 * Usage:  node scripts/daily-review.mjs [YYYY-MM-DD]   (default: yesterday UTC)
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { GovernorStore, assessDrawdown } from '@plumb/risk';
import { FeedStore } from '@plumb/asp';
import { generateReview } from '@plumb/ops';

const LOG_PATH = process.env.PLUMB_RUNNER_LOG ?? '/var/log/plumb/runner.log';
const FEED_PATH = process.env.PLUMB_FEED_PATH ?? '/var/lib/plumb/feed.db';
const STATE_PATH = process.env.PLUMB_STATE_PATH ?? '/var/lib/plumb/governor.db';
const OUT_DIR = process.env.PLUMB_REVIEW_DIR ?? '/var/lib/plumb/reviews';

const arg = process.argv[2];
const dateUtc = arg ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

/** Structured log lines for the target UTC day. A malformed line is skipped, not fatal. */
function linesFor(day) {
  if (!existsSync(LOG_PATH)) return [];
  return readFileSync(LOG_PATH, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return undefined;
      }
    })
    .filter((e) => e !== undefined && typeof e.ts === 'string' && e.ts.startsWith(day));
}

const entries = linesFor(dateUtc);
const count = (event) => entries.filter((e) => e.event === event).length;

const vetoesByReason = {};
for (const e of entries.filter((x) => x.event === 'veto')) {
  const code = e.code ?? 'unknown';
  vetoesByReason[code] = (vetoesByReason[code] ?? 0) + 1;
}

const feed = existsSync(FEED_PATH) ? new FeedStore(FEED_PATH) : undefined;
const publishedToday = feed === undefined ? 0 : feed.recent(1000).filter((p) => new Date(p.publishedAt).toISOString().startsWith(dateUtc)).length;

const governor = existsSync(STATE_PATH) ? new GovernorStore(STATE_PATH) : undefined;
const state = governor?.load(Date.now());
const equity = state?.equity ?? 0;
const peak = state?.peakEquity ?? equity;
const drawdown = assessDrawdown(equity, peak);

const ledger = {
  dateUtc,
  signalsEmitted: entries.filter((e) => e.event === 'cycle_complete').reduce((n, e) => n + (e.signals ?? 0), 0),
  signalsPublished: publishedToday,
  vetoesByReason,
  gateRejectionsByReason: {},
  tradesOpened: count('position_opened'),
  tradesClosed: count('position_closed'),
  realisedPnlUsdt: state?.realisedPnlToday ?? 0,
  // The governor stores a point-in-time equity, not a per-day open. Absent a day-open snapshot the
  // honest value is the equity we have, and the review is told the day's PnL separately.
  equityStartUsdt: equity - (state?.realisedPnlToday ?? 0),
  equityEndUsdt: equity,
  peakEquityUsdt: peak,
  drawdownPct: drawdown.drawdownPct,
  drawdownRung: drawdown.rung,
  haltFlags: state?.haltFlags ?? {},
  cyclesCompleted: count('cycle_complete'),
  cyclesSkipped: count('cycle_overrun') + count('snapshot_degraded'),
  degradedSnapshots: count('snapshot_degraded'),
  venueErrors: count('cycle_failed') + count('bootstrap_failed'),
};

const review = await generateReview(
  ledger,
  process.env.ANTHROPIC_API_KEY === undefined ? {} : { apiKey: process.env.ANTHROPIC_API_KEY },
);

mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, `${dateUtc}.md`);
writeFileSync(outPath, `# Plumb daily review — ${dateUtc}\n\n_source: ${review.source}${review.fallbackReason === undefined ? '' : ` (${review.fallbackReason})`}_\n\n${review.text}\n`);
writeFileSync(join(OUT_DIR, `${dateUtc}.ledger.json`), JSON.stringify(ledger, null, 2));

feed?.close();
governor?.close();
console.log(JSON.stringify({ event: 'daily_review', dateUtc, source: review.source, path: outPath }));
