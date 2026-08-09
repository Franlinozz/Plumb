/**
 * The engine: snapshot in, `Signal[]` out.
 *
 * Pure. The clock and the id source are injected; there is no I/O, no ambient state and no
 * randomness that the caller did not supply. That purity is what makes P4's backtest evidence
 * for the live system rather than a separate program that happens to resemble it.
 *
 * Order of operations, and why:
 *   1. classify the regime once, and share it — two strategies must never disagree about what
 *      kind of market they are in
 *   2. base strategies evaluate
 *   3. confirmation-requiring strategies evaluate, seeing the base drafts as `peers`
 *   4. the gate rejects, with reasons
 *   5. the portfolio coordinator ranks and caps
 *   6. ids and timestamps are stamped, and every signal is validated before it leaves
 */

import type { MarketSnapshot, Timeframe } from '@plumb/market';

import { runGate, type GateConflict, type GateRejection } from './gate.js';
import { createSeededIdFactory, type SignalIdFactory } from './ids.js';
import type { StrategyContext, StrategyModule } from './module.js';
import { applyPortfolioRules, type PortfolioDrop } from './portfolio.js';
import { classifyRegime } from './regime.js';
import { parseSignal, type Signal, type SignalDraft } from './signal.js';
import { ALL_STRATEGIES } from './strategies/index.js';
import {
  DEFAULT_STRATEGY_CONFIG,
  EMPTY_STATE,
  type EngineState,
  type RegimeAssessment,
  type RegimeHint,
  type StrategyConfig,
} from './types.js';

export interface EngineDeps {
  /** Injected clock. `Date.now()` appears nowhere in this package. */
  readonly now: number;
  readonly newId: SignalIdFactory;
  readonly config?: StrategyConfig;
  readonly state?: EngineState;
  readonly modules?: readonly StrategyModule[];
  /** The timeframe the regime is classified on. Defaults to the trend strategy's. */
  readonly regimeTimeframe?: Timeframe;
  /** Reserved for a later phase. Never populated here; see `classifyRegime`. */
  readonly regimeHint?: RegimeHint;
}

export interface CycleResult {
  readonly signals: readonly Signal[];
  readonly regime: RegimeAssessment;
  readonly rejected: readonly GateRejection[];
  readonly conflicts: readonly GateConflict[];
  readonly portfolioDrops: readonly PortfolioDrop[];
  /** Drafts produced before any filtering — useful for diagnosing an engine that has gone quiet. */
  readonly draftCount: number;
}

export function runCycle(snapshot: MarketSnapshot, deps: EngineDeps): CycleResult {
  const config = deps.config ?? DEFAULT_STRATEGY_CONFIG;
  const state = deps.state ?? EMPTY_STATE;
  const modules = deps.modules ?? ALL_STRATEGIES;
  const timeframe = deps.regimeTimeframe ?? config.trendEma.timeframe;

  const regime = classifyRegime(snapshot, timeframe, config.regime, deps.regimeHint);

  const enabled = modules.filter((m) => config.enabled[m.id] !== false);
  const base = enabled.filter((m) => !m.requiresConfirmation);
  const dependent = enabled.filter((m) => m.requiresConfirmation);

  const context = (peers: readonly SignalDraft[]): StrategyContext => ({
    snapshot,
    regime,
    state,
    config,
    now: deps.now,
    peers,
  });

  const baseDrafts: SignalDraft[] = [];
  for (const module of base) baseDrafts.push(...module.evaluate(context([])));

  const dependentDrafts: SignalDraft[] = [];
  for (const module of dependent) dependentDrafts.push(...module.evaluate(context(baseDrafts)));

  const drafts = [...baseDrafts, ...dependentDrafts];

  const gated = runGate({ drafts, snapshot, regime, state, config, now: deps.now });
  const portfolio = applyPortfolioRules(gated.passed, state, config.portfolio);

  const signals = portfolio.selected.map((draft) =>
    // Validated on the way out: a malformed signal throws here rather than reaching the ledger.
    parseSignal({ ...draft, id: deps.newId(), ts: deps.now }),
  );

  return {
    signals,
    regime,
    rejected: gated.rejected,
    conflicts: gated.conflicts,
    portfolioDrops: portfolio.dropped,
    draftCount: drafts.length,
  };
}

/** Convenience for tests and replays: a cycle with a deterministic id source. */
export function runCycleSeeded(
  snapshot: MarketSnapshot,
  now: number,
  overrides: Partial<Omit<EngineDeps, 'now' | 'newId'>> & { readonly seed?: number } = {},
): CycleResult {
  const { seed, ...rest } = overrides;
  return runCycle(snapshot, { now, newId: createSeededIdFactory(seed ?? 1), ...rest });
}
