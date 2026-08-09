/**
 * LLM rationale — INTERFACE ONLY. Nothing in this file calls anything, in this phase or any
 * other phase where it would be a shortcut.
 *
 * ┌──────────────────────────────────────────────────────────────────────────────────────────┐
 * │ GUARDRAIL 4. The model receives NUMBERS and returns PROSE.                                │
 * │                                                                                           │
 * │ It may never return a number that re-enters the signal — not an entry, not a size, not a  │
 * │ leverage, not a stop, not a target. By the time a payload reaches here the signal is       │
 * │ already complete and already gated; the rationale is an explanation of a decision that has │
 * │ been made, never an input to one. If a future phase finds itself parsing a figure out of a │
 * │ model response and putting it anywhere near an order, that phase is wrong.                 │
 * └──────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * The rationale exists because Plumb publishes every signal WITH its reasoning before any order
 * exists. The reasoning has to be checkable against the numbers that produced it, which is why
 * the payload carries `inputs` verbatim rather than a summary.
 */

import type { Signal } from './signal.js';
import type { RegimeAssessment } from './types.js';

export interface RationalePayload {
  readonly signalId: string;
  readonly instId: string;
  readonly side: 'long' | 'short';
  readonly timeframe: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly regime: {
    readonly label: string;
    readonly confidence: number;
    readonly reasons: readonly string[];
  };
  /** The EXACT indicator values that fired the signal. Verbatim, not rounded, not summarised. */
  readonly inputs: Readonly<Record<string, number>>;
  readonly entry: Signal['entry'];
  readonly stop: Signal['stop'];
  readonly takeProfit: Signal['takeProfit'];
  readonly invalidation: Signal['invalidation'];
  /** What the model is permitted to produce. Stated in the payload so it travels with it. */
  readonly contract: {
    readonly returns: 'prose';
    readonly mustNotReturn: readonly string[];
    readonly maxWords: number;
  };
}

export const RATIONALE_CONTRACT = Object.freeze({
  returns: 'prose' as const,
  mustNotReturn: Object.freeze([
    'entry price',
    'stop price',
    'take-profit price',
    'position size',
    'leverage',
    'notional',
    'any number not already present in `inputs`',
  ]),
  maxWords: 120,
});

/**
 * Build the payload a model would be given. Pure: it reads the signal and nothing else.
 *
 * Not called anywhere in this phase. When it is wired, the caller lives in `@plumb/ops` — outside
 * the pure packages — so that `strategy` stays free of I/O and stays replayable.
 */
export function buildRationalePayload(
  signal: Signal,
  regime: RegimeAssessment,
): RationalePayload {
  return Object.freeze({
    signalId: signal.id,
    instId: signal.instId,
    side: signal.side,
    timeframe: signal.timeframe,
    strategyId: signal.strategyId,
    strategyVersion: signal.version,
    regime: Object.freeze({
      label: regime.label,
      confidence: regime.confidence,
      reasons: Object.freeze([...regime.reasons]),
    }),
    inputs: signal.inputs,
    entry: signal.entry,
    stop: signal.stop,
    takeProfit: signal.takeProfit,
    invalidation: signal.invalidation,
    contract: RATIONALE_CONTRACT,
  });
}

/**
 * The check a future phase MUST run on any model response before publishing it: the prose may not
 * introduce a figure that was not already among the signal's own inputs.
 *
 * Provided now, unused now, so that the phase which wires the model has no excuse.
 */
export function findUnsanctionedNumbers(prose: string, signal: Signal): readonly string[] {
  const sanctioned = new Set<string>();
  for (const value of Object.values(signal.inputs)) sanctioned.add(normalise(value));
  sanctioned.add(normalise(signal.stop.price));
  sanctioned.add(normalise(signal.stop.distancePct * 100));
  if (signal.entry.price !== undefined) sanctioned.add(normalise(signal.entry.price));
  for (const tp of signal.takeProfit ?? []) {
    sanctioned.add(normalise(tp.price));
    sanctioned.add(normalise(tp.rMultiple));
  }
  sanctioned.add(normalise(signal.invalidation.maxHoldBars));

  const found: string[] = [];
  for (const match of prose.matchAll(/-?\d+(?:[.,]\d+)?/g)) {
    const raw = match[0].replace(/,/g, '');
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    if (!sanctioned.has(normalise(value))) found.push(match[0]);
  }
  return found;
}

/** Compare on a tolerant key, so "65,146.1" and 65146.10 are the same figure. */
function normalise(value: number): string {
  return value.toFixed(4);
}
