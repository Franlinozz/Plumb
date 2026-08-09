/**
 * The locked parameters, imported — never redefined.
 *
 * This file exists to make a second, deliberately redundant tripwire. `@plumb/core` already pins
 * the values; `params.test.ts` pins them again from inside the package that spends money. If
 * somebody edits `locked.ts` and updates its test in the same commit, this one still fails.
 *
 * Redundancy is the point. This is the only package where being wrong costs real money.
 */

import { DERIVED, LOCKED } from '@plumb/core';

export { LOCKED, DERIVED };

/** Config the operator may tune. Nothing here can loosen a LOCKED parameter. */
export interface RiskConfig {
  /**
   * Fraction of the per-trade risk budget that estimated funding may consume before the trade
   * stops being worth taking. A trade that pays more in funding than it risks is not a trade.
   */
  readonly maxFundingFractionOfRisk: number;
  /** Combined notional cap for same-direction positions across correlated instruments. */
  readonly correlatedNotionalCapUsdt: number;
  /** Slippage assumed when checking that a stop is reachable. */
  readonly assumedSlippagePct: number;
}

export const DEFAULT_RISK_CONFIG: RiskConfig = Object.freeze({
  maxFundingFractionOfRisk: 0.25,
  correlatedNotionalCapUsdt: 600,
  assumedSlippagePct: 0.0005,
});

/**
 * Startup assertion.
 *
 * Called by `createGovernor` before it will do anything. If the constitution and the code have
 * drifted apart, the system refuses to start rather than trading on the difference.
 */
export function assertLockedParameters(): void {
  const problems: string[] = [];
  const check = (name: string, actual: unknown, expected: unknown): void => {
    if (actual !== expected) problems.push(`${name}: expected ${String(expected)}, got ${String(actual)}`);
  };

  check('CAPITAL_USDT', LOCKED.CAPITAL_USDT, 400);
  check('KILL_SWITCH_EQUITY_USDT', LOCKED.KILL_SWITCH_EQUITY_USDT, 335);
  check('MAX_LOSS_USDT', LOCKED.MAX_LOSS_USDT, 65);
  check('DAILY_LOSS_LIMIT_USDT', LOCKED.DAILY_LOSS_LIMIT_USDT, 20);
  check('PER_TRADE_RISK_USDT', LOCKED.PER_TRADE_RISK_USDT, 4);
  check('LEVERAGE_CEILING', LOCKED.LEVERAGE_CEILING, 3);
  check('MAX_CONCURRENT_POSITIONS', LOCKED.MAX_CONCURRENT_POSITIONS, 2);
  check('MAX_TOTAL_NOTIONAL_USDT', LOCKED.MAX_TOTAL_NOTIONAL_USDT, 800);
  check('ACCOUNTING_BASIS', LOCKED.ACCOUNTING_BASIS, 'agent-trade-kit');
  check('INSTRUMENTS.length', LOCKED.INSTRUMENTS.length, 3);
  check('INSTRUMENTS[0]', LOCKED.INSTRUMENTS[0], 'BTC-USDT-SWAP');
  check('INSTRUMENTS[1]', LOCKED.INSTRUMENTS[1], 'ETH-USDT-SWAP');
  check('INSTRUMENTS[2]', LOCKED.INSTRUMENTS[2], 'SOL-USDT-SWAP');

  // Derived invariants, restated here so a change to one side is caught from the other.
  check(
    'CAPITAL - MAX_LOSS = KILL_SWITCH_EQUITY',
    LOCKED.CAPITAL_USDT - LOCKED.MAX_LOSS_USDT,
    LOCKED.KILL_SWITCH_EQUITY_USDT,
  );
  if (Math.abs(DERIVED.perTradeRiskFraction - 0.01) > 1e-12) {
    problems.push(`PER_TRADE_RISK is not 1% of capital (got ${DERIVED.perTradeRiskFraction})`);
  }
  if (LOCKED.MAX_TOTAL_NOTIONAL_USDT > DERIVED.leveragedNotionalCeilingUsdt) {
    problems.push('MAX_TOTAL_NOTIONAL exceeds what the leverage ceiling permits');
  }

  // The averaging-down prohibition is structural: there must be no key that could enable it.
  const forbidden = /averag|scale[\s_-]?in|\bdca\b|add[\s_-]?to[\s_-]?los|martingale|pyramid/i;
  const offenders = Object.keys(LOCKED).filter((key) => forbidden.test(key));
  if (offenders.length > 0) problems.push(`averaging-down-shaped parameter present: ${offenders.join(', ')}`);

  if (problems.length > 0) {
    throw new Error(
      `LOCKED PARAMETERS do not match the constitution — refusing to start:\n  ${problems.join('\n  ')}`,
    );
  }
}
