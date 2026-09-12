#!/usr/bin/env node
/** One-shot development-only measurement of the frozen operator contingency. No tuning. */

import { writeFileSync } from 'node:fs';

import { LOCKED } from '@plumb/core';
import { CandleStore } from '@plumb/market';
import {
  DEADLINE_CONTINGENCY_ID,
  DEFAULT_STRATEGY_CONFIG,
  STRATEGY_IDS,
  deadlineContingency,
} from '@plumb/strategy';
import { DEFAULT_COSTS, partition, runWalkForward } from '@plumb/backtest';

const instruments = ['ETH-USDT-SWAP', 'SOL-USDT-SWAP'];
const store = new CandleStore(process.env.PLUMB_DB_PATH ?? '/root/plumb/data/plumb.db');
const allCandles = {};
const funding = {};
for (const instrument of instruments) {
  allCandles[instrument] = store.getCandles(instrument, '1H');
  funding[instrument] = {
    instId: instrument,
    entries: store.getFundingRates(instrument).map((row) => ({
      fundingTime: row.fundingTime,
      fundingRate: row.fundingRate,
    })),
  };
}
store.close();
const dataFrom = Math.min(...Object.values(allCandles).map((rows) => rows[0].ts));
const dataTo = Math.max(...Object.values(allCandles).map((rows) => rows.at(-1).ts));
const protectedSplit = partition(dataFrom, dataTo);
const candles = Object.fromEntries(instruments.map((instrument) => [
  instrument,
  allCandles[instrument].filter((row) => row.ts <= protectedSplit.developmentTo),
]));
const enabled = Object.fromEntries([
  ...STRATEGY_IDS.map((id) => [id, false]),
  [DEADLINE_CONTINGENCY_ID, true],
]);
const config = {
  ...DEFAULT_STRATEGY_CONFIG,
  enabled,
  gate: { ...DEFAULT_STRATEGY_CONFIG.gate, minRegimeConfidence: 0 },
  takeProfitR: [1.5],
  maxHoldBars: 24,
  expiryBars: 1,
};
const walkForward = runWalkForward({
  label: 'deadline-contingency-v1-audit',
  candles,
  funding,
  timeframe: '1H',
  startingEquity: LOCKED.CAPITAL_USDT,
  strategyConfig: config,
  modules: [deadlineContingency],
  costs: DEFAULT_COSTS,
  split: { inSampleDays: 60, outOfSampleDays: 20, stepDays: 20 },
  seed: 20260823,
});
const metrics = walkForward.outOfSampleMetrics;
const trades = walkForward.combinedOutOfSample.trades;
const sum = (rows) => rows.reduce((total, row) => total + row.netPnlUsdt, 0);
const byInstrument = Object.fromEntries(instruments.map((instrument) => {
  const rows = trades.filter((trade) => trade.instId === instrument);
  const gains = sum(rows.filter((trade) => trade.netPnlUsdt > 0));
  const losses = Math.abs(sum(rows.filter((trade) => trade.netPnlUsdt <= 0)));
  return [instrument, {
    trades: rows.length,
    netPnlUsdt: sum(rows),
    profitFactor: losses === 0 ? null : gains / losses,
  }];
}));
const artifact = {
  generatedAt: new Date().toISOString(),
  scope: 'development-only',
  developmentTo: protectedSplit.developmentTo,
  holdoutRead: false,
  competitionPeriodRead: false,
  frozenAfterOperatorAuthorization: true,
  strategyId: DEADLINE_CONTINGENCY_ID,
  strategyVersion: deadlineContingency.version,
  verdict: 'CONTEST_RISK_ONLY_NOT_EVIDENCE_APPROVED',
  metrics: {
    trades: metrics.tradeCount,
    signalsEmitted: metrics.signalsEmitted,
    cycles: metrics.cycles,
    netPnlUsdt: metrics.totalReturnUsdt,
    profitFactor: metrics.profitFactor,
    winRate: metrics.winRate,
    profitableWindows: walkForward.windows.filter(
      (window) => window.outOfSample.metrics.totalReturnUsdt > 0,
    ).length,
    totalWindows: walkForward.windows.length,
  },
  byInstrument,
};
writeFileSync('reports/competition-deadline-contingency-development.json',
  `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(artifact));
