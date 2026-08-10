/**
 * THE PUBLIC TRACK RECORD.
 *
 * **Every number here is computed from the ledger. There is no code path that writes a performance
 * figure by hand, and `no-handwritten-numbers.test.ts` scans this package's source to prove it.**
 *
 * This is the Assay lesson applied: a grading product that can report a result it did not measure
 * will eventually report one. If we have three losing weeks the page says three losing weeks —
 * which is also the only reason a paying subscriber should believe the good weeks.
 */

import { LOCKED } from '@plumb/core';

import type { FeedStore, TradeOutcome } from './feed.js';

export interface TrackRecord {
  readonly generatedAt: number;
  readonly closedTrades: number;
  readonly wins: number;
  readonly losses: number;
  readonly winRatePct: number;
  readonly netPnlUsdt: number;
  readonly startingEquityUsdt: number;
  readonly currentEquityUsdt: number;
  readonly peakEquityUsdt: number;
  readonly currentDrawdownPct: number;
  readonly maxDrawdownPct: number;
  readonly distanceToKillSwitchUsdt: number;
  readonly averageWinUsdt: number;
  readonly averageLossUsdt: number;
  readonly profitFactor: number | null;
  readonly averageRMultiple: number;
  readonly largestLossUsdt: number;
  readonly longestLosingStreak: number;
  readonly totalFundingUsdt: number;
  readonly signalsPublished: number;
  readonly firstTradeAt: number | undefined;
  readonly lastTradeAt: number | undefined;
  /** Plain-language statement of what the numbers do and do not establish. */
  readonly caveat: string;
}

/**
 * Compute the record. Pure given the store's contents and the clock.
 *
 * `profitFactor` is `null` rather than Infinity when there have been no losses — a run with no
 * losses has an UNDEFINED profit factor, and printing ∞ on a public page would be a lie of
 * presentation on a two-trade sample.
 */
export function buildTrackRecord(store: FeedStore, now: number): TrackRecord {
  const outcomes = store.outcomes();
  const startingEquity: number = LOCKED.CAPITAL_USDT;

  const wins = outcomes.filter((o) => o.netPnlUsdt > 0);
  const losses = outcomes.filter((o) => o.netPnlUsdt <= 0);
  const grossWin = wins.reduce((s, o) => s + o.netPnlUsdt, 0);
  const grossLoss = Math.abs(losses.reduce((s, o) => s + o.netPnlUsdt, 0));
  const netPnl = outcomes.reduce((s, o) => s + o.netPnlUsdt, 0);

  const curve = equityCurve(outcomes, startingEquity);
  const currentEquity = curve.length === 0 ? startingEquity : (curve[curve.length - 1] as number);
  let peak: number = startingEquity;
  let maxDrawdownPct = 0;
  for (const equity of curve) {
    if (equity > peak) peak = equity;
    const dd = peak === 0 ? 0 : ((peak - equity) / peak) * 100;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
  }

  return {
    generatedAt: now,
    closedTrades: outcomes.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: outcomes.length === 0 ? 0 : (wins.length / outcomes.length) * 100,
    netPnlUsdt: netPnl,
    startingEquityUsdt: startingEquity,
    currentEquityUsdt: currentEquity,
    peakEquityUsdt: peak,
    currentDrawdownPct: peak === 0 ? 0 : ((peak - currentEquity) / peak) * 100,
    maxDrawdownPct,
    distanceToKillSwitchUsdt: currentEquity - LOCKED.KILL_SWITCH_EQUITY_USDT,
    averageWinUsdt: wins.length === 0 ? 0 : grossWin / wins.length,
    averageLossUsdt: losses.length === 0 ? 0 : -grossLoss / losses.length,
    profitFactor: grossLoss === 0 ? null : grossWin / grossLoss,
    averageRMultiple:
      outcomes.length === 0 ? 0 : outcomes.reduce((s, o) => s + o.rMultiple, 0) / outcomes.length,
    largestLossUsdt: losses.length === 0 ? 0 : Math.min(...losses.map((o) => o.netPnlUsdt)),
    longestLosingStreak: longestLosingStreak(outcomes),
    totalFundingUsdt: outcomes.reduce((s, o) => s + o.fundingUsdt, 0),
    signalsPublished: store.count(),
    firstTradeAt: outcomes[0]?.closedAt,
    lastTradeAt: outcomes[outcomes.length - 1]?.closedAt,
    caveat: caveatFor(outcomes.length),
  };
}

function equityCurve(outcomes: readonly TradeOutcome[], startingEquity: number): readonly number[] {
  let equity: number = startingEquity;
  return outcomes.map((o) => {
    equity += o.netPnlUsdt;
    return equity;
  });
}

export function longestLosingStreak(outcomes: readonly TradeOutcome[]): number {
  let longest = 0;
  let current = 0;
  for (const o of outcomes) {
    if (o.netPnlUsdt <= 0) {
      current += 1;
      if (current > longest) longest = current;
    } else current = 0;
  }
  return longest;
}

/**
 * The caveat scales with the sample.
 *
 * A small sample gets a blunt warning rather than a footnote, because the most misleading thing a
 * track record can do is present twelve trades with the confidence of twelve hundred.
 */
export function caveatFor(tradeCount: number): string {
  if (tradeCount === 0) {
    return 'No trades have closed yet. Nothing here establishes anything about future results.';
  }
  if (tradeCount < 30) {
    return (
      `Only ${tradeCount} trades have closed. That is NOT a sample from which performance can be ` +
      `concluded — the error bars are wider than any result shown. Treat this as a record of what ` +
      `happened, not as evidence of an edge.`
    );
  }
  return (
    `Computed from ${tradeCount} closed trades, every one traceable to a published signal. Past ` +
    `results do not predict future results, most individual signals lose, and the losing periods ` +
    `are shown here for the same reason the winning ones are.`
  );
}
