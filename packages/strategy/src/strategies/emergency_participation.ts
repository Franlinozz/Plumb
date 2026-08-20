/**
 * One-entry emergency participation strategy authorised by the operator on 2026-08-20.
 *
 * It is intentionally absent from ALL_STRATEGIES and the P8 defaults. It makes no expected-edge
 * claim. Its only job is to deterministically choose the direction of one minimum-lot entry from
 * a fully closed 4H trend while avoiding an already-extreme 1H RSI.
 */
import { EMERGENCY_PARTICIPATION_AMENDMENT, takeProfitLevels, type SignalDraft } from '@plumb/core';
import { atr, latest, rsi, closes, seriesFor } from '@plumb/market';

import type { StrategyContext, StrategyModule } from '../module.js';
import { classifyFourHourTrend } from './competition_trend_pullback.js';

export const EMERGENCY_PARTICIPATION_ID = EMERGENCY_PARTICIPATION_AMENDMENT.strategyId;

function evaluate(context: StrategyContext): readonly SignalDraft[] {
  const { snapshot, now } = context;
  const hourly = seriesFor(snapshot, '1H');
  const fourHour = seriesFor(snapshot, '4H');
  if (hourly === undefined || fourHour === undefined || hourly.length < 60 || fourHour.length < 60) return [];

  const trend = classifyFourHourTrend(fourHour);
  if (trend.direction === 'none' || trend.adx === undefined) return [];
  const hourlyRsi = latest(rsi(closes(hourly), 14));
  const hourlyAtr = latest(atr(hourly, 14));
  if (hourlyRsi === undefined || hourlyAtr === undefined || hourlyAtr <= 0 ||
      hourlyRsi < EMERGENCY_PARTICIPATION_AMENDMENT.minOneHourRsi ||
      hourlyRsi > EMERGENCY_PARTICIPATION_AMENDMENT.maxOneHourRsi) return [];

  const side = trend.direction === 'up' ? 'long' : 'short';
  const entryPrice = snapshot.last;
  const swing = hourly.slice(-6);
  const structuralStop = side === 'long'
    ? Math.min(...swing.map((bar) => bar.low)) - 0.25 * hourlyAtr
    : Math.max(...swing.map((bar) => bar.high)) + 0.25 * hourlyAtr;
  const minimumDistanceStop = side === 'long'
    ? entryPrice * (1 - EMERGENCY_PARTICIPATION_AMENDMENT.minStopDistancePct)
    : entryPrice * (1 + EMERGENCY_PARTICIPATION_AMENDMENT.minStopDistancePct);
  const stopPrice = side === 'long'
    ? Math.min(structuralStop, minimumDistanceStop)
    : Math.max(structuralStop, minimumDistanceStop);
  if (stopPrice <= 0 || (side === 'long' ? stopPrice >= entryPrice : stopPrice <= entryPrice)) return [];

  return [{
    instId: snapshot.instId,
    side,
    intent: 'open',
    entry: { type: 'market', price: entryPrice },
    stop: {
      price: stopPrice,
      distancePct: Math.abs(entryPrice - stopPrice) / entryPrice,
      basis: 'structure',
    },
    takeProfit: [...takeProfitLevels(side, entryPrice, stopPrice, [1.5])],
    timeframe: '1H',
    strategyId: EMERGENCY_PARTICIPATION_ID,
    regime: side === 'long' ? 'trending_up' : 'trending_down',
    inputs: {
      fourHourEmaFast: trend.emaFast as number,
      fourHourEmaSlow: trend.emaSlow as number,
      fourHourAdx: trend.adx,
      fourHourPlusDi: trend.plusDi as number,
      fourHourMinusDi: trend.minusDi as number,
      hourlyRsi,
      hourlyAtr,
      referencePrice: entryPrice,
    },
    invalidation: {
      maxHoldBars: 6,
      conditions: [
        'closed 4H trend no longer agrees',
        'hard stop or take profit executes',
        'six-hour time stop',
      ],
    },
    expiresAt: now + EMERGENCY_PARTICIPATION_AMENDMENT.maxValidityMs,
    version: EMERGENCY_PARTICIPATION_AMENDMENT.strategyVersion,
  }];
}

export const emergencyParticipation: StrategyModule = Object.freeze({
  id: EMERGENCY_PARTICIPATION_ID,
  version: EMERGENCY_PARTICIPATION_AMENDMENT.strategyVersion,
  requiresConfirmation: false,
  evaluate,
});
