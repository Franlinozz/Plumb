/**
 * CANDIDATE STRATEGY — open-interest divergence.
 *
 * **No edge is claimed.** What makes this one worth trying is that open interest is genuine
 * order-flow information the price series alone does not contain: it says whether a move was made
 * by NEW money or by existing positions closing.
 *
 * The four states and their conventional readings:
 *
 *   price ↑ + OI ↑  → new longs entering           continuation bias
 *   price ↑ + OI ↓  → short covering               weaker move, fade bias
 *   price ↓ + OI ↑  → new shorts entering          continuation bias
 *   price ↓ + OI ↓  → long liquidation exhausting  reversion bias
 *
 * Only the two least ambiguous states are traded (`new_longs` and `new_shorts` — the continuation
 * ones), because a "weaker move" is a claim about degree rather than direction and the reading is
 * correspondingly softer. `scripts/oi-states.mjs` measures the forward-return distribution of all
 * four before any of this is trusted.
 */

import { atr as computeAtr, closes, latest, seriesFor } from '@plumb/market';

import { makeDraft, type StrategyContext, type StrategyModule } from '../module.js';
import type { SignalDraft } from '@plumb/core';

export const OI_DIVERGENCE_ID = 'oi_divergence';
const VERSION = '1.0.0';

export type OiState = 'new_longs' | 'short_covering' | 'new_shorts' | 'long_liquidation' | 'flat';

/** Classify a bar from its price change and its open-interest change. */
export function classifyOiState(priceChange: number, oiChange: number, deadband = 0): OiState {
  const priceUp = priceChange > deadband;
  const priceDown = priceChange < -deadband;
  const oiUp = oiChange > deadband;
  const oiDown = oiChange < -deadband;

  if (priceUp && oiUp) return 'new_longs';
  if (priceUp && oiDown) return 'short_covering';
  if (priceDown && oiUp) return 'new_shorts';
  if (priceDown && oiDown) return 'long_liquidation';
  return 'flat';
}

/** The two states whose interpretation is least ambiguous. */
export const TRADED_STATES: ReadonlySet<OiState> = new Set(['new_longs', 'new_shorts']);

function evaluate(context: StrategyContext): readonly SignalDraft[] {
  const { snapshot, regime, config, now } = context;
  const settings = config.oiDivergence;
  const tf = settings.timeframe;

  const history = snapshot.openInterest.history;
  if (history.length < settings.minHistory) return [];

  const candles = seriesFor(snapshot, tf);
  if (candles === undefined || candles.length < 40) return [];

  const price = closes(candles);
  const i = price.length - 1;
  const entryPrice = price[i];
  const previousPrice = price[i - settings.lookbackBars];
  const atrValue = latest(computeAtr(candles, 14));
  if (entryPrice === undefined || previousPrice === undefined || atrValue === undefined || atrValue <= 0) {
    return [];
  }

  // Open interest over the same span. History is chronological, newest last.
  const oiNow = history[history.length - 1]?.oi;
  const oiThen = history[Math.max(0, history.length - 1 - settings.lookbackBars)]?.oi;
  if (oiNow === undefined || oiThen === undefined || oiThen === 0) return [];

  const priceChangePct = (entryPrice - previousPrice) / previousPrice;
  const oiChangePct = (oiNow - oiThen) / oiThen;
  const state = classifyOiState(priceChangePct, oiChangePct, settings.deadbandPct);
  if (!TRADED_STATES.has(state)) return [];

  // Require the move itself to be material, not a rounding error dressed up as order flow.
  if (Math.abs(priceChangePct) * entryPrice < settings.minMoveAtr * atrValue) return [];

  // Continuation: go WITH the direction new money is entering.
  const side: 'long' | 'short' = state === 'new_longs' ? 'long' : 'short';
  const stopPrice =
    side === 'long' ? entryPrice - settings.atrMultiple * atrValue : entryPrice + settings.atrMultiple * atrValue;
  if (stopPrice <= 0) return [];

  return [
    makeDraft({
      snapshot,
      side,
      entryPrice,
      stopPrice,
      stopBasis: 'atr',
      timeframe: tf,
      strategyId: OI_DIVERGENCE_ID,
      version: VERSION,
      regime,
      inputs: {
        priceChangePct,
        oiChangePct,
        oiNow,
        oiThen,
        atr: atrValue,
        close: entryPrice,
        // 1 = new_longs, 2 = new_shorts. Kept numeric because `inputs` is a number map.
        oiState: state === 'new_longs' ? 1 : 2,
        regimeConfidence: regime.confidence,
      },
      conditions: [
        'open interest reverses while price holds — the new money left',
        'the move retraces beyond the entry',
        'regime changes',
      ],
      config,
      now,
    }),
  ];
}

export const oiDivergence: StrategyModule = Object.freeze({
  id: OI_DIVERGENCE_ID,
  version: VERSION,
  requiresConfirmation: false,
  evaluate,
});
