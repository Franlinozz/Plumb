/**
 * Synthetic market builders for tests and probes.
 *
 * Pure and deterministic — a seeded PRNG, no clock, no I/O — so this file passes the same purity
 * scan as the rest of the package. It ships in `dist` because `@plumb/backtest` will want the
 * same generators in P4 for stress cases that history does not contain.
 *
 * These are CONSTRUCTED markets, not real ones. They exist to prove that a strategy fires when its
 * conditions hold and stays silent when they do not. They are never evidence of edge.
 */

import {
  TIMEFRAME_MS,
  snapshotFromCandles,
  type Candle,
  type FundingRateHistoryEntry,
  type MarketSnapshot,
  type Timeframe,
} from '@plumb/market';
import type { Instrument } from '@plumb/core';

/** mulberry32 — small, fast, and identical across runs. Not a security primitive. */
export function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SyntheticSpec {
  readonly bars: number;
  readonly startPrice: number;
  /** Fractional drift per bar, compounded. 0.002 ≈ +0.2% a bar. */
  readonly drift: number;
  /** Per-bar drift, overriding `drift`. Lets a series turn — which is where EMAs cross. */
  readonly driftAt?: (index: number, bars: number) => number;
  /** Fractional amplitude of the oscillation. */
  readonly amplitude: number;
  /** Oscillation period, in bars. */
  readonly period: number;
  /** Fractional noise added per bar. */
  readonly noise: number;
  /** Bar range as a fraction of price. */
  readonly barRange: number;
  /** Multiplies `barRange`, `noise` and `amplitude` per bar — compresses or expands the tape. */
  readonly volScale?: (index: number, bars: number) => number;
  /** Every Nth bar gets an outsized excursion — what actually reaches a Bollinger band. */
  readonly spikeEvery?: number;
  /** Fractional size of that excursion. */
  readonly spikeSize?: number;
  readonly seed?: number;
  readonly timeframe?: Timeframe;
  readonly endTs?: number;
}

/**
 * Deterministic candles matching `spec`. Chronological, all closed.
 *
 * Drift COMPOUNDS rather than accumulating linearly, both because that is how prices move and
 * because `driftAt` then lets a series genuinely reverse — a linear ramp never turns, so EMAs
 * never cross, so a cross-based strategy has nothing to detect.
 */
export function syntheticCandles(spec: SyntheticSpec): readonly Candle[] {
  const tf = spec.timeframe ?? '1H';
  const step = TIMEFRAME_MS[tf];
  const endTs = spec.endTs ?? Date.parse('2026-08-01T00:00:00Z');
  const random = prng(spec.seed ?? 7);
  const scale = spec.volScale ?? (() => 1);
  const driftAt = spec.driftAt ?? (() => spec.drift);

  const out: Candle[] = [];
  let base = spec.startPrice;
  for (let i = 0; i < spec.bars; i += 1) {
    base *= 1 + driftAt(i, spec.bars);
    const k = scale(i, spec.bars);
    const wave = base * spec.amplitude * Math.sin((2 * Math.PI * i) / spec.period) * k;
    const jitter = base * spec.noise * (random() - 0.5) * 2 * k;
    const spike =
      spec.spikeEvery !== undefined && spec.spikeSize !== undefined && i % spec.spikeEvery === 0
        ? base * spec.spikeSize * (random() < 0.5 ? -1 : 1)
        : 0;
    const close = base + wave + jitter + spike;
    const half = Math.abs(close) * spec.barRange * k * 0.5;
    const open = i === 0 ? close : (out[i - 1] as Candle).close;
    out.push(
      Object.freeze({
        ts: endTs - (spec.bars - 1 - i) * step,
        open,
        high: Math.max(open, close) + half,
        low: Math.min(open, close) - half,
        close,
        volume: 1_000,
        volumeCcy: 10,
        volumeQuote: close * 1_000,
        closed: true,
      }),
    );
  }
  return Object.freeze(out);
}

export interface SnapshotSpec {
  readonly instId?: Instrument;
  readonly timeframe?: Timeframe;
  readonly now?: number;
  readonly fundingRate?: number;
  readonly fundingHistory?: readonly number[];
}

/** Wrap candles in a MarketSnapshot. Never degraded — replayed data is old, not stale. */
export function snapshotOf(
  candles: readonly Candle[],
  spec: SnapshotSpec = {},
): MarketSnapshot {
  const tf = spec.timeframe ?? '1H';
  const last = candles[candles.length - 1];
  const now = spec.now ?? (last?.ts ?? 0) + TIMEFRAME_MS[tf];
  const history: FundingRateHistoryEntry[] = (spec.fundingHistory ?? []).map((rate, i) => ({
    instId: spec.instId ?? 'BTC-USDT-SWAP',
    fundingRate: rate,
    realizedRate: rate,
    fundingTime: now - (i + 1) * 28_800_000,
  }));

  return snapshotFromCandles({
    now,
    instId: spec.instId ?? 'BTC-USDT-SWAP',
    candles: [{ tf, ohlcv: candles }],
    fundingRate: spec.fundingRate ?? 0,
    fundingHistory: history,
  });
}

/**
 * Regime fixtures.
 *
 * Each spec was found by probe (`scripts/probe-regimes.mjs`) and then PINNED by a test asserting
 * the label it produces. If a classifier change moves one of these, the test fails and the change
 * has to be justified — which is the point.
 */
export const REGIME_SPECS = Object.freeze({
  trending_up: Object.freeze<SyntheticSpec>({
    bars: 200,
    startPrice: 100,
    drift: 0.004,
    amplitude: 0.002,
    period: 11,
    noise: 0.0008,
    barRange: 0.004,
    seed: 11,
  }),
  trending_down: Object.freeze<SyntheticSpec>({
    bars: 200,
    startPrice: 100,
    drift: -0.004,
    amplitude: 0.002,
    period: 11,
    noise: 0.0008,
    barRange: 0.004,
    seed: 12,
  }),
  ranging: Object.freeze<SyntheticSpec>({
    bars: 200,
    startPrice: 100,
    drift: 0,
    amplitude: 0.012,
    period: 9,
    noise: 0.003,
    barRange: 0.008,
    seed: 13,
  }),
  compressed: Object.freeze<SyntheticSpec>({
    bars: 200,
    startPrice: 100,
    drift: 0,
    amplitude: 0.012,
    period: 9,
    noise: 0.003,
    barRange: 0.008,
    seed: 14,
    volScale: (i, n) => (i > n - 25 ? 0.1 : 1),
  }),
  expanding: Object.freeze<SyntheticSpec>({
    bars: 200,
    startPrice: 100,
    drift: 0,
    amplitude: 0.006,
    period: 9,
    noise: 0.002,
    barRange: 0.006,
    seed: 15,
    volScale: (i, n) => (i > n - 12 ? 6 : 1),
  }),
  /**
   * A GENUINELY ambiguous market: ADX 24.4, inside the dead zone between the ranging ceiling (20)
   * and the trending floor (25), with bandwidth and ATR both unremarkable so nothing breaks the
   * tie. Found by `scripts/probe-regimes.mjs`. This must classify as `unclear` — rounding it to
   * the nearer label would be inventing a view, and downstream it would licence a real trade.
   */
  unclear: Object.freeze<SyntheticSpec>({
    bars: 200,
    startPrice: 100,
    drift: 0.0006,
    amplitude: 0.006,
    period: 13,
    noise: 0.002,
    barRange: 0.006,
    seed: 129,
  }),
});

/**
 * Markets built to contain the specific EVENT a strategy looks for.
 *
 * A regime fixture is not enough: `trend_ema` needs an actual EMA cross, and a linear ramp never
 * produces one however trending it is. Each of these was verified by `scripts/probe-strategies.mjs`
 * and is pinned by a test asserting the strategy fires on it.
 */
export const EVENT_SPECS = Object.freeze({
  /** Falls, then turns and runs — the EMAs cross on the way up while ADX is still high. */
  trendCross: Object.freeze<SyntheticSpec>({
    bars: 260,
    startPrice: 100,
    drift: 0,
    driftAt: (i, bars) => (i < bars * 0.55 ? -0.004 : 0.006),
    amplitude: 0.003,
    period: 11,
    noise: 0.001,
    barRange: 0.005,
    seed: 31,
  }),
  /**
   * A range punctuated by excursions large enough to reach the bands WHILE the regime is still
   * ranging. Found by a 1,800-point parameter search (`scripts/probe-strategies.mjs` documents
   * the shape) and it fires exactly once in 91 bars — which is the honest picture of this
   * strategy, not a fixture weakness. See the P2 checkpoint on `revert_band`'s reachability.
   */
  bandTouch: Object.freeze<SyntheticSpec>({
    bars: 220,
    startPrice: 100,
    drift: 0,
    amplitude: 0.022,
    period: 16,
    noise: 0.005,
    barRange: 0.003,
    spikeEvery: 17,
    spikeSize: 0.035,
    seed: 57,
  }),
  /** Compression, then a decisive directional push clear of the prior range. */
  rangeBreak: Object.freeze<SyntheticSpec>({
    bars: 240,
    startPrice: 100,
    drift: 0,
    driftAt: (i, bars) => (i > bars - 8 ? 0.012 : 0),
    amplitude: 0.004,
    period: 9,
    noise: 0.0015,
    barRange: 0.004,
    volScale: (i, bars) => (i > bars - 40 && i <= bars - 8 ? 0.35 : 1),
    seed: 77,
  }),
});
