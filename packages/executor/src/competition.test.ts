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

const NOW = Date.parse('2026-08-20T12:00:00Z');
const SECOND_NOW = Date.parse('2026-08-21T16:00:00Z');
const event = finalizeDecisionEvent({
  decisionId: 'DEC-COMPETE0001', strategyVersion: 'momentum-v1', createdAt: NOW - 1_000,
  validUntil: NOW + 60_000, instrument: 'ETH-USDT-SWAP', direction: 'long',
  entryLow: 1_900, entryHigh: 1_901, stopPrice: 1_890, takeProfit: 1_920,
  positionPct: 9.5, leverage: 2, riskUsd: 0.2, expectedCostBps: 12, expectedEdgeBps: 40,
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
    return { ctVal: 0.1, ctMult: 1, minSz: 0.01, lotSz: 0.01, state: 'live' };
  }
  async getFeeRates() { return { maker: 0.0002, taker: 0.0005 }; }
  async getLastPrice() { return 1_900; }
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
  priorLiveEntryCount: 0,
  liveConfirmation: `CONFIRM LIVE ${candidate.decisionId}`, now: NOW,
});

const executor = (venue = new CompetitionMock(), publications = proof(), now = () => NOW) =>
  new AgentTradeKitCompetitionExecutor({ venue, publications, intents: new IntentStore(), sleep: async () => {}, now });

describe('AgentTradeKitCompetitionExecutor', () => {
  it('executes a flat approved event only after exact A2A delivery proof', async () => {
    const venue = new CompetitionMock();
    const result = await executor(venue).execute(input());
    expect(result).toMatchObject({ decisionId: event.decisionId, contracts: 0.2, reversed: false,
      venueSignedPositionAfter: 0.2 });
    expect(venue.placed[0]).toMatchObject({
      clOrdId: 'DECCOMPETE0001', slTriggerPx: 1_890, tpTriggerPx: 1_920,
    });
  });

  it('permits an emergency event only at exactly the venue minimum lot', async () => {
    const minimum = finalizeDecisionEvent({
      ...event,
      decisionId: 'DEC-EMERGENCY01',
      strategyVersion: 'emergency_participation@1.0.0',
      positionPct: 0.475,
      riskUsd: 0.01,
      expectedEdgeBps: 0,
      approvalBasis: 'operator-emergency-participation',
    });
    await expect(executor(new CompetitionMock(), proof(minimum)).execute(input(minimum)))
      .resolves.toMatchObject({ contracts: 0.01 });

    const oversized = finalizeDecisionEvent({
      ...minimum, decisionId: 'DEC-EMERGENCY02', positionPct: 0.95, riskUsd: 0.02,
    });
    await expect(executor(new CompetitionMock(), proof(oversized)).execute(input(oversized)))
      .rejects.toThrow(/minimum lot/u);
  });

  it('executes exactly one flat BTC/SOL evidence-limited second entry', async () => {
    const second = finalizeDecisionEvent({
      ...event,
      decisionId: 'DEC-SECONDENTRY1',
      strategyVersion: 'competition_trend_pullback@3.0.0',
      createdAt: SECOND_NOW - 1_000,
      validUntil: SECOND_NOW + 60_000,
      instrument: 'BTC-USDT-SWAP',
      entryLow: 75_990,
      entryHigh: 76_010,
      stopPrice: 74_500,
      takeProfit: 78_250,
      positionPct: 19,
      leverage: 3,
      riskUsd: 1.5,
      expectedCostBps: 12.2,
      expectedEdgeBps: 0,
      approvalBasis: 'operator-evidence-limited-v3',
    });
    class SecondEntryVenue extends CompetitionMock {
      override async getInstrumentMetadata() {
        return { ctVal: 0.01, ctMult: 1, minSz: 0.01, lotSz: 0.01, state: 'live' };
      }
      override async getLastPrice() { return 76_000; }
      override async getLeverage() { return 3; }
    }
    const secondInput = {
      ...input(second), now: SECOND_NOW, priorLiveEntryCount: 1,
      liveConfirmation: `CONFIRM LIVE ${second.decisionId}`,
    };
    const venue = new SecondEntryVenue();
    await expect(executor(venue, proof(second), () => SECOND_NOW).execute(secondInput))
      .resolves.toMatchObject({ decisionId: second.decisionId, contracts: 0.1, reversed: false });

    await expect(executor(new SecondEntryVenue(), proof(second), () => SECOND_NOW)
      .execute({ ...secondInput, priorLiveEntryCount: 0 })).rejects.toThrow(/additional-entry allowance/u);
    await expect(executor(new SecondEntryVenue(), proof(second), () => SECOND_NOW)
      .execute({ ...secondInput, priorLiveEntryCount: 2 })).rejects.toThrow(/additional-entry allowance/u);
  });

  it('forbids a second-entry increase or reversal on an occupied instrument', async () => {
    const second = finalizeDecisionEvent({
      ...event,
      decisionId: 'DEC-SECONDENTRY2',
      strategyVersion: 'competition_trend_pullback@3.0.0',
      createdAt: SECOND_NOW - 1_000,
      validUntil: SECOND_NOW + 60_000,
      instrument: 'BTC-USDT-SWAP',
      entryLow: 75_990,
      entryHigh: 76_010,
      stopPrice: 74_500,
      takeProfit: 78_250,
      positionPct: 19,
      leverage: 3,
      riskUsd: 1.5,
      expectedCostBps: 12.2,
      expectedEdgeBps: 0,
      approvalBasis: 'operator-evidence-limited-v3',
      venuePositionBefore: 0.1,
      ledgerPositionBefore: 0.1,
    });
    class OccupiedSecondVenue extends CompetitionMock {
      constructor() {
        super();
        this.setPosition('BTC-USDT-SWAP', 0.1, 'net');
      }
      override async getInstrumentMetadata() {
        return { ctVal: 0.01, ctMult: 1, minSz: 0.01, lotSz: 0.01, state: 'live' };
      }
      override async getLastPrice() { return 76_000; }
      override async getLeverage() { return 3; }
    }
    const candidate = { ...input(second), now: SECOND_NOW, priorLiveEntryCount: 1,
      liveConfirmation: `CONFIRM LIVE ${second.decisionId}` };
    const venue = new OccupiedSecondVenue();
    await expect(executor(venue, proof(second), () => SECOND_NOW).execute(candidate))
      .rejects.toThrow(/must be flat/u);
    expect(venue.placed).toHaveLength(0);
  });

  it('does not let the second-entry approval basis disguise another strategy or claimed edge', async () => {
    const disguised = {
      ...event,
      decisionId: 'DEC-SECONDENTRY3',
      strategyVersion: 'unfrozen-discretion@9.9.9',
      createdAt: SECOND_NOW - 1_000,
      validUntil: SECOND_NOW + 60_000,
      instrument: 'BTC-USDT-SWAP',
      entryLow: 75_990,
      entryHigh: 76_010,
      stopPrice: 74_500,
      takeProfit: 78_250,
      positionPct: 19,
      leverage: 3,
      riskUsd: 1.5,
      expectedCostBps: 12.2,
      expectedEdgeBps: 40,
      approvalBasis: 'operator-evidence-limited-v3',
    } as DecisionEvent;
    const venue = new CompetitionMock();
    await expect(executor(venue, proof(disguised), () => SECOND_NOW).execute({
      ...input(disguised), now: SECOND_NOW, priorLiveEntryCount: 1,
      liveConfirmation: `CONFIRM LIVE ${disguised.decisionId}`,
    })).rejects.toThrow(/evidence-limited v3/u);
    expect(venue.placed).toHaveLength(0);
  });

  it('closes to signed zero before reversing in net_mode', async () => {
    const venue = new CompetitionMock();
    venue.setPosition(event.instrument, -0.1, 'net');
    const reversal = finalizeDecisionEvent({ ...event, decisionId: 'DEC-COMPETE0002',
      venuePositionBefore: -0.1, ledgerPositionBefore: -0.1 });
    const result = await executor(venue, proof(reversal)).execute(input(reversal));
    expect(result.reversed).toBe(true);
    expect(venue.placed[0]).toMatchObject({ side: 'buy', sz: 0.1, reduceOnly: true });
    expect(venue.placed[1]).toMatchObject({
      side: 'buy', sz: 0.2, slTriggerPx: 1_890, tpTriggerPx: 1_920,
    });
  });

  it('does not open the reversal when the event expires after reaching signed zero', async () => {
    const venue = new CompetitionMock();
    venue.setPosition(event.instrument, -0.1, 'net');
    const reversal = finalizeDecisionEvent({ ...event, decisionId: 'DEC-COMPETE0003',
      venuePositionBefore: -0.1, ledgerPositionBefore: -0.1 });
    await expect(executor(venue, proof(reversal), () => reversal.validUntil).execute(input(reversal)))
      .rejects.toThrow(/stale during reversal/u);
    expect(venue.placed).toHaveLength(1);
    expect(venue.placed[0]).toMatchObject({ reduceOnly: true });
    expect(await venue.getPositions(event.instrument)).toMatchObject([{ pos: 0 }]);
  });

  it.each([
    ['missing publication proof', { publications: { isFullyDelivered: () => false } }],
    ['missing live confirmation', { override: { liveConfirmation: 'no' } }],
    ['daily loss', { override: { risk: { ...input().risk, realisedPnlTodayUsd: -12 } } }],
    ['drawdown stop', { override: { risk: { ...input().risk, drawdownUsd: 24 } } }],
    ['concurrent risk', { override: { risk: { ...input().risk, concurrentStopRiskUsd: 8 } } }],
    ['prior live entry', { override: { priorLiveEntryCount: 1 } }],
    ['outside entry window', { override: { now: Date.parse('2026-08-19T19:00:00Z') } }],
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
    venue.setPosition(event.instrument, -0.2, 'net');
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
    await expect(executor(venue).execute(input())).rejects.toThrow(/stop or take-profit absent/u);
    expect(venue.placed.at(-1)).toMatchObject({ reduceOnly: true });
  });

  it('emergency-reduces and fails when the DecisionEvent take-profit is absent', async () => {
    const venue = new CompetitionMock();
    const original = venue.getOrder.bind(venue);
    venue.getOrder = async (...args): Promise<VenueOrder | undefined> => {
      const order = await original(...args);
      if (order === undefined) return undefined;
      const { tpTriggerPx: _target, ...withoutTarget } = order;
      return withoutTarget;
    };
    await expect(executor(venue).execute(input())).rejects.toThrow(/stop or take-profit absent/u);
    expect(venue.placed.at(-1)).toMatchObject({ reduceOnly: true });
  });

  it('emergency-reduces the actual partial fill, never the larger requested size', async () => {
    class PartialWithoutTargetVenue extends CompetitionMock {
      override async placeOrder(request: PlaceOrderRequest): Promise<OrderRef> {
        const result = await super.placeOrder(request);
        if (request.reduceOnly !== true) {
          this.setPosition(request.instId, (request.side === 'buy' ? 1 : -1) * request.sz / 2, 'net');
        }
        return result;
      }

      override async getOrder(...args: Parameters<CompetitionMock['getOrder']>): Promise<VenueOrder | undefined> {
        const order = await super.getOrder(...args);
        if (order === undefined) return undefined;
        const { tpTriggerPx: _target, ...withoutTarget } = order;
        return withoutTarget;
      }
    }
    const venue = new PartialWithoutTargetVenue();
    await expect(executor(venue).execute(input())).rejects.toThrow(/stop or take-profit absent/u);
    expect(venue.placed.at(-1)).toMatchObject({ reduceOnly: true, sz: 0.1 });
    expect(await venue.getPositions(event.instrument)).toMatchObject([{ pos: 0 }]);
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
