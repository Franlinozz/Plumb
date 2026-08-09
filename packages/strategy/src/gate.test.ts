import { describe, expect, it } from 'vitest';

import { cooldownKey, runGate, type GateRejectionCode } from './gate.js';
import { classifyRegime } from './regime.js';
import type { SignalDraft } from '@plumb/core';
import { REGIME_SPECS, snapshotOf, syntheticCandles } from './testkit.js';
import { DEFAULT_STRATEGY_CONFIG, EMPTY_STATE, type RegimeAssessment } from './types.js';

const NOW = Date.parse('2026-08-01T01:00:00Z');
const snapshot = snapshotOf(syntheticCandles(REGIME_SPECS.trending_up), { now: NOW });
const trendingRegime = classifyRegime(snapshot, '1H');

function draft(overrides: Partial<SignalDraft> = {}): SignalDraft {
  return {
    instId: 'BTC-USDT-SWAP',
    side: 'long',
    intent: 'open',
    entry: { type: 'market', price: 100 },
    stop: { price: 98, distancePct: 0.02, basis: 'atr' },
    takeProfit: [{ price: 104, rMultiple: 2 }],
    timeframe: '1H',
    strategyId: 'trend_ema',
    regime: 'trending_up',
    inputs: { adx: 30, regimeConfidence: 0.9 },
    invalidation: { maxHoldBars: 48, conditions: ['x'] },
    expiresAt: NOW + 7_200_000,
    version: '1.0.0',
    ...overrides,
  };
}

function gate(
  drafts: readonly SignalDraft[],
  overrides: Partial<Parameters<typeof runGate>[0]> = {},
) {
  return runGate({
    drafts,
    snapshot,
    regime: trendingRegime,
    state: EMPTY_STATE,
    config: DEFAULT_STRATEGY_CONFIG,
    now: NOW,
    ...overrides,
  });
}

function expectRejected(result: ReturnType<typeof gate>, code: GateRejectionCode): void {
  expect(result.passed).toEqual([]);
  expect(result.rejected.map((r) => r.code)).toContain(code);
}

describe('the pre-emission gate', () => {
  it('passes a well-formed signal in a confident regime', () => {
    const result = gate([draft()]);
    expect(result.passed).toHaveLength(1);
    expect(result.rejected).toEqual([]);
  });

  it('REJECTS EVERYTHING when the snapshot is degraded — nothing else matters', () => {
    const result = gate([draft(), draft({ strategyId: 'revert_band' })], {
      snapshot: { ...snapshot, degraded: true, degradedFields: ['mark', 'candles.1H'] },
    });
    expect(result.passed).toEqual([]);
    expect(result.rejected).toHaveLength(2);
    for (const rejection of result.rejected) {
      expect(rejection.code).toBe('snapshot_degraded');
      expect(rejection.details['degradedFields']).toBe('mark,candles.1H');
    }
  });

  it('rejects an instrument outside the locked set', () => {
    expectRejected(gate([draft({ instId: 'DOGE-USDT-SWAP' as never })]), 'instrument_not_locked');
  });

  it('rejects a disabled strategy', () => {
    expectRejected(
      gate([draft()], {
        config: {
          ...DEFAULT_STRATEGY_CONFIG,
          enabled: { ...DEFAULT_STRATEGY_CONFIG.enabled, trend_ema: false },
        },
      }),
      'strategy_disabled',
    );
  });

  it('rejects a missing or unusable stop — no stop, no order', () => {
    expectRejected(
      gate([draft({ stop: { price: 0, distancePct: 0.02, basis: 'atr' } })]),
      'stop_missing',
    );
    expectRejected(
      gate([draft({ stop: { price: Number.NaN, distancePct: 0.02, basis: 'atr' } })]),
      'stop_missing',
    );
    expectRejected(gate([draft({ entry: { type: 'market' } })]), 'stop_missing');
  });

  it('rejects a stop on the profitable side of entry, for both directions', () => {
    expectRejected(
      gate([draft({ stop: { price: 102, distancePct: 0.02, basis: 'atr' } })]),
      'stop_wrong_side',
    );
    expectRejected(
      gate([
        draft({
          side: 'short',
          stop: { price: 98, distancePct: 0.02, basis: 'atr' },
          regime: 'trending_down',
        }),
      ]),
      'stop_wrong_side',
    );
  });

  it('rejects a zero stop distance', () => {
    expectRejected(
      gate([draft({ stop: { price: 98, distancePct: 0, basis: 'atr' } })]),
      'stop_distance_zero',
    );
  });

  it('rejects a stop inside typical spread and slippage', () => {
    const tight = DEFAULT_STRATEGY_CONFIG.stops.minDistancePct / 2;
    const result = gate([draft({ stop: { price: 99.95, distancePct: tight, basis: 'atr' } })]);
    expectRejected(result, 'stop_too_tight');
    expect(result.rejected[0]?.details['floor']).toBe(DEFAULT_STRATEGY_CONFIG.stops.minDistancePct);
  });

  it('rejects a stop so wide the position size stops meaning anything', () => {
    const wide = DEFAULT_STRATEGY_CONFIG.stops.maxDistancePct * 2;
    expectRejected(gate([draft({ stop: { price: 90, distancePct: wide, basis: 'atr' } })]), 'stop_too_wide');
  });

  it('rejects everything when the regime is unclear', () => {
    const unclearSnapshot = snapshotOf(syntheticCandles(REGIME_SPECS.unclear), { now: NOW });
    const unclear = classifyRegime(unclearSnapshot, '1H');
    expect(unclear.label).toBe('unclear');
    expectRejected(gate([draft()], { snapshot: unclearSnapshot, regime: unclear }), 'regime_unclear');
  });

  it('rejects when regime confidence is below the floor', () => {
    const shaky: RegimeAssessment = { ...trendingRegime, confidence: 0.1 };
    expectRejected(gate([draft()], { regime: shaky }), 'regime_low_confidence');
  });

  it('rejects an expired signal', () => {
    expectRejected(gate([draft({ expiresAt: NOW - 1 })]), 'signal_stale');
  });

  it('rejects a signal timestamped before its own snapshot', () => {
    expectRejected(gate([draft()], { now: snapshot.ts - 1_000 }), 'signal_stale');
  });

  it('rejects a duplicate inside the cooldown, and allows it after', () => {
    const key = cooldownKey(draft());
    expect(key).toBe('BTC-USDT-SWAP|long|trend_ema');

    const inside = gate([draft()], {
      state: { ...EMPTY_STATE, lastSignalAt: { [key]: NOW - 60_000 } },
    });
    expectRejected(inside, 'duplicate_cooldown');

    const outside = gate([draft()], {
      state: {
        ...EMPTY_STATE,
        lastSignalAt: { [key]: NOW - DEFAULT_STRATEGY_CONFIG.gate.cooldownMs - 1 },
      },
    });
    expect(outside.passed).toHaveLength(1);
  });

  it('scopes the cooldown to instrument, side AND strategy', () => {
    const state = {
      ...EMPTY_STATE,
      lastSignalAt: { 'BTC-USDT-SWAP|long|trend_ema': NOW - 1_000 },
    };
    // A different strategy on the same instrument and side is not a duplicate.
    expect(gate([draft({ strategyId: 'breakout_range' })], { state }).passed).toHaveLength(1);
    // Neither is the same strategy on a different instrument.
    expect(gate([draft({ instId: 'ETH-USDT-SWAP' })], { state }).passed).toHaveLength(1);
  });

  it('rejects a draft carrying a sizing field', () => {
    const leaky = { ...draft(), notional: 800 } as unknown as SignalDraft;
    expectRejected(gate([leaky]), 'sizing_leak');
  });

  it('emits NEITHER side when two strategies disagree on one instrument', () => {
    const result = gate([
      draft({ strategyId: 'trend_ema', side: 'long' }),
      draft({
        strategyId: 'revert_band',
        side: 'short',
        stop: { price: 102, distancePct: 0.02, basis: 'structure' },
      }),
    ]);

    // Never netted out, never resolved in favour of the "better" one.
    expect(result.passed).toEqual([]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.instId).toBe('BTC-USDT-SWAP');
    expect(result.conflicts[0]?.strategyIds).toEqual(['revert_band', 'trend_ema']);
    expect(result.rejected.every((r) => r.code === 'conflicting_sides')).toBe(true);
    expect(result.rejected).toHaveLength(2);
  });

  it('does not treat agreement as a conflict', () => {
    const result = gate([
      draft({ strategyId: 'trend_ema' }),
      draft({ strategyId: 'breakout_range' }),
    ]);
    expect(result.conflicts).toEqual([]);
    expect(result.passed).toHaveLength(2);
  });

  it('confines a conflict to the instrument it happened on', () => {
    const result = gate([
      draft({ instId: 'BTC-USDT-SWAP', side: 'long', strategyId: 'trend_ema' }),
      draft({
        instId: 'BTC-USDT-SWAP',
        side: 'short',
        strategyId: 'revert_band',
        stop: { price: 102, distancePct: 0.02, basis: 'structure' },
      }),
      draft({ instId: 'ETH-USDT-SWAP', side: 'long', strategyId: 'trend_ema' }),
    ]);
    expect(result.passed.map((d) => d.instId)).toEqual(['ETH-USDT-SWAP']);
    expect(result.conflicts).toHaveLength(1);
  });

  it('gives every rejection a code, a message and the numbers behind it', () => {
    const result = gate([draft({ stop: { price: 99.999, distancePct: 0.00001, basis: 'atr' } })]);
    const rejection = result.rejected[0];
    expect(rejection).toBeDefined();
    expect(rejection?.message.length).toBeGreaterThan(10);
    expect(rejection?.strategyId).toBe('trend_ema');
    expect(rejection?.instId).toBe('BTC-USDT-SWAP');
    expect(rejection?.side).toBe('long');
    expect(Object.keys(rejection?.details ?? {}).length).toBeGreaterThan(0);
  });
});
