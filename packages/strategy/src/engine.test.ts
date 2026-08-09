import { fixtureCandles } from '@plumb/market';
import { describe, expect, it } from 'vitest';

import { runCycle, runCycleSeeded } from './engine.js';
import { createSeededIdFactory } from './ids.js';
import { buildRationalePayload, findUnsanctionedNumbers } from './rationale.js';
import { FORBIDDEN_SIGNAL_FIELDS, SignalSchema, stopIsOnCorrectSide } from './signal.js';
import { EVENT_SPECS, REGIME_SPECS, snapshotOf, syntheticCandles } from './testkit.js';
import { DEFAULT_STRATEGY_CONFIG, EMPTY_STATE } from './types.js';

const trendingSnapshot = snapshotOf(syntheticCandles(REGIME_SPECS.trending_up));

/**
 * A window on which the WHOLE engine emits — not merely one where a module produces a draft.
 * The gate and the portfolio coordinator sit between the two, and a test that assumed a draft
 * would survive them would be testing something it had not checked.
 *
 * Memoised: the search walks several hundred windows and is used by most tests in this file.
 */
let cachedEmitting: ReturnType<typeof snapshotOf> | undefined;
function emittingSnapshot() {
  if (cachedEmitting !== undefined) return cachedEmitting;
  for (const spec of [EVENT_SPECS.trendCross, EVENT_SPECS.rangeBreak, EVENT_SPECS.bandTouch]) {
    const candles = syntheticCandles(spec);
    for (let end = 130; end <= candles.length; end += 1) {
      const snapshot = snapshotOf(candles.slice(0, end));
      if (runCycleSeeded(snapshot, snapshot.ts).signals.length > 0) {
        cachedEmitting = snapshot;
        return snapshot;
      }
    }
  }
  throw new Error('no window emits through the full engine — the event fixtures have drifted');
}

describe('engine purity', () => {
  it('is byte-identical across 100 runs with the same snapshot and seed', () => {
    const snapshot = emittingSnapshot();
    const first = JSON.stringify(runCycleSeeded(snapshot, snapshot.ts, { seed: 4 }));
    for (let i = 0; i < 100; i += 1) {
      expect(JSON.stringify(runCycleSeeded(snapshot, snapshot.ts, { seed: 4 }))).toBe(first);
    }
  });

  it('depends on the injected clock, never an ambient one', () => {
    const snapshot = emittingSnapshot();
    const a = runCycleSeeded(snapshot, snapshot.ts, { seed: 1 });
    const b = runCycleSeeded(snapshot, snapshot.ts + 60_000, { seed: 1 });
    expect(a.signals[0]?.ts).toBe(snapshot.ts);
    expect(b.signals[0]?.ts).toBe(snapshot.ts + 60_000);
  });

  it('takes its ids from the injected factory only', () => {
    const snapshot = emittingSnapshot();
    const factory = createSeededIdFactory(99);
    const expected = createSeededIdFactory(99)();
    const result = runCycle(snapshot, { now: snapshot.ts, newId: factory });
    expect(result.signals[0]?.id).toBe(expected);
  });

  it('does not mutate the snapshot it was given', () => {
    const snapshot = emittingSnapshot();
    const before = JSON.stringify(snapshot);
    runCycleSeeded(snapshot, snapshot.ts);
    expect(JSON.stringify(snapshot)).toBe(before);
  });
});

describe('a degraded snapshot is silent, unconditionally', () => {
  it('emits nothing, for every strategy, whatever the market', () => {
    for (const specName of Object.keys(REGIME_SPECS) as Array<keyof typeof REGIME_SPECS>) {
      const clean = snapshotOf(syntheticCandles(REGIME_SPECS[specName]));
      const degraded = { ...clean, degraded: true, degradedFields: ['mark'] };
      const result = runCycleSeeded(degraded, degraded.ts);
      expect(result.signals).toEqual([]);
      for (const rejection of result.rejected) expect(rejection.code).toBe('snapshot_degraded');
    }
  });

  it('is silent even on a window that WOULD otherwise emit', () => {
    const snapshot = emittingSnapshot();
    expect(runCycleSeeded(snapshot, snapshot.ts).signals.length).toBeGreaterThan(0);
    const degraded = { ...snapshot, degraded: true, degradedFields: ['candles.1H'] };
    expect(runCycleSeeded(degraded, degraded.ts).signals).toEqual([]);
  });
});

describe('everything the engine emits is a valid Signal', () => {
  it('validates against the schema and carries no sizing', () => {
    const snapshot = emittingSnapshot();
    const result = runCycleSeeded(snapshot, snapshot.ts);
    expect(result.signals.length).toBeGreaterThan(0);
    for (const signal of result.signals) {
      expect(() => SignalSchema.parse(signal)).not.toThrow();
      for (const field of FORBIDDEN_SIGNAL_FIELDS) {
        expect(Object.prototype.hasOwnProperty.call(signal, field)).toBe(false);
      }
      expect(signal.id).toMatch(/^SIG-[A-Za-z0-9_-]{10}$/);
      expect(
        stopIsOnCorrectSide(signal.side, signal.entry.price as number, signal.stop.price),
      ).toBe(true);
    }
  });

  it('respects the correlation cap across a whole cycle', () => {
    const result = runCycleSeeded(trendingSnapshot, trendingSnapshot.ts);
    expect(result.signals.length).toBeLessThanOrEqual(
      DEFAULT_STRATEGY_CONFIG.portfolio.maxCorrelatedPerCycle * 2,
    );
  });

  it('honours disabled strategies', () => {
    const snapshot = emittingSnapshot();
    const enabled = runCycleSeeded(snapshot, snapshot.ts);
    expect(enabled.signals.length).toBeGreaterThan(0);

    const disabled = runCycleSeeded(snapshot, snapshot.ts, {
      config: {
        ...DEFAULT_STRATEGY_CONFIG,
        enabled: Object.fromEntries(
          Object.keys(DEFAULT_STRATEGY_CONFIG.enabled).map((id) => [id, false]),
        ),
      },
    });
    expect(disabled.signals).toEqual([]);
    expect(disabled.draftCount).toBe(0);
  });

  it('reports drafts, rejections and drops so a quiet engine can be diagnosed', () => {
    const result = runCycleSeeded(trendingSnapshot, trendingSnapshot.ts);
    expect(typeof result.draftCount).toBe('number');
    expect(Array.isArray(result.rejected)).toBe(true);
    expect(Array.isArray(result.conflicts)).toBe(true);
    expect(Array.isArray(result.portfolioDrops)).toBe(true);
    expect(result.regime.label).toBeDefined();
  });
});

describe('replaying real recorded history', () => {
  it('runs end to end over every recorded instrument without throwing', () => {
    let cycles = 0;
    let signals = 0;
    const perStrategy = new Map<string, number>();

    for (const instId of ['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP'] as const) {
      const candles = fixtureCandles(instId, '1H');
      for (let end = 120; end <= candles.length; end += 1) {
        const window = candles.slice(0, end);
        const bar = window[window.length - 1];
        if (bar === undefined) continue;
        const snapshot = snapshotOf(window, { instId, now: bar.ts + 1 });
        const result = runCycleSeeded(snapshot, bar.ts + 1, { state: EMPTY_STATE, seed: end });
        cycles += 1;
        signals += result.signals.length;
        for (const signal of result.signals) {
          perStrategy.set(signal.strategyId, (perStrategy.get(signal.strategyId) ?? 0) + 1);
          expect(() => SignalSchema.parse(signal)).not.toThrow();
        }
      }
    }

    expect(cycles).toBeGreaterThan(500);
    // Not a performance claim — a smoke test. A strategy firing on most bars is reporting a
    // state rather than an event, and would be a defect.
    expect(signals / cycles).toBeLessThan(0.2);
  });
});

describe('rationale interface', () => {
  it('builds a payload carrying the exact inputs and a no-numbers contract', () => {
    const snapshot = emittingSnapshot();
    const result = runCycleSeeded(snapshot, snapshot.ts);
    const signal = result.signals[0];
    expect(signal).toBeDefined();
    if (signal === undefined) return;

    const payload = buildRationalePayload(signal, result.regime);
    expect(payload.signalId).toBe(signal.id);
    expect(payload.inputs).toEqual(signal.inputs);
    expect(payload.contract.returns).toBe('prose');
    expect(payload.contract.mustNotReturn).toContain('position size');
  });

  it('detects a number the model invented', () => {
    const snapshot = emittingSnapshot();
    const result = runCycleSeeded(snapshot, snapshot.ts);
    const signal = result.signals[0];
    if (signal === undefined) return;

    // A figure that appears nowhere in the signal's own inputs must be caught.
    expect(findUnsanctionedNumbers('We expect a move to 999999.5 shortly.', signal)).toContain(
      '999999.5',
    );
    // A figure that IS one of the inputs is fine.
    const adx = signal.inputs['adx'];
    if (adx !== undefined) {
      expect(findUnsanctionedNumbers(`ADX reads ${adx.toFixed(4)}.`, signal)).toEqual([]);
    }
  });
});
