#!/usr/bin/env node
/**
 * GO FLAT. The operator's disarm button.
 *
 * Closes every recorded open position with a REDUCE-ONLY order carrying `toCloseClOrdId`, so each
 * close still traces back to the signal that opened it. `swap close` is deliberately NOT used for
 * the normal path: it produces a fill with an empty `clOrdId`, unattributable by construction, and
 * reconciliation will flag it forever after (gotcha 15).
 *
 * Stop the runner FIRST — otherwise it may open something behind you:
 *
 *   systemctl stop plumb-runner && node /opt/plumb/scripts/flatten.mjs
 *
 * Pass `--force-naked` to fall back to the blunt `closePosition` for anything the reduce-only path
 * could not close. That is the emergency path and it makes the position unattributable; it exists
 * because an unattributable flat position beats an attributable open one.
 */

import { GovernorStore, flatten } from '@plumb/risk';
import { CliAtkClient, entrySide, toCloseClOrdId } from '@plumb/executor';

const STATE_PATH = process.env.PLUMB_STATE_PATH ?? '/var/lib/plumb/governor.db';
const MODE = process.env.PLUMB_MODE ?? 'demo';
const FORCE_NAKED = process.argv.includes('--force-naked');

const governor = new GovernorStore(STATE_PATH);
const now = Date.now();
let state = governor.load(now);

const plan = flatten(state, 'manual', now);
if (plan.intents.length === 0) {
  console.log(JSON.stringify({ event: 'flatten', mode: MODE, positions: 0, note: 'nothing recorded as open' }));
  governor.close();
  process.exit(0);
}

const venue = new CliAtkClient({ demo: MODE !== 'live', timeoutMs: 30_000 });
venue.posSideOverride = await venue.resolvePosSide('long');

const results = [];
for (const intent of plan.intents) {
  const position = state.openPositions.find((p) => p.signalId === intent.positionSignalId);
  if (position === undefined) {
    // Never a silent skip. A flatten that closes nothing and says nothing is the worst outcome
    // this script can have, so an intent with no matching position is reported as a failure.
    results.push({ signalId: intent.positionSignalId, closed: false, error: 'no matching recorded position' });
    continue;
  }
  try {
    await venue.placeOrder({
      instId: position.instId,
      side: entrySide(position.side) === 'buy' ? 'sell' : 'buy',
      posSide: position.side,
      ordType: 'market',
      sz: position.contracts,
      tdMode: 'cross',
      clOrdId: toCloseClOrdId(position.signalId),
      reduceOnly: true,
    });
    results.push({ signalId: position.signalId, closed: true, path: 'reduce-only' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!FORCE_NAKED) {
      results.push({ signalId: position.signalId, closed: false, error: message.slice(0, 120) });
      continue;
    }
    try {
      await venue.closePosition(position.instId, 'cross');
      results.push({ signalId: position.signalId, closed: true, path: 'swap close (UNATTRIBUTABLE)' });
    } catch (fallbackError) {
      const m = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      results.push({ signalId: position.signalId, closed: false, error: m.slice(0, 120) });
    }
  }
}

// Only positions actually closed leave the recorded book. A close that failed stays open in state,
// because pretending otherwise is how a position becomes invisible.
const closedIds = new Set(results.filter((r) => r.closed).map((r) => r.signalId));
state = {
  ...state,
  openPositions: state.openPositions.filter((p) => !closedIds.has(p.signalId)),
  haltFlags: { ...state.haltFlags, manual: true },
  haltReason: 'operator flatten',
  haltedAt: now,
};
state = { ...state, totalNotional: state.openPositions.reduce((n, p) => n + p.notionalUsdt, 0) };
governor.save(state, now);
governor.close();

const failed = results.filter((r) => !r.closed);
console.log(JSON.stringify({ event: 'flatten', mode: MODE, results, stillOpen: state.openPositions.length }, null, 2));
if (failed.length > 0) {
  console.error(`${failed.length} position(s) COULD NOT BE CLOSED — they remain open and recorded. Handle by hand.`);
  process.exit(1);
}
