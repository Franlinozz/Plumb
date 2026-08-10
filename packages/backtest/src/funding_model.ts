/**
 * FUNDING RECONSTRUCTION.
 *
 * OKX retains ~97 days of settled funding, but the candle history reaches years further back. A
 * three-year backtest therefore has real funding for a sliver of it and nothing for the rest.
 *
 * The rule: **a modelled input may never flatter a result.**
 *
 *   - where a real settlement exists, use it, sign and all;
 *   - where it does not, apply a CONSERVATIVE CONSTANT set at the 75th percentile of ADVERSE
 *     observed funding, charged AGAINST us regardless of position direction.
 *
 * The constant is derived from the observed data rather than picked, and every report states what
 * fraction of funding was real versus modelled. A run that is only profitable because its funding
 * was invented is a run we need to be able to see.
 */

import type { Instrument } from '@plumb/core';

export interface FundingObservation {
  readonly fundingTime: number;
  readonly fundingRate: number;
}

export interface FundingModel {
  /** Real settlements, chronological, per instrument. */
  readonly observed: Readonly<Partial<Record<Instrument, readonly FundingObservation[]>>>;
  /** Charged when no observation exists. Always a COST, whatever the side. */
  readonly conservativeRate: number;
  readonly conservativeSource: string;
  /** Oldest instant for which ANY real observation exists. */
  readonly realFrom: number | undefined;
}

export interface FundingLookup {
  readonly rate: number;
  readonly modelled: boolean;
}

/**
 * The 75th percentile of ADVERSE funding.
 *
 * "Adverse" means the magnitude, taken without regard to sign: whichever way a position faces,
 * funding of that size can be against it. Taking the 75th percentile rather than the median means
 * the modelled periods are charged more than a typical settlement, which is the direction that
 * cannot flatter us.
 */
export function conservativeRateFrom(
  observations: readonly FundingObservation[],
  percentile = 0.75,
): { readonly rate: number; readonly source: string } {
  if (observations.length === 0) {
    // No data at all: fall back to a rate near OKX's typical cap rather than to zero. Zero would
    // be the single most flattering choice available.
    return { rate: 0.0001, source: 'no observations — default 0.01% per settlement' };
  }
  const magnitudes = observations.map((o) => Math.abs(o.fundingRate)).sort((a, b) => a - b);
  const index = Math.min(magnitudes.length - 1, Math.floor(percentile * (magnitudes.length - 1)));
  const rate = magnitudes[index] as number;
  return {
    rate,
    source:
      `${(percentile * 100).toFixed(0)}th percentile of |funding| across ${observations.length} ` +
      `real settlements (${(rate * 100).toFixed(5)}% per 8h)`,
  };
}

export function buildFundingModel(
  observed: Readonly<Partial<Record<Instrument, readonly FundingObservation[]>>>,
  percentile = 0.75,
): FundingModel {
  const all = Object.values(observed).flatMap((list) => (list ?? []) as readonly FundingObservation[]);
  const conservative = conservativeRateFrom(all, percentile);
  const realFrom = all.length === 0 ? undefined : Math.min(...all.map((o) => o.fundingTime));
  return {
    observed,
    conservativeRate: conservative.rate,
    conservativeSource: conservative.source,
    realFrom,
  };
}

/**
 * The rate applying at `ts` for `instId`, and whether it was real or modelled.
 *
 * A modelled rate is returned as a POSITIVE magnitude; the caller charges it as a cost. It is
 * never returned with a sign, because a signed model would sometimes pay us.
 */
export function fundingAt(model: FundingModel, instId: Instrument, ts: number): FundingLookup {
  const series = model.observed[instId];
  if (series !== undefined && series.length > 0 && ts >= (series[0]?.fundingTime ?? Infinity)) {
    let found: number | undefined;
    for (const entry of series) {
      if (entry.fundingTime > ts) break;
      found = entry.fundingRate;
    }
    if (found !== undefined) return { rate: found, modelled: false };
  }
  return { rate: model.conservativeRate, modelled: true };
}

export interface FundingAccrual {
  readonly usdt: number;
  readonly settlements: number;
  readonly modelledSettlements: number;
}

/**
 * Funding over a holding period.
 *
 * Real settlements are booked with their sign — including the times funding paid us. Modelled
 * settlements are booked as a cost, always.
 */
export function accrueFunding(
  model: FundingModel,
  instId: Instrument,
  side: 'long' | 'short',
  notionalUsdt: number,
  openedAt: number,
  closedAt: number,
): FundingAccrual {
  const direction = side === 'long' ? 1 : -1;
  let usdt = 0;
  let settlements = 0;
  let modelledSettlements = 0;

  const firstSlot = Math.ceil(openedAt / 28_800_000) * 28_800_000;
  for (let slot = firstSlot; slot <= closedAt; slot += 28_800_000) {
    settlements += 1;
    const lookup = fundingAt(model, instId, slot);
    if (lookup.modelled) {
      modelledSettlements += 1;
      usdt += Math.abs(notionalUsdt) * lookup.rate; // a cost, whatever the side
    } else {
      usdt += notionalUsdt * lookup.rate * direction;
    }
  }
  return { usdt, settlements, modelledSettlements };
}

/** What every report must state. */
export function describeFundingModel(model: FundingModel): readonly string[] {
  const counts = Object.entries(model.observed).map(
    ([instId, list]) => `${instId} ${(list ?? []).length}`,
  );
  return [
    `Real settlements available: ${counts.join(', ') || 'none'}` +
      (model.realFrom === undefined ? '' : `, oldest ${new Date(model.realFrom).toISOString().slice(0, 10)}`),
    `Where no real settlement exists, ${(model.conservativeRate * 100).toFixed(5)}% per 8h is charged ` +
      `AGAINST the position regardless of direction — ${model.conservativeSource}.`,
    'A modelled settlement is never a credit. Funding we did not observe cannot pay us.',
  ];
}
