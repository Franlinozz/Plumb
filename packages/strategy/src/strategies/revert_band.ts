/**
 * CANDIDATE STRATEGY — Bollinger band touch with an RSI extreme, mean reversion.
 *
 * **No edge is claimed, and this is the one most likely to fail.** Fading extremes works in a
 * range and is catastrophic in a trend, which is exactly why it is gated to `ranging` with a hard
 * ADX ceiling on top. It is kept deliberately un-tuned so that P4's backtest can say so plainly
 * rather than being flattered into looking viable.
 */

import {
  atr as computeAtr,
  adx as computeAdx,
  bollinger,
  closes,
  latest,
  rsi,
  seriesFor,
} from '@plumb/market';

import { makeDraft, type StrategyContext, type StrategyModule } from '../module.js';
import type { SignalDraft } from '@plumb/core';

export const REVERT_BAND_ID = 'revert_band';
const VERSION = '1.0.0';

function evaluate(context: StrategyContext): readonly SignalDraft[] {
  const { snapshot, regime, config, now } = context;
  const settings = config.revertBand;
  const tf = settings.timeframe;

  // Ranging only. Fading a trend is how a mean-reversion book dies.
  if (regime.label !== 'ranging') return [];

  const candles = seriesFor(snapshot, tf);
  if (candles === undefined || candles.length < 60) return [];

  const directional = computeAdx(candles, 14);
  const adxValue = latest(directional.adx);
  if (adxValue === undefined || adxValue >= settings.adxMax) return [];

  const price = closes(candles);
  const bands = bollinger(price, 20, 2);
  const i = price.length - 1;
  const bar = candles[i];
  const upper = bands.upper[i];
  const lower = bands.lower[i];
  const middle = bands.middle[i];
  const rsiValue = latest(rsi(price, 14));
  const atrValue = latest(computeAtr(candles, 14));
  const entryPrice = price[i];

  if (
    bar === undefined ||
    upper === undefined ||
    lower === undefined ||
    middle === undefined ||
    rsiValue === undefined ||
    atrValue === undefined ||
    atrValue <= 0 ||
    entryPrice === undefined
  ) {
    return [];
  }

  const touchedLower = bar.low <= lower;
  const touchedUpper = bar.high >= upper;

  let side: 'long' | 'short' | undefined;
  if (touchedLower && rsiValue <= settings.rsiOversold) side = 'long';
  else if (touchedUpper && rsiValue >= settings.rsiOverbought) side = 'short';
  if (side === undefined) return [];

  // Stop BEYOND the band, not at it: the band is where we expect price to turn, so a stop on it
  // is a stop at the exact price the thesis says will be tested.
  const stopPrice =
    side === 'long' ? lower - settings.atrMultiple * atrValue : upper + settings.atrMultiple * atrValue;
  if (stopPrice <= 0) return [];

  // When price has already collapsed FAR through the band, `lower - kATR` can land ABOVE the
  // close — a "stop" on the profitable side, which is not a stop at all. The gate catches this
  // (and did, six times over 180 days of real history), but a strategy should not be emitting
  // geometrically impossible orders and relying on a downstream check to tidy up.
  if (side === 'long' && stopPrice >= entryPrice) return [];
  if (side === 'short' && stopPrice <= entryPrice) return [];

  return [
    makeDraft({
      snapshot,
      side,
      entryPrice,
      stopPrice,
      stopBasis: 'structure',
      timeframe: tf,
      strategyId: REVERT_BAND_ID,
      version: VERSION,
      regime,
      inputs: {
        rsi: rsiValue,
        bbUpper: upper,
        bbMiddle: middle,
        bbLower: lower,
        adx: adxValue,
        atr: atrValue,
        close: entryPrice,
        high: bar.high,
        low: bar.low,
        atrMultiple: settings.atrMultiple,
        regimeConfidence: regime.confidence,
      },
      conditions: [
        'price closes beyond the band it was faded at',
        `ADX rises above ${settings.adxMax}`,
        'regime leaves ranging',
        'mean (Bollinger middle) reached',
      ],
      config,
      now,
    }),
  ];
}

export const revertBand: StrategyModule = Object.freeze({
  id: REVERT_BAND_ID,
  version: VERSION,
  requiresConfirmation: false,
  evaluate,
});
