import { INSTRUMENTS } from '@plumb/core';
import { TIMEFRAMES } from '@plumb/market';
import { z } from 'zod';

import { REGIME_LABELS } from './types.js';

/**
 * The Signal — everything `strategy` is allowed to say, and nothing more.
 *
 * **There is no `size`, `leverage` or `notional` field, and there never will be.** Strategy sets
 * DIRECTION and STOP DISTANCE. Sizing is computed in `@plumb/risk` from the stop distance and the
 * risk budget, because stop distance must determine size and never the reverse. The type is the
 * enforcement: a strategy cannot express a size, so it cannot smuggle one through.
 *
 * `inputs` carries the EXACT indicator values that fired the signal. It exists so that (a) the
 * published rationale can be checked against the numbers rather than trusted, and (b) an audit
 * six weeks later can reconstruct why this trade happened.
 */

const finite = z.number().finite();
const positive = finite.positive();

export const SignalSchema = z
  .object({
    id: z.string().regex(/^SIG-[A-Za-z0-9_-]{10}$/),
    ts: finite,
    instId: z.enum(INSTRUMENTS),
    side: z.enum(['long', 'short']),
    intent: z.enum(['open', 'close', 'reduce']),
    entry: z.object({
      type: z.enum(['market', 'limit']),
      price: positive.optional(),
    }),
    stop: z.object({
      price: positive,
      distancePct: positive,
      basis: z.enum(['atr', 'structure']),
    }),
    takeProfit: z
      .array(z.object({ price: positive, rMultiple: positive }))
      .optional(),
    timeframe: z.enum(TIMEFRAMES),
    strategyId: z.string().min(1),
    regime: z.enum(REGIME_LABELS),
    inputs: z.record(z.string(), finite),
    invalidation: z.object({
      maxHoldBars: z.number().int().positive(),
      conditions: z.array(z.string()),
    }),
    expiresAt: finite,
    version: z.string().min(1),
  })
  // A signal that carried sizing would mean the separation of concerns had already broken.
  .strict();

export type Signal = z.infer<typeof SignalSchema>;

/** What a strategy module returns. The engine stamps `id` and `ts`. */
export type SignalDraft = Omit<Signal, 'id' | 'ts'>;

/** Field names that must NEVER appear on a Signal. Asserted at runtime as well as in the type. */
export const FORBIDDEN_SIGNAL_FIELDS = Object.freeze([
  'size',
  'sz',
  'leverage',
  'lever',
  'notional',
  'quantity',
  'qty',
  'contracts',
  'margin',
] as const);

export class SignalSizingLeakError extends Error {
  constructor(readonly fields: readonly string[]) {
    super(
      `signal carries sizing fields (${fields.join(', ')}) — sizing belongs to @plumb/risk, ` +
        `never to @plumb/strategy`,
    );
    this.name = 'SignalSizingLeakError';
  }
}

/**
 * Runtime backstop for the type-level guarantee.
 *
 * `.strict()` already rejects unknown keys during parsing, but this is checked separately and
 * explicitly because it is the one invariant whose violation moves real money.
 */
export function assertNoSizing(candidate: Readonly<Record<string, unknown>>): void {
  const found = FORBIDDEN_SIGNAL_FIELDS.filter((field) =>
    Object.prototype.hasOwnProperty.call(candidate, field),
  );
  if (found.length > 0) throw new SignalSizingLeakError(found);
}

/** Parse + validate, including the no-sizing backstop. Throws on anything malformed. */
export function parseSignal(candidate: unknown): Signal {
  if (typeof candidate === 'object' && candidate !== null) {
    assertNoSizing(candidate as Record<string, unknown>);
  }
  return SignalSchema.parse(candidate);
}

/** True when the stop sits on the losing side of entry, which is the only valid arrangement. */
export function stopIsOnCorrectSide(
  side: 'long' | 'short',
  entryPrice: number,
  stopPrice: number,
): boolean {
  return side === 'long' ? stopPrice < entryPrice : stopPrice > entryPrice;
}

/** Fractional distance from entry to stop. Always positive. */
export function stopDistancePct(entryPrice: number, stopPrice: number): number {
  return Math.abs(entryPrice - stopPrice) / entryPrice;
}

/**
 * Take-profit levels at R multiples of the stop distance.
 * R is measured in price, so 2R is twice the distance risked — the same unit the stop is in.
 */
export function takeProfitLevels(
  side: 'long' | 'short',
  entryPrice: number,
  stopPrice: number,
  rMultiples: readonly number[],
): ReadonlyArray<{ price: number; rMultiple: number }> {
  const risk = Math.abs(entryPrice - stopPrice);
  return rMultiples.map((rMultiple) => ({
    price: side === 'long' ? entryPrice + risk * rMultiple : entryPrice - risk * rMultiple,
    rMultiple,
  }));
}
