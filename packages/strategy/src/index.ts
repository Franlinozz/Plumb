import { LOCKED } from '@plumb/core';
import { tradableUniverse } from '@plumb/market';

/**
 * @plumb/strategy — pure signal generation.
 *
 * ZERO I/O, ZERO network, ZERO clock reads, ZERO unseeded randomness. Given a `MarketSnapshot` it
 * returns `Signal[]`. `purity.test.ts` reads this package's own source and fails on any forbidden
 * token, so the guarantee is checked rather than asserted.
 *
 * Guardrail 1: this package emits Signals and CANNOT place orders — `@plumb/executor` is not
 * reachable from here at any depth, and `no-order-path.test.ts` proves it against the real
 * workspace manifests.
 */
export const STRATEGY_PACKAGE = Object.freeze({
  name: '@plumb/strategy',
  /** Proposes. Never disposes. */
  responsibility: 'propose',
  /** Guardrail 1. There is no code path from here to an order. */
  canPlaceOrders: false,
  universe: tradableUniverse(),
  /** Sizing is not this package's job — risk sizes from the stop distance. */
  perTradeRiskUsdt: LOCKED.PER_TRADE_RISK_USDT,
  /** Pinned by a test: no clock, no randomness, no network in this package. */
  isPure: true,
});

// The Signal type and the id factories live in @plumb/core — every package downstream of a
// signal needs them, and routing `risk` through `strategy` to reach a type would have given
// `executor` a transitive path back to strategy internals. Re-exported for convenience.
export {
  SignalSchema,
  SignalSizingLeakError,
  FORBIDDEN_SIGNAL_FIELDS,
  assertNoSizing,
  parseSignal,
  stopDistancePct,
  stopIsOnCorrectSide,
  takeProfitLevels,
  createEntropyIdFactory,
  createSeededIdFactory,
  type Signal,
  type SignalDraft,
  type SignalIdFactory,
} from '@plumb/core';

export { classifyRegime } from './regime.js';

export {
  clamp01,
  defined,
  median,
  percentileRank,
  rangeExcludingLast,
  tail,
} from './stats.js';

export {
  makeDraft,
  type DraftInput,
  type StrategyContext,
  type StrategyModule,
} from './module.js';

export {
  ALL_STRATEGIES,
  STRATEGY_IDS,
  breakoutRange,
  classifyOiState,
  fundingSkew,
  oiDivergence,
  revertBand,
  sessionBias,
  trendEma,
  volExpansion,
  SURVIVING_HOURS,
  TRADED_STATES,
  BREAKOUT_RANGE_ID,
  FUNDING_SKEW_ID,
  OI_DIVERGENCE_ID,
  REVERT_BAND_ID,
  SESSION_BIAS_ID,
  TREND_EMA_ID,
  VOL_EXPANSION_ID,
  type OiState,
} from './strategies/index.js';

export {
  cooldownKey,
  runGate,
  type GateConflict,
  type GateInput,
  type GateRejection,
  type GateRejectionCode,
  type GateResult,
} from './gate.js';

export {
  applyPortfolioRules,
  signalQuality,
  type PortfolioDrop,
  type PortfolioDropCode,
  type PortfolioResult,
} from './portfolio.js';

export {
  RATIONALE_CONTRACT,
  buildRationalePayload,
  findUnsanctionedNumbers,
  type RationalePayload,
} from './rationale.js';

export {
  runCycle,
  runCycleSeeded,
  type CycleResult,
  type EngineDeps,
} from './engine.js';

export {
  DEFAULT_STRATEGY_CONFIG,
  EMPTY_STATE,
  REGIME_LABELS,
  type EngineState,
  type GateConfig,
  type OpenPosition,
  type PortfolioConfig,
  type RegimeAssessment,
  type RegimeConfig,
  type RegimeHint,
  type RegimeLabel,
  type StopConfig,
  type StrategyConfig,
} from './types.js';
