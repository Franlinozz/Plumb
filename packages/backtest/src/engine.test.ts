import type { Instrument } from '@plumb/core';
import { fixtureCandles, type Candle } from '@plumb/market';
import { describe, expect, it } from 'vitest';

import { DEFAULT_COSTS, ZERO_COSTS } from './costs.js';
import {
  LookaheadError,
  SeriesAlignmentError,
  assertNoLookahead,
  runBacktest,
  type BacktestOptions,
} from './engine.js';
import { computeMetrics } from './metrics.js';
import { PERMISSIVE_CONFIG, permissiveStrategy } from './testkit.js';

/** The harness driven by a strategy that fires constantly, so vetoes actually happen. */
function runPermissive(overrides: Partial<BacktestOptions> = {}) {
  return runBacktest({
    candles: candles(),
    lookbackBars: 120,
    modules: [permissiveStrategy],
    strategyConfig: PERMISSIVE_CONFIG,
    ...overrides,
  });
}

const INSTRUMENTS: readonly Instrument[] = ['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP'];

function candles(): Record<string, readonly Candle[]> {
  return Object.fromEntries(INSTRUMENTS.map((i) => [i, fixtureCandles(i, '1H')]));
}

function run(overrides: Partial<BacktestOptions> = {}) {
  return runBacktest({ candles: candles(), lookbackBars: 120, ...overrides });
}

describe('lookahead detection', () => {
  it('throws when a window contains a bar after the current one', () => {
    const series = fixtureCandles('BTC-USDT-SWAP', '1H');
    const window = series.slice(0, 50);
    const current = window[40] as Candle;

    // The window legitimately ends at its own last bar.
    expect(() => assertNoLookahead(window, (window.at(-1) as Candle).ts)).not.toThrow();

    // But if the "current" bar is earlier than the window's end, bars 41..49 are the future.
    expect(() => assertNoLookahead(window, current.ts)).toThrow(LookaheadError);
    expect(() => assertNoLookahead(window, current.ts)).toThrow(/lookahead/);
  });

  it('CATCHES A DELIBERATELY CHEATING STRATEGY', () => {
    // A cheat is a window that reaches past the current bar. The engine's own assertion is what
    // stands between a bug and a wonderful, worthless result — so hand it a cheat directly.
    const series = fixtureCandles('BTC-USDT-SWAP', '1H');
    const honest = series.slice(0, 100);
    const cheating = series.slice(0, 101); // one bar into the future
    const currentTs = (honest.at(-1) as Candle).ts;

    expect(() => assertNoLookahead(honest, currentTs, 'honest')).not.toThrow();
    expect(() => assertNoLookahead(cheating, currentTs, 'cheat')).toThrow(LookaheadError);
  });

  it('never hands the strategy a bar it should not have seen, across a whole replay', () => {
    let windows = 0;
    let worstOvershoot = Number.NEGATIVE_INFINITY;
    run({
      onWindow: (_instId, window, currentTs) => {
        windows += 1;
        for (const candle of window) worstOvershoot = Math.max(worstOvershoot, candle.ts - currentTs);
      },
    });
    expect(windows).toBeGreaterThan(100);
    // The newest bar in the window IS the current bar — never later.
    expect(worstOvershoot).toBe(0);
  });

  it('gives the strategy exactly the configured lookback, no more', () => {
    const sizes = new Set<number>();
    run({ lookbackBars: 150, onWindow: (_i, window) => sizes.add(window.length) });
    expect([...sizes]).toEqual([150]);
  });

  it('fails closed when instrument series are not aligned by timestamp', () => {
    const input = candles();
    const eth = input['ETH-USDT-SWAP'] as readonly Candle[];
    const shifted = eth.map((candle, index) =>
      index === 120 ? { ...candle, ts: candle.ts + 3_600_000 } : candle,
    );
    expect(() =>
      runBacktest({
        candles: { ...input, 'ETH-USDT-SWAP': shifted },
        lookbackBars: 120,
      }),
    ).toThrow(SeriesAlignmentError);
  });
});

describe('the governor is genuinely in the loop', () => {
  it('records non-zero veto counts on a permissive strategy', () => {
    // If the governor were bypassed this would be zero, and the whole backtest would be measuring
    // a system we will never run.
    const result = runPermissive();
    expect(result.signalsEmitted).toBeGreaterThan(10);
    const vetoTotal = Object.values(result.governorVetoes).reduce((a, b) => a + b, 0);
    expect(vetoTotal).toBeGreaterThan(0);
    expect(Object.keys(result.governorVetoes)).toContain('max_concurrent');
  });

  it('never opens more positions than the locked concurrency limit', () => {
    const result = runPermissive();
    expect(result.state.openPositions.length).toBeLessThanOrEqual(2);
    expect(result.trades.length).toBeGreaterThan(5);
  });

  it('routes every trade through a signal — no trade exists without one', () => {
    const result = runPermissive();
    for (const trade of result.trades) {
      expect(trade.signalId).toMatch(/^SIG-/);
      expect(trade.strategyId.length).toBeGreaterThan(0);
    }
    expect(result.trades.length).toBeLessThanOrEqual(result.signalsEmitted);
  });
});

describe('the cost model changes the result in the expected direction', () => {
  it('charges real costs under the full model and none under the zero model', () => {
    const free = runPermissive({ costs: ZERO_COSTS });
    const paid = runPermissive({ costs: DEFAULT_COSTS });

    expect(paid.totalFeesUsdt).toBeGreaterThan(0);
    expect(free.totalFeesUsdt).toBe(0);
    expect(free.trades.every((t) => t.feesUsdt === 0 && t.fundingUsdt === 0)).toBe(true);
  });

  it('every cost strictly reduces the PnL of the trade it belongs to', () => {
    // NOTE: costs cannot be asserted to worsen the FINAL EQUITY of a run. Slippage moves fill
    // prices, which moves when stops trigger, which produces a different set of trades — the two
    // runs are not the same experiment. What IS guaranteed is per-trade: fees and funding are
    // subtracted from gross, always, and never added.
    const paid = runPermissive({ costs: DEFAULT_COSTS });
    expect(paid.trades.length).toBeGreaterThan(5);
    for (const trade of paid.trades) {
      expect(trade.feesUsdt).toBeGreaterThan(0);
      expect(trade.netPnlUsdt).toBeLessThan(trade.grossPnlUsdt);
      expect(trade.netPnlUsdt).toBeCloseTo(trade.grossPnlUsdt - trade.feesUsdt - trade.fundingUsdt, 8);
    }
    const totalCosts = paid.trades.reduce((s, t) => s + t.feesUsdt + t.fundingUsdt, 0);
    const totalGross = paid.trades.reduce((s, t) => s + t.grossPnlUsdt, 0);
    const totalNet = paid.trades.reduce((s, t) => s + t.netPnlUsdt, 0);
    expect(totalNet).toBeCloseTo(totalGross - totalCosts, 6);
    expect(totalCosts).toBeGreaterThan(0);
  });

  it('charges fees on both sides of every trade', () => {
    const result = runPermissive();
    for (const trade of result.trades) {
      expect(trade.feesUsdt).toBeGreaterThan(0);
      // Two taker fills at ~0.05% each on the notional.
      const expected = trade.notionalUsdt * DEFAULT_COSTS.takerRate * 2;
      expect(trade.feesUsdt).toBeGreaterThan(expected * 0.8);
      expect(trade.feesUsdt).toBeLessThan(expected * 1.3);
    }
  });

  it('books net PnL as gross minus fees minus funding', () => {
    for (const trade of runPermissive().trades) {
      expect(trade.netPnlUsdt).toBeCloseTo(trade.grossPnlUsdt - trade.feesUsdt - trade.fundingUsdt, 8);
    }
  });
});

describe('replay mechanics', () => {
  it('is deterministic', () => {
    const a = run();
    const b = run();
    expect(a.finalEquity).toBe(b.finalEquity);
    expect(a.trades.length).toBe(b.trades.length);
    expect(JSON.stringify(a.trades)).toBe(JSON.stringify(b.trades));
  });

  it('produces an equity curve and closes everything by the end', () => {
    const result = run();
    expect(result.equityCurve.length).toBeGreaterThan(100);
    expect(result.state.openPositions).toEqual([]);
    // An open position is not a result.
    expect(result.trades.every((t) => t.closedAt >= t.openedAt)).toBe(true);
  });

  it('honours a time window', () => {
    const all = run();
    const cutoff = all.fromTs + (all.toTs - all.fromTs) / 2;
    const half = runPermissive({ fromTs: all.fromTs, toTs: cutoff });
    expect(half.cycles).toBeLessThan(all.cycles);
    expect(half.toTs).toBeLessThanOrEqual(cutoff);
    expect(half.trades.length).toBeGreaterThan(0);
    expect(half.trades.every((trade) => trade.openedAt <= cutoff)).toBe(true);
    expect(half.trades.every((trade) => trade.closedAt <= cutoff)).toBe(true);
    expect(half.trades.every((trade) => trade.holdBars <= PERMISSIVE_CONFIG.maxHoldBars)).toBe(true);
  });

  it('fills entries at the NEXT bar open, not the signal bar close', () => {
    const series = fixtureCandles('BTC-USDT-SWAP', '1H');
    const byTs = new Map(series.map((c) => [c.ts, c]));
    for (const trade of runPermissive().trades.filter((t) => t.instId === 'BTC-USDT-SWAP')) {
      const bar = byTs.get(trade.openedAt);
      if (bar === undefined) continue;
      // Entry price is that bar's open, moved against us by slippage.
      const drift = Math.abs(trade.entryPrice - bar.open) / bar.open;
      expect(drift).toBeLessThan(0.01);
      if (trade.side === 'long') expect(trade.entryPrice).toBeGreaterThanOrEqual(bar.open);
      else expect(trade.entryPrice).toBeLessThanOrEqual(bar.open);
    }
  });

  it('metrics are computable and internally consistent', () => {
    const result = run();
    const m = computeMetrics(result);
    expect(m.tradeCount).toBe(result.trades.length);
    expect(m.finalEquity).toBe(result.finalEquity);
    expect(m.maxDrawdownUsdt).toBeGreaterThanOrEqual(0);
    expect(m.winRate).toBeGreaterThanOrEqual(0);
    expect(m.winRate).toBeLessThanOrEqual(100);
  });
});
