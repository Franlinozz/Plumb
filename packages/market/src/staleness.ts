/**
 * THE DATA WATCHDOG.
 *
 * A data gap must never look like a market move. A price that stopped updating twenty minutes
 * ago is not "the market went quiet" — it is a broken feed, and a strategy that cannot tell the
 * difference will happily read a frozen tape as a consolidation and trade it.
 *
 * So every field in a snapshot carries an age and a budget. If any required field is older than
 * its budget, the snapshot is marked `degraded` with the offending fields named, and
 * `isTradeable()` returns false. Guardrail (asserted here in P1, enforced in `strategy` in P2):
 * **a degraded snapshot must not produce a signal.**
 */

import { TIMEFRAME_MS, type Timeframe } from './types.js';

export interface FreshnessBudget {
  /** Mark price. Moves continuously; 30s of silence is already suspicious. */
  readonly markMs: number;
  /** Last traded price, from the ticker. Same reasoning as mark. */
  readonly lastMs: number;
  /** Funding settles every 8h, so an hour-old reading is still current. */
  readonly fundingMs: number;
  /** Open interest is published on a slow cadence. */
  readonly openInterestMs: number;
  /** Candles: a series is stale once it is this many bars behind. */
  readonly candleMultiple: number;
}

export const DEFAULT_FRESHNESS: FreshnessBudget = Object.freeze({
  markMs: 30_000,
  lastMs: 30_000,
  fundingMs: 3_600_000,
  openInterestMs: 3_600_000,
  candleMultiple: 2,
});

export interface FieldAge {
  readonly ageMs: number;
  readonly budgetMs: number;
  readonly stale: boolean;
}

export type DataAge = Readonly<Record<string, FieldAge>>;

export interface FreshnessAssessment {
  readonly dataAge: DataAge;
  readonly degraded: boolean;
  /** Names of the fields that blew their budget, sorted, so the reason is always legible. */
  readonly degradedFields: readonly string[];
}

export interface FreshnessInput {
  readonly now: number;
  readonly lastTs: number;
  readonly markTs: number;
  readonly fundingTs: number;
  readonly openInterestTs: number;
  /** Newest candle timestamp per timeframe — the bar START, as OKX reports it. */
  readonly candleTs: ReadonlyArray<{ readonly tf: Timeframe; readonly newestTs: number }>;
}

/**
 * Ages every field against its budget.
 *
 * A negative age (a timestamp in the future, i.e. clock skew between us and the exchange) is
 * clamped to 0 rather than treated as "very fresh" — but it is never treated as stale either,
 * because a skewed clock is not a stalled feed.
 */
export function assessFreshness(
  input: FreshnessInput,
  budget: FreshnessBudget = DEFAULT_FRESHNESS,
): FreshnessAssessment {
  const ages: Record<string, FieldAge> = {};
  const degradedFields: string[] = [];

  const check = (field: string, ts: number, budgetMs: number): void => {
    const ageMs = Math.max(0, input.now - ts);
    const stale = ageMs > budgetMs;
    ages[field] = Object.freeze({ ageMs, budgetMs, stale });
    if (stale) degradedFields.push(field);
  };

  check('last', input.lastTs, budget.lastMs);
  check('mark', input.markTs, budget.markMs);
  check('funding', input.fundingTs, budget.fundingMs);
  check('openInterest', input.openInterestTs, budget.openInterestMs);

  for (const { tf, newestTs } of input.candleTs) {
    check(`candles.${tf}`, newestTs, TIMEFRAME_MS[tf] * budget.candleMultiple);
  }

  degradedFields.sort();
  return Object.freeze({
    dataAge: Object.freeze(ages),
    degraded: degradedFields.length > 0,
    degradedFields: Object.freeze(degradedFields),
  });
}

/** The shape `isTradeable` needs — kept minimal so it can be asked of anything snapshot-like. */
export interface Degradable {
  readonly degraded: boolean;
}

/**
 * The single gate every consumer must pass through before acting on a snapshot.
 *
 * It is deliberately trivial and deliberately the only sanctioned phrasing: a caller writing
 * its own `!snapshot.degraded` is a caller that can forget to.
 */
export function isTradeable(snapshot: Degradable): boolean {
  return !snapshot.degraded;
}
