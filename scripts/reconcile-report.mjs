#!/usr/bin/env node
/**
 * WHAT DOES THE VENUE THINK, AND WHERE DO WE DISAGREE?
 *
 * Read-only. It places no orders and changes no state — it is what you run at 3am when
 * `reconcileMismatch` is set and you need to know what kind of mismatch it is before deciding
 * anything.
 *
 * The three kinds mean different things and want different responses, so they are labelled:
 *
 *   unmatched_fill, empty clOrdId   → a `swap close` happened. Unattributable by construction.
 *   unmatched_fill, unknown clOrdId → a fill from before this ledger, or a manual order.
 *   size_drift                      → the venue is the truth. Reconcile TO it, never the reverse.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CliAtkClient, IntentStore, reconcile } from '@plumb/executor';
import { GovernorStore } from '@plumb/risk';

const STATE_DIR = process.env.PLUMB_STATE_DIR ?? '/var/lib/plumb';
const MODE = process.env.PLUMB_MODE ?? 'demo';
const BASELINE_PATH = join(STATE_DIR, 'baseline.json');

const baselineAt = existsSync(BASELINE_PATH)
  ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).baselineAt
  : undefined;

const venue = new CliAtkClient({ demo: MODE !== 'live', timeoutMs: 30_000 });
venue.posSideOverride = await venue.resolvePosSide('long');

const intents = new IntentStore(join(STATE_DIR, 'intents.db'));
const governor = new GovernorStore(join(STATE_DIR, 'governor.db'));
const now = Date.now();
const state = governor.load(now);

const audit = await reconcile({
  client: venue,
  store: intents,
  recorded: state.openPositions.map((p) => ({
    instId: p.instId,
    side: p.side,
    contracts: p.contracts,
    signalId: p.signalId,
  })),
  knownSignalIds: intents.all().map((i) => i.signalId),
  now,
  sizeTolerance: 0.01,
  // Same window the runner uses. Reporting on a wider one would show "problems" the runner has
  // correctly decided are out of scope, which at 3am is worse than showing nothing.
  sinceTs: baselineAt === undefined ? now - 86_400_000 : Math.max(now - 86_400_000, baselineAt),
});

const venuePositions = await venue.getPositions();

console.log(`mode            ${MODE}`);
console.log(`baseline        ${baselineAt === undefined ? '(none)' : new Date(baselineAt).toISOString()}`);
console.log(`must halt       ${audit.mustHalt}`);
console.log(`issues          ${audit.issues.length}`);
console.log('');
console.log('WE RECORD:');
for (const p of state.openPositions) {
  console.log(`  ${p.instId} ${p.side} ${p.contracts} (signal ${p.signalId}, stop ${p.stopPrice})`);
}
if (state.openPositions.length === 0) console.log('  (nothing)');
console.log('');
console.log('THE VENUE REPORTS:');
for (const p of venuePositions) console.log(`  ${p.instId} ${p.posSide} pos=${p.pos} avgPx=${p.avgPx} upl=${p.upl}`);
if (venuePositions.length === 0) console.log('  (flat)');
console.log('');

if (audit.issues.length === 0) {
  console.log('No disagreement.');
} else {
  console.log('ISSUES:');
  for (const issue of audit.issues) console.log(`  [${issue.kind}] ${issue.detail}`);
}

intents.close();
governor.close();
