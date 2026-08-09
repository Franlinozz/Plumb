/**
 * Recorded-market-data replay.
 *
 * `PLUMB_MODE=fake` (the default everywhere, including every test) serves market data from
 * `packages/market/fixtures/` — real OKX payloads recorded once by `scripts/record-fixtures.mjs`,
 * stored as raw `{code, msg, data}` envelopes.
 *
 * Serving the RAW envelope matters: it means the client's own parsing runs in tests, against
 * bytes the exchange actually sent, rather than against a hand-written object that agrees with
 * whatever the parser happens to do.
 *
 * The fixtures directory sits at the PACKAGE root, not under `src/`, so the same relative path
 * resolves from both `src/` (vitest) and `dist/` (runtime).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FetchLike } from './client.js';
import type { Candle, Timeframe } from './types.js';
import { parseCandle } from './client.js';

export const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url));

export interface FixtureMeta {
  readonly recordedAt: number;
  readonly recordedAtIso: string;
  readonly source: string;
  readonly instruments: readonly string[];
  readonly timeframes: readonly string[];
  readonly candleLimit: number;
  readonly inventory: ReadonlyArray<{
    readonly instId: string;
    readonly name: string;
    readonly rows: number;
  }>;
}

interface Envelope {
  readonly code: string;
  readonly msg: string;
  readonly data: unknown[];
}

const cache = new Map<string, Envelope>();

function read(relative: string): Envelope {
  const cached = cache.get(relative);
  if (cached !== undefined) return cached;
  const raw = readFileSync(join(FIXTURES_DIR, relative), 'utf8');
  const parsed = JSON.parse(raw) as Envelope;
  cache.set(relative, parsed);
  return parsed;
}

export function fixtureMeta(): FixtureMeta {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, 'meta.json'), 'utf8')) as FixtureMeta;
}

/** The raw recorded envelope for one endpoint, e.g. `('BTC-USDT-SWAP', 'ticker')`. */
export function fixtureEnvelope(instId: string, name: string): Envelope {
  return read(`${instId}/${name}.json`);
}

/** Recorded candles, parsed and sorted oldest-first (OKX records them newest-first). */
export function fixtureCandles(instId: string, tf: Timeframe): readonly Candle[] {
  const envelope = fixtureEnvelope(instId, `candles-${tf}`);
  const parsed = envelope.data.map((row) => parseCandle('fixture', row as unknown[]));
  return Object.freeze([...parsed].sort((a, b) => a.ts - b.ts));
}

/** `BTC-USD` → `BTC-USDT-SWAP`, so index requests find the right fixture directory. */
function instrumentForIndex(indexInstId: string): string {
  return `${indexInstId.split('-')[0] ?? ''}-USDT-SWAP`;
}

const ENDPOINT_FIXTURES: Readonly<Record<string, string>> = Object.freeze({
  '/api/v5/market/ticker': 'ticker',
  '/api/v5/public/mark-price': 'mark-price',
  '/api/v5/market/index-tickers': 'index-ticker',
  '/api/v5/public/funding-rate': 'funding-rate',
  '/api/v5/public/funding-rate-history': 'funding-rate-history',
  '/api/v5/public/open-interest': 'open-interest',
  '/api/v5/rubik/stat/contracts/open-interest-history': 'open-interest-history',
  '/api/v5/public/price-limit': 'price-limit',
});

const CANDLE_PATHS = new Set(['/api/v5/market/candles', '/api/v5/market/history-candles']);

export interface FixtureFetchOptions {
  /** Records every URL the client requested, in order. Lets tests assert on paging. */
  readonly calls?: string[];
}

/**
 * A {@link FetchLike} backed entirely by the recorded fixtures — zero network.
 *
 * Candle requests honour `limit` and `after` against the recorded series, so pagination can be
 * exercised for real: `after: t` returns bars strictly OLDER than `t`, newest-first, exactly as
 * OKX behaves (verified live 2026-08-09).
 */
export function fixtureFetch(options: FixtureFetchOptions = {}): FetchLike {
  return async (url) => {
    options.calls?.push(url);
    const parsed = new URL(url);
    const instId = parsed.searchParams.get('instId') ?? '';

    const respond = (body: unknown): Awaited<ReturnType<FetchLike>> => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
    });

    if (CANDLE_PATHS.has(parsed.pathname)) {
      const bar = (parsed.searchParams.get('bar') ?? '15m') as Timeframe;
      const limit = Number(parsed.searchParams.get('limit') ?? '100');
      const after = parsed.searchParams.get('after');
      const envelope = fixtureEnvelope(instId, `candles-${bar}`);

      // Recorded newest-first. `after` keeps only strictly older bars.
      let rows = envelope.data as unknown[][];
      if (after !== null) {
        const cutoff = Number(after);
        rows = rows.filter((row) => Number(row[0]) < cutoff);
      }
      return respond({ code: '0', msg: '', data: rows.slice(0, limit) });
    }

    const name = ENDPOINT_FIXTURES[parsed.pathname];
    if (name === undefined) {
      return { ok: false, status: 404, text: async () => `no fixture for ${parsed.pathname}` };
    }

    const dir = parsed.pathname === '/api/v5/market/index-tickers' ? instrumentForIndex(instId) : instId;
    return respond(fixtureEnvelope(dir, name));
  };
}
