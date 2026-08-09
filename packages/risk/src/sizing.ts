/**
 * POSITION SIZING FROM STOP DISTANCE.
 *
 * The core arithmetic of the whole system, and the one place where the direction of causation
 * matters most:
 *
 *     riskAmount   = PER_TRADE_RISK (4 USDT)
 *     stopDistance = |entry - stop| / entry
 *     notional     = riskAmount / stopDistance
 *     leverage     = notional / equity
 *
 * **Stop distance determines size. Size never determines the stop.** If the leverage ceiling is
 * breached, the NOTIONAL is reduced — the stop is never widened to make a desired size fit. That
 * inversion is how accounts die: it converts a risk limit into a suggestion.
 *
 * If the compliant notional falls below the exchange minimum, the signal is REJECTED rather than
 * traded at a size that cannot honour its stop.
 *
 * NOTE FROM P1: our ATR runs ~2.8% above the Agent Trade Kit's, because we warm up over the full
 * series and they use a short (~40–80 bar) window. ATR sets stop distance and stop distance sets
 * size, so **our positions are ~2.8% smaller than a Trade-Kit-sized equivalent**. That is the
 * conservative direction and we accept it deliberately. See AGENTS.md § Deviations (P1).
 */

import type { Instrument } from '@plumb/core';
import {
  contractsToNotional,
  notionalToContracts,
  specFor,
  type InstrumentSpec,
} from '@plumb/market';

import { LOCKED } from './params.js';

export type SizingRejectionCode =
  | 'stop_distance_invalid'
  | 'entry_invalid'
  | 'equity_invalid'
  | 'below_minimum_size'
  | 'leverage_ceiling_unreachable';

export interface SizingInput {
  readonly instId: Instrument;
  readonly entryPrice: number;
  readonly stopPrice: number;
  readonly equityUsdt: number;
  /** Defaults to PER_TRADE_RISK. The drawdown ladder may hand in a reduced budget. */
  readonly riskBudgetUsdt?: number;
  readonly spec?: InstrumentSpec;
}

export interface SizingResult {
  readonly ok: true;
  readonly instId: Instrument;
  readonly contracts: number;
  readonly notionalUsdt: number;
  readonly leverage: number;
  readonly stopDistancePct: number;
  /** What we intended to risk. */
  readonly intendedRiskUsdt: number;
  /** What we ACTUALLY risk after rounding to the lot grid. Always ≤ intended. */
  readonly actualRiskUsdt: number;
  /** True when the leverage ceiling forced the notional down. */
  readonly clampedByLeverage: boolean;
}

export interface SizingRejection {
  readonly ok: false;
  readonly code: SizingRejectionCode;
  readonly message: string;
  readonly details: Readonly<Record<string, number>>;
}

export type SizingOutcome = SizingResult | SizingRejection;

const reject = (
  code: SizingRejectionCode,
  message: string,
  details: Readonly<Record<string, number>> = {},
): SizingRejection => ({ ok: false, code, message, details });

export function sizePosition(input: SizingInput): SizingOutcome {
  const { instId, entryPrice, stopPrice } = input;
  const riskBudget = input.riskBudgetUsdt ?? LOCKED.PER_TRADE_RISK_USDT;
  const spec = input.spec ?? specFor(instId);

  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    return reject('entry_invalid', 'entry price must be a positive number', { entryPrice });
  }
  if (!Number.isFinite(input.equityUsdt) || input.equityUsdt <= 0) {
    return reject('equity_invalid', 'equity must be a positive number', { equity: input.equityUsdt });
  }
  if (!Number.isFinite(stopPrice) || stopPrice <= 0 || stopPrice === entryPrice) {
    return reject('stop_distance_invalid', 'stop must be a positive price different from entry', {
      entryPrice,
      stopPrice,
    });
  }
  if (!Number.isFinite(riskBudget) || riskBudget <= 0) {
    return reject('stop_distance_invalid', 'risk budget must be positive', { riskBudget });
  }

  const stopDistancePct = Math.abs(entryPrice - stopPrice) / entryPrice;
  if (!Number.isFinite(stopDistancePct) || stopDistancePct <= 0) {
    return reject('stop_distance_invalid', 'stop distance is zero or not finite', {
      stopDistancePct,
    });
  }

  // Size from the stop.
  const desiredNotional = riskBudget / stopDistancePct;

  // Clamp by LEVERAGE. Reduce the NOTIONAL — never widen the stop.
  const maxNotionalByLeverage = input.equityUsdt * LOCKED.LEVERAGE_CEILING;
  const clampedByLeverage = desiredNotional > maxNotionalByLeverage;
  const targetNotional = clampedByLeverage ? maxNotionalByLeverage : desiredNotional;

  const contracts = notionalToContracts(targetNotional, entryPrice, spec);
  if (contracts < spec.minSz || contracts <= 0) {
    // Deliberately a rejection, not a smaller stop and not a minimum-size order. A position too
    // small to honour its stop is a position that cannot be risk-managed.
    return reject(
      'below_minimum_size',
      `compliant notional sizes to ${contracts} contracts, below the ${spec.minSz} minimum`,
      { contracts, minSz: spec.minSz, targetNotional, entryPrice },
    );
  }

  const notionalUsdt = contractsToNotional(contracts, entryPrice, spec);
  const leverage = notionalUsdt / input.equityUsdt;

  // Should be unreachable after the clamp — rounding is DOWN, so it can only reduce leverage.
  if (leverage > LOCKED.LEVERAGE_CEILING + 1e-9) {
    return reject(
      'leverage_ceiling_unreachable',
      'leverage still exceeds the ceiling after clamping — this is a bug, not a market condition',
      { leverage, ceiling: LOCKED.LEVERAGE_CEILING },
    );
  }

  // Report the REAL risk, not the intended one. Rounding down means actual ≤ intended.
  const actualRiskUsdt = notionalUsdt * stopDistancePct;

  return {
    ok: true,
    instId,
    contracts,
    notionalUsdt,
    leverage,
    stopDistancePct,
    intendedRiskUsdt: riskBudget,
    actualRiskUsdt,
    clampedByLeverage,
  };
}

/**
 * Estimated funding cost over a holding period, in USDT.
 *
 * Funding settles every 8h on these instruments. A long pays when funding is positive; a short
 * receives it. Only the COST direction is charged against the risk budget — a credit is ignored,
 * because relying on being paid to hold is a different strategy from the one that was signalled.
 */
export function estimateFundingCost(
  notionalUsdt: number,
  fundingRate: number,
  side: 'long' | 'short',
  holdBars: number,
  barMs: number,
): number {
  const holdMs = holdBars * barMs;
  const settlements = Math.max(0, Math.floor(holdMs / 28_800_000));
  const perSettlement = notionalUsdt * fundingRate * (side === 'long' ? 1 : -1);
  const total = perSettlement * settlements;
  return total > 0 ? total : 0;
}
