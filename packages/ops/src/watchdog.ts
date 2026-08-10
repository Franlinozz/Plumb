/**
 * THE WATCHDOG — an independent process that watches the runner.
 *
 * ┌────────────────────────────────────────────────────────────────────────────────────────────┐
 * │ THE WATCHDOG CAN HALT. IT CAN NEVER RE-ARM.                                                 │
 * │                                                                                             │
 * │ Only the operator re-arms, through `rearm` with the admin token. A watchdog that could      │
 * │ clear its own halt would eventually clear one it should not have.                           │
 * └────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * The dangerous state it exists for is a FROZEN RUNNER WITH OPEN POSITIONS: nothing is managing
 * the stops, nothing is reconciling, and from the outside everything looks quiet.
 */

import type { Alerter, AlertContext, Severity } from './alerts.js';

export type WatchdogCondition =
  | 'runner_stalled'
  | 'data_stale'
  | 'venue_unreachable'
  | 'reconcile_mismatch'
  | 'near_kill_switch';

export interface WatchdogThresholds {
  /** No completed cycle within this → the runner is stalled. */
  readonly maxCycleGapMs: number;
  /** Market data older than this → `dataStale`. */
  readonly maxDataAgeMs: number;
  /** Consecutive venue failures before halting. */
  readonly maxVenueFailures: number;
  /** Equity within this fraction of the kill switch → urgent. */
  readonly killSwitchProximity: number;
}

export const DEFAULT_THRESHOLDS: WatchdogThresholds = Object.freeze({
  maxCycleGapMs: 15 * 60_000,
  maxDataAgeMs: 10 * 60_000,
  maxVenueFailures: 5,
  killSwitchProximity: 0.05,
});

export interface WatchdogObservation {
  readonly now: number;
  readonly lastCycleAt: number | undefined;
  readonly lastDataAt: number | undefined;
  readonly consecutiveVenueFailures: number;
  readonly reconcileMismatch: boolean;
  readonly equityUsdt: number;
  readonly killSwitchEquityUsdt: number;
  readonly openPositions: number;
  readonly haltFlags: Readonly<Record<string, boolean>>;
  readonly mode: string;
}

export interface WatchdogAction {
  readonly condition: WatchdogCondition;
  readonly severity: Severity;
  readonly title: string;
  readonly detail: string;
  /** Which halt flag to set. `undefined` means alert only. */
  readonly haltFlag: 'dataStale' | 'manual' | 'reconcileMismatch' | undefined;
  /** True when open positions must be closed as well as trading stopped. */
  readonly flatten: boolean;
}

/**
 * Assess. Pure — it decides, it does not act, so every branch is testable without a venue.
 *
 * Returns every condition that currently holds, most severe first, because two things can be
 * wrong at once and reporting only the first hides the second.
 */
export function assess(
  observation: WatchdogObservation,
  thresholds: WatchdogThresholds = DEFAULT_THRESHOLDS,
): readonly WatchdogAction[] {
  const actions: WatchdogAction[] = [];

  // ── A frozen runner holding positions is the dangerous state. ────────────────────────────
  if (observation.lastCycleAt !== undefined) {
    const gap = observation.now - observation.lastCycleAt;
    if (gap > thresholds.maxCycleGapMs) {
      actions.push({
        condition: 'runner_stalled',
        severity: observation.openPositions > 0 ? 'CRITICAL' : 'URGENT',
        title: 'runner stalled',
        detail:
          `no cycle completed for ${Math.round(gap / 60_000)} minutes (threshold ` +
          `${Math.round(thresholds.maxCycleGapMs / 60_000)}). ` +
          (observation.openPositions > 0
            ? 'POSITIONS ARE OPEN and nothing is managing them.'
            : 'No positions are open.'),
        haltFlag: 'manual',
        flatten: observation.openPositions > 0,
      });
    }
  }

  // ── Stale data must never look like a quiet market. ──────────────────────────────────────
  if (observation.lastDataAt !== undefined) {
    const age = observation.now - observation.lastDataAt;
    if (age > thresholds.maxDataAgeMs) {
      actions.push({
        condition: 'data_stale',
        severity: observation.openPositions > 0 ? 'URGENT' : 'WARN',
        title: 'market data stale',
        detail: `market data is ${Math.round(age / 60_000)} minutes old (threshold ${Math.round(thresholds.maxDataAgeMs / 60_000)}).`,
        haltFlag: 'dataStale',
        flatten: observation.openPositions > 0,
      });
    }
  }

  if (observation.consecutiveVenueFailures >= thresholds.maxVenueFailures) {
    actions.push({
      condition: 'venue_unreachable',
      severity: observation.openPositions > 0 ? 'CRITICAL' : 'URGENT',
      title: 'venue unreachable',
      detail:
        `${observation.consecutiveVenueFailures} consecutive venue failures. ` +
        (observation.openPositions > 0 ? 'POSITIONS ARE OPEN and cannot be managed.' : ''),
      haltFlag: 'manual',
      // Deliberately NOT flatten: if the venue is unreachable, a close order cannot be placed
      // either. Halting stops new risk; the operator handles the open book.
      flatten: false,
    });
  }

  if (observation.reconcileMismatch) {
    actions.push({
      condition: 'reconcile_mismatch',
      severity: 'CRITICAL',
      title: 'reconciliation mismatch',
      detail:
        'the venue and the ledger disagree. Trading is already halted by the executor; this is ' +
        'the escalation. Every fill must trace to a published signal and one does not.',
      haltFlag: 'reconcileMismatch',
      flatten: true,
    });
  }

  // ── Proximity to the floor. Alert only — the governor owns the switch itself. ────────────
  const distance = observation.equityUsdt - observation.killSwitchEquityUsdt;
  const band = observation.killSwitchEquityUsdt * thresholds.killSwitchProximity;
  if (distance > 0 && distance <= band) {
    actions.push({
      condition: 'near_kill_switch',
      severity: 'URGENT',
      title: 'equity approaching the kill switch',
      detail:
        `equity ${observation.equityUsdt.toFixed(2)} is ${distance.toFixed(2)} USDT above the ` +
        `${observation.killSwitchEquityUsdt} floor.`,
      haltFlag: undefined,
      flatten: false,
    });
  }

  const order: Record<Severity, number> = { CRITICAL: 0, URGENT: 1, WARN: 2, INFO: 3 };
  return actions.sort((a, b) => order[a.severity] - order[b.severity]);
}

export interface WatchdogDeps {
  readonly alerter: Alerter;
  /** Sets a halt flag. The watchdog has no way to CLEAR one. */
  readonly halt: (flag: NonNullable<WatchdogAction['haltFlag']>, reason: string) => Promise<void> | void;
  readonly flatten: (reason: string) => Promise<void> | void;
  readonly thresholds?: WatchdogThresholds;
}

export interface WatchdogResult {
  readonly actions: readonly WatchdogAction[];
  readonly halted: readonly string[];
  readonly flattened: boolean;
}

/** Run one watchdog pass. */
export async function runWatchdog(
  observation: WatchdogObservation,
  deps: WatchdogDeps,
): Promise<WatchdogResult> {
  const actions = assess(observation, deps.thresholds);
  const context: AlertContext = {
    equityUsdt: observation.equityUsdt,
    openPositions: observation.openPositions,
    haltFlags: observation.haltFlags,
    mode: observation.mode,
  };

  const halted: string[] = [];
  let flattened = false;

  for (const action of actions) {
    await deps.alerter.raise(action.severity, action.condition, action.title, action.detail, context);
    if (action.haltFlag !== undefined) {
      await deps.halt(action.haltFlag, `watchdog: ${action.title}`);
      halted.push(action.haltFlag);
    }
    if (action.flatten && !flattened) {
      await deps.flatten(`watchdog: ${action.title}`);
      flattened = true;
    }
  }

  return { actions, halted, flattened };
}

/**
 * There is no re-arm here, and this is the proof.
 *
 * Exported so a test can assert the watchdog module exposes no way to clear a halt. If someone
 * adds one, the test that reads this package's exports fails.
 */
export const WATCHDOG_CAN_REARM = false;
