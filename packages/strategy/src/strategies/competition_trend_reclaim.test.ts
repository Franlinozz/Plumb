import { snapshotFromCandles, type Candle } from '@plumb/market';
import { describe, expect, it } from 'vitest';

import { DEFAULT_STRATEGY_CONFIG, EMPTY_STATE, type RegimeAssessment } from '../types.js';
import { ALL_STRATEGIES } from './index.js';
import {
  COMPETITION_TREND_RECLAIM_ID,
  COMPETITION_TREND_RECLAIM_SETTINGS,
  createCompetitionTrendReclaim,
} from './competition_trend_reclaim.js';

const HOUR = 3_600_000;
const regime: RegimeAssessment = Object.freeze({
  label: 'trending_up',
  confidence: 0.6,
  timeframe: '1H',
  inputs: Object.freeze({}),
  reasons: Object.freeze(['test']),
});

function risingSeries(): readonly Candle[] {
  const rows: Candle[] = [];
  for (let index = 0; index < 300; index += 1) {
    const close = 100 + index * 0.025 + Math.sin(index / 2.3) * 0.32;
    rows.push({
      ts: index * HOUR,
      open: close - 0.03,
      high: close + 0.12,
      low: close - 0.12,
      close,
      volume: 100,
      volumeCcy: 100,
      volumeQuote: 10_000,
      closed: true,
    });
  }
  const recentHigh = Math.max(...rows.slice(296, 299).map((bar) => bar.high));
  const prior = rows[298] as Candle;
  rows[299] = {
    ...(rows[299] as Candle),
    open: prior.close,
    close: recentHigh + 1,
    high: recentHigh + 1.1,
    low: prior.close - 0.08,
    volume: 100,
  };
  return rows;
}

describe('competition trend reclaim v5', () => {
  it('is isolated from the P8 strategy registry', () => {
    expect(ALL_STRATEGIES.some((strategy) => strategy.id === COMPETITION_TREND_RECLAIM_ID)).toBe(false);
  });

  it('emits a risk-defined two-R continuation draft on closed data', () => {
    const candles = risingSeries();
    const now = (candles.at(-1) as Candle).ts;
    const snapshot = snapshotFromCandles({
      now,
      instId: 'BTC-USDT-SWAP',
      candles: [{ tf: '1H', ohlcv: candles }],
    });
    const config = {
      ...DEFAULT_STRATEGY_CONFIG,
      takeProfitR: Object.freeze([2]),
      maxHoldBars: 24,
      expiryBars: 1,
    };
    const triggerHarness = createCompetitionTrendReclaim({
      ...COMPETITION_TREND_RECLAIM_SETTINGS,
      fourHourAdxMin: 0,
      volumeFloor: 0,
      longRsiMin: 0,
      longRsiMax: 100,
      shortRsiMin: 0,
      shortRsiMax: 100,
    });
    const drafts = triggerHarness.evaluate({
      snapshot,
      regime,
      state: EMPTY_STATE,
      config,
      now,
      peers: [],
    });
    expect(drafts).toHaveLength(1);
    const draft = drafts[0];
    expect(draft?.side).toBe('long');
    expect(draft?.timeframe).toBe('1H');
    expect(draft?.stop.distancePct).toBeGreaterThanOrEqual(0.015 - 1e-9);
    expect(draft?.stop.distancePct).toBeLessThanOrEqual(0.02);
    expect(draft?.takeProfit?.[0]?.rMultiple).toBe(2);
    expect(draft?.expiresAt).toBe(now + HOUR);
  });
});
