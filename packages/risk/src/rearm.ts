/**
 * MANUAL RE-ARM.
 *
 * The system cannot re-arm itself. There is no automatic recovery from a kill switch, ever, and
 * no timeout after which one expires. Re-arming requires an operator token and writes an audit
 * record carrying who did it, when, and why.
 *
 * This is deliberately the most awkward operation in the codebase. A kill switch that is easy to
 * clear is a speed bump.
 */

import { HALT_FLAGS, type GovernorState, type GovernorStore, type HaltFlag } from './state.js';

export type RearmFailureCode = 'missing_token' | 'bad_token' | 'not_halted' | 'missing_reason';

export interface RearmRequest {
  /** Compared against `PLUMB_ADMIN_TOKEN`, which the caller reads — this package reads no env. */
  readonly token: string | undefined;
  /** Free text, recorded verbatim. "why" is the part that matters in six weeks. */
  readonly reason: string;
  readonly actor: string;
  /** Which flags to clear. Omit for all of them. */
  readonly flags?: readonly HaltFlag[];
}

export interface RearmSuccess {
  readonly ok: true;
  readonly state: GovernorState;
  readonly cleared: readonly HaltFlag[];
}

export interface RearmFailure {
  readonly ok: false;
  readonly code: RearmFailureCode;
  readonly message: string;
}

export type RearmOutcome = RearmSuccess | RearmFailure;

/**
 * @param expectedToken the configured `PLUMB_ADMIN_TOKEN`. Passed IN — this package never reads
 *   `process.env`, so it stays testable and has no ambient authority.
 */
export function rearm(
  state: GovernorState,
  request: RearmRequest,
  expectedToken: string | undefined,
  nowMs: number,
  store?: GovernorStore,
): RearmOutcome {
  if (expectedToken === undefined || expectedToken === '') {
    return {
      ok: false,
      code: 'missing_token',
      message: 'no PLUMB_ADMIN_TOKEN is configured — re-arm is impossible until one is set',
    };
  }
  if (request.token === undefined || request.token === '') {
    return { ok: false, code: 'missing_token', message: 'no operator token supplied' };
  }
  if (!constantTimeEquals(request.token, expectedToken)) {
    // Recorded even on failure: a wrong token is exactly the event worth having a trail of.
    store?.appendAudit({
      ts: nowMs,
      kind: 'rearm_denied',
      reason: 'bad operator token',
      actor: request.actor,
      payload: undefined,
    });
    return { ok: false, code: 'bad_token', message: 'operator token does not match' };
  }
  if (request.reason.trim().length === 0) {
    return {
      ok: false,
      code: 'missing_reason',
      message: 'a re-arm must carry a reason — an unexplained re-arm is an unexplained loss later',
    };
  }

  const targets = request.flags ?? HALT_FLAGS;
  const cleared = targets.filter((flag) => state.haltFlags[flag]);
  if (cleared.length === 0) {
    return { ok: false, code: 'not_halted', message: 'no halt flag is set — nothing to re-arm' };
  }

  const haltFlags = { ...state.haltFlags };
  for (const flag of cleared) haltFlags[flag] = false;
  const stillHalted = HALT_FLAGS.some((flag) => haltFlags[flag]);

  const next: GovernorState = {
    ...state,
    haltFlags,
    ...(stillHalted ? {} : { haltReason: undefined, haltedAt: undefined }),
  };

  store?.appendAudit({
    ts: nowMs,
    kind: 'rearm',
    reason: request.reason,
    actor: request.actor,
    payload: { cleared, stillHalted, equity: state.equity },
  });

  return { ok: true, state: next, cleared };
}

/** Length-independent comparison, so a token cannot be probed a character at a time. */
function constantTimeEquals(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < length; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}
