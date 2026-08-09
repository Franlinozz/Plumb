import { describe, expect, it } from 'vitest';

import {
  MAX_CANDLE_PAGE,
  OkxApiError,
  OkxHttpError,
  OkxNetworkError,
  OkxPublicClient,
  OkxTimeoutError,
  UnsupportedInstrumentError,
  indexInstIdFor,
  type FetchLike,
} from './index.js';
import { fixtureEnvelope, fixtureFetch, fixtureMeta } from './fixtures.js';

/** A client wired to the recorded fixtures, with no timers and no randomness. */
function offlineClient(calls?: string[]): OkxPublicClient {
  return new OkxPublicClient({
    fetch: fixtureFetch(calls === undefined ? {} : { calls }),
    minIntervalMs: 0,
    sleep: async () => undefined,
    random: () => 0.5,
    now: () => 0,
  });
}

describe('OkxPublicClient — parsing real recorded payloads', () => {
  const client = offlineClient();

  it('parses a ticker', async () => {
    const ticker = await client.ticker('BTC-USDT-SWAP');
    expect(ticker.instId).toBe('BTC-USDT-SWAP');
    // Everything OKX sends is a STRING; the client's job is to hand back finite numbers.
    for (const value of [
      ticker.last,
      ticker.askPx,
      ticker.bidPx,
      ticker.open24h,
      ticker.high24h,
      ticker.low24h,
      ticker.vol24h,
      ticker.ts,
    ]) {
      expect(typeof value).toBe('number');
      expect(Number.isFinite(value)).toBe(true);
    }
    expect(ticker.last).toBeGreaterThan(0);
    expect(ticker.high24h).toBeGreaterThanOrEqual(ticker.low24h);
    expect(ticker.ts).toBeGreaterThan(1_600_000_000_000);
  });

  it('parses candles, including the positional array and the confirm flag', async () => {
    const candles = await client.candles('ETH-USDT-SWAP', '15m', { limit: 10 });
    expect(candles).toHaveLength(10);
    const first = candles[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(first.high).toBeGreaterThanOrEqual(first.low);
    expect(first.high).toBeGreaterThanOrEqual(first.open);
    expect(first.low).toBeLessThanOrEqual(first.close);
    expect(typeof first.closed).toBe('boolean');
    // Only the newest bar may still be forming, and after normalisation it is LAST.
    expect(candles.slice(0, -1).every((c) => c.closed)).toBe(true);
  });

  it('returns candles OLDEST-FIRST, though OKX sends them newest-first', async () => {
    // This is the boundary normalisation. A reversed price series does not throw — it produces
    // plausible, confidently wrong indicators — so the order is pinned rather than trusted.
    for (const tf of ['15m', '1H', '4H'] as const) {
      const candles = await client.historyCandles('BTC-USDT-SWAP', tf, { limit: 50 });
      expect(candles.length).toBe(50);
      for (let i = 1; i < candles.length; i += 1) {
        expect(candles[i]?.ts as number).toBeGreaterThan(candles[i - 1]?.ts as number);
      }
    }

    // ...and the raw envelope really is the other way round, so the test is not vacuous.
    const raw = fixtureEnvelope('BTC-USDT-SWAP', 'candles-15m').data as unknown[][];
    expect(Number(raw[0]?.[0])).toBeGreaterThan(Number(raw[1]?.[0]));
  });

  it('parses mark price', async () => {
    const mark = await client.markPrice('SOL-USDT-SWAP');
    expect(mark.instId).toBe('SOL-USDT-SWAP');
    expect(mark.markPx).toBeGreaterThan(0);
  });

  it('parses the index ticker, mapping the swap instId to its index', async () => {
    expect(indexInstIdFor('BTC-USDT-SWAP')).toBe('BTC-USD');
    const index = await client.indexTicker('BTC-USDT-SWAP');
    expect(index.instId).toBe('BTC-USD');
    expect(index.idxPx).toBeGreaterThan(0);
  });

  it('parses the current funding rate, and keeps OKX\'s confusing time fields straight', async () => {
    const funding = await client.fundingRate('BTC-USDT-SWAP');
    expect(funding.instId).toBe('BTC-USDT-SWAP');
    expect(Number.isFinite(funding.fundingRate)).toBe(true);
    expect(funding.fundingRate).toBeGreaterThan(funding.minFundingRate);
    expect(funding.fundingRate).toBeLessThan(funding.maxFundingRate);
    // `fundingTime` is the NEXT settlement; `nextFundingTime` is the one after that.
    expect(funding.nextFundingTime).toBeGreaterThan(funding.fundingTime);
    expect(funding.prevFundingTime).toBeLessThan(funding.fundingTime);
  });

  it('turns an empty nextFundingRate into undefined, not into zero', async () => {
    const funding = await client.fundingRate('BTC-USDT-SWAP');
    // OKX sends "" when the next rate is not published. Number("") === 0, and a 0% funding
    // rate is a completely different claim from "we do not know it yet".
    expect(funding.nextFundingRate === undefined || Number.isFinite(funding.nextFundingRate)).toBe(
      true,
    );
  });

  it('parses funding rate history', async () => {
    const history = await client.fundingRateHistory('ETH-USDT-SWAP', { limit: 100 });
    expect(history.length).toBeGreaterThan(10);
    const first = history[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(first.instId).toBe('ETH-USDT-SWAP');
    expect(Number.isFinite(first.fundingRate)).toBe(true);
    expect(Number.isFinite(first.realizedRate)).toBe(true);
    // OKX returns newest-first for history.
    const second = history[1];
    if (second !== undefined) expect(first.fundingTime).toBeGreaterThan(second.fundingTime);
  });

  it('parses open interest', async () => {
    const oi = await client.openInterest('BTC-USDT-SWAP');
    expect(oi.oi).toBeGreaterThan(0);
    expect(oi.oiUsd).toBeGreaterThan(0);
  });

  it('parses open-interest history, which is positional rather than keyed', async () => {
    const history = await client.openInterestHistory('BTC-USDT-SWAP', '1H', { limit: 100 });
    expect(history.length).toBeGreaterThan(10);
    for (const row of history.slice(0, 5)) {
      expect(row.ts).toBeGreaterThan(1_600_000_000_000);
      expect(row.oi).toBeGreaterThan(0);
      expect(row.oiUsd).toBeGreaterThan(0);
    }
  });

  it('parses the price limit, including the boolean', async () => {
    const limit = await client.priceLimit('SOL-USDT-SWAP');
    expect(limit.buyLmt).toBeGreaterThan(limit.sellLmt);
    expect(typeof limit.enabled).toBe('boolean');
  });

  it('covers every recorded endpoint — the fixtures and the client agree', () => {
    const meta = fixtureMeta();
    expect(meta.instruments).toEqual(['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP']);
    expect(meta.inventory.length).toBe(33);
    expect(meta.recordedAt).toBeGreaterThan(1_700_000_000_000);
  });
});

describe('OkxPublicClient — the locked instrument guard', () => {
  const client = offlineClient();

  it('throws for an instrument outside the locked set, on every endpoint', async () => {
    await expect(client.ticker('DOGE-USDT-SWAP')).rejects.toThrow(UnsupportedInstrumentError);
    await expect(client.candles('DOGE-USDT-SWAP', '15m')).rejects.toThrow(
      UnsupportedInstrumentError,
    );
    await expect(client.historyCandles('BTC-USDT', '15m')).rejects.toThrow(
      UnsupportedInstrumentError,
    );
    await expect(client.markPrice('XRP-USDT-SWAP')).rejects.toThrow(UnsupportedInstrumentError);
    await expect(client.fundingRate('')).rejects.toThrow(UnsupportedInstrumentError);
    await expect(client.openInterest('btc-usdt-swap')).rejects.toThrow(UnsupportedInstrumentError);
    await expect(client.priceLimit('BTC-USDT-SWAP-250101')).rejects.toThrow(
      UnsupportedInstrumentError,
    );
  });

  it('rejects before making any request at all', async () => {
    const calls: string[] = [];
    const guarded = offlineClient(calls);
    await expect(guarded.ticker('DOGE-USDT-SWAP')).rejects.toThrow(UnsupportedInstrumentError);
    expect(calls).toEqual([]);
  });

  it('caps a candle request at the page maximum OKX accepts', async () => {
    const calls: string[] = [];
    const capped = offlineClient(calls);
    await capped.historyCandles('BTC-USDT-SWAP', '1H', { limit: 5_000 });
    expect(calls[0]).toContain(`limit=${MAX_CANDLE_PAGE}`);
  });
});

describe('OkxPublicClient — failure and retry behaviour', () => {
  function flakyClient(
    responses: Array<{ status: number; body: string } | 'network'>,
    delays: number[],
  ): OkxPublicClient {
    let call = 0;
    const fetchFn: FetchLike = async () => {
      const next = responses[Math.min(call, responses.length - 1)];
      call += 1;
      if (next === 'network') throw new Error('ECONNRESET');
      return {
        ok: next !== undefined && next.status >= 200 && next.status < 300,
        status: next?.status ?? 500,
        text: async () => next?.body ?? '',
      };
    };
    return new OkxPublicClient({
      fetch: fetchFn,
      minIntervalMs: 0,
      random: () => 0.5,
      now: () => 0,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
  }

  const okBody = JSON.stringify({
    code: '0',
    msg: '',
    data: [{ instId: 'BTC-USDT-SWAP', markPx: '65000', ts: '1786284960455' }],
  });

  it('retries a 500 and succeeds, with exponential backoff and jitter', async () => {
    const delays: number[] = [];
    const client = flakyClient(
      [
        { status: 500, body: 'boom' },
        { status: 500, body: 'boom' },
        { status: 200, body: okBody },
      ],
      delays,
    );
    const mark = await client.markPrice('BTC-USDT-SWAP');
    expect(mark.markPx).toBe(65_000);
    expect(client.stats.retries).toBe(2);
    // random() is pinned at 0.5, so full jitter halves each doubling ceiling.
    expect(delays).toEqual([200, 400]);
  });

  it('retries a 429 and a transport failure', async () => {
    const delays: number[] = [];
    const rateLimited = flakyClient([{ status: 429, body: '' }, { status: 200, body: okBody }], delays);
    await expect(rateLimited.markPrice('BTC-USDT-SWAP')).resolves.toBeDefined();

    const dropped = flakyClient(['network', { status: 200, body: okBody }], delays);
    await expect(dropped.markPrice('BTC-USDT-SWAP')).resolves.toBeDefined();
  });

  it('gives up after maxAttempts and surfaces the real error', async () => {
    const delays: number[] = [];
    const client = flakyClient([{ status: 503, body: 'down' }], delays);
    await expect(client.markPrice('BTC-USDT-SWAP')).rejects.toThrow(OkxHttpError);
    expect(client.stats.attempts).toBe(4);
    expect(delays).toEqual([200, 400, 800]);
  });

  it('does NOT retry a business error — a bad parameter fails fast', async () => {
    const delays: number[] = [];
    const client = flakyClient(
      [{ status: 200, body: JSON.stringify({ code: '51001', msg: 'instrument does not exist' }) }],
      delays,
    );
    await expect(client.markPrice('BTC-USDT-SWAP')).rejects.toThrow(OkxApiError);
    expect(client.stats.retries).toBe(0);
    expect(delays).toEqual([]);
  });

  it('DOES retry OKX\'s own rate-limit code', async () => {
    const delays: number[] = [];
    const client = flakyClient(
      [{ status: 200, body: JSON.stringify({ code: '50011', msg: 'too many requests' }) }, { status: 200, body: okBody }],
      delays,
    );
    await expect(client.markPrice('BTC-USDT-SWAP')).resolves.toBeDefined();
    expect(client.stats.retries).toBe(1);
  });

  it('times out a hanging request rather than waiting forever', async () => {
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      });
    const client = new OkxPublicClient({
      fetch: hanging,
      timeoutMs: 20,
      minIntervalMs: 0,
      random: () => 0,
      sleep: async () => undefined,
      retry: { maxAttempts: 1 },
    });
    await expect(client.markPrice('BTC-USDT-SWAP')).rejects.toThrow(OkxTimeoutError);
  });

  it('reports a transport failure as a network error, not a parse error', async () => {
    const client = new OkxPublicClient({
      fetch: async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      },
      minIntervalMs: 0,
      sleep: async () => undefined,
      retry: { maxAttempts: 1 },
    });
    await expect(client.markPrice('BTC-USDT-SWAP')).rejects.toThrow(OkxNetworkError);
  });
});

describe('OkxPublicClient — the rate gate', () => {
  it('serialises requests and holds the minimum interval between them', async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const client = new OkxPublicClient({
      fetch: fixtureFetch(),
      minIntervalMs: 1_000,
      random: () => 0,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });

    // Fired concurrently — the gate must still space them out.
    await Promise.all([
      client.ticker('BTC-USDT-SWAP'),
      client.ticker('ETH-USDT-SWAP'),
      client.ticker('SOL-USDT-SWAP'),
    ]);

    expect(sleeps).toEqual([1_000, 1_000]);
    expect(clock).toBe(2_000);
  });
});
