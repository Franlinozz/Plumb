#!/usr/bin/env node
/**
 * THE RUNNER — the unattended cycle loop.
 *
 *   load state → snapshot → isTradeable? → strategy → gate → portfolio → governor →
 *   PUBLISH → execute → reconcile → persist → watchdog → heartbeat → sleep
 *
 * Demo mode only. Guardrail 10 holds until P9; `CliAtkClient` refuses to construct a live client.
 *
 * Every cycle writes `status.json` for the ASP's `/health` and for the watchdog, so a frozen
 * runner is visible from outside the process that froze.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { OkxPublicClient, snapshotFromCandles, tradableUniverse } from '@plumb/market';
import { createSeededIdFactory, runCycle } from '@plumb/strategy';
import {
  DEFAULT_RISK_CONFIG,
  GovernorStore,
  evaluate as governorEvaluate,
  flatten as flattenPositions,
  rollDailyIfNeeded,
} from '@plumb/risk';
import { PERMISSIVE_CONFIG, permissiveStrategy } from '@plumb/backtest';
import { FeedStore, generateRationale, publishThenExecute } from '@plumb/asp';
import {
  CliAtkClient,
  IntentStore,
  assertEligibleOrDemo,
  placeBracket,
  reconcile,
  recoverPendingIntents,
} from '@plumb/executor';
import { Alerter, Heartbeat, consoleSink, runWatchdog } from '@plumb/ops';

const MODE = process.env.PLUMB_MODE ?? 'demo';
const INTERVAL_MS = Number(process.env.PLUMB_CYCLE_MS ?? 300_000);
const FEED_PATH = process.env.PLUMB_FEED_PATH ?? '/var/lib/plumb/feed.db';
const STATE_PATH = process.env.PLUMB_STATE_PATH ?? '/var/lib/plumb/governor.db';
const INTENT_PATH = process.env.PLUMB_INTENT_PATH ?? '/var/lib/plumb/intents.db';
const STATUS_PATH = process.env.PLUMB_STATUS_PATH ?? '/var/lib/plumb/status.json';
const INSTRUMENT = process.env.PLUMB_INSTRUMENT ?? 'BTC-USDT-SWAP';

const BASELINE_PATH = process.env.PLUMB_BASELINE_PATH ?? '/var/lib/plumb/baseline.json';

for (const p of [FEED_PATH, STATE_PATH, INTENT_PATH, STATUS_PATH]) mkdirSync(dirname(p), { recursive: true });

/**
 * WHEN THIS LEDGER BEGAN.
 *
 * Reconciliation cannot match a fill that predates the ledger — the signal it came from was never
 * in this feed. Reconciling on a rolling 24h window therefore latched `reconcileMismatch`
 * permanently against P5B's manual venue fills, which is a true statement about the venue and a
 * useless one about this run: a halt nobody can clear is a halt nobody reads.
 *
 * So the window starts at the later of "24h ago" and "when this ledger was created". Fills before
 * the baseline are out of scope by construction rather than by exception. Recreating the state
 * directory starts a new baseline, which is exactly what beginning a measured run means.
 */
function baselineAt() {
  if (existsSync(BASELINE_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
      if (typeof raw.baselineAt === 'number') return raw.baselineAt;
    } catch {
      // A corrupt baseline is re-stamped rather than treated as absent, so it cannot silently
      // widen the window back over old fills.
    }
  }
  const stamped = Date.now();
  writeFileSync(BASELINE_PATH, JSON.stringify({ baselineAt: stamped, note: 'ledger start; reconciliation never looks before this' }));
  return stamped;
}

const BASELINE_AT = baselineAt();

const log = (level, event, fields = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }));

const market = new OkxPublicClient();
const venue = new CliAtkClient({ demo: true, timeoutMs: 30_000 });
const feed = new FeedStore(FEED_PATH);
const intents = new IntentStore(INTENT_PATH);
const governor = new GovernorStore(STATE_PATH);
let state = governor.load(Date.now());

const alerter = new Alerter({ sink: consoleSink((line) => log('alert', 'alert', { body: line })), now: () => Date.now() });
const heartbeat = new Heartbeat({
  ...(process.env.PLUMB_HEARTBEAT_URL === undefined ? {} : { url: process.env.PLUMB_HEARTBEAT_URL }),
  now: () => Date.now(),
});

// Demo-only eligibility override — no P4B config passed the gate, and this run measures the
// MACHINERY rather than an edge. It cannot apply in live mode; six tests pin that.
const gate = assertEligibleOrDemo(undefined, undefined, {
  mode: MODE,
  venueIsDemo: venue.demo,
  reason: 'P8 paper-trading validation — measuring the machinery, not the edge',
});
log('warn', 'eligibility', { overridden: gate.overridden, note: gate.note });

/**
 * BOOT MUST NOT BLOCK THE LOOP.
 *
 * **DRILL 2 FINDING.** These two calls used to run at module top level, before the interval was
 * armed. Under a venue outage the CLI child blocked on the network, so the process sat "active"
 * with no watchdog, no status write and no alert — a reboot during an outage produced ten silent
 * minutes and then a start-limit death. Observability must not depend on the venue being up.
 *
 * So bootstrap is attempted, failure is loud rather than fatal, and it is retried at the top of
 * every cycle. Nothing trades until it succeeds; `oneCycle` returns early while `bootstrapped` is
 * false, and the watchdog keeps reporting throughout.
 */
let bootstrapped = false;

async function bootstrap(now) {
  if (bootstrapped) return true;
  try {
    venue.posSideOverride = await venue.resolvePosSide('long');
    const boot = await recoverPendingIntents(venue, intents, now);
    log('info', 'boot_recovery', boot);
    bootstrapped = true;
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log('error', 'bootstrap_failed', { message: message.slice(0, 200) });
    await alerter.raise(
      'URGENT',
      'bootstrap_failed',
      'venue unreachable at start-up',
      'the runner is up but has not reached the venue, so pending intents are unrecovered and nothing will trade. It retries every cycle and recovers by itself when the venue returns.',
      { equityUsdt: state.equity, openPositions: state.openPositions.length, haltFlags: state.haltFlags, mode: MODE },
    );
    return false;
  }
}

let lastCycleAt;
let lastDataAt;
let venueFailures = 0;
let reconcileMismatch = false;
let cycleIndex = 0;
let running = false;

function writeStatus() {
  const openPositions = state.openPositions.length;
  writeFileSync(
    STATUS_PATH,
    JSON.stringify({
      lastCycleAt: lastCycleAt ?? null,
      haltFlags: state.haltFlags,
      equityUsdt: state.equity,
      openPositions,
      mode: MODE,
      cycleIndex,
      updatedAt: Date.now(),
    }),
  );
}

async function oneCycle() {
  const now = Date.now();
  state = rollDailyIfNeeded(state, now);

  // Retried here, not once at start-up. Until it succeeds the venue is unreachable and there is
  // nothing safe to do but stay observable — the tick still runs the watchdog and the heartbeat.
  if (!(await bootstrap(now))) {
    writeStatus();
    throw new Error('bootstrap incomplete: venue unreachable');
  }

  const candles = await market.candles(INSTRUMENT, '1H', { limit: 300 });
  const funding = await market.fundingRate(INSTRUMENT);
  lastDataAt = Date.now();

  const snapshot = snapshotFromCandles({
    now,
    instId: INSTRUMENT,
    candles: [{ tf: '1H', ohlcv: candles }],
    fundingRate: funding.fundingRate,
  });
  if (snapshot.degraded) {
    log('warn', 'snapshot_degraded', { fields: snapshot.degradedFields });
    return;
  }

  const config = { ...PERMISSIVE_CONFIG, trendEma: { ...PERMISSIVE_CONFIG.trendEma, atrMultiple: 6 } };
  const cycle = runCycle(snapshot, {
    now,
    newId: createSeededIdFactory(now % 1_000_000),
    config,
    modules: [permissiveStrategy],
    state: {
      openPositions: state.openPositions.map((p) => ({
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
      state,
      {
        instId: INSTRUMENT,
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
      log('info', 'veto', { signalId: signal.id, code: verdict.code });
      if (verdict.flatten) {
        const plan = flattenPositions(state, 'kill_switch', now);
        log('critical', 'flatten_requested', { intents: plan.intents.length, code: verdict.code });
      }
      continue;
    }

    // PUBLISH BEFORE EXECUTE. Publication first; the executor reads the published entry.
    await publishThenExecute(signal, {
      store: feed,
      now,
      rationale: async (frozen) => {
        const r = await generateRationale(
          frozen,
          process.env.ANTHROPIC_API_KEY === undefined ? {} : { apiKey: process.env.ANTHROPIC_API_KEY },
        );
        return r.text;
      },
      execute: async (entry) => {
        const result = await placeBracket(
          {
            signalId: entry.id,
            instId: entry.instId,
            side: entry.side,
            sz: verdict.sizing.contracts,
            stopPrice: entry.stopPrice,
          },
          {
            client: venue,
            store: intents,
            now,
            onAlarm: (kind, detail) =>
              void alerter.raise('CRITICAL', kind, kind, detail, {
                equityUsdt: state.equity,
                openPositions: state.openPositions.length,
                haltFlags: state.haltFlags,
                mode: MODE,
              }),
          },
        );
        if (result.placed) {
          state = {
            ...state,
            openPositions: [
              ...state.openPositions,
              {
                instId: entry.instId,
                side: entry.side,
                contracts: verdict.sizing.contracts,
                notionalUsdt: verdict.sizing.notionalUsdt,
                entryPrice: snapshot.last,
                stopPrice: entry.stopPrice,
                openedAt: now,
                signalId: entry.id,
              },
            ],
            totalNotional: state.totalNotional + verdict.sizing.notionalUsdt,
          };
          log('info', 'position_opened', { signalId: entry.id, contracts: verdict.sizing.contracts });
        }
      },
    });
  }

  // Reconcile every cycle. This is what keeps the published record and reality in step.
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
    // Never look before the ledger existed — an unmatchable fill is not a mismatch.
    sinceTs: Math.max(now - 86_400_000, BASELINE_AT),
  });
  reconcileMismatch = audit.mustHalt;
  if (audit.mustHalt) {
    state = {
      ...state,
      haltFlags: { ...state.haltFlags, reconcileMismatch: true },
      haltReason: audit.issues[0]?.detail ?? 'reconciliation mismatch',
      haltedAt: now,
    };
    log('critical', 'reconcile_mismatch', { issues: audit.issues.length });
  }

  governor.save(state, now);
  lastCycleAt = Date.now();
  cycleIndex += 1;
  writeStatus();
  log('info', 'cycle_complete', {
    index: cycleIndex,
    signals: cycle.signals.length,
    regime: cycle.regime.label,
    equity: state.equity,
    open: state.openPositions.length,
  });
}

async function tick() {
  if (running) {
    log('warn', 'cycle_overrun', { index: cycleIndex });
    return;
  }
  running = true;
  try {
    await oneCycle();
    venueFailures = 0;
  } catch (error) {
    venueFailures += 1;
    log('error', 'cycle_failed', { message: error instanceof Error ? error.message : String(error), venueFailures });
  } finally {
    running = false;
  }

  await runWatchdog(
    {
      now: Date.now(),
      lastCycleAt,
      lastDataAt,
      consecutiveVenueFailures: venueFailures,
      reconcileMismatch,
      equityUsdt: state.equity,
      killSwitchEquityUsdt: 335,
      openPositions: state.openPositions.length,
      haltFlags: state.haltFlags,
      mode: MODE,
    },
    {
      alerter,
      halt: (flag, reason) => {
        state = { ...state, haltFlags: { ...state.haltFlags, [flag]: true }, haltReason: reason, haltedAt: Date.now() };
        governor.save(state, Date.now());
        writeStatus();
      },
      flatten: (reason) => {
        const plan = flattenPositions(state, 'manual', Date.now());
        log('critical', 'watchdog_flatten', { reason, intents: plan.intents.length });
      },
    },
  );

  await heartbeat.ping({ equity: state.equity, open: state.openPositions.length, cycle: cycleIndex });
}

log('info', 'runner_started', { mode: MODE, intervalMs: INTERVAL_MS, instrument: INSTRUMENT });
writeStatus();
// Arm the interval BEFORE the first tick. If tick() blocks on an unreachable venue, the timer is
// already running and the process is still supervised — the drill-2 lesson, encoded in the order.
const timer = setInterval(() => void tick(), INTERVAL_MS);
await tick();

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    log('info', 'runner_stopping', { signal });
    clearInterval(timer);
    governor.save(state, Date.now());
    writeStatus();
    feed.close();
    intents.close();
    governor.close();
    process.exit(0);
  });
}
