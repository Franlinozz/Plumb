import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signEligibility, type EligibilitySummary } from '@plumb/core';
import { afterAll, describe, expect, it } from 'vitest';

import { AtkError, assertDemo, classifyError, withRetry, type PlaceOrderRequest } from './atk.js';
import { NakedPositionError, entrySide, placeBracket } from './bracket.js';
import { matchesSignal, resolveSignalId, toClOrdId, toCloseClOrdId } from './clord.js';
import { EXECUTOR_PACKAGE } from './index.js';
import { IntentStore } from './idempotency.js';
import {
  DEFAULT_LIFECYCLE,
  StopRegressionError,
  currentR,
  isTighter,
  manage,
  tightenStop,
  type ManagedPosition,
} from './lifecycle.js';
import { MockAtk } from './mock.js';
import { reconcile, recoverPendingIntents } from './reconcile.js';
import { CycleRunner, NotEligibleError, assertEligible } from './runner.js';

const NOW = Date.parse('2026-08-09T12:00:00Z');
const SIGNAL = 'SIG-abc_DEF-gh';
const temps: string[] = [];
const tempDb = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'plumb-exec-'));
  temps.push(dir);
  return join(dir, 'exec.db');
};
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function bracketRequest(overrides: Record<string, unknown> = {}) {
  return {
    signalId: SIGNAL,
    instId: 'BTC-USDT-SWAP' as const,
    side: 'long' as const,
    sz: 0.61,
    stopPrice: 64_350,
    ...overrides,
  };
}

describe('demo mode only (guardrail 10)', () => {
  it('declares itself demo-only', () => {
    expect(EXECUTOR_PACKAGE.demoOnly).toBe(true);
  });

  it('defaults to demo and REFUSES to build a live client', () => {
    expect(() => assertDemo({})).not.toThrow();
    expect(() => assertDemo({ demo: true })).not.toThrow();
    expect(() => assertDemo({ demo: false })).toThrow(AtkError);
    expect(() => assertDemo({ demo: false })).toThrow(/demo-only/);
  });

  it('needs TWO deliberate flags to go live, and this phase sets neither', () => {
    expect(() => assertDemo({ demo: false, allowLive: true })).not.toThrow();
    expect(() => assertDemo({ demo: false, allowLive: false })).toThrow(AtkError);
  });

  it('the mock is a demo venue', () => {
    expect(new MockAtk().demo).toBe(true);
  });
});

describe('client order ids', () => {
  it('strips characters OKX rejects, keeping the mapping recoverable', () => {
    // OKX allows letters and digits only. Our ids contain '-' and can contain '_'.
    expect(toClOrdId('SIG-abc_DEF-gh')).toBe('SIGabcDEFgh');
    expect(toClOrdId(SIGNAL)).toMatch(/^[A-Za-z0-9]+$/);
    expect(toClOrdId(SIGNAL).length).toBeLessThanOrEqual(32);
  });

  it('never exceeds 32 characters', () => {
    expect(toClOrdId(`SIG-${'a'.repeat(60)}`).length).toBe(32);
  });

  it('rejects an id with nothing usable in it', () => {
    expect(() => toClOrdId('---')).toThrow(RangeError);
  });

  it('matches a clOrdId back to its signal', () => {
    expect(matchesSignal('SIGabcDEFgh', SIGNAL)).toBe(true);
    expect(matchesSignal('SOMETHINGELSE', SIGNAL)).toBe(false);
    expect(resolveSignalId('SIGabcDEFgh', [SIGNAL, 'SIG-other00000'])).toBe(SIGNAL);
    expect(resolveSignalId('MANUALTRADE1', [SIGNAL])).toBeUndefined();
  });

  it('gives a close order a distinct id from its entry', () => {
    expect(toCloseClOrdId(SIGNAL)).not.toBe(toClOrdId(SIGNAL));
  });
});

describe('error classification and retry', () => {
  it('separates accidents from decisions', () => {
    expect(classifyError('request timed out')).toBe('timeout');
    expect(classifyError('ECONNRESET')).toBe('transport');
    expect(classifyError('insufficient margin')).toBe('rejected');
    expect(classifyError('unauthorized: bad api key')).toBe('auth');
    expect(classifyError('order not found')).toBe('not_found');
  });

  it('retries only what might not have reached the venue', () => {
    expect(new AtkError('timeout', 'x').retryable).toBe(true);
    expect(new AtkError('transport', 'x').retryable).toBe(true);
    expect(new AtkError('rejected', 'x').retryable).toBe(false);
    expect(new AtkError('auth', 'x').retryable).toBe(false);
  });

  it('NEVER blindly retries a rejected order', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw new AtkError('rejected', 'insufficient margin');
        },
        { maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 2 },
        async () => undefined,
        () => 0.5,
      ),
    ).rejects.toThrow(AtkError);
    // A rejection is a decision. Retrying it either does nothing or opens a surprise position.
    expect(attempts).toBe(1);
  });

  it('does retry a timeout, up to the limit', async () => {
    let attempts = 0;
    const delays: number[] = [];
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw new AtkError('timeout', 'timed out');
        },
        { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 },
        async (ms) => {
          delays.push(ms);
        },
        () => 0.5,
      ),
    ).rejects.toThrow();
    expect(attempts).toBe(3);
    expect(delays).toEqual([50, 100]);
  });

  it('returns as soon as it succeeds', async () => {
    let attempts = 0;
    const value = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 2) throw new AtkError('timeout', 'timed out');
        return 'ok';
      },
      { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
      async () => undefined,
      () => 0,
    );
    expect(value).toBe('ok');
    expect(attempts).toBe(2);
  });
});

describe('bracketed placement', () => {
  it('places the entry with the stop ATTACHED', async () => {
    const client = new MockAtk();
    const store = new IntentStore();
    const result = await placeBracket(bracketRequest(), { client, store, now: NOW });

    expect(result.placed).toBe(true);
    expect(result.stopAttached).toBe(true);
    const placed = client.placed[0] as PlaceOrderRequest;
    expect(placed.slTriggerPx).toBe(64_350);
    expect(placed.clOrdId).toBe(toClOrdId(SIGNAL));
    expect(placed.side).toBe('buy');
    store.close();
  });

  it('maps a position side to the right order side', () => {
    expect(entrySide('long')).toBe('buy');
    expect(entrySide('short')).toBe('sell');
  });

  it('persists intent BEFORE placing', async () => {
    const client = new MockAtk({
      rejectPlaceFor: () => new AtkError('rejected', 'venue said no'),
    });
    const store = new IntentStore();
    await expect(placeBracket(bracketRequest(), { client, store, now: NOW })).rejects.toThrow();

    // The intent exists even though the order never did — which is what makes recovery possible.
    const intent = store.get(toClOrdId(SIGNAL));
    expect(intent).toBeDefined();
    expect(intent?.status).toBe('failed');
    store.close();
  });

  it('IDEMPOTENCY: the same signal replayed five times opens ONE position', async () => {
    const client = new MockAtk();
    const store = new IntentStore();
    const results = [];
    for (let i = 0; i < 5; i += 1) {
      results.push(await placeBracket(bracketRequest(), { client, store, now: NOW + i }));
    }
    expect(client.placed).toHaveLength(1);
    expect(results.filter((r) => r.placed)).toHaveLength(1);
    expect(results.filter((r) => r.duplicate)).toHaveLength(4);
    expect(store.bySignal(SIGNAL)).toHaveLength(1);
    store.close();
  });

  it('FAULT INJECTION: a failed stop closes the entry IMMEDIATELY and raises an alarm', async () => {
    // Two-step path, with the stop placement rejected.
    const client = new MockAtk({
      rejectPlaceFor: (request) =>
        request.reduceOnly === true ? new AtkError('rejected', 'stop rejected by venue') : undefined,
    });
    const store = new IntentStore();
    const alarms: string[] = [];

    await expect(
      placeBracket(bracketRequest({ atomic: false }), {
        client,
        store,
        now: NOW,
        onAlarm: (kind) => alarms.push(kind),
      }),
    ).rejects.toThrow(NakedPositionError);

    // The entry was closed, not left running.
    expect(client.closes).toEqual(['BTC-USDT-SWAP']);
    expect(alarms).toEqual(['naked_position_closed']);
    expect(await client.getPositions()).toEqual([]);
    expect(store.get(toClOrdId(SIGNAL))?.status).toBe('abandoned');
    store.close();
  });

  it('FAULT INJECTION: stop fails AND close fails → alarm says STUCK, loudly', async () => {
    const client = new MockAtk({
      rejectPlaceFor: (request) =>
        request.reduceOnly === true ? new AtkError('rejected', 'stop rejected') : undefined,
      failClose: true,
    });
    const store = new IntentStore();
    const alarms: string[] = [];

    const error = await placeBracket(bracketRequest({ atomic: false }), {
      client,
      store,
      now: NOW,
      onAlarm: (kind) => alarms.push(kind),
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NakedPositionError);
    expect((error as NakedPositionError).closed).toBe(false);
    expect(alarms).toEqual(['naked_position_stuck']);
    expect(store.ledger().some((e) => e.kind === 'naked_position_STUCK')).toBe(true);
    store.close();
  });

  it('records every placement in the ledger', async () => {
    const client = new MockAtk();
    const store = new IntentStore();
    await placeBracket(bracketRequest(), { client, store, now: NOW });
    const ledger = store.ledger();
    expect(ledger.some((e) => e.kind === 'bracket_placed' && e.signalId === SIGNAL)).toBe(true);
    store.close();
  });
});

describe('crash recovery', () => {
  it('recovers an intent whose order DID land, without placing a second', async () => {
    const path = tempDb();
    const client = new MockAtk();

    // Cycle 1: intent persisted, order placed, then the process dies before marking it.
    const first = new IntentStore(path);
    first.recordIntent(
      {
        signalId: SIGNAL,
        clOrdId: toClOrdId(SIGNAL),
        instId: 'BTC-USDT-SWAP',
        side: 'buy',
        posSide: 'long',
        sz: 0.61,
        stopPrice: 64_350,
        createdAt: NOW,
      },
      NOW,
    );
    await client.placeOrder({
      instId: 'BTC-USDT-SWAP',
      side: 'buy',
      posSide: 'long',
      ordType: 'market',
      sz: 0.61,
      clOrdId: toClOrdId(SIGNAL),
      slTriggerPx: 64_350,
    });
    expect(first.pending()).toHaveLength(1);
    first.close(); // crash

    // Boot: the intent is adopted from the venue, not re-placed.
    const second = new IntentStore(path);
    const recovery = await recoverPendingIntents(client, second, NOW + 1_000);
    expect(recovery.recovered).toBe(1);
    expect(recovery.abandoned).toBe(0);
    expect(second.get(toClOrdId(SIGNAL))?.status).toBe('placed');
    expect(client.placed).toHaveLength(1);

    // And a replay after recovery still opens nothing new.
    await placeBracket(bracketRequest(), { client, store: second, now: NOW + 2_000 });
    expect(client.placed).toHaveLength(1);
    second.close();
  });

  it('abandons an intent whose order never landed', async () => {
    const client = new MockAtk();
    const store = new IntentStore();
    store.recordIntent(
      {
        signalId: SIGNAL,
        clOrdId: toClOrdId(SIGNAL),
        instId: 'BTC-USDT-SWAP',
        side: 'buy',
        posSide: 'long',
        sz: 0.61,
        stopPrice: 64_350,
        createdAt: NOW,
      },
      NOW,
    );
    const recovery = await recoverPendingIntents(client, store, NOW + 1_000);
    expect(recovery.abandoned).toBe(1);
    expect(store.get(toClOrdId(SIGNAL))?.status).toBe('abandoned');
    store.close();
  });

  it('persists the ledger across a restart', () => {
    const path = tempDb();
    const first = new IntentStore(path);
    first.append({ ts: NOW, kind: 'test', signalId: SIGNAL, instId: 'BTC-USDT-SWAP', detail: 'hello' });
    first.close();

    const second = new IntentStore(path);
    expect(second.ledger()).toHaveLength(1);
    expect(second.ledger()[0]?.detail).toBe('hello');
    second.close();
  });
});

describe('reconciliation', () => {
  const recorded = [
    { instId: 'BTC-USDT-SWAP', side: 'long' as const, contracts: 0.61, signalId: SIGNAL },
  ];

  async function setup() {
    const client = new MockAtk();
    const store = new IntentStore();
    await placeBracket(bracketRequest(), { client, store, now: NOW });
    client.setPosition('BTC-USDT-SWAP', 0.61);
    return { client, store };
  }

  it('passes when the venue and the ledger agree', async () => {
    const { client, store } = await setup();
    const result = await reconcile({
      client,
      store,
      recorded,
      knownSignalIds: [SIGNAL],
      now: NOW,
    });
    expect(result.ok).toBe(true);
    expect(result.mustHalt).toBe(false);
    expect(result.matchedFills).toBeGreaterThan(0);
    store.close();
  });

  it('CATCHES an unmatched fill and demands a halt', async () => {
    const { client, store } = await setup();
    client.injectOrphanFill('BTC-USDT-SWAP');

    const result = await reconcile({ client, store, recorded, knownSignalIds: [SIGNAL], now: NOW });
    expect(result.ok).toBe(false);
    expect(result.mustHalt).toBe(true);
    expect(result.issues.some((i) => i.kind === 'unmatched_fill')).toBe(true);
    // And it is written down, because this is the event an audit will ask about.
    expect(store.ledger().some((e) => e.kind === 'reconcile_unmatched_fill')).toBe(true);
    store.close();
  });

  it('CATCHES size drift and demands a halt', async () => {
    const { client, store } = await setup();
    client.setPosition('BTC-USDT-SWAP', 1.22); // double what we recorded

    const result = await reconcile({ client, store, recorded, knownSignalIds: [SIGNAL], now: NOW });
    expect(result.mustHalt).toBe(true);
    expect(result.issues.some((i) => i.kind === 'size_drift')).toBe(true);
    store.close();
  });

  it('CATCHES a position we record but the venue does not have', async () => {
    const { client, store } = await setup();
    client.clearPositions();

    const result = await reconcile({ client, store, recorded, knownSignalIds: [SIGNAL], now: NOW });
    expect(result.mustHalt).toBe(true);
    expect(result.issues.some((i) => i.kind === 'missing_fill')).toBe(true);
    store.close();
  });

  it('CATCHES a position at the venue we never opened', async () => {
    const { client, store } = await setup();
    client.setPosition('ETH-USDT-SWAP', 2, 'short');

    const result = await reconcile({ client, store, recorded, knownSignalIds: [SIGNAL], now: NOW });
    expect(result.mustHalt).toBe(true);
    expect(result.issues.some((i) => i.kind === 'unknown_position')).toBe(true);
    store.close();
  });

  it('tolerates nothing by default — an exchange does not round our size for us', async () => {
    const { client, store } = await setup();
    client.setPosition('BTC-USDT-SWAP', 0.62);
    expect((await reconcile({ client, store, recorded, knownSignalIds: [SIGNAL], now: NOW })).mustHalt).toBe(true);

    const tolerant = await reconcile({
      client,
      store,
      recorded,
      knownSignalIds: [SIGNAL],
      now: NOW,
      sizeTolerance: 0.02,
    });
    expect(tolerant.mustHalt).toBe(false);
    store.close();
  });
});

describe('lifecycle', () => {
  const position: ManagedPosition = {
    signalId: SIGNAL,
    instId: 'BTC-USDT-SWAP',
    side: 'long',
    contracts: 0.61,
    entryPrice: 65_000,
    stopPrice: 64_350,
    openedAt: NOW,
    openedAtBar: 10,
    maxHoldBars: 8,
    invalidationConditions: ['ADX falls below 25'],
  };

  it('knows which direction is tighter, for both sides', () => {
    expect(isTighter('long', 64_350, 64_500)).toBe(true);
    expect(isTighter('long', 64_350, 64_000)).toBe(false);
    expect(isTighter('short', 65_650, 65_500)).toBe(true);
    expect(isTighter('short', 65_650, 66_000)).toBe(false);
  });

  it('NEVER moves a stop further from entry — long and short', () => {
    expect(tightenStop(position, 64_500).stopPrice).toBe(64_500);
    expect(() => tightenStop(position, 64_000)).toThrow(StopRegressionError);

    const short: ManagedPosition = { ...position, side: 'short', stopPrice: 65_650 };
    expect(tightenStop(short, 65_500).stopPrice).toBe(65_500);
    expect(() => tightenStop(short, 66_000)).toThrow(StopRegressionError);
  });

  it('FUZZ: across many R multiples, a stop only ever moves closer', () => {
    for (const side of ['long', 'short'] as const) {
      let current: ManagedPosition = {
        ...position,
        side,
        stopPrice: side === 'long' ? 64_350 : 65_650,
      };
      for (let i = 1; i <= 200; i += 1) {
        const candidate = side === 'long' ? 64_350 + i * 2 : 65_650 - i * 2;
        const previous = current.stopPrice;
        current = tightenStop(current, candidate);
        expect(isTighter(side, previous, current.stopPrice)).toBe(true);
        // And the reverse is always refused.
        const backwards = side === 'long' ? current.stopPrice - 1 : current.stopPrice + 1;
        expect(() => tightenStop(current, backwards)).toThrow(StopRegressionError);
      }
    }
  });

  it('rejects a nonsense stop', () => {
    expect(() => tightenStop(position, 0)).toThrow(StopRegressionError);
    expect(() => tightenStop(position, Number.NaN)).toThrow(StopRegressionError);
  });

  it('computes R correctly', () => {
    // risk = 650. +650 is 1R.
    expect(currentR(position, 65_650)).toBeCloseTo(1, 10);
    expect(currentR(position, 64_350)).toBeCloseTo(-1, 10);
    expect(currentR({ ...position, side: 'short' }, 64_350)).toBeCloseTo(1, 10);
  });

  it('moves the stop to breakeven at 1R', () => {
    const action = manage({ position, price: 65_650, bar: 12 });
    expect(action.kind).toBe('move_stop');
    expect(action.newStopPrice).toBeGreaterThan(position.entryPrice);
    // Breakeven plus a buffer, so it covers fees rather than landing exactly on entry.
    expect(action.newStopPrice).toBeCloseTo(65_000 * (1 + DEFAULT_LIFECYCLE.breakevenBufferPct), 6);
  });

  it('does not move the stop before 1R', () => {
    expect(manage({ position, price: 65_100, bar: 12 }).kind).toBe('none');
  });

  it('CLOSES at maxHoldBars', () => {
    const action = manage({ position, price: 65_100, bar: 18 }); // opened at bar 10, max 8
    expect(action.kind).toBe('close');
    expect(action.reason).toContain('maxHoldBars');
  });

  it('CLOSES when an invalidation condition fires', () => {
    const action = manage({
      position,
      price: 65_100,
      bar: 12,
      triggeredConditions: ['ADX falls below 25'],
    });
    expect(action.kind).toBe('close');
    expect(action.reason).toContain('ADX falls below 25');
  });

  it('prefers invalidation over a breakeven move', () => {
    const action = manage({
      position,
      price: 66_000,
      bar: 12,
      triggeredConditions: ['regime changed'],
    });
    expect(action.kind).toBe('close');
  });
});

describe('the eligibility lock', () => {
  const summary: EligibilitySummary = {
    label: 'breakout_range',
    eligible: true,
    failedOn: [],
    criteria: [{ name: 'P(ruin)', passed: true, actual: '1.00%' }],
    tradeCount: 42,
    profitFactor: 1.4,
    totalReturnUsdt: 30,
    maxDrawdownPct: 5,
    probabilityOfRuin: 0.01,
    p5Equity: 380,
    criteriaUsed: { killSwitchEquity: 335 },
    evaluatedAt: NOW,
  };

  it('accepts a genuine passing record', () => {
    expect(() => assertEligible(summary, signEligibility(summary))).not.toThrow();
  });

  it('REFUSES when there is no record at all', () => {
    expect(() => assertEligible(undefined, undefined)).toThrow(NotEligibleError);
    expect(() => assertEligible(summary, undefined)).toThrow(NotEligibleError);
  });

  it('REFUSES a record that failed the gate', () => {
    const failed = { ...summary, eligible: false, failedOn: ['P(ruin)'] };
    expect(() => assertEligible(failed, signEligibility(failed))).toThrow(/NOT eligible/);
  });

  it('REFUSES a hand-edited "eligible: true"', () => {
    // The exact attack this exists to stop: flip the flag in a JSON file and try to trade.
    const failed = { ...summary, eligible: false, failedOn: ['P(ruin)'] };
    const honestSignature = signEligibility(failed);
    const forged = { ...failed, eligible: true, failedOn: [] };
    expect(() => assertEligible(forged, honestSignature)).toThrow(/signature verification/);
  });

  it('refuses every P4 configuration, because all five failed', () => {
    for (const label of ['trend_ema', 'revert_band', 'breakout_range', 'funding_skew', 'all_four_combined']) {
      const record = { ...summary, label, eligible: false, failedOn: ['P(ruin)'] };
      expect(() => assertEligible(record, signEligibility(record))).toThrow(NotEligibleError);
    }
  });
});

describe('the cycle loop', () => {
  function runner(cycleFn: (i: number) => Promise<string>, intervalMs = 100) {
    let clock = NOW;
    const store = new IntentStore();
    const sleeps: number[] = [];
    const r = new CycleRunner({
      client: new MockAtk(),
      store,
      cycle: async (i) => cycleFn(i),
      now: () => clock,
      intervalMs,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    return { runner: r, store, sleeps, advance: (ms: number) => (clock += ms) };
  }

  it('runs cycles in sequence', async () => {
    const seen: number[] = [];
    const { runner: r, store } = runner(async (i) => {
      seen.push(i);
      return 'ok';
    });
    await r.run(3);
    expect(seen).toEqual([0, 1, 2]);
    expect(r.history.every((h) => h.outcome === 'ran')).toBe(true);
    store.close();
  });

  it('NEVER overlaps — a cycle in flight blocks the next', async () => {
    const { runner: r, store } = runner(async () => 'ok');
    const first = r.runOnce();
    expect(r.busy).toBe(true);
    const second = await r.runOnce(); // called while the first is still running
    expect(second.outcome).toBe('skipped_overrun');
    expect(second.note).toContain('not queued');
    await first;
    expect(r.skippedCount).toBe(1);
    store.close();
  });

  it('SKIPS the next slot when a cycle overruns, and logs it', async () => {
    const { runner: r, store, advance } = runner(async () => {
      advance(250); // three times the 100ms interval
      return 'slow';
    }, 100);
    await r.run(2);
    expect(r.skippedCount).toBeGreaterThan(0);
    expect(store.ledger().some((e) => e.kind === 'cycle_overrun')).toBe(true);
    store.close();
  });

  it('sleeps only the remainder of the interval', async () => {
    const { runner: r, store, sleeps, advance } = runner(async () => {
      advance(30);
      return 'ok';
    }, 100);
    await r.run(1);
    expect(sleeps).toEqual([70]);
    store.close();
  });

  it('records a failing cycle without stopping the loop', async () => {
    const { runner: r, store } = runner(async (i) => {
      if (i === 1) throw new Error('cycle blew up');
      return 'ok';
    });
    const reports = await r.run(3);
    expect(reports.map((x) => x.outcome)).toEqual(['ran', 'failed', 'ran']);
    expect(reports[1]?.note).toContain('cycle blew up');
    store.close();
  });

  it('writes every cycle to the ledger', async () => {
    const { runner: r, store } = runner(async () => 'ok');
    await r.run(2);
    expect(store.ledger().filter((e) => e.kind === 'cycle_ran')).toHaveLength(2);
    store.close();
  });
});
