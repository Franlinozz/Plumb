import {
  decisionPositionsReconciled,
  MIN_EXPECTED_EDGE_COST_MULTIPLE,
  type DecisionEvent,
} from '@plumb/core';

export interface ExecutableSignalGate {
  readonly now: number;
  readonly marketDataAt: number;
  readonly maxMarketAgeMs: number;
  readonly haltFlags: Readonly<Record<string, boolean>>;
  readonly reconciliationHealthy: boolean;
  readonly instrumentMetadataPresent: boolean;
  readonly sizingValid: boolean;
  readonly accountCertain: boolean;
  readonly duplicateDecision: boolean;
}

export class ExecutableSignalRejected extends Error {
  constructor(readonly reason: string) {
    super(`executable signal rejected: ${reason}`);
    this.name = 'ExecutableSignalRejected';
  }
}

const instrument = (instId: DecisionEvent['instrument']): string => instId.replace('-SWAP', '-PERP');
const number = (value: number): string => Number(value.toFixed(8)).toString();

/** Current official Trading Signal v1.2 perpetual grammar (verified 2026-08-18). */
export function validateV12PerpetualSignal(text: string): void {
  if (text.length > 200) throw new ExecutableSignalRejected('signal exceeds 200 characters');
  const shape = /^【Futures】(BTC|ETH|SOL)-USDT-PERP \| (LONG|SHORT) [1-3](?:\.\d+)?x \| Market \| Reference Price \d+(?:\.\d+)? \| Stop Loss \d+(?:\.\d+)? \| Take Profit \d+(?:\.\d+)? \| Position \d+(?:\.\d+)?% \| Valid for \d+(?:min|h)$/u;
  if (!shape.test(text)) throw new ExecutableSignalRejected('signal does not match the v1.2 perpetual format');
}

export function formatDecisionEventForDelivery(event: DecisionEvent, gate: ExecutableSignalGate): string {
  if (event.governorApproved !== true) throw new ExecutableSignalRejected('governor did not approve');
  if (Object.values(gate.haltFlags).some(Boolean)) throw new ExecutableSignalRejected('a halt flag is active');
  if (!gate.reconciliationHealthy || !decisionPositionsReconciled(event)) {
    throw new ExecutableSignalRejected('signed reconciliation is unhealthy');
  }
  if (event.createdAt > gate.now) throw new ExecutableSignalRejected('DecisionEvent is future-dated');
  if (gate.now >= event.validUntil) throw new ExecutableSignalRejected('DecisionEvent is stale');
  if (gate.marketDataAt > gate.now || gate.now - gate.marketDataAt > gate.maxMarketAgeMs) {
    throw new ExecutableSignalRejected('market data is stale or future-dated');
  }
  if (!gate.instrumentMetadataPresent) throw new ExecutableSignalRejected('instrument metadata is missing');
  if (!gate.sizingValid) throw new ExecutableSignalRejected('position sizing is invalid');
  if (event.expectedEdgeBps < event.expectedCostBps * MIN_EXPECTED_EDGE_COST_MULTIPLE) {
    throw new ExecutableSignalRejected('cost gate failed');
  }
  if (gate.duplicateDecision) throw new ExecutableSignalRejected('duplicate decisionId');
  if (!gate.accountCertain) throw new ExecutableSignalRejected('account state is uncertain');

  const remainingMs = event.validUntil - gate.now;
  const validity = remainingMs < 3_600_000
    ? `${Math.max(1, Math.floor(remainingMs / 60_000))}min`
    : `${Math.floor(remainingMs / 3_600_000)}h`;
  const referencePrice = (event.entryLow + event.entryHigh) / 2;
  const text =
    `【Futures】${instrument(event.instrument)} | ${event.direction.toUpperCase()} ${number(event.leverage)}x | ` +
    `Market | Reference Price ${number(referencePrice)} | Stop Loss ${number(event.stopPrice)} | ` +
    `Take Profit ${number(event.takeProfit)} | Position ${number(event.positionPct)}% | Valid for ${validity}`;
  validateV12PerpetualSignal(text);
  return text;
}
