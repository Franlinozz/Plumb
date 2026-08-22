import type { StrategyModule } from '../module.js';

import { breakoutRange, BREAKOUT_RANGE_ID } from './breakout_range.js';
import { fundingSkew, FUNDING_SKEW_ID } from './funding_skew.js';
import { revertBand, REVERT_BAND_ID } from './revert_band.js';
import { oiDivergence, OI_DIVERGENCE_ID } from './oi_divergence.js';
import { trendEma, TREND_EMA_ID } from './trend_ema.js';
import { sessionBias, SESSION_BIAS_ID } from './session_bias.js';
import { isTrendAlignedBreakout, volExpansion, VOL_EXPANSION_ID } from './vol_expansion.js';
import {
  aggregateClosedFourHour,
  classifyFourHourTrend,
  competitionTrendPullback,
  COMPETITION_TREND_PULLBACK_ID,
} from './competition_trend_pullback.js';
import {
  emergencyParticipation,
  EMERGENCY_PARTICIPATION_ID,
} from './emergency_participation.js';
import {
  aggregateClosedOneHour,
  competitionIntradayContinuation,
  createCompetitionIntradayContinuation,
  COMPETITION_INTRADAY_CONTINUATION_ID,
  COMPETITION_INTRADAY_CONTINUATION_SETTINGS,
  type CompetitionIntradayContinuationSettings,
} from './competition_intraday_continuation.js';
import {
  competitionTrendContinuation,
  createCompetitionTrendContinuation,
  COMPETITION_TREND_CONTINUATION_ID,
  COMPETITION_TREND_CONTINUATION_SETTINGS,
  type CompetitionTrendContinuationSettings,
} from './competition_trend_continuation.js';
import {
  competitionTrendReclaim,
  createCompetitionTrendReclaim,
  COMPETITION_TREND_RECLAIM_ID,
  COMPETITION_TREND_RECLAIM_SETTINGS,
  type CompetitionTrendReclaimSettings,
} from './competition_trend_reclaim.js';

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
  competitionTrendPullback,
  aggregateClosedFourHour,
  classifyFourHourTrend,
  COMPETITION_TREND_PULLBACK_ID,
  emergencyParticipation,
  EMERGENCY_PARTICIPATION_ID,
  aggregateClosedOneHour,
  competitionIntradayContinuation,
  createCompetitionIntradayContinuation,
  COMPETITION_INTRADAY_CONTINUATION_ID,
  COMPETITION_INTRADAY_CONTINUATION_SETTINGS,
  type CompetitionIntradayContinuationSettings,
  competitionTrendContinuation,
  createCompetitionTrendContinuation,
  COMPETITION_TREND_CONTINUATION_ID,
  COMPETITION_TREND_CONTINUATION_SETTINGS,
  type CompetitionTrendContinuationSettings,
  competitionTrendReclaim,
  createCompetitionTrendReclaim,
  COMPETITION_TREND_RECLAIM_ID,
  COMPETITION_TREND_RECLAIM_SETTINGS,
  type CompetitionTrendReclaimSettings,
};
export { SURVIVING_HOURS } from './session_bias.js';
export { classifyOiState, TRADED_STATES, type OiState } from './oi_divergence.js';
