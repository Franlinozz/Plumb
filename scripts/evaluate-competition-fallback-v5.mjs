#!/usr/bin/env node
/** Development-only evaluation of the final predeclared competition fallback v5. */

import { writeFileSync } from 'node:fs';

import { LOCKED } from '@plumb/core';
import { CandleStore, tradableUniverse } from '@plumb/market';
import {
  COMPETITION_TREND_RECLAIM_ID,
  COMPETITION_TREND_RECLAIM_SETTINGS,
  DEFAULT_STRATEGY_CONFIG,
  competitionTrendReclaim,
  createCompetitionTrendReclaim,
} from '@plumb/strategy';
import { DEFAULT_COSTS, partition, runMonteCarlo, runWalkForward } from '@plumb/backtest';

const store = new CandleStore(process.env.PLUMB_DB_PATH ?? './data/plumb.db');
const candles = {};
const funding = {};
for (const instrument of tradableUniverse()) {
  candles[instrument] = store.getCandles(instrument, '1H');
  funding[instrument] = {
    instId: instrument,
    entries: store.getFundingRates(instrument).map((row) => ({
      fundingTime: row.fundingTime,
      fundingRate: row.fundingRate,
    })),
  };
}
store.close();

const dataFrom = Math.min(...Object.values(candles).map((rows) => rows[0].ts));
const dataTo = Math.max(...Object.values(candles).map((rows) => rows.at(-1).ts));
const protectedSplit = partition(dataFrom, dataTo);
for (const instrument of Object.keys(candles)) {
  candles[instrument] = candles[instrument].filter((bar) => bar.ts <= protectedSplit.developmentTo);
}

const split = Object.freeze({ inSampleDays: 60, outOfSampleDays: 20, stepDays: 20 });
const config = Object.freeze({
  ...DEFAULT_STRATEGY_CONFIG,
  enabled: Object.freeze({ [COMPETITION_TREND_RECLAIM_ID]: true }),
  lookbackBars: 300,
  regime: Object.freeze({
    ...DEFAULT_STRATEGY_CONFIG.regime,
    trendAdxMin: 20,
    rangeAdxMax: 20,
  }),
  stops: Object.freeze({ minDistancePct: 0.0149, maxDistancePct: 0.02 }),
  gate: Object.freeze({ ...DEFAULT_STRATEGY_CONFIG.gate, minRegimeConfidence: 0, cooldownMs: 0 }),
  portfolio: Object.freeze({ ...DEFAULT_STRATEGY_CONFIG.portfolio, maxCorrelatedPerCycle: 1 }),
  takeProfitR: Object.freeze([2]),
  maxHoldBars: 24,
  expiryBars: 1,
});
const variants = [
  ['predeclared-default', competitionTrendReclaim],
  ['adx-23', createCompetitionTrendReclaim({
    ...COMPETITION_TREND_RECLAIM_SETTINGS,
    fourHourAdxMin: 23,
  })],
  ['adx-27', createCompetitionTrendReclaim({
    ...COMPETITION_TREND_RECLAIM_SETTINGS,
    fourHourAdxMin: 27,
  })],
  ['volume-0.50', createCompetitionTrendReclaim({
    ...COMPETITION_TREND_RECLAIM_SETTINGS,
    volumeFloor: 0.5,
  })],
  ['volume-0.70', createCompetitionTrendReclaim({
    ...COMPETITION_TREND_RECLAIM_SETTINGS,
    volumeFloor: 0.7,
  })],
  ['rsi-wider', createCompetitionTrendReclaim({
    ...COMPETITION_TREND_RECLAIM_SETTINGS,
    longRsiMin: 46,
    longRsiMax: 72,
    shortRsiMin: 28,
    shortRsiMax: 54,
  })],
  ['rsi-narrower', createCompetitionTrendReclaim({
    ...COMPETITION_TREND_RECLAIM_SETTINGS,
    longRsiMin: 50,
    longRsiMax: 68,
    shortRsiMin: 32,
    shortRsiMax: 50,
  })],
];

const sum = (rows) => rows.reduce((total, row) => total + row.netPnlUsdt, 0);
const analyse = (walkForward) => {
  const trades = [...walkForward.combinedOutOfSample.trades].sort((a, b) => a.closedAt - b.closedAt);
  const midpoint = Math.floor(trades.length / 2);
  const bestFive = [...trades].sort((a, b) => b.netPnlUsdt - a.netPnlUsdt).slice(0, 5);
  return {
    profitableWindows: walkForward.windows.filter(
      (row) => row.outOfSample.metrics.totalReturnUsdt > 0,
    ).length,
    totalWindows: walkForward.windows.length,
    firstHalfNetPnlUsdt: sum(trades.slice(0, midpoint)),
    secondHalfNetPnlUsdt: sum(trades.slice(midpoint)),
    withoutBestFiveNetPnlUsdt: sum(trades) - sum(bestFive),
    exits: Object.fromEntries(['target', 'stop', 'timeout', 'flatten'].map((reason) => [
      reason,
      trades.filter((trade) => trade.exitReason === reason).length,
    ])),
    byInstrument: Object.fromEntries(tradableUniverse().map((instrument) => {
      const rows = trades.filter((trade) => trade.instId === instrument);
      const gains = sum(rows.filter((trade) => trade.netPnlUsdt > 0));
      const losses = Math.abs(sum(rows.filter((trade) => trade.netPnlUsdt <= 0)));
      return [instrument, {
        trades: rows.length,
        netPnlUsdt: sum(rows),
        profitFactor: losses === 0 ? (gains > 0 ? null : 0) : gains / losses,
      }];
    })),
  };
};

function run(label, module, costs = DEFAULT_COSTS) {
  process.stdout.write(`  ${label.padEnd(20)} `);
  const walkForward = runWalkForward({
    label,
    candles,
    funding,
    timeframe: '1H',
    lookbackBars: 300,
    startingEquity: LOCKED.CAPITAL_USDT,
    strategyConfig: config,
    modules: [module],
    costs,
    split,
    seed: 20260823,
  });
  const monteCarlo = runMonteCarlo({
    trades: walkForward.combinedOutOfSample.trades,
    startingEquity: LOCKED.CAPITAL_USDT,
    killSwitchEquity: LOCKED.KILL_SWITCH_EQUITY_USDT,
    iterations: 10_000,
    seed: 20260823,
  });
  const result = {
    label,
    metrics: walkForward.outOfSampleMetrics,
    inSampleMetrics: walkForward.inSampleMetrics,
    degradation: walkForward.degradation,
    overfitVerdict: walkForward.overfitVerdict,
    monteCarlo,
    diagnostics: analyse(walkForward),
  };
  console.log(`${result.metrics.tradeCount} trades · PF ${result.metrics.profitFactor.toFixed(3)} · ` +
    `net ${result.metrics.totalReturnUsdt.toFixed(2)} · ` +
    `${result.diagnostics.profitableWindows}/${result.diagnostics.totalWindows} positive windows`);
  return result;
}

console.log(`competition fallback v5 — DEVELOPMENT ONLY through ${new Date(protectedSplit.developmentTo).toISOString()}`);
const candidate = run(variants[0][0], variants[0][1]);
const primaryPass = candidate.metrics.tradeCount >= 60 && candidate.metrics.totalReturnUsdt > 0 &&
  candidate.metrics.profitFactor >= 1.2 &&
  candidate.metrics.minEquity > LOCKED.KILL_SWITCH_EQUITY_USDT &&
  candidate.monteCarlo.probabilityOfRuin <= 0.05 &&
  candidate.diagnostics.profitableWindows / candidate.diagnostics.totalWindows >= 0.4 &&
  candidate.diagnostics.firstHalfNetPnlUsdt > 0 &&
  candidate.diagnostics.secondHalfNetPnlUsdt > 0 &&
  candidate.diagnostics.withoutBestFiveNetPnlUsdt > 0 &&
  Object.values(candidate.diagnostics.byInstrument).every(
    (row) => row.trades >= 12 && row.netPnlUsdt > 0,
  );

const baseArtifact = {
  generatedAt: new Date().toISOString(),
  scope: 'development-only',
  developmentTo: protectedSplit.developmentTo,
  holdoutRead: false,
  competitionPeriodRead: false,
  strategyId: COMPETITION_TREND_RECLAIM_ID,
  strategyVersion: competitionTrendReclaim.version,
  settings: COMPETITION_TREND_RECLAIM_SETTINGS,
  config,
  costs: DEFAULT_COSTS,
  split,
};

if (!primaryPass) {
  const artifact = {
    ...baseArtifact,
    passed: false,
    primaryPass: false,
    candidate,
    secondaryRunsSkipped: true,
  };
  writeFileSync(
    'reports/competition-fallback-v5-development.json',
    `${JSON.stringify(artifact, null, 2)}\n`,
    { mode: 0o600 },
  );
  writeFileSync('reports/competition-fallback-v5-development.md', [
    '# Competition fallback v5 — development result',
    '',
    '## Verdict: FAIL / DO NOT ARM',
    '',
    `Trades ${candidate.metrics.tradeCount} · net ${candidate.metrics.totalReturnUsdt.toFixed(2)} USDT · ` +
      `PF ${candidate.metrics.profitFactor.toFixed(3)} · positive windows ` +
      `${candidate.diagnostics.profitableWindows}/${candidate.diagnostics.totalWindows}.`,
    '',
    'A primary gate failed. Sensitivity and cost-stress runs were stopped as non-decisive.',
    'Protected holdout and competition period were not read.',
    '',
  ].join('\n'), { mode: 0o600 });
  console.log(JSON.stringify({
    verdict: 'DEVELOPMENT_FAIL',
    trades: candidate.metrics.tradeCount,
    netPnlUsdt: candidate.metrics.totalReturnUsdt,
    profitFactor: candidate.metrics.profitFactor,
    holdoutRead: false,
    competitionPeriodRead: false,
  }));
  process.exit(0);
}

const results = [candidate, ...variants.slice(1).map(([label, module]) => run(label, module))];
const stressedCosts = Object.freeze({
  ...DEFAULT_COSTS,
  takerRate: DEFAULT_COSTS.takerRate * 1.5,
  baseSlippageBps: DEFAULT_COSTS.baseSlippageBps * 1.5,
  notionalSlippageBps: DEFAULT_COSTS.notionalSlippageBps * 1.5,
  volatilitySlippageCoeff: DEFAULT_COSTS.volatilitySlippageCoeff * 1.5,
});
const costStress = run('cost-stress-1.5x', competitionTrendReclaim, stressedCosts);
const stableNeighbours = results.slice(1).filter(
  (row) => row.metrics.totalReturnUsdt > 0 && row.metrics.profitFactor > 1,
).length;
const passed = stableNeighbours >= 4 && costStress.metrics.totalReturnUsdt > 0 &&
  costStress.metrics.profitFactor > 1;
const artifact = {
  ...baseArtifact,
  passed,
  primaryPass,
  stableNeighbours,
  results,
  costStress,
};
writeFileSync(
  'reports/competition-fallback-v5-development.json',
  `${JSON.stringify(artifact, null, 2)}\n`,
  { mode: 0o600 },
);
writeFileSync('reports/competition-fallback-v5-development.md', [
  '# Competition fallback v5 — development result',
  '',
  `## Verdict: ${passed ? 'DEVELOPMENT PASS / LIVE REQUIRES EXPLICIT AMENDMENT' : 'FAIL / DO NOT ARM'}`,
  '',
  `Trades ${candidate.metrics.tradeCount} · net ${candidate.metrics.totalReturnUsdt.toFixed(2)} USDT · ` +
    `PF ${candidate.metrics.profitFactor.toFixed(3)} · positive windows ` +
    `${candidate.diagnostics.profitableWindows}/${candidate.diagnostics.totalWindows}.`,
  `Stable neighbours ${stableNeighbours}/6 · cost stress net ` +
    `${costStress.metrics.totalReturnUsdt.toFixed(2)} / PF ${costStress.metrics.profitFactor.toFixed(3)}.`,
  '',
  'Protected holdout and competition period were not read.',
  '',
].join('\n'), { mode: 0o600 });
console.log(JSON.stringify({
  verdict: passed ? 'DEVELOPMENT_PASS' : 'DEVELOPMENT_FAIL',
  trades: candidate.metrics.tradeCount,
  netPnlUsdt: candidate.metrics.totalReturnUsdt,
  profitFactor: candidate.metrics.profitFactor,
  stableNeighbours,
  holdoutRead: false,
  competitionPeriodRead: false,
}));
