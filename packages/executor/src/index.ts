import { LOCKED } from '@plumb/core';

/**
 * @plumb/executor — the only component that places orders.
 *
 * Guardrail 2: it reads approved signals from the PUBLISHED feed (`@plumb/asp`), never from
 * strategy internals — which is what makes a fill provably signal-derived when audited.
 * Guardrail 3: every position has a stop before it opens; a naked position never survives a cycle.
 * Guardrail 5: every fill must match a signal id, and an unmatched fill halts trading.
 * Guardrail 10: **DEMO MODE ONLY** in this phase — live credentials are not used until P9.
 */
export const EXECUTOR_PACKAGE = Object.freeze({
  name: '@plumb/executor',
  responsibility: 'execute',
  readsFrom: '@plumb/asp',
  requiresVerdict: 'approved',
  requiresStopBeforeOpen: true,
  haltsOnUnmatchedFill: true,
  vetoedBy: '@plumb/risk',
  accountingBasis: LOCKED.ACCOUNTING_BASIS,
  /** Pinned by a test: this phase cannot construct a live client. */
  demoOnly: true,
});

export {
  AtkError,
  COMPETITION_BIN,
  DEFAULT_BIN,
  DEFAULT_RETRY,
  assertDemo,
  classifyError,
  withRetry,
  type AtkClient,
  type AtkErrorKind,
  type CliClientOptions,
  type OrderRef,
  type PlaceOrderRequest,
  type RetryPolicy,
  type VenueBalance,
  type VenueFill,
  type VenueOrder,
  type VenuePosition,
} from './atk.js';

export {
  matchesSignal,
  resolveSignalId,
  toCloseClOrdId,
  toClOrdId,
} from './clord.js';

export {
  IntentStore,
  type IntentStatus,
  type LedgerEntry,
  type OrderIntent,
} from './idempotency.js';

export {
  NakedPositionError,
  entrySide,
  placeBracket,
  type BracketDeps,
  type BracketRequest,
  type BracketResult,
} from './bracket.js';

export {
  fillsBySignal,
  reconcile,
  recoverPendingIntents,
  type ReconcileInput,
  type ReconcileIssue,
  type ReconcileIssueKind,
  type ReconcileResult,
  type RecordedPosition,
} from './reconcile.js';

export {
  DEFAULT_LIFECYCLE,
  StopRegressionError,
  currentR,
  isTighter,
  manage,
  tightenStop,
  type LifecycleAction,
  type LifecycleActionKind,
  type LifecycleConfig,
  type LifecycleInput,
  type ManagedPosition,
} from './lifecycle.js';

export {
  CycleRunner,
  NotEligibleError,
  assertEligible,
  type CycleOutcome,
  type CycleReport,
  type RunnerDeps,
} from './runner.js';

export { MockAtk, type MockFaults } from './mock.js';

export { CliAtkClient } from './cli.js';

export {
  DemoOverrideRefused,
  assertEligibleOrDemo,
  demoOverrideApplies,
  type OverrideContext,
} from './demo-override.js';

export {
  AgentTradeKitCompetitionExecutor,
  CompetitionExecutionRejected,
  type CompetitionExecutionInput,
  type CompetitionExecutionResult,
  type CompetitionExecutorDeps,
  type CompetitionFeeRates,
  type CompetitionInstrumentMetadata,
  type CompetitionPublicationProof,
  type CompetitionRiskState,
  type CompetitionVenue,
} from './competition.js';

export {
  CompetitionLedgerStore,
  type CompetitionLedgerPosition,
} from './competition-ledger.js';

export {
  CompetitionTimeStopExecutor,
  type CompetitionTimeStopDeps,
  type CompetitionTimeStopResult,
} from './competition-time-stop.js';
