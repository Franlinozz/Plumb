#!/usr/bin/env node
/** Single-use validation of the frozen Stage 2 winner. Refuses to overwrite an existing result. */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { LOCKED } from '@plumb/core';
import { CandleStore, tradableUniverse } from '@plumb/market';
import { DEFAULT_STRATEGY_CONFIG, STRATEGY_IDS, volExpansion } from '@plumb/strategy';
import { DEFAULT_COSTS, computeMetrics, outlierDependence, runBacktest } from '@plumb/backtest';

const FROM = Date.parse('2026-08-11T00:00:00Z');
const TO = Date.parse('2026-09-11T23:59:59Z');
const EXPECTED_HASH = '7ceee41a072da808af0e32a05d7b0808e6bc348a7b31107b3b21cabc05318563';
const developmentPath = 'reports/post-competition-development-v1.json';
const outputJson = 'reports/post-competition-validation-v1.json';
const outputMarkdown = 'reports/post-competition-validation-v1.md';
if (existsSync(outputJson) || existsSync(outputMarkdown)) {
  throw new Error('validation result already exists; this protocol permits one look only');
}

const development = JSON.parse(readFileSync(developmentPath, 'utf8'));
const selected = development.results?.find((row) => row.id === 'H1');
if (development.validationRead !== false || selected?.status !== 'PASS' || selected.configHash !== EXPECTED_HASH) {
  throw new Error('development evidence does not authorize the frozen H1 validation');
}
const enabled = Object.fromEntries(STRATEGY_IDS.map((id) => [id, id === 'vol_expansion']));
const config = {
  ...DEFAULT_STRATEGY_CONFIG,
  enabled,
  volExpansion: { ...DEFAULT_STRATEGY_CONFIG.volExpansion, requireTrendAlignment: true },
};
const actualHash = createHash('sha256').update(JSON.stringify(config)).digest('hex');
if (actualHash !== EXPECTED_HASH) throw new Error('runtime H1 configuration differs from the frozen hash');

const dbPath = process.env.PLUMB_DB_PATH ?? './data/post-competition-research.db';
const store = new CandleStore(dbPath);
const candles = {};
const funding = {};
for (const instId of tradableUniverse()) {
  // Keep pre-window history for indicators while runBacktest enforces the actual evaluation bounds.
  candles[instId] = store.getCandles(instId, '1H', { toTs: TO, closedOnly: true });
  funding[instId] = {
    instId,
    entries: store.getFundingRates(instId, { toTs: TO }).map((row) => ({
      fundingTime: row.fundingTime,
      fundingRate: row.fundingRate,
    })),
  };
}
store.close();

const result = runBacktest({
  candles,
  funding,
  timeframe: '1H',
  startingEquity: LOCKED.CAPITAL_USDT,
  strategyConfig: config,
  modules: [volExpansion],
  costs: DEFAULT_COSTS,
  seed: 20260914,
  fromTs: FROM,
  toTs: TO,
});
const metrics = computeMetrics(result);
const outlier = outlierDependence(result.trades, LOCKED.CAPITAL_USDT);
const boundariesPass = result.trades.every((trade) => trade.openedAt >= FROM && trade.closedAt <= TO);
const checks = [
  { name: 'positive after costs', passed: metrics.totalReturnUsdt > 0,
    actual: metrics.totalReturnUsdt, required: '> 0 USDT' },
  { name: 'profit factor', passed: metrics.profitFactor > 1,
    actual: metrics.profitFactor, required: '> 1.0' },
  { name: 'kill floor', passed: metrics.minEquity > LOCKED.KILL_SWITCH_EQUITY_USDT,
    actual: metrics.minEquity, required: `> ${LOCKED.KILL_SWITCH_EQUITY_USDT} USDT` },
  { name: 'replay boundaries', passed: boundariesPass, actual: boundariesPass, required: true },
];
const passed = checks.every((check) => check.passed);
const artifact = {
  generatedAt: new Date().toISOString(),
  scope: 'single-use-post-competition-validation',
  candidate: 'H1 trend-aligned-volatility-expansion',
  configHash: actualHash,
  fromTs: FROM,
  toTs: TO,
  passed,
  checks,
  metrics,
  outlier,
};
writeFileSync(outputJson, `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx' });
writeFileSync(outputMarkdown, [
  '# Post-competition Stage 2 validation result v1', '',
  `Candidate: **${artifact.candidate}**`, '',
  `Window: ${new Date(FROM).toISOString()} → ${new Date(TO).toISOString()}`, '',
  `Verdict: **${passed ? 'PASS' : 'FAIL'}**`, '',
  '| Check | Result | Actual | Required |', '| --- | --- | ---: | --- |',
  ...checks.map((check) => `| ${check.name} | ${check.passed ? 'PASS' : 'FAIL'} | ${check.actual} | ${check.required} |`),
  '', `Trades: ${metrics.tradeCount}; net: ${metrics.totalReturnUsdt.toFixed(2)} USDT; ` +
    `profit factor: ${Number.isFinite(metrics.profitFactor) ? metrics.profitFactor.toFixed(3) : 'undefined'}.`, '',
  'A PASS permits Stage 3 forward shadow trading only. It does not authorize live execution.', '',
].join('\n'), { flag: 'wx' });
console.log(`H1 validation ${passed ? 'PASS' : 'FAIL'} · ${metrics.tradeCount} trades · PF ` +
  `${Number.isFinite(metrics.profitFactor) ? metrics.profitFactor.toFixed(3) : 'undefined'} · ` +
  `net ${metrics.totalReturnUsdt.toFixed(2)} USDT`);
