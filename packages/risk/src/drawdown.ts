/**
 * THE DRAWDOWN LADDER.
 *
 * As equity falls from its peak, tighten — do not wait for the cliff. Each rung reduces what the
 * system is allowed to do next, so that arriving at the kill switch requires a long sequence of
 * failures rather than one bad afternoon.
 *
 *   −2%   log, no action
 *   −5%   per-trade risk halved for NEW positions
 *   −8%   max concurrent drops to 1
 *   −12%  no new positions; manage existing only
 *   ≤335  kill switch, flatten, permanent halt
 *
 * **Recovery unwinds the ladder only on REALISED equity gains.** Unrealised profit on an open
 * position is a hope, not a result; letting it restore risk capacity would mean a position that is
 * temporarily green could licence a second position that is not.
 */

import { LOCKED } from './params.js';
import type { GovernorState } from './state.js';

export type DrawdownRung = 'clear' | 'watch' | 'reduced_risk' | 'reduced_concurrency' | 'no_new_positions' | 'kill';

export interface DrawdownAssessment {
  readonly rung: DrawdownRung;
  readonly drawdownPct: number;
  /** Risk budget a new position may use, in USDT. */
  readonly riskBudgetUsdt: number;
  readonly maxConcurrent: number;
  readonly allowsNewPositions: boolean;
  readonly reason: string;
}

export const LADDER = Object.freeze([
  { at: 0.02, rung: 'watch' as const },
  { at: 0.05, rung: 'reduced_risk' as const },
  { at: 0.08, rung: 'reduced_concurrency' as const },
  { at: 0.12, rung: 'no_new_positions' as const },
]);

/**
 * Assess the ladder from REALISED equity against the peak.
 *
 * `equity` here must be realised — the caller passes the persisted equity figure, which only
 * moves when a position closes.
 */
export function assessDrawdown(state: GovernorState): DrawdownAssessment {
  const peak = Math.max(state.peakEquity, state.startingEquity);
  const drawdownPct = peak <= 0 ? 0 : Math.max(0, (peak - state.equity) / peak);

  if (state.equity <= LOCKED.KILL_SWITCH_EQUITY_USDT) {
    return {
      rung: 'kill',
      drawdownPct,
      riskBudgetUsdt: 0,
      maxConcurrent: 0,
      allowsNewPositions: false,
      reason: `equity ${state.equity.toFixed(2)} at or below the kill switch (${LOCKED.KILL_SWITCH_EQUITY_USDT})`,
    };
  }

  if (drawdownPct >= 0.12) {
    return {
      rung: 'no_new_positions',
      drawdownPct,
      riskBudgetUsdt: 0,
      maxConcurrent: LOCKED.MAX_CONCURRENT_POSITIONS,
      allowsNewPositions: false,
      reason: `drawdown ${(drawdownPct * 100).toFixed(1)}% ≥ 12% — manage existing positions only`,
    };
  }
  if (drawdownPct >= 0.08) {
    return {
      rung: 'reduced_concurrency',
      drawdownPct,
      riskBudgetUsdt: LOCKED.PER_TRADE_RISK_USDT / 2,
      maxConcurrent: 1,
      allowsNewPositions: true,
      reason: `drawdown ${(drawdownPct * 100).toFixed(1)}% ≥ 8% — one position at a time, half risk`,
    };
  }
  if (drawdownPct >= 0.05) {
    return {
      rung: 'reduced_risk',
      drawdownPct,
      riskBudgetUsdt: LOCKED.PER_TRADE_RISK_USDT / 2,
      maxConcurrent: LOCKED.MAX_CONCURRENT_POSITIONS,
      allowsNewPositions: true,
      reason: `drawdown ${(drawdownPct * 100).toFixed(1)}% ≥ 5% — per-trade risk halved`,
    };
  }
  if (drawdownPct >= 0.02) {
    return {
      rung: 'watch',
      drawdownPct,
      riskBudgetUsdt: LOCKED.PER_TRADE_RISK_USDT,
      maxConcurrent: LOCKED.MAX_CONCURRENT_POSITIONS,
      allowsNewPositions: true,
      reason: `drawdown ${(drawdownPct * 100).toFixed(1)}% ≥ 2% — logged, no action`,
    };
  }
  return {
    rung: 'clear',
    drawdownPct,
    riskBudgetUsdt: LOCKED.PER_TRADE_RISK_USDT,
    maxConcurrent: LOCKED.MAX_CONCURRENT_POSITIONS,
    allowsNewPositions: true,
    reason: 'no material drawdown',
  };
}

/**
 * Update the peak from REALISED equity only.
 *
 * The peak is what the ladder measures against, so raising it on unrealised profit would let an
 * open winner deepen the measured drawdown the moment it gave anything back.
 */
export function updatePeak(state: GovernorState, realisedEquity: number): GovernorState {
  if (realisedEquity <= state.peakEquity) return { ...state, equity: realisedEquity };
  return { ...state, equity: realisedEquity, peakEquity: realisedEquity };
}
