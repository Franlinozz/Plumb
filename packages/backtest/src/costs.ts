/**
 * COST MODEL — realistic and pessimistic.
 *
 * Where a choice exists, this file takes the assumption that makes results LOOK WORSE. An
 * optimistic backtest is worse than no backtest: it produces a number that licences real money
 * and cannot be defended when the money is gone.
 *
 * Every assumption is stated, sourced and printed in the report.
 */

import type { Instrument } from '@plumb/core';

/**
 * OKX published fee rates for USDT-margined perpetual swaps, regular (Lv1) tier.
 *
 * Fetched 2026-08-09 from OKX's published fee schedule (okx.com trading-fee help pages).
 * **Plumb uses market orders, so the TAKER rate applies to every fill** — entry and exit. The
 * maker rate is recorded for completeness and is deliberately never used.
 */
export const OKX_FEES = Object.freeze({
  takerRate: 0.0005, // 0.05%
  makerRate: 0.0002, // 0.02%
  tier: 'Lv1 (regular user)',
  source: 'https://www.okx.com/help/trading-fee-rules-faq',
  recordedAt: '2026-08-09',
});

export interface CostModel {
  /** Applied to notional on BOTH sides of every trade. */
  readonly takerRate: number;
  /** Half the typical spread, in basis points. The floor of the slippage model. */
  readonly baseSlippageBps: number;
  /** Extra slippage per unit of (notional / referenceNotional). Bigger orders pay more. */
  readonly notionalSlippageBps: number;
  readonly referenceNotionalUsdt: number;
  /** Extra slippage proportional to the bar's own range — violent bars fill worse. */
  readonly volatilitySlippageCoeff: number;
  /**
   * Funding rate assumed for bars with no stored history. OKX retains only ~97 days of funding
   * history while our candles reach ~180, so older bars have none. The fallback is a COST, always
   * charged against the position, never a credit — and the report states how many bars used it.
   */
  readonly fundingFallbackRate: number;
}

export const DEFAULT_COSTS: CostModel = Object.freeze({
  takerRate: OKX_FEES.takerRate,
  baseSlippageBps: 1, // ~0.01%: half a typical 2bp spread on these three instruments
  notionalSlippageBps: 2,
  referenceNotionalUsdt: 400,
  volatilitySlippageCoeff: 0.05,
  fundingFallbackRate: 0.0001, // pessimistic: ~3x the observed median, charged as a cost
});

export const ZERO_COSTS: CostModel = Object.freeze({
  takerRate: 0,
  baseSlippageBps: 0,
  notionalSlippageBps: 0,
  referenceNotionalUsdt: 400,
  volatilitySlippageCoeff: 0,
  fundingFallbackRate: 0,
});

export interface SlippageInput {
  readonly notionalUsdt: number;
  /** `(high - low) / close` for the bar being filled on. */
  readonly barRangePct: number;
  readonly costs: CostModel;
}

/** Slippage in basis points: a floor, plus a size term, plus a volatility term. */
export function slippageBps(input: SlippageInput): number {
  const { costs } = input;
  const sizeTerm =
    costs.referenceNotionalUsdt <= 0
      ? 0
      : (input.notionalUsdt / costs.referenceNotionalUsdt) * costs.notionalSlippageBps;
  const volTerm = input.barRangePct * 10_000 * costs.volatilitySlippageCoeff;
  return costs.baseSlippageBps + sizeTerm + volTerm;
}

/**
 * Fill price for a MARKET entry.
 *
 * Filled at the NEXT bar's open, not the close the signal was computed on — a decision made from
 * bar N's close cannot be executed at bar N's close. Slippage then pushes the fill against us.
 */
export function entryFillPrice(
  side: 'long' | 'short',
  nextBarOpen: number,
  slippage: number,
): number {
  const drift = nextBarOpen * (slippage / 10_000);
  return side === 'long' ? nextBarOpen + drift : nextBarOpen - drift;
}

/**
 * Fill price for a STOP.
 *
 * Taken as the WORSE of the stop price and the next bar's open, then slipped further against us.
 * Gaps go against us — always. Assuming a stop fills at its printed price is the single most
 * common way a backtest lies.
 */
export function stopFillPrice(
  side: 'long' | 'short',
  stopPrice: number,
  barOpen: number,
  slippage: number,
): number {
  // For a long, "worse" means LOWER; for a short it means HIGHER.
  const worse = side === 'long' ? Math.min(stopPrice, barOpen) : Math.max(stopPrice, barOpen);
  const drift = worse * (slippage / 10_000);
  return side === 'long' ? worse - drift : worse + drift;
}

/** Fill price for a market EXIT that is not a stop (timeout, invalidation, flatten). */
export function exitFillPrice(side: 'long' | 'short', price: number, slippage: number): number {
  const drift = price * (slippage / 10_000);
  // Closing a long is a sell, so slippage pushes the price DOWN.
  return side === 'long' ? price - drift : price + drift;
}

/** Taker fee on one side of a trade. */
export function feeUsdt(notionalUsdt: number, costs: CostModel): number {
  return Math.abs(notionalUsdt) * costs.takerRate;
}

export interface FundingSeries {
  readonly instId: Instrument;
  /** Settled rates, chronological. */
  readonly entries: ReadonlyArray<{ readonly fundingTime: number; readonly fundingRate: number }>;
}

export interface FundingCharge {
  readonly usdt: number;
  readonly settlements: number;
  /** Settlements that had no stored rate and used the pessimistic fallback. */
  readonly fallbackSettlements: number;
}

/**
 * Funding paid or received over a holding period, using the REAL historical series.
 *
 * A long pays when funding is positive. The sign is preserved — unlike the governor's
 * pre-trade estimate, which deliberately ignores credits, the backtest must book what actually
 * happened, including the times funding paid us.
 */
export function fundingOverHold(
  side: 'long' | 'short',
  notionalUsdt: number,
  openedAt: number,
  closedAt: number,
  series: FundingSeries | undefined,
  costs: CostModel,
): FundingCharge {
  const direction = side === 'long' ? 1 : -1;
  let usdt = 0;
  let settlements = 0;
  let fallbackSettlements = 0;

  // Settlements land every 8h at 00:00, 08:00, 16:00 UTC.
  const firstSlot = Math.ceil(openedAt / 28_800_000) * 28_800_000;
  for (let slot = firstSlot; slot <= closedAt; slot += 28_800_000) {
    settlements += 1;
    const rate = rateAt(series, slot);
    if (rate === undefined) {
      fallbackSettlements += 1;
      // No data: charge the fallback as a COST regardless of side. Never a credit we did not
      // observe — inventing income is exactly the flattery this model exists to avoid.
      usdt += Math.abs(notionalUsdt) * costs.fundingFallbackRate;
    } else {
      usdt += notionalUsdt * rate * direction;
    }
  }
  return { usdt, settlements, fallbackSettlements };
}

function rateAt(series: FundingSeries | undefined, ts: number): number | undefined {
  if (series === undefined || series.entries.length === 0) return undefined;
  let found: number | undefined;
  for (const entry of series.entries) {
    if (entry.fundingTime > ts) break;
    found = entry.fundingRate;
  }
  return found;
}

/** Human-readable statement of the assumptions, for the report. */
export function describeCosts(costs: CostModel): readonly string[] {
  return [
    `Taker fee ${(costs.takerRate * 100).toFixed(3)}% on BOTH sides of every trade ` +
      `(OKX ${OKX_FEES.tier}, recorded ${OKX_FEES.recordedAt} from ${OKX_FEES.source}). ` +
      `Plumb uses market orders, so the maker rate never applies.`,
    `Slippage = ${costs.baseSlippageBps}bp floor + ${costs.notionalSlippageBps}bp per ` +
      `${costs.referenceNotionalUsdt} USDT of notional + ${costs.volatilitySlippageCoeff} × the ` +
      `bar's own range. Larger orders and more violent bars fill worse.`,
    `Entries fill at the NEXT bar's open, never the close the signal was computed on.`,
    `Stops fill at the WORSE of the stop price and the next bar's open, then slip further ` +
      `against us. Gaps always go against us.`,
    `Funding is booked every 8h from the REAL historical series, sign preserved. Where no ` +
      `history is stored (OKX retains ~97 days), a pessimistic ${(costs.fundingFallbackRate * 100).toFixed(4)}% ` +
      `is charged as a COST regardless of direction, and the count of such settlements is reported.`,
  ];
}
