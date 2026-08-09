import { describe, expect, it } from 'vitest';

import {
  DEFAULT_COSTS,
  OKX_FEES,
  ZERO_COSTS,
  describeCosts,
  entryFillPrice,
  exitFillPrice,
  feeUsdt,
  fundingOverHold,
  slippageBps,
  stopFillPrice,
  type FundingSeries,
} from './costs.js';

describe('the recorded fee schedule', () => {
  it('uses OKX\'s published Lv1 rates, recorded rather than guessed', () => {
    expect(OKX_FEES.takerRate).toBe(0.0005); // 0.05%
    expect(OKX_FEES.makerRate).toBe(0.0002); // 0.02%
    expect(OKX_FEES.source).toContain('okx.com');
    expect(OKX_FEES.recordedAt).toBe('2026-08-09');
  });

  it('charges the TAKER rate, because Plumb uses market orders', () => {
    expect(DEFAULT_COSTS.takerRate).toBe(OKX_FEES.takerRate);
    expect(feeUsdt(400, DEFAULT_COSTS)).toBeCloseTo(0.2, 10);
    expect(feeUsdt(-400, DEFAULT_COSTS)).toBeCloseTo(0.2, 10); // sign-independent
  });
});

describe('slippage', () => {
  it('is a floor plus a size term plus a volatility term', () => {
    const quiet = slippageBps({ notionalUsdt: 0, barRangePct: 0, costs: DEFAULT_COSTS });
    expect(quiet).toBe(DEFAULT_COSTS.baseSlippageBps);

    // 400 USDT is exactly one reference notional → + notionalSlippageBps
    const sized = slippageBps({ notionalUsdt: 400, barRangePct: 0, costs: DEFAULT_COSTS });
    expect(sized).toBeCloseTo(DEFAULT_COSTS.baseSlippageBps + DEFAULT_COSTS.notionalSlippageBps, 10);

    // 1% bar range → 100bp × 0.05 = 5bp
    const violent = slippageBps({ notionalUsdt: 0, barRangePct: 0.01, costs: DEFAULT_COSTS });
    expect(violent).toBeCloseTo(DEFAULT_COSTS.baseSlippageBps + 5, 10);
  });

  it('grows with size and with volatility, never shrinks', () => {
    let previous = 0;
    for (const notional of [0, 100, 400, 800, 1_600]) {
      const bps = slippageBps({ notionalUsdt: notional, barRangePct: 0.005, costs: DEFAULT_COSTS });
      expect(bps).toBeGreaterThanOrEqual(previous);
      previous = bps;
    }
  });

  it('is zero under the zero-cost model', () => {
    expect(slippageBps({ notionalUsdt: 10_000, barRangePct: 0.05, costs: ZERO_COSTS })).toBe(0);
  });
});

describe('fills always go against us', () => {
  it('slips a market entry away from the direction of the trade', () => {
    // A long buys HIGHER than the open; a short sells LOWER.
    expect(entryFillPrice('long', 100, 10)).toBeCloseTo(100.1, 10);
    expect(entryFillPrice('short', 100, 10)).toBeCloseTo(99.9, 10);
  });

  it('slips a market exit against us too', () => {
    // Closing a long is a sell → filled lower.
    expect(exitFillPrice('long', 100, 10)).toBeCloseTo(99.9, 10);
    expect(exitFillPrice('short', 100, 10)).toBeCloseTo(100.1, 10);
  });

  it('fills a stop at the WORSE of stop price and the bar open — the gap fixture', () => {
    // LONG with a stop at 95. The bar GAPS DOWN and opens at 90: we get 90, not 95.
    expect(stopFillPrice('long', 95, 90, 0)).toBe(90);
    // No gap — the open is above the stop, so the stop price stands.
    expect(stopFillPrice('long', 95, 97, 0)).toBe(95);

    // SHORT with a stop at 105. The bar GAPS UP and opens at 112: we get 112.
    expect(stopFillPrice('short', 105, 112, 0)).toBe(112);
    expect(stopFillPrice('short', 105, 100, 0)).toBe(105);
  });

  it('slips the stop further after taking the worse side', () => {
    // Gapped to 90, then 10bp of slippage on top: 90 - 0.09 = 89.91
    expect(stopFillPrice('long', 95, 90, 10)).toBeCloseTo(89.91, 8);
    expect(stopFillPrice('short', 105, 112, 10)).toBeCloseTo(112.112, 8);
  });

  it('never fills a stop BETTER than its printed price, across a sweep', () => {
    for (let open = 80; open <= 120; open += 1) {
      expect(stopFillPrice('long', 100, open, 5)).toBeLessThanOrEqual(100);
      expect(stopFillPrice('short', 100, open, 5)).toBeGreaterThanOrEqual(100);
    }
  });
});

describe('funding accrual', () => {
  const rate = 0.0001;
  // Settlements land at 00:00, 08:00, 16:00 UTC.
  const series: FundingSeries = {
    instId: 'BTC-USDT-SWAP',
    entries: [
      { fundingTime: Date.parse('2026-08-01T00:00:00Z'), fundingRate: rate },
      { fundingTime: Date.parse('2026-08-01T08:00:00Z'), fundingRate: rate },
      { fundingTime: Date.parse('2026-08-01T16:00:00Z'), fundingRate: rate },
      { fundingTime: Date.parse('2026-08-02T00:00:00Z'), fundingRate: rate },
    ],
  };

  it('matches hand-computed values over a known window', () => {
    // Held 2026-08-01 01:00 → 2026-08-01 17:00 crosses the 08:00 and 16:00 settlements = 2.
    // A LONG pays: 400 × 0.0001 × 2 = 0.08 USDT.
    const long = fundingOverHold(
      'long',
      400,
      Date.parse('2026-08-01T01:00:00Z'),
      Date.parse('2026-08-01T17:00:00Z'),
      series,
      DEFAULT_COSTS,
    );
    expect(long.settlements).toBe(2);
    expect(long.fallbackSettlements).toBe(0);
    expect(long.usdt).toBeCloseTo(0.08, 10);

    // A SHORT over the same window RECEIVES it — the sign is preserved.
    const short = fundingOverHold(
      'short',
      400,
      Date.parse('2026-08-01T01:00:00Z'),
      Date.parse('2026-08-01T17:00:00Z'),
      series,
      DEFAULT_COSTS,
    );
    expect(short.usdt).toBeCloseTo(-0.08, 10);
  });

  it('counts a settlement exactly on the boundary', () => {
    const held = fundingOverHold(
      'long',
      400,
      Date.parse('2026-08-01T00:00:00Z'),
      Date.parse('2026-08-01T08:00:00Z'),
      series,
      DEFAULT_COSTS,
    );
    // 00:00 (open instant) and 08:00 both land inside [open, close].
    expect(held.settlements).toBe(2);
  });

  it('charges nothing for a position that never crosses a settlement', () => {
    const held = fundingOverHold(
      'long',
      400,
      Date.parse('2026-08-01T01:00:00Z'),
      Date.parse('2026-08-01T07:00:00Z'),
      series,
      DEFAULT_COSTS,
    );
    expect(held.settlements).toBe(0);
    expect(held.usdt).toBe(0);
  });

  it('charges the FALLBACK as a cost when no history exists, for BOTH sides', () => {
    // OKX retains ~97 days of funding history; older bars have none. Inventing income we never
    // observed is exactly the flattery this model exists to prevent.
    const long = fundingOverHold(
      'long',
      400,
      Date.parse('2025-01-01T01:00:00Z'),
      Date.parse('2025-01-01T17:00:00Z'),
      series,
      DEFAULT_COSTS,
    );
    const short = fundingOverHold(
      'short',
      400,
      Date.parse('2025-01-01T01:00:00Z'),
      Date.parse('2025-01-01T17:00:00Z'),
      series,
      DEFAULT_COSTS,
    );
    expect(long.fallbackSettlements).toBe(2);
    expect(short.fallbackSettlements).toBe(2);
    expect(long.usdt).toBeGreaterThan(0);
    expect(short.usdt).toBeGreaterThan(0); // a COST for the short too — never a credit
    expect(long.usdt).toBe(short.usdt);
  });

  it('charges nothing under the zero-cost model', () => {
    const held = fundingOverHold(
      'long',
      400,
      Date.parse('2025-01-01T01:00:00Z'),
      Date.parse('2025-01-05T17:00:00Z'),
      undefined,
      ZERO_COSTS,
    );
    expect(held.usdt).toBe(0);
  });
});

describe('the assumptions are stated', () => {
  it('describes every one of them for the report', () => {
    const described = describeCosts(DEFAULT_COSTS).join(' ');
    expect(described).toContain('0.050%');
    expect(described).toContain('NEXT bar');
    expect(described).toContain('WORSE');
    expect(described).toContain('97 days');
  });
});
