import { describe, expect, it } from 'vitest';

import { finalizeDecisionEvent, type DecisionEvent } from '@plumb/core';

import type { PlaceOrderRequest, OrderRef, VenueOrder } from './atk.js';
import {
  AgentTradeKitCompetitionExecutor,
  CompetitionExecutionRejected,
  type CompetitionPublicationProof,
  type CompetitionVenue,
} from './competition.js';
import { IntentStore } from './idempotency.js';
import { MockAtk } from './mock.js';

const NOW = Date.now();
const event = finalizeDecisionEvent({
  decisionId: 'DEC-COMPETE0001', strategyVersion: 'momentum-v1', createdAt: NOW - 1_000,
  validUntil: NOW + 60_000, instrument: 'BTC-USDT-SWAP', direction: 'long',
  entryLow: 65_000, entryHigh: 66_000, stopPrice: 64_025, takeProfit: 68_000,
  positionPct: 50, leverage: 2, riskUsd: 3, expectedCostBps: 12, expectedEdgeBps: 30,
  governorApproved: true, venuePositionBefore: 0, ledgerPositionBefore: 0,
  reconciliationVersion: 'signed-v1',
});

class CompetitionMock extends MockAtk implements CompetitionVenue {
  override readonly demo = false;
  readonly transport = 'agent-trade-kit' as const;
  readonly profileName = 'competition';
  posSideOverride: 'long' | 'short' | 'net' | undefined;

  async getAccountConfig() { return { uid: 'test-uid', acctLv: '2', posMode: 'net_mode' }; }
  async getInstrumentMetadata() {
    return { ctVal: 0.01, ctMult: 1, minSz: 0.01, lotSz: 0.01, state: 'live' };
  }
  async getFeeRates() { return { maker: 0.0002, taker: 0.0005 }; }
  async getLastPrice() { return 65_000; }
  async getLeverage() { return 2; }
  async getMaxAvailableSize() { return { buy: 10, sell: 10 }; }

  override async placeOrder(request: PlaceOrderRequest): Promise<OrderRef> {
    const result = await super.placeOrder(request);
    if (request.reduceOnly === true) this.setPosition(request.instId, 0, 'net');
    else {
      const sign = request.side === 'buy' ? 1 : -1;
      this.setPosition(request.instId, sign * request.sz, 'net');
    }
    return result;
  }
}

const proof = (expected: DecisionEvent = event): CompetitionPublicationProof => ({
  isFullyDelivered: (candidate) => JSON.stringify(candidate) === JSON.stringify(expected),
});

const input = (candidate: DecisionEvent = event) => ({
  event: candidate, expectedUid: 'test-uid', ledgerSignedPosition: candidate.ledgerPositionBefore,
  risk: { equityUsd: 400, availableMarginUsd: 400, realisedPnlTodayUsd: 0,
    drawdownUsd: 0, concurrentStopRiskUsd: 0 },
  liveConfirmation: `CONFIRM LIVE ${candidate.decisionId}`, now: NOW,
});

const executor = (venue = new CompetitionMock(), publications = proof()) =>
  new AgentTradeKitCompetitionExecutor({ venue, publications, intents: new IntentStore(), sleep: async () => {} });

describe('AgentTradeKitCompetitionExecutor', () => {
  it('executes a flat approved event only after exact A2A delivery proof', async () => {
    const venue = new CompetitionMock();
    const result = await executor(venue).execute(input());
    expect(result).toMatchObject({ decisionId: event.decisionId, contracts: 0.3, reversed: false,
      venueSignedPositionAfter: 0.3 });
    expect(venue.placed[0]).toMatchObject({ clOrdId: 'DECCOMPETE0001', slTriggerPx: 64_025 });
  });

  it('closes to signed zero before reversing in net_mode', async () => {
    const venue = new CompetitionMock();
    venue.setPosition(event.instrument, -0.1, 'net');
    const reversal = finalizeDecisionEvent({ ...event, decisionId: 'DEC-COMPETE0002',
      venuePositionBefore: -0.1, ledgerPositionBefore: -0.1 });
    const result = await executor(venue, proof(reversal)).execute(input(reversal));
    expect(result.reversed).toBe(true);
    expect(venue.placed[0]).toMatchObject({ side: 'buy', sz: 0.1, reduceOnly: true });
    expect(venue.placed[1]).toMatchObject({ side: 'buy', sz: 0.3, slTriggerPx: 64_025 });
  });

  it.each([
    ['missing publication proof', { publications: { isFullyDelivered: () => false } }],
    ['missing live confirmation', { override: { liveConfirmation: 'no' } }],
    ['daily loss', { override: { risk: { ...input().risk, realisedPnlTodayUsd: -12 } } }],
    ['drawdown stop', { override: { risk: { ...input().risk, drawdownUsd: 24 } } }],
    ['concurrent risk', { override: { risk: { ...input().risk, concurrentStopRiskUsd: 6 } } }],
  ])('fails closed on %s', async (_name, options) => {
    const venue = new CompetitionMock();
    const publications = 'publications' in options ? options.publications : proof();
    const override = 'override' in options ? options.override : {};
    await expect(executor(venue, publications).execute({ ...input(), ...override }))
      .rejects.toBeInstanceOf(CompetitionExecutionRejected);
    expect(venue.placed).toHaveLength(0);
  });

  it('rejects a correct-size position in the wrong signed direction', async () => {
    const venue = new CompetitionMock();
    venue.setPosition(event.instrument, -0.3, 'net');
    await expect(executor(venue).execute(input())).rejects.toThrow(/signed venue/u);
    expect(venue.placed).toHaveLength(0);
  });

  it('emergency-reduces and fails when the attached stop is absent', async () => {
    const venue = new CompetitionMock();
    const original = venue.getOrder.bind(venue);
    venue.getOrder = async (...args): Promise<VenueOrder | undefined> => {
      const order = await original(...args);
      if (order === undefined) return undefined;
      const { slTriggerPx: _stop, attachAlgoId: _algo, ...withoutStop } = order;
      return withoutStop;
    };
    await expect(executor(venue).execute(input())).rejects.toThrow(/protective stop absent/u);
    expect(venue.placed.at(-1)).toMatchObject({ reduceOnly: true });
  });

  it('fails closed when the venue position reveals a partial fill', async () => {
    class PartialFillVenue extends CompetitionMock {
      override async placeOrder(request: PlaceOrderRequest): Promise<OrderRef> {
        const result = await super.placeOrder(request);
        if (request.reduceOnly !== true) {
          this.setPosition(request.instId, (request.side === 'buy' ? 1 : -1) * request.sz / 2, 'net');
        }
        return result;
      }
    }
    await expect(executor(new PartialFillVenue()).execute(input())).rejects.toThrow(/partial/u);
  });

  it('rejects any adapter not branded as Agent Trade Kit', () => {
    const venue = new CompetitionMock() as CompetitionVenue & { transport: string };
    Object.defineProperty(venue, 'transport', { value: 'direct-rest' });
    expect(() => new AgentTradeKitCompetitionExecutor({ venue: venue as CompetitionVenue,
      publications: proof(), intents: new IntentStore() })).toThrow(/direct REST/u);
  });
});
