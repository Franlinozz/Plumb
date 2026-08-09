/**
 * WALK-FORWARD — the only result we trust.
 *
 * History is split into rolling in-sample / out-of-sample windows. Anything chosen may only be
 * chosen on IS data; the number that counts is measured on OOS data the choice never saw.
 *
 * IS and OOS are reported SIDE BY SIDE, always. A strategy whose OOS performance collapses
 * relative to its IS performance is overfit, and the report says so in those words rather than
 * quietly printing the better of the two.
 */

import type { Instrument } from '@plumb/core';
import type { Candle } from '@plumb/market';

import { runBacktest, type BacktestOptions, type BacktestResult } from './engine.js';
import { computeMetrics, type Metrics } from './metrics.js';

export interface WalkForwardWindow {
  readonly index: number;
  readonly inSampleFrom: number;
  readonly inSampleTo: number;
  readonly outOfSampleFrom: number;
  readonly outOfSampleTo: number;
}

export interface WalkForwardSplit {
  readonly inSampleDays: number;
  readonly outOfSampleDays: number;
  readonly stepDays: number;
}

export const DEFAULT_SPLIT: WalkForwardSplit = Object.freeze({
  inSampleDays: 60,
  outOfSampleDays: 20,
  stepDays: 20,
});

const MS_PER_DAY = 86_400_000;

/**
 * Rolling windows. IS and OOS never overlap — the OOS window starts exactly where the IS window
 * ends, and the whole pair rolls forward by `stepDays`.
 */
export function buildWindows(
  fromTs: number,
  toTs: number,
  split: WalkForwardSplit = DEFAULT_SPLIT,
): readonly WalkForwardWindow[] {
  const windows: WalkForwardWindow[] = [];
  const isMs = split.inSampleDays * MS_PER_DAY;
  const oosMs = split.outOfSampleDays * MS_PER_DAY;
  const stepMs = split.stepDays * MS_PER_DAY;

  let index = 0;
  for (let start = fromTs; start + isMs + oosMs <= toTs; start += stepMs) {
    windows.push({
      index,
      inSampleFrom: start,
      inSampleTo: start + isMs,
      outOfSampleFrom: start + isMs,
      outOfSampleTo: start + isMs + oosMs,
    });
    index += 1;
  }
  return Object.freeze(windows);
}

export interface WindowResult {
  readonly window: WalkForwardWindow;
  readonly inSample: { readonly result: BacktestResult; readonly metrics: Metrics };
  readonly outOfSample: { readonly result: BacktestResult; readonly metrics: Metrics };
}

export interface WalkForwardResult {
  readonly label: string;
  readonly split: WalkForwardSplit;
  readonly windows: readonly WindowResult[];
  /** All OOS trades, concatenated — the sample the gate judges. */
  readonly combinedOutOfSample: BacktestResult;
  readonly outOfSampleMetrics: Metrics;
  readonly inSampleMetrics: Metrics;
  /** OOS profit factor ÷ IS profit factor. Well below 1 means the IS result did not survive. */
  readonly degradation: number;
  readonly overfitVerdict: string;
}

export interface WalkForwardOptions extends Omit<BacktestOptions, 'fromTs' | 'toTs'> {
  readonly label: string;
  readonly split?: WalkForwardSplit;
  readonly fromTs?: number;
  readonly toTs?: number;
}

export function runWalkForward(options: WalkForwardOptions): WalkForwardResult {
  const split = options.split ?? DEFAULT_SPLIT;
  const bounds = seriesBounds(options.candles);
  const fromTs = options.fromTs ?? bounds.from;
  const toTs = options.toTs ?? bounds.to;
  const windows = buildWindows(fromTs, toTs, split);

  const results: WindowResult[] = [];
  for (const window of windows) {
    const inSample = runBacktest({
      ...options,
      fromTs: window.inSampleFrom,
      toTs: window.inSampleTo,
    });
    const outOfSample = runBacktest({
      ...options,
      fromTs: window.outOfSampleFrom,
      toTs: window.outOfSampleTo,
    });
    results.push({
      window,
      inSample: { result: inSample, metrics: computeMetrics(inSample) },
      outOfSample: { result: outOfSample, metrics: computeMetrics(outOfSample) },
    });
  }

  const combinedOutOfSample = concatenate(
    results.map((r) => r.outOfSample.result),
    options.startingEquity ?? 400,
  );
  const combinedInSample = concatenate(
    results.map((r) => r.inSample.result),
    options.startingEquity ?? 400,
  );

  const outOfSampleMetrics = computeMetrics(combinedOutOfSample);
  const inSampleMetrics = computeMetrics(combinedInSample);
  const degradation = ratio(outOfSampleMetrics.profitFactor, inSampleMetrics.profitFactor);

  return {
    label: options.label,
    split,
    windows: results,
    combinedOutOfSample,
    outOfSampleMetrics,
    inSampleMetrics,
    degradation,
    overfitVerdict: verdict(inSampleMetrics, outOfSampleMetrics, degradation),
  };
}

function ratio(oos: number, is: number): number {
  if (!Number.isFinite(is) || is <= 0) return 0;
  if (!Number.isFinite(oos)) return Number.POSITIVE_INFINITY;
  return oos / is;
}

function verdict(is: Metrics, oos: Metrics, degradation: number): string {
  if (oos.tradeCount === 0) return 'NO OUT-OF-SAMPLE TRADES — nothing was measured.';
  if (is.tradeCount === 0) return 'No in-sample trades to compare against.';
  if (oos.profitFactor <= 1 && is.profitFactor > 1) {
    return (
      `OVERFIT: in-sample profit factor ${is.profitFactor.toFixed(2)} did not survive out of ` +
      `sample (${oos.profitFactor.toFixed(2)}). The in-sample result is not evidence.`
    );
  }
  if (degradation < 0.5 && is.profitFactor > 1) {
    return (
      `LIKELY OVERFIT: out-of-sample profit factor is ${(degradation * 100).toFixed(0)}% of ` +
      `in-sample. A large gap means the in-sample number was fitted to noise.`
    );
  }
  if (oos.profitFactor <= 1) {
    return `Unprofitable both in and out of sample (OOS profit factor ${oos.profitFactor.toFixed(2)}).`;
  }
  return `Out-of-sample profit factor ${oos.profitFactor.toFixed(2)}, ${(degradation * 100).toFixed(0)}% of in-sample.`;
}

/**
 * Stitch window results into one record.
 *
 * The equity curve is re-based so each window continues from where the last left off, which is
 * what a live account would actually have experienced trading these windows back to back.
 */
function concatenate(results: readonly BacktestResult[], startingEquity: number): BacktestResult {
  const trades: BacktestResult['trades'][number][] = [];
  const equityCurve: BacktestResult['equityCurve'][number][] = [];
  const gateRejections: Record<string, number> = {};
  const governorVetoes: Record<string, number> = {};

  let equity = startingEquity;
  let cycles = 0;
  let signalsEmitted = 0;
  let killSwitchTriggers = 0;
  let dailyLimitTriggers = 0;
  let fundingFallbackSettlements = 0;
  let fundingPaidUsdt = 0;
  let fundingReceivedUsdt = 0;
  let totalFeesUsdt = 0;
  let fromTs = Number.POSITIVE_INFINITY;
  let toTs = 0;

  for (const result of results) {
    const offset = equity - result.startingEquity;
    for (const trade of result.trades) trades.push({ ...trade, equityAfter: trade.equityAfter + offset });
    for (const point of result.equityCurve) equityCurve.push({ ts: point.ts, equity: point.equity + offset });
    equity = result.finalEquity + offset;

    for (const [k, v] of Object.entries(result.gateRejections)) gateRejections[k] = (gateRejections[k] ?? 0) + v;
    for (const [k, v] of Object.entries(result.governorVetoes)) governorVetoes[k] = (governorVetoes[k] ?? 0) + v;
    cycles += result.cycles;
    signalsEmitted += result.signalsEmitted;
    killSwitchTriggers += result.killSwitchTriggers;
    dailyLimitTriggers += result.dailyLimitTriggers;
    fundingFallbackSettlements += result.fundingFallbackSettlements;
    fundingPaidUsdt += result.fundingPaidUsdt;
    fundingReceivedUsdt += result.fundingReceivedUsdt;
    totalFeesUsdt += result.totalFeesUsdt;
    if (result.fromTs > 0) fromTs = Math.min(fromTs, result.fromTs);
    toTs = Math.max(toTs, result.toTs);
  }

  const last = results[results.length - 1];
  return {
    startingEquity,
    finalEquity: equity,
    trades,
    equityCurve,
    cycles,
    signalsEmitted,
    gateRejections,
    governorVetoes,
    killSwitchTriggers,
    dailyLimitTriggers,
    fundingFallbackSettlements,
    fundingPaidUsdt,
    fundingReceivedUsdt,
    totalFeesUsdt,
    fromTs: Number.isFinite(fromTs) ? fromTs : 0,
    toTs,
    state: last?.state ?? ({} as BacktestResult['state']),
  };
}

function seriesBounds(
  candles: Readonly<Partial<Record<Instrument, readonly Candle[]>>>,
): { from: number; to: number } {
  let from = Number.POSITIVE_INFINITY;
  let to = 0;
  for (const series of Object.values(candles)) {
    const list = series as readonly Candle[] | undefined;
    if (list === undefined || list.length === 0) continue;
    from = Math.min(from, list[0]?.ts ?? 0);
    to = Math.max(to, list[list.length - 1]?.ts ?? 0);
  }
  return { from: Number.isFinite(from) ? from : 0, to };
}
