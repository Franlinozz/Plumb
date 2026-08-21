/**
 * @plumb/core — the locked competition parameters and the primitives every other
 * package shares. Nothing here reaches the network, reads the clock, or touches disk.
 */

export {
  INSTRUMENTS,
  LOCKED,
  DERIVED,
  isInstrument,
  canonicalLocked,
  type Instrument,
  type AccountingBasis,
  type Locked,
} from './locked.js';

export {
  COMPETITION_UTC_OFFSET_MINUTES,
  utc8ToUtcMs,
  utcMsToUtc8Parts,
  utcDayStartMs,
  utcDayKey,
  isSameUtcDay,
  toUtcIso,
  utcDayOfWeek,
  utcHourOf,
} from './time.js';

export { REGIME_LABELS, type RegimeLabel } from './regime-labels.js';
export { SIGNAL_TIMEFRAMES, type SignalTimeframe } from './timeframes.js';

export {
  SignalSchema,
  SignalSizingLeakError,
  FORBIDDEN_SIGNAL_FIELDS,
  assertNoSizing,
  parseSignal,
  stopDistancePct,
  stopIsOnCorrectSide,
  takeProfitLevels,
  type Signal,
  type SignalDraft,
} from './signal.js';

export {
  createEntropyIdFactory,
  createSeededIdFactory,
  type SignalIdFactory,
} from './ids.js';

export {
  signEligibility,
  verifyEligibility,
  type EligibilityCriterion,
  type EligibilitySummary,
} from './eligibility.js';

export {
  DecisionEventSchema,
  DecisionEventRejected,
  MIN_EXPECTED_EDGE_COST_MULTIPLE,
  decisionPositionsReconciled,
  finalizeDecisionEvent,
  type DecisionEvent,
} from './decision-event.js';

export {
  COMPETITION_V2_AMENDMENT,
  EMERGENCY_PARTICIPATION_AMENDMENT,
  SECOND_ENTRY_AMENDMENT,
} from './competition-amendment.js';
