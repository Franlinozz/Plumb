/**
 * CANDIDATE STRATEGY — intraday session bias. **EXPLICITLY EXPLORATORY.**
 *
 * This module was built only because the measurement justified it, and the measurement is worth
 * reading before the code:
 *
 * `npm run measure` computes mean return and volatility by hour-of-day per instrument across the
 * whole development set (2023-08-06 → 2026-05-12, ~24,200 hourly bars each), then asks which hours
 * keep the SAME SIGN in bull, bear AND chop regimes on ALL THREE instruments with a mean above 2bp.
 *
 * Exactly one hour survived: **08:00 UTC**, positive, on all three —
 * BTC +3.16bp, ETH +3.33bp, SOL +4.65bp. It is a funding-settlement hour, which is a plausible
 * structural reason rather than a coincidence dredged from 24 candidates. Hour 22 had larger raw
 * means (+5.4/+7.1/+7.8bp) but did NOT survive regime segmentation, so it is not traded.
 *
 * ⚠️ **THE EDGE IS SMALLER THAN THE COST OF CAPTURING IT.** A 3–5bp mean move against a 10bp
 * round-trip taker fee is negative before slippage. This module exists so the backtest can measure
 * that rather than assert it — but the arithmetic is not promising, and nobody should be surprised
 * when the gate rejects it.
 */

import { utcHourOf } from '@plumb/core';
import { atr as computeAtr, closes, latest, seriesFor } from '@plumb/market';

import { makeDraft, type StrategyContext, type StrategyModule } from '../module.js';
import type { SignalDraft } from '@plumb/core';

export const SESSION_BIAS_ID = 'session_bias';
const VERSION = '1.0.0';

/**
 * Hours that survived regime segmentation, with their measured sign.
 *
 * Derived from the development set and PINNED here. Adding an hour means re-running the
 * measurement and justifying it, not editing a list.
 */
export const SURVIVING_HOURS: Readonly<Record<number, 'long' | 'short'>> = Object.freeze({
  8: 'long',
});

function evaluate(context: StrategyContext): readonly SignalDraft[] {
  const { snapshot, regime, config, now } = context;
  const settings = config.sessionBias;
  const tf = settings.timeframe;

  const candles = seriesFor(snapshot, tf);
  if (candles === undefined || candles.length < 40) return [];

  const bar = candles[candles.length - 1];
  if (bar === undefined) return [];

  // The hour the CURRENT bar opened, in UTC. The competition clock is UTC+8 but every internal
  // measurement is UTC, and the table above is UTC (AGENTS.md gotcha 8). `utcHourOf` lives in
  // core so this package can stay under a strict no-`new Date()` purity scan.
  const hour = utcHourOf(bar.ts);
  const side = SURVIVING_HOURS[hour];
  if (side === undefined) return [];

  const price = closes(candles);
  const entryPrice = price[price.length - 1];
  const atrValue = latest(computeAtr(candles, 14));
  if (entryPrice === undefined || atrValue === undefined || atrValue <= 0) return [];

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
      strategyId: SESSION_BIAS_ID,
      version: VERSION,
      regime,
      inputs: {
        hourUtc: hour,
        atr: atrValue,
        close: entryPrice,
        regimeConfidence: regime.confidence,
      },
      conditions: [
        `the ${hour}:00 UTC window closes`,
        'the measured hour-of-day effect stops surviving regime segmentation',
      ],
      config,
      now,
    }),
  ];
}

export const sessionBias: StrategyModule = Object.freeze({
  id: SESSION_BIAS_ID,
  version: VERSION,
  requiresConfirmation: false,
  evaluate,
});
