import type { Instrument } from '@plumb/core';
import { REGIME_LABELS, type RegimeLabel } from '@plumb/core';
import type { Timeframe } from '@plumb/market';

/**
 * Market regimes. `unclear` is a first-class, frequent answer — not a failure mode.
 * A classifier that always has an opinion is a classifier that is often wrong, and in this
 * system "I don't know" suppresses signals rather than degrading into a guess.
 *
 * The vocabulary lives in `@plumb/core` because it appears on a `Signal`; the classifier that
 * produces a label lives here.
 */
export { REGIME_LABELS, type RegimeLabel };

export interface RegimeAssessment {
  readonly label: RegimeLabel;
  /** 0..1. Deterministic function of how far the inputs sit past their thresholds. */
  readonly confidence: number;
  readonly timeframe: Timeframe;
  /** The exact numbers that produced the label. Carried into the Signal for audit. */
  readonly inputs: Readonly<Record<string, number>>;
  readonly reasons: readonly string[];
}

/**
 * A regime label from a model, for a LATER phase.
 *
 * Interface only — nothing in this package calls a model. When it is wired, a hint may only
 * *lower* confidence when it disagrees with the deterministic classifier. It may never change
 * the label, and it may never contribute a number to a signal (guardrail 4).
 */
export interface RegimeHint {
  readonly label: RegimeLabel;
  readonly confidence: number;
  readonly source: string;
}

/** An open position, passed IN. This package never reads state from anywhere. */
export interface OpenPosition {
  readonly instId: Instrument;
  readonly side: 'long' | 'short';
  readonly notional: number;
  readonly openedAt: number;
  readonly signalId: string;
}

/** Everything the engine is allowed to know that is not in the snapshot. */
export interface EngineState {
  readonly openPositions: readonly OpenPosition[];
  /** `${instId}|${side}|${strategyId}` → ts of the last signal, for the cooldown. */
  readonly lastSignalAt: Readonly<Record<string, number>>;
}

export const EMPTY_STATE: EngineState = Object.freeze({
  openPositions: Object.freeze([]),
  lastSignalAt: Object.freeze({}),
});

export interface RegimeConfig {
  readonly trendAdxMin: number;
  readonly rangeAdxMax: number;
  readonly compressedPercentile: number;
  readonly expandedPercentile: number;
  readonly expansionAtrRatio: number;
  readonly percentileWindow: number;
}

export interface StopConfig {
  /** Below this, the stop sits inside spread + slippage and is a guaranteed loss. */
  readonly minDistancePct: number;
  /** Above this, position size collapses to something not worth holding. */
  readonly maxDistancePct: number;
}

export interface GateConfig {
  readonly minRegimeConfidence: number;
  /** Same instId + side + strategyId inside this window is a duplicate. */
  readonly cooldownMs: number;
}

export interface PortfolioConfig {
  /**
   * BTC, ETH and SOL move together. Same-direction signals across them in one cycle are one bet
   * wearing three hats, so at most this many survive.
   */
  readonly maxCorrelatedPerCycle: number;
}

export interface StrategyConfig {
  readonly enabled: Readonly<Record<string, boolean>>;
  /**
   * How many bars every strategy sees. **This is a replayability contract, not a performance
   * knob.** P1 proved that recursive indicators (Wilder RSI/ATR/ADX, MACD's EMA-26) depend on
   * warm-up length, so live and backtest must feed the SAME number of bars or the backtest stops
   * being evidence for the live system.
   */
  readonly lookbackBars: number;
  readonly regime: RegimeConfig;
  readonly stops: StopConfig;
  readonly gate: GateConfig;
  readonly portfolio: PortfolioConfig;
  readonly trendEma: {
    readonly timeframe: Timeframe;
    readonly adxMin: number;
    readonly atrMultiple: number;
  };
  readonly revertBand: {
    readonly timeframe: Timeframe;
    readonly adxMax: number;
    readonly rsiOverbought: number;
    readonly rsiOversold: number;
    readonly atrMultiple: number;
  };
  readonly breakoutRange: {
    readonly timeframe: Timeframe;
    readonly rangeBars: number;
    readonly minBreakAtr: number;
    readonly atrMultiple: number;
  };
  readonly fundingSkew: {
    readonly timeframe: Timeframe;
    readonly extremePercentile: number;
    readonly minHistory: number;
    /**
     * P4B: allow firing WITHOUT a peer, using a confirmation it can evaluate itself. Without
     * this the strategy can never fire in a solo backtest, so it can never be evaluated.
     */
    readonly standalone: boolean;
    /** Standalone confirmation: price must not be trending hard against the fade. */
    readonly standaloneMaxAdx: number;
  };
  readonly volExpansion: {
    readonly timeframe: Timeframe;
    /** Trailing window the compression percentile is measured against. */
    readonly compressionLookback: number;
    /** Bandwidth/vol at or below this percentile counts as compressed. */
    readonly compressionPercentile: number;
    /** Bars forming the range the break is measured against. */
    readonly rangeBars: number;
    readonly minBreakAtr: number;
  };
  readonly oiDivergence: {
    readonly timeframe: Timeframe;
    readonly lookbackBars: number;
    readonly minHistory: number;
    /** Changes smaller than this in either series are treated as noise. */
    readonly deadbandPct: number;
    readonly minMoveAtr: number;
    readonly atrMultiple: number;
  };
  readonly sessionBias: {
    readonly timeframe: Timeframe;
    readonly atrMultiple: number;
  };
  readonly takeProfitR: readonly number[];
  readonly maxHoldBars: number;
  /** A signal is stale after this many bars of its own timeframe. */
  readonly expiryBars: number;
}

export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = Object.freeze({
  enabled: Object.freeze({
    trend_ema: true,
    revert_band: true,
    breakout_range: true,
    funding_skew: true,
    vol_expansion: true,
    oi_divergence: true,
    session_bias: true,
  }),
  lookbackBars: 300,
  regime: Object.freeze({
    trendAdxMin: 25,
    rangeAdxMax: 20,
    compressedPercentile: 0.2,
    expandedPercentile: 0.85,
    expansionAtrRatio: 1.5,
    percentileWindow: 100,
  }),
  stops: Object.freeze({ minDistancePct: 0.001, maxDistancePct: 0.05 }),
  gate: Object.freeze({ minRegimeConfidence: 0.35, cooldownMs: 4 * 3_600_000 }),
  portfolio: Object.freeze({ maxCorrelatedPerCycle: 1 }),
  trendEma: Object.freeze({ timeframe: '1H' as Timeframe, adxMin: 25, atrMultiple: 2 }),
  revertBand: Object.freeze({
    timeframe: '1H' as Timeframe,
    adxMax: 20,
    rsiOverbought: 70,
    rsiOversold: 30,
    atrMultiple: 1.5,
  }),
  breakoutRange: Object.freeze({
    timeframe: '1H' as Timeframe,
    rangeBars: 20,
    minBreakAtr: 0.5,
    atrMultiple: 1.5,
  }),
  fundingSkew: Object.freeze({
    timeframe: '1H' as Timeframe,
    extremePercentile: 0.9,
    minHistory: 20,
    standalone: true,
    standaloneMaxAdx: 30,
  }),
  volExpansion: Object.freeze({
    timeframe: '1H' as Timeframe,
    compressionLookback: 100,
    compressionPercentile: 0.25,
    rangeBars: 20,
    minBreakAtr: 0.5,
  }),
  oiDivergence: Object.freeze({
    timeframe: '1H' as Timeframe,
    lookbackBars: 6,
    minHistory: 24,
    deadbandPct: 0.001,
    minMoveAtr: 0.75,
    atrMultiple: 2,
  }),
  sessionBias: Object.freeze({ timeframe: '1H' as Timeframe, atrMultiple: 1.5 }),
  takeProfitR: Object.freeze([1.5, 3]),
  maxHoldBars: 48,
  expiryBars: 2,
});
