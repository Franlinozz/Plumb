/**
 * REPORT — markdown, with the equity curve rendered as inline SVG.
 *
 * No external chart service: a report that needs the network to be read is a report that will one
 * day be unreadable, and sending our equity curve to a third party is not something to do casually.
 *
 * Every report states its cost assumptions, its walk-forward split, and — the part that matters —
 * an explicit "what this does not prove" section. Honest reporting is the point of the phase.
 */

import { describeCosts, type CostModel } from './costs.js';
import type { BacktestResult, EquityPoint } from './engine.js';
import type { EligibilityRecord } from './gate.js';
import { byRegime, byStrategy, computeMetrics, type Metrics } from './metrics.js';
import type { MonteCarloResult } from './monte_carlo.js';
import type { WalkForwardResult } from './walkforward.js';

export interface ReportInput {
  readonly title: string;
  readonly walkForward: WalkForwardResult;
  readonly monteCarlo: MonteCarloResult;
  readonly eligibility: EligibilityRecord;
  readonly costs: CostModel;
  readonly generatedAt: number;
  readonly dataFrom: number;
  readonly dataTo: number;
  readonly notes?: readonly string[];
}

const n = (v: number, dp = 2): string => (Number.isFinite(v) ? v.toFixed(dp) : String(v));
const iso = (ts: number): string => (ts > 0 ? new Date(ts).toISOString().slice(0, 16).replace('T', ' ') : '—');

export function renderReport(input: ReportInput): string {
  const { walkForward: wf, monteCarlo: mc, eligibility } = input;
  const oos = wf.outOfSampleMetrics;
  const is = wf.inSampleMetrics;

  const lines: string[] = [];
  const push = (...l: string[]): void => {
    lines.push(...l);
  };

  push(`# ${input.title}`, '');
  push(
    `> **${eligibility.eligible ? 'ELIGIBLE' : 'NOT ELIGIBLE'} for live trading.**` +
      (eligibility.eligible ? '' : ` Failed on: ${eligibility.failedOn.join(', ')}.`),
    '',
  );
  push(
    `Generated ${iso(input.generatedAt)} UTC · data ${iso(input.dataFrom)} → ${iso(input.dataTo)} · ` +
      `signature \`${eligibility.signature.slice(0, 16)}…\``,
    '',
  );

  // ── THE HEADLINE ─────────────────────────────────────────────────────────────────────────
  push('## Max drawdown (out of sample)', '');
  push(
    `| | |`,
    `| --- | --- |`,
    `| **Max drawdown** | **${n(oos.maxDrawdownUsdt)} USDT (${n(oos.maxDrawdownPct)}%)** |`,
    `| Minimum equity reached | ${n(oos.minEquity)} USDT |`,
    `| Kill-switch floor | 335 USDT |`,
    `| Longest drawdown | ${oos.longestDrawdownBars} bars (${n(oos.longestDrawdownDays, 1)} days) |`,
    `| Time below starting capital | ${n(oos.pctTimeBelowStartingCapital, 1)}% of bars |`,
    '',
  );

  // ── ELIGIBILITY ──────────────────────────────────────────────────────────────────────────
  push('## Eligibility gate', '');
  push('| Criterion | Required | Actual | Result |', '| --- | --- | --- | --- |');
  for (const c of eligibility.criteria) {
    push(`| ${c.name} | ${c.required} | ${c.actual} | ${c.passed ? '✅ pass' : '❌ **FAIL**'} |`);
  }
  push('');
  for (const c of eligibility.criteria) push(`- **${c.name}** — ${c.detail}`);
  push('');

  // ── IS vs OOS ────────────────────────────────────────────────────────────────────────────
  push('## In-sample vs out-of-sample', '');
  push(
    `Walk-forward: ${wf.split.inSampleDays}d in-sample / ${wf.split.outOfSampleDays}d out-of-sample, ` +
      `rolling ${wf.split.stepDays}d, ${wf.windows.length} windows. IS and OOS never overlap.`,
    '',
  );
  push(`> ${wf.overfitVerdict}`, '');
  push('| Metric | In-sample | Out-of-sample |', '| --- | --- | --- |');
  push(...comparisonRows(is, oos));
  push('');

  // ── ALL METRICS ──────────────────────────────────────────────────────────────────────────
  push('## Full metrics (out of sample)', '');
  push('| Metric | Value |', '| --- | --- |');
  push(
    `| Total return | ${n(oos.totalReturnUsdt)} USDT (${n(oos.totalReturnPct)}%) |`,
    `| CAGR-equivalent | ${n(oos.cagrPct)}% |`,
    `| Sharpe | ${n(oos.sharpe)} |`,
    `| Sortino | ${n(oos.sortino)} |`,
    `| Calmar | ${n(oos.calmar)} |`,
    `| Trades | ${oos.tradeCount} |`,
    `| Win rate | ${n(oos.winRate, 1)}% |`,
    `| Average win | ${n(oos.averageWinUsdt)} USDT |`,
    `| Average loss | ${n(oos.averageLossUsdt)} USDT |`,
    `| Profit factor | ${n(oos.profitFactor, 3)} |`,
    `| Expectancy per trade | ${n(oos.expectancyUsdt, 4)} USDT |`,
    `| Largest single loss | ${n(oos.largestLossUsdt)} USDT |`,
    `| Largest single win | ${n(oos.largestWinUsdt)} USDT |`,
    `| Longest losing streak | ${oos.longestLosingStreak} |`,
    `| Average hold | ${n(oos.averageHoldBars, 1)} bars |`,
    `| Fees paid | ${n(oos.totalFeesUsdt)} USDT |`,
    `| Funding paid | ${n(oos.fundingPaidUsdt)} USDT |`,
    `| Funding received | ${n(oos.fundingReceivedUsdt)} USDT |`,
    `| Settlements using the funding fallback | ${oos.fundingFallbackSettlements} |`,
    `| Signals emitted | ${oos.signalsEmitted} |`,
    `| Kill-switch triggers | ${oos.killSwitchTriggers} |`,
    `| Daily-limit triggers | ${oos.dailyLimitTriggers} |`,
    '',
  );

  // ── GOVERNOR ─────────────────────────────────────────────────────────────────────────────
  push('## The governor was in the loop', '');
  const vetoes = Object.entries(oos.governorVetoes).sort((a, b) => b[1] - a[1]);
  if (vetoes.length === 0) {
    push('**No governor vetoes were recorded.** That is suspicious, not reassuring — check that', '');
    push('the governor is genuinely wired into the replay.', '');
  } else {
    push('| Veto reason | Count |', '| --- | --- |');
    for (const [code, count] of vetoes) push(`| \`${code}\` | ${count} |`);
    push('');
  }
  const rejections = Object.entries(oos.gateRejections).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (rejections.length > 0) {
    push('Pre-emission gate rejections (top 10):', '');
    push('| Reason | Count |', '| --- | --- |');
    for (const [code, count] of rejections) push(`| \`${code}\` | ${count} |`);
    push('');
  }

  // ── MONTE CARLO ──────────────────────────────────────────────────────────────────────────
  push('## Monte Carlo', '');
  push(
    `${mc.iterations} resampled paths of ${mc.pathLength} trades each, seed \`${mc.seed}\`. ` +
      `A path ends when it touches the kill switch, as it would in reality.`,
    '',
  );
  push('| | |', '| --- | --- |');
  push(
    `| **P(equity ≤ 335) — the number that matters** | **${n(mc.probabilityOfRuin * 100)}%** |`,
    `| **5th-percentile final equity** | **${n(mc.p5Equity)} USDT** |`,
    `| P(ending below starting capital) | ${n(mc.probabilityBelowStart * 100)}% |`,
    `| 25th percentile | ${n(mc.p25Equity)} USDT |`,
    `| Median | ${n(mc.medianEquity)} USDT |`,
    `| 75th percentile | ${n(mc.p75Equity)} USDT |`,
    `| 95th percentile | ${n(mc.p95Equity)} USDT |`,
    `| Mean | ${n(mc.meanEquity)} USDT |`,
    `| Worst path | ${n(mc.worstEquity)} USDT |`,
    `| Median max drawdown | ${n(mc.medianMaxDrawdownPct)}% |`,
    `| Worst max drawdown | ${n(mc.worstMaxDrawdownPct)}% |`,
    '',
  );

  // ── BREAKDOWNS ───────────────────────────────────────────────────────────────────────────
  const trades = wf.combinedOutOfSample.trades;
  const regimes = byRegime(trades);
  if (regimes.length > 0) {
    push('## Where it worked — by regime (out of sample)', '');
    push('| Regime | Trades | Win rate | Net PnL | Profit factor | Expectancy |', '| --- | --- | --- | --- | --- | --- |');
    for (const r of regimes) {
      push(
        `| ${r.regime} | ${r.trades} | ${n(r.winRate, 1)}% | ${n(r.netPnlUsdt)} | ` +
          `${n(r.profitFactor, 3)} | ${n(r.expectancyUsdt, 4)} |`,
      );
    }
    push('');
  }
  const strategies = byStrategy(trades);
  if (strategies.length > 1) {
    push('## By strategy (out of sample)', '');
    push('| Strategy | Trades | Win rate | Net PnL | Profit factor |', '| --- | --- | --- | --- | --- |');
    for (const s of strategies) {
      push(`| \`${s.strategyId}\` | ${s.trades} | ${n(s.winRate, 1)}% | ${n(s.netPnlUsdt)} | ${n(s.profitFactor, 3)} |`);
    }
    push('');
  }

  // ── PER-WINDOW ───────────────────────────────────────────────────────────────────────────
  push('## Walk-forward windows', '');
  push(
    '| # | OOS period | IS trades | IS PF | OOS trades | OOS PF | OOS net | OOS min equity |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const w of wf.windows) {
    push(
      `| ${w.window.index} | ${iso(w.window.outOfSampleFrom).slice(0, 10)} → ${iso(w.window.outOfSampleTo).slice(0, 10)} | ` +
        `${w.inSample.metrics.tradeCount} | ${n(w.inSample.metrics.profitFactor, 2)} | ` +
        `${w.outOfSample.metrics.tradeCount} | ${n(w.outOfSample.metrics.profitFactor, 2)} | ` +
        `${n(w.outOfSample.metrics.totalReturnUsdt)} | ${n(w.outOfSample.metrics.minEquity)} |`,
    );
  }
  push('');

  // ── EQUITY CURVE ─────────────────────────────────────────────────────────────────────────
  push('## Out-of-sample equity curve', '');
  push(renderEquitySvg(wf.combinedOutOfSample.equityCurve, wf.combinedOutOfSample.startingEquity), '');

  // ── ASSUMPTIONS ──────────────────────────────────────────────────────────────────────────
  push('## Cost assumptions', '');
  push('Where a choice existed, the assumption that makes the result look WORSE was taken.', '');
  for (const line of describeCosts(input.costs)) push(`- ${line}`);
  push('');

  // ── WHAT THIS DOES NOT PROVE ─────────────────────────────────────────────────────────────
  push('## What this does not prove', '');
  push(
    '- **It is not a prediction.** It is a measurement of how this configuration would have behaved',
    '  over one particular stretch of history, which will not repeat.',
    `- **The sample is ${oos.tradeCount} out-of-sample trades over ${n(oos.days, 0)} days.** Even a clean result on`,
    '  this many trades carries wide error bars; the Monte Carlo above is the honest picture of that.',
    '- **One market regime.** The stored history covers a specific period. A strategy that survives it',
    '  has not been tested against the regimes that period did not contain.',
    '- **Fills are modelled, not observed.** Slippage, spread and gap behaviour are assumptions, chosen',
    '  pessimistically but still assumptions. Real fills will differ.',
    '- **No exchange outage, API failure, or partial fill is simulated.** The live system will meet all',
    '  three, and P5\'s reconciliation exists because of it.',
    '- **Funding before the stored window uses a fallback rate.** OKX retains ~97 days of funding',
    `  history; ${oos.fundingFallbackSettlements} settlements in this run used the pessimistic fallback.`,
    '- **Passing this gate is a licence to risk 400 USDT, nothing more.** It is not evidence of edge at',
    '  any other size, on any other instrument, or in any other market condition.',
    '',
  );
  if (input.notes !== undefined && input.notes.length > 0) {
    push('## Run notes', '');
    for (const note of input.notes) push(`- ${note}`);
    push('');
  }

  return lines.join('\n');
}

function comparisonRows(is: Metrics, oos: Metrics): readonly string[] {
  const row = (label: string, a: string, b: string): string => `| ${label} | ${a} | ${b} |`;
  return [
    row('Trades', String(is.tradeCount), String(oos.tradeCount)),
    row('Net PnL (USDT)', n(is.totalReturnUsdt), n(oos.totalReturnUsdt)),
    row('Profit factor', n(is.profitFactor, 3), n(oos.profitFactor, 3)),
    row('Win rate', `${n(is.winRate, 1)}%`, `${n(oos.winRate, 1)}%`),
    row('Expectancy (USDT)', n(is.expectancyUsdt, 4), n(oos.expectancyUsdt, 4)),
    row('Max drawdown', `${n(is.maxDrawdownPct)}%`, `${n(oos.maxDrawdownPct)}%`),
    row('Min equity', n(is.minEquity), n(oos.minEquity)),
    row('Sharpe', n(is.sharpe), n(oos.sharpe)),
  ];
}

/**
 * The equity curve as inline SVG — self-contained, no scripts, no external fetch.
 *
 * The kill-switch floor is drawn as a red line and the starting capital as a dashed one, so the
 * two references that actually matter are visible without reading the axis.
 */
export function renderEquitySvg(
  curve: readonly EquityPoint[],
  startingEquity: number,
  killSwitch = 335,
): string {
  const width = 900;
  const height = 320;
  const pad = { top: 20, right: 20, bottom: 34, left: 62 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  if (curve.length < 2) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="80" role="img" aria-label="No equity curve"><text x="12" y="46" font-family="monospace" font-size="14">no equity curve — too few points</text></svg>`;
  }

  const equities = curve.map((p) => p.equity);
  const lo = Math.min(killSwitch, ...equities) * 0.995;
  const hi = Math.max(startingEquity, ...equities) * 1.005;
  const span = hi - lo || 1;
  const t0 = curve[0]?.ts ?? 0;
  const t1 = curve[curve.length - 1]?.ts ?? t0 + 1;
  const tSpan = t1 - t0 || 1;

  const x = (ts: number): number => pad.left + ((ts - t0) / tSpan) * plotW;
  const y = (equity: number): number => pad.top + plotH - ((equity - lo) / span) * plotH;

  // Downsample so the SVG stays small and readable on long runs.
  const step = Math.max(1, Math.floor(curve.length / 1_200));
  const points: string[] = [];
  for (let i = 0; i < curve.length; i += step) {
    const p = curve[i] as EquityPoint;
    points.push(`${x(p.ts).toFixed(1)},${y(p.equity).toFixed(1)}`);
  }
  const last = curve[curve.length - 1] as EquityPoint;
  points.push(`${x(last.ts).toFixed(1)},${y(last.equity).toFixed(1)}`);

  const gridLines = [lo, lo + span * 0.25, lo + span * 0.5, lo + span * 0.75, hi]
    .map(
      (v) =>
        `<line x1="${pad.left}" y1="${y(v).toFixed(1)}" x2="${width - pad.right}" y2="${y(v).toFixed(1)}" stroke="#e2e2e2" stroke-width="1"/>` +
        `<text x="${pad.left - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" font-family="monospace" font-size="11" fill="#666">${v.toFixed(0)}</text>`,
    )
    .join('');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Out-of-sample equity curve">`,
    `<rect width="${width}" height="${height}" fill="#ffffff"/>`,
    gridLines,
    `<line x1="${pad.left}" y1="${y(startingEquity).toFixed(1)}" x2="${width - pad.right}" y2="${y(startingEquity).toFixed(1)}" stroke="#888" stroke-width="1" stroke-dasharray="4 4"/>`,
    `<text x="${width - pad.right}" y="${(y(startingEquity) - 6).toFixed(1)}" text-anchor="end" font-family="monospace" font-size="11" fill="#888">start ${startingEquity}</text>`,
    `<line x1="${pad.left}" y1="${y(killSwitch).toFixed(1)}" x2="${width - pad.right}" y2="${y(killSwitch).toFixed(1)}" stroke="#c0392b" stroke-width="1.5"/>`,
    `<text x="${width - pad.right}" y="${(y(killSwitch) - 6).toFixed(1)}" text-anchor="end" font-family="monospace" font-size="11" fill="#c0392b">kill switch ${killSwitch}</text>`,
    `<polyline fill="none" stroke="#1f6feb" stroke-width="1.6" points="${points.join(' ')}"/>`,
    `<text x="${pad.left}" y="${height - 10}" font-family="monospace" font-size="11" fill="#666">${iso(t0)}</text>`,
    `<text x="${width - pad.right}" y="${height - 10}" text-anchor="end" font-family="monospace" font-size="11" fill="#666">${iso(t1)}</text>`,
    `</svg>`,
  ].join('');
}

/** A one-line summary for the console and the index table. */
export function summariseRun(label: string, result: BacktestResult, eligibility: EligibilityRecord): string {
  const m = computeMetrics(result);
  return (
    `${label.padEnd(26)} ${eligibility.eligible ? 'ELIGIBLE' : 'REJECTED'}  ` +
    `trades ${String(m.tradeCount).padStart(4)}  PF ${n(m.profitFactor, 2).padStart(6)}  ` +
    `net ${n(m.totalReturnUsdt).padStart(8)}  maxDD ${n(m.maxDrawdownPct).padStart(6)}%`
  );
}
