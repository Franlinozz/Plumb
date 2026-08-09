import type { Instrument } from '@plumb/core';
import { describe, expect, it } from 'vitest';

import { OkxPublicClient } from './client.js';
import { fixtureFetch } from './fixtures.js';
import { buildSnapshot, seriesFor, type SnapshotInput } from './snapshot.js';
import { isTradeable } from './staleness.js';
import type { CandleSeries, Timeframe } from './types.js';

const TIMEFRAMES: readonly Timeframe[] = ['15m', '1H', '4H'];

function client(): OkxPublicClient {
  return new OkxPublicClient({
    fetch: fixtureFetch(),
    minIntervalMs: 0,
    sleep: async () => undefined,
    now: () => 0,
  });
}

/** Assemble a full snapshot input from the recorded fixtures — no network, no clock. */
async function loadInput(instId: Instrument, now: number): Promise<SnapshotInput> {
  const c = client();
  const candles: CandleSeries[] = [];
  for (const tf of TIMEFRAMES) {
    candles.push({ tf, ohlcv: await c.historyCandles(instId, tf, { limit: 300 }) });
  }
  return {
    now,
    instId,
    ticker: await c.ticker(instId),
    markPrice: await c.markPrice(instId),
    funding: await c.fundingRate(instId),
    fundingHistory: await c.fundingRateHistory(instId, { limit: 100 }),
    openInterest: await c.openInterest(instId),
    openInterestHistory: await c.openInterestHistory(instId, '1H', { limit: 100 }),
    candles,
  };
}

/** A clock close enough to the recording that nothing is stale. */
async function freshInput(instId: Instrument): Promise<SnapshotInput> {
  const c = client();
  const ticker = await c.ticker(instId);
  return loadInput(instId, ticker.ts + 1_000);
}

describe('buildSnapshot', () => {
  it('assembles every field the strategy is allowed to see', async () => {
    const snapshot = buildSnapshot(await freshInput('BTC-USDT-SWAP'));

    expect(snapshot.instId).toBe('BTC-USDT-SWAP');
    expect(snapshot.last).toBeGreaterThan(0);
    expect(snapshot.mark).toBeGreaterThan(0);
    expect(snapshot.candles.map((s) => s.tf)).toEqual(['15m', '1H', '4H']);
    expect(snapshot.funding.history.length).toBeGreaterThan(10);
    expect(snapshot.openInterest.value).toBeGreaterThan(0);
    expect(snapshot.openInterest.history.length).toBeGreaterThan(10);
    expect(Object.keys(snapshot.indicators).sort()).toEqual(['15m', '1H', '4H']);
  });

  it('sorts candles oldest-first, whatever order they arrived in', async () => {
    const input = await freshInput('ETH-USDT-SWAP');
    const snapshot = buildSnapshot(input);
    for (const s of snapshot.candles) {
      for (let i = 1; i < s.ohlcv.length; i += 1) {
        expect((s.ohlcv[i] as { ts: number }).ts).toBeGreaterThan(
          (s.ohlcv[i - 1] as { ts: number }).ts,
        );
      }
    }

    // Reversing the input must not change the output: order is normalised, not trusted.
    const reversed: SnapshotInput = {
      ...input,
      candles: input.candles.map((s) => ({ tf: s.tf, ohlcv: [...s.ohlcv].reverse() })),
    };
    expect(JSON.stringify(buildSnapshot(reversed))).toBe(JSON.stringify(snapshot));
  });

  it('is deterministic — same fixtures in, byte-identical snapshot out', async () => {
    const input = await freshInput('SOL-USDT-SWAP');
    const a = JSON.stringify(buildSnapshot(input));
    const b = JSON.stringify(buildSnapshot(await freshInput('SOL-USDT-SWAP')));
    expect(a).toBe(b);
  });

  it('never reads the clock itself — ts comes only from the injected now', async () => {
    const input = await freshInput('BTC-USDT-SWAP');
    expect(buildSnapshot({ ...input, now: 1_234_567 }).ts).toBe(1_234_567);
    expect(buildSnapshot(input).ts).toBe(input.now);
  });

  it('computes indicators per timeframe, and they differ between timeframes', async () => {
    const snapshot = buildSnapshot(await freshInput('BTC-USDT-SWAP'));
    const fifteen = snapshot.indicators['15m'];
    const fourHour = snapshot.indicators['4H'];
    expect(fifteen).toBeDefined();
    expect(fourHour).toBeDefined();
    if (fifteen === undefined || fourHour === undefined) return;

    for (const values of [fifteen, fourHour]) {
      expect(values.rsi as number).toBeGreaterThanOrEqual(0);
      expect(values.rsi as number).toBeLessThanOrEqual(100);
      expect(values.atr as number).toBeGreaterThan(0);
      expect(values.adx as number).toBeGreaterThanOrEqual(0);
    }
    // A 4H ATR must be materially larger than a 15m ATR on the same instrument.
    expect(fourHour.atr as number).toBeGreaterThan(fifteen.atr as number);
  });

  it('leaves an indicator undefined rather than guessing when history is short', async () => {
    const input = await freshInput('BTC-USDT-SWAP');
    const short: SnapshotInput = {
      ...input,
      candles: [{ tf: '15m', ohlcv: (input.candles[0] as CandleSeries).ohlcv.slice(-5) }],
    };
    const values = buildSnapshot(short).indicators['15m'];
    expect(values).toBeDefined();
    if (values === undefined) return;
    expect(values.smaLong).toBeUndefined(); // needs 200 bars
    expect(values.adx).toBeUndefined(); // needs 27
    expect(values.rsi).toBeUndefined(); // needs 15
  });

  it('is tradeable when fresh, and degraded — with reasons — when the clock runs on', async () => {
    const input = await freshInput('BTC-USDT-SWAP');

    const fresh = buildSnapshot(input);
    expect(fresh.degraded).toBe(false);
    expect(fresh.degradedFields).toEqual([]);
    expect(isTradeable(fresh)).toBe(true);

    const later = buildSnapshot({ ...input, now: input.now + 7 * 86_400_000 });
    expect(later.degraded).toBe(true);
    expect(isTradeable(later)).toBe(false);
    // Names every stale field, so the halt reason is legible in a log a week later.
    expect(later.degradedFields).toContain('mark');
    expect(later.degradedFields).toContain('last');
    expect(later.degradedFields).toContain('candles.15m');
  });

  it('is frozen — a consumer cannot mutate the snapshot it was handed', async () => {
    const snapshot = buildSnapshot(await freshInput('BTC-USDT-SWAP'));
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.candles)).toBe(true);
    expect(Object.isFrozen(snapshot.funding)).toBe(true);
    expect(() => {
      (snapshot as unknown as Record<string, unknown>)['last'] = 1;
    }).toThrow(TypeError);
  });

  it('seriesFor returns the requested timeframe, or undefined', async () => {
    const snapshot = buildSnapshot(await freshInput('ETH-USDT-SWAP'));
    expect(seriesFor(snapshot, '15m')?.length).toBe(300);
    expect(seriesFor(snapshot, '1m')).toBeUndefined();
  });
});
