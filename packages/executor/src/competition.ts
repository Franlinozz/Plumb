import {
  COMPETITION_V2_AMENDMENT,
  DEADLINE_CONTINGENCY_AMENDMENT,
  EMERGENCY_PARTICIPATION_AMENDMENT,
  FINAL_WINDOW_CONTINGENCY_AMENDMENT,
  SECOND_ENTRY_AMENDMENT,
  finalizeDecisionEvent,
  type DecisionEvent,
  type Instrument,
} from '@plumb/core';

import type { AtkClient, VenuePosition } from './atk.js';
import { AtkError } from './atk.js';
import { placeBracket } from './bracket.js';
import { toCloseClOrdId } from './clord.js';
import type { IntentStore } from './idempotency.js';

export interface CompetitionPublicationProof {
  isFullyDelivered(event: DecisionEvent): boolean;
}

export interface CompetitionInstrumentMetadata {
  readonly ctVal: number;
  readonly ctMult: number;
  readonly minSz: number;
  readonly lotSz: number;
  /** Venue price increment. Optional only for older injected test doubles. */
  readonly tickSz?: number;
  readonly state: string;
}

export interface CompetitionFeeRates {
  readonly maker: number;
  readonly taker: number;
}

export interface CompetitionVenue extends AtkClient {
  readonly transport: 'agent-trade-kit';
  readonly profileName: string;
  posSideOverride: 'long' | 'short' | 'net' | undefined;
  getAccountConfig(): Promise<{ readonly uid: string; readonly acctLv: string; readonly posMode: string }>;
  getInstrumentMetadata(instId: Instrument): Promise<CompetitionInstrumentMetadata>;
  getFeeRates(instId: Instrument): Promise<CompetitionFeeRates>;
  getLastPrice(instId: Instrument): Promise<number>;
  getLeverage(instId: Instrument): Promise<number>;
  getMaxAvailableSize(instId: Instrument): Promise<{ readonly buy: number; readonly sell: number }>;
}

export interface CompetitionRiskState {
  readonly equityUsd: number;
  readonly availableMarginUsd: number;
  readonly realisedPnlTodayUsd: number;
  readonly drawdownUsd: number;
  readonly concurrentStopRiskUsd: number;
}

export interface CompetitionExecutionInput {
  readonly event: DecisionEvent;
  readonly expectedUid: string;
  readonly ledgerSignedPosition: number;
  readonly risk: CompetitionRiskState;
  /** Previously placed competition entries other than this same idempotent decision. */
  readonly priorLiveEntryCount: number;
  /** Required immediately before the live write; never persisted as a reusable global switch. */
  readonly liveConfirmation: string;
  /** Exact timestamp of the recorded one-shot unattended second-entry authorization. */
  readonly unattendedAuthorizationAt?: number;
  readonly now: number;
}

export interface CompetitionExecutionResult {
  readonly decisionId: string;
  readonly orderId: string;
  readonly contracts: number;
  readonly venueSignedPositionAfter: number;
  readonly reversed: boolean;
}

export interface CompetitionExecutorDeps {
  readonly venue: CompetitionVenue;
  readonly publications: CompetitionPublicationProof;
  readonly intents: IntentStore;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injected wall clock for freshness checks that occur after awaited venue writes. */
  readonly now?: () => number;
}

export class CompetitionExecutionRejected extends Error {
  constructor(readonly reason: string) {
    super(`competition execution rejected: ${reason}`);
    this.name = 'CompetitionExecutionRejected';
  }
}

const signed = (positions: readonly VenuePosition[], instId: Instrument): number => {
  const matching = positions.filter((position) => position.instId === instId && Math.abs(position.pos) > 0);
  if (matching.length > 1) throw new CompetitionExecutionRejected('multiple venue positions for one net-mode instrument');
  const position = matching[0];
  if (position === undefined) return 0;
  if (position.posSide === 'net') return position.pos;
  return position.posSide === 'long' ? Math.abs(position.pos) : -Math.abs(position.pos);
};

const floorToStep = (value: number, step: number): number => {
  const decimals = Math.max(0, (step.toString().split('.')[1] ?? '').length);
  return Number((Math.floor(value / step) * step).toFixed(decimals));
};

export class AgentTradeKitCompetitionExecutor {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly deps: CompetitionExecutorDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = deps.now ?? Date.now;
    if (deps.venue.transport !== 'agent-trade-kit') {
      throw new CompetitionExecutionRejected('direct REST or unknown transport is forbidden');
    }
    if (deps.venue.demo) throw new CompetitionExecutionRejected('competition venue must be the dedicated live profile');
    if (deps.venue.profileName !== 'competition') throw new CompetitionExecutionRejected('wrong Agent Trade Kit profile');
  }

  async execute(input: CompetitionExecutionInput): Promise<CompetitionExecutionResult> {
    const event = finalizeDecisionEvent(input.event);
    const secondEntry = event.approvalBasis === SECOND_ENTRY_AMENDMENT.approvalBasis;
    const deadlineContingency = event.approvalBasis === DEADLINE_CONTINGENCY_AMENDMENT.approvalBasis;
    const finalWindowContingency =
      event.approvalBasis === FINAL_WINDOW_CONTINGENCY_AMENDMENT.approvalBasis;
    const additionalEntry = secondEntry || deadlineContingency || finalWindowContingency;
    const additionalAmendment = finalWindowContingency
      ? FINAL_WINDOW_CONTINGENCY_AMENDMENT
      : deadlineContingency ? DEADLINE_CONTINGENCY_AMENDMENT : SECOND_ENTRY_AMENDMENT;
    const unattended = input.unattendedAuthorizationAt !== undefined;
    if (unattended && (!additionalEntry || input.unattendedAuthorizationAt !==
        additionalAmendment.unattendedExecutionAuthorisedAt)) {
      throw new CompetitionExecutionRejected('unattended authorization is absent, mismatched, or outside its additional-entry scope');
    }
    if (!unattended && input.liveConfirmation !== `CONFIRM LIVE ${event.decisionId}`) {
      throw new CompetitionExecutionRejected('missing decision-specific live-money confirmation');
    }
    if (event.createdAt > input.now) throw new CompetitionExecutionRejected('DecisionEvent is future-dated');
    if (input.now >= event.validUntil) throw new CompetitionExecutionRejected('DecisionEvent is stale');
    if (!Number.isInteger(input.priorLiveEntryCount) || input.priorLiveEntryCount < 0) {
      throw new CompetitionExecutionRejected('prior live-entry count is invalid or uncertain');
    }
    if (additionalEntry) {
      const earliest = secondEntry ? SECOND_ENTRY_AMENDMENT.authorisedAt
        : deadlineContingency ? DEADLINE_CONTINGENCY_AMENDMENT.earliestEntryAt
          : FINAL_WINDOW_CONTINGENCY_AMENDMENT.earliestEntryAt;
      if (input.now < earliest || input.now >= additionalAmendment.latestEntryAt) {
        throw new CompetitionExecutionRejected('outside the authorised additional-entry window');
      }
      if (event.strategyVersion !==
          `${additionalAmendment.strategyId}@${additionalAmendment.strategyVersion}` ||
          event.expectedEdgeBps !== 0) {
        throw new CompetitionExecutionRejected('additional-entry event does not preserve its authorised strategy and evidence limitation');
      }
      if (!(additionalAmendment.instruments as readonly string[]).includes(
        event.instrument,
      )) {
        throw new CompetitionExecutionRejected('additional-entry amendment does not permit this instrument');
      }
      if (input.priorLiveEntryCount !== additionalAmendment.priorLiveEntryCount ||
          input.priorLiveEntryCount >= additionalAmendment.maxTotalLiveEntries) {
        throw new CompetitionExecutionRejected('the one-additional-entry allowance is unavailable or exhausted');
      }
    } else {
      if (input.now < COMPETITION_V2_AMENDMENT.earliestEntryAt ||
          input.now >= COMPETITION_V2_AMENDMENT.latestEntryAt) {
        throw new CompetitionExecutionRejected('outside the operator-authorised first-entry window');
      }
      if (event.instrument !== COMPETITION_V2_AMENDMENT.instrument) {
        throw new CompetitionExecutionRejected('operator amendment permits ETH-USDT-SWAP only');
      }
      if (input.priorLiveEntryCount >= COMPETITION_V2_AMENDMENT.maxLiveEntries) {
        throw new CompetitionExecutionRejected('the one-live-entry allowance is exhausted or uncertain');
      }
    }
    if (!this.deps.publications.isFullyDelivered(event)) {
      throw new CompetitionExecutionRejected('the exact DecisionEvent was not acknowledged by every active subscriber');
    }

    const [account, positions, pendingOrders, metadata, fees, lastPrice, leverage, maxSize, balances] = await Promise.all([
      this.deps.venue.getAccountConfig(),
      this.deps.venue.getPositions(event.instrument),
      this.deps.venue.getOpenOrders(event.instrument),
      this.deps.venue.getInstrumentMetadata(event.instrument),
      this.deps.venue.getFeeRates(event.instrument),
      this.deps.venue.getLastPrice(event.instrument),
      this.deps.venue.getLeverage(event.instrument),
      this.deps.venue.getMaxAvailableSize(event.instrument),
      this.deps.venue.getBalance(),
    ]);
    if (account.uid !== input.expectedUid) throw new CompetitionExecutionRejected('competition account mismatch');
    if (Number(account.acctLv) < 2) throw new CompetitionExecutionRejected('account level cannot trade perpetuals');
    if (account.posMode !== 'net_mode') throw new CompetitionExecutionRejected('only audited net_mode is supported');
    this.deps.venue.posSideOverride = 'net';
    if (pendingOrders.length > 0) throw new CompetitionExecutionRejected('pending orders make account state uncertain');
    if (metadata.state !== 'live' || metadata.ctVal <= 0 || metadata.ctMult <= 0 || metadata.lotSz <= 0) {
      throw new CompetitionExecutionRejected('instrument metadata is missing or invalid');
    }
    if (event.leverage > 3 || leverage > 3) throw new CompetitionExecutionRejected('event or venue leverage exceeds 3x');
    if (lastPrice < event.entryLow || lastPrice > event.entryHigh) {
      throw new CompetitionExecutionRejected('market price is outside the approved entry range');
    }
    const venueEquity = balances.reduce((sum, balance) => sum + Math.max(0, balance.eq), 0);
    const venueAvailable = balances.reduce((sum, balance) => sum + Math.max(0, balance.availEq), 0);
    if (venueEquity <= 0 || Math.abs(venueEquity - input.risk.equityUsd) > 1) {
      throw new CompetitionExecutionRejected('venue equity and risk ledger disagree');
    }
    const verifiedRisk = { ...input.risk, equityUsd: venueEquity,
      availableMarginUsd: Math.min(input.risk.availableMarginUsd, venueAvailable) };
    this.assertRisk(verifiedRisk, event, lastPrice);

    const roundTripFeeBps = Math.max(fees.maker, fees.taker) * 2 * 10_000;
    if (event.expectedCostBps < roundTripFeeBps) {
      throw new CompetitionExecutionRejected('DecisionEvent underestimates the venue round-trip fee');
    }

    let venueSigned = signed(positions, event.instrument);
    if (Math.abs(venueSigned - input.ledgerSignedPosition) > metadata.lotSz / 2 ||
        Math.abs(venueSigned - event.venuePositionBefore) > metadata.lotSz / 2 ||
        Math.abs(input.ledgerSignedPosition - event.ledgerPositionBefore) > metadata.lotSz / 2) {
      throw new CompetitionExecutionRejected('signed venue, ledger, and DecisionEvent positions disagree');
    }
    if (additionalEntry && Math.abs(venueSigned) > metadata.lotSz / 2) {
      throw new CompetitionExecutionRejected('additional-entry instrument must be flat; reversal or increase is forbidden');
    }

    const intendedSign = event.direction === 'long' ? 1 : -1;
    if (Math.sign(venueSigned) === intendedSign && venueSigned !== 0) {
      throw new CompetitionExecutionRejected('same-direction increases require a separately approved event type');
    }

    const contracts = this.contractsFor(event, verifiedRisk, metadata, lastPrice);
    if (event.approvalBasis === EMERGENCY_PARTICIPATION_AMENDMENT.approvalBasis &&
        Math.abs(contracts - metadata.minSz) > metadata.lotSz / 2) {
      throw new CompetitionExecutionRejected('emergency participation event must use exactly the venue minimum lot');
    }
    const availableForSide = event.direction === 'long' ? maxSize.buy : maxSize.sell;
    if (contracts > availableForSide) throw new CompetitionExecutionRejected('approved size exceeds account maximum');
    let reversed = false;
    if (venueSigned !== 0 && Math.sign(venueSigned) !== intendedSign) {
      const close = await this.reduceToZero(event, venueSigned);
      venueSigned = await this.waitForSignedPosition(event.instrument, 0, metadata.lotSz / 2);
      if (Math.abs(venueSigned) > metadata.lotSz / 2) {
        throw new CompetitionExecutionRejected('venue did not reach signed zero before reversal');
      }
      const [closeOrder, closeFills] = await Promise.all([
        this.deps.venue.getOrder(event.instrument, { ordId: close.ordId }),
        this.deps.venue.getFills(event.instrument),
      ]);
      if (closeOrder === undefined || !closeFills.some((fill) => fill.ordId === close.ordId && fill.clOrdId === close.clOrdId)) {
        throw new CompetitionExecutionRejected('reversal close lacks an attributable order/fill acknowledgement');
      }
      if (this.now() >= event.validUntil) throw new CompetitionExecutionRejected('DecisionEvent became stale during reversal');
      reversed = true;
    }

    const result = await placeBracket(
      { signalId: event.decisionId, instId: event.instrument, side: event.direction, sz: contracts,
        stopPrice: event.stopPrice, takeProfitPrice: event.takeProfit, atomic: true, tdMode: 'cross' },
      { client: this.deps.venue, store: this.deps.intents, now: input.now },
    );
    if (!result.placed || result.order === undefined) {
      throw new CompetitionExecutionRejected('entry was not newly placed');
    }
    const order = await this.deps.venue.getOrder(event.instrument, { ordId: result.order.ordId });
    if (order === undefined) throw new CompetitionExecutionRejected('entry order cannot be verified after write');
    const stopObserved = order.slTriggerPx !== undefined || order.attachAlgoId !== undefined;
    const takeProfitObserved = order.tpTriggerPx !== undefined;
    if (!stopObserved || !takeProfitObserved) {
      await this.emergencyReduce(event);
      throw new CompetitionExecutionRejected('attached stop or take-profit absent after entry; emergency reduce submitted');
    }

    const after = await this.waitForSignedPosition(event.instrument, intendedSign * contracts, metadata.lotSz / 2);
    if (Math.abs(after - intendedSign * contracts) > metadata.lotSz / 2) {
      throw new CompetitionExecutionRejected('entry is partial or signed position does not match the approved size');
    }
    const fills = await this.deps.venue.getFills(event.instrument);
    if (!fills.some((fill) => fill.ordId === result.order?.ordId && fill.clOrdId === result.clOrdId)) {
      throw new CompetitionExecutionRejected('no attributable fill found after entry');
    }
    return { decisionId: event.decisionId, orderId: result.order.ordId, contracts,
      venueSignedPositionAfter: after, reversed };
  }

  private assertRisk(risk: CompetitionRiskState, event: DecisionEvent, liveReferencePrice: number): void {
    const caps = event.approvalBasis === FINAL_WINDOW_CONTINGENCY_AMENDMENT.approvalBasis
      ? FINAL_WINDOW_CONTINGENCY_AMENDMENT
      : event.approvalBasis === DEADLINE_CONTINGENCY_AMENDMENT.approvalBasis
        ? DEADLINE_CONTINGENCY_AMENDMENT
      : event.approvalBasis === SECOND_ENTRY_AMENDMENT.approvalBasis
        ? SECOND_ENTRY_AMENDMENT
        : COMPETITION_V2_AMENDMENT;
    if (risk.equityUsd <= 0 || risk.availableMarginUsd < 0) throw new CompetitionExecutionRejected('invalid account equity');
    if (event.riskUsd / risk.equityUsd > 0.01) throw new CompetitionExecutionRejected('risk per trade exceeds 1%');
    if (event.riskUsd > caps.maxStopRiskUsd + 1e-9 ||
        event.positionPct > caps.maxPositionPct + 1e-9) {
      throw new CompetitionExecutionRejected('event exceeds the operator-authorised trade caps');
    }
    const stopDistancePct = Math.abs(liveReferencePrice - event.stopPrice) / liveReferencePrice;
    const notional = event.riskUsd / stopDistancePct;
    const plannedLossUsd = event.riskUsd + notional * event.expectedCostBps / 10_000;
    if (!Number.isFinite(notional) || notional > caps.maxNotionalUsd + 1e-9 ||
        plannedLossUsd > caps.maxPlannedLossUsd + 1e-9) {
      throw new CompetitionExecutionRejected('event exceeds the authorised notional or planned-loss cap');
    }
    if (event.approvalBasis === SECOND_ENTRY_AMENDMENT.approvalBasis ||
        event.approvalBasis === DEADLINE_CONTINGENCY_AMENDMENT.approvalBasis ||
        event.approvalBasis === FINAL_WINDOW_CONTINGENCY_AMENDMENT.approvalBasis) {
      const minProjectedNetTargetUsd = event.approvalBasis === FINAL_WINDOW_CONTINGENCY_AMENDMENT.approvalBasis
        ? FINAL_WINDOW_CONTINGENCY_AMENDMENT.minProjectedNetTargetUsd
        : event.approvalBasis === DEADLINE_CONTINGENCY_AMENDMENT.approvalBasis
          ? DEADLINE_CONTINGENCY_AMENDMENT.minProjectedNetTargetUsd
          : SECOND_ENTRY_AMENDMENT.minProjectedNetTargetUsd;
      const targetDistancePct = Math.abs(event.takeProfit - liveReferencePrice) / liveReferencePrice;
      const projectedNetTargetUsd = notional * targetDistancePct -
        notional * event.expectedCostBps / 10_000;
      if (!Number.isFinite(projectedNetTargetUsd) ||
          projectedNetTargetUsd + 1e-9 < minProjectedNetTargetUsd) {
        throw new CompetitionExecutionRejected('live projected net target is below the authorised minimum');
      }
    }
    if (-risk.realisedPnlTodayUsd / risk.equityUsd >= 0.03) throw new CompetitionExecutionRejected('soft daily loss reached');
    if (risk.drawdownUsd >= 24) throw new CompetitionExecutionRejected('competition drawdown stop reached');
    if (risk.drawdownUsd + event.riskUsd > 30) throw new CompetitionExecutionRejected('30 USDT loss budget would be exceeded');
    if ((risk.concurrentStopRiskUsd + event.riskUsd) / risk.equityUsd > 0.02) {
      throw new CompetitionExecutionRejected('concurrent stop-risk cap reached');
    }
  }

  private contractsFor(event: DecisionEvent, risk: CompetitionRiskState, metadata: CompetitionInstrumentMetadata, price: number): number {
    const stopDistancePct = Math.abs(price - event.stopPrice) / price;
    const notional = event.riskUsd / stopDistancePct;
    const positionPct = (notional / risk.equityUsd) * 100;
    if (Math.abs(positionPct - event.positionPct) > 0.25) {
      throw new CompetitionExecutionRejected('risk sizing and approved position percentage disagree');
    }
    if (notional / event.leverage > risk.availableMarginUsd) throw new CompetitionExecutionRejected('insufficient available margin');
    const contracts = floorToStep(notional / (price * metadata.ctVal * metadata.ctMult), metadata.lotSz);
    if (contracts < metadata.minSz) throw new CompetitionExecutionRejected('approved risk sizes below instrument minimum');
    return contracts;
  }

  private async reduceToZero(event: DecisionEvent, venueSigned: number): Promise<import('./atk.js').OrderRef> {
    return this.deps.venue.placeOrder({
      instId: event.instrument, side: venueSigned > 0 ? 'sell' : 'buy',
      posSide: venueSigned > 0 ? 'long' : 'short', ordType: 'market', sz: Math.abs(venueSigned),
      tdMode: 'cross', clOrdId: toCloseClOrdId(event.decisionId), reduceOnly: true,
    });
  }

  private async emergencyReduce(event: DecisionEvent): Promise<void> {
    const actual = signed(await this.deps.venue.getPositions(event.instrument), event.instrument);
    if (Math.abs(actual) <= 1e-9) return;
    const close = await this.deps.venue.placeOrder({
      instId: event.instrument, side: actual > 0 ? 'sell' : 'buy',
      posSide: actual > 0 ? 'long' : 'short', ordType: 'market', sz: Math.abs(actual), tdMode: 'cross',
      clOrdId: toCloseClOrdId(`E${event.decisionId}`), reduceOnly: true,
    }).catch((error: unknown) => {
      throw new AtkError('rejected', `protective stop absent and emergency reduce failed: ${String(error)}`);
    });
    const flat = await this.waitForSignedPosition(event.instrument, 0, 1e-9);
    const [order, fills] = await Promise.all([
      this.deps.venue.getOrder(event.instrument, { ordId: close.ordId }),
      this.deps.venue.getFills(event.instrument),
    ]);
    if (Math.abs(flat) > 1e-9 || order === undefined ||
        !fills.some((fill) => fill.ordId === close.ordId && fill.clOrdId === close.clOrdId)) {
      throw new AtkError('rejected', 'emergency reduce could not be fully verified');
    }
  }

  private async waitForSignedPosition(instId: Instrument, expected: number, tolerance: number): Promise<number> {
    let actual = Number.NaN;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      actual = signed(await this.deps.venue.getPositions(instId), instId);
      if (Math.abs(actual - expected) <= tolerance) return actual;
      await this.sleep(500);
    }
    return actual;
  }
}
