import { LOCKED, type Instrument } from '@plumb/core';

/**
 * @plumb/market — the only component that talks to market data.
 *
 * Everything here reads OKX's PUBLIC endpoints, which require no authentication. **No API key
 * exists in this package and none is needed** (AGENTS.md guardrail 10).
 */
export const MARKET_PACKAGE = Object.freeze({
  name: '@plumb/market',
  /** Reads the outside world. Writes nothing, decides nothing. */
  responsibility: 'ingest',
  universe: LOCKED.INSTRUMENTS,
  /** Pinned by a test: nothing in this package reads a credential. */
  requiresCredentials: false,
});

/** The only instruments any Plumb component may request data for. */
export function tradableUniverse(): readonly Instrument[] {
  return LOCKED.INSTRUMENTS;
}

export {
  MarketError,
  OkxApiError,
  OkxHttpError,
  OkxNetworkError,
  OkxParseError,
  OkxTimeoutError,
  UnsupportedInstrumentError,
} from './errors.js';

export {
  DEFAULT_RETRY,
  MAX_CANDLE_PAGE,
  OKX_PUBLIC_BASE_URL,
  OkxPublicClient,
  indexInstIdFor,
  parseCandle,
  type FetchLike,
  type OkxPublicClientOptions,
  type RetryPolicy,
} from './client.js';

export {
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
  trueRange,
  type AdxResult,
  type BollingerResult,
  type MacdResult,
  type Series,
} from './indicators.js';

export {
  DEFAULT_FRESHNESS,
  assessFreshness,
  isTradeable,
  type DataAge,
  type Degradable,
  type FieldAge,
  type FreshnessAssessment,
  type FreshnessBudget,
  type FreshnessInput,
} from './staleness.js';

export {
  INDICATOR_CONFIG,
  buildSnapshot,
  computeIndicators,
  seriesFor,
  snapshotFromCandles,
  type SyntheticSnapshotInput,
  type IndicatorValues,
  type MarketSnapshot,
  type SnapshotFunding,
  type SnapshotInput,
  type SnapshotOpenInterest,
} from './snapshot.js';

export {
  CandleStore,
  type GetCandlesOptions,
  type PutResult,
} from './cache.js';

export {
  backfillCandles,
  daysAgo,
  findDuplicates,
  findGaps,
  type BackfillOptions,
  type BackfillProgress,
  type BackfillResult,
  type Gap,
} from './history.js';

export {
  FIXTURES_DIR,
  fixtureCandles,
  fixtureEnvelope,
  fixtureFetch,
  fixtureMeta,
  type FixtureMeta,
} from './fixtures.js';

export {
  OI_PERIODS,
  TIMEFRAMES,
  TIMEFRAME_MS,
  isTimeframe,
  type Candle,
  type CandleSeries,
  type FundingRate,
  type FundingRateHistoryEntry,
  type IndexTicker,
  type MarkPrice,
  type OiPeriod,
  type OpenInterest,
  type OpenInterestHistoryEntry,
  type PriceLimit,
  type Ticker,
  type Timeframe,
} from './types.js';
