import { LOCKED } from '@plumb/core';

/**
 * @plumb/ops — watchdog, alerting, the daily review, backups and drills.
 *
 * Fourteen days of unattended uptime is a competition requirement and an engineering problem. It
 * is solved here rather than on day three of a live run.
 */
export const OPS_PACKAGE = Object.freeze({
  name: '@plumb/ops',
  responsibility: 'supervise',
  pipeline: Object.freeze([
    '@plumb/market',
    '@plumb/strategy',
    '@plumb/risk',
    '@plumb/asp',
    '@plumb/executor',
  ] as const),
  dailyLossLimitUsdt: LOCKED.DAILY_LOSS_LIMIT_USDT,
  accountingTimezone: 'UTC',
  competitionTimezone: 'UTC+8',
  /** Pinned by a test: the watchdog halts, and has no way to clear a halt. */
  watchdogCanRearm: false,
});

export const PIPELINE = OPS_PACKAGE.pipeline;

export {
  Alerter,
  consoleSink,
  formatAlert,
  webhookSink,
  type Alert,
  type AlertContext,
  type AlerterOptions,
  type AlertSink,
  type Severity,
} from './alerts.js';

export {
  DEFAULT_THRESHOLDS,
  WATCHDOG_CAN_REARM,
  assess,
  runWatchdog,
  type WatchdogAction,
  type WatchdogCondition,
  type WatchdogDeps,
  type WatchdogObservation,
  type WatchdogResult,
  type WatchdogThresholds,
} from './watchdog.js';

export {
  buildReviewPrompt,
  generateReview,
  templateReview,
  type DayLedger,
  type ReviewDeps,
  type ReviewResult,
} from './review.js';

export {
  backup,
  databaseIsReadable,
  pruneBackups,
  restore,
  verifyRestore,
  type BackupManifest,
  type BackupResult,
  type BackupTarget,
  type RestoreResult,
  type RestoreVerification,
} from './snapshot.js';

export { Heartbeat, type HeartbeatOptions, type HeartbeatState } from './heartbeat.js';

export {
  CompetitionDecisionRejected,
  FROZEN_COMPETITION_CONFIG_HASH,
  competitionConfigHash,
  createCompetitionDecision,
  signCompetitionHoldoutEvidence,
  verifyCompetitionHoldoutEvidence,
  type CompetitionCostEstimate,
  type CompetitionDecisionInput,
  type CompetitionDecisionState,
  type CompetitionEvidence,
  type CompetitionHoldoutEvidence,
} from './competition-decision.js';

export {
  createEmergencyParticipationDecision,
  type EmergencyParticipationInput,
  type EmergencyParticipationMetadata,
} from './emergency-participation-decision.js';

export {
  createSecondEntryDecision,
  type SecondEntryInput,
  type SecondEntryMetadata,
} from './second-entry-decision.js';
