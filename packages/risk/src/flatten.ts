/**
 * THE EMERGENCY PATH.
 *
 * Produces close-intents for every open position, marked urgent so the executor uses market
 * orders. Two properties matter:
 *
 *  - **Idempotent.** Calling it twice does not double-close. A flatten triggered by the kill
 *    switch and again by the operator must not send two closes for one position.
 *  - **Independent.** It reads only the persisted state, so it works even if `@plumb/strategy`
 *    is broken, unreachable, or has never run. The path out must not depend on the path in.
 */

import type { Instrument } from '@plumb/core';

import type { GovernorState, OpenPosition } from './state.js';

export type FlattenReason = 'kill_switch' | 'daily_limit' | 'manual' | 'reconcile_mismatch' | 'data_stale';

export interface CloseIntent {
  readonly kind: 'close';
  readonly instId: Instrument;
  /** The side that CLOSES the position — opposite the position's own side. */
  readonly side: 'long' | 'short';
  readonly contracts: number;
  readonly urgent: true;
  readonly orderType: 'market';
  readonly reason: FlattenReason;
  readonly positionSignalId: string;
  readonly issuedAt: number;
}

export interface FlattenResult {
  readonly intents: readonly CloseIntent[];
  /** Positions already covered by an earlier flatten, so not re-issued. */
  readonly alreadyClosing: readonly string[];
  readonly state: GovernorState;
}

/**
 * `alreadyClosing` carries the signal ids of positions a previous flatten already covered. It is
 * the caller's job to persist it between calls; passing an empty set means "first attempt".
 */
export function flatten(
  state: GovernorState,
  reason: FlattenReason,
  nowMs: number,
  alreadyClosing: ReadonlySet<string> = new Set(),
): FlattenResult {
  const intents: CloseIntent[] = [];
  const skipped: string[] = [];

  for (const position of state.openPositions) {
    if (alreadyClosing.has(position.signalId)) {
      skipped.push(position.signalId);
      continue;
    }
    intents.push(closeIntentFor(position, reason, nowMs));
  }

  return { intents, alreadyClosing: skipped, state };
}

export function closeIntentFor(
  position: OpenPosition,
  reason: FlattenReason,
  nowMs: number,
): CloseIntent {
  return Object.freeze({
    kind: 'close' as const,
    instId: position.instId,
    // Closing a long is a sell; closing a short is a buy.
    side: position.side === 'long' ? ('short' as const) : ('long' as const),
    contracts: position.contracts,
    urgent: true as const,
    orderType: 'market' as const,
    reason,
    positionSignalId: position.signalId,
    issuedAt: nowMs,
  });
}

/** Every position id a flatten has now covered — feed back in on the next call. */
export function coveredBy(result: FlattenResult, previous: ReadonlySet<string> = new Set()): Set<string> {
  const next = new Set(previous);
  for (const intent of result.intents) next.add(intent.positionSignalId);
  for (const id of result.alreadyClosing) next.add(id);
  return next;
}
