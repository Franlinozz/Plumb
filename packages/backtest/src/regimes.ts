/**
 * HISTORICAL REGIME SEGMENTATION.
 *
 * Three years of BTC contains a bull market, and a strategy that only works in one is not a
 * strategy — it is a leveraged long with extra steps. So every metric is reported segmented as
 * well as pooled, and a config profitable only in bull regimes is labelled as such in bold.
 *
 * The classification is deterministic and uses only trailing data: at any instant it looks back
 * 90 days, never forward. Otherwise the segmentation itself would be lookahead.
 */

import type { Candle } from '@plumb/market';

export type MarketRegime = 'bull' | 'bear' | 'chop';

export interface RegimePeriod {
  readonly from: number;
  readonly to: number;
  readonly regime: MarketRegime;
  readonly trailingReturnPct: number;
  readonly realisedVolPct: number;
}

export interface RegimeThresholds {
  /** Trailing 90-day return above this is a bull. */
  readonly bullReturnPct: number;
  /** Trailing 90-day return below this is a bear. */
  readonly bearReturnPct: number;
  readonly lookbackDays: number;
}

export const DEFAULT_REGIME_THRESHOLDS: RegimeThresholds = Object.freeze({
  bullReturnPct: 15,
  bearReturnPct: -15,
  lookbackDays: 90,
});

const MS_PER_DAY = 86_400_000;

/**
 * Classify every bar by the TRAILING 90-day window ending at it.
 *
 * Anything between the two return thresholds is `chop`, which is the majority of the time and is
 * where most strategies actually have to earn their keep.
 */
export function classifyHistory(
  candles: readonly Candle[],
  thresholds: RegimeThresholds = DEFAULT_REGIME_THRESHOLDS,
): ReadonlyMap<number, RegimePeriod> {
  const out = new Map<number, RegimePeriod>();
  if (candles.length === 0) return out;

  const lookbackMs = thresholds.lookbackDays * MS_PER_DAY;
  let start = 0;

  for (let i = 0; i < candles.length; i += 1) {
    const bar = candles[i] as Candle;
    const windowStart = bar.ts - lookbackMs;
    while (start < i && (candles[start] as Candle).ts < windowStart) start += 1;
    if (i - start < 10) continue; // not enough trailing data to classify honestly

    const first = candles[start] as Candle;
    const trailingReturnPct = first.close === 0 ? 0 : ((bar.close - first.close) / first.close) * 100;

    // Realised volatility of the trailing window, annualised from the bar cadence.
    let sumSq = 0;
    let count = 0;
    for (let j = start + 1; j <= i; j += 1) {
      const prev = (candles[j - 1] as Candle).close;
      const curr = (candles[j] as Candle).close;
      if (prev > 0 && curr > 0) {
        sumSq += Math.log(curr / prev) ** 2;
        count += 1;
      }
    }
    const barMs = i > 0 ? bar.ts - (candles[i - 1] as Candle).ts : MS_PER_DAY;
    const barsPerYear = barMs > 0 ? (365 * MS_PER_DAY) / barMs : 1;
    const realisedVolPct = count === 0 ? 0 : Math.sqrt(sumSq / count) * Math.sqrt(barsPerYear) * 100;

    const regime: MarketRegime =
      trailingReturnPct >= thresholds.bullReturnPct
        ? 'bull'
        : trailingReturnPct <= thresholds.bearReturnPct
          ? 'bear'
          : 'chop';

    out.set(bar.ts, { from: first.ts, to: bar.ts, regime, trailingReturnPct, realisedVolPct });
  }
  return out;
}

/** Contiguous runs of one regime — the human-readable form of the map above. */
export function regimeRuns(classified: ReadonlyMap<number, RegimePeriod>): readonly RegimePeriod[] {
  const entries = [...classified.entries()].sort((a, b) => a[0] - b[0]);
  const runs: RegimePeriod[] = [];
  let current: RegimePeriod | undefined;

  for (const [ts, period] of entries) {
    if (current === undefined || current.regime !== period.regime) {
      if (current !== undefined) runs.push(current);
      current = { ...period, from: ts, to: ts };
    } else {
      current = { ...current, to: ts, trailingReturnPct: period.trailingReturnPct, realisedVolPct: period.realisedVolPct };
    }
  }
  if (current !== undefined) runs.push(current);
  return runs;
}

/** How much of the dataset each regime accounts for. */
export function regimeShares(
  classified: ReadonlyMap<number, RegimePeriod>,
): Readonly<Record<MarketRegime, number>> {
  const counts: Record<MarketRegime, number> = { bull: 0, bear: 0, chop: 0 };
  for (const period of classified.values()) counts[period.regime] += 1;
  const total = counts.bull + counts.bear + counts.chop;
  if (total === 0) return counts;
  return { bull: counts.bull / total, bear: counts.bear / total, chop: counts.chop / total };
}

/** The regime in force at an instant — the nearest classified bar at or before it. */
export function regimeAt(
  classified: ReadonlyMap<number, RegimePeriod>,
  ts: number,
): MarketRegime | undefined {
  const direct = classified.get(ts);
  if (direct !== undefined) return direct.regime;
  let best: RegimePeriod | undefined;
  for (const [barTs, period] of classified) {
    if (barTs <= ts && (best === undefined || barTs > best.to)) best = period;
  }
  return best?.regime;
}

/**
 * The verdict the report prints in bold when it applies.
 *
 * A config that only makes money in a bull market has not been shown to have an edge; it has been
 * shown to be long.
 */
export function bullOnlyVerdict(
  byRegime: Readonly<Partial<Record<MarketRegime, { readonly netPnlUsdt: number; readonly trades: number }>>>,
): string | undefined {
  const bull = byRegime.bull;
  const bear = byRegime.bear;
  const chop = byRegime.chop;
  if (bull === undefined || bull.netPnlUsdt <= 0) return undefined;

  const nonBullNet = (bear?.netPnlUsdt ?? 0) + (chop?.netPnlUsdt ?? 0);
  const nonBullTrades = (bear?.trades ?? 0) + (chop?.trades ?? 0);
  if (nonBullTrades === 0) {
    return '**PROFITABLE ONLY IN BULL REGIMES** — it has never traded outside one, so nothing is known about the rest.';
  }
  if (nonBullNet <= 0) {
    return (
      `**PROFITABLE ONLY IN BULL REGIMES** — ${bull.netPnlUsdt.toFixed(2)} USDT in bull, ` +
      `${nonBullNet.toFixed(2)} outside it across ${nonBullTrades} trades. This is a leveraged long, not an edge.`
    );
  }
  return undefined;
}
