import { DERIVED, LOCKED } from '@plumb/core';

/**
 * @plumb/risk — the component that decides whether money moves.
 *
 * Deterministic, persisted, and with no model anywhere near it. Everything else in the repo can
 * be rebuilt; this is what prevents a 400 USDT account becoming a 0 USDT account.
 */
export const RISK_PACKAGE = Object.freeze({
  name: '@plumb/risk',
  /** May veto any signal. Never creates one. */
  responsibility: 'veto',
  /** Every arithmetic input is a locked parameter, never a model output. */
  limits: LOCKED,
  /** Flat everything, halt permanently, require a manual re-arm. */
  killSwitchEquityUsdt: DERIVED.killSwitchEquityUsdt,
  /** Guardrail 6 — counters survive a restart. */
  statePersisted: true,
  /** Pinned by a test that reads this package's own source. */
  usesModel: false,
});

export type RiskVerdict = 'approved' | 'vetoed';

export {
  DEFAULT_RISK_CONFIG,
  DERIVED,
  LOCKED,
  assertLockedParameters,
  type RiskConfig,
} from './params.js';

export {
  estimateFundingCost,
  sizePosition,
  type SizingInput,
  type SizingOutcome,
  type SizingRejection,
  type SizingRejectionCode,
  type SizingResult,
} from './sizing.js';

export {
  GovernorStore,
  HALT_FLAGS,
  anyHaltSet,
  initialState,
  rollDailyIfNeeded,
  withHalt,
  type AuditRecord,
  type GovernorState,
  type HaltFlag,
  type OpenPosition,
} from './state.js';

export {
  LADDER,
  assessDrawdown,
  updatePeak,
  type DrawdownAssessment,
  type DrawdownRung,
} from './drawdown.js';

export {
  createGovernor,
  evaluate,
  type Approval,
  type GovernorOptions,
  type RiskSnapshot,
  type Verdict,
  type Veto,
  type VetoCode,
} from './governor.js';

export {
  closeIntentFor,
  coveredBy,
  flatten,
  type CloseIntent,
  type FlattenReason,
  type FlattenResult,
} from './flatten.js';

export {
  rearm,
  type RearmFailure,
  type RearmFailureCode,
  type RearmOutcome,
  type RearmRequest,
  type RearmSuccess,
} from './rearm.js';

export {
  expectedFloor,
  simulateHostile,
  type SimCandle,
  type SimOptions,
  type SimResult,
  type SimTrade,
} from './simulate.js';

