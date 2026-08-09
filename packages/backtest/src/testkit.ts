/**
 * A PERMISSIVE STRATEGY, for exercising the harness.
 *
 * It fires on almost every bar, which is exactly what is needed to prove the governor is genuinely
 * in the loop: a strategy that rarely signals cannot demonstrate that vetoes happen.
 *
 * **It is not a candidate and claims nothing.** Its only job is to generate enough order flow that
 * the machinery around it can be tested. Pure, deterministic, no clock, no I/O.
 */

import {
  atr as computeAtr,
  closes,
  latest,
  seriesFor,
  type Timeframe,
} from '@plumb/market';
import {
  DEFAULT_STRATEGY_CONFIG,
  makeDraft,
  type SignalDraft,
  type StrategyConfig,
  type StrategyContext,
  type StrategyModule,
} from '@plumb/strategy';

export const PERMISSIVE_ID = 'permissive_test';

function evaluate(context: StrategyContext): readonly SignalDraft[] {
  const { snapshot, regime, config, now } = context;
  const tf: Timeframe = config.trendEma.timeframe;
  const candles = seriesFor(snapshot, tf);
  if (candles === undefined || candles.length < 40) return [];

  const price = closes(candles);
  const entryPrice = price[price.length - 1];
  const atrValue = latest(computeAtr(candles, 14));
  if (entryPrice === undefined || atrValue === undefined || atrValue <= 0) return [];

  // Alternate direction off the bar timestamp so the book is not accidentally hedged into safety.
  const bar = candles[candles.length - 1];
  const side = bar !== undefined && Math.floor(bar.ts / 3_600_000) % 2 === 0 ? 'long' : 'short';
  // Stop width comes from config so a caller can widen it. A TIGHT stop demands a large notional,
  // and MAX_TOTAL_NOTIONAL (800 on 400 equity) binds long before the 3x leverage ceiling does —
  // so a 1.5x-ATR permissive strategy is vetoed on every single bar and never reaches placement.
  const multiple = config.trendEma.atrMultiple;
  const stopPrice = side === 'long' ? entryPrice - multiple * atrValue : entryPrice + multiple * atrValue;
  if (stopPrice <= 0) return [];

  return [
    makeDraft({
      snapshot,
      side,
      entryPrice,
      stopPrice,
      stopBasis: 'atr',
      timeframe: tf,
      strategyId: PERMISSIVE_ID,
      version: '0.0.0-test',
      regime,
      inputs: { atr: atrValue, close: entryPrice, atrMultiple: multiple, regimeConfidence: regime.confidence },
      conditions: ['test strategy — no thesis'],
      config,
      now,
    }),
  ];
}

export const permissiveStrategy: StrategyModule = Object.freeze({
  id: PERMISSIVE_ID,
  version: '0.0.0-test',
  requiresConfirmation: false,
  evaluate,
});

/**
 * Config that lets the permissive strategy through the pre-emission gate.
 *
 * Note what is NOT relaxed: the regime must still not be `unclear`, stops must still be sane, and
 * every locked risk parameter still applies. Only the discretionary gate knobs move.
 */
export const PERMISSIVE_CONFIG: StrategyConfig = Object.freeze({
  ...DEFAULT_STRATEGY_CONFIG,
  enabled: Object.freeze({ [PERMISSIVE_ID]: true }),
  gate: Object.freeze({ minRegimeConfidence: 0, cooldownMs: 0 }),
  portfolio: Object.freeze({ maxCorrelatedPerCycle: 3 }),
});
