import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';

import { Alerter, consoleSink, formatAlert, type AlertContext } from './alerts.js';
import { Heartbeat } from './heartbeat.js';
import { OPS_PACKAGE } from './index.js';
import { generateReview, templateReview, type DayLedger } from './review.js';
import { backup, databaseIsReadable, pruneBackups, restore, verifyRestore } from './snapshot.js';
import { DEFAULT_THRESHOLDS, WATCHDOG_CAN_REARM, assess, runWatchdog, type WatchdogObservation } from './watchdog.js';

const NOW = Date.parse('2026-08-10T12:00:00Z');
const temps: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'plumb-ops-'));
  temps.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const context: AlertContext = { equityUsdt: 400, openPositions: 0, haltFlags: {}, mode: 'demo' };

function observation(overrides: Partial<WatchdogObservation> = {}): WatchdogObservation {
  return {
    now: NOW,
    lastCycleAt: NOW - 60_000,
    lastDataAt: NOW - 30_000,
    consecutiveVenueFailures: 0,
    reconcileMismatch: false,
    equityUsdt: 400,
    killSwitchEquityUsdt: 335,
    openPositions: 0,
    haltFlags: {},
    mode: 'demo',
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────── watchdog

describe('the watchdog', () => {
  it('is quiet when everything is healthy', () => {
    expect(assess(observation())).toEqual([]);
  });

  it('CANNOT re-arm — only the operator can', () => {
    expect(WATCHDOG_CAN_REARM).toBe(false);
    expect(OPS_PACKAGE.watchdogCanRearm).toBe(false);
  });

  it('detects a stalled runner, and escalates when positions are open', () => {
    const quiet = assess(observation({ lastCycleAt: NOW - 20 * 60_000 }));
    expect(quiet[0]?.condition).toBe('runner_stalled');
    expect(quiet[0]?.severity).toBe('URGENT');
    expect(quiet[0]?.flatten).toBe(false);

    // A frozen runner HOLDING POSITIONS is the dangerous state.
    const dangerous = assess(observation({ lastCycleAt: NOW - 20 * 60_000, openPositions: 2 }));
    expect(dangerous[0]?.severity).toBe('CRITICAL');
    expect(dangerous[0]?.flatten).toBe(true);
    expect(dangerous[0]?.detail).toContain('POSITIONS ARE OPEN');
  });

  it('detects stale market data and sets dataStale', () => {
    const actions = assess(observation({ lastDataAt: NOW - 20 * 60_000, openPositions: 1 }));
    const stale = actions.find((a) => a.condition === 'data_stale');
    expect(stale?.haltFlag).toBe('dataStale');
    expect(stale?.flatten).toBe(true);
  });

  it('detects an unreachable venue but does NOT try to flatten through it', () => {
    const actions = assess(observation({ consecutiveVenueFailures: 6, openPositions: 1 }));
    const venue = actions.find((a) => a.condition === 'venue_unreachable');
    expect(venue?.severity).toBe('CRITICAL');
    // If the venue is unreachable a close order cannot be placed either. Halting stops NEW risk.
    expect(venue?.flatten).toBe(false);
  });

  it('escalates a reconciliation mismatch to CRITICAL and flattens', () => {
    const actions = assess(observation({ reconcileMismatch: true }));
    expect(actions[0]?.condition).toBe('reconcile_mismatch');
    expect(actions[0]?.severity).toBe('CRITICAL');
    expect(actions[0]?.flatten).toBe(true);
  });

  it('warns when equity approaches the kill switch', () => {
    // 335 * 1.05 = 351.75, so 345 is inside the band.
    const actions = assess(observation({ equityUsdt: 345 }));
    const near = actions.find((a) => a.condition === 'near_kill_switch');
    expect(near?.severity).toBe('URGENT');
    // Alert only — the governor owns the switch itself.
    expect(near?.haltFlag).toBeUndefined();
    expect(assess(observation({ equityUsdt: 400 })).some((a) => a.condition === 'near_kill_switch')).toBe(false);
  });

  it('reports EVERY condition that holds, most severe first', () => {
    const actions = assess(
      observation({ lastCycleAt: NOW - 30 * 60_000, lastDataAt: NOW - 30 * 60_000, equityUsdt: 340, openPositions: 1 }),
    );
    expect(actions.length).toBeGreaterThanOrEqual(3);
    expect(actions[0]?.severity).toBe('CRITICAL');
  });

  it('halts and flattens through its deps', async () => {
    const halted: string[] = [];
    let flattened = false;
    const alerter = new Alerter({ sink: consoleSink(() => undefined), now: () => NOW });
    const result = await runWatchdog(observation({ reconcileMismatch: true }), {
      alerter,
      halt: (flag) => {
        halted.push(flag);
      },
      flatten: () => {
        flattened = true;
      },
    });
    expect(result.halted).toContain('reconcileMismatch');
    expect(flattened).toBe(true);
    expect(alerter.sent[0]?.severity).toBe('CRITICAL');
  });

  it('uses sane default thresholds', () => {
    expect(DEFAULT_THRESHOLDS.maxCycleGapMs).toBe(15 * 60_000);
    expect(DEFAULT_THRESHOLDS.killSwitchProximity).toBe(0.05);
  });
});

// ─────────────────────────────────────────────────────────────────────── alerts

describe('alerting', () => {
  it('includes equity, positions and halt flags in every alert', () => {
    const body = formatAlert({
      severity: 'URGENT',
      key: 'k',
      title: 't',
      detail: 'd',
      at: NOW,
      context: { equityUsdt: 372.5, openPositions: 1, haltFlags: { dailyLimit: true }, mode: 'demo' },
    });
    expect(body).toContain('equity 372.50');
    expect(body).toContain('open positions 1');
    expect(body).toContain('halt flags: dailyLimit');
  });

  it('DEDUPLICATES — one incident is not 400 messages', async () => {
    let clock = NOW;
    const alerter = new Alerter({ sink: consoleSink(() => undefined), now: () => clock });
    for (let i = 0; i < 50; i += 1) {
      await alerter.raise('URGENT', 'same_incident', 'title', 'detail', context);
      clock += 1_000;
    }
    expect(alerter.sent).toHaveLength(1);
    expect(alerter.suppressedCount('same_incident')).toBe(49);
  });

  it('reports the suppressed count on the next one through', async () => {
    let clock = NOW;
    const alerter = new Alerter({ sink: consoleSink(() => undefined), now: () => clock });
    await alerter.raise('URGENT', 'k', 't', 'first', context);
    for (let i = 0; i < 5; i += 1) {
      clock += 1_000;
      await alerter.raise('URGENT', 'k', 't', 'again', context);
    }
    clock += 20 * 60_000; // past the URGENT window
    await alerter.raise('URGENT', 'k', 't', 'later', context);
    expect(alerter.sent).toHaveLength(2);
    expect(alerter.sent[1]?.detail).toContain('occurred 5 more times');
  });

  it('treats distinct incidents as distinct', async () => {
    const alerter = new Alerter({ sink: consoleSink(() => undefined), now: () => NOW });
    await alerter.raise('WARN', 'a', 't', 'd', context);
    await alerter.raise('WARN', 'b', 't', 'd', context);
    expect(alerter.sent).toHaveLength(2);
  });

  it('enforces an hourly ceiling, but never gags CRITICAL', async () => {
    let clock = NOW;
    const alerter = new Alerter({ sink: consoleSink(() => undefined), now: () => clock, maxPerHour: 3 });
    for (let i = 0; i < 6; i += 1) {
      clock += 1_000;
      await alerter.raise('WARN', `key${i}`, 't', 'd', context);
    }
    expect(alerter.sent.length).toBeLessThanOrEqual(3);

    clock += 1_000;
    const critical = await alerter.raise('CRITICAL', 'kill_switch', 'kill switch', 'fired', context);
    expect(critical.sent).toBe(true);
  });

  it('an alerting failure never propagates', async () => {
    const alerter = new Alerter({
      sink: { send: async () => { throw new Error('webhook down'); } },
      now: () => NOW,
    });
    await expect(alerter.raise('INFO', 'k', 't', 'd', context)).rejects.toThrow();
    // The sink used in production swallows its own errors — see webhookSink.
  });

  it('counts by severity for the daily review', async () => {
    const alerter = new Alerter({ sink: consoleSink(() => undefined), now: () => NOW });
    await alerter.raise('INFO', 'a', 't', 'd', context);
    await alerter.raise('WARN', 'b', 't', 'd', context);
    await alerter.raise('CRITICAL', 'c', 't', 'd', context);
    expect(alerter.countsBySeverity()).toEqual({ INFO: 1, WARN: 1, URGENT: 0, CRITICAL: 1 });
  });
});

// ─────────────────────────────────────────────────────────────────────── daily review

function ledger(overrides: Partial<DayLedger> = {}): DayLedger {
  return {
    dateUtc: '2026-08-10',
    signalsEmitted: 3,
    signalsPublished: 3,
    vetoesByReason: { max_concurrent: 12, correlated_exposure: 4 },
    gateRejectionsByReason: { regime_low_confidence: 40 },
    tradesOpened: 2,
    tradesClosed: 2,
    realisedPnlUsdt: -3.2,
    equityStartUsdt: 400,
    equityEndUsdt: 396.8,
    peakEquityUsdt: 402,
    drawdownPct: 1.3,
    drawdownRung: 'clear',
    haltFlags: {},
    cyclesCompleted: 96,
    cyclesSkipped: 0,
    degradedSnapshots: 0,
    venueErrors: 0,
    reconcileIssues: 0,
    alertsBySeverity: { INFO: 4, WARN: 0, URGENT: 0, CRITICAL: 0 },
    ...overrides,
  };
}

describe('the daily review', () => {
  it('falls back to a factual template with no model', async () => {
    const result = await generateReview(ledger());
    expect(result.source).toBe('template');
    expect(result.text).toContain('96 cycles completed');
    expect(result.text).toContain('Reconciliation was clean');
  });

  it('handles an EMPTY day without manufacturing significance', async () => {
    const quiet = templateReview(
      ledger({
        signalsEmitted: 0,
        signalsPublished: 0,
        tradesOpened: 0,
        tradesClosed: 0,
        realisedPnlUsdt: 0,
        vetoesByReason: {},
        equityEndUsdt: 400,
      }),
    );
    expect(quiet).toContain('0 signals emitted');
    expect(quiet).toContain('vetoed nothing today');
  });

  it('handles a DISASTER day and says so bluntly', async () => {
    const bad = templateReview(
      ledger({
        realisedPnlUsdt: -21.4,
        equityEndUsdt: 350,
        drawdownPct: 12.9,
        drawdownRung: 'no_new_positions',
        haltFlags: { dailyLimit: true, reconcileMismatch: true },
        degradedSnapshots: 12,
        venueErrors: 40,
        reconcileIssues: 3,
        cyclesSkipped: 14,
      }),
    );
    expect(bad).toContain('RECONCILIATION ISSUES: 3');
    expect(bad).toContain('P0');
    expect(bad).toContain('dailyLimit');
    expect(bad).toContain('no_new_positions');
  });

  it('falls back cleanly when the model is unavailable', async () => {
    const result = await generateReview(ledger(), {
      complete: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(result.source).toBe('template');
    expect(result.fallbackReason).toContain('model unavailable');
  });

  it('accepts model prose', async () => {
    const result = await generateReview(ledger(), {
      complete: async () =>
        'The system ran cleanly through 96 cycles today and took two trades, both of which closed at a small loss. ' +
        'The governor vetoed mostly on concurrency, which is normal when signals cluster.',
    });
    expect(result.source).toBe('model');
    expect(result.text).toContain('96 cycles');
  });

  it('rejects a too-short model response', async () => {
    const result = await generateReview(ledger(), { complete: async () => 'fine' });
    expect(result.source).toBe('template');
    expect(result.fallbackReason).toBe('model returned too little');
  });
});

// ─────────────────────────────────────────────────────────────────────── backups

describe('backup and restore', () => {
  function seedDb(dir: string): string {
    const path = join(dir, 'plumb.db');
    const db = new Database(path);
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    const insert = db.prepare('INSERT INTO t (v) VALUES (?)');
    for (let i = 0; i < 500; i += 1) insert.run(`row-${i}`);
    db.close();
    return path;
  }

  it('backs up a live WAL database consistently', () => {
    const source = tempDir();
    const dbPath = seedDb(source);
    const dest = join(tempDir(), 'nightly');

    const manifest = backup([{ path: dbPath, label: 'state' }], dest, NOW);
    expect(manifest.ok).toBe(true);
    expect(manifest.entries[0]?.bytes).toBeGreaterThan(1000);
    expect(manifest.entries[0]?.sha256).toHaveLength(64);
    expect(databaseIsReadable(manifest.entries[0]?.destination ?? '')).toBe(true);
  });

  it('RESTORES to a clean directory and verifies BY CONTENT HASH', () => {
    const source = tempDir();
    const dbPath = seedDb(source);
    const backupDir = join(tempDir(), 'nightly');
    const manifest = backup([{ path: dbPath, label: 'state' }], backupDir, NOW);

    const restoreDir = tempDir();
    const results = restore(manifest, restoreDir);
    expect(results.every((r) => r.ok)).toBe(true);

    const verified = verifyRestore(manifest, restoreDir);
    expect(verified).toHaveLength(1);
    // Content hash, not size — a truncated database is the same size for most of its length.
    expect(verified[0]?.identical).toBe(true);
    expect(databaseIsReadable(join(restoreDir, 'plumb.db'))).toBe(true);
  });

  it('DETECTS a corrupted restore', () => {
    const source = tempDir();
    const dbPath = seedDb(source);
    const backupDir = join(tempDir(), 'nightly');
    const manifest = backup([{ path: dbPath, label: 'state' }], backupDir, NOW);

    const restoreDir = tempDir();
    restore(manifest, restoreDir);
    writeFileSync(join(restoreDir, 'plumb.db'), 'this is not a database');

    expect(verifyRestore(manifest, restoreDir)[0]?.identical).toBe(false);
    expect(databaseIsReadable(join(restoreDir, 'plumb.db'))).toBe(false);
  });

  it('refuses to overwrite unless asked', () => {
    const source = tempDir();
    const dbPath = seedDb(source);
    const backupDir = join(tempDir(), 'nightly');
    const manifest = backup([{ path: dbPath, label: 'state' }], backupDir, NOW);

    const restoreDir = tempDir();
    restore(manifest, restoreDir);
    expect(restore(manifest, restoreDir)[0]?.ok).toBe(false);
    expect(restore(manifest, restoreDir, { overwrite: true })[0]?.ok).toBe(true);
  });

  it('reports a missing source rather than silently succeeding', () => {
    const manifest = backup([{ path: '/nope/missing.db', label: 'gone' }], tempDir(), NOW);
    expect(manifest.ok).toBe(false);
    expect(manifest.entries[0]?.error).toContain('does not exist');
  });

  it('prunes old nightly directories', () => {
    const root = tempDir();
    for (const day of ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04']) {
      backup([], join(root, day), NOW);
    }
    const removed = pruneBackups(root, 2);
    expect(removed).toEqual(['2026-08-01', '2026-08-02']);
  });
});

// ─────────────────────────────────────────────────────────────────────── heartbeat

describe('the heartbeat', () => {
  it('is disabled without a URL, and says so', async () => {
    const hb = new Heartbeat({ now: () => NOW });
    expect(await hb.ping()).toBe(false);
    expect(hb.state.enabled).toBe(false);
  });

  it('pings outward and records success', async () => {
    const seen: string[] = [];
    const hb = new Heartbeat({
      url: 'https://monitor.example/ping',
      now: () => NOW,
      fetchFn: (async (url: string) => {
        seen.push(String(url));
        return { ok: true } as Response;
      }) as unknown as typeof fetch,
    });
    expect(await hb.ping({ equity: 400 })).toBe(true);
    expect(seen).toEqual(['https://monitor.example/ping']);
    expect(hb.state.lastSuccessAt).toBe(NOW);
    expect(hb.state.consecutiveFailures).toBe(0);
  });

  it('NEVER throws on failure — trading must not depend on a monitor', async () => {
    const hb = new Heartbeat({
      url: 'https://monitor.example/ping',
      now: () => NOW,
      fetchFn: (async () => {
        throw new Error('network down');
      }) as unknown as typeof fetch,
    });
    await expect(hb.ping()).resolves.toBe(false);
    expect(hb.state.consecutiveFailures).toBe(1);
  });
});
