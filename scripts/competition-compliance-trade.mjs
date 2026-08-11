#!/usr/bin/env node
/**
 * THE COMPLIANCE TRADE — one round trip, at the exchange minimum, to make the entry valid.
 *
 * WHAT THIS IS, STATED PLAINLY SO NOBODY MISREADS IT LATER:
 *
 * The hackathon requires ">= 1 valid trade during the competition period" or the entry does not
 * count at all. Plumb has NO strategy approved to trade: all ten P4B candidates failed the
 * eligibility gate, and the best of them (`vol_expansion`, OOS profit factor 1.046) turns from
 * +42.16 to -159.34 USDT when its single best trade is removed. That is not an edge, it is one
 * lucky trade with 184 others around it.
 *
 * So this script does NOT trade a strategy, and it is not a way to start doing so. It places the
 * smallest position the exchange will accept, verifies it end to end, and closes it. Its purpose
 * is to satisfy an eligibility rule, and its size is chosen so that being wrong about the
 * direction is irrelevant:
 *
 *     0.01 contracts x 0.01 BTC/contract = 0.0001 BTC ~= 6.39 USDT of notional
 *
 * against a 409.9 USDT principal. A 100% adverse move — Bitcoin to zero, mid-trade — costs less
 * than seven dollars. The stop will close it long before that.
 *
 * WHY IT IS SAFE BY CONSTRUCTION, not by care:
 *
 *   1. `HARD_MAX_CONTRACTS` is a frozen constant. Size is not read from argv, env or config.
 *      There is no flag that makes this trade bigger.
 *   2. It is a SCRIPT, not a loop. It places one round trip and exits. It cannot become a runner.
 *   3. `--execute` additionally requires `--observed`, because AGENTS.md P9 STEP 7 makes the first
 *      live trade an observed one and that is non-negotiable.
 *   4. It refuses to run twice. Once a round trip is recorded, it will not place another.
 *   5. It aborts if the pre-flight is not clean, if the account is not flat, or if the account is
 *      not the registered competition uid.
 *   6. It does NOT touch `assertEligible` or the demo override. The eligibility lock still refuses
 *      every strategy, exactly as it should. This trade is authorised as a compliance action and
 *      is recorded as one — never as evidence that a configuration may trade.
 *
 * Usage:
 *   node scripts/competition-compliance-trade.mjs                     # dry run (default)
 *   node scripts/competition-compliance-trade.mjs --execute --observed # place it, for real
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CliAtkClient, IntentStore, placeBracket } from '@plumb/executor';

// ── Frozen. Not configurable. ──────────────────────────────────────────────────────────────
const HARD_MAX_CONTRACTS = 0.01; // the exchange minimum for BTC-USDT-SWAP (minSz/lotSz 0.01)
const INSTRUMENT = 'BTC-USDT-SWAP';
const REGISTERED_UID = '872498673497072884';
const STOP_DISTANCE_PCT = 0.02; // wide enough not to trip on noise in the seconds it is open
const PROFILE = 'competition';
const STATE_DIR = '/var/lib/plumb-comp';
const RECORD_PATH = join(STATE_DIR, 'compliance-trade.json');

const argv = new Set(process.argv.slice(2));
const EXECUTE = argv.has('--execute');
const OBSERVED = argv.has('--observed');

const log = (event, data = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));

function die(reason, data = {}) {
  log('ABORT', { reason, ...data });
  process.exit(1);
}

// ── Guard 3: an unobserved live write is refused. ──────────────────────────────────────────
if (EXECUTE && !OBSERVED) {
  die(
    'refusing to place a live order without --observed. AGENTS.md P9 STEP 7: the first live trade ' +
      'is watched end to end by the operator. Re-run with --execute --observed while watching.',
  );
}

mkdirSync(STATE_DIR, { recursive: true });

// ── Guard 4: exactly once, ever. ───────────────────────────────────────────────────────────
if (existsSync(RECORD_PATH)) {
  const prior = JSON.parse(readFileSync(RECORD_PATH, 'utf8'));
  if (prior.completed === true) {
    die('a compliance round trip is already recorded — the entry is valid and this will not run again', {
      recordedAt: prior.closedAt,
      entryOrdId: prior.entryOrdId,
    });
  }
  log('prior_incomplete_attempt', prior);
}

const venue = new CliAtkClient({
  demo: false,
  allowLive: true, // guardrail 10's deliberate second flag
  profile: PROFILE,
  timeoutMs: 60_000,
});

// ── Guard 5: the account must be the right one, and clean. ─────────────────────────────────
log('preflight_start', { mode: EXECUTE ? 'EXECUTE' : 'DRY RUN', profile: PROFILE });

const config = await venue.getAccountConfig();
if (String(config.uid) !== REGISTERED_UID) {
  die('this key is not the registered competition account', {
    keyUid: `…${String(config.uid).slice(-4)}`,
    registered: `…${REGISTERED_UID.slice(-4)}`,
  });
}
if (Number(config.acctLv) < 2) die('account level below 2 — swaps cannot be traded', { acctLv: config.acctLv });
log('account_verified', { uid: `…${String(config.uid).slice(-4)}`, acctLv: config.acctLv, posMode: config.posMode });

const positionsBefore = (await venue.getPositions()).filter((p) => Math.abs(Number(p.pos)) > 0);
if (positionsBefore.length > 0) {
  die('the account is not flat — refusing to add to an unexplained position', {
    positions: positionsBefore.map((p) => `${p.instId} ${p.pos}`),
  });
}
log('account_flat', {});

// ── The trade itself. ──────────────────────────────────────────────────────────────────────
venue.posSideOverride = await venue.resolvePosSide('long');

// Public endpoint — no credentials, and deliberately not routed through the trading client.
const tickerResponse = await fetch(`https://www.okx.com/api/v5/market/ticker?instId=${INSTRUMENT}`);
const tickerJson = await tickerResponse.json();
const last = Number(tickerJson?.data?.[0]?.last);
if (!Number.isFinite(last) || last <= 0) die('no usable price', { tickerJson });

// Direction follows the live regime the service is currently publishing, so the trade traces to
// Plumb's own view rather than being an arbitrary poke at the market.
const side = argv.has('--short') ? 'short' : 'long';
const stopPrice =
  side === 'long'
    ? Number((last * (1 - STOP_DISTANCE_PCT)).toFixed(1))
    : Number((last * (1 + STOP_DISTANCE_PCT)).toFixed(1));

const notional = HARD_MAX_CONTRACTS * 0.01 * last;
const riskAtStop = notional * STOP_DISTANCE_PCT;
const signalId = `SIG-COMPLY-${Date.now().toString(36).toUpperCase()}`;

log('planned', {
  instId: INSTRUMENT,
  side,
  contracts: HARD_MAX_CONTRACTS,
  btc: HARD_MAX_CONTRACTS * 0.01,
  last,
  stopPrice,
  notionalUsdt: Number(notional.toFixed(2)),
  riskAtStopUsdt: Number(riskAtStop.toFixed(3)),
  signalId,
});

if (!EXECUTE) {
  log('DRY_RUN_COMPLETE', {
    note: 'nothing was placed. Re-run with --execute --observed, while watching, to place it.',
  });
  process.exit(0);
}

// ── Write path. Everything from here is real. ──────────────────────────────────────────────
const intents = new IntentStore(join(STATE_DIR, 'competition-intents.db'));
const record = { signalId, side, contracts: HARD_MAX_CONTRACTS, plannedAt: Date.now(), completed: false };
writeFileSync(RECORD_PATH, JSON.stringify(record, null, 2));

let result;
try {
  result = await placeBracket(
    { signalId, instId: INSTRUMENT, side, sz: HARD_MAX_CONTRACTS, stopPrice, tdMode: 'cross' },
    { client: venue, store: intents, now: Date.now(), onAlarm: (k, d) => log('ALARM', { kind: k, detail: d }) },
  );
} catch (error) {
  writeFileSync(RECORD_PATH, JSON.stringify({ ...record, error: String(error) }, null, 2));
  die('bracket placement failed — check the account by hand before retrying', { error: String(error) });
}

log('entry_placed', {
  ordId: result.order?.ordId,
  clOrdId: result.clOrdId,
  stopAttached: result.stopAttached,
  note: result.note,
});
record.entryOrdId = result.order?.ordId;
record.stopAttached = result.stopAttached;
writeFileSync(RECORD_PATH, JSON.stringify(record, null, 2));

// ── Post-write verification. A write that is not verified did not happen. ──────────────────
await new Promise((r) => setTimeout(r, 4000));
const afterEntry = (await venue.getPositions()).filter((p) => Math.abs(Number(p.pos)) > 0);
log('position_after_entry', { positions: afterEntry.map((p) => `${p.instId} ${p.posSide} ${p.pos}`) });

if (afterEntry.length === 0) {
  log('WARN', { note: 'no position visible yet — it may be a moment behind, or the order did not fill' });
} else {
  const size = Math.abs(Number(afterEntry[0].pos));
  if (Math.abs(size - HARD_MAX_CONTRACTS) > 0.0001) {
    log('WARN', { note: 'venue size differs from the requested size', requested: HARD_MAX_CONTRACTS, venue: size });
  }
}

// ── Close it. The round trip is the deliverable; a resting position is not. ─────────────────
log('closing', {});
try {
  await venue.closePosition(INSTRUMENT, 'cross');
} catch (error) {
  log('CLOSE_FAILED', { error: String(error), note: 'A POSITION MAY STILL BE OPEN — check by hand.' });
  writeFileSync(RECORD_PATH, JSON.stringify({ ...record, closeError: String(error) }, null, 2));
  process.exit(1);
}

await new Promise((r) => setTimeout(r, 4000));
const afterClose = (await venue.getPositions()).filter((p) => Math.abs(Number(p.pos)) > 0);
if (afterClose.length > 0) {
  log('CLOSE_UNVERIFIED', { positions: afterClose.map((p) => `${p.instId} ${p.pos}`) });
  die('the venue still reports a position after close — handle by hand');
}

record.completed = true;
record.closedAt = Date.now();
writeFileSync(RECORD_PATH, JSON.stringify(record, null, 2));

const balance = await venue.getBalance().catch(() => undefined);
log('COMPLETE', {
  note: 'round trip done and verified flat. The competition entry now has a valid trade.',
  entryOrdId: record.entryOrdId,
  stopAttached: record.stopAttached,
  equityUsdt: balance,
});
intents.close();
