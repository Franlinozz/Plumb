/**
 * THE AUDIT LOOP — and the thing that keeps us eligible.
 *
 * Every cycle, the venue's fills and positions are matched against the signal ledger. This is what
 * makes "our trades follow our published signals" CHECKABLE rather than asserted, which is exactly
 * the claim a competition audit tests.
 *
 * Any of these halts trading immediately:
 *   - a fill that matches no signal id          → `reconcileMismatch`, flatten, alert
 *   - a signal marked executed with no fill      → re-query, then alert or halt
 *   - a venue position size that drifts from ours → halt
 *
 * Halting on drift is deliberate. Trading on a position we cannot account for is how a small
 * discrepancy becomes an unexplainable loss.
 */

import type { AtkClient, VenueFill, VenuePosition } from './atk.js';
import { resolveSignalId } from './clord.js';
import type { IntentStore } from './idempotency.js';

export type ReconcileIssueKind =
  | 'unmatched_fill'
  | 'missing_fill'
  | 'size_drift'
  | 'unknown_position';

export interface ReconcileIssue {
  readonly kind: ReconcileIssueKind;
  readonly instId: string;
  readonly detail: string;
  readonly signalId: string | undefined;
}

export interface ReconcileResult {
  readonly ok: boolean;
  readonly issues: readonly ReconcileIssue[];
  readonly matchedFills: number;
  readonly checkedPositions: number;
  /** True when the caller must set `haltFlags.reconcileMismatch`, flatten and stop trading. */
  readonly mustHalt: boolean;
}

export interface RecordedPosition {
  readonly instId: string;
  readonly side: 'long' | 'short';
  readonly contracts: number;
  readonly signalId: string;
}

export interface ReconcileInput {
  readonly client: AtkClient;
  readonly store: IntentStore;
  /** What WE believe is open, from the governor's persisted state. */
  readonly recorded: readonly RecordedPosition[];
  /** Every signal id we have ever acted on — the universe a fill may legitimately match. */
  readonly knownSignalIds: Iterable<string>;
  readonly now: number;
  /** Contracts of tolerated difference. Default 0 — an exchange does not round our size for us. */
  readonly sizeTolerance?: number;
  /** Fills older than this are ignored as already-reconciled history. */
  readonly sinceTs?: number;
}

export async function reconcile(input: ReconcileInput): Promise<ReconcileResult> {
  const tolerance = input.sizeTolerance ?? 0;
  const issues: ReconcileIssue[] = [];
  const known = [...input.knownSignalIds];

  const [fills, positions] = await Promise.all([input.client.getFills(), input.client.getPositions()]);

  // ── 1. Every fill must trace to a signal. ────────────────────────────────────────────────
  let matchedFills = 0;
  for (const fill of fills) {
    if (input.sinceTs !== undefined && fill.ts < input.sinceTs) continue;
    const signalId = resolveSignalId(fill.clOrdId, known);
    if (signalId === undefined) {
      issues.push({
        kind: 'unmatched_fill',
        instId: fill.instId,
        signalId: undefined,
        detail:
          `fill ${fill.ordId} on ${fill.instId} (clOrdId "${fill.clOrdId}", ${fill.side} ` +
          `${fill.fillSz} @ ${fill.fillPx}) matches no signal in the ledger`,
      });
    } else {
      matchedFills += 1;
    }
  }

  // ── 2. Every position we believe in must exist at the venue, at the right size. ──────────
  const byInstrument = new Map<string, VenuePosition>();
  for (const position of positions) {
    if (Math.abs(position.pos) > 0) byInstrument.set(position.instId, position);
  }

  for (const recorded of input.recorded) {
    const venue = byInstrument.get(recorded.instId);
    if (venue === undefined) {
      issues.push({
        kind: 'missing_fill',
        instId: recorded.instId,
        signalId: recorded.signalId,
        detail:
          `we record a ${recorded.side} position of ${recorded.contracts} on ${recorded.instId} ` +
          `(signal ${recorded.signalId}) but the venue reports none`,
      });
      continue;
    }
    const venueSize = Math.abs(venue.pos);
    if (Math.abs(venueSize - recorded.contracts) > tolerance) {
      issues.push({
        kind: 'size_drift',
        instId: recorded.instId,
        signalId: recorded.signalId,
        detail:
          `position size drift on ${recorded.instId}: we record ${recorded.contracts}, ` +
          `the venue reports ${venueSize} (tolerance ${tolerance})`,
      });
    }
    byInstrument.delete(recorded.instId);
  }

  // ── 3. Anything left at the venue is a position we did not open. ────────────────────────
  for (const [instId, position] of byInstrument) {
    issues.push({
      kind: 'unknown_position',
      instId,
      signalId: undefined,
      detail: `venue reports a ${position.posSide} position of ${position.pos} on ${instId} that we did not open`,
    });
  }

  for (const issue of issues) {
    input.store.append({
      ts: input.now,
      kind: `reconcile_${issue.kind}`,
      signalId: issue.signalId,
      instId: issue.instId,
      detail: issue.detail,
    });
  }

  // Every issue class halts. There is no "minor" reconciliation failure: each one means our
  // record of reality and reality itself have parted company.
  const mustHalt = issues.length > 0;
  return {
    ok: issues.length === 0,
    issues,
    matchedFills,
    checkedPositions: input.recorded.length,
    mustHalt,
  };
}

/**
 * Boot-time recovery: intents written but never confirmed.
 *
 * For each, ask the venue whether the order actually landed. A crash between "intent persisted"
 * and "order placed" is thereby resolved from the venue's records rather than guessed at.
 */
export async function recoverPendingIntents(
  client: AtkClient,
  store: IntentStore,
  now: number,
): Promise<{ readonly recovered: number; readonly abandoned: number; readonly stillPending: number }> {
  let recovered = 0;
  let abandoned = 0;
  let stillPending = 0;

  for (const intent of store.pending()) {
    let order: Awaited<ReturnType<AtkClient['getOrder']>>;
    try {
      order = await client.getOrder(intent.instId, { clOrdId: intent.clOrdId });
    } catch {
      stillPending += 1;
      continue;
    }

    if (order === undefined) {
      // The order never reached the venue. Safe to abandon — nothing was opened.
      store.markAbandoned(intent.clOrdId, 'no order at the venue on boot — intent never landed', now);
      store.append({
        ts: now,
        kind: 'intent_abandoned',
        signalId: intent.signalId,
        instId: intent.instId,
        detail: `pending intent ${intent.clOrdId} had no corresponding venue order`,
      });
      abandoned += 1;
    } else {
      // It DID land. Adopt it rather than placing a second one.
      store.markPlaced(intent.clOrdId, order.ordId, now);
      store.append({
        ts: now,
        kind: 'intent_recovered',
        signalId: intent.signalId,
        instId: intent.instId,
        detail: `pending intent ${intent.clOrdId} was already live at the venue as ${order.ordId} (${order.state})`,
      });
      recovered += 1;
    }
  }

  return { recovered, abandoned, stillPending };
}

export function fillsBySignal(
  fills: readonly VenueFill[],
  knownSignalIds: Iterable<string>,
): ReadonlyMap<string, readonly VenueFill[]> {
  const known = [...knownSignalIds];
  const map = new Map<string, VenueFill[]>();
  for (const fill of fills) {
    const signalId = resolveSignalId(fill.clOrdId, known);
    if (signalId === undefined) continue;
    const bucket = map.get(signalId);
    if (bucket === undefined) map.set(signalId, [fill]);
    else bucket.push(fill);
  }
  return map;
}
