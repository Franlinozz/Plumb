import { snapshotFromCandles } from '@plumb/market';
import { describe, expect, it } from 'vitest';

import { EMPTY_STATE, DEFAULT_STRATEGY_CONFIG, type RegimeAssessment } from '../types.js';
import { syntheticCandles } from '../testkit.js';
import { ALL_STRATEGIES } from './index.js';
import { deadlineContingency, DEADLINE_CONTINGENCY_ID } from './deadline_contingency.js';

const HOUR = 3_600_000;
const candles = syntheticCandles({
  bars: 300,
  startPrice: 100,
  drift: 0.0001,
  amplitude: 0.002,
  period: 9,
  noise: 0.001,
  barRange: 0.004,
  seed: 3,
  timeframe: '1H',
  endTs: 299 * HOUR,
});
const now = candles.at(-1)?.ts ?? 0;
const regime: RegimeAssessment = Object.freeze({
  label: 'trending_up', confidence: 1, timeframe: '4H',
  inputs: Object.freeze({}), reasons: Object.freeze(['test']),
});
const context = (instId: 'BTC-USDT-SWAP' | 'ETH-USDT-SWAP') => ({
  snapshot: snapshotFromCandles({ now, instId, candles: [{ tf: '1H' as const, ohlcv: candles }] }),
  regime,
  state: EMPTY_STATE,
  config: DEFAULT_STRATEGY_CONFIG,
  now,
  peers: [],
});

describe('deadline contingency strategy', () => {
  it('is isolated from P8 and hard-limited to the authorised ETH/SOL universe', () => {
    expect(ALL_STRATEGIES.some((strategy) => strategy.id === DEADLINE_CONTINGENCY_ID)).toBe(false);
    expect(deadlineContingency.evaluate(context('BTC-USDT-SWAP'))).toEqual([]);
  });

  it('emits one deterministic closed-bar recovery with exact 2% risk geometry', () => {
    const drafts = deadlineContingency.evaluate(context('ETH-USDT-SWAP'));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      instId: 'ETH-USDT-SWAP', side: 'long', strategyId: 'deadline_contingency',
      version: '1.0.0', timeframe: '1H',
    });
    expect(drafts[0]?.stop.distancePct).toBeCloseTo(0.02);
    expect(drafts[0]?.takeProfit?.[0]?.rMultiple).toBe(1.5);
    expect(drafts[0]?.expiresAt).toBe(now + 30 * 60_000);
  });
});
