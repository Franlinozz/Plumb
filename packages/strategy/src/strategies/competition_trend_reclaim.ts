/** Final predeclared fallback: strong closed-4H trend with a 1H reclaim or short-range break. */

import { adx as computeAdx, atr as computeAtr, closes, ema, macd, rsi, seriesFor } from '@plumb/market';
import type { SignalDraft } from '@plumb/core';

import { makeDraft, type StrategyContext, type StrategyModule } from '../module.js';
import { aggregateClosedFourHour } from './competition_trend_pullback.js';

export const COMPETITION_TREND_RECLAIM_ID = 'competition_trend_reclaim';
const VERSION = '5.0.0';

export interface CompetitionTrendReclaimSettings {
  readonly fourHourAdxMin: number;
  readonly breakoutBars: number;
  readonly volumeFloor: number;
  readonly longRsiMin: number;
  readonly longRsiMax: number;
  readonly shortRsiMin: number;
  readonly shortRsiMax: number;
}
export const COMPETITION_TREND_RECLAIM_SETTINGS = Object.freeze({ fourHourAdxMin: 25,
  breakoutBars: 3, volumeFloor: 0.6, longRsiMin: 48, longRsiMax: 70,
  shortRsiMin: 30, shortRsiMax: 52 }) satisfies CompetitionTrendReclaimSettings;
const mean = (values: readonly number[]): number | undefined => values.length === 0 ? undefined :
  values.reduce((sum, value) => sum + value, 0) / values.length;

function evaluate(context: StrategyContext, settings: CompetitionTrendReclaimSettings): readonly SignalDraft[] {
  const { snapshot, config, now } = context;
  const hourly = seriesFor(snapshot, '1H');
  if (hourly === undefined || hourly.length < 260) return [];
  const four = aggregateClosedFourHour(hourly);
  if (four.length < 60) return [];
  const fourPrice = closes(four);
  const fourEma20Series = ema(fourPrice, 20);
  const fourEma50Series = ema(fourPrice, 50);
  const fourDirectional = computeAdx(four, 14);
  const f = four.length - 1;
  const fourEma20 = fourEma20Series[f]; const fourEma50 = fourEma50Series[f];
  const fourAdx = fourDirectional.adx[f]; const fourPlusDi = fourDirectional.plusDi[f];
  const fourMinusDi = fourDirectional.minusDi[f];
  if (fourEma20 === undefined || fourEma50 === undefined || fourAdx === undefined ||
      fourPlusDi === undefined || fourMinusDi === undefined || fourAdx < settings.fourHourAdxMin) return [];
  const trendLong = fourEma20 > fourEma50 && fourPlusDi > fourMinusDi;
  const trendShort = fourEma20 < fourEma50 && fourMinusDi > fourPlusDi;
  if (!trendLong && !trendShort) return [];

  const price = closes(hourly); const ema20 = ema(price, 20); const rsi14 = rsi(price, 14);
  const atr14 = computeAtr(hourly, 14); const histogram = macd(price, 12, 26, 9).histogram;
  const i = hourly.length - 1; const current = hourly[i]; const previous = hourly[i - 1];
  const entry = price[i]; const emaNow = ema20[i]; const emaPrevious = ema20[i - 1];
  const rsiNow = rsi14[i]; const atrNow = atr14[i]; const histogramNow = histogram[i];
  if (current === undefined || previous === undefined || entry === undefined || emaNow === undefined ||
      emaPrevious === undefined || rsiNow === undefined || atrNow === undefined || atrNow <= 0 ||
      histogramNow === undefined) return [];
  const priorVolumeMean = mean(hourly.slice(i - 20, i).map((bar) => bar.volume));
  if (priorVolumeMean === undefined || priorVolumeMean <= 0 ||
      current.volume < priorVolumeMean * settings.volumeFloor) return [];
  const recent = hourly.slice(i - settings.breakoutBars, i);
  const recentHigh = Math.max(...recent.map((bar) => bar.high));
  const recentLow = Math.min(...recent.map((bar) => bar.low));
  const reclaimLong = previous.close <= emaPrevious && entry > emaNow;
  const reclaimShort = previous.close >= emaPrevious && entry < emaNow;
  const breakoutLong = entry > emaNow && entry > recentHigh;
  const breakoutShort = entry < emaNow && entry < recentLow;
  const long = trendLong && (reclaimLong || breakoutLong) && histogramNow > 0 &&
    rsiNow >= settings.longRsiMin && rsiNow <= settings.longRsiMax;
  const short = trendShort && (reclaimShort || breakoutShort) && histogramNow < 0 &&
    rsiNow >= settings.shortRsiMin && rsiNow <= settings.shortRsiMax;
  if (!long && !short) return [];
  const side = long ? 'long' : 'short'; const swing = hourly.slice(i - 5, i + 1);
  const structural = side === 'long' ? Math.min(...swing.map((bar) => bar.low)) - 0.25 * atrNow :
    Math.max(...swing.map((bar) => bar.high)) + 0.25 * atrNow;
  const minimum = side === 'long' ? entry * 0.985 : entry * 1.015;
  const stopPrice = side === 'long' ? Math.min(structural, minimum) : Math.max(structural, minimum);
  const stopDistance = Math.abs(entry - stopPrice) / entry;
  if (stopPrice <= 0 || stopDistance > 0.02) return [];
  const regime = Object.freeze({ label: side === 'long' ? 'trending_up' as const : 'trending_down' as const,
    confidence: Math.min(1, Math.max(0, (fourAdx - settings.fourHourAdxMin) / settings.fourHourAdxMin)),
    timeframe: '4H' as const, inputs: Object.freeze({ ema20: fourEma20, ema50: fourEma50,
      adx: fourAdx, plusDi: fourPlusDi, minusDi: fourMinusDi }),
    reasons: Object.freeze(['closed 4H trend plus 1H reclaim or continuation break']) });
  return [makeDraft({ snapshot, side, entryPrice: entry, stopPrice, stopBasis: 'structure', timeframe: '1H',
    strategyId: COMPETITION_TREND_RECLAIM_ID, version: VERSION, regime,
    inputs: { fourHourEma20: fourEma20, fourHourEma50: fourEma50, fourHourAdx: fourAdx, fourHourPlusDi: fourPlusDi,
      fourHourMinusDi: fourMinusDi, hourlyEma20: emaNow, hourlyRsi: rsiNow,
      hourlyMacdHistogram: histogramNow, hourlyAtr: atrNow, recentHigh, recentLow,
      reclaim: reclaimLong || reclaimShort ? 1 : 0, volumeRatio: current.volume / priorVolumeMean,
      close: entry, regimeConfidence: regime.confidence, adx: fourAdx },
    conditions: ['1H close loses EMA20', 'closed 4H trend no longer agrees', 'maximum hold expires'],
    config, now })];
}
export function createCompetitionTrendReclaim(
  settings: CompetitionTrendReclaimSettings = COMPETITION_TREND_RECLAIM_SETTINGS,
): StrategyModule {
  const frozen = Object.freeze({ ...settings });
  return Object.freeze({ id: COMPETITION_TREND_RECLAIM_ID, version: VERSION,
    requiresConfirmation: false, evaluate: (context: StrategyContext) => evaluate(context, frozen) });
}
export const competitionTrendReclaim = createCompetitionTrendReclaim();
