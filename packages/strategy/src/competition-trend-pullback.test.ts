import { describe, expect, it } from 'vitest';
import type { Candle } from '@plumb/market';

import {
  ALL_STRATEGIES,
  COMPETITION_TREND_PULLBACK_ID,
  aggregateClosedFourHour,
  classifyFourHourTrend,
  competitionTrendPullback,
} from './index.js';
import { syntheticCandles } from './testkit.js';

const HOUR_MS = 3_600_000;

describe('competition trend-pullback research candidate', () => {
  it('aggregates only complete, contiguous, UTC-aligned closed 4H bars', () => {
    const complete = syntheticCandles({
      bars: 8,
      startPrice: 100,
      drift: 0.001,
      amplitude: 0,
      period: 2,
      noise: 0,
      barRange: 0.002,
      timeframe: '1H',
      endTs: 7 * HOUR_MS,
    });
    expect(aggregateClosedFourHour(complete)).toHaveLength(2);
    expect(aggregateClosedFourHour(complete.slice(0, -1))).toHaveLength(1);
    expect(aggregateClosedFourHour([
      ...complete.slice(0, 4),
      { ...(complete[4] as Candle), closed: false },
      ...complete.slice(5),
    ])).toHaveLength(1);
  });

  it('classifies strong 4H direction symmetrically', () => {
    const up = aggregateClosedFourHour(syntheticCandles({
      bars: 320,
      startPrice: 100,
      drift: 0.002,
      amplitude: 0.001,
      period: 11,
      noise: 0.0002,
      barRange: 0.003,
      endTs: 319 * HOUR_MS,
      seed: 301,
    }));
    const down = aggregateClosedFourHour(syntheticCandles({
      bars: 320,
      startPrice: 100,
      drift: -0.002,
      amplitude: 0.001,
      period: 11,
      noise: 0.0002,
      barRange: 0.003,
      endTs: 319 * HOUR_MS,
      seed: 302,
    }));
    expect(classifyFourHourTrend(up).direction).toBe('up');
    expect(classifyFourHourTrend(down).direction).toBe('down');
  });

  it('stays outside the default/P8 strategy set', () => {
    expect(competitionTrendPullback.id).toBe(COMPETITION_TREND_PULLBACK_ID);
    expect(competitionTrendPullback.version).toBe('3.0.0');
    expect(ALL_STRATEGIES.some((strategy) => strategy.id === COMPETITION_TREND_PULLBACK_ID)).toBe(false);
  });
});
