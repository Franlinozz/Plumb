import { snapshotFromCandles, type Candle } from '@plumb/market';
import { describe, expect, it } from 'vitest';

import { EMPTY_STATE, DEFAULT_STRATEGY_CONFIG, type RegimeAssessment } from '../types.js';
import {
  aggregateClosedOneHour,
  competitionIntradayContinuation,
} from './competition_intraday_continuation.js';

const TF = 15 * 60_000;

function risingSeries(): readonly Candle[] {
  const rows: Candle[] = [];
  for (let index = 0; index < 300; index += 1) {
    const centre = 100 + index * 0.012 + Math.sin(index / 2.7) * 0.18;
    const close = centre + Math.sin(index / 1.9) * 0.04;
    rows.push({
      ts: index * TF,
      open: centre - 0.02,
      high: close + 0.08,
      low: close - 0.08,
      close,
      volume: 100,
      volumeCcy: 100,
      volumeQuote: 10_000,
      closed: true,
    });
  }
  const prior = rows.slice(-9, -1);
  const breakout = Math.max(...prior.map((bar) => bar.high)) + 0.04;
  rows[299] = { ...(rows[299] as Candle), open: breakout - 0.04, high: breakout + 0.08,
    low: breakout - 0.12, close: breakout, volume: 100 };
  return rows;
}

const regime: RegimeAssessment = Object.freeze({
  label: 'trending_up', confidence: 0.6, timeframe: '15m', inputs: Object.freeze({}),
  reasons: Object.freeze(['test context']),
});

describe('competition intraday continuation', () => {
  it('aggregates only complete UTC-aligned one-hour bars', () => {
    const rows = risingSeries().slice(0, 10);
    const hourly = aggregateClosedOneHour(rows);
    expect(hourly).toHaveLength(2);
    expect(hourly[0]?.ts).toBe(0);
    expect(hourly[1]?.ts).toBe(60 * 60_000);
  });

  it('emits a replayable long only after the closed 15m breakout', () => {
    const candles = risingSeries();
    const now = (candles.at(-1) as Candle).ts;
    const snapshot = snapshotFromCandles({
      now,
      instId: 'BTC-USDT-SWAP',
      candles: [{ tf: '15m', ohlcv: candles }],
    });
    const config = {
      ...DEFAULT_STRATEGY_CONFIG,
      takeProfitR: Object.freeze([2]),
      maxHoldBars: 96,
      expiryBars: 1,
    };
    const drafts = competitionIntradayContinuation.evaluate({
      snapshot, regime, state: EMPTY_STATE, config, now, peers: [],
    });
    expect(drafts).toHaveLength(1);
    const draft = drafts[0];
    expect(draft?.side).toBe('long');
    expect(draft?.timeframe).toBe('15m');
    expect(draft?.stop.distancePct).toBeGreaterThanOrEqual(0.015 - 1e-9);
    expect(draft?.stop.distancePct).toBeLessThanOrEqual(0.02);
    expect(draft?.takeProfit?.[0]?.rMultiple).toBe(2);
    expect(draft?.expiresAt).toBe(now + TF);
  });

  it('does not emit before price clears the prior range', () => {
    const candles = risingSeries().map((bar, index, all) => index === all.length - 1
      ? { ...bar, close: (all[index - 1] as Candle).close, high: (all[index - 1] as Candle).high }
      : bar);
    const now = (candles.at(-1) as Candle).ts;
    const snapshot = snapshotFromCandles({ now, instId: 'BTC-USDT-SWAP',
      candles: [{ tf: '15m', ohlcv: candles }] });
    expect(competitionIntradayContinuation.evaluate({
      snapshot, regime, state: EMPTY_STATE, config: DEFAULT_STRATEGY_CONFIG, now, peers: [],
    })).toEqual([]);
  });
});
