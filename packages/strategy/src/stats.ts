/** Small pure statistics helpers. No I/O, no clock, no allocation surprises. */

import type { Series } from '@plumb/market';

/** Defined values only, order preserved. */
export function defined(series: Series): readonly number[] {
  const out: number[] = [];
  for (const v of series) if (v !== undefined) out.push(v);
  return out;
}

/** The last `n` values of an array. Fewer if there are fewer. */
export function tail(values: readonly number[], n: number): readonly number[] {
  return n >= values.length ? values : values.slice(values.length - n);
}

export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * Where `value` sits within `values`, in 0..1, using the MID-RANK convention.
 *
 * Used to rank a reading against its own history rather than against an absolute threshold —
 * "is funding extreme for THIS instrument" is a question an absolute number cannot answer.
 *
 * Mid-rank — averaging the strictly-below and at-or-below counts — matters because of ties. The
 * naive at-or-below form scores a perfectly flat series at 1.0, i.e. "this reading is the highest
 * it has ever been", which would make a dead-quiet market look like it was expanding violently.
 * Mid-rank scores it 0.5: unremarkable, which is the truth.
 */
export function percentileRank(value: number, values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  let below = 0;
  let atOrBelow = 0;
  for (const v of values) {
    if (v < value) below += 1;
    if (v <= value) atOrBelow += 1;
  }
  return (below + atOrBelow) / (2 * values.length);
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Highest high and lowest low over the last `n` entries, excluding the final bar. */
export function rangeExcludingLast(
  highs: readonly number[],
  lows: readonly number[],
  n: number,
): { high: number; low: number } | undefined {
  if (highs.length < n + 1 || lows.length < n + 1) return undefined;
  const end = highs.length - 1;
  let high = Number.NEGATIVE_INFINITY;
  let low = Number.POSITIVE_INFINITY;
  for (let i = end - n; i < end; i += 1) {
    high = Math.max(high, highs[i] as number);
    low = Math.min(low, lows[i] as number);
  }
  return Number.isFinite(high) && Number.isFinite(low) ? { high, low } : undefined;
}
