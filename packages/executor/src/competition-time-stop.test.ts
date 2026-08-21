import { describe, expect, it } from 'vitest';

import { SECOND_ENTRY_AMENDMENT, finalizeDecisionEvent } from '@plumb/core';

import type { OrderRef, PlaceOrderRequest } from './atk.js';
import { type CompetitionVenue } from './competition.js';
import { CompetitionLedgerStore } from './competition-ledger.js';
import { CompetitionTimeStopExecutor } from './competition-time-stop.js';
import { IntentStore } from './idempotency.js';
import { MockAtk } from './mock.js';

const event = finalizeDecisionEvent({
  decisionId: 'DEC-TIMESTOP01', strategyVersion: 'competition_trend_pullback@3.0.0',
  createdAt: SECOND_ENTRY_AMENDMENT.latestEntryAt - 60_000,
  validUntil: SECOND_ENTRY_AMENDMENT.latestEntryAt,
  instrument: 'BTC-USDT-SWAP', direction: 'long', entryLow: 75_900, entryHigh: 76_100,
  stopPrice: 74_500, takeProfit: 78_250, positionPct: 20, leverage: 3, riskUsd: 1.5,
  expectedCostBps: 12, expectedEdgeBps: 0, governorApproved: true,
  venuePositionBefore: 0, ledgerPositionBefore: 0, reconciliationVersion: 'signed-v2',
  approvalBasis: SECOND_ENTRY_AMENDMENT.approvalBasis,
});

class TimeStopVenue extends MockAtk implements CompetitionVenue {
  override readonly demo = false;
  readonly transport = 'agent-trade-kit' as const;
  readonly profileName = 'competition';
  posSideOverride: 'long' | 'short' | 'net' | undefined;
  async getAccountConfig() { return { uid: 'uid', acctLv: '2', posMode: 'net_mode' }; }
  async getInstrumentMetadata() {
    return { ctVal: 0.01, ctMult: 1, minSz: 0.01, lotSz: 0.01, state: 'live' };
  }
  async getFeeRates() { return { maker: 0.0002, taker: 0.0005 }; }
  async getLastPrice() { return 76_000; }
  async getLeverage() { return 3; }
  async getMaxAvailableSize() { return { buy: 10, sell: 10 }; }
  override async placeOrder(request: PlaceOrderRequest): Promise<OrderRef> {
    const result = await super.placeOrder(request);
    if (request.reduceOnly === true) this.clearPositions();
    return result;
  }
}

const setup = () => {
  const venue = new TimeStopVenue();
  venue.setPosition(event.instrument, 0.1, 'net');
  const ledger = new CompetitionLedgerStore();
  ledger.set({ instrument: event.instrument, signedPosition: 0.1,
    decisionId: event.decisionId, orderId: 'ENTRY1', updatedAt: event.createdAt });
  const intents = new IntentStore();
  const executor = new CompetitionTimeStopExecutor({ venue, ledger, intents,
    publications: { isFullyDelivered: (candidate) => candidate.decisionId === event.decisionId },
    sleep: async () => {} });
  return { venue, ledger, intents, executor };
};

describe('CompetitionTimeStopExecutor', () => {
  it('does nothing before the authorised hard exit', async () => {
    const { venue, ledger, intents, executor } = setup();
    await expect(executor.execute({ event, expectedUid: 'uid',
      now: SECOND_ENTRY_AMENDMENT.hardExitAt - 1 })).resolves.toMatchObject({ closed: false });
    expect(venue.placed).toHaveLength(0);
    ledger.close(); intents.close();
  });

  it('closes once through an attributable reduce-only Agent Trade Kit order', async () => {
    const { venue, ledger, intents, executor } = setup();
    const result = await executor.execute({ event, expectedUid: 'uid',
      now: SECOND_ENTRY_AMENDMENT.hardExitAt });
    expect(result).toMatchObject({ closed: true, alreadyClosed: false });
    expect(venue.placed).toHaveLength(1);
    expect(venue.placed[0]).toMatchObject({ side: 'sell', sz: 0.1, reduceOnly: true });
    expect(ledger.get(event.instrument)?.signedPosition).toBe(0);
    expect(intents.ledger()).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'competition_time_stop_reconciled', signalId: event.decisionId }),
    ]));
    ledger.close(); intents.close();
  });

  it('fails closed on a signed mismatch and never places', async () => {
    const { venue, ledger, intents, executor } = setup();
    venue.setPosition(event.instrument, -0.1, 'net');
    await expect(executor.execute({ event, expectedUid: 'uid',
      now: SECOND_ENTRY_AMENDMENT.hardExitAt })).rejects.toThrow(/signed ledger disagree/u);
    expect(venue.placed).toHaveLength(0);
    ledger.close(); intents.close();
  });
});
