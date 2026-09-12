#!/usr/bin/env node
/** One-shot protected holdout evaluation. Never run casually. See the frozen protocol report. */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { LOCKED } from '@plumb/core';
import { CandleStore, tradableUniverse } from '@plumb/market';
import { DEFAULT_STRATEGY_CONFIG, STRATEGY_IDS, volExpansion } from '@plumb/strategy';
import { signCompetitionHoldoutEvidence } from '@plumb/ops';
import {
  DEFAULT_AUDIT_PATH,
  DEFAULT_COSTS,
  computeMetrics,
  holdoutAuditLog,
  outlierDependence,
  requestHoldoutAccess,
  runBacktest,
} from '@plumb/backtest';

const developmentPath = 'reports/competition-candidate-development.json';
const outputJson = 'reports/competition-candidate-holdout.json';
const outputMarkdown = 'reports/competition-candidate-holdout.md';
const expectedHash = '7ceee41a072da808af0e32a05d7b0808e6bc348a7b31107b3b21cabc05318563';
const protocol = Object.freeze({ minTrades: 12, minProfitFactor: 1, maxDrawdownPct: 20,
  killSwitchEquity: LOCKED.KILL_SWITCH_EQUITY_USDT });

if (!existsSync(developmentPath)) throw new Error('development artifact is absent');
const development = JSON.parse(readFileSync(developmentPath, 'utf8'));
const selected = development.results?.find((row) => row.label === development.decisionCandidate);
if (!development.defaultEligible || !development.holdoutPermitted || development.holdoutRead) {
  throw new Error('development artifact does not permit the protected holdout');
}
if (!selected || selected.configHash !== expectedHash) {
  throw new Error('frozen competition configuration does not match the predeclared hash');
}
const configJson = JSON.stringify(selected.config);
const actualHash = createHash('sha256').update(configJson).digest('hex');
if (actualHash !== expectedHash) throw new Error('selected config contents fail their hash');

// Authentication and the durable single-use check happen before CandleStore is opened. Therefore
// a missing/bad token cannot accidentally read even one protected row.
const previous = holdoutAuditLog(DEFAULT_AUDIT_PATH);
const access = requestHoldoutAccess({
  token: process.env.PLUMB_HOLDOUT_TOKEN,
  configLabel: 'aligned-default',
  configJson,
  reason: 'one final evaluation of the single frozen competition candidate',
  actor: process.env.PLUMB_HOLDOUT_ACTOR ?? 'plumb-operator',
  now: Date.now(),
  previouslyUsed: previous.length > 0,
}, process.env.PLUMB_ADMIN_TOKEN, DEFAULT_AUDIT_PATH);
if (!access.granted) throw new Error(`holdout access denied: ${access.code}`);

const dbPath = process.env.PLUMB_DB_PATH ?? './data/plumb.db';
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

const enabled = Object.fromEntries(STRATEGY_IDS.map((id) => [id, id === 'vol_expansion']));
const config = {
  ...DEFAULT_STRATEGY_CONFIG,
  ...selected.config,
  enabled,
  volExpansion: { ...DEFAULT_STRATEGY_CONFIG.volExpansion, ...selected.config.volExpansion },
};
if (createHash('sha256').update(JSON.stringify(config)).digest('hex') !== expectedHash) {
  throw new Error('runtime configuration differs from the audited frozen configuration');
}

const result = runBacktest({
  candles,
  funding,
  timeframe: '1H',
  startingEquity: LOCKED.CAPITAL_USDT,
  strategyConfig: config,
  modules: [volExpansion],
  costs: DEFAULT_COSTS,
  seed: 20260817,
  fromTs: development.holdoutFrom,
  toTs: Math.min(...tradableUniverse().map((instId) => candles[instId].at(-1).ts)),
});
const metrics = computeMetrics(result);
const outlier = outlierDependence(result.trades, LOCKED.CAPITAL_USDT);
const boundariesPass = result.trades.every((trade) =>
  trade.openedAt >= development.holdoutFrom && trade.closedAt <= result.toTs &&
  trade.holdBars <= config.maxHoldBars);
const checks = [
  { name: 'sample size', passed: metrics.tradeCount >= protocol.minTrades,
    actual: metrics.tradeCount, required: `>= ${protocol.minTrades}` },
  { name: 'net PnL', passed: metrics.totalReturnUsdt > 0,
    actual: metrics.totalReturnUsdt, required: '> 0 USDT' },
  { name: 'profit factor', passed: metrics.profitFactor > protocol.minProfitFactor,
    actual: metrics.profitFactor, required: `> ${protocol.minProfitFactor}` },
  { name: 'max drawdown', passed: metrics.maxDrawdownPct <= protocol.maxDrawdownPct,
    actual: metrics.maxDrawdownPct, required: `<= ${protocol.maxDrawdownPct}%` },
  { name: 'kill floor', passed: metrics.minEquity > protocol.killSwitchEquity,
    actual: metrics.minEquity, required: `> ${protocol.killSwitchEquity} USDT` },
  { name: 'outlier independence', passed: outlier.passed,
    actual: outlier.withoutBest, required: 'positive without best trade' },
  { name: 'governor stops', passed: result.killSwitchTriggers === 0 && result.dailyLimitTriggers === 0,
    actual: `${result.killSwitchTriggers}/${result.dailyLimitTriggers}`, required: '0/0' },
  { name: 'boundaries', passed: boundariesPass, actual: boundariesPass, required: true },
];
const passed = checks.every((check) => check.passed);
const unsigned = {
  generatedAt: new Date().toISOString(),
  scope: 'single-use-protected-holdout',
  configHash: expectedHash,
  auditConfigHash: access.configHash,
  fromTs: development.holdoutFrom,
  toTs: result.toTs,
  passed,
  checks,
  metrics,
  outlier,
};
const artifact = { ...unsigned, signature: signCompetitionHoldoutEvidence(unsigned) };
writeFileSync(outputJson, `${JSON.stringify(artifact, null, 2)}\n`);
writeFileSync(outputMarkdown, [
  '# Competition candidate — protected holdout result', '',
  `Verdict: **${passed ? 'PASS' : 'FAIL'}**`, '',
  `Window: ${new Date(unsigned.fromTs).toISOString()} → ${new Date(unsigned.toTs).toISOString()}`, '',
  '| Check | Result | Actual | Required |', '| --- | --- | ---: | --- |',
  ...checks.map((check) => `| ${check.name} | ${check.passed ? 'PASS' : 'FAIL'} | ${check.actual} | ${check.required} |`),
  '', 'This was the single permitted look. A failure is final for this competition candidate.', '',
].join('\n'));
console.log(`protected holdout: ${passed ? 'PASS' : 'FAIL'} · ${outputMarkdown}`);
