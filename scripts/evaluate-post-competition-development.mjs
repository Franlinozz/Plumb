#!/usr/bin/env node
/** Frozen Stage 2 development evaluation. Never reads beyond the declared development cutoff. */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

import { LOCKED } from '@plumb/core';
import { CandleStore, tradableUniverse } from '@plumb/market';
import {
  DEFAULT_STRATEGY_CONFIG,
  STRATEGY_IDS,
  fundingSkew,
  oiDivergence,
  volExpansion,
} from '@plumb/strategy';
import {
  DEFAULT_COSTS,
  DEFAULT_CRITERIA,
  evaluateEligibility,
  runMonteCarlo,
  runWalkForward,
} from '@plumb/backtest';

const DEVELOPMENT_TO = Date.parse('2026-08-09T23:59:59Z');
const VALIDATION_FROM = Date.parse('2026-08-11T00:00:00Z');
const dbPath = process.env.PLUMB_DB_PATH ?? './data/post-competition-research.db';
const outputJson = 'reports/post-competition-development-v1.json';
const outputMarkdown = 'reports/post-competition-development-v1.md';
const split = Object.freeze({ inSampleDays: 60, outOfSampleDays: 20, stepDays: 20 });
const sha256 = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const store = new CandleStore(dbPath);
const candles = {};
const funding = {};
for (const instId of tradableUniverse()) {
  candles[instId] = store.getCandles(instId, '1H', { toTs: DEVELOPMENT_TO, closedOnly: true });
  funding[instId] = {
    instId,
    entries: store.getFundingRates(instId, { toTs: DEVELOPMENT_TO }).map((row) => ({
      fundingTime: row.fundingTime,
      fundingRate: row.fundingRate,
    })),
  };
}
store.close();

for (const [instId, rows] of Object.entries(candles)) {
  if (rows.length === 0) throw new Error(`no development candles for ${instId}`);
  if (rows.some((row) => row.ts > DEVELOPMENT_TO)) throw new Error(`cutoff violation for ${instId}`);
}
for (const series of Object.values(funding)) {
  if (series.entries.some((row) => row.fundingTime > DEVELOPMENT_TO)) {
    throw new Error(`funding cutoff violation for ${series.instId}`);
  }
}

const enabledOnly = (id) => Object.fromEntries(STRATEGY_IDS.map((candidate) => [candidate, candidate === id]));
const candidates = [
  {
    id: 'H1',
    label: 'trend-aligned-volatility-expansion',
    strategyId: 'vol_expansion',
    module: volExpansion,
    config: {
      ...DEFAULT_STRATEGY_CONFIG,
      enabled: enabledOnly('vol_expansion'),
      volExpansion: { ...DEFAULT_STRATEGY_CONFIG.volExpansion, requireTrendAlignment: true },
    },
  },
  {
    id: 'H2',
    label: 'open-interest-backed-continuation',
    strategyId: 'oi_divergence',
    module: oiDivergence,
    config: { ...DEFAULT_STRATEGY_CONFIG, enabled: enabledOnly('oi_divergence') },
    unavailableReason: 'historical open interest is not yet persisted or injected by the backtest engine',
  },
  {
    id: 'H3',
    label: 'funding-crowding-fade',
    strategyId: 'funding_skew',
    module: fundingSkew,
    config: { ...DEFAULT_STRATEGY_CONFIG, enabled: enabledOnly('funding_skew') },
  },
];

const sum = (rows, field) => rows.reduce((total, row) => total + row[field], 0);
function concentration(trades, field) {
  const profitable = trades.filter((trade) => trade.netPnlUsdt > 0);
  const total = sum(profitable, 'grossPnlUsdt');
  const groups = {};
  for (const trade of trades) {
    const key = trade[field];
    const rows = groups[key] ?? [];
    rows.push(trade);
    groups[key] = rows;
  }
  const detail = Object.fromEntries(Object.entries(groups).map(([key, rows]) => [key, {
    trades: rows.length,
    netPnlUsdt: sum(rows, 'netPnlUsdt'),
    positiveGrossPnlUsdt: sum(rows.filter((row) => row.netPnlUsdt > 0), 'grossPnlUsdt'),
  }]));
  const maximumShare = total <= 0 ? 1 : Math.max(0, ...Object.values(detail)
    .map((row) => row.positiveGrossPnlUsdt / total));
  return { groups: detail, groupCountWithTrades: Object.keys(detail).length, maximumPositiveGrossShare: maximumShare };
}

const results = [];
for (const candidate of candidates) {
  const configHash = sha256(candidate.config);
  if (candidate.unavailableReason !== undefined) {
    results.push({
      id: candidate.id,
      label: candidate.label,
      strategyId: candidate.strategyId,
      configHash,
      status: 'BLOCKED_IMPLEMENTATION',
      passed: false,
      reason: candidate.unavailableReason,
    });
    console.log(`${candidate.id} BLOCKED_IMPLEMENTATION · ${candidate.unavailableReason}`);
    continue;
  }
  const walkForward = runWalkForward({
    label: candidate.label,
    candles,
    funding,
    timeframe: '1H',
    startingEquity: LOCKED.CAPITAL_USDT,
    strategyConfig: candidate.config,
    modules: [candidate.module],
    costs: DEFAULT_COSTS,
    split,
    seed: 20260914,
    toTs: DEVELOPMENT_TO,
  });
  const trades = walkForward.combinedOutOfSample.trades;
  const monteCarlo = runMonteCarlo({
    trades,
    startingEquity: LOCKED.CAPITAL_USDT,
    killSwitchEquity: LOCKED.KILL_SWITCH_EQUITY_USDT,
    iterations: 10_000,
    seed: 20260914,
  });
  const eligibility = evaluateEligibility({
    walkForward,
    monteCarlo,
    startingEquity: LOCKED.CAPITAL_USDT,
    criteria: DEFAULT_CRITERIA,
    evaluatedAt: Date.now(),
  });
  const byInstrument = concentration(trades, 'instId');
  const byRegime = concentration(trades, 'regime');
  const extraChecks = [
    { name: 'instrument breadth', passed: byInstrument.groupCountWithTrades >= 2,
      actual: byInstrument.groupCountWithTrades, required: '>= 2 instruments with trades' },
    { name: 'instrument concentration', passed: byInstrument.maximumPositiveGrossShare <= 0.70,
      actual: byInstrument.maximumPositiveGrossShare, required: '<= 0.70' },
    { name: 'regime breadth', passed: byRegime.groupCountWithTrades >= 2,
      actual: byRegime.groupCountWithTrades, required: '>= 2 regimes with trades' },
    { name: 'regime concentration', passed: byRegime.maximumPositiveGrossShare <= 0.80,
      actual: byRegime.maximumPositiveGrossShare, required: '<= 0.80' },
  ];
  const passed = eligibility.eligible && extraChecks.every((check) => check.passed);
  results.push({ id: candidate.id, label: candidate.label, strategyId: candidate.strategyId,
    configHash, status: passed ? 'PASS' : 'FAIL', passed, eligibility, extraChecks,
    diagnostics: { byInstrument, byRegime } });
  console.log(`${candidate.id} ${passed ? 'PASS' : 'FAIL'} · ${trades.length} trades · PF ` +
    `${Number.isFinite(eligibility.outOfSampleMetrics.profitFactor) ? eligibility.outOfSampleMetrics.profitFactor.toFixed(3) : 'undefined'} · ` +
    `net ${eligibility.outOfSampleMetrics.totalReturnUsdt.toFixed(2)} USDT`);
}

const artifact = {
  generatedAt: new Date().toISOString(),
  protocol: 'reports/post-competition-hypothesis-protocol-v1.md',
  scope: 'development-only',
  database: dbPath,
  developmentTo: DEVELOPMENT_TO,
  validationFrom: VALIDATION_FROM,
  validationRead: false,
  dataRows: Object.fromEntries(Object.entries(candles).map(([key, rows]) => [key, rows.length])),
  fundingRows: Object.fromEntries(Object.entries(funding).map(([key, value]) => [key, value.entries.length])),
  results,
};
mkdirSync('reports', { recursive: true });
writeFileSync(outputJson, `${JSON.stringify(artifact, null, 2)}\n`);
writeFileSync(outputMarkdown, [
  '# Post-competition Stage 2 development result v1', '',
  `Generated ${artifact.generatedAt}. Scope: **development only** through ` +
    `${new Date(DEVELOPMENT_TO).toISOString()}. Validation data was **not read**.`, '',
  '| Candidate | Status | Trades | PF | Net USDT | Failed checks |',
  '| --- | --- | ---: | ---: | ---: | --- |',
  ...results.map((result) => {
    if (result.eligibility === undefined) return `| ${result.id} ${result.label} | ${result.status} | — | — | — | ${result.reason} |`;
    const metrics = result.eligibility.outOfSampleMetrics;
    const failed = [...result.eligibility.failedOn, ...result.extraChecks.filter((check) => !check.passed).map((check) => check.name)];
    return `| ${result.id} ${result.label} | ${result.status} | ${metrics.tradeCount} | ` +
      `${Number.isFinite(metrics.profitFactor) ? metrics.profitFactor.toFixed(3) : 'undefined'} | ` +
      `${metrics.totalReturnUsdt.toFixed(2)} | ${failed.join(', ') || 'none'} |`;
  }), '',
  'A PASS permits forward shadow evaluation only. It does not authorize live execution.', '',
].join('\n'));
console.log(`wrote ${outputMarkdown}`);
