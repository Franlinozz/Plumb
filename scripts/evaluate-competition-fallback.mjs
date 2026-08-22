#!/usr/bin/env node
/** One-run development-only evaluation of the predeclared 15m competition fallback. */

import { writeFileSync } from 'node:fs';

import { LOCKED } from '@plumb/core';
import { CandleStore, tradableUniverse } from '@plumb/market';
import {
  COMPETITION_INTRADAY_CONTINUATION_ID,
  COMPETITION_INTRADAY_CONTINUATION_SETTINGS,
  DEFAULT_STRATEGY_CONFIG,
  competitionIntradayContinuation,
  createCompetitionIntradayContinuation,
} from '@plumb/strategy';
import {
  DEFAULT_COSTS,
  partition,
  runMonteCarlo,
  runWalkForward,
} from '@plumb/backtest';

const dbPath = process.env.PLUMB_DB_PATH ?? './data/plumb.db';
const outputJson = 'reports/competition-fallback-development.json';
const outputMarkdown = 'reports/competition-fallback-development.md';
const split = Object.freeze({ inSampleDays: 120, outOfSampleDays: 30, stepDays: 30 });
const generatedAt = Date.now();

const store = new CandleStore(dbPath);
const candles = {};
const funding = {};
for (const instrument of tradableUniverse()) {
  candles[instrument] = store.getCandles(instrument, '15m');
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
  candles[instrument] = candles[instrument].filter((candle) => candle.ts <= protectedSplit.developmentTo);
}

const config = Object.freeze({
  ...DEFAULT_STRATEGY_CONFIG,
  enabled: Object.freeze({ [COMPETITION_INTRADAY_CONTINUATION_ID]: true }),
  lookbackBars: 300,
  regime: Object.freeze({ ...DEFAULT_STRATEGY_CONFIG.regime, trendAdxMin: 18, rangeAdxMax: 18 }),
  stops: Object.freeze({ minDistancePct: 0.015, maxDistancePct: 0.02 }),
  gate: Object.freeze({ minRegimeConfidence: 0, cooldownMs: 0 }),
  portfolio: Object.freeze({ maxCorrelatedPerCycle: 1 }),
  trendEma: Object.freeze({ ...DEFAULT_STRATEGY_CONFIG.trendEma, timeframe: '15m' }),
  takeProfitR: Object.freeze([2]),
  maxHoldBars: 96,
  expiryBars: 1,
});

const variants = [
  { label: 'predeclared-default', module: competitionIntradayContinuation },
  { label: 'breakout-6', module: createCompetitionIntradayContinuation({
    ...COMPETITION_INTRADAY_CONTINUATION_SETTINGS, breakoutBars: 6,
  }) },
  { label: 'breakout-10', module: createCompetitionIntradayContinuation({
    ...COMPETITION_INTRADAY_CONTINUATION_SETTINGS, breakoutBars: 10,
  }) },
  { label: 'adx-16', module: createCompetitionIntradayContinuation({
    ...COMPETITION_INTRADAY_CONTINUATION_SETTINGS, hourlyAdxMin: 16,
  }) },
  { label: 'adx-20', module: createCompetitionIntradayContinuation({
    ...COMPETITION_INTRADAY_CONTINUATION_SETTINGS, hourlyAdxMin: 20,
  }) },
  { label: 'volume-0.50', module: createCompetitionIntradayContinuation({
    ...COMPETITION_INTRADAY_CONTINUATION_SETTINGS, volumeFloor: 0.5,
  }) },
  { label: 'volume-0.70', module: createCompetitionIntradayContinuation({
    ...COMPETITION_INTRADAY_CONTINUATION_SETTINGS, volumeFloor: 0.7,
  }) },
];

const sum = (rows) => rows.reduce((total, row) => total + row.netPnlUsdt, 0);
const diagnostics = (walkForward) => {
  const trades = [...walkForward.combinedOutOfSample.trades].sort((a, b) => a.closedAt - b.closedAt);
  const midpoint = Math.floor(trades.length / 2);
  const bestTen = [...trades].sort((a, b) => b.netPnlUsdt - a.netPnlUsdt).slice(0, 10);
  return {
    profitableWindows: walkForward.windows.filter((window) => window.outOfSample.metrics.totalReturnUsdt > 0).length,
    totalWindows: walkForward.windows.length,
    firstHalfNetPnlUsdt: sum(trades.slice(0, midpoint)),
    secondHalfNetPnlUsdt: sum(trades.slice(midpoint)),
    withoutBestTenNetPnlUsdt: sum(trades) - sum(bestTen),
    costToGrossProfitRatio: (() => {
      const grossProfit = sum(trades.filter((trade) => trade.grossPnlUsdt > 0));
      const costs = trades.reduce((total, trade) => total + trade.feesUsdt + trade.fundingUsdt, 0);
      return grossProfit <= 0 ? null : costs / grossProfit;
    })(),
    exits: Object.fromEntries(['target', 'stop', 'timeout', 'flatten'].map((reason) =>
      [reason, trades.filter((trade) => trade.exitReason === reason).length])),
    byInstrument: Object.fromEntries(tradableUniverse().map((instrument) => {
      const rows = trades.filter((trade) => trade.instId === instrument);
      const gains = sum(rows.filter((trade) => trade.netPnlUsdt > 0));
      const losses = Math.abs(sum(rows.filter((trade) => trade.netPnlUsdt <= 0)));
      return [instrument, { trades: rows.length, netPnlUsdt: sum(rows),
        profitFactor: losses === 0 ? (gains > 0 ? null : 0) : gains / losses }];
    })),
  };
};

function evaluate(label, module, costs = DEFAULT_COSTS) {
  process.stdout.write(`  ${label.padEnd(22)} `);
  const walkForward = runWalkForward({
    label,
    candles,
    funding,
    timeframe: '15m',
    lookbackBars: config.lookbackBars,
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
  const result = { label, metrics: walkForward.outOfSampleMetrics,
    inSampleMetrics: walkForward.inSampleMetrics, degradation: walkForward.degradation,
    overfitVerdict: walkForward.overfitVerdict, monteCarlo, diagnostics: diagnostics(walkForward) };
  console.log(`${result.metrics.tradeCount} trades · PF ${result.metrics.profitFactor.toFixed(3)} · ` +
    `net ${result.metrics.totalReturnUsdt.toFixed(2)} · ` +
    `${result.diagnostics.profitableWindows}/${result.diagnostics.totalWindows} positive windows`);
  return result;
}

console.log(`competition fallback — DEVELOPMENT ONLY through ${new Date(protectedSplit.developmentTo).toISOString()}`);
const variantsToRun = process.env.PLUMB_FALLBACK_DEFAULT_ONLY === '1' ? variants.slice(0, 1) : variants;
const results = variantsToRun.map((variant) => evaluate(variant.label, variant.module));
if (process.env.PLUMB_FALLBACK_DEFAULT_ONLY === '1') {
  const candidate = results[0];
  console.log(JSON.stringify({ verdict: 'PREDECLARED_DEFAULT_ONLY', trades: candidate.metrics.tradeCount,
    netPnlUsdt: candidate.metrics.totalReturnUsdt, profitFactor: candidate.metrics.profitFactor,
    profitableWindows: candidate.diagnostics.profitableWindows,
    totalWindows: candidate.diagnostics.totalWindows, holdoutRead: false, competitionPeriodRead: false }));
  process.exit(0);
}
const stressedCosts = Object.freeze({
  ...DEFAULT_COSTS,
  takerRate: DEFAULT_COSTS.takerRate * 1.5,
  baseSlippageBps: DEFAULT_COSTS.baseSlippageBps * 1.5,
  notionalSlippageBps: DEFAULT_COSTS.notionalSlippageBps * 1.5,
  volatilitySlippageCoeff: DEFAULT_COSTS.volatilitySlippageCoeff * 1.5,
});
const costStress = evaluate('cost-stress-1.5x', competitionIntradayContinuation, stressedCosts);
const candidate = results[0];
const stableNeighbours = results.slice(1).filter((result) =>
  result.metrics.totalReturnUsdt > 0 && result.metrics.profitFactor > 1).length;
const checks = [
  ['sample size', candidate.metrics.tradeCount >= 120, candidate.metrics.tradeCount, '>= 120'],
  ['net PnL', candidate.metrics.totalReturnUsdt > 0, candidate.metrics.totalReturnUsdt, '> 0'],
  ['profit factor', candidate.metrics.profitFactor >= 1.15, candidate.metrics.profitFactor, '>= 1.15'],
  ['kill floor', candidate.metrics.minEquity > LOCKED.KILL_SWITCH_EQUITY_USDT,
    candidate.metrics.minEquity, `> ${LOCKED.KILL_SWITCH_EQUITY_USDT}`],
  ['P(ruin)', candidate.monteCarlo.probabilityOfRuin <= 0.05,
    candidate.monteCarlo.probabilityOfRuin, '<= 0.05'],
  ['profitable windows', candidate.diagnostics.profitableWindows / candidate.diagnostics.totalWindows >= 0.5,
    `${candidate.diagnostics.profitableWindows}/${candidate.diagnostics.totalWindows}`, '>= 50%'],
  ['chronological halves', candidate.diagnostics.firstHalfNetPnlUsdt > 0 &&
    candidate.diagnostics.secondHalfNetPnlUsdt > 0,
    `${candidate.diagnostics.firstHalfNetPnlUsdt.toFixed(2)} / ${candidate.diagnostics.secondHalfNetPnlUsdt.toFixed(2)}`,
    'both > 0'],
  ['outlier independence', candidate.diagnostics.withoutBestTenNetPnlUsdt > 0,
    candidate.diagnostics.withoutBestTenNetPnlUsdt, '> 0 without best 10'],
  ['instrument breadth', Object.values(candidate.diagnostics.byInstrument).every((row) =>
    row.trades >= 20 && row.netPnlUsdt > 0), JSON.stringify(candidate.diagnostics.byInstrument),
    'each >= 20 trades and > 0'],
  ['neighbour stability', stableNeighbours >= 4, stableNeighbours, '>= 4 of 6'],
  ['cost stress', costStress.metrics.totalReturnUsdt > 0 && costStress.metrics.profitFactor > 1,
    `${costStress.metrics.totalReturnUsdt.toFixed(2)} / ${costStress.metrics.profitFactor.toFixed(3)}`, 'net > 0 and PF > 1'],
].map(([name, passed, actual, required]) => ({ name, passed, actual, required }));
const passed = checks.every((check) => check.passed);

const artifact = {
  generatedAt: new Date(generatedAt).toISOString(),
  scope: 'development-only',
  developmentTo: protectedSplit.developmentTo,
  holdoutFrom: protectedSplit.holdoutFrom,
  holdoutRead: false,
  competitionPeriodRead: false,
  strategyId: COMPETITION_INTRADAY_CONTINUATION_ID,
  strategyVersion: competitionIntradayContinuation.version,
  settings: COMPETITION_INTRADAY_CONTINUATION_SETTINGS,
  config,
  costs: DEFAULT_COSTS,
  split,
  passed,
  checks,
  results,
  costStress,
};
writeFileSync(outputJson, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });

const metrics = candidate.metrics;
const lines = [
  '# Competition fallback — development result', '',
  `Generated ${artifact.generatedAt}. Protected holdout **NOT READ**. Competition period **NOT READ**.`, '',
  `## Verdict: ${passed ? 'DEVELOPMENT PASS / LIVE STILL REQUIRES EXPLICIT AMENDMENT' : 'FAIL / DO NOT ARM'}`, '',
  '| OOS trades | Net USDT | PF | Win rate | Max DD | P(ruin) | Positive windows | Without best 10 |',
  '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  `| ${metrics.tradeCount} | ${metrics.totalReturnUsdt.toFixed(2)} | ${metrics.profitFactor.toFixed(3)} | ` +
    `${metrics.winRate.toFixed(1)}% | ${metrics.maxDrawdownPct.toFixed(2)}% | ` +
    `${(candidate.monteCarlo.probabilityOfRuin * 100).toFixed(2)}% | ` +
    `${candidate.diagnostics.profitableWindows}/${candidate.diagnostics.totalWindows} | ` +
    `${candidate.diagnostics.withoutBestTenNetPnlUsdt.toFixed(2)} |`, '',
  '| Check | Result | Actual | Required |', '| --- | --- | --- | --- |',
  ...checks.map((check) => `| ${check.name} | ${check.passed ? 'PASS' : 'FAIL'} | ` +
    `${String(check.actual).replaceAll('|', '/')} | ${check.required} |`), '',
  '| Variant | Trades | Net USDT | PF |', '| --- | ---: | ---: | ---: |',
  ...results.map((result) => `| ${result.label} | ${result.metrics.tradeCount} | ` +
    `${result.metrics.totalReturnUsdt.toFixed(2)} | ${result.metrics.profitFactor.toFixed(3)} |`),
  `| cost-stress-1.5x | ${costStress.metrics.tradeCount} | ` +
    `${costStress.metrics.totalReturnUsdt.toFixed(2)} | ${costStress.metrics.profitFactor.toFixed(3)} |`, '',
  'This one-run result cannot repair or replace the failed protected holdout. Passing would permit',
  'only an explicitly authorised evidence-limited fallback. Failure keeps the live gate closed.', '',
];
writeFileSync(outputMarkdown, `${lines.join('\n')}\n`, { mode: 0o600 });
console.log(JSON.stringify({ verdict: passed ? 'DEVELOPMENT_PASS' : 'DEVELOPMENT_FAIL',
  trades: metrics.tradeCount, netPnlUsdt: metrics.totalReturnUsdt,
  profitFactor: metrics.profitFactor, holdoutRead: false, competitionPeriodRead: false }));
