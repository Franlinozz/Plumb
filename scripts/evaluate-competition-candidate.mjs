#!/usr/bin/env node
/**
 * Development-only robustness evaluation for the single predeclared competition candidate.
 *
 * Candidate: vol_expansion 1.1.0 with trend alignment enabled. The default configuration is the
 * decision candidate; neighbours measure stability and are never searched for a better winner.
 * This script physically removes the protected holdout before any replay begins.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { CandleStore, snapshotFromCandles, tradableUniverse } from '@plumb/market';
import {
  DEFAULT_STRATEGY_CONFIG,
  STRATEGY_IDS,
  classifyRegime,
  volExpansion,
} from '@plumb/strategy';
import { LOCKED } from '@plumb/core';
import {
  calibrateExpectedGrossEdge,
  DEFAULT_COSTS,
  DEFAULT_CRITERIA,
  evaluateEligibility,
  partition,
  runMonteCarlo,
  runWalkForward,
} from '@plumb/backtest';

const dbPath = process.env.PLUMB_DB_PATH ?? './data/plumb.db';
const outputJson = 'reports/competition-candidate-development.json';
const outputMarkdown = 'reports/competition-candidate-development.md';
const split = Object.freeze({ inSampleDays: 60, outOfSampleDays: 20, stepDays: 20 });

const store = new CandleStore(dbPath);
const candles = {};
const funding = {};
for (const instId of tradableUniverse()) {
  candles[instId] = store.getCandles(instId, '1H');
  funding[instId] = {
    instId,
    entries: store.getFundingRates(instId).map((row) => ({
      fundingTime: row.fundingTime,
      fundingRate: row.fundingRate,
    })),
  };
}
store.close();

const dataFrom = Math.min(...Object.values(candles).map((rows) => rows[0].ts));
const dataTo = Math.max(...Object.values(candles).map((rows) => rows.at(-1).ts));
const protectedSplit = partition(dataFrom, dataTo);
for (const instId of Object.keys(candles)) {
  candles[instId] = candles[instId].filter((candle) => candle.ts <= protectedSplit.developmentTo);
}

const FOUR_HOURS = 4 * 3_600_000;
function aggregateFourHour(rows) {
  const groups = new Map();
  for (const candle of rows) {
    const bucket = Math.floor(candle.ts / FOUR_HOURS) * FOUR_HOURS;
    const group = groups.get(bucket) ?? [];
    group.push(candle);
    groups.set(bucket, group);
  }
  return [...groups.entries()].filter(([, group]) => group.length === 4 && group.every((row) => row.closed))
    .map(([ts, group]) => ({
      ts,
      open: group[0].open,
      high: Math.max(...group.map((row) => row.high)),
      low: Math.min(...group.map((row) => row.low)),
      close: group.at(-1).close,
      volume: group.reduce((sum, row) => sum + row.volume, 0),
      volumeCcy: group.reduce((sum, row) => sum + row.volumeCcy, 0),
      volumeQuote: group.reduce((sum, row) => sum + row.volumeQuote, 0),
      closed: true,
    })).sort((a, b) => a.ts - b.ts);
}
const fourHourCandles = Object.fromEntries(Object.entries(candles)
  .map(([instId, rows]) => [instId, aggregateFourHour(rows)]));

function closedFourHourAlignment(trade, config) {
  const history = fourHourCandles[trade.instId].filter((candle) => candle.ts + FOUR_HOURS <= trade.openedAt);
  if (history.length < 300) return { aligned: false, regime: 'unclear', adx: 0 };
  const window = history.slice(-config.lookbackBars);
  const snapshot = snapshotFromCandles({
    now: trade.openedAt,
    instId: trade.instId,
    candles: [{ tf: '4H', ohlcv: window }],
  });
  const regime = classifyRegime(snapshot, '4H', config.regime);
  const indicators = snapshot.indicators['4H'];
  const emaDirection = indicators?.emaFast === undefined || indicators.emaSlow === undefined
    ? 'unclear'
    : indicators.emaFast > indicators.emaSlow ? 'up'
      : indicators.emaFast < indicators.emaSlow ? 'down' : 'unclear';
  const directional = trade.side === 'long' ? emaDirection === 'up' : emaDirection === 'down';
  return {
    aligned: directional && (indicators?.adx ?? 0) >= 25,
    regime: regime.label,
    emaDirection,
    adx: indicators?.adx ?? 0,
  };
}

const enabled = Object.fromEntries(STRATEGY_IDS.map((id) => [id, id === 'vol_expansion']));
const candidate = (overrides = {}) => ({
  ...DEFAULT_STRATEGY_CONFIG,
  enabled,
  volExpansion: {
    ...DEFAULT_STRATEGY_CONFIG.volExpansion,
    requireTrendAlignment: true,
    ...(overrides.volExpansion ?? {}),
  },
  ...(overrides.maxHoldBars === undefined ? {} : { maxHoldBars: overrides.maxHoldBars }),
});

// The first row is the frozen decision candidate. Every later row changes exactly one parameter
// around it and can only veto instability; no neighbour may replace the default for being richer.
const variants = Object.freeze([
  { label: 'aligned-default', config: candidate() },
  { label: 'compression-0.20', config: candidate({ volExpansion: { compressionPercentile: 0.20 } }) },
  { label: 'compression-0.30', config: candidate({ volExpansion: { compressionPercentile: 0.30 } }) },
  { label: 'range-16', config: candidate({ volExpansion: { rangeBars: 16 } }) },
  { label: 'range-24', config: candidate({ volExpansion: { rangeBars: 24 } }) },
  { label: 'break-0.40', config: candidate({ volExpansion: { minBreakAtr: 0.40 } }) },
  { label: 'break-0.60', config: candidate({ volExpansion: { minBreakAtr: 0.60 } }) },
]);

const sha256 = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sum = (rows) => rows.reduce((total, row) => total + row.netPnlUsdt, 0);

function diagnostics(walkForward) {
  const trades = [...walkForward.combinedOutOfSample.trades].sort((a, b) => a.closedAt - b.closedAt);
  const byInstrument = Object.fromEntries(tradableUniverse().map((instId) => {
    const rows = trades.filter((trade) => trade.instId === instId);
    const gains = sum(rows.filter((trade) => trade.netPnlUsdt > 0));
    const losses = Math.abs(sum(rows.filter((trade) => trade.netPnlUsdt <= 0)));
    return [instId, {
      trades: rows.length,
      netPnlUsdt: sum(rows),
      profitFactor: losses === 0 ? (gains > 0 ? null : 0) : gains / losses,
    }];
  }));
  const midpoint = Math.floor(trades.length / 2);
  const ranked = [...trades].sort((a, b) => b.netPnlUsdt - a.netPnlUsdt);
  const top3 = ranked.slice(0, 3);
  const profitableWindows = walkForward.windows.filter((window) =>
    window.outOfSample.metrics.totalReturnUsdt > 0).length;
  return {
    profitableWindows,
    totalWindows: walkForward.windows.length,
    profitableWindowPct: walkForward.windows.length === 0 ? 0 : profitableWindows / walkForward.windows.length,
    firstHalfNetPnlUsdt: sum(trades.slice(0, midpoint)),
    secondHalfNetPnlUsdt: sum(trades.slice(midpoint)),
    withoutTop3NetPnlUsdt: sum(trades) - sum(top3),
    top3NetPnlUsdt: sum(top3),
    byInstrument,
  };
}

const priorArtifact = process.env.PLUMB_DEFAULT_ONLY === '1' && existsSync(outputJson)
  ? JSON.parse(readFileSync(outputJson, 'utf8')) : undefined;
const variantsToRun = process.env.PLUMB_DEFAULT_ONLY === '1' ? variants.slice(0, 1) : variants;
const results = [];
const generatedAt = Date.now();
console.log(`competition candidate — DEVELOPMENT ONLY through ${new Date(protectedSplit.developmentTo).toISOString()}`);
for (const variant of variantsToRun) {
  process.stdout.write(`  ${variant.label.padEnd(20)} `);
  const walkForward = runWalkForward({
    label: variant.label,
    candles,
    funding,
    timeframe: '1H',
    startingEquity: LOCKED.CAPITAL_USDT,
    strategyConfig: variant.config,
    modules: [volExpansion],
    costs: DEFAULT_COSTS,
    split,
    seed: 20260817,
  });
  const monteCarlo = runMonteCarlo({
    trades: walkForward.combinedOutOfSample.trades,
    startingEquity: LOCKED.CAPITAL_USDT,
    killSwitchEquity: LOCKED.KILL_SWITCH_EQUITY_USDT,
    iterations: 10_000,
    seed: 20260817,
  });
  const eligibility = evaluateEligibility({
    walkForward,
    monteCarlo,
    startingEquity: LOCKED.CAPITAL_USDT,
    criteria: DEFAULT_CRITERIA,
    evaluatedAt: Date.now(),
  });
  const aligned4h = walkForward.combinedOutOfSample.trades.filter((trade) =>
    closedFourHourAlignment(trade, variant.config).aligned);
  const alignedGains = sum(aligned4h.filter((trade) => trade.netPnlUsdt > 0));
  const alignedLosses = Math.abs(sum(aligned4h.filter((trade) => trade.netPnlUsdt <= 0)));
  const alignedBest = aligned4h.length === 0 ? 0 : Math.max(...aligned4h.map((trade) => trade.netPnlUsdt));
  const result = {
    label: variant.label,
    configHash: sha256(variant.config),
    config: variant.config,
    eligibility,
    diagnostics: diagnostics(walkForward),
    fourHourConfirmation: {
      tradeCount: aligned4h.length,
      netPnlUsdt: sum(aligned4h),
      profitFactor: alignedLosses === 0 ? null : alignedGains / alignedLosses,
      withoutBestNetPnlUsdt: sum(aligned4h) - alignedBest,
      byInstrument: Object.fromEntries(tradableUniverse().map((instrument) => {
        const rows = aligned4h.filter((trade) => trade.instId === instrument);
        const gains = sum(rows.filter((trade) => trade.netPnlUsdt > 0));
        const losses = Math.abs(sum(rows.filter((trade) => trade.netPnlUsdt <= 0)));
        const best = rows.length === 0 ? 0 : Math.max(...rows.map((trade) => trade.netPnlUsdt));
        return [instrument, {
          tradeCount: rows.length,
          netPnlUsdt: sum(rows),
          profitFactor: losses === 0 ? null : gains / losses,
          withoutBestNetPnlUsdt: sum(rows) - best,
        }];
      })),
    },
    calibrations: Object.fromEntries(tradableUniverse().map((instrument, index) => [instrument,
      calibrateExpectedGrossEdge({
        trades: aligned4h,
        strategyId: 'vol_expansion',
        strategyVersion: '1.1.0',
        configHash: sha256(variant.config),
        instrument,
        calculatedAt: generatedAt,
        blockSize: 5,
        iterations: 10_000,
        seed: 20260817 + index,
      }),
    ])),
  };
  results.push(result);
  console.log(`${eligibility.eligible ? 'PASS' : 'FAIL'} · ${eligibility.outOfSampleMetrics.tradeCount} trades · ` +
    `PF ${eligibility.outOfSampleMetrics.profitFactor.toFixed(2)} · net ` +
    `${eligibility.outOfSampleMetrics.totalReturnUsdt.toFixed(2)} · ruin ` +
    `${(eligibility.monteCarlo.probabilityOfRuin * 100).toFixed(2)}%`);
}
if (priorArtifact !== undefined) results.push(...priorArtifact.results.slice(1));

const defaultResult = results[0];
const stableCount = results.filter((result) =>
  result.eligibility.outOfSampleMetrics.totalReturnUsdt > 0 &&
  result.eligibility.outOfSampleMetrics.profitFactor > 1).length;
const allInstrumentsPositive = Object.values(defaultResult.diagnostics.byInstrument)
  .every((row) => row.trades > 0 && row.netPnlUsdt > 0);
const temporalPositive = defaultResult.diagnostics.firstHalfNetPnlUsdt > 0 &&
  defaultResult.diagnostics.secondHalfNetPnlUsdt > 0;
const top3Independent = defaultResult.diagnostics.withoutTop3NetPnlUsdt > 0;
const stabilityPassed = stableCount >= 5 && allInstrumentsPositive && temporalPositive && top3Independent;
const holdoutPermitted = defaultResult.eligibility.eligible && stabilityPassed;

const artifact = {
  generatedAt: new Date(generatedAt).toISOString(),
  scope: 'development-only',
  developmentTo: protectedSplit.developmentTo,
  holdoutFrom: protectedSplit.holdoutFrom,
  holdoutRead: false,
  decisionCandidate: 'aligned-default',
  defaultEligible: defaultResult.eligibility.eligible,
  stability: { stableCount, required: 5, allInstrumentsPositive, temporalPositive, top3Independent,
    passed: stabilityPassed },
  holdoutPermitted,
  results,
};

const lines = [
  '# Competition candidate — development robustness',
  '',
  `Generated ${artifact.generatedAt} · protected holdout **NOT READ**`,
  '',
  `Decision candidate: \`aligned-default\` · development gate: **${artifact.defaultEligible ? 'PASS' : 'FAIL'}** · ` +
    `stability: **${stabilityPassed ? 'PASS' : 'FAIL'}** · holdout permitted: **${holdoutPermitted ? 'YES' : 'NO'}**`,
  '',
  '| Variant | Eligible | Trades | PF | Net USDT | P(ruin) | Config hash |',
  '| --- | --- | ---: | ---: | ---: | ---: | --- |',
  ...results.map((result) => `| ${result.label} | ${result.eligibility.eligible ? 'PASS' : 'FAIL'} | ` +
    `${result.eligibility.outOfSampleMetrics.tradeCount} | ` +
    `${result.eligibility.outOfSampleMetrics.profitFactor.toFixed(3)} | ` +
    `${result.eligibility.outOfSampleMetrics.totalReturnUsdt.toFixed(2)} | ` +
    `${(result.eligibility.monteCarlo.probabilityOfRuin * 100).toFixed(2)}% | ` +
    `\`${result.configHash.slice(0, 16)}…\` |`),
  '',
  '## Default diagnostics',
  '',
  `- Profitable windows: ${defaultResult.diagnostics.profitableWindows}/${defaultResult.diagnostics.totalWindows} ` +
    `(${(defaultResult.diagnostics.profitableWindowPct * 100).toFixed(1)}%)`,
  `- First half net: ${defaultResult.diagnostics.firstHalfNetPnlUsdt.toFixed(2)} USDT`,
  `- Second half net: ${defaultResult.diagnostics.secondHalfNetPnlUsdt.toFixed(2)} USDT`,
  `- Net without best three trades: ${defaultResult.diagnostics.withoutTop3NetPnlUsdt.toFixed(2)} USDT`,
  ...Object.entries(defaultResult.diagnostics.byInstrument).map(([instId, row]) =>
    `- ${instId}: ${row.trades} trades, ${row.netPnlUsdt.toFixed(2)} USDT, PF ` +
      `${row.profitFactor === null ? 'undefined' : row.profitFactor.toFixed(3)}`),
  '',
  '## Gross-edge calibration (5th percentile circular-block bootstrap)',
  '',
  '| Instrument | Samples | Gross mean | 50% haircut edge | Analytical 95% lower |',
  '| --- | ---: | ---: | ---: | ---: |',
  ...Object.values(defaultResult.calibrations).map((row) =>
    `| ${row.instrument} | ${row.sampleSize} | ${row.grossMeanBps.toFixed(2)} bps | ` +
      `${row.conservativeExpectedEdgeBps.toFixed(2)} bps | ` +
      `${row.analyticalLowerConfidenceBoundBps.toFixed(2)} bps |`),
  '',
  `Closed-4H-confirmed subset: ${defaultResult.fourHourConfirmation.tradeCount} trades, ` +
    `${defaultResult.fourHourConfirmation.netPnlUsdt.toFixed(2)} USDT net. Only fully closed 4H ` +
    'bars available before entry are used.',
  '',
  'The default is frozen before this run. Neighbours may veto instability; they cannot replace it.',
];

mkdirSync('reports', { recursive: true });
writeFileSync(outputJson, `${JSON.stringify(artifact, null, 2)}\n`);
writeFileSync(outputMarkdown, `${lines.join('\n')}\n`);
console.log(`holdout permitted: ${holdoutPermitted ? 'YES' : 'NO'} · ${outputMarkdown}`);
