/**
 * Regime labels live in core because they appear on a `Signal`, and a `Signal` is a domain type
 * that `strategy`, `risk`, `asp`, `executor` and `backtest` all read.
 *
 * The classifier that PRODUCES a label lives in `@plumb/strategy`. Only the vocabulary is here.
 */
export const REGIME_LABELS = Object.freeze([
  'trending_up',
  'trending_down',
  'ranging',
  'expanding',
  'compressed',
  'unclear',
] as const);

export type RegimeLabel = (typeof REGIME_LABELS)[number];
