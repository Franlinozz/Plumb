import { LOCKED } from '@plumb/core';

/**
 * @plumb/asp — the ASP surface: the published feed, the subscription service, and the public
 * MCP/HTTP endpoints.
 *
 * Guardrail 2 lives here. A signal is written to the published feed BEFORE the executor is
 * permitted to act on it, and the executor reads from this feed rather than from strategy
 * internals — which is what makes the correspondence between our public signals and our actual
 * trades structurally true rather than a claim.
 */
export const ASP_PACKAGE = Object.freeze({
  name: '@plumb/asp',
  /** Writes signals to the feed BEFORE the executor may act (guardrail 2). */
  responsibility: 'publish',
  /** Exactly one, created once, never deleted. There is no delete function in this package. */
  subscriptionServiceCount: 1,
  instruments: LOCKED.INSTRUMENTS,
  /** Pinned by a test: every published performance number is computed from the ledger. */
  trackRecordIsComputed: true,
});

export {
  FeedStore,
  FeedTamperError,
  GENESIS_HASH,
  canonicalise,
  hashEntry,
  type PublishedSignal,
  type TradeOutcome,
  type TradeOutcomeReason,
} from './feed.js';

export {
  buildPrompt,
  containsForeignNumber,
  generateRationale,
  templateRationale,
  type RationaleDeps,
  type RationaleResult,
} from './rationale.js';

export {
  PLUMB_SERVICE,
  SubscriptionDeletionRefused,
  activeSubscribers,
  formatSignalForDelivery,
  planDelivery,
  refuseDeletion,
  type DeliveryPlan,
  type ServiceDefinition,
  type Subscriber,
} from './subscription.js';

export {
  buildTrackRecord,
  caveatFor,
  longestLosingStreak,
  type TrackRecord,
} from './track_record.js';

export { createApp, type ServerDeps } from './http.js';

export {
  TOOL_NAMES,
  TOOL_SPECS,
  callTool,
  type ToolContext,
  type ToolName,
  type ToolResult,
  type ToolSpec,
} from './tools.js';

export {
  PublicationRequiredError,
  publishThenExecute,
  requirePublished,
  type PublishAndExecuteDeps,
} from './publish_gate.js';

export {
  ExecutableSignalRejected,
  formatDecisionEventForDelivery,
  validateV12PerpetualSignal,
  type ExecutableSignalGate,
} from './decision-delivery.js';

export {
  DecisionPublicationStore,
  type DecisionPublication,
  type PublicationStatus,
} from './decision-publication-store.js';

export {
  describeDeliveryCommandFailure,
  exactDeliverableMatches,
  isRetryableDeliveryFailure,
  redactDeliveryDiagnostic,
  requireExplicitDeliverySuccess,
  type DeliverableRecord,
} from './delivery-reconciliation.js';

export {
  acquireDeliveryLock,
  type DeliveryLockOptions,
} from './delivery-lock.js';
