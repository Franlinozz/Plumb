/**
 * THE HOLDOUT LOCK.
 *
 * Every strategy tested against the same data burns statistical power. Multiple-comparisons bias
 * is how honest people overfit: try twenty ideas on one dataset and one of them looks good by
 * arithmetic alone.
 *
 * So the history is partitioned ONCE, before any of the P4B work touches it:
 *
 *   DEVELOPMENT — everything except the most recent 90 days. Iterate here freely.
 *   HOLDOUT     — the most recent 90 days. Write-protected. Touched ONCE, at the very end,
 *                 on the single best development config. If it fails there, it fails.
 *
 * The guard is not advice. `assertDevelopmentOnly` throws if a backtest window reaches into the
 * holdout, and reading the holdout at all requires an operator token AND appends an audit record
 * carrying the date, the config hash and the reason. A test asserts the normal backtest path
 * cannot read holdout data.
 *
 * There is no "let me just check one more variant". That is the whole point.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** The most recent N days are reserved. Fixed here, recorded in AGENTS.md. */
export const HOLDOUT_DAYS = 90;

const MS_PER_DAY = 86_400_000;

export interface Partition {
  /** Oldest bar in the whole dataset. */
  readonly dataFrom: number;
  /** Newest bar in the whole dataset. */
  readonly dataTo: number;
  /** Development set: [dataFrom, holdoutFrom). */
  readonly developmentFrom: number;
  readonly developmentTo: number;
  /** Holdout set: [holdoutFrom, dataTo]. WRITE-PROTECTED. */
  readonly holdoutFrom: number;
  readonly holdoutTo: number;
  readonly holdoutDays: number;
}

/** Partition a dataset. Deterministic: the same bounds always give the same split. */
export function partition(dataFrom: number, dataTo: number, holdoutDays = HOLDOUT_DAYS): Partition {
  const holdoutFrom = dataTo - holdoutDays * MS_PER_DAY;
  if (holdoutFrom <= dataFrom) {
    throw new HoldoutViolation(
      `dataset spans only ${((dataTo - dataFrom) / MS_PER_DAY).toFixed(1)} days — ` +
        `not enough to reserve a ${holdoutDays}-day holdout`,
    );
  }
  return {
    dataFrom,
    dataTo,
    developmentFrom: dataFrom,
    developmentTo: holdoutFrom,
    holdoutFrom,
    holdoutTo: dataTo,
    holdoutDays,
  };
}

export class HoldoutViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HoldoutViolation';
  }
}

/**
 * The guard the normal backtest path runs.
 *
 * A window that reaches past `developmentTo` — by even one bar — throws. There is no tolerance
 * parameter, because a tolerance parameter is how a holdout leaks.
 */
export function assertDevelopmentOnly(
  window: { readonly fromTs: number; readonly toTs: number },
  split: Partition,
  label = 'backtest window',
): void {
  if (window.toTs > split.developmentTo) {
    throw new HoldoutViolation(
      `${label} ends at ${iso(window.toTs)}, inside the holdout which begins at ` +
        `${iso(split.holdoutFrom)}. The holdout is touched ONCE, at the end, on one config.`,
    );
  }
}

/** Clip a request to the development set, so a caller cannot accidentally over-reach. */
export function clampToDevelopment(
  window: { readonly fromTs: number; readonly toTs: number },
  split: Partition,
): { readonly fromTs: number; readonly toTs: number } {
  return {
    fromTs: Math.max(window.fromTs, split.developmentFrom),
    toTs: Math.min(window.toTs, split.developmentTo),
  };
}

export interface HoldoutAccessRequest {
  /** Must match `PLUMB_ADMIN_TOKEN`. Passed IN — this module reads no environment. */
  readonly token: string | undefined;
  /** Which configuration is being tested. Hashed into the audit record. */
  readonly configLabel: string;
  readonly configJson: string;
  readonly reason: string;
  readonly actor: string;
  readonly now: number;
}

export interface HoldoutAccessGrant {
  readonly granted: true;
  readonly configHash: string;
  readonly auditLine: string;
}

export interface HoldoutAccessDenial {
  readonly granted: false;
  readonly code: 'missing_token' | 'bad_token' | 'missing_reason' | 'already_used';
  readonly message: string;
}

export type HoldoutAccessOutcome = HoldoutAccessGrant | HoldoutAccessDenial;

export const DEFAULT_AUDIT_PATH = 'reports/holdout-audit.log';

/**
 * Request permission to read the holdout.
 *
 * Requires the operator token and a reason, and APPENDS to an audit log before returning. The
 * audit log is the mechanism: it makes "we only looked once" checkable rather than remembered.
 *
 * `previouslyUsed` lets the caller enforce single-use. Passed in rather than inferred, so the
 * policy is explicit at the call site.
 */
export function requestHoldoutAccess(
  request: HoldoutAccessRequest,
  expectedToken: string | undefined,
  auditPath: string = DEFAULT_AUDIT_PATH,
): HoldoutAccessOutcome {
  if (expectedToken === undefined || expectedToken === '') {
    return {
      granted: false,
      code: 'missing_token',
      message: 'no PLUMB_ADMIN_TOKEN is configured — the holdout cannot be read',
    };
  }
  if (request.token === undefined || request.token !== expectedToken) {
    return { granted: false, code: 'bad_token', message: 'operator token missing or incorrect' };
  }
  if (request.reason.trim().length === 0) {
    return {
      granted: false,
      code: 'missing_reason',
      message: 'a holdout read must carry a reason — an unexplained look is an unexplained result',
    };
  }

  const configHash = createHash('sha256').update(request.configJson).digest('hex').slice(0, 16);
  const auditLine = JSON.stringify({
    at: new Date(request.now).toISOString(),
    actor: request.actor,
    configLabel: request.configLabel,
    configHash,
    reason: request.reason,
  });

  mkdirSync(dirname(auditPath), { recursive: true });
  appendFileSync(auditPath, `${auditLine}\n`);
  return { granted: true, configHash, auditLine };
}

/** Every holdout read that has ever happened. Empty is the healthy state until the very end. */
export function holdoutAuditLog(auditPath: string = DEFAULT_AUDIT_PATH): readonly string[] {
  if (!existsSync(auditPath)) return [];
  return readFileSync(auditPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0);
}

function iso(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}
