/**
 * Predeclared competition fallback v4 — broader 1H continuation inside a closed 4H trend.
 * Excluded from ALL_STRATEGIES so P8 cannot change by importing it.
 */

import {
  adx as computeAdx,
  atr as computeAtr,
  closes,
  ema,
  macd,
  rsi,
  seriesFor,
} from '@plumb/market';
import type { SignalDraft } from '@plumb/core';

import { makeDraft, type StrategyContext, type StrategyModule } from '../module.js';
import { aggregateClosedFourHour } from './competition_trend_pullback.js';

export const COMPETITION_TREND_CONTINUATION_ID = 'competition_trend_continuation';
const VERSION = '4.0.0';

export interface CompetitionTrendContinuationSettings {
  readonly fourHourAdxMin: number;
  readonly volumeFloor: number;
  readonly longRsiMin: number;
  readonly longRsiMax: number;
  readonly shortRsiMin: number;
  readonly shortRsiMax: number;
}

export const COMPETITION_TREND_CONTINUATION_SETTINGS = Object.freeze({
  fourHourAdxMin: 20,
  volumeFloor: 0.5,
  longRsiMin: 48,
  longRsiMax: 72,
  shortRsiMin: 28,
  shortRsiMax: 52,
}) satisfies CompetitionTrendContinuationSettings;

const mean = (values: readonly number[]): number | undefined =>
  values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length;

function evaluate(
  context: StrategyContext,
  settings: CompetitionTrendContinuationSettings,
): readonly SignalDraft[] {
  const { snapshot, config, now } = context;
  const hourly = seriesFor(snapshot, '1H');
  if (hourly === undefined || hourly.length < 260) return [];
  const fourHour = aggregateClosedFourHour(hourly);
  if (fourHour.length < 60) return [];

  const fourHourPrice = closes(fourHour);
  const fourHourEma20 = ema(fourHourPrice, 20);
  const fourHourEma50 = ema(fourHourPrice, 50);
  const fourHourDirectional = computeAdx(fourHour, 14);
  const f = fourHour.length - 1;
  const fourEma20 = fourHourEma20[f];
  const fourEma50 = fourHourEma50[f];
  const fourAdx = fourHourDirectional.adx[f];
  const fourPlusDi = fourHourDirectional.plusDi[f];
  const fourMinusDi = fourHourDirectional.minusDi[f];
  if (fourEma20 === undefined || fourEma50 === undefined || fourAdx === undefined ||
      fourPlusDi === undefined || fourMinusDi === undefined || fourAdx < settings.fourHourAdxMin) return [];
  const fourHourLong = fourEma20 > fourEma50 && fourPlusDi > fourMinusDi;
  const fourHourShort = fourEma20 < fourEma50 && fourMinusDi > fourPlusDi;
  if (!fourHourLong && !fourHourShort) return [];

  const price = closes(hourly);
  const hourlyEma20 = ema(price, 20);
  const hourlyRsi = rsi(price, 14);
  const hourlyAtr = computeAtr(hourly, 14);
  const histogram = macd(price, 12, 26, 9).histogram;
  const i = hourly.length - 1;
  const current = hourly[i];
  const previous = hourly[i - 1];
  const entryPrice = price[i];
  const previousClose = price[i - 1];
  const emaNow = hourlyEma20[i];
  const emaPrevious = hourlyEma20[i - 1];
  const rsiNow = hourlyRsi[i];
  const atrNow = hourlyAtr[i];
  const histogramNow = histogram[i];
  const histogramPrevious = histogram[i - 1];
  if (current === undefined || previous === undefined || entryPrice === undefined || previousClose === undefined ||
      emaNow === undefined || emaPrevious === undefined || rsiNow === undefined || atrNow === undefined ||
      atrNow <= 0 || histogramNow === undefined || histogramPrevious === undefined) return [];

  const priorVolumeMean = mean(hourly.slice(i - 20, i).map((bar) => bar.volume));
  if (priorVolumeMean === undefined || priorVolumeMean <= 0 ||
      current.volume < priorVolumeMean * settings.volumeFloor) return [];

  const long = fourHourLong && entryPrice > emaNow && emaNow >= emaPrevious &&
    entryPrice > previousClose && rsiNow >= settings.longRsiMin && rsiNow <= settings.longRsiMax &&
    histogramNow > histogramPrevious;
  const short = fourHourShort && entryPrice < emaNow && emaNow <= emaPrevious &&
    entryPrice < previousClose && rsiNow >= settings.shortRsiMin && rsiNow <= settings.shortRsiMax &&
    histogramNow < histogramPrevious;
  if (!long && !short) return [];

  const side = long ? 'long' : 'short';
  const swing = hourly.slice(i - 5, i + 1);
  const structural = side === 'long'
    ? Math.min(...swing.map((bar) => bar.low)) - 0.25 * atrNow
    : Math.max(...swing.map((bar) => bar.high)) + 0.25 * atrNow;
  const minimumDistance = side === 'long' ? entryPrice * 0.985 : entryPrice * 1.015;
  const stopPrice = side === 'long'
    ? Math.min(structural, minimumDistance)
    : Math.max(structural, minimumDistance);
  const stopDistance = Math.abs(entryPrice - stopPrice) / entryPrice;
  if (stopPrice <= 0 || stopDistance > 0.02) return [];

  const regime = Object.freeze({
    label: side === 'long' ? 'trending_up' as const : 'trending_down' as const,
    confidence: Math.min(1, Math.max(0, (fourAdx - settings.fourHourAdxMin) / settings.fourHourAdxMin)),
    timeframe: '4H' as const,
    inputs: Object.freeze({ ema20: fourEma20, ema50: fourEma50, adx: fourAdx,
      plusDi: fourPlusDi, minusDi: fourMinusDi }),
    reasons: Object.freeze(['closed 4H EMA and directional movement agree']),
  });

  return [makeDraft({
    snapshot,
    side,
    entryPrice,
    stopPrice,
    stopBasis: 'structure',
    timeframe: '1H',
    strategyId: COMPETITION_TREND_CONTINUATION_ID,
    version: VERSION,
    regime,
    inputs: {
      fourHourEma20: fourEma20, fourHourEma50: fourEma50, fourHourAdx: fourAdx,
      fourHourPlusDi: fourPlusDi, fourHourMinusDi: fourMinusDi,
      hourlyEma20: emaNow, hourlyEma20Previous: emaPrevious, hourlyRsi: rsiNow,
      hourlyMacdHistogram: histogramNow, hourlyMacdHistogramPrevious: histogramPrevious,
      hourlyAtr: atrNow, volumeRatio: current.volume / priorVolumeMean, close: entryPrice,
      regimeConfidence: regime.confidence, adx: fourAdx,
    },
    conditions: [
      '1H close loses EMA20 against the position',
      'closed 4H trend no longer agrees',
      'maximum 24-hour hold expires',
    ],
    config,
    now,
  })];
}

export function createCompetitionTrendContinuation(
  settings: CompetitionTrendContinuationSettings = COMPETITION_TREND_CONTINUATION_SETTINGS,
): StrategyModule {
  const frozen = Object.freeze({ ...settings });
  return Object.freeze({ id: COMPETITION_TREND_CONTINUATION_ID, version: VERSION,
    requiresConfirmation: false,
    evaluate: (context: StrategyContext) => evaluate(context, frozen) });
}

export const competitionTrendContinuation = createCompetitionTrendContinuation();
