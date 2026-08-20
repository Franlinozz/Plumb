#!/usr/bin/env node
/** One-shot development-only evaluation of the predeclared v3 candidate. */

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

import { LOCKED } from '@plumb/core';
import { CandleStore, tradableUniverse } from '@plumb/market';
import {
  COMPETITION_TREND_PULLBACK_ID,
  DEFAULT_STRATEGY_CONFIG,
  STRATEGY_IDS,
  competitionTrendPullback,
} from '@plumb/strategy';
import {
  DEFAULT_COSTS,
  DEFAULT_CRITERIA,
  evaluateEligibility,
  partition,
  runMonteCarlo,
  runWalkForward,
} from '@plumb/backtest';

const dbPath = process.env.PLUMB_DB_PATH ?? './data/plumb.db';
const outputJson = 'reports/competition-strategy-v3-development.json';
const outputMarkdown = 'reports/competition-strategy-v3-development.md';
const split = Object.freeze({ inSampleDays: 60, outOfSampleDays: 20, stepDays: 20 });
const generatedAt = Date.now();

const store = new CandleStore(dbPath);
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
  candles[instrument] = candles[instrument].filter((candle) => candle.ts <= protectedSplit.developmentTo);
}

const enabled = Object.fromEntries([
  ...STRATEGY_IDS.map((id) => [id, false]),
  [COMPETITION_TREND_PULLBACK_ID, true],
]);
const config = { ...DEFAULT_STRATEGY_CONFIG, enabled };
const configHash = createHash('sha256').update(JSON.stringify(config)).digest('hex');

const walkForward = runWalkForward({
  label: 'competition-trend-pullback-v3',
  candles,
  funding,
  timeframe: '1H',
  startingEquity: LOCKED.CAPITAL_USDT,
  strategyConfig: config,
  modules: [competitionTrendPullback],
  costs: DEFAULT_COSTS,
  split,
  seed: 20260820,
});
const monteCarlo = runMonteCarlo({
  trades: walkForward.combinedOutOfSample.trades,
  startingEquity: LOCKED.CAPITAL_USDT,
  killSwitchEquity: LOCKED.KILL_SWITCH_EQUITY_USDT,
  iterations: 10_000,
  seed: 20260820,
});
const eligibility = evaluateEligibility({
  walkForward,
  monteCarlo,
  startingEquity: LOCKED.CAPITAL_USDT,
  criteria: DEFAULT_CRITERIA,
  evaluatedAt: generatedAt,
});

const trades = [...walkForward.combinedOutOfSample.trades].sort((a, b) => a.closedAt - b.closedAt);
const sum = (rows) => rows.reduce((total, row) => total + row.netPnlUsdt, 0);
const midpoint = Math.floor(trades.length / 2);
const top3 = [...trades].sort((a, b) => b.netPnlUsdt - a.netPnlUsdt).slice(0, 3);
const diagnostics = {
  firstHalfNetPnlUsdt: sum(trades.slice(0, midpoint)),
  secondHalfNetPnlUsdt: sum(trades.slice(midpoint)),
  withoutTop3NetPnlUsdt: sum(trades) - sum(top3),
  profitableWindows: walkForward.windows.filter((window) => window.outOfSample.metrics.totalReturnUsdt > 0).length,
  totalWindows: walkForward.windows.length,
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

const artifact = {
  generatedAt: new Date(generatedAt).toISOString(),
  scope: 'development-only',
  developmentTo: protectedSplit.developmentTo,
  holdoutFrom: protectedSplit.holdoutFrom,
  holdoutRead: false,
  competitionPeriodRead: false,
  strategyId: COMPETITION_TREND_PULLBACK_ID,
  strategyVersion: competitionTrendPullback.version,
  configHash,
  config,
  costs: DEFAULT_COSTS,
  split,
  eligibility,
  diagnostics,
};
writeFileSync(outputJson, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });

const metrics = eligibility.outOfSampleMetrics;
const lines = [
  '# Competition strategy v3 — development result',
  '',
  `Generated ${artifact.generatedAt}. Protected holdout **NOT READ**. Competition period **NOT READ**.`,
  '',
  `## Verdict: ${eligibility.eligible ? 'DEVELOPMENT PASS' : 'DEVELOPMENT FAIL'} — never live-eligible without new independent validation`,
  '',
  '| OOS trades | Net USDT | PF | Max drawdown | P(ruin) | Without best 3 |',
  '| ---: | ---: | ---: | ---: | ---: | ---: |',
  `| ${metrics.tradeCount} | ${metrics.totalReturnUsdt.toFixed(2)} | ${metrics.profitFactor.toFixed(3)} | ` +
    `${metrics.maxDrawdownPct.toFixed(2)}% | ${(monteCarlo.probabilityOfRuin * 100).toFixed(2)}% | ` +
    `${diagnostics.withoutTop3NetPnlUsdt.toFixed(2)} |`,
  '',
  `First half: ${diagnostics.firstHalfNetPnlUsdt.toFixed(2)} USDT · ` +
    `second half: ${diagnostics.secondHalfNetPnlUsdt.toFixed(2)} USDT · ` +
    `profitable windows: ${diagnostics.profitableWindows}/${diagnostics.totalWindows}.`,
  '',
  '| Instrument | Trades | Net USDT | PF |',
  '| --- | ---: | ---: | ---: |',
  ...Object.entries(diagnostics.byInstrument).map(([instrument, row]) =>
    `| ${instrument} | ${row.trades} | ${row.netPnlUsdt.toFixed(2)} | ` +
      `${row.profitFactor === null ? '∞' : row.profitFactor.toFixed(3)} |`),
  '',
  'This is a one-run measurement of the predeclared candidate. The result will not be tuned or',
  'repaired during this competition. A development pass is research evidence only because the sole',
  'protected holdout was already consumed by a different strategy and cannot be reused.',
  '',
];
writeFileSync(outputMarkdown, lines.join('\n'), { mode: 0o600 });
console.log(JSON.stringify({
  verdict: eligibility.eligible ? 'DEVELOPMENT_PASS' : 'DEVELOPMENT_FAIL',
  trades: metrics.tradeCount,
  netPnlUsdt: metrics.totalReturnUsdt,
  profitFactor: metrics.profitFactor,
  ruinPct: monteCarlo.probabilityOfRuin * 100,
  holdoutRead: false,
  competitionPeriodRead: false,
}));
