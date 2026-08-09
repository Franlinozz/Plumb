import type { StrategyModule } from '../module.js';

import { breakoutRange, BREAKOUT_RANGE_ID } from './breakout_range.js';
import { fundingSkew, FUNDING_SKEW_ID } from './funding_skew.js';
import { revertBand, REVERT_BAND_ID } from './revert_band.js';
import { trendEma, TREND_EMA_ID } from './trend_ema.js';

/**
 * The four candidates. **No edge is claimed for any of them.** P4's backtest decides which, if
 * any, survive; each is individually enable/disable-able through `config.enabled`.
 */
export const ALL_STRATEGIES: readonly StrategyModule[] = Object.freeze([
  trendEma,
  revertBand,
  breakoutRange,
  fundingSkew,
]);

export const STRATEGY_IDS = Object.freeze([
  TREND_EMA_ID,
  REVERT_BAND_ID,
  BREAKOUT_RANGE_ID,
  FUNDING_SKEW_ID,
] as const);

export {
  breakoutRange,
  fundingSkew,
  revertBand,
  trendEma,
  BREAKOUT_RANGE_ID,
  FUNDING_SKEW_ID,
  REVERT_BAND_ID,
  TREND_EMA_ID,
};
