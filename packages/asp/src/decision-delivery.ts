import {
  decisionPositionsReconciled,
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

const instrument = (instId: DecisionEvent['instrument']): string => instId.replace('-USDT-SWAP', '-PERP');
const number = (value: number): string => Number(value.toFixed(8)).toString();

export function validateV11PerpetualSignal(text: string): void {
  if (text.length > 200) throw new ExecutableSignalRejected('signal exceeds 200 characters');
  const shape = /^\[Perpetual Signal\] (BTC|ETH|SOL)-PERP \| (LONG|SHORT) [0-3](?:\.\d+)?x \| Entry \d+(?:\.\d+)?-\d+(?:\.\d+)? \| SL \d+(?:\.\d+)? \| TP1 \d+(?:\.\d+)? \| Position \d+(?:\.\d+)?% \| Valid for \d+h \| Decision DEC-[A-Za-z0-9_-]+$/u;
  if (!shape.test(text)) throw new ExecutableSignalRejected('signal does not match the V1.1 perpetual format');
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
  if (event.expectedEdgeBps <= event.expectedCostBps) throw new ExecutableSignalRejected('cost gate failed');
  if (gate.duplicateDecision) throw new ExecutableSignalRejected('duplicate decisionId');
  if (!gate.accountCertain) throw new ExecutableSignalRejected('account state is uncertain');

  const hours = Math.max(1, Math.ceil((event.validUntil - gate.now) / 3_600_000));
  const text =
    `[Perpetual Signal] ${instrument(event.instrument)} | ${event.direction.toUpperCase()} ${number(event.leverage)}x | ` +
    `Entry ${number(event.entryLow)}-${number(event.entryHigh)} | SL ${number(event.stopPrice)} | ` +
    `TP1 ${number(event.takeProfit)} | Position ${number(event.positionPct)}% | Valid for ${hours}h | ` +
    `Decision ${event.decisionId}`;
  validateV11PerpetualSignal(text);
  return text;
}
