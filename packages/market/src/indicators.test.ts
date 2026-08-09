import { describe, expect, it } from 'vitest';

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
  trueRange,
} from './indicators.js';
import { fixtureCandles } from './fixtures.js';
import type { Candle } from './types.js';

/** Minimal candle builder — only the fields OHLC indicators read. */
function candle(high: number, low: number, close: number, open = close): Candle {
  return Object.freeze({
    ts: 0,
    open,
    high,
    low,
    close,
    volume: 0,
    volumeCcy: 0,
    volumeQuote: 0,
    closed: true,
  });
}

const P = 10; // decimal places for float comparisons

describe('sma', () => {
  it('matches hand-computed values and warms up at index period-1', () => {
    expect(sma([1, 2, 3, 10, 5], 3)).toEqual([undefined, undefined, 2, 5, 6]);
  });

  it('rejects a nonsense period', () => {
    expect(() => sma([1, 2, 3], 0)).toThrow(RangeError);
    expect(() => sma([1, 2, 3], 1.5)).toThrow(RangeError);
  });

  it('returns an all-undefined series when there is not enough history', () => {
    expect(sma([1, 2], 5)).toEqual([undefined, undefined]);
  });
});

describe('ema', () => {
  it('matches hand-computed values, seeded with the SMA of the first period', () => {
    // seed = mean(1,2,3) = 2; k = 2/(3+1) = 0.5
    // idx3 = 10*0.5 + 2*0.5   = 6
    // idx4 =  5*0.5 + 6*0.5   = 5.5
    expect(ema([1, 2, 3, 10, 5], 3)).toEqual([undefined, undefined, 2, 6, 5.5]);
  });

  it('differs from sma on the same series, i.e. it really is weighting recency', () => {
    expect(ema([1, 2, 3, 10, 5], 3)).not.toEqual(sma([1, 2, 3, 10, 5], 3));
  });
});

describe('rsi', () => {
  // Wilder-smoothed, hand-computed on a deliberately small mixed series.
  const values = [10, 11, 10.5, 11.5, 11, 12];

  it('matches hand-computed values', () => {
    const out = rsi(values, 2);
    expect(out[0]).toBeUndefined();
    expect(out[1]).toBeUndefined();
    expect(out[2] as number).toBeCloseTo(100 - 100 / 3, P); // avgGain .5 / avgLoss .25
    expect(out[3] as number).toBeCloseTo(100 - 100 / 7, P); // .75 / .125
    expect(out[4] as number).toBeCloseTo(100 - 100 / 2.2, P); // .375 / .3125
    expect(out[5] as number).toBeCloseTo(100 - 100 / 5.4, P); // .6875 / .15625
  });

  it('defines the degenerate cases explicitly instead of dividing by zero', () => {
    expect(latest(rsi([1, 2, 3, 4, 5], 2))).toBe(100); // no losses
    expect(latest(rsi([5, 4, 3, 2, 1], 2))).toBe(0); // no gains
    expect(latest(rsi([7, 7, 7, 7, 7], 2))).toBe(50); // perfectly flat is NEUTRAL, not overbought
  });

  it('stays inside 0..100 on real recorded data', () => {
    const values15m = closes(fixtureCandles('BTC-USDT-SWAP', '15m'));
    for (const v of rsi(values15m, 14)) {
      if (v === undefined) continue;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });
});

describe('trueRange and atr', () => {
  // TR needs a PREVIOUS close, so index 0 is undefined by construction.
  const series = [
    candle(10, 8, 9),
    candle(11, 9, 10), // TR = max(2, |11-9|, |9-9|)   = 2
    candle(12, 10, 11), // TR = max(2, |12-10|, |10-10|) = 2
    candle(13, 11, 12), // TR = max(2, |13-11|, |11-11|) = 2
    candle(20, 11, 19), // TR = max(9, |20-12|, |11-12|) = 9  ← gap up
  ];

  it('computes true range with the previous close, leaving index 0 undefined', () => {
    expect(trueRange(series)).toEqual([undefined, 2, 2, 2, 9]);
  });

  it('matches hand-computed ATR — this one sets position size', () => {
    // Wilder: ATR[3] = mean(TR[1..3]) = 2 ; ATR[4] = (2*(3-1) + 9)/3 = 13/3
    const out = atr(series, 3);
    expect(out[0]).toBeUndefined();
    expect(out[1]).toBeUndefined();
    expect(out[2]).toBeUndefined();
    expect(out[3] as number).toBeCloseTo(2, P);
    expect(out[4] as number).toBeCloseTo(13 / 3, P);
  });

  it('warms up at exactly index `period` and never earlier', () => {
    const out = atr(series, 4);
    expect(out.slice(0, 4).every((v) => v === undefined)).toBe(true);
    expect(out[4] as number).toBeCloseTo((2 + 2 + 2 + 9) / 4, P);
  });

  it('is strictly positive and proportionate on real recorded data', () => {
    const candles = fixtureCandles('BTC-USDT-SWAP', '15m');
    const out = atr(candles, 14);
    const last = latest(out);
    expect(last).toBeDefined();
    if (last === undefined) return;
    expect(last).toBeGreaterThan(0);
    // A 15m ATR that is a double-digit percentage of price would mean the maths is wrong,
    // not that the market moved — this is the sanity check that catches a scale error.
    const price = (candles[candles.length - 1] as Candle).close;
    expect(last / price).toBeLessThan(0.05);
  });

  it('returns nothing when there is not enough history for one average', () => {
    expect(atr(series, 10).every((v) => v === undefined)).toBe(true);
  });
});

describe('macd', () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8];

  it('matches hand-computed values on a small series', () => {
    // ema(2): 1.5 2.5 3.5 4.5 5.5 6.5 7.5   (from idx1)
    // ema(4): 2.5 3.5 4.5 5.5 6.5           (from idx3)
    // macd = fast - slow = 1 everywhere it is defined; signal(2) therefore also 1.
    const { macd: line, signal, histogram } = macd(values, 2, 4, 2);
    expect(line.slice(0, 3).every((v) => v === undefined)).toBe(true);
    for (let i = 3; i < values.length; i += 1) expect(line[i] as number).toBeCloseTo(1, P);
    expect(signal[3]).toBeUndefined();
    for (let i = 4; i < values.length; i += 1) {
      expect(signal[i] as number).toBeCloseTo(1, P);
      expect(histogram[i] as number).toBeCloseTo(0, P);
    }
  });

  it('is exactly fastEma - slowEma on real recorded data', () => {
    const price = closes(fixtureCandles('ETH-USDT-SWAP', '1H'));
    const fast = ema(price, 12);
    const slow = ema(price, 26);
    const { macd: line, signal, histogram } = macd(price, 12, 26, 9);
    for (let i = 0; i < price.length; i += 1) {
      const f = fast[i];
      const s = slow[i];
      if (f === undefined || s === undefined) {
        expect(line[i]).toBeUndefined();
        continue;
      }
      expect(line[i] as number).toBeCloseTo(f - s, P);
      const sig = signal[i];
      if (sig !== undefined) expect(histogram[i] as number).toBeCloseTo((line[i] as number) - sig, P);
    }
  });

  it('refuses a fast period that is not shorter than the slow one', () => {
    expect(() => macd([1, 2, 3], 26, 12, 9)).toThrow(RangeError);
  });
});

describe('bollinger', () => {
  it('matches hand-computed values using POPULATION standard deviation', () => {
    // mean 4; variance ((−2)²+0²+2²)/3 = 8/3; sd = 1.632993...
    const sd = Math.sqrt(8 / 3);
    const { middle, upper, lower, bandwidth } = bollinger([2, 4, 6], 3, 2);
    expect(middle[2] as number).toBeCloseTo(4, P);
    expect(upper[2] as number).toBeCloseTo(4 + 2 * sd, P);
    expect(lower[2] as number).toBeCloseTo(4 - 2 * sd, P);
    expect(bandwidth[2] as number).toBeCloseTo((4 * sd) / 4, P);
  });

  it('keeps the bands ordered and the middle equal to the SMA on real data', () => {
    const price = closes(fixtureCandles('SOL-USDT-SWAP', '15m'));
    const { middle, upper, lower } = bollinger(price, 20, 2);
    const reference = sma(price, 20);
    for (let i = 0; i < price.length; i += 1) {
      const mid = middle[i];
      if (mid === undefined) continue;
      expect(mid).toBeCloseTo(reference[i] as number, P);
      expect(upper[i] as number).toBeGreaterThanOrEqual(mid);
      expect(lower[i] as number).toBeLessThanOrEqual(mid);
    }
  });
});

describe('realisedVolatility', () => {
  it('matches hand-computed values on a series with known log returns', () => {
    // log returns are exactly 1, 2, 3
    const values = [1, Math.E, Math.E ** 3, Math.E ** 6];
    const out = realisedVolatility(values, 2);
    expect(out[0]).toBeUndefined();
    expect(out[1]).toBeUndefined();
    expect(out[2] as number).toBeCloseTo(0.5, P); // sd of [1,2] (population)
    expect(out[3] as number).toBeCloseTo(0.5, P); // sd of [2,3]
  });

  it('annualises by the square root of periods per year', () => {
    const values = [1, Math.E, Math.E ** 3, Math.E ** 6];
    const out = realisedVolatility(values, 2, { periodsPerYear: 4 });
    expect(out[2] as number).toBeCloseTo(1, P); // 0.5 * sqrt(4)
  });

  it('is zero for a perfectly flat series and positive for a real one', () => {
    expect(latest(realisedVolatility([5, 5, 5, 5, 5], 2))).toBeCloseTo(0, P);
    const price = closes(fixtureCandles('BTC-USDT-SWAP', '1H'));
    expect(latest(realisedVolatility(price, 20)) as number).toBeGreaterThan(0);
  });
});

describe('adx', () => {
  it('matches hand-computed values at period 1, where ADX collapses to DX', () => {
    const series = [
      candle(10, 8, 9),
      candle(11, 9, 10), // +DM 1, −DM 0, TR 2  → +DI 50, −DI 0  → DX 100
      candle(10.5, 9.5, 10), // +DM 0, −DM 0, TR 1  → +DI  0, −DI 0  → DX   0
    ];
    const { adx: out, plusDi, minusDi } = adx(series, 1);
    expect(plusDi[1] as number).toBeCloseTo(50, P);
    expect(minusDi[1] as number).toBeCloseTo(0, P);
    expect(out[1] as number).toBeCloseTo(100, P);
    expect(out[2] as number).toBeCloseTo(0, P);
  });

  it('warms up at exactly index 2*period - 1 — two stacked Wilder averages', () => {
    const candles = fixtureCandles('BTC-USDT-SWAP', '1H');
    const { adx: out, plusDi } = adx(candles, 14);
    expect(out[26]).toBeUndefined();
    expect(out[27]).toBeDefined(); // 2*14 - 1
    expect(plusDi[13]).toBeUndefined();
    expect(plusDi[14]).toBeDefined();
  });

  it('keeps ADX and both DIs inside 0..100 on real recorded data', () => {
    for (const inst of ['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP']) {
      const { adx: out, plusDi, minusDi } = adx(fixtureCandles(inst, '15m'), 14);
      for (const series of [out, plusDi, minusDi]) {
        for (const v of series) {
          if (v === undefined) continue;
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(100);
        }
      }
    }
  });

  it('reads a pure uptrend as directional: +DI dominant, −DI zero, ADX maxed', () => {
    const rising: Candle[] = [];
    for (let i = 0; i < 60; i += 1) rising.push(candle(10 + i, 8 + i, 9 + i));
    const { adx: out, plusDi, minusDi } = adx(rising, 14);
    expect(latest(minusDi)).toBeCloseTo(0, P);
    expect(latest(plusDi) as number).toBeGreaterThan(0);
    expect(latest(out) as number).toBeCloseTo(100, 6);
  });
});

describe('latest', () => {
  it('returns the last defined value, or undefined if the series never warmed up', () => {
    expect(latest([undefined, 1, 2, undefined])).toBe(2);
    expect(latest([undefined, undefined])).toBeUndefined();
    expect(latest([])).toBeUndefined();
  });
});

describe('purity', () => {
  it('does not mutate its input', () => {
    const values = [1, 2, 3, 4, 5];
    const snapshot = [...values];
    sma(values, 2);
    ema(values, 2);
    rsi(values, 2);
    bollinger(values, 2);
    realisedVolatility(values, 2);
    macd(values, 2, 3, 2);
    expect(values).toEqual(snapshot);
  });

  it('returns identical output for identical input, every time', () => {
    const candles = fixtureCandles('ETH-USDT-SWAP', '15m');
    const once = JSON.stringify(adx(candles, 14));
    const twice = JSON.stringify(adx(candles, 14));
    expect(once).toBe(twice);
  });
});
