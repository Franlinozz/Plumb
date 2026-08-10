/**
 * CANDIDATE STRATEGY — volatility compression, then the break out of it.
 *
 * **No edge is claimed.** The reasoning is that volatility CLUSTERS: quiet begets quiet and violent
 * begets violent, which is among the most robust empirical regularities in markets and is far more
 * predictable than direction. So the bet is that expansion OCCURS, not on which way it breaks —
 * the direction is taken from the break itself rather than forecast.
 *
 * The stop sits INSIDE the compressed range, which is what makes the risk/reward asymmetric: the
 * risk is the width of a quiet range, while the reward is whatever the expansion delivers.
 */

import {
  atr as computeAtr,
  bollinger,
  closes,
  latest,
  realisedVolatility,
  seriesFor,
} from '@plumb/market';

import { makeDraft, type StrategyContext, type StrategyModule } from '../module.js';
import type { SignalDraft } from '@plumb/core';
import { percentileRank, tail, defined } from '../stats.js';

export const VOL_EXPANSION_ID = 'vol_expansion';
const VERSION = '1.0.0';

function evaluate(context: StrategyContext): readonly SignalDraft[] {
  const { snapshot, regime, config, now } = context;
  const settings = config.volExpansion;
  const tf = settings.timeframe;

  const candles = seriesFor(snapshot, tf);
  if (candles === undefined || candles.length < settings.compressionLookback + 40) return [];

  const price = closes(candles);
  const i = price.length - 1;
  const entryPrice = price[i];
  const bar = candles[i];
  const atrValue = latest(computeAtr(candles, 14));
  if (entryPrice === undefined || bar === undefined || atrValue === undefined || atrValue <= 0) return [];

  // ── 1. Was the market COMPRESSED before this bar? ────────────────────────────────────────
  // Measured on the bar BEFORE the break, so the break itself does not inflate the reading.
  const bandwidth = bollinger(price, 20, 2).bandwidth;
  const vol = realisedVolatility(price, 20);
  const priorBandwidth = bandwidth[i - 1];
  const priorVol = vol[i - 1];
  if (priorBandwidth === undefined || priorVol === undefined) return [];

  const window = settings.compressionLookback;
  const bandwidthPct = percentileRank(priorBandwidth, tail(defined(bandwidth).slice(0, -1), window));
  const volPct = percentileRank(priorVol, tail(defined(vol).slice(0, -1), window));
  if (bandwidthPct === undefined || volPct === undefined) return [];
  if (bandwidthPct > settings.compressionPercentile && volPct > settings.compressionPercentile) {
    return [];
  }

  // ── 2. The compressed range itself — the last N bars before this one. ────────────────────
  let rangeHigh = Number.NEGATIVE_INFINITY;
  let rangeLow = Number.POSITIVE_INFINITY;
  const from = Math.max(0, i - settings.rangeBars);
  for (let j = from; j < i; j += 1) {
    const c = candles[j];
    if (c === undefined) continue;
    rangeHigh = Math.max(rangeHigh, c.high);
    rangeLow = Math.min(rangeLow, c.low);
  }
  if (!Number.isFinite(rangeHigh) || !Number.isFinite(rangeLow) || rangeHigh <= rangeLow) return [];

  // ── 3. A DECISIVE break, measured in ATR so it means the same thing on every instrument. ──
  const breakUp = (entryPrice - rangeHigh) / atrValue;
  const breakDown = (rangeLow - entryPrice) / atrValue;
  let side: 'long' | 'short' | undefined;
  let strength = 0;
  if (breakUp >= settings.minBreakAtr) {
    side = 'long';
    strength = breakUp;
  } else if (breakDown >= settings.minBreakAtr) {
    side = 'short';
    strength = breakDown;
  }
  if (side === undefined) return [];

  // ── 4. Stop INSIDE the compressed range. The asymmetry is the whole point. ───────────────
  const mid = (rangeHigh + rangeLow) / 2;
  const stopPrice = side === 'long' ? Math.max(mid, rangeLow) : Math.min(mid, rangeHigh);
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
      strategyId: VOL_EXPANSION_ID,
      version: VERSION,
      regime,
      inputs: {
        bandwidthPercentile: bandwidthPct,
        volPercentile: volPct,
        rangeHigh,
        rangeLow,
        breakStrengthAtr: strength,
        atr: atrValue,
        close: entryPrice,
        regimeConfidence: regime.confidence,
      },
      conditions: [
        'price returns inside the compressed range',
        'volatility falls back into its low percentile',
        'expansion fails to follow through',
      ],
      config,
      now,
    }),
  ];
}

export const volExpansion: StrategyModule = Object.freeze({
  id: VOL_EXPANSION_ID,
  version: VERSION,
  requiresConfirmation: false,
  evaluate,
});
