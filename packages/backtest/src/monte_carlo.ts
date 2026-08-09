/**
 * MONTE CARLO — a distribution of outcomes, not one path.
 *
 * The single equity curve a backtest produces is one ordering of the trades that happened to
 * occur. Reshuffling that sequence 10,000 times answers a different and far more useful question:
 * how bad could this have looked, given the same trades in a different order?
 *
 * **THE 5TH PERCENTILE IS THE NUMBER THAT MATTERS.** A strategy with a great average and a 20%
 * chance of hitting the kill switch is not eligible, and an average tells you nothing about that.
 *
 * Seeded, so a result is reproducible from the seed rather than being a story that changes each
 * time it is told.
 */

import type { BacktestTrade } from './engine.js';

export interface MonteCarloOptions {
  readonly trades: readonly BacktestTrade[];
  readonly startingEquity: number;
  readonly killSwitchEquity: number;
  readonly iterations?: number;
  readonly seed?: number;
  /** How many trades each path draws. Defaults to the observed trade count. */
  readonly pathLength?: number;
}

export interface MonteCarloResult {
  readonly iterations: number;
  readonly pathLength: number;
  readonly seed: number;
  readonly p5Equity: number;
  readonly p25Equity: number;
  readonly medianEquity: number;
  readonly p75Equity: number;
  readonly p95Equity: number;
  readonly meanEquity: number;
  readonly worstEquity: number;
  /** THE gate number: how often a path ever touched the kill switch. */
  readonly probabilityOfRuin: number;
  readonly probabilityBelowStart: number;
  readonly p5MaxDrawdownPct: number;
  readonly medianMaxDrawdownPct: number;
  readonly worstMaxDrawdownPct: number;
}

/** mulberry32 — small, fast, identical across runs. Not a security primitive. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function runMonteCarlo(options: MonteCarloOptions): MonteCarloResult {
  const iterations = options.iterations ?? 10_000;
  const seed = options.seed ?? 424242;
  const trades = options.trades;
  const pathLength = options.pathLength ?? trades.length;
  const random = prng(seed);

  const finals: number[] = [];
  const drawdowns: number[] = [];
  let ruinCount = 0;
  let belowStartCount = 0;

  if (trades.length === 0) {
    return {
      iterations: 0,
      pathLength: 0,
      seed,
      p5Equity: options.startingEquity,
      p25Equity: options.startingEquity,
      medianEquity: options.startingEquity,
      p75Equity: options.startingEquity,
      p95Equity: options.startingEquity,
      meanEquity: options.startingEquity,
      worstEquity: options.startingEquity,
      probabilityOfRuin: 0,
      probabilityBelowStart: 0,
      p5MaxDrawdownPct: 0,
      medianMaxDrawdownPct: 0,
      worstMaxDrawdownPct: 0,
    };
  }

  for (let i = 0; i < iterations; i += 1) {
    let equity = options.startingEquity;
    let peak = equity;
    let maxDd = 0;
    let ruined = false;

    for (let step = 0; step < pathLength; step += 1) {
      // Resample WITH replacement: the observed sequence is one sample from a distribution,
      // not the distribution itself.
      const pick = trades[Math.floor(random() * trades.length)] as BacktestTrade;
      equity += pick.netPnlUsdt;
      if (equity > peak) peak = equity;
      const dd = peak === 0 ? 0 : ((peak - equity) / peak) * 100;
      if (dd > maxDd) maxDd = dd;
      if (equity <= options.killSwitchEquity) {
        ruined = true;
        break; // the kill switch halts trading — the path ends here, as it would in reality
      }
    }

    if (ruined) ruinCount += 1;
    if (equity < options.startingEquity) belowStartCount += 1;
    finals.push(equity);
    drawdowns.push(maxDd);
  }

  finals.sort((a, b) => a - b);
  drawdowns.sort((a, b) => a - b);

  return {
    iterations,
    pathLength,
    seed,
    p5Equity: percentile(finals, 0.05),
    p25Equity: percentile(finals, 0.25),
    medianEquity: percentile(finals, 0.5),
    p75Equity: percentile(finals, 0.75),
    p95Equity: percentile(finals, 0.95),
    meanEquity: finals.reduce((a, b) => a + b, 0) / finals.length,
    worstEquity: finals[0] as number,
    probabilityOfRuin: ruinCount / iterations,
    probabilityBelowStart: belowStartCount / iterations,
    p5MaxDrawdownPct: percentile(drawdowns, 0.05),
    medianMaxDrawdownPct: percentile(drawdowns, 0.5),
    worstMaxDrawdownPct: drawdowns[drawdowns.length - 1] as number,
  };
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[index] as number;
}
