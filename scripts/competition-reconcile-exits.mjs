#!/usr/bin/env node
/** Reconcile venue-native competition TP/SL exits into the signed local ledger. No venue writes. */

import { execFileSync } from 'node:child_process';

import { CliAtkClient, CompetitionLedgerStore, IntentStore } from '@plumb/executor';

const expectedUid = process.env.PLUMB_COMPETITION_UID?.trim() ?? '';
if (!/^\d+$/u.test(expectedUid)) throw new Error('PLUMB_COMPETITION_UID is required outside the repository');

const stateDir = process.env.PLUMB_COMPETITION_STATE_DIR ?? '/var/lib/plumb-okxai';
const cleanEnv = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !/^OKX_(API_KEY|API_SECRET|API_PASSPHRASE)$/u.test(key)));
const venue = new CliAtkClient({ demo: false, allowLive: true, profile: 'competition', timeoutMs: 60_000 });
const ledger = new CompetitionLedgerStore(`${stateDir}/competition-ledger.db`);
const intents = new IntentStore(`${stateDir}/competition-intents.db`);

const raw = (args) => JSON.parse(execFileSync('okx', [
  '--profile', 'competition', '--live', '--json', ...args,
], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'], env: cleanEnv }));
const rows = (payload) => Array.isArray(payload) ? payload : (payload?.data ?? []);
const signed = (positions, instId) => positions.filter((position) => position.instId === instId)
  .reduce((sum, position) => sum + (position.posSide === 'net' ? position.pos
    : position.posSide === 'long' ? Math.abs(position.pos) : -Math.abs(position.pos)), 0);

try {
  const [account, positions] = await Promise.all([venue.getAccountConfig(), venue.getPositions()]);
  if (account.uid !== expectedUid || account.posMode !== 'net_mode') {
    throw new Error('competition identity or net-mode preflight failed during exit reconciliation');
  }

  const plans = [];
  for (const instrument of ['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP']) {
    const recorded = ledger.get(instrument);
    if (recorded === undefined || Math.abs(recorded.signedPosition) <= 1e-9) continue;
    const venueSigned = signed(positions, instrument);
    if (Math.abs(venueSigned - recorded.signedPosition) <= 1e-9) continue;
    if (Math.abs(venueSigned) > 1e-9) {
      throw new Error(`non-flat signed mismatch on ${instrument}; automatic reconciliation forbidden`);
    }

    const intent = [...intents.all()].reverse().find((candidate) => candidate.status === 'placed' &&
      candidate.instId === instrument && candidate.signalId === recorded.decisionId &&
      candidate.ordId === recorded.orderId);
    if (intent === undefined || intent.ordId === undefined) {
      throw new Error(`flat ${instrument} lacks its exact durable entry intent`);
    }
    const [entryOrder, fills, algoPayload, historyPayload] = await Promise.all([
      venue.getOrder(instrument, { ordId: intent.ordId }),
      venue.getFills(instrument),
      Promise.resolve(raw(['swap', 'algo', 'orders', '--instId', instrument, '--history'])),
      Promise.resolve(raw(['account', 'positions-history', '--instType', 'SWAP', '--instId', instrument, '--limit', '20'])),
    ]);
    if (entryOrder === undefined || entryOrder.state !== 'filled') {
      throw new Error(`${instrument} entry order is absent or was not filled`);
    }
    const entryFill = fills.find((fill) => fill.ordId === intent.ordId && fill.clOrdId === intent.clOrdId);
    if (entryFill === undefined) throw new Error(`${instrument} entry fill is not attributable`);

    const expectedSide = recorded.signedPosition > 0 ? 'sell' : 'buy';
    const algo = rows(algoPayload).find((candidate) =>
      candidate.instId === instrument && ['tp', 'sl'].includes(candidate.actualSide) &&
      candidate.state === 'effective' && candidate.side === expectedSide &&
      candidate.reduceOnly === 'true' &&
      Math.abs(Number(candidate.actualSz) - Math.abs(recorded.signedPosition)) <= 1e-9 &&
      Number(candidate.triggerTime) >= entryFill.ts &&
      (candidate.ordIdList ?? [candidate.ordId]).some((orderId) =>
        fills.some((fill) => fill.ordId === orderId && fill.side === expectedSide &&
          Math.abs(fill.fillSz - Math.abs(recorded.signedPosition)) <= 1e-9)));
    if (algo === undefined) throw new Error(`${instrument} flat state lacks an attributable native TP/SL execution`);
    const exitOrderId = String((algo.ordIdList ?? [algo.ordId])[0]);
    const exitFill = fills.find((fill) => fill.ordId === exitOrderId && fill.side === expectedSide);
    if (exitFill === undefined) throw new Error(`${instrument} protective exit fill is absent`);

    const history = rows(historyPayload).find((position) => position.instId === instrument &&
      position.direction === (recorded.signedPosition > 0 ? 'long' : 'short') &&
      Math.abs(Number(position.closeTotalPos) - Math.abs(recorded.signedPosition)) <= 1e-9 &&
      Math.abs(Number(position.uTime) - Number(algo.triggerTime)) <= 5_000);
    if (history === undefined) throw new Error(`${instrument} closed-position history does not match the protective exit`);
    plans.push({ instrument, recorded, exitOrderId, exitKind: algo.actualSide,
      exitPrice: Number(exitFill.fillPx), realisedPnl: Number(history.realizedPnl),
      closedAt: Number(history.uTime) });
  }

  for (const plan of plans) {
    ledger.set({ instrument: plan.instrument, signedPosition: 0,
      decisionId: plan.recorded.decisionId, orderId: plan.exitOrderId, updatedAt: plan.closedAt });
    intents.append({ ts: plan.closedAt, kind: 'competition_protective_exit_reconciled',
      signalId: plan.recorded.decisionId, instId: plan.instrument,
      detail: JSON.stringify({ exitOrderId: plan.exitOrderId, exitKind: plan.exitKind,
        exitPrice: plan.exitPrice, realisedPnl: plan.realisedPnl }) });
  }
  console.log(JSON.stringify({ event: 'competition_exit_reconciliation_complete',
    reconciled: plans.map(({ instrument, recorded, exitOrderId, exitKind, exitPrice, realisedPnl, closedAt }) => ({
      instrument, decisionId: recorded.decisionId, exitOrderId, exitKind, exitPrice, realisedPnl,
      closedAt: new Date(closedAt).toISOString(),
    })) }));
} finally {
  intents.close();
  ledger.close();
}
