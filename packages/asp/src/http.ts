/**
 * The public HTTP surface.
 *
 * Everything here is free and read-only. Free discovery is what drives subscriptions, and a public
 * track record only means something if anyone can fetch it without asking us for permission.
 *
 * Three rules hold across every route:
 *  - **`/health` never calls a model or the venue** and answers in single-digit milliseconds.
 *    A health check that can hang is not a health check.
 *  - **Errors are sanitised.** No provider strings, no stack traces, no key material — a response
 *    body is a public artifact.
 *  - **Bodies are capped and requests are rate-limited**, because this endpoint is on the open
 *    internet for fourteen days unattended.
 */

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { DERIVED, LOCKED } from '@plumb/core';

import type { FeedStore } from './feed.js';
import { PLUMB_SERVICE } from './subscription.js';
import { buildTrackRecord } from './track_record.js';

export interface ServerDeps {
  readonly store: FeedStore;
  readonly version: string;
  readonly mode: string;
  readonly startedAt: number;
  /** Injected clock. */
  readonly now: () => number;
  /** Read from the runner's persisted state — never a model or venue call. */
  readonly status?: () => { readonly lastCycleAt: number | undefined; readonly haltFlags: Readonly<Record<string, boolean>> };
  readonly rateLimit?: { readonly windowMs: number; readonly max: number };
}

const MAX_BODY_BYTES = 16 * 1024;

/** Fixed-window limiter. Small, dependency-free, and enough for a read-only public surface. */
function rateLimiter(windowMs: number, max: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    const entry = hits.get(key);
    if (entry === undefined || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }
    entry.count += 1;
    if (entry.count > max) {
      res.status(429).json({ error: 'rate_limited', message: 'too many requests' });
      return;
    }
    next();
  };
}

export function createApp(deps: ServerDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: MAX_BODY_BYTES }));

  const limit = deps.rateLimit ?? { windowMs: 60_000, max: 120 };
  app.use(rateLimiter(limit.windowMs, limit.max));

  // ── /health — no model, no venue, no database scan. ──────────────────────────────────────
  app.get('/health', (_req, res) => {
    const status = deps.status?.() ?? { lastCycleAt: undefined, haltFlags: {} };
    res.json({
      ok: true,
      version: deps.version,
      mode: deps.mode,
      uptimeSeconds: Math.floor((deps.now() - deps.startedAt) / 1000),
      lastCycleAt: status.lastCycleAt ?? null,
      haltFlags: status.haltFlags,
    });
  });

  // ── the service manifest ─────────────────────────────────────────────────────────────────
  app.get('/.well-known/plumb.json', (_req, res) => {
    res.json({
      name: 'Plumb',
      tagline: "Every signal, measured before it's sent.",
      version: deps.version,
      service: {
        name: PLUMB_SERVICE.serviceName,
        type: PLUMB_SERVICE.serviceType,
        billing: PLUMB_SERVICE.billing,
        priceUsdtPerMonth: PLUMB_SERVICE.priceUsdtPerMonth,
        freeTrialDays: PLUMB_SERVICE.freeTrialDays,
        endpoint: PLUMB_SERVICE.endpoint,
      },
      instruments: LOCKED.INSTRUMENTS,
      // Published verbatim from the constants. A risk parameter a subscriber cannot check is a
      // marketing claim.
      riskParameters: {
        startingCapitalUsdt: LOCKED.CAPITAL_USDT,
        perTradeRiskUsdt: LOCKED.PER_TRADE_RISK_USDT,
        perTradeRiskPct: DERIVED.perTradeRiskFraction * 100,
        leverageCeiling: LOCKED.LEVERAGE_CEILING,
        maxConcurrentPositions: LOCKED.MAX_CONCURRENT_POSITIONS,
        maxTotalNotionalUsdt: LOCKED.MAX_TOTAL_NOTIONAL_USDT,
        dailyLossLimitUsdt: LOCKED.DAILY_LOSS_LIMIT_USDT,
        killSwitchEquityUsdt: LOCKED.KILL_SWITCH_EQUITY_USDT,
        averagingDown: 'prohibited — there is no configuration value that enables it',
        accountingBasis: LOCKED.ACCOUNTING_BASIS,
      },
      feed: { chained: true, headHash: deps.store.headHash(), published: deps.store.count() },
      endpoints: ['/health', '/signals/recent', '/signals/:id', '/track-record', '/mcp'],
    });
  });

  // ── the public feed ──────────────────────────────────────────────────────────────────────
  app.get('/signals/recent', (req, res) => {
    const limitParam = Number(req.query['limit'] ?? 25);
    const count = Number.isFinite(limitParam) ? Math.min(Math.max(1, Math.floor(limitParam)), 200) : 25;
    res.json({ signals: deps.store.recent(count), headHash: deps.store.headHash() });
  });

  app.get('/signals/:id', (req, res) => {
    const id = String(req.params['id'] ?? '');
    const entry = deps.store.get(id);
    if (entry === undefined) {
      res.status(404).json({ error: 'not_found', message: 'no published signal with that id' });
      return;
    }
    res.json(entry);
  });

  // ── the track record — computed, never written ───────────────────────────────────────────
  app.get('/track-record', (_req, res) => {
    res.json(buildTrackRecord(deps.store, deps.now()));
  });

  // ── the chain, so anyone can verify the record has not been edited ───────────────────────
  app.get('/feed/verify', (_req, res) => {
    res.json(deps.store.verifyChain());
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found', message: 'no such endpoint' });
  });

  // Sanitised error handler. A raw provider string or a stack trace in a public body is a leak.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const code = error instanceof SyntaxError ? 'bad_request' : 'internal_error';
    res.status(code === 'bad_request' ? 400 : 500).json({
      error: code,
      message: code === 'bad_request' ? 'malformed request body' : 'something went wrong',
    });
  });

  return app;
}
