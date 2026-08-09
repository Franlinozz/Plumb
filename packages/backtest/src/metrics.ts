/**
 * METRICS — all of them, never a curated subset.
 *
 * The headline is MAX DRAWDOWN, printed first, because it is the number that decides whether a
 * strategy can be traded at all. Return is what a strategy earns; drawdown is what it costs to
 * find out. Reporting the second only when it flatters is how backtests mislead.
 */

import type { BacktestResult, BacktestTrade, EquityPoint } from './engine.js';

export interface Metrics {
  // ── the headline ──────────────────────────────────────────────────────────────────────────
  readonly maxDrawdownUsdt: number;
  readonly maxDrawdownPct: number;
  readonly minEquity: number;
  readonly longestDrawdownBars: number;
  readonly longestDrawdownDays: number;

  // ── returns ───────────────────────────────────────────────────────────────────────────────
  readonly startingEquity: number;
  readonly finalEquity: number;
  readonly totalReturnUsdt: number;
  readonly totalReturnPct: number;
  readonly cagrPct: number;
  readonly days: number;

  // ── risk-adjusted ─────────────────────────────────────────────────────────────────────────
  readonly sharpe: number;
  readonly sortino: number;
  readonly calmar: number;

  // ── trades ────────────────────────────────────────────────────────────────────────────────
  readonly tradeCount: number;
  readonly winRate: number;
  readonly averageWinUsdt: number;
  readonly averageLossUsdt: number;
  readonly profitFactor: number;
  readonly expectancyUsdt: number;
  readonly largestLossUsdt: number;
  readonly largestWinUsdt: number;
  readonly longestLosingStreak: number;
  readonly averageHoldBars: number;

  // ── costs ─────────────────────────────────────────────────────────────────────────────────
  readonly totalFeesUsdt: number;
  readonly fundingPaidUsdt: number;
  readonly fundingReceivedUsdt: number;
  readonly fundingFallbackSettlements: number;

  // ── governor ──────────────────────────────────────────────────────────────────────────────
  readonly pctTimeBelowStartingCapital: number;
  readonly governorVetoes: Readonly<Record<string, number>>;
  readonly gateRejections: Readonly<Record<string, number>>;
  readonly killSwitchTriggers: number;
  readonly dailyLimitTriggers: number;
  readonly signalsEmitted: number;
  readonly cycles: number;
}

export interface RegimeBreakdown {
  readonly regime: string;
  readonly trades: number;
  readonly winRate: number;
  readonly netPnlUsdt: number;
  readonly profitFactor: number;
  readonly expectancyUsdt: number;
}

export interface StrategyBreakdown {
  readonly strategyId: string;
  readonly trades: number;
  readonly winRate: number;
  readonly netPnlUsdt: number;
  readonly profitFactor: number;
}

const MS_PER_DAY = 86_400_000;

export function computeMetrics(result: BacktestResult): Metrics {
  const { trades, equityCurve, startingEquity } = result;
  const drawdown = drawdownStats(equityCurve, startingEquity);
  const days = Math.max((result.toTs - result.fromTs) / MS_PER_DAY, 1 / 24);

  const wins = trades.filter((t) => t.netPnlUsdt > 0);
  const losses = trades.filter((t) => t.netPnlUsdt <= 0);
  const grossWin = wins.reduce((s, t) => s + t.netPnlUsdt, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netPnlUsdt, 0));

  const returns = periodReturns(equityCurve);
  const totalReturnUsdt = result.finalEquity - startingEquity;

  return {
    maxDrawdownUsdt: drawdown.maxUsdt,
    maxDrawdownPct: drawdown.maxPct,
    minEquity: drawdown.minEquity,
    longestDrawdownBars: drawdown.longestBars,
    longestDrawdownDays: drawdown.longestDays,

    startingEquity,
    finalEquity: result.finalEquity,
    totalReturnUsdt,
    totalReturnPct: startingEquity === 0 ? 0 : (totalReturnUsdt / startingEquity) * 100,
    cagrPct: cagr(startingEquity, result.finalEquity, days),
    days,

    sharpe: sharpeRatio(returns),
    sortino: sortinoRatio(returns),
    calmar: drawdown.maxPct === 0 ? 0 : cagr(startingEquity, result.finalEquity, days) / drawdown.maxPct,

    tradeCount: trades.length,
    winRate: trades.length === 0 ? 0 : (wins.length / trades.length) * 100,
    averageWinUsdt: wins.length === 0 ? 0 : grossWin / wins.length,
    averageLossUsdt: losses.length === 0 ? 0 : -grossLoss / losses.length,
    // A strategy with no losses has an undefined profit factor, not an infinite one. Reporting
    // Infinity would let a 2-trade sample look like the best system ever built.
    profitFactor: grossLoss === 0 ? (grossWin > 0 ? Number.POSITIVE_INFINITY : 0) : grossWin / grossLoss,
    expectancyUsdt: trades.length === 0 ? 0 : totalNet(trades) / trades.length,
    largestLossUsdt: losses.length === 0 ? 0 : Math.min(...losses.map((t) => t.netPnlUsdt)),
    largestWinUsdt: wins.length === 0 ? 0 : Math.max(...wins.map((t) => t.netPnlUsdt)),
    longestLosingStreak: longestLosingStreak(trades),
    averageHoldBars: trades.length === 0 ? 0 : trades.reduce((s, t) => s + t.holdBars, 0) / trades.length,

    totalFeesUsdt: result.totalFeesUsdt,
    fundingPaidUsdt: result.fundingPaidUsdt,
    fundingReceivedUsdt: result.fundingReceivedUsdt,
    fundingFallbackSettlements: result.fundingFallbackSettlements,

    pctTimeBelowStartingCapital:
      equityCurve.length === 0
        ? 0
        : (equityCurve.filter((p) => p.equity < startingEquity).length / equityCurve.length) * 100,
    governorVetoes: result.governorVetoes,
    gateRejections: result.gateRejections,
    killSwitchTriggers: result.killSwitchTriggers,
    dailyLimitTriggers: result.dailyLimitTriggers,
    signalsEmitted: result.signalsEmitted,
    cycles: result.cycles,
  };
}

function totalNet(trades: readonly BacktestTrade[]): number {
  return trades.reduce((s, t) => s + t.netPnlUsdt, 0);
}

export interface DrawdownStats {
  readonly maxUsdt: number;
  readonly maxPct: number;
  readonly minEquity: number;
  readonly longestBars: number;
  readonly longestDays: number;
}

export function drawdownStats(curve: readonly EquityPoint[], startingEquity: number): DrawdownStats {
  if (curve.length === 0) {
    return { maxUsdt: 0, maxPct: 0, minEquity: startingEquity, longestBars: 0, longestDays: 0 };
  }
  let peak = startingEquity;
  let peakTs = curve[0]?.ts ?? 0;
  let maxUsdt = 0;
  let maxPct = 0;
  let minEquity = startingEquity;
  let longestBars = 0;
  let longestMs = 0;
  let barsSincePeak = 0;

  for (const point of curve) {
    if (point.equity >= peak) {
      peak = point.equity;
      peakTs = point.ts;
      barsSincePeak = 0;
    } else {
      barsSincePeak += 1;
      longestBars = Math.max(longestBars, barsSincePeak);
      longestMs = Math.max(longestMs, point.ts - peakTs);
    }
    const dd = peak - point.equity;
    if (dd > maxUsdt) {
      maxUsdt = dd;
      maxPct = peak === 0 ? 0 : (dd / peak) * 100;
    }
    minEquity = Math.min(minEquity, point.equity);
  }
  return { maxUsdt, maxPct, minEquity, longestBars, longestDays: longestMs / MS_PER_DAY };
}

function periodReturns(curve: readonly EquityPoint[]): readonly number[] {
  const out: number[] = [];
  for (let i = 1; i < curve.length; i += 1) {
    const prev = curve[i - 1]?.equity ?? 0;
    const curr = curve[i]?.equity ?? 0;
    if (prev > 0) out.push(curr / prev - 1);
  }
  return out;
}

function cagr(start: number, end: number, days: number): number {
  if (start <= 0 || end <= 0 || days <= 0) return 0;
  return ((end / start) ** (365 / days) - 1) * 100;
}

/**
 * Sharpe, annualised from hourly bars, with a zero risk-free rate.
 *
 * Stated plainly because Sharpe on a small trade count is close to meaningless — the report
 * prints it alongside the trade count for exactly that reason.
 */
export function sharpeRatio(returns: readonly number[], periodsPerYear = 24 * 365): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  const sd = Math.sqrt(variance);
  return sd === 0 ? 0 : (mean / sd) * Math.sqrt(periodsPerYear);
}

export function sortinoRatio(returns: readonly number[], periodsPerYear = 24 * 365): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const downside = returns.filter((r) => r < 0);
  if (downside.length === 0) return 0;
  const dd = Math.sqrt(downside.reduce((s, r) => s + r ** 2, 0) / returns.length);
  return dd === 0 ? 0 : (mean / dd) * Math.sqrt(periodsPerYear);
}

export function longestLosingStreak(trades: readonly BacktestTrade[]): number {
  let longest = 0;
  let current = 0;
  for (const trade of trades) {
    if (trade.netPnlUsdt <= 0) {
      current += 1;
      longest = Math.max(longest, current);
    } else current = 0;
  }
  return longest;
}

/** Where each strategy actually works — the breakdown that tells us what to keep. */
export function byRegime(trades: readonly BacktestTrade[]): readonly RegimeBreakdown[] {
  return group(trades, (t) => t.regime).map(([regime, group_]) => ({
    regime,
    ...summarise(group_),
  }));
}

export function byStrategy(trades: readonly BacktestTrade[]): readonly StrategyBreakdown[] {
  return group(trades, (t) => t.strategyId).map(([strategyId, group_]) => {
    const s = summarise(group_);
    return {
      strategyId,
      trades: s.trades,
      winRate: s.winRate,
      netPnlUsdt: s.netPnlUsdt,
      profitFactor: s.profitFactor,
    };
  });
}

function group(
  trades: readonly BacktestTrade[],
  key: (t: BacktestTrade) => string,
): ReadonlyArray<readonly [string, readonly BacktestTrade[]]> {
  const map = new Map<string, BacktestTrade[]>();
  for (const trade of trades) {
    const k = key(trade);
    const bucket = map.get(k);
    if (bucket === undefined) map.set(k, [trade]);
    else bucket.push(trade);
  }
  return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
}

function summarise(trades: readonly BacktestTrade[]): {
  trades: number;
  winRate: number;
  netPnlUsdt: number;
  profitFactor: number;
  expectancyUsdt: number;
} {
  const wins = trades.filter((t) => t.netPnlUsdt > 0);
  const grossWin = wins.reduce((s, t) => s + t.netPnlUsdt, 0);
  const grossLoss = Math.abs(
    trades.filter((t) => t.netPnlUsdt <= 0).reduce((s, t) => s + t.netPnlUsdt, 0),
  );
  const net = totalNet(trades);
  return {
    trades: trades.length,
    winRate: trades.length === 0 ? 0 : (wins.length / trades.length) * 100,
    netPnlUsdt: net,
    profitFactor: grossLoss === 0 ? (grossWin > 0 ? Number.POSITIVE_INFINITY : 0) : grossWin / grossLoss,
    expectancyUsdt: trades.length === 0 ? 0 : net / trades.length,
  };
}
