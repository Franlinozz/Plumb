import { LOCKED } from '@plumb/core';
import { tradableUniverse } from '@plumb/market';

/**
 * @plumb/strategy — signal generation.
 *
 * Placeholder. The real generator lands in a later phase, and **no edge is claimed for it
 * until `@plumb/backtest` and paper trading produce evidence.**
 *
 * Guardrail 1 (SIGNAL PRIMACY): this package emits `Signal` objects and cannot place an
 * order. That is structural, not a promise — `@plumb/strategy` does not depend on
 * `@plumb/executor`, directly or transitively, and `no-order-path.test.ts` proves it.
 */
export const STRATEGY_PACKAGE = Object.freeze({
  name: '@plumb/strategy',
  /** Proposes. Never disposes. */
  responsibility: 'propose',
  /** Guardrail 1. There is no code path from here to an order. */
  canPlaceOrders: false,
  universe: tradableUniverse(),
  /** Sizing is not this package's job either — risk sizes from the stop distance. */
  perTradeRiskUsdt: LOCKED.PER_TRADE_RISK_USDT,
});
