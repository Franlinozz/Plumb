/**
 * DETERMINISTIC regime classification. No model is consulted, here or ever.
 *
 * The classifier reads four things, all computed locally from the snapshot's candles:
 *   - ADX and the ±DI pair       — is there a trend, and which way
 *   - ATR% against its own trailing median — is volatility unusual FOR THIS INSTRUMENT
 *   - Bollinger bandwidth percentile — is the range compressed or expanded
 *   - realised volatility percentile — corroboration for the above
 *
 * Absolute thresholds are avoided wherever a reading can be ranked against its own history: "ATR
 * is 0.4%" means nothing without knowing whether that is high for SOL. "ATR is at its 92nd
 * percentile" means something.
 *
 * **`unclear` is a first-class answer.** There is a deliberate dead zone between the ranging
 * ceiling and the trending floor, and readings that land in it are reported as unclear rather
 * than rounded to the nearer label. Unclear suppresses signals downstream.
 */

import {
  adx as computeAdx,
  atr as computeAtr,
  bollinger,
  closes,
  latest,
  realisedVolatility,
  seriesFor,
  type MarketSnapshot,
  type Timeframe,
} from '@plumb/market';

import { clamp01, defined, median, percentileRank, tail } from './stats.js';
import {
  DEFAULT_STRATEGY_CONFIG,
  type RegimeAssessment,
  type RegimeConfig,
  type RegimeHint,
} from './types.js';

const UNCLEAR = (timeframe: Timeframe, reason: string): RegimeAssessment =>
  Object.freeze({
    label: 'unclear' as const,
    confidence: 0,
    timeframe,
    inputs: Object.freeze({}),
    reasons: Object.freeze([reason]),
  });

export function classifyRegime(
  snapshot: MarketSnapshot,
  timeframe: Timeframe,
  config: RegimeConfig = DEFAULT_STRATEGY_CONFIG.regime,
  hint?: RegimeHint,
): RegimeAssessment {
  const candles = seriesFor(snapshot, timeframe);
  if (candles === undefined || candles.length < 60) {
    return UNCLEAR(timeframe, 'insufficient history for a regime call');
  }

  const price = closes(candles);
  const directional = computeAdx(candles, 14);
  const adxValue = latest(directional.adx);
  const plusDi = latest(directional.plusDi);
  const minusDi = latest(directional.minusDi);

  const atrSeries = computeAtr(candles, 14);
  const atrValue = latest(atrSeries);
  const lastClose = price[price.length - 1];

  const bandwidth = bollinger(price, 20, 2).bandwidth;
  const bandwidthValue = latest(bandwidth);
  const volSeries = realisedVolatility(price, 20);
  const volValue = latest(volSeries);

  if (
    adxValue === undefined ||
    plusDi === undefined ||
    minusDi === undefined ||
    atrValue === undefined ||
    bandwidthValue === undefined ||
    volValue === undefined ||
    lastClose === undefined ||
    lastClose <= 0
  ) {
    return UNCLEAR(timeframe, 'one or more indicators had not warmed up');
  }

  // ATR as a fraction of price, ranked against its own recent median.
  const atrPctSeries: number[] = [];
  for (let i = 0; i < candles.length; i += 1) {
    const a = atrSeries[i];
    const c = price[i];
    if (a !== undefined && c !== undefined && c > 0) atrPctSeries.push(a / c);
  }
  const atrPct = atrValue / lastClose;
  const atrMedian = median(tail(atrPctSeries, config.percentileWindow));
  const atrRatio = atrMedian === undefined || atrMedian === 0 ? 1 : atrPct / atrMedian;

  const bandwidthPercentile =
    percentileRank(bandwidthValue, tail(defined(bandwidth), config.percentileWindow)) ?? 0.5;
  const volPercentile =
    percentileRank(volValue, tail(defined(volSeries), config.percentileWindow)) ?? 0.5;

  const inputs = Object.freeze({
    adx: adxValue,
    plusDi,
    minusDi,
    atrPct,
    atrRatio,
    bandwidth: bandwidthValue,
    bandwidthPercentile,
    realisedVol: volValue,
    volPercentile,
  });

  const diTotal = plusDi + minusDi;
  const diSpread = diTotal === 0 ? 0 : Math.abs(plusDi - minusDi) / diTotal;
  const adxStrength = clamp01((adxValue - config.trendAdxMin) / config.trendAdxMin);

  const assess = (
    label: RegimeAssessment['label'],
    confidence: number,
    reasons: readonly string[],
  ): RegimeAssessment =>
    finalise({ label, confidence: clamp01(confidence), timeframe, inputs, reasons }, hint);

  // --- trending -------------------------------------------------------------
  if (adxValue >= config.trendAdxMin && plusDi !== minusDi) {
    const up = plusDi > minusDi;
    return assess(
      up ? 'trending_up' : 'trending_down',
      0.5 * adxStrength + 0.5 * diSpread,
      [
        `ADX ${adxValue.toFixed(1)} >= ${config.trendAdxMin}`,
        `${up ? '+DI' : '-DI'} dominant (${plusDi.toFixed(1)} vs ${minusDi.toFixed(1)})`,
      ],
    );
  }

  // --- compressed -----------------------------------------------------------
  if (bandwidthPercentile <= config.compressedPercentile && adxValue < config.rangeAdxMax) {
    return assess(
      'compressed',
      (config.compressedPercentile - bandwidthPercentile) / config.compressedPercentile,
      [
        `bandwidth at ${(bandwidthPercentile * 100).toFixed(0)}th percentile`,
        `ADX ${adxValue.toFixed(1)} < ${config.rangeAdxMax}`,
      ],
    );
  }

  // --- expanding ------------------------------------------------------------
  if (atrRatio >= config.expansionAtrRatio || bandwidthPercentile >= config.expandedPercentile) {
    const byAtr = (atrRatio - config.expansionAtrRatio) / config.expansionAtrRatio;
    const byBand =
      (bandwidthPercentile - config.expandedPercentile) / (1 - config.expandedPercentile);
    return assess('expanding', Math.max(clamp01(byAtr), clamp01(byBand), 0.4), [
      `ATR ${atrRatio.toFixed(2)}x its trailing median`,
      `bandwidth at ${(bandwidthPercentile * 100).toFixed(0)}th percentile`,
    ]);
  }

  // --- ranging --------------------------------------------------------------
  if (adxValue < config.rangeAdxMax) {
    return assess('ranging', (config.rangeAdxMax - adxValue) / config.rangeAdxMax, [
      `ADX ${adxValue.toFixed(1)} < ${config.rangeAdxMax}`,
      `volatility unremarkable (${(volPercentile * 100).toFixed(0)}th percentile)`,
    ]);
  }

  // --- the dead zone --------------------------------------------------------
  // ADX between the ranging ceiling and the trending floor. Not trending enough to follow, not
  // quiet enough to fade. Rounding this to the nearer label would be inventing a view.
  return finalise(
    {
      label: 'unclear',
      confidence: 0,
      timeframe,
      inputs,
      reasons: [
        `ADX ${adxValue.toFixed(1)} sits between ${config.rangeAdxMax} and ${config.trendAdxMin}`,
        'no compression or expansion to break the tie',
      ],
    },
    hint,
  );
}

/**
 * Apply an optional model hint.
 *
 * A hint may only REDUCE confidence when it disagrees. It cannot change the label, cannot raise
 * confidence, and cannot introduce a number of its own (guardrail 4). Nothing calls this with a
 * hint in this phase; the parameter exists so that when a DeepSeek label is added it is added as
 * corroboration rather than as an authority.
 */
function finalise(
  assessment: {
    label: RegimeAssessment['label'];
    confidence: number;
    timeframe: Timeframe;
    inputs: Readonly<Record<string, number>>;
    reasons: readonly string[];
  },
  hint?: RegimeHint,
): RegimeAssessment {
  if (hint === undefined || hint.label === assessment.label) {
    return Object.freeze({ ...assessment, reasons: Object.freeze([...assessment.reasons]) });
  }
  const penalty = 1 - clamp01(hint.confidence) * 0.5;
  return Object.freeze({
    ...assessment,
    confidence: clamp01(assessment.confidence * penalty),
    reasons: Object.freeze([
      ...assessment.reasons,
      `hint from ${hint.source} disagreed (${hint.label}) — confidence reduced, label unchanged`,
    ]),
  });
}
