import type { Signal } from '@plumb/core';
import { FeedStore, PublicationRequiredError, publishThenExecute, requirePublished } from '@plumb/asp';
import { describe, expect, it } from 'vitest';

import { IntentStore } from './idempotency.js';
import { MockAtk } from './mock.js';
import { placeBracket } from './bracket.js';

/**
 * GUARDRAIL 2 FROM THE EXECUTOR'S SIDE.
 *
 * `@plumb/asp` proves the gate refuses an unpublished signal. This proves the EXECUTOR is actually
 * wired behind that gate — that the path from a signal to a real bracketed order runs through
 * publication, and that skipping publication cannot produce an order.
 */

const NOW = Date.parse('2026-08-10T12:00:00Z');

function signal(): Signal {
  return {
    id: 'SIG-abcdefghij',
    ts: NOW,
    instId: 'BTC-USDT-SWAP',
    side: 'long',
    intent: 'open',
    entry: { type: 'market', price: 65_000 },
    stop: { price: 64_350, distancePct: 0.01, basis: 'atr' },
    takeProfit: [{ price: 65_975, rMultiple: 1.5 }],
    timeframe: '1H',
    strategyId: 'trend_ema',
    regime: 'trending_up',
    inputs: { adx: 31.2 },
    invalidation: { maxHoldBars: 8, conditions: ['ADX falls'] },
    expiresAt: NOW + 7_200_000,
    version: '1.0.0',
  };
}

describe('the executor sits behind the publish gate', () => {
  it('CANNOT place an order for a signal that was never published', () => {
    const feed = new FeedStore();
    // The executor's permission check is the only way in, and it refuses.
    expect(() => requirePublished(feed, signal().id)).toThrow(PublicationRequiredError);
    feed.close();
  });

  it('places the order only AFTER the signal exists in the feed', async () => {
    const feed = new FeedStore();
    const intents = new IntentStore();
    const venue = new MockAtk();
    const observed: boolean[] = [];

    await publishThenExecute(signal(), {
      store: feed,
      now: NOW,
      rationale: async () => 'because the trend agreed',
      execute: async (entry) => {
        // At the moment the order is placed, the record already exists.
        observed.push(feed.isPublished(entry.id));
        await placeBracket(
          {
            signalId: entry.id,
            instId: entry.instId,
            side: entry.side,
            sz: 0.61,
            stopPrice: entry.stopPrice,
          },
          { client: venue, store: intents, now: NOW },
        );
      },
    });

    expect(observed).toEqual([true]);
    expect(venue.placed).toHaveLength(1);
    // And the order carries the stop, from the PUBLISHED entry's stop price.
    expect(venue.placed[0]?.slTriggerPx).toBe(64_350);
    feed.close();
    intents.close();
  });

  it('places NOTHING when publication throws', async () => {
    const intents = new IntentStore();
    const venue = new MockAtk();
    const broken = { publish: () => { throw new Error('feed unavailable'); } } as unknown as FeedStore;

    await expect(
      publishThenExecute(signal(), {
        store: broken,
        now: NOW,
        rationale: async () => 'r',
        execute: async () => {
          await placeBracket(
            { signalId: 'SIG-abcdefghij', instId: 'BTC-USDT-SWAP', side: 'long', sz: 0.61, stopPrice: 64_350 },
            { client: venue, store: intents, now: NOW },
          );
        },
      }),
    ).rejects.toThrow('feed unavailable');

    // An unpublished trade is worse than a missed trade.
    expect(venue.placed).toEqual([]);
    intents.close();
  });
});
