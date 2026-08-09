/**
 * CANDIDATE STRATEGY — EMA cross with a trend filter.
 *
 * **No edge is claimed.** This is one of four candidates; P4's backtest decides which, if any,
 * survive. It is written to be honest rather than flattering: it fires only on the bar the cross
 * actually happens (not on every bar the fast EMA is above the slow one, which would turn one
 * signal into forty), and only when the regime classifier independently agrees there is a trend.
 */

import { closes, ema, latest, seriesFor, adx as computeAdx, atr as computeAtr } from '@plumb/market';

import { makeDraft, type StrategyContext, type StrategyModule } from '../module.js';
import type { SignalDraft } from '../signal.js';

export const TREND_EMA_ID = 'trend_ema';
const VERSION = '1.0.0';

const FAST = 20;
const SLOW = 50;

function evaluate(context: StrategyContext): readonly SignalDraft[] {
  const { snapshot, regime, config, now } = context;
  const settings = config.trendEma;
  const tf = settings.timeframe;

  if (regime.label !== 'trending_up' && regime.label !== 'trending_down') return [];

  const candles = seriesFor(snapshot, tf);
  if (candles === undefined || candles.length < SLOW + 30) return [];

  const price = closes(candles);
  const fast = ema(price, FAST);
  const slow = ema(price, SLOW);
  const i = price.length - 1;

  const fastNow = fast[i];
  const slowNow = slow[i];
  const fastPrev = fast[i - 1];
  const slowPrev = slow[i - 1];
  if (
    fastNow === undefined ||
    slowNow === undefined ||
    fastPrev === undefined ||
    slowPrev === undefined
  ) {
    return [];
  }

  // The CROSS, not the state. Firing on "fast is above slow" would emit on every bar of a trend.
  const crossedUp = fastPrev <= slowPrev && fastNow > slowNow;
  const crossedDown = fastPrev >= slowPrev && fastNow < slowNow;
  if (!crossedUp && !crossedDown) return [];

  // Only with the trend the classifier already found — never counter-trend.
  const side = crossedUp ? 'long' : 'short';
  if (side === 'long' && regime.label !== 'trending_up') return [];
  if (side === 'short' && regime.label !== 'trending_down') return [];

  const directional = computeAdx(candles, 14);
  const adxValue = latest(directional.adx);
  if (adxValue === undefined || adxValue < settings.adxMin) return [];

  const atrValue = latest(computeAtr(candles, 14));
  const entryPrice = price[i];
  if (atrValue === undefined || atrValue <= 0 || entryPrice === undefined) return [];

  const stopPrice =
    side === 'long'
      ? entryPrice - settings.atrMultiple * atrValue
      : entryPrice + settings.atrMultiple * atrValue;
  if (stopPrice <= 0) return [];

  return [
    makeDraft({
      snapshot,
      side,
      entryPrice,
      stopPrice,
      stopBasis: 'atr',
      timeframe: tf,
      strategyId: TREND_EMA_ID,
      version: VERSION,
      regime,
      inputs: {
        emaFast: fastNow,
        emaSlow: slowNow,
        emaFastPrev: fastPrev,
        emaSlowPrev: slowPrev,
        adx: adxValue,
        atr: atrValue,
        close: entryPrice,
        atrMultiple: settings.atrMultiple,
        regimeConfidence: regime.confidence,
      },
      conditions: [
        `close back through EMA${SLOW} against the position`,
        `ADX falls below ${settings.adxMin}`,
        'regime leaves ' + regime.label,
      ],
      config,
      now,
    }),
  ];
}

export const trendEma: StrategyModule = Object.freeze({
  id: TREND_EMA_ID,
  version: VERSION,
  requiresConfirmation: false,
  evaluate,
});
