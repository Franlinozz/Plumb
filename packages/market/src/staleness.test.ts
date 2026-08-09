import { describe, expect, it } from 'vitest';

import { DEFAULT_FRESHNESS, assessFreshness, isTradeable } from './staleness.js';

const NOW = Date.parse('2026-08-09T12:00:00Z');

/** Everything perfectly fresh; individual tests age one field at a time. */
function fresh(overrides: Partial<Parameters<typeof assessFreshness>[0]> = {}) {
  return {
    now: NOW,
    lastTs: NOW - 1_000,
    markTs: NOW - 1_000,
    fundingTs: NOW - 60_000,
    openInterestTs: NOW - 60_000,
    candleTs: [
      { tf: '15m' as const, newestTs: NOW - 60_000 },
      { tf: '1H' as const, newestTs: NOW - 600_000 },
    ],
    ...overrides,
  };
}

describe('the data watchdog', () => {
  it('reports everything fresh as not degraded', () => {
    const result = assessFreshness(fresh());
    expect(result.degraded).toBe(false);
    expect(result.degradedFields).toEqual([]);
    expect(Object.keys(result.dataAge).sort()).toEqual([
      'candles.15m',
      'candles.1H',
      'funding',
      'last',
      'mark',
      'openInterest',
    ]);
  });

  it('flags a stale mark price at 30s and names the field', () => {
    const ok = assessFreshness(fresh({ markTs: NOW - 30_000 }));
    expect(ok.degraded).toBe(false);

    const stale = assessFreshness(fresh({ markTs: NOW - 30_001 }));
    expect(stale.degraded).toBe(true);
    expect(stale.degradedFields).toEqual(['mark']);
    expect(stale.dataAge['mark']?.ageMs).toBe(30_001);
    expect(stale.dataAge['mark']?.budgetMs).toBe(DEFAULT_FRESHNESS.markMs);
  });

  it('flags a stale last price', () => {
    const stale = assessFreshness(fresh({ lastTs: NOW - 45_000 }));
    expect(stale.degradedFields).toEqual(['last']);
  });

  it('flags stale funding at one hour', () => {
    expect(assessFreshness(fresh({ fundingTs: NOW - 3_600_000 })).degraded).toBe(false);
    const stale = assessFreshness(fresh({ fundingTs: NOW - 3_600_001 }));
    expect(stale.degradedFields).toEqual(['funding']);
  });

  it('flags stale open interest at one hour', () => {
    const stale = assessFreshness(fresh({ openInterestTs: NOW - 7_200_000 }));
    expect(stale.degradedFields).toEqual(['openInterest']);
  });

  it('flags a candle series that is more than two bars behind, per timeframe', () => {
    // 15m budget is 2 x 900_000 = 1_800_000ms.
    const ok = assessFreshness(fresh({ candleTs: [{ tf: '15m', newestTs: NOW - 1_800_000 }] }));
    expect(ok.degraded).toBe(false);

    const stale = assessFreshness(fresh({ candleTs: [{ tf: '15m', newestTs: NOW - 1_800_001 }] }));
    expect(stale.degradedFields).toEqual(['candles.15m']);

    // The same absolute age is fine on a 1H series, because the budget scales with the bar.
    const hourly = assessFreshness(fresh({ candleTs: [{ tf: '1H', newestTs: NOW - 1_800_001 }] }));
    expect(hourly.degraded).toBe(false);
  });

  it('names EVERY failing field, not just the first', () => {
    const stale = assessFreshness(
      fresh({
        markTs: NOW - 60_000,
        lastTs: NOW - 60_000,
        candleTs: [{ tf: '15m', newestTs: NOW - 10_000_000 }],
      }),
    );
    // Sorted, so the reason a snapshot was rejected always reads the same way.
    expect(stale.degradedFields).toEqual(['candles.15m', 'last', 'mark']);
  });

  it('treats a future timestamp as clock skew, not as freshness or staleness', () => {
    const skewed = assessFreshness(fresh({ markTs: NOW + 5_000 }));
    expect(skewed.dataAge['mark']?.ageMs).toBe(0);
    expect(skewed.degraded).toBe(false);
  });

  it('honours a custom budget', () => {
    const strict = assessFreshness(fresh({ markTs: NOW - 2_000 }), {
      ...DEFAULT_FRESHNESS,
      markMs: 1_000,
    });
    expect(strict.degradedFields).toEqual(['mark']);
  });

  it('isTradeable is false for anything degraded, true otherwise', () => {
    expect(isTradeable({ degraded: false })).toBe(true);
    expect(isTradeable({ degraded: true })).toBe(false);
    expect(isTradeable(assessFreshness(fresh()))).toBe(true);
    expect(isTradeable(assessFreshness(fresh({ markTs: 0 })))).toBe(false);
  });
});
