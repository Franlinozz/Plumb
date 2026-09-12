/** Operator-authorised final-window V2; isolated from ALL_STRATEGIES and P8. */
import { FINAL_WINDOW_CONTINGENCY_AMENDMENT, takeProfitLevels, type SignalDraft } from '@plumb/core';
import { closes, ema, macd, rsi, seriesFor } from '@plumb/market';

import type { StrategyContext, StrategyModule } from '../module.js';
import { aggregateClosedFourHour, classifyFourHourTrend } from './competition_trend_pullback.js';

export const FINAL_WINDOW_CONTINGENCY_ID = FINAL_WINDOW_CONTINGENCY_AMENDMENT.strategyId;

const mean = (values: readonly number[]): number | undefined =>
  values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length;

function evaluate(context: StrategyContext): readonly SignalDraft[] {
  const amendment = FINAL_WINDOW_CONTINGENCY_AMENDMENT;
  const { snapshot, now } = context;
  if (!amendment.instruments.includes(
    snapshot.instId as (typeof amendment.instruments)[number],
  )) return [];
  const hourly = seriesFor(snapshot, '1H');
  if (hourly === undefined || hourly.length < 260) return [];
  const trend = classifyFourHourTrend(aggregateClosedFourHour(hourly));
  if (trend.direction === 'none' || trend.adx === undefined ||
      trend.adx < amendment.minClosedFourHourAdx) return [];

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
  if (volumeRatio < amendment.minVolumeRatio) return [];

  const long = trend.direction === 'up' && current.close > emaNow && current.close > previous.close &&
    rsiNow >= amendment.longRsiMin && rsiNow <= amendment.longRsiMax &&
    histogramNow > histogramPrevious;
  const short = trend.direction === 'down' && current.close < emaNow && current.close < previous.close &&
    rsiNow >= amendment.shortRsiMin && rsiNow <= amendment.shortRsiMax &&
    histogramNow < histogramPrevious;
  if (!long && !short) return [];

  const side = long ? 'long' : 'short';
  const entryPrice = current.close;
  const stopPrice = side === 'long'
    ? entryPrice * (1 - amendment.stopDistancePct)
    : entryPrice * (1 + amendment.stopDistancePct);

  return [{
    instId: snapshot.instId,
    side,
    intent: 'open',
    entry: { type: 'market', price: entryPrice },
    stop: { price: stopPrice, distancePct: amendment.stopDistancePct, basis: 'structure' },
    takeProfit: [...takeProfitLevels(side, entryPrice, stopPrice, [amendment.takeProfitR])],
    timeframe: '1H',
    strategyId: FINAL_WINDOW_CONTINGENCY_ID,
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
    expiresAt: now + amendment.maxValidityMs,
    version: amendment.strategyVersion,
  }];
}

export const finalWindowContingency: StrategyModule = Object.freeze({
  id: FINAL_WINDOW_CONTINGENCY_ID,
  version: FINAL_WINDOW_CONTINGENCY_AMENDMENT.strategyVersion,
  requiresConfirmation: false,
  evaluate,
});
