/**
 * The timeframes a `Signal` may carry.
 *
 * `@plumb/market` owns the full candle-timeframe vocabulary (including the OKX `bar` strings and
 * their millisecond durations); this is the subset that can appear on a signal, kept in core so
 * that core owns the whole `Signal` type without depending on market.
 *
 * `market/src/types.test.ts` pins that these stay a subset of the market timeframes — two lists
 * that can drift apart silently are worse than one list in the wrong place.
 */
export const SIGNAL_TIMEFRAMES = Object.freeze([
  '1m',
  '5m',
  '15m',
  '30m',
  '1H',
  '4H',
  '1D',
] as const);

export type SignalTimeframe = (typeof SIGNAL_TIMEFRAMES)[number];
