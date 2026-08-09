#!/usr/bin/env node
/**
 * Run the walk-forward backtest over the stored history and write a report per configuration.
 *
 * Reports land in `reports/`. Whatever the gate says is what gets printed — this script has no
 * opinion and no fallback to a friendlier number.
 *
 *   node scripts/backtest.mjs [--tf 1H] [--is 60] [--oos 20] [--step 20]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CandleStore, tradableUniverse } from '@plumb/market';
import { DEFAULT_STRATEGY_CONFIG, STRATEGY_IDS } from '@plumb/strategy';
import { LOCKED } from '@plumb/risk';
import {
  DEFAULT_COSTS,
  DEFAULT_CRITERIA,
  computeMetrics,
  evaluateEligibility,
  renderReport,
  runMonteCarlo,
  runWalkForward,
} from '@plumb/backtest';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};

const tf = arg('tf', '1H');
const split = {
  inSampleDays: Number(arg('is', '60')),
  outOfSampleDays: Number(arg('oos', '20')),
  stepDays: Number(arg('step', '20')),
};
const dbPath = process.env.PLUMB_DB_PATH ?? './data/plumb.db';
const reportsDir = 'reports';
mkdirSync(reportsDir, { recursive: true });

const store = new CandleStore(dbPath);
const candles = {};
const funding = {};
for (const instId of tradableUniverse()) {
  candles[instId] = store.getCandles(instId, tf);
  const rates = store.getFundingRates(instId);
  funding[instId] = { instId, entries: rates.map((r) => ({ fundingTime: r.fundingTime, fundingRate: r.fundingRate })) };
}
store.close();

const bars = Math.min(...Object.values(candles).map((c) => c.length));
const fundingRows = Object.values(funding).reduce((n, f) => n + f.entries.length, 0);
console.log(
  `\nbacktest — ${bars} bars/instrument on ${tf}, ${fundingRows} funding settlements, ` +
    `walk-forward ${split.inSampleDays}/${split.outOfSampleDays} step ${split.stepDays}`,
);
console.log(
  `costs: taker ${(DEFAULT_COSTS.takerRate * 100).toFixed(3)}%, slippage floor ` +
    `${DEFAULT_COSTS.baseSlippageBps}bp, entries at next-bar open, stops at the worse side\n`,
);

/** Each of the four candidates alone, then all four together. */
const configs = [
  ...STRATEGY_IDS.map((id) => ({
    label: id,
    config: {
      ...DEFAULT_STRATEGY_CONFIG,
      enabled: Object.fromEntries(STRATEGY_IDS.map((s) => [s, s === id])),
    },
  })),
  { label: 'all_four_combined', config: DEFAULT_STRATEGY_CONFIG },
];

const generatedAt = Date.now();
const summary = [];

for (const { label, config } of configs) {
  process.stdout.write(`  ${label.padEnd(20)} `);
  const wf = runWalkForward({
    label,
    candles,
    funding,
    timeframe: tf,
    startingEquity: LOCKED.CAPITAL_USDT,
    strategyConfig: config,
    costs: DEFAULT_COSTS,
    split,
    seed: 20260809,
  });

  const oos = wf.outOfSampleMetrics;
  const mc = runMonteCarlo({
    trades: wf.combinedOutOfSample.trades,
    startingEquity: LOCKED.CAPITAL_USDT,
    killSwitchEquity: LOCKED.KILL_SWITCH_EQUITY_USDT,
    iterations: 10_000,
    seed: 20260809,
  });

  const eligibility = evaluateEligibility({
    walkForward: wf,
    monteCarlo: mc,
    startingEquity: LOCKED.CAPITAL_USDT,
    criteria: DEFAULT_CRITERIA,
    evaluatedAt: generatedAt,
  });

  const markdown = renderReport({
    title: `Plumb backtest — ${label}`,
    walkForward: wf,
    monteCarlo: mc,
    eligibility,
    costs: DEFAULT_COSTS,
    generatedAt,
    dataFrom: wf.combinedOutOfSample.fromTs,
    dataTo: wf.combinedOutOfSample.toTs,
    notes: [
      `Configuration: ${label}. Strategies enabled: ${Object.entries(config.enabled).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}.`,
      `${wf.windows.length} walk-forward windows over ${bars} bars of ${tf} data.`,
    ],
  });
  writeFileSync(join(reportsDir, `${label}.md`), `${markdown}\n`);

  const pf = Number.isFinite(oos.profitFactor) ? oos.profitFactor.toFixed(2) : 'n/a';
  console.log(
    `${eligibility.eligible ? 'ELIGIBLE' : 'REJECTED'}  ` +
      `OOS trades ${String(oos.tradeCount).padStart(4)}  PF ${pf.padStart(5)}  ` +
      `net ${oos.totalReturnUsdt.toFixed(2).padStart(8)}  maxDD ${oos.maxDrawdownPct.toFixed(1).padStart(5)}%  ` +
      `P(ruin) ${(mc.probabilityOfRuin * 100).toFixed(1)}%`,
  );
  summary.push({ label, eligibility, oos, mc, wf });
}

console.log(`\n${'='.repeat(100)}`);
console.log('OUT-OF-SAMPLE METRICS — every configuration, whatever the result');
console.log('='.repeat(100));
console.log(
  `${'config'.padEnd(20)}${'trades'.padStart(7)}${'win%'.padStart(7)}${'PF'.padStart(7)}` +
    `${'net'.padStart(9)}${'maxDD%'.padStart(8)}${'minEq'.padStart(8)}${'P5eq'.padStart(8)}` +
    `${'P(ruin)'.padStart(9)}${'expectancy'.padStart(12)}`,
);
for (const s of summary) {
  const pf = Number.isFinite(s.oos.profitFactor) ? s.oos.profitFactor.toFixed(2) : 'n/a';
  console.log(
    `${s.label.padEnd(20)}${String(s.oos.tradeCount).padStart(7)}` +
      `${s.oos.winRate.toFixed(1).padStart(7)}${pf.padStart(7)}` +
      `${s.oos.totalReturnUsdt.toFixed(2).padStart(9)}${s.oos.maxDrawdownPct.toFixed(1).padStart(8)}` +
      `${s.oos.minEquity.toFixed(0).padStart(8)}${s.mc.p5Equity.toFixed(0).padStart(8)}` +
      `${(s.mc.probabilityOfRuin * 100).toFixed(1).padStart(8)}%${s.oos.expectancyUsdt.toFixed(4).padStart(12)}`,
  );
}

console.log('\nIN-SAMPLE vs OUT-OF-SAMPLE (overfitting check)');
console.log(`${'config'.padEnd(20)}${'IS PF'.padStart(8)}${'OOS PF'.padStart(8)}${'IS net'.padStart(9)}${'OOS net'.padStart(9)}  verdict`);
for (const s of summary) {
  const isPf = Number.isFinite(s.wf.inSampleMetrics.profitFactor) ? s.wf.inSampleMetrics.profitFactor.toFixed(2) : 'n/a';
  const oosPf = Number.isFinite(s.oos.profitFactor) ? s.oos.profitFactor.toFixed(2) : 'n/a';
  console.log(
    `${s.label.padEnd(20)}${isPf.padStart(8)}${oosPf.padStart(8)}` +
      `${s.wf.inSampleMetrics.totalReturnUsdt.toFixed(2).padStart(9)}${s.oos.totalReturnUsdt.toFixed(2).padStart(9)}  ` +
      s.wf.overfitVerdict.slice(0, 70),
  );
}

console.log('\nGATE RESULTS');
const eligible = summary.filter((s) => s.eligibility.eligible);
for (const s of summary) {
  console.log(`  ${s.label.padEnd(20)} ${s.eligibility.eligible ? 'ELIGIBLE' : `REJECTED — ${s.eligibility.failedOn.join(', ')}`}`);
}
console.log(
  `\n${eligible.length} of ${summary.length} configurations are eligible for live trading.` +
    (eligible.length === 0
      ? '\nNONE PASSED. That is a legitimate outcome: we do not trade this configuration.'
      : ''),
);
console.log(`\nreports written to ${reportsDir}/`);
