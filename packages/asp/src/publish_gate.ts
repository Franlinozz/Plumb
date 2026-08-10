/**
 * PUBLISH BEFORE EXECUTE — guardrail 2, made structural.
 *
 * The executor is not permitted to act on a signal that does not exist in the published feed. Not
 * "should not" — cannot: `requirePublished` throws, and `publishThenExecute` is the only sanctioned
 * way to get from a signal to an order, with publication happening first and the execute callback
 * receiving the PUBLISHED ENTRY rather than the signal object.
 *
 * That ordering is what makes our trades provably signal-derived when audited. The feed entry is
 * timestamped and hash-chained before any order exists, so the record cannot be reconstructed
 * after the fact to match a trade that happened for some other reason.
 */

import type { Signal } from '@plumb/core';

import type { FeedStore, PublishedSignal } from './feed.js';

export class PublicationRequiredError extends Error {
  constructor(readonly signalId: string) {
    super(
      `signal ${signalId} has not been published — the executor may only act on signals that ` +
        `exist in the published feed (AGENTS.md guardrail 2). Publication comes first; execution ` +
        `reads what was published.`,
    );
    this.name = 'PublicationRequiredError';
  }
}

/**
 * The executor's permission check.
 *
 * Returns the published entry, which is what the executor should be reading — not the in-memory
 * signal it may happen to be holding.
 */
export function requirePublished(store: FeedStore, signalId: string): PublishedSignal {
  const entry = store.get(signalId);
  if (entry === undefined) throw new PublicationRequiredError(signalId);
  return entry;
}

export interface PublishAndExecuteDeps {
  readonly store: FeedStore;
  readonly now: number;
  /** Produces the rationale. Runs BEFORE publication, on the frozen signal. */
  readonly rationale: (signal: Signal) => Promise<string>;
  /**
   * Places the order. Receives the PUBLISHED ENTRY — not the Signal — so the executor is reading
   * the record rather than the strategy's working state.
   */
  readonly execute: (entry: PublishedSignal) => Promise<void>;
  /** Called after publication and before execution. The subscriber delivery hook. */
  readonly deliver?: (entry: PublishedSignal) => Promise<void> | void;
}

export interface PublishThenExecuteResult {
  readonly entry: PublishedSignal;
  readonly alreadyPublished: boolean;
  readonly executed: boolean;
  readonly error: string | undefined;
}

/**
 * The one sanctioned path from an approved signal to an order.
 *
 * Order of operations is the whole point:
 *   1. generate the rationale from the FROZEN signal
 *   2. write it to the published feed and chain it
 *   3. deliver to subscribers
 *   4. only then execute, and only from the published entry
 *
 * If publication fails, execution never happens. That is deliberate: an unpublished trade is worse
 * than a missed trade, because a missed trade costs an opportunity and an unpublished one costs
 * the property the whole service is built on.
 */
export async function publishThenExecute(
  signal: Signal,
  deps: PublishAndExecuteDeps,
): Promise<PublishThenExecuteResult> {
  const frozen = Object.freeze({ ...signal });
  const rationale = await deps.rationale(frozen);

  const { entry, alreadyPublished } = deps.store.publish(frozen, rationale, deps.now);

  // Belt and braces: confirm the record actually holds it before anything can trade on it.
  const confirmed = requirePublished(deps.store, signal.id);

  if (deps.deliver !== undefined) await deps.deliver(confirmed);

  try {
    await deps.execute(confirmed);
    return { entry, alreadyPublished, executed: true, error: undefined };
  } catch (error) {
    return {
      entry,
      alreadyPublished,
      executed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
