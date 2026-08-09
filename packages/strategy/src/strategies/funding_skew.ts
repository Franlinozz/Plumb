/**
 * CANDIDATE STRATEGY — funding extreme, faded, and never alone.
 *
 * **No edge is claimed.** Positive funding means longs are paying shorts, i.e. the crowd is long.
 * At a historical extreme that crowding is a liability, so the bias is AGAINST it.
 *
 * Two deliberate constraints:
 *  1. The extreme is **percentile-ranked against this instrument's own funding history**, never an
 *     absolute threshold. "0.01% funding" is unremarkable on one instrument and a record on
 *     another; only the rank carries information.
 *  2. **It never fires alone.** Crowding is a reason to prefer a direction, not a reason to enter.
 *     It requires a same-side draft from one of the other three strategies in the same cycle, and
 *     `requiresConfirmation` puts it in the second evaluation pass so that peers exist to check.
 */

import { atr as computeAtr, closes, latest, seriesFor } from '@plumb/market';

import { makeDraft, type StrategyContext, type StrategyModule } from '../module.js';
import type { SignalDraft } from '@plumb/core';
import { percentileRank } from '../stats.js';

export const FUNDING_SKEW_ID = 'funding_skew';
const VERSION = '1.0.0';

function evaluate(context: StrategyContext): readonly SignalDraft[] {
  const { snapshot, regime, config, now, peers } = context;
  const settings = config.fundingSkew;
  const tf = settings.timeframe;

  // Never alone. No peer, no signal — before any other work.
  if (peers.length === 0) return [];

  const history = snapshot.funding.history;
  if (history.length < settings.minHistory) return [];

  const rates = history.map((h) => h.fundingRate);
  const current = snapshot.funding.current;
  const rank = percentileRank(current, rates);
  if (rank === undefined) return [];

  // High funding → crowd is long → fade short. Low/negative → crowd is short → fade long.
  let side: 'long' | 'short' | undefined;
  if (rank >= settings.extremePercentile) side = 'short';
  else if (rank <= 1 - settings.extremePercentile) side = 'long';
  if (side === undefined) return [];

  // Confirmation: a peer on this instrument must independently want the same direction.
  const confirming = peers.filter((p) => p.instId === snapshot.instId && p.side === side);
  if (confirming.length === 0) return [];

  const candles = seriesFor(snapshot, tf);
  if (candles === undefined || candles.length < 60) return [];
  const price = closes(candles);
  const entryPrice = price[price.length - 1];
  const atrValue = latest(computeAtr(candles, 14));
  if (entryPrice === undefined || atrValue === undefined || atrValue <= 0) return [];

  const stopPrice = side === 'long' ? entryPrice - 2 * atrValue : entryPrice + 2 * atrValue;
  if (stopPrice <= 0) return [];

  const first = confirming[0];
  return [
    makeDraft({
      snapshot,
      side,
      entryPrice,
      stopPrice,
      stopBasis: 'atr',
      timeframe: tf,
      strategyId: FUNDING_SKEW_ID,
      version: VERSION,
      regime,
      inputs: {
        fundingRate: current,
        fundingPercentile: rank,
        fundingHistoryLength: history.length,
        confirmingPeers: confirming.length,
        atr: atrValue,
        close: entryPrice,
        regimeConfidence: regime.confidence,
      },
      conditions: [
        'funding returns toward its median',
        `confirming strategy (${first?.strategyId ?? 'unknown'}) invalidates`,
        'regime changes',
      ],
      config,
      now,
    }),
  ];
}

export const fundingSkew: StrategyModule = Object.freeze({
  id: FUNDING_SKEW_ID,
  version: VERSION,
  requiresConfirmation: true,
  evaluate,
});
