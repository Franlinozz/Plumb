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
  buildFundingModel,
  bullOnlyVerdict,
  classifyHistory,
  computeMetrics,
  evaluateEligibility,
  partition,
  regimeAt,
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
const wfSplit = {
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

// P4B: the HOLDOUT is never read. Everything below runs on the development set only.
const dataFrom = Math.min(...Object.values(candles).map((c) => c[0].ts));
const dataTo = Math.max(...Object.values(candles).map((c) => c.at(-1).ts));
const split = partition(dataFrom, dataTo);
for (const instId of Object.keys(candles)) {
  candles[instId] = candles[instId].filter((c) => c.ts <= split.developmentTo);
}

const classified = {};
for (const instId of Object.keys(candles)) classified[instId] = classifyHistory(candles[instId]);

const fundingModel = buildFundingModel(
  Object.fromEntries(Object.entries(funding).map(([k, v]) => [k, v.entries])),
);

const bars = Math.min(...Object.values(candles).map((c) => c.length));
const fundingRows = Object.values(funding).reduce((n, f) => n + f.entries.length, 0);
console.log(
  `\nbacktest — DEVELOPMENT SET ONLY: ${new Date(split.developmentFrom).toISOString().slice(0, 10)} → ` +
    `${new Date(split.developmentTo).toISOString().slice(0, 10)}  (holdout ` +
    `${new Date(split.holdoutFrom).toISOString().slice(0, 10)} → ${new Date(split.holdoutTo).toISOString().slice(0, 10)} NOT READ)`,
);
console.log(
  `${bars} bars/instrument on ${tf}, ${fundingRows} real funding settlements, ` +
    `walk-forward ${wfSplit.inSampleDays}/${wfSplit.outOfSampleDays} step ${wfSplit.stepDays}`,
);
console.log(
  `costs: taker ${(DEFAULT_COSTS.takerRate * 100).toFixed(3)}%, slippage floor ` +
    `${DEFAULT_COSTS.baseSlippageBps}bp, entries at next-bar open, stops at the worse side\n`,
);

/** Each candidate alone, then the sensible combinations. */
const configs = [
  ...STRATEGY_IDS.map((id) => ({
    label: id,
    config: {
      ...DEFAULT_STRATEGY_CONFIG,
      enabled: Object.fromEntries(STRATEGY_IDS.map((s) => [s, s === id])),
    },
  })),
  { label: 'all_combined', config: DEFAULT_STRATEGY_CONFIG },
  {
    label: 'trend_and_breakout',
    config: {
      ...DEFAULT_STRATEGY_CONFIG,
      enabled: Object.fromEntries(
        STRATEGY_IDS.map((s) => [s, s === 'trend_ema' || s === 'breakout_range' || s === 'vol_expansion']),
      ),
    },
  },
  {
    label: 'mean_reversion_pair',
    config: {
      ...DEFAULT_STRATEGY_CONFIG,
      enabled: Object.fromEntries(
        STRATEGY_IDS.map((s) => [s, s === 'revert_band' || s === 'funding_skew']),
      ),
    },
  },
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
    split: wfSplit,
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
      `${wf.windows.length} walk-forward windows over ${bars} bars of ${tf} data (development set only).`,
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
  // ── Trades per 14-day window — the competition horizon. ────────────────────────────────
  const trades = wf.combinedOutOfSample.trades;
  const windowMs = 14 * 86_400_000;
  const perWindow = new Map();
  for (const t of trades) {
    const w = Math.floor((t.closedAt - split.developmentFrom) / windowMs);
    perWindow.set(w, (perWindow.get(w) ?? 0) + 1);
  }
  const spanWindows = Math.max(1, Math.ceil((wf.combinedOutOfSample.toTs - wf.combinedOutOfSample.fromTs) / windowMs));
  const counts = [];
  for (let w = 0; w < spanWindows; w += 1) counts.push(perWindow.get(w) ?? 0);
  counts.sort((a, b) => a - b);
  const median14 = counts.length === 0 ? 0 : counts[Math.floor(counts.length / 2)];
  const mean14 = counts.length === 0 ? 0 : counts.reduce((a, b) => a + b, 0) / counts.length;

  // ── Regime segmentation. ───────────────────────────────────────────────────────────────
  const byRegime = { bull: { netPnlUsdt: 0, trades: 0 }, bear: { netPnlUsdt: 0, trades: 0 }, chop: { netPnlUsdt: 0, trades: 0 } };
  for (const t of trades) {
    const r = regimeAt(classified[t.instId] ?? new Map(), t.openedAt);
    if (r === undefined) continue;
    byRegime[r].netPnlUsdt += t.netPnlUsdt;
    byRegime[r].trades += 1;
  }
  const bullOnly = bullOnlyVerdict(byRegime);

  // ── Modelled-vs-real funding, and whether profit concentrates in the modelled period. ──
  const realFrom = fundingModel.realFrom ?? Number.POSITIVE_INFINITY;
  const modelledTrades = trades.filter((t) => t.openedAt < realFrom);
  const realTrades = trades.filter((t) => t.openedAt >= realFrom);
  const modelledPnl = modelledTrades.reduce((s, t) => s + t.netPnlUsdt, 0);
  const realPnl = realTrades.reduce((s, t) => s + t.netPnlUsdt, 0);
  const modelledFraction = trades.length === 0 ? 1 : modelledTrades.length / trades.length;

  summary.push({ label, eligibility, oos, mc, wf, median14, mean14, counts, byRegime, bullOnly, modelledFraction, modelledPnl, realPnl });
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

console.log('\nTRADES PER 14-DAY WINDOW (the competition horizon — under 5 cannot be competitive)');
console.log(`${'config'.padEnd(22)}${'median'.padStart(8)}${'mean'.padStart(8)}${'min'.padStart(6)}${'max'.padStart(6)}  verdict`);
for (const s of summary) {
  const min = s.counts[0] ?? 0;
  const max = s.counts[s.counts.length - 1] ?? 0;
  const verdict = s.median14 < 5 ? 'TOO SPARSE for a 14-day contest' : 'adequate frequency';
  console.log(
    `${s.label.padEnd(22)}${String(s.median14).padStart(8)}${s.mean14.toFixed(1).padStart(8)}` +
      `${String(min).padStart(6)}${String(max).padStart(6)}  ${verdict}`,
  );
}

console.log('\nREGIME SEGMENTATION (net USDT / trades)');
console.log(`${'config'.padEnd(22)}${'bull'.padStart(16)}${'bear'.padStart(16)}${'chop'.padStart(16)}`);
for (const s of summary) {
  const cell = (r) => `${r.netPnlUsdt.toFixed(2)}/${r.trades}`.padStart(16);
  console.log(`${s.label.padEnd(22)}${cell(s.byRegime.bull)}${cell(s.byRegime.bear)}${cell(s.byRegime.chop)}`);
  if (s.bullOnly !== undefined) console.log(`  ${s.bullOnly}`);
}

console.log('\nFUNDING: modelled vs real, and where the profit sits');
console.log(`${'config'.padEnd(22)}${'modelled%'.padStart(11)}${'PnL modelled'.padStart(14)}${'PnL real'.padStart(11)}  flag`);
for (const s of summary) {
  const concentrated =
    s.oos.totalReturnUsdt > 0 && s.modelledPnl > 0 && s.realPnl <= 0
      ? 'RED FLAG — profit sits entirely in the MODELLED-funding period'
      : '';
  console.log(
    `${s.label.padEnd(22)}${(s.modelledFraction * 100).toFixed(1).padStart(10)}%` +
      `${s.modelledPnl.toFixed(2).padStart(14)}${s.realPnl.toFixed(2).padStart(11)}  ${concentrated}`,
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
