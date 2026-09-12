import {
  DEADLINE_CONTINGENCY_AMENDMENT,
  FINAL_WINDOW_CONTINGENCY_AMENDMENT,
  SECOND_ENTRY_AMENDMENT,
  finalizeDecisionEvent,
  type DecisionEvent,
  type Instrument,
} from '@plumb/core';

import type { CompetitionLedgerStore } from './competition-ledger.js';
import { CompetitionExecutionRejected, type CompetitionPublicationProof, type CompetitionVenue } from './competition.js';
import type { IntentStore } from './idempotency.js';
import { toCloseClOrdId } from './clord.js';

export interface CompetitionTimeStopDeps {
  readonly venue: CompetitionVenue;
  readonly publications: CompetitionPublicationProof;
  readonly intents: IntentStore;
  readonly ledger: CompetitionLedgerStore;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface CompetitionTimeStopResult {
  readonly decisionId: string;
  readonly instrument: Instrument;
  readonly closed: boolean;
  readonly alreadyClosed: boolean;
  readonly orderId?: string;
}

const signed = (positions: Awaited<ReturnType<CompetitionVenue['getPositions']>>, instrument: Instrument): number =>
  positions.filter((position) => position.instId === instrument).reduce((sum, position) =>
    sum + (position.posSide === 'net' ? position.pos
      : position.posSide === 'long' ? Math.abs(position.pos) : -Math.abs(position.pos)), 0);

export class CompetitionTimeStopExecutor {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: CompetitionTimeStopDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    if (deps.venue.transport !== 'agent-trade-kit' || deps.venue.demo ||
        deps.venue.profileName !== 'competition') {
      throw new CompetitionExecutionRejected('time stop requires the dedicated live Agent Trade Kit profile');
    }
  }

  async execute(input: { readonly event: DecisionEvent; readonly expectedUid: string;
    readonly now: number }): Promise<CompetitionTimeStopResult> {
    const event = finalizeDecisionEvent(input.event);
    const secondEntry = event.approvalBasis === SECOND_ENTRY_AMENDMENT.approvalBasis &&
      SECOND_ENTRY_AMENDMENT.instruments.includes(
        event.instrument as (typeof SECOND_ENTRY_AMENDMENT.instruments)[number],
      );
    const deadlineContingency = event.approvalBasis === DEADLINE_CONTINGENCY_AMENDMENT.approvalBasis &&
      DEADLINE_CONTINGENCY_AMENDMENT.instruments.includes(
        event.instrument as (typeof DEADLINE_CONTINGENCY_AMENDMENT.instruments)[number],
      );
    const finalWindowContingency =
      event.approvalBasis === FINAL_WINDOW_CONTINGENCY_AMENDMENT.approvalBasis &&
      FINAL_WINDOW_CONTINGENCY_AMENDMENT.instruments.includes(
        event.instrument as (typeof FINAL_WINDOW_CONTINGENCY_AMENDMENT.instruments)[number],
      );
    if (!secondEntry && !deadlineContingency && !finalWindowContingency) {
      throw new CompetitionExecutionRejected('time stop is scoped only to the authorised additional entry');
    }
    const hardExitAt = finalWindowContingency ? FINAL_WINDOW_CONTINGENCY_AMENDMENT.hardExitAt
      : deadlineContingency ? DEADLINE_CONTINGENCY_AMENDMENT.hardExitAt
        : SECOND_ENTRY_AMENDMENT.hardExitAt;
    if (input.now < hardExitAt) {
      return { decisionId: event.decisionId, instrument: event.instrument,
        closed: false, alreadyClosed: false };
    }
    if (!this.deps.publications.isFullyDelivered(event)) {
      throw new CompetitionExecutionRejected('time-stop event lacks complete original A2A acknowledgement');
    }

    const [account, positions, metadata] = await Promise.all([
      this.deps.venue.getAccountConfig(), this.deps.venue.getPositions(event.instrument),
      this.deps.venue.getInstrumentMetadata(event.instrument),
    ]);
    if (account.uid !== input.expectedUid || account.posMode !== 'net_mode') {
      throw new CompetitionExecutionRejected('competition identity or net mode changed before time stop');
    }
    this.deps.venue.posSideOverride = 'net';
    const venueSigned = signed(positions, event.instrument);
    const recorded = this.deps.ledger.get(event.instrument);
    if (recorded === undefined || recorded.decisionId !== event.decisionId) {
      throw new CompetitionExecutionRejected('time stop lacks the exact signed-ledger decision');
    }
    if (Math.abs(venueSigned - recorded.signedPosition) > metadata.lotSz / 2) {
      throw new CompetitionExecutionRejected('time-stop venue and signed ledger disagree');
    }
    if (Math.abs(venueSigned) <= metadata.lotSz / 2) {
      return { decisionId: event.decisionId, instrument: event.instrument,
        closed: false, alreadyClosed: true };
    }
    if (Math.sign(venueSigned) !== (event.direction === 'long' ? 1 : -1)) {
      throw new CompetitionExecutionRejected('time-stop position direction disagrees with DecisionEvent');
    }

    const clOrdId = toCloseClOrdId(`T${event.decisionId}`);
    const recordedIntent = this.deps.intents.recordIntent({
      signalId: event.decisionId, clOrdId, instId: event.instrument,
      side: venueSigned > 0 ? 'sell' : 'buy', posSide: venueSigned > 0 ? 'long' : 'short',
      sz: Math.abs(venueSigned), stopPrice: event.stopPrice, createdAt: input.now,
    }, input.now);
    if (recordedIntent.alreadyExisted) {
      const prior = await this.deps.venue.getOrder(event.instrument, { clOrdId });
      if (prior === undefined || prior.state !== 'filled') {
        throw new CompetitionExecutionRejected('existing time-stop intent is uncertain; automatic retry forbidden');
      }
      return this.verifyAndPersist(event, prior.ordId, clOrdId, metadata.lotSz, true);
    }

    const order = await this.deps.venue.placeOrder({
      instId: event.instrument, side: venueSigned > 0 ? 'sell' : 'buy',
      posSide: venueSigned > 0 ? 'long' : 'short', ordType: 'market', sz: Math.abs(venueSigned),
      tdMode: 'cross', clOrdId, reduceOnly: true,
    });
    this.deps.intents.markPlaced(clOrdId, order.ordId, Date.now());
    return this.verifyAndPersist(event, order.ordId, clOrdId, metadata.lotSz, false);
  }

  private async verifyAndPersist(event: DecisionEvent, orderId: string, clOrdId: string,
    tolerance: number, replay: boolean): Promise<CompetitionTimeStopResult> {
    let after = Number.NaN;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      after = signed(await this.deps.venue.getPositions(event.instrument), event.instrument);
      if (Math.abs(after) <= tolerance / 2) break;
      await this.sleep(500);
    }
    const [order, fills] = await Promise.all([
      this.deps.venue.getOrder(event.instrument, { ordId: orderId }),
      this.deps.venue.getFills(event.instrument),
    ]);
    const expectedSide = event.direction === 'long' ? 'sell' : 'buy';
    const expectedSize = Math.abs(this.deps.ledger.get(event.instrument)?.signedPosition ?? 0);
    if (Math.abs(after) > tolerance / 2 || order?.state !== 'filled' ||
        !fills.some((fill) => fill.ordId === orderId && fill.clOrdId === clOrdId &&
          fill.instId === event.instrument && fill.side === expectedSide &&
          Math.abs(fill.fillSz - expectedSize) <= tolerance / 2)) {
      throw new CompetitionExecutionRejected('time-stop close is not fully filled, flat and attributable');
    }
    this.deps.ledger.set({ instrument: event.instrument, signedPosition: 0,
      decisionId: event.decisionId, orderId, updatedAt: Date.now() });
    this.deps.intents.append({ ts: Date.now(), kind: 'competition_time_stop_reconciled',
      signalId: event.decisionId, instId: event.instrument,
      detail: JSON.stringify({ orderId, replay }) });
    return { decisionId: event.decisionId, instrument: event.instrument,
      closed: true, alreadyClosed: replay, orderId };
  }
}
