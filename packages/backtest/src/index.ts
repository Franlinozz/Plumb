import { LOCKED } from '@plumb/core';

/**
 * @plumb/backtest — the evidence gate.
 *
 * This package decides whether any strategy is permitted to touch real money. It replays the FULL
 * pipeline — snapshot → strategy → gate → portfolio → governor → simulated execution — because a
 * backtest that skips the risk governor measures a system we will never run.
 *
 * **No result is claimed until this package produces one**, and failing the gate is a legitimate
 * outcome: it means we do not trade that configuration.
 */
export const BACKTEST_PACKAGE = Object.freeze({
  name: '@plumb/backtest',
  responsibility: 'measure',
  startingEquityUsdt: LOCKED.CAPITAL_USDT,
  /** The governor is replayed, not assumed. Pinned by a test asserting veto counts are non-zero. */
  governorInTheLoop: true,
});

export {
  DEFAULT_COSTS,
  OKX_FEES,
  ZERO_COSTS,
  describeCosts,
  entryFillPrice,
  exitFillPrice,
  feeUsdt,
  fundingOverHold,
  slippageBps,
  stopFillPrice,
  type CostModel,
  type FundingCharge,
  type FundingSeries,
} from './costs.js';

export {
  LookaheadError,
  assertNoLookahead,
  runBacktest,
  type BacktestOptions,
  type BacktestResult,
  type BacktestTrade,
  type EquityPoint,
} from './engine.js';

export {
  byRegime,
  byStrategy,
  computeMetrics,
  drawdownStats,
  longestLosingStreak,
  sharpeRatio,
  sortinoRatio,
  type DrawdownStats,
  type Metrics,
  type RegimeBreakdown,
  type StrategyBreakdown,
} from './metrics.js';

export {
  DEFAULT_SPLIT,
  buildWindows,
  runWalkForward,
  type WalkForwardOptions,
  type WalkForwardResult,
  type WalkForwardSplit,
  type WalkForwardWindow,
  type WindowResult,
} from './walkforward.js';

export {
  percentile,
  runMonteCarlo,
  type MonteCarloOptions,
  type MonteCarloResult,
} from './monte_carlo.js';

export {
  DEFAULT_CRITERIA,
  evaluateEligibility,
  outlierDependence,
  signRecord,
  verifyRecord,
  type CriterionResult,
  type EligibilityRecord,
  type GateCriteria,
  type GateInput,
  type OutlierCheck,
} from './gate.js';

export {
  renderEquitySvg,
  renderReport,
  summariseRun,
  type ReportInput,
} from './report.js';

export {
  PERMISSIVE_CONFIG,
  PERMISSIVE_ID,
  permissiveStrategy,
} from './testkit.js';

