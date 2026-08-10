/**
 * The OKX Agent Trade Kit wrapper.
 *
 * **DEMO MODE ONLY in this phase.** `--demo` is passed on every invocation and `assertDemo()`
 * refuses to construct a live client without an explicit, separate opt-in that P5 never uses.
 * Live credentials are not touched until P9 (guardrail 10).
 *
 * Interface re-verified against the Trade Kit docs on 2026-08-09: `okx swap place` supports
 * `--clOrdId` and attached stop-loss via `--slTriggerPx` / `--slOrdPx`, and demo mode requires a
 * SEPARATE demo API key (okx.com/account/my-api?go-demo-trading=1).
 */

import type { Instrument } from '@plumb/core';

export type AtkErrorKind =
  /** The call never completed — safe to retry. */
  | 'timeout'
  | 'transport'
  /** The venue answered and said no. NEVER retried blindly. */
  | 'rejected'
  | 'not_found'
  | 'auth'
  | 'malformed';

export class AtkError extends Error {
  constructor(
    readonly kind: AtkErrorKind,
    message: string,
    readonly detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'AtkError';
  }

  /**
   * Only failures that might not have reached the venue are retryable.
   *
   * A REJECTION is a decision, not an accident: retrying it blindly either does nothing or, worse,
   * succeeds the second time and opens a position nobody expected.
   */
  get retryable(): boolean {
    return this.kind === 'timeout' || this.kind === 'transport';
  }
}

export interface PlaceOrderRequest {
  readonly instId: Instrument;
  readonly side: 'buy' | 'sell';
  readonly posSide: 'long' | 'short';
  readonly ordType: 'market' | 'limit';
  /** Contracts. */
  readonly sz: number;
  readonly px?: number;
  readonly tdMode?: 'cross' | 'isolated';
  /** Idempotency key — the signal id, sanitised. See `clord.ts`. */
  readonly clOrdId: string;
  readonly reduceOnly?: boolean;
  /** Attached stop-loss, so the bracket is atomic where the venue allows it. */
  readonly slTriggerPx?: number;
  /** `-1` means "market order when triggered". */
  readonly slOrdPx?: number;
}

export interface OrderRef {
  readonly ordId: string;
  readonly clOrdId: string;
  readonly instId: string;
}

export interface VenueOrder {
  readonly ordId: string;
  readonly clOrdId: string;
  readonly instId: string;
  readonly state: 'live' | 'filled' | 'canceled' | 'partially_filled';
  readonly side: 'buy' | 'sell';
  readonly sz: number;
  readonly avgPx: number;
  readonly ts: number;
  readonly slTriggerPx?: number;
  /** The linked algo order carrying an ATTACHED stop, when the venue reports one. */
  readonly attachAlgoId?: string;
}

export interface VenuePosition {
  readonly instId: string;
  readonly posSide: 'long' | 'short' | 'net';
  /** Signed in one-way mode; absolute in long/short mode. */
  readonly pos: number;
  readonly avgPx: number;
  readonly upl: number;
}

export interface VenueFill {
  readonly instId: string;
  readonly ordId: string;
  readonly clOrdId: string;
  readonly side: 'buy' | 'sell';
  readonly fillSz: number;
  readonly fillPx: number;
  readonly fee: number;
  readonly ts: number;
}

export interface VenueBalance {
  readonly ccy: string;
  readonly eq: number;
  readonly availEq: number;
}

/**
 * Everything the executor needs from the venue. Narrow on purpose: the mock implements exactly
 * this, so the fault-injection tests exercise the real code paths rather than a parallel one.
 */
export interface AtkClient {
  readonly demo: boolean;
  placeOrder(request: PlaceOrderRequest): Promise<OrderRef>;
  cancelOrder(instId: string, ordId: string): Promise<void>;
  amendOrder(instId: string, ordId: string, changes: { sz?: number; px?: number }): Promise<void>;
  getOrder(instId: string, params: { ordId?: string; clOrdId?: string }): Promise<VenueOrder | undefined>;
  getOpenOrders(instId?: string): Promise<readonly VenueOrder[]>;
  getPositions(instId?: string): Promise<readonly VenuePosition[]>;
  getFills(instId?: string): Promise<readonly VenueFill[]>;
  getBalance(): Promise<readonly VenueBalance[]>;
  closePosition(instId: string, mgnMode?: 'cross' | 'isolated'): Promise<void>;
}

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 300,
  maxDelayMs: 4_000,
});

export interface CliClientOptions {
  /** Path to the `okx` binary. Default matches P1's install location. */
  readonly binPath?: string;
  readonly profile?: string;
  readonly timeoutMs?: number;
  readonly retry?: Partial<RetryPolicy>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  /**
   * MUST be true in P5. Constructing a non-demo client requires passing this explicitly false
   * AND setting `allowLive`, neither of which any code path in this phase does.
   */
  readonly demo?: boolean;
  readonly allowLive?: boolean;
  /** Injected so tests never spawn a process. */
  readonly exec?: (args: readonly string[], timeoutMs: number) => Promise<string>;
}

export const DEFAULT_BIN = '/root/.plumb/atk/node_modules/.bin/okx';

/**
 * Guardrail 10, enforced at construction.
 *
 * P5 is demo-only. A live client cannot be built by accident — it takes two deliberate flags,
 * and the executor never sets either.
 */
export function assertDemo(options: CliClientOptions): void {
  const demo = options.demo ?? true;
  if (!demo && options.allowLive !== true) {
    throw new AtkError(
      'auth',
      'refusing to construct a LIVE Agent Trade Kit client — P5 is demo-only and live ' +
        'credentials are not used until P9 (AGENTS.md guardrail 10)',
    );
  }
}

/** Retry with exponential backoff and full jitter — transient failures only. */
export async function withRetry<T>(
  operation: () => Promise<T>,
  policy: RetryPolicy,
  sleep: (ms: number) => Promise<void>,
  random: () => number,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const retryable = error instanceof AtkError && error.retryable;
      if (!retryable || attempt === policy.maxAttempts) throw error;
      const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
      await sleep(Math.round(ceiling * random()));
    }
  }
  /* c8 ignore next */
  throw lastError;
}

/** Map a CLI failure onto a kind, so the retry policy can tell a decision from an accident. */
export function classifyError(message: string, exitCode?: number): AtkErrorKind {
  const text = message.toLowerCase();
  if (text.includes('timed out') || text.includes('etimedout')) return 'timeout';
  if (text.includes('econnreset') || text.includes('enotfound') || text.includes('socket hang up')) {
    return 'transport';
  }
  if (text.includes('unauthor') || text.includes('api key') || text.includes('signature')) return 'auth';
  if (text.includes('not found') || text.includes('does not exist')) return 'not_found';
  if (text.includes('insufficient') || text.includes('rejected') || text.includes('invalid')) {
    return 'rejected';
  }
  return exitCode === undefined ? 'malformed' : 'rejected';
}
