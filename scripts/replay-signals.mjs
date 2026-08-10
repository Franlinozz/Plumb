#!/usr/bin/env node
/**
 * Replay the stored history through the strategy engine.
 *
 * **This is a SMOKE TEST, not a performance claim.** It reports how often each strategy fires,
 * under which regimes, and why the gate rejected what it rejected. It says nothing whatsoever
 * about whether any of them make money — that is P4's job, and until P4 runs, no edge is claimed.
 *
 * What it IS for: catching a strategy that fires on 60% of bars (it is reporting a state, not an
 * event) and one that fires zero times in 180 days (it is unreachable).
 *
 *   node scripts/replay-signals.mjs [--tf 1H] [--bars 300]
 */

import { CandleStore, tradableUniverse } from '@plumb/market';
import { DEFAULT_STRATEGY_CONFIG, EMPTY_STATE, runCycleSeeded } from '@plumb/strategy';
import { snapshotOf } from '@plumb/strategy/testkit';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};

const tf = arg('tf', '1H');
const lookback = Number(arg('bars', String(DEFAULT_STRATEGY_CONFIG.lookbackBars)));
const dbPath = process.env.PLUMB_DB_PATH ?? './data/plumb.db';

const store = new CandleStore(dbPath);

const fired = new Map(); // `${strategy}|${inst}|${regime}` -> count
const perStrategy = new Map();
const regimeBars = new Map();
const rejections = new Map();
const conflicts = new Map();
const drops = new Map();
let cycles = 0;
let drafts = 0;
let emitted = 0;

const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
const started = Date.now();

// P4B: funding history is now stored, so funding_skew can finally be evaluated.
const fundingByInst = {};
for (const instId of tradableUniverse()) fundingByInst[instId] = store.getFundingRates(instId);

for (const instId of tradableUniverse()) {
  const candles = store.getCandles(instId, tf);
  if (candles.length < lookback + 10) {
    console.log(`  ${instId} ${tf}: only ${candles.length} bars — run npm run backfill first`);
    continue;
  }
  process.stdout.write(`  replaying ${instId} ${tf} (${candles.length} bars) `);

  for (let end = lookback; end <= candles.length; end += 1) {
    // A fixed-width rolling window: live and backtest MUST feed the same number of bars, or
    // the recursive indicators warm up differently and the replay stops being evidence (P1).
    const window = candles.slice(end - lookback, end);
    const bar = window[window.length - 1];
    const rates = fundingByInst[instId] ?? [];
    const past = [];
    for (const r of rates) {
      if (r.fundingTime > bar.ts) break;
      past.push(r.fundingRate);
    }
    const snapshot = snapshotOf(window, {
      instId,
      timeframe: tf,
      now: bar.ts + 1,
      fundingRate: past.length > 0 ? past[past.length - 1] : 0,
      fundingHistory: past.slice(-100),
    });

    const result = runCycleSeeded(snapshot, bar.ts + 1, { state: EMPTY_STATE, seed: end });
    cycles += 1;
    drafts += result.draftCount;
    emitted += result.signals.length;
    bump(regimeBars, result.regime.label);

    for (const signal of result.signals) {
      bump(fired, `${signal.strategyId}|${instId}|${signal.regime}`);
      bump(perStrategy, signal.strategyId);
    }
    for (const r of result.rejected) bump(rejections, `${r.strategyId}|${r.code}`);
    for (const c of result.conflicts) bump(conflicts, c.strategyIds.join('+'));
    for (const d of result.portfolioDrops) bump(drops, `${d.strategyId}|${d.code}`);

    if (end % 1000 === 0) process.stdout.write('.');
  }
  console.log('');
}
store.close();

const pct = (n) => `${((n / cycles) * 100).toFixed(2)}%`;

console.log(`\n${'='.repeat(78)}`);
console.log(`replayed ${cycles} cycles on ${tf} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`drafts ${drafts} → emitted ${emitted} (${pct(emitted)} of bars)`);
console.log('='.repeat(78));

console.log('\nregime distribution across all bars:');
for (const [label, n] of [...regimeBars].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${label.padEnd(16)} ${String(n).padStart(7)}  ${pct(n).padStart(8)}`);
}

console.log('\nsignals per strategy per instrument per regime:');
if (fired.size === 0) console.log('  (none)');
const rows = [...fired].sort((a, b) => b[1] - a[1]);
for (const [key, n] of rows) {
  const [strategy, inst, regime] = key.split('|');
  console.log(`  ${strategy.padEnd(16)}${inst.padEnd(16)}${regime.padEnd(16)}${String(n).padStart(6)}`);
}

console.log('\nper-strategy totals (verdict: a strategy firing >20% of bars, or 0 times, is broken):');
for (const id of Object.keys(DEFAULT_STRATEGY_CONFIG.enabled)) {
  const n = perStrategy.get(id) ?? 0;
  const rate = (n / cycles) * 100;
  const verdict = n === 0 ? 'NEVER FIRES — investigate' : rate > 20 ? 'TOO FREQUENT — investigate' : 'plausible';
  console.log(`  ${id.padEnd(16)}${String(n).padStart(6)}  ${rate.toFixed(2).padStart(6)}%  ${verdict}`);
}

console.log(
  '\n  NOTE on funding_skew: the candle store holds no funding-rate history, so this replay\n' +
    '  cannot rank funding against its own past and the strategy is UNEVALUABLE here — not\n' +
    '  proven dead. It is proven to fire in strategies.test.ts when history and a peer exist.\n' +
    '  Storing funding history is a P4 prerequisite.',
);

console.log('\ngate rejections by strategy and reason:');
for (const [key, n] of [...rejections].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  const [strategy, code] = key.split('|');
  console.log(`  ${strategy.padEnd(16)}${code.padEnd(24)}${String(n).padStart(7)}`);
}

console.log('\nportfolio drops:');
if (drops.size === 0) console.log('  (none)');
for (const [key, n] of [...drops].sort((a, b) => b[1] - a[1])) {
  const [strategy, code] = key.split('|');
  console.log(`  ${strategy.padEnd(16)}${code.padEnd(28)}${String(n).padStart(7)}`);
}

console.log('\nconflicts (opposite sides in one cycle — neither emitted):');
if (conflicts.size === 0) console.log('  (none)');
for (const [key, n] of [...conflicts].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${key.padEnd(40)}${String(n).padStart(7)}`);
}
