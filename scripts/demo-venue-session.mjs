#!/usr/bin/env node
/**
 * P5B — the REAL Agent Trade Kit demo venue session.
 *
 * Verifies against an actual venue what the mock could only assert: that an order places, that the
 * stop attaches and is visible, that clOrdId round-trips unchanged, that position/fill shapes match
 * what the wrapper expects, that reconciliation matches real fills to signal ids, and that the
 * cancel/close paths work.
 *
 * Demo credentials only. The live sub-account key is never read (guardrail 10).
 *
 *   node scripts/demo-venue-session.mjs [--inst BTC-USDT-SWAP]
 */

import { OkxPublicClient, snapshotFromCandles, specFor } from '@plumb/market';
import { createSeededIdFactory, runCycle } from '@plumb/strategy';
import { DEFAULT_RISK_CONFIG, GovernorStore, evaluate as governorEvaluate } from '@plumb/risk';
import { PERMISSIVE_CONFIG, permissiveStrategy } from '@plumb/backtest';
import {
  AtkError,
  CliAtkClient,
  IntentStore,
  assertEligibleOrDemo,
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
const instId = arg('inst', 'BTC-USDT-SWAP');

const findings = [];
const note = (label, detail) => {
  findings.push(`${label}: ${detail}`);
  console.log(`  ${label.padEnd(34)} ${detail}`);
};

const venue = new CliAtkClient({ demo: true, timeoutMs: 30_000 });
const intents = new IntentStore();
const governor = new GovernorStore();
let state = governor.load(Date.now());
const market = new OkxPublicClient();

console.log('\n' + '='.repeat(84));
console.log('P5B — LIVE AGENT TRADE KIT DEMO VENUE SESSION');
console.log('='.repeat(84));

// ── 0. The eligibility lock, and the demo-only override. ───────────────────────────────────
const gate = assertEligibleOrDemo(undefined, undefined, {
  mode: 'demo',
  venueIsDemo: venue.demo,
  reason: 'P5B venue verification — no order here is a trading decision',
});
console.log(`\neligibility: ${gate.overridden ? 'OVERRIDDEN' : 'genuine'}\n  ${gate.note}\n`);

// ── 1. Read paths. ─────────────────────────────────────────────────────────────────────────
console.log('READ PATHS');
const balances = await venue.getBalance();
const usdt = balances.find((b) => b.ccy === 'USDT');
note('balance shape', `${balances.length} currencies, USDT eq ${usdt?.eq ?? 'n/a'}`);

const startPositions = await venue.getPositions();
note('positions shape', `${startPositions.length} open (${JSON.stringify(startPositions.slice(0, 1))})`);

const startFills = await venue.getFills(instId);
note('fills shape', `${startFills.length} historical fills`);

const boot = await recoverPendingIntents(venue, intents, Date.now());
note('boot recovery', `${boot.recovered} recovered, ${boot.abandoned} abandoned, ${boot.stillPending} pending`);

// Account mode decides whether ANY swap order is possible. Read it before trying.
const acct = await venue.getAccountConfig();
note('account config', `acctLv ${acct.acctLv} posMode ${acct.posMode} canTradeSwaps ${acct.canTradeSwaps}`);
if (!acct.canTradeSwaps) {
  console.log(
    `\n  BLOCKED: acctLv ${acct.acctLv} is SPOT MODE — perpetual swaps cannot be traded at all.\n` +
      `  Every place returns sCode 51010. This is an OKX ACCOUNT SETTING, not a parameter problem,\n` +
      `  and the Trade Kit CLI has no command to change it (only set-position-mode).\n` +
      `  OPERATOR: switch the DEMO account to a margin account mode (Single-currency margin or\n` +
      `  higher) in the OKX UI, then re-run this script unchanged.\n`,
  );
}
venue.posSideOverride = await venue.resolvePosSide('long');
note('posSide resolved', String(venue.posSideOverride));

// ── 2. Build a real signal through the real pipeline. ──────────────────────────────────────
console.log('\nPIPELINE');
const candles = await market.candles(instId, '1H', { limit: 300 });
const funding = await market.fundingRate(instId);
const snapshot = snapshotFromCandles({
  now: Date.now(),
  instId,
  candles: [{ tf: '1H', ohlcv: candles }],
  fundingRate: funding.fundingRate,
});
note('snapshot', `last ${snapshot.last}, degraded ${snapshot.degraded}`);

const sessionConfig = { ...PERMISSIVE_CONFIG, trendEma: { ...PERMISSIVE_CONFIG.trendEma, atrMultiple: 6 } };
const cycle = runCycle(snapshot, {
  now: Date.now(),
  newId: createSeededIdFactory(Date.now() % 100000),
  config: sessionConfig,
  modules: [permissiveStrategy],
  state: { openPositions: [], lastSignalAt: {} },
});
const signal = cycle.signals[0];
if (signal === undefined) {
  console.log('  no signal this cycle — regime was ' + cycle.regime.label);
  process.exit(0);
}
note('signal', `${signal.id} ${signal.side} stop ${signal.stop.price.toFixed(1)} regime ${signal.regime}`);

const verdict = governorEvaluate(
  signal,
  state,
  { instId, ts: Date.now(), degraded: false, degradedFields: [], last: snapshot.last, funding: { current: snapshot.funding.current } },
  Date.now(),
  DEFAULT_RISK_CONFIG,
);
state = verdict.state;
if (!verdict.approved) {
  console.log(`  governor VETOED: ${verdict.code} — ${verdict.reason}`);
  process.exit(0);
}
// Round to the venue lot grid; the governor already sized to it.
const spec = specFor(instId);
note('governor', `approved ${verdict.sizing.contracts} contracts, risk ${verdict.sizing.actualRiskUsdt.toFixed(3)} USDT, lev ${verdict.sizing.leverage.toFixed(2)}`);

// ── 3. THE PLACEMENT — a real bracketed order at a real venue. ─────────────────────────────
console.log('\nPLACEMENT');
const sentClOrdId = toClOrdId(signal.id);
note('clOrdId sent', sentClOrdId);

let placeResult;
try {
  placeResult = await placeBracket(
    { signalId: signal.id, instId, side: signal.side, sz: verdict.sizing.contracts, stopPrice: signal.stop.price },
    { client: venue, store: intents, now: Date.now(), onAlarm: (k, d) => console.log(`  ALARM ${k}: ${d}`) },
  );
  note('placed', `${placeResult.placed} ordId ${placeResult.order?.ordId} stopAttached ${placeResult.stopAttached}`);
} catch (error) {
  note('PLACEMENT FAILED', error instanceof AtkError ? `${error.kind}: ${error.message}` : String(error));
  intents.close();
  governor.close();
  process.exit(1);
}

// ── 4. Verify at the venue what the mock could only assert. ────────────────────────────────
console.log('\nVENUE VERIFICATION');
const fetched = await venue.getOrder(instId, { clOrdId: sentClOrdId });
note('order visible by clOrdId', fetched === undefined ? 'NOT FOUND' : `${fetched.ordId} state ${fetched.state}`);

const roundTrip = fetched?.clOrdId === sentClOrdId;
note(
  'clOrdId ROUND-TRIP',
  fetched === undefined ? 'could not check' : `sent "${sentClOrdId}" got "${fetched.clOrdId}" → ${roundTrip ? 'EXACT' : 'TRANSFORMED — idempotency scheme needs adjusting'}`,
);

note('stop visible at venue', fetched?.slTriggerPx === undefined ? 'NOT VISIBLE on the order record' : `slTriggerPx ${fetched.slTriggerPx}`);

const positions = await venue.getPositions(instId);
const pos = positions.find((p) => Math.abs(p.pos) > 0);
note('position opened', pos === undefined ? 'NONE' : `${pos.posSide} ${pos.pos} @ ${pos.avgPx}`);

const fills = await venue.getFills(instId);
const ourFill = fills.find((f) => f.clOrdId === sentClOrdId);
note('fill visible', ourFill === undefined ? 'NOT FOUND' : `${ourFill.fillSz} @ ${ourFill.fillPx} fee ${ourFill.fee}`);

// ── 5. Reconciliation against REAL venue state. ────────────────────────────────────────────
console.log('\nRECONCILIATION');
const recorded = pos === undefined ? [] : [{ instId, side: signal.side, contracts: Math.abs(pos.pos), signalId: signal.id }];
const audit = await reconcile({
  client: venue,
  store: intents,
  recorded,
  knownSignalIds: intents.all().map((i) => i.signalId),
  now: Date.now(),
  sizeTolerance: spec.lotSz,
});
note('reconcile', `ok ${audit.ok}, matched ${audit.matchedFills} fills, ${audit.issues.length} issue(s)`);
for (const issue of audit.issues.slice(0, 5)) console.log(`      ${issue.kind}: ${issue.detail.slice(0, 110)}`);

// ── 6. FAULT INJECTION against the real venue. ─────────────────────────────────────────────
console.log('\nFAULT INJECTION');

// 6a. Replay the same signal five times — must open exactly one position.
let replayPlaced = 0;
for (let i = 0; i < 5; i += 1) {
  const r = await placeBracket(
    { signalId: signal.id, instId, side: signal.side, sz: verdict.sizing.contracts, stopPrice: signal.stop.price },
    { client: venue, store: intents, now: Date.now() },
  );
  if (r.placed) replayPlaced += 1;
}
note('replay x5 → new positions', String(replayPlaced));

// 6b. Crash between intent and placement, then restart.
const crashSignalId = 'SIG-crashtest01';
const crashClOrdId = toClOrdId(crashSignalId);
intents.recordIntent(
  { signalId: crashSignalId, clOrdId: crashClOrdId, instId, side: 'buy', posSide: 'long', sz: spec.minSz, stopPrice: snapshot.last * 0.5, createdAt: Date.now() },
  Date.now(),
);
const recovery = await recoverPendingIntents(venue, intents, Date.now());
note('crash recovery', `recovered ${recovery.recovered}, abandoned ${recovery.abandoned} (order never placed → abandon is correct)`);

// 6c. Force a stop-placement failure with an invalid stop price.
const badSignalId = 'SIG-badstop0001';
let stopFaultOutcome = 'not triggered';
try {
  await placeBracket(
    { signalId: badSignalId, instId, side: 'long', sz: spec.minSz, stopPrice: -1, atomic: true },
    { client: venue, store: intents, now: Date.now(), onAlarm: (k, d) => console.log(`      ALARM ${k}: ${d.slice(0, 100)}`) },
  );
  stopFaultOutcome = 'venue ACCEPTED an invalid stop — a finding';
} catch (error) {
  stopFaultOutcome = error instanceof AtkError ? `rejected (${error.kind}) — entry never opened` : String(error).slice(0, 90);
}
note('invalid stop price', stopFaultOutcome);

// ── 7. Cancel / close paths. ───────────────────────────────────────────────────────────────
console.log('\nCLOSE PATH');
try {
  await venue.closePosition(instId, 'cross');
  const after = await venue.getPositions(instId);
  const still = after.find((p) => Math.abs(p.pos) > 0);
  note('close position', still === undefined ? 'closed, venue reports flat' : `STILL OPEN: ${still.pos}`);
} catch (error) {
  note('close position', `FAILED ${error instanceof AtkError ? error.kind : ''} ${String(error).slice(0, 80)}`);
}

// ── 8. Ledger. ─────────────────────────────────────────────────────────────────────────────
console.log('\nLEDGER');
for (const entry of intents.ledger()) {
  console.log(`  ${new Date(entry.ts).toISOString().slice(11, 19)}  ${entry.kind.padEnd(24)} ${(entry.signalId ?? '-').padEnd(17)} ${entry.detail.slice(0, 86)}`);
}

console.log('\nINTENTS');
for (const i of intents.all()) {
  console.log(`  ${i.clOrdId.padEnd(16)} ${i.status.padEnd(10)} ${i.instId.padEnd(15)} ${i.posSide} ${i.sz}  (${i.signalId})`);
}

console.log('\nCLI CALLS MADE');
for (const call of venue.calls) console.log(`  okx ${call.slice(0, 120)}`);

console.log(`\n${'='.repeat(84)}\nFINDINGS\n${'='.repeat(84)}`);
for (const f of findings) console.log(`  ${f}`);

intents.close();
governor.close();
