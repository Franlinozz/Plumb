import { TIMEFRAME_MS, type MarketSnapshot, type Timeframe } from '@plumb/market';

import { stopDistancePct, takeProfitLevels, type SignalDraft } from './signal.js';
import type { EngineState, RegimeAssessment, StrategyConfig } from './types.js';

/**
 * What a strategy module sees. Everything is passed IN — no strategy reads state, the clock,
 * or the outside world. `now` is injected; `Date.now()` does not appear in this package.
 */
export interface StrategyContext {
  readonly snapshot: MarketSnapshot;
  readonly regime: RegimeAssessment;
  readonly state: EngineState;
  readonly config: StrategyConfig;
  readonly now: number;
  /**
   * Drafts produced by the base strategies in THIS cycle. Only modules with
   * `requiresConfirmation` may read it, and it is empty for everyone else.
   */
  readonly peers: readonly SignalDraft[];
}

export interface StrategyModule {
  readonly id: string;
  readonly version: string;
  /** True → evaluated in a second pass, and may only fire when a peer agrees. */
  readonly requiresConfirmation: boolean;
  evaluate(context: StrategyContext): readonly SignalDraft[];
}

export interface DraftInput {
  readonly snapshot: MarketSnapshot;
  readonly side: 'long' | 'short';
  readonly entryPrice: number;
  readonly stopPrice: number;
  readonly stopBasis: 'atr' | 'structure';
  readonly timeframe: Timeframe;
  readonly strategyId: string;
  readonly version: string;
  readonly regime: RegimeAssessment;
  readonly inputs: Readonly<Record<string, number>>;
  readonly conditions: readonly string[];
  readonly config: StrategyConfig;
  readonly now: number;
}

/**
 * Assemble a draft. The single place a strategy turns a decision into a Signal shape, so the
 * derived fields (stop distance, take-profit R levels, expiry) are computed one way everywhere.
 *
 * Note what is NOT computed here: size, notional, leverage. Those are `@plumb/risk`'s job and the
 * `Signal` type has nowhere to put them.
 */
export function makeDraft(input: DraftInput): SignalDraft {
  const distancePct = stopDistancePct(input.entryPrice, input.stopPrice);
  const barMs = TIMEFRAME_MS[input.timeframe];
  return {
    instId: input.snapshot.instId,
    side: input.side,
    intent: 'open',
    entry: { type: 'market', price: input.entryPrice },
    stop: { price: input.stopPrice, distancePct, basis: input.stopBasis },
    takeProfit: [
      ...takeProfitLevels(
        input.side,
        input.entryPrice,
        input.stopPrice,
        input.config.takeProfitR,
      ),
    ],
    timeframe: input.timeframe,
    strategyId: input.strategyId,
    regime: input.regime.label,
    inputs: input.inputs,
    invalidation: {
      maxHoldBars: input.config.maxHoldBars,
      conditions: [...input.conditions],
    },
    expiresAt: input.now + input.config.expiryBars * barMs,
    version: input.version,
  };
}
