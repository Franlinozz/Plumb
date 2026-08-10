#!/usr/bin/env node
/**
 * THE WEEKLY PAPER-RUN REPORT.
 *
 * Phase 8 runs for 21 days and is scored on ten criteria, nine of which are about the MACHINERY —
 * uptime, reconciliation, naked positions, parameter breaches, restart recovery. This report
 * derives all of them from the daily ledgers, the feed and the governor state.
 *
 * It does not decide whether the gate passed. It reports each criterion with the evidence, and a
 * human reads it. A script that graded its own run would be the same mistake as a backtest that
 * chose its own thresholds.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { GovernorStore } from '@plumb/risk';
import { FeedStore, buildTrackRecord } from '@plumb/asp';

const STATE_DIR = process.env.PLUMB_STATE_DIR ?? '/var/lib/plumb';
const REVIEW_DIR = process.env.PLUMB_REVIEW_DIR ?? join(STATE_DIR, 'reviews');
const OUT_DIR = process.env.PLUMB_REPORT_DIR ?? join(STATE_DIR, 'weekly');
const BASELINE_PATH = join(STATE_DIR, 'baseline.json');

const baselineAt = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).baselineAt : undefined;
if (baselineAt === undefined) {
  console.error('no baseline.json — the run has not started');
  process.exit(1);
}

const now = Date.now();
const dayMs = 86_400_000;
const elapsedDays = (now - baselineAt) / dayMs;

/** Every daily ledger the review job has written since the run began. */
const ledgers = !existsSync(REVIEW_DIR)
  ? []
  : readdirSync(REVIEW_DIR)
      .filter((f) => f.endsWith('.ledger.json'))
      .sort()
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(REVIEW_DIR, f), 'utf8'));
        } catch {
          return undefined;
        }
      })
      .filter((l) => l !== undefined)
      .filter((l) => Date.parse(`${l.dateUtc}T00:00:00Z`) >= baselineAt - dayMs);

const sum = (key) => ledgers.reduce((n, l) => n + (l[key] ?? 0), 0);

const governor = existsSync(join(STATE_DIR, 'governor.db')) ? new GovernorStore(join(STATE_DIR, 'governor.db')) : undefined;
const state = governor?.load(now);
const feed = existsSync(join(STATE_DIR, 'feed.db')) ? new FeedStore(join(STATE_DIR, 'feed.db')) : undefined;
const record = feed === undefined ? undefined : buildTrackRecord(feed, now);
const chain = feed?.verifyChain();

const haltDays = ledgers.filter((l) => Object.values(l.haltFlags ?? {}).some(Boolean)).length;

const report = {
  runStartUtc: new Date(baselineAt).toISOString(),
  asOfUtc: new Date(now).toISOString(),
  elapsedDays: Number(elapsedDays.toFixed(2)),
  daysWithALedger: ledgers.length,
  cyclesCompleted: sum('cyclesCompleted'),
  cyclesSkipped: sum('cyclesSkipped'),
  degradedSnapshots: sum('degradedSnapshots'),
  venueErrors: sum('venueErrors'),
  signalsEmitted: sum('signalsEmitted'),
  signalsPublished: sum('signalsPublished'),
  tradesOpened: sum('tradesOpened'),
  tradesClosed: sum('tradesClosed'),
  daysWithAHaltFlag: haltDays,
  equityUsdt: state?.equity ?? null,
  peakEquityUsdt: state?.peakEquity ?? null,
  haltFlags: state?.haltFlags ?? {},
  openPositions: state?.openPositions.length ?? null,
  feedChainIntact: chain?.ok ?? null,
  closedTrades: record?.closedTrades ?? null,
  netPnlUsdt: record?.netPnlUsdt ?? null,
  maxDrawdownPct: record?.maxDrawdownPct ?? null,
};

mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date(now).toISOString().slice(0, 10);
writeFileSync(join(OUT_DIR, `${stamp}.json`), JSON.stringify(report, null, 2));

const line = (k, v) => `| ${k} | ${v} |`;
const md = `# Plumb paper run — weekly report, ${stamp}

Run started **${report.runStartUtc}**, day **${Math.floor(elapsedDays)} of 21**.

| | |
| --- | --- |
${line('Cycles completed', report.cyclesCompleted)}
${line('Cycles skipped / degraded', `${report.cyclesSkipped} / ${report.degradedSnapshots}`)}
${line('Venue errors', report.venueErrors)}
${line('Signals emitted / published', `${report.signalsEmitted} / ${report.signalsPublished}`)}
${line('Trades opened / closed', `${report.tradesOpened} / ${report.tradesClosed}`)}
${line('Days with a halt flag set', `${report.daysWithAHaltFlag} of ${report.daysWithALedger}`)}
${line('Equity / peak', `${report.equityUsdt} / ${report.peakEquityUsdt}`)}
${line('Open positions', report.openPositions)}
${line('Feed hash chain', report.feedChainIntact === true ? 'intact' : 'BROKEN')}

Halt flags now: ${Object.entries(report.haltFlags).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}

Every number above is derived from the daily ledgers, the feed and the governor state. This report
does **not** grade the gate — see \`reports/p8-gate.md\` for the criteria and read them against this.
`;
writeFileSync(join(OUT_DIR, `${stamp}.md`), md);

feed?.close();
governor?.close();
console.log(JSON.stringify({ event: 'weekly_report', stamp, elapsedDays: report.elapsedDays, path: join(OUT_DIR, `${stamp}.md`) }));
