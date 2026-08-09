import { specFor } from '@plumb/market';
import { describe, expect, it } from 'vitest';

import { LOCKED } from './params.js';
import { estimateFundingCost, sizePosition, type SizingResult } from './sizing.js';

function ok(outcome: ReturnType<typeof sizePosition>): SizingResult {
  if (!outcome.ok) throw new Error(`expected sizing to succeed, got ${outcome.code}: ${outcome.message}`);
  return outcome;
}

describe('sizing arithmetic — worked examples by hand', () => {
  // notional = risk / stopDistance ; contracts = notional / (price * ctVal), rounded DOWN
  const cases = [
    {
      name: 'BTC, 1% stop',
      instId: 'BTC-USDT-SWAP' as const,
      entry: 65_000,
      stop: 64_350, // 1.0% below
      equity: 400,
      // notional = 4 / 0.01 = 400 ; contracts = 400 / (65000 * 0.01) = 0.6153… → 0.61
      expectContracts: 0.61,
    },
    {
      name: 'BTC, tight 0.2% stop — leverage clamps',
      instId: 'BTC-USDT-SWAP' as const,
      entry: 65_000,
      stop: 64_870, // 0.2%
      equity: 400,
      // desired notional = 4 / 0.002 = 2000, above 400*3 = 1200 → clamp to 1200
      // contracts = 1200 / 650 = 1.846… → 1.84
      expectContracts: 1.84,
      expectClamped: true,
    },
    {
      name: 'ETH, 2% stop',
      instId: 'ETH-USDT-SWAP' as const,
      entry: 1_920,
      stop: 1_881.6, // 2%
      equity: 400,
      // notional = 4 / 0.02 = 200 ; contracts = 200 / (1920 * 0.1) = 1.0416… → 1.04
      expectContracts: 1.04,
    },
    {
      name: 'SOL, 3% stop',
      instId: 'SOL-USDT-SWAP' as const,
      entry: 76.8,
      stop: 74.496, // 3%
      equity: 400,
      // notional = 4 / 0.03 = 133.33 ; contracts = 133.33 / (76.8 * 1) = 1.736… → 1.73
      expectContracts: 1.73,
    },
    {
      name: 'SOL, wide 10% stop',
      instId: 'SOL-USDT-SWAP' as const,
      entry: 76.8,
      stop: 69.12, // 10%
      equity: 400,
      // notional = 40 ; contracts = 40 / 76.8 = 0.5208… → 0.52
      expectContracts: 0.52,
    },
  ];

  for (const c of cases) {
    it(`sizes ${c.name}`, () => {
      const result = ok(
        sizePosition({ instId: c.instId, entryPrice: c.entry, stopPrice: c.stop, equityUsdt: c.equity }),
      );
      expect(result.contracts).toBeCloseTo(c.expectContracts, 8);
      expect(result.clampedByLeverage).toBe(c.expectClamped ?? false);
      expect(result.actualRiskUsdt).toBeLessThanOrEqual(LOCKED.PER_TRADE_RISK_USDT + 1e-9);
      expect(result.leverage).toBeLessThanOrEqual(LOCKED.LEVERAGE_CEILING + 1e-9);
    });
  }

  it('sizes SHORTS identically — direction does not change the arithmetic', () => {
    const long = ok(sizePosition({ instId: 'BTC-USDT-SWAP', entryPrice: 65_000, stopPrice: 64_350, equityUsdt: 400 }));
    const short = ok(sizePosition({ instId: 'BTC-USDT-SWAP', entryPrice: 65_000, stopPrice: 65_650, equityUsdt: 400 }));
    expect(short.contracts).toBe(long.contracts);
    expect(short.stopDistancePct).toBeCloseTo(long.stopDistancePct, 12);
  });
});

describe('the leverage clamp', () => {
  it('reduces the NOTIONAL and never widens the stop', () => {
    const entry = 65_000;
    const stop = 64_935; // 0.1% — very tight, demands huge notional
    const result = ok(sizePosition({ instId: 'BTC-USDT-SWAP', entryPrice: entry, stopPrice: stop, equityUsdt: 400 }));

    expect(result.clampedByLeverage).toBe(true);
    // The stop distance the caller asked for is EXACTLY what came back. This is the invariant
    // that stops sizing from quietly becoming "widen the stop until my size fits".
    expect(result.stopDistancePct).toBeCloseTo(Math.abs(entry - stop) / entry, 12);
    expect(result.leverage).toBeLessThanOrEqual(LOCKED.LEVERAGE_CEILING + 1e-9);
    expect(result.notionalUsdt).toBeLessThanOrEqual(400 * LOCKED.LEVERAGE_CEILING + 1e-9);
    // Clamping means we risk LESS than budget, never more.
    expect(result.actualRiskUsdt).toBeLessThan(LOCKED.PER_TRADE_RISK_USDT);
  });

  it('never exceeds the ceiling across a sweep of stop distances', () => {
    for (let bps = 5; bps <= 500; bps += 5) {
      const entry = 65_000;
      const stop = entry * (1 - bps / 10_000);
      const outcome = sizePosition({ instId: 'BTC-USDT-SWAP', entryPrice: entry, stopPrice: stop, equityUsdt: 400 });
      if (!outcome.ok) continue;
      expect(outcome.leverage).toBeLessThanOrEqual(LOCKED.LEVERAGE_CEILING + 1e-9);
      expect(outcome.actualRiskUsdt).toBeLessThanOrEqual(LOCKED.PER_TRADE_RISK_USDT + 1e-9);
    }
  });
});

describe('post-rounding risk', () => {
  it('never exceeds the budget across a sweep of prices and instruments', () => {
    let checked = 0;
    for (const instId of ['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP'] as const) {
      const base = instId.startsWith('BTC') ? 65_000 : instId.startsWith('ETH') ? 1_920 : 76.8;
      for (let priceStep = 0; priceStep < 25; priceStep += 1) {
        const entry = base * (1 + priceStep * 0.017);
        for (let bps = 20; bps <= 400; bps += 7) {
          const stop = entry * (1 - bps / 10_000);
          const outcome = sizePosition({ instId, entryPrice: entry, stopPrice: stop, equityUsdt: 400 });
          if (!outcome.ok) continue;
          checked += 1;
          expect(outcome.actualRiskUsdt).toBeLessThanOrEqual(LOCKED.PER_TRADE_RISK_USDT + 1e-9);
          // Rounding DOWN to the lot grid: actual is at or under intended, never over.
          expect(outcome.actualRiskUsdt).toBeLessThanOrEqual(outcome.intendedRiskUsdt + 1e-9);
        }
      }
    }
    expect(checked).toBeGreaterThan(1_000);
  });

  it('reports the REAL risk after rounding, not the intended one', () => {
    const result = ok(sizePosition({ instId: 'SOL-USDT-SWAP', entryPrice: 76.8, stopPrice: 74.496, equityUsdt: 400 }));
    // 1.73 contracts × 76.8 × 3% = 3.986…, not the 4.00 requested.
    expect(result.actualRiskUsdt).toBeLessThan(result.intendedRiskUsdt);
    expect(result.actualRiskUsdt).toBeCloseTo(result.notionalUsdt * result.stopDistancePct, 12);
  });

  it('honours a reduced risk budget from the drawdown ladder', () => {
    const full = ok(sizePosition({ instId: 'ETH-USDT-SWAP', entryPrice: 1_920, stopPrice: 1_881.6, equityUsdt: 400 }));
    const half = ok(
      sizePosition({
        instId: 'ETH-USDT-SWAP',
        entryPrice: 1_920,
        stopPrice: 1_881.6,
        equityUsdt: 400,
        riskBudgetUsdt: LOCKED.PER_TRADE_RISK_USDT / 2,
      }),
    );
    expect(half.contracts).toBeLessThan(full.contracts);
    expect(half.actualRiskUsdt).toBeLessThanOrEqual(LOCKED.PER_TRADE_RISK_USDT / 2 + 1e-9);
  });
});

describe('rejections', () => {
  it('REJECTS a below-minimum size rather than tightening the stop', () => {
    // Equity so small that a 3x-capped notional cannot buy one lot.
    const outcome = sizePosition({
      instId: 'BTC-USDT-SWAP',
      entryPrice: 65_000,
      stopPrice: 32_500, // 50% stop
      equityUsdt: 0.5,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('below_minimum_size');
    expect(outcome.details['minSz']).toBe(specFor('BTC-USDT-SWAP').minSz);
  });

  it('rejects a stop equal to entry', () => {
    const outcome = sizePosition({ instId: 'BTC-USDT-SWAP', entryPrice: 65_000, stopPrice: 65_000, equityUsdt: 400 });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('stop_distance_invalid');
  });

  it('rejects non-finite or non-positive inputs', () => {
    for (const bad of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      expect(sizePosition({ instId: 'BTC-USDT-SWAP', entryPrice: bad, stopPrice: 100, equityUsdt: 400 }).ok).toBe(false);
      expect(sizePosition({ instId: 'BTC-USDT-SWAP', entryPrice: 100, stopPrice: 90, equityUsdt: bad }).ok).toBe(false);
      expect(sizePosition({ instId: 'BTC-USDT-SWAP', entryPrice: 100, stopPrice: bad, equityUsdt: 400 }).ok).toBe(false);
    }
  });

  it('sizes to the lot grid with no floating-point dust', () => {
    for (let i = 0; i < 200; i += 1) {
      const entry = 1_900 + i * 0.37;
      const outcome = sizePosition({ instId: 'ETH-USDT-SWAP', entryPrice: entry, stopPrice: entry * 0.98, equityUsdt: 400 });
      if (!outcome.ok) continue;
      const lot = specFor('ETH-USDT-SWAP').lotSz;
      const lots = outcome.contracts / lot;
      expect(Math.abs(lots - Math.round(lots))).toBeLessThan(1e-9);
    }
  });
});

describe('funding cost estimation', () => {
  const barMs = 3_600_000; // 1H

  it('charges a long when funding is positive', () => {
    // 48 bars = 48h = 6 settlements of 8h
    expect(estimateFundingCost(400, 0.0001, 'long', 48, barMs)).toBeCloseTo(400 * 0.0001 * 6, 10);
  });

  it('charges a short when funding is negative', () => {
    expect(estimateFundingCost(400, -0.0001, 'short', 48, barMs)).toBeCloseTo(400 * 0.0001 * 6, 10);
  });

  it('never treats a credit as a benefit — a receipt is 0, not negative', () => {
    // Relying on being PAID to hold is a different strategy from the one that was signalled.
    expect(estimateFundingCost(400, 0.0001, 'short', 48, barMs)).toBe(0);
    expect(estimateFundingCost(400, -0.0001, 'long', 48, barMs)).toBe(0);
  });

  it('counts whole settlements only', () => {
    expect(estimateFundingCost(400, 0.001, 'long', 7, barMs)).toBe(0); // under 8h
    expect(estimateFundingCost(400, 0.001, 'long', 8, barMs)).toBeCloseTo(0.4, 10);
  });
});
