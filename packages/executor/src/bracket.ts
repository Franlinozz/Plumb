/**
 * BRACKETED PLACEMENT — the entry and its protective stop are one operation.
 *
 * Guardrail 3: EVERY POSITION HAS A STOP BEFORE IT OPENS. A naked position never survives a cycle.
 *
 * The venue supports an attached stop (`--slTriggerPx` / `--slOrdPx`), so the normal path is
 * atomic. Where an attached stop cannot be used, the fallback is:
 *
 *   place entry → place stop → **if the stop fails, IMMEDIATELY CLOSE THE ENTRY** and raise.
 *
 * That last step is the one that matters and the one a fault-injection test pins. An executor that
 * places an entry, fails to protect it, and leaves it running has done the single worst thing
 * available to it.
 */

import type { Instrument } from '@plumb/core';

import { AtkError, type AtkClient, type OrderRef } from './atk.js';
import { toClOrdId } from './clord.js';
import type { IntentStore } from './idempotency.js';

export interface BracketRequest {
  readonly signalId: string;
  readonly instId: Instrument;
  readonly side: 'long' | 'short';
  /** Contracts. */
  readonly sz: number;
  readonly stopPrice: number;
  readonly takeProfitPrice?: number;
  /** Attach the stop to the entry order. False forces the two-step fallback path. */
  readonly atomic?: boolean;
  readonly tdMode?: 'cross' | 'isolated';
}

export interface BracketResult {
  readonly placed: boolean;
  readonly duplicate: boolean;
  readonly order: OrderRef | undefined;
  readonly stopAttached: boolean;
  readonly clOrdId: string;
  readonly note: string;
}

export class NakedPositionError extends Error {
  constructor(
    message: string,
    readonly closed: boolean,
    readonly signalId: string,
  ) {
    super(message);
    this.name = 'NakedPositionError';
  }
}

export interface BracketDeps {
  readonly client: AtkClient;
  readonly store: IntentStore;
  readonly now: number;
  readonly onAlarm?: (kind: string, detail: string) => void;
}

/** Entry side for a position side: a long is bought, a short is sold. */
export function entrySide(side: 'long' | 'short'): 'buy' | 'sell' {
  return side === 'long' ? 'buy' : 'sell';
}

export async function placeBracket(
  request: BracketRequest,
  deps: BracketDeps,
): Promise<BracketResult> {
  const { client, store, now } = deps;
  const clOrdId = toClOrdId(request.signalId);

  // ── 1. Idempotency: has this signal already been acted on? ────────────────────────────────
  const existingOrder = await client.getOrder(request.instId, { clOrdId });
  if (existingOrder !== undefined) {
    store.append({
      ts: now,
      kind: 'duplicate_suppressed',
      signalId: request.signalId,
      instId: request.instId,
      detail: `an order with clOrdId ${clOrdId} already exists at the venue (${existingOrder.state})`,
    });
    return {
      placed: false,
      duplicate: true,
      order: { ordId: existingOrder.ordId, clOrdId, instId: request.instId },
      stopAttached: existingOrder.slTriggerPx !== undefined,
      clOrdId,
      note: 'already placed',
    };
  }

  // ── 2. Persist intent BEFORE placing, so a crash here is recoverable. ─────────────────────
  const recorded = store.recordIntent(
    {
      signalId: request.signalId,
      clOrdId,
      instId: request.instId,
      side: entrySide(request.side),
      posSide: request.side,
      sz: request.sz,
      stopPrice: request.stopPrice,
      createdAt: now,
    },
    now,
  );
  if (recorded.alreadyExisted && recorded.intent.status === 'placed') {
    return {
      placed: false,
      duplicate: true,
      order:
        recorded.intent.ordId === undefined
          ? undefined
          : { ordId: recorded.intent.ordId, clOrdId, instId: request.instId },
      stopAttached: true,
      clOrdId,
      note: 'intent already marked placed',
    };
  }

  const atomic = request.atomic ?? true;

  // ── 3a. The atomic path: entry with the stop attached. ────────────────────────────────────
  if (atomic) {
    try {
      const order = await client.placeOrder({
        instId: request.instId,
        side: entrySide(request.side),
        posSide: request.side,
        ordType: 'market',
        sz: request.sz,
        tdMode: request.tdMode ?? 'cross',
        clOrdId,
        ...(request.takeProfitPrice === undefined
          ? {}
          : { tpTriggerPx: request.takeProfitPrice, tpOrdPx: -1 }),
        slTriggerPx: request.stopPrice,
        slOrdPx: -1, // market on trigger
      });
      store.markPlaced(clOrdId, order.ordId, now);
      store.append({
        ts: now,
        kind: 'bracket_placed',
        signalId: request.signalId,
        instId: request.instId,
        detail: `${request.side} ${request.sz} with attached stop @ ${request.stopPrice} (ordId ${order.ordId})`,
      });
      return { placed: true, duplicate: false, order, stopAttached: true, clOrdId, note: 'atomic bracket' };
    } catch (error) {
      const outcomeUncertain = error instanceof AtkError &&
        ['timeout', 'transport', 'malformed'].includes(error.kind);
      if (outcomeUncertain) {
        // The write may have reached the venue. Resolve only by the persisted
        // client order id; never resend and never relabel uncertainty as failure.
        let observed: Awaited<ReturnType<AtkClient['getOrder']>>;
        try { observed = await client.getOrder(request.instId, { clOrdId }); }
        catch (lookupError) {
          store.append({ ts: now, kind: 'order_outcome_uncertain', signalId: request.signalId,
            instId: request.instId, detail: `write and reconciliation uncertain: ${describe(lookupError)}` });
          throw error;
        }
        if (observed !== undefined) {
          store.markPlaced(clOrdId, observed.ordId, now);
          store.append({ ts: now, kind: 'intent_recovered_after_write', signalId: request.signalId,
            instId: request.instId, detail: `ambiguous write resolved to venue order ${observed.ordId}` });
          return {
            placed: true, duplicate: false,
            order: { ordId: observed.ordId, clOrdId, instId: request.instId },
            stopAttached: observed.slTriggerPx !== undefined,
            clOrdId, note: 'atomic bracket recovered by clOrdId',
          };
        }
        store.append({ ts: now, kind: 'order_outcome_uncertain', signalId: request.signalId,
          instId: request.instId, detail: `write returned ${describe(error)}; no venue order is observable yet` });
        // Leave the intent pending. A later reconciliation may discover a
        // delayed order; an automated new entry is forbidden while it exists.
        throw error;
      }
      store.markFailed(clOrdId, describe(error), now);
      throw error;
    }
  }

  // ── 3b. The fallback: entry, then stop, then close-on-failure. ────────────────────────────
  let order: OrderRef;
  try {
    order = await client.placeOrder({
      instId: request.instId,
      side: entrySide(request.side),
      posSide: request.side,
      ordType: 'market',
      sz: request.sz,
      tdMode: request.tdMode ?? 'cross',
      clOrdId,
    });
    store.markPlaced(clOrdId, order.ordId, now);
  } catch (error) {
    const outcomeUncertain = error instanceof AtkError &&
      ['timeout', 'transport', 'malformed'].includes(error.kind);
    if (!outcomeUncertain) {
      store.markFailed(clOrdId, describe(error), now);
      throw error;
    }
    let observed: Awaited<ReturnType<AtkClient['getOrder']>>;
    try { observed = await client.getOrder(request.instId, { clOrdId }); }
    catch (lookupError) {
      store.append({ ts: now, kind: 'order_outcome_uncertain', signalId: request.signalId,
        instId: request.instId, detail: `write and reconciliation uncertain: ${describe(lookupError)}` });
      throw error;
    }
    if (observed === undefined) {
      store.append({ ts: now, kind: 'order_outcome_uncertain', signalId: request.signalId,
        instId: request.instId, detail: `write returned ${describe(error)}; no venue order is observable yet` });
      throw error;
    }
    order = { ordId: observed.ordId, clOrdId, instId: request.instId };
    store.markPlaced(clOrdId, observed.ordId, now);
  }

  try {
    await client.placeOrder({
      instId: request.instId,
      // The stop CLOSES the position, so it is the opposite side and reduce-only.
      side: entrySide(request.side) === 'buy' ? 'sell' : 'buy',
      posSide: request.side,
      ordType: 'market',
      sz: request.sz,
      tdMode: request.tdMode ?? 'cross',
      clOrdId: toClOrdId(`S${request.signalId}`),
      reduceOnly: true,
      slTriggerPx: request.stopPrice,
      slOrdPx: -1,
    });
    store.append({
      ts: now,
      kind: 'bracket_placed',
      signalId: request.signalId,
      instId: request.instId,
      detail: `${request.side} ${request.sz}, stop placed separately @ ${request.stopPrice}`,
    });
    return { placed: true, duplicate: false, order, stopAttached: true, clOrdId, note: 'two-step bracket' };
  } catch (stopError) {
    // ── THE PATH THAT MATTERS. The entry is live and unprotected. Close it NOW. ────────────
    let closed = false;
    let closeNote = '';
    try {
      await client.closePosition(request.instId, request.tdMode ?? 'cross');
      closed = true;
    } catch (closeError) {
      closeNote = ` AND THE CLOSE ALSO FAILED: ${describe(closeError)}`;
    }

    const message =
      `stop placement failed for ${request.signalId} on ${request.instId} ` +
      `(${describe(stopError)}) — entry ${closed ? 'was closed immediately' : 'COULD NOT BE CLOSED'}${closeNote}`;

    store.markAbandoned(clOrdId, message, now);
    store.append({
      ts: now,
      kind: closed ? 'naked_position_closed' : 'naked_position_STUCK',
      signalId: request.signalId,
      instId: request.instId,
      detail: message,
    });
    deps.onAlarm?.(closed ? 'naked_position_closed' : 'naked_position_stuck', message);

    throw new NakedPositionError(message, closed, request.signalId);
  }
}

function describe(error: unknown): string {
  if (error instanceof AtkError) return `${error.kind}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
