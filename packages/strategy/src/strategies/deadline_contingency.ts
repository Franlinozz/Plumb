/**
 * Operator-authorised post-cutoff contingency.
 *
 * This module is deliberately absent from ALL_STRATEGIES and claims no calibrated edge. It is a
 * deterministic, closed-bar 4H-trend/1H-recovery rule for one bounded contest-risk decision.
 */
import { DEADLINE_CONTINGENCY_AMENDMENT, takeProfitLevels, type SignalDraft } from '@plumb/core';
import { closes, ema, macd, rsi, seriesFor } from '@plumb/market';

import type { StrategyContext, StrategyModule } from '../module.js';
import { aggregateClosedFourHour, classifyFourHourTrend } from './competition_trend_pullback.js';

export const DEADLINE_CONTINGENCY_ID = DEADLINE_CONTINGENCY_AMENDMENT.strategyId;

const mean = (values: readonly number[]): number | undefined =>
  values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length;

function evaluate(context: StrategyContext): readonly SignalDraft[] {
  const { snapshot, now } = context;
  if (!DEADLINE_CONTINGENCY_AMENDMENT.instruments.includes(
    snapshot.instId as (typeof DEADLINE_CONTINGENCY_AMENDMENT.instruments)[number],
  )) return [];
  const hourly = seriesFor(snapshot, '1H');
  if (hourly === undefined || hourly.length < 260) return [];
  const trend = classifyFourHourTrend(aggregateClosedFourHour(hourly));
  if (trend.direction === 'none' || trend.adx === undefined ||
      trend.adx < DEADLINE_CONTINGENCY_AMENDMENT.minClosedFourHourAdx) return [];

  const price = closes(hourly);
  const ema20 = ema(price, 20);
  const rsi14 = rsi(price, 14);
  const histogram = macd(price, 12, 26, 9).histogram;
  const i = hourly.length - 1;
  const current = hourly[i];
  const previous = hourly[i - 1];
  const emaNow = ema20[i];
  const rsiNow = rsi14[i];
  const histogramNow = histogram[i];
  const histogramPrevious = histogram[i - 1];
  if (current === undefined || previous === undefined || emaNow === undefined ||
      rsiNow === undefined || histogramNow === undefined || histogramPrevious === undefined) return [];

  const priorVolumeMean = mean(hourly.slice(Math.max(0, i - 20), i).map((bar) => bar.volume));
  if (priorVolumeMean === undefined || priorVolumeMean <= 0) return [];
  const volumeRatio = current.volume / priorVolumeMean;
  if (volumeRatio < DEADLINE_CONTINGENCY_AMENDMENT.minVolumeRatio) return [];

  const long = trend.direction === 'up' && current.close > emaNow && current.close > previous.close &&
    rsiNow >= DEADLINE_CONTINGENCY_AMENDMENT.longRsiMin &&
    rsiNow <= DEADLINE_CONTINGENCY_AMENDMENT.longRsiMax && histogramNow > histogramPrevious;
  const short = trend.direction === 'down' && current.close < emaNow && current.close < previous.close &&
    rsiNow >= DEADLINE_CONTINGENCY_AMENDMENT.shortRsiMin &&
    rsiNow <= DEADLINE_CONTINGENCY_AMENDMENT.shortRsiMax && histogramNow < histogramPrevious;
  if (!long && !short) return [];

  const side = long ? 'long' : 'short';
  const entryPrice = current.close;
  const stopPrice = side === 'long'
    ? entryPrice * (1 - DEADLINE_CONTINGENCY_AMENDMENT.stopDistancePct)
    : entryPrice * (1 + DEADLINE_CONTINGENCY_AMENDMENT.stopDistancePct);

  return [{
    instId: snapshot.instId,
    side,
    intent: 'open',
    entry: { type: 'market', price: entryPrice },
    stop: {
      price: stopPrice,
      distancePct: DEADLINE_CONTINGENCY_AMENDMENT.stopDistancePct,
      basis: 'structure',
    },
    takeProfit: [...takeProfitLevels(
      side, entryPrice, stopPrice, [DEADLINE_CONTINGENCY_AMENDMENT.takeProfitR],
    )],
    timeframe: '1H',
    strategyId: DEADLINE_CONTINGENCY_ID,
    regime: side === 'long' ? 'trending_up' : 'trending_down',
    inputs: {
      fourHourEmaFast: trend.emaFast as number,
      fourHourEmaSlow: trend.emaSlow as number,
      fourHourAdx: trend.adx,
      fourHourPlusDi: trend.plusDi as number,
      fourHourMinusDi: trend.minusDi as number,
      hourlyClose: current.close,
      hourlyPreviousClose: previous.close,
      hourlyEma20: emaNow,
      hourlyRsi: rsiNow,
      hourlyMacdHistogram: histogramNow,
      hourlyMacdHistogramPrevious: histogramPrevious,
      volumeRatio,
    },
    invalidation: {
      maxHoldBars: 24,
      conditions: [
        'closed 4H trend no longer agrees',
        '1H close loses EMA20 against the position',
        'hard stop, take profit, or competition hard exit executes',
      ],
    },
    expiresAt: now + DEADLINE_CONTINGENCY_AMENDMENT.maxValidityMs,
    version: DEADLINE_CONTINGENCY_AMENDMENT.strategyVersion,
  }];
}

export const deadlineContingency: StrategyModule = Object.freeze({
  id: DEADLINE_CONTINGENCY_ID,
  version: DEADLINE_CONTINGENCY_AMENDMENT.strategyVersion,
  requiresConfirmation: false,
  evaluate,
});
