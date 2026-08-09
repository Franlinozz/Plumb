/**
 * CANDIDATE STRATEGY — range breakout, normalised by ATR.
 *
 * **No edge is claimed.** The normalisation is the point: a 200-point break of a range is a
 * different event when ATR is 50 than when ATR is 400. The break is therefore measured in ATR
 * units, not in price, so the same rule means the same thing across BTC, ETH and SOL and across
 * quiet and violent weeks.
 *
 * Gated to `compressed` or `expanding` — a breakout out of an already-trending market is just
 * trend continuation, which `trend_ema` owns.
 */

import { atr as computeAtr, closes, latest, seriesFor } from '@plumb/market';

import { makeDraft, type StrategyContext, type StrategyModule } from '../module.js';
import type { SignalDraft } from '@plumb/core';
import { rangeExcludingLast } from '../stats.js';

export const BREAKOUT_RANGE_ID = 'breakout_range';
const VERSION = '1.0.0';

function evaluate(context: StrategyContext): readonly SignalDraft[] {
  const { snapshot, regime, config, now } = context;
  const settings = config.breakoutRange;
  const tf = settings.timeframe;

  if (regime.label !== 'compressed' && regime.label !== 'expanding') return [];

  const candles = seriesFor(snapshot, tf);
  if (candles === undefined || candles.length < settings.rangeBars + 30) return [];

  const price = closes(candles);
  const i = price.length - 1;
  const entryPrice = price[i];
  const atrValue = latest(computeAtr(candles, 14));
  if (entryPrice === undefined || atrValue === undefined || atrValue <= 0) return [];

  const bounds = rangeExcludingLast(
    candles.map((c) => c.high),
    candles.map((c) => c.low),
    settings.rangeBars,
  );
  if (bounds === undefined) return [];

  // How far past the range the close sits, measured in ATR.
  const breakUp = (entryPrice - bounds.high) / atrValue;
  const breakDown = (bounds.low - entryPrice) / atrValue;

  let side: 'long' | 'short' | undefined;
  let breakStrength = 0;
  if (breakUp >= settings.minBreakAtr) {
    side = 'long';
    breakStrength = breakUp;
  } else if (breakDown >= settings.minBreakAtr) {
    side = 'short';
    breakStrength = breakDown;
  }
  if (side === undefined) return [];

  // Back inside the range means the breakout failed, so that is where the stop belongs —
  // structure, not an arbitrary ATR multiple off the entry.
  const stopPrice =
    side === 'long'
      ? bounds.high - settings.atrMultiple * atrValue
      : bounds.low + settings.atrMultiple * atrValue;
  if (stopPrice <= 0) return [];
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
      strategyId: BREAKOUT_RANGE_ID,
      version: VERSION,
      regime,
      inputs: {
        rangeHigh: bounds.high,
        rangeLow: bounds.low,
        rangeBars: settings.rangeBars,
        breakStrengthAtr: breakStrength,
        atr: atrValue,
        close: entryPrice,
        atrMultiple: settings.atrMultiple,
        regimeConfidence: regime.confidence,
      },
      conditions: [
        'close returns inside the broken range',
        'regime leaves compressed/expanding',
        `break strength falls below ${settings.minBreakAtr} ATR`,
      ],
      config,
      now,
    }),
  ];
}

export const breakoutRange: StrategyModule = Object.freeze({
  id: BREAKOUT_RANGE_ID,
  version: VERSION,
  requiresConfirmation: false,
  evaluate,
});
