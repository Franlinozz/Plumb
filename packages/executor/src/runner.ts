/**
 * THE CYCLE LOOP — single-threaded and serialised.
 *
 *   load state → snapshot → isTradeable? → strategy → gate → portfolio → governor →
 *   publish (P6 hook, no-op here) → execute approved → reconcile → persist → sleep
 *
 * **A cycle never overlaps itself.** If one overruns, the next is SKIPPED and logged, never
 * queued: two cycles running against the same book would each size against a position the other
 * had already taken.
 *
 * The executor also refuses to run a strategy configuration without a PASSING eligibility record
 * from `@plumb/backtest` — verified by signature, so a hand-edited `"eligible": true` does not
 * work (guardrail: nothing trades on evidence that was not produced).
 */

import { verifyEligibility, type EligibilitySummary } from '@plumb/core';

import type { AtkClient } from './atk.js';
import type { IntentStore } from './idempotency.js';

export class NotEligibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotEligibleError';
  }
}

/**
 * The lock the backtest gate installs.
 *
 * Called before the loop starts. A missing record, a failing record, or a record whose signature
 * does not verify all refuse equally — an unverifiable pass is not a pass.
 */
export function assertEligible(
  summary: EligibilitySummary | undefined,
  signature: string | undefined,
): void {
  if (summary === undefined || signature === undefined) {
    throw new NotEligibleError(
      'no eligibility record — a configuration cannot trade without evidence from @plumb/backtest',
    );
  }
  if (!verifyEligibility(summary, signature)) {
    throw new NotEligibleError(
      `eligibility record for "${summary.label}" fails signature verification — it has been edited`,
    );
  }
  if (!summary.eligible) {
    throw new NotEligibleError(
      `configuration "${summary.label}" is NOT eligible (failed on: ${summary.failedOn.join(', ')})`,
    );
  }
}

export type CycleOutcome = 'ran' | 'skipped_overrun' | 'halted' | 'failed';

export interface CycleReport {
  readonly index: number;
  readonly outcome: CycleOutcome;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly note: string;
}

export interface RunnerDeps {
  readonly client: AtkClient;
  readonly store: IntentStore;
  /** One full cycle. Returns a short note for the ledger. */
  readonly cycle: (index: number, startedAt: number) => Promise<string>;
  /** Injected clock. */
  readonly now: () => number;
  readonly intervalMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly onReport?: (report: CycleReport) => void;
}

/**
 * Runs `count` cycles, serialised.
 *
 * The overrun rule is enforced by construction: because each cycle is awaited before the next is
 * scheduled, two can never be in flight. What "skipped" records is a cycle whose SLOT was missed
 * because the previous one ran past it.
 */
export class CycleRunner {
  private running = false;
  private index = 0;
  private skipped = 0;
  private readonly reports: CycleReport[] = [];

  constructor(private readonly deps: RunnerDeps) {}

  get skippedCount(): number {
    return this.skipped;
  }

  get history(): readonly CycleReport[] {
    return this.reports;
  }

  /** True while a cycle is in flight — the guard that makes overlap impossible. */
  get busy(): boolean {
    return this.running;
  }

  async runOnce(): Promise<CycleReport> {
    const startedAt = this.deps.now();
    const index = this.index++;

    if (this.running) {
      // Reached only if a caller ignores the returned promise. Recorded rather than queued.
      this.skipped += 1;
      const report: CycleReport = {
        index,
        outcome: 'skipped_overrun',
        startedAt,
        durationMs: 0,
        note: 'previous cycle still running — this one skipped, not queued',
      };
      this.record(report);
      return report;
    }

    this.running = true;
    try {
      const note = await this.deps.cycle(index, startedAt);
      const report: CycleReport = {
        index,
        outcome: 'ran',
        startedAt,
        durationMs: this.deps.now() - startedAt,
        note,
      };
      this.record(report);
      return report;
    } catch (error) {
      const report: CycleReport = {
        index,
        outcome: 'failed',
        startedAt,
        durationMs: this.deps.now() - startedAt,
        note: error instanceof Error ? error.message : String(error),
      };
      this.record(report);
      return report;
    } finally {
      this.running = false;
    }
  }

  /**
   * Run for `cycles` iterations, sleeping only for the REMAINDER of the interval.
   *
   * A cycle that overran its slot does not get a full sleep afterwards — that would compound the
   * delay. It records the miss and goes straight into the next one.
   */
  async run(cycles: number): Promise<readonly CycleReport[]> {
    for (let i = 0; i < cycles; i += 1) {
      const report = await this.runOnce();
      const remaining = this.deps.intervalMs - report.durationMs;
      if (remaining > 0) {
        await this.deps.sleep(remaining);
      } else if (report.durationMs > this.deps.intervalMs) {
        this.skipped += 1;
        this.deps.store.append({
          ts: this.deps.now(),
          kind: 'cycle_overrun',
          signalId: undefined,
          instId: undefined,
          detail:
            `cycle ${report.index} took ${report.durationMs}ms against a ${this.deps.intervalMs}ms ` +
            `interval — the next slot was skipped rather than queued`,
        });
      }
    }
    return this.reports;
  }

  private record(report: CycleReport): void {
    this.reports.push(report);
    this.deps.onReport?.(report);
    this.deps.store.append({
      ts: report.startedAt,
      kind: `cycle_${report.outcome}`,
      signalId: undefined,
      instId: undefined,
      detail: `cycle ${report.index} (${report.durationMs}ms): ${report.note}`,
    });
  }
}
