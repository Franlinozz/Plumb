import { describe, expect, it } from 'vitest';

import type { BacktestResult, BacktestTrade } from './engine.js';
import { DEFAULT_CRITERIA, evaluateEligibility, outlierDependence, verifyRecord } from './gate.js';
import { byRegime, computeMetrics, drawdownStats, longestLosingStreak } from './metrics.js';
import { runMonteCarlo } from './monte_carlo.js';
import { renderEquitySvg, renderReport } from './report.js';
import { buildWindows, type WalkForwardResult } from './walkforward.js';

const T0 = Date.parse('2026-05-01T00:00:00Z');
const HOUR = 3_600_000;

function trade(netPnlUsdt: number, i: number, overrides: Partial<BacktestTrade> = {}): BacktestTrade {
  return {
    signalId: `SIG-${String(i).padStart(10, '0')}`,
    strategyId: 'trend_ema',
    instId: 'BTC-USDT-SWAP',
    side: 'long',
    regime: 'trending_up',
    openedAt: T0 + i * HOUR,
    closedAt: T0 + (i + 4) * HOUR,
    holdBars: 4,
    entryPrice: 65_000,
    exitPrice: 65_000 + netPnlUsdt,
    contracts: 0.61,
    notionalUsdt: 400,
    grossPnlUsdt: netPnlUsdt + 0.4,
    feesUsdt: 0.4,
    fundingUsdt: 0,
    netPnlUsdt,
    exitReason: netPnlUsdt > 0 ? 'timeout' : 'stop',
    equityAfter: 400,
    fundingFallbackSettlements: 0,
    ...overrides,
  };
}

/** A hand-computed 10-trade fixture: 4 wins of +3, 6 losses of -1.5. */
const HAND_TRADES: readonly BacktestTrade[] = [
  trade(3, 0),
  trade(-1.5, 1),
  trade(3, 2),
  trade(-1.5, 3),
  trade(-1.5, 4),
  trade(3, 5),
  trade(-1.5, 6),
  trade(-1.5, 7),
  trade(-1.5, 8),
  trade(3, 9),
];

function resultFrom(trades: readonly BacktestTrade[], startingEquity = 400): BacktestResult {
  let equity = startingEquity;
  const stamped = trades.map((t) => {
    equity += t.netPnlUsdt;
    return { ...t, equityAfter: equity };
  });
  return {
    startingEquity,
    finalEquity: equity,
    trades: stamped,
    equityCurve: stamped.map((t) => ({ ts: t.closedAt, equity: t.equityAfter })),
    cycles: stamped.length,
    signalsEmitted: stamped.length,
    gateRejections: {},
    governorVetoes: { max_concurrent: 5 },
    killSwitchTriggers: 0,
    dailyLimitTriggers: 0,
    fundingFallbackSettlements: 0,
    fundingPaidUsdt: 0,
    fundingReceivedUsdt: 0,
    totalFeesUsdt: stamped.reduce((s, t) => s + t.feesUsdt, 0),
    fromTs: stamped[0]?.openedAt ?? T0,
    toTs: stamped.at(-1)?.closedAt ?? T0,
    state: {} as BacktestResult['state'],
  };
}

describe('metrics against a hand-computed 10-trade fixture', () => {
  const m = computeMetrics(resultFrom(HAND_TRADES));

  it('counts trades, wins and losses', () => {
    expect(m.tradeCount).toBe(10);
    expect(m.winRate).toBeCloseTo(40, 10); // 4 of 10
  });

  it('computes gross win, gross loss and profit factor by hand', () => {
    // wins 4 × 3 = 12 ; losses 6 × 1.5 = 9 ; PF = 12 / 9 = 1.3333…
    expect(m.averageWinUsdt).toBeCloseTo(3, 10);
    expect(m.averageLossUsdt).toBeCloseTo(-1.5, 10);
    expect(m.profitFactor).toBeCloseTo(12 / 9, 10);
  });

  it('computes expectancy and total return by hand', () => {
    // net = 12 - 9 = 3 ; expectancy = 3 / 10 = 0.3
    expect(m.totalReturnUsdt).toBeCloseTo(3, 10);
    expect(m.expectancyUsdt).toBeCloseTo(0.3, 10);
    expect(m.finalEquity).toBeCloseTo(403, 10);
  });

  it('finds the largest loss, largest win and longest losing streak', () => {
    expect(m.largestLossUsdt).toBeCloseTo(-1.5, 10);
    expect(m.largestWinUsdt).toBeCloseTo(3, 10);
    // trades 6,7,8 are three consecutive losses
    expect(m.longestLosingStreak).toBe(3);
    expect(longestLosingStreak(HAND_TRADES)).toBe(3);
  });

  it('computes max drawdown by hand', () => {
    // equity: 403, 401.5, 404.5, 403, 401.5, 404.5, 403, 401.5, 400, 403
    // peak 404.5 → trough 400 = 4.5 USDT
    expect(m.maxDrawdownUsdt).toBeCloseTo(4.5, 10);
    expect(m.maxDrawdownPct).toBeCloseTo((4.5 / 404.5) * 100, 8);
    expect(m.minEquity).toBeCloseTo(400, 10);
  });

  it('reports an undefined profit factor as Infinity only when there ARE wins', () => {
    expect(computeMetrics(resultFrom([trade(3, 0), trade(2, 1)])).profitFactor).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(computeMetrics(resultFrom([])).profitFactor).toBe(0);
  });

  it('breaks results down by regime', () => {
    const mixed = [
      trade(3, 0, { regime: 'trending_up' }),
      trade(-1.5, 1, { regime: 'ranging' }),
      trade(-1.5, 2, { regime: 'ranging' }),
    ];
    const breakdown = byRegime(mixed);
    expect(breakdown.find((r) => r.regime === 'ranging')?.trades).toBe(2);
    expect(breakdown.find((r) => r.regime === 'ranging')?.netPnlUsdt).toBeCloseTo(-3, 10);
    expect(breakdown.find((r) => r.regime === 'trending_up')?.winRate).toBe(100);
  });

  it('computes drawdown stats on an empty curve without dividing by zero', () => {
    const d = drawdownStats([], 400);
    expect(d.maxUsdt).toBe(0);
    expect(d.minEquity).toBe(400);
  });
});

describe('walk-forward windows', () => {
  const from = Date.parse('2026-01-01T00:00:00Z');
  const to = Date.parse('2026-07-01T00:00:00Z');
  const windows = buildWindows(from, to, { inSampleDays: 60, outOfSampleDays: 20, stepDays: 20 });

  it('produces rolling windows across the period', () => {
    expect(windows.length).toBeGreaterThan(3);
    expect(windows[0]?.inSampleFrom).toBe(from);
  });

  it('NEVER overlaps in-sample and out-of-sample', () => {
    for (const w of windows) {
      expect(w.outOfSampleFrom).toBe(w.inSampleTo);
      expect(w.outOfSampleFrom).toBeGreaterThanOrEqual(w.inSampleTo);
      expect(w.outOfSampleTo).toBeGreaterThan(w.outOfSampleFrom);
    }
  });

  it('rolls forward by exactly the step', () => {
    for (let i = 1; i < windows.length; i += 1) {
      const gap = (windows[i]?.inSampleFrom ?? 0) - (windows[i - 1]?.inSampleFrom ?? 0);
      expect(gap).toBe(20 * 86_400_000);
    }
  });

  it('never runs past the end of the data', () => {
    for (const w of windows) expect(w.outOfSampleTo).toBeLessThanOrEqual(to);
  });

  it('returns nothing when there is not enough history for one window', () => {
    expect(buildWindows(from, from + 10 * 86_400_000)).toEqual([]);
  });
});

describe('Monte Carlo', () => {
  it('is reproducible with a seed, and differs across seeds', () => {
    const options = { trades: HAND_TRADES, startingEquity: 400, killSwitchEquity: 335, iterations: 500 };
    const a = runMonteCarlo({ ...options, seed: 7 });
    const b = runMonteCarlo({ ...options, seed: 7 });
    const c = runMonteCarlo({ ...options, seed: 8 });
    expect(a.p5Equity).toBe(b.p5Equity);
    expect(a.probabilityOfRuin).toBe(b.probabilityOfRuin);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
  });

  it('orders its percentiles', () => {
    const mc = runMonteCarlo({
      trades: HAND_TRADES,
      startingEquity: 400,
      killSwitchEquity: 335,
      iterations: 2_000,
      seed: 1,
    });
    expect(mc.p5Equity).toBeLessThanOrEqual(mc.p25Equity);
    expect(mc.p25Equity).toBeLessThanOrEqual(mc.medianEquity);
    expect(mc.medianEquity).toBeLessThanOrEqual(mc.p75Equity);
    expect(mc.p75Equity).toBeLessThanOrEqual(mc.p95Equity);
    expect(mc.worstEquity).toBeLessThanOrEqual(mc.p5Equity);
  });

  it('finds a high probability of ruin for a losing strategy', () => {
    const losers = Array.from({ length: 20 }, (_, i) => trade(-4, i));
    const mc = runMonteCarlo({
      trades: losers,
      startingEquity: 400,
      killSwitchEquity: 335,
      iterations: 1_000,
      seed: 3,
      pathLength: 50,
    });
    // 50 trades × -4 = -200, far past the floor. Ruin should be certain.
    expect(mc.probabilityOfRuin).toBeGreaterThan(0.99);
    expect(mc.probabilityBelowStart).toBeGreaterThan(0.99);
  });

  it('finds no ruin for a strategy that cannot reach the floor', () => {
    const mc = runMonteCarlo({
      trades: [trade(1, 0), trade(-0.5, 1)],
      startingEquity: 400,
      killSwitchEquity: 335,
      iterations: 1_000,
      seed: 5,
      pathLength: 10,
    });
    expect(mc.probabilityOfRuin).toBe(0);
  });

  it('handles an empty trade list without pretending it measured something', () => {
    const mc = runMonteCarlo({ trades: [], startingEquity: 400, killSwitchEquity: 335 });
    expect(mc.iterations).toBe(0);
    expect(mc.probabilityOfRuin).toBe(0);
    expect(mc.p5Equity).toBe(400);
  });
});

describe('outlier dependence', () => {
  it('passes when the result survives without its best trade', () => {
    const check = outlierDependence(HAND_TRADES, 400);
    // total +3, best +3 → without it, 0 … which does NOT survive. Honest failure.
    expect(check.total).toBeCloseTo(3, 10);
    expect(check.withoutBest).toBeCloseTo(0, 10);
    expect(check.passed).toBe(false);
  });

  it('FAILS a curve carried by one trade', () => {
    const carried = [trade(50, 0), trade(-2, 1), trade(-2, 2), trade(-2, 3)];
    const check = outlierDependence(carried, 400);
    expect(check.total).toBeCloseTo(44, 10);
    expect(check.withoutBest).toBeCloseTo(-6, 10);
    expect(check.passed).toBe(false);
    expect(check.detail).toContain('carried by one trade');
  });

  it('passes a broadly-based curve', () => {
    const broad = Array.from({ length: 20 }, (_, i) => trade(i % 3 === 0 ? -1 : 1, i));
    const check = outlierDependence(broad, 400);
    expect(check.passed).toBe(true);
    expect(check.withoutBest).toBeGreaterThan(0);
  });

  it('reports honestly when there are no trades', () => {
    expect(outlierDependence([], 400).passed).toBe(false);
  });
});

function walkForwardStub(trades: readonly BacktestTrade[], minEquity = 380): WalkForwardResult {
  const combined = resultFrom(trades);
  const metrics = computeMetrics(combined);
  const windowResult = {
    window: { index: 0, inSampleFrom: T0, inSampleTo: T0 + 1, outOfSampleFrom: T0 + 1, outOfSampleTo: T0 + 2 },
    inSample: { result: combined, metrics },
    outOfSample: { result: combined, metrics: { ...metrics, minEquity } },
  };
  return {
    label: 'stub',
    split: { inSampleDays: 60, outOfSampleDays: 20, stepDays: 20 },
    windows: [windowResult],
    combinedOutOfSample: combined,
    outOfSampleMetrics: metrics,
    inSampleMetrics: metrics,
    degradation: 1,
    overfitVerdict: 'stub',
  };
}

describe('the eligibility gate', () => {
  const mcFor = (trades: readonly BacktestTrade[], pathLength?: number) =>
    runMonteCarlo({
      trades,
      startingEquity: 400,
      killSwitchEquity: 335,
      iterations: 1_000,
      seed: 11,
      ...(pathLength === undefined ? {} : { pathLength }),
    });

  it('REJECTS too few trades, whatever the return says', () => {
    const record = evaluateEligibility({
      walkForward: walkForwardStub(HAND_TRADES),
      monteCarlo: mcFor(HAND_TRADES),
      startingEquity: 400,
      evaluatedAt: T0,
    });
    expect(record.eligible).toBe(false);
    expect(record.failedOn).toContain('sample size');
    const criterion = record.criteria.find((c) => c.name === 'sample size');
    expect(criterion?.detail).toContain('noise, not evidence');
  });

  it('REJECTS an outlier-dependent curve', () => {
    const carried = [
      trade(200, 0),
      ...Array.from({ length: 40 }, (_, i) => trade(-1, i + 1)),
    ];
    const record = evaluateEligibility({
      walkForward: walkForwardStub(carried),
      monteCarlo: mcFor(carried),
      startingEquity: 400,
      evaluatedAt: T0,
    });
    expect(record.eligible).toBe(false);
    expect(record.failedOn).toContain('outlier independence');
  });

  it('REJECTS excessive probability of ruin', () => {
    const losers = Array.from({ length: 40 }, (_, i) => trade(-3, i));
    const record = evaluateEligibility({
      walkForward: walkForwardStub(losers),
      monteCarlo: mcFor(losers, 60),
      startingEquity: 400,
      evaluatedAt: T0,
    });
    expect(record.eligible).toBe(false);
    expect(record.failedOn).toContain('P(ruin)');
    expect(record.failedOn).toContain('profit factor (OOS)');
  });

  it('REJECTS a window that breached the floor', () => {
    const good = Array.from({ length: 40 }, (_, i) => trade(i % 4 === 0 ? -1 : 1, i));
    const record = evaluateEligibility({
      walkForward: walkForwardStub(good, 330), // a window dipped below 335
      monteCarlo: mcFor(good),
      startingEquity: 400,
      evaluatedAt: T0,
    });
    expect(record.eligible).toBe(false);
    expect(record.failedOn).toContain('drawdown floor');
  });

  it('ACCEPTS a config that clears every criterion', () => {
    const good = Array.from({ length: 60 }, (_, i) => trade(i % 4 === 0 ? -1 : 1, i));
    const record = evaluateEligibility({
      walkForward: walkForwardStub(good),
      monteCarlo: mcFor(good),
      startingEquity: 400,
      evaluatedAt: T0,
    });
    expect(record.eligible).toBe(true);
    expect(record.failedOn).toEqual([]);
    expect(record.criteria).toHaveLength(5);
  });

  it('uses the operator-set criteria', () => {
    expect(DEFAULT_CRITERIA.maxProbabilityOfRuin).toBe(0.05);
    expect(DEFAULT_CRITERIA.minOutOfSampleTrades).toBe(30);
    expect(DEFAULT_CRITERIA.minProfitFactor).toBe(1.0);
    expect(DEFAULT_CRITERIA.killSwitchEquity).toBe(335);
  });

  it('signs the record, and the signature detects tampering', () => {
    const good = Array.from({ length: 60 }, (_, i) => trade(i % 4 === 0 ? -1 : 1, i));
    const record = evaluateEligibility({
      walkForward: walkForwardStub(good),
      monteCarlo: mcFor(good),
      startingEquity: 400,
      evaluatedAt: T0,
    });
    expect(verifyRecord(record)).toBe(true);

    // Hand-editing "eligible" to true must not survive verification.
    const forged = { ...record, eligible: !record.eligible };
    expect(verifyRecord(forged)).toBe(false);
    const forgedFail = { ...record, failedOn: [] };
    expect(verifyRecord(forgedFail)).toBe(record.failedOn.length === 0);
  });
});

describe('the report', () => {
  const good = Array.from({ length: 60 }, (_, i) => trade(i % 4 === 0 ? -1 : 1, i));
  const wf = walkForwardStub(good);
  const mc = runMonteCarlo({ trades: good, startingEquity: 400, killSwitchEquity: 335, iterations: 500, seed: 2 });
  const record = evaluateEligibility({
    walkForward: wf,
    monteCarlo: mc,
    startingEquity: 400,
    evaluatedAt: T0,
  });
  const markdown = renderReport({
    title: 'test run',
    walkForward: wf,
    monteCarlo: mc,
    eligibility: record,
    costs: { takerRate: 0.0005, baseSlippageBps: 1, notionalSlippageBps: 2, referenceNotionalUsdt: 400, volatilitySlippageCoeff: 0.05, fundingFallbackRate: 0.0001 },
    generatedAt: T0,
    dataFrom: T0,
    dataTo: T0 + 86_400_000,
  });

  it('leads with max drawdown', () => {
    const ddIndex = markdown.indexOf('Max drawdown');
    const returnIndex = markdown.indexOf('Total return');
    expect(ddIndex).toBeGreaterThan(-1);
    expect(ddIndex).toBeLessThan(returnIndex);
  });

  it('states the cost assumptions and the walk-forward split', () => {
    expect(markdown).toContain('Cost assumptions');
    expect(markdown).toContain('60d in-sample / 20d out-of-sample');
    expect(markdown).toContain('WORSE');
  });

  it('has an explicit "what this does not prove" section', () => {
    expect(markdown).toContain('## What this does not prove');
    expect(markdown).toContain('It is not a prediction');
    expect(markdown).toContain('Fills are modelled, not observed');
  });

  it('embeds a self-contained SVG with no external references', () => {
    expect(markdown).toContain('<svg');
    const svg = markdown.slice(markdown.indexOf('<svg'), markdown.indexOf('</svg>'));
    // The ONLY URL permitted inside the SVG is the W3C namespace, which is an identifier and
    // never fetched. Anything else would mean the report needs the network to be read.
    const urls = [...svg.matchAll(/https?:\/\/[^"'\s>]+/g)].map((m) => m[0]);
    expect(urls).toEqual(['http://www.w3.org/2000/svg']);
    expect(svg).not.toContain('<script');
    expect(svg).toContain('kill switch 335');
  });

  it('renders an SVG even for a degenerate curve', () => {
    expect(renderEquitySvg([], 400)).toContain('<svg');
    expect(renderEquitySvg([{ ts: T0, equity: 400 }], 400)).toContain('too few points');
  });

  it('states the eligibility verdict at the top', () => {
    expect(markdown.slice(0, 400)).toMatch(/ELIGIBLE|NOT ELIGIBLE/);
  });
});
