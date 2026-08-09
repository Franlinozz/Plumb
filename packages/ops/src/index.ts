import { LOCKED } from '@plumb/core';
import { ASP_PACKAGE } from '@plumb/asp';
import { EXECUTOR_PACKAGE } from '@plumb/executor';
import { MARKET_PACKAGE } from '@plumb/market';
import { RISK_PACKAGE } from '@plumb/risk';
import { STRATEGY_PACKAGE } from '@plumb/strategy';

/**
 * @plumb/ops — alerts, the daily written review, health checks and the operator CLI.
 *
 * Placeholder. This is the only package that sees the whole pipeline, so it is where the
 * ordering is asserted: **publish before execute**. `@plumb/asp` sits ahead of
 * `@plumb/executor` in `PIPELINE`, and a test pins that.
 */
export const PIPELINE = Object.freeze([
  MARKET_PACKAGE.name,
  STRATEGY_PACKAGE.name,
  RISK_PACKAGE.name,
  ASP_PACKAGE.name,
  EXECUTOR_PACKAGE.name,
] as const);

export const OPS_PACKAGE = Object.freeze({
  name: '@plumb/ops',
  responsibility: 'supervise',
  pipeline: PIPELINE,
  dailyLossLimitUsdt: LOCKED.DAILY_LOSS_LIMIT_USDT,
  /**
   * All internal accounting is UTC. The competition clock is UTC+8 and every conversion
   * between them is explicit — an implicit one inside a daily loss limit is a money bug.
   */
  accountingTimezone: 'UTC',
  competitionTimezone: 'UTC+8',
});
