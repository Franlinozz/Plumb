/**
 * Deterministic technical indicators, computed locally from candles.
 *
 * **Pure functions. No I/O, no clock, no randomness.** Same input, same output, forever.
 *
 * Why compute these ourselves when the Agent Trade Kit exposes 70+ server-side: `strategy`
 * must be fully replayable in backtest, and the same code path must produce the same numbers
 * live and historically. A server-side indicator cannot be replayed against a candle from six
 * months ago without trusting that the server computed it the same way that day. Local
 * computation makes the backtest and the live loop provably the same function.
 *
 * Conventions, stated once because they are where implementations quietly differ:
 *  - Every function returns a `Series` **aligned to the input**, with `undefined` in the
 *    warm-up region. No silent truncation, so index `i` always means candle `i`.
 *  - RSI, ATR and ADX use **Wilder's smoothing** (the original definition), not a plain EMA.
 *  - Standard deviation is **population** (÷n), which is what Bollinger Bands specify.
 *  - EMA is seeded with the SMA of the first `period` values.
 */

import type { Candle } from './types.js';

/** A value per input index; `undefined` while the indicator is still warming up. */
export type Series = readonly (number | undefined)[];

function assertPeriod(period: number, name: string): void {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError(`${name} period must be a positive integer, got ${period}`);
  }
}

function blank(length: number): (number | undefined)[] {
  return new Array<number | undefined>(length).fill(undefined);
}

/** Simple moving average. */
export function sma(values: readonly number[], period: number): Series {
  assertPeriod(period, 'sma');
  const out = blank(values.length);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i] as number;
    if (i >= period) sum -= values[i - period] as number;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Exponential moving average, seeded with the SMA of the first `period` values. */
export function ema(values: readonly number[], period: number): Series {
  assertPeriod(period, 'ema');
  const out = blank(values.length);
  if (values.length < period) return out;

  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += values[i] as number;
  seed /= period;
  out[period - 1] = seed;

  const k = 2 / (period + 1);
  let prev = seed;
  for (let i = period; i < values.length; i += 1) {
    prev = (values[i] as number) * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** EMA over a series that already has a warm-up gap (used for the MACD signal line). */
function emaOverDefined(series: Series, period: number): Series {
  const out = blank(series.length);
  const firstDefined = series.findIndex((v) => v !== undefined);
  if (firstDefined < 0) return out;

  const dense = series.slice(firstDefined) as readonly number[];
  const inner = ema(dense, period);
  for (let i = 0; i < inner.length; i += 1) out[firstDefined + i] = inner[i];
  return out;
}

/**
 * Relative Strength Index, Wilder-smoothed.
 *
 * Degenerate cases are defined explicitly rather than left to a division by zero:
 * a window with no losses is 100, one with no gains is 0, and a perfectly flat window
 * (neither gains nor losses) is 50 — flat is neutral, not maximally overbought.
 */
export function rsi(values: readonly number[], period = 14): Series {
  assertPeriod(period, 'rsi');
  const out = blank(values.length);
  if (values.length <= period) return out;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i += 1) {
    const delta = (values[i] as number) - (values[i - 1] as number);
    if (delta > 0) avgGain += delta;
    else avgLoss += -delta;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = rsiFrom(avgGain, avgLoss);

  for (let i = period + 1; i < values.length; i += 1) {
    const delta = (values[i] as number) - (values[i - 1] as number);
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = rsiFrom(avgGain, avgLoss);
  }
  return out;
}

function rsiFrom(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  if (avgGain === 0) return 0;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

export interface MacdResult {
  readonly macd: Series;
  readonly signal: Series;
  readonly histogram: Series;
}

export function macd(
  values: readonly number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MacdResult {
  assertPeriod(fastPeriod, 'macd fast');
  assertPeriod(slowPeriod, 'macd slow');
  assertPeriod(signalPeriod, 'macd signal');
  if (fastPeriod >= slowPeriod) {
    throw new RangeError(`macd fast (${fastPeriod}) must be shorter than slow (${slowPeriod})`);
  }

  const fast = ema(values, fastPeriod);
  const slow = ema(values, slowPeriod);
  const line = blank(values.length);
  for (let i = 0; i < values.length; i += 1) {
    const f = fast[i];
    const s = slow[i];
    if (f !== undefined && s !== undefined) line[i] = f - s;
  }

  const signal = emaOverDefined(line, signalPeriod);
  const histogram = blank(values.length);
  for (let i = 0; i < values.length; i += 1) {
    const m = line[i];
    const s = signal[i];
    if (m !== undefined && s !== undefined) histogram[i] = m - s;
  }
  return { macd: line, signal, histogram };
}

/**
 * True Range. Index 0 is `undefined` — true range is defined against the PREVIOUS close, and
 * the first candle has no previous close. Implementations that fudge index 0 to `high - low`
 * shift every subsequent Wilder average by one bar.
 */
export function trueRange(candles: readonly Candle[]): Series {
  const out = blank(candles.length);
  for (let i = 1; i < candles.length; i += 1) {
    const c = candles[i] as Candle;
    const prevClose = (candles[i - 1] as Candle).close;
    out[i] = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  }
  return out;
}

/**
 * Average True Range, Wilder-smoothed.
 *
 * This one sets position size — `size = PER_TRADE_RISK / stopDistance`, and stop distance is
 * an ATR multiple. A wrong ATR is a wrong bet size, so it has its own dedicated tests.
 */
export function atr(candles: readonly Candle[], period = 14): Series {
  assertPeriod(period, 'atr');
  const tr = trueRange(candles);
  const out = blank(candles.length);
  if (candles.length <= period) return out;

  let sum = 0;
  for (let i = 1; i <= period; i += 1) sum += tr[i] as number;
  let prev = sum / period;
  out[period] = prev;

  for (let i = period + 1; i < candles.length; i += 1) {
    prev = (prev * (period - 1) + (tr[i] as number)) / period;
    out[i] = prev;
  }
  return out;
}

export interface BollingerResult {
  readonly middle: Series;
  readonly upper: Series;
  readonly lower: Series;
  /** `(upper - lower) / middle` — the squeeze/expansion measure. */
  readonly bandwidth: Series;
}

export function bollinger(
  values: readonly number[],
  period = 20,
  multiplier = 2,
): BollingerResult {
  assertPeriod(period, 'bollinger');
  const middle = sma(values, period);
  const upper = blank(values.length);
  const lower = blank(values.length);
  const bandwidth = blank(values.length);

  for (let i = period - 1; i < values.length; i += 1) {
    const mean = middle[i];
    if (mean === undefined) continue;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j += 1) {
      const d = (values[j] as number) - mean;
      variance += d * d;
    }
    const sd = Math.sqrt(variance / period);
    const hi = mean + multiplier * sd;
    const lo = mean - multiplier * sd;
    upper[i] = hi;
    lower[i] = lo;
    bandwidth[i] = mean === 0 ? 0 : (hi - lo) / mean;
  }
  return { middle, upper, lower, bandwidth };
}

/**
 * Realised volatility: the population standard deviation of log returns over a rolling
 * window. Defined from index `period` (one return is consumed per pair of prices).
 *
 * Pass `periodsPerYear` to annualise — e.g. 35_040 for 15m bars (4 × 24 × 365).
 */
export function realisedVolatility(
  values: readonly number[],
  period = 20,
  options: { readonly periodsPerYear?: number } = {},
): Series {
  assertPeriod(period, 'realisedVolatility');
  const out = blank(values.length);
  if (values.length <= period) return out;

  const returns = blank(values.length);
  for (let i = 1; i < values.length; i += 1) {
    const prev = values[i - 1] as number;
    const curr = values[i] as number;
    returns[i] = prev > 0 && curr > 0 ? Math.log(curr / prev) : 0;
  }

  const scale =
    options.periodsPerYear === undefined ? 1 : Math.sqrt(options.periodsPerYear);

  for (let i = period; i < values.length; i += 1) {
    let mean = 0;
    for (let j = i - period + 1; j <= i; j += 1) mean += returns[j] as number;
    mean /= period;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j += 1) {
      const d = (returns[j] as number) - mean;
      variance += d * d;
    }
    out[i] = Math.sqrt(variance / period) * scale;
  }
  return out;
}

export interface AdxResult {
  readonly adx: Series;
  readonly plusDi: Series;
  readonly minusDi: Series;
}

/**
 * Average Directional Index with the +DI / −DI pair, Wilder-smoothed throughout.
 *
 * ADX needs two warm-ups stacked: DX is defined from index `period`, and ADX averages the
 * first `period` DX values, so ADX starts at index `2 × period − 1`.
 */
export function adx(candles: readonly Candle[], period = 14): AdxResult {
  assertPeriod(period, 'adx');
  const n = candles.length;
  const tr = trueRange(candles);
  const plusDm = blank(n);
  const minusDm = blank(n);

  for (let i = 1; i < n; i += 1) {
    const c = candles[i] as Candle;
    const p = candles[i - 1] as Candle;
    const up = c.high - p.high;
    const down = p.low - c.low;
    plusDm[i] = up > down && up > 0 ? up : 0;
    minusDm[i] = down > up && down > 0 ? down : 0;
  }

  const plusDi = blank(n);
  const minusDi = blank(n);
  const dx = blank(n);
  const out = blank(n);
  if (n <= period) return { adx: out, plusDi, minusDi };

  let smTr = 0;
  let smPlus = 0;
  let smMinus = 0;
  for (let i = 1; i <= period; i += 1) {
    smTr += tr[i] as number;
    smPlus += plusDm[i] as number;
    smMinus += minusDm[i] as number;
  }

  const record = (i: number): void => {
    const pdi = smTr === 0 ? 0 : (100 * smPlus) / smTr;
    const mdi = smTr === 0 ? 0 : (100 * smMinus) / smTr;
    plusDi[i] = pdi;
    minusDi[i] = mdi;
    dx[i] = pdi + mdi === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / (pdi + mdi);
  };
  record(period);

  for (let i = period + 1; i < n; i += 1) {
    smTr = smTr - smTr / period + (tr[i] as number);
    smPlus = smPlus - smPlus / period + (plusDm[i] as number);
    smMinus = smMinus - smMinus / period + (minusDm[i] as number);
    record(i);
  }

  const adxStart = 2 * period - 1;
  if (n <= adxStart) return { adx: out, plusDi, minusDi };

  let sum = 0;
  for (let i = period; i <= adxStart; i += 1) sum += dx[i] as number;
  let prev = sum / period;
  out[adxStart] = prev;

  for (let i = adxStart + 1; i < n; i += 1) {
    prev = (prev * (period - 1) + (dx[i] as number)) / period;
    out[i] = prev;
  }
  return { adx: out, plusDi, minusDi };
}

/** The last defined value of a series, or `undefined` if it never warmed up. */
export function latest(series: Series): number | undefined {
  for (let i = series.length - 1; i >= 0; i -= 1) {
    const v = series[i];
    if (v !== undefined) return v;
  }
  return undefined;
}

/** Closing prices, the input most indicators take. */
export function closes(candles: readonly Candle[]): readonly number[] {
  return candles.map((c) => c.close);
}
