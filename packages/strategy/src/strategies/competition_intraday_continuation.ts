/**
 * Predeclared emergency fallback — 1H trend plus a 15m range continuation.
 *
 * Deliberately excluded from ALL_STRATEGIES so importing this module cannot change P8. Exact live
 * parameters are frozen in reports/competition-fallback-protocol.md before the first replay.
 */

import type { Candle } from '@plumb/market';
import {
  adx as computeAdx,
  atr as computeAtr,
  closes,
  ema,
  rsi,
  seriesFor,
} from '@plumb/market';
import type { SignalDraft } from '@plumb/core';

import { makeDraft, type StrategyContext, type StrategyModule } from '../module.js';

export const COMPETITION_INTRADAY_CONTINUATION_ID = 'competition_intraday_continuation';
const VERSION = '1.0.0';
const FIFTEEN_MINUTES_MS = 15 * 60_000;
const ONE_HOUR_MS = 60 * 60_000;

export interface CompetitionIntradayContinuationSettings {
  readonly breakoutBars: number;
  readonly hourlyAdxMin: number;
  readonly volumeFloor: number;
}

export const COMPETITION_INTRADAY_CONTINUATION_SETTINGS = Object.freeze({
  breakoutBars: 8,
  hourlyAdxMin: 18,
  volumeFloor: 0.6,
}) satisfies CompetitionIntradayContinuationSettings;

/** Aggregate only four complete, contiguous, UTC-aligned closed 15m bars. */
export function aggregateClosedOneHour(rows: readonly Candle[]): readonly Candle[] {
  const groups = new Map<number, Candle[]>();
  for (const row of rows) {
    if (!row.closed) continue;
    const bucket = Math.floor(row.ts / ONE_HOUR_MS) * ONE_HOUR_MS;
    const group = groups.get(bucket) ?? [];
    group.push(row);
    groups.set(bucket, group);
  }

  const result: Candle[] = [];
  for (const [ts, unsorted] of [...groups.entries()].sort(([a], [b]) => a - b)) {
    const group = [...unsorted].sort((a, b) => a.ts - b.ts);
    if (group.length !== 4) continue;
    if (!group.every((row, index) => row.ts === ts + index * FIFTEEN_MINUTES_MS)) continue;
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

const mean = (values: readonly number[]): number | undefined =>
  values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length;

function evaluate(
  context: StrategyContext,
  settings: CompetitionIntradayContinuationSettings,
): readonly SignalDraft[] {
  const { snapshot, config, now } = context;
  const fifteen = seriesFor(snapshot, '15m');
  if (fifteen === undefined || fifteen.length < 300) return [];

  const hourly = aggregateClosedOneHour(fifteen);
  if (hourly.length < 60) return [];
  const hourlyPrice = closes(hourly);
  const hourlyEma20 = ema(hourlyPrice, 20);
  const hourlyEma50 = ema(hourlyPrice, 50);
  const hourlyDirectional = computeAdx(hourly, 14);
  const h = hourly.length - 1;
  const hourlyClose = hourlyPrice[h];
  const ema20Now = hourlyEma20[h];
  const ema20ThreeHoursAgo = hourlyEma20[h - 3];
  const ema50Now = hourlyEma50[h];
  const hourlyAdx = hourlyDirectional.adx[h];
  const hourlyPlusDi = hourlyDirectional.plusDi[h];
  const hourlyMinusDi = hourlyDirectional.minusDi[h];
  if (hourlyClose === undefined || ema20Now === undefined || ema20ThreeHoursAgo === undefined ||
      ema50Now === undefined || hourlyAdx === undefined || hourlyPlusDi === undefined ||
      hourlyMinusDi === undefined || hourlyAdx < settings.hourlyAdxMin) return [];

  const hourlyLong = hourlyClose > ema20Now && ema20Now > ema50Now &&
    ema20Now > ema20ThreeHoursAgo && hourlyPlusDi > hourlyMinusDi;
  const hourlyShort = hourlyClose < ema20Now && ema20Now < ema50Now &&
    ema20Now < ema20ThreeHoursAgo && hourlyMinusDi > hourlyPlusDi;
  if (!hourlyLong && !hourlyShort) return [];

  const price = closes(fifteen);
  const atrSeries = computeAtr(fifteen, 14);
  const rsiSeries = rsi(price, 14);
  const i = fifteen.length - 1;
  const current = fifteen[i];
  const entryPrice = price[i];
  const atrNow = atrSeries[i];
  const rsiNow = rsiSeries[i];
  if (current === undefined || entryPrice === undefined || entryPrice <= 0 || atrNow === undefined ||
      atrNow <= 0 || rsiNow === undefined) return [];

  const range = fifteen.slice(i - settings.breakoutBars, i);
  if (range.length !== settings.breakoutBars) return [];
  const rangeHigh = Math.max(...range.map((bar) => bar.high));
  const rangeLow = Math.min(...range.map((bar) => bar.low));
  const priorVolumeMean = mean(fifteen.slice(i - 20, i).map((bar) => bar.volume));
  if (priorVolumeMean === undefined || priorVolumeMean <= 0 ||
      current.volume < priorVolumeMean * settings.volumeFloor) return [];

  const long = hourlyLong && current.close > rangeHigh && rsiNow >= 52 && rsiNow <= 72;
  const short = hourlyShort && current.close < rangeLow && rsiNow >= 28 && rsiNow <= 48;
  if (!long && !short) return [];

  const side = long ? 'long' : 'short';
  const structural = side === 'long'
    ? rangeLow - 0.25 * atrNow
    : rangeHigh + 0.25 * atrNow;
  const minimumDistance = side === 'long' ? entryPrice * 0.985 : entryPrice * 1.015;
  const stopPrice = side === 'long'
    ? Math.min(structural, minimumDistance)
    : Math.max(structural, minimumDistance);
  const stopDistance = Math.abs(entryPrice - stopPrice) / entryPrice;
  if (stopPrice <= 0 || stopDistance > 0.02) return [];

  const regime = Object.freeze({
    label: side === 'long' ? 'trending_up' as const : 'trending_down' as const,
    confidence: Math.min(1, Math.max(0, (hourlyAdx - settings.hourlyAdxMin) / settings.hourlyAdxMin)),
    timeframe: '1H' as const,
    inputs: Object.freeze({
      ema20: ema20Now,
      ema50: ema50Now,
      adx: hourlyAdx,
      plusDi: hourlyPlusDi,
      minusDi: hourlyMinusDi,
    }),
    reasons: Object.freeze(['closed 1H EMA slope and directional movement agree']),
  });

  return [makeDraft({
    snapshot,
    side,
    entryPrice,
    stopPrice,
    stopBasis: 'structure',
    timeframe: '15m',
    strategyId: COMPETITION_INTRADAY_CONTINUATION_ID,
    version: VERSION,
    regime,
    inputs: {
      hourlyEma20: ema20Now,
      hourlyEma50: ema50Now,
      hourlyEma20ThreeHoursAgo: ema20ThreeHoursAgo,
      hourlyAdx,
      hourlyPlusDi,
      hourlyMinusDi,
      fifteenMinuteRsi: rsiNow,
      fifteenMinuteAtr: atrNow,
      rangeHigh,
      rangeLow,
      breakoutBars: settings.breakoutBars,
      volumeRatio: current.volume / priorVolumeMean,
      close: entryPrice,
      regimeConfidence: regime.confidence,
      adx: hourlyAdx,
    },
    conditions: [
      '15m close returns inside the broken range',
      'closed 1H EMA slope or directional movement no longer agrees',
      'maximum 24-hour hold expires',
    ],
    config,
    now,
  })];
}

export function createCompetitionIntradayContinuation(
  settings: CompetitionIntradayContinuationSettings = COMPETITION_INTRADAY_CONTINUATION_SETTINGS,
): StrategyModule {
  const frozen = Object.freeze({ ...settings });
  return Object.freeze({
    id: COMPETITION_INTRADAY_CONTINUATION_ID,
    version: VERSION,
    requiresConfirmation: false,
    evaluate: (context: StrategyContext) => evaluate(context, frozen),
  });
}

export const competitionIntradayContinuation = createCompetitionIntradayContinuation();
