#!/usr/bin/env node
/**
 * A live-data execution session.
 *
 * Runs the FULL cycle loop — snapshot → strategy → gate → portfolio → governor → bracketed
 * placement → reconcile → persist — against REAL market data from OKX's public endpoints.
 *
 * ┌────────────────────────────────────────────────────────────────────────────────────────┐
 * │ VENUE: by default this uses the MOCK venue, not the Agent Trade Kit.                     │
 * │                                                                                          │
 * │ The Trade Kit's `--demo` mode needs a SEPARATE demo API key                              │
 * │ (okx.com/account/my-api?go-demo-trading=1), which we do not have — the key we hold is a  │
 * │ LIVE sub-account key, and guardrail 10 forbids touching it before P9. So the order flow   │
 * │ here is simulated while the DATA and every decision are real.                             │
 * │                                                                                          │
 * │ Set PLUMB_ATK_DEMO_PROFILE to run against the real Trade Kit in demo mode once a demo    │
 * │ key exists. Nothing else changes.                                                        │
 * └────────────────────────────────────────────────────────────────────────────────────────┘
 *
 *   node scripts/demo-session.mjs [--cycles 12] [--interval 5000]
 */

import { OkxPublicClient, snapshotFromCandles, tradableUniverse } from '@plumb/market';
import { createSeededIdFactory, runCycle } from '@plumb/strategy';
import {
  DEFAULT_RISK_CONFIG,
  GovernorStore,
  evaluate as governorEvaluate,
  flatten,
} from '@plumb/risk';
import { PERMISSIVE_CONFIG, permissiveStrategy } from '@plumb/backtest';
import {
  CycleRunner,
  IntentStore,
  MockAtk,
  placeBracket,
  reconcile,
  recoverPendingIntents,
  toClOrdId,
} from '@plumb/executor';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};
const cycles = Number(arg('cycles', '12'));
const intervalMs = Number(arg('interval', '5000'));

if (process.env.PLUMB_ATK_DEMO_PROFILE !== undefined) {
  console.error('a real Trade Kit demo profile is configured, but the CLI adapter is P9 work — aborting');
  process.exit(1);
}

// A WIDE stop, so the position sizes under MAX_TOTAL_NOTIONAL and the loop actually places.
// Narrow stops are correctly vetoed on notional — see the P3/P5 checkpoints.
const sessionConfig = {
  ...PERMISSIVE_CONFIG,
  trendEma: { ...PERMISSIVE_CONFIG.trendEma, atrMultiple: 6 },
};

const market = new OkxPublicClient();
const venue = new MockAtk();
const intents = new IntentStore();
const governor = new GovernorStore();
let state = governor.load(Date.now());

console.log('\nPlumb execution session — LIVE market data, SIMULATED venue');
console.log(`cycles ${cycles}, interval ${intervalMs}ms, starting equity ${state.equity} USDT`);
console.log('strategy: permissive_test (not a candidate — it exists to exercise the loop)\n');

const boot = await recoverPendingIntents(venue, intents, Date.now());
console.log(`boot recovery: ${boot.recovered} recovered, ${boot.abandoned} abandoned, ${boot.stillPending} pending\n`);

const openPositions = new Map();
let placed = 0;
let vetoed = 0;
let reconcileFailures = 0;

async function oneCycle(index) {
  const now = Date.now();
  const notes = [];

  for (const instId of tradableUniverse()) {
    const candles = await market.candles(instId, '1H', { limit: 300 });
    const funding = await market.fundingRate(instId);
    const snapshot = snapshotFromCandles({
      now,
      instId,
      candles: [{ tf: '1H', ohlcv: candles }],
      fundingRate: funding.fundingRate,
    });

    // isTradeable? — a degraded snapshot stops here.
    if (snapshot.degraded) {
      notes.push(`${instId}:degraded(${snapshot.degradedFields.join(',')})`);
      continue;
    }

    const cycle = runCycle(snapshot, {
      now,
      newId: createSeededIdFactory(index * 97 + instId.length),
      config: sessionConfig,
      modules: [permissiveStrategy],
      state: {
        openPositions: [...openPositions.values()].map((p) => ({
          instId: p.instId,
          side: p.side,
          notional: p.notionalUsdt,
          openedAt: p.openedAt,
          signalId: p.signalId,
        })),
        lastSignalAt: {},
      },
    });

    for (const signal of cycle.signals) {
      const verdict = governorEvaluate(
        signal,
        { ...state, openPositions: [...openPositions.values()] },
        {
          instId,
          ts: now,
          degraded: false,
          degradedFields: [],
          last: snapshot.last,
          funding: { current: snapshot.funding.current },
        },
        now,
        DEFAULT_RISK_CONFIG,
      );
      state = verdict.state;

      if (!verdict.approved) {
        vetoed += 1;
        notes.push(`${instId}:veto(${verdict.code})`);
        continue;
      }

      // PUBLISH BEFORE EXECUTE — P6 hook. No-op for now, but the ordering is already real.
      intents.append({
        ts: now,
        kind: 'signal_published',
        signalId: signal.id,
        instId,
        detail: `${signal.side} ${verdict.sizing.contracts} @ ~${snapshot.last} stop ${signal.stop.price}`,
      });

      const result = await placeBracket(
        {
          signalId: signal.id,
          instId,
          side: signal.side,
          sz: verdict.sizing.contracts,
          stopPrice: signal.stop.price,
        },
        { client: venue, store: intents, now, onAlarm: (k, d) => console.log(`  ALARM ${k}: ${d}`) },
      );

      if (result.placed) {
        placed += 1;
        openPositions.set(signal.id, {
          instId,
          side: signal.side,
          contracts: verdict.sizing.contracts,
          notionalUsdt: verdict.sizing.notionalUsdt,
          entryPrice: snapshot.last,
          stopPrice: signal.stop.price,
          openedAt: now,
          signalId: signal.id,
        });
        venue.setPosition(instId, signal.side === 'long' ? verdict.sizing.contracts : -verdict.sizing.contracts, signal.side);
        notes.push(`${instId}:PLACED(${result.stopAttached ? 'stop attached' : 'NO STOP'})`);
      } else if (result.duplicate) {
        notes.push(`${instId}:duplicate-suppressed`);
      }
    }
  }

  // ── RECONCILE every cycle. This is what keeps us eligible. ──────────────────────────────
  const audit = await reconcile({
    client: venue,
    store: intents,
    recorded: [...openPositions.values()].map((p) => ({
      instId: p.instId,
      side: p.side,
      contracts: p.contracts,
      signalId: p.signalId,
    })),
    knownSignalIds: intents.all().map((i) => i.signalId),
    now,
    sizeTolerance: 1e-9,
  });

  if (audit.mustHalt) {
    reconcileFailures += 1;
    state = {
      ...state,
      haltFlags: { ...state.haltFlags, reconcileMismatch: true },
      haltReason: audit.issues[0]?.detail ?? 'reconciliation mismatch',
      haltedAt: now,
    };
    const flat = flatten(state, 'reconcile_mismatch', now);
    console.log(`  RECONCILE FAILED — halting. ${audit.issues.length} issue(s), ${flat.intents.length} close intent(s)`);
    for (const issue of audit.issues.slice(0, 3)) console.log(`    ${issue.kind}: ${issue.detail}`);
  }

  governor.save(state, now);
  return `${notes.length === 0 ? 'no action' : notes.join(' ')} | reconcile ${audit.ok ? 'clean' : 'FAILED'}`;
}

const runner = new CycleRunner({
  client: venue,
  store: intents,
  cycle: oneCycle,
  now: () => Date.now(),
  intervalMs,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  onReport: (r) => console.log(`  cycle ${String(r.index).padStart(3)} ${r.outcome.padEnd(15)} ${r.durationMs}ms  ${r.note}`),
});

await runner.run(cycles);

// ── Fault injection, so the session proves the alarm works rather than only that nothing broke.
console.log('\ninjecting an unmatched fill — reconciliation MUST catch it:');
venue.injectOrphanFill('BTC-USDT-SWAP', 'MANUALTRADE99');
const injected = await reconcile({
  client: venue,
  store: intents,
  recorded: [...openPositions.values()].map((p) => ({
    instId: p.instId,
    side: p.side,
    contracts: p.contracts,
    signalId: p.signalId,
  })),
  knownSignalIds: intents.all().map((i) => i.signalId),
  now: Date.now(),
  sizeTolerance: 1e-9,
});
console.log(`  caught: ${!injected.ok}  mustHalt: ${injected.mustHalt}  issues: ${injected.issues.map((i) => i.kind).join(', ')}`);

console.log(`\n${'='.repeat(78)}\nSESSION SUMMARY\n${'='.repeat(78)}`);
console.log(`cycles run          ${runner.history.filter((r) => r.outcome === 'ran').length}`);
console.log(`cycles skipped      ${runner.skippedCount}`);
console.log(`orders placed       ${placed}`);
console.log(`governor vetoes     ${vetoed}`);
console.log(`open positions      ${openPositions.size}`);
console.log(`reconcile failures  ${reconcileFailures} (before the deliberate injection)`);
console.log(`equity              ${state.equity.toFixed(2)} USDT`);
console.log(`venue orders        ${venue.placed.length}  (every one carries a clOrdId derived from its signal)`);

console.log(`\nLEDGER (${intents.ledger().length} entries)`);
for (const entry of intents.ledger()) {
  const when = new Date(entry.ts).toISOString().slice(11, 19);
  console.log(`  ${when}  ${entry.kind.padEnd(24)} ${(entry.signalId ?? '-').padEnd(16)} ${entry.detail.slice(0, 90)}`);
}

console.log('\nINTENTS');
for (const intent of intents.all()) {
  console.log(
    `  ${intent.clOrdId.padEnd(16)} ${intent.status.padEnd(10)} ${intent.instId.padEnd(15)} ` +
      `${intent.posSide} ${intent.sz} stop ${intent.stopPrice}  (signal ${intent.signalId})`,
  );
}

const allBracketed = venue.placed.every((p) => p.slTriggerPx !== undefined || p.reduceOnly === true);
console.log(`\nevery entry carried a stop: ${allBracketed}`);
console.log(`clOrdId ↔ signal mapping intact: ${intents.all().every((i) => i.clOrdId === toClOrdId(i.signalId))}`);

intents.close();
governor.close();
