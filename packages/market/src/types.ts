import type { Instrument } from '@plumb/core';

/**
 * Candle timeframes. These are OKX `bar` values verbatim — note the uppercase `H`, which
 * OKX requires and which a lowercase `1h` silently fails on.
 */
export const TIMEFRAMES = Object.freeze(['1m', '5m', '15m', '30m', '1H', '4H', '1D'] as const);
export type Timeframe = (typeof TIMEFRAMES)[number];

/** Milliseconds in one bar of each timeframe. Used for staleness budgets and gap detection. */
export const TIMEFRAME_MS: Readonly<Record<Timeframe, number>> = Object.freeze({
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1H': 3_600_000,
  '4H': 14_400_000,
  '1D': 86_400_000,
});

export function isTimeframe(value: string): value is Timeframe {
  return (TIMEFRAMES as readonly string[]).includes(value);
}

/**
 * One candlestick.
 *
 * `ts` is the START of the bar, in UTC milliseconds — OKX's convention. `closed` comes from
 * OKX's `confirm` field: `"1"` means the bar is finalised and will never change again, `"0"`
 * means it is still forming. That distinction is the whole basis of the cache: a closed
 * candle is immutable and is never refetched; an open one must be.
 */
export interface Candle {
  readonly ts: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  /** Volume in contracts. */
  readonly volume: number;
  /** Volume in the base currency. */
  readonly volumeCcy: number;
  /** Volume in the quote currency. */
  readonly volumeQuote: number;
  readonly closed: boolean;
}

export interface CandleSeries {
  readonly tf: Timeframe;
  readonly ohlcv: readonly Candle[];
}

export interface Ticker {
  readonly instId: Instrument;
  readonly last: number;
  readonly askPx: number;
  readonly bidPx: number;
  readonly open24h: number;
  readonly high24h: number;
  readonly low24h: number;
  readonly vol24h: number;
  readonly ts: number;
}

export interface MarkPrice {
  readonly instId: Instrument;
  readonly markPx: number;
  readonly ts: number;
}

export interface IndexTicker {
  /** The index instrument, e.g. `BTC-USD` — NOT the swap instId. */
  readonly instId: string;
  readonly idxPx: number;
  readonly high24h: number;
  readonly low24h: number;
  readonly open24h: number;
  readonly ts: number;
}

/**
 * The current funding rate.
 *
 * OKX's naming is a trap: `fundingTime` is the NEXT settlement this rate applies to, and
 * `nextFundingTime` is the one after that. `prevFundingTime` is the last settled one.
 */
export interface FundingRate {
  readonly instId: Instrument;
  readonly fundingRate: number;
  readonly fundingTime: number;
  readonly nextFundingRate: number | undefined;
  readonly nextFundingTime: number;
  readonly prevFundingTime: number;
  readonly minFundingRate: number;
  readonly maxFundingRate: number;
  readonly ts: number;
}

export interface FundingRateHistoryEntry {
  readonly instId: Instrument;
  readonly fundingRate: number;
  readonly realizedRate: number;
  readonly fundingTime: number;
}

export interface OpenInterest {
  readonly instId: Instrument;
  /** Open interest in contracts. */
  readonly oi: number;
  /** Open interest in the base currency. */
  readonly oiCcy: number;
  /** Open interest in USD. */
  readonly oiUsd: number;
  readonly ts: number;
}

export interface OpenInterestHistoryEntry {
  readonly ts: number;
  readonly oi: number;
  readonly oiCcy: number;
  readonly oiUsd: number;
}

export interface PriceLimit {
  readonly instId: Instrument;
  readonly buyLmt: number;
  readonly sellLmt: number;
  readonly enabled: boolean;
  readonly ts: number;
}

/** Periods accepted by OKX's open-interest history endpoint. */
export const OI_PERIODS = Object.freeze(['5m', '1H', '1D'] as const);
export type OiPeriod = (typeof OI_PERIODS)[number];
