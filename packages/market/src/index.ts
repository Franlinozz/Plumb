import { LOCKED, type Instrument } from '@plumb/core';

/**
 * @plumb/market — market data ingest.
 *
 * Placeholder. The real ingest (OKX public candles, tickers and funding; fixture-backed
 * under `PLUMB_MODE=fake`) lands in a later phase. Market data needs no authentication,
 * which is why this package can be built and exercised long before any key exists.
 */
export const MARKET_PACKAGE = Object.freeze({
  name: '@plumb/market',
  /** Reads the outside world. Writes nothing, decides nothing. */
  responsibility: 'ingest',
  universe: LOCKED.INSTRUMENTS,
});

/** The only instruments any Plumb component may request data for. */
export function tradableUniverse(): readonly Instrument[] {
  return LOCKED.INSTRUMENTS;
}
