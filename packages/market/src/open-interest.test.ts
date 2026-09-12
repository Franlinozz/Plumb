import { describe, expect, it } from 'vitest';

import { openInterestChangeOverWindow } from './open-interest.js';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-08-20T22:10:00Z');

describe('rolling open-interest change', () => {
  it('uses the last hourly point before the boundary, not the next point after it', () => {
    const current = { instId: 'ETH-USDT-SWAP' as const, oi: 100.3, oiCcy: 0, oiUsd: 0, ts: NOW };
    const history = [
      { ts: Date.parse('2026-08-19T22:00:00Z'), oi: 100, oiCcy: 0, oiUsd: 0 },
      { ts: Date.parse('2026-08-19T23:00:00Z'), oi: 103, oiCcy: 0, oiUsd: 0 },
    ];
    expect(openInterestChangeOverWindow(current, history, 24 * HOUR)).toBeCloseTo(0.003);
    // The old `find(ts >= boundary)` implementation chose 23:00 and got the opposite sign.
    expect(current.oi / history[1]!.oi - 1).toBeLessThan(0);
  });

  it('fails closed when history does not reach the requested boundary', () => {
    const current = { instId: 'ETH-USDT-SWAP' as const, oi: 100, oiCcy: 0, oiUsd: 0, ts: NOW };
    const history = [{ ts: NOW - 23 * HOUR, oi: 99, oiCcy: 0, oiUsd: 0 }];
    expect(openInterestChangeOverWindow(current, history, 24 * HOUR)).toBeNaN();
  });
});
