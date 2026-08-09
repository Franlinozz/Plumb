/**
 * The MarketSnapshot: the single immutable object `strategy` consumes.
 *
 * Built once per cycle, passed by value, never mutated. Everything a strategy is allowed to
 * know about the market at one instant is in here, and nothing else — no client, no fetcher,
 * no way to ask a follow-up question. That constraint is what makes a strategy replayable:
 * feed the same snapshot in a backtest and it must reach the same decision.
 *
 * `buildSnapshot` is a **pure function of its input**, including the clock — it never calls
 * `Date.now()`. Same inputs in, byte-identical snapshot out.
 */

import type { Instrument } from '@plumb/core';

import {
  adx,
  atr,
  bollinger,
  closes,
  ema,
  latest,
  macd,
  realisedVolatility,
  rsi,
  sma,
} from './indicators.js';
import {
  assessFreshness,
  DEFAULT_FRESHNESS,
  type DataAge,
  type FreshnessBudget,
} from './staleness.js';
import type {
  Candle,
  CandleSeries,
  FundingRate,
  FundingRateHistoryEntry,
  OpenInterest,
  OpenInterestHistoryEntry,
  Ticker,
  Timeframe,
} from './types.js';
import type { MarkPrice } from './types.js';

/**
 * Indicator periods, in one place.
 *
 * They live here rather than at each call site so that `strategy`, `backtest` and the snapshot
 * can never disagree about what "the 14-period ATR" means.
 */
export const INDICATOR_CONFIG = Object.freeze({
  rsiPeriod: 14,
  atrPeriod: 14,
  emaFast: 20,
  emaSlow: 50,
  smaLong: 200,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  bollingerPeriod: 20,
  bollingerMultiplier: 2,
  realisedVolPeriod: 20,
  adxPeriod: 14,
});

/** Latest indicator readings for one timeframe. `undefined` means "not enough history yet". */
export interface IndicatorValues {
  readonly rsi: number | undefined;
  readonly atr: number | undefined;
  readonly emaFast: number | undefined;
  readonly emaSlow: number | undefined;
  readonly smaLong: number | undefined;
  readonly macd: number | undefined;
  readonly macdSignal: number | undefined;
  readonly macdHistogram: number | undefined;
  readonly bbUpper: number | undefined;
  readonly bbMiddle: number | undefined;
  readonly bbLower: number | undefined;
  readonly bbBandwidth: number | undefined;
  readonly realisedVol: number | undefined;
  readonly adx: number | undefined;
  readonly plusDi: number | undefined;
  readonly minusDi: number | undefined;
}

export interface SnapshotFunding {
  readonly current: number;
  readonly next: number | undefined;
  readonly nextTime: number;
  readonly history: readonly FundingRateHistoryEntry[];
}

export interface SnapshotOpenInterest {
  readonly value: number;
  readonly valueUsd: number;
  readonly history: readonly OpenInterestHistoryEntry[];
}

export interface MarketSnapshot {
  /** The instant this snapshot describes, in UTC ms. */
  readonly ts: number;
  readonly instId: Instrument;
  readonly candles: readonly CandleSeries[];
  readonly last: number;
  readonly mark: number;
  readonly funding: SnapshotFunding;
  readonly openInterest: SnapshotOpenInterest;
  readonly indicators: Readonly<Partial<Record<Timeframe, IndicatorValues>>>;
  readonly dataAge: DataAge;
  /** True when any required field blew its freshness budget. See `isTradeable`. */
  readonly degraded: boolean;
  readonly degradedFields: readonly string[];
}

export interface SnapshotInput {
  /** The cycle clock, injected. `buildSnapshot` never reads the system clock itself. */
  readonly now: number;
  readonly instId: Instrument;
  readonly ticker: Ticker;
  readonly markPrice: MarkPrice;
  readonly funding: FundingRate;
  readonly fundingHistory: readonly FundingRateHistoryEntry[];
  readonly openInterest: OpenInterest;
  readonly openInterestHistory: readonly OpenInterestHistoryEntry[];
  readonly candles: readonly CandleSeries[];
  readonly freshness?: FreshnessBudget;
}

/** Latest indicator readings for one candle series. */
export function computeIndicators(candles: readonly Candle[]): IndicatorValues {
  const price = closes(candles);
  const macdResult = macd(
    price,
    INDICATOR_CONFIG.macdFast,
    INDICATOR_CONFIG.macdSlow,
    INDICATOR_CONFIG.macdSignal,
  );
  const bands = bollinger(
    price,
    INDICATOR_CONFIG.bollingerPeriod,
    INDICATOR_CONFIG.bollingerMultiplier,
  );
  const directional = adx(candles, INDICATOR_CONFIG.adxPeriod);

  return Object.freeze({
    rsi: latest(rsi(price, INDICATOR_CONFIG.rsiPeriod)),
    atr: latest(atr(candles, INDICATOR_CONFIG.atrPeriod)),
    emaFast: latest(ema(price, INDICATOR_CONFIG.emaFast)),
    emaSlow: latest(ema(price, INDICATOR_CONFIG.emaSlow)),
    smaLong: latest(sma(price, INDICATOR_CONFIG.smaLong)),
    macd: latest(macdResult.macd),
    macdSignal: latest(macdResult.signal),
    macdHistogram: latest(macdResult.histogram),
    bbUpper: latest(bands.upper),
    bbMiddle: latest(bands.middle),
    bbLower: latest(bands.lower),
    bbBandwidth: latest(bands.bandwidth),
    realisedVol: latest(realisedVolatility(price, INDICATOR_CONFIG.realisedVolPeriod)),
    adx: latest(directional.adx),
    plusDi: latest(directional.plusDi),
    minusDi: latest(directional.minusDi),
  });
}

/**
 * Assemble the snapshot. Deterministic: no clock, no network, no mutation of the input.
 *
 * Candle series are sorted **oldest-first** here, because OKX returns them newest-first and
 * every indicator in this package assumes chronological order. Getting that backwards yields
 * plausible-looking numbers that are exactly wrong, which is the worst failure mode available.
 */
export function buildSnapshot(input: SnapshotInput): MarketSnapshot {
  const series: CandleSeries[] = input.candles.map((s) => ({
    tf: s.tf,
    ohlcv: Object.freeze([...s.ohlcv].sort((a, b) => a.ts - b.ts)),
  }));
  series.sort((a, b) => a.tf.localeCompare(b.tf));

  const indicators: Partial<Record<Timeframe, IndicatorValues>> = {};
  for (const s of series) indicators[s.tf] = computeIndicators(s.ohlcv);

  const freshness = assessFreshness(
    {
      now: input.now,
      lastTs: input.ticker.ts,
      markTs: input.markPrice.ts,
      fundingTs: input.funding.ts,
      openInterestTs: input.openInterest.ts,
      candleTs: series.map((s) => ({
        tf: s.tf,
        newestTs: s.ohlcv.length === 0 ? 0 : (s.ohlcv[s.ohlcv.length - 1] as Candle).ts,
      })),
    },
    input.freshness ?? DEFAULT_FRESHNESS,
  );

  return Object.freeze({
    ts: input.now,
    instId: input.instId,
    candles: Object.freeze(series.map((s) => Object.freeze(s))),
    last: input.ticker.last,
    mark: input.markPrice.markPx,
    funding: Object.freeze({
      current: input.funding.fundingRate,
      next: input.funding.nextFundingRate,
      nextTime: input.funding.fundingTime,
      history: Object.freeze([...input.fundingHistory]),
    }),
    openInterest: Object.freeze({
      value: input.openInterest.oi,
      valueUsd: input.openInterest.oiUsd,
      history: Object.freeze([...input.openInterestHistory]),
    }),
    indicators: Object.freeze(indicators),
    dataAge: freshness.dataAge,
    degraded: freshness.degraded,
    degradedFields: freshness.degradedFields,
  });
}

export interface SyntheticSnapshotInput {
  readonly now: number;
  readonly instId: Instrument;
  readonly candles: readonly CandleSeries[];
  readonly fundingRate?: number;
  readonly fundingHistory?: readonly FundingRateHistoryEntry[];
  readonly openInterest?: number;
  readonly openInterestUsd?: number;
  readonly openInterestHistory?: readonly OpenInterestHistoryEntry[];
}

/**
 * Build a snapshot from candles alone — the historical-replay path used by backtests.
 *
 * **Two honest approximations, stated rather than hidden:**
 *  1. `mark` is set equal to `last`. There is no historical mark-price series on the public API,
 *     and inventing a basis would be inventing data. On these instruments the two track within a
 *     few basis points (measured live in P1), so the error is small — but it IS an error, and any
 *     strategy that trades the mark/last basis must not be backtested through this path.
 *  2. Every timestamp is set to `now`, so a replayed snapshot is never `degraded`. That is
 *     correct: historical data is old, not *stale*. Staleness is a liveness property of a running
 *     feed, and replaying it would make every backtest bar unusable.
 */
export function snapshotFromCandles(input: SyntheticSnapshotInput): MarketSnapshot {
  const primary = input.candles[0];
  const newest = primary?.ohlcv[primary.ohlcv.length - 1];
  if (newest === undefined) {
    throw new RangeError('snapshotFromCandles needs at least one candle in the first series');
  }
  const rate = input.fundingRate ?? 0;
  return buildSnapshot({
    now: input.now,
    instId: input.instId,
    ticker: {
      instId: input.instId,
      last: newest.close,
      askPx: newest.close,
      bidPx: newest.close,
      open24h: newest.open,
      high24h: newest.high,
      low24h: newest.low,
      vol24h: newest.volume,
      ts: input.now,
    },
    markPrice: { instId: input.instId, markPx: newest.close, ts: input.now },
    funding: {
      instId: input.instId,
      fundingRate: rate,
      fundingTime: input.now,
      nextFundingRate: undefined,
      nextFundingTime: input.now + 28_800_000,
      prevFundingTime: input.now - 28_800_000,
      minFundingRate: -0.00375,
      maxFundingRate: 0.00375,
      ts: input.now,
    },
    fundingHistory: input.fundingHistory ?? [],
    openInterest: {
      instId: input.instId,
      oi: input.openInterest ?? 0,
      oiCcy: 0,
      oiUsd: input.openInterestUsd ?? 0,
      ts: input.now,
    },
    openInterestHistory: input.openInterestHistory ?? [],
    candles: input.candles,
  });
}

/** The candle series for one timeframe, or `undefined` if the snapshot does not carry it. */
export function seriesFor(
  snapshot: MarketSnapshot,
  tf: Timeframe,
): readonly Candle[] | undefined {
  return snapshot.candles.find((s) => s.tf === tf)?.ohlcv;
}
