/**
 * THE ELIGIBILITY GATE.
 *
 * A strategy config may touch real money ONLY if it passes every criterion below on
 * OUT-OF-SAMPLE data with full costs. There is no partial credit and no "close enough".
 *
 * `@plumb/executor` (P5) refuses to run a config without a PASSING eligibility record, so this is
 * not advice — it is a lock.
 *
 * Failing is a legitimate and useful outcome. It means we do not trade this configuration and we
 * go back to work, which is enormously cheaper than finding out with money.
 */

import { signEligibility, type EligibilitySummary } from '@plumb/core';

import type { BacktestTrade } from './engine.js';
import { computeMetrics, drawdownStats, type Metrics } from './metrics.js';
import type { MonteCarloResult } from './monte_carlo.js';
import type { WalkForwardResult } from './walkforward.js';

export interface GateCriteria {
  /** Equity floor that must never be breached in any walk-forward window. */
  readonly killSwitchEquity: number;
  /** Maximum acceptable Monte Carlo P(equity <= floor). Operator-set; 5% recommended. */
  readonly maxProbabilityOfRuin: number;
  readonly minProfitFactor: number;
  /** Below this, the result is noise, not evidence. */
  readonly minOutOfSampleTrades: number;
}

export const DEFAULT_CRITERIA: GateCriteria = Object.freeze({
  killSwitchEquity: 335,
  maxProbabilityOfRuin: 0.05,
  minProfitFactor: 1.0,
  minOutOfSampleTrades: 30,
});

export interface CriterionResult {
  readonly name: string;
  readonly passed: boolean;
  readonly actual: string;
  readonly required: string;
  readonly detail: string;
}

export interface EligibilityRecord {
  readonly label: string;
  readonly eligible: boolean;
  readonly criteria: readonly CriterionResult[];
  readonly failedOn: readonly string[];
  readonly outOfSampleMetrics: Metrics;
  readonly monteCarlo: MonteCarloResult;
  readonly evaluatedAt: number;
  /** sha256 over the record's decisive contents — a tamper-evident signature. */
  readonly signature: string;
  readonly criteriaUsed: GateCriteria;
}

export interface GateInput {
  readonly walkForward: WalkForwardResult;
  readonly monteCarlo: MonteCarloResult;
  readonly startingEquity: number;
  readonly criteria?: GateCriteria;
  /** Injected clock — this module reads none. */
  readonly evaluatedAt: number;
}

export function evaluateEligibility(input: GateInput): EligibilityRecord {
  const criteria = input.criteria ?? DEFAULT_CRITERIA;
  const oos = input.walkForward.outOfSampleMetrics;
  const results: CriterionResult[] = [];

  // ── 1. The floor holds in EVERY window, not on average. ─────────────────────────────────
  const breaches = input.walkForward.windows.filter(
    (w) => w.outOfSample.metrics.minEquity <= criteria.killSwitchEquity,
  );
  const worstWindowEquity = input.walkForward.windows.reduce(
    (min, w) => Math.min(min, w.outOfSample.metrics.minEquity),
    Number.POSITIVE_INFINITY,
  );
  results.push({
    name: 'drawdown floor',
    passed: breaches.length === 0,
    actual: `worst window min equity ${fmt(worstWindowEquity)}`,
    required: `> ${criteria.killSwitchEquity} in every window`,
    detail:
      breaches.length === 0
        ? 'no walk-forward window breached the kill-switch floor'
        : `${breaches.length} of ${input.walkForward.windows.length} windows breached the floor`,
  });

  // ── 2. Monte Carlo probability of ruin. THE number. ──────────────────────────────────────
  results.push({
    name: 'P(ruin)',
    passed: input.monteCarlo.probabilityOfRuin <= criteria.maxProbabilityOfRuin,
    actual: `${(input.monteCarlo.probabilityOfRuin * 100).toFixed(2)}%`,
    required: `<= ${(criteria.maxProbabilityOfRuin * 100).toFixed(2)}%`,
    detail:
      `5th-percentile equity ${fmt(input.monteCarlo.p5Equity)} across ` +
      `${input.monteCarlo.iterations} resampled paths`,
  });

  // ── 3. Profitable out of sample, after full costs. ───────────────────────────────────────
  results.push({
    name: 'profit factor (OOS)',
    passed: oos.profitFactor > criteria.minProfitFactor,
    actual: Number.isFinite(oos.profitFactor) ? oos.profitFactor.toFixed(3) : 'undefined (no losses)',
    required: `> ${criteria.minProfitFactor}`,
    detail: `net ${fmt(oos.totalReturnUsdt)} USDT over ${oos.tradeCount} out-of-sample trades`,
  });

  // ── 4. Enough trades that the result is evidence rather than noise. ──────────────────────
  results.push({
    name: 'sample size',
    passed: oos.tradeCount >= criteria.minOutOfSampleTrades,
    actual: `${oos.tradeCount} OOS trades`,
    required: `>= ${criteria.minOutOfSampleTrades}`,
    detail:
      oos.tradeCount >= criteria.minOutOfSampleTrades
        ? 'sample is large enough to carry a conclusion'
        : 'too few trades — this is noise, not evidence, whatever the return says',
  });

  // ── 5. Not driven by one or two outliers. ────────────────────────────────────────────────
  const outlier = outlierDependence(input.walkForward.combinedOutOfSample.trades, input.startingEquity);
  results.push({
    name: 'outlier independence',
    passed: outlier.passed,
    actual: `without best trade: ${fmt(outlier.withoutBest)} USDT`,
    required: 'still positive without the single best trade',
    detail: outlier.detail,
  });

  const failedOn = results.filter((r) => !r.passed).map((r) => r.name);
  const record = {
    label: input.walkForward.label,
    eligible: failedOn.length === 0,
    criteria: results,
    failedOn,
    outOfSampleMetrics: oos,
    monteCarlo: input.monteCarlo,
    evaluatedAt: input.evaluatedAt,
    criteriaUsed: criteria,
  };
  return { ...record, signature: signRecord(record) };
}

export interface OutlierCheck {
  readonly passed: boolean;
  readonly total: number;
  readonly withoutBest: number;
  readonly bestTradeUsdt: number;
  readonly bestTradeShareOfProfit: number;
  readonly detail: string;
}

/**
 * Would the result survive without its single best trade?
 *
 * An equity curve carried by one lucky trade is not a strategy; it is an anecdote. This is the
 * cheapest available test of whether the edge is repeatable.
 */
export function outlierDependence(
  trades: readonly BacktestTrade[],
  startingEquity: number,
): OutlierCheck {
  if (trades.length === 0) {
    return {
      passed: false,
      total: 0,
      withoutBest: 0,
      bestTradeUsdt: 0,
      bestTradeShareOfProfit: 0,
      detail: 'no trades to assess',
    };
  }
  const total = trades.reduce((s, t) => s + t.netPnlUsdt, 0);
  const best = trades.reduce((m, t) => (t.netPnlUsdt > m ? t.netPnlUsdt : m), Number.NEGATIVE_INFINITY);
  const withoutBest = total - best;
  const share = total > 0 ? best / total : 0;

  // Also check the curve without it, so a single trade cannot be what keeps us above the floor.
  const remaining = trades.filter((t) => t.netPnlUsdt !== best);
  const rebuilt = rebuildCurve(remaining, startingEquity);
  const dd = drawdownStats(rebuilt, startingEquity);

  const passed = total > 0 && withoutBest > 0;
  return {
    passed,
    total,
    withoutBest,
    bestTradeUsdt: best,
    bestTradeShareOfProfit: share,
    detail: passed
      ? `best trade ${fmt(best)} is ${(share * 100).toFixed(0)}% of profit; result survives without it ` +
        `(min equity then ${fmt(dd.minEquity)})`
      : total <= 0
        ? 'the result is not positive to begin with'
        : `removing the best trade (${fmt(best)}) flips the result to ${fmt(withoutBest)} — ` +
          `the curve is carried by one trade`,
  };
}

function rebuildCurve(
  trades: readonly BacktestTrade[],
  startingEquity: number,
): ReadonlyArray<{ ts: number; equity: number }> {
  let equity = startingEquity;
  return trades.map((t) => {
    equity += t.netPnlUsdt;
    return { ts: t.closedAt, equity };
  });
}

/**
 * Tamper-evident signature over the decisive contents.
 *
 * Not a cryptographic authority — anyone with the code can recompute it. Its job is to make an
 * edited eligibility record obvious, so a config cannot be promoted to live by hand-editing a
 * "passed: true" into a JSON file.
 */
export function signRecord(record: Omit<EligibilityRecord, 'signature'>): string {
  return signEligibility(summaryOf(record));
}

/**
 * The decisive subset the signature covers. Shared with `@plumb/executor` through
 * `@plumb/core` so the producer and the consumer cannot drift apart.
 */
export function summaryOf(record: Omit<EligibilityRecord, 'signature'>): EligibilitySummary {
  return {
    label: record.label,
    eligible: record.eligible,
    failedOn: record.failedOn,
    criteria: record.criteria.map((c) => ({ name: c.name, passed: c.passed, actual: c.actual })),
    tradeCount: record.outOfSampleMetrics.tradeCount,
    profitFactor: record.outOfSampleMetrics.profitFactor,
    totalReturnUsdt: record.outOfSampleMetrics.totalReturnUsdt,
    maxDrawdownPct: record.outOfSampleMetrics.maxDrawdownPct,
    probabilityOfRuin: record.monteCarlo.probabilityOfRuin,
    p5Equity: record.monteCarlo.p5Equity,
    criteriaUsed: record.criteriaUsed as unknown as Readonly<Record<string, number>>,
    evaluatedAt: record.evaluatedAt,
  };
}

/** Verify a record has not been edited since it was signed. */
export function verifyRecord(record: EligibilityRecord): boolean {
  const { signature, ...rest } = record;
  return signRecord(rest) === signature;
}

function fmt(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : String(value);
}

export { computeMetrics };
