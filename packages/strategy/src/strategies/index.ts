import type { StrategyModule } from '../module.js';

import { breakoutRange, BREAKOUT_RANGE_ID } from './breakout_range.js';
import { fundingSkew, FUNDING_SKEW_ID } from './funding_skew.js';
import { revertBand, REVERT_BAND_ID } from './revert_band.js';
import { oiDivergence, OI_DIVERGENCE_ID } from './oi_divergence.js';
import { trendEma, TREND_EMA_ID } from './trend_ema.js';
import { sessionBias, SESSION_BIAS_ID } from './session_bias.js';
import { isTrendAlignedBreakout, volExpansion, VOL_EXPANSION_ID } from './vol_expansion.js';

/**
 * The four candidates. **No edge is claimed for any of them.** P4's backtest decides which, if
 * any, survive; each is individually enable/disable-able through `config.enabled`.
 */
export const ALL_STRATEGIES: readonly StrategyModule[] = Object.freeze([
  trendEma,
  revertBand,
  breakoutRange,
  volExpansion,
  oiDivergence,
  sessionBias,
  fundingSkew,
]);

export const STRATEGY_IDS = Object.freeze([
  TREND_EMA_ID,
  REVERT_BAND_ID,
  BREAKOUT_RANGE_ID,
  VOL_EXPANSION_ID,
  OI_DIVERGENCE_ID,
  SESSION_BIAS_ID,
  FUNDING_SKEW_ID,
] as const);

export {
  breakoutRange,
  fundingSkew,
  oiDivergence,
  revertBand,
  sessionBias,
  trendEma,
  volExpansion,
  isTrendAlignedBreakout,
  BREAKOUT_RANGE_ID,
  FUNDING_SKEW_ID,
  OI_DIVERGENCE_ID,
  REVERT_BAND_ID,
  SESSION_BIAS_ID,
  TREND_EMA_ID,
  VOL_EXPANSION_ID,
};
export { SURVIVING_HOURS } from './session_bias.js';
export { classifyOiState, TRADED_STATES, type OiState } from './oi_divergence.js';
