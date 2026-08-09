import { isInstrument, type Instrument } from '@plumb/core';

import {
  OkxApiError,
  OkxHttpError,
  OkxNetworkError,
  OkxParseError,
  OkxTimeoutError,
  UnsupportedInstrumentError,
} from './errors.js';
import type {
  Candle,
  FundingRate,
  FundingRateHistoryEntry,
  IndexTicker,
  MarkPrice,
  OiPeriod,
  OpenInterest,
  OpenInterestHistoryEntry,
  PriceLimit,
  Ticker,
  Timeframe,
} from './types.js';

export const OKX_PUBLIC_BASE_URL = 'https://www.okx.com';

/**
 * OKX business codes that mean "try again", as opposed to "you asked for the wrong thing".
 * Retrying a 51000-class parameter error would just be a slower failure.
 */
const RETRYABLE_OKX_CODES = new Set(['50011', '50013', '50026', '50004']);

/** Max rows OKX returns per candle request. Verified live 2026-08-09: 300 is accepted. */
export const MAX_CANDLE_PAGE = 300;

export type FetchLike = (
  url: string,
  init?: { readonly signal?: AbortSignal },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}>;

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = Object.freeze({
  maxAttempts: 4,
  baseDelayMs: 400,
  maxDelayMs: 8_000,
});

export interface OkxPublicClientOptions {
  readonly baseUrl?: string;
  readonly fetch?: FetchLike;
  /** Per-attempt budget. The whole call may take longer across retries. */
  readonly timeoutMs?: number;
  readonly retry?: Partial<RetryPolicy>;
  /**
   * Minimum gap between the START of two requests. OKX publishes per-endpoint limits in the
   * 20-per-2s range; 125ms (8/s) sits comfortably under all of them. Requests are serialised
   * through one gate, so this is a hard floor and not a best effort.
   */
  readonly minIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injected for tests, so backoff jitter is deterministic. */
  readonly random?: () => number;
  readonly now?: () => number;
}

interface OkxEnvelope {
  readonly code?: unknown;
  readonly msg?: unknown;
  readonly data?: unknown;
}

type Params = Readonly<Record<string, string | number | undefined>>;

function assertInstrument(instId: string): asserts instId is Instrument {
  if (!isInstrument(instId)) throw new UnsupportedInstrumentError(instId);
}

/** `BTC-USDT-SWAP` → `BTC-USD`. The index is quoted against USD, not the swap's instId. */
export function indexInstIdFor(instId: Instrument): string {
  const base = instId.split('-')[0];
  return `${base ?? ''}-USD`;
}

function num(path: string, field: string, raw: unknown): number {
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) throw new OkxParseError(path, field, raw);
  return value;
}

/** OKX returns `""` for a rate that does not exist yet, which `Number("")` turns into 0. */
function optionalNum(raw: unknown): number | undefined {
  if (raw === '' || raw === null || raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Read-only client for OKX's PUBLIC market endpoints.
 *
 * **No credential ever reaches this class.** Every endpoint it calls is unauthenticated, which
 * is why market data can be built and exercised long before any API key exists.
 *
 * Three behaviours are deliberate:
 *  - Requests are **serialised behind a rate gate**, so concurrency cannot burst past the limit.
 *  - Retries use **exponential backoff with full jitter**, and only for genuinely transient
 *    failures — a bad parameter fails immediately rather than four times slowly.
 *  - Every instId is checked against the locked set before the request is built.
 */
export class OkxPublicClient {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;
  private readonly retry: RetryPolicy;
  private readonly minIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;

  private gate: Promise<unknown> = Promise.resolve();
  private lastStart = Number.NEGATIVE_INFINITY;

  /** Observability: how many attempts and how many of them were retries. */
  readonly stats = { attempts: 0, retries: 0, requests: 0 };

  constructor(options: OkxPublicClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? OKX_PUBLIC_BASE_URL;
    this.fetchFn = options.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.retry = { ...DEFAULT_RETRY, ...options.retry };
    this.minIntervalMs = options.minIntervalMs ?? 125;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
  }

  // ---------------------------------------------------------------- endpoints

  async ticker(instId: string): Promise<Ticker> {
    assertInstrument(instId);
    const path = '/api/v5/market/ticker';
    const row = await this.one(path, { instId });
    return Object.freeze({
      instId,
      last: num(path, 'last', row['last']),
      askPx: num(path, 'askPx', row['askPx']),
      bidPx: num(path, 'bidPx', row['bidPx']),
      open24h: num(path, 'open24h', row['open24h']),
      high24h: num(path, 'high24h', row['high24h']),
      low24h: num(path, 'low24h', row['low24h']),
      vol24h: num(path, 'vol24h', row['vol24h']),
      ts: num(path, 'ts', row['ts']),
    });
  }

  /**
   * Recent candles, **oldest-first**.
   *
   * OKX returns candles newest-first. Every indicator in this package — and every reasonable
   * reading of a price series — assumes chronological order, so the order is normalised HERE,
   * once, at the boundary. Reversing a price series does not throw; it silently produces
   * plausible, confidently wrong numbers, which is the worst failure mode available. It is not
   * left to each caller to remember.
   *
   * The still-forming bar (`closed: false`), when present, is therefore the LAST row.
   */
  async candles(
    instId: string,
    bar: Timeframe,
    options: { readonly limit?: number; readonly after?: number; readonly before?: number } = {},
  ): Promise<readonly Candle[]> {
    return this.fetchCandles('/api/v5/market/candles', instId, bar, options);
  }

  /**
   * Older candles, **oldest-first** (see {@link candles}). This is the endpoint that paginates
   * back through history.
   *
   * **`after` means OLDER, not newer.** `after: t` returns bars strictly before `t`, newest
   * first. Verified live 2026-08-09. Getting this backwards produces an infinite loop that
   * refetches page one forever.
   */
  async historyCandles(
    instId: string,
    bar: Timeframe,
    options: { readonly limit?: number; readonly after?: number; readonly before?: number } = {},
  ): Promise<readonly Candle[]> {
    return this.fetchCandles('/api/v5/market/history-candles', instId, bar, options);
  }

  async markPrice(instId: string): Promise<MarkPrice> {
    assertInstrument(instId);
    const path = '/api/v5/public/mark-price';
    const row = await this.one(path, { instType: 'SWAP', instId });
    return Object.freeze({
      instId,
      markPx: num(path, 'markPx', row['markPx']),
      ts: num(path, 'ts', row['ts']),
    });
  }

  async indexTicker(instId: string): Promise<IndexTicker> {
    assertInstrument(instId);
    const path = '/api/v5/market/index-tickers';
    const indexInstId = indexInstIdFor(instId);
    const row = await this.one(path, { instId: indexInstId });
    return Object.freeze({
      instId: indexInstId,
      idxPx: num(path, 'idxPx', row['idxPx']),
      high24h: num(path, 'high24h', row['high24h']),
      low24h: num(path, 'low24h', row['low24h']),
      open24h: num(path, 'open24h', row['open24h']),
      ts: num(path, 'ts', row['ts']),
    });
  }

  async fundingRate(instId: string): Promise<FundingRate> {
    assertInstrument(instId);
    const path = '/api/v5/public/funding-rate';
    const row = await this.one(path, { instId });
    return Object.freeze({
      instId,
      fundingRate: num(path, 'fundingRate', row['fundingRate']),
      fundingTime: num(path, 'fundingTime', row['fundingTime']),
      nextFundingRate: optionalNum(row['nextFundingRate']),
      nextFundingTime: num(path, 'nextFundingTime', row['nextFundingTime']),
      prevFundingTime: num(path, 'prevFundingTime', row['prevFundingTime']),
      minFundingRate: num(path, 'minFundingRate', row['minFundingRate']),
      maxFundingRate: num(path, 'maxFundingRate', row['maxFundingRate']),
      ts: num(path, 'ts', row['ts']),
    });
  }

  async fundingRateHistory(
    instId: string,
    options: { readonly limit?: number; readonly after?: number } = {},
  ): Promise<readonly FundingRateHistoryEntry[]> {
    assertInstrument(instId);
    const path = '/api/v5/public/funding-rate-history';
    const rows = await this.many(path, {
      instId,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.after === undefined ? {} : { after: options.after }),
    });
    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          instId,
          fundingRate: num(path, 'fundingRate', row['fundingRate']),
          realizedRate: num(path, 'realizedRate', row['realizedRate']),
          fundingTime: num(path, 'fundingTime', row['fundingTime']),
        }),
      ),
    );
  }

  async openInterest(instId: string): Promise<OpenInterest> {
    assertInstrument(instId);
    const path = '/api/v5/public/open-interest';
    const row = await this.one(path, { instType: 'SWAP', instId });
    return Object.freeze({
      instId,
      oi: num(path, 'oi', row['oi']),
      oiCcy: num(path, 'oiCcy', row['oiCcy']),
      oiUsd: num(path, 'oiUsd', row['oiUsd']),
      ts: num(path, 'ts', row['ts']),
    });
  }

  /** Open-interest history. This endpoint returns positional arrays, not objects. */
  async openInterestHistory(
    instId: string,
    period: OiPeriod = '1H',
    options: { readonly limit?: number } = {},
  ): Promise<readonly OpenInterestHistoryEntry[]> {
    assertInstrument(instId);
    const path = '/api/v5/rubik/stat/contracts/open-interest-history';
    const rows = await this.manyRows(path, {
      instId,
      period,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          ts: num(path, 'ts', row[0]),
          oi: num(path, 'oi', row[1]),
          oiCcy: num(path, 'oiCcy', row[2]),
          oiUsd: num(path, 'oiUsd', row[3]),
        }),
      ),
    );
  }

  async priceLimit(instId: string): Promise<PriceLimit> {
    assertInstrument(instId);
    const path = '/api/v5/public/price-limit';
    const row = await this.one(path, { instId });
    return Object.freeze({
      instId,
      buyLmt: num(path, 'buyLmt', row['buyLmt']),
      sellLmt: num(path, 'sellLmt', row['sellLmt']),
      enabled: row['enabled'] === true || row['enabled'] === 'true',
      ts: num(path, 'ts', row['ts']),
    });
  }

  // ----------------------------------------------------------------- internals

  private async fetchCandles(
    path: string,
    instId: string,
    bar: Timeframe,
    options: { readonly limit?: number; readonly after?: number; readonly before?: number },
  ): Promise<readonly Candle[]> {
    assertInstrument(instId);
    const rows = await this.manyRows(path, {
      instId,
      bar,
      ...(options.limit === undefined ? {} : { limit: Math.min(options.limit, MAX_CANDLE_PAGE) }),
      ...(options.after === undefined ? {} : { after: options.after }),
      ...(options.before === undefined ? {} : { before: options.before }),
    });
    const parsed = rows.map((row) => parseCandle(path, row));
    // OKX sends newest-first. Normalise once, here, so nothing downstream can read it backwards.
    parsed.sort((a, b) => a.ts - b.ts);
    return Object.freeze(parsed);
  }

  private async one(path: string, params: Params): Promise<Record<string, unknown>> {
    const rows = await this.many(path, params);
    const first = rows[0];
    if (first === undefined) throw new OkxParseError(path, 'data[0]', rows);
    return first;
  }

  private async many(path: string, params: Params): Promise<readonly Record<string, unknown>[]> {
    const data = await this.request(path, params);
    return data.map((row, index) => {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) {
        throw new OkxParseError(path, `data[${index}]`, row);
      }
      return row as Record<string, unknown>;
    });
  }

  private async manyRows(path: string, params: Params): Promise<readonly unknown[][]> {
    const data = await this.request(path, params);
    return data.map((row, index) => {
      if (!Array.isArray(row)) throw new OkxParseError(path, `data[${index}]`, row);
      return row;
    });
  }

  private async request(path: string, params: Params): Promise<readonly unknown[]> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const href = url.toString();
    this.stats.requests += 1;

    let lastError: unknown;
    for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt += 1) {
      if (attempt > 1) {
        this.stats.retries += 1;
        await this.sleep(this.backoffDelay(attempt));
      }
      await this.rateGate();
      this.stats.attempts += 1;
      try {
        return await this.attempt(path, href);
      } catch (error) {
        lastError = error;
        if (!isRetryable(error) || attempt === this.retry.maxAttempts) throw error;
      }
    }
    /* c8 ignore next */
    throw lastError;
  }

  private async attempt(path: string, href: string): Promise<readonly unknown[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.fetchFn(href, { signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw new OkxTimeoutError(path, this.timeoutMs);
      throw new OkxNetworkError(path, error);
    } finally {
      clearTimeout(timer);
    }

    const body = await response.text();
    if (!response.ok) throw new OkxHttpError(response.status, path, body.slice(0, 400));

    let envelope: OkxEnvelope;
    try {
      envelope = JSON.parse(body) as OkxEnvelope;
    } catch {
      throw new OkxParseError(path, 'body', body.slice(0, 200));
    }

    const code = String(envelope.code ?? '');
    if (code !== '0') throw new OkxApiError(code, String(envelope.msg ?? ''), path);
    if (!Array.isArray(envelope.data)) throw new OkxParseError(path, 'data', envelope.data);
    return envelope.data;
  }

  /** Exponential backoff with full jitter: `random() * min(max, base * 2^(n-1))`. */
  private backoffDelay(attempt: number): number {
    const ceiling = Math.min(
      this.retry.maxDelayMs,
      this.retry.baseDelayMs * 2 ** (attempt - 2 < 0 ? 0 : attempt - 2),
    );
    return Math.round(ceiling * this.random());
  }

  /** Serialises every request and enforces the minimum inter-request gap. */
  private async rateGate(): Promise<void> {
    const turn = this.gate.then(async () => {
      const wait = this.lastStart + this.minIntervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastStart = this.now();
    });
    this.gate = turn.catch(() => undefined);
    return turn;
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof OkxTimeoutError || error instanceof OkxNetworkError) return true;
  if (error instanceof OkxHttpError) return error.status === 429 || error.status >= 500;
  if (error instanceof OkxApiError) return RETRYABLE_OKX_CODES.has(error.code);
  return false;
}

/**
 * OKX candle rows are positional:
 * `[ts, open, high, low, close, vol, volCcy, volCcyQuote, confirm]`.
 */
export function parseCandle(path: string, row: readonly unknown[]): Candle {
  if (row.length < 9) throw new OkxParseError(path, 'candle', row);
  return Object.freeze({
    ts: num(path, 'candle.ts', row[0]),
    open: num(path, 'candle.open', row[1]),
    high: num(path, 'candle.high', row[2]),
    low: num(path, 'candle.low', row[3]),
    close: num(path, 'candle.close', row[4]),
    volume: num(path, 'candle.volume', row[5]),
    volumeCcy: num(path, 'candle.volumeCcy', row[6]),
    volumeQuote: num(path, 'candle.volumeQuote', row[7]),
    closed: String(row[8]) === '1',
  });
}
