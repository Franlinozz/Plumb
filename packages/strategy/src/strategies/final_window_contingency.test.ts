import { snapshotFromCandles } from '@plumb/market';
import { describe, expect, it } from 'vitest';

import { EMPTY_STATE, DEFAULT_STRATEGY_CONFIG, type RegimeAssessment } from '../types.js';
import { syntheticCandles } from '../testkit.js';
import { ALL_STRATEGIES } from './index.js';
import { finalWindowContingency, FINAL_WINDOW_CONTINGENCY_ID } from './final_window_contingency.js';

const HOUR = 3_600_000;
const candles = syntheticCandles({ bars: 300, startPrice: 100, drift: 0.0001, amplitude: 0.002,
  period: 9, noise: 0.001, barRange: 0.004, seed: 3, timeframe: '1H', endTs: 299 * HOUR });
const now = candles.at(-1)?.ts ?? 0;
const regime: RegimeAssessment = Object.freeze({ label: 'trending_up', confidence: 1,
  timeframe: '4H', inputs: Object.freeze({}), reasons: Object.freeze(['test']) });
const context = (instId: 'BTC-USDT-SWAP' | 'ETH-USDT-SWAP') => ({
  snapshot: snapshotFromCandles({ now, instId, candles: [{ tf: '1H' as const, ohlcv: candles }] }),
  regime, state: EMPTY_STATE, config: DEFAULT_STRATEGY_CONFIG, now, peers: [],
});

describe('final-window contingency V2 strategy', () => {
  it('is isolated from P8 and preserves the exact V1 signal geometry', () => {
    expect(ALL_STRATEGIES.some((strategy) => strategy.id === FINAL_WINDOW_CONTINGENCY_ID)).toBe(false);
    expect(finalWindowContingency.evaluate(context('BTC-USDT-SWAP'))).toEqual([]);
    const drafts = finalWindowContingency.evaluate(context('ETH-USDT-SWAP'));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ strategyId: 'final_window_contingency', version: '2.0.0',
      side: 'long', stop: { distancePct: 0.02 } });
    expect(drafts[0]?.takeProfit?.[0]?.rMultiple).toBe(1.5);
  });
});
