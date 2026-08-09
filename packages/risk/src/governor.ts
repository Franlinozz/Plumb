/**
 * THE VETO.
 *
 * `evaluate(signal, state, snapshot)` → approved with a size, or vetoed with a structured reason.
 *
 * Checks run in a FIXED order and the first failure wins. The order is not cosmetic: a halted
 * system must report that it is halted rather than that the funding was unattractive, because the
 * first reason is the one a human reads at 3am.
 *
 * No model is consulted anywhere in this file. Every number is arithmetic on locked parameters,
 * persisted state and the snapshot. `no-llm.test.ts` reads this package's source and proves it.
 */

import { LOCKED as CORE_LOCKED, TIMEFRAME_MS_FOR_SIGNAL, type Signal } from './signal-compat.js';
import { assessDrawdown, type DrawdownAssessment } from './drawdown.js';
import { DEFAULT_RISK_CONFIG, LOCKED, assertLockedParameters, type RiskConfig } from './params.js';
import { estimateFundingCost, sizePosition, type SizingResult } from './sizing.js';
import { anyHaltSet, withHalt, type GovernorState, type HaltFlag } from './state.js';

export type VetoCode =
  | 'halted'
  | 'kill_switch'
  | 'daily_loss_limit'
  | 'max_concurrent'
  | 'max_total_notional'
  | 'averaging_down'
  | 'correlated_exposure'
  | 'below_minimum_size'
  | 'leverage_ceiling'
  | 'funding_cost'
  | 'snapshot_degraded'
  | 'risk_exceeds_budget'
  | 'instrument_not_locked'
  | 'no_new_positions';

export interface Veto {
  readonly approved: false;
  readonly code: VetoCode;
  readonly reason: string;
  readonly details: Readonly<Record<string, number | string>>;
  /** State AFTER the check — a kill switch or daily halt mutates it, so the caller must persist. */
  readonly state: GovernorState;
  /** Set when this veto also demands that open positions be closed. */
  readonly flatten: boolean;
}

export interface Approval {
  readonly approved: true;
  readonly signalId: string;
  readonly sizing: SizingResult;
  readonly drawdown: DrawdownAssessment;
  readonly state: GovernorState;
}

export type Verdict = Approval | Veto;

/** The minimum a governor needs to know about the market. Kept narrow deliberately. */
export interface RiskSnapshot {
  readonly instId: string;
  readonly ts: number;
  readonly degraded: boolean;
  readonly degradedFields: readonly string[];
  readonly last: number;
  readonly funding: { readonly current: number };
}

export interface GovernorOptions {
  readonly config?: RiskConfig;
}

export function createGovernor(options: GovernorOptions = {}) {
  // Refuses to exist if the constitution and the code have drifted apart.
  assertLockedParameters();
  const config = options.config ?? DEFAULT_RISK_CONFIG;

  return {
    config,
    evaluate: (signal: Signal, state: GovernorState, snapshot: RiskSnapshot, nowMs: number): Verdict =>
      evaluate(signal, state, snapshot, nowMs, config),
  };
}

export function evaluate(
  signal: Signal,
  state: GovernorState,
  snapshot: RiskSnapshot,
  nowMs: number,
  config: RiskConfig = DEFAULT_RISK_CONFIG,
): Verdict {
  const veto = (
    code: VetoCode,
    reason: string,
    details: Readonly<Record<string, number | string>> = {},
    nextState: GovernorState = state,
    flatten = false,
  ): Veto => ({ approved: false, code, reason, details, state: nextState, flatten });

  // ─── 1. ANY halt flag. The kill switch is permanent until a manual re-arm. ────────────────
  const halt: HaltFlag | undefined = anyHaltSet(state);
  if (halt !== undefined) {
    return veto(
      halt === 'killSwitch' ? 'kill_switch' : halt === 'dailyLimit' ? 'daily_loss_limit' : 'halted',
      `system is halted (${halt})${state.haltReason === undefined ? '' : `: ${state.haltReason}`}`,
      { flag: halt, haltedAt: state.haltedAt ?? 0 },
    );
  }

  // ─── 2. Kill switch. Flatten everything, halt permanently, alert. ─────────────────────────
  if (state.equity <= LOCKED.KILL_SWITCH_EQUITY_USDT) {
    const halted = withHalt(
      state,
      'killSwitch',
      `equity ${state.equity.toFixed(2)} <= kill switch ${LOCKED.KILL_SWITCH_EQUITY_USDT}`,
      nowMs,
    );
    return veto(
      'kill_switch',
      `KILL SWITCH: equity ${state.equity.toFixed(2)} at or below ${LOCKED.KILL_SWITCH_EQUITY_USDT} — flatten and halt permanently`,
      { equity: state.equity, floor: LOCKED.KILL_SWITCH_EQUITY_USDT },
      halted,
      true,
    );
  }

  // ─── 3. Daily loss limit. Flatten, no new signals until the next UTC day. ─────────────────
  // Explicitly UTC: competition times are UTC+8, internal accounting is UTC (gotcha 8).
  if (state.realisedPnlToday <= -LOCKED.DAILY_LOSS_LIMIT_USDT) {
    const halted = withHalt(
      state,
      'dailyLimit',
      `realised PnL today ${state.realisedPnlToday.toFixed(2)} <= -${LOCKED.DAILY_LOSS_LIMIT_USDT}`,
      nowMs,
    );
    return veto(
      'daily_loss_limit',
      `daily loss limit hit (${state.realisedPnlToday.toFixed(2)} USDT on ${state.dailyResetAtUtc} UTC) — flat until the next UTC day`,
      { realisedPnlToday: state.realisedPnlToday, limit: LOCKED.DAILY_LOSS_LIMIT_USDT },
      halted,
      true,
    );
  }

  if (!CORE_LOCKED.INSTRUMENTS.includes(signal.instId)) {
    return veto('instrument_not_locked', 'instrument is outside the locked set', {
      instId: signal.instId,
    });
  }

  // ─── The drawdown ladder governs what the remaining checks are allowed to permit. ─────────
  const drawdown = assessDrawdown(state);
  if (!drawdown.allowsNewPositions) {
    return veto('no_new_positions', drawdown.reason, {
      drawdownPct: drawdown.drawdownPct,
      rung: drawdown.rung,
    });
  }

  // ─── 4. Concurrency. ──────────────────────────────────────────────────────────────────────
  const maxConcurrent = Math.min(drawdown.maxConcurrent, LOCKED.MAX_CONCURRENT_POSITIONS);
  if (state.openPositions.length >= maxConcurrent) {
    return veto('max_concurrent', `already holding ${state.openPositions.length} of ${maxConcurrent} permitted positions`, {
      open: state.openPositions.length,
      max: maxConcurrent,
    });
  }

  // ─── 6. AVERAGING DOWN. Checked BEFORE sizing, so it can never be sized at all. ───────────
  // There is no config value that permits this. It is not a parameter.
  const sameDirection = state.openPositions.find(
    (p) => p.instId === signal.instId && p.side === signal.side,
  );
  if (sameDirection !== undefined) {
    return veto(
      'averaging_down',
      `a ${signal.side} position on ${signal.instId} is already open — adding to it is prohibited`,
      { openedAt: sameDirection.openedAt, signalId: sameDirection.signalId },
    );
  }

  // ─── 11. Degraded snapshot. Redundant with the P2 gate; kept for defence in depth. ────────
  if (snapshot.degraded) {
    return veto('snapshot_degraded', 'market snapshot is degraded', {
      degradedFields: snapshot.degradedFields.join(','),
    });
  }

  const entryPrice = signal.entry.price ?? snapshot.last;

  // ─── 8/9. Sizing, the leverage clamp, and the minimum order size. ─────────────────────────
  const sizing = sizePosition({
    instId: signal.instId,
    entryPrice,
    stopPrice: signal.stop.price,
    equityUsdt: state.equity,
    riskBudgetUsdt: drawdown.riskBudgetUsdt,
  });
  if (!sizing.ok) {
    const code: VetoCode =
      sizing.code === 'below_minimum_size'
        ? 'below_minimum_size'
        : sizing.code === 'leverage_ceiling_unreachable'
          ? 'leverage_ceiling'
          : 'risk_exceeds_budget';
    return veto(code, sizing.message, sizing.details);
  }

  // ─── 5. Total notional across the book. ───────────────────────────────────────────────────
  const projectedNotional = state.totalNotional + sizing.notionalUsdt;
  if (projectedNotional > LOCKED.MAX_TOTAL_NOTIONAL_USDT) {
    return veto(
      'max_total_notional',
      `total notional would reach ${projectedNotional.toFixed(2)}, above the ${LOCKED.MAX_TOTAL_NOTIONAL_USDT} cap`,
      { projected: projectedNotional, cap: LOCKED.MAX_TOTAL_NOTIONAL_USDT },
    );
  }

  // ─── 7. Correlation. BTC, ETH and SOL move together. ──────────────────────────────────────
  const correlatedNotional = state.openPositions
    .filter((p) => p.side === signal.side)
    .reduce((sum, p) => sum + p.notionalUsdt, 0);
  if (correlatedNotional + sizing.notionalUsdt > config.correlatedNotionalCapUsdt) {
    return veto(
      'correlated_exposure',
      `combined ${signal.side} exposure would reach ${(correlatedNotional + sizing.notionalUsdt).toFixed(2)}, ` +
        `above the ${config.correlatedNotionalCapUsdt} correlated cap`,
      {
        existing: correlatedNotional,
        adding: sizing.notionalUsdt,
        cap: config.correlatedNotionalCapUsdt,
      },
    );
  }

  // ─── 10. Funding cost over the intended hold. ─────────────────────────────────────────────
  const barMs = TIMEFRAME_MS_FOR_SIGNAL[signal.timeframe];
  const fundingCost = estimateFundingCost(
    sizing.notionalUsdt,
    snapshot.funding.current,
    signal.side,
    signal.invalidation.maxHoldBars,
    barMs,
  );
  const fundingBudget = sizing.actualRiskUsdt * config.maxFundingFractionOfRisk;
  if (fundingCost > fundingBudget) {
    return veto(
      'funding_cost',
      `estimated funding ${fundingCost.toFixed(4)} USDT over ${signal.invalidation.maxHoldBars} bars ` +
        `exceeds ${(config.maxFundingFractionOfRisk * 100).toFixed(0)}% of the ${sizing.actualRiskUsdt.toFixed(2)} risked`,
      { fundingCost, fundingBudget, fundingRate: snapshot.funding.current },
    );
  }

  // ─── 12. Post-rounding actual risk. The last line before money moves. ─────────────────────
  if (sizing.actualRiskUsdt > drawdown.riskBudgetUsdt + 1e-9) {
    return veto(
      'risk_exceeds_budget',
      `post-rounding risk ${sizing.actualRiskUsdt.toFixed(4)} exceeds the ${drawdown.riskBudgetUsdt} budget`,
      { actualRisk: sizing.actualRiskUsdt, budget: drawdown.riskBudgetUsdt },
    );
  }
  if (sizing.actualRiskUsdt > LOCKED.PER_TRADE_RISK_USDT + 1e-9) {
    return veto(
      'risk_exceeds_budget',
      `post-rounding risk ${sizing.actualRiskUsdt.toFixed(4)} exceeds PER_TRADE_RISK`,
      { actualRisk: sizing.actualRiskUsdt, perTradeRisk: LOCKED.PER_TRADE_RISK_USDT },
    );
  }

  return {
    approved: true,
    signalId: signal.id,
    sizing,
    drawdown,
    state: { ...state, lastSignalAt: nowMs },
  };
}
