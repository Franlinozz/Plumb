import { readFileSync, readdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Signal } from '@plumb/core';
import { afterAll, describe, expect, it } from 'vitest';

import { FeedStore, hashEntry, GENESIS_HASH } from './feed.js';
import { createApp } from './http.js';
import { ASP_PACKAGE } from './index.js';
import { PublicationRequiredError, publishThenExecute, requirePublished } from './publish_gate.js';
import { containsForeignNumber, generateRationale, templateRationale } from './rationale.js';
import {
  PLUMB_SERVICE,
  SubscriptionDeletionRefused,
  activeSubscribers,
  formatSignalForDelivery,
  planDelivery,
  refuseDeletion,
} from './subscription.js';
import { TOOL_NAMES, callTool } from './tools.js';
import { buildTrackRecord } from './track_record.js';

const NOW = Date.parse('2026-08-10T12:00:00Z');

function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: 'SIG-abcdefghij',
    ts: NOW,
    instId: 'BTC-USDT-SWAP',
    side: 'long',
    intent: 'open',
    entry: { type: 'market', price: 65_000 },
    stop: { price: 64_350, distancePct: 0.01, basis: 'atr' },
    takeProfit: [{ price: 65_975, rMultiple: 1.5 }],
    timeframe: '1H',
    strategyId: 'trend_ema',
    regime: 'trending_up',
    inputs: { adx: 31.2, atr: 500 },
    invalidation: { maxHoldBars: 8, conditions: ['ADX falls below 25'] },
    expiresAt: NOW + 7_200_000,
    version: '1.0.0',
    ...overrides,
  };
}

function outcome(signalId: string, netPnlUsdt: number, closedAt: number) {
  return {
    signalId,
    instId: 'BTC-USDT-SWAP',
    side: 'long' as const,
    openedAt: closedAt - 3_600_000,
    closedAt,
    entryPrice: 65_000,
    exitPrice: 65_000 + netPnlUsdt,
    contracts: 0.61,
    netPnlUsdt,
    rMultiple: netPnlUsdt / 4,
    fundingUsdt: 0.05,
    reason: netPnlUsdt > 0 ? ('target' as const) : ('stop' as const),
    equityAfter: 400 + netPnlUsdt,
  };
}

// ─────────────────────────────────────────────────────────────── the structural guarantee

describe('PUBLISH BEFORE EXECUTE (guardrail 2)', () => {
  it('THE EXECUTOR CANNOT ACCESS AN UNPUBLISHED SIGNAL', () => {
    const store = new FeedStore();
    expect(() => requirePublished(store, 'SIG-neverpublished')).toThrow(PublicationRequiredError);
    expect(() => requirePublished(store, 'SIG-neverpublished')).toThrow(/has not been published/);
    store.close();
  });

  it('publishes FIRST, then executes, and hands the executor the PUBLISHED ENTRY', async () => {
    const store = new FeedStore();
    const order: string[] = [];
    let received: unknown;

    const result = await publishThenExecute(signal(), {
      store,
      now: NOW,
      rationale: async () => {
        order.push('rationale');
        return 'because the trend filter agreed';
      },
      deliver: () => {
        order.push('deliver');
      },
      execute: async (entry) => {
        order.push('execute');
        received = entry;
        // By the time the executor runs, the signal is already in the record.
        expect(store.isPublished(entry.id)).toBe(true);
      },
    });

    expect(order).toEqual(['rationale', 'deliver', 'execute']);
    expect(result.executed).toBe(true);
    // The executor receives the FEED ENTRY, not the Signal object.
    expect((received as { hash: string }).hash).toBe(result.entry.hash);
    expect((received as { rationale: string }).rationale).toBe('because the trend filter agreed');
    store.close();
  });

  it('never executes when publication fails', async () => {
    const store = new FeedStore();
    let executed = false;
    const broken = {
      ...store,
      publish: () => {
        throw new Error('disk full');
      },
    } as unknown as FeedStore;

    await expect(
      publishThenExecute(signal(), {
        store: broken,
        now: NOW,
        rationale: async () => 'r',
        execute: async () => {
          executed = true;
        },
      }),
    ).rejects.toThrow('disk full');
    expect(executed).toBe(false);
    store.close();
  });

  it('is idempotent — republishing does not fork the chain', async () => {
    const store = new FeedStore();
    const deps = { store, now: NOW, rationale: async () => 'r', execute: async () => undefined };
    const first = await publishThenExecute(signal(), deps);
    const second = await publishThenExecute(signal(), deps);
    expect(first.alreadyPublished).toBe(false);
    expect(second.alreadyPublished).toBe(true);
    expect(store.count()).toBe(1);
    expect(store.verifyChain().ok).toBe(true);
    store.close();
  });
});

// ─────────────────────────────────────────────────────────────── the feed

describe('the published feed', () => {
  it('is append-only and hash-chained from a genesis hash', () => {
    const store = new FeedStore();
    const a = store.publish(signal({ id: 'SIG-aaaaaaaaaa' }), 'a', NOW).entry;
    const b = store.publish(signal({ id: 'SIG-bbbbbbbbbb' }), 'b', NOW + 1).entry;

    expect(a.prevHash).toBe(GENESIS_HASH);
    expect(b.prevHash).toBe(a.hash);
    expect(store.headHash()).toBe(b.hash);
    expect(store.verifyChain().ok).toBe(true);
    store.close();
  });

  it('DETECTS an edited entry', () => {
    const store = new FeedStore();
    store.publish(signal({ id: 'SIG-aaaaaaaaaa' }), 'a', NOW);
    store.publish(signal({ id: 'SIG-bbbbbbbbbb' }), 'b', NOW + 1);
    expect(store.verifyChain().ok).toBe(true);

    // Quietly amend a published signal's stop, as one might to make it match a trade.
    const raw = (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db;
    const tampered = JSON.stringify({
      ...JSON.parse(
        (store as unknown as { db: { prepare: (s: string) => { get: (...a: unknown[]) => { payload: string } } } }).db
          .prepare('SELECT payload FROM published_signals WHERE id = ?')
          .get('SIG-aaaaaaaaaa').payload,
      ),
      stopPrice: 1,
    });
    raw.prepare('UPDATE published_signals SET payload = ? WHERE id = ?').run(tampered, 'SIG-aaaaaaaaaa');

    const check = store.verifyChain();
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('do not match its recorded hash');
    store.close();
  });

  it('DETECTS a removed entry', () => {
    const store = new FeedStore();
    store.publish(signal({ id: 'SIG-aaaaaaaaaa' }), 'a', NOW);
    store.publish(signal({ id: 'SIG-bbbbbbbbbb' }), 'b', NOW + 1);
    store.publish(signal({ id: 'SIG-cccccccccc' }), 'c', NOW + 2);
    (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db
      .prepare('DELETE FROM published_signals WHERE id = ?')
      .run('SIG-bbbbbbbbbb');

    const check = store.verifyChain();
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('prevHash');
    store.close();
  });

  it('hashes deterministically regardless of input key order', () => {
    const store = new FeedStore();
    const entry = store.publish(signal(), 'r', NOW).entry;
    const { seq, hash, ...partial } = entry;
    expect(hashEntry(partial)).toBe(hash);
    store.close();
  });

  it('records the exact indicator inputs verbatim', () => {
    const store = new FeedStore();
    const entry = store.publish(signal({ inputs: { adx: 31.234567, atr: 500.5 } }), 'r', NOW).entry;
    expect(entry.inputs).toEqual({ adx: 31.234567, atr: 500.5 });
    store.close();
  });
});

// ─────────────────────────────────────────────────────────────── rationale

describe('rationale (guardrail 4)', () => {
  it('falls back to the template when no model is configured', async () => {
    const result = await generateRationale(signal());
    expect(result.source).toBe('template');
    expect(result.text.length).toBeGreaterThan(80);
  });

  it('FALLS BACK CLEANLY when the model is unavailable', async () => {
    const result = await generateRationale(signal(), {
      complete: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    expect(result.source).toBe('template');
    expect(result.fallbackReason).toContain('model unavailable');
    expect(result.text).toContain('perpetuals');
  });

  it('falls back when the model returns garbage', async () => {
    const result = await generateRationale(signal(), { complete: async () => 'I am not JSON' });
    expect(result.source).toBe('template');
    expect(result.fallbackReason).toBe('unparseable model response');
  });

  it('accepts clean prose from the model', async () => {
    const result = await generateRationale(signal(), {
      complete: async () =>
        JSON.stringify({
          rationale:
            'The shorter moving average crossed above the longer one while the trend filter agreed, ' +
            'and the classifier reads the market as trending upward.',
        }),
    });
    expect(result.source).toBe('model');
    expect(result.text).toContain('moving average');
  });

  it('REJECTS a model response that introduces a number', async () => {
    const result = await generateRationale(signal(), {
      complete: async () =>
        JSON.stringify({ rationale: 'Strong setup — we expect price to reach 71234 within the day.' }),
    });
    expect(result.source).toBe('template');
    expect(result.fallbackReason).toContain('introduced a number');
  });

  it('detects a foreign number but allows the signal\'s own', () => {
    const s = signal();
    expect(containsForeignNumber('ADX read 31.2 at the time.', s)).toBe(false);
    expect(containsForeignNumber('Two of three conditions aligned.', s)).toBe(false);
    expect(containsForeignNumber('Target is 99999.', s)).toBe(true);
  });

  it('NO MODEL OUTPUT REACHES THE SIGNAL OBJECT', async () => {
    const store = new FeedStore();
    const original = signal();
    const snapshot = JSON.stringify(original);

    await publishThenExecute(original, {
      store,
      now: NOW,
      rationale: async (s) => {
        // The signal handed to rationale generation is frozen.
        expect(Object.isFrozen(s)).toBe(true);
        return 'model prose here';
      },
      execute: async () => undefined,
    });

    // The signal is byte-identical afterwards; the rationale lives only on the feed entry.
    expect(JSON.stringify(original)).toBe(snapshot);
    expect(store.get(original.id)?.rationale).toBe('model prose here');
    store.close();
  });

  it('the template names the strategy that actually fired', () => {
    expect(templateRationale(signal({ strategyId: 'vol_expansion' }))).toContain('compressed');
    expect(templateRationale(signal({ strategyId: 'revert_band' }))).toContain('range');
  });
});

// ─────────────────────────────────────────────────────────────── subscription

describe('the subscription service', () => {
  it('is exactly one service with subscription billing and a free trial', () => {
    expect(ASP_PACKAGE.subscriptionServiceCount).toBe(1);
    expect(PLUMB_SERVICE.billing).toBe('subscription');
    expect(PLUMB_SERVICE.priceUsdtPerMonth).toBeGreaterThan(0);
    expect(PLUMB_SERVICE.freeTrialDays).toBe(3);
  });

  it('REFUSES deletion, always', () => {
    expect(() => refuseDeletion('cleaning up')).toThrow(SubscriptionDeletionRefused);
    expect(() => refuseDeletion()).toThrow(/forfeits eligibility/);
  });

  it('exposes no delete function at all', () => {
    const surface = readFileSync(join(SRC, 'subscription.ts'), 'utf8');
    expect(surface).not.toMatch(/export function deleteService/);
    expect(surface).not.toMatch(/operation:\s*['"]delete['"]/);
  });

  it('carries a signal example and the ordered pre-subscription confirmations', () => {
    // Both are required by the current A2A subscription docs — a subscriber's agent parses them.
    expect(PLUMB_SERVICE.serviceDescription).toContain('[Perpetual Signal]');
    expect(PLUMB_SERVICE.serviceDescription).toContain('Before subscribing, confirm in order:');
    expect(PLUMB_SERVICE.serviceDescription).toContain('Agent Trade Kit');
  });

  it('formats a signal in the documented wire shape', () => {
    const store = new FeedStore();
    const entry = store.publish(signal(), 'because the trend agreed', NOW).entry;
    const body = formatSignalForDelivery(entry);
    expect(body).toContain('[Perpetual Signal] BTC-USDT-SWAP | LONG');
    expect(body).toContain('stop');
    expect(body).toContain('Why: because the trend agreed');
    expect(body).toContain('/signals/SIG-abcdefghij');
    store.close();
  });

  it('delivers only to ACTIVE subscribers', () => {
    const store = new FeedStore();
    const entry = store.publish(signal(), 'r', NOW).entry;
    const subs = [
      { id: 'active', subscribedAt: NOW - 1000, expiresAt: NOW + 86_400_000, trial: false },
      { id: 'expired', subscribedAt: NOW - 100_000, expiresAt: NOW - 1, trial: true },
      { id: 'future', subscribedAt: NOW + 5000, expiresAt: NOW + 86_400_000, trial: false },
    ];
    expect(activeSubscribers(subs, NOW).map((s) => s.id)).toEqual(['active']);
    expect(planDelivery(entry, subs, NOW).recipients).toEqual(['active']);
    store.close();
  });
});

// ─────────────────────────────────────────────────────────────── track record

describe('the track record is computed, never written', () => {
  it('matches a HAND-COMPUTED fixture ledger exactly', () => {
    const store = new FeedStore();
    // 3 wins of +6, 2 losses of -4  →  net +10, win rate 60%, PF 18/8 = 2.25
    store.recordOutcome(outcome('SIG-1', 6, NOW + 1));
    store.recordOutcome(outcome('SIG-2', -4, NOW + 2));
    store.recordOutcome(outcome('SIG-3', 6, NOW + 3));
    store.recordOutcome(outcome('SIG-4', -4, NOW + 4));
    store.recordOutcome(outcome('SIG-5', 6, NOW + 5));

    const record = buildTrackRecord(store, NOW + 10);
    expect(record.closedTrades).toBe(5);
    expect(record.wins).toBe(3);
    expect(record.losses).toBe(2);
    expect(record.winRatePct).toBeCloseTo(60, 10);
    expect(record.netPnlUsdt).toBeCloseTo(10, 10);
    expect(record.currentEquityUsdt).toBeCloseTo(410, 10);
    expect(record.averageWinUsdt).toBeCloseTo(6, 10);
    expect(record.averageLossUsdt).toBeCloseTo(-4, 10);
    expect(record.profitFactor).toBeCloseTo(18 / 8, 10);
    // equity: 406, 402, 408, 404, 410. Two drawdowns of 4 USDT, but from different peaks —
    // 406→402 is 0.985% and 408→404 is 0.980%, so the FIRST is the max. The percentage, not the
    // absolute, is what decides.
    expect(record.maxDrawdownPct).toBeCloseTo((4 / 406) * 100, 8);
    expect(record.distanceToKillSwitchUsdt).toBeCloseTo(410 - 335, 10);
    expect(record.longestLosingStreak).toBe(1);
    store.close();
  });

  it('reports an UNDEFINED profit factor as null, not Infinity', () => {
    const store = new FeedStore();
    store.recordOutcome(outcome('SIG-1', 5, NOW + 1));
    expect(buildTrackRecord(store, NOW).profitFactor).toBeNull();
    store.close();
  });

  it('warns bluntly on a small sample', () => {
    const store = new FeedStore();
    expect(buildTrackRecord(store, NOW).caveat).toContain('No trades have closed yet');
    store.recordOutcome(outcome('SIG-1', 5, NOW + 1));
    expect(buildTrackRecord(store, NOW).caveat).toContain('NOT a sample');
    store.close();
  });

  it('shows losses — a losing ledger produces a losing record', () => {
    const store = new FeedStore();
    for (let i = 0; i < 5; i += 1) store.recordOutcome(outcome(`SIG-${i}`, -4, NOW + i));
    const record = buildTrackRecord(store, NOW);
    expect(record.netPnlUsdt).toBeCloseTo(-20, 10);
    expect(record.winRatePct).toBe(0);
    expect(record.longestLosingStreak).toBe(5);
    expect(record.currentEquityUsdt).toBeCloseTo(380, 10);
    store.close();
  });
});

const SRC = fileURLToPath(new URL('./', import.meta.url));

describe('NO HAND-WRITTEN PERFORMANCE NUMBERS (source scan)', () => {
  it('the track record declares itself computed', () => {
    expect(ASP_PACKAGE.trackRecordIsComputed).toBe(true);
  });

  const PERF_FIELD = '(?:winRate|winRatePct|netPnl|netPnlUsdt|totalReturn|profitFactor|maxDrawdown|maxDrawdownPct|currentDrawdownPct|averageWin|averageLoss)\\w*';
  // A performance field assigned a LITERAL is the failure mode. An accumulator declared at zero
  // (`let maxDrawdownPct = 0`) is not — it is about to be computed.
  const handWritten = new RegExp(`(?<!let |const |var )\\b${PERF_FIELD}\\s*[:=]\\s*-?\\d`, 'g');

  it('the scan catches a planted violation — it is not vacuous', () => {
    expect('return { winRatePct: 62.5 };'.match(handWritten)).not.toBeNull();
    expect('const record = { netPnlUsdt: 1234 };'.match(handWritten)).not.toBeNull();
    // ...and does not fire on a legitimate accumulator.
    expect('let maxDrawdownPct = 0;'.match(handWritten)).toBeNull();
  });

  it('contains no hard-coded win rate, PnL or return figure', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(SRC).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
      const source = readFileSync(join(SRC, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
      for (const match of source.matchAll(handWritten)) offenders.push(`${file}: ${match[0]}`);
    }
    expect(offenders).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────── tools

describe('MCP tools', () => {
  const store = new FeedStore();
  store.publish(signal(), 'because the trend agreed', NOW);
  store.recordOutcome(outcome('SIG-abcdefghij', 6, NOW + 1));
  const context = { store, now: () => NOW + 10 };

  it('lists EXACTLY the expected names, all free', () => {
    expect([...TOOL_NAMES]).toEqual([
      'plumb_recent_signals',
      'plumb_track_record',
      'plumb_signal_detail',
      'plumb_risk_disclosure',
    ]);
  });

  it('returns recent signals', () => {
    const result = callTool('plumb_recent_signals', { limit: 5 }, context);
    expect(result.ok).toBe(true);
    expect((result.data as { signals: unknown[] }).signals).toHaveLength(1);
  });

  it('returns the track record', () => {
    const result = callTool('plumb_track_record', {}, context);
    expect((result.data as { closedTrades: number }).closedTrades).toBe(1);
  });

  it('returns one signal, and refuses a missing id cleanly', () => {
    expect(callTool('plumb_signal_detail', { id: 'SIG-abcdefghij' }, context).ok).toBe(true);
    const missing = callTool('plumb_signal_detail', { id: 'SIG-nope' }, context);
    expect(missing.ok).toBe(false);
    expect((missing.data as { error: string }).error).toBe('not_found');
    const noId = callTool('plumb_signal_detail', {}, context);
    expect((noId.data as { example: unknown }).example).toBeDefined();
  });

  it('publishes the risk parameters verbatim from the constants', () => {
    const data = callTool('plumb_risk_disclosure', {}, context).data as Record<string, unknown>;
    expect(data['perTradeRiskUsdt']).toBe(4);
    expect(data['leverageCeiling']).toBe(3);
    expect(data['killSwitchEquityUsdt']).toBe(335);
    expect(data['averagingDown']).toContain('prohibited');
  });

  it('refuses an unknown tool with the available list', () => {
    const result = callTool('plumb_drain_wallet', {}, context);
    expect(result.ok).toBe(false);
    expect((result.data as { available: string[] }).available).toHaveLength(4);
  });
});

// ─────────────────────────────────────────────────────────────── HTTP

describe('the HTTP surface', () => {
  const store = new FeedStore();
  store.publish(signal(), 'because the trend agreed', NOW);
  store.recordOutcome(outcome('SIG-abcdefghij', 6, NOW + 1));

  const app = createApp({
    store,
    version: '0.9.0',
    mode: 'fake',
    startedAt: NOW - 60_000,
    now: () => NOW,
    status: () => ({ lastCycleAt: NOW - 5_000, haltFlags: { killSwitch: false } }),
    rateLimit: { windowMs: 60_000, max: 10_000 },
  });

  let server: Server;
  let base = '';
  const start = async (): Promise<void> => {
    if (base !== '') return;
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    base = typeof address === 'object' && address !== null ? `http://127.0.0.1:${address.port}` : '';
  };

  afterAll(async () => {
    if (server !== undefined) await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });

  it('/health answers in well under 100ms with no model or venue call', async () => {
    await start();
    const began = Date.now();
    const response = await fetch(`${base}/health`);
    const elapsed = Date.now() - began;
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(elapsed).toBeLessThan(100);
    expect(body['ok']).toBe(true);
    expect(body['mode']).toBe('fake');
    expect(body['haltFlags']).toEqual({ killSwitch: false });
  });

  it('serves the manifest with published risk parameters', async () => {
    await start();
    const body = (await (await fetch(`${base}/.well-known/plumb.json`)).json()) as Record<string, Record<string, unknown>>;
    expect(body['riskParameters']?.['killSwitchEquityUsdt']).toBe(335);
    expect(body['service']?.['billing']).toBe('subscription');
    expect(body['feed']?.['published']).toBe(1);
  });

  it('serves the public feed and one signal', async () => {
    await start();
    const recent = (await (await fetch(`${base}/signals/recent`)).json()) as { signals: Array<{ id: string }> };
    expect(recent.signals[0]?.id).toBe('SIG-abcdefghij');

    const one = (await (await fetch(`${base}/signals/SIG-abcdefghij`)).json()) as { rationale: string };
    expect(one.rationale).toBe('because the trend agreed');

    expect((await fetch(`${base}/signals/SIG-missing`)).status).toBe(404);
  });

  it('serves the track record', async () => {
    await start();
    const body = (await (await fetch(`${base}/track-record`)).json()) as Record<string, unknown>;
    expect(body['closedTrades']).toBe(1);
    expect(body['caveat']).toContain('NOT a sample');
  });

  it('lets anyone verify the chain', async () => {
    await start();
    const body = (await (await fetch(`${base}/feed/verify`)).json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('LEAKS NO SECRET OR RAW ERROR in any response body', async () => {
    await start();
    const secrets = ['sk-ant-', 'sk-proj-', 'OKX_API', 'passphrase', 'Francisco@', 'secret', 'Bearer '];
    for (const path of ['/health', '/.well-known/plumb.json', '/signals/recent', '/track-record', '/feed/verify', '/nope']) {
      const text = await (await fetch(`${base}${path}`)).text();
      for (const needle of secrets) expect(text.toLowerCase()).not.toContain(needle.toLowerCase());
      expect(text).not.toContain('    at '); // no stack frames
      expect(text).not.toContain('node_modules');
    }
  });

  it('returns a sanitised 404 for an unknown endpoint', async () => {
    await start();
    const response = await fetch(`${base}/definitely-not-a-route`);
    expect(response.status).toBe(404);
    expect((await response.json()) as Record<string, string>).toEqual({
      error: 'not_found',
      message: 'no such endpoint',
    });
  });

  it('rate-limits', async () => {
    const limited = createApp({
      store,
      version: '0.9.0',
      mode: 'fake',
      startedAt: NOW,
      now: () => NOW,
      rateLimit: { windowMs: 60_000, max: 2 },
    });
    const s = createServer(limited);
    await new Promise<void>((resolve) => s.listen(0, resolve));
    const address = s.address();
    const url = typeof address === 'object' && address !== null ? `http://127.0.0.1:${address.port}/health` : '';

    await fetch(url);
    await fetch(url);
    expect((await fetch(url)).status).toBe(429);
    await new Promise<void>((r) => s.close(() => r()));
  });
});
