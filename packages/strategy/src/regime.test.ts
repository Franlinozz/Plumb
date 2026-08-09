import { fixtureCandles } from '@plumb/market';
import { describe, expect, it } from 'vitest';

import { classifyRegime } from './regime.js';
import { median, percentileRank } from './stats.js';
import { REGIME_SPECS, snapshotOf, syntheticCandles } from './testkit.js';
import { DEFAULT_STRATEGY_CONFIG } from './types.js';

function classify(specName: keyof typeof REGIME_SPECS) {
  return classifyRegime(snapshotOf(syntheticCandles(REGIME_SPECS[specName])), '1H');
}

describe('regime classification', () => {
  it('labels a trending-up market', () => {
    const r = classify('trending_up');
    expect(r.label).toBe('trending_up');
    expect(r.confidence).toBeGreaterThan(0.5);
    expect(r.inputs['plusDi'] as number).toBeGreaterThan(r.inputs['minusDi'] as number);
  });

  it('labels a trending-down market', () => {
    const r = classify('trending_down');
    expect(r.label).toBe('trending_down');
    expect(r.inputs['minusDi'] as number).toBeGreaterThan(r.inputs['plusDi'] as number);
  });

  it('labels a ranging market', () => {
    const r = classify('ranging');
    expect(r.label).toBe('ranging');
    expect(r.inputs['adx'] as number).toBeLessThan(DEFAULT_STRATEGY_CONFIG.regime.rangeAdxMax);
  });

  it('labels a compressed market', () => {
    const r = classify('compressed');
    expect(r.label).toBe('compressed');
    expect(r.inputs['bandwidthPercentile'] as number).toBeLessThanOrEqual(
      DEFAULT_STRATEGY_CONFIG.regime.compressedPercentile,
    );
  });

  it('labels an expanding market', () => {
    const r = classify('expanding');
    expect(r.label).toBe('expanding');
    expect(r.inputs['atrRatio'] as number).toBeGreaterThan(1);
  });

  it('returns UNCLEAR for a genuinely ambiguous market rather than rounding to the nearer label', () => {
    const r = classify('unclear');
    expect(r.label).toBe('unclear');
    expect(r.confidence).toBe(0);
    // The dead zone: too trendy to fade, not trendy enough to follow.
    const adx = r.inputs['adx'] as number;
    expect(adx).toBeGreaterThanOrEqual(DEFAULT_STRATEGY_CONFIG.regime.rangeAdxMax);
    expect(adx).toBeLessThan(DEFAULT_STRATEGY_CONFIG.regime.trendAdxMin);
    expect(r.reasons.join(' ')).toContain('sits between');
  });

  it('returns unclear when there is not enough history, with a reason', () => {
    const short = syntheticCandles({ ...REGIME_SPECS.ranging, bars: 30 });
    const r = classifyRegime(snapshotOf(short), '1H');
    expect(r.label).toBe('unclear');
    expect(r.confidence).toBe(0);
    expect(r.reasons[0]).toContain('insufficient history');
  });

  it('returns unclear for a timeframe the snapshot does not carry', () => {
    const r = classifyRegime(snapshotOf(syntheticCandles(REGIME_SPECS.ranging)), '4H');
    expect(r.label).toBe('unclear');
  });

  it('reports every input it used, all finite', () => {
    const r = classify('trending_up');
    for (const key of ['adx', 'plusDi', 'minusDi', 'atrPct', 'atrRatio', 'bandwidth', 'bandwidthPercentile', 'realisedVol', 'volPercentile']) {
      expect(Number.isFinite(r.inputs[key])).toBe(true);
    }
  });

  it('keeps confidence inside 0..1 on real recorded market data', () => {
    for (const inst of ['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP'] as const) {
      const snapshot = snapshotOf(fixtureCandles(inst, '1H'), { instId: inst });
      const r = classifyRegime(snapshot, '1H');
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
      expect(['trending_up', 'trending_down', 'ranging', 'expanding', 'compressed', 'unclear']).toContain(r.label);
    }
  });

  it('is deterministic — same candles in, identical assessment out', () => {
    const snapshot = snapshotOf(syntheticCandles(REGIME_SPECS.ranging));
    expect(JSON.stringify(classifyRegime(snapshot, '1H'))).toBe(
      JSON.stringify(classifyRegime(snapshot, '1H')),
    );
  });
});

describe('a model hint may corroborate, never override', () => {
  const snapshot = snapshotOf(syntheticCandles(REGIME_SPECS.trending_up));

  it('leaves the assessment untouched when it agrees', () => {
    const plain = classifyRegime(snapshot, '1H');
    const hinted = classifyRegime(snapshot, '1H', DEFAULT_STRATEGY_CONFIG.regime, {
      label: 'trending_up',
      confidence: 0.9,
      source: 'test',
    });
    expect(hinted.label).toBe(plain.label);
    expect(hinted.confidence).toBe(plain.confidence);
  });

  it('lowers confidence but NEVER changes the label when it disagrees', () => {
    const plain = classifyRegime(snapshot, '1H');
    const hinted = classifyRegime(snapshot, '1H', DEFAULT_STRATEGY_CONFIG.regime, {
      label: 'ranging',
      confidence: 1,
      source: 'test',
    });
    expect(hinted.label).toBe(plain.label);
    expect(hinted.confidence).toBeLessThan(plain.confidence);
    expect(hinted.reasons.join(' ')).toContain('label unchanged');
  });

  it('cannot raise confidence, however sure it claims to be', () => {
    const plain = classifyRegime(snapshot, '1H');
    for (const confidence of [0, 0.5, 1, 99]) {
      const hinted = classifyRegime(snapshot, '1H', DEFAULT_STRATEGY_CONFIG.regime, {
        label: 'compressed',
        confidence,
        source: 'test',
      });
      expect(hinted.confidence).toBeLessThanOrEqual(plain.confidence);
    }
  });
});

describe('percentile ranking handles ties', () => {
  it('scores a perfectly flat history at the middle, not the top', () => {
    // The naive at-or-below form returns 1.0 here, which would read a dead-quiet market as
    // the most volatile it has ever been.
    expect(percentileRank(5, [5, 5, 5, 5])).toBeCloseTo(0.5, 12);
  });

  it('scores extremes at the extremes', () => {
    expect(percentileRank(10, [1, 2, 3])).toBe(1);
    expect(percentileRank(0, [1, 2, 3])).toBe(0);
    expect(percentileRank(2, [1, 2, 3])).toBeCloseTo(0.5, 12);
  });

  it('returns undefined for an empty history rather than a made-up number', () => {
    expect(percentileRank(1, [])).toBeUndefined();
    expect(median([])).toBeUndefined();
  });
});
