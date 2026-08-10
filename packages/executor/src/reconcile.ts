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
  | 'side_mismatch'
  | 'multiple_recorded_positions'
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

  // Recorded positions are grouped by instrument first. The old code walked `input.recorded`
  // directly and `delete`d the venue entry on the first match, so a SECOND recorded position on
  // the same instrument always came back `missing_fill` — the venue had not lost it, we had
  // already consumed it. That is what turned one real fault into two confusing ones during P8
  // run 1 (2026-08-10): "we record 0.34, the venue reports 0.01" plus "the venue reports none",
  // describing a single net-mode netting event.
  const recordedByInstrument = new Map<string, RecordedPosition[]>();
  for (const recorded of input.recorded) {
    const bucket = recordedByInstrument.get(recorded.instId);
    if (bucket === undefined) recordedByInstrument.set(recorded.instId, [recorded]);
    else bucket.push(recorded);
  }

  for (const [instId, group] of recordedByInstrument) {
    const venue = byInstrument.get(instId);
    byInstrument.delete(instId);

    if (venue === undefined) {
      for (const recorded of group) {
        issues.push({
          kind: 'missing_fill',
          instId,
          signalId: recorded.signalId,
          detail:
            `we record a ${recorded.side} position of ${recorded.contracts} on ${instId} ` +
            `(signal ${recorded.signalId}) but the venue reports none`,
        });
      }
      continue;
    }

    // More than one recorded position on one instrument cannot be checked position-by-position:
    // in `net_mode` the venue holds a single netted figure and there is no way to attribute it
    // back to the legs. The governor forbids this (veto `instrument_occupied`); if it happens
    // anyway, say so plainly instead of inventing a per-leg drift.
    if (group.length > 1) {
      const net = group.reduce((sum, p) => sum + (p.side === 'long' ? p.contracts : -p.contracts), 0);
      issues.push({
        kind: 'multiple_recorded_positions',
        instId,
        signalId: group[0]?.signalId,
        detail:
          `we record ${group.length} positions on ${instId} ` +
          `(${group.map((p) => `${p.side} ${p.contracts} via ${p.signalId}`).join(', ')}) ` +
          `netting to ${net}; the venue reports a single ${venue.posSide} position of ${venue.pos}. ` +
          `Under net_mode the legs cannot be attributed — reconcile to the venue, which is the truth.`,
      });
      continue;
    }

    const recorded = group[0];
    if (recorded === undefined) continue;

    // Direction, then size. `Math.abs(venue.pos)` alone let a REVERSED position of the right size
    // pass silently, which is the most dangerous drift there is.
    const venueSide =
      venue.posSide === 'net' ? (venue.pos >= 0 ? 'long' : 'short') : venue.posSide;
    if (venueSide !== recorded.side) {
      issues.push({
        kind: 'side_mismatch',
        instId,
        signalId: recorded.signalId,
        detail:
          `direction mismatch on ${instId}: we record ${recorded.side} ${recorded.contracts} ` +
          `(signal ${recorded.signalId}), the venue holds ${venueSide} ${Math.abs(venue.pos)}`,
      });
      continue;
    }

    const venueSize = Math.abs(venue.pos);
    if (Math.abs(venueSize - recorded.contracts) > tolerance) {
      issues.push({
        kind: 'size_drift',
        instId,
        signalId: recorded.signalId,
        detail:
          `position size drift on ${instId}: we record ${recorded.contracts}, ` +
          `the venue reports ${venueSize} (tolerance ${tolerance})`,
      });
    }
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
