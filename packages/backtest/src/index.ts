import { LOCKED } from '@plumb/core';
import { tradableUniverse } from '@plumb/market';
import { RISK_PACKAGE } from '@plumb/risk';
import { STRATEGY_PACKAGE } from '@plumb/strategy';

/**
 * @plumb/backtest — historical replay and honest metrics.
 *
 * Placeholder. **No backtest has been run and no result is claimed anywhere in this
 * repository.** When this package produces one, the result and the code that produced it
 * land in the same commit, and `resultsAvailable` flips with them (guardrail 8).
 *
 * A replay is only meaningful if it runs the signals through the same risk governor the
 * live system uses, which is why this package depends on `@plumb/risk` rather than
 * reimplementing sizing.
 */
export const BACKTEST_PACKAGE = Object.freeze({
  name: '@plumb/backtest',
  responsibility: 'measure',
  /** Flips only when a real replay over real historical data has produced a real number. */
  resultsAvailable: false,
  universe: tradableUniverse(),
  strategyUnderTest: STRATEGY_PACKAGE.name,
  governedBy: RISK_PACKAGE.name,
  startingEquityUsdt: LOCKED.CAPITAL_USDT,
});
