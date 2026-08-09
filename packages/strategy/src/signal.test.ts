import { describe, expect, it } from 'vitest';

import { createEntropyIdFactory, createSeededIdFactory } from './ids.js';
import {
  FORBIDDEN_SIGNAL_FIELDS,
  SignalSizingLeakError,
  assertNoSizing,
  parseSignal,
  stopDistancePct,
  stopIsOnCorrectSide,
  takeProfitLevels,
  type Signal,
} from './signal.js';

function validSignal(overrides: Partial<Signal> = {}): Record<string, unknown> {
  return {
    id: 'SIG-abcdefghij',
    ts: 1_786_000_000_000,
    instId: 'BTC-USDT-SWAP',
    side: 'long',
    intent: 'open',
    entry: { type: 'market', price: 65_000 },
    stop: { price: 64_000, distancePct: 1000 / 65_000, basis: 'atr' },
    takeProfit: [{ price: 66_500, rMultiple: 1.5 }],
    timeframe: '1H',
    strategyId: 'trend_ema',
    regime: 'trending_up',
    inputs: { adx: 31.2, atr: 500 },
    invalidation: { maxHoldBars: 48, conditions: ['ADX falls'] },
    expiresAt: 1_786_007_200_000,
    version: '1.0.0',
    ...overrides,
  };
}

describe('Signal schema', () => {
  it('accepts a well-formed signal', () => {
    const signal = parseSignal(validSignal());
    expect(signal.instId).toBe('BTC-USDT-SWAP');
    expect(signal.stop.basis).toBe('atr');
  });

  it('rejects an instrument outside the locked set', () => {
    expect(() => parseSignal(validSignal({ instId: 'DOGE-USDT-SWAP' as never }))).toThrow();
  });

  it('rejects a malformed id', () => {
    expect(() => parseSignal(validSignal({ id: 'abc' }))).toThrow();
    expect(() => parseSignal(validSignal({ id: 'SIG-tooshort' }))).toThrow();
  });

  it('rejects a non-positive stop price or distance', () => {
    expect(() =>
      parseSignal(validSignal({ stop: { price: 0, distancePct: 0.01, basis: 'atr' } })),
    ).toThrow();
    expect(() =>
      parseSignal(validSignal({ stop: { price: 64_000, distancePct: 0, basis: 'atr' } })),
    ).toThrow();
  });

  it('rejects a non-finite input value — NaN must never reach the ledger', () => {
    expect(() => parseSignal(validSignal({ inputs: { adx: Number.NaN } }))).toThrow();
    expect(() => parseSignal(validSignal({ inputs: { adx: Number.POSITIVE_INFINITY } }))).toThrow();
  });

  it('REJECTS any sizing field — sizing belongs to @plumb/risk', () => {
    for (const field of FORBIDDEN_SIGNAL_FIELDS) {
      expect(() => parseSignal({ ...validSignal(), [field]: 1 })).toThrow(SignalSizingLeakError);
    }
  });

  it('rejects unknown keys outright, so nothing can be smuggled alongside', () => {
    expect(() => parseSignal({ ...validSignal(), somethingElse: 1 })).toThrow();
  });

  it('assertNoSizing names every offending field at once', () => {
    try {
      assertNoSizing({ size: 1, leverage: 3, notional: 800 });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(SignalSizingLeakError);
      expect((error as SignalSizingLeakError).fields).toEqual(['size', 'leverage', 'notional']);
    }
  });
});

describe('stop geometry', () => {
  it('knows which side a stop belongs on', () => {
    expect(stopIsOnCorrectSide('long', 100, 95)).toBe(true);
    expect(stopIsOnCorrectSide('long', 100, 105)).toBe(false);
    expect(stopIsOnCorrectSide('short', 100, 105)).toBe(true);
    expect(stopIsOnCorrectSide('short', 100, 95)).toBe(false);
    // A stop AT the entry is not a stop.
    expect(stopIsOnCorrectSide('long', 100, 100)).toBe(false);
    expect(stopIsOnCorrectSide('short', 100, 100)).toBe(false);
  });

  it('computes stop distance as a positive fraction of entry', () => {
    expect(stopDistancePct(100, 95)).toBeCloseTo(0.05, 12);
    expect(stopDistancePct(100, 105)).toBeCloseTo(0.05, 12);
  });

  it('places take-profits at R multiples of the risked distance', () => {
    expect(takeProfitLevels('long', 100, 95, [1, 2, 3])).toEqual([
      { price: 105, rMultiple: 1 },
      { price: 110, rMultiple: 2 },
      { price: 115, rMultiple: 3 },
    ]);
    expect(takeProfitLevels('short', 100, 105, [1, 2])).toEqual([
      { price: 95, rMultiple: 1 },
      { price: 90, rMultiple: 2 },
    ]);
  });
});

describe('signal ids', () => {
  it('produces the nanoid shape', () => {
    const id = createSeededIdFactory(1)();
    expect(id).toMatch(/^SIG-[A-Za-z0-9_-]{10}$/);
  });

  it('is deterministic for a given seed, and different across seeds', () => {
    const a = createSeededIdFactory(42);
    const b = createSeededIdFactory(42);
    const c = createSeededIdFactory(43);
    const first = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(first);
    expect([c(), c(), c()]).not.toEqual(first);
  });

  it('does not repeat within a run', () => {
    const factory = createSeededIdFactory(9);
    const ids = new Set(Array.from({ length: 2_000 }, () => factory()));
    expect(ids.size).toBe(2_000);
  });

  it('takes entropy from an injected source, never an ambient one', () => {
    let counter = 0;
    const factory = createEntropyIdFactory(() => {
      counter += 7;
      return counter;
    });
    expect(factory()).toMatch(/^SIG-[A-Za-z0-9_-]{10}$/);
    expect(counter).toBeGreaterThan(0);
  });
});
