/**
 * Position management after entry.
 *
 * One rule dominates: **a stop NEVER moves further from entry. Only closer.** Moving a stop away
 * is how a small planned loss becomes an unplanned large one, and it is always rationalised in the
 * moment. So it is not a policy — it is a function that refuses.
 */

import type { Instrument } from '@plumb/core';

export interface ManagedPosition {
  readonly signalId: string;
  readonly instId: Instrument;
  readonly side: 'long' | 'short';
  readonly contracts: number;
  readonly entryPrice: number;
  readonly stopPrice: number;
  readonly openedAt: number;
  readonly openedAtBar: number;
  readonly maxHoldBars: number;
  readonly invalidationConditions: readonly string[];
}

export interface LifecycleConfig {
  /** Move the stop to breakeven once this many R of profit is reached. */
  readonly breakevenAtR: number;
  /** Small buffer beyond entry so breakeven covers fees rather than landing exactly on entry. */
  readonly breakevenBufferPct: number;
}

export const DEFAULT_LIFECYCLE: LifecycleConfig = Object.freeze({
  breakevenAtR: 1,
  breakevenBufferPct: 0.0005,
});

export class StopRegressionError extends Error {
  constructor(
    readonly signalId: string,
    readonly from: number,
    readonly to: number,
  ) {
    super(
      `refusing to move the stop for ${signalId} from ${from} to ${to} — that is further from ` +
        `entry, and a stop only ever moves closer`,
    );
    this.name = 'StopRegressionError';
  }
}

/**
 * Is `next` closer to entry than `current`, on the correct side?
 *
 * For a long, closer means HIGHER; for a short, LOWER.
 */
export function isTighter(
  side: 'long' | 'short',
  current: number,
  next: number,
): boolean {
  return side === 'long' ? next > current : next < current;
}

/**
 * The only sanctioned way to change a stop.
 *
 * Throws rather than clamping: a caller that tried to widen a stop has a bug in its reasoning,
 * and silently ignoring the request would hide it.
 */
export function tightenStop(
  position: ManagedPosition,
  nextStop: number,
): ManagedPosition {
  if (!Number.isFinite(nextStop) || nextStop <= 0) {
    throw new StopRegressionError(position.signalId, position.stopPrice, nextStop);
  }
  if (nextStop === position.stopPrice) return position;
  if (!isTighter(position.side, position.stopPrice, nextStop)) {
    throw new StopRegressionError(position.signalId, position.stopPrice, nextStop);
  }
  return { ...position, stopPrice: nextStop };
}

/** Profit in R multiples — how many "risked distances" the position is up. */
export function currentR(position: ManagedPosition, price: number): number {
  const risk = Math.abs(position.entryPrice - position.stopPrice);
  if (risk === 0) return 0;
  const move = position.side === 'long' ? price - position.entryPrice : position.entryPrice - price;
  return move / risk;
}

export type LifecycleActionKind = 'move_stop' | 'close' | 'none';

export interface LifecycleAction {
  readonly kind: LifecycleActionKind;
  readonly signalId: string;
  readonly instId: Instrument;
  readonly reason: string;
  readonly newStopPrice?: number;
}

export interface LifecycleInput {
  readonly position: ManagedPosition;
  readonly price: number;
  readonly bar: number;
  readonly config?: LifecycleConfig;
  /** Invalidation conditions the caller has evaluated as TRUE this cycle. */
  readonly triggeredConditions?: readonly string[];
}

/**
 * Decide what to do with an open position this cycle.
 *
 * Pure: it returns an intent, it does not place anything. The caller routes every action through
 * the same bracket/idempotency machinery an entry uses.
 */
export function manage(input: LifecycleInput): LifecycleAction {
  const { position, price, bar } = input;
  const config = input.config ?? DEFAULT_LIFECYCLE;

  // ── 1. Invalidation conditions from the signal itself. ───────────────────────────────────
  const triggered = input.triggeredConditions ?? [];
  if (triggered.length > 0) {
    return {
      kind: 'close',
      signalId: position.signalId,
      instId: position.instId,
      reason: `invalidation condition met: ${triggered.join('; ')}`,
    };
  }

  // ── 2. maxHoldBars from the signal. ──────────────────────────────────────────────────────
  const held = bar - position.openedAtBar;
  if (held >= position.maxHoldBars) {
    return {
      kind: 'close',
      signalId: position.signalId,
      instId: position.instId,
      reason: `held ${held} bars, the signal's maxHoldBars is ${position.maxHoldBars}`,
    };
  }

  // ── 3. Trail to breakeven once the trade has earned it. ──────────────────────────────────
  const r = currentR(position, price);
  if (r >= config.breakevenAtR) {
    const buffer = position.entryPrice * config.breakevenBufferPct;
    const breakeven =
      position.side === 'long' ? position.entryPrice + buffer : position.entryPrice - buffer;
    if (isTighter(position.side, position.stopPrice, breakeven)) {
      return {
        kind: 'move_stop',
        signalId: position.signalId,
        instId: position.instId,
        newStopPrice: breakeven,
        reason: `reached ${r.toFixed(2)}R — stop to breakeven + ${(config.breakevenBufferPct * 100).toFixed(2)}%`,
      };
    }
  }

  return { kind: 'none', signalId: position.signalId, instId: position.instId, reason: 'hold' };
}
