/**
 * Competition v3 research candidate — 4H trend, 1H pullback and continuation.
 *
 * This module is deliberately NOT in ALL_STRATEGIES: adding a research candidate to the default
 * engine would change P8. Its parameters were frozen in reports/competition-strategy-v3-protocol.md
 * before the first replay, and no live eligibility is claimed.
 */

import type { Candle } from '@plumb/market';
import {
  adx as computeAdx,
  atr as computeAtr,
  closes,
  ema,
  latest,
  macd,
  rsi,
  seriesFor,
} from '@plumb/market';
import type { SignalDraft } from '@plumb/core';

import { makeDraft, type StrategyContext, type StrategyModule } from '../module.js';

export const COMPETITION_TREND_PULLBACK_ID = 'competition_trend_pullback';
const VERSION = '3.0.0';
const HOUR_MS = 3_600_000;
const FOUR_HOUR_MS = 4 * HOUR_MS;

/** Build only complete, contiguous, UTC-aligned 4H bars. */
export function aggregateClosedFourHour(rows: readonly Candle[]): readonly Candle[] {
  const groups = new Map<number, Candle[]>();
  for (const row of rows) {
    if (!row.closed) continue;
    const bucket = Math.floor(row.ts / FOUR_HOUR_MS) * FOUR_HOUR_MS;
    const group = groups.get(bucket) ?? [];
    group.push(row);
    groups.set(bucket, group);
  }

  const result: Candle[] = [];
  for (const [ts, unsorted] of [...groups.entries()].sort(([a], [b]) => a - b)) {
    const group = [...unsorted].sort((a, b) => a.ts - b.ts);
    if (group.length !== 4) continue;
    if (!group.every((row, index) => row.ts === ts + index * HOUR_MS)) continue;
    result.push(Object.freeze({
      ts,
      open: (group[0] as Candle).open,
      high: Math.max(...group.map((row) => row.high)),
      low: Math.min(...group.map((row) => row.low)),
      close: (group[3] as Candle).close,
      volume: group.reduce((sum, row) => sum + row.volume, 0),
      volumeCcy: group.reduce((sum, row) => sum + row.volumeCcy, 0),
      volumeQuote: group.reduce((sum, row) => sum + row.volumeQuote, 0),
      closed: true,
    }));
  }
  return Object.freeze(result);
}

export type FourHourTrend = 'up' | 'down' | 'none';

export function classifyFourHourTrend(rows: readonly Candle[]): {
  readonly direction: FourHourTrend;
  readonly emaFast: number | undefined;
  readonly emaSlow: number | undefined;
  readonly adx: number | undefined;
  readonly plusDi: number | undefined;
  readonly minusDi: number | undefined;
} {
  const price = closes(rows);
  const directional = computeAdx(rows, 14);
  const emaFast = latest(ema(price, 20));
  const emaSlow = latest(ema(price, 50));
  const adx = latest(directional.adx);
  const plusDi = latest(directional.plusDi);
  const minusDi = latest(directional.minusDi);
  let direction: FourHourTrend = 'none';
  if (emaFast !== undefined && emaSlow !== undefined && adx !== undefined &&
      plusDi !== undefined && minusDi !== undefined && adx >= 25) {
    if (emaFast > emaSlow && plusDi > minusDi) direction = 'up';
    if (emaFast < emaSlow && minusDi > plusDi) direction = 'down';
  }
  return { direction, emaFast, emaSlow, adx, plusDi, minusDi };
}

const mean = (values: readonly number[]): number | undefined =>
  values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length;

function evaluate(context: StrategyContext): readonly SignalDraft[] {
  const { snapshot, config, now } = context;
  const hourly = seriesFor(snapshot, '1H');
  if (hourly === undefined || hourly.length < 260) return [];

  const fourHour = aggregateClosedFourHour(hourly);
  if (fourHour.length < 60) return [];
  const trend = classifyFourHourTrend(fourHour);
  if (trend.direction === 'none') return [];

  const price = closes(hourly);
  const hourlyEma = ema(price, 20);
  const hourlyRsi = rsi(price, 14);
  const hourlyAtr = computeAtr(hourly, 14);
  const histogram = macd(price, 12, 26, 9).histogram;
  const i = hourly.length - 1;
  const current = hourly[i];
  const previous = hourly[i - 1];
  const entryPrice = price[i];
  const emaNow = hourlyEma[i];
  const emaPrevious = hourlyEma[i - 1];
  const rsiNow = hourlyRsi[i];
  const atrNow = hourlyAtr[i];
  const histogramNow = histogram[i];
  const histogramPrevious = histogram[i - 1];
  if (current === undefined || previous === undefined || entryPrice === undefined ||
      emaNow === undefined || emaPrevious === undefined || rsiNow === undefined ||
      atrNow === undefined || atrNow <= 0 || histogramNow === undefined ||
      histogramPrevious === undefined) return [];

  const priorVolumeMean = mean(hourly.slice(Math.max(0, i - 20), i).map((bar) => bar.volume));
  if (priorVolumeMean === undefined || current.volume < priorVolumeMean * 0.8) return [];

  const long = trend.direction === 'up' && previous.close <= emaPrevious &&
    current.close > emaNow && current.close > previous.high &&
    rsiNow >= 50 && rsiNow <= 68 && histogramNow > 0 && histogramNow > histogramPrevious;
  const short = trend.direction === 'down' && previous.close >= emaPrevious &&
    current.close < emaNow && current.close < previous.low &&
    rsiNow >= 32 && rsiNow <= 50 && histogramNow < 0 && histogramNow < histogramPrevious;
  if (!long && !short) return [];

  const side = long ? 'long' : 'short';
  const swing = hourly.slice(Math.max(0, i - 5), i + 1);
  const stopPrice = side === 'long'
    ? Math.min(...swing.map((bar) => bar.low)) - 0.25 * atrNow
    : Math.max(...swing.map((bar) => bar.high)) + 0.25 * atrNow;
  if (stopPrice <= 0 || (side === 'long' ? stopPrice >= entryPrice : stopPrice <= entryPrice)) return [];

  const regime = Object.freeze({
    label: side === 'long' ? 'trending_up' as const : 'trending_down' as const,
    confidence: context.regime.confidence,
    timeframe: '4H' as const,
    inputs: Object.freeze({
      emaFast: trend.emaFast as number,
      emaSlow: trend.emaSlow as number,
      adx: trend.adx as number,
      plusDi: trend.plusDi as number,
      minusDi: trend.minusDi as number,
    }),
    reasons: Object.freeze(['closed 4H EMA and directional movement agree']),
  });

  return [makeDraft({
    snapshot,
    side,
    entryPrice,
    stopPrice,
    stopBasis: 'structure',
    timeframe: '1H',
    strategyId: COMPETITION_TREND_PULLBACK_ID,
    version: VERSION,
    regime,
    inputs: {
      fourHourEmaFast: trend.emaFast as number,
      fourHourEmaSlow: trend.emaSlow as number,
      fourHourAdx: trend.adx as number,
      fourHourPlusDi: trend.plusDi as number,
      fourHourMinusDi: trend.minusDi as number,
      hourlyEma20: emaNow,
      hourlyRsi: rsiNow,
      hourlyMacdHistogram: histogramNow,
      hourlyMacdHistogramPrevious: histogramPrevious,
      hourlyAtr: atrNow,
      volumeRatio: current.volume / priorVolumeMean,
      close: entryPrice,
      regimeConfidence: context.regime.confidence,
    },
    conditions: [
      '1H close loses the EMA20 against the position',
      'closed 4H EMA or directional-movement trend no longer agrees',
      'continuation fails to follow through',
    ],
    config,
    now,
  })];
}

export const competitionTrendPullback: StrategyModule = Object.freeze({
  id: COMPETITION_TREND_PULLBACK_ID,
  version: VERSION,
  requiresConfirmation: false,
  evaluate,
});
